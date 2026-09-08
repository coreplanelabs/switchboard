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
// paints what comes back. One vocabulary with the card, the friction report
// and the log's own rows — getting ready, thinking, in tools, finishing up,
// Switchboard overhead — and never a raw span name outside `debug`.

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
  /** The record predates span schema (`RunHistorySeed.untimed`): no shape is
   *  computed and the note says so. */
  untimed?: boolean;
  /** The collapsed headline of the call card a tool span decorates, by call
   *  id — the Longest steps name a tool step by its command (`$ npm test`),
   *  falling back to the display table when the page knows no card. */
  callTitle?: (callId: string) => string | undefined;
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
  /** The step's name as its row reads: a tool step's command when the page
   *  knows the card, else the display table — never a raw span name. */
  label: string;
  /** The step's own time: its in-window duration minus the union of its children's. */
  ms: number;
  facts: string[];
  /** The id of the row the step is on the page — `call-<callId>` for a tool
   *  step, `span-<spanId>` otherwise — what the link scrolls to. */
  anchor: string;
}

/** One row of the legend under the bar: a term, its printed time, and what
 *  the term means (the hover). The same numbers as the bar, in the same order. */
export interface LegendItem {
  term: PrintedTerm;
  text: string;
  definition: string;
}

export interface TimelineVm {
  /** The header's total — the one number the legend's items sum to. */
  total: string;
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
  /** The gate: the bar, its legend and the ranked list are shown together. */
  shown: boolean;
  bar: BarSegment[];
  legend: LegendItem[];
  ranked: RankedItem[];
  rankedNote: string;
  /** A record with no root: `getting ready: not recorded (too large)`. */
  note: string;
  /** Raw names and the partition, for `Copy debug JSON` only. */
  debug: unknown;
}

/** What each word of the bar means — the legend item's hover. */
export const TERM_DEFINITIONS: Record<PrintedTerm, string> = {
  "getting ready": "before the agent's first turn: reading the thread, finding the repo, checking out, loading tools",
  thinking: "the model's turns — from a request to the model until its reply came back",
  "in tools": "the commands and tool calls the model ran",
  "finishing up": "after the agent's last turn: posting the PR, checking the workspace",
  "Switchboard overhead":
    "orchestration between steps, and moments when only a background read was running — the time no step claims",
  "not recorded": "a stretch of the run the record does not carry",
  "not loaded": "a stretch of the run this page did not load — the record has the full shape",
};
export const RANKED_NOTE = "Ranked by each step's own time, its children excluded — the bar counts every instant once.";
export const CURRENTLY_DELIVERING = "currently delivering";
export const NO_ROOT_NOTE = "getting ready: not recorded (too large)";
/** A record written before span schema: the one neutral empty state. */
export const NO_TIMING_NOTE = "no timing data";
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
  if (input.untimed) {
    // A record from before span schema: the header's total and the one note;
    // no shape is read from whatever the record carries.
    const empty = { total, current, openStep, captions: [], rankedNote: RANKED_NOTE, debug };
    return { ...empty, lede: total, shown: false, bar: [], legend: [], ranked: [], note: NO_TIMING_NOTE };
  }
  const captions = [
    queuedCaption("before", numberAttr(root, "queuedBeforeMs")),
    queuedCaption("behind", numberAttr(root, "queuedBehindMs")),
  ].filter((c): c is string => c !== undefined);
  const base = { total, current, openStep, captions, rankedNote: RANKED_NOTE, debug };
  if (!root) {
    // A record whose root was never stored, or a live page before its first
    // frame: the header's total, and on a record the one word for the missing setup.
    return {
      ...base,
      lede: total,
      shown: false,
      bar: [],
      legend: [],
      ranked: [],
      note: finished ? NO_ROOT_NOTE : "",
    };
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
  const legend: LegendItem[] = shown
    ? printed.items.map(({ term, s }) => ({
        term,
        text: formatDuration(s * 1000, "clock"),
        definition:
          term === "not recorded" && input.truncated ? `${TERM_DEFINITIONS[term]} (too large)` : TERM_DEFINITIONS[term],
      }))
    : [];
  return {
    ...base,
    lede,
    shown,
    bar: shown ? barOf(p, open) : [],
    legend,
    ranked: shown ? ranked(spans, root, owner, window, input.callTitle) : [],
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
 *  of their children's — the root, the agent loop and background subtrees
 *  excluded, ties by earlier start. A tool step is named by its card's command
 *  when the page knows the card, and anchored to that card; every other step
 *  to its row. */
function ranked(
  spans: readonly SpanRecord[],
  root: SpanRecord,
  owner: RunOwner,
  window: Window,
  callTitle: TimelineInput["callTitle"],
): RankedItem[] {
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
    // The root and the agent loop are the page's structure, not steps a reader
    // can go to (neither has a row); their own time is the overhead term.
    if (s === root || s.name === "run.agent") continue;
    if (classOf(s.name, owner) === undefined || underBackground(s, byId, owner)) continue;
    const [a, b] = clip(s);
    if (b <= a) continue;
    const children = (childrenOf.get(s.spanId) ?? [])
      .map(clip)
      .map(([x, y]): [number, number] => [Math.max(a, x), Math.min(b, y)])
      .filter(([x, y]) => y > x);
    const own = b - a - unionLength(children);
    if (own <= 0) continue;
    const callId = s.name.startsWith("tool.") && typeof s.attrs.callId === "string" ? s.attrs.callId : undefined;
    const title = callId ? callTitle?.(callId) : undefined;
    items.push({
      label: title ?? displayNameOf(s.name),
      ms: own,
      facts: factsOf(s),
      anchor: callId ? `call-${callId}` : `span-${s.spanId}`,
      startedAt: s.startedAt,
    });
  }
  items.sort((x, y) => y.ms - x.ms || x.startedAt - y.startedAt);
  return items.slice(0, 3).map(({ label, ms, facts, anchor }) => ({ label, ms, facts, anchor }));
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
