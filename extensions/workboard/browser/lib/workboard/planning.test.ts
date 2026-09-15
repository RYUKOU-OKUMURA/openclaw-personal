import { expectDefined } from "@openclaw/normalization-core";
// @vitest-environment node
import type { WorkboardPlanningBoard } from "@openclaw/workboard-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  beginPlanningEdit,
  cancelPlanningEdit,
  disposePlanning,
  getPlanningState,
  movePlanningCard,
  refreshPlanning,
  resizePlanningColumn,
  savePlanningColumns,
  setPlanningMode,
  syncPlanningContext,
} from "./planning.ts";
import { createWorkboardTestClient } from "./test/index-helpers.ts";

function board(boardId = "ideas", revision = 1): WorkboardPlanningBoard {
  return {
    boardId,
    revision,
    columns: [
      { id: "inbox", name: "Inbox", width: 280, order: 0 },
      { id: "research", name: "Research", width: 320, order: 1 },
    ],
    cards: [{ cardId: "card-1", columnId: "inbox", order: 0 }],
  };
}

async function fixture(revision = 1, canWrite = true) {
  const host = {};
  const onUpdate = vi.fn();
  const initial = board("ideas", revision);
  const client = createWorkboardTestClient({ "workboard.planning.get": { planning: initial } });
  syncPlanningContext(host, client, "ideas", onUpdate, canWrite);
  await refreshPlanning(host);
  return { host, client, onUpdate, initial, state: getPlanningState(host) };
}

describe("planning view controller", () => {
  it("chooses the initial mode by saved revision and preserves the user's mode on refresh", async () => {
    const legacy = await fixture(0);
    expect(legacy.state).toMatchObject({ mode: "execution", boardId: "ideas", ready: true });
    const saved = await fixture(2);
    expect(saved.state.mode).toBe("planning");
    setPlanningMode(saved.host, "execution");
    await refreshPlanning(saved.host);
    expect(saved.state.mode).toBe("execution");
    syncPlanningContext(saved.host, saved.client, "ideas", saved.onUpdate, true);
    expect(saved.client.request).toHaveBeenCalledTimes(2);
  });

  it("ignores an old board's deferred load after context switch", async () => {
    const host = {};
    const old = createDeferred<{ planning: WorkboardPlanningBoard }>();
    const client = createWorkboardTestClient((_method, params) =>
      (params as { boardId: string }).boardId === "old"
        ? old.promise
        : { planning: board("new", 3) },
    );
    syncPlanningContext(host, client, "old", vi.fn(), true);
    const oldLoad = refreshPlanning(host);
    await Promise.resolve();
    syncPlanningContext(host, client, "new", vi.fn(), true);
    await refreshPlanning(host);
    old.resolve({ planning: board("old", 99) });
    await oldLoad;
    expect(getPlanningState(host).data).toMatchObject({ boardId: "new", revision: 3 });
  });

  it("retains a conflicting draft and its original revision until explicit discard/reload", async () => {
    const f = await fixture();
    beginPlanningEdit(f.host);
    expectDefined(f.state.draft?.[1], "draft research").name = "My research";
    f.state.deletedColumnDestinations = { removed: "inbox" };
    f.client.request.mockImplementation(async (method) => {
      if (method === "workboard.planning.update") {
        throw Object.assign(new Error("Planning changed while you were editing."), {
          code: "workboard_conflict",
          details: { code: "WORKBOARD_PLANNING_CONFLICT", planning: board("ideas", 8) },
        });
      }
      return { planning: board("ideas", 8) };
    });
    expect(await savePlanningColumns(f.host)).toBe(false);
    expect(f.state.draft?.[1]?.name).toBe("My research");
    expect(f.state.deletedColumnDestinations).toEqual({ removed: "inbox" });
    expect(f.state.data?.revision).toBe(1);
    expect(f.state.error).toContain("reload");
    expect(f.state).toMatchObject({ saving: false, ready: false, needsReload: true });
    const requests = f.client.request.mock.calls.length;
    await refreshPlanning(f.host);
    expect(await savePlanningColumns(f.host)).toBe(false);
    expect(f.client.request).toHaveBeenCalledTimes(requests);
    await cancelPlanningEdit(f.host);
    expect(f.state).toMatchObject({ draft: null, error: null, ready: true, needsReload: false });
    expect(f.state.data?.revision).toBe(8);
  });

  it("sends only planning placement fields and never mutates execution card status", async () => {
    const f = await fixture(4);
    const updated = board("ideas", 5);
    updated.cards[0] = { cardId: "card-1", columnId: "research", order: 7 };
    f.client.request.mockResolvedValue({ planning: updated });
    expect(await movePlanningCard(f.host, "card-1", "research", 7)).toBe(true);
    expect(f.client.request.mock.lastCall).toEqual([
      "workboard.planning.move",
      { boardId: "ideas", expectedRevision: 4, cardId: "card-1", columnId: "research", order: 7 },
    ]);
    expect(f.initial.cards[0]).toEqual({ cardId: "card-1", columnId: "inbox", order: 0 });
    expect(
      f.client.request.mock.calls.every(([method]) => method.startsWith("workboard.planning.")),
    ).toBe(true);
    expect(f.state.data?.revision).toBe(5);
  });

  it("blocks writes without permission, a client, or while a write is in flight", async () => {
    const f = await fixture(1, false);
    beginPlanningEdit(f.host);
    expect(f.state.draft).toBeNull();
    expect(await movePlanningCard(f.host, "card-1", "research", 1)).toBe(false);
    expect(await resizePlanningColumn(f.host, "inbox", 400)).toBe(false);
    expect(f.client.request).toHaveBeenCalledTimes(1);
    syncPlanningContext(f.host, null, "ideas", f.onUpdate, true);
    expect(getPlanningState(f.host).ready).toBe(false);
    expect(await movePlanningCard(f.host, "card-1", "research", 1)).toBe(false);

    const writable = await fixture();
    const pending = createDeferred<{ planning: WorkboardPlanningBoard }>();
    writable.client.request.mockReturnValue(pending.promise);
    const first = movePlanningCard(writable.host, "card-1", "research", 1);
    expect(await movePlanningCard(writable.host, "card-1", "research", 2)).toBe(false);
    pending.resolve({ planning: board("ideas", 2) });
    expect(await first).toBe(true);
    expect(writable.client.request).toHaveBeenCalledTimes(2);
  });

  it("ignores a pending write after disposal or client replacement", async () => {
    const f = await fixture();
    const pending = createDeferred<{ planning: WorkboardPlanningBoard }>();
    f.client.request.mockReturnValue(pending.promise);
    const save = resizePlanningColumn(f.host, "inbox", 420);
    disposePlanning(f.host);
    const replacement = createWorkboardTestClient({
      "workboard.planning.get": { planning: board("ideas", 10) },
    });
    syncPlanningContext(f.host, replacement, "ideas", f.onUpdate, true);
    await refreshPlanning(f.host);
    pending.resolve({ planning: board("ideas", 2) });
    expect(await save).toBe(false);
    expect(getPlanningState(f.host).data?.revision).toBe(10);
  });

  it("saves independent draft columns with deletion destinations and clears them on success", async () => {
    const f = await fixture();
    beginPlanningEdit(f.host);
    const inbox = expectDefined(f.state.draft?.[0], "draft inbox");
    inbox.name = "New inbox";
    f.state.draft = [inbox];
    f.state.deletedColumnDestinations = { research: "inbox" };
    const updated = board("ideas", 2);
    updated.columns = [{ id: "inbox", name: "New inbox", width: 280, order: 0 }];
    f.client.request.mockResolvedValue({ planning: updated });
    expect(await savePlanningColumns(f.host)).toBe(true);
    expect(f.client.request.mock.lastCall).toEqual([
      "workboard.planning.update",
      {
        boardId: "ideas",
        expectedRevision: 1,
        columns: updated.columns,
        deletedColumnDestinations: { research: "inbox" },
      },
    ]);
    expect(f.initial.columns[0]?.name).toBe("Inbox");
    expect(f.state.draft).toBeNull();
    expect(f.state.deletedColumnDestinations).toEqual({});
  });

  it("resizes from the saved snapshot without making or overwriting a draft", async () => {
    const f = await fixture();
    const updated = board("ideas", 2);
    expectDefined(updated.columns[0], "saved inbox").width = 400;
    f.client.request.mockResolvedValue({ planning: updated });
    expect(await resizePlanningColumn(f.host, "inbox", 400)).toBe(true);
    expect(f.client.request.mock.lastCall).toEqual([
      "workboard.planning.update",
      { boardId: "ideas", expectedRevision: 1, columns: updated.columns },
    ]);
    expect(f.initial.columns[0]?.width).toBe(280);
    expect(f.state.draft).toBeNull();
    beginPlanningEdit(f.host);
    const requests = f.client.request.mock.calls.length;
    expect(await resizePlanningColumn(f.host, "inbox", 500)).toBe(false);
    expect(await movePlanningCard(f.host, "card-1", "research", 1)).toBe(false);
    expect(f.client.request).toHaveBeenCalledTimes(requests);
  });

  it("rejects a mismatched board response and can explicitly retry a failed load", async () => {
    const host = {};
    const client = createWorkboardTestClient({
      "workboard.planning.get": { planning: board("other") },
    });
    syncPlanningContext(host, client, "ideas", vi.fn(), true);
    await refreshPlanning(host);
    expect(getPlanningState(host)).toMatchObject({ data: null, ready: false, loading: false });
    expect(getPlanningState(host).error).toContain("another board");
    client.request.mockResolvedValue({ planning: board() });
    await refreshPlanning(host);
    expect(getPlanningState(host)).toMatchObject({ ready: true, error: null });
  });

  it("sends destinations only for deleted saved columns, not temporary or retained columns", async () => {
    const f = await fixture();
    beginPlanningEdit(f.host);
    f.state.draft = [expectDefined(f.state.draft?.[0], "draft inbox")];
    f.state.deletedColumnDestinations = {
      research: "inbox",
      inbox: "research",
      "new-then-removed": "inbox",
    };
    const updated = board("ideas", 2);
    updated.columns = [expectDefined(updated.columns[0], "saved inbox")];
    f.client.request.mockResolvedValue({ planning: updated });
    expect(await savePlanningColumns(f.host)).toBe(true);
    expect(f.client.request.mock.lastCall).toEqual([
      "workboard.planning.update",
      {
        boardId: "ideas",
        expectedRevision: 1,
        columns: updated.columns,
        deletedColumnDestinations: { research: "inbox" },
      },
    ]);
  });

  it("keeps writes blocked when the explicit reload after a write failure also fails", async () => {
    const f = await fixture();
    f.client.request.mockRejectedValue(new Error("Connection lost"));
    expect(await movePlanningCard(f.host, "card-1", "research", 2)).toBe(false);
    await refreshPlanning(f.host, { discardDraft: true });
    expect(f.state).toMatchObject({ ready: false, needsReload: true, loading: false });
    const requests = f.client.request.mock.calls.length;
    expect(await movePlanningCard(f.host, "card-1", "research", 2)).toBe(false);
    expect(f.client.request).toHaveBeenCalledTimes(requests);
    f.client.request.mockResolvedValue({ planning: board("ideas", 3) });
    await refreshPlanning(f.host, { discardDraft: true });
    expect(f.state).toMatchObject({ ready: true, needsReload: false });
  });

  it("drains changes arriving during a GET into one latest GET", async () => {
    const f = await fixture();
    const stale = createDeferred<{ planning: WorkboardPlanningBoard }>();
    f.client.request.mockImplementationOnce(() => stale.promise);
    f.client.request.mockResolvedValue({ planning: board("ideas", 3) });
    const first = refreshPlanning(f.host);
    await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledTimes(2));
    const change = refreshPlanning(f.host);
    void refreshPlanning(f.host);
    stale.resolve({ planning: board("ideas", 2) });
    await Promise.all([first, change]);
    expect(f.client.request).toHaveBeenCalledTimes(3);
    expect(f.state.data?.revision).toBe(3);
    expect(f.state.loading).toBe(false);
  });

  it("drains changes arriving during a write without overwriting an editing draft", async () => {
    const f = await fixture();
    const pending = createDeferred<{ planning: WorkboardPlanningBoard }>();
    f.client.request.mockImplementation((method) =>
      method === "workboard.planning.move"
        ? pending.promise
        : Promise.resolve({ planning: board("ideas", 3) }),
    );
    const write = movePlanningCard(f.host, "card-1", "research", 1);
    await refreshPlanning(f.host);
    await refreshPlanning(f.host);
    expect(f.client.request).toHaveBeenCalledTimes(2);
    pending.resolve({ planning: board("ideas", 2) });
    expect(await write).toBe(true);
    expect(f.client.request).toHaveBeenCalledTimes(3);
    expect(f.state.data?.revision).toBe(3);
    expect(f.state.loading).toBe(false);
    beginPlanningEdit(f.host);
    expectDefined(f.state.draft?.[0], "draft inbox").name = "Unsaved inbox";
    await refreshPlanning(f.host);
    expect(f.client.request).toHaveBeenCalledTimes(3);
    expect(f.state.draft?.[0]?.name).toBe("Unsaved inbox");
  });

  it("does not drain a pending change after a conflicting write until explicit reload", async () => {
    const f = await fixture();
    beginPlanningEdit(f.host);
    const pending = createDeferred<{ planning: WorkboardPlanningBoard }>();
    f.client.request.mockReturnValueOnce(pending.promise);
    const write = savePlanningColumns(f.host);
    await refreshPlanning(f.host);
    pending.reject(new Error("Planning changed while you were editing."));
    expect(await write).toBe(false);
    expect(f.client.request).toHaveBeenCalledTimes(2);
    expect(f.state).toMatchObject({ needsReload: true, ready: false });
    expect(f.state.draft).not.toBeNull();
    f.client.request.mockResolvedValue({ planning: board("ideas", 4) });
    await cancelPlanningEdit(f.host);
    expect(f.client.request).toHaveBeenCalledTimes(3);
    expect(f.state.data?.revision).toBe(4);
  });
});
