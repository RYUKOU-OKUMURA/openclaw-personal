import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateSandboxExplainResult,
  validateSandboxEntriesAddResult,
  validateSandboxRecreateResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";

const readRegistry = vi.hoisted(() => vi.fn(async () => null));
const recreate = vi.hoisted(() => vi.fn());
vi.mock("../../agents/sandbox/explain-runtime.js", () => ({
  readSandboxExplainRegistry: readRegistry,
}));
vi.mock("../../agents/sandbox/recreate.js", () => ({
  recreateSandboxContainer: recreate,
}));

afterEach(() => {
  readRegistry.mockClear();
  recreate.mockReset();
});

async function call(
  cfg: OpenClawConfig,
  params: unknown = {},
  scopes = ["operator.read"],
  method = "sandbox.explain",
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "sandbox-request", method, params },
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

describe("sandbox.entries.add RPC", () => {
  it("admits an admin upload and exposes the actual entry to a read-only caller without session state", async () => {
    await withOpenClawTestState({ label: "sandbox-add-rpc" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            sandbox: { mode: "all", scope: "agent", workspaceAccess: "rw" },
          },
        },
      };
      const before = JSON.stringify(cfg);
      const add = await call(
        cfg,
        {
          mode: "copy",
          source: {
            kind: "upload",
            name: "../../note.md",
            contentBase64: Buffer.from("hello").toString("base64"),
          },
        },
        ["operator.admin"],
        "sandbox.entries.add",
      );
      const [ok, result] = add.mock.calls[0] ?? [];
      expect(ok).toBe(true);
      expect(validateSandboxEntriesAddResult(result)).toBe(true);
      expect(result).toMatchObject({
        entry: {
          name: "note.md",
          kind: "file",
          mode: "copy",
          containerPath: "/workspace/inbox/note.md",
        },
        recreateRequired: false,
      });
      expect(await fs.readFile(path.join(state.workspaceDir, "inbox/note.md"), "utf8")).toBe(
        "hello",
      );
      const read = await call(cfg);
      expect(read.mock.calls[0]?.[1]).toMatchObject({
        inbox: {
          entries: [{ name: "note.md", kind: "file" }],
          counts: { files: 1, folders: 0, other: 0 },
          truncated: false,
        },
      });
      expect(JSON.stringify(cfg)).toBe(before);
      await expect(
        fs.stat(state.statePath("agents", "main", "agent", "openclaw-agent.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each([{ scopes: ["operator.read"] }, { scopes: ["operator.write"] }, { scopes: [] }])(
    "rejects non-admin scopes $scopes before writing",
    async ({ scopes }) => {
      await withOpenClawTestState({ label: "sandbox-add-authz" }, async (state) => {
        const add = await call(
          { agents: { defaults: { workspace: state.workspaceDir } } },
          {
            mode: "copy",
            source: { kind: "create", name: "empty", entryKind: "directory" },
          },
          scopes,
          "sandbox.entries.add",
        );
        expect(add).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN", message: "missing scope: operator.admin" }),
        );
        await expect(fs.stat(path.join(state.workspaceDir, "inbox"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
  );

  it.each([
    { mode: "ro", source: { kind: "upload", name: "empty", contentBase64: "" } },
    { mode: "copy", source: { kind: "create", name: "empty", entryKind: "socket" } },
    { mode: "copy", source: { kind: "upload", name: "empty", contentBase64: "not base64" } },
    {
      agentId: "missing",
      mode: "copy",
      source: { kind: "create", name: "empty", entryKind: "file" },
    },
  ])("rejects invalid inputs without creating inbox: %j", async (params) => {
    await withOpenClawTestState({ label: "sandbox-add-invalid" }, async (state) => {
      const add = await call(
        {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              sandbox: { mode: "all", workspaceAccess: "rw" },
            },
            list: [{ id: "main" }],
          },
        },
        params,
        ["operator.admin"],
        "sandbox.entries.add",
      );
      expect(add).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      await expect(fs.stat(path.join(state.workspaceDir, "inbox"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});

describe("sandbox.recreate RPC", () => {
  it.each([
    { removed: [], failed: [] },
    { removed: ["sandbox-main"], failed: [] },
    { removed: [], failed: [{ containerName: "sandbox-main", error: "Docker unavailable" }] },
  ])("returns the lifecycle outcome to admins: %j", async (result) => {
    await withOpenClawTestState({ label: "sandbox-recreate-rpc" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            sandbox: { mode: "all", scope: "agent", workspaceAccess: "rw" },
          },
        },
      };
      recreate.mockResolvedValueOnce(result);
      const respond = await call(cfg, {}, ["operator.admin"], "sandbox.recreate");
      expect(respond).toHaveBeenCalledWith(true, result, undefined);
      expect(validateSandboxRecreateResult(respond.mock.calls[0]?.[1])).toBe(true);
      expect(recreate).toHaveBeenCalledWith(
        expect.objectContaining({
          report: expect.objectContaining({ agentId: "main" }),
          workspaceLayout: expect.objectContaining({ workspaceDir: state.workspaceDir }),
        }),
        cfg,
      );
    });
  });

  it.each([{ scopes: [] }, { scopes: ["operator.read"] }, { scopes: ["operator.write"] }])(
    "rejects non-admin scopes $scopes before removal",
    async ({ scopes }) => {
      const respond = await call({}, {}, scopes, "sandbox.recreate");
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN", message: "missing scope: operator.admin" }),
      );
      expect(recreate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { containerName: "other" },
    { sessionKey: "agent:other:main" },
    { agentId: "  " },
    { agentId: "missing" },
  ])("rejects invalid or widened targets %j", async (params) => {
    const respond = await call(
      { agents: { list: [{ id: "main" }] } },
      params,
      ["operator.admin"],
      "sandbox.recreate",
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(recreate).not.toHaveBeenCalled();
  });

  it.each([{ mode: "off" as const }, { mode: "all" as const, backend: "podman" }])(
    "rejects a session without a supported sandbox %j",
    async (sandbox) => {
      await withOpenClawTestState({ label: "sandbox-recreate-disabled" }, async (state) => {
        const respond = await call(
          { agents: { defaults: { workspace: state.workspaceDir, sandbox } } },
          {},
          ["operator.admin"],
          "sandbox.recreate",
        );
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(recreate).not.toHaveBeenCalled();
      });
    },
  );

  it("reports registry read failures as unavailable instead of an empty success", async () => {
    await withOpenClawTestState({ label: "sandbox-recreate-unavailable" }, async (state) => {
      recreate.mockRejectedValueOnce(new Error("registry unreadable"));
      const respond = await call(
        {
          agents: {
            defaults: { workspace: state.workspaceDir, sandbox: { mode: "all" } },
          },
        },
        {},
        ["operator.admin"],
        "sandbox.recreate",
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", message: "registry unreadable" }),
      );
    });
  });
});
