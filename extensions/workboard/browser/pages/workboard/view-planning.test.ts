import "../../test/dom.setup.ts";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { getWorkboardState } from "../../lib/workboard/index.ts";
import { getPlanningState, syncPlanningContext } from "../../lib/workboard/planning.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { renderWorkboard } from "./view.ts";

function setup() {
  const host = {};
  const workboard = getWorkboardState(host);
  workboard.loaded = true;
  workboard.boardFilter = "ideas";
  workboard.cards = [
    createWorkboardCard({
      id: "idea",
      title: "One idea",
      status: "triage",
      metadata: { automation: { boardId: "ideas" } },
    }),
  ];
  let planning = {
    boardId: "ideas",
    revision: 1,
    columns: [
      { id: "inbox", name: "Inbox", width: 300, order: 0 },
      { id: "research", name: "Research", width: 300, order: 1 },
    ],
    cards: [{ cardId: "idea", columnId: "research", order: 0 }],
  };
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "workboard.planning.update") {
      planning = {
        ...planning,
        revision: planning.revision + 1,
        columns: params.columns as typeof planning.columns,
      };
    }
    if (method === "workboard.planning.move") {
      planning = {
        ...planning,
        revision: planning.revision + 1,
        cards: [{ cardId: "idea", columnId: String(params.columnId), order: Number(params.order) }],
      };
    }
    return { planning: structuredClone(planning) };
  });
  const client = { request, addEventListener: () => () => {} };
  const container = document.createElement("div");
  const update = () => {
    workboardTestHost().connection.connected = true;
    render(
      renderWorkboard({
        host,
        client: client as never,
        connected: true,
        canWrite: true,
        agentsList: null,
        sessions: [],
        onOpenSession: () => {},
        onRefresh: () => {},
        onRequestUpdate: update,
      }),
      container,
    );
  };
  syncPlanningContext(host, client as never, "ideas", update, true);
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.trim().endsWith(text),
    )!;
  return { host, workboard, container, request, update, button, client };
}

describe("planning board controls", () => {
  it("edits columns with destination required, saves stable ids and keeps execution status", async () => {
    const { host, container, button, request, workboard } = setup();
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".workboard-planning-column")).toHaveLength(2),
    );
    expect(container.querySelector(".workboard-planning-status")?.textContent).toBe("Triage");
    button("Edit board").click();
    const row = container.querySelectorAll<HTMLElement>(".workboard-planning-editor__row")[1]!;
    const remove = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === "Remove column",
    )!;
    expect(remove.disabled).toBe(true);
    const destination = row.querySelector<HTMLSelectElement>("select")!;
    destination.value = "inbox";
    destination.dispatchEvent(new Event("change"));
    expect(remove.disabled).toBe(false);
    remove.click();
    button("Add column").click();
    const draft = getPlanningState(host).draft!;
    const addedId = draft[1]!.id;
    const input = container.querySelectorAll<HTMLInputElement>(
      ".workboard-planning-editor__row input",
    )[2]!;
    input.value = "Validation";
    input.dispatchEvent(new Event("input"));
    button("Save").click();
    await vi.waitFor(() => expect(getPlanningState(host).draft).toBeNull());
    expect(request).toHaveBeenCalledWith(
      "workboard.planning.update",
      expect.objectContaining({
        expectedRevision: 1,
        deletedColumnDestinations: { research: "inbox" },
        columns: expect.arrayContaining([
          expect.objectContaining({ id: addedId, name: "Validation" }),
        ]),
      }),
    );
    expect(workboard.cards[0]!.status).toBe("triage");
    button("Execution status").click();
    expect(container.querySelector(".workboard-planning-board")).toBeNull();
    expect(container.textContent).toContain("One idea");
  });

  it("moves the same card through planning RPC and supports keyboard width changes", async () => {
    const { container, request, workboard } = setup();
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".workboard-planning-column")).toHaveLength(2),
    );
    const select = container.querySelector<HTMLSelectElement>(
      ".workboard-planning-card__move select",
    )!;
    select.value = "inbox";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "workboard.planning.move",
        expect.objectContaining({ cardId: "idea", columnId: "inbox", expectedRevision: 1 }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        container
          .querySelector<HTMLElement>(".workboard-planning-resize")
          ?.getAttribute("aria-disabled"),
      ).toBe("false"),
    );
    container
      .querySelector<HTMLElement>(".workboard-planning-resize")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "workboard.planning.update",
        expect.objectContaining({
          expectedRevision: 2,
          columns: expect.arrayContaining([expect.objectContaining({ id: "inbox", width: 320 })]),
        }),
      ),
    );
    expect(request.mock.calls.some(([method]) => method === "workboard.cards.move")).toBe(false);
    expect(workboard.cards[0]!.status).toBe("triage");
  });
  it("keeps unknown and missing placements visible in inbox and disables planning writes without permission", async () => {
    const { host, container, request, update, client, workboard, button } = setup();
    await vi.waitFor(() => expect(getPlanningState(host).ready).toBe(true));
    getPlanningState(host).data!.cards[0]!.columnId = "removed";
    workboard.cards.push(
      createWorkboardCard({
        id: "new-idea",
        title: "New idea",
        metadata: { automation: { boardId: "ideas" } },
      }),
    );
    syncPlanningContext(host, client as never, "ideas", update, false);
    update();
    const inbox = container.querySelector(".workboard-planning-column")!;
    expect(inbox.textContent).toContain("One idea");
    expect(inbox.textContent).toContain("New idea");
    expect(button("Edit board").disabled).toBe(true);
    for (const select of container.querySelectorAll<HTMLSelectElement>(
      ".workboard-planning-card__move select",
    )) {
      expect(select.disabled).toBe(true);
    }
    const handle = container.querySelector<HTMLElement>(".workboard-planning-resize")!;
    expect(handle.getAttribute("aria-disabled")).toBe("true");
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(request.mock.calls).toHaveLength(1);
  });
  it("shows the actual planning column initially and restores it after a failed move", async () => {
    const { host, container, request } = setup();
    await vi.waitFor(() => expect(getPlanningState(host).ready).toBe(true));
    const select = container.querySelector<HTMLSelectElement>(
      ".workboard-planning-card__move select",
    )!;
    expect(select.value).toBe("research");
    request.mockRejectedValueOnce(new Error("Conflict"));
    select.value = "inbox";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(getPlanningState(host).needsReload).toBe(true));
    expect(select.value).toBe("research");
    expect(container.querySelectorAll(".workboard-planning-column")[1]!.textContent).toContain(
      "One idea",
    );
  });
});
