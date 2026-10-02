import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { buildSandboxSharePatch } from "./shared-entries.js";

type ShareMode = "ro" | "rw";

function createConfig(
  state: OpenClawTestState,
  overrides: {
    mode?: "off" | "all";
    backend?: string;
    scope?: "agent" | "shared";
    workspaceAccess?: "none" | "ro" | "rw";
    binds?: string[];
    dangerouslyAllowExternalBindSources?: boolean;
  } = {},
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        sandbox: {
          mode: overrides.mode ?? "all",
          backend: overrides.backend ?? "docker",
          scope: overrides.scope ?? "agent",
          workspaceAccess: overrides.workspaceAccess ?? "rw",
          docker: {
            containerPrefix: "openclaw-shared-entries-sbx-",
            ...(overrides.binds ? { binds: overrides.binds } : {}),
            ...(overrides.dangerouslyAllowExternalBindSources !== undefined
              ? {
                  dangerouslyAllowExternalBindSources:
                    overrides.dangerouslyAllowExternalBindSources,
                }
              : {}),
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

function shareRequest(mode: ShareMode, sourcePath: string, allowExternalSource?: boolean) {
  return {
    agentId: "main",
    mode,
    source: { kind: "path" as const, path: sourcePath },
    ...(allowExternalSource === undefined ? {} : { allowExternalSource }),
  };
}

describe("sandbox shared entries", () => {
  it.each(["ro", "rw"] as const)(
    "creates a canonical %s bind without mutating the source or config",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await fs.mkdir(state.workspaceDir, { recursive: true });
        const sourcePath = path.join(state.workspaceDir, "source.txt");
        await fs.writeFile(sourcePath, "keep-me", "utf8");
        const config = createConfig(state);
        const sourceConfig = structuredClone(config);
        const beforeConfig = JSON.stringify({ config, sourceConfig });
        const beforeSource = await fs.readFile(sourcePath, "utf8");
        const realSourcePath = await fs.realpath(sourcePath);
        const bind = `${realSourcePath}:/mnt/shared/source.txt:${mode}`;

        const result = await buildSandboxSharePatch({
          config,
          sourceConfig,
          request: shareRequest(mode, sourcePath),
        });

        expect(result).toEqual({
          patch: {
            agents: {
              list: [{ id: "main", sandbox: { docker: { binds: [bind] } } }],
            },
          },
          result: {
            entry: {
              name: "source.txt",
              kind: "file",
              hostPath: realSourcePath,
              containerPath: "/mnt/shared/source.txt",
              mode,
            },
            recreateRequired: true,
          },
        });
        expect(await fs.readFile(sourcePath, "utf8")).toBe(beforeSource);
        expect(JSON.stringify({ config, sourceConfig })).toBe(beforeConfig);
      });
    },
  );

  it("requires external-source consent and honors an existing dangerous flag", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sourcePath = state.path("external-source.txt");
      await fs.writeFile(sourcePath, "external-content", "utf8");

      const config = createConfig(state);
      const sourceConfig = structuredClone(config);
      const beforeConfig = JSON.stringify({ config, sourceConfig });
      await expect(
        buildSandboxSharePatch({
          config,
          sourceConfig,
          request: shareRequest("ro", sourcePath),
        }),
      ).rejects.toThrow(/Confirm sharing this external source/);
      expect(JSON.stringify({ config, sourceConfig })).toBe(beforeConfig);

      const consented = await buildSandboxSharePatch({
        config,
        sourceConfig,
        request: shareRequest("ro", sourcePath, true),
      });
      expect(consented.patch).toMatchObject({
        agents: {
          list: [
            {
              sandbox: {
                docker: {
                  binds: [`${await fs.realpath(sourcePath)}:/mnt/shared/external-source.txt:ro`],
                  dangerouslyAllowExternalBindSources: true,
                },
              },
            },
          ],
        },
      });

      const configured = createConfig(state, {
        dangerouslyAllowExternalBindSources: true,
      });
      const configuredSource = structuredClone(configured);
      const configuredResult = await buildSandboxSharePatch({
        config: configured,
        sourceConfig: configuredSource,
        request: shareRequest("rw", sourcePath),
      });
      expect(configuredResult.result.entry.mode).toBe("rw");
      expect(configuredResult.patch).toMatchObject({
        agents: {
          list: [
            {
              sandbox: {
                docker: {
                  binds: [`${await fs.realpath(sourcePath)}:/mnt/shared/external-source.txt:rw`],
                },
              },
            },
          ],
        },
      });
      expect(
        (configuredResult.patch.agents?.list?.[0]?.sandbox?.docker ?? {})
          .dangerouslyAllowExternalBindSources,
      ).toBeUndefined();
    });
  });

  it.runIf(process.platform !== "win32")(
    "keeps blocked system paths blocked through symlink aliases even with consent",
    async () => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const aliasPath = state.path("etc-alias");
        await fs.symlink("/etc", aliasPath);
        const config = createConfig(state, {
          dangerouslyAllowExternalBindSources: true,
        });
        const sourceConfig = structuredClone(config);
        const beforeConfig = JSON.stringify({ config, sourceConfig });

        for (const sourcePath of ["/etc/passwd", path.join(aliasPath, "passwd")]) {
          await expect(
            buildSandboxSharePatch({
              config,
              sourceConfig,
              request: shareRequest("ro", sourcePath, true),
            }),
          ).rejects.toThrow(/blocked|credential|system|etc/i);
        }

        expect(JSON.stringify({ config, sourceConfig })).toBe(beforeConfig);
      });
    },
  );

  it.each([
    {
      label: "suffixes a target already used below /mnt/shared",
      occupiedTarget: "/mnt/shared/source.txt",
      expectedName: "source-2.txt",
    },
    {
      label: "suffixes a target with a trailing slash",
      occupiedTarget: "/mnt/shared/source.txt/",
      expectedName: "source-2.txt",
    },
    {
      label: "rejects an existing /mnt/shared root mount",
      occupiedTarget: "/mnt/shared",
      expectedError: /shared-file destination is already mounted/,
    },
  ])("$label", async ({ occupiedTarget, expectedName, expectedError }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await fs.mkdir(state.workspaceDir, { recursive: true });
      const sourcePath = path.join(state.workspaceDir, "source.txt");
      const bindHostPath = path.join(state.workspaceDir, "existing-mount");
      await fs.writeFile(sourcePath, "source", "utf8");
      await fs.mkdir(bindHostPath, { recursive: true });
      const config = createConfig(state, {
        binds: [`${bindHostPath}:${occupiedTarget}:ro`],
      });
      const sourceConfig = structuredClone(config);

      const operation = buildSandboxSharePatch({
        config,
        sourceConfig,
        request: shareRequest("rw", sourcePath),
      });
      if (expectedError) {
        await expect(operation).rejects.toThrow(expectedError);
        return;
      }

      const result = await operation;
      expect(result.result.entry.name).toBe(expectedName);
      expect(result.result.entry.containerPath).toBe(`/mnt/shared/${expectedName}`);
      expect(result.result.entry.hostPath).toBe(await fs.realpath(sourcePath));
    });
  });

  it("writes a keyed agent owner while preserving defaults and sibling entries", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await fs.mkdir(state.workspaceDir, { recursive: true });
      const defaultHostPath = path.join(state.workspaceDir, "default-mount");
      const agentHostPath = path.join(state.workspaceDir, "agent-mount");
      const siblingHostPath = path.join(state.workspaceDir, "sibling-mount");
      const sourcePath = path.join(state.workspaceDir, "new.txt");
      await Promise.all([
        fs.mkdir(defaultHostPath, { recursive: true }),
        fs.mkdir(agentHostPath, { recursive: true }),
        fs.mkdir(siblingHostPath, { recursive: true }),
        fs.writeFile(sourcePath, "new", "utf8"),
      ]);
      const defaultBind = `${defaultHostPath}:/mnt/default:ro`;
      const agentBind = `${agentHostPath}:/mnt/agent:rw`;
      const siblingBind = `${siblingHostPath}:/mnt/sibling:ro`;
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            sandbox: {
              mode: "all",
              backend: "docker",
              scope: "agent",
              workspaceAccess: "rw",
              docker: {
                containerPrefix: "openclaw-shared-entries-sbx-",
                binds: [defaultBind],
              },
            },
          },
          entries: {
            main: {
              workspace: state.workspaceDir,
              sandbox: { docker: { binds: [agentBind] } },
            },
            sibling: {
              workspace: state.workspaceDir,
              sandbox: { docker: { binds: [siblingBind] } },
            },
          },
        },
        session: {
          store: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
        },
      };
      const sourceConfig = structuredClone(config);
      const result = await buildSandboxSharePatch({
        config,
        sourceConfig,
        request: shareRequest("rw", sourcePath),
      });
      const newBind = `${await fs.realpath(sourcePath)}:/mnt/shared/new.txt:rw`;

      expect(result.patch).toEqual({
        agents: {
          entries: {
            main: {
              sandbox: { docker: { binds: [agentBind, newBind] } },
            },
          },
        },
      });
      expect(result.patch.agents?.defaults).toBeUndefined();
      expect(result.patch.agents?.entries?.sibling).toBeUndefined();
    });
  });

  it("uses default Docker binds for shared scope and ignores an agent Docker entry", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await fs.mkdir(state.workspaceDir, { recursive: true });
      const defaultHostPath = path.join(state.workspaceDir, "default-mount");
      const agentHostPath = path.join(state.workspaceDir, "agent-mount");
      const sourcePath = path.join(state.workspaceDir, "shared.txt");
      await Promise.all([
        fs.mkdir(defaultHostPath, { recursive: true }),
        fs.mkdir(agentHostPath, { recursive: true }),
        fs.writeFile(sourcePath, "shared", "utf8"),
      ]);
      const defaultBind = `${defaultHostPath}:/mnt/default:ro`;
      const agentBind = `${agentHostPath}:/mnt/agent:rw`;
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            sandbox: {
              mode: "all",
              backend: "docker",
              scope: "shared",
              workspaceAccess: "rw",
              docker: {
                containerPrefix: "openclaw-shared-entries-sbx-",
                binds: [defaultBind],
              },
            },
          },
          entries: {
            main: {
              workspace: state.workspaceDir,
              sandbox: { docker: { binds: [agentBind] } },
            },
          },
        },
        session: {
          store: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
        },
      };
      const sourceConfig = structuredClone(config);
      const result = await buildSandboxSharePatch({
        config,
        sourceConfig,
        request: shareRequest("ro", sourcePath),
      });
      const newBind = `${await fs.realpath(sourcePath)}:/mnt/shared/shared.txt:ro`;

      expect(result.patch).toEqual({
        agents: {
          defaults: {
            sandbox: { docker: { binds: [defaultBind, newBind] } },
          },
        },
      });
      expect(JSON.stringify(result.patch)).not.toContain(agentBind);
    });
  });

  it.each([
    { label: "sandbox off", mode: "off" as const, backend: "docker" },
    { label: "unsupported backend", mode: "all" as const, backend: "ssh" },
  ])("rejects when sharing is unavailable ($label)", async ({ mode, backend }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sourcePath = state.path("unavailable.txt");
      await fs.writeFile(sourcePath, "unchanged", "utf8");
      const config = createConfig(state, { mode, backend });
      const sourceConfig = structuredClone(config);
      const beforeConfig = JSON.stringify({ config, sourceConfig });

      await expect(
        buildSandboxSharePatch({
          config,
          sourceConfig,
          request: shareRequest("ro", sourcePath),
        }),
      ).rejects.toThrow(/Enable a Docker sandbox/);
      expect(await fs.readFile(sourcePath, "utf8")).toBe("unchanged");
      expect(JSON.stringify({ config, sourceConfig })).toBe(beforeConfig);
    });
  });

  it("rejects a path containing an ambiguous Docker colon separator", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await fs.mkdir(state.workspaceDir, { recursive: true });
      const sourcePath = path.join(state.workspaceDir, "ambiguous:name.txt");
      await fs.writeFile(sourcePath, "unchanged", "utf8");
      const config = createConfig(state);
      const sourceConfig = structuredClone(config);
      const beforeConfig = JSON.stringify({ config, sourceConfig });

      await expect(
        buildSandboxSharePatch({
          config,
          sourceConfig,
          request: shareRequest("ro", sourcePath),
        }),
      ).rejects.toThrow(/represented as a Docker bind|Docker bind|copy/i);
      expect(await fs.readFile(sourcePath, "utf8")).toBe("unchanged");
      expect(JSON.stringify({ config, sourceConfig })).toBe(beforeConfig);
    });
  });
});
