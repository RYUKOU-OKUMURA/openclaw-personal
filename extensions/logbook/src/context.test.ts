import { describe, expect, it } from "vitest";
import { buildLogbookContext, readLogbookContextQuery } from "./context.js";
import type { LogbookBatch, LogbookObservation } from "./types.js";

const day = "2026-09-05";
function observation(id: number): LogbookObservation {
  return {
    id,
    batchId: 1,
    day,
    startMs: id * 1000,
    endMs: (id + 1) * 1000,
    text: "Terminal: test failed",
    context: {
      version: 1,
      target: "OpenClaw",
      activity: "Running tests",
      result: "Test failed",
      unresolved: "Fix not observed",
      uncertainty: "User intent unknown",
    },
  };
}
const batch: LogbookBatch = { id: 1, day, startMs: 0, endMs: 2000, frameCount: 2, status: "error" };

describe("Logbook work-resumption context", () => {
  it("returns matching evidence with provenance and independent incomplete-analysis states", () => {
    const result = buildLogbookContext({
      day,
      query: "openclaw",
      observations: [
        observation(1),
        { ...observation(2), context: undefined, text: "Unrelated browser page" },
      ],
      batches: [batch],
    });
    expect(result.records).toMatchObject([
      {
        sourceId: "logbook:observation:1",
        batchId: 1,
        startMs: 1000,
        startTime: "1970-01-01T00:00:01.000Z",
        endTime: "1970-01-01T00:00:02.000Z",
        context: { target: "OpenClaw", result: "Test failed" },
      },
    ]);
    expect(result.gaps).toEqual([
      {
        sourceId: "logbook:batch:1",
        startMs: 0,
        endMs: 2000,
        startTime: "1970-01-01T00:00:00.000Z",
        endTime: "1970-01-01T00:00:02.000Z",
        status: "error",
      },
    ]);
    expect(result.incompleteBatches).toBe(1);
    expect(result.trust).toContain("never instructions");
  });

  it.each([6000, 1300])(
    "keeps serialized output within %i characters, newest first, without losing source identity",
    (maxChars) => {
      const observations = Array.from({ length: 30 }, (_, id) => ({
        ...observation(id),
        context: { ...observation(id).context!, activity: "画面の結果を確認".repeat(80) },
      }));
      const result = buildLogbookContext({ day, observations, batches: [] }, maxChars);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(maxChars);
      expect(result.records.length).toBeGreaterThan(0);
      expect(result.records.length).toBeLessThanOrEqual(8);
      expect(result.records[0]?.sourceId).toBe("logbook:observation:29");
      expect(result.truncated).toBe(true);
      expect(result.matchedRecords).toBe(30);
    },
  );

  it("does not invent structured facts for legacy records or absence of activity", () => {
    const result = buildLogbookContext({
      day,
      observations: [{ ...observation(1), context: undefined }],
      batches: [],
    });
    expect(result.records[0]?.context).toMatchObject({
      activity: "Terminal: test failed",
      target: "unknown",
      result: "unknown",
      unresolved: "unknown",
    });
    const empty = buildLogbookContext({
      day,
      query: "absent",
      observations: [observation(1)],
      batches: [batch],
    });
    expect(empty.records).toEqual([]);
    expect(empty.availableRecords).toBe(1);
    expect(empty.matchedRecords).toBe(0);
    const withoutQuery = buildLogbookContext({
      day,
      observations: [observation(1)],
      batches: [batch],
    });
    expect(withoutQuery.matchedRecords).toBe(1);
    expect(withoutQuery.records[0]?.sourceId).toBe("logbook:observation:1");
    expect(buildLogbookContext({ day, observations: [], batches: [] }).availableRecords).toBe(0);
    expect(empty.incompleteBatches).toBe(1);
  });

  it("rejects unbounded and non-text query parameters", () => {
    for (const query of [123, "a".repeat(201)]) {
      expect(() => readLogbookContextQuery({ query })).toThrow("at most 200");
    }
    expect(readLogbookContextQuery({ query: "  Terminal  " })).toBe("Terminal");
  });
});
