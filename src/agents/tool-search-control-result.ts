import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "../security/external-content.js";
import type { AgentToolResult } from "./runtime/index.js";

type ToolSearchContentBlock = AgentToolResult<unknown>["content"][number];
type ToolSearchImageBlock = Extract<ToolSearchContentBlock, { type: "image" }>;

/** Shared by budget fitting and delivery so formatting cannot consume unreserved context. */
export function serializeToolSearchControlResult(payload: unknown, compact = false): string {
  return JSON.stringify(payload, null, compact ? undefined : 2);
}

function isDeliverableImageBlock(block: ToolSearchContentBlock): block is ToolSearchImageBlock {
  return (
    isRecord(block) &&
    block.type === "image" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
  );
}

/**
 * Lift image blocks out of a relayed target result so they travel in the outer
 * result's content blocks, where every runtime applies the same delivery,
 * sanitization, and budgeting as a direct call. The serialized envelope keeps
 * the transcript diagnostic convention: the same block without `data`, plus
 * decoded `bytes` and `omitted: true`. Blocks that only claim an image type
 * stay in the envelope unchanged.
 */
export function detachToolSearchResultMedia(result: AgentToolResult<unknown>): {
  /** JSON-safe result for the serialized envelope. */
  projection: unknown;
  /** Image blocks to append to the outer result's content, in original order. */
  media: ToolSearchImageBlock[];
} {
  const content = Array.isArray(result.content) ? result.content : [];
  if (!content.some(isDeliverableImageBlock)) {
    return { projection: result, media: [] };
  }
  const media: ToolSearchImageBlock[] = [];
  const projectedContent: unknown[] = content.map((block) => {
    if (!isDeliverableImageBlock(block)) {
      return block;
    }
    media.push(block);
    const stub: Record<string, unknown> = { ...block };
    delete stub.data;
    return Object.assign(stub, {
      bytes: estimateBase64DecodedBytes(block.data),
      omitted: true,
    });
  });
  return { projection: { ...result, content: projectedContent }, media };
}

/** Shared by the source projector and final formatter; no terminal receipts are consumed here. */
export function renderToolSearchControlText(text: string, networkContent: boolean) {
  if (!networkContent) {
    return { text, truncated: false };
  }
  const bounded =
    text.length <= 20_000 ? truncateSanitizedExternalContent(text, 20_000) : undefined;
  const truncated = bounded?.truncated ?? true;
  const modelText =
    !bounded || bounded.truncated
      ? `${truncateSanitizedExternalContent(text, 19_988).text}\n[truncated]`
      : bounded.text;
  return { text: wrapExternalContent(modelText, { source: "api" }), truncated };
}
