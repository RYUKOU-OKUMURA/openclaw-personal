import { rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { LogbookDatabase } from "./store-schema.js";

type Database = import("node:sqlite").DatabaseSync;

const FRAME_PRUNE_BATCH_SIZE = 64;

export function invalidateLogbookStandups(db: Database, day: string): number {
  return Number(
    db
      .prepare(`DELETE FROM standups
      WHERE day = ? OR day = date(?, '+1 day')`)
      .run(day, day).changes,
  );
}

export function deleteLogbookDay(
  db: Database,
  day: string,
  busyTimeoutMs: number,
): {
  frames: number;
  batches: number;
  observations: number;
  cards: number;
  standups: number;
} {
  // SAFETY: frames.path is NOT NULL TEXT in the owned STRICT frames table.
  const files = db.prepare("SELECT path FROM frames WHERE day = ?").all(day) as Array<{
    path: string;
  }>;
  // Metadata remains the retry manifest if a later unlink or the transaction fails.
  // force tolerates files removed by an earlier attempt, including after reopen.
  for (const file of files) {
    rmSync(file.path, { force: true });
  }
  return runSqliteImmediateTransactionSync(
    db,
    () => {
      const counts = { frames: 0, batches: 0, observations: 0, cards: 0, standups: 0 };
      for (const table of ["cards", "observations", "frames", "batches"] as const) {
        counts[table] = Number(db.prepare(`DELETE FROM ${table} WHERE day = ?`).run(day).changes);
      }
      counts.standups = invalidateLogbookStandups(db, day);
      return counts;
    },
    {
      busyTimeoutMs,
      databaseLabel: "logbook",
      operationLabel: "logbook.day.delete",
    },
  );
}

/** Worker-owned frame retention keeps batched reads and records expired unfinished intervals. */
export function pruneLogbookFrames(params: {
  db: import("node:sqlite").DatabaseSync;
  framesDir: string;
  olderThanMs: number;
  olderUnfinishedThanMs?: number;
  busyTimeoutMs: number;
}): number {
  const { db, framesDir, olderThanMs, olderUnfinishedThanMs = olderThanMs, busyTimeoutMs } = params;
  const query = getNodeSqliteKysely<LogbookDatabase>(db);
  const rows = executeSqliteQuerySync(
    db,
    query
      .selectFrom("frames")
      .select(["id", "path", "day", "captured_at_ms", "batch_id", "idle"])
      .where("captured_at_ms", "<", olderThanMs)
      .where((eb) =>
        eb.or([
          eb("captured_at_ms", "<", olderUnfinishedThanMs),
          eb("idle", "=", 1),
          eb.exists(
            eb
              .selectFrom("batches")
              .select("batches.id")
              .whereRef("batches.id", "=", "frames.batch_id")
              .where((batch) =>
                batch.or([
                  batch("status", "=", "done"),
                  batch("observation_cursor", ">=", batch.ref("end_ms")),
                ]),
              ),
          ),
        ]),
      ),
  ).rows;
  if (rows.length === 0) {
    return 0;
  }
  const days = new Set<string>();
  for (const row of rows) {
    // Keep metadata until every file is removed; force makes interrupted passes retryable.
    rmSync(row.path, { force: true });
    days.add(row.day);
  }
  const deleted = runSqliteImmediateTransactionSync(
    db,
    () => {
      let count = 0;
      const unavailable = new Map<string, { start: number; end: number; count: number }>();
      const affected = new Set<number>();
      for (let offset = 0; offset < rows.length; offset += FRAME_PRUNE_BATCH_SIZE) {
        const batch = rows.slice(offset, offset + FRAME_PRUNE_BATCH_SIZE);
        const ids = batch.map((row) => row.id);
        const currentPaths = new Map(
          executeSqliteQuerySync(
            db,
            query.selectFrom("frames").select(["id", "path"]).where("id", "in", ids),
          ).rows.map((row) => [row.id, row.path]),
        );
        for (const row of batch) {
          if (currentPaths.has(row.id) && currentPaths.get(row.id) !== row.path) {
            throw new Error(`Logbook frame ${row.id} changed path while pruning`);
          }
          if (!currentPaths.has(row.id)) {
            continue;
          }
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
        // ON DELETE SET NULL clears surviving cards' keyframes in the same commit.
        const result = executeSqliteQuerySync(
          db,
          query.deleteFrom("frames").where("id", "in", ids),
        );
        count += Number(expectDefined(result.numAffectedRows, "Logbook pruned frame count"));
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
