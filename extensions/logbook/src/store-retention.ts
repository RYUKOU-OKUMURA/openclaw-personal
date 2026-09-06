// Retention owns frame unlink ordering, unavailable-interval receipts, and DB cleanup.
import { rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  compileSqliteQueryBindings,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import type { LogbookDatabase } from "./types.js";

/** Deletes expired images only after allowing unfinished observations their bounded grace. */
export function pruneLogbookFrames(params: {
  db: import("node:sqlite").DatabaseSync;
  framesDir: string;
  olderThanMs: number;
  olderUnfinishedThanMs: number;
  busyTimeoutMs: number;
}): number {
  const { db, framesDir, olderThanMs, olderUnfinishedThanMs, busyTimeoutMs } = params;
  const query = getNodeSqliteKysely<LogbookDatabase>(db);
  const selectExpired = db.prepare(
    `SELECT id, path, day, captured_at_ms, batch_id, idle FROM frames WHERE captured_at_ms < ? AND
     (captured_at_ms < ? OR idle = 1 OR EXISTS (
       SELECT 1 FROM batches WHERE batches.id = frames.batch_id
       AND (status = 'done' OR observation_cursor >= end_ms)))`,
  );
  // SAFETY: The frames schema fixes these columns to integer/text storage; only batch_id is nullable.
  const rows = selectExpired.all(olderThanMs, olderUnfinishedThanMs) as Array<{
    id: number;
    path: string;
    day: string;
    captured_at_ms: number;
    batch_id: number | null;
    idle: number;
  }>;
  if (rows.length === 0) {
    return 0;
  }
  const days = new Set<string>();
  for (const row of rows) {
    // Keep metadata until every file operation succeeds. A later retry can
    // then find rows whose earlier files were already removed with force.
    rmSync(row.path, { force: true });
    days.add(row.day);
  }
  const currentPath = compileSqliteQueryBindings<number>((p) =>
    query
      .selectFrom("frames")
      .select("path")
      .where(
        "id",
        "=",
        p((id) => id),
      ),
  );
  const selectCurrent = db.prepare(currentPath.compiled.sql);
  const deletion = compileSqliteQueryBindings<number>((p) =>
    query.deleteFrom("frames").where(
      "id",
      "=",
      p((id) => id),
    ),
  );
  const deleteById = db.prepare(deletion.compiled.sql);
  const deleted = runSqliteImmediateTransactionSync(
    db,
    () => {
      let count = 0;
      const unavailable = new Map<string, { start: number; end: number; count: number }>();
      const affected = new Set<number>();
      for (const row of rows) {
        const current = selectCurrent.get(...currentPath.bind(row.id));
        if (!current) {
          continue;
        }
        if (current.path !== row.path) {
          throw new Error(`Logbook frame ${row.id} changed path while pruning`);
        }
        // keyframe_id uses ON DELETE SET NULL, so the same commit cannot
        // leave surviving cards pointed at removed frame rows.
        count += Number(deleteById.run(...deletion.bind(row.id)).changes);
        if (row.batch_id !== null) {
          affected.add(row.batch_id);
        } else if (row.idle === 0) {
          const span = unavailable.get(row.day) ?? {
            start: row.captured_at_ms,
            end: row.captured_at_ms + 1,
            count: 0,
          };
          span.start = Math.min(span.start, row.captured_at_ms);
          span.end = Math.max(span.end, row.captured_at_ms + 1);
          span.count += 1;
          unavailable.set(row.day, span);
        }
      }
      const now = Date.now();
      const reason =
        "source frames expired before analysis completed; captured interval is unavailable";
      for (const [day, span] of unavailable) {
        db.prepare(`INSERT INTO batches(day,start_ms,end_ms,status,error,frame_count,
          created_ms,updated_ms,attempts) VALUES (?,?,?,'error',?,?,?,?,3)`).run(
          day,
          span.start,
          span.end,
          reason,
          span.count,
          now,
          now,
        );
      }
      for (const id of affected) {
        db.prepare(`UPDATE batches SET status='error',error=?,attempts=3,
          retry_after_ms=NULL,updated_ms=? WHERE id=? AND status!='done'
          AND COALESCE(observation_cursor,start_ms)<end_ms`).run(reason, now, id);
      }
      return count;
    },
    {
      busyTimeoutMs,
      databaseLabel: "logbook",
      operationLabel: "logbook.frames.prune",
    },
  );
  for (const day of days) {
    // Best-effort: removes now-empty day directories, keeps non-empty ones.
    try {
      rmdirSync(path.join(framesDir, day));
    } catch {}
  }
  return deleted;
}
