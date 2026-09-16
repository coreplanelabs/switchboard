import type { CostReport, DailyCost } from "@core/core/costs.js";
import type { CostsSnapshotStatus } from "@core/core/costsSnapshot.js";
import { snapshotAgeText, untilText } from "@core/core/snapshotAge.js";
import { snapshotTime } from "./delivery";

// The costs page's view model, ported from the string renderer: series
// discovery, per-day values, the stat tiles, and the stacked-bar geometry.
// Pure data in, pure data out — the component does layout only.

export const DO_LABEL = "Durable Objects";

/** Who a take is credited to in the status line: the loop's takes read `on schedule`, a person's `by <name>`. */
const takerText = (by: string): string => (by === "schedule" ? "on schedule" : `by ${by}`);

/**
 * The one line the page shows about its snapshot (costs.md item 6): when it
 * was taken and how long ago, who took it, when the next is due — or that one
 * is being taken now, or that none has landed yet. The last failed take is
 * named until one succeeds. Pure; `nowMs` is the ticking clock.
 */
export function snapshotLineOf(status: CostsSnapshotStatus, nowMs: number): string {
  const parts: string[] = [];
  if (status.inFlight) {
    parts.push(
      `Taking a snapshot now — started ${snapshotAgeText(status.inFlight.startedAt, nowMs)} ${takerText(status.inFlight.by)}`,
    );
    if (status.snapshot) parts.push(`showing the one from ${snapshotTime(status.snapshot.takenAt)} meanwhile`);
  } else if (status.snapshot) {
    parts.push(
      `Snapshot from ${snapshotTime(status.snapshot.takenAt)}, ${snapshotAgeText(status.snapshot.takenAt, nowMs)} ${takerText(status.snapshot.takenBy)}`,
    );
    if (status.nextAt) parts.push(`next ${untilText(status.nextAt, nowMs)}`);
  } else {
    parts.push("No snapshot yet — the first one is taken within a minute of startup");
  }
  if (status.lastFailure && !status.inFlight)
    parts.push(
      `last attempt ${snapshotAgeText(status.lastFailure.at, nowMs)} failed: ${status.lastFailure.message.slice(0, 120)}`,
    );
  return parts.join(" · ");
}
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

/** The month projection, cloud and LLM as separate run-rates added together:
 *  cloud from the last seven full days, LLM from the closed days that have LLM
 *  data (the workspace may be younger than the range) — and, while a rate has no
 *  full day to stand on, from the open day scaled to a full one by the fraction
 *  of the UTC day elapsed at `generatedAt`. A projection that ignored LLM on a
 *  young workspace read an order of magnitude low. */
export interface CostProjection {
  monthUsd: number;
  cloudRate: number;
  llmRate: number;
  cloudBasis: "full-days" | "today";
  /** `none` = LLM unavailable, or no LLM data at all in range. */
  llmBasis: "closed-days" | "today" | "none";
  /** How many closed days the LLM rate averages (when `llmBasis` is `closed-days`). */
  llmClosedDays: number;
}

export const DAYS_PER_MONTH_PROJECTION = 30.4;

export interface CostTiles {
  yesterday?: { date: string; total: number };
  /** The open day (`partialLastDay`), so a one-day range has a figure to lead with. */
  today?: { date: string; total: number };
  /** Average total per full day over the last seven; absent when the range has no full day. */
  avg7?: number;
  projection: CostProjection;
  /** LLM dollars over the range, yesterday's, and the open day's (an estimate
   *  from the usage report when the cost report has not closed it). Not a
   *  share: LLM spend dwarfs the Cloudflare spend, so a percentage of the total
   *  would say nothing. */
  llm: { range: number; yesterday?: number; today?: { usd: number; estimated: boolean } };
  /** This group's share of the account's whole Cloudflare spend in range (percent, rounded). */
  accountShare: number;
}

/** The stat tiles: the averages over FULL days only (a partial today would
 *  understate every figure), the open day named as such, the shares over the
 *  whole range. */
export function tilesOf(report: CostReport): CostTiles {
  const full = report.range.partialLastDay ? report.days.slice(0, -1) : report.days;
  const today = report.range.partialLastDay ? report.days[report.days.length - 1] : undefined;
  const yesterday = full[full.length - 1];
  const last7 = full.slice(-7);
  const avg7 = last7.length ? last7.reduce((s, d) => s + d.total, 0) / last7.length : undefined;
  const accountShare =
    report.account.cloudUsd > 0 ? Math.round((report.totals.cloudUsd / report.account.cloudUsd) * 100) : 0;
  return {
    ...(yesterday ? { yesterday: { date: yesterday.date, total: yesterday.total } } : {}),
    ...(today ? { today: { date: today.date, total: today.total } } : {}),
    ...(avg7 !== undefined ? { avg7 } : {}),
    projection: projectionOf(report, full, today),
    llm: {
      range: report.totals.llmUsd,
      ...(yesterday ? { yesterday: yesterday.llmUsd } : {}),
      ...(today ? { today: { usd: today.llmUsd, estimated: today.llmEstimated } } : {}),
    },
    accountShare,
  };
}

const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;

/** The fraction of the open UTC day elapsed at `generatedAt`, never below one
 *  hour so a figure read just after midnight is not scaled to infinity. */
function elapsedFractionOf(report: CostReport, today: DailyCost): number {
  const dayStart = Date.parse(`${today.date}T00:00:00Z`);
  const f = (report.generatedAt - dayStart) / 86_400_000;
  return Math.min(1, Math.max(1 / 24, Number.isFinite(f) ? f : 1));
}

function projectionOf(report: CostReport, full: DailyCost[], today: DailyCost | undefined): CostProjection {
  const frac = today ? elapsedFractionOf(report, today) : 1;
  const last7 = full.slice(-7);
  let cloudRate = 0;
  let cloudBasis: CostProjection["cloudBasis"] = "full-days";
  if (last7.length) cloudRate = mean(last7.map((d) => d.cloudUsd));
  else if (today) {
    cloudRate = today.cloudUsd / frac;
    cloudBasis = "today";
  }
  let llmRate = 0;
  let llmBasis: CostProjection["llmBasis"] = "none";
  let llmClosedDays = 0;
  if (report.llmAvailable) {
    // The workspace may be younger than the range: average only from the first
    // closed day that has LLM spend, so leading zero days do not dilute the rate.
    const first = full.findIndex((d) => d.llmUsd > 0);
    const closed = first === -1 ? [] : full.slice(first).slice(-7);
    if (closed.length) {
      llmRate = mean(closed.map((d) => d.llmUsd));
      llmBasis = "closed-days";
      llmClosedDays = closed.length;
    } else if (today && today.llmUsd > 0) {
      llmRate = today.llmUsd / frac;
      llmBasis = "today";
    }
  }
  return {
    monthUsd: (cloudRate + llmRate) * DAYS_PER_MONTH_PROJECTION,
    cloudRate,
    llmRate,
    cloudBasis,
    llmBasis,
    llmClosedDays,
  };
}

/** Where each figure can be dug into: the Cloudflare dashboard pages for the
 *  account and its billed products, and Anthropic's cost page for the LLM line. */
export interface CostLinks {
  account: string;
  billing: string;
  containers: string;
  durableObjects: string;
  workers: string;
  r2: string;
  workflows: string;
  worker: (script: string) => string;
  bucket: (name: string) => string;
  anthropic: string;
}

export function linksOf(report: CostReport): CostLinks {
  const dash = `https://dash.cloudflare.com/${report.account.id}`;
  return {
    account: dash,
    billing: `${dash}/billing`,
    containers: `${dash}/workers/containers`,
    durableObjects: `${dash}/workers/durable-objects`,
    workers: `${dash}/workers-and-pages`,
    r2: `${dash}/r2/overview`,
    workflows: `${dash}/workers/workflows`,
    worker: (script) => `${dash}/workers/services/view/${encodeURIComponent(script)}/production/metrics`,
    bucket: (name) => `${dash}/r2/default/buckets/${encodeURIComponent(name)}`,
    anthropic: "https://platform.claude.com/cost",
  };
}

/** The account as the page names it: the configured name, else the id's first eight hex. */
export const accountLabelOf = (report: CostReport): string =>
  report.account.name ?? `${report.account.id.slice(0, 8)}…`;

/** The hover text for one day: every series and the total, one per line, the
 *  open day's LLM estimate said so. */
export function dayTitleOf(d: DailyCost, series: string[], partial: boolean): string {
  const lines = [`${d.date} · total ${usd(d.total)}${partial ? " (partial day)" : ""}`];
  for (const s of series) {
    const v = valueOf(d, s);
    if (v <= 0) continue;
    lines.push(`${s} ${usd(v)}${s === LLM_LABEL && d.llmEstimated ? " (estimate)" : ""}`);
  }
  return lines.join("\n");
}

/** An ISO day (`YYYY-MM-DD`) → `Aug 1`, the way the page reads dates aloud. */
export function monthDayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The tooltip's content for one day, structured so the panel can lay it out
 *  as a header and a two-column table: the components that cost anything,
 *  largest first, the LLM estimate tagged. */
export interface DayTip {
  date: string;
  /** `Aug 29` */
  label: string;
  partial: boolean;
  total: number;
  rows: Array<{ series: string; usd: number; estimated: boolean }>;
}

export function dayTipOf(d: DailyCost, series: string[], partial: boolean): DayTip {
  const rows = series
    .map((s) => ({ series: s, usd: valueOf(d, s), estimated: s === LLM_LABEL && d.llmEstimated }))
    .filter((r) => r.usd > 0)
    .sort((a, b) => b.usd - a.usd);
  return { date: d.date, label: monthDayOf(d.date), partial, total: d.total, rows };
}

export interface ChartSegment {
  seriesIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ChartTick {
  x?: number;
  y?: number;
  label: string;
}
/** One transparent hover target per day, the full column, whose title is the
 *  day's whole breakdown (`dayTitleOf`). Drawn over the segments. */
export interface ChartDayHover {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The breakdown as one text, for the column's accessible label. */
  title: string;
  /** The same breakdown structured, for the tooltip panel. */
  tip: DayTip;
}
export interface ChartModel {
  width: number;
  height: number;
  gridLines: Array<{ y: number; label: string }>;
  segments: ChartSegment[];
  dayHovers: ChartDayHover[];
  dayLabels: Array<{ x: number; label: string }>;
  axisY: number;
  marginLeft: number;
  marginRight: number;
}

/** The stacked-bar geometry (one bar per day, one <rect> per positive series
 *  value, and one column-high <rect> per day whose <title> is the whole day's
 *  breakdown — the one hover target, working without JS). */
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
  const dayHovers: ChartDayHover[] = [];
  const dayLabels: Array<{ x: number; label: string }> = [];
  days.forEach((d, i) => {
    let acc = 0;
    const x = m.l + i * bw + gap / 2;
    const w = bw - gap;
    dayHovers.push({
      x: Number((m.l + i * bw).toFixed(1)),
      y: m.t,
      width: Number(bw.toFixed(1)),
      height: ih,
      title: dayTitleOf(d, series, report.range.partialLastDay && i === days.length - 1),
      tip: dayTipOf(d, series, report.range.partialLastDay && i === days.length - 1),
    });
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
    dayHovers,
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
