// Approved file locations for the session browser. No client path grants a root.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SessionFileRoot,
  SessionFileBrowserResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { buildSandboxExplainReport } from "../../agents/sandbox/explain-report.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildWorkspaceBrowser } from "./session-file-browser.js";
import {
  openWorkspaceRoot,
  statWorkspacePath,
  workspaceStatKind,
  type WorkspaceRoot,
} from "./workspace-fs.js";

export type SessionBrowserRoot = {
  info: SessionFileRoot;
  // Outputs stay rooted at the workspace, so an outputs symlink cannot grant a new root.
  fsRoot: string;
  prefix: string;
  displayRoot: string;
  workspaceRoot?: WorkspaceRoot;
  onlyFile?: string;
};

async function directoryRoot(params: {
  id: string;
  kind: "workspace" | "outputs";
  fsRoot: string;
  runtimeRoot?: string;
  writable: boolean;
}): Promise<SessionBrowserRoot> {
  const prefix = params.kind === "outputs" ? "outputs" : "";
  const displayRoot = path.join(params.fsRoot, prefix);
  const workspaceRoot = await openWorkspaceRoot(params.fsRoot);
  const stat = workspaceRoot ? await statWorkspacePath(workspaceRoot, prefix) : undefined;
  return {
    fsRoot: params.fsRoot,
    prefix,
    displayRoot,
    workspaceRoot,
    info: {
      id: params.id,
      kind: params.kind,
      name: params.kind,
      hostPath: displayRoot,
      ...(params.runtimeRoot ? { runtimePath: path.posix.join(params.runtimeRoot, prefix) } : {}),
      writable: params.writable,
      available: Boolean(stat && workspaceStatKind(stat) === "directory"),
    },
  };
}

/** Admin-only host browsing reuses the same effective mounts shown by sandbox.explain. */
export async function resolveSessionBrowserRoots(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceRoot: string;
}): Promise<SessionBrowserRoot[]> {
  const { sandbox } = buildSandboxExplainReport(params);
  const localSandbox = ["docker", "podman"].includes(sandbox.backend.toLowerCase());
  // Remote filesystem backends must not turn their host mirrors into extra read grants.
  if (sandbox.sessionIsSandboxed && !localSandbox) {
    return [];
  }
  const workspaceMount = sandbox.workspaceMounts.find((mount) => mount.source === "workspace");
  const runtimeRoot = sandbox.sessionIsSandboxed
    ? workspaceMount?.containerRoot
    : params.workspaceRoot;
  const outputHostRoot = sandbox.sessionIsSandboxed
    ? sandbox.effectiveHostWorkspaceRoot
    : params.workspaceRoot;
  const writable = !sandbox.sessionIsSandboxed || workspaceMount?.writable === true;
  const roots = [
    await directoryRoot({
      id: "workspace",
      kind: "workspace",
      fsRoot: params.workspaceRoot,
      runtimeRoot:
        !sandbox.sessionIsSandboxed || outputHostRoot === params.workspaceRoot
          ? runtimeRoot
          : undefined,
      writable,
    }),
    await directoryRoot({
      id: "outputs",
      kind: "outputs",
      fsRoot: outputHostRoot,
      runtimeRoot,
      writable,
    }),
  ];
  for (const mount of sandbox.workspaceMounts) {
    if (mount.source !== "bind" || !mount.containerRoot.startsWith("/mnt/shared/")) {
      continue;
    }
    const hostPath = path.resolve(mount.hostRoot);
    const stat = await fs.lstat(hostPath).catch(() => undefined);
    // Share grants persist a canonical path. Do not follow a later symlink replacement.
    const canonical = await fs.realpath(hostPath).catch(() => undefined);
    const regular = canonical === hostPath && (stat?.isFile() || stat?.isDirectory());
    const onlyFile = stat?.isFile() ? path.basename(hostPath) : undefined;
    const fsRoot = onlyFile ? path.dirname(hostPath) : hostPath;
    const safeRoot = regular ? await openWorkspaceRoot(fsRoot) : undefined;
    const safeStat =
      safeRoot?.rootReal === fsRoot ? await statWorkspacePath(safeRoot, onlyFile ?? "") : undefined;
    roots.push({
      fsRoot,
      prefix: "",
      displayRoot: fsRoot,
      workspaceRoot: safeRoot,
      ...(onlyFile ? { onlyFile } : {}),
      info: {
        id: `shared:${createHash("sha256").update(`${hostPath}\0${mount.containerRoot}`).digest("hex")}`,
        kind: "shared",
        name: path.posix.basename(mount.containerRoot),
        hostPath,
        runtimePath: mount.containerRoot,
        writable: mount.writable,
        available: Boolean(safeStat),
      },
    });
  }
  return roots;
}

/** Converts a root-relative path without granting access to ancestors or sibling shares. */
export function sessionBrowserRootPath(root: SessionBrowserRoot, input = ""): string | undefined {
  const normalized = input.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    return undefined;
  }
  const relative = normalized
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  if (root.onlyFile && relative !== root.onlyFile) {
    return undefined;
  }
  return [root.prefix, relative].filter(Boolean).join("/");
}

/** Lists only the selected location, including a single-file share without its siblings. */
export async function listSessionBrowserRoot(
  root: SessionBrowserRoot,
  params: { path?: string; search?: string },
): Promise<SessionFileBrowserResult | undefined> {
  if (!root.info.available) {
    return { path: "", entries: [] };
  }
  if (root.onlyFile) {
    if (params.path) {
      return undefined;
    }
    const stat = root.workspaceRoot
      ? await statWorkspacePath(root.workspaceRoot, root.onlyFile)
      : undefined;
    const search = params.search?.trim();
    return {
      path: "",
      ...(search ? { search } : {}),
      entries:
        stat &&
        workspaceStatKind(stat) === "file" &&
        (!search || root.onlyFile.toLowerCase().includes(search.toLowerCase()))
          ? [{ path: root.onlyFile, name: root.onlyFile, kind: "file", size: stat.size }]
          : [],
    };
  }
  const selectedPath = sessionBrowserRootPath(root, params.path);
  if (selectedPath === undefined) {
    return undefined;
  }
  const browser = await buildWorkspaceBrowser({
    root: root.fsRoot,
    workspaceRoot: root.workspaceRoot,
    path: selectedPath,
    search: params.search,
    searchPath: root.prefix,
  });
  if (!browser) {
    return undefined;
  }
  const relative = (value: string) =>
    root.prefix && value.startsWith(`${root.prefix}/`)
      ? value.slice(root.prefix.length + 1)
      : value === root.prefix
        ? ""
        : value;
  const browserPath = relative(browser.path);
  for (const entry of browser.entries) {
    entry.path = relative(entry.path);
  }
  return {
    ...browser,
    path: browserPath,
    parentPath:
      browserPath && browser.parentPath !== undefined ? relative(browser.parentPath) : undefined,
  };
}
