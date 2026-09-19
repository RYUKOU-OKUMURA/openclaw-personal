import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type {
  SandboxEntriesAddParams,
  SandboxEntriesAddResult,
} from "../../../packages/gateway-protocol/src/schema/sandbox.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { sanitizeTerminalUploadName } from "../../infra/terminal-file-upload.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { listAgentEntriesWithSource } from "../agent-scope-config.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { resolveSandboxExplainContext } from "./explain-report.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import { isPathInsideContainerRoot, normalizeContainerPathCore } from "./path-utils.js";
import { validateSandboxSecurity } from "./validate-sandbox-security.js";

type ShareParams = Exclude<SandboxEntriesAddParams, { mode: "copy" }>;
const SHARED_CONTAINER_ROOT = "/mnt/shared";

/** Builds intent from the config writer's snapshot; never writes config or touches the source. */
export async function buildSandboxSharePatch(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  request: ShareParams;
}): Promise<{ patch: OpenClawConfig; result: SandboxEntriesAddResult }> {
  const { config, sourceConfig, request } = params;
  const { report, sandboxConfig, workspaceLayout } = resolveSandboxExplainContext({
    cfg: config,
    agentId: request.agentId,
  });
  if (
    !report.sandbox.sessionIsSandboxed ||
    normalizeLowercaseStringOrEmpty(sandboxConfig.backend) !== "docker"
  ) {
    throw new Error("Enable a Docker sandbox before sharing files.");
  }
  if (!path.isAbsolute(request.source.path)) {
    throw new Error("Choose an absolute host file or folder path.");
  }
  // Persist the selected real target, so changing a picker-visible symlink later
  // does not redirect this grant to a different host directory.
  const hostPath = await fs.realpath(request.source.path);
  const stat = await fs.stat(hostPath);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error("Choose a regular file or folder to share.");
  }
  const kind = stat.isDirectory() ? "directory" : "file";
  const name = sanitizeTerminalUploadName(path.basename(hostPath));
  const mountRoots = report.sandbox.workspaceMounts.map(
    (mount) => normalizeContainerPathCore(mount.containerRoot).replace(/\/+$/, "") || "/",
  );
  if (mountRoots.some((mount) => isPathInsideContainerRoot(mount, SHARED_CONTAINER_ROOT))) {
    throw new Error("The shared-file destination is already mounted. Adjust that mount first.");
  }
  const extension = kind === "file" ? path.extname(name) : "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  let targetName = name;
  let containerPath = path.posix.join(SHARED_CONTAINER_ROOT, targetName);
  for (
    let suffix = 2;
    mountRoots.some(
      (mount) =>
        isPathInsideContainerRoot(mount, containerPath) ||
        isPathInsideContainerRoot(containerPath, mount),
    );
    suffix++
  ) {
    targetName = `${stem}-${suffix}${extension}`;
    containerPath = path.posix.join(SHARED_CONTAINER_ROOT, targetName);
  }
  const bind = `${hostPath}:${containerPath}:${request.mode}`;
  const parsed = splitSandboxBindSpec(bind);
  if (
    hostPath !== hostPath.trim() ||
    parsed?.host !== hostPath ||
    parsed.container !== containerPath ||
    parsed.options !== request.mode
  ) {
    throw new Error("This path cannot be represented as a Docker bind. Rename it or use a copy.");
  }
  const allowedSourceRoots = [workspaceLayout.workspaceDir, workspaceLayout.agentWorkspaceDir];
  const external = !allowedSourceRoots.some((root) =>
    isPathInside(resolveSandboxHostPathViaExistingAncestor(root), hostPath),
  );
  const externalAllowed = sandboxConfig.docker.dangerouslyAllowExternalBindSources === true;
  validateSandboxSecurity({ binds: [bind] });
  if (external && !externalAllowed && request.allowExternalSource !== true) {
    throw new Error(
      "Confirm sharing this external source and retry with allowExternalSource: true.",
    );
  }
  // The existing validator remains authoritative for blocked paths, aliases,
  // reserved targets and Docker isolation settings, even after explicit consent.
  validateSandboxSecurity({
    ...sandboxConfig.docker,
    binds: [...(sandboxConfig.docker.binds ?? []), bind],
    allowedSourceRoots,
    allowSourcesOutsideAllowedRoots: externalAllowed || request.allowExternalSource === true,
    allowReservedContainerTargets:
      sandboxConfig.docker.dangerouslyAllowReservedContainerTargets === true,
  });
  const selectedAgent = listAgentEntriesWithSource(sourceConfig).find(
    ({ entry }) => normalizeAgentId(entry.id) === report.agentId,
  );
  // Shared scope deliberately ignores agent Docker settings. Otherwise grants
  // belong to this agent, not the defaults inherited by unrelated agents.
  const sharedScope = resolveSandboxConfigForAgent(config, report.agentId).scope === "shared";
  const ownerDocker = sharedScope
    ? sourceConfig.agents?.defaults?.sandbox?.docker
    : selectedAgent?.entry.sandbox?.docker;
  const docker = {
    binds: [...(ownerDocker?.binds ?? []), bind],
    ...(external && !externalAllowed ? { dangerouslyAllowExternalBindSources: true } : {}),
  };
  const sandbox = { docker };
  const patch: OpenClawConfig = sharedScope
    ? { agents: { defaults: { sandbox } } }
    : selectedAgent?.source.kind === "list"
      ? { agents: { list: [{ id: selectedAgent.entry.id, sandbox }] } }
      : {
          agents: {
            entries: { [selectedAgent?.entry.id ?? report.agentId]: { sandbox } },
          },
        };
  return {
    patch,
    result: {
      entry: { name: targetName, kind, hostPath, containerPath, mode: request.mode },
      // Config acceptance does not alter mounts in an already-running container.
      recreateRequired: true,
    },
  };
}
