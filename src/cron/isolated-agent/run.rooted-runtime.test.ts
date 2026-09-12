// Rooted cron reviews preserve their host-selected root and instructions across runtimes.
import { describe, expect, it, vi } from "vitest";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import {
  SKILL_WORKSHOP_MAINTENANCE_PROMPT,
  SKILL_WORKSHOP_MAINTENANCE_TOOLS,
} from "../../skills/workshop/maintenance-prompt.js";
import { SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX } from "../system-owned-declaration.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  acquirePreparedModelRuntimeMock,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  pickLastNonEmptyTextFromPayloadsMock,
  resolveCronPayloadOutcomeMock,
  resolveCronSessionMock,
  resolveConfiguredModelRefMock,
  resolveEffectiveAgentRuntimeMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const executionRoot = "/tmp/workshop-skills";

describe("runCronIsolatedAgentTurn — rooted runtime fallback", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("rejects a rooted turn before the unsupported Codex harness starts", async () => {
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ executionRoot }),
    );

    expect(result).toMatchObject({
      status: "error",
      admissionDisposition: "rejected",
    });
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "unspecified", cfg: {} },
    {
      label: "auto",
      cfg: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.4": { agentRuntime: { id: "auto" } } },
          },
        },
      },
    },
  ])("forces OpenClaw for a rooted Workshop review with $label runtime policy", async ({ cfg }) => {
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg,
        executionRoot,
        job: {
          declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}worker`,
          payload: { kind: "agentTurn", message: "test" },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(acquirePreparedModelRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: expect.arrayContaining([
          expect.objectContaining({
            provider: "openai",
            modelId: "gpt-5.4",
            runtime: "openclaw",
          }),
        ]),
      }),
      expect.anything(),
    );
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessRuntimeOverride: "openclaw",
        cwd: executionRoot,
        sessionRoot: executionRoot,
        requireWorkspaceOnly: true,
      }),
    );
  });

  it("does not force a Workshop runtime when the turn has no host root", async () => {
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: {
          declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}worker`,
          payload: { kind: "agentTurn", message: "test" },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(acquirePreparedModelRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: expect.arrayContaining([
          expect.objectContaining({ provider: "openai", modelId: "gpt-5.4" }),
        ]),
      }),
      expect.anything(),
    );
    expect(acquirePreparedModelRuntimeMock.mock.calls[0]?.[0].runtimePluginSelections).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ runtime: "openclaw" })]),
    );
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentHarnessRuntimeOverride: undefined }),
    );
  });

  it.each([
    {
      label: "an explicit session runtime override",
      sessionEntry: { agentRuntimeOverride: "codex" },
    },
    {
      label: "a model-selection-locked harness",
      sessionEntry: { agentHarnessId: "codex", modelSelectionLocked: true },
    },
  ])("preserves $label for a rooted Workshop review", async ({ sessionEntry }) => {
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({ sessionEntry: makeCronSessionEntry(sessionEntry) }),
    );
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        executionRoot,
        job: {
          declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}worker`,
          payload: { kind: "agentTurn", message: "test" },
        },
      }),
    );

    expect(result).toMatchObject({
      status: "error",
      admissionDisposition: "rejected",
    });
    expect(acquirePreparedModelRuntimeMock.mock.calls[0]?.[0].runtimePluginSelections).toEqual(
      expect.arrayContaining([expect.objectContaining({ runtime: "codex" })]),
    );
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("does not treat a historical harness id as a new-turn runtime pin", async () => {
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({ sessionEntry: makeCronSessionEntry({ agentHarnessId: "codex" }) }),
    );
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        executionRoot,
        job: {
          declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}worker`,
          payload: { kind: "agentTurn", message: "test" },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(acquirePreparedModelRuntimeMock.mock.calls[0]?.[0].runtimePluginSelections).toEqual(
      expect.arrayContaining([expect.objectContaining({ runtime: "openclaw" })]),
    );
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentHarnessRuntimeOverride: "openclaw" }),
    );
  });

  it("keeps an explicit Codex policy fail-closed for a rooted Workshop review", async () => {
    resolveEffectiveAgentRuntimeMock.mockReturnValue("codex");
    mockRunCronFallbackPassthrough();

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          agents: {
            defaults: {
              models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
            },
          },
        },
        executionRoot,
        job: {
          declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}worker`,
          payload: { kind: "agentTurn", message: "test" },
        },
      }),
    );

    expect(result).toMatchObject({
      status: "error",
      admissionDisposition: "rejected",
    });
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each([
    { prompt: "", skills: [] },
    { prompt: "Explicit safe instructions", skills: [{ name: "safe" }] },
  ])("preserves the host-selected instruction snapshot: $prompt", async (skillsSnapshot) => {
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    }));
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ executionRoot, skillsSnapshot }),
    );
    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(expect.objectContaining({ skillsSnapshot }));
  });

  it("runs a rooted review with a Claude CLI primary and returns its report", async () => {
    const helpers = await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      helpers.pickLastNonEmptyTextFromPayloads,
    );
    resolveCronPayloadOutcomeMock.mockImplementation(helpers.resolveCronPayloadOutcome);
    const skillsSnapshot = { prompt: "", skills: [] };
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    resolveEffectiveAgentRuntimeMock.mockReturnValue("claude-cli");
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    runCliAgentMock.mockImplementation(async (params) => {
      params.onExecutionStarted?.();
      return {
        payloads: [{ text: "Workshop review complete: retained useful procedures." }],
        meta: { agentMeta: {} },
      };
    });
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        executionRoot,
        skillsSnapshot,
        job: {
          declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}worker`,
          payload: {
            kind: "agentTurn",
            message: SKILL_WORKSHOP_MAINTENANCE_PROMPT,
            toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
          },
          delivery: { mode: "none" },
        },
        cfg: {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-6",
              models: { "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } } },
            },
          },
        },
      }),
    );
    expect(result).toMatchObject({
      status: "ok",
      outputText: "Workshop review complete: retained useful procedures.",
    });
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        rootedExecution: { root: executionRoot },
        workspaceDir: executionRoot,
        skillsSnapshot,
        trigger: "cron",
        toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
      }),
    );
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("keeps an unspecified direct Claude CLI provider on its CLI runtime", async () => {
    const helpers = await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
    pickLastNonEmptyTextFromPayloadsMock.mockImplementation(
      helpers.pickLastNonEmptyTextFromPayloads,
    );
    resolveCronPayloadOutcomeMock.mockImplementation(helpers.resolveCronPayloadOutcome);
    const skillsSnapshot = { prompt: "", skills: [] };
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "claude-cli",
      model: "claude-opus-4-6",
    });
    resolveEffectiveAgentRuntimeMock.mockReturnValue("claude-cli");
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    runCliAgentMock.mockImplementation(async (params) => {
      params.onExecutionStarted?.();
      return {
        payloads: [{ text: "Direct CLI review complete." }],
        meta: { agentMeta: {} },
      };
    });
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
      result: await runInitialModelFallbackAttempt(params),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        executionRoot,
        skillsSnapshot,
        job: {
          declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}worker`,
          payload: {
            kind: "agentTurn",
            message: SKILL_WORKSHOP_MAINTENANCE_PROMPT,
            toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
          },
          delivery: { mode: "none" },
        },
      }),
    );

    expect(result).toMatchObject({
      status: "ok",
      outputText: "Direct CLI review complete.",
    });
    expect(acquirePreparedModelRuntimeMock.mock.calls[0]?.[0].runtimePluginSelections).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ provider: "claude-cli", runtime: "openclaw" }),
      ]),
    );
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        rootedExecution: { root: executionRoot },
        workspaceDir: executionRoot,
        skillsSnapshot,
        trigger: "cron",
        toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
      }),
    );
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("skips an unsupported rooted runtime and reaches a later embedded candidate", async () => {
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ modelId }: { modelId: string }) =>
      modelId === "fallback-model" ? "unsupported-harness" : "codex",
    );
    isCliProviderMock.mockReturnValue(false);
    runEmbeddedAgentMock.mockImplementation(
      async (params: { model?: string; onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        if (params.model === "gpt-5.4") {
          throw new Error("embedded primary failed");
        }
        return { payloads: [{ text: "later embedded succeeded" }], meta: { agentMeta: {} } };
      },
    );
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await expect(runInitialModelFallbackAttempt(params)).rejects.toThrow(
        "embedded primary failed",
      );
      await expect(
        runFallbackModelAttempt(params, "fallback-provider", "fallback-model", "unknown"),
      ).rejects.toThrow("collection review requires a runtime that enforces the Workshop root");
      const result = await runFallbackModelAttempt(params, "openai", "gpt-5", "unknown");
      return { result, provider: "openai", model: "gpt-5", attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          agents: {
            defaults: {
              models: {
                "fallback-provider/fallback-model": {
                  agentRuntime: { id: "unsupported-harness" },
                },
              },
            },
          },
        },
        executionRoot,
        job: {
          declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}worker`,
          payload: { kind: "agentTurn", message: "test" },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5",
        agentHarnessRuntimeOverride: "openclaw",
      }),
    );
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ agentHarnessRuntimeOverride: "openclaw" }),
    );
  });
});
