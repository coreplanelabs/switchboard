import { describe, expect, it } from "vitest";
import { llmUsdOfUsage, type ModelPriceTable } from "./modelPricing.js";
import {
  blobOf,
  blobColumn,
  doubleColumn,
  dominantFriction,
  doubleOf,
  isRunMetricsPoint,
  MAX_POINT_BLOB_BYTES,
  POINT_COLUMNS,
  pointOf,
  pointTurnsFinal,
  type RunMetricsPoint,
} from "./runMetrics.js";
import { FRICTION_CATEGORIES, type FrictionCategory } from "./runFriction.js";
import type { RunRecord } from "./runRecord.js";
import type { RunUsage } from "./runUsage.js";

// Feature: docs/reference/specs/run-metrics.md — the point every finished run
// writes: `POINT_COLUMNS`, `pointOf`, `isRunMetricsPoint`, `pointTurnsFinal`.

const NOW = 1_800_000_000_000;

const ZERO = { count: 0, durationMs: 0 };
const byCategory = (over: Partial<Record<FrictionCategory, { count: number; durationMs: number }>> = {}) =>
  Object.fromEntries(FRICTION_CATEGORIES.map((c) => [c, over[c] ?? ZERO])) as RunRecord["diagnosis"]["byCategory"];

const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
  turns: 14,
  byModel: {
    "anthropic/claude-fable-5": {
      turns: 14,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheWriteTokens: 300,
    },
  },
  ...over,
});

const PRICES: ModelPriceTable = {
  "anthropic/claude-fable-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    agent: "ship",
    model: "anthropic/claude-fable-5",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:1",
    channelVisibility: "unknown",
    repo: "o/r",
    startedAt: NOW - 60_000,
    receivedAt: NOW - 61_000,
    finishedAt: NOW,
    stepCount: 9,
    status: "completed",
    replyOk: true,
    eventCount: 40,
    storedEventCount: 40,
    truncated: false,
    events: [],
    parentRunId: "parent-1",
    profile: { preset: "coding", machine: "repo-resident", identity: "write", minutes: 90 },
    usage: usage(),
    diagnosis: {
      eventCount: 40,
      toolCalls: 12,
      byCategory: byCategory({ slow_tool: { count: 2, durationMs: 4000 } }),
      findings: [],
      verdict: "slow tool calls dominated",
      shape: {
        windowMs: 61_000,
        gettingReadyMs: 1000,
        thinkingMs: 30_000,
        toolsMs: 20_000,
        finishingUpMs: 2000,
        overheadMs: 500,
        notRecordedMs: 7000,
        notLoadedMs: 500,
      },
    },
    ...over,
  };
}

describe("pointOf — every position by its POINT_COLUMNS name", () => {
  it("fills the sixteen blobs and twenty doubles of a final record, in order, the agent as the index", () => {
    const point = pointOf(record(), PRICES);
    expect(point).toBeDefined();
    const p = point as RunMetricsPoint;
    expect(p.indexes).toEqual(["ship"]);
    expect(p.blobs).toHaveLength(POINT_COLUMNS.blobs.length);
    expect(p.doubles).toHaveLength(POINT_COLUMNS.doubles.length);
    expect(blobOf(p, "schema")).toBe("1");
    expect(blobOf(p, "agent")).toBe("ship");
    expect(blobOf(p, "preset")).toBe("coding");
    expect(blobOf(p, "model")).toBe("anthropic/claude-fable-5");
    expect(blobOf(p, "status")).toBe("completed");
    expect(blobOf(p, "failure kind")).toBe("");
    expect(blobOf(p, "dominant friction")).toBe("slow_tool");
    expect(blobOf(p, "channel")).toBe("slack:C1");
    expect(blobOf(p, "repository")).toBe("o/r");
    expect(blobOf(p, "machine class")).toBe("repo-resident");
    expect(blobOf(p, "route class")).toBe("chosen");
    expect(blobOf(p, "reply")).toBe("ok");
    expect(blobOf(p, "lineage")).toBe("child");
    expect(blobOf(p, "requester")).toBe("slack:UALICE");
    expect(blobOf(p, "identity")).toBe("write");
    expect(blobOf(p, "run id")).toBe("run-1");
    // blob16 is the run id and blob13 the lineage — the positions the reader's SQL names.
    expect(blobColumn("run id")).toBe("blob16");
    expect(p.blobs[15]).toBe("run-1");
    expect(p.blobs[12]).toBe("child");
    expect(doubleOf(p, "wall")).toBe(61_000);
    expect(doubleOf(p, "getting ready")).toBe(1000);
    expect(doubleOf(p, "thinking")).toBe(30_000);
    expect(doubleOf(p, "tools")).toBe(20_000);
    expect(doubleOf(p, "finishing up")).toBe(2000);
    expect(doubleOf(p, "overhead")).toBe(500);
    expect(doubleOf(p, "not recorded")).toBe(7000);
    expect(doubleOf(p, "not loaded")).toBe(500);
    expect(doubleOf(p, "turns")).toBe(14);
    expect(doubleOf(p, "input tokens")).toBe(1000);
    expect(doubleOf(p, "output tokens")).toBe(200);
    expect(doubleOf(p, "cache read tokens")).toBe(5000);
    expect(doubleOf(p, "cache write tokens")).toBe(300);
    expect(doubleOf(p, "steps")).toBe(9);
    expect(doubleOf(p, "tool calls")).toBe(12);
    expect(doubleOf(p, "events")).toBe(40);
    expect(doubleOf(p, "minutes")).toBe(90);
    expect(doubleOf(p, "finished at")).toBe(NOW);
    expect(doubleColumn("dollars")).toBe("double14");
    expect(doubleColumn("unpriced tokens")).toBe("double18");
  });

  it("a ship child with usage.turns 14 and a price table yields double14 equal to llmUsdOfUsage of the same inputs, and blob13 = child", () => {
    const p = pointOf(record(), PRICES) as RunMetricsPoint;
    expect(doubleOf(p, "dollars")).toBe(llmUsdOfUsage(usage(), PRICES).usd);
    expect(doubleOf(p, "dollars")).toBeGreaterThan(0);
    expect(doubleOf(p, "turns")).toBe(14);
    expect(blobOf(p, "lineage")).toBe("child");
  });

  it("a provisional record yields undefined; a final finishedAt === startedAt record yields a zero wall; absent optionals are empty strings and zero doubles", () => {
    expect(pointOf(record({ provisional: true }))).toBeUndefined();
    const bare = record({
      agent: undefined,
      model: undefined,
      repo: undefined,
      profile: undefined,
      usage: undefined,
      parentRunId: undefined,
      replyOk: undefined,
      receivedAt: undefined,
      stepCount: undefined,
      startedAt: NOW,
      finishedAt: NOW,
      status: "interrupted",
      diagnosis: { eventCount: 0, toolCalls: 0, byCategory: byCategory(), findings: [], verdict: "x" },
    });
    const p = pointOf(bare) as RunMetricsPoint;
    expect(p.indexes).toEqual(["unknown"]);
    expect(blobOf(p, "agent")).toBe("");
    expect(blobOf(p, "preset")).toBe("");
    expect(blobOf(p, "model")).toBe("");
    expect(blobOf(p, "repository")).toBe("");
    expect(blobOf(p, "machine class")).toBe("");
    expect(blobOf(p, "identity")).toBe("");
    expect(blobOf(p, "reply")).toBe("none");
    expect(blobOf(p, "lineage")).toBe("root");
    expect(doubleOf(p, "wall")).toBe(0);
    expect(doubleOf(p, "thinking")).toBe(0);
    expect(doubleOf(p, "turns")).toBe(0);
    expect(doubleOf(p, "dollars")).toBe(0);
    expect(doubleOf(p, "minutes")).toBe(0);
  });

  it("a route on the record yields blob11 = routed; without one, chosen", () => {
    const routed = pointOf(
      record({ route: { preset: "coding", reason: "code words", model: "a/m" } }),
    ) as RunMetricsPoint;
    expect(blobOf(routed, "route class")).toBe("routed");
    expect(routed.blobs[10]).toBe("routed");
    expect(blobOf(pointOf(record()) as RunMetricsPoint, "route class")).toBe("chosen");
  });

  it("a failed run carries its status and failure kind; replyOk false reads failed", () => {
    const p = pointOf(
      record({ status: "failed", failure: { kind: "policy_refusal" }, replyOk: false }),
    ) as RunMetricsPoint;
    expect(blobOf(p, "status")).toBe("failed");
    expect(blobOf(p, "failure kind")).toBe("policy_refusal");
    expect(blobOf(p, "reply")).toBe("failed");
  });

  it("free text never reaches a blob: a sentinel in activity, label, diagnosis.verdict and an event body appears in no blob and not in the index", () => {
    const SENTINEL = "SENTINEL_FREE_TEXT";
    const p = pointOf(
      record({
        activity: `doing ${SENTINEL}`,
        label: `ship · o/r · "${SENTINEL}"`,
        events: [{ type: "input", text: SENTINEL } as RunRecord["events"][number]],
        diagnosis: {
          eventCount: 1,
          toolCalls: 0,
          byCategory: byCategory(),
          findings: [],
          verdict: SENTINEL,
        },
      }),
      PRICES,
    ) as RunMetricsPoint;
    for (const blob of [...p.blobs, ...p.indexes]) expect(blob).not.toContain(SENTINEL);
  });

  it("an unpriced model's tokens land in unpriced tokens and dollars counts only the priced ones", () => {
    const mixed: RunUsage = {
      turns: 3,
      byModel: {
        "anthropic/claude-fable-5": {
          turns: 2,
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        "acme/unpriced": { turns: 1, inputTokens: 40, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 3 },
      },
    };
    const p = pointOf(record({ usage: mixed }), PRICES) as RunMetricsPoint;
    expect(doubleOf(p, "unpriced tokens")).toBe(50);
    expect(doubleOf(p, "dollars")).toBe(llmUsdOfUsage(mixed, PRICES).usd);
    // The token counts still count every model's tokens.
    expect(doubleOf(p, "input tokens")).toBe(140);
  });

  it("caps every blob and the index at 96 bytes", () => {
    const long = "x".repeat(200);
    const p = pointOf(record({ agent: long, channelId: long })) as RunMetricsPoint;
    expect(p.indexes[0]).toBe("x".repeat(MAX_POINT_BLOB_BYTES));
    expect(blobOf(p, "channel")).toBe("x".repeat(MAX_POINT_BLOB_BYTES));
  });
});

describe("dominantFriction", () => {
  it("picks the category with the largest durationMs among those with a count; all zero counts yield the empty string", () => {
    expect(
      dominantFriction({
        slow_tool: { count: 3, durationMs: 9000 },
        failed_tool: { count: 5, durationMs: 800 },
      }),
    ).toBe("slow_tool");
    expect(dominantFriction(byCategory())).toBe("");
  });
});

describe("isRunMetricsPoint", () => {
  const good = () => pointOf(record(), PRICES) as RunMetricsPoint;

  it("accepts what pointOf builds and rejects seventeen blobs, a 97-byte blob, a NaN double, a second index", () => {
    expect(isRunMetricsPoint(good())).toBe(true);
    expect(isRunMetricsPoint({ ...good(), blobs: [...good().blobs, "extra"] })).toBe(false);
    const overCap = good();
    overCap.blobs[0] = "x".repeat(MAX_POINT_BLOB_BYTES + 1);
    expect(isRunMetricsPoint(overCap)).toBe(false);
    const nan = good();
    nan.doubles[0] = Number.NaN;
    expect(isRunMetricsPoint(nan)).toBe(false);
    expect(isRunMetricsPoint({ ...good(), indexes: ["a", "b"] })).toBe(false);
    expect(isRunMetricsPoint({ ...good(), indexes: [] })).toBe(false);
    expect(isRunMetricsPoint(null)).toBe(false);
    expect(isRunMetricsPoint({ ...good(), doubles: good().doubles.slice(1) })).toBe(false);
  });
});

describe("pointTurnsFinal — the six combinations", () => {
  const final = {};
  const provisional = { provisional: true as const };
  it("is true exactly when a final record lands where no final row stands", () => {
    expect(pointTurnsFinal(undefined, final)).toBe(true);
    expect(pointTurnsFinal({ provisional: true }, final)).toBe(true);
    expect(pointTurnsFinal({ provisional: false }, final)).toBe(false);
    expect(pointTurnsFinal(undefined, provisional)).toBe(false);
    expect(pointTurnsFinal({ provisional: true }, provisional)).toBe(false);
    expect(pointTurnsFinal({ provisional: false }, provisional)).toBe(false);
  });
});
