// Feature: docs/reference/specs/run-metrics.md — no inferred review samples or ratios.
import { describe, expect, it } from "vitest";
import { reviewReportFixture } from "../../../scripts/web-review-fixture";
import { durationText, ratioText, reviewsHref, reviewDayChart, surfaceText } from "./reviews";
describe("Review report display", () => {
  it("keeps missing populations unknown, empty populations separate, and zero duration valid", () => {
    expect([durationText(0), durationText(0, 0), durationText(0, 3), durationText(240000, 2)]).toEqual([
      "Unknown",
      "No data",
      "0.0s",
      "4m",
    ]);
    expect(ratioText({ good: 2, total: 4, ratio: 0.75 })).toBe("75%");
    expect(ratioText({ good: 0, total: 0, ratio: 0 })).toBe("No data");
    expect(ratioText({ good: 5, total: 4, ratio: 1.25 })).toBe("125%");
  });
  it("keeps the exact finish range on each tab and preserves supplied daily totals", () => {
    const report = reviewReportFixture();
    expect(reviewsHref("/metrics/health", report)).toBe("/metrics/health?from=1970-01-01&to=1970-01-07");
    const chart = reviewDayChart([{ day: "1970-01-01", runs: 7, values: { slack: 2, mcp: 3 } }], surfaceText);
    expect(chart.labels).toEqual(["Slack", "MCP"]);
    expect(chart.model.dayHovers[0].title).toBe("1970-01-01 — 7 runs · MCP 3 · Slack 2");
  });
});
