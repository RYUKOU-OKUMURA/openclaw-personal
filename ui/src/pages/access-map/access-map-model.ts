import type { SandboxExplainResult } from "../../../../packages/gateway-protocol/src/index.js";

type AccessMapMountBadge = "read-only" | "read-write" | "protected";

type AccessMapMount = SandboxExplainResult["sandbox"]["workspaceMounts"][number] & {
  badge: AccessMapMountBadge;
};

type SandboxInbox = Exclude<SandboxExplainResult["inbox"], null | undefined>;

type AccessMapInboxEntry = SandboxInbox["entries"][number] & {
  badge: "inbox";
};

type AccessMapInbox = Omit<SandboxInbox, "entries"> & {
  entries: AccessMapInboxEntry[];
};

type AccessMapSandbox = Omit<
  SandboxExplainResult["sandbox"],
  "workspaceMounts" | "runtimeWorkdir"
> & {
  workspaceMounts: AccessMapMount[];
  runtimeWorkdir: string | null;
  backendSupported: boolean;
};

export type AccessMapViewModel = Omit<
  SandboxExplainResult,
  "sandbox" | "inbox" | "registry" | "fixIt"
> & {
  sandbox: AccessMapSandbox;
  /** A normalized nullable value makes the empty inbox distinct from a missing response. */
  inbox: AccessMapInbox | null;
  registry: SandboxExplainResult["registry"];
  fixIt: string[];
  stale: boolean;
  chips: {
    sharedFolders: number;
    /** Null means the report did not expose a configured network value. */
    network: string | null;
    externalTools: {
      allow: string[];
      deny: string[];
    };
  };
};

function mountBadge(
  mount: SandboxExplainResult["sandbox"]["workspaceMounts"][number],
): AccessMapMountBadge {
  if (mount.source === "protectedSkill") {
    return "protected";
  }
  return mount.writable ? "read-write" : "read-only";
}

/**
 * Derives the display state from one explain response. The function only
 * copies and annotates protocol data; inbox counts continue to mean immediate
 * inbox children and never the complete set of reachable files.
 */
export function buildAccessMapViewModel(explain: SandboxExplainResult): AccessMapViewModel {
  const workspaceMounts = explain.sandbox.workspaceMounts.map((mount) => ({
    ...mount,
    badge: mountBadge(mount),
  }));
  const inbox = explain.inbox
    ? {
        ...explain.inbox,
        entries: explain.inbox.entries.map((entry) => ({ ...entry, badge: "inbox" as const })),
      }
    : null;
  const network = explain.sandbox.network ?? null;

  return {
    docsUrl: explain.docsUrl,
    agentId: explain.agentId,
    sessionKey: explain.sessionKey,
    mainSessionKey: explain.mainSessionKey,
    sandbox: {
      ...explain.sandbox,
      workspaceMounts,
      runtimeWorkdir: explain.sandbox.runtimeWorkdir ?? null,
      backendSupported: explain.sandbox.backend.trim().toLowerCase() === "docker",
    },
    elevated: explain.elevated,
    fixIt: explain.fixIt,
    inbox,
    registry: explain.registry,
    stale: explain.registry?.stale ?? false,
    chips: {
      sharedFolders: workspaceMounts.filter((mount) => mount.source === "bind").length,
      network,
      externalTools: {
        allow: [...explain.sandbox.tools.allow],
        deny: [...explain.sandbox.tools.deny],
      },
    },
  };
}
