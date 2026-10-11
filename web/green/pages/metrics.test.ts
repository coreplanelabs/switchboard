// Feature: docs/reference/specs/run-metrics.md — recorded review usage and system outcomes.
import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReviewFeedbackReport } from "@core/core/reviewFeedbackReport.js";
import { buildReviewsReport } from "@core/core/reviewsReport.js";
import { DAY_MS } from "@core/core/budgets.js";
import { reviewReportFixture } from "../../../scripts/web-review-fixture";
import { mountApp } from "../../src/testing/mount";
import MetricsPage from "./Metrics.vue";
import HealthPage from "./SystemHealth.vue";
enableAutoUnmount(afterEach);
describe("Green review metrics", () => {
  it("shows current human feedback, empty ratings and unavailable feedback beside review usage", () => {
    const report = reviewReportFixture();
    const feedback = buildReviewFeedbackReport(
      {
        entries: [
          {
            publication: {
              runId: "review-one",
              repo: "sample/api",
              pr: 7,
              head: "a".repeat(40),
              bodyHash: "b".repeat(64),
              format: 1,
              findings: 1,
              publishedAt: DAY_MS,
              review: {
                id: "71",
                nodeId: "review-71",
                url: "https://github.com/sample/api/pull/7#pullrequestreview-71",
                publishedAt: DAY_MS,
              },
            },
            snapshot: {
              status: "complete",
              checkedAt: 2 * DAY_MS,
              completedAt: 2 * DAY_MS,
              votes: [{ id: "vote-one", actorId: "person-one", actorType: "User", content: "up" }],
            },
          },
        ],
      },
      { sinceMs: 0, untilMs: 7 * DAY_MS },
      2 * DAY_MS,
      {},
    );
    const positive = mountApp(MetricsPage, { seed: { page: "reviewsMetrics", report: { ...report, feedback } } });
    const section = positive.get("[data-review-feedback]");
    expect(section.text()).toContain("Positive only1");
    expect(section.find('a[href="https://github.com/sample/api/pull/7#pullrequestreview-71"]').exists()).toBe(true);
    expect(positive.findAll(".green-stat dd")[0].text()).toBe("21");
    const empty = mountApp(MetricsPage, {
      seed: {
        page: "reviewsMetrics",
        report: {
          ...report,
          feedback: buildReviewFeedbackReport({ entries: [] }, { sinceMs: 0, untilMs: 7 * DAY_MS }, 2 * DAY_MS, {}),
        },
      },
    });
    expect(empty.get("[data-review-feedback]").text()).toContain("No tracked reviews in this range.");
    const unavailable = mountApp(MetricsPage, {
      seed: { page: "reviewsMetrics", report: { ...report, feedback: { status: "unavailable", asOf: 2 * DAY_MS } } },
    });
    expect(unavailable.get("[data-review-feedback]").text()).toContain("Human review feedback is unavailable.");
    expect(unavailable.findAll(".green-stat dd")[0].text()).toBe("21");
  });
  it("shows review counts and successful duration samples without model cost claims", () => {
    const page = mountApp(MetricsPage, { seed: { page: "reviewsMetrics", report: reviewReportFixture() } });
    expect(page.findAll(".green-stat").map((tile) => tile.find("dd").text())).toEqual([
      "21",
      "18",
      "22.0s",
      "1.0s",
      "2.0s",
      "1",
    ]);
    expect(page.text()).toContain("18 successful runs");
    expect(page.text()).not.toContain("LLM spend");
    expect(page.text()).not.toContain("Model cost");
    expect(page.text()).toContain("Changes requested");
    expect(page.text()).toContain("0–1m20");
    expect(page.text()).toContain("30m or more1");
    expect(
      page.find('[aria-label="Metrics sections"] a[href="/metrics/health?from=1970-01-01&to=1970-01-07"]').text(),
    ).toBe("System health");
  });
  it("shows hovered surface totals as counts and preserves the range on the health tab", async () => {
    const page = mountApp(MetricsPage, { seed: { page: "reviewsMetrics", report: reviewReportFixture() } });
    await page
      .find('[aria-label="Review runs by day and surface"] rect.day')
      .trigger("pointerenter", { clientX: 20, clientY: 30 });
    const tip = page.find('[role="tooltip"]');
    expect(tip.find(".tip-head").findAll("span").at(-1)?.text()).toBe("21");
    expect(tip.findAll(".tip-row").map((row) => row.text())).toEqual(["Slack18", "MCP2", "HTTP1"]);
    expect(tip.text()).not.toContain("$");
    const health = mountApp(HealthPage, { seed: { page: "reviewsMetrics", report: reviewReportFixture() } });
    expect(health.find('[aria-label="Metrics sections"] a[href="/metrics?from=1970-01-01&to=1970-01-07"]').text()).toBe(
      "Usage",
    );
  });
  it("keeps sampled PR distribution and unproved surface quantiles unavailable", () => {
    const report = reviewReportFixture();
    report.maxSampleInterval = 4;
    delete report.usage.reviewsPerPullRequest;
    for (const row of report.usage.bySurface) delete row.durationRuns;
    const page = mountApp(MetricsPage, { seed: { page: "reviewsMetrics", report } });
    expect(page.text()).toContain("Sampled rows; counts are weighted. Largest sample interval: 4.");
    expect(page.text()).toContain("Reviews per pull request unavailable for this report.");
    const mcp = page.findAll('[data-table="surfaces"] tbody tr').find((row) => row.text().includes("MCP"))!;
    expect(mcp.findAll("td").map((cell) => cell.text())).toEqual(["MCP", "2", "Unknown", "Unknown"]);
  });
  it("shows supplied successful surface populations including a valid zero quantile", () => {
    const report = reviewReportFixture();
    const slack = report.usage.bySurface.find((row) => row.surface === "slack")!;
    slack.p50Ms = 0;
    const page = mountApp(MetricsPage, { seed: { page: "reviewsMetrics", report } });
    expect(
      page.findAll('[data-table="surfaces"] tbody tr').map((row) => row.findAll("td").map((cell) => cell.text())),
    ).toEqual([
      ["Slack", "18", "0.0s", "2.0s"],
      ["MCP", "2", "No data", "No data"],
      ["HTTP", "1", "No data", "No data"],
    ]);
  });
  it("renders health ratios with denominators, legacy outcomes and unavailable diagnostics", () => {
    const page = mountApp(HealthPage, { seed: { page: "reviewsMetrics", report: reviewReportFixture() } });
    expect(page.findAll(".green-stat").map((tile) => [tile.find("dd").text(), tile.find("p").text()])).toEqual([
      ["90%", "18 / 20"],
      ["100%", "18 / 18"],
      ["10%", "2 / 21"],
      ["10%", "2 / 21"],
    ]);
    expect(page.text()).toContain("Outcome not recorded1");
    expect(page.text()).toContain("Unclassified system errors2");
    expect(page.text()).toContain("Write failuresUnavailable");
    expect(page.text()).toContain("First fully recorded outcome dayUnavailable");
    expect(page.text()).toContain("Recorded outcomes, not service uptime.");
  });
  it("distinguishes a successful empty report from missing and mismatched seeds", () => {
    const report = {
      dataset: "fixture_reviews",
      ...buildReviewsReport(
        {
          runs: [],
          durationByRequester: [],
          durationBySurface: [],
          durationOverall: [],
          durationHistogram: [],
          reviews: [],
          setup: [],
          byWorkspace: [],
        },
        { fromMs: 0, toMs: 7 * DAY_MS },
      ),
    };
    const health = mountApp(HealthPage, { seed: { page: "reviewsMetrics", report } });
    expect(health.findAll(".green-stat dd").map((tile) => tile.text())).toEqual([
      "No data",
      "No data",
      "No data",
      "No data",
    ]);
    const usage = mountApp(MetricsPage, { seed: { page: "reviewsMetrics", report } });
    expect(usage.findAll(".green-stat dd")[0].text()).toBe("0");
    expect(usage.findAll(".green-stat dd")[3].text()).toBe("No data");
    for (const component of [MetricsPage, HealthPage]) {
      const missing = mountApp(component, { seed: null });
      expect(missing.findAll(".green-stat")).toHaveLength(0);
      expect(missing.text()).toContain("The review report is unavailable.");
      const wrong = mountApp(component, { seed: { page: "runNotFound", retentionDays: 30 } });
      expect(wrong.text()).toContain("The review report is unavailable.");
    }
  });
  it("renders a ninety-day report without fetching and keeps finish-time provenance", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const report = {
        dataset: "fixture_reviews",
        ...buildReviewsReport(
          {
            runs: [],
            durationByRequester: [],
            durationBySurface: [],
            durationOverall: [],
            durationHistogram: [],
            reviews: [],
            setup: [],
            byWorkspace: [],
          },
          { fromMs: 0, toMs: 90 * DAY_MS },
        ),
      };
      const page = mountApp(MetricsPage, { seed: { page: "reviewsMetrics", report } });
      expect(page.find('svg[aria-label="Review runs by day and surface"]').findAll("rect.day")).toHaveLength(90);
      expect(page.text()).toContain("UTC days, grouped by finish time. Each run is recorded at most once.");
      expect(page.text()).toContain("Best-effort recording; missing platform writes cannot always be detected.");
      expect(page.find('input[name="from"]').element.getAttribute("value")).toBe("1970-01-01");
      expect(page.find('input[name="to"]').element.getAttribute("value")).toBe("1970-03-31");
      expect(page.find('a[href="/metrics.json?from=1970-01-01&to=1970-03-31"]').text()).toBe("Download report as JSON");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("renders only the supplied scoped requester rows with protected display names and no owner selector", () => {
    const report = reviewReportFixture();
    const page = mountApp(MetricsPage, {
      seed: {
        page: "reviewsMetrics",
        report,
        requesterNames: { "access:preview": "Your account" },
        dataView: { mode: "person", canViewEveryone: true },
        viewingAs: { id: "access:preview", name: "Your account" },
      },
    });
    const rows = page.findAll('[data-table="requesters"] tbody tr');
    expect(rows.map((row) => row.findAll("td").map((cell) => cell.text()))).toEqual([
      ["Your account", "21", "18", "22.0s", "1.0s", "2.0s"],
    ]);
    expect(page.findAll("select")).toHaveLength(0);
    expect(page.find('input[name="owner"]').exists()).toBe(false);
    expect(page.findAll("button").map((button) => button.text())).toEqual(["Apply range"]);
  });
});
