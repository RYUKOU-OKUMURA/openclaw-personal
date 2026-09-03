/**
 * Sandbox explanation command.
 *
 * It resolves the effective sandbox/tool/elevated policy for an agent session
 * and prints either JSON or a human-readable fix-it report.
 */
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import {
  buildSandboxExplainReport,
  type SandboxExplainReport,
} from "../agents/sandbox/explain-report.js";
import { getRuntimeConfig } from "../config/config.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type SandboxExplainOptions = {
  session?: string;
  agent?: string;
  json: boolean;
};

/** Prints the effective sandbox policy for a session or agent. */
export async function sandboxExplainCommand(
  opts: SandboxExplainOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = getRuntimeConfig();
  const payload: SandboxExplainReport = buildSandboxExplainReport({
    cfg,
    agentId: opts.agent,
    sessionKey: opts.session,
  });

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  const rich = isRich();
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const key = (value: string) => colorize(rich, theme.muted, value);
  const value = (val: string) => colorize(rich, theme.info, val);
  const ok = (val: string) => colorize(rich, theme.success, val);
  const warn = (val: string) => colorize(rich, theme.warn, val);
  const err = (val: string) => colorize(rich, theme.error, val);
  const bool = (flag: boolean) => (flag ? ok("true") : err("false"));

  const lines: string[] = [];
  lines.push(heading("Effective sandbox:"));
  lines.push(`  ${key("agentId:")} ${value(payload.agentId)}`);
  lines.push(`  ${key("sessionKey:")} ${value(payload.sessionKey)}`);
  lines.push(`  ${key("mainSessionKey:")} ${value(payload.mainSessionKey)}`);
  lines.push(
    `  ${key("runtime:")} ${payload.sandbox.sessionIsSandboxed ? warn("sandboxed") : ok("direct")}`,
  );
  lines.push(
    `  ${key("mode:")} ${value(payload.sandbox.mode)} ${key("scope:")} ${value(
      payload.sandbox.scope,
    )}`,
  );
  lines.push(
    `  ${key("workspaceAccess:")} ${value(
      payload.sandbox.workspaceAccess,
    )} ${key("workspaceRoot:")} ${value(payload.sandbox.workspaceRoot)}`,
  );
  lines.push(
    `  ${key("effectiveHostWorkspaceRoot:")} ${value(payload.sandbox.effectiveHostWorkspaceRoot)}`,
  );
  lines.push(
    `  ${key("backend:")} ${value(payload.sandbox.backend)} ${key("runtimeWorkdir:")} ${value(
      payload.sandbox.runtimeWorkdir ?? "(direct host)",
    )} ${key("workspaceSource:")} ${value(payload.sandbox.workspaceSource)}`,
  );
  if (payload.sandbox.workspaceMounts.length > 0) {
    lines.push(`  ${key("workspaceMounts:")}`);
    for (const mount of payload.sandbox.workspaceMounts) {
      lines.push(
        `    - ${value(mount.hostRoot)} -> ${value(mount.containerRoot)} ${key(
          mount.writable ? "rw" : "ro",
        )} ${key(`(${mount.source})`)}`,
      );
    }
  }
  lines.push("");
  lines.push(heading("Sandbox tool policy:"));
  lines.push(
    `  ${key(`allow (${payload.sandbox.tools.sources.allow.source}):`)} ${value(
      payload.sandbox.tools.allow.join(", ") || "(empty)",
    )}`,
  );
  lines.push(
    `  ${key(`deny  (${payload.sandbox.tools.sources.deny.source}):`)} ${value(
      payload.sandbox.tools.deny.join(", ") || "(empty)",
    )}`,
  );
  lines.push("");
  lines.push(heading("Elevated:"));
  lines.push(`  ${key("enabled:")} ${bool(payload.elevated.enabled)}`);
  lines.push(`  ${key("channel:")} ${value(payload.elevated.channel ?? "(unknown)")}`);
  lines.push(`  ${key("allowedByConfig:")} ${bool(payload.elevated.allowedByConfig)}`);
  if (payload.elevated.failures.length > 0) {
    lines.push(
      `  ${key("failing gates:")} ${warn(
        payload.elevated.failures.map((f) => `${f.gate} (${f.key})`).join(", "),
      )}`,
    );
  }
  if (payload.sandbox.mode === "non-main" && payload.sandbox.sessionIsSandboxed) {
    lines.push("");
    lines.push(
      `${warn("Hint:")} sandbox mode is non-main; use main session key to run direct: ${value(
        payload.mainSessionKey,
      )}`,
    );
  }
  lines.push("");
  lines.push(heading("Fix-it:"));
  for (const keyLocal of payload.fixIt) {
    lines.push(`  - ${keyLocal}`);
  }
  lines.push("");
  lines.push(`${key("Docs:")} ${formatDocsLink("/sandbox", "docs.openclaw.ai/sandbox")}`);

  runtime.log(`${lines.join("\n")}\n`);
}
