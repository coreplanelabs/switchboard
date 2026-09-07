// `load:history`: the production concurrency baseline, reproducible. The run
// store lists finished runs newest-first with a (finishedAt, id) cursor; this
// pages it, drops the provisional start-of-run tombstones (finishedAt equals
// startedAt — features/run-history.md item 27), and sweeps the intervals for
// the peak number of runs live at once. The plan's "peak 8" came from here.

import { percentile } from "./aggregate.js";

export interface RunInterval {
  startedAt: number;
  finishedAt: number;
}

/** Rows with a real duration: the start tombstone (finishedAt === startedAt) is not a run. */
export function realRuns<T extends RunInterval>(items: readonly T[]): T[] {
  return items.filter((r) => r.finishedAt > r.startedAt);
}

export interface PeakConcurrency {
  peak: number;
  /** Epoch ms when the peak was first reached; undefined with no runs. */
  at: number | undefined;
  /** Peak per UTC day (`YYYY-MM-DD`). */
  perDay: Record<string, number>;
}

/** Sweep-line over half-open [startedAt, finishedAt) intervals. */
export function peakConcurrency(items: readonly RunInterval[]): PeakConcurrency {
  const events: Array<[number, number]> = [];
  for (const r of items) {
    events.push([r.startedAt, +1]);
    events.push([r.finishedAt, -1]);
  }
  // Ends before starts at the same instant: a run finishing exactly when
  // another starts does not overlap it.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  let peak = 0;
  let at: number | undefined;
  const perDay: Record<string, number> = {};
  for (const [t, d] of events) {
    live += d;
    if (d > 0) {
      const day = new Date(t).toISOString().slice(0, 10);
      perDay[day] = Math.max(perDay[day] ?? 0, live);
    }
    if (live > peak) {
      peak = live;
      at = t;
    }
  }
  return { peak, at, perDay };
}

export interface DurationStats {
  count: number;
  meanS: number;
  p50S: number;
  p90S: number;
  p99S: number;
  maxS: number;
}

export function durationStats(items: readonly RunInterval[]): DurationStats {
  const s = items.map((r) => (r.finishedAt - r.startedAt) / 1000).sort((a, b) => a - b);
  const mean = s.length === 0 ? NaN : s.reduce((a, b) => a + b, 0) / s.length;
  return {
    count: s.length,
    meanS: round(mean),
    p50S: round(percentile(s, 50)),
    p90S: round(percentile(s, 90)),
    p99S: round(percentile(s, 99)),
    maxS: round(s[s.length - 1] ?? NaN),
  };
}

function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n) : n;
}

export interface ListCursor {
  before: number;
  beforeId: string;
}

/** Page a newest-first listing with the store's compound cursor until a short
 *  page or `maxPages`. `fetchPage` receives the cursor to continue from. */
export async function pageAll<T extends { id: string; finishedAt: number }>(
  fetchPage: (cursor?: ListCursor) => Promise<T[]>,
  opts: { pageSize: number; maxPages: number },
): Promise<T[]> {
  const all: T[] = [];
  let cursor: ListCursor | undefined;
  for (let page = 0; page < opts.maxPages; page++) {
    const items = await fetchPage(cursor);
    all.push(...items);
    if (items.length < opts.pageSize) break;
    const last = items[items.length - 1];
    cursor = { before: last.finishedAt, beforeId: last.id };
  }
  return all;
}
