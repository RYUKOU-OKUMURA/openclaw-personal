import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiBootstrapConfig } from "../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createApplicationConfigCapability } from "./config.ts";

function bootstrapResponse(
  serverVersion: string,
  automaticallyFetchFavicons = false,
  pluginAssetsRequireAuth?: boolean,
  communityInvite = true,
): Response {
  const payload: ControlUiBootstrapConfig = {
    basePath: "",
    assistantName: "Assistant",
    assistantAvatar: "A",
    assistantAgentId: "main",
    serverVersion,
    terminalEnabled: false,
    cliAgentsEnabled: true,
    automaticallyFetchFavicons,
    communityInvite,
    ...(pluginAssetsRequireAuth === undefined ? {} : { pluginAssetsRequireAuth }),
    pluginFrameGrants: [],
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApplicationConfigCapability", () => {
  it("authenticates plugin asset bootstrap with the accepted Tailscale identity", async () => {
    const grant = {
      pluginId: "workboard",
      path: "/__openclaw__/plugins/control-ui/workboard/",
      match: "prefix",
    };
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      if (new Headers(init?.headers).has("Authorization")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({
        serverVersion: "test",
        pluginAssetsRequireAuth: true,
        pluginFrameGrants: [grant],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({
        hello: { auth: { method: "tailscale", deviceToken: "legacy-device-token" } },
        settings: { token: "saved-shared-token" },
        password: "saved-password",
      }),
    });

    await expect(config.refresh()).resolves.toMatchObject({
      pluginAssetsRequireAuth: true,
      pluginFrameGrants: [grant],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
  });

  it.each(["method", "device token"])(
    "discards an ambient bootstrap after its accepted %s changes",
    async (changed) => {
      const response = createDeferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(() => response.promise),
      );
      let method: "tailscale" | "token" = "tailscale";
      let deviceToken = "legacy-device-token";
      const config = createApplicationConfigCapability({
        resourceBasePath: "",
        getAuth: () => ({ hello: { auth: { method, deviceToken } } }),
      });
      const loading = config.refresh();
      if (changed === "method") {
        method = "token";
      } else {
        deviceToken = "replacement-device-token";
      }
      response.resolve(bootstrapResponse("retired"));

      await expect(loading).resolves.toBeNull();
      expect(config.current.serverVersion).toBeNull();
    },
  );

  it("fails closed when the accepted Tailscale identity cannot authenticate bootstrap", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({
        hello: { auth: { method: "tailscale", deviceToken: "legacy-device-token" } },
        settings: { token: "saved-owner-token" },
      }),
    });

    await expect(config.refresh()).resolves.toBeNull();
    expect(config.current.pluginFrameGrants).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
  });

  it.each(["token", "password", "device-token", undefined] as const)(
    "preserves ordered Bearer fallback for %s authentication",
    async (method) => {
      const fetchMock = vi.fn<typeof fetch>(async (_url, init) =>
        new Headers(init?.headers).get("Authorization") === "Bearer saved-password"
          ? bootstrapResponse("ready")
          : new Response(null, { status: 401 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const config = createApplicationConfigCapability({
        resourceBasePath: "",
        getAuth: () => ({
          hello: { auth: { method, deviceToken: "device-token" } },
          settings: { token: "saved-token" },
          password: "saved-password",
        }),
      });

      await expect(config.refresh()).resolves.toMatchObject({ serverVersion: "ready" });
      expect(
        fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
      ).toEqual(["Bearer device-token", "Bearer saved-token", "Bearer saved-password"]);
    },
  );

  it("replaces pending bootstrap when the accepted method changes with the same token", async () => {
    const firstResponse = createDeferred<Response>();
    const secondResponse = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    let method: "tailscale" | "token" = "tailscale";
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({ hello: { auth: { method, deviceToken: "same-device-token" } } }),
    });

    const first = config.refresh();
    method = "token";
    const second = config.refresh();
    secondResponse.resolve(bootstrapResponse("new"));
    await expect(second).resolves.toMatchObject({ serverVersion: "new" });
    firstResponse.resolve(bootstrapResponse("old"));
    await expect(first).resolves.toBeNull();
    expect(config.current.serverVersion).toBe("new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps capabilities available when development plugin grants contain invalid URLs", async () => {
    vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", {
      gatewayUrl: "ws://gateway.example/mount",
      proxyPath: "/dev-gateway",
    });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        terminalEnabled: true,
        cliAgentsEnabled: true,
        pluginFrameGrants: [
          {
            pluginId: "fixture",
            path: "/mount/plugins/fixture/",
            match: "prefix",
            unrecognized: "discard",
          },
          { pluginId: "malformed", path: "http://[", match: "prefix" },
          { pluginId: "foreign", path: "https://other.example/panel", match: "exact" },
          { path: "/missing-owner", match: "prefix" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "/dev-gateway/mount" });
    await expect(config.refresh()).resolves.toMatchObject({
      terminalEnabled: true,
      cliAgentsEnabled: true,
      pluginFrameGrants: [
        { pluginId: "fixture", path: "/dev-gateway/mount/plugins/fixture/", match: "prefix" },
        { pluginId: "malformed", path: "http://[", match: "prefix" },
        { pluginId: "foreign", path: "https://other.example/panel", match: "exact" },
      ],
    });
    expect(config.current.pluginFrameGrants[0]).not.toHaveProperty("unrecognized");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps invitations hidden until bootstrap enables them and accepts later opt-outs", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(bootstrapResponse("test"))
      .mockResolvedValueOnce(bootstrapResponse("test", false, undefined, false));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    const listener = vi.fn();
    const unsubscribe = config.subscribe(listener);

    expect(config.current.communityInvite).toBe(false);
    await expect(config.refresh()).resolves.toMatchObject({ communityInvite: true });
    await expect(config.refresh()).resolves.toMatchObject({ communityInvite: false });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ communityInvite: false }));
    unsubscribe();
  });

  it.each([undefined, true, false])(
    "requires native asset grants unless bootstrap explicitly disables auth: %s",
    async (pluginAssetsRequireAuth) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => bootstrapResponse("test", false, pluginAssetsRequireAuth)),
      );
      const config = createApplicationConfigCapability({ resourceBasePath: "" });
      expect(config.current.pluginAssetsRequireAuth).toBe(true);
      await expect(config.refresh()).resolves.toMatchObject({
        pluginAssetsRequireAuth: pluginAssetsRequireAuth !== false,
        pluginFrameGrants: [],
      });
    },
  );

  it("stays fail closed before bootstrap and accepts the Gateway favicon setting", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => bootstrapResponse("test", true));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "/openclaw" });

    expect(config.current.automaticallyFetchFavicons).toBe(false);
    await expect(config.refresh()).resolves.toMatchObject({ automaticallyFetchFavicons: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/openclaw/control-ui-config.json");
    expect(config.current.automaticallyFetchFavicons).toBe(true);
  });

  it.each([null, { pluginFrameGrants: {} }])(
    "returns an unavailable result for invalid bootstrap data: %j",
    async (payload) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload))),
      );
      const config = createApplicationConfigCapability({ resourceBasePath: "" });

      await expect(config.refresh()).resolves.toBeNull();
      expect(config.current.serverVersion).toBeNull();
    },
  );

  it("does not discard an in-flight bootstrap when an auth-only refresh skips", async () => {
    const response = createDeferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => response.promise),
    );
    const config = createApplicationConfigCapability({ resourceBasePath: "" });

    const loading = config.refresh();
    await expect(config.refresh({ skipWithoutAuthCandidate: true })).resolves.toBeNull();
    response.resolve(bootstrapResponse("ready", false, false));

    await expect(loading).resolves.toMatchObject({ serverVersion: "ready" });
    expect(config.current.serverVersion).toBe("ready");
  });

  it("shares concurrent bootstrap loads with equivalent credentials", async () => {
    const response = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    let token = "fixture-token";
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({ settings: { token } }),
    });

    const first = config.refresh();
    token = " fixture-token ";
    const second = config.refresh({ skipWithoutAuthCandidate: true });
    response.resolve(bootstrapResponse("ready"));

    await expect(first).resolves.toMatchObject({ serverVersion: "ready" });
    await expect(second).resolves.toMatchObject({ serverVersion: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an authenticated response after credentials are cleared by a skipped refresh", async () => {
    const response = createDeferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => response.promise),
    );
    let token = "fixture-token";
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({ settings: { token } }),
    });

    const loading = config.refresh();
    token = "";
    await expect(config.refresh({ skipWithoutAuthCandidate: true })).resolves.toBeNull();
    response.resolve(bootstrapResponse("old"));

    await expect(loading).resolves.toBeNull();
    expect(config.current.serverVersion).toBeNull();
  });

  it.each(["", "replacement-fixture-token"])(
    "rejects an authenticated response when live credentials change without another refresh: %s",
    async (nextToken) => {
      const response = createDeferred<Response>();
      const fetchMock = vi.fn<typeof fetch>(() => response.promise);
      vi.stubGlobal("fetch", fetchMock);
      let token = "fixture-token";
      const config = createApplicationConfigCapability({
        resourceBasePath: "",
        getAuth: () => ({ settings: { token } }),
      });

      const loading = config.refresh();
      token = nextToken;
      response.resolve(bootstrapResponse("retired"));

      await expect(loading).resolves.toBeNull();
      expect(config.current.serverVersion).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "keeps independent callers valid and publishes the newest successful response (aborted: %s)",
    async (aborted) => {
      const firstResponse = createDeferred<Response>();
      const secondResponse = createDeferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockImplementationOnce(() => firstResponse.promise)
          .mockImplementationOnce(() => secondResponse.promise),
      );
      const config = createApplicationConfigCapability({ resourceBasePath: "" });
      const abort = new AbortController();
      const first = config.refresh();
      const second = config.refresh({ signal: abort.signal });
      if (aborted) {
        abort.abort();
      }
      secondResponse.resolve(bootstrapResponse("new"));
      expect(await second).toEqual(
        aborted ? null : expect.objectContaining({ serverVersion: "new" }),
      );
      firstResponse.resolve(bootstrapResponse("old"));

      await expect(first).resolves.toMatchObject({ serverVersion: "old" });
      expect(config.current.serverVersion).toBe(aborted ? "old" : "new");
    },
  );

  it("returns null for a bootstrap response superseded by different credentials", async () => {
    const firstResponse = createDeferred<Response>();
    const secondResponse = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    let token = "old-fixture-token";
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({ settings: { token } }),
    });

    const firstRefresh = config.refresh();
    token = "new-fixture-token";
    const secondRefresh = config.refresh();
    secondResponse.resolve(bootstrapResponse("new"));
    await expect(secondRefresh).resolves.toMatchObject({ serverVersion: "new" });
    firstResponse.resolve(bootstrapResponse("old"));

    await expect(firstRefresh).resolves.toBeNull();
    expect(config.current.serverVersion).toBe("new");
    expect(config.current.cliAgentsEnabled).toBe(true);
  });
});
