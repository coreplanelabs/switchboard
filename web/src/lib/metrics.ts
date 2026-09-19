import type {
  MetricsByAgentRow,
  MetricsByDayRow,
  MetricsP50Row,
  MetricsReport,
  MetricsReportRange,
} from "@core/core/metrics.js";
import { usd, type ChartModel, type ChartSegment, type ChartDayHover } from "./costs";

// The metrics page's view model (docs/reference/specs/run-metrics.md item 10):
// the tiles, the three charts' geometry and the footer's provenance sentences,
// all computed from the seed's report and nothing else — the page renders
// nothing the JSON twin does not carry. Pure data in, pure data out; the
// stacked day chart reuses the costs page's ChartModel shape so CostChart.vue
// draws both.

/** Counts read plain; the locale is pinned so two renders of one tree agree. */
export const countText = (n: number): string => Math.round(n).toLocaleString("en-US");

/** A wall time for a tile or a cell: seconds under two minutes, minutes above — the `metrics trend` render's rule. */
export function wallText(ms: number): string {
  const seconds = (Number.isFinite(ms) ? ms : 0) / 1000;
  return seconds < 120 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds / 60)}m`;
}

/** A failure share as the command renders it: `2 in 20` → `10%`. */
export const pctText = (rate: number): string => `${Math.round((Number.isFinite(rate) ? rate : 0) * 100)}%`;

/** The same page for another range or agent — each pill keeps the other filter. */
export function metricsHrefOf(days: number, agent?: string): string {
  return `/metrics?days=${days}${agent !== undefined ? `&agent=${encodeURIComponent(agent)}` : ""}`;
}

export interface MetricsTileVm {
  label: string;
  value: string;
  sub: string;
}

/** The eight tiles, in reading order, every figure from the report's own numbers. */
export function metricsTilesOf(report: MetricsReport): MetricsTileVm[] {
  const t = report.tiles;
  return [
    { label: "Runs", value: countText(t.runs), sub: `${report.range.days}d window, UTC days` },
    { label: "Failed", value: countText(t.failed), sub: "runs that ended failed" },
    { label: "Failure rate", value: pctText(t.failureRate), sub: `${countText(t.failed)} of ${countText(t.runs)}` },
    { label: "p50 wall", value: wallText(t.p50WallMs), sub: "median run, runs-weighted" },
    { label: "p95 wall", value: wallText(t.p95WallMs), sub: "runs-weighted" },
    { label: "LLM spend", value: usd(t.usd), sub: "priced at finish" },
    { label: "Unpriced tokens", value: countText(t.unpricedTokens), sub: "tokens with no price row" },
    { label: "Turns", value: countText(t.turns), sub: "model turns in range" },
  ];
}

/** Every status that occurs in the range, in order of first appearance — the
 *  stacked chart's series and its legend (the costs page's `seriesOf` rule). */
export function statusSeriesOf(byDay: readonly MetricsByDayRow[]): string[] {
  const names: string[] = [];
  for (const d of byDay) for (const s of Object.keys(d.byStatus)) if (!names.includes(s)) names.push(s);
  return names;
}

const W = 960;
const H = 260;
const MARGIN = { t: 12, r: 12, b: 30, l: 48 };

/** Sparse x labels: every day under 17 bars, every nth above (the costs chart's rule). */
const labelEvery = (n: number): number => (n <= 16 ? 1 : Math.ceil(n / 16));

/** The runs-per-day stacked bars in the costs chart's own model shape: one bar
 *  per UTC day in range (a 90-day range is ninety buckets — the zero-filled
 *  report guarantees it), one segment per status with a count, counts on the
 *  grid and in the tips. */
export function runsChartModelOf(byDay: readonly MetricsByDayRow[], statuses: readonly string[]): ChartModel {
  const iw = W - MARGIN.l - MARGIN.r;
  const ih = H - MARGIN.t - MARGIN.b;
  const max = Math.max(1, ...byDay.map((d) => d.runs)) * 1.08;
  const bw = iw / Math.max(1, byDay.length);
  const gap = Math.min(10, bw * 0.28);
  const y = (v: number) => MARGIN.t + ih - (v / max) * ih;
  const gridLines = Array.from({ length: 5 }, (_, i) => {
    const v = (max / 4) * i;
    return { y: Number(y(v).toFixed(1)), label: countText(v) };
  });
  const segments: ChartSegment[] = [];
  const dayHovers: ChartDayHover[] = [];
  const dayLabels: Array<{ x: number; label: string }> = [];
  byDay.forEach((d, i) => {
    let acc = 0;
    const x = MARGIN.l + i * bw + gap / 2;
    const w = bw - gap;
    const rows = statuses
      .map((s) => ({ series: s, usd: d.byStatus[s] ?? 0 }))
      .filter((r) => r.usd > 0)
      .sort((a, b) => b.usd - a.usd);
    dayHovers.push({
      x: Number((MARGIN.l + i * bw).toFixed(1)),
      y: MARGIN.t,
      width: Number(bw.toFixed(1)),
      height: ih,
      title: `${d.day} — ${countText(d.runs)} runs${rows.map((r) => ` · ${r.series} ${countText(r.usd)}`).join("")}`,
      tip: {
        date: d.day,
        label: d.day,
        total: d.runs,
        partial: false,
        rows: rows.map((r) => ({ ...r, estimated: false })),
      },
    });
    statuses.forEach((s, si) => {
      const v = d.byStatus[s] ?? 0;
      if (v <= 0) return;
      const y0 = y(acc + v);
      const y1 = y(acc);
      segments.push({
        seriesIndex: si,
        x: Number(x.toFixed(1)),
        y: Number(y0.toFixed(1)),
        width: Number(w.toFixed(1)),
        height: Number(Math.max(0, y1 - y0 - 2).toFixed(1)),
      });
      acc += v;
    });
    if (i % labelEvery(byDay.length) === 0) {
      dayLabels.push({ x: Number((x + w / 2).toFixed(1)), label: d.day.slice(5) });
    }
  });
  return {
    width: W,
    height: H,
    gridLines,
    segments,
    dayHovers,
    dayLabels,
    axisY: Number(y(0).toFixed(1)),
    marginLeft: MARGIN.l,
    marginRight: MARGIN.r,
  };
}

/** One line of a trend chart: its polyline segments (split where a day has no
 *  value — an agent with no runs that day draws a gap, never a zero) and a dot
 *  per point so a lone day still shows. */
export interface TrendLineVm {
  name: string;
  seriesIndex: number;
  /** Each entry is one polyline's `points` attribute (two or more points). */
  segments: string[];
  dots: Array<{ x: number; y: number; title: string }>;
}

export interface TrendChartModel {
  width: number;
  height: number;
  gridLines: Array<{ y: number; label: string }>;
  dayLabels: Array<{ x: number; label: string }>;
  axisY: number;
  marginLeft: number;
  marginRight: number;
  lines: TrendLineVm[];
}

/** A per-day line chart over the range's days: `values[i]` aligns with `days[i]`, null is a gap. */
export function trendChartModelOf(
  days: readonly string[],
  series: ReadonlyArray<{ name: string; values: ReadonlyArray<number | null> }>,
  format: (v: number) => string,
  maxFloor = 1e-9,
): TrendChartModel {
  const iw = W - MARGIN.l - MARGIN.r;
  const ih = H - MARGIN.t - MARGIN.b;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = Math.max(maxFloor, ...all) * 1.08;
  const slot = iw / Math.max(1, days.length);
  const xOf = (i: number) => MARGIN.l + i * slot + slot / 2;
  const yOf = (v: number) => MARGIN.t + ih - (v / max) * ih;
  const gridLines = Array.from({ length: 5 }, (_, i) => {
    const v = (max / 4) * i;
    return { y: Number(yOf(v).toFixed(1)), label: format(v) };
  });
  const dayLabels = days
    .map((d, i) => ({ x: Number(xOf(i).toFixed(1)), label: d.slice(5), i }))
    .filter(({ i }) => i % labelEvery(days.length) === 0)
    .map(({ x, label }) => ({ x, label }));
  const lines: TrendLineVm[] = series.map((s, si) => {
    const segments: string[] = [];
    const dots: TrendLineVm["dots"] = [];
    let run: string[] = [];
    s.values.forEach((v, i) => {
      if (v === null) {
        if (run.length >= 2) segments.push(run.join(" "));
        run = [];
        return;
      }
      const x = Number(xOf(i).toFixed(1));
      const y = Number(yOf(v).toFixed(1));
      run.push(`${x},${y}`);
      dots.push({ x, y, title: `${days[i]} — ${s.name} ${format(v)}` });
    });
    if (run.length >= 2) segments.push(run.join(" "));
    return { name: s.name, seriesIndex: si, segments, dots };
  });
  return {
    width: W,
    height: H,
    gridLines,
    dayLabels,
    axisY: Number(yOf(0).toFixed(1)),
    marginLeft: MARGIN.l,
    marginRight: MARGIN.r,
    lines,
  };
}

/** The failure-rate line: failed share per UTC day, zero on a day with runs and none failed, a gap on an empty day. */
export function failureRateChartOf(byDay: readonly MetricsByDayRow[]): TrendChartModel {
  const days = byDay.map((d) => d.day);
  const values = byDay.map((d) => (d.runs > 0 ? (d.byStatus["failed"] ?? 0) / d.runs : null));
  return trendChartModelOf(days, [{ name: "failure rate", values }], pctText, 0.01);
}

/** The p50-wall line per agent, `byAgent`'s order (largest first) so colors match the table. */
export function p50ChartOf(
  byDay: readonly MetricsByDayRow[],
  byAgent: readonly MetricsByAgentRow[],
  p50ByDayAgent: readonly MetricsP50Row[],
): TrendChartModel {
  const days = byDay.map((d) => d.day);
  const byKey = new Map(p50ByDayAgent.map((r) => [`${r.day}\n${r.agent}`, r.p50WallMs]));
  const series = byAgent.map((a) => ({
    name: a.agent,
    values: days.map((d) => byKey.get(`${d}\n${a.agent}`) ?? null),
  }));
  return trendChartModelOf(days, series, wallText);
}

/** The footer's provenance, one sentence per fact the report's range names:
 *  the bucket, the pricing, the completeness and the retention. */
export function footerSentencesOf(range: MetricsReportRange): string[] {
  return [
    `Each finished run is one point, bucketed at ${range.bucket} (UTC days).`,
    `Dollars are priced ${range.pricing}, through the same price table the costs page uses.`,
    `Each run is counted ${range.completeness}, however many times its record is written.`,
    `The dataset keeps ${range.retentionDays} days; sampled rows are re-weighted in every figure.`,
  ];
}

/** Stroke classes by series index — the same muted palette as the costs chart's fills. */
export const SERIES_STROKE = [
  "stroke-[#4478b8] dark:stroke-[#7aa7e0]",
  "stroke-[#c8823b] dark:stroke-[#e0a95a]",
  "stroke-[#4c8c57] dark:stroke-[#6fae7a]",
  "stroke-[#b8963e] dark:stroke-[#d4b45a]",
  "stroke-[#b0568c] dark:stroke-[#d489b8]",
  "stroke-[#6b7bcc] dark:stroke-[#98a5e6]",
  "stroke-[#d05252] dark:stroke-[#e07a74]",
  "stroke-[#3e8e96] dark:stroke-[#6fb9c0]",
];
export const DOT_FILL = [
  "fill-[#4478b8] dark:fill-[#7aa7e0]",
  "fill-[#c8823b] dark:fill-[#e0a95a]",
  "fill-[#4c8c57] dark:fill-[#6fae7a]",
  "fill-[#b8963e] dark:fill-[#d4b45a]",
  "fill-[#b0568c] dark:fill-[#d489b8]",
  "fill-[#6b7bcc] dark:fill-[#98a5e6]",
  "fill-[#d05252] dark:fill-[#e07a74]",
  "fill-[#3e8e96] dark:fill-[#6fb9c0]",
];
