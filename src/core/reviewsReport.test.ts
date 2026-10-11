import { describe, expect, it } from "vitest";
import { DAY_MS } from "./budgets.js";
import { blobColumn, doubleColumn } from "./runMetrics.js";
import { FALLBACK_WORDS, LOST_WORDS } from "./runSetup.js";
import {
  buildReviewsReport,
  reviewsQueries,
  setupReasonClass,
  type ReviewsQueries,
  type ReviewsRows,
} from "./reviewsReport.js";

// Feature: record 0097, "The reader and the page" — the review dashboard's
// eight queries and the report built from their rows.

const FROM = Date.UTC(2026, 9, 4);
const TO = FROM + 7 * DAY_MS;
const RANGE = { fromMs: FROM, toMs: TO };
/** The range's `n`th UTC day, `YYYY-MM-DD`, computed so the fixture carries no literal dates. */
const dayN = (n: number): string => new Date(FROM + n * DAY_MS).toISOString().slice(0, 10);
/** That day as the SQL service spells a `toStartOfInterval` day. */
const sqlDay = (n: number): string => `${dayN(n)} 00:00:00`;

describe("reviewsQueries", () => {
  const q = reviewsQueries(RANGE, "switchboard_runs");
  const all = Object.values(q) as string[];

  it("refuses a dataset that is not a name, an inverted range and one over ninety days", () => {
    expect(() => reviewsQueries(RANGE, "runs; DROP")).toThrow(/dataset name/);
    expect(() => reviewsQueries({ fromMs: TO, toMs: FROM }, "d")).toThrow(/range/);
    expect(() => reviewsQueries({ fromMs: FROM, toMs: FROM + 91 * DAY_MS }, "d")).toThrow(/at most 90 days/);
  });

  it("weights every count and quantile by the sample interval, never count()", () => {
    for (const sql of all) {
      expect(sql).not.toMatch(/count\(/);
      expect(sql).toMatch(/_sample_interval/);
    }
  });

  it("bounds every scan by write time a day wider on each side, and filters on the row's own finish time", () => {
    for (const sql of all) {
      expect(sql).toContain(`timestamp >= toDateTime(${(FROM - DAY_MS) / 1000})`);
      expect(sql).toContain(`timestamp < toDateTime(${(TO + DAY_MS) / 1000})`);
    }
    const runFinish = doubleColumn("finished at");
    for (const key of ["runs", "setup", "byWorkspace", "durationHistogram"] as (keyof ReviewsQueries)[])
      expect(q[key]).toContain(`${runFinish} >= ${FROM} AND ${runFinish} < ${TO}`);
    expect(q.runs).toContain(`toStartOfInterval(toDateTime(intDiv(${runFinish}, 1000)), INTERVAL '1' DAY) AS day`);
  });

  it("reads run rows of the review agent under schema 1, and review rows under their own word", () => {
    for (const key of ["runs", "durationByRequester", "setup", "byWorkspace"] as (keyof ReviewsQueries)[]) {
      expect(q[key]).toContain(`${blobColumn("schema")} = '1'`);
      expect(q[key]).toContain(`index1 = 'review'`);
    }
    expect(q.reviews).toContain(`blob1 = 'review-1'`);
    expect(q.reviews).not.toContain("index1");
    // Columns by name, never a magic number: outcome is the last of the twenty.
    expect(q.runs).toContain(`${blobColumn("outcome")} AS outcome`);
    expect(blobColumn("outcome")).toBe("blob20");
    expect(q.durationOverall).toContain(`${blobColumn("outcome")} = 'success'`);
  });
});

describe("scoped reviewsQueries", () => {
  it("filters every aggregate with each table's exact requester and repository columns", () => {
    const q = reviewsQueries(RANGE, "d", {
      kind: "and",
      of: [
        { kind: "user-is", userId: "access:alice" },
        { kind: "repos-in", repos: new Set(["org/one"]) },
      ],
    });
    for (const [key, sql] of Object.entries(q)) {
      const filter =
        key === "reviews"
          ? "(blob7 = 'access:alice' AND (blob3 != '' AND lower(blob3) IN ('org/one')))"
          : "(blob14 = 'access:alice' AND (blob9 != '' AND lower(blob9) IN ('org/one')))";
      expect(
        sql.slice(sql.indexOf(" WHERE "), sql.indexOf(" GROUP BY ") < 0 ? undefined : sql.indexOf(" GROUP BY ")),
      ).toContain(" AND " + filter);
    }
  });

  it("holds unsupported review facts while preserving a supported OR branch and escaping SQL strings", () => {
    const channel = reviewsQueries(RANGE, "d", { kind: "channels-in", channelIds: new Set(["slack:C1"]) });
    expect(channel.runs).toContain(" AND blob8 IN ('slack:C1')");
    expect(channel.reviews).toContain(" AND 0 GROUP BY");
    const mixed = reviewsQueries(RANGE, "d", {
      kind: "or",
      of: [
        { kind: "channels-in", channelIds: new Set(["slack:C1"]) },
        { kind: "user-is", userId: "access:a'b" },
      ],
    });
    expect(mixed.reviews).toContain(" AND (0 OR blob7 = 'access:a''b') GROUP BY");
    expect(() => reviewsQueries(RANGE, "d", { kind: "user-is", userId: "access:bad\nsubject" })).toThrow(
      "invalid metrics scope value",
    );
  });
});

// The functions Analytics Engine's SQL reference documents (aggregate,
// conditional, date-time, mathematical); a query calling anything else is
// refused by the service, and one refused query fails the whole report.
const DOCUMENTED_FUNCTIONS = new Set([
  "lower",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "quantileExactWeighted",
  "quantileWeighted",
  "argMax",
  "argMin",
  "first_value",
  "last_value",
  "topK",
  "topKWeighted",
  "countIf",
  "sumIf",
  "avgIf",
  "if",
  "formatDateTime",
  "now",
  "today",
  "toDateTime",
  "toYear",
  "toMonth",
  "toDayOfWeek",
  "toDayOfMonth",
  "toHour",
  "toMinute",
  "toSecond",
  "toUnixTimestamp",
  "toStartOfInterval",
  "toStartOfYear",
  "toStartOfMonth",
  "toStartOfWeek",
  "toStartOfDay",
  "toStartOfHour",
  "toStartOfFifteenMinutes",
  "toStartOfTenMinutes",
  "toStartOfFiveMinutes",
  "toStartOfMinute",
  "toYYYYMM",
  "intDiv",
  "log",
  "ln",
  "pow",
  "round",
  "floor",
  "ceil",
]);

describe("reviewsQueries — only documented SQL functions", () => {
  it("calls no function outside Analytics Engine's SQL reference", () => {
    const q = reviewsQueries(RANGE, "switchboard_runs", { kind: "repos-not-in", repos: new Set(["org/private"]) });
    for (const [name, sql] of Object.entries(q)) {
      const called = [...sql.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]);
      // Parenthesized policy groups follow SQL operators, not function calls.
      for (const fn of called.filter((name) => !["AND", "OR", "IN"].includes(name.toUpperCase())))
        expect(DOCUMENTED_FUNCTIONS.has(fn), `${name} calls ${fn}`).toBe(true);
    }
  });
});

describe("setupReasonClass", () => {
  it("names every lost word a failure, the record's design words design, and every other fallback word a defect", () => {
    for (const word of LOST_WORDS) expect(setupReasonClass(word)).toBe("failure");
    const design = [
      "fleet_draining",
      "deploy_fence",
      "workspace_preserved",
      "settlement_pending",
      "recreate_in_progress",
      "not_resident",
      "reattach_refused",
    ];
    for (const word of FALLBACK_WORDS) expect(setupReasonClass(word)).toBe(design.includes(word) ? "design" : "defect");
    expect(setupReasonClass("a_word_from_a_newer_writer")).toBe("defect");
  });
});

const EMPTY: ReviewsRows = {
  runs: [],
  durationByRequester: [],
  durationBySurface: [],
  durationOverall: [],
  durationHistogram: [],
  reviews: [],
  setup: [],
  byWorkspace: [],
};

describe("buildReviewsReport", () => {
  it("an empty range is a zero report with every UTC day present", () => {
    const r = buildReviewsReport(EMPTY, RANGE);
    expect(r.usage.byDay.map((d) => d.day)).toEqual([0, 1, 2, 3, 4, 5, 6].map(dayN));
    expect(r.usage.runs).toBe(0);
    expect(r.system.tiles.runSuccessRate).toEqual({ good: 0, total: 0, ratio: 0 });
    expect(r.usage.reviewsPerPullRequest).toEqual([]);
  });

  const rows: ReviewsRows = {
    ...EMPTY,
    runs: [
      {
        day: sqlDay(1),
        outcome: "success",
        surface: "slack",
        requester: "slack:UA",
        runs: 6,
        wallMs: 6 * 300_000,
        maxInterval: 1,
      },
      {
        day: sqlDay(1),
        outcome: "error",
        surface: "mcp",
        requester: "mcp:ops",
        runs: 2,
        wallMs: 2 * 60_000,
        maxInterval: 1,
      },
      {
        day: sqlDay(2),
        outcome: "cancellation",
        surface: "slack",
        requester: "slack:UA",
        runs: 1,
        wallMs: 30_000,
        maxInterval: 1,
      },
      {
        day: sqlDay(2),
        outcome: "",
        surface: "",
        requester: "slack:UB",
        runs: 1,
        wallMs: 90_000,
        maxInterval: 1,
      },
    ],
    durationByRequester: [{ requester: "slack:UA", runs: 6, p50Ms: 300_000, p95Ms: 420_000 }],
    durationBySurface: [{ surface: "slack", runs: 6, p50Ms: 300_000, p95Ms: 420_000 }],
    durationOverall: [{ runs: 6, p50Ms: 300_000, p95Ms: 420_000 }],
    durationHistogram: [
      { minute: 1, runs: 2 },
      { minute: 5, runs: 6 },
    ],
    reviews: [
      {
        repository: "o/r",
        pr: "1",
        verdict: "changes_requested",
        reviews: 2,
        findings: 3,
        blocking: 0,
        major: 1,
        minor: 2,
        nit: 0,
        maxInterval: 1,
      },
      {
        repository: "o/r",
        pr: "1",
        verdict: "approved",
        reviews: 1,
        findings: 0,
        blocking: 0,
        major: 0,
        minor: 0,
        nit: 0,
        maxInterval: 1,
      },
      {
        repository: "o/r",
        pr: "2",
        verdict: "approved",
        reviews: 1,
        findings: 1,
        blocking: 0,
        major: 0,
        minor: 0,
        nit: 1,
        maxInterval: 1,
      },
      {
        repository: "o/r",
        pr: "",
        verdict: "approved",
        reviews: 1,
        findings: 0,
        blocking: 0,
        major: 0,
        minor: 0,
        nit: 0,
        maxInterval: 1,
      },
    ],
    setup: [
      { day: sqlDay(1), workspace: "resident", setupReason: "", errorType: "", runs: 4 },
      {
        day: sqlDay(1),
        workspace: "sandbox_snapshot",
        setupReason: "workload_full",
        errorType: "",
        runs: 2,
      },
      {
        day: sqlDay(1),
        workspace: "none",
        setupReason: "sandbox_start_timeout",
        errorType: "sandbox_start_timeout",
        runs: 2,
      },
      { day: sqlDay(2), workspace: "sandbox_fresh", setupReason: "fleet_draining", errorType: "", runs: 1 },
      { day: sqlDay(2), workspace: "", setupReason: "", errorType: "", runs: 1 },
      // A cold-class run asked for no resident: outside the warm-start total.
      { day: sqlDay(3), workspace: "sandbox_cold", setupReason: "", errorType: "", runs: 1 },
    ],
    byWorkspace: [
      { workspace: "resident", runs: 4, p50Ms: 240_000, p50ReadyMs: 5_000 },
      { workspace: "sandbox_snapshot", runs: 2, p50Ms: 420_000, p50ReadyMs: 90_000 },
    ],
  };

  it("sums usage by day, surface and requester, with the time spent", () => {
    const r = buildReviewsReport(rows, RANGE);
    expect(r.usage.runs).toBe(10);
    expect(r.usage.succeeded).toBe(6);
    expect(r.usage.wallMs).toBe(6 * 300_000 + 2 * 60_000 + 30_000 + 90_000);
    expect(r.usage.byDay[1]).toEqual({ day: dayN(1), runs: 8, bySurface: { slack: 6, mcp: 2 } });
    expect(r.usage.byRequester[0]).toMatchObject({ requester: "slack:UA", runs: 7, succeeded: 6, p50Ms: 300_000 });
    expect(r.usage.bySurface.map((s) => s.surface)).toEqual(["slack", "mcp", ""]);
    expect(r.usage.histogram).toEqual([
      { minute: 1, runs: 2 },
      { minute: 5, runs: 6 },
    ]);
  });

  it("counts reviews per pull request in TypeScript, leaving branch reviews out of the pull requests", () => {
    const r = buildReviewsReport(rows, RANGE);
    expect(r.usage.pullRequests).toBe(2);
    expect(r.usage.reviewsPerPullRequest).toEqual([
      { reviews: 1, pullRequests: 1 },
      { reviews: 3, pullRequests: 1 },
    ]);
    expect(r.usage.verdicts).toEqual({ approved: 3, changes_requested: 2 });
    expect(r.usage.findings).toEqual({ total: 4, blocking: 0, major: 1, minor: 2, nit: 1 });
  });

  it("states each tile as good over total", () => {
    const t = buildReviewsReport(rows, RANGE).system.tiles;
    // Cancellations and rows without an outcome are left out of the success rate.
    expect(t.runSuccessRate).toEqual({ good: 6, total: 8, ratio: 0.75 });
    // Warm over the rows that asked for a resident and got a workspace.
    expect(t.warmStartShare).toEqual({ good: 4, total: 7, ratio: 4 / 7 });
    expect(t.lostAtSetup).toEqual({ good: 2, total: 10, ratio: 0.2 });
    expect(t.reviewsWithVerdict).toEqual({ good: 5, total: 10, ratio: 0.5 });
  });

  it("counts a local or E2B run that stood in for a resident in the warm-start total, never a cold one", () => {
    const warmOf = (setup: ReviewsRows["setup"]) =>
      buildReviewsReport({ ...EMPTY, setup }, RANGE).system.tiles.warmStartShare;
    for (const backend of ["local", "e2b"])
      expect(
        warmOf([
          { day: sqlDay(1), workspace: "resident", setupReason: "", errorType: "", runs: 1 },
          { day: sqlDay(1), workspace: backend, setupReason: "resident_not_serviceable", errorType: "", runs: 1 },
          // An explicitly cold run on that backend asked for no resident.
          { day: sqlDay(1), workspace: backend, setupReason: "", errorType: "", runs: 1 },
          // A lost workspace got none.
          { day: sqlDay(1), workspace: "none", setupReason: "sandbox_start_timeout", errorType: "", runs: 1 },
        ]),
      ).toEqual({ good: 1, total: 2, ratio: 0.5 });
  });

  it("classifies setup reasons and keeps rows without an outcome or workspace visible", () => {
    const s = buildReviewsReport(rows, RANGE).system;
    expect(s.setupReasons).toEqual([
      { reason: "workload_full", class: "defect", runs: 2 },
      { reason: "sandbox_start_timeout", class: "failure", runs: 2 },
      { reason: "fleet_draining", class: "design", runs: 1 },
    ]);
    expect(s.outcomeNotRecorded).toBe(1);
    expect(s.byDay[2].byWorkspace).toEqual({ sandbox_fresh: 1, "not recorded": 1 });
    expect(s.byWorkspace[0]).toEqual({ workspace: "resident", runs: 4, p50Ms: 240_000, p50ReadyMs: 5_000 });
  });

  it("suppresses reviews per pull request when any row was sampled, and says how much", () => {
    const sampled = { ...rows, reviews: rows.reviews.map((r) => ({ ...r, maxInterval: 4 })) };
    const r = buildReviewsReport(sampled, RANGE);
    expect(r.maxSampleInterval).toBe(4);
    expect(r.usage.reviewsPerPullRequest).toBeUndefined();
    expect(r.usage.pullRequests).toBe(2);
  });
});

describe("review duration population", () => {
  it("retains the successful surface population so no sample differs from a valid zero duration", () => {
    const report = buildReviewsReport(
      {
        ...EMPTY,
        runs: [
          { day: sqlDay(0), surface: "mcp", outcome: "success", requester: "access:alice", runs: 2 },
          { day: sqlDay(0), surface: "http", outcome: "failure", requester: "access:alice", runs: 1 },
        ],
        durationBySurface: [{ surface: "mcp", runs: 2, p50Ms: 0, p95Ms: 0 }],
      },
      RANGE,
    );
    expect(report.usage.bySurface).toEqual([
      { surface: "mcp", runs: 2, durationRuns: 2, p50Ms: 0, p95Ms: 0 },
      { surface: "http", runs: 1, durationRuns: 0, p50Ms: 0, p95Ms: 0 },
    ]);
  });
  it("does not invent a successful sample population when a legacy duration row omitted it", () => {
    const report = buildReviewsReport(
      {
        ...EMPTY,
        runs: [{ day: sqlDay(0), surface: "mcp", outcome: "success", requester: "access:alice", runs: 2 }],
        durationBySurface: [{ surface: "mcp", p50Ms: 0, p95Ms: 0 }],
      },
      RANGE,
    );
    expect(report.usage.bySurface).toEqual([{ surface: "mcp", runs: 2, p50Ms: 0, p95Ms: 0 }]);
  });
});
