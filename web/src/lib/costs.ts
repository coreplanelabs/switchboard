import type { CostReport, DailyCost } from "@core/core/costs.js";

// The costs page's view model, ported from the string renderer: series
// discovery, per-day values, the stat tiles, and the stacked-bar geometry.
// Pure data in, pure data out — the component does layout only.

export const DO_LABEL = "Durable Objects";
/** Workers requests + CPU, SQLite rows + storage, R2, Workflows — the meters
 *  that are cents a day at today's volume, stacked as one series so the chart
 *  stays legible. */
export const PLATFORM_LABEL = "Workers · storage · R2";
export const LLM_LABEL = "LLM (Anthropic)";

export const usd = (v: number, digits = 2): string => `$${v.toFixed(digits)}`;

/** The day's Workers + SQLite rows/storage + R2 + Workflows spend. */
export const platformUsdOf = (d: DailyCost): number =>
  d.workersUsd + d.doRowsUsd + d.doStorageUsd + d.r2Usd + d.workflowsUsd;

/** Every stackable series in a report, in a stable order: containers (order of
 *  first appearance), then DOs as one series, then the platform meters, then LLM. */
export function seriesOf(report: CostReport): string[] {
  const names: string[] = [];
  for (const d of report.days) for (const k of Object.keys(d.containers)) if (!names.includes(k)) names.push(k);
  if (report.days.some((d) => Object.keys(d.durableObjects).length > 0)) names.push(DO_LABEL);
  if (report.days.some((d) => platformUsdOf(d) > 0)) names.push(PLATFORM_LABEL);
  if (report.llmAvailable) names.push(LLM_LABEL);
  return names;
}

export function valueOf(d: DailyCost, series: string): number {
  if (series === DO_LABEL) return Object.values(d.durableObjects).reduce((s, v) => s + v, 0) + d.doRequestsUsd;
  if (series === PLATFORM_LABEL) return platformUsdOf(d);
  if (series === LLM_LABEL) return d.llmUsd;
  return d.containers[series]?.total ?? 0;
}

export interface CostTiles {
  yesterday?: { date: string; total: number };
  avg7: number;
  projectedMonth: number;
  llmShare: number;
  /** This group's share of the account's whole Cloudflare spend in range (percent, rounded). */
  accountShare: number;
}

/** The stat tiles, computed over FULL days only (a partial today would
 *  understate every figure); the shares over the whole range. */
export function tilesOf(report: CostReport): CostTiles {
  const full = report.range.partialLastDay ? report.days.slice(0, -1) : report.days;
  const yesterday = full[full.length - 1];
  const last7 = full.slice(-7);
  const avg7 = last7.length ? last7.reduce((s, d) => s + d.total, 0) / last7.length : 0;
  const llmShare = report.totals.total > 0 ? Math.round((report.totals.llmUsd / report.totals.total) * 100) : 0;
  const accountShare =
    report.account.cloudUsd > 0 ? Math.round((report.totals.cloudUsd / report.account.cloudUsd) * 100) : 0;
  return {
    ...(yesterday ? { yesterday: { date: yesterday.date, total: yesterday.total } } : {}),
    avg7,
    projectedMonth: avg7 * 30.4,
    llmShare,
    accountShare,
  };
}

export interface ChartSegment {
  seriesIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
}
export interface ChartTick {
  x?: number;
  y?: number;
  label: string;
}
export interface ChartModel {
  width: number;
  height: number;
  gridLines: Array<{ y: number; label: string }>;
  segments: ChartSegment[];
  dayLabels: Array<{ x: number; label: string }>;
  axisY: number;
  marginLeft: number;
  marginRight: number;
}

/** The stacked-bar geometry (one bar per day, one <rect> per positive series
 *  value, a <title> per segment so hover works without JS). */
export function chartModelOf(report: CostReport, series: string[]): ChartModel {
  const W = 960;
  const H = 260;
  const m = { t: 12, r: 12, b: 30, l: 48 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const days = report.days;
  const max = Math.max(1e-9, ...days.map((d) => d.total)) * 1.08;
  const bw = iw / Math.max(1, days.length);
  const gap = Math.min(10, bw * 0.28);
  const y = (v: number) => m.t + ih - (v / max) * ih;
  const gridLines = Array.from({ length: 5 }, (_, i) => {
    const v = (max / 4) * i;
    return { y: Number(y(v).toFixed(1)), label: usd(v) };
  });
  const segments: ChartSegment[] = [];
  const dayLabels: Array<{ x: number; label: string }> = [];
  days.forEach((d, i) => {
    let acc = 0;
    const x = m.l + i * bw + gap / 2;
    const w = bw - gap;
    series.forEach((s, si) => {
      const v = valueOf(d, s);
      if (v <= 0) return;
      const y0 = y(acc + v);
      const y1 = y(acc);
      const h = Math.max(0, y1 - y0 - 2);
      segments.push({
        seriesIndex: si,
        x: Number(x.toFixed(1)),
        y: Number(y0.toFixed(1)),
        width: Number(w.toFixed(1)),
        height: Number(h.toFixed(1)),
        title: `${d.date} · ${s} · ${usd(v)}`,
      });
      acc += v;
    });
    if (days.length <= 16 || i % Math.ceil(days.length / 16) === 0) {
      dayLabels.push({ x: Number((x + w / 2).toFixed(1)), label: d.date.slice(5) });
    }
  });
  return {
    width: W,
    height: H,
    gridLines,
    segments,
    dayLabels,
    axisY: Number(y(0).toFixed(1)),
    marginLeft: m.l,
    marginRight: m.r,
  };
}

export interface ResourceSplitRow {
  label: string;
  usd: number;
  percent: number;
}

/** Cloudflare spend split by billed resource, with each row's share. */
export function resourceSplitOf(report: CostReport): ResourceSplitRow[] {
  const b = report.totals.byResource;
  const parts: Array<[string, number]> = [
    ["Memory (provisioned while awake)", b.memory],
    ["vCPU (active use only)", b.cpu],
    ["Durable Object duration + requests", b.durableObjects],
    ["Disk (provisioned while awake)", b.disk],
    ["Workers requests + CPU", b.workers],
    ["Durable Object SQLite rows", b.doRows],
    ["Durable Object SQLite storage", b.doStorage],
    ["R2 storage + operations", b.r2],
    ["Workflow steps + state", b.workflows],
  ];
  const tot = parts.reduce((s, p) => s + p[1], 0) || 1;
  return parts.map(([label, v]) => ({ label, usd: v, percent: (v / tot) * 100 }));
}

/** Series swatch/fill classes by index — the theme's muted data palette (the
 *  same print saturation as the status tokens in main.css), one hue per
 *  series, light + dark stepped, painted as Tailwind arbitrary-value classes:
 *  blue, orange, green, yellow, plum, indigo, red, teal. */
export const SERIES_FILL = [
  "fill-[#4478b8] dark:fill-[#7aa7e0]",
  "fill-[#c8823b] dark:fill-[#e0a95a]",
  "fill-[#4c8c57] dark:fill-[#6fae7a]",
  "fill-[#b8963e] dark:fill-[#d4b45a]",
  "fill-[#b0568c] dark:fill-[#d489b8]",
  "fill-[#6b7bcc] dark:fill-[#98a5e6]",
  "fill-[#d05252] dark:fill-[#e07a74]",
  "fill-[#3e8e96] dark:fill-[#6fb9c0]",
];
export const SERIES_SWATCH = [
  "bg-[#4478b8] dark:bg-[#7aa7e0]",
  "bg-[#c8823b] dark:bg-[#e0a95a]",
  "bg-[#4c8c57] dark:bg-[#6fae7a]",
  "bg-[#b8963e] dark:bg-[#d4b45a]",
  "bg-[#b0568c] dark:bg-[#d489b8]",
  "bg-[#6b7bcc] dark:bg-[#98a5e6]",
  "bg-[#d05252] dark:bg-[#e07a74]",
  "bg-[#3e8e96] dark:bg-[#6fb9c0]",
];
