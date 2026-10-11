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
  isTerminalClose,
  outcomeOf,
  pointEmits,
  surfaceOf,
  workspaceWordOf,
  type RunMetricsPoint,
} from "./runMetrics.js";
import { FRICTION_CATEGORIES, type FrictionCategory } from "./runFriction.js";
import type { RunRecord } from "./runRecord.js";
import type { RunUsage } from "./runUsage.js";

// Feature: docs/reference/specs/run-metrics.md — the point every finished run
// writes: `POINT_COLUMNS`, `pointOf`, `isRunMetricsPoint`, `isTerminalClose`, `pointEmits`.

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
  it("fills the twenty blobs and twenty doubles of a final record, in order, the agent as the index", () => {
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
    expect(blobOf(p, "error type")).toBe("");
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
    expect(blobOf(p, "error type")).toBe("policy_refusal");
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

  it("accepts the sixteen-column row and the twenty-column row, so a rolling deploy can widen it; any other width is refused", () => {
    // The writer builds the twenty-column row; an older writer's sixteen-column row still lands.
    const widened = good();
    expect(widened.blobs).toHaveLength(20);
    expect(isRunMetricsPoint(widened)).toBe(true);
    expect(isRunMetricsPoint({ ...good(), blobs: good().blobs.slice(0, 16) })).toBe(true);
    for (const width of [15, 17, 19, 21]) {
      const blobs = Array.from({ length: width }, (_, i) => good().blobs[i] ?? "");
      expect(isRunMetricsPoint({ ...good(), blobs })).toBe(false);
    }
    const overCap = { ...widened, blobs: [...widened.blobs] };
    overCap.blobs[19] = "x".repeat(MAX_POINT_BLOB_BYTES + 1);
    expect(isRunMetricsPoint(overCap)).toBe(false);
  });
});

describe("the terminal close and the emission latch (record 0097)", () => {
  const terminal = {};
  const provisional = { provisional: true as const };
  const restarting = { restarting: true as const };
  it("a close is terminal when it is neither provisional nor restarting", () => {
    expect(isTerminalClose(terminal)).toBe(true);
    expect(isTerminalClose(provisional)).toBe(false);
    expect(isTerminalClose(restarting)).toBe(false);
  });
  it("emits exactly when a terminal close lands on a run whose latch is unset", () => {
    expect(pointEmits(false, terminal)).toBe(true);
    expect(pointEmits(true, terminal)).toBe(false);
    for (const latched of [false, true]) {
      expect(pointEmits(latched, provisional)).toBe(false);
      expect(pointEmits(latched, restarting)).toBe(false);
    }
  });
});

// Record 0097, "Outcome and error type" and "Rows and columns".
describe("outcomeOf — the terminal status decides first, then the first matching row", () => {
  const ending = (e: NonNullable<RunRecord["answerOutcome"]>["ending"]) => ({
    answerOutcome: { version: 1 as const, ending: e, output: "unknown" as const },
  });
  const cases: Array<[string, Partial<RunRecord>, { outcome: string; errorType: string }]> = [
    ["stopped soft", { status: "stopped_soft" }, { outcome: "cancellation", errorType: "" }],
    [
      "stopped hard, even with a failure",
      { status: "stopped_hard", failure: { kind: "provider_transient" } },
      { outcome: "cancellation", errorType: "" },
    ],
    [
      "interrupted by the store's sweep",
      { status: "interrupted", failure: { kind: "restart_unclaimed" } },
      { outcome: "error", errorType: "restart_unclaimed" },
    ],
    ["interrupted otherwise", { status: "interrupted" }, { outcome: "error", errorType: "interrupted" }],
    [
      "failed on a policy refusal",
      { status: "failed", failure: { kind: "policy_refusal" } },
      { outcome: "failure", errorType: "policy_refusal" },
    ],
    [
      "failed on another named kind",
      { status: "failed", failure: { kind: "sandbox_fleet_busy" } },
      { outcome: "error", errorType: "sandbox_fleet_busy" },
    ],
    [
      "failed with a lost word",
      { status: "failed", setup: { version: 1, requested: "resident", reason: "sandbox_start_timeout" } },
      { outcome: "error", errorType: "sandbox_start_timeout" },
    ],
    [
      "failed with a reply that failed",
      { status: "failed", replyOk: false },
      { outcome: "error", errorType: "reply_failed" },
    ],
    [
      "failed on its time budget",
      { status: "failed", ...ending("time_budget") },
      { outcome: "timeout", errorType: "time_budget" },
    ],
    [
      "failed on its turn budget",
      { status: "failed", ...ending("turn_budget") },
      { outcome: "timeout", errorType: "turn_budget" },
    ],
    ["failed otherwise", { status: "failed" }, { outcome: "error", errorType: "unclassified" }],
    [
      "completed on its time budget",
      { status: "completed", ...ending("time_budget") },
      { outcome: "timeout", errorType: "time_budget" },
    ],
    [
      "completed with an interrupted answer",
      { status: "completed", ...ending("interrupted") },
      { outcome: "error", errorType: "answer_interrupted" },
    ],
    [
      "completed after a stop",
      { status: "completed", ...ending("hard_stop") },
      { outcome: "cancellation", errorType: "" },
    ],
    [
      "completed after a soft stop",
      { status: "completed", ...ending("soft_stop") },
      { outcome: "cancellation", errorType: "" },
    ],
    ["completed", { status: "completed", ...ending("answered") }, { outcome: "success", errorType: "" }],
    [
      "completed with a fallback setup word",
      {
        status: "completed",
        setup: { version: 1, requested: "resident", seeding: "snapshot", reason: "workload_full" },
      },
      { outcome: "success", errorType: "" },
    ],
  ];
  it.each(cases)("%s", (_name, over, expected) => {
    expect(outcomeOf(record(over))).toEqual(expected);
  });
  it("leaves the error type empty exactly for success and cancellation", () => {
    for (const [, over] of cases) {
      const { outcome, errorType } = outcomeOf(record(over));
      expect(errorType === "", JSON.stringify(over)).toBe(outcome === "success" || outcome === "cancellation");
    }
  });
});

describe("surfaceOf", () => {
  it("reads the channel's namespace, and nothing for one it does not know", () => {
    expect(surfaceOf("slack:C1")).toBe("slack");
    expect(surfaceOf("mcp:ops-ingress")).toBe("mcp");
    expect(surfaceOf("web:dashboard")).toBe("web");
    expect(surfaceOf("http:ops")).toBe("http");
    expect(surfaceOf("cli:local")).toBe("cli");
    expect(surfaceOf("teams:T1")).toBe("");
    expect(surfaceOf("noprefix")).toBe("");
  });
});

describe("workspaceWordOf — the setup result folded into one word", () => {
  const word = (setup?: RunRecord["setup"]) => workspaceWordOf(record(setup ? { setup } : {}));
  it("names each shape the record's table lists", () => {
    expect(word({ version: 1, requested: "resident" })).toBe("resident");
    expect(word({ version: 1, requested: "resident", restored: true })).toBe("resident_restored");
    expect(word({ version: 1, requested: "resident", seeding: "snapshot", reason: "workload_full" })).toBe(
      "sandbox_snapshot",
    );
    expect(word({ version: 1, requested: "resident", seeding: "fresh_no_snapshot", reason: "not_resident" })).toBe(
      "sandbox_fresh",
    );
    expect(
      word({ version: 1, requested: "resident", seeding: "fresh_after_seed_failure", reason: "fleet_draining" }),
    ).toBe("sandbox_seed_failed");
    expect(word({ version: 1, requested: "cold" })).toBe("sandbox_cold");
    expect(word({ version: 1, requested: "blank" })).toBe("sandbox_blank");
    expect(word({ version: 1, requested: "resident", reason: "sandbox_start_timeout" })).toBe("none");
    expect(word()).toBe("");
  });
  it("names a local or E2B backend for every shape it ran, never a Cloudflare sandbox, and keeps a lost workspace none", () => {
    for (const backend of ["local", "e2b"] as const) {
      expect(word({ version: 1, requested: "cold", backend })).toBe(backend);
      expect(word({ version: 1, requested: "blank", backend })).toBe(backend);
      expect(
        word({ version: 1, requested: "resident", seeding: "fresh_no_snapshot", reason: "not_resident", backend }),
      ).toBe(backend);
      expect(word({ version: 1, requested: "cold", reason: "lost_other", backend })).toBe("none");
    }
  });
});

describe("pointOf — the four columns record 0097 appends", () => {
  it("writes surface, workspace, setup reason and outcome beside the error type", () => {
    const p = pointOf(
      record({
        channelId: "mcp:ops-ingress",
        status: "failed",
        setup: { version: 1, requested: "resident", reason: "stopped_in_drain" },
      }),
    )!;
    expect(p.blobs).toHaveLength(20);
    expect(blobOf(p, "surface")).toBe("mcp");
    expect(blobOf(p, "workspace")).toBe("none");
    expect(blobOf(p, "setup reason")).toBe("stopped_in_drain");
    expect(blobOf(p, "outcome")).toBe("error");
    expect(blobOf(p, "error type")).toBe("stopped_in_drain");
    // Appended, so no position changes meaning: the error type is still blob6, the run id blob16.
    expect(blobColumn("error type")).toBe("blob6");
    expect(blobColumn("run id")).toBe("blob16");
    expect(blobColumn("outcome")).toBe("blob20");
    expect(isRunMetricsPoint(p)).toBe(true);
  });
  it("keeps a cancellation's setup reason in its own column", () => {
    const p = pointOf(
      record({ status: "stopped_hard", setup: { version: 1, requested: "resident", reason: "stopped_in_drain" } }),
    )!;
    expect(blobOf(p, "outcome")).toBe("cancellation");
    expect(blobOf(p, "error type")).toBe("");
    expect(blobOf(p, "setup reason")).toBe("stopped_in_drain");
  });
});
