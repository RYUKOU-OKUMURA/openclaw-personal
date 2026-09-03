import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { registerSandboxBackend, type SandboxBackendManager } from "./backend.js";
import { sandboxContainerLifecycleQueue } from "./docker.js";
import { resolveSandboxExplainContext } from "./explain-report.js";
import { recreateSandboxContainer } from "./recreate.js";
import {
  readBrowserRegistry,
  readRegistryEntry,
  updateBrowserRegistry,
  updateRegistry,
  type SandboxRegistryEntry,
} from "./registry.js";
import { buildSandboxContainerName, slugifySessionKey } from "./shared.js";

const registryMock = vi.hoisted(() => ({
  delegate: undefined as ((containerName: string) => Promise<void>) | undefined,
  removeRegistryEntry: vi.fn(),
}));

vi.mock("./registry.js", async () => {
  const actual = await vi.importActual<typeof import("./registry.js")>("./registry.js");
  registryMock.delegate = actual.removeRegistryEntry;
  registryMock.removeRegistryEntry.mockImplementation(async (containerName: string) => {
    if (!registryMock.delegate) {
      throw new Error("registry test delegate is unavailable");
    }
    await registryMock.delegate(containerName);
  });
  return { ...actual, removeRegistryEntry: registryMock.removeRegistryEntry };
});

type ExplainSnapshot = ReturnType<typeof resolveSandboxExplainContext>;

function createConfig(
  state: OpenClawTestState,
  overrides: { backend?: string; mode?: "off" | "all" } = {},
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        sandbox: {
          mode: overrides.mode ?? "all",
          backend: overrides.backend ?? "docker",
          scope: "agent",
          workspaceAccess: "rw",
          docker: {
            containerPrefix: "openclaw-recreate-sbx-",
            image: "alpine:3.20",
          },
        },
      },
      list: [{ id: "main" }],
    },
    session: {
      store: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
    },
  };
}

function createSnapshot(
  state: OpenClawTestState,
  overrides: Parameters<typeof createConfig>[1] = {},
): { cfg: OpenClawConfig; snapshot: ExplainSnapshot } {
  const cfg = createConfig(state, overrides);
  return { cfg, snapshot: resolveSandboxExplainContext({ cfg, agentId: "main" }) };
}

function resolveContainerName(snapshot: ExplainSnapshot): string {
  const slug =
    snapshot.workspaceLayout.scopeKey === "shared"
      ? "shared"
      : slugifySessionKey(snapshot.workspaceLayout.scopeKey);
  return buildSandboxContainerName(snapshot.sandboxConfig.docker.containerPrefix, slug);
}

function createRegistryEntry(
  snapshot: ExplainSnapshot,
  overrides: Partial<SandboxRegistryEntry> = {},
): SandboxRegistryEntry {
  return {
    containerName: resolveContainerName(snapshot),
    backendId: "docker",
    sessionKey: snapshot.workspaceLayout.scopeKey,
    createdAtMs: 1,
    lastUsedAtMs: 2,
    image: snapshot.sandboxConfig.docker.image,
    ...overrides,
  };
}

function installDockerManager(removeRuntime: SandboxBackendManager["removeRuntime"]): () => void {
  return registerSandboxBackend("docker", {
    factory: async () => {
      throw new Error("test factory must not be called");
    },
    manager: {
      describeRuntime: async () => ({ running: true, configLabelMatch: true }),
      removeRuntime,
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  registryMock.removeRegistryEntry.mockClear();
});

describe("recreateSandboxContainer", () => {
  it("removes only the exact Docker scope and leaves other runtimes and browser state", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { cfg, snapshot } = createSnapshot(state);
      const expected = createRegistryEntry(snapshot);
      const sameAgentOtherSession = createRegistryEntry(snapshot, {
        containerName: buildSandboxContainerName(
          snapshot.sandboxConfig.docker.containerPrefix,
          slugifySessionKey("agent:main:other-session"),
        ),
        sessionKey: "agent:main:other-session",
      });
      const otherWorkspace = createRegistryEntry(snapshot, {
        containerName: buildSandboxContainerName(
          snapshot.sandboxConfig.docker.containerPrefix,
          slugifySessionKey("agent:main:other-workspace"),
        ),
        sessionKey: "agent:main:other-workspace",
      });
      const otherPrefix = createRegistryEntry(snapshot, {
        containerName: buildSandboxContainerName(
          "other-prefix-",
          slugifySessionKey(snapshot.workspaceLayout.scopeKey),
        ),
      });
      await updateRegistry(expected);
      await updateRegistry(sameAgentOtherSession);
      await updateRegistry(otherWorkspace);
      await updateRegistry(otherPrefix);
      await updateBrowserRegistry({
        containerName: expected.containerName,
        sessionKey: snapshot.workspaceLayout.scopeKey,
        createdAtMs: 1,
        lastUsedAtMs: 2,
        image: "browser",
        cdpPort: 19222,
      });

      const removeRuntime = vi.fn(async () => undefined);
      const restore = installDockerManager(removeRuntime);
      try {
        await expect(recreateSandboxContainer(snapshot, cfg)).resolves.toEqual({
          removed: [expected.containerName],
          failed: [],
        });
      } finally {
        restore();
      }

      expect(removeRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          entry: expect.objectContaining(expected),
          config: cfg,
          agentId: "main",
        }),
      );
      await expect(readRegistryEntry(expected.containerName)).resolves.toBeNull();
      await expect(readRegistryEntry(sameAgentOtherSession.containerName)).resolves.toMatchObject(
        sameAgentOtherSession,
      );
      await expect(readRegistryEntry(otherWorkspace.containerName)).resolves.toMatchObject(
        otherWorkspace,
      );
      await expect(readRegistryEntry(otherPrefix.containerName)).resolves.toMatchObject(
        otherPrefix,
      );
      await expect(readBrowserRegistry()).resolves.toEqual({
        entries: [
          expect.objectContaining({
            containerName: expected.containerName,
            cdpPort: 19222,
          }),
        ],
      });
    });
  });

  it.each([
    { label: "missing entry", kind: "missing" as const },
    { label: "different name", kind: "name" as const },
    { label: "different backend", kind: "backend" as const },
    { label: "different scope key", kind: "scope" as const },
  ])("returns a no-op for $label", async ({ kind }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { cfg, snapshot } = createSnapshot(state);
      const expected = createRegistryEntry(snapshot);
      let stored: SandboxRegistryEntry | undefined;
      if (kind !== "missing") {
        stored = createRegistryEntry(
          snapshot,
          kind === "name"
            ? { containerName: `${expected.containerName}-other` }
            : kind === "backend"
              ? { backendId: "podman" }
              : { sessionKey: "agent:main:other-scope" },
        );
        await updateRegistry(stored);
      }
      const removeRuntime = vi.fn(async () => undefined);
      const restore = installDockerManager(removeRuntime);
      try {
        await expect(recreateSandboxContainer(snapshot, cfg)).resolves.toEqual({
          removed: [],
          failed: [],
        });
      } finally {
        restore();
      }
      expect(removeRuntime).not.toHaveBeenCalled();
      if (stored) {
        await expect(readRegistryEntry(stored.containerName)).resolves.toMatchObject(stored);
      }
    });
  });

  it.each([
    { label: "sandbox off", mode: "off" as const, backend: "docker" },
    { label: "non-Docker backend", mode: "all" as const, backend: "podman" },
  ])("rejects $label before touching the registry", async ({ mode, backend }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { cfg, snapshot } = createSnapshot(state, { mode, backend });
      await expect(recreateSandboxContainer(snapshot, cfg)).rejects.toThrow(
        "This session has no Docker sandbox",
      );
    });
  });

  it("returns failed and preserves the entry when backend removal fails", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { cfg, snapshot } = createSnapshot(state);
      const entry = createRegistryEntry(snapshot);
      await updateRegistry(entry);
      const removeRuntime = vi.fn(async () => {
        throw new Error("remove failed");
      });
      const restore = installDockerManager(removeRuntime);
      try {
        await expect(recreateSandboxContainer(snapshot, cfg)).resolves.toEqual({
          removed: [],
          failed: [{ containerName: entry.containerName, error: "remove failed" }],
        });
      } finally {
        restore();
      }
      await expect(readRegistryEntry(entry.containerName)).resolves.toMatchObject(entry);
    });
  });

  it("returns failed when registry cleanup fails instead of reporting success", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { cfg, snapshot } = createSnapshot(state);
      const entry = createRegistryEntry(snapshot);
      await updateRegistry(entry);
      const removeRuntime = vi.fn(async () => undefined);
      const restore = installDockerManager(removeRuntime);
      registryMock.removeRegistryEntry.mockImplementationOnce(async () => {
        throw new Error("registry cleanup failed");
      });
      try {
        await expect(recreateSandboxContainer(snapshot, cfg)).resolves.toEqual({
          removed: [],
          failed: [{ containerName: entry.containerName, error: "registry cleanup failed" }],
        });
      } finally {
        restore();
      }
      expect(removeRuntime).toHaveBeenCalledOnce();
      await expect(readRegistryEntry(entry.containerName)).resolves.toMatchObject(entry);
    });
  });

  it("serializes recreate behind an in-flight lifecycle operation for the same name", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { cfg, snapshot } = createSnapshot(state);
      const entry = createRegistryEntry(snapshot);
      const removeRuntime = vi.fn(async () => undefined);
      const restore = installDockerManager(removeRuntime);
      const started = deferred<void>();
      const release = deferred<void>();
      const lifecyclePromise = sandboxContainerLifecycleQueue.enqueue(
        entry.containerName,
        async () => {
          started.resolve();
          await release.promise;
          await updateRegistry(entry);
        },
      );
      await started.promise;
      const recreatePromise = recreateSandboxContainer(snapshot, cfg);
      try {
        await Promise.resolve();
        expect(removeRuntime).not.toHaveBeenCalled();
        release.resolve();
        await lifecyclePromise;
        await expect(recreatePromise).resolves.toEqual({
          removed: [entry.containerName],
          failed: [],
        });
      } finally {
        release.resolve();
        await Promise.allSettled([lifecyclePromise, recreatePromise]);
        restore();
      }
      await expect(readRegistryEntry(entry.containerName)).resolves.toBeNull();
    });
  });
});
