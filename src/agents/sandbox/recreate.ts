import type { SandboxRecreateResult } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withSandboxContainerLifecycle } from "./container-lifecycle.js";
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
  // Wait for provisioning before selecting the exact registered entry. Removal
  // then uses the registry reservation and physical lifecycle owners in manage.
  const entry = await withSandboxContainerLifecycle(name, undefined, () =>
    readSandboxExplainRegistryEntry(snapshot),
  );
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
}
