// Feature: docs/reference/specs/run-metrics.md — report-only review display mapping.
import { REVIEWS_HISTOGRAM_OPEN_MS, MINUTE_MS } from "@core/core/budgets.js";
import type { ReviewsReport, ReviewsTile } from "@core/core/reviewsReport.js";
import { countText, pctText, runsChartModelOf, wallText } from "../../src/lib/metrics";

export { countText, wallText };
export function histogramLabel(minute: number): string {
  const open = REVIEWS_HISTOGRAM_OPEN_MS / MINUTE_MS;
  return minute >= open ? `${open}m or more` : `${minute}–${minute + 1}m`;
}
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export function reviewDays(report: ReviewsReport): { from: string; to: string } {
  return { from: day(report.range.fromMs), to: day(report.range.toMs - 1) };
}
export function reviewsHref(path: string, report?: ReviewsReport | null): string {
  if (!report) return path;
  const range = reviewDays(report);
  return `${path}?${new URLSearchParams(range)}`;
}
/** Population must be proved separately; a valid zero quantile is not a missing sample. */
export function durationText(ms: number, runs?: number): string {
  return runs === undefined ? "Unknown" : runs > 0 ? wallText(ms) : "No data";
}
export function ratioText(tile: ReviewsTile): string {
  return tile.total > 0 ? pctText(tile.ratio) : "No data";
}
export const surfaceText = (value: string): string =>
  ({ slack: "Slack", mcp: "MCP", http: "HTTP", cli: "CLI", browser: "Browser", web: "Web" })[value] ??
  (value || "Not recorded");
export const workspaceText = (value: string): string =>
  ({
    resident: "Warm start",
    resident_restored: "Warm start from saved state",
    sandbox_snapshot: "Cold start from saved state",
    sandbox_fresh: "Cold start from clone",
    sandbox_seed_failed: "Cold start after restore failed",
    local: "Local workspace",
    e2b: "E2B workspace",
    none: "No workspace",
    "not recorded": "Workspace not recorded",
  })[value] ??
  (value || "Workspace not recorded");
export const outcomeText = (value: string): string =>
  ({
    success: "Succeeded",
    failure: "Work failed",
    error: "System error",
    timeout: "Timed out",
    cancellation: "Cancelled",
    "not recorded": "Outcome not recorded",
  })[value] ?? value;
export function reviewUsageTiles(report: ReviewsReport) {
  const usage = report.usage;
  return [
    { label: "Review runs", value: countText(usage.runs), note: "Recorded in the selected range" },
    { label: "Succeeded", value: countText(usage.succeeded), note: "Run outcome; separate from review verdict" },
    { label: "Total run time", value: wallText(usage.wallMs), note: "All recorded review runs" },
    {
      label: "p50 duration",
      value: durationText(usage.duration.p50Ms, usage.duration.runs),
      note: `${countText(usage.duration.runs)} successful runs`,
    },
    {
      label: "p95 duration",
      value: durationText(usage.duration.p95Ms, usage.duration.runs),
      note: `${countText(usage.duration.runs)} successful runs`,
    },
    { label: "Observed pull requests", value: countText(usage.pullRequests), note: "From recorded review rows" },
  ];
}
export function reviewHealthTiles(report: ReviewsReport) {
  const t = report.system.tiles;
  return [
    ["Run success rate", t.runSuccessRate],
    ["Warm start share", t.warmStartShare],
    ["Lost at setup", t.lostAtSetup],
    ["Reviews with verdict", t.reviewsWithVerdict],
  ].map(([label, tile]) => {
    const value = tile as ReviewsTile;
    return {
      label: label as string,
      value: ratioText(value),
      note: `${countText(value.good)} / ${countText(value.total)}`,
    };
  });
}
export function reviewDayChart(
  rows: readonly { day: string; runs?: number; values: Record<string, number> }[],
  label: (value: string) => string,
) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row.values)))];
  return {
    labels: keys.map(label),
    model: runsChartModelOf(
      rows.map((row) => ({
        day: row.day,
        runs: row.runs ?? Object.values(row.values).reduce((a, b) => a + b, 0),
        byStatus: Object.fromEntries(Object.entries(row.values).map(([key, value]) => [label(key), value])),
      })),
      keys.map(label),
    ),
  };
}
export function reviewMethod(report: ReviewsReport & { dataset?: string }): string[] {
  return [
    `UTC days, grouped by ${report.range.bucket}. Each run is recorded ${report.range.completeness}.`,
    "Best-effort recording; missing platform writes cannot always be detected.",
    report.maxSampleInterval > 1
      ? `Sampled rows; counts are weighted. Largest sample interval: ${report.maxSampleInterval}.`
      : "Weighted counts and quantiles from the recorded rows.",
    "Duration quantiles use successful review runs only. Workspace medians use the recorded workspace population.",
    "Changes requested is a review verdict, not a failed run.",
    `Dataset: ${report.dataset ?? "Unavailable"}`,
  ];
}
