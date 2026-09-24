import { describe, expect, it, vi } from "vitest";
import type {
  FsListDirResult,
  SandboxExplainResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import {
  addSandboxEntry,
  listHostDir,
  loadSandboxExplain,
  recreateSandboxContainer,
  removeSharedBind,
} from "./access-map-gateway.ts";

function clientWith(request: ReturnType<typeof vi.fn>): GatewayBrowserClient {
  return { request } as unknown as GatewayBrowserClient;
}

function report(scope: SandboxExplainResult["sandbox"]["scope"] = "agent"): SandboxExplainResult {
  return {
    docsUrl: "https://docs.openclaw.ai/sandbox",
    agentId: "main",
    sessionKey: "agent:main:main",
    mainSessionKey: "agent:main:main",
    sandbox: {
      mode: "all",
      scope,
      backend: "docker",
      workspaceAccess: "rw",
      workspaceRoot: "/workspace",
      effectiveHostWorkspaceRoot: "/tmp/workspace",
      runtimeWorkdir: "/workspace",
      workspaceMounts: [],
      workspaceSource: "sandbox",
      sessionIsSandboxed: true,
      tools: {
        allow: [],
        deny: [],
        sources: {
          allow: { source: "default", key: "default" },
          deny: { source: "default", key: "default" },
        },
      },
    },
    elevated: {
      enabled: false,
      allowedByConfig: false,
      alwaysAllowedByConfig: false,
      allowFrom: {},
      failures: [],
    },
    fixIt: [],
    registry: null,
  };
}

function shareMount(
  hostRoot: string,
  containerRoot: string,
  writable = false,
): SandboxExplainResult["sandbox"]["workspaceMounts"][number] {
  return { hostRoot, containerRoot, writable, source: "bind" };
}

function mutationHarness(sourceConfig: Record<string, unknown>, hash = "fresh-hash") {
  const request = vi.fn(async (method: string, _params: unknown) => {
    if (method === "config.get") {
      return { sourceConfig, hash, valid: true };
    }
    if (method === "config.patch") {
      return { ok: true, hash: "next-hash" };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const client = clientWith(request);
  const runExternalMutation: RuntimeConfigCapability["runExternalMutation"] = async (
    task,
    options,
  ) => {
    if (options?.canDispatch && !options.canDispatch()) {
      return {
        ok: false,
        reason: "unavailable",
        error: options.dispatchError ?? "dispatch unavailable",
      };
    }
    try {
      const value = await task(client);
      return { ok: true, value, refresh: { ok: true } };
    } catch (error) {
      return {
        ok: false,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const runtimeConfig = {
    canPatch: true,
    runExternalMutation,
  } as unknown as RuntimeConfigCapability;
  return { request, client, runtimeConfig };
}

describe("access-map Gateway wrappers", () => {
  it("uses the existing RPCs and opts the local picker into files", async () => {
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "fs.listDir") {
        return { path: "/tmp", home: "/Users/operator", entries: [] } as FsListDirResult;
      }
      return {};
    });
    const client = clientWith(request);

    await loadSandboxExplain(client);
    await loadSandboxExplain(client, " main ");
    await addSandboxEntry(client, {
      mode: "copy",
      source: { kind: "create", name: "draft.txt", entryKind: "file" },
    });
    await recreateSandboxContainer(client, "main");
    await listHostDir(client, { path: "/tmp" });
    await listHostDir(client, { nodeId: "macbook" });

    expect(request.mock.calls.slice(0, 4)).toEqual([
      ["sandbox.explain", {}],
      ["sandbox.explain", { agentId: "main" }],
      [
        "sandbox.entries.add",
        { mode: "copy", source: { kind: "create", name: "draft.txt", entryKind: "file" } },
      ],
      ["sandbox.recreate", { agentId: "main" }],
    ]);
    expect(request.mock.calls[4]).toEqual(["fs.listDir", { path: "/tmp", includeFiles: true }]);
    expect(request.mock.calls[5]).toEqual(["fs.listDir", { nodeId: "macbook" }]);
  });

  it.each([
    {
      label: "authored entries",
      scope: "agent" as const,
      sourceConfig: {
        agents: {
          entries: {
            main: {
              sandbox: {
                docker: {
                  binds: [
                    "/tmp/parent/../reference/:/mnt/shared/./reference/:ro",
                    "/tmp/keep:/mnt/shared/keep:rw",
                  ],
                },
              },
            },
          },
        },
      },
      mount: shareMount("/tmp/reference", "/mnt/shared/reference"),
      replacePath: "agents.entries.main.sandbox.docker.binds",
      expectedBinds: ["/tmp/keep:/mnt/shared/keep:rw"],
    },
    {
      label: "authored list",
      scope: "agent" as const,
      sourceConfig: {
        agents: {
          list: [
            {
              id: "main",
              sandbox: {
                docker: { binds: ["/tmp/reference:/mnt/shared/reference:rw"] },
              },
            },
          ],
        },
      },
      mount: shareMount("/tmp/reference", "/mnt/shared/reference", true),
      replacePath: "agents.list[].sandbox.docker.binds",
      expectedBinds: [],
    },
    {
      label: "shared defaults",
      scope: "shared" as const,
      sourceConfig: {
        agents: {
          defaults: {
            sandbox: {
              docker: {
                binds: ["/tmp/reference:/mnt/shared/reference:ro", "/tmp/keep:/mnt/shared/keep:ro"],
              },
            },
          },
        },
      },
      mount: shareMount("/tmp/reference", "/mnt/shared/reference"),
      replacePath: "agents.defaults.sandbox.docker.binds",
      expectedBinds: ["/tmp/keep:/mnt/shared/keep:ro"],
    },
  ])("removes one bind through the fresh config owner ($label)", async (testCase) => {
    const harness = mutationHarness(testCase.sourceConfig);
    const result = await removeSharedBind(
      harness.client,
      report(testCase.scope),
      testCase.mount,
      harness.runtimeConfig,
    );

    expect(result).toEqual({ removed: true, refreshWarning: null });
    const patchCall = harness.request.mock.calls.find(([method]) => method === "config.patch");
    if (!patchCall) {
      throw new Error("Expected a config.patch request");
    }
    expect(patchCall[1]).toMatchObject({
      baseHash: "fresh-hash",
      replacePaths: [testCase.replacePath],
    });
    expect(JSON.parse((patchCall[1] as { raw: string }).raw)).toMatchObject({
      agents: expect.anything(),
    });
    const patch = JSON.parse((patchCall[1] as { raw: string }).raw) as {
      agents: {
        defaults?: { sandbox?: { docker?: { binds?: string[] } } };
        entries?: Record<string, unknown>;
        list?: Array<{ sandbox?: { docker?: { binds?: string[] } } }>;
      };
    };
    const binds =
      patch.agents.defaults?.sandbox?.docker?.binds ??
      (patch.agents.entries?.main as { sandbox?: { docker?: { binds?: string[] } } } | undefined)
        ?.sandbox?.docker?.binds ??
      patch.agents.list?.[0]?.sandbox?.docker?.binds;
    expect(binds).toEqual(testCase.expectedBinds);
  });

  it("fails closed when one owner has duplicate normalized bind matches", async () => {
    const harness = mutationHarness({
      agents: {
        entries: {
          main: {
            sandbox: {
              docker: {
                binds: [
                  "/tmp/reference:/mnt/shared/reference:ro",
                  "/tmp/parent/../reference/:/mnt/shared/./reference/:ro",
                ],
              },
            },
          },
        },
      },
    });

    await expect(
      removeSharedBind(
        harness.client,
        report(),
        shareMount("/tmp/reference", "/mnt/shared/reference"),
        harness.runtimeConfig,
      ),
    ).rejects.toThrow("This bind has more than one configured match");
    expect(harness.request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
  });

  it("fails closed for a defaults bind inherited by an agent scope", async () => {
    const bind = "/tmp/reference:/mnt/shared/reference:ro";
    const harness = mutationHarness({
      agents: {
        defaults: { sandbox: { docker: { binds: [bind] } } },
        entries: { main: { sandbox: { mode: "all" } } },
      },
    });

    await expect(
      removeSharedBind(
        harness.client,
        report("agent"),
        shareMount("/tmp/reference", "/mnt/shared/reference"),
        harness.runtimeConfig,
      ),
    ).rejects.toThrow(
      "This share is inherited from global sandbox settings. Change it there to update all agents.",
    );
    expect(harness.request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
  });

  it("fails closed when config.get does not include authored sourceConfig", async () => {
    const request = vi.fn(async (method: string) =>
      method === "config.get" ? { resolved: { agents: {} }, hash: "fresh-hash" } : {},
    );
    const client = clientWith(request);
    const runtimeConfig = {
      canPatch: true,
      runExternalMutation: async (
        task: Parameters<RuntimeConfigCapability["runExternalMutation"]>[0],
      ) => {
        try {
          const value = await task(client);
          return { ok: true as const, value, refresh: { ok: true as const } };
        } catch (error) {
          return {
            ok: false as const,
            reason: "error" as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    } as unknown as RuntimeConfigCapability;

    await expect(
      removeSharedBind(
        client,
        report(),
        shareMount("/tmp/reference", "/mnt/shared/reference"),
        runtimeConfig,
      ),
    ).rejects.toThrow("Authoritative source configuration is unavailable");
    expect(request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
  });

  it("checks the dispatch guard again after the fresh read", async () => {
    const harness = mutationHarness({
      agents: {
        entries: {
          main: {
            sandbox: { docker: { binds: ["/tmp/reference:/mnt/shared/reference:ro"] } },
          },
        },
      },
    });
    let allowed = true;
    await expect(
      removeSharedBind(
        harness.client,
        report(),
        shareMount("/tmp/reference", "/mnt/shared/reference"),
        harness.runtimeConfig,
        () => {
          const current = allowed;
          allowed = false;
          return current;
        },
      ),
    ).rejects.toThrow("Access changed before the shared bind update was sent");
    expect(harness.request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
  });
});
