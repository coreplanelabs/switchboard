import { describe, expect, it, vi } from "vitest";
import { DAY_MS } from "@core/core/budgets.js";
import { buildMetricsReport, type MetricsReport } from "@core/core/metrics.js";
import { buildReviewFeedbackReport } from "@core/core/reviewFeedbackReport.js";
import type { ReviewFeedbackEntry } from "@core/core/reviewFeedback.js";
import type { MetricsSeed } from "@core/channels/webSeed.js";
import MetricsPage from "../../green/pages/Metrics.vue";
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
  it("shows exact review-level ratings, coverage and native drilldown links from the seed", () => {
    const now = UNTIL_MS - 1;
    const entries: ReviewFeedbackEntry[] = [["up"], ["down"], ["up", "down"]].map((votes, i) => ({
      publication: {
        runId: `review-${i}`,
        repo: "acme/api",
        pr: 7,
        head: "a".repeat(40),
        bodyHash: "b".repeat(64),
        format: 1,
        findings: i === 0 ? 0 : 1,
        publishedAt: now - DAY_MS,
        review: {
          id: String(100 + i),
          nodeId: `PRR_sample_${i}`,
          url: `https://github.com/acme/api/pull/7#pullrequestreview-${100 + i}`,
          publishedAt: now - DAY_MS,
        },
      },
      snapshot: {
        status: "complete",
        completedAt: now,
        checkedAt: now,
        votes: votes.map((sign, j) => ({
          id: `reaction-${i}-${j}`,
          actorId: `person-${i}-${j}`,
          actorType: "User",
          content: sign as "up" | "down",
        })),
      },
    }));
    const r = report();
    r.feedback = buildReviewFeedbackReport({ entries, collectionStartedAt: now - DAY_MS }, r.range, now);
    const wrapper = mountApp(MetricsPage, { seed: seed(r) });
    expect(wrapper.findAll("[data-feedback-distribution] .text-2xl").map((e) => e.text())).toEqual(["1", "1", "1"]);
    expect(wrapper.find("[data-feedback-score]").text()).toContain("50% (1 of 2 reviews). Mixed: 1.");
    expect(wrapper.find("[data-feedback-coverage]").text()).toContain("3 / 3 fully checked reviews (100%)");
    expect(wrapper.findAll("[data-feedback-reviews] a").map((a) => a.attributes("href"))).toEqual([
      "https://github.com/acme/api/pull/7#pullrequestreview-100",
      "https://github.com/acme/api/pull/7#pullrequestreview-101",
      "https://github.com/acme/api/pull/7#pullrequestreview-102",
    ]);
    expect(wrapper.findAll("[data-feedback-groups]")).toHaveLength(3);
    expect(wrapper.text()).toContain("Later votes and removals revise these rows");
    expect(wrapper.findAll("[data-metrics-tiles] > div")).toHaveLength(8);
  });
  it("keeps zero ratings distinct from unavailable feedback and preserves run metrics", () => {
    const empty = report();
    empty.feedback = buildReviewFeedbackReport({ entries: [] }, empty.range, UNTIL_MS - 1);
    const zero = mountApp(MetricsPage, { seed: seed(empty) });
    expect(zero.find("[data-review-feedback]").text()).toContain("No tracked reviews in this range.");
    expect(zero.find("[data-feedback-score]").text()).toContain("Helpful among clear ratings: —");
    const failed = mountApp(MetricsPage, {
      seed: seed({ ...report(), feedback: { status: "unavailable", asOf: UNTIL_MS - 1 } }),
    });
    expect(failed.find("[data-review-feedback]").text()).toContain("Human review feedback is unavailable.");
    expect(failed.find("[data-feedback-distribution]").exists()).toBe(false);
    expect(failed.findAll("[data-metrics-tiles] > div")).toHaveLength(8);
  });
  it("renders the eight tiles, the three charts and the by-agent table from the seed, and asks the network for nothing", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const wrapper = mountApp(MetricsPage, { seed: seed() });
    const tiles = wrapper.findAll(".green-stat");
    expect(tiles).toHaveLength(8);
    expect(tiles.map((t) => t.find("dd").text())).toEqual(["25", "2", "8%", "54.8s", "4m", "$14.50", "3", "450"]);
    expect(wrapper.find('svg[aria-label="Finished runs per day, stacked by outcome"]').exists()).toBe(true);
    expect(wrapper.find('svg[aria-label="Daily failure rate"]').exists()).toBe(true);
    expect(wrapper.find('svg[aria-label="Median wall duration by agent per day"]').exists()).toBe(true);
    const rows = wrapper.findAll("table tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("coding");
    expect(rows[0].text()).toContain("10%");
    expect(rows[1].text()).toContain("review");
    expect(wrapper.text()).toContain("Dataset: switchboard_runs");
    expect(wrapper.find('a[href="/metrics.json?days=7"]').exists()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("a 90-day seed renders ninety x-axis buckets in the runs chart", () => {
    const wrapper = mountApp(MetricsPage, { seed: seed(report(90)) });
    const chart = wrapper.find('svg[aria-label="Finished runs per day, stacked by outcome"]');
    expect(chart.findAll("rect.day")).toHaveLength(90);
  });

  it("the footer is exactly the report's four provenance sentences: bucket, pricing, completeness, retention", () => {
    const r = report();
    const wrapper = mountApp(MetricsPage, { seed: seed(r) });
    const sentences = wrapper
      .findAll("details > p")
      .slice(0, 4)
      .map((p) => p.text());
    expect(sentences).toEqual(footerSentencesOf(r.range));
  });

  it("the range pills keep the agent filter and the agent pills keep the range; the filtered agent reads solid", () => {
    const filtered = { ...report(), range: { ...report().range, agent: "coding" } };
    const wrapper = mountApp(MetricsPage, { seed: seed(filtered) });
    const rangeLinks = wrapper.findAll('nav[aria-label="Metrics range"] a:not([aria-current])');
    expect(rangeLinks.map((a) => a.attributes("href"))).toEqual([
      "/metrics?days=30&agent=coding",
      "/metrics?days=90&agent=coding",
    ]);
    expect((wrapper.find("select").element as HTMLSelectElement).value).toBe("coding");
    expect(wrapper.findAll("select option").map((option) => option.text())).toEqual(["All agents", "coding", "review"]);
  });

  it("without a seed says so instead of crashing — the off state never reaches this page", () => {
    const wrapper = mountApp(MetricsPage, { seed: null });
    expect(wrapper.text()).toContain("Metrics could not be loaded");
  });
});
