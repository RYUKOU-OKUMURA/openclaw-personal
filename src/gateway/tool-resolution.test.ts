/**
 * Gateway tool-resolution tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as sandboxRuntime from "../agents/sandbox.js";
import type { SandboxBackendHandle } from "../agents/sandbox/backend-handle.types.js";
import { createAgentToolsSandboxContext } from "../agents/test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "../agents/test-helpers/host-sandbox-fs-bridge.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  McpLoopbackToolCache,
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "./mcp-http.runtime.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

async function createMediatedExecFixture() {
  const workspaceDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mediated-exec-")),
  );
  const containerWorkdir = "/sandbox/workspace";
  const buildExecSpec = vi.fn<SandboxBackendHandle["buildExecSpec"]>(async (input) => ({
    argv: ["sandbox-runtime", "exec", "--workdir", input.workdir!, "fixture", input.command],
    env: {},
    stdinMode: "pipe-closed",
  }));
  const sandbox = createAgentToolsSandboxContext({
    workspaceDir,
    containerWorkdir,
    sessionKey: "agent:main:mediated-exec",
    fsBridge: createHostSandboxFsBridge(workspaceDir),
  });
  sandbox.backend = {
    id: "docker",
    runtimeId: sandbox.containerName,
    runtimeLabel: sandbox.containerName,
    workdir: containerWorkdir,
    buildExecSpec,
    runShellCommand: async () => {
      throw new Error("unexpected sandbox command outside the exec supervisor");
    },
  };
  const provision = vi.spyOn(sandboxRuntime, "resolveSandboxContext").mockResolvedValue(sandbox);
  const spawn = vi.spyOn(getProcessSupervisor(), "spawn").mockImplementation(async (input) => {
    input.onStdout?.("sandbox exec ok\n");
    return {
      runId: input.runId ?? "mediated-exec",
      pid: 1234,
      startedAtMs: Date.now(),
      wait: async () => ({
        reason: "exit" as const,
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        stdout: "sandbox exec ok\n",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
      cancel: vi.fn(),
    };
  });
  return {
    workspaceDir,
    sandbox,
    buildExecSpec,
    spawn,
    cleanup: async () => {
      spawn.mockRestore();
      provision.mockRestore();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

describe("resolveGatewayScopedTools", () => {
  beforeAll(async () => {
    await resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });
  });

  it("force-allows the message tool for room-event loopback turns", async () => {
    const result = await resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool).toBeDefined();
  });

  it("keeps webchat room-event turns on automatic source delivery", async () => {
    const result = await resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:webchat:forge-main",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "message")).toBe(false);
  });

  it("force-allows the message tool for routed webchat room-event turns", async () => {
    const result = await resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      sourceReplyDeliveryMode: "message_tool_only",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool).toBeDefined();
  });

  it.each(["profile", "gateway-deny", "surface-exclusion"] as const)(
    "rejects collector mode after %s removes its reader",
    async (restriction) => {
      const result = await resolveGatewayScopedTools({
        cfg: {
          agents: { entries: { main: { default: true } } },
          tools: { profile: restriction === "profile" ? "messaging" : "coding" },
          ...(restriction === "gateway-deny"
            ? { gateway: { tools: { deny: ["agents_wait"] } } }
            : {}),
        },
        sessionKey: "agent:main:main",
        surface: "loopback",
        ...(restriction === "surface-exclusion" ? { excludeToolNames: ["agents_wait"] } : {}),
      });
      const spawn = result.tools.find((tool) => tool.name === "sessions_spawn");
      expect(spawn).toBeDefined();
      expect(result.tools.some((tool) => tool.name === "agents_wait")).toBe(false);
      expect(spawn?.parameters).not.toHaveProperty("properties.collect");
      await expect(
        spawn!.execute("uncollectable", { task: "inspect", collect: true }),
      ).rejects.toThrow("Collector results are unavailable");
    },
  );

  it("keeps ordinary loopback turns under the configured profile", async () => {
    const result = await resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "user_request",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "message")).toBe(false);
  });

  it("keeps default-agent credentials out of unbound gateway calls", async () => {
    const cfg = {
      agents: { defaults: { imageModel: { primary: "openai/gpt-5.4-mini" } } },
    } as OpenClawConfig;
    const unbound = await resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:main",
      surface: "loopback",
    });
    const grantBound = await resolveGatewayScopedTools({
      cfg,
      agentDir: "/agents/cli",
      sessionKey: "agent:main:main",
      surface: "loopback",
    });

    expect(unbound.tools.some((tool) => tool.name === "view_image")).toBe(false);
    expect(grantBound.tools.some((tool) => tool.name === "view_image")).toBe(true);
  });

  it("uses the prepared vision fact for the loopback image loader", async () => {
    const result = await resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      agentDir: "/agents/cli",
      sessionKey: "agent:main:main",
      modelHasVision: true,
      surface: "loopback",
    });

    const imageTool = result.tools.find((tool) => tool.name === "view_image");
    expect(imageTool).toMatchObject({
      label: "View Image",
      catalogMode: "direct-only",
    });
    expect(imageTool?.description).toContain("private model context");
  });

  it.each([
    { first: undefined, second: false },
    { first: false, second: undefined },
  ])(
    "keeps unknown and disabled model vision distinct in cached tools: $first then $second",
    async ({ first, second }) => {
      const cache = new McpLoopbackToolCache();
      const cfg: OpenClawConfig = { tools: { allow: ["computer"] } };
      for (const modelHasVision of [first, second]) {
        const result = await cache.resolve({
          cfg,
          context: {
            sessionKey: "agent:main:vision-context",
            senderIsOwner: true,
            modelHasVision,
          },
        });
        expect(result.tools.some((tool) => tool.name === "computer")).toBe(
          modelHasVision !== false,
        );
      }
    },
  );

  it("applies a borrowed runtime policy without reassigning session tools", async () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          main: {},
          worker: { tools: { deny: ["sessions_list"] } },
        },
      },
    } satisfies OpenClawConfig;

    const result = await resolveGatewayScopedTools({
      cfg,
      sessionKey: "agent:main:main",
      agentId: "main",
      runtimePolicySessionKey: "agent:worker:discord:default:direct:peer-42",
      runtimePolicyAgentId: "worker",
      surface: "loopback",
    });

    expect(result.agentId).toBe("main");
    expect(result.tools.some((tool) => tool.name === "sessions_list")).toBe(false);
    expect(result.tools.some((tool) => tool.name === "sessions_history")).toBe(true);
  });

  it("rejects a runtime policy agent that conflicts with its session key", async () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, worker: {} },
      },
    } satisfies OpenClawConfig;

    await expect(
      resolveGatewayScopedTools({
        cfg,
        sessionKey: "agent:main:main",
        agentId: "main",
        runtimePolicySessionKey: "agent:worker:main",
        runtimePolicyAgentId: "main",
        surface: "loopback",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
  });

  it.each(
    [
      { mode: "policy", resolve: resolveMcpLoopbackPolicyTools },
      { mode: "exact grant", resolve: resolveMcpLoopbackScopedTools },
    ].flatMap(({ mode, resolve }) =>
      [
        { label: "ls-only", toolsAllow: ["ls"], expected: ["ls"] },
        { label: "read-only", toolsAllow: ["read"], expected: ["read"] },
        { label: "mixed", toolsAllow: ["ls", "read"], expected: ["ls", "read"] },
        {
          label: "filesystem group",
          toolsAllow: ["group:fs"],
          expected: mode === "policy" ? ["ls", "read"] : [],
        },
      ].map((testCase) => Object.assign(testCase, { mode, resolve })),
    ),
  )(
    "materializes $label loopback $mode without widening its cap",
    async ({ resolve, toolsAllow, expected }) => {
      const scope = {
        cfg: {
          plugins: { enabled: false },
          tools: { profile: "minimal", alsoAllow: ["ls", "read"] },
        } satisfies OpenClawConfig,
        context: {
          sessionKey: "agent:main:cron:listing-surface",
          workspaceDir: path.join(os.tmpdir(), "openclaw-listing-surface"),
          senderIsOwner: true,
          toolsAllow,
        },
      };
      const allowed = await resolve(scope);
      expect(allowed.tools.map((tool) => tool.name)).toEqual(expected);

      const denied = await resolve({
        ...scope,
        cfg: { ...scope.cfg, tools: { ...scope.cfg.tools, deny: ["ls"] } },
      });
      expect(denied.tools.map((tool) => tool.name)).toEqual(
        expected.filter((name) => name !== "ls"),
      );
    },
  );

  it("materializes an executable write tool on the mediated CLI surface", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mediated-write-"));
    try {
      const result = await resolveGatewayScopedTools({
        cfg: {} as OpenClawConfig,
        sessionKey: "agent:main:cron:mediated-write",
        surface: "loopback",
        workspaceDir,
        mediatedToolNames: ["write"],
        excludeToolNames: ["read", "edit", "apply_patch", "exec", "process"],
      });

      const writeTool = result.tools.find((tool) => tool.name === "write");
      expect(writeTool).toBeDefined();
      await writeTool?.execute?.("mediated-write-call", {
        path: "proof.txt",
        content: "mediated write ok",
      });
      await expect(fs.readFile(path.join(workspaceDir, "proof.txt"), "utf8")).resolves.toBe(
        "mediated write ok",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.each(["rw", "ro"] as const)(
    "keeps mediated filesystem tools inside the provisioned %s sandbox",
    async (workspaceAccess) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mediated-sandbox-")),
      );
      const workspaceDir = path.join(root, "host");
      const sandboxDir = path.join(root, "sandbox");
      const outsideDir = path.join(root, "outside");
      await fs.mkdir(workspaceDir);
      await fs.mkdir(sandboxDir);
      await fs.mkdir(outsideDir);
      await fs.writeFile(path.join(workspaceDir, "proof.txt"), "host contents");
      await fs.writeFile(path.join(sandboxDir, "proof.txt"), "sandbox contents");
      await fs.writeFile(path.join(outsideDir, "proof.txt"), "outside contents");
      await fs.symlink(outsideDir, path.join(sandboxDir, "escape"));
      const sandbox = createAgentToolsSandboxContext({
        workspaceDir: sandboxDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess,
        sessionKey: "agent:main:mediated-sandbox",
        // Use the portable bridge fixture for real I/O; the canonical tool
        // factory still enforces workspace containment and read-only access.
        fsBridge: createHostSandboxFsBridge(sandboxDir),
      });
      const provision = vi
        .spyOn(sandboxRuntime, "resolveSandboxContext")
        .mockResolvedValue(sandbox);
      try {
        const result = await resolveGatewayScopedTools({
          cfg: {
            agents: { defaults: { sandbox: { mode: "all", workspaceAccess } } },
            tools: { allow: ["read", "write", "edit"], fs: { workspaceOnly: true } },
          },
          sessionKey: sandbox.sessionKey,
          surface: "loopback",
          workspaceDir,
          mediatedToolNames: ["read", "write", "edit"],
        });
        const read = result.tools.find((tool) => tool.name === "read");
        expect(result.sandbox).toBe(sandbox);
        expect(read).toBeDefined();
        const readResult = await read!.execute("sandbox-read", { path: "proof.txt" });
        expect(readResult.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("sandbox contents"),
            }),
          ]),
        );
        await expect(read!.execute("escape-read", { path: "escape/proof.txt" })).rejects.toThrow();
        const write = result.tools.find((tool) => tool.name === "write");
        if (workspaceAccess === "ro") {
          expect(write).toBeUndefined();
          expect(result.tools.some((tool) => tool.name === "edit")).toBe(false);
        } else {
          expect(write).toBeDefined();
          await write!.execute("sandbox-write", { path: "proof.txt", content: "sandbox changed" });
          await expect(fs.readFile(path.join(sandboxDir, "proof.txt"), "utf8")).resolves.toBe(
            "sandbox changed",
          );
          await expect(
            write!.execute("escape-write", { path: "escape/proof.txt", content: "escaped" }),
          ).rejects.toThrow();
        }
        await expect(fs.readFile(path.join(workspaceDir, "proof.txt"), "utf8")).resolves.toBe(
          "host contents",
        );
        await expect(fs.readFile(path.join(outsideDir, "proof.txt"), "utf8")).resolves.toBe(
          "outside contents",
        );
        expect(provision).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey: sandbox.sessionKey,
            workspaceDir,
          }),
        );
      } finally {
        provision.mockRestore();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("fails closed when required mediation cannot provision its sandbox", async () => {
    const provision = vi.spyOn(sandboxRuntime, "resolveSandboxContext").mockResolvedValue(null);
    try {
      await expect(
        resolveGatewayScopedTools({
          cfg: { agents: { defaults: { sandbox: { mode: "all" } } } },
          sessionKey: "agent:main:mediated-missing",
          surface: "loopback",
          mediatedToolNames: ["read"],
        }),
      ).rejects.toThrow("sandbox");
    } finally {
      provision.mockRestore();
    }
  });

  it.each([
    { name: "unset exec policy", exec: undefined, denied: false },
    { name: "explicit security deny", exec: { security: "deny" as const }, denied: true },
    { name: "explicit mode deny", exec: { mode: "deny" as const }, denied: true },
  ])("honors $name for mediated sandbox exec", async ({ exec, denied }) => {
    const fixture = await createMediatedExecFixture();
    try {
      const result = await resolveGatewayScopedTools({
        cfg: {
          agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } } },
          tools: { allow: ["exec"], exec },
        },
        sessionKey: fixture.sandbox.sessionKey,
        surface: "loopback",
        workspaceDir: fixture.workspaceDir,
        mediatedToolNames: ["exec"],
      });
      const execTool = result.tools.find((tool) => tool.name === "exec");
      expect(execTool).toBeDefined();
      const execution = execTool!.execute("mediated-exec", { command: "pwd" });
      if (denied) {
        await expect(execution).rejects.toThrow("exec denied");
        expect(fixture.buildExecSpec).not.toHaveBeenCalled();
        expect(fixture.spawn).not.toHaveBeenCalled();
      } else {
        const output = await execution;
        expect(output.details).toMatchObject({ status: "completed", exitCode: 0 });
        expect(fixture.buildExecSpec).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ command: "pwd", workdir: "/sandbox/workspace" }),
        );
        expect(fixture.spawn).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            mode: "child",
            argv: ["sandbox-runtime", "exec", "--workdir", "/sandbox/workspace", "fixture", "pwd"],
            cwd: fixture.workspaceDir,
          }),
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("enforces a read-only session inside a writable mediated sandbox", async () => {
    const fixture = await createMediatedExecFixture();
    try {
      const result = await resolveGatewayScopedTools({
        cfg: {
          agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } } },
          tools: { allow: ["read", "write", "edit", "apply_patch", "exec"] },
        },
        sessionKey: fixture.sandbox.sessionKey,
        execSession: { permissionMode: "read-only" },
        surface: "loopback",
        workspaceDir: fixture.workspaceDir,
        mediatedToolNames: ["read", "write", "edit", "apply_patch", "exec"],
      });
      const names = result.tools.map((tool) => tool.name);
      expect(names).toContain("read");
      expect(names).not.toContain("write");
      expect(names).not.toContain("edit");
      expect(names).not.toContain("apply_patch");
      const execTool = result.tools.find((tool) => tool.name === "exec");
      expect(execTool).toBeDefined();
      await expect(execTool!.execute("readonly-exec", { command: "pwd" })).rejects.toThrow(
        "exec denied",
      );
      expect(fixture.buildExecSpec).not.toHaveBeenCalled();
      expect(fixture.spawn).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("applies sandbox tool denies to sandboxed loopback turns", async () => {
    const result = await resolveGatewayScopedTools({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        tools: { sandbox: { tools: { deny: ["sessions_list"] } } },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
      surface: "loopback",
    });

    const toolNames = result.tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("sessions_list");
    expect(toolNames).toContain("sessions_history");
  });

  it("does not apply sandbox tool policy to the main session in non-main mode", async () => {
    const result = await resolveGatewayScopedTools({
      cfg: {
        agents: { defaults: { sandbox: { mode: "non-main" } } },
        tools: { sandbox: { tools: { deny: ["sessions_list"] } } },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "sessions_list")).toBe(true);
  });

  it("exposes task suggestion tools only for actionable loopback turns", async () => {
    const withoutActions = await resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:main",
      surface: "loopback",
    });
    const withActions = await resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:main",
      taskSuggestionDeliveryMode: "gateway",
      surface: "loopback",
    });

    expect(withoutActions.tools.some((tool) => tool.name === "suggest_task")).toBe(false);
    expect(withActions.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["suggest_task", "dismiss_task"]),
    );
  });

  it("passes loopback yield context into sessions_yield", async () => {
    const registry = await import("../agents/subagents/registry/subagent-registry.js");
    const markRequesterTurnYielded = vi
      .spyOn(registry, "markRequesterTurnYielded")
      .mockReturnValue(1);
    const onYield = vi.fn();
    try {
      const result = await resolveGatewayScopedTools({
        cfg: { tools: { profile: "minimal", alsoAllow: ["sessions_yield"] } } as OpenClawConfig,
        sessionKey: "agent:main:telegram:group:-100123",
        sessionId: "session-123",
        runId: "run-123",
        onYield,
        surface: "loopback",
      });
      const yieldTool = result.tools.find((tool) => tool.name === "sessions_yield");
      if (!yieldTool) {
        throw new Error("expected sessions_yield tool");
      }

      const toolResult = await yieldTool.execute("tool-call-1", {
        message: "waiting on subagents",
        acknowledgment: "I’m waiting on the subagents.",
      });

      expect(markRequesterTurnYielded).toHaveBeenCalledExactlyOnceWith({
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:telegram:group:-100123",
        requesterTurnRunId: "run-123",
      });
      expect(onYield).toHaveBeenCalledWith("waiting on subagents", "I’m waiting on the subagents.");
      expect(toolResult.details).toEqual({
        status: "yielded",
        acknowledgment: "I’m waiting on the subagents.",
      });
    } finally {
      markRequesterTurnYielded.mockRestore();
    }
  });
});
