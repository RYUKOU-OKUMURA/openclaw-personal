import type { DatabaseSync } from "node:sqlite";
import {
  WORKBOARD_PLANNING_INBOX_ID,
  type WorkboardPlanningBoard,
  type WorkboardPlanningCard,
  type WorkboardPlanningColumn,
} from "@openclaw/workboard-contract";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { WorkboardPlanningConflictError } from "./planning-errors.js";
import { normalizeBoardIdRequired } from "./store-normalizers.js";

// Additive plugin-owned tables: older readers ignore planning and retain execution semantics.
export const WORKBOARD_PLANNING_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS workboard_planning_boards (
    board_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    columns_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS workboard_planning_cards (
    card_id TEXT PRIMARY KEY REFERENCES workboard_cards(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL,
    column_id TEXT NOT NULL,
    planning_order REAL NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workboard_planning_cards_board_idx
    ON workboard_planning_cards(board_id, column_id, planning_order);
`;

type PlanningDatabase = {
  workboard_planning_boards: { board_id: string; revision: number; columns_json: string };
  workboard_planning_cards: {
    card_id: string;
    board_id: string;
    column_id: string;
    planning_order: number;
  };
  workboard_cards: { id: string; board_id: string; created_at: number };
  workboard_boards: { id: string };
};

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
    throw new Error(`${label} must be a stable identifier (1–80 letters, digits, _ or -).`);
  }
  return value;
}

function order(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e12) {
    throw new Error("planning order must be a finite number between -1e12 and 1e12.");
  }
  return value;
}

function columns(value: unknown): WorkboardPlanningColumn[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error("planning requires 1–32 columns including inbox.");
  }
  const ids = new Set<string>();
  const result = value.map((column: unknown) => {
    if (!isRecord(column)) {
      throw new Error("invalid planning column.");
    }
    const id = identifier(column.id, "column id");
    if (ids.has(id)) {
      throw new Error("planning column ids must be unique.");
    }
    ids.add(id);
    if (typeof column.name !== "string" || !column.name.trim() || column.name.trim().length > 80) {
      throw new Error("planning column name must contain 1–80 characters.");
    }
    if (
      typeof column.width !== "number" ||
      !Number.isFinite(column.width) ||
      column.width < 200 ||
      column.width > 800
    ) {
      throw new Error("planning column width must be between 200 and 800.");
    }
    return { id, name: column.name.trim(), width: column.width, order: order(column.order) };
  });
  if (!ids.has(WORKBOARD_PLANNING_INBOX_ID)) {
    throw new Error("inbox cannot be deleted.");
  }
  return result.toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function destinations(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("deletedColumnDestinations must be an object.");
  }
  return Object.fromEntries(
    Object.entries(value).map(([from, to]) => [
      identifier(from, "deleted column id"),
      identifier(to, "destination column id"),
    ]),
  );
}

export class WorkboardSqlitePlanningStore {
  constructor(private readonly db: DatabaseSync) {}

  private query() {
    return getNodeSqliteKysely<PlanningDatabase>(this.db);
  }

  private read(boardId: string): WorkboardPlanningBoard {
    const query = this.query();
    const cardRows = executeSqliteQuerySync(
      this.db,
      query
        .selectFrom("workboard_cards")
        .leftJoin(
          "workboard_planning_cards",
          "workboard_planning_cards.card_id",
          "workboard_cards.id",
        )
        .select([
          "workboard_cards.id",
          "workboard_planning_cards.board_id as placement_board_id",
          "column_id",
          "planning_order",
        ])
        .where("workboard_cards.board_id", "=", boardId)
        .orderBy("workboard_cards.created_at")
        .orderBy("workboard_cards.id"),
    ).rows;
    if (
      boardId !== "default" &&
      cardRows.length === 0 &&
      !executeSqliteQueryTakeFirstSync(
        this.db,
        query.selectFrom("workboard_boards").select("id").where("id", "=", boardId),
      )
    ) {
      throw new Error(`board not found: ${boardId}`);
    }
    const saved = executeSqliteQueryTakeFirstSync(
      this.db,
      query.selectFrom("workboard_planning_boards").selectAll().where("board_id", "=", boardId),
    );
    const layout = saved
      ? columns(JSON.parse(saved.columns_json))
      : [{ id: WORKBOARD_PLANNING_INBOX_ID, name: "Inbox", width: 300, order: 0 }];
    const ids = new Set(layout.map((column) => column.id));
    const maxSavedOrder = cardRows.reduce(
      (max, row) =>
        row.placement_board_id === boardId && row.planning_order !== null
          ? Math.max(max, row.planning_order)
          : max,
      0,
    );
    return {
      boardId,
      revision: saved?.revision ?? 0,
      columns: layout,
      cards: cardRows.map((row, index) => ({
        cardId: row.id,
        columnId:
          row.placement_board_id === boardId && row.column_id && ids.has(row.column_id)
            ? row.column_id
            : WORKBOARD_PLANNING_INBOX_ID,
        order:
          row.placement_board_id === boardId && row.planning_order !== null
            ? row.planning_order
            : maxSavedOrder + (index + 1) * 1024,
      })),
    };
  }

  get(boardId: unknown): WorkboardPlanningBoard {
    const id = normalizeBoardIdRequired(boardId);
    // One snapshot includes both column definitions and the current card membership.
    return runSqliteImmediateTransactionSync(this.db, () => this.read(id));
  }

  private assertRevision(current: WorkboardPlanningBoard, revision: unknown) {
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("expectedRevision must be a non-negative safe integer.");
    }
    if (revision !== current.revision) {
      throw new WorkboardPlanningConflictError(current);
    }
  }

  private save(current: WorkboardPlanningBoard, layout: WorkboardPlanningColumn[]) {
    executeSqliteQuerySync(
      this.db,
      this.query()
        .insertInto("workboard_planning_boards")
        .values({
          board_id: current.boardId,
          revision: current.revision + 1,
          columns_json: JSON.stringify(layout),
        })
        .onConflict((conflict) =>
          conflict
            .column("board_id")
            .doUpdateSet({ revision: current.revision + 1, columns_json: JSON.stringify(layout) }),
        ),
    );
  }

  private place(boardId: string, cardId: string, columnId: string, position: number) {
    executeSqliteQuerySync(
      this.db,
      this.query()
        .insertInto("workboard_planning_cards")
        .values({
          card_id: cardId,
          board_id: boardId,
          column_id: columnId,
          planning_order: position,
        })
        .onConflict((conflict) =>
          conflict
            .column("card_id")
            .doUpdateSet({ board_id: boardId, column_id: columnId, planning_order: position }),
        ),
    );
  }

  private orderColumn(boardId: string, columnId: string, cards: WorkboardPlanningCard[]) {
    // Spaced canonical positions keep subsequent midpoint insertions usable, including
    // after merging two columns whose previous positions overlapped.
    cards
      .toSorted((a, b) => a.order - b.order || a.cardId.localeCompare(b.cardId))
      .forEach((card, index) => this.place(boardId, card.cardId, columnId, index * 1024));
  }

  update(input: Record<string, unknown>): WorkboardPlanningBoard {
    const boardId = normalizeBoardIdRequired(input.boardId);
    const layout = columns(input.columns);
    const moves = destinations(input.deletedColumnDestinations);
    return runSqliteImmediateTransactionSync(this.db, () => {
      const current = this.read(boardId);
      this.assertRevision(current, input.expectedRevision);
      const ids = new Set(layout.map((column) => column.id));
      const removed = new Set(
        current.columns.filter((column) => !ids.has(column.id)).map((column) => column.id),
      );
      const validatedMoves = new Map<string, string>();
      for (const id of removed) {
        const destination = moves[id];
        if (!Object.hasOwn(moves, id) || destination === undefined || !ids.has(destination)) {
          throw new Error("each deleted column requires a destination in the remaining columns.");
        }
        validatedMoves.set(id, destination);
      }
      if (Object.keys(moves).some((id) => !removed.has(id))) {
        throw new Error("destinations may only refer to deleted columns.");
      }
      for (const destination of new Set(validatedMoves.values())) {
        this.orderColumn(
          boardId,
          destination,
          current.cards.filter(
            (card) =>
              card.columnId === destination || validatedMoves.get(card.columnId) === destination,
          ),
        );
      }
      this.save(current, layout);
      return this.read(boardId);
    });
  }

  move(input: Record<string, unknown>): WorkboardPlanningBoard {
    const boardId = normalizeBoardIdRequired(input.boardId);
    const cardId = identifier(input.cardId, "cardId");
    const columnId = identifier(input.columnId, "columnId");
    const position = order(input.order);
    return runSqliteImmediateTransactionSync(this.db, () => {
      const current = this.read(boardId);
      this.assertRevision(current, input.expectedRevision);
      if (!current.cards.some((card) => card.cardId === cardId)) {
        throw new Error("card does not belong to this board.");
      }
      if (!current.columns.some((column) => column.id === columnId)) {
        throw new Error("planning column not found.");
      }
      this.orderColumn(boardId, columnId, [
        ...current.cards.filter((card) => card.columnId === columnId && card.cardId !== cardId),
        { cardId, columnId, order: position },
      ]);
      this.save(current, current.columns);
      return this.read(boardId);
    });
  }
}

/** Called inside the existing card writer's transaction, including board moves by old APIs. */
export function resetPlanningForBoardMove(db: DatabaseSync, cardId: string, boardId: string): void {
  const query = getNodeSqliteKysely<PlanningDatabase>(db);
  const previous = executeSqliteQueryTakeFirstSync(
    db,
    query.selectFrom("workboard_planning_cards").select("board_id").where("card_id", "=", cardId),
  );
  if (!previous || previous.board_id === boardId) {
    return;
  }
  executeSqliteQuerySync(
    db,
    query.deleteFrom("workboard_planning_cards").where("card_id", "=", cardId),
  );
  executeSqliteQuerySync(
    db,
    query
      .updateTable("workboard_planning_boards")
      .set((eb) => ({ revision: eb("revision", "+", 1) }))
      .where("board_id", "in", [previous.board_id, boardId]),
  );
}

export function deleteBoardPlanning(db: DatabaseSync, boardId: string): void {
  const query = getNodeSqliteKysely<PlanningDatabase>(db);
  executeSqliteQuerySync(
    db,
    query.deleteFrom("workboard_planning_cards").where("board_id", "=", boardId),
  );
  executeSqliteQuerySync(
    db,
    query.deleteFrom("workboard_planning_boards").where("board_id", "=", boardId),
  );
}
