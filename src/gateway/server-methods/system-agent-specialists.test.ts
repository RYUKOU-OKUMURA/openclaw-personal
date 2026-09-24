import "./system-agent.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import type { SystemAgentOperation } from "../../system-agent/operation-types.js";
import {
  callChat,
  makeContext,
  transcriptStoreMocks,
  useSystemAgentGatewayTestFixture,
} from "./system-agent.test-support.js";

const approval = vi.hoisted(() => vi.fn());
vi.mock("./system-agent-approval.js", () => ({
  prepareDelegatedSystemAgentApproval: async () => approval,
}));
useSystemAgentGatewayTestFixture();
const operation: Extract<SystemAgentOperation, { kind: "create-specialist" }> = {
  kind: "create-specialist",
  agentId: "specialist-123",
  name: "分析担当",
  role: "Count responses",
  requesterAgentId: "main",
  model: "openai/gpt-4.1",
  configHash: "hash",
  peerAgentIds: ["main", "specialist-123"],
};
const params = {
  sessionId: "specialists-test",
  message: "Create",
  delegation: { agentId: "main", sessionKey: "agent:main:main" },
};
describe("specialist-only gateway capability", () => {
  it("refuses RPC-only and forged proposal data before creating a management session", async () => {
    const context = makeContext(new Map());
    for (const input of [params, { ...params, specialistProposal: operation }]) {
      const result = await callChat(context, input);
      expect(result.ok).toBe(false);
    }
    expect(context.systemAgentSessions.size).toBe(0);
  });
  it("rejects mismatched requester, Full Access bypass, and general management session reuse", async () => {
    for (const override of [{ agentId: "gbp" }, { fullPermission: true }]) {
      const result = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          fullPermission: false,
          specialistProposal: operation,
          ...override,
        },
        async () => await callChat(makeContext(new Map()), params),
      );
      expect(result.ok).toBe(false);
    }
    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        fullPermission: false,
        specialistProposal: operation,
      },
      async () => await callChat(makeContext(new Map()), { ...params, sessionId: "general" }),
    );
    expect(result.ok).toBe(false);
  });
  it("passes only the exact typed operation through human approval without management inference or prior logbook context", async () => {
    const handle = vi.spyOn(SystemAgentChatEngine.prototype, "handle");
    const overview = vi.spyOn(SystemAgentChatEngine.prototype, "loadOverview");
    const propose = vi.spyOn(SystemAgentChatEngine.prototype, "propose");
    approval.mockResolvedValue({
      kind: "completed",
      reply: { text: "Human denied. No change.", action: "none" },
    });
    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        fullPermission: false,
        specialistProposal: operation,
      },
      async () => await callChat(makeContext(new Map()), params),
    );
    expect(result.ok).toBe(true);
    expect(propose).toHaveBeenCalledWith(operation);
    expect(approval).toHaveBeenCalledWith({ operation, hash: expect.any(String) });
    expect(handle).not.toHaveBeenCalled();
    expect(overview).not.toHaveBeenCalled();
    expect(transcriptStoreMocks.readTranscriptTail).not.toHaveBeenCalled();
  });
});
