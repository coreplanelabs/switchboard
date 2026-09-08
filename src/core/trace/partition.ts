/** The partition (docs/reference/specs/tracing.md): every instant of a run's window
 *  belongs to exactly one of seven terms —
 *
 *    window = getting ready + thinking + tools + finishing up
 *           + Switchboard overhead + not recorded + not loaded
 *
 *  Three passes. (1) Claim: every counted span's interval, clipped to the
 *  window, claims the instants no deeper counted span already claimed (deepest
 *  wins; ties by earlier start, then id), so concurrent siblings count once and
 *  a tool inside a turn is tools, not thinking. Background subtrees claim
 *  nothing; uncounted spans are structure only. An open span (no end) runs to
 *  the window end on a live window; on a finished window, where nothing can
 *  still be running so a missing end was lost, a counted open span is cut at the
 *  first loss interval after its start. (2) Losses: `lost` intervals (seq gaps,
 *  `spans_dropped` notes) become not recorded and `elided` ones (a live
 *  replay's budget) not loaded, each minus the instants a counted span claims;
 *  where the two overlap, lost wins. (3) Overhead is the residual. */
import type { Bucket, RunOwner } from "./streamSpans.js";
import { classOf } from "./streamSpans.js";
import type { SpanRecord } from "./types.js";

export interface Window {
  start: number;
  end: number;
}

export interface LossInterval {
  from: number;
  to: number;
  kind: "lost" | "elided";
}

export interface PartitionInput {
  window: Window;
  owner: RunOwner;
  /** True for a record and for a live page after the `finished` frame. */
  finished: boolean;
  losses: readonly LossInterval[];
}

export interface Partition {
  windowMs: number;
  gettingReadyMs: number;
  thinkingMs: number;
  toolsMs: number;
  finishingUpMs: number;
  overheadMs: number;
  notRecordedMs: number;
  notLoadedMs: number;
  /** Instants covered only by background spans — part of overhead, reported
   *  so the no-gaps test can account for them exactly. */
  backgroundOnlyMs: number;
}

interface Claim {
  start: number;
  end: number;
  bucket: Bucket;
  depth: number;
  startedAt: number;
  spanId: string;
}

export function partition(spans: readonly SpanRecord[], input: PartitionInput): Partition {
  const { window, owner, finished } = input;
  const windowMs = Math.max(0, window.end - window.start);
  const byId = new Map(spans.map((s) => [s.spanId, s]));

  // Depth over the input set; an orphan (parent not in the set) is depth 1.
  const depthMemo = new Map<string, number>();
  const depthOf = (s: SpanRecord): number => {
    const memo = depthMemo.get(s.spanId);
    if (memo !== undefined) return memo;
    depthMemo.set(s.spanId, 1); // cycle guard
    const parent = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
    const d = parent ? depthOf(parent) + 1 : 1;
    depthMemo.set(s.spanId, d);
    return d;
  };
  const underBackground = (s: SpanRecord): boolean => {
    let cur: SpanRecord | undefined = s;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.spanId)) {
      seen.add(cur.spanId);
      if (classOf(cur.name, owner)?.kind === "background") return true;
      cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined;
    }
    return false;
  };

  const lossStarts = input.losses.map((l) => Math.max(window.start, l.from)).sort((a, b) => a - b);
  const clipEnd = (s: SpanRecord): number => {
    if (s.endedAt !== undefined) return Math.min(window.end, s.endedAt);
    if (!finished) return window.end;
    // Finished window: a counted open span's end was lost — cut at the next loss.
    const next = lossStarts.find((at) => at > s.startedAt);
    return next === undefined ? window.end : Math.min(window.end, next);
  };

  const claims: Claim[] = [];
  const backgroundIntervals: Array<[number, number]> = [];
  for (const s of spans) {
    const cls = classOf(s.name, owner);
    if (!cls) continue;
    const start = Math.max(window.start, s.startedAt);
    if (cls.kind === "background") {
      const end = Math.min(window.end, s.endedAt ?? window.end);
      if (end > start) backgroundIntervals.push([start, end]);
      continue;
    }
    if (cls.kind !== "counted" || underBackground(s)) continue;
    const end = clipEnd(s);
    if (end <= start) continue;
    claims.push({ start, end, bucket: cls.bucket, depth: depthOf(s), startedAt: s.startedAt, spanId: s.spanId });
  }
  claims.sort(
    (a, b) =>
      b.depth - a.depth || a.startedAt - b.startedAt || (a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0),
  );

  // Elementary intervals from every boundary in play.
  const points = new Set<number>([window.start, window.end]);
  for (const c of claims) {
    points.add(c.start);
    points.add(c.end);
  }
  for (const l of input.losses) {
    points.add(clamp(l.from, window));
    points.add(clamp(l.to, window));
  }
  for (const [a, b] of backgroundIntervals) {
    points.add(a);
    points.add(b);
  }
  const sorted = [...points].filter((p) => p >= window.start && p <= window.end).sort((a, b) => a - b);

  const buckets: Record<Bucket, number> = { getting_ready: 0, thinking: 0, tools: 0, finishing_up: 0 };
  let notRecorded = 0;
  let notLoaded = 0;
  let backgroundOnly = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const len = b - a;
    if (len <= 0) continue;
    const claim = claims.find((c) => c.start <= a && c.end >= b);
    if (claim) {
      buckets[claim.bucket] += len;
      continue;
    }
    const lost = input.losses.some((l) => l.kind === "lost" && clamp(l.from, window) <= a && clamp(l.to, window) >= b);
    if (lost) {
      notRecorded += len;
      continue;
    }
    const elided = input.losses.some(
      (l) => l.kind === "elided" && clamp(l.from, window) <= a && clamp(l.to, window) >= b,
    );
    if (elided) {
      notLoaded += len;
      continue;
    }
    if (backgroundIntervals.some(([s, e]) => s <= a && e >= b)) backgroundOnly += len;
  }
  const counted = buckets.getting_ready + buckets.thinking + buckets.tools + buckets.finishing_up;
  return {
    windowMs,
    gettingReadyMs: buckets.getting_ready,
    thinkingMs: buckets.thinking,
    toolsMs: buckets.tools,
    finishingUpMs: buckets.finishing_up,
    overheadMs: Math.max(0, windowMs - counted - notRecorded - notLoaded),
    notRecordedMs: notRecorded,
    notLoadedMs: notLoaded,
    backgroundOnlyMs: backgroundOnly,
  };
}

function clamp(at: number, w: Window): number {
  return Math.min(w.end, Math.max(w.start, at));
}

/** The seven terms as the printed shape: totals and buckets floored to whole
 *  seconds, the residual absorbing the rounding so the printed items always sum
 *  to the printed total, and no bucket printing `0s`. */
export interface PrintedShape {
  totalS: number;
  items: Array<{ term: PrintedTerm; s: number }>;
}
export type PrintedTerm =
  "getting ready" | "thinking" | "in tools" | "finishing up" | "Switchboard overhead" | "not recorded" | "not loaded";

export function printedShape(p: Partition): PrintedShape {
  const totalS = Math.floor(p.windowMs / 1000);
  const floored: Array<[PrintedTerm, number]> = [
    ["getting ready", Math.floor(p.gettingReadyMs / 1000)],
    ["thinking", Math.floor(p.thinkingMs / 1000)],
    ["in tools", Math.floor(p.toolsMs / 1000)],
    ["finishing up", Math.floor(p.finishingUpMs / 1000)],
    ["not recorded", Math.floor(p.notRecordedMs / 1000)],
    ["not loaded", Math.floor(p.notLoadedMs / 1000)],
  ];
  const sum = floored.reduce((a, [, s]) => a + s, 0);
  const items = floored.filter(([, s]) => s > 0).map(([term, s]) => ({ term, s }));
  const overhead = totalS - sum;
  if (overhead > 0) items.push({ term: "Switchboard overhead", s: overhead });
  // Order: the four counted words, then overhead, then the two loss terms.
  const order: PrintedTerm[] = [
    "getting ready",
    "thinking",
    "in tools",
    "finishing up",
    "Switchboard overhead",
    "not recorded",
    "not loaded",
  ];
  items.sort((a, b) => order.indexOf(a.term) - order.indexOf(b.term));
  return { totalS, items };
}

/** A bucket is informative at 5 % of the window or 2 s; the shape is shown when
 *  at least two are. */
export function isInformative(p: Partition): boolean {
  const terms = [
    p.gettingReadyMs,
    p.thinkingMs,
    p.toolsMs,
    p.finishingUpMs,
    p.overheadMs,
    p.notRecordedMs,
    p.notLoadedMs,
  ];
  const informative = terms.filter((ms) => ms >= 2000 || (p.windowMs > 0 && ms / p.windowMs >= 0.05)).length;
  return informative >= 2;
}
