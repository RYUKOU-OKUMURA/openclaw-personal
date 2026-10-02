import { describe, expect, it } from "vitest";
import type { SandboxExplainResult } from "../../../../packages/gateway-protocol/src/index.js";
import { buildAccessMapViewModel } from "./access-map-model.ts";

function makeExplain(): SandboxExplainResult {
  return {
    docsUrl: "https://docs.openclaw.ai/sandbox",
    agentId: "main",
    sessionKey: "agent:main:main",
    mainSessionKey: "agent:main:main",
    sandbox: {
      mode: "all",
      scope: "agent",
      backend: "docker",
      workspaceAccess: "rw",
      workspaceRoot: "/workspace",
      effectiveHostWorkspaceRoot: "/tmp/openclaw/workspace",
      runtimeWorkdir: "/workspace",
      workspaceMounts: [
        {
          hostRoot: "/tmp/openclaw/workspace",
          containerRoot: "/workspace",
          writable: true,
          source: "workspace",
        },
        {
          hostRoot: "/Users/operator/reference",
          containerRoot: "/mnt/shared/reference",
          writable: false,
          source: "bind",
        },
        {
          hostRoot: "/Users/operator/drafts",
          containerRoot: "/mnt/shared/drafts",
          writable: true,
          source: "bind",
        },
        {
          hostRoot: "/tmp/openclaw/skills",
          containerRoot: "/workspace/skills",
          writable: false,
          source: "protectedSkill",
        },
      ],
      workspaceSource: "sandbox",
      sessionIsSandboxed: true,
      network: "none",
      tools: {
        allow: ["group:fs"],
        deny: ["group:runtime"],
        sources: {
          allow: { source: "agent", key: "tools.sandbox.tools.allow" },
          deny: { source: "global", key: "tools.sandbox.tools.deny" },
        },
      },
    },
    elevated: {
      enabled: true,
      channel: "webchat",
      allowedByConfig: true,
      alwaysAllowedByConfig: false,
      allowFrom: { global: ["operator"], agent: ["reviewer"] },
      failures: [],
    },
    fixIt: ["tools.sandbox.tools.allow"],
    inbox: {
      hostPath: "/tmp/openclaw/workspace/inbox",
      containerPath: "/workspace/inbox",
      entries: [
        { name: "brief.txt", kind: "file" },
        { name: "assets", kind: "directory" },
        { name: "link", kind: "symlink" },
      ],
      counts: { files: 2, folders: 3, other: 1 },
      truncated: true,
    },
    registry: {
      containerName: "openclaw-sandbox-main",
      image: "openclaw:test",
      configHash: "hash-1",
      createdAtMs: 1,
      lastUsedAtMs: 2,
      running: true,
      stale: true,
    },
  };
}

describe("buildAccessMapViewModel", () => {
  it("annotates configured mounts and keeps inbox counts scoped to immediate children", () => {
    const model = buildAccessMapViewModel(makeExplain());

    expect(model.sandbox.workspaceMounts.map((mount) => mount.badge)).toEqual([
      "read-write",
      "read-only",
      "read-write",
      "protected",
    ]);
    expect(model.inbox).toMatchObject({
      counts: { files: 2, folders: 3, other: 1 },
      truncated: true,
    });
    expect(model.inbox?.entries.map((entry) => entry.badge)).toEqual(["inbox", "inbox", "inbox"]);
    expect(model.chips.sharedFolders).toBe(2);
    expect(model).not.toHaveProperty("reachableFileCount");
  });

  it("preserves configured network absence instead of presenting it as none", () => {
    const withoutNetwork = makeExplain();
    delete withoutNetwork.sandbox.network;
    expect(buildAccessMapViewModel(withoutNetwork).chips.network).toBeNull();

    const bridge = makeExplain();
    bridge.sandbox.network = "bridge";
    expect(buildAccessMapViewModel(bridge).chips.network).toBe("bridge");
  });

  it("passes tool and elevated policy state through the model", () => {
    const report = makeExplain();
    const model = buildAccessMapViewModel(report);

    expect(model.sandbox.tools.allow).toEqual(["group:fs"]);
    expect(model.sandbox.tools.deny).toEqual(["group:runtime"]);
    expect(model.chips.externalTools).toEqual({
      allow: ["group:fs"],
      deny: ["group:runtime"],
    });
    expect(model.elevated).toEqual(report.elevated);
  });

  it("propagates stale state and distinguishes non-Docker backends", () => {
    const stale = makeExplain();
    expect(buildAccessMapViewModel(stale).stale).toBe(true);

    const noRegistry = makeExplain();
    noRegistry.registry = null;
    expect(buildAccessMapViewModel(noRegistry).stale).toBe(false);

    const podman = makeExplain();
    podman.sandbox.backend = "podman";
    expect(buildAccessMapViewModel(podman).sandbox.backendSupported).toBe(false);
  });
});
