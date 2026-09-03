import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSandboxExplainParams,
  validateSandboxEntriesAddParams,
  type SandboxExplainResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { addSandboxEntry, readSandboxInbox } from "../../agents/sandbox/entries.js";
import { resolveSandboxExplainContext } from "../../agents/sandbox/explain-report.js";
import { readSandboxExplainRegistry } from "../../agents/sandbox/explain-runtime.js";
import { errorShapeFromError } from "../error-shape.js";
import type { GatewayRequestHandlers } from "./types.js";

export const sandboxHandlers: GatewayRequestHandlers = {
  "sandbox.explain": async ({ params, respond, context }) => {
    if (!validateSandboxExplainParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid sandbox parameters"),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    let snapshot: ReturnType<typeof resolveSandboxExplainContext>;
    try {
      snapshot = resolveSandboxExplainContext({ cfg, agentId: params.agentId });
    } catch (error) {
      respond(false, undefined, errorShapeFromError(ErrorCodes.INVALID_REQUEST, error));
      return;
    }
    try {
      const registry = await readSandboxExplainRegistry(snapshot, cfg);
      const inbox = await readSandboxInbox(snapshot);
      const result = {
        ...snapshot.report,
        sandbox: {
          ...snapshot.report.sandbox,
          ...(normalizeLowercaseStringOrEmpty(snapshot.sandboxConfig.backend) === "docker"
            ? { network: snapshot.sandboxConfig.docker.network }
            : {}),
        },
        registry,
        inbox,
      } satisfies SandboxExplainResult;
      respond(true, result, undefined);
    } catch (error) {
      respond(false, undefined, errorShapeFromError(ErrorCodes.UNAVAILABLE, error));
    }
  },
  "sandbox.entries.add": async ({ params, respond, context }) => {
    if (!validateSandboxEntriesAddParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid sandbox entry parameters"),
      );
      return;
    }
    try {
      const snapshot = resolveSandboxExplainContext({
        cfg: context.getRuntimeConfig(),
        agentId: params.agentId,
      });
      const result = await addSandboxEntry(snapshot, params.source);
      respond(true, result, undefined);
    } catch (error) {
      respond(false, undefined, errorShapeFromError(ErrorCodes.INVALID_REQUEST, error));
    }
  },
};
