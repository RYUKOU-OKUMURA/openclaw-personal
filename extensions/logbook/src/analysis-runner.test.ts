import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLogbookBatch } from "./analysis-runner.js";
import { resolveLogbookConfig } from "./config.js";
import { logbookSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
const workerModuleUrl = resolveRuntimeWorkerUrl(logbookSqliteBackendEntrypoint);
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
async function fixture() {
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-progress-")));
  const store = await LogbookStore.open(dataDir, workerModuleUrl);
  const ids = await Promise.all(
    Array.from({ length: 8 }, async (_, i) => {
      const timestamp = startMs + i * 30_000;
      const file = store.frameFilePath(day, timestamp);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "synthetic-jpeg");
      return await store.insertFrame({
        capturedAtMs: timestamp,
        day,
        path: file,
        screenIndex: 0,
        byteSize: 14,
        contentHash: `${i}`,
        idle: false,
      });
    }),
  );
  await store.createBatch({ day, startMs, endMs: startMs + 240_000, frameIds: ids });
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
    batch: (await store.nextPendingBatch())!,
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
    const f = await fixture();
    let active = f.store;
    try {
      f.extract
        .mockResolvedValueOnce({ text: JSON.stringify(record) })
        .mockRejectedValueOnce(new Error("request timed out"));
      await runLogbookBatch(f.params);
      expect(f.extract.mock.calls.map(([request]) => request.input.length)).toEqual([4, 4]);
      expect(await active.observationsInRange(day, 0, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
      expect(await active.latestBatch()).toMatchObject({
        status: "error",
        observationCursor: startMs + 120_000,
      });
      expect(await active.nextPendingBatch()).toBeNull();
      await active.close();
      active = await LogbookStore.open(f.dataDir, workerModuleUrl);
      await active.resetRunningBatches();

      await runLogbookBatch({
        ...f.params,
        store: active,
        batch: (await active.nextPendingBatch(Number.MAX_SAFE_INTEGER))!,
      });
      expect(f.extract).toHaveBeenCalledTimes(3);
      expect((await active.latestBatch())?.status).toBe("done");
      expect(
        (await active.observationsInRange(day, 0, Number.MAX_SAFE_INTEGER)).map(
          (obs) => obs.startMs,
        ),
      ).toEqual([startMs, startMs + 120_000]);
      expect(await active.cardsForDay(day)).toHaveLength(1);
    } finally {
      await active.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("retries text synthesis from saved observations without spending another vision call", async () => {
    const f = await fixture();
    try {
      f.complete.mockRejectedValueOnce(new Error("text unavailable"));
      await runLogbookBatch(f.params);
      expect(await f.store.latestBatch()).toMatchObject({
        status: "error",
        observationCursor: startMs + 240_000,
      });

      await runLogbookBatch({
        ...f.params,
        batch: (await f.store.nextPendingBatch(Number.MAX_SAFE_INTEGER))!,
      });
      expect(f.extract).toHaveBeenCalledTimes(2);
      expect((await f.store.latestBatch())?.status).toBe("done");
    } finally {
      await f.store.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("bounds unreadable image retries even when metadata still contains the source frame", async () => {
    const f = await fixture();
    try {
      rmSync(f.store.frameFilePath(day, startMs));
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const batch = await f.store.nextPendingBatch(Number.MAX_SAFE_INTEGER);
        expect(batch).not.toBeNull();
        await runLogbookBatch({ ...f.params, batch: batch! });
        expect(await f.store.latestBatch()).toMatchObject({ status: "error", attempts: attempt });
      }
      expect(await f.store.nextPendingBatch(Number.MAX_SAFE_INTEGER)).toBeNull();
      expect(f.extract).not.toHaveBeenCalled();
    } finally {
      await f.store.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  it("does not write late model output after cancellation closes the store", async () => {
    const f = await fixture();
    let finish!: (value: { text: string }) => void;
    f.extract.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const work = runLogbookBatch(f.params);
    await vi.waitFor(() => expect(f.extract).toHaveBeenCalledOnce());
    f.controller.abort();
    await f.store.close();
    finish({ text: JSON.stringify(record) });
    try {
      await expect(work).resolves.toBeUndefined();
      const reopened = await LogbookStore.open(f.dataDir, workerModuleUrl);
      try {
        expect(await reopened.observationsInRange(day, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
        expect((await reopened.latestBatch())?.status).toBe("running");
      } finally {
        await reopened.close();
      }
    } finally {
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });
});
