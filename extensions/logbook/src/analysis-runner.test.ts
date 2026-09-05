import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLogbookBatch } from "./analysis-runner.js";
import { resolveLogbookConfig } from "./config.js";
import { LogbookStore } from "./store.js";

const day = "2026-09-05";
const startMs = new Date(`${day}T10:00:00`).getTime();
const record = {
  version: 1,
  target: "Editor: project",
  activity: "Editing a document",
  result: "",
  unresolved: "",
  uncertainty: "Samples only",
};
function fixture() {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-progress-")));
  const store = new LogbookStore(dataDir);
  const ids = Array.from({ length: 8 }, (_, i) => {
    const timestamp = startMs + i * 30_000;
    const file = store.frameFilePath(day, timestamp);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "synthetic-jpeg");
    return store.insertFrame({
      capturedAtMs: timestamp,
      day,
      path: file,
      screenIndex: 0,
      byteSize: 14,
      contentHash: `${i}`,
      idle: false,
    });
  });
  store.createBatch({ day, startMs, endMs: startMs + 240_000, frameIds: ids });
  const controller = new AbortController();
  const extract = vi.fn().mockResolvedValue({ text: JSON.stringify(record) });
  const complete = vi.fn().mockResolvedValue({
    text: JSON.stringify([
      {
        startTime: "10:00:00",
        endTime: "10:04:00",
        title: "Editing",
        summary: "Edited the document",
      },
    ]),
  });
  const params = {
    batch: store.nextPendingBatch()!,
    store,
    runtime: {
      mediaUnderstanding: { extractStructuredWithModel: extract },
      llm: { complete },
    } as never,
    fullConfig: {},
    config: resolveLogbookConfig({ captureEnabled: false, textModel: "ollama/local-model" }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    vision: { provider: "ollama", model: "local-model" },
    signal: controller.signal,
  };
  return { dataDir, store, params, extract, complete, controller };
}

describe("durable Logbook analysis", () => {
  afterEach(() => vi.useRealTimers());

  it("preserves the first chunk through timeout and restart and retries only missing work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(startMs + 300_000);
    const f = fixture();
    let active = f.store;
    try {
      f.extract
        .mockResolvedValueOnce({ text: JSON.stringify(record) })
        .mockRejectedValueOnce(new Error("request timed out"));
      await runLogbookBatch(f.params);
      expect(f.extract.mock.calls.map(([request]) => request.input.length)).toEqual([4, 4]);
      expect(active.observationsInRange(day, 0, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
      expect(active.latestBatch()).toMatchObject({
        status: "error",
        observationCursor: startMs + 120_000,
      });
      expect(active.nextPendingBatch()).toBeNull();
      active.close();
      active = new LogbookStore(f.dataDir);
      active.resetRunningBatches();
      vi.setSystemTime(startMs + 361_000);
      await runLogbookBatch({ ...f.params, store: active, batch: active.nextPendingBatch()! });
      expect(f.extract).toHaveBeenCalledTimes(3);
      expect(active.latestBatch()?.status).toBe("done");
      expect(
        active.observationsInRange(day, 0, Number.MAX_SAFE_INTEGER).map((obs) => obs.startMs),
      ).toEqual([startMs, startMs + 120_000]);
      expect(active.cardsForDay(day)).toHaveLength(1);
    } finally {
      active.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("retries text synthesis from saved observations without spending another vision call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(startMs + 300_000);
    const f = fixture();
    try {
      f.complete.mockRejectedValueOnce(new Error("text unavailable"));
      await runLogbookBatch(f.params);
      expect(f.store.latestBatch()).toMatchObject({
        status: "error",
        observationCursor: startMs + 240_000,
      });
      vi.setSystemTime(startMs + 361_000);
      await runLogbookBatch({ ...f.params, batch: f.store.nextPendingBatch()! });
      expect(f.extract).toHaveBeenCalledTimes(2);
      expect(f.store.latestBatch()?.status).toBe("done");
    } finally {
      f.store.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("does not write late model output after cancellation closes the store", async () => {
    const f = fixture();
    let finish!: (value: { text: string }) => void;
    f.extract.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const work = runLogbookBatch(f.params);
    f.controller.abort();
    f.store.close();
    finish({ text: JSON.stringify(record) });
    try {
      await expect(work).resolves.toBeUndefined();
      const reopened = new LogbookStore(f.dataDir);
      try {
        expect(reopened.observationsInRange(day, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
        expect(reopened.latestBatch()?.status).toBe("running");
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });
});
