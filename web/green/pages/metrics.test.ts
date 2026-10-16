// Feature: docs/reference/specs/run-metrics.md — hovered outcome values are counts.
import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { buildMetricsReport } from "@core/core/metrics.js";
import { DAY_MS } from "@core/core/budgets.js";
import { mountApp } from "../../src/testing/mount";
import MetricsPage from "./Metrics.vue";

enableAutoUnmount(afterEach);

describe("Green Metrics", () => {
  it("shows each tile's weighted-run and pricing qualifier beside its formatted value", () => {
    const report = {
      dataset: "fixture_runs",
      ...buildMetricsReport(
        {
          byDayStatus: [
            { day: "1970-01-01 00:00:00", status: "completed", runs: 18 },
            { day: "1970-01-01 00:00:00", status: "failed", runs: 2 },
          ],
          byAgent: [
            {
              agent: "coding",
              runs: 20,
              failed: 2,
              p50WallMs: 61000,
              p95WallMs: 300000,
              usd: 12.5,
              unpricedTokens: 3,
              turns: 400,
            },
          ],
          byDayAgentP50: [],
        },
        { sinceMs: 0, untilMs: 7 * DAY_MS, days: 7 },
      ),
    };
    const page = mountApp(MetricsPage, { seed: { page: "metrics", report } });
    expect(
      page.findAll(".green-stat").map((tile) => ({
        label: tile.find("dt").text(),
        value: tile.find("dd").text(),
        note: tile.find("p").exists() ? tile.find("p").text() : null,
      })),
    ).toEqual([
      { label: "Runs", value: "20", note: "7d window, UTC days" },
      { label: "Failed", value: "2", note: "runs that ended failed" },
      { label: "Failure rate", value: "10%", note: "2 of 20" },
      { label: "p50 wall", value: "61.0s", note: "median run, runs-weighted" },
      { label: "p95 wall", value: "5m", note: "runs-weighted" },
      { label: "LLM spend", value: "$12.50", note: "priced at finish" },
      { label: "Unpriced tokens", value: "3", note: "tokens with no price row" },
      { label: "Turns", value: "400", note: "model turns in range" },
    ]);
  });
  it("shows the hovered outcome total and breakdown as run counts", async () => {
    const report = {
      dataset: "fixture_runs",
      ...buildMetricsReport(
        {
          byDayStatus: [
            { day: "1970-01-01 00:00:00", status: "completed", runs: 18 },
            { day: "1970-01-01 00:00:00", status: "failed", runs: 2 },
          ],
          byAgent: [],
          byDayAgentP50: [],
        },
        { sinceMs: 0, untilMs: 7 * DAY_MS, days: 7 },
      ),
    };
    const page = mountApp(MetricsPage, { seed: { page: "metrics", report } });
    const chart = page.find('[aria-label="Finished runs per day, stacked by outcome"]');
    await chart.find("rect.day").trigger("pointerenter", { clientX: 20, clientY: 30 });
    const tooltip = page.find('[role="tooltip"]');
    expect(tooltip.find(".tip-head").findAll("span").at(-1)?.text()).toBe("20");
    expect(tooltip.findAll(".tip-row").map((row) => row.text())).toEqual(["completed18", "failed2"]);
    expect(tooltip.text()).not.toContain("$");
  });
});
