import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type {
  SandboxEntriesAddParams,
  SandboxEntriesAddResult,
  SandboxExplainResult,
} from "../../../packages/gateway-protocol/src/schema/sandbox.js";
import { hasErrnoCode, isMissingPathError } from "../../infra/errno.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { ensureAbsoluteDirectory, FsSafeError, root, type Root } from "../../infra/fs-safe.js";
import {
  decodeTerminalUpload,
  sanitizeTerminalUploadName,
} from "../../infra/terminal-file-upload.js";
import type { resolveSandboxExplainContext } from "./explain-report.js";

type ExplainContext = ReturnType<typeof resolveSandboxExplainContext>;
type Inbox = NonNullable<SandboxExplainResult["inbox"]>;
type EntryKind = SandboxEntriesAddResult["entry"]["kind"];
const MAX_INBOX_ENTRIES = 200;

function resolveInboxPaths(snapshot: ExplainContext) {
  const { report, sandboxConfig, workspaceLayout } = snapshot;
  if (
    !report.sandbox.sessionIsSandboxed ||
    normalizeLowercaseStringOrEmpty(sandboxConfig.backend) !== "docker" ||
    !report.sandbox.runtimeWorkdir
  ) {
    return null;
  }
  // Use the same working mount as explain/runtime, including ro/none agent-workspace access.
  // Never import to an agent directory that this sandbox cannot see.
  return {
    workspaceDir: workspaceLayout.workspaceDir,
    hostPath: path.join(workspaceLayout.workspaceDir, "inbox"),
    containerPath: path.posix.join(report.sandbox.runtimeWorkdir, "inbox"),
  };
}

export async function readSandboxInbox(snapshot: ExplainContext): Promise<Inbox | null> {
  const paths = resolveInboxPaths(snapshot);
  if (!paths) {
    return null;
  }
  const result: Inbox = {
    hostPath: paths.hostPath,
    containerPath: paths.containerPath,
    entries: [],
    counts: { files: 0, folders: 0, other: 0 },
    truncated: false,
  };
  let entries;
  try {
    const workspace = await root(paths.workspaceDir);
    entries = await workspace.list("inbox", { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return result;
    }
    throw error;
  }
  for (const entry of entries) {
    const kind = entry.isSymbolicLink
      ? "symlink"
      : entry.isFile
        ? "file"
        : entry.isDirectory
          ? "directory"
          : "other";
    result.counts[kind === "file" ? "files" : kind === "directory" ? "folders" : "other"]++;
    if (result.entries.length < MAX_INBOX_ENTRIES) {
      result.entries.push({ name: entry.name, kind });
    }
  }
  result.truncated = entries.length > result.entries.length;
  return result;
}

async function reserveInboxEntry(workspace: Root, name: string, kind: EntryKind, bytes: Buffer) {
  const extension = kind === "file" ? path.extname(name) : "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  const occupied = new Set(await workspace.list("inbox"));
  for (let suffix = 1; ; suffix++) {
    const candidate = suffix === 1 ? name : `${stem}-${suffix}${extension}`;
    if (occupied.has(candidate)) {
      continue;
    }
    const relativePath = path.join("inbox", candidate);
    try {
      if (kind === "file") {
        await workspace.create(relativePath, bytes, { mkdir: false });
      } else {
        // Root.mkdir is mkdir-p: reserve this exact name exclusively instead of
        // merging a copy into an existing directory. Root.resolve guards its parents.
        await fs.mkdir(await workspace.resolve(relativePath));
        await workspace.stat(relativePath);
      }
      return { name: candidate, relativePath };
    } catch (error) {
      if (hasErrnoCode(error, "EEXIST") || hasErrnoCode(error, "already-exists")) {
        continue;
      }
      throw error;
    }
  }
}

/** The source is private staging containing only materialized files/directories. */
async function importStagedDirectory(workspace: Root, source: string, destination: string) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries.toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await workspace.mkdir(targetPath);
      await importStagedDirectory(workspace, sourcePath, targetPath);
    } else {
      await workspace.copyIn(targetPath, sourcePath, {
        maxBytes: Number.MAX_SAFE_INTEGER,
        sourceHardlinks: "reject",
        mkdir: false,
      });
    }
  }
}

export async function addSandboxEntry(
  snapshot: ExplainContext,
  source: SandboxEntriesAddParams["source"],
): Promise<SandboxEntriesAddResult> {
  const paths = resolveInboxPaths(snapshot);
  if (!paths) {
    throw new FsSafeError("invalid-path", "Enable a Docker sandbox before adding files.");
  }
  const bytes =
    source.kind === "upload" ? decodeTerminalUpload(source.contentBase64) : Buffer.alloc(0);
  let kind: EntryKind = source.kind === "create" ? source.entryKind : "file";
  let staging: string | undefined;
  try {
    if (source.kind === "path") {
      if (!path.isAbsolute(source.path)) {
        throw new FsSafeError("invalid-path", "Choose an absolute host file or folder path.");
      }
      const stat = await fs.stat(source.path);
      if (!stat.isFile() && !stat.isDirectory()) {
        throw new FsSafeError("not-file", "Choose a regular file or folder to copy.");
      }
      kind = stat.isDirectory() ? "directory" : "file";
      // Dereference once outside the agent's writable workspace. A link is copied
      // as content, never published as an alias back into the host filesystem.
      staging = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-import-"));
      await fs.cp(source.path, path.join(staging, "entry"), {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
      });
    }
    const workspace = await root(paths.workspaceDir).catch(async (error: unknown) => {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const ensured = await ensureAbsoluteDirectory(paths.workspaceDir);
      if (!ensured.ok) {
        throw ensured.error;
      }
      return await root(paths.workspaceDir);
    });
    await workspace.mkdir("inbox");
    const name = sanitizeTerminalUploadName(
      source.kind === "path" ? path.basename(source.path) : source.name,
    );
    const reserved = await reserveInboxEntry(workspace, name, kind, bytes);
    try {
      if (staging) {
        const stagedPath = path.join(staging, "entry");
        if (kind === "directory") {
          await importStagedDirectory(workspace, stagedPath, reserved.relativePath);
        } else {
          await workspace.copyIn(reserved.relativePath, stagedPath, {
            maxBytes: Number.MAX_SAFE_INTEGER,
            sourceHardlinks: "reject",
            mkdir: false,
          });
        }
      }
    } catch (error) {
      await removePathWithinRoot({
        rootDir: workspace.rootReal,
        relativePath: reserved.relativePath,
        recursive: true,
      });
      throw error;
    }
    return {
      entry: {
        name: reserved.name,
        kind,
        hostPath: path.join(paths.hostPath, reserved.name),
        containerPath: path.posix.join(paths.containerPath, reserved.name),
        mode: "copy",
      },
      recreateRequired: false,
    };
  } finally {
    if (staging) {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
}
