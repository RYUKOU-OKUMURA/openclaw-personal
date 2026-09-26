// Root-bounded directory browsing shared by workspace and approved file locations.
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionFileBrowserEntry,
  SessionFileBrowserResult,
  SessionFileRelevance,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  listWorkspacePath,
  normalizeRelativePath,
  resolveWorkspacePath,
  sortDirents,
  sortWorkspaceEntries,
  statWorkspacePath,
  toUpdatedAtMs,
  type WorkspaceDirEntry,
  type WorkspaceRoot,
} from "./workspace-fs.js";

const MAX_BROWSER_ENTRIES = 250;
const MAX_SEARCH_ENTRIES = 500;
const MAX_SEARCH_VISITED_ENTRIES = 5_000;
const SEARCH_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".next",
  ".turbo",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
]);

function mergeRelevance(
  current: SessionFileRelevance | undefined,
  next: SessionFileRelevance | undefined,
): SessionFileRelevance | undefined {
  if (!current) {
    return next;
  }
  if (!next || current === next) {
    return current;
  }
  return "mixed";
}

function relevanceForBrowserPath(
  browserPath: string,
  kind: "file" | "directory",
  relevance: ReadonlyMap<string, SessionFileRelevance> | undefined,
): SessionFileRelevance | undefined {
  if (kind === "file") {
    return relevance?.get(browserPath);
  }
  if (!relevance) {
    return undefined;
  }
  const prefix = browserPath ? `${browserPath}/` : "";
  let aggregate: SessionFileRelevance | undefined;
  for (const [filePath, sessionKind] of relevance) {
    if (filePath.startsWith(prefix) && filePath !== browserPath) {
      aggregate = mergeRelevance(aggregate, sessionKind);
    }
  }
  return aggregate;
}

function toBrowserEntry(
  browserPath: string,
  dirent: WorkspaceDirEntry,
  relevance?: ReadonlyMap<string, SessionFileRelevance>,
): SessionFileBrowserEntry | undefined {
  const kind = dirent.isDirectory ? "directory" : dirent.isFile ? "file" : null;
  if (!kind) {
    return undefined;
  }
  const sessionKind = relevanceForBrowserPath(browserPath, kind, relevance);
  return {
    path: browserPath,
    name: dirent.name,
    kind,
    ...(kind === "file" ? { size: dirent.size } : {}),
    updatedAtMs: toUpdatedAtMs(dirent.mtimeMs),
    ...(sessionKind ? { sessionKind } : {}),
  };
}

function matchesSearch(entryPath: string, name: string, query: string): boolean {
  const normalizedQuery = query.toLowerCase();
  return (
    name.toLowerCase().includes(normalizedQuery) ||
    entryPath.toLowerCase().includes(normalizedQuery)
  );
}

async function searchBrowserEntries(params: {
  root: string | WorkspaceRoot;
  query: string;
  startPath?: string;
  relevance?: ReadonlyMap<string, SessionFileRelevance>;
}): Promise<{ entries: SessionFileBrowserEntry[]; truncated?: boolean }> {
  const entries: SessionFileBrowserEntry[] = [];
  let visitedEntries = 0;
  let truncated = false;
  const shouldStop = (): boolean => {
    if (entries.length >= MAX_SEARCH_ENTRIES || visitedEntries >= MAX_SEARCH_VISITED_ENTRIES) {
      truncated = true;
      return true;
    }
    return false;
  };
  const visit = async (dir: string): Promise<void> => {
    if (shouldStop()) {
      return;
    }
    const dirents = await listWorkspacePath(params.root, dir);
    if (!dirents) {
      return;
    }
    for (const dirent of sortDirents(dirents)) {
      if (shouldStop()) {
        return;
      }
      visitedEntries += 1;
      const browserPath = dir ? `${dir}/${dirent.name}` : dirent.name;
      if (matchesSearch(browserPath, dirent.name, params.query)) {
        const entry = toBrowserEntry(browserPath, dirent, params.relevance);
        if (entry) {
          entries.push(entry);
        }
      }
      if (dirent.isDirectory && !SEARCH_SKIP_DIRS.has(dirent.name)) {
        await visit(browserPath);
      }
    }
  };
  await visit(params.startPath ?? "");
  return { entries: sortWorkspaceEntries(entries), ...(truncated ? { truncated } : {}) };
}

export async function buildWorkspaceBrowser(params: {
  root: string | undefined;
  workspaceRoot?: WorkspaceRoot;
  path?: string;
  search?: string;
  searchPath?: string;
  relevance?: ReadonlyMap<string, SessionFileRelevance>;
}): Promise<SessionFileBrowserResult | undefined> {
  if (!params.root) {
    return undefined;
  }
  const search = normalizeOptionalString(params.search);
  if (search) {
    const result = await searchBrowserEntries({
      root: params.workspaceRoot ?? params.root,
      query: search,
      startPath: params.searchPath,
      relevance: params.relevance,
    });
    return {
      path: "",
      search,
      entries: result.entries,
      ...(result.truncated ? { truncated: result.truncated } : {}),
    };
  }
  const browserPath = normalizeRelativePath(params.path);
  const resolved = resolveWorkspacePath(params.root, browserPath);
  if (!resolved) {
    return undefined;
  }
  const stat = await statWorkspacePath(params.workspaceRoot ?? params.root, browserPath);
  if (!stat?.isDirectory) {
    return undefined;
  }
  const dirents = await listWorkspacePath(params.workspaceRoot ?? params.root, browserPath);
  if (!dirents) {
    return undefined;
  }
  const entries = sortDirents(dirents)
    .slice(0, MAX_BROWSER_ENTRIES + 1)
    .map((dirent) => {
      const entryPath = browserPath ? `${browserPath}/${dirent.name}` : dirent.name;
      return toBrowserEntry(entryPath, dirent, params.relevance);
    })
    .filter((entry): entry is SessionFileBrowserEntry => Boolean(entry));
  const parent = path.dirname(browserPath);
  return {
    path: browserPath,
    ...(browserPath ? { parentPath: parent === "." ? "" : parent } : {}),
    entries: sortWorkspaceEntries(entries.slice(0, MAX_BROWSER_ENTRIES)),
    ...(entries.length > MAX_BROWSER_ENTRIES ? { truncated: true } : {}),
  };
}
