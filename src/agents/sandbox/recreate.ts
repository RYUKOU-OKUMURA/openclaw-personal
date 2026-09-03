import type { SandboxRecreateResult } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { sandboxContainerLifecycleQueue } from "./docker.js";
import type { resolveSandboxExplainContext } from "./explain-report.js";
import {
  readSandboxExplainRegistryEntry,
  resolveSandboxExplainContainerName,
} from "./explain-runtime.js";
import { removeSandboxContainerEntry } from "./manage.js";

/** Removes this report's runtime; the existing lifecycle recreates it on next use. */
export async function recreateSandboxContainer(
  snapshot: ReturnType<typeof resolveSandboxExplainContext>,
  config: OpenClawConfig,
): Promise<SandboxRecreateResult> {
  const name = resolveSandboxExplainContainerName(snapshot);
  if (!name) {
    throw new Error("This session has no Docker sandbox. Check sandbox.explain before recreating.");
  }
  // Selection and removal share the provisioning queue. An in-flight create
  // must finish first, and another create must not lose its new registry row.
  return sandboxContainerLifecycleQueue.enqueue(name, async () => {
    const entry = await readSandboxExplainRegistryEntry(snapshot);
    if (!entry) {
      return { removed: [], failed: [] };
    }
    try {
      await removeSandboxContainerEntry(entry, config);
      return { removed: [entry.containerName], failed: [] };
    } catch (error) {
      return {
        removed: [],
        failed: [{ containerName: entry.containerName, error: formatErrorMessage(error) }],
      };
    }
  });
}
