// Logbook SQLite store: frames on disk, everything else in one plugin-owned DB.
// Uses node:sqlite prepared statements directly (extension-local store, same
// pattern as memory-core/imessage); the shared Kysely helpers are core-only.
import { chmodSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  LOGBOOK_SCHEMA as SCHEMA,
  toFrame,
  toBatch,
  toCard,
  parseObservationContext,
  type FrameRow,
  type BatchRow,
  type CardRow,
} from "./store-schema.js";
import type {
  LogbookBatch,
  LogbookBatchStatus,
  LogbookCard,
  LogbookCardDraft,
  LogbookDayStats,
  LogbookFrame,
  LogbookObservation,
  LogbookObservationSegment,
} from "./types.js";

type Database = import("node:sqlite").DatabaseSync;

const LOGBOOK_SCHEMA_VERSION = 1;
const LOGBOOK_SQLITE_BUSY_TIMEOUT_MS = 5_000;

/** Formats an epoch-ms timestamp as a local-time YYYY-MM-DD day key. */
export function dayKeyFor(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

export class LogbookStore {
  private readonly db: Database;
  private readonly walMaintenance: ReturnType<typeof configureSqliteConnectionPragmas>;
  readonly framesDir: string;

  constructor(readonly dataDir: string) {
    // Frames and the DB hold raw screen contents; keep everything owner-only
    // even when the surrounding state dir is more permissive.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.framesDir = path.join(dataDir, "frames");
    mkdirSync(this.framesDir, { recursive: true, mode: 0o700 });
    chmodSync(this.framesDir, 0o700);
    const dbPath = path.join(dataDir, "logbook.sqlite");
    const db = openNodeSqliteDatabase(dbPath);
    let walMaintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
    try {
      // WAL/SHM sidecars inherit the main DB file's permissions.
      chmodSync(dbPath, 0o600);
      walMaintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        databasePath: dbPath,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      const versionRow = db.prepare("PRAGMA user_version").get() as
        | { user_version?: unknown }
        | undefined;
      const schemaVersion = Number(versionRow?.user_version ?? 0);
      if (schemaVersion > LOGBOOK_SCHEMA_VERSION) {
        throw new Error(
          `Logbook database uses newer schema version ${schemaVersion}; this build supports ${LOGBOOK_SCHEMA_VERSION}`,
        );
      }
      db.exec(SCHEMA);
      if (schemaVersion < LOGBOOK_SCHEMA_VERSION) {
        migrateSqliteSchemaToStrict(db, SCHEMA, { databaseLabel: dbPath });
        db.exec(`PRAGMA user_version = ${LOGBOOK_SCHEMA_VERSION};`);
      }
      // Bare nullable additions are understood by new readers and ignored by old writers.
      for (const [table, columns] of [
        ["batches", ["observation_cursor INTEGER", "attempts INTEGER", "retry_after_ms INTEGER"]],
        ["observations", ["context_json TEXT"]],
      ] as const) {
        // SAFETY: SQLite table_info returns each column name as TEXT.
        const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        for (const column of columns) {
          if (!existing.some((entry) => entry.name === column.split(" ")[0])) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
          }
        }
      }
    } catch (error) {
      walMaintenance?.close();
      db.close();
      throw error;
    }
    if (!walMaintenance) {
      db.close();
      throw new Error("Logbook SQLite maintenance failed to initialize");
    }
    this.db = db;
    this.walMaintenance = walMaintenance;
  }

  close(): void {
    this.walMaintenance.close();
    this.db.close();
  }

  frameFilePath(day: string, capturedAtMs: number): string {
    return path.join(this.framesDir, day, `${capturedAtMs}.jpg`);
  }

  insertFrame(params: {
    capturedAtMs: number;
    day: string;
    path: string;
    screenIndex: number;
    width?: number;
    height?: number;
    byteSize: number;
    contentHash: string;
    idle: boolean;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO frames (captured_at_ms, day, path, screen_index, width, height, byte_size, content_hash, idle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.capturedAtMs,
        params.day,
        params.path,
        params.screenIndex,
        params.width ?? null,
        params.height ?? null,
        params.byteSize,
        params.contentHash,
        params.idle ? 1 : 0,
      );
    return Number(result.lastInsertRowid);
  }

  lastFrame(): { capturedAtMs: number; contentHash: string } | null {
    const row = this.db
      .prepare(
        `SELECT captured_at_ms, content_hash FROM frames ORDER BY captured_at_ms DESC LIMIT 1`,
      )
      .get() as { captured_at_ms: number; content_hash: string } | undefined;
    return row ? { capturedAtMs: row.captured_at_ms, contentHash: row.content_hash } : null;
  }

  unbatchedActiveFrames(limit: number): LogbookFrame[] {
    const rows = this.db
      .prepare(
        `SELECT id, captured_at_ms, day, path, screen_index, width, height, byte_size, idle
         FROM frames WHERE batch_id IS NULL AND idle = 0
         ORDER BY captured_at_ms ASC LIMIT ?`,
      )
      .all(limit) as FrameRow[];
    return rows.map(toFrame);
  }

  countUnbatchedActiveFrames(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM frames WHERE batch_id IS NULL AND idle = 0`)
      .get() as { n: number };
    return row.n;
  }

  frameById(id: number): LogbookFrame | null {
    const row = this.db
      .prepare(
        `SELECT id, captured_at_ms, day, path, screen_index, width, height, byte_size, idle
         FROM frames WHERE id = ?`,
      )
      .get(id) as FrameRow | undefined;
    return row ? toFrame(row) : null;
  }

  framesInRange(startMs: number, endMs: number): LogbookFrame[] {
    const rows = this.db
      .prepare(
        `SELECT id, captured_at_ms, day, path, screen_index, width, height, byte_size, idle
         FROM frames WHERE captured_at_ms >= ? AND captured_at_ms < ?
         ORDER BY captured_at_ms ASC`,
      )
      .all(startMs, endMs) as FrameRow[];
    return rows.map(toFrame);
  }

  createBatch(params: { day: string; startMs: number; endMs: number; frameIds: number[] }): number {
    if (params.frameIds.length === 0) {
      throw new Error("Logbook batch requires at least one frame");
    }
    const now = Date.now();
    const insertBatch = this.db.prepare(
      `INSERT INTO batches (day, start_ms, end_ms, status, frame_count, created_ms, updated_ms)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    );
    const assignFrame = this.db.prepare(
      `UPDATE frames SET batch_id = ? WHERE id = ? AND batch_id IS NULL`,
    );
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const result = insertBatch.run(
          params.day,
          params.startMs,
          params.endMs,
          params.frameIds.length,
          now,
          now,
        );
        const batchId = Number(result.lastInsertRowid);
        for (const frameId of params.frameIds) {
          const assignment = assignFrame.run(batchId, frameId);
          if (assignment.changes !== 1) {
            throw new Error(`Logbook frame ${frameId} is missing or already batched`);
          }
        }
        return batchId;
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.batch.create",
      },
    );
  }

  beginBatch(batchId: number, model?: string): void {
    this.db
      .prepare(`UPDATE batches SET status = 'running', error = NULL,
      model = COALESCE(?, model), attempts = COALESCE(attempts, 0) + 1,
      retry_after_ms = NULL, updated_ms = ? WHERE id = ?`)
      .run(model ?? null, Date.now(), batchId);
  }

  setBatchStatus(
    batchId: number,
    status: LogbookBatchStatus,
    error?: string,
    model?: string,
  ): void {
    const now = Date.now();
    this.db
      .prepare(`UPDATE batches SET status = ?, error = ?, model = COALESCE(?, model),
      retry_after_ms = CASE WHEN ? = 'error' THEN ? +
        CASE WHEN COALESCE(attempts, 0) <= 1 THEN 60000 ELSE 300000 END ELSE NULL END,
      updated_ms = ? WHERE id = ?`)
      .run(status, error ?? null, model ?? null, status, now, now, batchId);
  }

  latestBatch(): LogbookBatch | null {
    const row = this.db
      .prepare(
        `SELECT id, day, start_ms, end_ms, status, error, frame_count, model, observation_cursor, attempts, retry_after_ms
         FROM batches ORDER BY id DESC LIMIT 1`,
      )
      .get() as BatchRow | undefined;
    return row ? toBatch(row) : null;
  }

  /** Interrupted stages retain their attempt budget and enter the same retry schedule. */
  resetRunningBatches(): void {
    // An older writer can replace observations without updating additive cursors.
    for (const row of this.db
      .prepare(`SELECT id, start_ms, observation_cursor FROM batches
      WHERE observation_cursor IS NOT NULL AND status != 'done'`)
      // SAFETY: Owned STRICT integer columns are selected with NULL cursors excluded.
      .all() as Array<{ id: number; start_ms: number; observation_cursor: number }>) {
      let cursor = row.start_ms;
      const spans = this.db
        .prepare(`SELECT start_ms, end_ms FROM observations
        WHERE batch_id = ? ORDER BY start_ms`)
        // SAFETY: Both selected times are NOT NULL INTEGER in the owned STRICT table.
        .all(row.id) as Array<{ start_ms: number; end_ms: number }>;
      for (const span of spans) {
        if (span.start_ms > cursor) {
          break;
        }
        cursor = Math.max(cursor, span.end_ms);
      }
      if (cursor < row.observation_cursor) {
        this.db.prepare("UPDATE batches SET observation_cursor = NULL WHERE id = ?").run(row.id);
      }
    }
    const rows = this.db
      .prepare(`SELECT id FROM batches WHERE status = 'running'
      OR (status = 'pending' AND attempts >= 3)`)
      // SAFETY: batches.id is the owned STRICT INTEGER primary key.
      .all() as Array<{
      id: number;
    }>;
    for (const row of rows) {
      this.setBatchStatus(row.id, "error", "analysis interrupted by restart");
    }
  }

  /** Explicit retry renews the budget without discarding completed observations. */
  resetErrorBatches(): number {
    const result = this.db
      .prepare(`UPDATE batches SET status = 'pending', error = NULL,
      attempts = 0, retry_after_ms = NULL, updated_ms = ? WHERE status = 'error'`)
      .run(Date.now());
    return Number(result.changes);
  }

  nextPendingBatch(nowMs = Date.now()): LogbookBatch | null {
    const row = this.db
      .prepare(`SELECT id, day, start_ms, end_ms, status, error, frame_count,
      model, observation_cursor, attempts, retry_after_ms FROM batches
      WHERE COALESCE(attempts, 0) < 3 AND (status = 'pending' OR
        (status = 'error' AND COALESCE(retry_after_ms, 0) <= ?))
      ORDER BY start_ms ASC LIMIT 1`)
      .get(nowMs) as BatchRow | undefined;
    return row ? toBatch(row) : null;
  }

  batchesForDay(day: string): LogbookBatch[] {
    return (
      (
        this.db
          .prepare(`SELECT id, day, start_ms, end_ms, status, error, frame_count,
      model, observation_cursor, attempts, retry_after_ms FROM batches
      WHERE day = ? ORDER BY start_ms ASC`)
          // SAFETY: This exact projection matches BatchRow and the owned STRICT batches schema.
          .all(day) as BatchRow[]
      ).map(toBatch)
    );
  }

  batchFrames(batchId: number): LogbookFrame[] {
    const rows = this.db
      .prepare(
        `SELECT id, captured_at_ms, day, path, screen_index, width, height, byte_size, idle
         FROM frames WHERE batch_id = ? ORDER BY captured_at_ms ASC`,
      )
      .all(batchId) as FrameRow[];
    return rows.map(toFrame);
  }

  /** Commit completed vision evidence and its resume boundary together. */
  checkpointObservations(
    batch: LogbookBatch,
    endMs: number,
    segments: LogbookObservationSegment[],
  ): void {
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const current = this.db
          .prepare(`SELECT COALESCE(observation_cursor, start_ms) AS cursor,
        end_ms FROM batches WHERE id = ?`)
          // SAFETY: COALESCE uses NOT NULL start_ms; both selected times are STRICT INTEGER.
          .get(batch.id) as { cursor: number; end_ms: number } | undefined;
        if (
          !current ||
          endMs <= current.cursor ||
          endMs > current.end_ms ||
          segments.length === 0 ||
          segments.some((segment) => segment.startMs < current.cursor || segment.endMs > endMs)
        ) {
          throw new Error("invalid or stale Logbook observation checkpoint");
        }
        this.db
          .prepare(`DELETE FROM observations WHERE batch_id = ? AND
          end_ms > ? AND start_ms < ?`)
          .run(batch.id, current.cursor, endMs);
        const insert = this.db.prepare(`INSERT INTO observations
        (batch_id, day, start_ms, end_ms, text, context_json) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const segment of segments) {
          insert.run(
            batch.id,
            batch.day,
            segment.startMs,
            segment.endMs,
            segment.text,
            segment.context ? JSON.stringify(segment.context) : null,
          );
        }
        this.db
          .prepare(`UPDATE batches SET observation_cursor = ?, attempts = 0,
        retry_after_ms = NULL, updated_ms = ? WHERE id = ?`)
          .run(endMs, Date.now(), batch.id);
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.observations.checkpoint",
      },
    );
  }

  observationsInRange(day: string, startMs: number, endMs: number): LogbookObservation[] {
    const rows = this.db
      .prepare(
        `SELECT id, batch_id, day, start_ms, end_ms, text, context_json FROM observations
         WHERE day = ? AND end_ms > ? AND start_ms < ? ORDER BY start_ms ASC`,
      )
      .all(day, startMs, endMs) as Array<{
      id: number;
      batch_id: number;
      day: string;
      start_ms: number;
      end_ms: number;
      text: string;
      context_json: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      day: row.day,
      startMs: row.start_ms,
      endMs: row.end_ms,
      text: row.text,
      context: parseObservationContext(row.context_json),
    }));
  }

  cardsForDay(day: string): LogbookCard[] {
    const rows = this.db
      .prepare(
        `SELECT id, day, start_ms, end_ms, title, summary, detail, category, app_primary, app_secondary, distractions, keyframe_id
         FROM cards WHERE day = ? ORDER BY start_ms ASC`,
      )
      .all(day) as CardRow[];
    return rows.map(toCard);
  }

  cardById(id: number): LogbookCard | null {
    const row = this.db
      .prepare(
        `SELECT id, day, start_ms, end_ms, title, summary, detail, category, app_primary, app_secondary, distractions, keyframe_id
         FROM cards WHERE id = ?`,
      )
      .get(id) as CardRow | undefined;
    return row ? toCard(row) : null;
  }

  /**
   * Replaces cards overlapping [startMs, endMs) for a day in one transaction.
   * The analysis lookback treats recent cards as a revisable draft, so partial
   * writes here would surface as duplicated or missing timeline segments.
   */
  replaceCardsInWindow(
    day: string,
    startMs: number,
    endMs: number,
    drafts: LogbookCardDraft[],
  ): void {
    const now = Date.now();
    const deleteWindow = this.db.prepare(
      `DELETE FROM cards WHERE day = ? AND end_ms > ? AND start_ms < ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO cards (day, start_ms, end_ms, title, summary, detail, category, app_primary, app_secondary, distractions, keyframe_id, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        deleteWindow.run(day, startMs, endMs);
        this.invalidateStandups(day);
        for (const draft of drafts) {
          insert.run(
            draft.day,
            draft.startMs,
            draft.endMs,
            draft.title,
            draft.summary,
            draft.detail,
            draft.category,
            draft.appPrimary ?? null,
            draft.appSecondary ?? null,
            JSON.stringify(draft.distractions),
            draft.keyframeId ?? null,
            now,
          );
        }
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.cards.replace",
      },
    );
  }

  listDays(): Array<{ day: string; cards: number; firstMs: number; lastMs: number }> {
    const rows = this.db
      .prepare(
        `SELECT day, COUNT(*) AS cards, MIN(start_ms) AS first_ms, MAX(end_ms) AS last_ms
         FROM cards GROUP BY day ORDER BY day DESC`,
      )
      .all() as Array<{ day: string; cards: number; first_ms: number; last_ms: number }>;
    return rows.map((row) => ({
      day: row.day,
      cards: row.cards,
      firstMs: row.first_ms,
      lastMs: row.last_ms,
    }));
  }

  dayStats(day: string): LogbookDayStats {
    const cards = this.cardsForDay(day);
    const categories = new Map<string, number>();
    const apps = new Map<string, number>();
    let trackedMs = 0;
    let distractionMs = 0;
    for (const card of cards) {
      const duration = Math.max(0, card.endMs - card.startMs);
      trackedMs += duration;
      categories.set(card.category, (categories.get(card.category) ?? 0) + duration);
      if (card.appPrimary) {
        apps.set(card.appPrimary, (apps.get(card.appPrimary) ?? 0) + duration);
      }
      for (const distraction of card.distractions) {
        distractionMs += Math.max(0, distraction.endMs - distraction.startMs);
      }
    }
    const byMsDesc = (a: { ms: number }, b: { ms: number }) => b.ms - a.ms;
    return {
      trackedMs,
      distractionMs,
      categories: [...categories.entries()]
        .map(([category, ms]) => ({ category, ms }))
        .toSorted(byMsDesc),
      apps: [...apps.entries()].map(([domain, ms]) => ({ domain, ms })).toSorted(byMsDesc),
    };
  }

  getStandup(day: string): { day: string; text: string; updatedMs: number } | null {
    const row = this.db
      .prepare(`SELECT day, text, updated_ms FROM standups WHERE day = ?`)
      .get(day) as { day: string; text: string; updated_ms: number } | undefined;
    return row ? { day: row.day, text: row.text, updatedMs: row.updated_ms } : null;
  }

  saveStandup(day: string, text: string): void {
    this.db
      .prepare(
        `INSERT INTO standups (day, text, updated_ms) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET text = excluded.text, updated_ms = excluded.updated_ms`,
      )
      .run(day, text, Date.now());
  }

  private invalidateStandups(day: string): number {
    // The next day's standup also quotes this day's cards.
    return Number(
      this.db
        .prepare(`DELETE FROM standups
      WHERE day = ? OR day = date(?, '+1 day')`)
        .run(day, day).changes,
    );
  }

  /** Explicit operator deletion includes both captured evidence and all derived day data. */
  deleteDay(day: string): {
    frames: number;
    batches: number;
    observations: number;
    cards: number;
    standups: number;
  } {
    // SAFETY: frames.path is NOT NULL TEXT in the owned STRICT frames table.
    const files = this.db.prepare("SELECT path FROM frames WHERE day = ?").all(day) as Array<{
      path: string;
    }>;
    // Metadata remains the retry manifest if a later unlink or the transaction fails.
    // force tolerates files removed by an earlier attempt, including after reopen.
    for (const file of files) {
      rmSync(file.path, { force: true });
    }
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const counts = { frames: 0, batches: 0, observations: 0, cards: 0, standups: 0 };
        for (const table of ["cards", "observations", "frames", "batches"] as const) {
          counts[table] = Number(
            this.db.prepare(`DELETE FROM ${table} WHERE day = ?`).run(day).changes,
          );
        }
        counts.standups = this.invalidateStandups(day);
        return counts;
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.day.delete",
      },
    );
  }

  /** Deletes frame rows and files older than the retention window. */
  pruneFrames(olderThanMs: number, olderUnfinishedThanMs = olderThanMs): number {
    const selectExpired = this.db.prepare(
      `SELECT id, path, day, captured_at_ms, batch_id, idle FROM frames WHERE captured_at_ms < ? AND
       (captured_at_ms < ? OR idle = 1 OR EXISTS (
         SELECT 1 FROM batches WHERE batches.id = frames.batch_id
         AND (status = 'done' OR observation_cursor >= end_ms)))`,
    );
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
    const selectCurrent = this.db.prepare(`SELECT path FROM frames WHERE id = ?`);
    const deleteById = this.db.prepare(`DELETE FROM frames WHERE id = ?`);
    const deleted = runSqliteImmediateTransactionSync(
      this.db,
      () => {
        let count = 0;
        const unavailable = new Map<string, { start: number; end: number; count: number }>();
        const affected = new Set<number>();
        for (const row of rows) {
          const current = selectCurrent.get(row.id) as { path: string } | undefined;
          if (!current) {
            continue;
          }
          if (current.path !== row.path) {
            throw new Error(`Logbook frame ${row.id} changed path while pruning`);
          }
          // keyframe_id uses ON DELETE SET NULL, so the same commit cannot
          // leave surviving cards pointed at removed frame rows.
          count += Number(deleteById.run(row.id).changes);
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
          this.db
            .prepare(`INSERT INTO batches(day,start_ms,end_ms,status,error,frame_count,
            created_ms,updated_ms,attempts) VALUES (?,?,?,'error',?,?,?,?,3)`)
            .run(day, span.start, span.end, reason, span.count, now, now);
        }
        for (const id of affected) {
          this.db
            .prepare(`UPDATE batches SET status='error',error=?,attempts=3,
            retry_after_ms=NULL,updated_ms=? WHERE id=? AND status!='done'
            AND COALESCE(observation_cursor,start_ms)<end_ms`)
            .run(reason, now, id);
        }
        return count;
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.frames.prune",
      },
    );
    for (const day of days) {
      // Best-effort: removes now-empty day directories, keeps non-empty ones.
      try {
        rmdirSync(path.join(this.framesDir, day));
      } catch {}
    }
    return deleted;
  }
}
