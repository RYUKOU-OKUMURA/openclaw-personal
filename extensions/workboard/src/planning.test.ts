import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkboardPlanningColumn } from "@openclaw/workboard-contract";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { WorkboardPlanningConflictError } from "./planning-errors.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const opened: WorkboardStore[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((store) => store.close()));
});

function open(dbPath = path.join(dirs.make("workboard-planning-"), "workboard.sqlite")) {
  const persistence = createWorkboardSqliteStores({
    dbPath,
    workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
  });
  const store = new WorkboardStore(persistence.cards, persistence);
  opened.push(store);
  return { store, dbPath };
}

const layout: WorkboardPlanningColumn[] = [
  { id: "inbox", name: "Inbox", width: 300, order: 0 },
  { id: "ideas", name: "Ideas", width: 320, order: 1 },
  { id: "validation", name: "Validation", width: 360, order: 2 },
];

describe("Workboard planning persistence", () => {
  it("keeps merged, moved and newly unassigned card orders distinct for later drag insertions", async () => {
    const { store } = open();
    const first = await store.create({ title: "First ordering card" });
    const second = await store.create({ title: "Second ordering card" });
    await store.updatePlanning({ expectedRevision: 0, columns: layout });
    await store.movePlanningCard({
      expectedRevision: 1,
      cardId: first.id,
      columnId: "ideas",
      order: 0,
    });
    await store.movePlanningCard({
      expectedRevision: 2,
      cardId: second.id,
      columnId: "validation",
      order: 0,
    });
    const merged = await store.updatePlanning({
      expectedRevision: 3,
      columns: layout.filter((column) => column.id !== "ideas"),
      deletedColumnDestinations: { ideas: "validation" },
    });
    const ordered = merged.cards.toSorted((a, b) => a.order - b.order);
    expect(ordered.map((card) => card.order)).toEqual([0, 1024]);
    const last = ordered.at(-1)!;
    const moved = await store.movePlanningCard({
      expectedRevision: 4,
      cardId: last.cardId,
      columnId: "validation",
      order: -1024,
    });
    expect(moved.cards.toSorted((a, b) => a.order - b.order).map((card) => card.cardId)).toEqual(
      ordered.map((card) => card.cardId).toReversed(),
    );
    await store.create({ title: "New inbox card" });
    const withInbox = await store.getPlanning("default");
    expect(new Set(withInbox.cards.map((card) => card.order)).size).toBe(3);
    expect(await store.get(first.id)).toEqual(first);
    expect(await store.get(second.id)).toEqual(second);
  });
  it("reads virtual inbox without activating planning and preserves execution fields across reopen", async () => {
    const { store, dbPath } = open();
    const card = await store.create({
      title: "Independent planning",
      status: "todo",
      position: 17,
    });
    expect(await store.getPlanning("default")).toMatchObject({
      revision: 0,
      columns: [layout[0]],
      cards: [{ cardId: card.id, columnId: "inbox" }],
    });
    expect((await open(dbPath).store.getPlanning("default")).revision).toBe(0);
    await expect(store.getPlanning("unknown")).rejects.toThrow("board not found");
    const changes = vi.fn();
    store.subscribeChanges(changes);
    await store.updatePlanning({ boardId: "default", expectedRevision: 0, columns: layout });
    await store.movePlanningCard({
      boardId: "default",
      expectedRevision: 1,
      cardId: card.id,
      columnId: "ideas",
      order: 42,
    });
    expect(changes).toHaveBeenCalledTimes(2);
    expect(await store.get(card.id)).toEqual(card);
    await store.close();
    expect(await open(dbPath).store.getPlanning("default")).toMatchObject({
      revision: 2,
      columns: layout,
      cards: [{ cardId: card.id, columnId: "ideas", order: 0 }],
    });
  });

  it("renames, reorders, resizes and adds columns without changing stable card placement", async () => {
    const { store } = open();
    const card = await store.create({ title: "Stable placement" });
    await store.updatePlanning({ expectedRevision: 0, columns: layout });
    await store.movePlanningCard({
      expectedRevision: 1,
      cardId: card.id,
      columnId: "ideas",
      order: 6,
    });
    const columns = [
      ...layout.map((column) =>
        column.id === "ideas" ? { ...column, name: "Considering", width: 480, order: 8 } : column,
      ),
      { id: "revenue", name: "Revenue", width: 400, order: 3 },
    ];
    const result = await store.updatePlanning({ expectedRevision: 2, columns });
    expect(result.columns.map((column) => column.id)).toEqual([
      "inbox",
      "validation",
      "revenue",
      "ideas",
    ]);
    expect(result.columns[3]).toMatchObject({ name: "Considering", width: 480 });
    expect(result.cards).toEqual([{ cardId: card.id, columnId: "ideas", order: 0 }]);
  });

  it("requires destinations, keeps inbox, and atomically moves cards before deleting a column", async () => {
    const { store, dbPath } = open();
    const card = await store.create({ title: "Move before deletion" });
    await store.updatePlanning({ expectedRevision: 0, columns: layout });
    await store.movePlanningCard({
      expectedRevision: 1,
      cardId: card.id,
      columnId: "ideas",
      order: 12,
    });
    const columns = layout.filter((column) => column.id !== "ideas");
    await expect(store.updatePlanning({ expectedRevision: 2, columns })).rejects.toThrow(
      "destination",
    );
    await expect(
      store.updatePlanning({ expectedRevision: 2, columns: layout.slice(1) }),
    ).rejects.toThrow("inbox cannot be deleted");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "CREATE TRIGGER planning_abort BEFORE UPDATE ON workboard_planning_boards BEGIN SELECT RAISE(ABORT, 'injected planning failure'); END",
      );
      await expect(
        store.updatePlanning({
          expectedRevision: 2,
          columns,
          deletedColumnDestinations: { ideas: "validation" },
        }),
      ).rejects.toThrow("injected planning failure");
      expect(await store.getPlanning("default")).toMatchObject({
        revision: 2,
        columns: layout,
        cards: [{ cardId: card.id, columnId: "ideas", order: 0 }],
      });
      db.exec("DROP TRIGGER planning_abort");
    } finally {
      db.close();
    }
    const result = await store.updatePlanning({
      expectedRevision: 2,
      columns,
      deletedColumnDestinations: { ideas: "validation" },
    });
    expect(result).toMatchObject({
      revision: 3,
      columns,
      cards: [{ cardId: card.id, columnId: "validation", order: 0 }],
    });
    expect(await store.get(card.id)).toEqual(card);
  });

  it("rejects stale updates across connections without publishing a change", async () => {
    const { store, dbPath } = open();
    const peer = open(dbPath).store;
    const card = await store.create({ title: "Concurrent editors" });
    await store.updatePlanning({ expectedRevision: 0, columns: layout });
    const changes = vi.fn();
    peer.subscribeChanges(changes);
    await expect(
      peer.updatePlanning({ expectedRevision: 0, columns: [layout[0]] }),
    ).rejects.toBeInstanceOf(WorkboardPlanningConflictError);
    await expect(
      peer.movePlanningCard({ expectedRevision: 0, cardId: card.id, columnId: "ideas", order: 0 }),
    ).rejects.toBeInstanceOf(WorkboardPlanningConflictError);
    expect(changes).not.toHaveBeenCalled();
    expect(await peer.getPlanning("default")).toMatchObject({ revision: 1, columns: layout });
  });

  it("resets placement on old API board moves and never resurrects it when a card moves back", async () => {
    const { store } = open();
    await store.upsertBoard({ id: "other" });
    const card = await store.create({ title: "Changing boards" });
    await store.updatePlanning({ expectedRevision: 0, columns: layout });
    await store.movePlanningCard({
      expectedRevision: 1,
      cardId: card.id,
      columnId: "ideas",
      order: 0,
    });
    await store.move(card.id, "ready", 123);
    expect((await store.getPlanning("default")).cards[0]).toMatchObject({
      columnId: "ideas",
      order: 0,
    });
    await store.update(card.id, { boardId: "other" });
    expect((await store.getPlanning("other")).cards[0]).toMatchObject({ columnId: "inbox" });
    await expect(
      store.movePlanningCard({
        boardId: "default",
        expectedRevision: 3,
        cardId: card.id,
        columnId: "ideas",
        order: 1,
      }),
    ).rejects.toThrow("does not belong");
    await store.update(card.id, { boardId: "default" });
    expect((await store.getPlanning("default")).cards[0]).toMatchObject({ columnId: "inbox" });
    expect(await store.get(card.id)).toMatchObject({ status: "ready", position: 123 });
  });

  it("projects unknown saved ids into inbox and cleans card/board planning on deletion", async () => {
    const { store, dbPath } = open();
    await store.upsertBoard({ id: "project" });
    const card = await store.create({ title: "Unknown column", boardId: "project" });
    await store.updatePlanning({ boardId: "project", expectedRevision: 0, columns: layout });
    const db = new DatabaseSync(dbPath);
    try {
      const query = getNodeSqliteKysely<{
        workboard_planning_cards: {
          card_id: string;
          board_id: string;
          column_id: string;
          planning_order: number;
        };
      }>(db);
      executeSqliteQuerySync(
        db,
        query.insertInto("workboard_planning_cards").values({
          card_id: card.id,
          board_id: "project",
          column_id: "missing",
          planning_order: 5,
        }),
      );
      expect((await store.getPlanning("project")).cards[0]).toMatchObject({ columnId: "inbox" });
      await store.delete(card.id);
      expect(
        executeSqliteQuerySync(db, query.selectFrom("workboard_planning_cards").selectAll()).rows,
      ).toEqual([]);
    } finally {
      db.close();
    }
    await store.deleteBoard("project");
    await store.upsertBoard({ id: "project" });
    expect(await store.getPlanning("project")).toMatchObject({
      revision: 0,
      columns: [layout[0]],
      cards: [],
    });
  });

  it("rejects invalid names, widths, duplicate ids and unknown move targets", async () => {
    const { store } = open();
    const card = await store.create({ title: "Validate inputs" });
    for (const columns of [
      [{ ...layout[0], name: " " }],
      [{ ...layout[0], width: 100 }],
      [layout[0], layout[0]],
    ]) {
      await expect(store.updatePlanning({ expectedRevision: 0, columns })).rejects.toThrow();
    }
    await expect(
      store.movePlanningCard({
        expectedRevision: 0,
        cardId: card.id,
        columnId: "missing",
        order: 0,
      }),
    ).rejects.toThrow("column not found");
    expect((await store.getPlanning("default")).revision).toBe(0);
  });

  it("serves planning through registered read/write Gateway methods and rejects stale writes", async () => {
    const { store } = open();
    type Registration = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      options: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, Registration>();
    const api = {
      registerGatewayMethod(
        method: string,
        handler: Registration["handler"],
        options: Registration["options"],
      ) {
        methods.set(method, { handler, options });
      },
    } as unknown as OpenClawPluginApi;
    registerWorkboardGatewayMethods({ api, store });
    expect(methods.get("workboard.planning.get")?.options).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.planning.update")?.options).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.planning.move")?.options).toEqual({ scope: "operator.write" });
    const request = async (method: string, params: Record<string, unknown>) => {
      const respond = vi.fn();
      await methods.get(method)!.handler({ params, respond } as never);
      return respond.mock.calls[0];
    };
    expect(await request("workboard.planning.get", { boardId: "default" })).toEqual([
      true,
      expect.objectContaining({ planning: expect.objectContaining({ revision: 0 }) }),
    ]);
    expect(
      (
        await request("workboard.planning.update", {
          boardId: "default",
          expectedRevision: 0,
          columns: layout,
        })
      )?.[0],
    ).toBe(true);
    expect(
      await request("workboard.planning.update", {
        boardId: "default",
        expectedRevision: 0,
        columns: [layout[0]],
      }),
    ).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "workboard_conflict",
        message: expect.stringContaining("Reload"),
      }),
    ]);
    const card = await store.create({ title: "Gateway planning" });
    expect(
      (
        await request("workboard.planning.move", {
          boardId: "default",
          expectedRevision: 1,
          cardId: card.id,
          columnId: "ideas",
          order: 3,
        })
      )?.[0],
    ).toBe(true);
    expect(await store.get(card.id)).toEqual(card);
  });
});
