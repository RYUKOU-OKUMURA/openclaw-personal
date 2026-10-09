import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { getInProcessGatewayToolContext } from "../agents/tools/in-process-gateway.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronExecutionIdentityAdmission, CronServiceState } from "../cron/service/state.js";
import { armTimer } from "../cron/service/timer.js";
import { resolveSkillCollectionReviewMonitorSpecs } from "../cron/skill-collection-review-monitor.js";
import type { CronJobCreate } from "../cron/types.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { buildGatewayCronService } from "./server-cron.js";

type CronFixture = ReturnType<typeof buildGatewayCronService>;
type CronJobOverrides = Partial<Omit<CronJobCreate, "name" | "payload">>;
type AddCronJob = (
  service: CronFixture,
  name: string,
  message: string,
  overrides?: CronJobOverrides,
) => ReturnType<CronFixture["cron"]["add"]>;
type GatewayCronContextTestHarness = {
  createCronConfig: (name: string) => OpenClawConfig;
  createCronService: (
    cfg: OpenClawConfig,
    overrides?: Partial<
      Pick<Parameters<typeof buildGatewayCronService>[0], "resolveGatewayContext" | "scheduler">
    >,
  ) => CronFixture;
  getCronState: (service: CronFixture) => CronServiceState;
  addAgentTurnJob: AddCronJob;
  addSystemEventJob: AddCronJob;
  loadConfigMock: { mockReturnValue: (cfg: OpenClawConfig) => unknown };
  runCronIsolatedAgentTurnMock: {
    mockImplementationOnce: (
      implementation: () => Promise<{ status: "ok"; summary: string }>,
    ) => unknown;
  };
  requestHeartbeatAndWaitMock: {
    mockImplementationOnce: (implementation: () => Promise<HeartbeatRunResult>) => unknown;
  };
};

export function registerGatewayCronContextTests({
  createCronConfig,
  createCronService,
  getCronState,
  addAgentTurnJob,
  addSystemEventJob,
  loadConfigMock,
  runCronIsolatedAgentTurnMock,
  requestHeartbeatAndWaitMock,
}: GatewayCronContextTestHarness) {
  const createBroker = useSpawnBrokerTestFixture(afterEach);
  it.each(["empty", "metadata", "symlink", "unknown", "invalid", "read-error", "cancelled"])(
    "handles collection review inventory: %s",
    async (inventory) => {
      const cfg = createCronConfig(`server-cron-review-${inventory}`);
      cfg.skills = { workshop: { autonomous: { mode: "auto" } } };
      cfg.agents = {
        entries: {
          main: {
            agentDir: path.join(path.dirname((cfg.cron as { store: string }).store), "agent"),
            tools: { deny: ["group:fs", "group:runtime"] },
          },
        },
      };
      const root = resolveWorkshopSkillsDir(cfg, "main");
      await fs.mkdir(root, { recursive: true });
      if (inventory === "metadata") {
        await fs.mkdir(path.join(root, ".openclaw"));
      } else if (inventory === "symlink") {
        const target = path.join(path.dirname(root), "symlink-material");
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, "SKILL.md"), "Preserve target material");
        await fs.symlink(
          target,
          path.join(root, ".openclaw"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } else if (inventory === "unknown") {
        await fs.writeFile(path.join(root, "unknown.txt"), "Unreviewed material");
      } else if (inventory === "invalid") {
        await fs.mkdir(path.join(root, "invalid-skill"));
        await fs.writeFile(path.join(root, "invalid-skill", "SKILL.md"), "Malformed skill");
      }
      loadConfigMock.mockReturnValue(cfg);
      const state = createCronService(cfg);
      const summaries: string[] = [];
      const onEvent = getCronState(state).deps.onEvent;
      getCronState(state).deps.onEvent = (event, context) => {
        onEvent?.(event, context);
        if (event.action === "finished" && event.summary) {
          summaries.push(event.summary);
        }
      };
      await state.reconcileSystemJobs();
      const job = (await state.cron.list({ includeDisabled: true })).find(
        (candidate) => candidate.declarationKey === "skill-collection-review:main",
      );
      if (!job) {
        throw new Error("expected the skill collection review monitor");
      }
      const abortController = new AbortController();
      const failure = new Error(`collection inventory ${inventory}`);
      if (inventory === "cancelled") {
        abortController.abort(failure);
      }
      const readFailure =
        inventory === "read-error"
          ? vi.spyOn(fs, "readdir").mockRejectedValueOnce(failure)
          : undefined;
      try {
        if (inventory === "read-error" || inventory === "cancelled") {
          await expect(
            getCronState(state).deps.runIsolatedAgentJob({
              job,
              message: "review",
              abortSignal: abortController.signal,
            }),
          ).rejects.toThrow(failure);
          expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
        } else {
          const empty = inventory === "empty" || inventory === "metadata";
          if (!empty) {
            runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
              throw new Error("Collection review tools denied");
            });
          }
          await state.cron.run(job.id, "force");
          expect(state.cron.getJob(job.id)).toMatchObject({
            enabled: true,
            state: { lastRunStatus: empty ? "skipped" : "error" },
          });
          expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(empty ? 0 : 1);
          if (inventory === "symlink") {
            expect(
              await fs.readFile(
                path.join(path.dirname(root), "symlink-material", "SKILL.md"),
                "utf8",
              ),
            ).toBe("Preserve target material");
          }
          if (empty) {
            expect(summaries).toContain("No Skill Workshop collection material to review.");
          }
        }
      } finally {
        readFailure?.mockRestore();
        state.cron.stop();
      }
    },
  );

  it("converges collection review delivery and runs without a configured channel", async () => {
    const cfg = {
      ...createCronConfig("server-cron-skill-review-delivery"),
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } satisfies OpenClawConfig;
    cfg.agents = {
      entries: {
        main: { agentDir: path.join(path.dirname((cfg.cron as { store: string }).store), "agent") },
      },
    };
    await fs.mkdir(path.join(resolveWorkshopSkillsDir(cfg, "main"), "existing-skill"), {
      recursive: true,
    });
    loadConfigMock.mockReturnValue(cfg);
    const state = createCronService(cfg);
    const [spec] = resolveSkillCollectionReviewMonitorSpecs(cfg, [], {
      schedulerSeed: "test-seed",
    });

    if (!spec) {
      throw new Error("expected the skill collection review monitor spec");
    }

    try {
      const existing = await state.cron.add(
        { ...spec.input, delivery: { mode: "announce" } },
        { enabledExplicit: true, systemOwned: true },
      );
      runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => ({
        status: "ok",
        summary: "review complete",
      }));

      await expect(state.reconcileSystemJobs()).resolves.toBe("converged");
      expect(state.cron.getJob(existing.id)).toMatchObject({ delivery: { mode: "none" } });

      await expect(state.cron.run(existing.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(state.cron.getJob(existing.id)?.state).toMatchObject({
        lastRunStatus: "ok",
        lastDeliveryStatus: "not-requested",
      });
      expect(state.cron.getJob(existing.id)?.state.lastDeliveryError).toBeUndefined();
    } finally {
      state.cron.stop();
    }
  });

  it("forwards cancellation, execution callbacks, and identity to collection review turns", async () => {
    const cfg = {
      ...createCronConfig("server-cron-skill-review-forwarding"),
      skills: { workshop: { autonomous: { mode: "auto" } } },
    } satisfies OpenClawConfig;
    cfg.agents = {
      entries: {
        main: { agentDir: path.join(path.dirname((cfg.cron as { store: string }).store), "agent") },
      },
    };
    await fs.mkdir(path.join(resolveWorkshopSkillsDir(cfg, "main"), "existing-skill"), {
      recursive: true,
    });
    loadConfigMock.mockReturnValue(cfg);
    const state = createCronService(cfg);
    const abortController = new AbortController();
    const onExecutionStarted = vi.fn();
    const onExecutionPhase = vi.fn();
    const onLaneWait = vi.fn();
    const executionIdentity = {
      ingress: { kind: "schedule", boundary: "cron.test", state: "present" },
    } satisfies CronExecutionIdentityAdmission;
    await expect(state.reconcileSystemJobs()).resolves.toBe("converged");
    const job = (await state.cron.list({ includeDisabled: true })).find(
      (candidate) => candidate.declarationKey === "skill-collection-review:main",
    );
    if (!job) {
      throw new Error("expected the skill collection review monitor");
    }

    try {
      await getCronState(state).deps.runIsolatedAgentJob({
        job,
        message: "review",
        abortSignal: abortController.signal,
        onExecutionStarted,
        onExecutionPhase,
        onLaneWait,
        executionIdentity,
      });

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          abortSignal: abortController.signal,
          onExecutionStarted,
          onExecutionPhase,
          onLaneWait,
          executionIdentity,
          skillsSnapshot: { prompt: "", skills: [] },
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("owns timer execution and settlement after its creator context closes", async () => {
    const broker = await createBroker();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T01:00:00.000Z"));
    const clock = createGatewaySchedulerClock(Date.now());
    const cfg = createCronConfig("server-cron-scheduled-gateway-context");
    loadConfigMock.mockReturnValue(cfg);
    const gatewayContext = {
      terminalSessions: {},
      resolveGatewayContext: () => gatewayContext,
    } as never;
    const creatorContext = new AsyncLocalStorage<string>();
    const creatorWork = new AsyncWorkScope();
    let requestContextActive = true;
    const retiredRequestContext = {
      terminalSessions: { retired: true },
      resolveGatewayContext: () => (requestContextActive ? retiredRequestContext : undefined),
    } as never;
    const retiredRequestClient = { id: "retired-request" } as never;
    let observed: unknown = "never-ran";
    let observedClient: unknown = "never-ran";
    let observedCreator: unknown = "never-ran";
    let observedWork: unknown = "never-ran";
    let observedBroker: unknown = "never-ran";
    const settled = createDeferred();
    let settlementContext: unknown = "never-settled";
    let assertScheduledCaller: ReturnType<typeof captureGatewayToolCallerAssertion>;
    const ran = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      observed = getInProcessGatewayToolContext();
      observedClient = getPluginRuntimeGatewayRequestScope()?.client;
      observedCreator = creatorContext.getStore();
      observedBroker = getSpawnBroker();
      observedWork = await trackAsyncWork(() => "completed").catch((error: unknown) => error);
      assertScheduledCaller = captureGatewayToolCallerAssertion();
      ran.resolve();
      return { status: "ok", text: "done" } as never;
    });

    const state = runWithSpawnBroker(broker, () =>
      createCronService(cfg, {
        scheduler: createTestGatewayScheduler(clock.clock),
        resolveGatewayContext: () => gatewayContext,
      }),
    );
    try {
      await state.cron.start();
      await addAgentTurnJob(state, "scheduled-isolated", "run it", {
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      });
      const cronState = getCronState(state);
      const onEvent = cronState.deps.onEvent;
      cronState.deps.onEvent = (event, context) => {
        onEvent?.(event, context);
        if (event.action === "finished") {
          settlementContext = getInProcessGatewayToolContext();
          settled.resolve();
        }
      };
      const creatorScope = await creatorWork.run(() =>
        creatorContext.run("expired creator", () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:schedule-creator",
              operationalRunInstance: { runId: "creator-run", instanceId: "creator-instance" },
              receiptAuthority: () => requestContextActive,
            },
            () =>
              withPluginRuntimeGatewayRequestScope(
                {
                  context: retiredRequestContext,
                  client: retiredRequestClient,
                  isWebchatConnect: () => false,
                } as never,
                () => {
                  armTimer(cronState);
                  return {
                    run: AsyncLocalStorage.snapshot(),
                    assertCurrent: captureGatewayToolCallerAssertion(),
                  };
                },
              ),
          ),
        ),
      );
      requestContextActive = false;
      await creatorWork.drain();

      await creatorScope.run(() => clock.advanceBy(60_000));
      await ran.promise;
      await settled.promise;

      expect(observedCreator).toBeUndefined();
      expect(observedWork).toBe("completed");
      expect(settlementContext).toBe(gatewayContext);
      expect(observed).toBe(gatewayContext);
      expect(observedClient).toBeUndefined();
      expect(observedBroker).toBe(broker);
      expect(() => assertScheduledCaller?.("chat.history")).not.toThrow();
      expect(() => creatorScope.assertCurrent?.("chat.history")).toThrow(
        "agent tool caller authority is no longer active",
      );
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("leaves a scheduler-triggered isolated run without context when no resolver is wired", async () => {
    const cfg = createCronConfig("server-cron-scheduled-gateway-context-absent");
    loadConfigMock.mockReturnValue(cfg);
    let observed: unknown = "never-ran";
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      observed = getInProcessGatewayToolContext();
      return { status: "ok", text: "done" } as never;
    });

    const state = createCronService(cfg);
    try {
      const job = await addAgentTurnJob(state, "scheduled-isolated-no-resolver", "run it", {
        deleteAfterRun: false,
      });

      await state.cron.run(job.id, "force");

      expect(observed).toBeUndefined();
    } finally {
      state.cron.stop();
    }
  });

  it("withholds a retired gateway context from a scheduled run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T02:00:00.000Z"));
    const clock = createGatewaySchedulerClock(Date.now());
    // The process-wide context holder is not cleared on shutdown, so an
    // unfenced resolver would hand a queued run a retired context. No context
    // fails visibly; a retired one operates against a dead Gateway generation.
    const cfg = createCronConfig("server-cron-retired-gateway-context");
    loadConfigMock.mockReturnValue(cfg);
    const retiredContext = {
      terminalSessions: {},
      // Instance retired: its own lifecycle resolver reports unavailable.
      resolveGatewayContext: () => undefined,
    } as never;
    let observed: unknown = "never-ran";
    const ran = createDeferred();
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      observed = getInProcessGatewayToolContext();
      ran.resolve();
      return { status: "ok", text: "done" } as never;
    });

    const state = createCronService(cfg, {
      scheduler: createTestGatewayScheduler(clock.clock),
      resolveGatewayContext: () => retiredContext,
    });
    try {
      await state.cron.start();
      await addAgentTurnJob(state, "retired-context", "run it", {
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
      });

      await clock.advanceBy(60_000);
      await ran.promise;

      expect(observed).toBeUndefined();
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("gives a scheduled heartbeat wake a resolvable gateway context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T03:00:00.000Z"));
    const clock = createGatewaySchedulerClock(Date.now());
    // Main-session cron jobs and heartbeat monitors reach the agent through the
    // heartbeat adapter, which shares the isolated path's contextless defect.
    const cfg = createCronConfig("server-cron-heartbeat-gateway-context");
    loadConfigMock.mockReturnValue(cfg);
    const gatewayContext = {
      terminalSessions: {},
      resolveGatewayContext: () => gatewayContext,
    } as never;
    let observed: unknown = "never-ran";
    const ran = createDeferred();
    requestHeartbeatAndWaitMock.mockImplementationOnce(async () => {
      observed = getInProcessGatewayToolContext();
      ran.resolve();
      return { status: "ran", durationMs: 1 };
    });

    const state = createCronService(cfg, {
      scheduler: createTestGatewayScheduler(clock.clock),
      resolveGatewayContext: () => gatewayContext,
    });
    try {
      await state.cron.start();
      await addSystemEventJob(state, "scheduled-heartbeat", "run it", {
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
        sessionTarget: "main",
        wakeMode: "now",
      });
      await clock.advanceBy(60_000);
      await ran.promise;

      expect(observed).toBe(gatewayContext);
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("keeps an RPC-inherited gateway context instead of the scheduler resolver", async () => {
    const cfg = createCronConfig("server-cron-rpc-gateway-context");
    loadConfigMock.mockReturnValue(cfg);
    const rpcContext = { terminalSessions: { rpc: true } } as never;
    const schedulerContext = {
      terminalSessions: { scheduler: true },
      resolveGatewayContext: () => schedulerContext,
    } as never;
    const resolveGatewayContext = vi.fn(() => schedulerContext);
    let observed: unknown = "never-ran";
    let callerActive = true;
    let assertCaller: ReturnType<typeof captureGatewayToolCallerAssertion>;
    runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
      observed = getInProcessGatewayToolContext();
      assertCaller = captureGatewayToolCallerAssertion();
      return { status: "ok", text: "done" } as never;
    });

    const state = createCronService(cfg, { resolveGatewayContext });
    try {
      const job = await addAgentTurnJob(state, "rpc-isolated", "run it", {
        deleteAfterRun: false,
      });

      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:manual-run",
          operationalRunInstance: { runId: "manual-run", instanceId: "manual-instance" },
          receiptAuthority: () => callerActive,
        },
        () =>
          withPluginRuntimeGatewayRequestScope(
            { context: rpcContext, isWebchatConnect: () => false } as never,
            () => state.cron.run(job.id, "force"),
          ),
      );

      expect(observed).toBe(rpcContext);
      expect(assertCaller).toBeTypeOf("function");
      expect(() => assertCaller?.("chat.history")).not.toThrow();
      callerActive = false;
      expect(() => assertCaller?.("chat.history")).toThrow(
        "agent tool caller authority is no longer active",
      );
    } finally {
      state.cron.stop();
    }
  });
}
