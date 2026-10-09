import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export async function prepareWorkshopReview(
  skillsDir: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  abortSignal?.throwIfAborted();
  await fs.mkdir(skillsDir, { recursive: true });
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  abortSignal?.throwIfAborted();
  // .openclaw is reserved workspace metadata, not collection material.
  return entries.some((entry) => entry.name !== ".openclaw" || !entry.isDirectory());
}

export function resolveWorkshopSkillsDir(
  config: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveAgentDir(config, agentId, env), "workshop-skills");
}

export function resolveWorkshopWatchRoots(config?: OpenClawConfig, agentId?: string) {
  return config && agentId
    ? [{ path: resolveWorkshopSkillsDir(config, agentId), source: "openclaw-workshop" }]
    : [];
}
