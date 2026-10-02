// Host filesystem browsing and native picker RPCs. Write-scoped callers stay
// inside configured agent workspaces; admin retains host access.
import { safeParseJson } from "@openclaw/normalization-core";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateFsListDirParams,
  validateFsListDirResult,
  validateFsPickPathParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listHostDirectories } from "../../infra/host-directory-listing.js";
import { pickHostPath } from "../../infra/host-directory-picker.js";
import { NODE_FS_LIST_DIR_COMMAND } from "../../infra/node-commands.js";
import { errorShapeFromError } from "../error-shape.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { resolveWorkspacePathContainment } from "./workspace-path-containment.js";

function isNativePickerAvailable(client: GatewayClient | null): boolean {
  return process.platform === "darwin" && client?.internal?.isLocalClient === true;
}

type NativePickerRequestOptions = Pick<
  GatewayRequestHandlerOptions,
  "params" | "respond" | "client" | "signal"
>;
async function handleNativePickerRequest({
  params,
  respond,
  client,
  signal,
}: NativePickerRequestOptions) {
  if (!validateFsPickPathParams(params)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid fs parameters"));
    return;
  }
  const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
  if (!scopes.includes(ADMIN_SCOPE)) {
    respond(
      false,
      undefined,
      missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
    );
    return;
  }
  if (!isNativePickerAvailable(client)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "native path picker requires a local macOS client"),
    );
    return;
  }
  if (signal?.aborted) {
    return;
  }

  try {
    const result = await pickHostPath({ path: params.path, signal });
    if (!signal?.aborted) {
      respond(true, result, undefined);
    }
  } catch (error) {
    if (!signal?.aborted) {
      respond(false, undefined, errorShapeFromError(ErrorCodes.UNAVAILABLE, error));
    }
  }
}

export const fsHandlers: GatewayRequestHandlers = {
  "fs.listDir": async ({ params, respond, context, client }) => {
    if (!validateFsListDirParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid fs parameters"));
      return;
    }
    try {
      if (params.nodeId) {
        if (params.includeFiles === true) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "includeFiles is supported only for Gateway-local listings",
            ),
          );
          return;
        }
        const node = context.nodeRegistry.get(params.nodeId);
        if (!node) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "node not connected"));
          return;
        }
        if (!node.commands.includes(NODE_FS_LIST_DIR_COMMAND)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "node does not support directory browsing"),
          );
          return;
        }
        const allowed = isNodeCommandAllowed({
          command: NODE_FS_LIST_DIR_COMMAND,
          declaredCommands: node.commands,
          allowlist: resolveNodeCommandAllowlist(context.getRuntimeConfig(), {
            ...node,
            approvedCommands: node.commands,
          }),
        });
        if (!allowed.ok) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `node command not allowed: ${NODE_FS_LIST_DIR_COMMAND} (${allowed.reason})`,
              {
                details: { command: NODE_FS_LIST_DIR_COMMAND, reason: allowed.reason },
              },
            ),
          );
          return;
        }
        const result = await context.nodeRegistry.invoke({
          nodeId: params.nodeId,
          expectedConnId: node.connId,
          ...(node.pairingGeneration ? { expectedPairingGeneration: node.pairingGeneration } : {}),
          command: NODE_FS_LIST_DIR_COMMAND,
          params: params.path ? { path: params.path } : {},
        });
        if (!result.ok) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, result.error?.message ?? "node browse failed"),
          );
          return;
        }
        const payload = result.payloadJSON ? safeParseJson(result.payloadJSON) : result.payload;
        if (!validateFsListDirResult(payload)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "node returned an invalid directory listing"),
          );
          return;
        }
        const { nativePathPicker: _nativePathPicker, ...listing } = payload;
        respond(true, listing, undefined);
        return;
      }
      const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
      if (scopes.includes(ADMIN_SCOPE)) {
        const listing = await listHostDirectories(params.path, {
          includeFiles: params.includeFiles === true,
        });
        respond(
          true,
          isNativePickerAvailable(client)
            ? {
                ...listing,
                nativePathPicker: true as const,
              }
            : listing,
          undefined,
        );
        return;
      }
      const containment = await resolveWorkspacePathContainment(
        params.path || undefined,
        context.getRuntimeConfig(),
        { allowMissing: true },
      );
      if (!containment) {
        respond(
          false,
          undefined,
          missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
        );
        return;
      }
      const listing = await listHostDirectories(containment.path, {
        includeFiles: params.includeFiles === true,
      });
      if (listing.path === containment.workspaceRoot) {
        const { parent: _parent, ...clamped } = listing;
        respond(true, clamped, undefined);
        return;
      }
      respond(true, listing, undefined);
    } catch (error) {
      respond(false, undefined, errorShapeFromError(ErrorCodes.INVALID_REQUEST, error));
    }
  },
  "fs.pickPath": handleNativePickerRequest,
};
