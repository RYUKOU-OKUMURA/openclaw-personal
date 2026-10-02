import fs from "node:fs/promises";
import {
  resolveSubagentSessionAttachmentRootDir,
  SANDBOX_SUBAGENT_ATTACHMENTS_MOUNT,
} from "../subagents/subagent-attachment-paths.js";

/** Share the lifecycle's attachment projection with read-only runtime inspection. */
export async function resolveSandboxSessionResourceMounts(params: {
  scope: string;
  agentId: string;
  sessionKey: string;
}): Promise<Array<{ hostPath: string; containerPath: string }> | undefined> {
  if (params.scope === "shared") {
    return undefined;
  }
  const hostPath = resolveSubagentSessionAttachmentRootDir({
    agentId: params.agentId,
    childSessionKey: params.sessionKey,
  });
  try {
    if (!(await fs.stat(hostPath)).isDirectory()) {
      return undefined;
    }
    return [
      { hostPath: await fs.realpath(hostPath), containerPath: SANDBOX_SUBAGENT_ATTACHMENTS_MOUNT },
    ];
  } catch {
    return undefined;
  }
}
