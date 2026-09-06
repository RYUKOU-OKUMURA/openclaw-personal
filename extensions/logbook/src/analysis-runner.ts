// Durable observation chunks and card synthesis share one retry owner.
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  CARD_LOOKBACK_MS,
  MAX_FRAMES_PER_CALL,
  parseCardsJson,
  parseObservationSegments,
  pickKeyframeId,
  revisionWindow,
  sampleFrames,
  validateCardCoverage,
} from "./analyze.js";
import type { LogbookConfig } from "./config.js";
import {
  buildCardsCorrectionPrompt,
  buildCardsPrompt,
  buildObservationInstructions,
  OBSERVATION_JSON_SCHEMA,
} from "./prompts.js";
import type { LogbookStore } from "./store.js";
import type { LogbookBatch } from "./types.js";

// Bound the vision work and output independently of the 15-minute timeline window.
const OBSERVATION_CHUNK_SIZE = 4;
type BatchParams = {
  batch: LogbookBatch;
  store: LogbookStore;
  runtime: NonNullable<OpenClawPluginApi["runtime"]>;
  fullConfig: OpenClawConfig;
  config: LogbookConfig;
  logger: PluginLogger;
  vision: { provider: string; model: string; profile?: string; preferredProfile?: string };
  signal: AbortSignal;
};

export async function runLogbookBatch(params: BatchParams): Promise<void> {
  const { batch, store, runtime, fullConfig, vision, signal } = params;
  try {
    signal.throwIfAborted();
    let cursor = batch.observationCursor ?? batch.startMs;
    // Legacy full-batch observations may already exist after a text-stage failure.
    const existing = store
      .observationsInRange(batch.day, batch.startMs, batch.endMs)
      .filter((observation) => observation.batchId === batch.id);
    if (batch.observationCursor === undefined && existing.length > 0) {
      const coverage = validateCardCoverage({
        drafts: existing,
        requiredSpans: [batch],
        windowStartMs: batch.startMs,
        windowEndMs: batch.endMs,
      });
      if (coverage.ok) {
        cursor = batch.endMs;
      }
    }
    if (cursor < batch.endMs) {
      const frames = store.batchFrames(batch.id);
      if (frames.length !== batch.frameCount) {
        store.beginBatch(batch.id);
        throw new Error(
          "source frames expired or missing; analysis cannot reconstruct this interval",
        );
      }
      const sampled = sampleFrames(frames, MAX_FRAMES_PER_CALL);
      for (let offset = 0; offset < sampled.length; offset += OBSERVATION_CHUNK_SIZE) {
        const chunk = sampled.slice(offset, offset + OBSERVATION_CHUNK_SIZE);
        const startMs = offset === 0 ? batch.startMs : chunk[0]!.capturedAtMs;
        const endMs = sampled[offset + OBSERVATION_CHUNK_SIZE]?.capturedAtMs ?? batch.endMs;
        if (endMs <= cursor) {
          continue;
        }
        store.beginBatch(batch.id, `${vision.provider}/${vision.model}`);
        const result = await runtime.mediaUnderstanding.extractStructuredWithModel({
          ...vision,
          input: chunk.map((frame) => ({
            type: "image" as const,
            buffer: readFileSync(frame.path),
            fileName: path.basename(frame.path),
            mime: "image/jpeg",
          })),
          instructions: buildObservationInstructions({
            frameTimes: chunk.map((frame) => frame.capturedAtMs),
            startMs,
            endMs,
          }),
          schemaName: "logbook.observations",
          jsonSchema: OBSERVATION_JSON_SCHEMA,
          cfg: fullConfig,
          maxTokens: 1024,
          timeoutMs: 180_000,
          signal,
        });
        // Cancellation/restart must never write into a closed or replacement store.
        signal.throwIfAborted();
        const segments = parseObservationSegments({
          raw: result.text ?? "",
          day: batch.day,
          startMs,
          endMs,
        });
        if (segments.length === 0) {
          throw new Error("vision model returned no usable segments");
        }
        store.checkpointObservations(batch, endMs, segments);
        cursor = endMs;
      }
    }
    store.beginBatch(batch.id);
    await reviseCards(params);
    signal.throwIfAborted();
    store.setBatchStatus(batch.id, "done");
  } catch (error) {
    if (signal.aborted) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    store.setBatchStatus(batch.id, "error", message);
    params.logger.warn(`logbook: batch ${batch.id} failed: ${message}`);
  }
}

async function reviseCards(params: BatchParams): Promise<void> {
  const { batch, store, runtime, config, signal } = params;
  const lookbackStart = batch.startMs - CARD_LOOKBACK_MS;
  const previousCards = store.cardsForDay(batch.day, {
    startMs: lookbackStart,
    endMs: batch.endMs,
  });
  const observations = store.observationsInRange(
    batch.day,
    Math.min(lookbackStart, batch.startMs),
    batch.endMs,
  );
  const window = revisionWindow({
    batchStartMs: batch.startMs,
    batchEndMs: batch.endMs,
    previousCards,
  });
  const prompt = buildCardsPrompt({
    day: batch.day,
    observations,
    previousCards,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
  });
  // Coverage is validated alongside parsing: a partial-but-valid output must
  // trigger the repair round-trip instead of erasing previous cards below.
  const requiredSpans = [
    ...previousCards.map((card) => ({ startMs: card.startMs, endMs: card.endMs })),
    { startMs: batch.startMs, endMs: batch.endMs },
  ];
  const evaluate = (raw: string) => {
    const parsed = parseCardsJson({
      raw,
      day: batch.day,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
    });
    if (!parsed.ok) {
      return parsed;
    }
    const coverage = validateCardCoverage({
      drafts: parsed.drafts,
      requiredSpans,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
    });
    return coverage.ok ? parsed : { ok: false as const, error: coverage.error };
  };
  const first = await runtime.llm.complete({
    model: config.textModel,
    signal,
    messages: [{ role: "user", content: prompt }],
    purpose: "logbook.cards",
    maxTokens: 4000,
  });
  signal.throwIfAborted();
  let parsed = evaluate(first.text);
  if (!parsed.ok) {
    const retry = await runtime.llm.complete({
      model: config.textModel,
      signal,
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: first.text },
        { role: "user", content: buildCardsCorrectionPrompt(parsed.error) },
      ],
      purpose: "logbook.cards.repair",
      maxTokens: 4000,
    });
    signal.throwIfAborted();
    parsed = evaluate(retry.text);
  }
  if (!parsed.ok) {
    throw new Error(`card synthesis failed validation: ${parsed.error}`);
  }
  const windowFrames = store
    .framesInRange(window.startMs, window.endMs)
    .map((frame) => ({ id: frame.id, capturedAtMs: frame.capturedAtMs }));
  const drafts = parsed.drafts.map((draft) =>
    Object.assign(draft, { keyframeId: pickKeyframeId(draft, windowFrames) }),
  );
  store.replaceCardsInWindow(batch.day, window.startMs, window.endMs, drafts);
}
