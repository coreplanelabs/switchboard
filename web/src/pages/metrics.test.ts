import { describe, expect, it, vi } from "vitest";
import { DAY_MS } from "@core/core/budgets.js";
import { buildMetricsReport, type MetricsReport } from "@core/core/metrics.js";
import type { MetricsSeed } from "@core/channels/webSeed.js";
import MetricsPage from "./MetricsPage.vue";
import { footerSentencesOf } from "../lib/metrics";
import { mountApp } from "../testing/mount";

// The metrics page (docs/reference/specs/run-metrics.md item 10): the tiles,
// the three charts and the by-agent table, all painted from the seed's report
// and nothing else — the JSON twin carries exactly the same object.

/** A whole-UTC-day window, computed from DAY_MS — never a literal date. */
const UNTIL_MS = 20_700 * DAY_MS;

function report(days = 7): MetricsReport {
  const sinceMs = UNTIL_MS - days * DAY_MS;
  const day = (i: number) => `${new Date(sinceMs + i * DAY_MS).toISOString().slice(0, 10)} 00:00:00`;
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

const seed = (r: MetricsReport = report()): MetricsSeed => ({ page: "metrics", report: r });

describe("MetricsPage", () => {
  it("renders the eight tiles, the three charts and the by-agent table from the seed, and asks the network for nothing", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const wrapper = mountApp(MetricsPage, { seed: seed() });
    const tiles = wrapper.findAll("[data-metrics-tiles] > div");
    expect(tiles).toHaveLength(8);
    expect(tiles.map((t) => t.find(".text-2xl").text())).toEqual([
      "25",
      "2",
      "8%",
      "54.8s",
      "4m",
      "$14.50",
      "3",
      "450",
    ]);
    expect(wrapper.find('svg[aria-label="Runs per day, stacked by status"]').exists()).toBe(true);
    expect(wrapper.find('svg[aria-label="Failure rate per day"]').exists()).toBe(true);
    expect(wrapper.find('svg[aria-label="Median wall-clock per day per agent"]').exists()).toBe(true);
    const rows = wrapper.findAll("[data-metrics-agents] tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("coding");
    expect(rows[0].text()).toContain("10%");
    expect(rows[1].text()).toContain("review");
    expect(wrapper.text()).toContain("dataset switchboard_runs");
    expect(wrapper.text()).toContain("GET /metrics.json");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("a 90-day seed renders ninety x-axis buckets in the runs chart", () => {
    const wrapper = mountApp(MetricsPage, { seed: seed(report(90)) });
    const chart = wrapper.find('svg[aria-label="Runs per day, stacked by status"]');
    expect(chart.findAll("rect.day")).toHaveLength(90);
  });

  it("the footer is exactly the report's four provenance sentences: bucket, pricing, completeness, retention", () => {
    const r = report();
    const wrapper = mountApp(MetricsPage, { seed: seed(r) });
    const sentences = wrapper.findAll("[data-metrics-footer] p").map((p) => p.text());
    expect(sentences).toEqual(footerSentencesOf(r.range));
  });

  it("the range pills keep the agent filter and the agent pills keep the range; the filtered agent reads solid", () => {
    const filtered = { ...report(), range: { ...report().range, agent: "coding" } };
    const wrapper = mountApp(MetricsPage, { seed: seed(filtered) });
    const rangeLinks = wrapper.findAll('nav[aria-label="Range"] a');
    expect(rangeLinks.map((a) => a.attributes("href"))).toEqual([
      "/metrics?days=30&agent=coding",
      "/metrics?days=90&agent=coding",
    ]);
    const current = wrapper.find('nav[aria-label="Agent"] [aria-current="page"]');
    expect(current.text()).toBe("coding");
    expect(wrapper.find('nav[aria-label="Agent"] a').attributes("href")).toBe("/metrics?days=7");
  });

  it("without a seed says so instead of crashing — the off state never reaches this page", () => {
    const wrapper = mountApp(MetricsPage, { seed: null });
    expect(wrapper.text()).toContain("Nothing to show");
  });
});
