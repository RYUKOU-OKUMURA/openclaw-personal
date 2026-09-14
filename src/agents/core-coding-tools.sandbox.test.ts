import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import {
  createSandbox,
  createSandboxFsBridge,
  dockerExecResult,
  getDockerArg,
  getDockerScript,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
} from "./sandbox/fs-bridge.test-helpers.js";

describe("core sandbox directory listing", () => {
  installFsBridgeTestHarness();
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["/workspace", "/custom-workspace"])(
    "lists the mounted skill collection through the assembled ls tool: %s",
    async (containerWorkdir) => {
      const stateDir = tempDirs.make("openclaw-coding-ls-");
      const workspaceDir = path.join(stateDir, "workshop");
      const skillsWorkspaceDir = path.join(stateDir, "materialized");
      const skillsRoot = path.join(skillsWorkspaceDir, "skills");
      await fs.mkdir(path.join(workspaceDir, ".openclaw", "sandbox-skills", "skills"), {
        recursive: true,
      });
      await fs.mkdir(path.join(skillsRoot, "demo"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, ".openclaw", "sandbox-skills", "skills", "shadow.txt"),
        "shadow",
      );
      await fs.mkdir(path.join(workspaceDir, "notes"));
      await fs.writeFile(path.join(workspaceDir, "notes", "todo.txt"), "todo");
      await fs.symlink(
        stateDir,
        path.join(workspaceDir, "outside-link"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        skillsWorkspaceDir,
        containerWorkdir,
      });
      sandbox.fsBridge = createSandboxFsBridge({ sandbox });
      const mountedSkills = `${containerWorkdir}/.openclaw/sandbox-skills/skills`;
      // Keep the real bridge and mount guards; only Docker transport is simulated.
      mockedExecDockerRaw.mockImplementation(async (args) => {
        if (getDockerScript(args).includes('readlink -f -- "$cursor"')) {
          return dockerExecResult(`${getDockerArg(args, 1)}\n`);
        }
        expect(getDockerArg(args, 1)).toBe("readdir");
        const mount = getDockerArg(args, 2);
        expect([mountedSkills, containerWorkdir]).toContain(mount);
        const root = mount === mountedSkills ? skillsRoot : workspaceDir;
        const entries = await fs.readdir(path.join(root, getDockerArg(args, 3)), {
          withFileTypes: true,
        });
        return dockerExecResult(
          JSON.stringify(
            entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })),
          ),
        );
      });
      const tools = createCoreCodingTools({
        codingRoot: workspaceDir,
        containmentRoot: workspaceDir,
        includeBaseCodingTools: true,
        includeShellTools: false,
        workspaceOnly: true,
        readOnly: false,
        sandbox,
        applyPatchEnabled: false,
        applyPatchWorkspaceOnly: true,
        execDefaults: {},
        processDefaults: {},
      });
      const ls = tools.find((tool) => tool.name === "ls")!;
      for (const directory of [".openclaw/sandbox-skills/skills", mountedSkills]) {
        await expect(ls.execute("list-skills", { path: directory })).resolves.toMatchObject({
          content: [{ type: "text", text: '"demo/"' }],
        });
      }
      await expect(ls.execute("list-notes", { path: "notes" })).resolves.toMatchObject({
        content: [{ type: "text", text: '"todo.txt"' }],
      });
      await expect(ls.execute("list-cwd", {})).resolves.toMatchObject({
        content: [{ type: "text", text: '".openclaw/"\n"notes/"\n"outside-link"' }],
      });
      for (const directory of ["/outside", "..", "outside-link"]) {
        await expect(ls.execute("outside-workspace", { path: directory })).rejects.toThrow(
          /escapes sandbox root/,
        );
      }
      const write = tools.find((tool) => tool.name === "write")!;
      await expect(
        write.execute("protect-skills", { path: `${mountedSkills}/new.md`, content: "no" }),
      ).rejects.toThrow(/read-only/);
      expect(await fs.readdir(skillsRoot)).toEqual(["demo"]);
    },
  );
});
