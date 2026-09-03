import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateSandboxExplainResult } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";

const readRegistry = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../../agents/sandbox/explain-runtime.js", () => ({
  readSandboxExplainRegistry: readRegistry,
}));

afterEach(() => readRegistry.mockClear());

async function call(cfg: OpenClawConfig, params: unknown = {}, scopes = ["operator.read"]) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "sandbox-explain", method: "sandbox.explain", params },
    respond,
    client: {
      connId: "sandbox-reader",
      connect: {
        role: "operator",
        scopes,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    } as Parameters<typeof handleGatewayRequest>[0]["client"],
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => cfg,
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
  });
  return respond;
}

describe("sandbox.explain RPC", () => {
  it("dispatches for read-only callers and reports configured mounts without creating session state", async () => {
    await withOpenClawTestState({ label: "sandbox-explain-rpc" }, async (state) => {
      const store = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            sandbox: {
              backend: "Docker",
              mode: "all",
              scope: "agent",
              workspaceAccess: "rw",
              docker: { network: "none", binds: ["/reference:/mnt/shared/reference:ro"] },
            },
          },
          list: [{ id: "main" }],
        },
        session: { store },
        tools: { elevated: { enabled: false } },
      };
      const respond = await call(cfg);
      const [ok, payload] = respond.mock.calls[0] ?? [];
      expect(ok).toBe(true);
      expect(validateSandboxExplainResult(payload)).toBe(true);
      expect(payload).toMatchObject({
        agentId: "main",
        registry: null,
        sandbox: {
          backend: "Docker",
          network: "none",
          sessionIsSandboxed: true,
          effectiveHostWorkspaceRoot: state.workspaceDir,
          workspaceMounts: expect.arrayContaining([
            {
              hostRoot: "/reference",
              containerRoot: "/mnt/shared/reference",
              writable: false,
              source: "bind",
            },
          ]),
        },
        elevated: { enabled: false, allowedByConfig: false },
      });
      await expect(fs.stat(store)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each([{ unexpected: true }, { agentId: "" }, { agentId: "  " }, { agentId: "missing" }])(
    "rejects invalid parameters %j before inspecting containers",
    async (params) => {
      const respond = await call({ agents: { list: [{ id: "main" }] } }, params);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(readRegistry).not.toHaveBeenCalled();
    },
  );

  it("requires operator.read before dispatch", async () => {
    const respond = await call({}, {}, []);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        message: "missing scope: operator.read",
      }),
    );
    expect(readRegistry).not.toHaveBeenCalled();
  });

  it("reports runtime inspection failures as unavailable", async () => {
    await withOpenClawTestState({ label: "sandbox-explain-unavailable" }, async (state) => {
      readRegistry.mockRejectedValueOnce(new Error("Docker unavailable"));
      const respond = await call({
        agents: { defaults: { workspace: state.workspaceDir, sandbox: { mode: "all" } } },
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: "Docker unavailable",
        }),
      );
    });
  });
});
