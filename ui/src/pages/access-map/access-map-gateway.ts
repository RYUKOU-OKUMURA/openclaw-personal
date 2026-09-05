import {
  asNullableRecord as asConfigRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import type {
  FsListDirParams,
  FsListDirResult,
  FsPickPathResult,
  SandboxEntriesAddParams,
  SandboxEntriesAddResult,
  SandboxExplainResult,
  SandboxRecreateResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

export type AccessMapGatewayClient = Pick<GatewayBrowserClient, "request">;

export type AccessMapConfigWriter = Pick<
  RuntimeConfigCapability,
  "runExternalMutation" | "canPatch"
>;

export type AccessMapShareMount = SandboxExplainResult["sandbox"]["workspaceMounts"][number];

export type RemoveSharedBindResult = {
  removed: boolean;
  /** A committed patch can outlive a failed authoritative refresh. */
  refreshWarning: string | null;
};

export async function loadSandboxExplain(
  client: AccessMapGatewayClient,
  agentId?: string,
): Promise<SandboxExplainResult> {
  const normalizedAgentId = agentId?.trim();
  return await client.request<SandboxExplainResult>(
    "sandbox.explain",
    normalizedAgentId ? { agentId: normalizedAgentId } : {},
  );
}

export async function addSandboxEntry(
  client: AccessMapGatewayClient,
  params: SandboxEntriesAddParams,
): Promise<SandboxEntriesAddResult> {
  return await client.request<SandboxEntriesAddResult>("sandbox.entries.add", params);
}

export async function recreateSandboxContainer(
  client: AccessMapGatewayClient,
  agentId?: string,
): Promise<SandboxRecreateResult> {
  const normalizedAgentId = agentId?.trim();
  return await client.request<SandboxRecreateResult>(
    "sandbox.recreate",
    normalizedAgentId ? { agentId: normalizedAgentId } : {},
  );
}

/**
 * Lists Gateway-local files for the access-map picker. The node path remains
 * directory-only unless the caller explicitly asks for the server rejection.
 */
export async function listHostDir(
  client: AccessMapGatewayClient,
  params: FsListDirParams = {},
): Promise<FsListDirResult> {
  const requestParams = { ...params };
  if (!params.nodeId && params.includeFiles === undefined) {
    requestParams.includeFiles = true;
  }
  return await client.request<FsListDirResult>("fs.listDir", requestParams);
}

export async function pickHostPath(
  client: AccessMapGatewayClient,
  path: string,
): Promise<FsPickPathResult> {
  // The native dialog waits for a person; keep the request alive beyond its 2-minute limit.
  return await client.request<FsPickPathResult>("fs.pickPath", { path }, { timeoutMs: 150_000 });
}

const AGENT_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,63}$/i;
const BLOCKED_AGENT_IDS = new Set(["__proto__", "prototype", "constructor"]);

function safeAgentId(agentId: string): string | null {
  const trimmed = agentId.trim();
  if (!AGENT_ID_PATTERN.test(trimmed) || BLOCKED_AGENT_IDS.has(trimmed.toLowerCase())) {
    return null;
  }
  const normalized = normalizeAgentId(trimmed);
  return AGENT_ID_PATTERN.test(normalized) && !BLOCKED_AGENT_IDS.has(normalized)
    ? normalized
    : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readBindList(source: Record<string, unknown> | null, ownerPath: string): string[] | null {
  if (!source || !Object.hasOwn(source, "binds")) {
    return null;
  }
  if (!Array.isArray(source.binds) || !source.binds.every((bind) => typeof bind === "string")) {
    throw new Error(`Configuration at ${ownerPath} is not a valid Docker bind list.`);
  }
  return [...source.binds];
}

type BindOwner = {
  path: string;
  binds: string[];
  makePatch: (binds: string[]) => Record<string, unknown>;
};

function dockerFromSandbox(sandbox: unknown): Record<string, unknown> | null {
  const sandboxRecord = readRecord(sandbox);
  return readRecord(sandboxRecord?.docker) ?? null;
}

function resolveDefaultsBindOwner(agents: Record<string, unknown>): BindOwner | null {
  const defaults = readRecord(agents.defaults);
  const sandbox = readRecord(defaults?.sandbox);
  const path = "agents.defaults.sandbox.docker.binds";
  const docker = dockerFromSandbox(sandbox);
  const binds = readBindList(docker, path);
  return docker && binds
    ? {
        path,
        binds,
        makePatch: (nextBinds) => ({
          agents: { defaults: { sandbox: { docker: { binds: nextBinds } } } },
        }),
      }
    : null;
}

function resolveAuthoredAgentBindOwner(params: {
  agents: Record<string, unknown>;
  agentId: string;
}): BindOwner | null {
  const normalizedAgentId = safeAgentId(params.agentId);
  if (!normalizedAgentId) {
    return null;
  }

  // readAgentRosterProperty gives agents.entries precedence over agents.list;
  // mirror that source ownership rule before constructing a patch.
  const entries = readRecord(params.agents.entries);
  if (entries) {
    const entryKey = Object.keys(entries).find(
      (candidate) => safeAgentId(candidate) === normalizedAgentId,
    );
    if (!entryKey) {
      return null;
    }
    const entry = readRecord(entries[entryKey]);
    const path = `agents.entries.${entryKey}.sandbox.docker.binds`;
    const docker = dockerFromSandbox(entry?.sandbox);
    const binds = readBindList(docker, path);
    return docker && binds
      ? {
          path,
          binds,
          makePatch: (nextBinds) => ({
            agents: {
              entries: { [entryKey]: { sandbox: { docker: { binds: nextBinds } } } },
            },
          }),
        }
      : null;
  }

  const list = Array.isArray(params.agents.list) ? params.agents.list : [];
  const listIndex = list.findIndex((candidate) => {
    const entry = readRecord(candidate);
    return entry && typeof entry.id === "string" && safeAgentId(entry.id) === normalizedAgentId;
  });
  if (listIndex < 0) {
    return null;
  }
  const entry = readRecord(list[listIndex]);
  const entryId = typeof entry?.id === "string" ? entry.id : null;
  const path = "agents.list[].sandbox.docker.binds";
  const docker = dockerFromSandbox(entry?.sandbox);
  const binds = readBindList(docker, path);
  return entryId && docker && binds
    ? {
        path,
        binds,
        makePatch: (nextBinds) => ({
          agents: {
            list: [{ id: entryId, sandbox: { docker: { binds: nextBinds } } }],
          },
        }),
      }
    : null;
}

function resolveBindOwners(params: {
  sourceConfig: Record<string, unknown>;
  agentId: string;
  scope: SandboxExplainResult["sandbox"]["scope"];
}): BindOwner[] {
  const agents = readRecord(params.sourceConfig.agents);
  if (!agents) {
    return [];
  }

  if (params.scope === "shared") {
    const defaultsOwner = resolveDefaultsBindOwner(agents);
    return defaultsOwner ? [defaultsOwner] : [];
  }

  const owners: BindOwner[] = [];
  const authoredOwner = resolveAuthoredAgentBindOwner({
    agents,
    agentId: params.agentId,
  });
  if (authoredOwner) {
    owners.push(authoredOwner);
  }
  return owners;
}

type ParsedBind = {
  host: string;
  container: string;
  options: string;
};

function parseBindSpec(spec: string): ParsedBind | null {
  const trimmed = spec.trim();
  const drivePrefix = /^[A-Za-z]:[\\/]/.test(trimmed) ? 2 : 0;
  const separator = trimmed.indexOf(":", drivePrefix);
  if (separator < 0) {
    return null;
  }
  const host = trimmed.slice(0, separator).trim();
  const rest = trimmed.slice(separator + 1);
  const optionsStart = rest.indexOf(":");
  if (optionsStart < 0) {
    return { host, container: rest.trim(), options: "" };
  }
  return {
    host,
    container: rest.slice(0, optionsStart).trim(),
    options: rest.slice(optionsStart + 1),
  };
}

function stripWindowsNamespacePrefix(input: string): string {
  if (input.startsWith("\\\\?\\")) {
    const withoutPrefix = input.slice(4);
    if (withoutPrefix.toUpperCase().startsWith("UNC\\")) {
      return `\\\\${withoutPrefix.slice(4)}`;
    }
    return withoutPrefix;
  }
  if (input.startsWith("//?/")) {
    const withoutPrefix = input.slice(4);
    if (withoutPrefix.toUpperCase().startsWith("UNC/")) {
      return `//${withoutPrefix.slice(4)}`;
    }
    return withoutPrefix;
  }
  return input;
}

function normalizePathSegments(value: string): string {
  const drive = /^([A-Za-z]):(?=\/|$)/.exec(value);
  const prefix = drive ? `${drive[1]!.toUpperCase()}:` : "";
  const rest = drive ? value.slice(2) : value;
  const absolute = rest.startsWith("/");
  const segments: string[] = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (prefix) {
    return joined ? `${prefix}/${joined}` : `${prefix}/`;
  }
  if (absolute) {
    return joined ? `/${joined}` : "/";
  }
  return joined || ".";
}

/**
 * Mirrors the backend's lexical bind normalization. This deliberately does
 * not resolve symlinks: the report and config are compared by representation,
 * while the backend remains the authority for real filesystem identity.
 */
function normalizeHostPathForComparison(raw: string): string | null {
  const stripped = stripWindowsNamespacePrefix(raw.trim());
  if (!stripped) {
    return "/";
  }
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(stripped) || stripped.startsWith("\\\\");
  const slashNormalized = windowsStyle ? stripped.replaceAll("\\", "/") : stripped;
  if (!slashNormalized.startsWith("/") && !/^[A-Za-z]:\//.test(slashNormalized)) {
    return null;
  }
  const normalized = normalizePathSegments(slashNormalized);
  return /^[A-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function normalizeContainerPathForComparison(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  return normalizePathSegments(trimmed);
}

function matchesShareMount(bind: string, mount: AccessMapShareMount): boolean {
  const parsed = parseBindSpec(bind);
  if (!parsed) {
    return false;
  }
  const host = normalizeHostPathForComparison(parsed.host);
  const mountHost = normalizeHostPathForComparison(mount.hostRoot);
  const container = normalizeContainerPathForComparison(parsed.container);
  const mountContainer = normalizeContainerPathForComparison(mount.containerRoot);
  if (!host || !mountHost || !container || !mountContainer) {
    return false;
  }
  if (host !== mountHost || container !== mountContainer) {
    return false;
  }
  const readOnly = parsed.options.split(",").some((option) => option.trim().toLowerCase() === "ro");
  return mount.writable ? !readOnly : readOnly;
}

/**
 * Removes one exact bind through the RuntimeConfigCapability owner. The
 * config.get and base hash are acquired inside the serialized mutation so a
 * stale page cannot rewrite another owner's bind list.
 */
export async function removeSharedBind(
  expectedClient: GatewayBrowserClient,
  report: SandboxExplainResult,
  mount: AccessMapShareMount,
  runtimeConfig: AccessMapConfigWriter,
  canDispatch?: () => boolean,
): Promise<RemoveSharedBindResult> {
  if (mount.source !== "bind") {
    throw new Error("Only configured shared binds can be removed.");
  }

  const dispatchAllowed = () =>
    runtimeConfig.canPatch !== false && (canDispatch ? canDispatch() : true);
  const mutation = await runtimeConfig.runExternalMutation(
    async (client) => {
      if (client !== expectedClient) {
        throw new Error("Connection changed before the shared bind update started.");
      }
      const snapshot = await client.request<ConfigSnapshot>("config.get", {});
      // Owner selection must use the authored source, never the resolved
      // projection: defaults and agent rows have different write ownership.
      const sourceConfig = asConfigRecord(snapshot.sourceConfig);
      if (!sourceConfig) {
        throw new Error(
          "Authoritative source configuration is unavailable; refresh and try again.",
        );
      }
      const owners = resolveBindOwners({
        sourceConfig,
        agentId: report.agentId,
        scope: report.sandbox.scope,
      });
      const agents = readRecord(sourceConfig.agents);
      const defaultsOwner = agents ? resolveDefaultsBindOwner(agents) : null;
      if (
        report.sandbox.scope !== "shared" &&
        defaultsOwner?.binds.some((bind) => matchesShareMount(bind, mount))
      ) {
        throw new Error(
          "This share is inherited from global sandbox settings. Change it there to update all agents.",
        );
      }
      const matchingBinds = owners.flatMap((owner) =>
        owner.binds.flatMap((bind, index) =>
          matchesShareMount(bind, mount) ? [{ owner, index }] : [],
        ),
      );
      if (matchingBinds.length > 1) {
        throw new Error(
          "This bind has more than one configured match; remove it in configuration.",
        );
      }
      const match = matchingBinds[0];
      if (!match) {
        throw new Error("The configured owner for this shared bind is unavailable.");
      }
      const { owner, index } = match;
      const baseHash = snapshot.hash?.trim();
      if (!baseHash) {
        throw new Error("Config hash missing; refresh and retry.");
      }
      if (!dispatchAllowed()) {
        throw new Error("Access changed before the shared bind update was sent.");
      }
      const nextBinds = [...owner.binds];
      nextBinds.splice(index, 1);
      await client.request("config.patch", {
        raw: JSON.stringify(owner.makePatch(nextBinds)),
        baseHash,
        replacePaths: [owner.path],
        note: "Remove sandbox shared bind",
      });
      return { removed: true };
    },
    {
      canDispatch: dispatchAllowed,
      dispatchError: "Access changed before the shared bind update started.",
    },
  );
  if (!mutation.ok) {
    throw new Error(mutation.error);
  }
  return {
    ...mutation.value,
    refreshWarning: mutation.refresh.ok ? null : mutation.refresh.error,
  };
}
