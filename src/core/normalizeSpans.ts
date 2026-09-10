import { isSpanRecord, type RunEvent, type SpanEndEvent, type SpanStartEvent } from "./runEvents.js";
import type { LossInterval } from "./trace/partition.js";
import type { SpanRecord } from "./trace/types.js";
import type { SpanAttrs } from "./trace/attrs.js";

// The one Adapter between a run stream and the span set the partition, the
// analyzer and the timeline read (docs/reference/specs/tracing.md). A stream is
// span schema (`SPAN_SCHEMA`): spans carry the timing. A content pair whose
// `tool.*` twin was dropped by the record budget still deserves a span, so
// `normalizeSpans` adds a synthesized span for every stamped, `callId`-keyed
// pair that lacks one and never touches a pair that has one — it is idempotent
// and the identity on a complete stream. A record below `SPAN_SCHEMA` is never
// normalized: its readers show no timing (docs/reference/migrations.md).
// `spansFromEvents` pairs the records into `SpanRecord`s and `lossesFromStream`
// derives the loss intervals from the `seq` gaps, the `spans_dropped` notes and
// the live transport's elided ranges.

/** The stream schema from which spans are the timing record. A record whose
 *  `schema` is absent or below it carries no timing. */
export const SPAN_SCHEMA = 2;

/** A synthesized span's id: `synth:<callId>` for a call whose id is a plain
 *  token, else `synth:<content index>`. */
function synthId(callId: string, index: number): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(callId) ? `synth:${callId}` : `synth:${index}`;
}

interface OpenAgent {
  spanId: string;
  startedAt: number;
  endedAt: number;
}

/** The `run.agent` spans that survive on the stream, as intervals — a
 *  synthesized span's parent is the innermost one containing it. */
function agentSpans(events: readonly RunEvent[]): OpenAgent[] {
  const out: OpenAgent[] = [];
  for (const e of events) {
    if (e.type === "span_end" && e.name === "run.agent") {
      out.push({ spanId: e.spanId, startedAt: e.startedAt, endedAt: e.startedAt + e.durationMs });
    }
  }
  return out;
}

function parentFor(agents: readonly OpenAgent[], at: number): string | undefined {
  let best: OpenAgent | undefined;
  for (const a of agents) {
    if (a.startedAt <= at && at <= a.endedAt && (!best || a.endedAt - a.startedAt < best.endedAt - best.startedAt))
      best = a;
  }
  return best?.spanId;
}

/**
 * Synthesize the `tool.*` spans a stream is missing: one per stamped
 * `tool_call` with a `callId` and no twin, closed by the `tool_result` with the
 * same `callId`. Returns a new array; the input is never mutated. The
 * synthesized `span_start` is placed right before the call, the `span_end`
 * right after the result, so a per-event fold sees them where the emitter
 * would have put them. A call with no `callId` or no `at` gets no span: there
 * is nothing to key or to time it by.
 */
export function normalizeSpans(events: readonly RunEvent[]): RunEvent[] {
  const agents = agentSpans(events);

  // What already has a twin.
  const toolSpanCallIds = new Set<string>();
  for (const e of events) {
    if (!isSpanRecord(e)) continue;
    const attrs = (e.attrs ?? {}) as Record<string, unknown>;
    if (e.name.startsWith("tool.") && typeof attrs.callId === "string") toolSpanCallIds.add(attrs.callId);
  }

  const out: RunEvent[] = [];
  // A call's synthesized start, keyed by callId, until its result closes it.
  const openCalls = new Map<string, { spanId: string; startedAt: number }>();

  events.forEach((e, index) => {
    switch (e.type) {
      case "tool_call": {
        const callId = e.callId;
        if (callId === undefined || e.at === undefined || toolSpanCallIds.has(callId)) {
          out.push(e);
          return;
        }
        const spanId = synthId(callId, index);
        out.push(spanStart(spanId, `tool.${e.tool}`, e.at, parentFor(agents, e.at), { callId }), e);
        openCalls.set(callId, { spanId, startedAt: e.at });
        return;
      }
      case "tool_result": {
        out.push(e);
        if (e.callId === undefined) return;
        const open = openCalls.get(e.callId);
        if (!open) return; // a result whose call has a real twin (or no call at all): nothing to close
        openCalls.delete(e.callId);
        const endedAt = e.at ?? open.startedAt;
        const attrs: Record<string, string | number | boolean> = { ok: e.ok, callId: e.callId };
        if (e.exitCode !== undefined) attrs.exitCode = e.exitCode;
        if (e.infra) attrs.infra = true;
        out.push(
          spanEnd(
            open.spanId,
            `tool.${e.tool}`,
            open.startedAt,
            Math.max(0, endedAt - open.startedAt),
            parentFor(agents, open.startedAt),
            attrs,
            e.ok ? "ok" : "error",
          ),
        );
        return;
      }
      default:
        out.push(e);
    }
  });
  return out;
}

function spanStart(
  spanId: string,
  name: string,
  at: number,
  parentSpanId?: string,
  attrs?: Record<string, string | number | boolean>,
): SpanStartEvent {
  return {
    type: "span_start",
    spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    name,
    ...(attrs ? { attrs } : {}),
    at,
  };
}

function spanEnd(
  spanId: string,
  name: string,
  startedAt: number,
  durationMs: number,
  parentSpanId?: string,
  attrs?: Record<string, string | number | boolean>,
  status: "ok" | "error" = "ok",
): SpanEndEvent {
  return {
    type: "span_end",
    spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    name,
    startedAt,
    durationMs,
    status,
    ...(attrs ? { attrs } : {}),
    at: startedAt + durationMs,
  };
}

/** Pair the span records of a (normalized) stream into `SpanRecord`s. A
 *  `span_start` with no `span_end` is an open span (no `endedAt`); a `span_end`
 *  with no start is complete on its own. `traceId` is the stream's — the run id
 *  the caller names, since a stream belongs to one run. */
export function spansFromEvents(events: readonly RunEvent[], traceId: string): SpanRecord[] {
  const byId = new Map<string, SpanRecord>();
  for (const e of events) if (isSpanRecord(e)) foldSpanRecord(byId, e, traceId);
  return [...byId.values()];
}

/** Fold one span record into the set: a start opens the record (unless an end
 *  already made it), an end completes it, keeping a start's parent and attrs.
 *  The per-frame half of `spansFromEvents`, for a page that folds live. */
export function foldSpanRecord(byId: Map<string, SpanRecord>, e: SpanStartEvent | SpanEndEvent, traceId: string): void {
  const prior = byId.get(e.spanId);
  if (e.type === "span_start") {
    if (prior) return; // an end already made the record
    byId.set(e.spanId, {
      traceId,
      spanId: e.spanId,
      ...(e.parentSpanId !== undefined ? { parentSpanId: e.parentSpanId } : {}),
      name: e.name,
      startedAt: e.at ?? 0,
      attrs: (e.attrs ?? {}) as SpanAttrs,
    });
    return;
  }
  byId.set(e.spanId, {
    traceId,
    spanId: e.spanId,
    ...(e.parentSpanId !== undefined
      ? { parentSpanId: e.parentSpanId }
      : prior?.parentSpanId !== undefined
        ? { parentSpanId: prior.parentSpanId }
        : {}),
    name: e.name,
    startedAt: e.startedAt,
    endedAt: e.startedAt + e.durationMs,
    durationMs: e.durationMs,
    status: e.status,
    ...(e.error !== undefined ? { errorMessage: e.error } : {}),
    attrs: { ...(prior?.attrs ?? {}), ...((e.attrs ?? {}) as SpanAttrs) },
  });
}

export interface ElidedRange {
  fromSeq: number;
  toSeq: number;
}

/**
 * The loss intervals of a stream, in stream time: `[windowStart, at(first)]`
 * when the first stored `seq` is above 1 (the registry trimmed the head —
 * always `lost`), `[min(at(prev), at(next)), max(…)]` for each interior `seq`
 * gap (`elided` when the gap lies inside a range the live transport reported,
 * `lost` otherwise), and every `spans_dropped` note's own `from`/`to` (`lost`).
 * `replay_note` markers are never consulted. Events without `at` contribute no
 * interval.
 */
export function lossesFromStream(
  events: readonly RunEvent[],
  opts: { windowStart?: number; elided?: readonly ElidedRange[] } = {},
): LossInterval[] {
  const tracker = createLossTracker();
  for (const e of events) tracker.push(e);
  return tracker.losses(opts);
}

export interface LossTracker {
  /** One more event of the stream, in order. */
  push(event: RunEvent): void;
  /** The loss intervals so far, for the window's start and the ranges the live
   *  transport has reported by now. O(gaps), never a rescan of the stream. */
  losses(opts?: { windowStart?: number; elided?: readonly ElidedRange[] }): LossInterval[];
}

/** The incremental form of `lossesFromStream`: a live page pushes each frame
 *  as it arrives and reads the intervals per tick without holding the stream.
 *  Kept per event: the first event's `seq` and stamp (the head loss), each
 *  interior `seq` gap with the stamps around it (its kind decided at read time,
 *  since the `replay_elided` range that covers a gap can arrive after it), and
 *  every `spans_dropped` note's own interval — in stream order. */
export function createLossTracker(): LossTracker {
  let first: { seq: number; at: number | undefined } | undefined;
  let prev: { seq: number | undefined; at: number | undefined } | undefined;
  const entries: Array<
    | { kind: "gap"; fromSeq: number; toSeq: number; from: number; to: number }
    | { kind: "note"; from: number; to: number }
  > = [];
  return {
    push(e) {
      if (!first) {
        first = { seq: e.seq ?? 1, at: e.at };
      } else if (prev && e.seq !== undefined && prev.seq !== undefined && e.seq > prev.seq + 1) {
        if (prev.at !== undefined && e.at !== undefined) {
          entries.push({
            kind: "gap",
            fromSeq: prev.seq + 1,
            toSeq: e.seq - 1,
            from: Math.min(prev.at, e.at),
            to: Math.max(prev.at, e.at),
          });
        }
      }
      if (
        e.type === "run_note" &&
        e.kind === "spans_dropped" &&
        e.from !== undefined &&
        e.to !== undefined &&
        e.to >= e.from
      ) {
        entries.push({ kind: "note", from: e.from, to: e.to });
      }
      prev = { seq: e.seq, at: e.at };
    },
    losses(opts = {}) {
      const elided = opts.elided ?? [];
      const inElided = (from: number, to: number) => elided.some((r) => r.fromSeq <= from && to <= r.toSeq);
      const out: LossInterval[] = [];
      if (
        first &&
        first.seq > 1 &&
        opts.windowStart !== undefined &&
        first.at !== undefined &&
        first.at > opts.windowStart
      ) {
        out.push({ from: opts.windowStart, to: first.at, kind: "lost" });
      }
      for (const g of entries) {
        out.push(
          g.kind === "note"
            ? { from: g.from, to: g.to, kind: "lost" }
            : { from: g.from, to: g.to, kind: inElided(g.fromSeq, g.toSeq) ? "elided" : "lost" },
        );
      }
      return out;
    },
  };
}
