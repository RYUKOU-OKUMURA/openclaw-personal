import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { resolveSandboxDockerUser } from "./docker-user.js";
import { computeExpectedSandboxConfigHash } from "./docker.js";
import { resolveSandboxExplainContext } from "./explain-report.js";
import { readSandboxExplainRegistry } from "./explain-runtime.js";
import type { SandboxContainerInfo } from "./manage.js";
import type { SandboxRegistryEntry } from "./registry.js";
import { resolveDockerEnvPolicyEpoch } from "./sanitize-env-vars.js";
import { buildSandboxContainerName, slugifySessionKey } from "./shared.js";
import {
  formatReadOnlyWorkspaceSkillMountHashState,
  resolveReadOnlyWorkspaceSkillMounts,
  SANDBOX_MOUNT_FORMAT_VERSION,
} from "./workspace-mounts.js";

const sandboxMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  describeSandboxContainer: vi.fn(),
}));

vi.mock("./registry.js", async () => {
  const actual = await vi.importActual<typeof import("./registry.js")>("./registry.js");
  return {
    ...actual,
    readRegistryEntry: sandboxMocks.readRegistryEntry,
  };
});

vi.mock("./manage.js", () => ({
  describeSandboxContainer: sandboxMocks.describeSandboxContainer,
}));

type ExplainSnapshot = ReturnType<typeof resolveSandboxExplainContext>;

function createConfig(
  state: OpenClawTestState,
  overrides: {
    backend?: string;
    binds?: string[];
    mode?: "off" | "all";
  } = {},
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
            containerPrefix: "openclaw-explain-sbx-",
            env: { OPENAI_API_KEY: "synthetic-secret" },
            binds: overrides.binds ?? ["/host/cache:/cache:ro"],
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
  return {
    cfg,
    snapshot: resolveSandboxExplainContext({ cfg, agentId: "main" }),
  };
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

async function resolveExpectedHash(snapshot: ExplainSnapshot): Promise<{
  docker: ExplainSnapshot["sandboxConfig"]["docker"];
  hash: string;
}> {
  const docker = await resolveSandboxDockerUser({
    backend: snapshot.sandboxConfig.backend,
    docker: snapshot.sandboxConfig.docker,
    workspaceDir: snapshot.workspaceLayout.workspaceDir,
  });
  const mounts = resolveReadOnlyWorkspaceSkillMounts({
    workspaceDir: snapshot.workspaceLayout.workspaceDir,
    agentWorkspaceDir: snapshot.workspaceLayout.agentWorkspaceDir,
    skillsWorkspaceDir: snapshot.workspaceLayout.skillsWorkspaceDir,
    workdir: docker.workdir,
    workspaceAccess: snapshot.sandboxConfig.workspaceAccess,
  });
  const hash = computeSandboxConfigHash({
    docker,
    dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(docker.env),
    workspaceAccess: snapshot.sandboxConfig.workspaceAccess,
    workspaceDir: snapshot.workspaceLayout.workspaceDir,
    agentWorkspaceDir: snapshot.workspaceLayout.agentWorkspaceDir,
    mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
    readOnlyWorkspaceSkillMounts: formatReadOnlyWorkspaceSkillMountHashState(mounts),
  });
  expect(
    computeExpectedSandboxConfigHash({
      cfg: { ...snapshot.sandboxConfig, docker },
      workspaceDir: snapshot.workspaceLayout.workspaceDir,
      agentWorkspaceDir: snapshot.workspaceLayout.agentWorkspaceDir,
      skillsWorkspaceDir: snapshot.workspaceLayout.skillsWorkspaceDir,
      readOnlyWorkspaceSkillMounts: mounts,
    }),
  ).toBe(hash);
  return { docker, hash };
}

beforeEach(() => {
  sandboxMocks.readRegistryEntry.mockReset();
  sandboxMocks.describeSandboxContainer.mockReset();
  sandboxMocks.describeSandboxContainer.mockImplementation(
    async (entry: SandboxRegistryEntry): Promise<SandboxContainerInfo> => ({
      ...entry,
      running: true,
      imageMatch: true,
    }),
  );
});

describe("readSandboxExplainRegistry", () => {
  it("keeps an unchanged default-workspace hash fresh with uid/gid, epoch, and protected mounts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await fs.mkdir(path.join(state.workspaceDir, "skills"), { recursive: true });
      const { cfg, snapshot } = createSnapshot(state, { backend: "Docker" });
      const { docker, hash } = await resolveExpectedHash(snapshot);
      const mounts = resolveReadOnlyWorkspaceSkillMounts({
        workspaceDir: snapshot.workspaceLayout.workspaceDir,
        agentWorkspaceDir: snapshot.workspaceLayout.agentWorkspaceDir,
        skillsWorkspaceDir: snapshot.workspaceLayout.skillsWorkspaceDir,
        workdir: docker.workdir,
        workspaceAccess: snapshot.sandboxConfig.workspaceAccess,
      });

      expect(docker.user).toMatch(/^\d+:\d+$/);
      expect(resolveDockerEnvPolicyEpoch(docker.env)).toBe("explicit-config-env-v1");
      expect(mounts).toEqual(
        expect.arrayContaining([
          {
            hostPath: path.join(state.workspaceDir, "skills"),
            containerPath: "/workspace/skills",
          },
        ]),
      );

      const entry = createRegistryEntry(snapshot, { configHash: hash });
      sandboxMocks.readRegistryEntry.mockResolvedValueOnce(entry);

      await expect(readSandboxExplainRegistry(snapshot, cfg)).resolves.toMatchObject({
        containerName: entry.containerName,
        configHash: hash,
        running: true,
        stale: false,
      });
      expect(sandboxMocks.readRegistryEntry).toHaveBeenCalledWith(entry.containerName);
      expect(sandboxMocks.describeSandboxContainer).toHaveBeenCalledTimes(1);
    });
  });

  it("marks bind and missing-hash changes stale while rejecting name, backend, and scope mismatches", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const first = createSnapshot(state, { binds: ["/host/cache-a:/cache:ro"] });
      const { hash } = await resolveExpectedHash(first.snapshot);
      const entry = createRegistryEntry(first.snapshot, { configHash: hash });

      const changed = createSnapshot(state, { binds: ["/host/cache-b:/cache:ro"] });
      sandboxMocks.readRegistryEntry.mockResolvedValueOnce(entry);
      await expect(
        readSandboxExplainRegistry(changed.snapshot, changed.cfg),
      ).resolves.toMatchObject({
        configHash: hash,
        stale: true,
      });

      const missingHash = createRegistryEntry(first.snapshot);
      sandboxMocks.readRegistryEntry.mockResolvedValueOnce(missingHash);
      await expect(readSandboxExplainRegistry(first.snapshot, first.cfg)).resolves.toMatchObject({
        containerName: entry.containerName,
        configHash: undefined,
        stale: true,
      });

      const otherName = { ...entry, containerName: `${entry.containerName}-other` };
      sandboxMocks.readRegistryEntry.mockImplementationOnce(async (name: string) =>
        name === otherName.containerName ? otherName : null,
      );
      await expect(readSandboxExplainRegistry(first.snapshot, first.cfg)).resolves.toBeNull();
      for (const mismatch of [
        { backendId: "podman" },
        { sessionKey: "agent:other:workspace:other" },
      ]) {
        sandboxMocks.readRegistryEntry.mockResolvedValueOnce({ ...entry, ...mismatch });
        await expect(readSandboxExplainRegistry(first.snapshot, first.cfg)).resolves.toBeNull();
      }
      expect(sandboxMocks.describeSandboxContainer).toHaveBeenCalledTimes(2);
    });
  });

  it("does not probe the registry or backend when the session is off or the backend is unsupported", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const off = createSnapshot(state, { mode: "off" });
      const unsupported = createSnapshot(state, { backend: "ssh" });

      await expect(readSandboxExplainRegistry(off.snapshot, off.cfg)).resolves.toBeNull();
      await expect(
        readSandboxExplainRegistry(unsupported.snapshot, unsupported.cfg),
      ).resolves.toBeNull();
      expect(sandboxMocks.readRegistryEntry).not.toHaveBeenCalled();
      expect(sandboxMocks.describeSandboxContainer).not.toHaveBeenCalled();
    });
  });
});
