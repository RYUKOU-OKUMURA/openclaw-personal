// Logbook background service: snapshot capture loop, batch analysis, retention.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import { runLogbookBatch } from "./analysis-runner.js";
import { selectBatchFrames } from "./analyze.js";
import {
  parseModelRef,
  resolveLogbookConfig,
  parseLogbookCaptureSchedule,
  isLogbookCaptureScheduledPaused,
  type LogbookConfig,
} from "./config.js";
import { buildLogbookContext } from "./context.js";
import { buildAskPrompt, buildStandupPrompt } from "./prompts.js";
import { dayKeyFor, LogbookStore } from "./store.js";
import type { LogbookBatch, LogbookStatus } from "./types.js";

const ANALYSIS_TICK_MS = 60 * 1000;
const PRUNE_TICK_MS = 60 * 60 * 1000;
const MODEL_MISSING_MESSAGE =
  "no vision model: set plugins.entries.logbook.config.visionModel or configure tools.media";
const MODEL_MISSING_LOG_INTERVAL_MS = 10 * 60 * 1000;
const CAPTURE_FAILURE_PAUSE_TICKS = 10;
const CAPTURE_FAILURE_THRESHOLD = 3;
const JPEG_QUALITY = 0.6;
// Preserve the established Codex route for borrowed media defaults.
// Other structured providers require an explicit visionModel.
const STRUCTURED_MEDIA_PROVIDER = "codex";
type SnapshotPayload = {
  format?: string;
  base64?: unknown;
  width?: number;
  height?: number;
  error?: string;
};

/** node.invoke responses wrap the node result in {payload, payloadJSON}. */
function unwrapInvokePayload(raw: unknown): SnapshotPayload | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const envelope = raw as { payload?: unknown; payloadJSON?: string | null };
  if (envelope.payload && typeof envelope.payload === "object") {
    return envelope.payload as SnapshotPayload;
  }
  if (typeof envelope.payloadJSON === "string" && envelope.payloadJSON.length > 0) {
    try {
      return JSON.parse(envelope.payloadJSON) as SnapshotPayload;
    } catch {
      return null;
    }
  }
  // Tolerate transports that already deliver the bare node payload.
  return "base64" in envelope || "error" in envelope ? (envelope as SnapshotPayload) : null;
}

/** Capture commands in preference order: app nodes first, headless node hosts second. */
const CAPTURE_COMMANDS = ["screen.snapshot", "logbook.snapshot"] as const;

export class LogbookService {
  private store: LogbookStore | null = null;
  private readonly operations = new Set<Promise<unknown>>();
  private stopping: Promise<void> | undefined;
  private lifetime = new AbortController();
  private captureTimer: NodeJS.Timeout | null = null;
  private analysisTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private captureInFlight = false;
  private analysisInFlight = false;
  private capturePaused = false;
  private captureFailures = 0;
  private captureBackoffTicks = 0;
  private lastCaptureAtMs: number | undefined;
  private lastCaptureError: string | undefined;
  private lastModelMissingLogMs = 0;
  private cachedNode: { nodeId: string; displayName?: string; command: string } | null = null;
  // Nodes whose captures failed this rotation; skipped until every candidate
  // has failed once, then retried so transient outages self-heal.
  private failedNodeIds = new Set<string>();

  constructor(
    private readonly config: LogbookConfig,
    private readonly deps: {
      runtime: NonNullable<OpenClawPluginApi["runtime"]>;
      fullConfig: OpenClawConfig;
      logger: PluginLogger;
      dataDir: string;
    },
  ) {}

  start(): void {
    this.stopping = undefined;
    this.lifetime = new AbortController();
    this.store = new LogbookStore(this.deps.dataDir);
    // Interrupted stages retain durable progress and their retry budget.
    this.store.resetRunningBatches();
    this.captureTimer = setInterval(() => {
      void this.captureTick();
    }, this.config.captureIntervalSeconds * 1000);
    this.captureTimer.unref?.();
    this.analysisTimer = setInterval(() => {
      void this.analysisTick();
    }, ANALYSIS_TICK_MS);
    this.analysisTimer.unref?.();
    this.pruneTimer = setInterval(() => {
      this.prune();
    }, PRUNE_TICK_MS);
    this.pruneTimer.unref?.();
    this.prune();
    this.deps.logger.info(
      `logbook: started (capture every ${this.config.captureIntervalSeconds}s, analysis window ${this.config.analysisIntervalMinutes}m, data ${this.deps.dataDir})`,
    );
  }

  stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    for (const timer of [this.captureTimer, this.analysisTimer, this.pruneTimer]) {
      if (timer) {
        clearInterval(timer);
      }
    }
    this.captureTimer = null;
    this.analysisTimer = null;
    this.pruneTimer = null;
    const store = this.store;
    // Admitted work retains its connection through its final writes and error recording.
    this.stopping = Promise.allSettled(this.operations).then(() => {
      this.lifetime.abort();
      store?.close();
      this.store = null;
    });
    return this.stopping;
  }

  private trackOperation<T>(run: () => Promise<T>): Promise<T> {
    // Register ownership before runtime hooks can reenter shutdown.
    const operation = Promise.resolve().then(run);
    this.operations.add(operation);
    const settled = () => this.operations.delete(operation);
    void operation.then(settled, settled);
    return operation;
  }

  private requireStore(): LogbookStore {
    if (this.stopping || !this.store) {
      throw new Error("Logbook service is not running");
    }
    return this.store;
  }

  setCapturePaused(paused: boolean): void {
    this.capturePaused = paused;
    if (!paused) {
      this.captureBackoffTicks = 0;
      this.captureFailures = 0;
    }
  }

  private screenIndex(): number {
    return resolveLogbookConfig(
      this.deps.runtime.config.current().plugins?.entries?.logbook?.config,
    ).screenIndex;
  }

  private captureSchedule() {
    return resolveLogbookConfig(
      this.deps.runtime.config.current().plugins?.entries?.logbook?.config,
    ).captureSchedule;
  }

  async setCaptureSchedule(raw: unknown): Promise<LogbookStatus> {
    const schedule = raw === null ? undefined : parseLogbookCaptureSchedule(raw);
    this.requireStore();
    await this.deps.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const config = draft.plugins?.entries?.logbook?.config;
        // Parent creation reloads the plugin and would lose the operator's manual pause.
        if (!config) {
          throw new Error(
            "Initialize Logbook config and restart the Gateway before setting a capture schedule",
          );
        }
        if (schedule) {
          config.captureSchedule = schedule;
        } else {
          delete config.captureSchedule;
        }
      },
    });
    const deadline = Date.now() + 10_000;
    while (true) {
      const current = this.captureSchedule();
      if (current?.start === schedule?.start && current?.end === schedule?.end) {
        return this.status();
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "Capture schedule was saved but not applied; check Gateway config reload and refresh Logbook status",
        );
      }
      await delay(50);
      this.requireStore();
    }
  }

  async setScreenIndex(screenIndex: unknown): Promise<LogbookStatus> {
    if (
      typeof screenIndex !== "number" ||
      !Number.isInteger(screenIndex) ||
      screenIndex < 0 ||
      screenIndex > 16
    ) {
      throw new Error("screenIndex must be an integer from 0 to 16");
    }
    this.requireStore();
    await this.deps.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const config = draft.plugins?.entries?.logbook?.config;
        // Creating the parent object is a broader plugin reload, which resets pause.
        if (!config) {
          throw new Error(
            "Initialize Logbook config with screenIndex and restart the Gateway once before using live display selection",
          );
        }
        config.screenIndex = screenIndex;
      },
    });
    // The managed Gateway applies config asynchronously after the durable write.
    // Confirm the active snapshot rather than keeping a second, divergent choice.
    const deadline = Date.now() + 10_000;
    while (this.screenIndex() !== screenIndex) {
      if (Date.now() >= deadline) {
        throw new Error(
          "Screen selection was saved but not applied; check Gateway config reload and refresh Logbook status",
        );
      }
      await delay(50);
      this.requireStore();
    }
    this.captureBackoffTicks = 0;
    this.captureFailures = 0;
    return this.status();
  }

  private async resolveNode(): Promise<
    { node: { nodeId: string; displayName?: string; command: string } } | { reason: string }
  > {
    if (this.cachedNode) {
      return { node: this.cachedNode };
    }
    const { nodes } = await this.deps.runtime.nodes.list({ connected: true });
    const captureCommand = (node: { commands?: string[] }) =>
      CAPTURE_COMMANDS.find((command) => (node.commands ?? []).includes(command));
    // App nodes (screen.snapshot) come first: plugin node-host commands are
    // advertised on every platform, but logbook.snapshot only captures on
    // macOS, so headless hosts are a fallback rather than the default pick.
    const commandRank = (node: { commands?: string[] }) =>
      CAPTURE_COMMANDS.indexOf(captureCommand(node) as (typeof CAPTURE_COMMANDS)[number]);
    const candidates = nodes
      .filter((node) => captureCommand(node) !== undefined)
      .toSorted((a, b) => commandRank(a) - commandRank(b) || a.nodeId.localeCompare(b.nodeId));
    const wanted = this.config.nodeId?.toLowerCase();
    // Failed nodes rotate to the back until everything has failed once;
    // without this, a broken node that sorts first is re-picked every tick.
    let pool = candidates.filter((node) => !this.failedNodeIds.has(node.nodeId));
    if (pool.length === 0) {
      this.failedNodeIds.clear();
      pool = candidates;
    }
    const picked = wanted
      ? candidates.find(
          (node) =>
            node.nodeId.toLowerCase() === wanted || node.displayName?.toLowerCase() === wanted,
        )
      : pool[0];
    const command = picked ? captureCommand(picked) : undefined;
    if (!picked || !command) {
      const inventory =
        nodes
          .map(
            (node) =>
              `${node.displayName ?? node.nodeId}(${(node.commands ?? []).join("/") || "no commands"})`,
          )
          .join(", ") || "none";
      return {
        reason: `no connected node exposes ${CAPTURE_COMMANDS.join(" or ")}; connected: ${inventory}`,
      };
    }
    this.cachedNode = { nodeId: picked.nodeId, displayName: picked.displayName, command };
    return { node: this.cachedNode };
  }

  private async captureTick(): Promise<void> {
    const store = this.store;
    if (
      this.stopping ||
      !this.config.captureEnabled ||
      this.capturePaused ||
      isLogbookCaptureScheduledPaused(this.captureSchedule()) ||
      this.captureInFlight ||
      !store
    ) {
      return;
    }
    if (this.captureBackoffTicks > 0) {
      this.captureBackoffTicks -= 1;
      return;
    }
    this.captureInFlight = true;
    return this.trackOperation(async () => {
      try {
        const resolved = await this.resolveNode();
        if ("reason" in resolved) {
          if (this.lastCaptureError !== resolved.reason) {
            this.deps.logger.warn(`logbook: ${resolved.reason}`);
          }
          this.lastCaptureError = resolved.reason;
          return;
        }
        // Node discovery can cross a pause boundary or a sleep/resume transition.
        if (this.capturePaused || isLogbookCaptureScheduledPaused(this.captureSchedule())) {
          return;
        }
        const node = resolved.node;
        const screenIndex = this.screenIndex();
        const invoked = await this.deps.runtime.nodes.invoke({
          nodeId: node.nodeId,
          command: node.command,
          params: {
            screenIndex,
            maxWidth: this.config.maxWidth,
            quality: JPEG_QUALITY,
            format: "jpeg",
          },
          timeoutMs: 30_000,
        });
        const raw = unwrapInvokePayload(invoked);
        if (raw?.error) {
          throw new Error(raw.error);
        }
        const rawBase64 = raw?.base64;
        if (rawBase64 === undefined || rawBase64 === "") {
          throw new Error(`${node.command} returned no image payload`);
        }
        if (typeof rawBase64 !== "string") {
          throw new Error(`${node.command} returned invalid image payload`);
        }
        const base64 = canonicalizeBase64(rawBase64);
        if (!base64) {
          throw new Error(`${node.command} returned invalid image payload`);
        }
        const buffer = Buffer.from(base64, "base64");
        const capturedAtMs = Date.now();
        const day = dayKeyFor(capturedAtMs);
        const contentHash = createHash("sha256").update(buffer).digest("hex");
        // Unchanged consecutive frames mean the user is idle (or away); they are
        // stored for the filmstrip but excluded from analysis batches.
        const idle = store.lastFrame()?.contentHash === contentHash;
        const filePath = store.frameFilePath(day, capturedAtMs);
        // Screen captures can contain secrets; keep them owner-only.
        mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        writeFileSync(filePath, buffer, { mode: 0o600 });
        store.insertFrame({
          capturedAtMs,
          day,
          path: filePath,
          screenIndex,
          width: raw?.width,
          height: raw?.height,
          byteSize: buffer.byteLength,
          contentHash,
          idle,
        });
        this.lastCaptureAtMs = capturedAtMs;
        this.lastCaptureError = undefined;
        this.captureFailures = 0;
        this.failedNodeIds.clear();
      } catch (err) {
        this.captureFailures += 1;
        if (this.cachedNode) {
          this.failedNodeIds.add(this.cachedNode.nodeId);
        }
        this.cachedNode = null;
        this.lastCaptureError = err instanceof Error ? err.message : String(err);
        if (this.captureFailures >= CAPTURE_FAILURE_THRESHOLD) {
          this.captureBackoffTicks = CAPTURE_FAILURE_PAUSE_TICKS;
          this.deps.logger.warn(
            `logbook: capture failing (${this.lastCaptureError}); backing off for ${CAPTURE_FAILURE_PAUSE_TICKS} ticks`,
          );
        }
      } finally {
        this.captureInFlight = false;
      }
    });
  }

  private resolveVisionModel(): {
    ref?: { provider: string; model: string; profile?: string; preferredProfile?: string };
    source: LogbookStatus["visionModelSource"];
  } {
    if (this.config.visionModel) {
      const ref = parseModelRef(this.config.visionModel);
      return ref ? { ref, source: "config" } : { source: "missing" };
    }
    const media = this.deps.fullConfig.tools?.media;
    // Operators who disabled image understanding must not have screenshots
    // routed to a provider via the borrowed media defaults.
    if (media?.image?.enabled === false) {
      return { source: "missing" };
    }
    const entries = media?.models ?? [];
    for (const entry of entries) {
      const usable =
        entry.type !== "cli" &&
        entry.provider?.trim().toLowerCase() === STRUCTURED_MEDIA_PROVIDER &&
        typeof entry.model === "string" &&
        (!entry.capabilities || entry.capabilities.includes("image"));
      if (usable) {
        return {
          // Auth profile fields ride along so profile-scoped media credentials
          // keep working when Logbook borrows the media-understanding default.
          ref: {
            provider: STRUCTURED_MEDIA_PROVIDER,
            model: entry.model as string,
            profile: entry.profile,
            preferredProfile: entry.preferredProfile,
          },
          source: "media-defaults",
        };
      }
    }
    return { source: "missing" };
  }

  async analyzeNow(): Promise<{ started: boolean; reason?: string }> {
    const store = this.requireStore();
    if (this.analysisInFlight) {
      return { started: false, reason: "analysis already running" };
    }
    if (!this.resolveVisionModel().ref) {
      return { started: false, reason: MODEL_MISSING_MESSAGE };
    }
    // Explicit action renews an exhausted retry budget, preserving checkpoints.
    store.resetErrorBatches();
    if (!store.nextPendingBatch()) {
      // Force-close the current window so "analyze now" needs no elapsed time.
      if (!this.enqueueNextBatch(store, true)) {
        return { started: false, reason: "no unanalyzed activity captured yet" };
      }
    }
    void this.analysisTick();
    return { started: true };
  }

  private async analysisTick(): Promise<void> {
    const store = this.store;
    if (this.stopping || this.analysisInFlight || !store) {
      return;
    }
    // Without a vision model, leave frames unbatched and batches pending so
    // everything analyzes once the operator configures one; erroring here
    // would permanently strand the assigned frames.
    if (!this.resolveVisionModel().ref) {
      const now = Date.now();
      if (now - this.lastModelMissingLogMs > MODEL_MISSING_LOG_INTERVAL_MS) {
        this.lastModelMissingLogMs = now;
        this.deps.logger.warn(`logbook: analysis paused; ${MODEL_MISSING_MESSAGE}`);
      }
      return;
    }
    this.analysisInFlight = true;
    return this.trackOperation(async () => {
      try {
        if (this.stopping) {
          return;
        }
        this.enqueueElapsedWindow(store);
        for (let i = 0; i < 4 && !this.stopping; i += 1) {
          const batch = store.nextPendingBatch();
          if (!batch) {
            return;
          }
          await this.runBatch(store, batch);
        }
      } catch (err) {
        this.deps.logger.error(`logbook: analysis tick failed: ${String(err)}`);
      } finally {
        this.analysisInFlight = false;
      }
    });
  }

  private enqueueNextBatch(store: LogbookStore, force = false): boolean {
    const selection = selectBatchFrames({
      frames: store.unbatchedActiveFrames(2000),
      windowMs: this.config.analysisIntervalMinutes * 60_000,
      nowMs: Date.now(),
      force,
    });
    if (!selection) {
      return false;
    }
    store.createBatch({
      day: dayKeyFor(selection.startMs),
      startMs: selection.startMs,
      endMs: selection.endMs,
      frameIds: selection.frameIds,
    });
    return true;
  }

  private enqueueElapsedWindow(store: LogbookStore): void {
    // Windows close on elapsed wall-clock or on a capture gap; both cases are
    // resolved by selectBatchFrames against the oldest unbatched frame.
    while (this.enqueueNextBatch(store)) {
      // Continue until all elapsed windows are queued.
    }
  }

  private async runBatch(store: LogbookStore, batch: LogbookBatch): Promise<void> {
    const vision = this.resolveVisionModel();
    if (!vision.ref) {
      return;
    }
    await runLogbookBatch({
      batch,
      store,
      runtime: this.deps.runtime,
      fullConfig: this.deps.fullConfig,
      config: this.config,
      logger: this.deps.logger,
      vision: vision.ref,
      signal: this.lifetime.signal,
    });
  }

  async standup(
    day: string,
    refresh: boolean,
  ): Promise<{ day: string; text: string; updatedMs: number }> {
    const store = this.requireStore();
    const signal = this.lifetime.signal;
    return this.trackOperation(async () => {
      if (!refresh) {
        const cached = store.getStandup(day);
        if (cached) {
          return cached;
        }
      }
      const previousDay = dayKeyFor(new Date(`${day}T12:00:00`).getTime() - 24 * 60 * 60 * 1000);
      const cards = store.cardsForDay(day);
      const previousDayCards = store.cardsForDay(previousDay);
      const source = JSON.stringify([cards, previousDayCards]);
      const result = await this.deps.runtime.llm.complete({
        model: this.config.textModel,
        signal,
        messages: [
          {
            role: "user",
            content: buildStandupPrompt({
              day,
              cards,
              previousDayCards,
            }),
          },
        ],
        purpose: "logbook.standup",
        maxTokens: 800,
      });
      signal.throwIfAborted();
      const text = result.text.trim();
      if (!text) {
        throw new Error("standup model returned no text");
      }
      if (source !== JSON.stringify([store.cardsForDay(day), store.cardsForDay(previousDay)])) {
        throw new Error("timeline changed while generating the standup; generate it again");
      }
      store.saveStandup(day, text);
      const saved = store.getStandup(day);
      if (!saved) {
        throw new Error("standup save failed");
      }
      return saved;
    });
  }

  async ask(day: string, question: string): Promise<string> {
    const store = this.requireStore();
    const signal = this.lifetime.signal;
    return this.trackOperation(async () => {
      const observations = store.observationsInRange(day, 0, Number.MAX_SAFE_INTEGER, 200);
      const result = await this.deps.runtime.llm.complete({
        model: this.config.textModel,
        signal,
        messages: [
          {
            role: "user",
            content: buildAskPrompt({
              day,
              cards: store.cardsForDay(day),
              observations,
              question,
            }),
          },
        ],
        purpose: "logbook.ask",
        maxTokens: 600,
      });
      signal.throwIfAborted();
      const text = result.text.trim();
      if (!text) {
        throw new Error("question answering model returned no text");
      }
      return text;
    });
  }

  // ── Introspection ──────────────────────────────────────────────────

  context(params: { day: string; query?: string }, maxChars = 6000) {
    const store = this.requireStore();
    return buildLogbookContext(
      {
        ...params,
        observations: store.observationsInRange(params.day, 0, Number.MAX_SAFE_INTEGER),
        batches: store.batchesForDay(params.day),
      },
      maxChars,
    );
  }

  deleteDay(day: string) {
    if (this.analysisInFlight || this.captureInFlight || this.operations.size > 0) {
      throw new Error("Logbook is busy; wait for active capture or analysis before deleting a day");
    }
    return this.requireStore().deleteDay(day);
  }

  timelineForDay(day: string): ReturnType<LogbookStore["timelineForDay"]> {
    return this.requireStore().timelineForDay(day);
  }

  listDays(): ReturnType<LogbookStore["listDays"]> {
    return this.requireStore().listDays();
  }

  frameById(id: number): ReturnType<LogbookStore["frameById"]> {
    return this.requireStore().frameById(id);
  }

  framesInRange(startMs: number, endMs: number): ReturnType<LogbookStore["framesInRange"]> {
    return this.requireStore().framesInRange(startMs, endMs);
  }

  status(): LogbookStatus {
    const store = this.requireStore();
    const today = dayKeyFor(Date.now());
    const latestBatch = store.latestBatch();
    const vision = this.resolveVisionModel();
    const captureSchedule = this.captureSchedule();
    return {
      captureEnabled: this.config.captureEnabled,
      capturePaused: this.capturePaused,
      captureSchedule: captureSchedule ?? null,
      captureSchedulePaused: isLogbookCaptureScheduledPaused(captureSchedule),
      screenIndex: this.screenIndex(),
      captureIntervalSeconds: this.config.captureIntervalSeconds,
      analysisIntervalMinutes: this.config.analysisIntervalMinutes,
      retentionDays: this.config.retentionDays,
      nodeId: this.cachedNode?.nodeId ?? this.config.nodeId,
      nodeName: this.cachedNode?.displayName,
      lastCaptureAtMs: this.lastCaptureAtMs,
      lastCaptureError: this.lastCaptureError,
      pendingFrames: store.countUnbatchedActiveFrames(),
      analysisRunning: this.analysisInFlight,
      lastBatch: latestBatch
        ? {
            id: latestBatch.id,
            day: latestBatch.day,
            status: latestBatch.status,
            endMs: latestBatch.endMs,
            error: latestBatch.error,
          }
        : undefined,
      visionModel: vision.ref ? `${vision.ref.provider}/${vision.ref.model}` : undefined,
      visionModelSource: vision.source,
      today,
      todayCards: store.countCardsForDay(today),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  private prune(): void {
    if (!this.store) {
      return;
    }
    const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
    const unfinishedCutoff = Date.now() - Math.max(this.config.retentionDays, 7) * 86_400_000;
    const removed = this.store.pruneFrames(cutoff, unfinishedCutoff);
    if (removed > 0) {
      this.deps.logger.info(
        `logbook: pruned ${removed} frames older than ${this.config.retentionDays}d`,
      );
    }
  }
}
