import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "../config/sessions/session-accessor.js";
import type { SessionTranscriptContextVersion } from "../config/sessions/session-accessor.sqlite-contract.js";
import { readSessionTranscriptContextMessages } from "../config/sessions/session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.types.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
  withSessionContextAdmission,
} from "../config/sessions/session-transcript-read-fence.js";
import type {
  TranscriptTurnAdmission,
  TranscriptEntryAnchor,
} from "../config/sessions/transcript-entry-anchor.js";
import type { AgentMessage } from "./agent-core.js";
import type {
  InternalSessionTranscriptWriteLockContext,
  InternalSessionTranscriptWriteLockParams,
} from "./session-transcript-lock-runtime.js";
import type { SessionTranscriptTargetParams } from "./session-transcript-runtime.js";

export { resolveSessionTranscriptReadFence as captureCodexSessionTranscriptReadAdmission } from "../config/sessions/session-transcript-read-fence.js";
export { validateSessionTranscriptContextAdmission as validateCodexSessionTranscriptReadAdmission } from "../config/sessions/session-accessor.sqlite-model-context.js";
export { validateSessionTranscriptContextVersion as validateCodexSessionTranscriptContextVersion } from "../config/sessions/session-accessor.sqlite-model-context.js";
export type { SessionTranscriptContextVersion } from "../config/sessions/session-accessor.sqlite-contract.js";
export { SessionTranscriptReadFenceError };

/** The native evidence consumer remains lazy inside one readonly transcript snapshot. */
export function readCodexSessionContext<T>(
  target: SessionTranscriptRuntimeTarget,
  read: (
    messages: Iterable<AgentMessage>,
    header: unknown,
    version?: SessionTranscriptContextVersion,
  ) => T,
  admission?: TranscriptTurnAdmission,
): T {
  return withSessionContextAdmission(target, admission, () =>
    readSessionTranscriptContextMessages(target, read),
  );
}

/** Reads the bundled Codex mirror strictly before one admitted user row. */
export async function readCodexSessionTranscriptEventsBeforeAdmission(
  params: SessionTranscriptTargetParams,
  admission: TranscriptTurnAdmission,
) {
  const { readSessionTranscriptEvents, resolveSessionTranscriptIdentity } =
    await import("./session-transcript-runtime.js");
  const target = await resolveSessionTranscriptIdentity(params);
  if (
    target.agentId !== admission.agentId ||
    target.sessionId !== admission.sessionId ||
    target.sessionKey !== admission.sessionKey
  ) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission belongs to a different transcript target",
    );
  }
  return await runWithSessionTranscriptReadFence(
    admission,
    async () => await readSessionTranscriptEvents(params),
  );
}

export type CodexSessionTranscriptMirrorWriteLockContext =
  InternalSessionTranscriptWriteLockContext & {
    appendMessageWithMessageSequence: <TMessage>(
      options: Omit<TranscriptMessageAppendOptions<TMessage>, "config">,
    ) => Promise<{
      lifecycleRevision?: string;
      messageSeq?: number;
      result: TranscriptMessageAppendResult<TMessage> | undefined;
    }>;
    readMessageFacts: (params: { idempotencyKeys: readonly string[] }) => Promise<{
      anchorsByIdempotencyKey: Map<string, TranscriptEntryAnchor>;
      existingIdempotencyKeys: Set<string>;
      messagesByIdempotencyKey: Map<string, AgentMessage>;
    }>;
  };

/** Runs the bundled Codex mirror under the transcript writer lock. */
export async function withCodexSessionTranscriptMirrorWriteLock<T>(
  params: InternalSessionTranscriptWriteLockParams,
  run: (context: CodexSessionTranscriptMirrorWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const { withProjectedSessionTranscriptWriteLock } =
    await import("./session-transcript-lock-runtime.js");
  // The session payload guard owns persistence capping; keep it lazy so the
  // mirror seam does not pull the agent graph into plugin startup.
  const { capToolResultForPersistence, resolveMaxToolResultChars } =
    await import("../agents/session-tool-result-guard.payload.js");
  const redactionConfig = params.config?.logging;
  const maxToolResultChars = resolveMaxToolResultChars();
  const capMessageForPersistence = <TMessage>(message: TMessage): TMessage =>
    // Mirror persistence shares the session guard's cap so diagnostic payloads
    // such as tool result image bytes are not duplicated into the transcript.
    isAgentMessageRecord(message) && message.role === "toolResult"
      ? (capToolResultForPersistence(message, maxToolResultChars, redactionConfig) as TMessage)
      : message;
  return await withProjectedSessionTranscriptWriteLock(params, run, (context, locked) => ({
    ...context,
    appendMessageWithMessageSequence: (options) =>
      locked.appendMessageWithMessageSequence({
        ...options,
        message: capMessageForPersistence(options.message),
        ...(params.config !== undefined ? { config: params.config } : {}),
      }),
    readMessageFacts: async (factParams) => {
      const facts = await locked.readMessageFacts(factParams);
      const messagesByIdempotencyKey = new Map<string, AgentMessage>();
      for (const [idempotencyKey, message] of facts.messagesByIdempotencyKey) {
        if (isAgentMessageRecord(message)) {
          messagesByIdempotencyKey.set(idempotencyKey, message);
        }
      }
      return { ...facts, messagesByIdempotencyKey };
    },
  }));
}

function isAgentMessageRecord(value: unknown): value is AgentMessage & Record<string, unknown> {
  return isRecord(value) && typeof value.role === "string" && value.role.trim().length > 0;
}
