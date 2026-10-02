import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../../security/dangerous-tools.js";
import { specialistId } from "../../system-agent/specialists.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createOpenClawDelegateToolsForRun } from "./openclaw-delegate-tool.js";
import { createSpecialistToolsForRun } from "./specialists-tool.js";

const mocks = vi.hoisted(() => ({ config: {} as OpenClawConfig, call: vi.fn() }));
vi.mock("../../config/config.js", async (original) => ({
  ...(await original<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => ({ valid: true, hash: "hash", config: mocks.config }),
}));
vi.mock("./in-process-gateway.js", () => ({ callInProcessGatewayTool: mocks.call }));
function makeConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        subagents: { model: "openai/gpt-4.1" },
        sandbox: { mode: "all", sessionToolsVisibility: "all" },
      },
      list: [{ id: "main", tools: { alsoAllow: ["specialists"] } }, { id: "gbp" }],
    },
    tools: {
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true, allow: ["main", "gbp"] },
    },
  };
}
function specialistFixture(name: string, role: string) {
  return { id: specialistId("main", name), name, identity: { theme: role } };
}
function tools(config = mocks.config, sessionAgentId = "main", sessionKey = "agent:main:main") {
  return createSpecialistToolsForRun({
    config,
    sessionAgentId,
    agentSessionKey: sessionKey,
    sandboxed: true,
  });
}
beforeEach(() => {
  mocks.config = makeConfig();
  mocks.call.mockReset();
});

describe("specialist capability", () => {
  it("uses the standard owner-only and HTTP deny gates for management capabilities", () => {
    expect(DEFAULT_GATEWAY_HTTP_TOOL_DENY).toContain("specialists");
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("specialists");
  });
  it("requires exact enablement and refuses child/peer management while ordinary admin stays sandbox-blocked", () => {
    expect(tools()).toHaveLength(1);
    expect(tools({}, "main")).toEqual([]);
    expect(tools({ tools: { allow: ["*"] } }, "main")).toEqual([]);
    expect(tools(mocks.config, "gbp", "agent:gbp:main")).toEqual([]);
    expect(tools(mocks.config, "main", "agent:main:subagent:x")).toEqual([]);
    expect(
      createOpenClawDelegateToolsForRun({
        config: mocks.config,
        sessionAgentId: "main",
        sandboxed: true,
      }),
    ).toEqual([]);
    const peer = specialistFixture("分析担当", "Count responses");
    expect(
      tools(
        {
          ...mocks.config,
          agents: { ...mocks.config.agents, list: [...mocks.config.agents!.list!, peer] },
        },
        peer.id,
        `agent:${peer.id}:main`,
      ),
    ).toEqual([]);
  });
  it("binds only the host proposal to the original requester and forces approval even under Full Access", async () => {
    const controller = new AbortController();
    mocks.call.mockImplementation(async (method, args) => {
      const identity = getGatewayToolCallerIdentity();
      expect(method).toBe("openclaw.chat");
      expect(args.sessionId).toMatch(/^specialists-/);
      expect(args).not.toHaveProperty("specialistProposal");
      expect(identity).toMatchObject({
        agentId: "main",
        sessionKey: "agent:main:main",
        fullPermission: false,
        specialistProposal: {
          kind: "create-specialist",
          name: "分析担当",
          role: "Count responses",
          model: "openai/gpt-4.1",
          configHash: "hash",
        },
      });
      expect(identity?.approvalSignals).toContain(controller.signal);
      return { reply: "Applied." };
    });
    const result = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:main", fullPermission: true },
      async () =>
        await tools()[0]!.execute(
          "call",
          { action: "create", name: "分析担当", role: "Count responses" },
          controller.signal,
        ),
    );
    expect(result.details).toMatchObject({ reply: "Applied." });
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("does not accept permission/path/model/admin arguments or actions, even bypassing schema validation", async () => {
    const tool = tools()[0]!;
    for (const args of [
      { action: "config", path: "tools" },
      { action: "create", name: "x", role: "y", model: "other" },
      { action: "create", name: "x", role: "y", workspace: "/tmp" },
    ]) {
      expect(Value.Check(tool.parameters, args)).toBe(false);
      await expect(tool.execute("call", args)).rejects.toThrow();
    }
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("lists and reuses the same name without silently changing its role", async () => {
    const entry = specialistFixture("分析担当", "Original role");
    mocks.config.agents!.list!.push(entry);
    expect((await tools()[0]!.execute("list", { action: "list" })).details).toMatchObject({
      specialists: [{ name: "分析担当", role: "Original role" }],
    });
    expect(
      (
        await tools()[0]!.execute("reuse", {
          action: "create",
          name: "分析担当",
          role: "Different role",
        })
      ).details,
    ).toMatchObject({ status: "existing", role: "Original role" });
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("rechecks management enablement at execution", async () => {
    const tool = tools()[0]!;
    mocks.config = {};
    await expect(tool.execute("call", { action: "list" })).rejects.toThrow("unavailable");
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
