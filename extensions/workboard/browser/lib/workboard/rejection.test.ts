// @vitest-environment node
import "../../test/host.setup.ts";
import { describe, expect, it } from "vitest";
import { hasWorkboardRejection, rejectWorkboardIdea } from "./rejection.ts";
import { getWorkboardState } from "./runtime.ts";
import { createWorkboardCard, createWorkboardTestClient } from "./test/index-helpers.ts";
import type { WorkboardCard } from "./types.ts";

const REJECTED_LABEL = "rejected";

function createRejectionHarness(overrides: Partial<WorkboardCard> = {}) {
  const host = {};
  const card = createWorkboardCard({ status: "triage", ...overrides });
  const state = getWorkboardState(host);
  state.loaded = true;
  state.mutationReadiness = "ready";
  state.cards = [card];
  return { host, card, state };
}

function rejectionComment(card: WorkboardCard, body: string, createdAt = 2) {
  return { id: `idea-rejection:${card.id}`, body, createdAt };
}

describe("Workboard idea rejection", () => {
  it("saves the reason with CAS before archiving and preserves card fields", async () => {
    const links = [
      {
        id: "discussion-link",
        type: "relates_to" as const,
        title: "Card discussion",
        url: "/chat/main/dashboard/rejection-review",
        createdAt: 1,
      },
    ];
    const existingComment = { id: "existing", body: "Existing note", createdAt: 1 };
    const { host, card, state } = createRejectionHarness({
      updatedAt: 41,
      notes: "Keep this context.",
      labels: ["売上のタネ"],
      sessionKey: "agent:main:execution",
      runId: "execution-run",
      metadata: { links, comments: [existingComment] },
    });
    const reason = "The customer need is too weak to test next.";
    const saved = {
      ...card,
      updatedAt: 42,
      labels: [...card.labels, REJECTED_LABEL],
      metadata: {
        ...card.metadata,
        links,
        comments: [existingComment, rejectionComment(card, reason)],
      },
    };
    const archived = {
      ...saved,
      updatedAt: 43,
      metadata: { ...saved.metadata, archivedAt: 99 },
    };
    const client = createWorkboardTestClient((method) => {
      if (method === "workboard.cards.update") {
        return { card: saved };
      }
      if (method === "workboard.cards.archive") {
        return { card: archived };
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    await expect(rejectWorkboardIdea({ host, client, card, reason })).resolves.toBeUndefined();

    expect(client.request).toHaveBeenNthCalledWith(1, "workboard.cards.update", {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: {
        labels: ["売上のタネ", REJECTED_LABEL],
        metadata: {
          comments: [
            existingComment,
            expect.objectContaining({
              id: `idea-rejection:${card.id}`,
              body: reason,
              createdAt: expect.any(Number),
            }),
          ],
        },
      },
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "workboard.cards.archive", {
      id: card.id,
      archived: true,
    });

    const patch = client.request.mock.calls[0]?.[1] as { patch: Record<string, unknown> };
    expect(patch.patch).not.toHaveProperty("status");
    expect(patch.patch).not.toHaveProperty("notes");
    expect(patch.patch).not.toHaveProperty("sessionKey");
    expect(patch.patch).not.toHaveProperty("runId");
    expect(patch.patch.metadata as Record<string, unknown>).not.toHaveProperty("links");

    expect(state.cards[0]).toMatchObject({
      id: card.id,
      status: "triage",
      notes: card.notes,
      sessionKey: card.sessionKey,
      runId: card.runId,
      labels: ["売上のタネ", REJECTED_LABEL],
      metadata: {
        links,
        comments: [
          existingComment,
          expect.objectContaining({
            id: `idea-rejection:${card.id}`,
            body: reason,
          }),
        ],
        archivedAt: 99,
      },
    });
    expect(hasWorkboardRejection(state.cards[0]!)).toBe(true);
    expect(state.busyCardIds.size).toBe(0);
  });

  it("does not archive when saving the rejection fails", async () => {
    const { host, card, state } = createRejectionHarness({
      updatedAt: 12,
      metadata: {
        links: [
          {
            id: "link-1",
            type: "relates_to",
            url: "/chat/main/dashboard/keep",
            createdAt: 1,
          },
        ],
      },
    });
    const client = createWorkboardTestClient((method) => {
      if (method === "workboard.cards.update") {
        throw new Error("CAS rejected");
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    await expect(
      rejectWorkboardIdea({ host, client, card, reason: "Not enough evidence." }),
    ).rejects.toThrow("CAS rejected");

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", expect.anything());
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.archive", expect.anything());
    expect(state.cards).toEqual([card]);
    expect(state.cards[0]?.labels).not.toContain(REJECTED_LABEL);
    expect(state.cards[0]?.metadata?.archivedAt).toBeUndefined();
    expect(state.busyCardIds.size).toBe(0);
  });

  it("does not archive when the update response lacks the deterministic rejection comment", async () => {
    const { host, card, state } = createRejectionHarness({ updatedAt: 12 });
    const client = createWorkboardTestClient((method) => {
      if (method === "workboard.cards.update") {
        return {
          card: {
            ...card,
            updatedAt: 13,
            labels: [...card.labels, REJECTED_LABEL],
            metadata: { ...card.metadata, comments: [] },
          },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    await expect(
      rejectWorkboardIdea({ host, client, card, reason: "No buyer signal." }),
    ).rejects.toThrow("Rejection feedback was not retained");

    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).not.toHaveBeenCalledWith("workboard.cards.archive", expect.anything());
    expect(state.cards[0]?.labels).toContain(REJECTED_LABEL);
    expect(hasWorkboardRejection(state.cards[0]!)).toBe(false);
    expect(state.cards[0]?.metadata?.archivedAt).toBeUndefined();
    expect(state.busyCardIds.size).toBe(0);
  });

  it("retries archive from saved feedback without adding a duplicate comment", async () => {
    const { host, card, state } = createRejectionHarness({
      updatedAt: 20,
      notes: "Keep the original idea context.",
      metadata: {
        links: [
          {
            id: "link-1",
            type: "relates_to",
            title: "Original discussion",
            url: "/chat/main/dashboard/original",
            createdAt: 1,
          },
        ],
      },
    });
    const reason = "The expected revenue is too uncertain.";
    let saved: WorkboardCard | undefined;
    let archiveAttempts = 0;
    const client = createWorkboardTestClient((method, rawParams) => {
      if (method === "workboard.cards.update") {
        const params = rawParams as {
          patch: { labels: string[]; metadata: WorkboardCard["metadata"] };
        };
        saved = {
          ...card,
          updatedAt: 21,
          labels: params.patch.labels,
          metadata: { ...card.metadata, ...params.patch.metadata },
        };
        return { card: saved };
      }
      if (method === "workboard.cards.archive") {
        archiveAttempts += 1;
        if (archiveAttempts === 1) {
          throw new Error("archive temporarily unavailable");
        }
        if (!saved) {
          throw new Error("expected saved rejection before retry");
        }
        return {
          card: { ...saved, updatedAt: 22, metadata: { ...saved.metadata, archivedAt: 101 } },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    await expect(rejectWorkboardIdea({ host, client, card, reason })).rejects.toThrow(
      "archive temporarily unavailable",
    );
    expect(state.cards[0]).toEqual(saved);
    expect(hasWorkboardRejection(state.cards[0]!)).toBe(true);
    expect(state.cards[0]?.metadata?.archivedAt).toBeUndefined();

    const savedCard = state.cards[0];
    if (!savedCard) {
      throw new Error("Expected the saved rejection card");
    }
    await expect(
      rejectWorkboardIdea({ host, client, card: savedCard, reason: "" }),
    ).resolves.toBeUndefined();

    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "workboard.cards.update",
      "workboard.cards.archive",
      "workboard.cards.archive",
    ]);
    expect(client.request).toHaveBeenCalledTimes(3);
    expect(state.cards[0]?.metadata?.comments).toHaveLength(1);
    expect(state.cards[0]?.metadata?.comments?.[0]).toMatchObject({
      id: `idea-rejection:${card.id}`,
      body: reason,
    });
    expect(state.cards[0]?.metadata?.archivedAt).toBe(101);
    expect(state.cards[0]?.notes).toBe(card.notes);
    expect(state.cards[0]?.metadata?.links).toEqual(card.metadata?.links);
    expect(state.busyCardIds.size).toBe(0);
  });

  it.each([
    ["a non-triage card", { status: "todo" as const }, "ready" as const],
    [
      "a stale read-only runtime",
      { status: "triage" as const },
      "canonical_reload_required" as const,
    ],
  ])("does not issue mutation RPCs for %s", async (_name, cardOverrides, readiness) => {
    const { host, card, state } = createRejectionHarness(cardOverrides);
    state.mutationReadiness = readiness;
    const client = createWorkboardTestClient(() => {
      throw new Error("rejection must be gated before the RPC");
    });

    await expect(rejectWorkboardIdea({ host, client, card, reason: "Not a fit." })).rejects.toThrow(
      "Refresh the card before rejecting this idea.",
    );
    expect(client.request).not.toHaveBeenCalled();
    expect(state.cards).toEqual([card]);
  });
});
