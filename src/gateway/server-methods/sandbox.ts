import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSandboxExplainParams,
  type SandboxExplainResult,
} from "../../../packages/gateway-protocol/src/index.js";
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
      const result = {
        ...snapshot.report,
        sandbox: {
          ...snapshot.report.sandbox,
          ...(normalizeLowercaseStringOrEmpty(snapshot.sandboxConfig.backend) === "docker"
            ? { network: snapshot.sandboxConfig.docker.network }
            : {}),
        },
        registry,
      } satisfies SandboxExplainResult;
      respond(true, result, undefined);
    } catch (error) {
      respond(false, undefined, errorShapeFromError(ErrorCodes.UNAVAILABLE, error));
    }
  },
};
