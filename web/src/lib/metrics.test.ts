import { describe, expect, it } from "vitest";
import { DAY_MS } from "@core/core/budgets.js";
import { buildMetricsReport, type MetricsReport } from "@core/core/metrics.js";
import {
  countText,
  failureRateChartOf,
  footerSentencesOf,
  metricsHrefOf,
  metricsTilesOf,
  p50ChartOf,
  pctText,
  runsChartModelOf,
  statusSeriesOf,
  trendChartModelOf,
  wallText,
} from "./metrics";

// The metrics page's view model (run-metrics.md item 10): pure math over the
// seed's report — the tiles' words, the stacked day chart's geometry, the two
// trend lines and the footer's provenance sentences.

/** A whole-UTC-day window, computed from DAY_MS — never a literal date. */
const UNTIL_MS = 20_700 * DAY_MS;

const dayIso = (untilMs: number, days: number, i: number): string =>
  new Date(untilMs - days * DAY_MS + i * DAY_MS).toISOString().slice(0, 10);

/** A report over `days` whole days: runs on day 0 (18 ok + 2 failed) and day 2 (5 ok), two agents. */
function report(days = 7): MetricsReport {
  const sinceMs = UNTIL_MS - days * DAY_MS;
  const day = (i: number) => `${dayIso(UNTIL_MS, days, i)} 00:00:00`;
  return {
    dataset: "switchboard_runs",
    ...buildMetricsReport(
      {
        byDayStatus: [
          { day: day(0), status: "completed", runs: 18 },
          { day: day(0), status: "failed", runs: 2 },
          { day: day(2), status: "completed", runs: 5 },
        ],
        byAgent: [
          {
            agent: "coding",
            runs: 20,
            failed: 2,
            p50WallMs: 61_000,
            p95WallMs: 300_000,
            usd: 12.5,
            unpricedTokens: 3,
            turns: 400,
          },
          {
            agent: "review",
            runs: 5,
            failed: 0,
            p50WallMs: 30_000,
            p95WallMs: 90_000,
            usd: 2,
            unpricedTokens: 0,
            turns: 50,
          },
        ],
        byDayAgentP50: [
          { day: day(0), agent: "coding", p50WallMs: 61_000 },
          { day: day(2), agent: "coding", p50WallMs: 45_000 },
          { day: day(2), agent: "review", p50WallMs: 30_000 },
        ],
      },
      { sinceMs, untilMs: UNTIL_MS, days },
    ),
  };
}

describe("the tile and cell words", () => {
  it("renders counts, a failed share of 2 in 20 as 10%, walls in seconds under two minutes and minutes above", () => {
    expect(countText(1234)).toBe("1,234");
    expect(pctText(2 / 20)).toBe("10%");
    expect(wallText(61_000)).toBe("61.0s");
    expect(wallText(300_000)).toBe("5m");
  });

  it("metricsTilesOf is the eight tiles in reading order, every figure the report's own", () => {
    const tiles = metricsTilesOf(report());
    expect(tiles.map((t) => t.label)).toEqual([
      "Runs",
      "Failed",
      "Failure rate",
      "p50 wall",
      "p95 wall",
      "LLM spend",
      "Unpriced tokens",
      "Turns",
    ]);
    expect(tiles.map((t) => t.value)).toEqual(["25", "2", "8%", "54.8s", "4m", "$14.50", "3", "450"]);
  });
});

describe("runsChartModelOf — the stacked day series", () => {
  it("a 90-day report draws ninety x-axis buckets, one hover column each, zero days included", () => {
    const r = report(90);
    const model = runsChartModelOf(r.byDay, statusSeriesOf(r.byDay));
    expect(r.byDay).toHaveLength(90);
    expect(model.dayHovers).toHaveLength(90);
  });

  it("stacks one segment per status with a count, labels the grid with counts, and a zero day draws none", () => {
    const r = report(7);
    const statuses = statusSeriesOf(r.byDay);
    expect(statuses).toEqual(["completed", "failed"]);
    const model = runsChartModelOf(r.byDay, statuses);
    // Day 0 has both statuses, day 2 one, the other five days none.
    expect(model.segments).toHaveLength(3);
    expect(model.gridLines.every((g) => !g.label.includes("$"))).toBe(true);
    expect(model.dayHovers[0].title).toContain("20 runs");
    expect(model.dayHovers[0].tip.rows.map((row) => row.series)).toEqual(["completed", "failed"]);
  });
});

describe("trendChartModelOf — the day lines", () => {
  it("splits a line at a gap (null), keeps a lone point as a dot without a segment, and titles every dot", () => {
    const days = [0, 1, 2, 3, 4].map((i) => dayIso(UNTIL_MS, 5, i));
    const model = trendChartModelOf(days, [{ name: "one", values: [1, 2, null, 3, null] }], (v) => `${v}u`);
    expect(model.lines).toHaveLength(1);
    expect(model.lines[0].segments).toHaveLength(1);
    expect(model.lines[0].dots).toHaveLength(3);
    expect(model.lines[0].dots[0].title).toContain("one 1u");
  });

  it("failureRateChartOf: a day with runs and no failures is 0%, an empty day a gap, 2 in 20 reads 10%", () => {
    const model = failureRateChartOf(report(7).byDay);
    const dots = model.lines[0].dots;
    expect(dots).toHaveLength(2);
    expect(dots[0].title).toContain("10%");
    expect(dots[1].title).toContain("0%");
  });

  it("p50ChartOf: one line per agent in the table's order, aligned to the range's days", () => {
    const r = report(7);
    const model = p50ChartOf(r.byDay, r.byAgent, r.p50ByDayAgent);
    expect(model.lines.map((l) => l.name)).toEqual(["coding", "review"]);
    expect(model.lines[0].dots).toHaveLength(2);
    expect(model.lines[1].dots).toHaveLength(1);
  });
});

describe("the footer and the hrefs", () => {
  it("footerSentencesOf is the report's four provenance sentences: bucket, pricing, completeness, retention", () => {
    const sentences = footerSentencesOf(report().range);
    expect(sentences).toHaveLength(4);
    expect(sentences[0]).toContain("write time");
    expect(sentences[1]).toContain("at finish");
    expect(sentences[2]).toContain("at most once");
    expect(sentences[3]).toContain("90 days");
  });

  it("metricsHrefOf keeps the agent filter across a range switch and encodes it", () => {
    expect(metricsHrefOf(30)).toBe("/metrics?days=30");
    expect(metricsHrefOf(7, "coding")).toBe("/metrics?days=7&agent=coding");
  });
});
