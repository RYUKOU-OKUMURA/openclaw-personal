// Approved locations must be browsable without turning root ids into host path grants.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenPathCommand } from "./open-path.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectError,
  expectOkPayload,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
  writeWorkspaceFile,
} from "./sessions-files.test-support.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readSessionTranscriptVisibleMessageDeltaCore: vi.fn(),
  buildSandboxExplainReport: vi.fn(),
}));
vi.mock("./open-path.js", async (original) => ({
  ...(await original<typeof import("./open-path.js")>()),
  execOpenPath: mocks.execOpenPath,
}));
vi.mock("../../agents/agent-scope.js", async (original) => ({
  ...(await original<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));
vi.mock("../session-utils.js", async (original) => ({
  ...(await original<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnly: mocks.loadSessionEntry,
}));
vi.mock("../session-transcript-readers.js", async (original) => ({
  ...(await original<typeof import("../session-transcript-readers.js")>()),
  readSessionTranscriptVisibleMessageDeltaCore: mocks.readSessionTranscriptVisibleMessageDeltaCore,
}));
vi.mock("../../agents/sandbox/explain-report.js", () => ({
  buildSandboxExplainReport: mocks.buildSandboxExplainReport,
}));

const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const admin = { connect: { scopes: ["operator.admin"] } } as GatewayClient;
const sessionKey = "agent:main:main";
const visibleMessages = createVisibleMessagesMock(
  mocks.readSessionTranscriptVisibleMessageDeltaCore,
);

describe("session file locations", () => {
  let workspace: string;
  let shared: string;
  let binds: Array<{ hostRoot: string; containerRoot: string; writable: boolean; source: "bind" }>;

  beforeEach(() => {
    workspace = prepareSessionFilesTest(mocks, visibleMessages);
    shared = fs.mkdtempSync(path.join(path.dirname(workspace), "openclaw-shared-files-"));
    writeWorkspaceFile(shared, "notes/readme.md", "Shared notes\n");
    binds = [
      { hostRoot: shared, containerRoot: "/mnt/shared/Notes", writable: false, source: "bind" },
    ];
    mocks.buildSandboxExplainReport.mockImplementation(() => ({
      sandbox: {
        backend: "docker",
        sessionIsSandboxed: true,
        effectiveHostWorkspaceRoot: workspace,
        workspaceMounts: [
          { source: "workspace", hostRoot: workspace, containerRoot: "/workspace", writable: true },
          ...binds,
        ],
      },
    }));
  });
  afterEach(() => {
    removeWorkspaceFixture(workspace);
    removeWorkspaceFixture(shared);
  });

  async function locations() {
    return expectOkPayload(await invoke("sessions.files.list", { sessionKey }, {}, admin));
  }
  async function sharedId(): Promise<string> {
    const payload = await locations();
    return payload.roots.find((root: { kind: string }) => root.kind === "shared").id;
  }

  it("lists approved shares and missing outputs without creating anything, and previews a shared file read-only", async () => {
    const payload = await locations();
    expect(payload.roots).toEqual([
      expect.objectContaining({ id: "workspace", kind: "workspace", runtimePath: "/workspace" }),
      expect.objectContaining({
        id: "outputs",
        kind: "outputs",
        runtimePath: "/workspace/outputs",
        available: false,
      }),
      expect.objectContaining({
        kind: "shared",
        name: "Notes",
        runtimePath: "/mnt/shared/Notes",
        writable: false,
        available: true,
      }),
    ]);
    expect(fs.existsSync(path.join(workspace, "outputs"))).toBe(false);
    const rootId = await sharedId();
    const listing = expectOkPayload(
      await invoke("sessions.files.list", { sessionKey, rootId, path: "notes" }, {}, admin),
    );
    expect(listing.files).toEqual([]);
    expect(listing.browser.entries).toEqual([expect.objectContaining({ path: "notes/readme.md" })]);
    const preview = expectOkPayload(
      await invoke(
        "sessions.files.get",
        { sessionKey, rootId, path: "notes/readme.md" },
        {},
        admin,
      ),
    );
    expect(preview).toMatchObject({
      root: shared,
      readOnly: true,
      file: { content: "Shared notes\n", workspacePath: "notes/readme.md" },
    });
  });

  it("keeps external locations admin-only and rejects a revoked share id", async () => {
    const rootId = await sharedId();
    expect(
      expectOkPayload(await invoke("sessions.files.list", { sessionKey })).roots,
    ).toBeUndefined();
    expect(
      expectError(
        await invoke("sessions.files.get", { sessionKey, rootId, path: "notes/readme.md" }),
      ).details.type,
    ).toBe("session_file_root_not_found");
    binds = [];
    expect(
      expectError(
        await invoke(
          "sessions.files.get",
          { sessionKey, rootId, path: "notes/readme.md" },
          {},
          admin,
        ),
      ).details.type,
    ).toBe("session_file_root_not_found");
  });

  it.each(["directory", "file"])(
    "does not launch a shared %s through the host OS",
    async (kind) => {
      if (kind === "file") {
        binds[0]!.hostRoot = path.join(shared, "notes/readme.md");
        binds[0]!.containerRoot = "/mnt/shared/readme.md";
      }
      const rootId = await sharedId();
      expect(
        expectOkPayload(
          await invoke("sessions.files.reveal", { key: sessionKey, rootId }, {}, admin),
        ),
      ).toMatchObject({ ok: false, error: "Shared locations support preview only." });
      expect(mocks.execOpenPath).not.toHaveBeenCalled();
    },
  );

  it("refuses arbitrary roots, traversal, symlinks and hardlinks without exposing unshared files", async () => {
    const rootId = await sharedId();
    for (const requestedRoot of [shared, "/", "shared:unknown"]) {
      expectError(
        await invoke("sessions.files.list", { sessionKey, rootId: requestedRoot }, {}, admin),
      );
    }
    fs.symlinkSync(path.join(workspace, "package.json"), path.join(shared, "escape.json"));
    fs.linkSync(path.join(workspace, "package.json"), path.join(shared, "hard.json"));
    for (const filePath of [
      "../package.json",
      "/etc/passwd",
      "notes/../../package.json",
      "escape.json",
      "hard.json",
    ]) {
      expectError(
        await invoke("sessions.files.get", { sessionKey, rootId, path: filePath }, {}, admin),
      );
    }
    expectError(
      await invoke(
        "sessions.files.set",
        {
          sessionKey,
          rootId,
          path: "notes/readme.md",
          content: "changed",
          expectedHash: "a".repeat(64),
        },
        {},
        admin,
      ),
    );
    expect(fs.readFileSync(path.join(shared, "notes/readme.md"), "utf8")).toBe("Shared notes\n");
  });

  it("limits a file share to that file, not its parent directory", async () => {
    binds[0]!.hostRoot = path.join(shared, "notes/readme.md");
    binds[0]!.containerRoot = "/mnt/shared/readme.md";
    const rootId = await sharedId();
    const listing = expectOkPayload(
      await invoke("sessions.files.list", { sessionKey, rootId }, {}, admin),
    );
    expect(listing.browser.entries).toEqual([expect.objectContaining({ path: "readme.md" })]);
    expect(
      expectOkPayload(
        await invoke("sessions.files.get", { sessionKey, rootId, path: "readme.md" }, {}, admin),
      ).file.content,
    ).toBe("Shared notes\n");
    writeWorkspaceFile(shared, "notes/private.md", "Not shared\n");
    expectError(
      await invoke("sessions.files.get", { sessionKey, rootId, path: "private.md" }, {}, admin),
    );
  });

  it("searches and previews outputs only, and reveals the same output folder", async () => {
    writeWorkspaceFile(workspace, "outputs/result.md", "Result\n");
    writeWorkspaceFile(workspace, "result-secret.md", "Outside outputs\n");
    const listing = expectOkPayload(
      await invoke(
        "sessions.files.list",
        { sessionKey, rootId: "outputs", search: "result" },
        {},
        admin,
      ),
    );
    expect(listing.browser.entries).toEqual([expect.objectContaining({ path: "result.md" })]);
    const preview = expectOkPayload(
      await invoke(
        "sessions.files.get",
        { sessionKey, rootId: "outputs", path: "result.md" },
        {},
        admin,
      ),
    );
    expect(preview).toMatchObject({
      root: path.join(workspace, "outputs"),
      readOnly: true,
      file: { content: "Result\n", workspacePath: "result.md" },
    });
    expect(
      expectOkPayload(
        await invoke("sessions.files.reveal", { key: sessionKey, rootId: "outputs" }, {}, admin),
      ),
    ).toEqual({ ok: true, path: path.join(workspace, "outputs") });
    expect(mocks.execOpenPath).toHaveBeenCalledWith(
      resolveOpenPathCommand(path.join(workspace, "outputs")),
    );
  });

  it("does not follow an outputs symlink or create the missing directory on reveal", async () => {
    expect(
      expectOkPayload(
        await invoke("sessions.files.reveal", { key: sessionKey, rootId: "outputs" }, {}, admin),
      ).ok,
    ).toBe(false);
    expect(fs.existsSync(path.join(workspace, "outputs"))).toBe(false);
    fs.symlinkSync(shared, path.join(workspace, "outputs"), "dir");
    const listing = expectOkPayload(
      await invoke("sessions.files.list", { sessionKey, rootId: "outputs" }, {}, admin),
    );
    expect(listing.browser.entries).toEqual([]);
    expectError(
      await invoke(
        "sessions.files.get",
        { sessionKey, rootId: "outputs", path: "notes/readme.md" },
        {},
        admin,
      ),
    );
    expect(mocks.execOpenPath).not.toHaveBeenCalled();
  });

  it("does not expose gateway-host locations for a remote session", async () => {
    const rootId = await sharedId();
    const context = {
      workerSessionPlacementService: {
        getMany: () => new Map([["sess-main", { state: "active" }]]),
      },
    };
    expect(
      expectOkPayload(await invoke("sessions.files.list", { sessionKey }, context, admin)).roots,
    ).toBeUndefined();
    expectError(
      await invoke(
        "sessions.files.get",
        { sessionKey, rootId, path: "notes/readme.md" },
        context,
        admin,
      ),
    );
  });
});
