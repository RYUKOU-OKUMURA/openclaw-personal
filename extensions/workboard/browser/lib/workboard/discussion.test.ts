// @vitest-environment node
import "../../test/host.setup.ts";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test/wait-for.ts";
import { discussionSessionKey, discussWorkboardCard } from "./discussion.ts";
import { getWorkboardState } from "./runtime.ts";
import { createWorkboardCard, createWorkboardTestClient } from "./test/index-helpers.ts";
import type { WorkboardCard } from "./types.ts";

function createDiscussionHarness(overrides: Partial<WorkboardCard> = {}) {
  const host = {};
  const card = createWorkboardCard(overrides);
  const state = getWorkboardState(host);
  state.loaded = true;
  state.mutationReadiness = "ready";
  state.cards = [card];
  return { host, card, state };
}

function referenceSnapshot(message: string): {
  id: string;
  title: string;
  notes: string;
  comments: string[];
} {
  const json = message.slice(message.lastIndexOf("\n\n") + 2);
  return JSON.parse(json) as {
    id: string;
    title: string;
    notes: string;
    comments: string[];
  };
}

function linkedCard(card: WorkboardCard, key: string): WorkboardCard {
  const link = createDiscussionLink(key, card.updatedAt + 1);
  return {
    ...card,
    updatedAt: card.updatedAt + 1,
    metadata: {
      ...card.metadata,
      links: [...(card.metadata?.links ?? []), link],
    },
  };
}

function createDiscussionLink(key: string, createdAt = 1) {
  const url = buildControlUiSessionPath({ namespace: "chat", sessionKey: key, exactKey: true });
  if (!url) {
    throw new Error("test discussion key did not produce a chat URL");
  }
  return {
    id: `discussion-${key}`,
    type: "relates_to" as const,
    title: "Card discussion",
    url,
    createdAt,
  };
}

describe("Workboard card discussions", () => {
  it("creates an idle discussion, persists a separate link, and sends bounded context", async () => {
    const { host, card, state } = createDiscussionHarness({
      title: "Sell a useful revenue experiment",
      notes: "N".repeat(10_000),
      agentId: "seller",
      status: "ready",
      sessionKey: "agent:main:execution-owner",
      runId: "execution-run",
      execution: {
        id: "execution-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "done",
        model: "test/execution-model",
        sessionKey: "agent:main:execution-owner",
        startedAt: 10,
        updatedAt: 20,
      },
      metadata: {
        comments: [
          { id: "old", body: "old comment", createdAt: 1 },
          ...Array.from({ length: 3 }, (_, index) => ({
            id: `comment-${index}`,
            body: `${index}-${"C".repeat(1_200)}`,
            createdAt: index + 2,
          })),
        ],
      },
    });
    const key = "agent:main:discussion-1";
    const updated = linkedCard(card, key);
    const client = createWorkboardTestClient((method) => {
      if (method === "sessions.create") {
        return { key };
      }
      if (method === "workboard.cards.update") {
        return { card: updated };
      }
      if (method === "chat.send") {
        return { runId: "discussion-run" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    await expect(
      discussWorkboardCard({
        host,
        client,
        card,
        model: "test/discussion-model",
        thinkingLevel: "max",
        fastMode: true,
      }),
    ).resolves.toBe(key);

    expect(client.request).toHaveBeenNthCalledWith(1, "sessions.create", {
      idempotencyKey: `workboard-discussion:${card.id}:${card.updatedAt}`,
      agentId: "seller",
      displayName: "Sell a useful revenue experiment (card-1)",
      model: "test/discussion-model",
      thinkingLevel: "max",
      fastMode: true,
    });
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "workboard.cards.update",
      expect.objectContaining({
        id: card.id,
        expectedUpdatedAt: card.updatedAt,
        patch: expect.objectContaining({
          metadata: expect.objectContaining({
            links: expect.arrayContaining([
              expect.objectContaining({
                type: "relates_to",
                title: "Card discussion",
                url: buildControlUiSessionPath({
                  namespace: "chat",
                  sessionKey: key,
                  exactKey: true,
                }),
              }),
            ]),
          }),
        }),
      }),
    );
    const updateParams = client.request.mock.calls[1]?.[1] as {
      patch: Record<string, unknown>;
    };
    expect(updateParams.patch).not.toHaveProperty("status");
    expect(updateParams.patch).not.toHaveProperty("sessionKey");
    expect(updateParams.patch).not.toHaveProperty("runId");
    expect(updateParams.patch).not.toHaveProperty("execution");
    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "chat.send",
      expect.objectContaining({
        sessionKey: key,
        idempotencyKey: `workboard-discussion:${key}`,
      }),
    );

    const sendParams = client.request.mock.calls[2]?.[1] as { message: string };
    const snapshot = referenceSnapshot(sendParams.message);
    expect(snapshot).toEqual({
      id: card.id,
      title: card.title,
      notes: "N".repeat(8_000),
      comments: ["0-" + "C".repeat(998), "1-" + "C".repeat(998), "2-" + "C".repeat(998)],
    });
    expect(sendParams.message).toContain("summarize/save to the card");
    expect(sendParams.message).toContain("append a compact dated discussion outcome");
    expect(sendParams.message).toContain("Do not automatically execute work");
    expect(sendParams.message).toContain("report the card ID and the saved outcome");
    expect(sendParams.message).toContain("ask to save the discussion to this card");

    // The discussion link is metadata-only; execution ownership and lifecycle stay intact.
    expect(state.cards[0]).toMatchObject({
      id: card.id,
      status: card.status,
      sessionKey: card.sessionKey,
      runId: card.runId,
      execution: card.execution,
      metadata: {
        links: expect.arrayContaining([expect.objectContaining({ title: "Card discussion" })]),
      },
    });
    expect(discussionSessionKey(state.cards[0]!)).toBe(key);
    expect(state.error).toBeNull();
  });

  it("reuses an existing discussion link without creating or sending another turn", async () => {
    const key = "agent:main:discussion-existing";
    const { host, card, state } = createDiscussionHarness({
      metadata: { links: [createDiscussionLink(key)] },
    });
    const client = createWorkboardTestClient(() => {
      throw new Error("an existing discussion must not issue another RPC");
    });

    await expect(discussWorkboardCard({ host, client, card })).resolves.toBe(key);

    expect(client.request).not.toHaveBeenCalled();
    expect(state.cards).toEqual([card]);
    expect(state.error).toBeNull();
  });

  it("only recognizes the titled literal chat URL as a discussion link", () => {
    const key = "agent:main:discussion-existing";
    const dashboardUrl = buildControlUiSessionPath({
      namespace: "dashboard",
      sessionKey: key,
      exactKey: true,
    });
    const shortUrl = buildControlUiSessionPath({
      namespace: "chat",
      sessionKey: "agent:main:12345678-90ab-cdef-1234-567890abcdef",
    });
    if (!dashboardUrl || !shortUrl) {
      throw new Error("test session keys did not produce control UI URLs");
    }
    const card = createWorkboardCard({
      metadata: {
        links: [
          { ...createDiscussionLink(key), title: "Related" },
          { ...createDiscussionLink(key), url: dashboardUrl },
          { ...createDiscussionLink(key), url: shortUrl },
          { ...createDiscussionLink(key), url: "/chat" },
          { ...createDiscussionLink(key), type: "parent" },
        ],
      },
    });

    expect(discussionSessionKey(card)).toBeUndefined();
  });

  it("admits only one discussion start for a card while creation is pending", async () => {
    const created = createDeferred<{ key: string }>();
    const { host, card, state } = createDiscussionHarness();
    const key = "agent:main:discussion-concurrent";
    const updated = linkedCard(card, key);
    const client = createWorkboardTestClient((method) => {
      if (method === "sessions.create") {
        return created.promise;
      }
      if (method === "workboard.cards.update") {
        return { card: updated };
      }
      if (method === "chat.send") {
        return { runId: "discussion-run" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    const first = discussWorkboardCard({ host, client, card });
    await waitForFast(() => expect(client.request).toHaveBeenCalledOnce());
    await expect(discussWorkboardCard({ host, client, card })).resolves.toBeNull();
    expect(client.request).toHaveBeenCalledTimes(1);

    created.resolve({ key });
    await expect(first).resolves.toBe(key);
    expect(state.busyCardIds.size).toBe(0);
  });

  it("uses the selected agent and accepts an unchanged card reloaded during creation", async () => {
    const { host, card, state } = createDiscussionHarness({ agentId: undefined });
    const key = "agent:seller:discussion-reloaded";
    const client = createWorkboardTestClient((method) => {
      if (method === "sessions.create") {
        state.cards = [{ ...card }];
        return { key };
      }
      if (method === "workboard.cards.update") {
        return { card: linkedCard(card, key) };
      }
      if (method === "chat.send") {
        return { runId: "discussion-run" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    await expect(discussWorkboardCard({ host, client, card, agentId: "seller" })).resolves.toBe(
      key,
    );
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "sessions.create",
      expect.objectContaining({ agentId: "seller" }),
    );
  });

  it("replays session creation with the same key after a lost response", async () => {
    const { host, card } = createDiscussionHarness();
    const key = "agent:main:discussion-replayed";
    let creates = 0;
    const client = createWorkboardTestClient((method) => {
      if (method === "sessions.create") {
        if (++creates === 1) {
          throw new Error("response lost");
        }
        return { key };
      }
      if (method === "workboard.cards.update") {
        return { card: linkedCard(card, key) };
      }
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    await expect(discussWorkboardCard({ host, client, card })).resolves.toBeNull();
    await expect(discussWorkboardCard({ host, client, card })).resolves.toBe(key);
    const requests = client.request.mock.calls.filter(([method]) => method === "sessions.create");
    expect(requests[0]?.[1]).toEqual(requests[1]?.[1]);
    expect(requests[0]?.[1]).toMatchObject({
      idempotencyKey: `workboard-discussion:${card.id}:${card.updatedAt}`,
    });
  });

  it("keeps the empty chat visible when linking the card fails", async () => {
    const { host, card, state } = createDiscussionHarness();
    const key = "agent:main:discussion-link-failure";
    const client = createWorkboardTestClient((method) => {
      if (method === "sessions.create") {
        return { key };
      }
      if (method === "workboard.cards.update") {
        throw new Error("card update failed");
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    const onUnlinkedSession = vi.fn();
    await expect(
      discussWorkboardCard({ host, client, card, onUnlinkedSession }),
    ).resolves.toBeNull();
    expect(onUnlinkedSession).toHaveBeenCalledWith(key);

    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.create",
      "workboard.cards.update",
    ]);
    expect(client.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(client.request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(state.cards).toEqual([card]);
    expect(state.error).toContain("An empty chat was created but its card link was not confirmed");
    expect(state.error).toContain(key);
    expect(state.busyCardIds.size).toBe(0);
  });

  it("does not send when the server cannot retain the discussion link", async () => {
    const { host, card, state } = createDiscussionHarness();
    const key = "agent:main:discussion-unretained";
    const onUnlinkedSession = vi.fn();
    const client = createWorkboardTestClient((method) => {
      if (method === "sessions.create") {
        return { key };
      }
      if (method === "workboard.cards.update") {
        return { card };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    await expect(
      discussWorkboardCard({ host, client, card, onUnlinkedSession }),
    ).resolves.toBeNull();
    expect(onUnlinkedSession).toHaveBeenCalledWith(key);
    expect(state.error).toContain("did not retain the discussion link");
    expect(client.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  });

  it("keeps the persisted link and recovery path when sending the initial turn fails", async () => {
    const { host, card, state } = createDiscussionHarness();
    const key = "agent:main:discussion-send-failure";
    const updated = linkedCard(card, key);
    const client = createWorkboardTestClient((method) => {
      if (method === "sessions.create") {
        return { key };
      }
      if (method === "workboard.cards.update") {
        return { card: updated };
      }
      if (method === "chat.send") {
        throw new Error("chat send failed");
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    await expect(discussWorkboardCard({ host, client, card })).resolves.toBeNull();

    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.create",
      "workboard.cards.update",
      "chat.send",
    ]);
    expect(client.request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(discussionSessionKey(state.cards[0]!)).toBe(key);
    expect(state.error).toContain("initial card context was not confirmed sent");
    expect(state.error).toContain(key);
    expect(state.busyCardIds.size).toBe(0);
  });

  it.each(["error", "timeout"])(
    "reports terminal %s acknowledgements with the persisted recovery link",
    async (status) => {
      const { host, card, state } = createDiscussionHarness();
      const key = "agent:main:discussion-terminal";
      const client = createWorkboardTestClient((method) => {
        if (method === "sessions.create") {
          return { key };
        }
        if (method === "workboard.cards.update") {
          return { card: linkedCard(card, key) };
        }
        if (method === "chat.send") {
          return { status, summary: "Turn rejected" };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      await expect(discussWorkboardCard({ host, client, card })).resolves.toBeNull();
      expect(discussionSessionKey(state.cards[0]!)).toBe(key);
      expect(state.error).toContain("Turn rejected");
      expect(state.error).toContain("initial card context was not confirmed sent");
    },
  );

  it("does not link or send when the card changes during session creation", async () => {
    const created = createDeferred<{ key: string }>();
    const { host, card, state } = createDiscussionHarness({ updatedAt: 10 });
    const successor = { ...card, updatedAt: 11 };
    const client = createWorkboardTestClient((method) => {
      if (method === "sessions.create") {
        return created.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    const discussion = discussWorkboardCard({ host, client, card });
    await waitForFast(() => expect(client.request).toHaveBeenCalledOnce());
    state.cards = [successor];
    created.resolve({ key: "agent:main:discussion-stale-card" });

    await expect(discussion).resolves.toBeNull();
    expect(client.request).toHaveBeenCalledOnce();
    expect(state.cards).toEqual([successor]);
    expect(state.error).toContain("card changed");
    expect(state.busyCardIds.size).toBe(0);
  });
});
