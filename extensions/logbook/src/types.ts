// Shared Logbook domain shapes used by the store, pipeline, and gateway methods.
import type { LogbookCaptureSchedule } from "./config.js";

export type LogbookFrame = {
  id: number;
  capturedAtMs: number;
  day: string;
  path: string;
  screenIndex: number;
  width?: number;
  height?: number;
  byteSize: number;
  idle: boolean;
};

export type LogbookBatchStatus = "pending" | "running" | "done" | "error";

export type LogbookBatch = {
  id: number;
  day: string;
  startMs: number;
  endMs: number;
  status: LogbookBatchStatus;
  error?: string;
  frameCount: number;
  model?: string;
  observationCursor?: number;
  attempts?: number;
  retryAfterMs?: number;
};

export type LogbookObservationContext = {
  version: 1;
  target: string;
  activity: string;
  result: string;
  unresolved: string;
  uncertainty: string;
};

export type LogbookObservation = {
  id: number;
  batchId: number;
  day: string;
  startMs: number;
  endMs: number;
  text: string;
  context?: LogbookObservationContext;
};

export type LogbookObservationSegment = Pick<
  LogbookObservation,
  "startMs" | "endMs" | "text" | "context"
>;

export type LogbookDistraction = {
  startMs: number;
  endMs: number;
  title: string;
};

export type LogbookCard = {
  id: number;
  day: string;
  startMs: number;
  endMs: number;
  title: string;
  summary: string;
  detail: string;
  category: string;
  appPrimary?: string;
  appSecondary?: string;
  distractions: LogbookDistraction[];
  keyframeId?: number;
};

export type LogbookCardDraft = Omit<LogbookCard, "id">;

export type LogbookDayStats = {
  trackedMs: number;
  distractionMs: number;
  categories: Array<{ category: string; ms: number }>;
  apps: Array<{ domain: string; ms: number }>;
};

export type LogbookStatus = {
  captureEnabled: boolean;
  capturePaused: boolean;
  captureSchedule: LogbookCaptureSchedule | null;
  captureSchedulePaused: boolean;
  screenIndex: number;
  captureIntervalSeconds: number;
  analysisIntervalMinutes: number;
  retentionDays: number;
  nodeId?: string;
  nodeName?: string;
  lastCaptureAtMs?: number;
  lastCaptureError?: string;
  pendingFrames: number;
  analysisRunning: boolean;
  lastBatch?: Pick<LogbookBatch, "id" | "day" | "status" | "endMs" | "error">;
  visionModel?: string;
  visionModelSource: "config" | "media-defaults" | "missing";
  today: string;
  todayCards: number;
  timeZone: string;
};
