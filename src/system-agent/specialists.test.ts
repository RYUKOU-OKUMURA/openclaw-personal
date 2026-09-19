import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  describeSystemAgentPersistentOperation,
  isPersistentSystemAgentOperation,
} from "./operations-parse.js";
import { hashSystemAgentOperation } from "./operator-approval.js";
import { createSpecialist, prepareSpecialistOperation, specialistEntry } from "./specialists.js";

const mocks = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  hash: "hash",
  createAgent: vi.fn(),
}));
vi.mock("../config/config.js", async (original) => ({
  ...(await original<typeof import("../config/config.js")>()),
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: { valid: true, hash: mocks.hash, config: mocks.config },
    writeOptions: {},
  }),
}));
vi.mock("../agents/agent-create.js", () => ({ createAgent: mocks.createAgent }));
let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "specialists-test-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  mocks.hash = "hash";
  mocks.createAgent.mockReset();
  mocks.config = {
    agents: {
      defaults: {
        subagents: { model: "openai/gpt-4.1" },
        sandbox: { mode: "all", sessionToolsVisibility: "all" },
      },
      list: [{ id: "main", tools: { alsoAllow: ["specialists"] } }, { id: "gbp" }],
    },
    tools: {
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true, allow: ["main", "gbp"] },
    },
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(stateDir, { recursive: true, force: true });
});
const proposal = () =>
  prepareSpecialistOperation(
    mocks.config,
    "hash",
    "main",
    "分析担当",
    "Analyze anonymized responses",
  );

describe("managed specialist creation", () => {
  it("has an exact human-readable approval covering role, route, peer registration and snapshot", () => {
    const op = proposal();
    expect(isPersistentSystemAgentOperation(op)).toBe(true);
    const plan = describeSystemAgentPersistentOperation(op);
    for (const text of [op.name, op.role, "専用", "相互連絡", "外部公開", "main", "gbp"]) {
      expect(plan).toContain(text);
    }
    for (const changed of [
      { role: "Other" },
      { name: "Other" },
      { model: "other/model" },
      { configHash: "changed" },
      { peerAgentIds: ["main"] },
    ]) {
      expect(hashSystemAgentOperation({ ...op, ...changed })).not.toBe(
        hashSystemAgentOperation(op),
      );
    }
  });
  it("resolves a separate networkless workspace and cannot regain management/publication through peer tools", () => {
    const op = proposal(),
      entry = specialistEntry(op);
    const config = {
      ...mocks.config,
      agents: { ...mocks.config.agents, list: [...mocks.config.agents!.list!, entry] },
    };
    const sandbox = resolveSandboxConfigForAgent(config, entry.id);
    expect(sandbox).toMatchObject({
      mode: "all",
      scope: "agent",
      workspaceAccess: "rw",
      docker: { network: "none", readOnlyRoot: true, capDrop: ["ALL"] },
      browser: { enabled: false },
    });
    expect(sandbox.docker.binds).toBeUndefined();
    expect(entry.workspace).toBe(join(stateDir, `workspace-${op.agentId}`));
    expect(entry.tools.fs.workspaceOnly).toBe(true);
    expect(entry.tools.allow).toContain("sessions_send");
    for (const name of [
      "specialists",
      "openclaw",
      "gateway",
      "exec",
      "sessions_spawn",
      "session_status",
      "view_image",
      "gbp_*",
      "wp_article_*",
    ]) {
      expect(entry.tools.deny).toContain(name);
      expect(entry.tools.allow).not.toContain(name);
    }
    expect(entry.model).toEqual({ primary: "openai/gpt-4.1", fallbacks: [] });
  });
  it("rejects unsafe inherited mounts/environment/setup and unbounded peer routing", () => {
    for (const docker of [
      { binds: ["/private:/private:ro"] },
      { env: { TOKEN: "synthetic" } },
      { setupCommand: "echo unsafe" },
    ]) {
      const cfg = structuredClone(mocks.config);
      cfg.agents!.defaults!.sandbox!.docker = docker;
      expect(() => prepareSpecialistOperation(cfg, "hash", "main", "Name", "Role")).toThrow();
    }
    for (const allow of [undefined, ["*"], ["gbp"]]) {
      const cfg = structuredClone(mocks.config);
      cfg.tools!.agentToAgent!.allow = allow;
      expect(() => prepareSpecialistOperation(cfg, "hash", "main", "Name", "Role")).toThrow();
    }
    delete mocks.config.agents!.defaults!.subagents;
    expect(proposal).toThrow("verified subagent model");
  });
  it.each(["commit", "rollback"] as const)(
    "preserves confinement and role-file ownership on config %s",
    async (outcome) => {
      const op = proposal(),
        guard = vi.fn();
      mocks.createAgent.mockImplementation(async (params) => {
        expect(params.stagedConfig.writeSnapshot.snapshot.hash).toBe("hash");
        expect(params.stagedConfig.config.tools.agentToAgent.allow).toEqual(op.peerAgentIds);
        expect(params.entry).toEqual(specialistEntry(op));
        expect(params.provenance).toEqual({ createdVia: "agent", creatorAgentId: "main" });
        expect(params.beforePersistentApply).toBe(guard);
        await mkdir(params.entry.workspace);
        const receipt = await params.prepareConfigCommit();
        expect(await readFile(join(params.entry.workspace, "AGENTS.md"), "utf8")).toContain(
          op.role,
        );
        await receipt[outcome]();
        if (outcome === "rollback") {
          await expect(readFile(join(params.entry.workspace, "AGENTS.md"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          expect(await readFile(join(params.entry.workspace, "AGENTS.md"), "utf8")).toContain(
            op.role,
          );
        }
        return { status: "created", agentId: op.agentId };
      });
      await createSpecialist(op, guard);
      expect(guard).toHaveBeenCalled();
      expect(mocks.createAgent).toHaveBeenCalledTimes(1);
    },
  );
  it("does not enter creation after a changed snapshot, altered proposal, or pre-existing workspace", async () => {
    const op = proposal();
    mocks.hash = "changed";
    await expect(createSpecialist(op, () => {})).rejects.toThrow("Configuration changed");
    mocks.hash = "hash";
    await expect(createSpecialist({ ...op, model: "other/model" }, () => {})).rejects.toThrow(
      "no longer matches",
    );
    await mkdir(specialistEntry(op).workspace);
    await expect(createSpecialist(op, () => {})).rejects.toThrow("workspace already exists");
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
  it("revalidates the live approval before writing the role document", async () => {
    mocks.createAgent.mockImplementation(async (params) => {
      await mkdir(params.entry.workspace);
      await params.prepareConfigCommit();
    });
    const op = proposal();
    await expect(
      createSpecialist(op, () => {
        throw new Error("retired");
      }),
    ).rejects.toThrow("retired");
    await expect(readFile(join(specialistEntry(op).workspace, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
