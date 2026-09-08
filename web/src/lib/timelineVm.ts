import {
  isInformative,
  partition,
  printedShape,
  type LossInterval,
  type Partition,
  type PrintedTerm,
  type Window,
} from "@core/core/trace/partition.js";
import { classOf, type Bucket, type RunOwner } from "@core/core/trace/streamSpans.js";
import type { SpanRecord } from "@core/core/trace/types.js";
import { displayNameOf } from "@core/core/trace/displayNames.js";
import { queuedCaption } from "@core/core/runShape.js";
import { deliveryCaption } from "./runPageModel";
import { formatDuration } from "./format";

// The run page's timeline (docs/reference/specs/live-view.md item 25; docs/reference/specs/tracing.md):
// the run's shape from its spans and stamps alone, on the header's own window
// so the lede's total IS the header's total. Pure: the page hands in the span
// set, the loss intervals, the window, the phase and the delivery stamps, and
// paints what comes back. One vocabulary with the card and the friction report
// — getting ready, thinking, in tools, finishing up, Switchboard overhead — and
// never a raw span name outside `debug`.

export type TimelinePhase = "live" | "delivering" | "ended";

export interface TimelineInput {
  spans: readonly SpanRecord[];
  losses: readonly LossInterval[];
  /** `[receivedAt (else startedAt), finishedAt]`, or to the projected server clock while live. */
  window: Window;
  owner: RunOwner;
  /** The header's total: the lede prints this window, never a second measurement. */
  totalMs: number;
  /** `live` while the agent works; `delivering` after the `finished` frame; `ended` after `end` or on a record. */
  phase: TimelinePhase;
  /** The delivery caption's inputs (`ended` only). */
  delivery?: { finishedAt?: number; sealedAt?: number; replyOk?: boolean };
  /** The record was cut to its budget: `not recorded` reads `(too large)`. */
  truncated?: boolean;
}

export interface BarSegment {
  term: PrintedTerm;
  ms: number;
  /** Of the window. */
  pct: number;
  /** The open bucket's in-flight tail (live only). */
  hatched: boolean;
}

export interface RankedItem {
  /** From the display table — never a raw span name. */
  label: string;
  /** The step's own time: its in-window duration minus the union of its children's. */
  ms: number;
  facts: string[];
}

export interface TimelineVm {
  /** `4m 12s — 34s getting ready · …`, or `40s — getting ready` below the gate, or the total alone. */
  lede: string;
  /** `currently thinking 1m 26s` / `currently delivering` / `delivered in 2s` / `reply failed` / "". */
  current: string;
  /** The deepest open counted span's display name (`a model turn`, `attaching the
   *  workspace`) — what the log's tail row names while live; "" when nothing
   *  counted is open. The same span `current` drills into. */
  openStep: string;
  /** The queued captions, from a minute. */
  captions: string[];
  /** The gate: the bar, the gloss and the ranked list are shown together. */
  shown: boolean;
  bar: BarSegment[];
  gloss: string;
  ranked: RankedItem[];
  rankedNote: string;
  /** A record with no root: `getting ready: not recorded (too large)`. */
  note: string;
  /** Raw names and the partition, for `Copy debug JSON` only. */
  debug: unknown;
}

export const GLOSS =
  "getting ready = finding the repo, checking out, loading tools · finishing up = posting the PR, checking the workspace · Switchboard overhead = orchestration between steps, and moments when only a background read was running";
export const RANKED_NOTE =
  "Ranked by each step's own time, its children excluded — the buckets above count every instant once.";
export const CURRENTLY_DELIVERING = "currently delivering";
export const NO_ROOT_NOTE = "getting ready: not recorded (too large)";
const NOT_LOADED_GLOSS = "not loaded (the record has the full shape)";

const BUCKET_WORD: Record<Bucket, PrintedTerm> = {
  getting_ready: "getting ready",
  thinking: "thinking",
  tools: "in tools",
  finishing_up: "finishing up",
};

export function buildTimeline(input: TimelineInput): TimelineVm {
  const { spans, window, owner } = input;
  const finished = input.phase !== "live";
  const p = partition(spans, { window, owner, finished, losses: input.losses });
  const printed = printedShape(p);
  const total = formatDuration(printed.totalS * 1000, "clock");
  const root = spans.find((s) => s.name === "request" && s.parentSpanId === undefined);
  const captions = [
    queuedCaption("before", numberAttr(root, "queuedBeforeMs")),
    queuedCaption("behind", numberAttr(root, "queuedBehindMs")),
  ].filter((c): c is string => c !== undefined);
  const open = input.phase === "live" ? deepestOpenCounted(spans, owner, window) : undefined;
  const current = currentOf(input, open);
  const openStep = open ? displayNameOf(open.name) : "";
  const debug = {
    window,
    owner,
    phase: input.phase,
    partition: p,
    spans: spans.map((s) => ({
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      name: s.name,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      status: s.status,
      attrs: s.attrs,
    })),
  };
  const base = { current, openStep, captions, gloss: GLOSS, rankedNote: RANKED_NOTE, debug };
  if (!root) {
    // A legacy record (no root) or a live page before its first frame: the
    // header's total, and on a record the one word for the missing setup.
    return { ...base, lede: total, shown: false, bar: [], ranked: [], note: finished ? NO_ROOT_NOTE : "" };
  }
  const termText = (term: PrintedTerm): string =>
    term === "not recorded"
      ? `not recorded${input.truncated ? " (too large)" : ""}`
      : term === "not loaded"
        ? NOT_LOADED_GLOSS
        : term;
  const shown = isInformative(p) && printed.items.length > 0;
  const lede = shown
    ? `${total} — ${printed.items.map(({ term, s }) => `${formatDuration(s * 1000, "clock")} ${termText(term)}`).join(" · ")}`
    : p.windowMs > 0
      ? `${total} — ${termText(dominantTerm(p))}`
      : total;
  return {
    ...base,
    lede,
    shown,
    bar: shown ? barOf(p, open) : [],
    ranked: shown ? ranked(spans, root, owner, window) : [],
    note: "",
  };
}

function numberAttr(span: SpanRecord | undefined, key: "queuedBeforeMs" | "queuedBehindMs"): number | undefined {
  const v = span?.attrs[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

interface OpenCounted {
  bucket: Bucket;
  elapsedMs: number;
  /** The span's own name, for the display table. */
  name: string;
}

/** The deepest open counted span (ties: the latest start) — what the run is in
 *  right now; nothing when the deepest open span is uncounted or background. */
function deepestOpenCounted(spans: readonly SpanRecord[], owner: RunOwner, window: Window): OpenCounted | undefined {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const depthOf = (s: SpanRecord): number => {
    let d = 1;
    const seen = new Set<string>([s.spanId]);
    let cur = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
    while (cur && !seen.has(cur.spanId)) {
      seen.add(cur.spanId);
      d++;
      cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined;
    }
    return d;
  };
  let best: { span: SpanRecord; depth: number; bucket: Bucket } | undefined;
  for (const s of spans) {
    if (s.endedAt !== undefined || s.startedAt >= window.end) continue;
    const cls = classOf(s.name, owner);
    if (cls?.kind !== "counted" || underBackground(s, byId, owner)) continue;
    const depth = depthOf(s);
    if (!best || depth > best.depth || (depth === best.depth && s.startedAt > best.span.startedAt)) {
      best = { span: s, depth, bucket: cls.bucket };
    }
  }
  if (!best) return undefined;
  return {
    bucket: best.bucket,
    name: best.span.name,
    elapsedMs: Math.max(0, window.end - Math.max(window.start, best.span.startedAt)),
  };
}

function underBackground(s: SpanRecord, byId: Map<string, SpanRecord>, owner: RunOwner): boolean {
  let cur: SpanRecord | undefined = s;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.spanId)) {
    seen.add(cur.spanId);
    if (classOf(cur.name, owner)?.kind === "background") return true;
    cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined;
  }
  return false;
}

function currentOf(input: TimelineInput, open: OpenCounted | undefined): string {
  if (input.phase === "delivering") return CURRENTLY_DELIVERING;
  if (input.phase === "ended") return deliveryCaption(input.delivery ?? {});
  return open ? `currently ${BUCKET_WORD[open.bucket]} ${formatDuration(open.elapsedMs, "clock")}` : "";
}

function termsOf(p: Partition): Array<[PrintedTerm, number]> {
  return [
    ["getting ready", p.gettingReadyMs],
    ["thinking", p.thinkingMs],
    ["in tools", p.toolsMs],
    ["finishing up", p.finishingUpMs],
    ["Switchboard overhead", p.overheadMs],
    ["not recorded", p.notRecordedMs],
    ["not loaded", p.notLoadedMs],
  ];
}

/** The largest term; ties go to the printed order. */
function dominantTerm(p: Partition): PrintedTerm {
  let best: [PrintedTerm, number] = ["getting ready", -1];
  for (const t of termsOf(p)) if (t[1] > best[1]) best = t;
  return best[0];
}

/** The bar: every non-zero term in printed order, the open bucket's in-flight
 *  tail split off and hatched (clamped to the bucket — a subset, never an addend). */
function barOf(p: Partition, open: OpenCounted | undefined): BarSegment[] {
  const segments: BarSegment[] = [];
  const pct = (ms: number) => (p.windowMs > 0 ? (ms / p.windowMs) * 100 : 0);
  for (const [term, ms] of termsOf(p)) {
    if (ms <= 0) continue;
    if (open && BUCKET_WORD[open.bucket] === term) {
      const tail = Math.min(open.elapsedMs, ms);
      if (ms - tail > 0) segments.push({ term, ms: ms - tail, pct: pct(ms - tail), hatched: false });
      if (tail > 0) segments.push({ term, ms: tail, pct: pct(tail), hatched: true });
      continue;
    }
    segments.push({ term, ms, pct: pct(ms), hatched: false });
  }
  return segments; // termsOf yields the printed order; a hatched tail follows its solid half
}

/** Up to three steps by their own time — the in-window duration minus the union
 *  of their children's — the root and background subtrees excluded, ties by
 *  earlier start. */
function ranked(spans: readonly SpanRecord[], root: SpanRecord, owner: RunOwner, window: Window): RankedItem[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const childrenOf = new Map<string, SpanRecord[]>();
  for (const s of spans) {
    if (s.parentSpanId === undefined) continue;
    const list = childrenOf.get(s.parentSpanId);
    if (list) list.push(s);
    else childrenOf.set(s.parentSpanId, [s]);
  }
  const clip = (s: SpanRecord): [number, number] => [
    Math.max(window.start, s.startedAt),
    Math.min(window.end, s.endedAt ?? window.end),
  ];
  const items: Array<RankedItem & { startedAt: number }> = [];
  for (const s of spans) {
    if (s === root || classOf(s.name, owner) === undefined || underBackground(s, byId, owner)) continue;
    const [a, b] = clip(s);
    if (b <= a) continue;
    const children = (childrenOf.get(s.spanId) ?? [])
      .map(clip)
      .map(([x, y]): [number, number] => [Math.max(a, x), Math.min(b, y)])
      .filter(([x, y]) => y > x);
    const own = b - a - unionLength(children);
    if (own <= 0) continue;
    items.push({ label: displayNameOf(s.name), ms: own, facts: factsOf(s), startedAt: s.startedAt });
  }
  items.sort((x, y) => y.ms - x.ms || x.startedAt - y.startedAt);
  return items.slice(0, 3).map(({ label, ms, facts }) => ({ label, ms, facts }));
}

function unionLength(intervals: Array<[number, number]>): number {
  const sorted = [...intervals].sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | undefined;
  for (const [a, b] of sorted) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else if (b > cur[1]) cur[1] = b;
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** The whitelisted facts a ranked step may show — attrs from closed tables,
 *  numbers formatted; never free text. */
function factsOf(s: SpanRecord): string[] {
  const a = s.attrs;
  const facts: string[] = [];
  if (a.token === "expired" || a.token === "expiring") facts.push(`token ${a.token}`);
  if (a.budget === "clipped") facts.push("budget clipped");
  if (typeof a.timeoutMs === "number") facts.push(`timeout ${formatDuration(a.timeoutMs, "clock")}`);
  if (typeof a.waitedMs === "number") facts.push(`waited ${formatDuration(a.waitedMs, "clock")}`);
  if (typeof a.exitCode === "number" && a.exitCode !== 0) facts.push(`exit ${a.exitCode}`);
  if (a.timedOut === true) facts.push("timed out");
  if (typeof a.attempts === "number" && a.attempts > 1) facts.push(`${a.attempts} attempts`);
  if (s.status === "error" && facts.length === 0) facts.push("failed");
  return facts;
}
