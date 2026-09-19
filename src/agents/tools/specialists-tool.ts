import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import {
  listSpecialists,
  prepareSpecialistOperation,
  specialistId,
  specialistManagementEnabled,
} from "../../system-agent/specialists.js";
import type { OpenClawToolsOptions } from "../openclaw-tools.types.js";
import { jsonResult, readToolStringParam, type AnyAgentTool } from "./common.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";

export function createSpecialistToolsForRun(
  options: OpenClawToolsOptions & { sessionAgentId: string },
): AnyAgentTool[] {
  const sessionKey = options.runSessionKey ?? options.agentSessionKey;
  if (
    !options.config ||
    !sessionKey ||
    isSubagentSessionKey(sessionKey) ||
    !specialistManagementEnabled(options.config, options.sessionAgentId)
  ) {
    return [];
  }
  return [
    {
      name: "specialists",
      label: "Specialists",
      catalogMode: "direct-only",
      description:
        "List or create a permanent specialist after discussing its name and role with the user. Creation waits for human approval of a fixed isolated workspace and peer communication permissions. No custom permissions, models, or paths. Reuse an existing specialist by sending tasks with sessions_send; never recreate to change its role.",
      parameters: Type.Object(
        {
          action: Type.Union([Type.Literal("list"), Type.Literal("create")]),
          name: Type.Optional(Type.String({ maxLength: 80 })),
          role: Type.Optional(Type.String({ maxLength: 4000 })),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, args, signal) => {
        // SAFETY: tool inputs are JSON objects; field values are validated below before use.
        const params = args as Record<string, unknown>;
        if (Object.keys(params).some((key) => !["action", "name", "role"].includes(key))) {
          throw new Error("Unsupported specialist input.");
        }
        const { readConfigFileSnapshot } = await import("../../config/config.js");
        const snapshot = await readConfigFileSnapshot();
        if (
          !snapshot.valid ||
          !specialistManagementEnabled(snapshot.config, options.sessionAgentId)
        ) {
          throw new Error("Specialist management is unavailable.");
        }
        const existing = listSpecialists(snapshot.config);
        if (params.action === "list") {
          return jsonResult({ specialists: existing });
        }
        if (params.action !== "create") {
          throw new Error("Unsupported specialist action.");
        }
        const name = readToolStringParam(params, "name", { required: true });
        const role = readToolStringParam(params, "role", { required: true });
        const found = existing.find(
          (entry) => entry.agentId === specialistId(options.sessionAgentId, name),
        );
        if (found) {
          return jsonResult({
            status: "existing",
            ...found,
            message: "Use this specialist; its existing role and permissions were not changed.",
          });
        }
        const operation = prepareSpecialistOperation(
          snapshot.config,
          snapshot.hash ?? null,
          options.sessionAgentId,
          name,
          role,
        );
        const result = await withGatewayToolCallerIdentity(
          {
            agentId: options.sessionAgentId,
            sessionKey,
            fullPermission: false,
            specialistProposal: operation,
            approvalSignals: signal ? [signal] : [],
          },
          async () =>
            await callInProcessGatewayTool<{ reply: string }>("openclaw.chat", {
              sessionId: `specialists-${randomUUID()}`,
              message: "Create the host-prepared specialist proposal.",
              delegation: {
                agentId: options.sessionAgentId,
                sessionKey,
                ...(options.agentChannel ? { turnSourceChannel: options.agentChannel } : {}),
                ...((options.currentMessagingTarget ?? options.currentChannelId ?? options.agentTo)
                  ? {
                      turnSourceTo:
                        options.currentMessagingTarget ??
                        options.currentChannelId ??
                        options.agentTo,
                    }
                  : {}),
                ...(options.agentAccountId ? { turnSourceAccountId: options.agentAccountId } : {}),
                ...((options.currentThreadTs ?? options.agentThreadId) !== undefined
                  ? { turnSourceThreadId: options.currentThreadTs ?? options.agentThreadId }
                  : {}),
              },
            }),
        );
        return jsonResult({ reply: result.reply, agentId: operation.agentId });
      },
    },
  ];
}
