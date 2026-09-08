import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { replaceCard } from "./card-state.ts";
import { normalizeCardPayload } from "./normalization.ts";
import {
  getWorkboardState,
  invalidateWorkboardLoads,
  workboardMutationsReady,
  type WorkboardHost,
} from "./runtime.ts";
import type { WorkboardCard } from "./types.ts";

// A normal label makes feedback discoverable through the existing card-list tool.
const REJECTED_IDEA_LABEL = "rejected";

export function hasWorkboardRejection(card: WorkboardCard): boolean {
  return (
    card.labels.includes(REJECTED_IDEA_LABEL) &&
    Boolean(card.metadata?.comments?.some((comment) => comment.id === `idea-rejection:${card.id}`))
  );
}

export async function rejectWorkboardIdea(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient;
  card: WorkboardCard;
  reason: string;
  requestUpdate?: () => void;
}): Promise<void> {
  const state = getWorkboardState(params.host);
  const card = params.card;
  if (
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(card.id) ||
    card.status !== "triage" ||
    card.metadata?.archivedAt
  ) {
    throw new Error("Refresh the card before rejecting this idea.");
  }
  const reason = params.reason.trim();
  const alreadyRecorded = hasWorkboardRejection(card);
  if (!alreadyRecorded && (!reason || reason.length > 1800)) {
    throw new Error("A rejection reason of up to 1800 characters is required.");
  }
  if (!card.labels.includes(REJECTED_IDEA_LABEL) && card.labels.length >= 12) {
    throw new Error("Remove a label before rejecting this idea; the card already has 12 labels.");
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(card.id);
  params.requestUpdate?.();
  try {
    if (!alreadyRecorded) {
      const comment = { id: `idea-rejection:${card.id}`, body: reason, createdAt: Date.now() };
      // Persist feedback before hiding the card. CAS protects concurrent comments
      // and also rejects a replay after an unacknowledged successful save.
      const saved = normalizeCardPayload(
        await params.client.request("workboard.cards.update", {
          id: card.id,
          expectedUpdatedAt: card.updatedAt,
          patch: {
            labels: [...new Set([...card.labels, REJECTED_IDEA_LABEL])],
            metadata: { comments: [...(card.metadata?.comments ?? []), comment] },
          },
        }),
      );
      replaceCard(state, saved);
      if (
        !saved.labels.includes(REJECTED_IDEA_LABEL) ||
        !saved.metadata?.comments?.some((entry) => entry.id === comment.id && entry.body === reason)
      ) {
        throw new Error("Rejection feedback was not retained. The card has not been archived.");
      }
    }
    const archived = normalizeCardPayload(
      await params.client.request("workboard.cards.archive", { id: card.id, archived: true }),
    );
    replaceCard(state, archived);
    if (!archived.metadata?.archivedAt) {
      throw new Error("The card was not archived. Retry archiving the saved feedback.");
    }
  } finally {
    state.busyCardIds.delete(card.id);
    params.requestUpdate?.();
  }
}
