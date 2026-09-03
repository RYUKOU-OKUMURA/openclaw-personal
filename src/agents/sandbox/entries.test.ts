import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_TERMINAL_UPLOAD_BYTES } from "../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { addSandboxEntry, readSandboxInbox } from "./entries.js";
import { resolveSandboxExplainContext } from "./explain-report.js";

type WorkspaceAccess = "none" | "ro" | "rw";

function createConfig(
  state: OpenClawTestState,
  overrides: {
    backend?: string;
    mode?: "off" | "all";
    workspaceAccess?: WorkspaceAccess;
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
          workspaceAccess: overrides.workspaceAccess ?? "rw",
          docker: { containerPrefix: "openclaw-entries-sbx-" },
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
) {
  const cfg = createConfig(state, overrides);
  return {
    cfg,
    snapshot: resolveSandboxExplainContext({ cfg, agentId: "main" }),
  };
}

function inboxPaths(snapshot: ReturnType<typeof resolveSandboxExplainContext>) {
  const runtimeWorkdir = snapshot.report.sandbox.runtimeWorkdir;
  if (!runtimeWorkdir) {
    throw new Error("expected a Docker runtime workdir");
  }
  return {
    hostPath: path.join(snapshot.workspaceLayout.workspaceDir, "inbox"),
    containerPath: path.posix.join(runtimeWorkdir, "inbox"),
  };
}

describe("sandbox entries", () => {
  it.runIf(process.platform !== "win32")(
    "copies path sources without mutating them and materializes source symlink contents",
    async () => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { snapshot } = createSnapshot(state);
        const sourceRoot = state.path("source-tree");
        const sourceTarget = path.join(sourceRoot, "target.txt");
        const sourceLink = path.join(sourceRoot, "linked.txt");
        await fs.mkdir(sourceRoot, { recursive: true });
        await fs.writeFile(sourceTarget, "source-content", "utf8");
        await fs.symlink("target.txt", sourceLink);

        const result = await addSandboxEntry(snapshot, {
          kind: "path",
          path: sourceRoot,
        });
        const destinationRoot = result.entry.hostPath;

        expect(result).toEqual({
          entry: {
            name: "source-tree",
            kind: "directory",
            hostPath: path.join(snapshot.workspaceLayout.workspaceDir, "inbox", "source-tree"),
            containerPath: path.posix.join("/workspace/inbox", "source-tree"),
            mode: "copy",
          },
          recreateRequired: false,
        });
        expect(await fs.readFile(path.join(destinationRoot, "linked.txt"), "utf8")).toBe(
          "source-content",
        );
        expect((await fs.lstat(path.join(destinationRoot, "linked.txt"))).isSymbolicLink()).toBe(
          false,
        );

        expect((await fs.lstat(sourceLink)).isSymbolicLink()).toBe(true);
        await expect(fs.readlink(sourceLink)).resolves.toBe("target.txt");
        await expect(fs.readFile(sourceTarget, "utf8")).resolves.toBe("source-content");
        await expect(readSandboxInbox(snapshot)).resolves.toMatchObject({
          hostPath: inboxPaths(snapshot).hostPath,
          containerPath: inboxPaths(snapshot).containerPath,
        });
      });
    },
  );

  it("creates empty entries and reserves concurrent duplicate names with extensions preserved", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { snapshot } = createSnapshot(state);
      const emptyFile = await addSandboxEntry(snapshot, {
        kind: "create",
        name: "newfile.txt",
        entryKind: "file",
      });
      const emptyFolder = await addSandboxEntry(snapshot, {
        kind: "create",
        name: "empty-folder",
        entryKind: "directory",
      });
      expect(emptyFile.entry.kind).toBe("file");
      expect(emptyFolder.entry.kind).toBe("directory");
      expect(emptyFile.recreateRequired).toBe(false);
      expect(emptyFolder.recreateRequired).toBe(false);
      await expect(fs.readFile(emptyFile.entry.hostPath)).resolves.toEqual(Buffer.alloc(0));
      await expect(fs.readdir(emptyFolder.entry.hostPath)).resolves.toEqual([]);

      const [firstFile, secondFile] = await Promise.all([
        addSandboxEntry(snapshot, {
          kind: "create",
          name: "file.ext",
          entryKind: "file",
        }),
        addSandboxEntry(snapshot, {
          kind: "create",
          name: "file.ext",
          entryKind: "file",
        }),
      ]);
      expect([firstFile.entry.name, secondFile.entry.name].toSorted()).toEqual([
        "file-2.ext",
        "file.ext",
      ]);

      const [firstFolder, secondFolder] = await Promise.all([
        addSandboxEntry(snapshot, {
          kind: "create",
          name: "folder",
          entryKind: "directory",
        }),
        addSandboxEntry(snapshot, {
          kind: "create",
          name: "folder",
          entryKind: "directory",
        }),
      ]);
      expect([firstFolder.entry.name, secondFolder.entry.name].toSorted()).toEqual([
        "folder",
        "folder-2",
      ]);
    });
  });

  it.runIf(process.platform !== "win32")(
    "suffixes a leaf symlink collision without changing the external target",
    async () => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { snapshot } = createSnapshot(state);
        const outsidePath = state.path("outside.txt");
        const sourcePath = state.path("incoming.txt");
        const { hostPath: inboxPath } = inboxPaths(snapshot);
        await fs.writeFile(outsidePath, "keep-me", "utf8");
        await fs.writeFile(sourcePath, "new-content", "utf8");
        await fs.mkdir(inboxPath, { recursive: true });
        const destinationPath = path.join(inboxPath, "incoming.txt");
        await fs.symlink(outsidePath, destinationPath);

        const result = await addSandboxEntry(snapshot, { kind: "path", path: sourcePath });
        expect(result.entry.name).toBe("incoming-2.txt");
        expect(result.entry.hostPath).toBe(path.join(inboxPath, "incoming-2.txt"));
        await expect(fs.readFile(result.entry.hostPath, "utf8")).resolves.toBe("new-content");
        await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("keep-me");
        expect((await fs.lstat(destinationPath)).isSymbolicLink()).toBe(true);
        await expect(fs.readlink(destinationPath)).resolves.toBe(outsidePath);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects an inbox directory symlink without changing the external target",
    async () => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { snapshot } = createSnapshot(state);
        const outsideInbox = state.path("outside-inbox");
        const outsideSentinel = path.join(outsideInbox, "sentinel.txt");
        const sourcePath = state.path("incoming.txt");
        const { hostPath: inboxPath } = inboxPaths(snapshot);
        await fs.mkdir(outsideInbox, { recursive: true });
        await fs.writeFile(outsideSentinel, "keep-me", "utf8");
        await fs.writeFile(sourcePath, "new-content", "utf8");
        await fs.symlink(outsideInbox, inboxPath);

        await expect(readSandboxInbox(snapshot)).rejects.toThrow();
        await expect(
          addSandboxEntry(snapshot, { kind: "path", path: sourcePath }),
        ).rejects.toThrow();
        await expect(fs.readFile(outsideSentinel, "utf8")).resolves.toBe("keep-me");
        await expect(fs.readdir(outsideInbox)).resolves.toEqual(["sentinel.txt"]);
      });
    },
  );

  it("rejects invalid and oversized uploads before creating inbox state", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { snapshot } = createSnapshot(state);
      const { hostPath: inboxPath } = inboxPaths(snapshot);
      await expect(
        addSandboxEntry(snapshot, {
          kind: "upload",
          name: "bad.txt",
          contentBase64: "not-base64",
        }),
      ).rejects.toThrow(/invalid.*encoding|base64/i);
      await expect(fs.lstat(inboxPath)).rejects.toMatchObject({ code: "ENOENT" });

      const oversized = Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES + 1, 0x61).toString("base64");
      await expect(
        addSandboxEntry(snapshot, {
          kind: "upload",
          name: "large.bin",
          contentBase64: oversized,
        }),
      ).rejects.toThrow(/exceed|large|size|bytes/i);
      await expect(fs.lstat(inboxPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("returns an empty listing without creating inbox or session state", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { cfg, snapshot } = createSnapshot(state);
      const paths = inboxPaths(snapshot);
      await expect(readSandboxInbox(snapshot)).resolves.toEqual({
        ...paths,
        entries: [],
        counts: { files: 0, folders: 0, other: 0 },
        truncated: false,
      });
      await expect(fs.lstat(paths.hostPath)).rejects.toMatchObject({ code: "ENOENT" });
      const sessionStore = cfg.session?.store;
      if (!sessionStore) {
        throw new Error("expected a configured session store");
      }
      await expect(fs.lstat(sessionStore)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.runIf(process.platform !== "win32")(
    "counts only direct children, classifies symlinks and other nodes, and caps the listing",
    async () => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { snapshot } = createSnapshot(state);
        const { hostPath: inboxPath, containerPath } = inboxPaths(snapshot);
        await fs.mkdir(path.join(inboxPath, "a-folder"), { recursive: true });
        await fs.writeFile(path.join(inboxPath, "a-folder", "nested.txt"), "nested", "utf8");
        const outsidePath = state.path("outside.txt");
        await fs.writeFile(outsidePath, "outside", "utf8");
        await fs.symlink(outsidePath, path.join(inboxPath, "b-link"));
        await Promise.all(
          Array.from({ length: 197 }, (_, index) =>
            fs.writeFile(
              path.join(inboxPath, `file-${String(index).padStart(3, "0")}`),
              "file",
              "utf8",
            ),
          ),
        );
        await Promise.all(
          Array.from({ length: 3 }, (_, index) =>
            fs.writeFile(path.join(inboxPath, `z-overflow-${index}`), "overflow", "utf8"),
          ),
        );

        const listing = await readSandboxInbox(snapshot);
        expect(listing).not.toBeNull();
        expect(listing).toMatchObject({
          hostPath: inboxPath,
          containerPath,
          counts: { files: 200, folders: 1, other: 1 },
          truncated: true,
        });
        expect(listing?.entries).toHaveLength(200);
        expect(listing?.entries.slice(0, 3)).toEqual([
          { name: "a-folder", kind: "directory" },
          { name: "b-link", kind: "symlink" },
          { name: "file-000", kind: "file" },
        ]);
      });
    },
  );

  it.each(["ro", "none"] as const)(
    "uses the effective workspace and runtime inbox path for %s access",
    async (workspaceAccess) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { snapshot } = createSnapshot(state, { workspaceAccess });
        const expectedHostInbox = path.join(
          snapshot.report.sandbox.effectiveHostWorkspaceRoot,
          "inbox",
        );
        const expectedContainerInbox = inboxPaths(snapshot).containerPath;
        const result = await addSandboxEntry(snapshot, {
          kind: "create",
          name: "entry.txt",
          entryKind: "file",
        });
        expect(result.entry.hostPath).toBe(path.join(expectedHostInbox, "entry.txt"));
        expect(result.entry.containerPath).toBe(
          path.posix.join(expectedContainerInbox, "entry.txt"),
        );
        await expect(fs.readFile(result.entry.hostPath)).resolves.toEqual(Buffer.alloc(0));
        await expect(readSandboxInbox(snapshot)).resolves.toMatchObject({
          hostPath: expectedHostInbox,
          containerPath: expectedContainerInbox,
          entries: [{ name: "entry.txt", kind: "file" }],
          counts: { files: 1, folders: 0, other: 0 },
          truncated: false,
        });
        await expect(
          fs.lstat(path.join(snapshot.workspaceLayout.agentWorkspaceDir, "inbox")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it.each([
    { label: "off", mode: "off" as const, backend: "docker" },
    { label: "unsupported backend", mode: "all" as const, backend: "ssh" },
  ])("rejects entries for $label without creating inbox state", async ({ mode, backend }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { snapshot } = createSnapshot(state, { mode, backend });
      const inboxPath = path.join(snapshot.workspaceLayout.workspaceDir, "inbox");
      await expect(readSandboxInbox(snapshot)).resolves.toBeNull();
      await expect(
        addSandboxEntry(snapshot, {
          kind: "create",
          name: "entry.txt",
          entryKind: "file",
        }),
      ).rejects.toThrow();
      await expect(fs.lstat(inboxPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
