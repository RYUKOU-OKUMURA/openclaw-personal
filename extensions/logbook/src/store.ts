// Logbook SQLite store: frames on disk, everything else in one plugin-owned DB.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { pruneLogbookFrames } from "./store-retention.js";
import {
  LOGBOOK_SCHEMA as SCHEMA,
  toFrame,
  toBatch,
  toCard,
  parseObservationContext,
  type BatchRow,
} from "./store-schema.js";
import type {
  LogbookBatch,
  LogbookBatchStatus,
  LogbookCard,
  LogbookCardDraft,
  LogbookDatabase,
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
  private readonly query;
  private readonly framesQuery;
  private readonly batchesQuery;
  private readonly cardsQuery;
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
    this.query = getNodeSqliteKysely<LogbookDatabase>(db);
    // Timestamp ties follow insertion ids, matching existing SQLite reads.
    this.framesQuery = this.query
      .selectFrom("frames")
      .select([
        "id",
        "captured_at_ms",
        "day",
        "path",
        "screen_index",
        "width",
        "height",
        "byte_size",
        "idle",
      ])
      .orderBy("captured_at_ms", "asc")
      .orderBy("id", "asc");
    this.batchesQuery = this.query
      .selectFrom("batches")
      .select([
        "id",
        "day",
        "start_ms",
        "end_ms",
        "status",
        "error",
        "frame_count",
        "model",
        "observation_cursor",
        "attempts",
        "retry_after_ms",
      ]);
    this.cardsQuery = this.query.selectFrom("cards");
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
    const { compiled, bind } = compileSqliteQueryBindings<typeof params>((p) =>
      this.query.insertInto("frames").values({
        captured_at_ms: p((row) => row.capturedAtMs),
        day: p((row) => row.day),
        path: p((row) => row.path),
        screen_index: p((row) => row.screenIndex),
        width: p((row) => row.width ?? null),
        height: p((row) => row.height ?? null),
        byte_size: p((row) => row.byteSize),
        content_hash: p((row) => row.contentHash),
        idle: p((row) => (row.idle ? 1 : 0)),
      }),
    );
    const result = this.db.prepare(compiled.sql).run(...bind(params));
    return Number(result.lastInsertRowid);
  }

  lastFrame(): { capturedAtMs: number; contentHash: string } | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("frames")
        .select(["captured_at_ms", "content_hash"])
        .orderBy("captured_at_ms", "desc")
        .orderBy("id", "desc")
        .limit(1),
    );
    return row ? { capturedAtMs: row.captured_at_ms, contentHash: row.content_hash } : null;
  }

  unbatchedActiveFrames(limit: number): LogbookFrame[] {
    return executeSqliteQuerySync(
      this.db,
      this.framesQuery.where("batch_id", "is", null).where("idle", "=", 0).limit(limit),
    ).rows.map(toFrame);
  }

  countUnbatchedActiveFrames(): number {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("frames")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("batch_id", "is", null)
        .where("idle", "=", 0),
    );
    return expectDefined(row, "Logbook unbatched frame count").n;
  }

  frameById(id: number): LogbookFrame | null {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.framesQuery.where("id", "=", id));
    return row ? toFrame(row) : null;
  }

  framesInRange(startMs: number, endMs: number): LogbookFrame[] {
    return executeSqliteQuerySync(
      this.db,
      this.framesQuery.where("captured_at_ms", ">=", startMs).where("captured_at_ms", "<", endMs),
    ).rows.map(toFrame);
  }

  createBatch(params: { day: string; startMs: number; endMs: number; frameIds: number[] }): number {
    if (params.frameIds.length === 0) {
      throw new Error("Logbook batch requires at least one frame");
    }
    const now = Date.now();
    const batch = compileSqliteQueryBindings<typeof params>((p) =>
      this.query.insertInto("batches").values({
        day: p((row) => row.day),
        start_ms: p((row) => row.startMs),
        end_ms: p((row) => row.endMs),
        status: "pending",
        frame_count: p((row) => row.frameIds.length),
        created_ms: now,
        updated_ms: now,
      }),
    );
    const insertBatch = this.db.prepare(batch.compiled.sql);
    const assignment = compileSqliteQueryBindings<{ batchId: number; frameId: number }>((p) =>
      this.query
        .updateTable("frames")
        .set({ batch_id: p((row) => row.batchId) })
        .where(
          "id",
          "=",
          p((row) => row.frameId),
        )
        .where("batch_id", "is", null),
    );
    const assignFrame = this.db.prepare(assignment.compiled.sql);
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const result = insertBatch.run(...batch.bind(params));
        const batchId = Number(result.lastInsertRowid);
        for (const frameId of params.frameIds) {
          const assigned = assignFrame.run(...assignment.bind({ batchId, frameId }));
          if (assigned.changes !== 1) {
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
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.batchesQuery.orderBy("id", "desc").limit(1),
    );
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
      ORDER BY start_ms ASC, id ASC LIMIT 1`)
      .get(nowMs) as BatchRow | undefined;
    return row ? toBatch(row) : null;
  }

  batchesForDay(day: string): LogbookBatch[] {
    return (
      (
        this.db
          .prepare(`SELECT id, day, start_ms, end_ms, status, error, frame_count,
      model, observation_cursor, attempts, retry_after_ms FROM batches
      WHERE day = ? ORDER BY start_ms ASC, id ASC`)
          // SAFETY: This exact projection matches BatchRow and the owned STRICT batches schema.
          .all(day) as BatchRow[]
      ).map(toBatch)
    );
  }

  batchFrames(batchId: number): LogbookFrame[] {
    return executeSqliteQuerySync(
      this.db,
      this.framesQuery.where("batch_id", "=", batchId),
    ).rows.map(toFrame);
  }

  replaceObservations(
    batchId: number,
    day: string,
    segments: Array<{ startMs: number; endMs: number; text: string }>,
  ): void {
    const deletion = compileSqliteQueryBindings<void>(() =>
      this.query.deleteFrom("observations").where("batch_id", "=", batchId),
    );
    const deleteBatch = this.db.prepare(deletion.compiled.sql);
    const observation = compileSqliteQueryBindings<(typeof segments)[number]>((p) =>
      this.query.insertInto("observations").values({
        batch_id: batchId,
        day,
        start_ms: p((row) => row.startMs),
        end_ms: p((row) => row.endMs),
        text: p((row) => row.text),
      }),
    );
    const insert = this.db.prepare(observation.compiled.sql);
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        deleteBatch.run(...deletion.bind());
        for (const segment of segments) {
          insert.run(...observation.bind(segment));
        }
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.observations.replace",
      },
    );
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

  observationsInRange(
    day: string,
    startMs: number,
    endMs: number,
    tailLimit?: number,
  ): LogbookObservation[] {
    const direction = tailLimit === undefined ? "asc" : "desc";
    let query = this.query
      .selectFrom("observations")
      .selectAll()
      .where("day", "=", day)
      .where("end_ms", ">", startMs)
      .where("start_ms", "<", endMs)
      .orderBy("start_ms", direction)
      .orderBy("id", direction);
    if (tailLimit !== undefined) {
      query = query.limit(tailLimit);
    }
    const rows = executeSqliteQuerySync(this.db, query).rows;
    // Reverse the stable timestamp/id tail so prompts keep their original chronology.
    if (tailLimit !== undefined) {
      rows.reverse();
    }
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

  cardsForDay(day: string, window?: { startMs: number; endMs: number }): LogbookCard[] {
    let query = this.cardsQuery
      .selectAll()
      .where("day", "=", day)
      .orderBy("start_ms", "asc")
      .orderBy("id", "asc");
    if (window) {
      query = query.where("end_ms", ">", window.startMs).where("start_ms", "<", window.endMs);
    }
    return executeSqliteQuerySync(this.db, query).rows.map(toCard);
  }

  countCardsForDay(day: string): number {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.cardsQuery.select((eb) => eb.fn.countAll<number>().as("count")).where("day", "=", day),
    );
    return expectDefined(row, "Logbook card count").count;
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
    const deletion = compileSqliteQueryBindings<void>(() =>
      this.query
        .deleteFrom("cards")
        .where("day", "=", day)
        .where("end_ms", ">", startMs)
        .where("start_ms", "<", endMs),
    );
    const deleteWindow = this.db.prepare(deletion.compiled.sql);
    const card = compileSqliteQueryBindings<LogbookCardDraft>((p) =>
      this.query.insertInto("cards").values({
        day: p((row) => row.day),
        start_ms: p((row) => row.startMs),
        end_ms: p((row) => row.endMs),
        title: p((row) => row.title),
        summary: p((row) => row.summary),
        detail: p((row) => row.detail),
        category: p((row) => row.category),
        app_primary: p((row) => row.appPrimary ?? null),
        app_secondary: p((row) => row.appSecondary ?? null),
        distractions: p((row) => JSON.stringify(row.distractions)),
        keyframe_id: p((row) => row.keyframeId ?? null),
        updated_ms: now,
      }),
    );
    const insert = this.db.prepare(card.compiled.sql);
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        deleteWindow.run(...deletion.bind());
        this.invalidateStandups(day);
        for (const draft of drafts) {
          insert.run(...card.bind(draft));
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
    return executeSqliteQuerySync(
      this.db,
      this.cardsQuery
        .select((eb) => [
          "day",
          eb.fn.countAll<number>().as("cards"),
          eb.fn.min<number>("start_ms").as("first_ms"),
          eb.fn.max<number>("end_ms").as("last_ms"),
        ])
        .groupBy("day")
        .orderBy("day", "desc"),
    ).rows.map((row) => ({
      day: row.day,
      cards: row.cards,
      firstMs: row.first_ms,
      lastMs: row.last_ms,
    }));
  }

  timelineForDay(day: string): { day: string; cards: LogbookCard[]; stats: LogbookDayStats } {
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
      day,
      cards,
      stats: {
        trackedMs,
        distractionMs,
        categories: [...categories.entries()]
          .map(([category, ms]) => ({ category, ms }))
          .toSorted(byMsDesc),
        apps: [...apps.entries()].map(([domain, ms]) => ({ domain, ms })).toSorted(byMsDesc),
      },
    };
  }

  getStandup(day: string): { day: string; text: string; updatedMs: number } | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("standups").selectAll().where("day", "=", day),
    );
    return row ? { day: row.day, text: row.text, updatedMs: row.updated_ms } : null;
  }

  saveStandup(day: string, text: string): void {
    const { compiled, bind } = compileSqliteQueryBindings<void>((p) =>
      this.query
        .insertInto("standups")
        .values({ day, text, updated_ms: p(() => Date.now()) })
        .onConflict((conflict) =>
          conflict.column("day").doUpdateSet((eb) => ({
            text: eb.ref("excluded.text"),
            updated_ms: eb.ref("excluded.updated_ms"),
          })),
        ),
    );
    this.db.prepare(compiled.sql).run(...bind());
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
    return pruneLogbookFrames({
      db: this.db,
      framesDir: this.framesDir,
      olderThanMs,
      olderUnfinishedThanMs,
      busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
    });
  }
}
