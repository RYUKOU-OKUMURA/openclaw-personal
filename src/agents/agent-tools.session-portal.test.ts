import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { bindSessionRowProjection } from "../gateway/session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../gateway/session-row-projection.test-support.js";
import { resolveGatewayScopedTools } from "../gateway/tool-resolution.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";

const identity = { sessionKey: "agent:main:preview", sessionId: "conversation", agentId: "main" };
const binding = { ...identity, environmentId: "attached", ownerEpoch: 1, generation: 1 };

function context(dedicated: boolean, attached: boolean, locked = false) {
  const signal = new AbortController().signal;
  const projection = createSessionRowProjectionFixture({
    cfg: {},
    store: {
      [identity.sessionKey]: {
        sessionId: identity.sessionId,
        updatedAt: 1,
        modelSelectionLocked: locked,
      },
    },
  });
  return bindSessionRowProjection(
    {
      portalService: {},
      workerEnvironmentService: {
        getSessionAttachmentStatus: () => (attached ? { attachment: binding } : undefined),
        captureSessionAttachment: () => {
          if (!attached) {
            throw new Error("no secondary attachment");
          }
          return { binding, assertCurrent: () => {}, touch: async () => {} };
        },
        get: () => ({ ...binding, leaseId: "lease", nodeDeviceId: "node", sharedHost: false }),
        getDedicatedNodeLeaseSignal: () => (dedicated ? signal : undefined),
      },
    } as unknown as GatewayRequestContext,
    () => projection,
  );
}

async function tools(
  builder: "agent" | "gateway",
  cfg: OpenClawConfig = { tools: { profile: "coding" } },
  senderIsOwner = false,
) {
  return builder === "agent"
    ? createOpenClawCodingTools({ ...identity, config: cfg, senderIsOwner })
    : (await resolveGatewayScopedTools({ ...identity, cfg, senderIsOwner, surface: "loopback" }))
        .tools;
}

describe("attached conversation portal tool availability", () => {
  for (const builder of ["agent", "gateway"] as const) {
    it(`${builder} exposes only the scoped schema for a qualified non-owner and preserves tool denies`, async () => {
      const ctx = context(true, true);
      await withPluginRuntimeGatewayContextResolver(
        () => ctx,
        async () => {
          const portal = (await tools(builder)).find((tool) => tool.name === "portal");
          expect(portal).toBeDefined();
          expect(portal?.parameters).not.toHaveProperty("properties.environmentId");
          expect(portal?.description).toContain("attached dedicated worker");
          expect(
            (await tools(builder, { tools: { profile: "coding", deny: ["portal"] } })).some(
              (tool) => tool.name === "portal",
            ),
          ).toBe(false);
        },
      );
    });

    it(`${builder} preserves the owner's global portal schema`, async () => {
      const ctx = context(false, false);
      await withPluginRuntimeGatewayContextResolver(
        () => ctx,
        async () => {
          const portal = (await tools(builder, undefined, true)).find(
            (tool) => tool.name === "portal",
          );
          expect(portal?.parameters).toHaveProperty("properties.environmentId");
        },
      );
    });
  }

  it.each([
    { builder: "gateway", dedicated: false, attached: true, locked: false, label: "shared host" },
    { builder: "agent", dedicated: true, attached: false, locked: false, label: "no attachment" },
    {
      builder: "agent",
      dedicated: true,
      attached: true,
      locked: true,
      label: "model-selection lock",
    },
  ] as const)(
    "$builder keeps $label unavailable to non-owners",
    async ({ builder, dedicated, attached, locked }) => {
      const ctx = context(dedicated, attached, locked);
      await withPluginRuntimeGatewayContextResolver(
        () => ctx,
        async () => {
          expect((await tools(builder)).some((tool) => tool.name === "portal")).toBe(false);
          if (locked) {
            expect(
              (await tools(builder, undefined, true)).some((tool) => tool.name === "portal"),
            ).toBe(true);
          }
        },
      );
    },
  );

  it("does not expose the new mode through HTTP tool invocation", async () => {
    const ctx = context(true, true);
    await withPluginRuntimeGatewayContextResolver(
      () => ctx,
      async () => {
        const result = await resolveGatewayScopedTools({
          ...identity,
          cfg: { tools: { profile: "coding" } },
          senderIsOwner: false,
          surface: "http",
        });
        expect(result.tools.some((tool) => tool.name === "portal")).toBe(false);
      },
    );
  });
});
