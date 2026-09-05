// Structured-extraction runtime tests cover owner resolution, timeout bounds,
// input validation, and provider capability errors.
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { extractStructuredWithModel } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  buildProviderRegistry: vi.fn(() => new Map()),
  createMediaAttachmentCache: vi.fn(),
  normalizeMediaAttachments: vi.fn(),
  runCapability: vi.fn(),
  normalizeMediaProviderId: vi.fn((provider: string) => provider.trim().toLowerCase()),
  buildMediaUnderstandingRegistry: vi.fn(() => new Map()),
  getMediaUnderstandingProvider: vi.fn(),
}));

vi.mock("./runner.js", () => ({
  buildProviderRegistry: mocks.buildProviderRegistry,
  createMediaAttachmentCache: mocks.createMediaAttachmentCache,
  normalizeMediaAttachments: mocks.normalizeMediaAttachments,
  runCapability: mocks.runCapability,
}));

vi.mock("./provider-registry.js", () => ({
  normalizeMediaProviderId: mocks.normalizeMediaProviderId,
  buildMediaUnderstandingRegistry: mocks.buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider: mocks.getMediaUnderstandingProvider,
}));

vi.mock("./image-runtime.js", () => ({
  describeImageWithModel: vi.fn(),
}));

afterEach(() => {
  mocks.buildProviderRegistry.mockReset();
  mocks.buildProviderRegistry.mockReturnValue(new Map());
  mocks.createMediaAttachmentCache.mockReset();
  mocks.normalizeMediaAttachments.mockReset();
  mocks.runCapability.mockReset();
  mocks.normalizeMediaProviderId.mockReset();
  mocks.normalizeMediaProviderId.mockImplementation((provider: string) =>
    provider.trim().toLowerCase(),
  );
  mocks.buildMediaUnderstandingRegistry.mockReset();
  mocks.buildMediaUnderstandingRegistry.mockReturnValue(new Map());
  mocks.getMediaUnderstandingProvider.mockReset();
});

describe("structured extraction runtime", () => {
  it.each([
    {
      name: "default",
      agentDir: undefined,
      expectedAgentDir: "/tmp/default-agent",
      maxTokens: undefined,
    },
    { name: "explicit", agentDir: "/tmp/agent", expectedAgentDir: "/tmp/agent", maxTokens: 1024 },
  ])("routes structured extraction with the $name owner", async (testCase) => {
    const providerRegistry = new Map();
    const authStore = {} as AuthProfileStore;
    const signal = new AbortController().signal;
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "worker" } },
        entries: {
          other: { agentDir: "/tmp/other-agent" },
          worker: { agentDir: "/tmp/default-agent" },
        },
      },
    } satisfies OpenClawConfig;
    const extractStructured = vi.fn(async () => ({
      text: '{"ok":true}',
      parsed: { ok: true },
      model: "vision-json",
      provider: "vision-plugin",
      contentType: "json" as const,
    }));
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(providerRegistry);
    mocks.getMediaUnderstandingProvider.mockReturnValue({
      id: "vision-plugin",
      extractStructured,
    });

    await expect(
      extractStructuredWithModel({
        input: [
          { type: "text", text: "Extract the fact." },
          {
            type: "image",
            buffer: Buffer.from("image-bytes"),
            fileName: "fact.png",
            mime: "image/png",
          },
        ],
        instructions: "Return JSON.",
        provider: "Vision-Plugin",
        model: "vision-json",
        profile: "work",
        preferredProfile: "preferred-work",
        authStore,
        timeoutMs: 45_000,
        maxTokens: testCase.maxTokens,
        signal,
        cfg,
        agentDir: testCase.agentDir,
      }),
    ).resolves.toEqual({
      text: '{"ok":true}',
      parsed: { ok: true },
      model: "vision-json",
      provider: "vision-plugin",
      contentType: "json",
    });

    expect(mocks.buildMediaUnderstandingRegistry).toHaveBeenCalledWith(undefined, cfg);
    expect(mocks.getMediaUnderstandingProvider).toHaveBeenCalledWith(
      "Vision-Plugin",
      providerRegistry,
    );
    const [extractOptions] = expectDefined(
      (
        extractStructured.mock.calls as unknown as Array<
          [
            {
              input?: unknown;
              instructions?: string;
              provider?: string;
              model?: string;
              profile?: string;
              preferredProfile?: string;
              authStore?: AuthProfileStore;
              timeoutMs?: number;
              maxTokens?: number;
              signal?: AbortSignal;
              agentDir?: string;
            },
          ]
        >
      )[0],
      "(extractStructured.mock.calls as unknown as Array<\n        [\n          {\n            input?: unknown;\n            instructions?: string;\n            provider?: string;\n            model?: string;\n            profile?: string;\n            preferredProfile?: string;\n            authStore?: AuthProfileStore;\n            timeoutMs?: number;\n            agentDir?: string;\n          },\n        ]\n      >)[0] test invariant",
    );
    expect(extractOptions?.input).toEqual([
      { type: "text", text: "Extract the fact." },
      {
        type: "image",
        buffer: Buffer.from("image-bytes"),
        fileName: "fact.png",
        mime: "image/png",
      },
    ]);
    expect(extractOptions?.instructions).toBe("Return JSON.");
    expect(extractOptions?.provider).toBe("Vision-Plugin");
    expect(extractOptions?.model).toBe("vision-json");
    expect(extractOptions?.profile).toBe("work");
    expect(extractOptions?.preferredProfile).toBe("preferred-work");
    expect(extractOptions?.authStore).toBe(authStore);
    expect(extractOptions?.timeoutMs).toBe(45_000);
    expect(extractOptions?.maxTokens).toBe(testCase.maxTokens);
    expect(extractOptions?.signal).toBe(signal);
    expect(extractOptions?.agentDir).toBe(testCase.expectedAgentDir);
  });

  it("caps explicit structured extraction timeouts before provider execution", async () => {
    const extractStructured = vi.fn(async () => ({
      text: "{}",
      parsed: {},
      model: "vision-json",
      provider: "vision-plugin",
      contentType: "json" as const,
    }));
    mocks.getMediaUnderstandingProvider.mockReturnValue({ id: "vision-plugin", extractStructured });

    await extractStructuredWithModel({
      input: [
        {
          type: "image",
          buffer: Buffer.from("image-bytes"),
          fileName: "fact.png",
          mime: "image/png",
        },
      ],
      instructions: "Return JSON.",
      provider: "vision-plugin",
      model: "vision-json",
      timeoutMs: Number.MAX_SAFE_INTEGER,
      cfg: {} as OpenClawConfig,
    });

    expect(extractStructured).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: MAX_TIMER_TIMEOUT_MS }),
    );
  });

  it("rejects text-only structured extraction before provider lookup", async () => {
    await expect(
      extractStructuredWithModel({
        input: [{ type: "text", text: "Extract the fact." }],
        instructions: "Return JSON.",
        provider: "vision-plugin",
        model: "vision-json",
        cfg: {} as OpenClawConfig,
      }),
    ).rejects.toThrow("Structured extraction requires at least one image input.");

    expect(mocks.buildMediaUnderstandingRegistry).not.toHaveBeenCalled();
    expect(mocks.getMediaUnderstandingProvider).not.toHaveBeenCalled();
  });

  it("fails clearly when a provider lacks structured extraction", async () => {
    const providerRegistry = new Map();
    mocks.buildMediaUnderstandingRegistry.mockReturnValue(providerRegistry);
    mocks.getMediaUnderstandingProvider.mockReturnValue({ id: "vision-plugin" });

    await expect(
      extractStructuredWithModel({
        input: [
          {
            type: "image",
            buffer: Buffer.from("image-bytes"),
            fileName: "fact.png",
            mime: "image/png",
          },
        ],
        instructions: "Return JSON.",
        provider: "vision-plugin",
        model: "vision-json",
        cfg: {} as OpenClawConfig,
      }),
    ).rejects.toThrow("Provider does not support structured extraction: vision-plugin");
  });
});
