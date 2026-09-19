import type { GatewaySessionRow } from "../../api/types.ts";

export function sessionWorkspaceFileKey(
  root: string | undefined,
  workspacePath: string,
  rootId?: string | null,
): string {
  return JSON.stringify([
    "file",
    root ?? "",
    workspacePath,
    ...(rootId && rootId !== "workspace" ? [rootId] : []),
  ]);
}

export function isSessionWorkspaceFileSelected(
  activeId: string | null,
  root: string | undefined,
  path: string,
  workspacePath?: string,
  rootId?: string | null,
): boolean {
  // Requests and Show in Files can select a row before its canonical read completes.
  return (
    activeId ===
      (rootId && rootId !== "workspace" ? `root:${rootId}:file:${path}` : `file:${path}`) ||
    activeId === sessionWorkspaceFileKey(root, workspacePath ?? path, rootId)
  );
}

function pathBasename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

export function resolveSessionWorkspace(params: {
  session: GatewaySessionRow | undefined;
  agentWorkspace?: string;
  worktreePath?: string | null;
}): { root: string | null; label: string | null } {
  const row = params.session;
  if (!row) {
    return { root: null, label: null };
  }
  if (row.repositoryWorkspaceId) {
    return {
      root: row.execNode ? row.execCwd?.trim() || null : null,
      label: row.repository ? pathBasename(row.repository.url).replace(/\.git$/u, "") : null,
    };
  }
  // Exec-node paths belong to that node. Mirror loadSessionFileRoot precedence;
  // an unresolved worktree must never borrow the agent's different checkout.
  const root = row.execNode
    ? row.execCwd?.trim() || null
    : row.spawnedWorkspaceDir?.trim() ||
      row.spawnedCwd?.trim() ||
      params.worktreePath?.trim() ||
      (!row.worktree ? params.agentWorkspace?.trim() : "") ||
      null;
  const label = row.worktree?.repoRoot
    ? pathBasename(row.worktree.repoRoot)
    : root
      ? pathBasename(root)
      : null;
  return { root, label };
}
