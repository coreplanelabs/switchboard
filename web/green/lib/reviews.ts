// Feature: docs/reference/specs/run-metrics.md — report-only review display mapping.
import { REVIEWS_HISTOGRAM_OPEN_MS, MINUTE_MS } from "@core/core/budgets.js";
import type { ReviewsComparison } from "@core/core/reviewsComparison.js";
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

// Week over week: the selected range beside the same range whole weeks earlier.
/** `now` against `before` as a signed whole percent; nothing earlier is said, never divided. */
export function changeText(now: number, before: number): string {
  if (before <= 0) return now > 0 ? "New" : "No change";
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}
/** Two ratios' difference in whole percentage points, or no data when either has no total. */
export function pointsText(now: ReviewsTile, before: ReviewsTile): string {
  if (now.total <= 0 || before.total <= 0) return "No data";
  const pts = Math.round((now.ratio - before.ratio) * 100);
  return `${pts > 0 ? "+" : ""}${pts} pts`;
}
/** Two durations' signed difference, or no data when either has no successful sample. */
export function durationChangeText(now: number, nowRuns: number, before: number, beforeRuns: number): string {
  if (nowRuns <= 0 || beforeRuns <= 0) return "No data";
  return `${now >= before ? "+" : "-"}${wallText(Math.abs(now - before))}`;
}
/** What the previous window is called: one week earlier, or N weeks earlier. */
export function shiftText(shiftDays: number): string {
  const weeks = shiftDays / 7;
  return weeks === 1 ? "one week earlier" : `${weeks} weeks earlier`;
}
/** The earlier window as a column heading. */
export const shiftHeading = (shiftDays: number): string => {
  const text = shiftText(shiftDays);
  return text[0].toUpperCase() + text.slice(1);
};
const minuteOf = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
/** A window as its first and last instants, UTC to the minute. */
export function windowText(report: ReviewsReport): string {
  return `${minuteOf(report.range.fromMs)} – ${minuteOf(report.range.toMs)} UTC`;
}
type Row = { label: string; now: string; before: string; change: string };
/** The side-by-side table: each measure now, before, and the change. */
export function comparisonRows(c: Extract<ReviewsComparison, { previous: ReviewsReport }>): Row[] {
  const [n, b] = [c.current, c.previous];
  const count = (label: string, pick: (r: ReviewsReport) => number): Row => ({
    label,
    now: countText(pick(n)),
    before: countText(pick(b)),
    change: changeText(pick(n), pick(b)),
  });
  const ratio = (label: string, pick: (r: ReviewsReport) => ReviewsTile): Row => ({
    label,
    now: ratioText(pick(n)),
    before: ratioText(pick(b)),
    change: pointsText(pick(n), pick(b)),
  });
  const duration = (label: string, key: "p50Ms" | "p95Ms"): Row => ({
    label,
    now: durationText(n.usage.duration[key], n.usage.duration.runs),
    before: durationText(b.usage.duration[key], b.usage.duration.runs),
    change: durationChangeText(
      n.usage.duration[key],
      n.usage.duration.runs,
      b.usage.duration[key],
      b.usage.duration.runs,
    ),
  });
  return [
    count("Review runs", (r) => r.usage.runs),
    count("Succeeded", (r) => r.usage.succeeded),
    ratio("Run success rate", (r) => r.system.tiles.runSuccessRate),
    ratio("Warm start share", (r) => r.system.tiles.warmStartShare),
    ratio("Lost at setup", (r) => r.system.tiles.lostAtSetup),
    ratio("Reviews with verdict", (r) => r.system.tiles.reviewsWithVerdict),
    duration("p50 duration", "p50Ms"),
    duration("p95 duration", "p95Ms"),
    {
      label: "Total run time",
      now: wallText(n.usage.wallMs),
      before: wallText(b.usage.wallMs),
      change: changeText(n.usage.wallMs, b.usage.wallMs),
    },
    count("Observed pull requests", (r) => r.usage.pullRequests),
    count("Findings", (r) => r.usage.findings.total),
  ];
}
/** The headline tiles: the value now, and the earlier value with its change as the note. */
export function comparisonTiles(c: Extract<ReviewsComparison, { previous: ReviewsReport }>) {
  const earlier = shiftText(c.shiftDays);
  const pick = new Set([
    "Review runs",
    "Run success rate",
    "Warm start share",
    "Lost at setup",
    "p50 duration",
    "Observed pull requests",
  ]);
  return comparisonRows(c)
    .filter((row) => pick.has(row.label))
    .map((row) => ({ label: row.label, value: row.now, note: `${row.before} ${earlier} · ${row.change}` }));
}
/** Runs per day, each day beside the day one shift earlier. */
export function comparisonDays(c: Extract<ReviewsComparison, { previous: ReviewsReport }>) {
  return c.current.usage.byDay.map((row, i) => {
    const before = c.previous.usage.byDay[i];
    return {
      day: row.day,
      runs: countText(row.runs),
      earlierDay: before?.day ?? "",
      earlierRuns: countText(before?.runs ?? 0),
      change: changeText(row.runs, before?.runs ?? 0),
    };
  });
}
/** Runs per requester in either window, most runs now first. */
export function comparisonRequesters(c: Extract<ReviewsComparison, { previous: ReviewsReport }>) {
  const runs = (r: ReviewsReport) => new Map(r.usage.byRequester.map((row) => [row.requester, row]));
  const [n, b] = [runs(c.current), runs(c.previous)];
  return [...new Set([...n.keys(), ...b.keys()])]
    .map((requester) => ({ requester, now: n.get(requester)?.runs ?? 0, before: b.get(requester)?.runs ?? 0 }))
    .sort((x, y) => y.now - x.now || y.before - x.before)
    .map((row) => ({ ...row, change: changeText(row.now, row.before) }));
}
