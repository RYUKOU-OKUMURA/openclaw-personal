import {
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { LogbookOperations } from "./store-contract.js";
import { toBatch, type BatchRow, type LogbookDatabase } from "./store-schema.js";
import type { LogbookBatch, LogbookBatchStatus, LogbookObservationSegment } from "./types.js";

/** Worker-owned retry and observation kernels share the owner's admitted connection. */
export class LogbookAnalysisStore {
  private readonly updateBatchStatus;
  constructor(
    private readonly db: import("node:sqlite").DatabaseSync,
    private readonly busyTimeoutMs: number,
  ) {
    const query = getNodeSqliteKysely<LogbookDatabase>(db);
    this.updateBatchStatus = prepareSqliteQuerySync<
      LogbookOperations["setBatchStatus"]["input"] & { now: number }
    >(db, (p) =>
      query
        .updateTable("batches")
        .set((eb) => ({
          status: p((row) => row.status),
          error: p((row) => row.error ?? null),
          model: eb.fn.coalesce(
            p((row) => row.model ?? null),
            "model",
          ),
          retry_after_ms: eb
            .case()
            .when(
              p((row) => row.status),
              "=",
              "error",
            )
            .then(
              eb(
                p((row) => row.now),
                "+",
                eb
                  .case()
                  .when(eb.fn.coalesce("attempts", eb.val(0)), "<=", 1)
                  .then(60000)
                  .else(300000)
                  .end(),
              ),
            )
            .else(null)
            .end(),
          updated_ms: p((row) => row.now),
        }))
        .where(
          "id",
          "=",
          p((row) => row.batchId),
        ),
    );
  }
  setBatchStatus(
    batchId: number,
    status: LogbookBatchStatus,
    error?: string,
    model?: string,
  ): void {
    this.updateBatchStatus({ batchId, status, error, model, now: Date.now() });
  }

  beginBatch(batchId: number, model?: string): void {
    this.db
      .prepare(`UPDATE batches SET status = 'running', error = NULL,
      model = COALESCE(?, model), attempts = COALESCE(attempts, 0) + 1,
      retry_after_ms = NULL, updated_ms = ? WHERE id = ?`)
      .run(model ?? null, Date.now(), batchId);
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
        busyTimeoutMs: this.busyTimeoutMs,
        databaseLabel: "logbook",
        operationLabel: "logbook.observations.checkpoint",
      },
    );
  }

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
}
