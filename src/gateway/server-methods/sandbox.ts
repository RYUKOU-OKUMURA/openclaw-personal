import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSandboxExplainParams,
  validateSandboxEntriesAddParams,
  type SandboxEntriesAddResult,
  type SandboxExplainResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { addSandboxEntry, readSandboxInbox } from "../../agents/sandbox/entries.js";
import { resolveSandboxExplainContext } from "../../agents/sandbox/explain-report.js";
import { readSandboxExplainRegistry } from "../../agents/sandbox/explain-runtime.js";
import { buildSandboxSharePatch } from "../../agents/sandbox/shared-entries.js";
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
  "sandbox.entries.add": async ({ params, respond, context, client }) => {
    if (!validateSandboxEntriesAddParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid sandbox entry parameters"),
      );
      return;
    }
    try {
      if (params.mode !== "copy") {
        const { applyConfigMergePatchInProcess } = await import("./config.js");
        const request = params;
        let result: SandboxEntriesAddResult | undefined;
        await applyConfigMergePatchInProcess({
          client,
          context,
          buildPatch: async ({ snapshot }) => {
            const prepared = await buildSandboxSharePatch({
              config: snapshot.config,
              sourceConfig: snapshot.sourceConfig,
              request,
            });
            result = prepared.result;
            return { patch: prepared.patch };
          },
          // The config owner acknowledges only after validation, CAS and runtime
          // acceptance. Expose the share receipt, not its full config response.
          respond: (ok, _payload, error, meta) => respond(ok, ok ? result : undefined, error, meta),
        });
        return;
      }
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
