/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { SessionWorkspaceGetResult, SessionWorkspaceRoot } from "../../../api/types.ts";
import {
  createSessionWorkspaceProps,
  openSessionWorkspaceFile,
  renderSessionWorkspaceRail,
  resolveSessionDiffSidebarContent,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";

const sessionKey = "agent:main:current";

function createFixture() {
  const roots: SessionWorkspaceRoot[] = [
    {
      id: "workspace",
      kind: "workspace",
      name: "workspace",
      hostPath: "/host/work",
      runtimePath: "/workspace",
      writable: true,
      available: true,
    },
    {
      id: "outputs",
      kind: "outputs",
      name: "outputs",
      hostPath: "/host/work/outputs",
      runtimePath: "/workspace/outputs",
      writable: true,
      available: false,
    },
    {
      id: "shared:notes",
      kind: "shared",
      name: "Shared Notes",
      hostPath: "/host/notes",
      runtimePath: "/mnt/shared/Shared Notes",
      writable: false,
      available: true,
    },
  ];
  const listFiles = vi.fn(async (_key: string, options?: { rootId?: string }) => ({
    sessionKey,
    root: roots.find((root) => root.id === (options?.rootId ?? "workspace"))?.hostPath,
    rootId: options?.rootId ?? "workspace",
    roots,
    files: [],
    browser: { path: "", entries: [] },
  }));
  const getFile = vi.fn<() => Promise<SessionWorkspaceGetResult | null>>();
  const revealFiles = vi.fn().mockResolvedValue({ ok: true });
  const request = vi
    .fn()
    .mockResolvedValue({ artifacts: [{ id: "old-artifact", name: "attachment.txt" }] });
  const state: SessionWorkspaceHost = {
    sessionKey,
    sessions: { listFiles, getFile, revealFiles } as unknown as SessionWorkspaceHost["sessions"],
    client: { request } as unknown as SessionWorkspaceHost["client"],
    connected: true,
    connectionEpoch: 1,
    agentsList: { agents: [] },
    hello: {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["sessions.files.set", "sessions.files.reveal", "sessions.diff"] },
    } as SessionWorkspaceHost["hello"],
    sidebarContent: null,
    requestUpdate: vi.fn(),
    handleOpenSidebar: vi.fn((content) => {
      state.sidebarContent = content;
    }),
  };
  const props = () => createSessionWorkspaceProps(state, { expanded: true });
  const ready = async () => {
    props();
    await vi.waitFor(() => expect(props().loading).toBe(false));
  };
  const select = async (id: string) => {
    props().onSelectRoot?.(id);
    await ready();
  };
  return { state, roots, listFiles, getFile, revealFiles, request, props, ready, select };
}

function preview(
  content: string,
  root = "/host/notes",
  readOnly = true,
): SessionWorkspaceGetResult {
  return {
    sessionKey,
    root,
    readOnly,
    file: {
      kind: "read",
      name: "note.md",
      path: "note.md",
      workspacePath: "note.md",
      content,
      hash: "a".repeat(64),
      missing: false,
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Files location ownership", () => {
  it("scopes shared list and preview requests without artifacts or editing, while chat links keep their workspace scope", async () => {
    const fixture = createFixture();
    await fixture.ready();
    expect(fixture.props().list?.artifacts).toHaveLength(1);
    await fixture.select("shared:notes");
    expect(fixture.listFiles).toHaveBeenLastCalledWith(
      sessionKey,
      expect.objectContaining({ rootId: "shared:notes", path: "", search: "" }),
    );
    expect(fixture.props().list?.artifacts).toBeUndefined();
    expect(fixture.request).toHaveBeenCalledOnce();
    fixture.getFile.mockResolvedValue(preview("Shared note"));
    fixture.props().onOpenFile("note.md", "workspace");
    await vi.waitFor(() => expect(fixture.state.sidebarContent?.kind).toBe("file"));
    expect(fixture.getFile).toHaveBeenLastCalledWith(sessionKey, "note.md", {
      agentId: "main",
      rootId: "shared:notes",
    });
    expect(fixture.state.sidebarContent).not.toHaveProperty("edit");
    expect(fixture.state.sidebarContent).toHaveProperty("previewOnly", true);
    expect(fixture.state.sidebarContent).toHaveProperty(
      "draftKey",
      `\u0000\u0000${sessionKey}\u0000/host/notes\u0000shared:notes\u0000note.md`,
    );
    fixture.getFile.mockResolvedValue(preview("Workspace note", "/host/work", false));
    openSessionWorkspaceFile(fixture.state, { path: "note.md" });
    await vi.waitFor(() =>
      expect(fixture.state.sidebarContent).toHaveProperty("content", "Workspace note"),
    );
    expect(fixture.getFile).toHaveBeenLastCalledWith(sessionKey, "note.md", { agentId: "main" });
    expect(fixture.state.sidebarContent).toHaveProperty("edit");
    expect(fixture.state.sidebarContent).not.toHaveProperty("previewOnly");
  });

  it("keeps diff file links scoped to the workspace while shared materials are selected", async () => {
    const fixture = createFixture();
    await fixture.ready();
    await fixture.select("shared:notes");
    fixture.getFile.mockResolvedValue(preview("Changed workspace note", "/host/work", false));
    const diff = resolveSessionDiffSidebarContent(fixture.state);
    if (diff?.kind !== "session-diff") {
      throw new Error("Expected session diff content");
    }
    diff.openFile?.("note.md");
    await vi.waitFor(() =>
      expect(fixture.state.sidebarContent).toHaveProperty("content", "Changed workspace note"),
    );
    expect(fixture.getFile).toHaveBeenLastCalledWith(sessionKey, "note.md", { agentId: "main" });
    expect(fixture.state.sidebarContent).toHaveProperty("edit");
  });

  it("drops late previews after switching away and back to the same path", async () => {
    const fixture = createFixture();
    await fixture.ready();
    await fixture.select("shared:notes");
    const pending = createDeferred<SessionWorkspaceGetResult>();
    fixture.getFile
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(preview("Current output", "/host/work/outputs"));
    fixture.props().onOpenFile("note.md", "workspace");
    await fixture.select("outputs");
    fixture.props().onOpenFile("note.md", "workspace");
    await vi.waitFor(() =>
      expect(fixture.state.sidebarContent).toHaveProperty("content", "Current output"),
    );
    pending.resolve(preview("Stale shared note"));
    await pending.promise;
    await Promise.resolve();
    expect(fixture.state.sidebarContent).toHaveProperty("content", "Current output");
    expect(fixture.state.sidebarContent).not.toHaveProperty("edit");
  });

  it("drops stale list results and resets location ownership on a session change", async () => {
    const fixture = createFixture();
    await fixture.ready();
    const pending = createDeferred<Awaited<ReturnType<typeof fixture.listFiles>>>();
    fixture.listFiles.mockReturnValueOnce(pending.promise);
    fixture.props().onSelectRoot?.("shared:notes");
    fixture.props().onSelectRoot?.("outputs");
    pending.resolve({
      sessionKey,
      root: "/stale",
      rootId: "shared:notes",
      roots: fixture.roots,
      files: [],
      browser: { path: "stale", entries: [] },
    });
    await fixture.ready();
    expect(fixture.props().rootId).toBe("outputs");
    expect(fixture.props().list?.root).toBe("/host/work/outputs");
    expect(fixture.props().list?.browser?.path).toBe("");
    fixture.state.sessionKey = "agent:writer:other";
    expect(fixture.props().rootId).toBe("workspace");
    expect(fixture.props().roots).toBeNull();
    await fixture.ready();
    expect(fixture.listFiles).toHaveBeenLastCalledWith("agent:writer:other", {
      agentId: "writer",
      path: "",
      search: "",
    });
  });

  it("keeps outputs discoverable before they exist and opens the folder only when available", async () => {
    const fixture = createFixture();
    await fixture.ready();
    await fixture.select("outputs");
    const mount = document.body.appendChild(document.createElement("div"));
    render(renderSessionWorkspaceRail(fixture.props(), { embedded: true }), mount);
    let reveal = mount.querySelector<HTMLButtonElement>('button[aria-label="Open output folder"]');
    expect(reveal?.disabled).toBe(true);
    reveal?.click();
    expect(fixture.revealFiles).not.toHaveBeenCalled();
    expect(mount.textContent).toContain("/workspace/outputs");
    expect(mount.textContent).toContain("The AI creates output files while saving");
    fixture.roots[1]!.available = true;
    fixture.props().onRefresh();
    await fixture.ready();
    render(renderSessionWorkspaceRail(fixture.props(), { embedded: true }), mount);
    reveal = mount.querySelector<HTMLButtonElement>('button[aria-label="Open output folder"]');
    expect(reveal?.disabled).toBe(false);
    reveal?.click();
    expect(fixture.revealFiles).toHaveBeenCalledWith(sessionKey, {
      agentId: "main",
      rootId: "outputs",
    });
  });

  it("does not apply a previous location's failed request to the current location", async () => {
    const fixture = createFixture();
    await fixture.ready();
    const pending = createDeferred<Awaited<ReturnType<typeof fixture.listFiles>>>();
    fixture.listFiles.mockReturnValueOnce(pending.promise);
    fixture.props().onSelectRoot?.("shared:notes");
    fixture.props().onSelectRoot?.("outputs");
    pending.reject(new Error("Stale shared location error"));
    await fixture.ready();
    expect(fixture.props().error).toBeNull();
    expect(fixture.props().list?.root).toBe("/host/work/outputs");
  });

  it.each(["non-admin", "unsupported"])(
    "gates output reveal for %s clients, including stale callbacks",
    async (access) => {
      const fixture = createFixture();
      fixture.roots[1]!.available = true;
      await fixture.ready();
      await fixture.select("outputs");
      const previousReveal = fixture.props().onRevealRoot;
      expect(previousReveal).toBeTypeOf("function");
      if (access === "non-admin") {
        fixture.state.hello!.auth!.scopes = ["operator.read"];
      } else {
        fixture.state.hello!.features = { methods: ["sessions.files.set"] };
      }
      expect(fixture.props().onRevealRoot).toBeUndefined();
      previousReveal?.();
      expect(fixture.revealFiles).not.toHaveBeenCalled();
    },
  );

  it("explains that a read-only workspace cannot receive outputs", async () => {
    const fixture = createFixture();
    fixture.roots[1]!.writable = false;
    await fixture.ready();
    await fixture.select("outputs");
    const mount = document.body.appendChild(document.createElement("div"));
    render(renderSessionWorkspaceRail(fixture.props(), { embedded: true }), mount);
    expect(mount.textContent).toContain("The AI cannot save output files here.");
    expect(mount.textContent).not.toContain("The AI creates output files while saving");
  });
});
