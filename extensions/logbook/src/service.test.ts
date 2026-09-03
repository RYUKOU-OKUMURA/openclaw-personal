import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLogbookConfig } from "./config.js";
import { LogbookService } from "./service.js";

type NodeRecord = { nodeId: string; displayName?: string; commands: string[] };

const quietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeService(params: {
  nodes: NodeRecord[];
  invoke: (args: {
    nodeId: string;
    command: string;
    params: { screenIndex: number };
  }) => Promise<unknown>;
  config?: Record<string, unknown>;
  fullConfig?: Record<string, unknown>;
  complete?: (request: { model?: string; purpose?: string }) => Promise<{ text: string }>;
  extractStructured?: () => Promise<{ text: string }>;
  mutateConfig?: (draft: OpenClawConfig) => Promise<void>;
}) {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-service-test-")));
  const invoked: Array<{ nodeId: string; command: string }> = [];
  const currentConfig: OpenClawConfig = {
    ...params.fullConfig,
    plugins: { entries: { logbook: { config: { ...params.config } } } },
  };
  const mutateConfigFile = vi.fn(
    async ({ mutate }: { mutate: (draft: OpenClawConfig) => void }) => {
      const draft = structuredClone(currentConfig);
      mutate(draft);
      await params.mutateConfig?.(draft);
      Object.assign(currentConfig, draft);
    },
  );
  const runtime = {
    config: { current: () => currentConfig, mutateConfigFile },
    nodes: {
      list: async () => ({ nodes: params.nodes }),
      invoke: async (args: {
        nodeId: string;
        command: string;
        params: { screenIndex: number };
      }) => {
        invoked.push({ nodeId: args.nodeId, command: args.command });
        return await params.invoke(args);
      },
    },
    llm: { complete: params.complete },
    mediaUnderstanding: { extractStructuredWithModel: params.extractStructured },
  };
  const service = new LogbookService(
    resolveLogbookConfig({ captureEnabled: true, ...params.config }),
    {
      runtime: runtime as never,
      fullConfig: (params.fullConfig ?? {}) as never,
      logger: quietLogger as never,
      dataDir,
    },
  );
  service.start();
  const tick = () =>
    (service as unknown as { captureTick(): Promise<void> }).captureTick.call(service);
  return { service, invoked, tick, dataDir, currentConfig, mutateConfigFile };
}

const framePayload = {
  payload: { format: "jpeg", base64: Buffer.from("fake-jpeg").toString("base64") },
};

describe("LogbookService capture node selection", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("captures the live configured screen and keeps an in-flight frame on its original screen", async () => {
    const requestedScreens: number[] = [];
    const fixture = makeService({
      nodes: [{ nodeId: "mac-app", commands: ["screen.snapshot"] }],
      config: { screenIndex: 0 },
      invoke: async ({ params }) => {
        requestedScreens.push(params.screenIndex);
        fixture.currentConfig.plugins!.entries!.logbook!.config!.screenIndex = 0;
        return framePayload;
      },
    });
    cleanups.push(() => {
      fixture.service.stop();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    });
    fixture.currentConfig.plugins!.entries!.logbook!.config!.screenIndex = 1;

    await fixture.tick();

    expect(requestedScreens).toEqual([1]);
    expect(fixture.service.framesInRange(0, Date.now() + 1)[0]?.screenIndex).toBe(1);
    expect(fixture.service.status()).toMatchObject({ screenIndex: 0 });
    await fixture.tick();
    expect(requestedScreens).toEqual([1, 0]);
  });

  it("prefers app nodes over headless node hosts regardless of node id order", async () => {
    const { service, invoked, tick, dataDir } = makeService({
      nodes: [
        { nodeId: "a-headless", commands: ["logbook.snapshot"] },
        { nodeId: "b-mac-app", commands: ["screen.snapshot"] },
      ],
      invoke: async () => framePayload,
    });
    cleanups.push(() => {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    await tick();
    expect(invoked).toEqual([{ nodeId: "b-mac-app", command: "screen.snapshot" }]);
    expect(service.status()).toMatchObject({ pendingFrames: 1, lastCaptureError: undefined });
  });

  it("rotates to the next capture node after a failure instead of re-picking the broken one", async () => {
    const { service, invoked, tick, dataDir } = makeService({
      nodes: [
        { nodeId: "a-broken", commands: ["logbook.snapshot"] },
        { nodeId: "b-working", commands: ["logbook.snapshot"] },
      ],
      invoke: async ({ nodeId }) => {
        if (nodeId === "a-broken") {
          return { payload: { error: "logbook.snapshot is not supported on linux" } };
        }
        return framePayload;
      },
    });
    cleanups.push(() => {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    await tick();
    await tick();
    expect(invoked.map((call) => call.nodeId)).toEqual(["a-broken", "b-working"]);
    expect(service.status().lastCaptureError).toBeUndefined();
  });

  it.each([
    ["malformed string", "not-base64!"],
    ["object", { encoded: "ZmFrZQ==" }],
    ["array", ["ZmFrZQ=="]],
  ])("rejects a %s snapshot payload before storing a frame", async (_label, base64) => {
    const { service, tick, dataDir } = makeService({
      nodes: [{ nodeId: "capture-node", commands: ["logbook.snapshot"] }],
      invoke: async () => ({ payload: { format: "jpeg", base64 } }),
    });
    cleanups.push(() => {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    await tick();

    expect(service.status()).toMatchObject({
      pendingFrames: 0,
      lastCaptureError: "logbook.snapshot returned invalid image payload",
    });
  });
});

describe("LogbookService vision model selection", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("borrows only a media provider with structured extraction", () => {
    const { service, dataDir } = makeService({
      nodes: [],
      invoke: async () => framePayload,
      fullConfig: {
        tools: {
          media: {
            models: [
              { provider: "openai", model: "gpt-5.5", capabilities: ["image"] },
              { provider: " Codex ", model: "gpt-5.5", capabilities: ["image"] },
            ],
          },
        },
      },
    });
    cleanups.push(() => {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    expect(service.status()).toMatchObject({
      visionModel: "codex/gpt-5.5",
      visionModelSource: "media-defaults",
    });
  });

  it("reports a missing model when borrowed defaults cannot extract structured data", () => {
    const { service, dataDir } = makeService({
      nodes: [],
      invoke: async () => framePayload,
      fullConfig: {
        tools: {
          media: {
            models: [{ provider: "openai", model: "gpt-5.5", capabilities: ["image"] }],
          },
        },
      },
    });
    cleanups.push(() => {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    expect(service.status()).toMatchObject({
      visionModel: undefined,
      visionModelSource: "missing",
    });
  });
});

describe("LogbookService status", () => {
  it("returns the capture-host timezone without exposing the state path", () => {
    const { service, dataDir } = makeService({
      nodes: [],
      invoke: async () => framePayload,
    });

    try {
      expect(service.status()).toMatchObject({
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      expect(service.status()).not.toHaveProperty("dataDir");
    } finally {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("LogbookService screen selection", () => {
  it("persists only the screen selection, preserves pause, and accepts screen zero", async () => {
    const fixture = makeService({
      nodes: [],
      invoke: async () => framePayload,
      config: { screenIndex: 1, captureEnabled: false, nodeId: "my-mac" },
      fullConfig: { gateway: { port: 18789 } },
    });
    try {
      fixture.service.setCapturePaused(true);
      const previous = structuredClone(fixture.currentConfig);
      previous.plugins!.entries!.logbook!.config!.screenIndex = 0;
      await expect(fixture.service.setScreenIndex(0)).resolves.toMatchObject({
        screenIndex: 0,
        capturePaused: true,
        captureEnabled: false,
      });
      expect(fixture.currentConfig).toEqual(previous);
      expect(fixture.mutateConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          afterWrite: { mode: "auto" },
        }),
      );
    } finally {
      fixture.service.stop();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid choices and failed persistence without changing capture state", async () => {
    const fixture = makeService({
      nodes: [],
      invoke: async () => framePayload,
      config: { screenIndex: 1 },
      mutateConfig: async () => {
        throw new Error("disk unavailable");
      },
    });
    try {
      fixture.service.setCapturePaused(true);
      for (const invalid of [undefined, null, "0", -1, 17, 0.5, Number.NaN]) {
        await expect(fixture.service.setScreenIndex(invalid)).rejects.toThrow("screenIndex");
      }
      expect(fixture.mutateConfigFile).not.toHaveBeenCalled();
      await expect(fixture.service.setScreenIndex(0)).rejects.toThrow("disk unavailable");
      expect(fixture.service.status()).toMatchObject({ screenIndex: 1, capturePaused: true });
      delete fixture.currentConfig.plugins!.entries!.logbook!.config;
      await expect(fixture.service.setScreenIndex(0)).rejects.toThrow("Initialize Logbook config");
      expect(fixture.currentConfig.plugins!.entries!.logbook!.config).toBeUndefined();
      expect(fixture.service.status().capturePaused).toBe(true);
    } finally {
      fixture.service.stop();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

  it("waits for the active config and reports when a saved choice cannot be applied", async () => {
    vi.useFakeTimers();
    const fixture = makeService({
      nodes: [],
      invoke: async () => framePayload,
      config: { screenIndex: 1 },
    });
    fixture.mutateConfigFile.mockImplementation(async () => {});
    try {
      fixture.service.setCapturePaused(true);
      let settled = false;
      const selection = fixture.service.setScreenIndex(0).then((status) => {
        settled = true;
        return status;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      fixture.currentConfig.plugins!.entries!.logbook!.config!.screenIndex = 0;
      await vi.advanceTimersByTimeAsync(50);
      await expect(selection).resolves.toMatchObject({ screenIndex: 0, capturePaused: true });

      const failure = expect(fixture.service.setScreenIndex(1)).rejects.toThrow(
        "saved but not applied",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
      expect(fixture.service.status()).toMatchObject({ screenIndex: 0, capturePaused: true });
    } finally {
      fixture.service.stop();
      rmSync(fixture.dataDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});

describe("LogbookService text model routing", () => {
  it.each([
    ["the configured local model", " ollama/local-text-model ", "ollama/local-text-model"],
    ["the host default when unset", undefined, undefined],
  ])(
    "uses %s for cards, repair, standup, and questions",
    async (_label, textModel, expectedModel) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-01T10:00:00"));
      const complete = vi
        .fn<(request: { model?: string; purpose?: string }) => Promise<{ text: string }>>()
        .mockResolvedValueOnce({ text: "not valid JSON" })
        .mockResolvedValueOnce({
          text: JSON.stringify([
            {
              startTime: "10:00:00",
              endTime: "10:01:00",
              title: "Editing a document",
              summary: "Updated the project document.",
            },
          ]),
        })
        .mockResolvedValueOnce({ text: "Updated the project document." })
        .mockResolvedValueOnce({ text: "You edited the project document." });
      const { service, tick, dataDir } = makeService({
        nodes: [{ nodeId: "capture-node", commands: ["screen.snapshot"] }],
        invoke: async () => framePayload,
        config: { visionModel: "ollama/local-vision-model", textModel },
        complete,
        extractStructured: async () => ({
          text: JSON.stringify({
            segments: [
              { start: "10:00:00", end: "10:01:00", description: "Editing a project document." },
            ],
          }),
        }),
      });
      try {
        await tick();
        await expect(service.analyzeNow()).resolves.toEqual({ started: true });
        await vi.waitFor(() => expect(service.status().lastBatch?.status).toBe("done"));
        expect(service.cardsForDay("2026-08-01")).toMatchObject([{ title: "Editing a document" }]);
        await expect(service.standup("2026-08-01", true)).resolves.toMatchObject({
          text: "Updated the project document.",
        });
        await expect(service.ask("2026-08-01", "What did I work on?")).resolves.toBe(
          "You edited the project document.",
        );
        expect(complete.mock.calls.map(([request]) => [request.purpose, request.model])).toEqual([
          ["logbook.cards", expectedModel],
          ["logbook.cards.repair", expectedModel],
          ["logbook.standup", expectedModel],
          ["logbook.ask", expectedModel],
        ]);
      } finally {
        service.stop();
        rmSync(dataDir, { recursive: true, force: true });
        vi.useRealTimers();
      }
    },
  );
});

describe("LogbookService text completion validation", () => {
  it.each(["", " \n\t "])("preserves the saved standup when a refresh returns %j", async (text) => {
    const complete = vi
      .fn<(request: { model?: string; purpose?: string }) => Promise<{ text: string }>>()
      .mockResolvedValueOnce({ text: "Updated the project document." })
      .mockResolvedValueOnce({ text });
    const { service, dataDir } = makeService({
      nodes: [],
      invoke: async () => framePayload,
      config: { textModel: "ollama/local-text-model" },
      complete,
    });
    try {
      const saved = await service.standup("2026-08-01", true);

      await expect(service.standup("2026-08-01", true)).rejects.toThrow(/no text/i);
      await expect(service.standup("2026-08-01", false)).resolves.toEqual(saved);
      expect(complete).toHaveBeenCalledTimes(2);
    } finally {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each(["", " \n\t "])("rejects a question answer containing %j", async (text) => {
    const { service, dataDir } = makeService({
      nodes: [],
      invoke: async () => framePayload,
      config: { textModel: "ollama/local-text-model" },
      complete: async () => ({ text }),
    });
    try {
      await expect(service.ask("2026-08-01", "What did I work on?")).rejects.toThrow(/no text/i);
    } finally {
      service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
