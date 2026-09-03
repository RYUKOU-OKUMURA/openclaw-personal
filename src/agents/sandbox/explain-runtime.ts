import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSandboxDockerUser } from "./docker-user.js";
import { computeExpectedSandboxConfigHash } from "./docker.js";
import type { resolveSandboxExplainContext } from "./explain-report.js";
import { describeSandboxContainer } from "./manage.js";
import { readRegistryEntry } from "./registry.js";
import { buildSandboxContainerName, slugifySessionKey } from "./shared.js";

/** Projects only the Docker runtime addressed by this report, without provisioning it. */
export async function readSandboxExplainRegistry(
  { report, sandboxConfig, workspaceLayout }: ReturnType<typeof resolveSandboxExplainContext>,
  config: OpenClawConfig,
) {
  if (
    !report.sandbox.sessionIsSandboxed ||
    normalizeLowercaseStringOrEmpty(sandboxConfig.backend) !== "docker"
  ) {
    return null;
  }
  const slug =
    sandboxConfig.scope === "shared" ? "shared" : slugifySessionKey(workspaceLayout.scopeKey);
  const name = buildSandboxContainerName(sandboxConfig.docker.containerPrefix, slug);
  const entry = await readRegistryEntry(name);
  // A scope can own multiple containers. Match the lifecycle's name and backend
  // too, so another workspace or a retired prefix cannot appear as this runtime.
  if (
    !entry ||
    normalizeLowercaseStringOrEmpty(entry.backendId ?? "docker") !== "docker" ||
    entry.sessionKey !== workspaceLayout.scopeKey
  ) {
    return null;
  }
  const docker = await resolveSandboxDockerUser({
    backend: sandboxConfig.backend,
    docker: sandboxConfig.docker,
    workspaceDir: workspaceLayout.workspaceDir,
  });
  const expectedHash = computeExpectedSandboxConfigHash({
    cfg: { ...sandboxConfig, docker },
    ...workspaceLayout,
  });
  const runtime = await describeSandboxContainer(entry, config);
  return {
    containerName: entry.containerName,
    image: runtime.image,
    configHash: entry.configHash,
    createdAtMs: entry.createdAtMs,
    lastUsedAtMs: entry.lastUsedAtMs,
    running: runtime.running,
    // Missing hashes also require recreation, matching the lifecycle owner.
    stale: entry.configHash !== expectedHash,
  };
}
