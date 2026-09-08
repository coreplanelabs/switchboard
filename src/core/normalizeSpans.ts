import { isSpanRecord, type RunEvent, type SpanEndEvent, type SpanStartEvent } from "./runEvents.js";
import type { LossInterval } from "./trace/partition.js";
import type { SpanRecord } from "./trace/types.js";
import type { SpanAttrs } from "./trace/attrs.js";

// The one Adapter between a run stream and the span set the partition, the
// analyzer and the timeline read (features/tracing.md). A stream is either
// legacy (schema absent: `turn` and `mcp_tool_use` events carry the timing) or
// schema 2 (spans carry it); on either, a content pair whose twin span was
// dropped by the record budget still deserves a span. `normalizeSpans` adds a
// synthesized span for every content pair that lacks one and never touches a
// pair that has one, so it is idempotent and the identity on a complete
// schema-2 stream. `spansFromEvents` pairs the records into `SpanRecord`s and
// `lossesFromStream` derives the loss intervals from the `seq` gaps, the
// `spans_dropped` notes and the live transport's elided ranges.

/** The stream schema below which `turn`/`mcp_tool_use` are the timing record. */
export const SPAN_SCHEMA = 2;

export interface NormalizeOptions {
  /** The record's or seed's `schema`; absent (or below `SPAN_SCHEMA`) is legacy. */
  schema?: number;
}

/** A synthesized span's id: `synth:<callId>` for a call whose id is a plain
 *  token, else `synth:<content index>`. */
function synthId(callId: string | undefined, index: number): string {
  return callId !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(callId) ? `synth:${callId}` : `synth:${index}`;
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
 * Synthesize the spans a stream is missing. Returns a new array; the input is
 * never mutated. A synthesized `span_end` is placed right after the content
 * event that closes it (the `turn`, the `tool_result`, the `mcp_tool_use`), its
 * `span_start` right before the content event that opens it, so a per-event
 * fold sees them where the emitter would have put them.
 */
export function normalizeSpans(events: readonly RunEvent[], opts: NormalizeOptions = {}): RunEvent[] {
  const legacy = (opts.schema ?? 0) < SPAN_SCHEMA;
  const agents = agentSpans(events);

  // What already has a twin.
  const turnSpansAt: Array<{ start: number; end: number }> = [];
  const toolSpanCallIds = new Set<string>();
  const mcpSpanKeys = new Set<string>(); // `<server>.<tool>@<endedAt>`
  let hasModelTurnSpan = false;
  for (const e of events) {
    if (!isSpanRecord(e)) continue;
    const attrs = (e.attrs ?? {}) as Record<string, unknown>;
    if (e.name === "model.turn") {
      hasModelTurnSpan = true;
      if (e.type === "span_end") turnSpansAt.push({ start: e.startedAt, end: e.startedAt + e.durationMs });
    } else if (e.name.startsWith("tool.") && typeof attrs.callId === "string") {
      toolSpanCallIds.add(attrs.callId);
    } else if (e.name.startsWith("mcp.") && e.type === "span_end") {
      mcpSpanKeys.add(`${e.name.slice("mcp.".length)}@${e.startedAt + e.durationMs}`);
    }
  }
  const turnCovered = (at: number | undefined) =>
    at !== undefined && turnSpansAt.some((t) => t.start <= at && at <= t.end);

  const out: RunEvent[] = [];
  // A call's synthesized start, keyed by callId; a legacy call without one
  // queues under its tool, and its result closes the oldest open call of that
  // tool — the fold's own pairing rule.
  const openCalls = new Map<string, { spanId: string; index: number }>();
  const openByTool = new Map<string, Array<{ spanId: string; index: number }>>();
  const hasTurnEvents = events.some((e) => e.type === "turn");
  // The gap rule (legacy streams with no turn record at all): a model turn runs
  // from the previous `tool_result`/`input` to the next `tool_call`/`assistant`/`answer`.
  const gapRule = legacy && !hasTurnEvents && !hasModelTurnSpan;
  let gapStart: number | undefined;
  let gapIndex = 0;

  events.forEach((e, index) => {
    if (gapRule && e.type !== "context" && !isSpanRecord(e)) {
      if ((e.type === "tool_call" || e.type === "assistant" || e.type === "answer") && gapStart !== undefined) {
        const at = e.at;
        if (at !== undefined && at > gapStart) {
          const spanId = `synth:gap${gapIndex++}`;
          out.push(
            spanStart(spanId, "model.turn", gapStart, parentFor(agents, gapStart)),
            spanEnd(spanId, "model.turn", gapStart, at - gapStart, parentFor(agents, gapStart)),
          );
        }
        gapStart = undefined;
      }
      if ((e.type === "tool_result" || e.type === "input") && e.at !== undefined) gapStart = e.at;
    }

    switch (e.type) {
      case "turn": {
        if (turnCovered(e.at)) {
          out.push(e);
          return;
        }
        const spanId = `synth:${index}`;
        const parent = parentFor(agents, e.startedAt);
        const attrs: Record<string, string | number | boolean> = { stopReason: e.stopReason };
        if (typeof e.model === "string" && e.model) attrs.model = e.model;
        if (e.usage?.inputTokens !== undefined) attrs.inputTokens = e.usage.inputTokens;
        if (e.usage?.outputTokens !== undefined) attrs.outputTokens = e.usage.outputTokens;
        if (e.usage?.cacheReadTokens !== undefined) attrs.cacheReadTokens = e.usage.cacheReadTokens;
        if (e.usage?.cacheWriteTokens !== undefined) attrs.cacheWriteTokens = e.usage.cacheWriteTokens;
        out.push(spanStart(spanId, "model.turn", e.startedAt, parent), e);
        out.push(spanEnd(spanId, "model.turn", e.startedAt, e.durationMs, parent, attrs));
        return;
      }
      case "tool_call": {
        const callId = e.callId;
        if (callId !== undefined && toolSpanCallIds.has(callId)) {
          out.push(e);
          return;
        }
        const spanId = synthId(callId, index);
        const at = e.at ?? 0;
        out.push(spanStart(spanId, `tool.${e.tool}`, at, parentFor(agents, at), callId ? { callId } : undefined), e);
        if (callId !== undefined) openCalls.set(callId, { spanId, index });
        else openByTool.set(e.tool, [...(openByTool.get(e.tool) ?? []), { spanId, index }]);
        return;
      }
      case "tool_result": {
        out.push(e);
        let open: { spanId: string; index: number } | undefined;
        if (e.callId !== undefined) {
          open = openCalls.get(e.callId);
          if (open) openCalls.delete(e.callId);
        } else {
          open = openByTool.get(e.tool)?.shift();
        }
        if (!open) return; // a result whose call has a real twin (or no call at all): nothing to close
        const startedAt = startOf(events, open.index);
        const endedAt = e.at ?? startedAt;
        const attrs: Record<string, string | number | boolean> = { ok: e.ok };
        if (e.callId !== undefined) attrs.callId = e.callId;
        if (e.exitCode !== undefined) attrs.exitCode = e.exitCode;
        if (e.infra) attrs.infra = true;
        out.push(
          spanEnd(
            open.spanId,
            `tool.${e.tool}`,
            startedAt,
            Math.max(0, endedAt - startedAt),
            parentFor(agents, startedAt),
            attrs,
            e.ok ? "ok" : "error",
          ),
        );
        return;
      }
      case "mcp_tool_use": {
        const endedAt = e.at ?? 0;
        const key = `${e.server}.${e.tool}@${endedAt}`;
        out.push(e);
        if (mcpSpanKeys.has(key)) return;
        const spanId = `synth:${index}`;
        const startedAt = endedAt - e.durationMs;
        const name = `mcp.${e.server}.${e.tool}`;
        out.push(
          spanStart(spanId, name, startedAt, parentFor(agents, startedAt)),
          spanEnd(
            spanId,
            name,
            startedAt,
            e.durationMs,
            parentFor(agents, startedAt),
            { ok: e.ok, bytes: e.bytes },
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

function startOf(events: readonly RunEvent[], index: number): number {
  return events[index]?.at ?? 0;
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
  for (const e of events) {
    if (!isSpanRecord(e)) continue;
    const prior = byId.get(e.spanId);
    if (e.type === "span_start") {
      if (prior) continue; // an end already made the record
      byId.set(e.spanId, {
        traceId,
        spanId: e.spanId,
        ...(e.parentSpanId !== undefined ? { parentSpanId: e.parentSpanId } : {}),
        name: e.name,
        startedAt: e.at ?? 0,
        attrs: (e.attrs ?? {}) as SpanAttrs,
      });
      continue;
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
  return [...byId.values()];
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
  const out: LossInterval[] = [];
  const elided = opts.elided ?? [];
  const inElided = (from: number, to: number) => elided.some((r) => r.fromSeq <= from && to <= r.toSeq);
  let prev: RunEvent | undefined;
  let first = true;
  for (const e of events) {
    if (first) {
      first = false;
      if ((e.seq ?? 1) > 1 && opts.windowStart !== undefined && e.at !== undefined && e.at > opts.windowStart) {
        out.push({ from: opts.windowStart, to: e.at, kind: "lost" });
      }
    } else if (prev && e.seq !== undefined && prev.seq !== undefined && e.seq > prev.seq + 1) {
      if (prev.at !== undefined && e.at !== undefined) {
        const from = Math.min(prev.at, e.at);
        const to = Math.max(prev.at, e.at);
        out.push({ from, to, kind: inElided(prev.seq + 1, e.seq - 1) ? "elided" : "lost" });
      }
    }
    if (
      e.type === "run_note" &&
      e.kind === "spans_dropped" &&
      e.from !== undefined &&
      e.to !== undefined &&
      e.to >= e.from
    ) {
      out.push({ from: e.from, to: e.to, kind: "lost" });
    }
    prev = e;
  }
  return out;
}
