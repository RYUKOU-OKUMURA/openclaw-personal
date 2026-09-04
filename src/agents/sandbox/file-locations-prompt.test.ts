import { describe, expect, it } from "vitest";
import { buildSandboxFileLocationsPrompt } from "./file-locations-prompt.js";
import type { SandboxContext } from "./types.js";

function createSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  const base = {
    enabled: true,
    backendId: "docker",
    sessionKey: "session:test",
    workspaceDir: "/tmp/openclaw-sandbox",
    agentWorkspaceDir: "/tmp/openclaw-agent",
    workspaceAccess: "rw",
    runtimeId: "openclaw-sbx-test",
    runtimeLabel: "openclaw-sbx-test",
    containerName: "openclaw-sbx-test",
    containerWorkdir: "/workspace",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      network: "none",
      capDrop: ["ALL"],
      binds: undefined,
    },
    tools: { allow: ["exec"], deny: [] },
    browserAllowHostControl: false,
  } satisfies SandboxContext;
  return { ...base, ...overrides };
}

describe("sandbox file-location prompt", () => {
  it("does not project disabled sandboxes", () => {
    expect(buildSandboxFileLocationsPrompt(createSandbox({ enabled: false }))).toBeUndefined();
    expect(buildSandboxFileLocationsPrompt()).toBeUndefined();
  });

  it("lists effective shared bind modes without exposing host paths", () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: [
          "/host/read:/mnt/shared/脳内メモ:ro",
          "/host/write:/mnt/shared/output:rw",
          "/host/other:/mnt/other:ro",
        ],
      },
    });

    const prompt = buildSandboxFileLocationsPrompt(sandbox);
    expect(prompt).toBeDefined();
    expect(prompt).toContain('"/mnt/shared/output" — read-write');
    expect(prompt).toContain('"/mnt/shared/脳内メモ" — read-only');
    expect(prompt).toContain(
      'Deliverables: save under "/workspace/outputs". If it does not exist, create it when saving',
    );
    expect(prompt).not.toContain("/host/read");
    expect(prompt).not.toContain("/host/write");
  });

  it("does not advertise outputs as writable for a read-only workspace", () => {
    const sandbox = createSandbox({
      workspaceAccess: "ro",
      docker: {
        ...createSandbox().docker,
        binds: ["/host/read:/mnt/shared/脳内メモ:ro"],
      },
    });

    const prompt = buildSandboxFileLocationsPrompt(sandbox);
    expect(prompt).toContain('"/mnt/shared/脳内メモ" — read-only');
    expect(prompt).toContain(
      'Deliverables path "/workspace/outputs" is not writable in this sandbox; do not write there.',
    );
    expect(prompt).not.toContain("create it when saving");
  });

  it("JSON-encodes path names and bounds the shared-bind list", () => {
    const binds = Array.from(
      { length: 20 },
      (_, index) => `/host/${index}:/mnt/shared/item-${index}:ro`,
    );
    binds.push("/host/newline:/mnt/shared/line\nbreak:ro");
    const sandbox = createSandbox({
      docker: { ...createSandbox().docker, binds },
    });

    const prompt = buildSandboxFileLocationsPrompt(sandbox);
    expect(prompt).toBeDefined();
    expect(prompt?.match(/— read-only/g) ?? []).toHaveLength(16);
    expect(prompt?.length).toBeLessThanOrEqual(4096);
    expect(prompt).toContain("additional shared bind(s) omitted");
    expect(prompt).toContain('Use filesystem tools to inspect "/mnt/shared/"');

    const newlinePrompt = buildSandboxFileLocationsPrompt(
      createSandbox({
        docker: {
          ...createSandbox().docker,
          binds: ["/host/newline:/mnt/shared/line\nbreak:ro"],
        },
      }),
    );
    expect(newlinePrompt).toContain('"/mnt/shared/line\\nbreak" — read-only');
    expect(newlinePrompt).not.toContain("/mnt/shared/line\nbreak");
  });

  it("omits overlong actionable paths instead of shortening them", () => {
    const longSharedPath = `/mnt/shared/${"shared-".repeat(24)}`;
    const longWorkdir = `/workspace/${"workdir-".repeat(24)}`;
    const prompt = buildSandboxFileLocationsPrompt(
      createSandbox({
        containerWorkdir: longWorkdir,
        docker: {
          ...createSandbox().docker,
          binds: [`/host/read:${longSharedPath}:ro`],
        },
      }),
    );

    expect(prompt).toContain(
      `Deliverables: save under the sandbox working directory's "outputs" directory when writable`,
    );
    expect(prompt).toContain("Some paths were omitted for prompt size");
    expect(prompt).not.toContain(longSharedPath);
    expect(prompt).not.toContain(`${longWorkdir}/outputs`);
    expect(prompt).not.toContain("...");
  });

  it.each(["\u2028", "\u2029", "\u202e", "\u200b", "\u{e0001}"])(
    "escapes prompt-unsafe Unicode losslessly (%j)",
    (control) => {
      const sharedPath = `/mnt/shared/start${control}end`;
      const prompt = buildSandboxFileLocationsPrompt(
        createSandbox({
          docker: { ...createSandbox().docker, binds: [`/host/read:${sharedPath}:ro`] },
        }),
      );
      expect(prompt).not.toContain(control);
      const quoted = prompt
        ?.split("\n")
        .find((line) => line.startsWith('- "'))
        ?.slice(2)
        .split(" — ")[0];
      expect(JSON.parse(quoted ?? "null")).toBe(sharedPath);
    },
  );

  it("keeps remote locations outside the local file-browser guidance", () => {
    const sandbox = createSandbox({
      backendId: "ssh",
      containerWorkdir: "/srv/private/runtime-id/workspace",
      docker: {
        ...createSandbox().docker,
        binds: ["/host/read:/mnt/shared/脳内メモ:ro"],
      },
    });

    const prompt = buildSandboxFileLocationsPrompt(sandbox);
    expect(prompt).toBeUndefined();
  });
});
