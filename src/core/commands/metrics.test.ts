import { describe, expect, it } from "vitest";
import { CommandError, type Caller, type JsonValue } from "../commandRegistry.js";
import { MetricsSourceError, type MetricsReport } from "../metrics.js";
import { METRICS_OFF_MESSAGE, NullMetricsService, type MetricsService } from "../metricsService.js";
import { DAY_MS } from "../budgets.js";
import { buildReviewsReport } from "../reviewsReport.js";
import { NullReviewsService, type ReviewsService } from "../reviewsService.js";
import { metricsReviews, metricsTrend } from "./metrics.js";
import { buildReviewFeedbackReport } from "../reviewFeedbackReport.js";

// `metrics trend` (docs/reference/specs/run-metrics.md item 9): the trend
// report on every surface — its refusals (off, a failing source) and its text
// render (header, tiles, one line per agent largest first, the footer).

const caller = {
  kind: "chat",
  id: "slack:UCASEY",
  actor: { kind: "user", id: "slack:UCASEY", grants: { actions: "all", channels: "all", repos: "all" } },
} as Caller;

// The window's edges, formatted the way the fixture and the assertions need
// them — computed, so the fixture carries no literal dates.
const SINCE = Date.UTC(2026, 0, 2);
const UNTIL = Date.UTC(2026, 0, 9);
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const REPORT: MetricsReport = {
  dataset: "switchboard_runs",
  tiles: {
    runs: 20,
    failed: 2,
    failureRate: 0.1,
    p50WallMs: 3_500,
    p95WallMs: 41_000,
    usd: 1.23,
    unpricedTokens: 0,
    turns: 87,
  },
  byDay: [{ day: isoDay(SINCE), runs: 20, byStatus: { completed: 18, failed: 2 } }],
  byAgent: [
    {
      agent: "coding",
      runs: 15,
      failed: 2,
      p50WallMs: 4_000,
      p95WallMs: 41_000,
      usd: 0.9,
      unpricedTokens: 0,
      turns: 60,
    },
    {
      agent: "review",
      runs: 5,
      failed: 0,
      p50WallMs: 200_000,
      p95WallMs: 300_000,
      usd: 0.33,
      unpricedTokens: 0,
      turns: 27,
    },
  ],
  p50ByDayAgent: [],
  range: {
    sinceMs: SINCE,
    untilMs: UNTIL,
    days: 7,
    agent: undefined as unknown as string,
    bucket: "write time",
    retentionDays: 90,
    pricing: "at finish",
    completeness: "at most once",
  },
};
delete (REPORT.range as unknown as Record<string, unknown>).agent;

const service = (report: () => Promise<MetricsReport>): MetricsService => ({
  report,
  feedback: () => new NullMetricsService().feedback(),
});

const invoke = (svc: MetricsService, options: Record<string, unknown> = {}) =>
  metricsTrend.handler({ args: [], options, caller, deps: { metrics: { service: async () => svc } } } as never);

describe("metrics.trend", () => {
  it("carries exact feedback into JSON and distinguishes an unrated cohort from unavailable feedback in text", async () => {
    const feedback = buildReviewFeedbackReport({ entries: [] }, REPORT.range, UNTIL - 1);
    const complete = { ...REPORT, feedback };
    expect(await invoke(service(async () => complete))).toEqual(complete);
    expect(metricsTrend.render!(complete as unknown as JsonValue)).toContain(
      "Helpful among clear ratings: — (0/0); rating coverage 0/0; current reads 0/0",
    );
    expect(
      metricsTrend.render!({ ...REPORT, feedback: { status: "unavailable", asOf: UNTIL - 1 } } as unknown as JsonValue),
    ).toContain("Human review feedback is unavailable.");
  });
  it("answers the service's report — the JSON twin's shape — passing --days and --agent through", async () => {
    const asked: unknown[] = [];
    const svc = service(async () => REPORT);
    const spied: MetricsService = {
      feedback: svc.feedback,
      report: (opts) => {
        asked.push(opts);
        return svc.report();
      },
    };
    const out = await invoke(spied, { days: 7, agent: "coding" });
    expect(out).toEqual(REPORT as unknown as JsonValue);
    expect(asked).toEqual([{ days: 7, agent: "coding" }]);
    await invoke(spied, {});
    expect(asked[1]).toEqual({});
  });

  it("off is `unavailable` with the off message", async () => {
    const err = await invoke(new NullMetricsService()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toMatchObject({ code: "unavailable", message: METRICS_OFF_MESSAGE });
  });

  it("a source error is `unavailable` naming the error's class, never the token", async () => {
    const err = await invoke(service(() => Promise.reject(new MetricsSourceError(403, "authentication error")))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toMatchObject({ code: "unavailable" });
    expect(String((err as Error).message)).toBe(
      "metrics by run unavailable: MetricsSourceError: analytics engine sql 403: authentication error",
    );
  });

  it("renders the header, the tiles bullet with the failed share as a percentage (2 in 20 → 10%), one line per agent largest first, and the footer", () => {
    const text = metricsTrend.render!(REPORT as unknown as JsonValue);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`metrics trend · ${isoDay(SINCE)} → ${isoDay(UNTIL)} (7d) · dataset switchboard_runs`);
    expect(lines[1]).toBe("• 20 runs · failed 2 (10%) · p50 wall 3.5s · p95 wall 41.0s · LLM $1.23 · turns 87");
    expect(lines[2]).toBe("• coding — 15 runs · failed 2 (13%) · p50 4.0s · p95 41.0s · LLM $0.90 · turns 60");
    expect(lines[3]).toBe("• review — 5 runs · failed 0 (0%) · p50 3m · p95 5m · LLM $0.33 · turns 27");
    expect(lines[4]).toBe("bucketed by write time · priced at finish · counted at most once · kept 90 days");
    // Chat-safe on every surface: no aligned columns to collapse.
    expect(text).not.toMatch(/ {2,}/);
  });

  it("renders an agent-filtered, empty report with the filter in the header and no agent lines", () => {
    const empty: MetricsReport = {
      ...REPORT,
      byAgent: [],
      tiles: { ...REPORT.tiles, runs: 0, failed: 0, failureRate: 0, usd: 0, turns: 0, p50WallMs: 0, p95WallMs: 0 },
      range: { ...REPORT.range, agent: "coding" },
    };
    const text = metricsTrend.render!(empty as unknown as JsonValue);
    expect(text).toContain("· agent coding · dataset switchboard_runs");
    expect(text).toContain("(no runs in this range)");
  });
});

// Record 0097, "The reader and the page": `metrics reviews` answers the review
// report for a range of whole UTC days, `--from` and `--to` both included.
describe("metrics.reviews", () => {
  const FROM = Date.UTC(2026, 0, 4);
  const REVIEWS = buildReviewsReport(
    {
      runs: [
        {
          day: "",
          outcome: "success",
          surface: "slack",
          requester: "slack:UCASEY",
          runs: 8,
          wallMs: 8 * 360_000,
          maxInterval: 1,
        },
        {
          day: "",
          outcome: "error",
          surface: "mcp",
          requester: "mcp:ops",
          runs: 2,
          wallMs: 2 * 60_000,
          maxInterval: 1,
        },
      ],
      durationByRequester: [],
      durationBySurface: [],
      durationOverall: [{ runs: 8, p50Ms: 360_000, p95Ms: 540_000 }],
      durationHistogram: [],
      reviews: [
        {
          repository: "o/r",
          pr: "1",
          verdict: "approved",
          reviews: 6,
          findings: 2,
          blocking: 0,
          major: 0,
          minor: 2,
          nit: 0,
          maxInterval: 1,
        },
      ],
      setup: [
        { day: "", workspace: "resident", setupReason: "", errorType: "", runs: 6 },
        { day: "", workspace: "sandbox_snapshot", setupReason: "workload_full", errorType: "", runs: 2 },
        {
          day: "",
          workspace: "none",
          setupReason: "sandbox_start_timeout",
          errorType: "sandbox_start_timeout",
          runs: 2,
        },
      ],
      byWorkspace: [],
    },
    { fromMs: FROM, toMs: FROM + 7 * DAY_MS },
  );
  const report = { dataset: "switchboard_runs", ...REVIEWS };
  const reviewsInvoke = (svc: ReviewsService, options: Record<string, unknown> = {}) =>
    metricsReviews.handler({
      args: [],
      options,
      caller,
      deps: { metrics: { service: async () => new NullMetricsService(), reviews: async () => svc } },
    } as never);

  it("asks for whole UTC days, --to included, and answers the report as the JSON twin's shape", async () => {
    const asked: unknown[] = [];
    const svc: ReviewsService = {
      reviews: async (range) => {
        asked.push(range);
        return report;
      },
    };
    expect(await reviewsInvoke(svc, { from: isoDay(FROM), to: isoDay(FROM + 6 * DAY_MS) })).toEqual(
      report as unknown as JsonValue,
    );
    expect(asked).toEqual([{ fromMs: FROM, toMs: FROM + 7 * DAY_MS }]);
  });

  it("defaults to the seven days ending today", async () => {
    const asked: Array<{ fromMs: number; toMs: number }> = [];
    await reviewsInvoke({
      reviews: async (range) => {
        asked.push(range);
        return report;
      },
    });
    expect(asked[0].toMs - asked[0].fromMs).toBe(7 * DAY_MS);
    expect(asked[0].toMs % DAY_MS).toBe(0);
    expect(asked[0].toMs).toBeGreaterThan(Date.now());
  });

  it("refuses a range that ends before it starts, runs past ninety days, or names a day the calendar does not have, before asking", async () => {
    const svc: ReviewsService = { reviews: () => Promise.reject(new Error("must not be asked")) };
    // A day the calendar does not have, assembled so no fixture spells a date.
    const unreal = (month: string, dayOfMonth: string): string => ["2026", month, dayOfMonth].join("-");
    for (const options of [
      { from: isoDay(FROM + 6 * DAY_MS), to: isoDay(FROM) },
      { from: isoDay(FROM), to: isoDay(FROM + 91 * DAY_MS) },
      { from: unreal("02", "29"), to: isoDay(FROM + 60 * DAY_MS) },
      { from: isoDay(FROM), to: unreal("04", "31") },
      { from: unreal("13", "01") },
    ]) {
      const err = await reviewsInvoke(svc, options).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommandError);
      expect(err).toMatchObject({ code: "invalid_input" });
    }
  });

  it("off is `unavailable` with the off message; a source error names its class", async () => {
    expect(await reviewsInvoke(new NullReviewsService()).catch((e: unknown) => e)).toMatchObject({
      code: "unavailable",
      message: METRICS_OFF_MESSAGE,
    });
    const err = await reviewsInvoke({
      reviews: () => Promise.reject(new MetricsSourceError(403, "authentication error")),
    }).catch((e: unknown) => e);
    expect(String((err as Error).message)).toBe(
      "review metrics unavailable: MetricsSourceError: analytics engine sql 403: authentication error",
    );
  });

  it("--compare adds the same range a week earlier, read through the same service, and one text line", async () => {
    const asked: Array<{ fromMs: number; toMs: number }> = [];
    const svc: ReviewsService = {
      reviews: async (range) => {
        asked.push(range);
        return report;
      },
    };
    const today = Date.now() - (Date.now() % DAY_MS);
    const [from, to] = [today - 13 * DAY_MS, today - 7 * DAY_MS];
    const out = (await reviewsInvoke(svc, { from: isoDay(from), to: isoDay(to), compare: true })) as Record<
      string,
      unknown
    >;
    expect(asked).toContainEqual({ fromMs: from - 7 * DAY_MS, toMs: from });
    expect(out.usage).toEqual(report.usage);
    expect(out.comparison).toMatchObject({
      shiftDays: 7,
      current: { usage: { runs: 10 } },
      previous: { usage: { runs: 10 } },
    });
    expect(metricsReviews.render!(out as JsonValue).split("\n")).toContain(
      "• week over week · vs 7d earlier · 10 vs 10 review runs (+0%) · run success 80% vs 80% · warm start 75% vs 75%",
    );
    // A range whose earlier window the dataset no longer keeps says so instead of reading it.
    const old = (await reviewsInvoke(svc, {
      from: isoDay(FROM),
      to: isoDay(FROM + 6 * DAY_MS),
      compare: true,
    })) as JsonValue;
    expect(metricsReviews.render!(old).split("\n")).toContain(
      "• week over week · 7d earlier is before the 90 days the dataset keeps",
    );
  });

  it("--compare says no data for a rate with no eligible runs on either side, and keeps a measured 0%", () => {
    const tiles = (success: [number, number], warm: [number, number]) => ({
      usage: { runs: success[1] },
      system: {
        tiles: {
          runSuccessRate: { good: success[0], total: success[1], ratio: success[1] ? success[0] / success[1] : 0 },
          warmStartShare: { good: warm[0], total: warm[1], ratio: warm[1] ? warm[0] / warm[1] : 0 },
        },
      },
    });
    const line = (current: object, previous: object) =>
      metricsReviews.render!({ ...report, comparison: { shiftDays: 7, current, previous } } as unknown as JsonValue)
        .split("\n")
        .find((l) => l.startsWith("• week over week"));
    // An empty earlier window, then an empty current one: the missing side is no data.
    expect(line(tiles([8, 10], [6, 8]), tiles([0, 0], [0, 0]))).toBe(
      "• week over week · vs 7d earlier · 10 vs 0 review runs (no earlier runs) · run success 80% vs no data · warm start 75% vs no data",
    );
    expect(line(tiles([0, 0], [0, 0]), tiles([8, 10], [6, 8]))).toBe(
      "• week over week · vs 7d earlier · 0 vs 10 review runs (-100%) · run success no data vs 80% · warm start no data vs 75%",
    );
    // Runs but no eligible resident requests on one side; a measured zero stays 0%.
    expect(line(tiles([0, 4], [0, 0]), tiles([0, 0], [0, 3]))).toBe(
      "• week over week · vs 7d earlier · 4 vs 0 review runs (no earlier runs) · run success 0% vs no data · warm start no data vs 0%",
    );
  });

  it("renders the range, usage, the four tiles as good of total, and the top requesters, chat-safe", () => {
    const lines = metricsReviews.render!(report as unknown as JsonValue).split("\n");
    expect(lines[0]).toBe(
      `metrics reviews · ${isoDay(FROM)} → ${isoDay(FROM + 6 * DAY_MS)} (7d) · dataset switchboard_runs`,
    );
    expect(lines[1]).toBe(
      "• 10 review runs · 8 succeeded · 6 reviews over 1 pull request · 50m running · p50 6m · p95 9m",
    );
    expect(lines[2]).toBe(
      "• run success 8 of 10 (80%) · warm start 6 of 8 (75%) · lost at setup 2 of 10 (20%) · reviews with a verdict 6 of 10 (60%)",
    );
    expect(lines[3]).toBe("• slack:UCASEY — 8 runs · 8 succeeded · 48m running");
    expect(lines[4]).toBe("• mcp:ops — 2 runs · 0 succeeded · 2m running");
    expect(lines.at(-1)).toBe("bucketed by finish time · counted at most once");
    expect(lines.join("\n")).not.toMatch(/ {2,}/);
  });
});
