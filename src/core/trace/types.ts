/** The one measurement primitive (features/tracing.md).
 *
 *  A span is one unit of work with a start, an end, a name and a parent. A root
 *  has no parent; one root per message. Every awaited step Switchboard takes
 *  runs inside `span(fn)` (Execute Around Method), so the timeline of a run is a
 *  side effect of the code's shape, never a second bookkeeping.
 *
 *  Node-free, no I/O: the Workers import this by relative path. */
import type { SpanAttrs } from "./attrs.js";

/** The only way production code reads the time: injected, never `Date.now()`
 *  (features/tracing.md, the clock ratchet). */
export type Clock = () => number;

export type SpanStatus = "ok" | "error";

/** Our classification of a failure. The peer's own discriminator, where one
 *  exists, rides beside it as `errorCode`; free text never does for a span whose
 *  error came from a remote body (see `classify.ts`). */
export type ErrorKind = "timeout" | "transport" | "http" | "refused" | "infra" | "other";

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status?: SpanStatus;
  errorKind?: ErrorKind;
  errorCode?: string;
  /** Redacted and capped; absent whenever the error carries a classification. */
  errorMessage?: string;
  attrs: SpanAttrs;
}

/** Observer of span starts and ends (Observer). Sinks are attached to a root
 *  and inherited by its whole subtree; a throwing sink never reaches traced
 *  code. */
export interface SpanSink {
  onStart?(span: SpanRecord): void;
  onEnd(span: SpanRecord): void;
}

/** The seam the no-gaps test enters through (Strategy): production is the
 *  identity, so the primitive stays free of `node:async_hooks`; the test wraps
 *  `fn` in an `AsyncLocalStorage.run`, so a bare await outside any `span(fn)`
 *  records no current span. */
export interface SpanContext {
  run<T>(span: Span, fn: () => T): T;
}

export interface SpanOptions {
  attrs?: SpanAttrs;
  /** Backdate a span created after the fact (a grafted step, a late measure). */
  startedAt?: number;
}

export interface Span {
  readonly id: string;
  readonly traceId: string;
  readonly name: string;
  readonly parentId: string | undefined;
  readonly ended: boolean;
  /** Execute Around Method: start a child, run `fn` inside it (invoked
   *  synchronously), end it when `fn` settles — `ok` on return, `error` (and
   *  rethrow) on throw. The one way to time an awaited step. */
  span<T>(name: string, fn: (span: Span) => Promise<T> | T, opts?: SpanOptions): Promise<T>;
  /** A handle: a child kept across a suspension point and ended explicitly.
   *  The root is the only handle in the request path. */
  start(name: string, opts?: SpanOptions): Span;
  /** Idempotent. */
  end(status?: SpanStatus, attrs?: SpanAttrs): void;
  /** Record the failure's classification (or its redacted message) without
   *  ending the span. */
  fail(err: unknown): void;
  setAttrs(attrs: SpanAttrs): void;
  record(): SpanRecord;
}

export interface RootOptions {
  sinks: SpanSink[];
  startedAt?: number;
  attrs?: SpanAttrs;
}

/** The one production implementation is `createTracer`; the seams with two
 *  implementations are `SpanSink`, `Clock` and `SpanContext`. */
export interface Tracer {
  start(name: string, opts: RootOptions): Span;
  readonly clock: Clock;
}
