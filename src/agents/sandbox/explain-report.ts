import {
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
  normalizeStringifiedEntries,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import {
  resolveAgentMainSessionKey,
  resolveSessionStorePathCore,
  type SessionEntry,
} from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import {
  resolveAgentConfig,
  resolveConfiguredAgentId,
  resolveSessionAgentId,
  resolveAgentWorkspaceDir,
} from "../agent-scope.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../spawned-context.js";
import { getSandboxBackendWorkdirResolver } from "./backend.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { buildSandboxFsMounts } from "./fs-paths.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./shared.js";
import { resolveSandboxToolPolicyForAgent } from "./tool-policy.js";

const SANDBOX_DOCS_URL = "https://docs.openclaw.ai/sandbox";

type BuildSandboxExplainReportParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
};

function normalizeExplainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  session?: string;
}): string {
  const raw = (params.session ?? "").trim();
  if (!raw) {
    return resolveAgentMainSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
    });
  }
  if (raw.includes(":")) {
    // Fully-qualified session keys are already scoped; only short names need
    // agent/main-key expansion.
    return raw;
  }
  if (raw === "global") {
    return "global";
  }
  return buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: normalizeMainKey(raw),
  });
}

function inferProviderFromSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): string | undefined {
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed) {
    return undefined;
  }
  const rest = parsed.rest.trim();
  if (!rest) {
    return undefined;
  }
  const parts = rest.split(":").filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const configuredMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (parts[0] === configuredMainKey) {
    return undefined;
  }
  // Legacy session keys embedded provider/channel in the first segment after
  // agent id; use that as a fallback when the session store lacks channel data.
  const candidate = normalizeOptionalLowercaseString(parts[0]);
  if (!candidate) {
    return undefined;
  }
  if (candidate === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  return normalizeAnyChannelId(candidate) ?? undefined;
}

function resolveActiveChannel(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  sessionKey: string;
}): string | undefined {
  const candidate = (sessionDeliveryChannel(params.entry) ?? "").trim();
  const normalizedCandidate = normalizeOptionalLowercaseString(candidate);
  if (!normalizedCandidate) {
    // Empty canonical delivery can still be recovered from the session key.
    return inferProviderFromSessionKey({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
  }
  if (normalizedCandidate === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  const normalized = normalizeAnyChannelId(normalizedCandidate);
  if (normalized) {
    return normalized;
  }
  return inferProviderFromSessionKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
}

export function resolveSandboxExplainContext({
  cfg,
  agentId,
  sessionKey: requestedSessionKey,
}: BuildSandboxExplainReportParams) {
  const requestedSession = requestedSessionKey?.trim();
  const requestedAgent = agentId?.trim();
  if (agentId !== undefined && !requestedAgent) {
    throw new Error("--agent must not be blank");
  }
  const requestedAgentId = requestedAgent ? normalizeAgentId(requestedAgent) : undefined;
  const sessionAgentId =
    requestedSession && requestedSession !== "global" && requestedSession.includes(":")
      ? normalizeAgentId(resolveAgentIdFromSessionKey(requestedSession))
      : undefined;
  if (requestedAgentId && sessionAgentId && requestedAgentId !== sessionAgentId) {
    throw new Error(
      `Sandbox explain agent "${requestedAgentId}" does not match session agent "${sessionAgentId}".`,
    );
  }
  if (requestedAgentId) {
    resolveConfiguredAgentId(cfg, requestedAgentId);
  }
  const resolvedAgentId = resolveSessionAgentId({
    sessionKey: requestedSession,
    config: cfg,
    agentId: requestedAgentId,
  });

  const sessionKey = normalizeExplainSessionKey({
    cfg,
    agentId: resolvedAgentId,
    session: requestedSessionKey,
  });

  const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, resolvedAgentId);
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey,
    agentId: resolvedAgentId,
    classificationAgentId: resolvedAgentId,
  });
  const configuredSandbox = resolveSandboxConfigForAgent(cfg, resolvedAgentId);
  const sandboxCfg = sandboxRuntime.sandboxRequired
    ? {
        ...configuredSandbox,
        scope: "agent" as const,
        workspaceAccess: sandboxRuntime.workspaceAccess,
      }
    : configuredSandbox;
  const mainSessionKey = sandboxRuntime.mainSessionKey;
  const sessionIsSandboxed = sandboxRuntime.sandboxed;
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: resolvedAgentId,
  });
  // CLI reads must not join the Gateway's writable SQLite lifecycle (#101290).
  const sessionEntry = loadSessionEntryReadOnly({
    agentId: resolvedAgentId,
    sessionKey,
    storePath,
  });

  const agentConfig = resolveAgentConfig(cfg, resolvedAgentId);
  // Spawned sessions persist their inherited workspace and direct-mode cwd so
  // later turns keep running in the same location. Explain must mirror those
  // overrides or its effective paths point at a different runtime.
  const configuredWorkspaceDir = resolveAgentWorkspaceDir(cfg, resolvedAgentId);
  const sessionWorkspaceDir = resolveIngressWorkspaceOverrideForSessionRun({
    spawnedBy: sessionEntry?.spawnedBy,
    workspaceDir: sessionEntry?.spawnedWorkspaceDir,
    cwd: sessionEntry?.spawnedCwd,
  });
  const effectiveAgentWorkspaceDir = sessionWorkspaceDir ?? configuredWorkspaceDir;
  const directRuntimeCwd =
    normalizeOptionalString(sessionEntry?.spawnedCwd) ?? effectiveAgentWorkspaceDir;
  const workspaceLayout = resolveSandboxWorkspaceLayoutPaths({
    cfg: sandboxCfg,
    agentId: resolvedAgentId,
    isolationSubject: sandboxRuntime.isolationSubject,
    rawSessionKey:
      sessionKey === "global"
        ? buildAgentMainSessionKey({
            agentId: resolvedAgentId,
            mainKey: normalizeMainKey(cfg.session?.mainKey),
          })
        : sessionKey,
    workspaceDir: effectiveAgentWorkspaceDir,
  });
  const sandboxWorkdir = getSandboxBackendWorkdirResolver(sandboxCfg.backend)?.({
    sessionKey,
    scopeKey: workspaceLayout.scopeKey,
    workspaceDir: workspaceLayout.workspaceDir,
    agentWorkspaceDir: workspaceLayout.agentWorkspaceDir,
    skillsWorkspaceDir: workspaceLayout.skillsWorkspaceDir,
    cfg: sandboxCfg,
  });
  const effectiveHostWorkspaceRoot = sessionIsSandboxed
    ? workspaceLayout.workspaceDir
    : workspaceLayout.agentWorkspaceDir;
  const runtimeWorkdir = sessionIsSandboxed ? sandboxWorkdir : directRuntimeCwd;
  const workspaceSource = sessionIsSandboxed ? workspaceLayout.workspaceSource : "direct";
  const usesLocalContainerMounts =
    sandboxCfg.backend.toLowerCase() === "docker" || sandboxCfg.backend.toLowerCase() === "podman";
  const workspaceMounts =
    sessionIsSandboxed && usesLocalContainerMounts && sandboxWorkdir
      ? buildSandboxFsMounts({
          workspaceDir: workspaceLayout.workspaceDir,
          agentWorkspaceDir: workspaceLayout.agentWorkspaceDir,
          skillsWorkspaceDir: workspaceLayout.skillsWorkspaceDir,
          workspaceAccess: sandboxCfg.workspaceAccess,
          containerName: "",
          containerWorkdir: sandboxWorkdir,
          docker: sandboxCfg.docker,
        })
      : [];

  const channel = resolveActiveChannel({
    cfg,
    entry: sessionEntry,
    sessionKey,
  });

  const elevatedGlobal = cfg.tools?.elevated;
  const elevatedAgent = agentConfig?.tools?.elevated;
  const elevatedGlobalEnabled = elevatedGlobal?.enabled !== false;
  const elevatedAgentEnabled = elevatedAgent?.enabled !== false;
  const elevatedEnabled = elevatedGlobalEnabled && elevatedAgentEnabled;

  const globalAllow = channel ? elevatedGlobal?.allowFrom?.[channel] : undefined;
  const agentAllow = channel ? elevatedAgent?.allowFrom?.[channel] : undefined;

  const allowTokens = (values?: Array<string | number>) => normalizeStringifiedEntries(values);
  const globalAllowTokens = allowTokens(globalAllow);
  const agentAllowTokens = allowTokens(agentAllow);

  const elevatedAllowedByConfig =
    elevatedEnabled &&
    Boolean(channel) &&
    globalAllowTokens.length > 0 &&
    (elevatedAgent?.allowFrom ? agentAllowTokens.length > 0 : true);

  const elevatedAlwaysAllowedByConfig =
    elevatedAllowedByConfig &&
    globalAllowTokens.includes("*") &&
    (elevatedAgent?.allowFrom ? agentAllowTokens.includes("*") : true);

  const elevatedFailures: Array<{ gate: string; key: string }> = [];
  // Track each failed gate separately so the human report points at concrete
  // config keys instead of only saying elevated access is disabled.
  if (!elevatedGlobalEnabled) {
    elevatedFailures.push({ gate: "enabled", key: "tools.elevated.enabled" });
  }
  if (!elevatedAgentEnabled) {
    elevatedFailures.push({
      gate: "enabled",
      key: "agents.entries.*.tools.elevated.enabled",
    });
  }
  if (channel && globalAllowTokens.length === 0) {
    elevatedFailures.push({
      gate: "allowFrom",
      key: `tools.elevated.allowFrom.${channel}`,
    });
  }
  if (channel && elevatedAgent?.allowFrom && agentAllowTokens.length === 0) {
    elevatedFailures.push({
      gate: "allowFrom",
      key: `agents.entries.*.tools.elevated.allowFrom.${channel}`,
    });
  }

  const fixIt: string[] = [];
  if (sandboxCfg.mode !== "off") {
    fixIt.push("agents.defaults.sandbox.mode=off");
    fixIt.push("agents.entries.*.sandbox.mode=off");
  }
  fixIt.push("tools.sandbox.tools.allow");
  fixIt.push("tools.sandbox.tools.alsoAllow");
  fixIt.push("tools.sandbox.tools.deny");
  fixIt.push("agents.entries.*.tools.sandbox.tools.allow");
  fixIt.push("agents.entries.*.tools.sandbox.tools.alsoAllow");
  fixIt.push("agents.entries.*.tools.sandbox.tools.deny");
  fixIt.push("tools.elevated.enabled");
  if (channel) {
    fixIt.push(`tools.elevated.allowFrom.${channel}`);
  }

  return {
    report: {
      docsUrl: SANDBOX_DOCS_URL,
      agentId: resolvedAgentId,
      sessionKey,
      mainSessionKey,
      sandbox: {
        mode: sandboxCfg.mode,
        scope: sandboxCfg.scope,
        backend: sandboxCfg.backend,
        workspaceAccess: sandboxCfg.workspaceAccess,
        workspaceRoot: sandboxCfg.workspaceRoot,
        effectiveHostWorkspaceRoot,
        runtimeWorkdir,
        workspaceMounts,
        workspaceSource,
        sessionIsSandboxed,
        tools: {
          allow: toolPolicy.allow,
          deny: toolPolicy.deny,
          sources: toolPolicy.sources,
        },
      },
      elevated: {
        enabled: elevatedEnabled,
        channel,
        allowedByConfig: elevatedAllowedByConfig,
        alwaysAllowedByConfig: elevatedAlwaysAllowedByConfig,
        allowFrom: {
          global: channel ? globalAllowTokens : undefined,
          agent: elevatedAgent?.allowFrom && channel ? agentAllowTokens : undefined,
        },
        failures: elevatedFailures,
      },
      fixIt,
    },
    sandboxConfig: sandboxCfg,
    workspaceLayout,
  } as const;
}

export function buildSandboxExplainReport(params: BuildSandboxExplainReportParams) {
  return resolveSandboxExplainContext(params).report;
}

export type SandboxExplainReport = ReturnType<typeof buildSandboxExplainReport>;
