import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import { describe, expect, it } from "vitest";
import { syncWorkboardAgentEnded } from "./lifecycle-sync.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

describe("Workboard discussion persistence", () => {
  it("keeps the chat reference and saved outcome across reopen without completing the card", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workboard-discussion-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    let stores = createWorkboardSqliteStores({ dbPath });
    try {
      let store = new WorkboardStore(stores.cards);
      const card = await store.create({
        title: "Explore an idea",
        notes: "Original hypothesis",
        status: "triage",
      });
      const sessionKey = "agent:main:dashboard:discussion-test";
      const linked = await store.update(card.id, {
        metadata: {
          links: [
            {
              id: "discussion-link",
              type: "relates_to",
              title: "Card discussion",
              url: buildControlUiSessionPath({ namespace: "chat", sessionKey, exactKey: true })!,
              createdAt: Date.now(),
            },
          ],
        },
      });
      const outcome = "Decision: test demand. Unresolved: price. Next: interview three customers.";
      await store.addComment(card.id, { body: outcome });
      expect(
        await syncWorkboardAgentEnded({
          store,
          event: { success: true, runId: "discussion-turn" },
          context: { sessionKey },
        }),
      ).toBe(0);
      stores.close();
      stores = createWorkboardSqliteStores({ dbPath });
      store = new WorkboardStore(stores.cards);
      const reloaded = await store.get(card.id);
      expect(reloaded).toMatchObject({
        status: "triage",
        notes: "Original hypothesis",
        metadata: {
          links: linked.metadata?.links,
          comments: [expect.objectContaining({ body: outcome })],
        },
      });
      expect(reloaded?.sessionKey).toBeUndefined();
      expect(reloaded?.execution).toBeUndefined();
    } finally {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
