import { readFileSync } from "node:fs";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const serviceMock = vi.hoisted(() => ({
  context: vi.fn(() => ({ version: 1, records: [] })),
  deleteDay: vi.fn(() => ({ frames: 1 })),
}));
vi.mock("./src/service.js", () => ({
  LogbookService: class {
    context = serviceMock.context;
    deleteDay = serviceMock.deleteDay;
    start() {}
    stop() {}
  },
}));

type PolicyContext = Parameters<OpenClawPluginNodeInvokePolicy["handle"]>[0];

function registerLogbookPolicies(): OpenClawPluginNodeInvokePolicy[] {
  const policies: OpenClawPluginNodeInvokePolicy[] = [];
  plugin.register({
    pluginConfig: {},
    session: { controls: { registerControlUiDescriptor: () => {} } },
    registerNodeInvokePolicy: (policy: OpenClawPluginNodeInvokePolicy) => policies.push(policy),
    registerService: () => {},
    registerTool: () => {},
    on: () => {},
    registerGatewayMethod: () => {},
  } as unknown as OpenClawPluginApi);
  return policies;
}

describe("logbook gateway methods", () => {
  it("keeps only process-wide status independent of the authenticated profile", () => {
    const registrations: Array<{ method: string; options: unknown }> = [];
    plugin.register({
      pluginConfig: {},
      session: { controls: { registerControlUiDescriptor: () => {} } },
      registerNodeInvokePolicy: () => {},
      registerService: () => {},
      registerTool: () => {},
      on: () => {},
      registerGatewayMethod: (method: string, _handler: unknown, options: unknown) => {
        registrations.push({ method, options });
      },
    } as unknown as OpenClawPluginApi);

    expect(registrations.find((entry) => entry.method === "logbook.status")?.options).toEqual({
      scope: "operator.read",
      profileAccess: "independent",
    });
    expect(registrations.find((entry) => entry.method === "logbook.screen.set")?.options).toEqual({
      scope: "operator.write",
    });
    for (const registration of registrations.filter((entry) => entry.method !== "logbook.status")) {
      expect(registration.options).not.toHaveProperty("profileAccess");
    }
  });
});

describe("logbook snapshot invoke policy", () => {
  it("blocks logbook.snapshot when gateway.nodes.commands.deny lists screen.snapshot", async () => {
    const [policy] = registerLogbookPolicies();
    expect(policy?.commands).toEqual(["logbook.snapshot"]);
    const invokeNode = vi.fn();
    const result = await policy!.handle({
      nodeId: "node-1",
      command: "logbook.snapshot",
      params: undefined,
      config: { gateway: { nodes: { commands: { deny: ["screen.snapshot"] } } } },
      invokeNode,
    } as unknown as PolicyContext);
    expect(result).toMatchObject({ ok: false, code: "SCREEN_CAPTURE_DENIED" });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("invokes the node when screen.snapshot is not denied", async () => {
    const [policy] = registerLogbookPolicies();
    const invokeNode = vi.fn().mockResolvedValue({ ok: true, payloadJSON: null });
    const result = await policy!.handle({
      nodeId: "node-1",
      command: "logbook.snapshot",
      params: undefined,
      config: { gateway: { nodes: { commands: { deny: ["camera.snap"] } } } },
      invokeNode,
    } as unknown as PolicyContext);
    expect(result).toMatchObject({ ok: true });
    expect(invokeNode).toHaveBeenCalledTimes(1);
  });
});

describe("Logbook conversation context authorization", () => {
  function harness() {
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    const on = vi.fn<OpenClawPluginApi["on"]>();
    const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
    const registerGatewayMethod = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();
    plugin.register({
      pluginConfig: {},
      runtime: {},
      session: { controls: { registerControlUiDescriptor: () => {} } },
      registerNodeInvokePolicy: () => {},
      registerService,
      registerGatewayMethod,
      registerTool,
      on,
    } as unknown as OpenClawPluginApi);
    const factory = registerTool.mock.calls[0]![0];
    if (typeof factory !== "function") {
      throw new Error("Expected context tool factory");
    }
    const service = registerService.mock.calls[0]![0];
    void service.start({
      stateDir: "/unused",
      config: {},
      logger: { info() {}, warn() {}, error() {} },
    });
    return { factory, service, on, registerGatewayMethod };
  }

  it("exposes context only to host-owner private dashboard turns", () => {
    const { factory } = harness();
    const owner = { senderIsOwner: true, messageChannel: "webchat" };
    const denied: OpenClawPluginToolContext[] = [
      {},
      { ...owner, senderIsOwner: false },
      { ...owner, messageChannel: "discord" },
      { ...owner, messageChannel: "telegram" },
      { ...owner, nativeChannelId: "group" },
      { ...owner, deliveryContext: { to: "external" } },
      ...[
        {},
        { channel: "discord" },
        { channel: "unknown" },
        { channel: "" },
        { channel: "webchat", to: "external" },
        { channel: "webchat", threadId: "group" },
        { channel: "webchat", accountId: "other" },
      ].map((deliveryContext) => Object.assign({}, owner, { deliveryContext })),
    ];
    for (const context of denied) {
      expect(factory(context)).toBeNull();
    }
    expect(factory({ ...owner, deliveryContext: { channel: "webchat" } })).toMatchObject({
      name: "logbook_context",
    });
    expect(factory(owner)).toMatchObject({ name: "logbook_context" });
    expect(factory({ ...owner, sandboxed: true })).toMatchObject({ name: "logbook_context" });
  });

  it("passes bounded recall through the same service as the read RPC and requires explicit deletion day", async () => {
    const { factory, registerGatewayMethod } = harness();
    const tool = factory({ senderIsOwner: true, messageChannel: "webchat" });
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected recall tool");
    }
    expect(tool.description).toContain("retry the same day without query");
    await tool.execute("call", { day: "2026-09-05", query: "  OpenClaw  " });
    expect(serviceMock.context).toHaveBeenLastCalledWith({ day: "2026-09-05", query: "OpenClaw" });
    const read = registerGatewayMethod.mock.calls.find(([method]) => method === "logbook.context")!;
    const remove = registerGatewayMethod.mock.calls.find(
      ([method]) => method === "logbook.context.delete",
    )!;
    expect(read[2]).toEqual({ scope: "operator.read" });
    expect(remove[2]).toEqual({ scope: "operator.write" });
    const respond = vi.fn();
    await remove[1]({
      req: { type: "req", id: "delete-test", method: "logbook.context.delete" },
      params: {},
      client: null,
      isWebchatConnect: () => true,
      respond,
      get context(): never {
        throw new Error("Deletion handler must not access unrelated Gateway context");
      },
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ error: "day is required for context deletion" }),
      expect.anything(),
    );
  });

  it("injects recent evidence only after finalized tool-policy authorization", async () => {
    const { on } = harness();
    const registration = on.mock.calls.find(([name]) => name === "before_prompt_build")!;
    expect(registration[2]).toEqual({ requiresToolAuthority: true });
    // Recover the hook's correlated type from the public registration overload.
    const hook = registration[1] as (
      event: { prompt: string; messages: unknown[] },
      context: {
        trigger: string;
        toolAuthority?: {
          fingerprint: string;
          allows(name: string): boolean;
          assertActive(): void;
        };
      },
    ) => unknown;
    expect(await hook({ prompt: "resume", messages: [] }, { trigger: "user" })).toBeUndefined();
    const assertActive = vi.fn();
    const toolAuthority = { fingerprint: "turn", allows: () => false, assertActive };
    expect(
      await hook({ prompt: "resume", messages: [] }, { trigger: "user", toolAuthority }),
    ).toBeUndefined();
    toolAuthority.allows = () => true;
    expect(
      await hook({ prompt: "resume", messages: [] }, { trigger: "cron", toolAuthority }),
    ).toBeUndefined();
    expect(
      await hook({ prompt: "resume", messages: [] }, { trigger: "user", toolAuthority }),
    ).toMatchObject({ prependContext: expect.stringContaining("Recent Logbook evidence") });
    expect(assertActive).toHaveBeenCalledOnce();
    expect(serviceMock.context).toHaveBeenLastCalledWith(expect.anything(), 1300);
  });
});

it("registers the context tool through the host registrar using its shipped manifest", () => {
  const manifest: { contracts?: { tools?: string[] } } = JSON.parse(
    readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  );
  const { config, registry } = createPluginRegistryFixture();
  registerVirtualTestPlugin({
    registry,
    config,
    id: "logbook",
    name: "Logbook",
    contracts: manifest.contracts,
    register: plugin.register,
  });
  expect(registry.registry.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
  expect(registry.registry.tools).toContainEqual(
    expect.objectContaining({ pluginId: "logbook", names: ["logbook_context"] }),
  );
});
