// Preserve the real lease owner with isolated catalog/auth dependencies.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../prepared-model-runtime.test-harness.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "../prepared-model-runtime.js";
import { runAgentStep } from "./agent-step.js";
import { testing } from "./agent-step.test-support.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("announce step prepared runtime admission", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "announce-runtime" });
    await resetPreparedModelRuntimeHarness(state);
  });

  afterEach(async ({ task }) => {
    testing.setDepsForTest();
    await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
  });

  it.each(["peer", "released-parent-after-reload"] as const)(
    "admits the target's current runtime instead of inheriting %s generation",
    async (scenario) => {
      mocks.configuredAgentIds = ["default", "worker"];
      for (const agentId of mocks.configuredAgentIds) {
        mocks.configuredWorkspaces.set(agentId, path.join(state.workspaceDir, agentId));
      }
      let config: OpenClawConfig = {
        agents: { defaults: { model: "openai/gpt-4.1" }, entries: { default: {}, worker: {} } },
      };
      const publication = { gatewayLifecycle: true, catalogMode: "static" as const };
      const input = (agentId: string) => ({
        config,
        agentId,
        agentDir: state.agentDir(agentId),
        workspaceDir: mocks.configuredWorkspaces.get(agentId),
      });
      await refreshPreparedModelRuntimeSnapshots(config, publication);
      const parentAgentId = scenario === "peer" ? "default" : "worker";
      const parent = await acquireAgentRunPreparedModelRuntime(input(parentAgentId));
      let parentActive = true;
      const targetCommand = vi.fn(async (opts: { agentId?: string }) => {
        // This is the production runner's admission path, not a replacement guard.
        expect(opts.agentId).toBe("worker");
        const lease = await acquireAgentRunPreparedModelRuntime(input("worker"), {
          pluginGeneration: getPreparedModelRuntimePluginGeneration(),
        });
        try {
          const published = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
          expect(lease.pluginGeneration).toBe(published?.pluginGeneration);
          expect(lease.snapshot.agentId).toBe("worker");
          expect(lease.snapshot.config).toEqual(config);
          await Promise.resolve();
          return {
            payloads: [{ text: "Announcement complete", mediaUrl: null }],
            meta: { durationMs: 1 },
          };
        } finally {
          await lease[Symbol.asyncDispose]();
        }
      });
      testing.setDepsForTest({ agentCommandFromIngress: targetCommand });
      try {
        await withPreparedModelRuntimePluginGenerationScope(
          parent.pluginGeneration,
          async () => {
            if (scenario === "released-parent-after-reload") {
              parentActive = false;
              await parent[Symbol.asyncDispose]();
              config = {
                ...config,
                agents: { ...config.agents, defaults: { model: "openai/gpt-4.1-mini" } },
              };
              await refreshPreparedModelRuntimeSnapshots(config, publication);
            }
            // The stale/cross-agent generation must still be rejected if explicitly reused.
            await expect(
              acquireAgentRunPreparedModelRuntime(input("worker"), {
                pluginGeneration: parent.pluginGeneration,
              }),
            ).rejects.toThrow("plugin generation was superseded");

            await expect(
              runAgentStep({
                agentId: "worker",
                sessionKey: "agent:worker:main",
                message: "Agent-to-agent announce step.",
                transcriptMessage: "",
                extraSystemPrompt: "Announce the completed peer reply.",
                timeoutMs: 10_000,
              }),
            ).resolves.toBe("Announcement complete");
            expect(getPreparedModelRuntimePluginGeneration()).toBe(parent.pluginGeneration);
          },
          () => (parentActive ? parent.snapshot : undefined),
        );
        expect(targetCommand).toHaveBeenCalledOnce();
      } finally {
        parentActive = false;
        await parent[Symbol.asyncDispose]();
      }
    },
  );
});
