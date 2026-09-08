/** The one sink that turns streamed spans into run-stream events
 *  (docs/reference/specs/tracing.md, Sink scoping).
 *
 *  Attached to a request's root before any run exists, it retains every
 *  streamed start and end in one bounded, append-only buffer for the root's
 *  lifetime. `bindRun` gives a run a cursor at the buffer's head, delivers
 *  everything past it (each delivery a fresh object; the registry stamps the
 *  run's own `seq`), publishes one counted `spans_dropped` note when events
 *  before the cursor were dropped, then routes live events to that run. A
 *  rebind (the natural-language fall-through) is normal; a rebind while a
 *  binding is still active releases it with one warning; anything after the
 *  root ended is dropped with one warning — the log sink still records it. */
import type { SpanAttrs } from "./attrs.js";
import { isStreamed } from "./streamSpans.js";
import type { SpanRecord, SpanSink } from "./types.js";

export interface SpanStartEvent {
  type: "span_start";
  spanId: string;
  parentSpanId?: string;
  name: string;
  attrs?: SpanAttrs;
  at: number;
}

export interface SpanEndEvent {
  type: "span_end";
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: number;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
  attrs?: SpanAttrs;
  at: number;
}

export interface SpansDroppedNote {
  type: "run_note";
  kind: "spans_dropped";
  summary: string;
  from: number;
  to: number;
  at: number;
}

export type SpanStreamEvent = SpanStartEvent | SpanEndEvent | SpansDroppedNote;

export interface RunStreamSink extends SpanSink {
  /** Point the sink at a run: backfill the retained events, then route live. */
  bindRun(runId: string, publish: (event: SpanStreamEvent) => void): void;
  /** The run currently bound, if any. */
  readonly boundRunId: string | undefined;
}

/** The buffer bound, sized against the worst pre-bind case (about 16 setup
 *  pairs, a 64-step attach graft and a ship preflight — about 200 events) so
 *  `spans_dropped` never appears on an ordinary run. */
export const BUFFER_MAX_EVENTS = 512;
export const BUFFER_MAX_BYTES = 256 * 1024;
/** The first events are never dropped: the root's start and the setup steps. */
export const BUFFER_PROTECTED_HEAD = 64;

export interface RunStreamSinkOptions {
  clock: () => number;
  warn?: (message: string) => void;
}

export function createRunStreamSink(opts: RunStreamSinkOptions): RunStreamSink {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const buffer: Array<{ event: SpanStreamEvent; bytes: number }> = [];
  let bufferBytes = 0;
  let dropped: { count: number; from: number; to: number } | undefined;
  let rootId: string | undefined;
  let rootEnded = false;
  let warnedAfterRoot = false;
  const ended = new Set<string>();
  let binding: { runId: string; publish: (e: SpanStreamEvent) => void } | undefined;

  const retain = (event: SpanStreamEvent): void => {
    const bytes = JSON.stringify(event).length;
    buffer.push({ event, bytes });
    bufferBytes += bytes;
    while (buffer.length > BUFFER_MAX_EVENTS || bufferBytes > BUFFER_MAX_BYTES) {
      if (buffer.length <= BUFFER_PROTECTED_HEAD + 1) break;
      // Drop from the middle: the oldest unprotected entry, keeping the newest.
      const [victim] = buffer.splice(BUFFER_PROTECTED_HEAD, 1);
      bufferBytes -= victim.bytes;
      dropped = dropped
        ? {
            count: dropped.count + 1,
            from: Math.min(dropped.from, victim.event.at),
            to: Math.max(dropped.to, victim.event.at),
          }
        : { count: 1, from: victim.event.at, to: victim.event.at };
    }
  };

  const emit = (event: SpanStreamEvent): void => {
    retain(event);
    if (binding) binding.publish({ ...event });
  };

  const accept = (rec: SpanRecord): boolean => {
    // Log-only spans are never the stream's business, before or after the root
    // ends — so they can never spend the one after-root warning.
    if (!isStreamed(rec.name)) return false;
    if (rootEnded) {
      if (!warnedAfterRoot) {
        warnedAfterRoot = true;
        warn(`[trace] span ${rec.name} reached the run stream after its root ended; dropped (the log sink keeps it)`);
      }
      return false;
    }
    // A late child (its parent already ended) is recorded, never streamed.
    if (rec.parentSpanId && ended.has(rec.parentSpanId)) return false;
    return true;
  };

  return {
    get boundRunId() {
      return binding?.runId;
    },
    onStart(rec) {
      if (rootId === undefined && rec.parentSpanId === undefined) rootId = rec.spanId;
      if (!accept(rec)) return;
      emit({
        type: "span_start",
        spanId: rec.spanId,
        ...(rec.parentSpanId ? { parentSpanId: rec.parentSpanId } : {}),
        name: rec.name,
        ...(Object.keys(rec.attrs).length > 0 ? { attrs: rec.attrs } : {}),
        at: rec.startedAt,
      });
    },
    onEnd(rec) {
      const isRoot = rec.spanId === rootId;
      const ok = accept(rec);
      ended.add(rec.spanId);
      if (ok) {
        emit({
          type: "span_end",
          spanId: rec.spanId,
          ...(rec.parentSpanId ? { parentSpanId: rec.parentSpanId } : {}),
          name: rec.name,
          startedAt: rec.startedAt,
          durationMs: rec.durationMs ?? 0,
          status: rec.status ?? "ok",
          ...(rec.errorMessage ? { error: rec.errorMessage } : {}),
          ...(Object.keys(rec.attrs).length > 0 ? { attrs: rec.attrs } : {}),
          at: rec.endedAt ?? rec.startedAt,
        });
      }
      if (isRoot) rootEnded = true;
    },
    bindRun(runId, publish) {
      if (rootEnded) {
        warn(`[trace] bindRun(${runId}) after the root ended is a no-op`);
        return;
      }
      if (binding) warn(`[trace] run ${binding.runId} was still bound when ${runId} bound; released`);
      binding = { runId, publish };
      for (const { event } of buffer) publish({ ...event });
      if (dropped) {
        publish({
          type: "run_note",
          kind: "spans_dropped",
          summary: `${dropped.count} setup steps not recorded`,
          from: dropped.from,
          to: dropped.to,
          at: opts.clock(),
        });
      }
    },
  };
}
