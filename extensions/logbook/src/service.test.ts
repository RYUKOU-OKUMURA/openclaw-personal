import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLogbookConfig } from "./config.js";
import { LogbookService } from "./service.js";
import { LogbookStore } from "./store.js";

type NodeRecord = { nodeId: string; displayName?: string; commands: string[] };

const quietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeService(params: {
  nodes: NodeRecord[];
  listNodes?: () => Promise<{ nodes: NodeRecord[] }>;
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
      list: params.listNodes ?? (async () => ({ nodes: params.nodes })),
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
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
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
    cleanups.push(async () => {
      await fixture.service.stop();
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
    cleanups.push(async () => {
      await service.stop();
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
    cleanups.push(async () => {
      await service.stop();
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
    cleanups.push(async () => {
      await service.stop();
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
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
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
    cleanups.push(async () => {
      await service.stop();
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
    cleanups.push(async () => {
      await service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    expect(service.status()).toMatchObject({
      visionModel: undefined,
      visionModelSource: "missing",
    });
  });
});

describe("LogbookService status", () => {
  it("returns the capture-host timezone without exposing the state path", async () => {
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
      await service.stop();
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
      await fixture.service.stop();
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
      await fixture.service.stop();
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
      await fixture.service.stop();
      rmSync(fixture.dataDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});

describe("LogbookService capture schedule", () => {
  it.each([
    [
      { start: "23:00", end: "08:00" },
      ["22:59", "23:00", "00:00", "07:59", "08:00"],
      [1, 1, 1, 1, 2],
    ],
    [{ start: "12:00", end: "13:00" }, ["11:59", "12:00", "12:59", "13:00"], [1, 1, 1, 2]],
  ])(
    "applies daily boundaries, restart, and manual pause for %j",
    async (schedule, times, counts) => {
      vi.useFakeTimers();
      const fixture = makeService({
        nodes: [{ nodeId: "mac", commands: ["screen.snapshot"] }],
        config: { captureSchedule: schedule },
        invoke: async () => framePayload,
      });
      try {
        for (const [index, time] of times.entries()) {
          vi.setSystemTime(new Date(`2026-09-07T${time}:00`));
          if (index === 2) {
            await fixture.service.stop();
            fixture.service.start();
          }
          await fixture.tick();
          expect(fixture.invoked).toHaveLength(counts[index]!);
          expect(fixture.service.status().captureSchedulePaused).toBe(
            index > 0 && index < times.length - 1,
          );
        }
        fixture.service.setCapturePaused(true);
        await fixture.tick();
        expect(fixture.invoked).toHaveLength(2);
        fixture.service.setCapturePaused(false);
        await fixture.tick();
        expect(fixture.invoked).toHaveLength(3);
      } finally {
        await fixture.service.stop();
        rmSync(fixture.dataDir, { recursive: true, force: true });
        vi.useRealTimers();
      }
    },
  );

  it.each(["00:00", "08:00"])(
    "treats equal %s endpoints as an all-day capture pause",
    async (time) => {
      vi.useFakeTimers();
      const fixture = makeService({
        nodes: [{ nodeId: "mac", commands: ["screen.snapshot"] }],
        config: { captureSchedule: { start: time, end: time } },
        invoke: async () => framePayload,
      });
      try {
        for (const hour of [0, 7, 8, 23]) {
          vi.setSystemTime(new Date(2026, 8, 7, hour));
          await fixture.tick();
          expect(fixture.service.status().captureSchedulePaused).toBe(true);
        }
        expect(fixture.invoked).toHaveLength(0);
        await fixture.service.setCaptureSchedule(null);
        await fixture.tick();
        expect(fixture.invoked).toHaveLength(1);
      } finally {
        await fixture.service.stop();
        rmSync(fixture.dataDir, { recursive: true, force: true });
        vi.useRealTimers();
      }
    },
  );

  it("rechecks a pause boundary after asynchronous node discovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T22:59:59"));
    const fixture = makeService({
      nodes: [],
      listNodes: async () => {
        vi.setSystemTime(new Date("2026-09-07T23:00:00"));
        return { nodes: [{ nodeId: "mac", commands: ["screen.snapshot"] }] };
      },
      config: { captureSchedule: { start: "23:00", end: "08:00" } },
      invoke: async () => framePayload,
    });
    try {
      await fixture.tick();
      expect(fixture.invoked).toHaveLength(0);
      expect(fixture.service.status().captureSchedulePaused).toBe(true);
    } finally {
      await fixture.service.stop();
      rmSync(fixture.dataDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("persists only the schedule, applies it live, and preserves manual pause when removed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T23:00:00"));
    const fixture = makeService({
      nodes: [],
      config: { screenIndex: 1 },
      invoke: async () => framePayload,
    });
    const previous = structuredClone(fixture.currentConfig);
    try {
      await expect(
        fixture.service.setCaptureSchedule({ start: "23:00", end: "08:00" }),
      ).resolves.toMatchObject({
        capturePaused: false,
        captureSchedulePaused: true,
        captureSchedule: { start: "23:00", end: "08:00" },
      });
      fixture.service.setCapturePaused(false);
      expect(fixture.service.status().captureSchedulePaused).toBe(true);
      fixture.service.setCapturePaused(true);
      await expect(fixture.service.setCaptureSchedule(null)).resolves.toMatchObject({
        capturePaused: true,
        captureSchedulePaused: false,
        captureSchedule: null,
      });
      expect(fixture.currentConfig).toEqual(previous);
    } finally {
      await fixture.service.stop();
      rmSync(fixture.dataDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("rejects invalid schedules and failed writes without removing the saved pause", async () => {
    const schedule = { start: "23:00", end: "08:00" };
    const fixture = makeService({
      nodes: [],
      config: { captureSchedule: schedule },
      invoke: async () => framePayload,
      mutateConfig: async () => {
        throw new Error("disk unavailable");
      },
    });
    try {
      for (const invalid of [
        undefined,
        {},
        [],
        "23:00",
        { start: "9:00", end: "08:00" },
        { start: "24:00", end: "08:00" },
        { start: "23:60", end: "08:00" },
        { ...schedule, extra: true },
      ]) {
        await expect(fixture.service.setCaptureSchedule(invalid)).rejects.toThrow(
          "captureSchedule",
        );
        if (invalid !== undefined) {
          expect(() => resolveLogbookConfig({ captureSchedule: invalid })).toThrow(
            "captureSchedule",
          );
        }
      }
      expect(fixture.mutateConfigFile).not.toHaveBeenCalled();
      await expect(fixture.service.setCaptureSchedule(null)).rejects.toThrow("disk unavailable");
      expect(fixture.service.status().captureSchedule).toEqual(schedule);
    } finally {
      await fixture.service.stop();
      rmSync(fixture.dataDir, { recursive: true, force: true });
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
        await service.setCaptureSchedule({ start: "09:00", end: "11:00" });
        expect(service.status().captureSchedulePaused).toBe(true);
        await expect(service.analyzeNow()).resolves.toEqual({ started: true });
        await vi.waitFor(() => expect(service.status().lastBatch?.status).toBe("done"));
        expect(service.timelineForDay("2026-08-01").cards).toMatchObject([
          { title: "Editing a document" },
        ]);
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
        await service.stop();
        rmSync(dataDir, { recursive: true, force: true });
        vi.useRealTimers();
      }
    },
  );
});

describe("LogbookService text completion validation", () => {
  it("does not restore a stale standup after its source timeline changes", async () => {
    const fixture = makeService({
      nodes: [],
      invoke: async () => framePayload,
      complete: async () => {
        const writer = new LogbookStore(fixture.dataDir);
        try {
          writer.replaceCardsInWindow("2026-08-01", 1, 1000, [
            {
              day: "2026-08-01",
              startMs: 1,
              endMs: 1000,
              title: "Updated",
              summary: "New evidence",
              detail: "",
              category: "other",
              distractions: [],
            },
          ]);
        } finally {
          writer.close();
        }
        return { text: "Old evidence summary" };
      },
    });
    try {
      await expect(fixture.service.standup("2026-08-01", true)).rejects.toThrow("timeline changed");
      const reader = new LogbookStore(fixture.dataDir);
      try {
        expect(reader.getStandup("2026-08-01")).toBeNull();
      } finally {
        reader.close();
      }
    } finally {
      await fixture.service.stop();
      rmSync(fixture.dataDir, { recursive: true, force: true });
    }
  });

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
      await service.stop();
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
      await service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("LogbookService bounded observation dispatch", () => {
  it("dispatches no more than four screenshots per vision request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T10:00:00"));
    let frame = 0;
    const extractStructured = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        version: 1,
        target: "Editor",
        activity: "Editing",
        result: "",
        unresolved: "",
        uncertainty: "",
      }),
    });
    const fixture = makeService({
      nodes: [{ nodeId: "capture-node", commands: ["screen.snapshot"] }],
      invoke: async () => ({
        payload: { format: "jpeg", base64: Buffer.from(`frame-${frame++}`).toString("base64") },
      }),
      config: { visionModel: "ollama/local-vision-model" },
      extractStructured,
      complete: async () => ({
        text: JSON.stringify([
          {
            startTime: "10:00:00",
            endTime: "10:03:30",
            title: "Editing",
            summary: "Editing a file",
          },
        ]),
      }),
    });
    try {
      for (let i = 0; i < 8; i += 1) {
        vi.setSystemTime(new Date("2026-08-01T10:00:00").getTime() + i * 30_000);
        await fixture.tick();
      }
      await fixture.service.analyzeNow();
      await vi.waitFor(() => expect(fixture.service.status().analysisRunning).toBe(false));
      expect(extractStructured.mock.calls.map(([request]) => request.input.length)).toEqual([4, 4]);
      expect(fixture.service.status().lastBatch?.status).toBe("done");
    } finally {
      await fixture.service.stop();
      rmSync(fixture.dataDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});
