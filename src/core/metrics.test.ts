import { describe, expect, it } from "vitest";
import { DAY_MS } from "./budgets.js";
import {
  AnalyticsEngineSqlSource,
  buildMetricsReport,
  InMemoryMetricsSource,
  metricsQueries,
  MetricsSourceError,
  parseMetricsConfig,
  type MetricsRange,
} from "./metrics.js";
import { blobColumn, doubleColumn, POINT_COLUMNS, type RunMetricsPoint } from "./runMetrics.js";

// The run-metrics reader (docs/reference/specs/run-metrics.md items 7–8): the
// config block, the pinned query texts — weighted for sampling, columns from
// POINT_COLUMNS — the SQL-API source, and the pure report builder.

/** A point in POINT_COLUMNS order: agent, status, wall/dollars/unpriced/turns and a write time. */
function point(opts: {
  agent: string;
  status?: string;
  wallMs?: number;
  usd?: number;
  unpriced?: number;
  turns?: number;
  finishedAt: number;
}): RunMetricsPoint {
  const blobs = POINT_COLUMNS.blobs.map(() => "");
  blobs[POINT_COLUMNS.blobs.indexOf("agent")] = opts.agent;
  blobs[POINT_COLUMNS.blobs.indexOf("status")] = opts.status ?? "completed";
  const doubles = POINT_COLUMNS.doubles.map(() => 0);
  doubles[POINT_COLUMNS.doubles.indexOf("wall")] = opts.wallMs ?? 1000;
  doubles[POINT_COLUMNS.doubles.indexOf("dollars")] = opts.usd ?? 0;
  doubles[POINT_COLUMNS.doubles.indexOf("unpriced tokens")] = opts.unpriced ?? 0;
  doubles[POINT_COLUMNS.doubles.indexOf("turns")] = opts.turns ?? 1;
  doubles[POINT_COLUMNS.doubles.indexOf("finished at")] = opts.finishedAt;
  return { indexes: [opts.agent], blobs, doubles };
}

// A fixed 7-day UTC window ending at a midnight (exclusive).
const UNTIL = Date.UTC(2026, 0, 8);
const SINCE = UNTIL - 7 * DAY_MS;
const RANGE: MetricsRange = { sinceMs: SINCE, untilMs: UNTIL };
/** The ISO day `i` days into the window — computed, so the fixture carries no literal dates. */
const day = (i: number): string => new Date(SINCE + i * DAY_MS).toISOString().slice(0, 10);

describe("parseMetricsConfig", () => {
  it("absent → undefined; a dataset alone gets the 30-day default; days is kept when in 1..90", () => {
    expect(parseMetricsConfig(undefined)).toBeUndefined();
    expect(parseMetricsConfig(null)).toBeUndefined();
    expect(parseMetricsConfig({ dataset: "switchboard_runs" })).toEqual({ dataset: "switchboard_runs", days: 30 });
    expect(parseMetricsConfig({ dataset: "runs_v1", days: 7 })).toEqual({ dataset: "runs_v1", days: 7 });
  });

  it("refuses by field: a bad dataset name, days out of range or fractional, a non-mapping", () => {
    expect(() => parseMetricsConfig("runs")).toThrow(/metrics: must be a mapping/);
    expect(() => parseMetricsConfig({})).toThrow(/metrics\.dataset/);
    expect(() => parseMetricsConfig({ dataset: "1runs" })).toThrow(/metrics\.dataset/);
    expect(() => parseMetricsConfig({ dataset: "has-hyphen" })).toThrow(/metrics\.dataset/);
    expect(() => parseMetricsConfig({ dataset: "runs", days: 0 })).toThrow(/metrics\.days/);
    expect(() => parseMetricsConfig({ dataset: "runs", days: 91 })).toThrow(/metrics\.days/);
    expect(() => parseMetricsConfig({ dataset: "runs", days: 1.5 })).toThrow(/metrics\.days/);
  });
});

describe("metricsQueries — the three texts, pinned", () => {
  const q = metricsQueries(RANGE, "switchboard_runs");

  it("every query is weighted with _sample_interval and names its columns from POINT_COLUMNS", () => {
    // The positions the queries ride on, resolved from the one table — a move fails here first.
    expect(doubleColumn("wall")).toBe("double1");
    expect(doubleColumn("turns")).toBe("double9");
    expect(doubleColumn("dollars")).toBe("double14");
    expect(doubleColumn("unpriced tokens")).toBe("double18");
    expect(blobColumn("status")).toBe("blob5");
    expect(POINT_COLUMNS.index).toEqual(["agent"]);
    for (const text of Object.values(q)) {
      expect(text).toContain("_sample_interval");
      expect(text).toContain("FROM switchboard_runs");
      expect(text).toContain(`timestamp >= toDateTime(${SINCE / 1000}) AND timestamp < toDateTime(${UNTIL / 1000})`);
    }
  });

  it("byDayStatus counts runs per day per status by sum(_sample_interval), never count()", () => {
    expect(q.byDayStatus).toBe(
      "SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob5 AS status, sum(_sample_interval) AS runs " +
        `FROM switchboard_runs WHERE timestamp >= toDateTime(${SINCE / 1000}) AND timestamp < toDateTime(${UNTIL / 1000}) ` +
        "GROUP BY day, status ORDER BY day ASC",
    );
    expect(q.byDayStatus).not.toContain("count(");
  });

  it("byAgent aggregates runs, failed, weighted p50/p95 wall, dollars, unpriced tokens and turns per agent", () => {
    expect(q.byAgent).toBe(
      "SELECT index1 AS agent, sum(_sample_interval) AS runs, " +
        "sumIf(_sample_interval, blob5 = 'failed') AS failed, " +
        "quantileExactWeighted(0.5)(double1, _sample_interval) AS p50WallMs, " +
        "quantileExactWeighted(0.95)(double1, _sample_interval) AS p95WallMs, " +
        "sum(double14 * _sample_interval) AS usd, " +
        "sum(double18 * _sample_interval) AS unpricedTokens, " +
        "sum(double9 * _sample_interval) AS turns " +
        `FROM switchboard_runs WHERE timestamp >= toDateTime(${SINCE / 1000}) AND timestamp < toDateTime(${UNTIL / 1000}) ` +
        "GROUP BY agent ORDER BY runs DESC",
    );
  });

  it("byDayAgentP50 is the weighted median wall per day per agent", () => {
    expect(q.byDayAgentP50).toBe(
      "SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, index1 AS agent, " +
        "quantileExactWeighted(0.5)(double1, _sample_interval) AS p50WallMs " +
        `FROM switchboard_runs WHERE timestamp >= toDateTime(${SINCE / 1000}) AND timestamp < toDateTime(${UNTIL / 1000}) ` +
        "GROUP BY day, agent ORDER BY day ASC",
    );
  });

  it("the agent filter is validated against the agent-name rule and quoted; the range must be integers", () => {
    const filtered = metricsQueries({ ...RANGE, agent: "coding" }, "runs");
    for (const text of Object.values(filtered)) expect(text).toContain("index1 = 'coding'");
    expect(() => metricsQueries({ ...RANGE, agent: "x' OR 1=1 --" }, "runs")).toThrow(/agent name/);
    expect(() => metricsQueries({ ...RANGE, agent: "Coding" }, "runs")).toThrow(/agent name/);
    expect(() => metricsQueries({ sinceMs: Number.NaN, untilMs: UNTIL }, "runs")).toThrow(/two finite timestamps/);
    expect(() => metricsQueries(RANGE, "bad-name")).toThrow(/dataset name/);
  });
});

describe("AnalyticsEngineSqlSource", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const respond = (status: number, body: unknown): typeof fetch =>
    (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return {
        status,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
        json: async () => body,
      };
    }) as unknown as typeof fetch;

  it("posts the text with the bearer in the header only and FORMAT JSON appended, and answers `data`", async () => {
    const src = new AnalyticsEngineSqlSource({
      accountId: "acct",
      token: "secret-token",
      fetchImpl: respond(200, { data: [{ agent: "coding", runs: 2 }] }),
    });
    const rows = await src.query("SELECT 1");
    expect(rows).toEqual([{ agent: "coding", runs: 2 }]);
    const call = calls[calls.length - 1];
    expect(call.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    expect(call.init.body).toBe("SELECT 1 FORMAT JSON");
  });

  it("a 403 is a MetricsSourceError carrying the status and never the token", async () => {
    const src = new AnalyticsEngineSqlSource({
      accountId: "acct",
      token: "secret-token",
      fetchImpl: respond(403, "authentication error"),
    });
    const err = await src.query("SELECT 1").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MetricsSourceError);
    expect((err as MetricsSourceError).status).toBe(403);
    expect((err as MetricsSourceError).name).toBe("MetricsSourceError");
    expect((err as Error).message).toContain("403");
    expect((err as Error).message).not.toContain("secret-token");
  });
});

describe("buildMetricsReport over the in-memory source", () => {
  // Points on three of the seven days, two agents; `coding` fails 1 of 3.
  const points = [
    point({ agent: "coding", wallMs: 1000, usd: 0.1, turns: 2, finishedAt: SINCE + 1 * DAY_MS + 60_000 }),
    point({ agent: "coding", status: "failed", wallMs: 3000, usd: 0.2, turns: 4, finishedAt: SINCE + 3 * DAY_MS }),
    point({ agent: "coding", wallMs: 2000, usd: 0.3, turns: 6, unpriced: 50, finishedAt: SINCE + 5 * DAY_MS }),
    point({ agent: "review", wallMs: 9000, usd: 1, turns: 1, finishedAt: SINCE + 5 * DAY_MS + 1 }),
    // Outside the window and never counted.
    point({ agent: "coding", finishedAt: SINCE - 1 }),
    point({ agent: "coding", finishedAt: UNTIL }),
  ];
  const source = new InMemoryMetricsSource(points);
  const query = async (range: MetricsRange) => {
    const q = metricsQueries(range, "runs_v1");
    return buildMetricsReport(
      {
        byDayStatus: await source.query(q.byDayStatus),
        byAgent: await source.query(q.byAgent),
        byDayAgentP50: await source.query(q.byDayAgentP50),
      },
      { ...range, days: 7 },
    );
  };

  it("a 7-day range over points on three of the days yields seven byDay rows with four zero rows", async () => {
    const report = await query(RANGE);
    expect(report.byDay).toHaveLength(7);
    expect(report.byDay.map((d) => d.day)).toEqual([0, 1, 2, 3, 4, 5, 6].map(day));
    expect(report.byDay.filter((d) => d.runs === 0)).toHaveLength(4);
    expect(report.byDay[1]).toEqual({ day: day(1), runs: 1, byStatus: { completed: 1 } });
    expect(report.byDay[3]).toEqual({ day: day(3), runs: 1, byStatus: { failed: 1 } });
    expect(report.byDay[5]).toEqual({ day: day(5), runs: 2, byStatus: { completed: 2 } });
  });

  it("equals the report over the same points computed by hand: tiles, byAgent largest first, p50 rows", async () => {
    const report = await query(RANGE);
    expect(report.tiles.runs).toBe(4);
    expect(report.tiles.failed).toBe(1);
    expect(report.tiles.failureRate).toBe(0.25);
    expect(report.tiles.usd).toBeCloseTo(1.6, 10);
    expect(report.tiles.unpricedTokens).toBe(50);
    expect(report.tiles.turns).toBe(13);
    expect(report.byAgent.map((r) => r.agent)).toEqual(["coding", "review"]);
    const coding = report.byAgent[0];
    // quantileExactWeighted(0.5) over [1000, 2000, 3000] at weight 1 each is 2000.
    expect(coding).toEqual({
      agent: "coding",
      runs: 3,
      failed: 1,
      p50WallMs: 2000,
      p95WallMs: 3000,
      usd: expect.closeTo(0.6, 10) as number,
      unpricedTokens: 50,
      turns: 12,
    });
    // The tiles' quantiles are the runs-weighted mean of the per-agent quantiles.
    expect(report.tiles.p50WallMs).toBeCloseTo((2000 * 3 + 9000 * 1) / 4, 10);
    expect(report.p50ByDayAgent).toEqual([
      { day: day(1), agent: "coding", p50WallMs: 1000 },
      { day: day(3), agent: "coding", p50WallMs: 3000 },
      { day: day(5), agent: "coding", p50WallMs: 2000 },
      { day: day(5), agent: "review", p50WallMs: 9000 },
    ]);
    expect(report.range).toEqual({
      sinceMs: SINCE,
      untilMs: UNTIL,
      days: 7,
      bucket: "write time",
      retentionDays: 90,
      pricing: "at finish",
      completeness: "at most once",
    });
  });

  it("an agent filter leaves other agents' points out of every table", async () => {
    const report = await query({ ...RANGE, agent: "review" });
    expect(report.byAgent).toEqual([
      {
        agent: "review",
        runs: 1,
        failed: 0,
        p50WallMs: 9000,
        p95WallMs: 9000,
        usd: 1,
        unpricedTokens: 0,
        turns: 1,
      },
    ]);
    expect(report.tiles.runs).toBe(1);
    expect(report.byDay.reduce((s, d) => s + d.runs, 0)).toBe(1);
    expect(report.p50ByDayAgent).toEqual([{ day: day(5), agent: "review", p50WallMs: 9000 }]);
    expect(report.range.agent).toBe("review");
  });

  it("an empty window is a zero-filled report, never an error", async () => {
    const empty = await query({ sinceMs: UNTIL + 7 * DAY_MS, untilMs: UNTIL + 14 * DAY_MS });
    expect(empty.tiles).toEqual({
      runs: 0,
      failed: 0,
      failureRate: 0,
      p50WallMs: 0,
      p95WallMs: 0,
      usd: 0,
      unpricedTokens: 0,
      turns: 0,
    });
    expect(empty.byDay).toHaveLength(7);
    expect(empty.byDay.every((d) => d.runs === 0)).toBe(true);
    expect(empty.byAgent).toEqual([]);
    expect(empty.p50ByDayAgent).toEqual([]);
  });
});
