/** The one production `Tracer` (features/tracing.md).
 *
 *  Pinned semantics, each with a test:
 *  - `span(fn)` invokes `fn` synchronously and ends the child in `finally`:
 *    `ok` on return, `error` and rethrow on throw;
 *  - `end()` is idempotent; `startedAt` may backdate a span created after the
 *    fact; a child started after its parent ended is a late child, recorded
 *    with true times (the stream sink is what refuses it);
 *  - a throwing sink never reaches traced code;
 *  - names are sanitized to `[a-z0-9_.-]`, 64 chars, with the MCP bridge's
 *    hash-suffix rule for a cut name;
 *  - a failure with a classification records kind and code and no message; an
 *    unclassified one records its message redacted and capped at 200. */
import { redactAndCap } from "../redact.js";
import type { SpanAttrs } from "./attrs.js";
import { classificationOf } from "./classify.js";
import { identityContext } from "./context.js";
import { newSpanId, newTraceId } from "./ids.js";
import type {
  Clock,
  RootOptions,
  Span,
  SpanContext,
  SpanOptions,
  SpanRecord,
  SpanSink,
  SpanStatus,
  Tracer,
} from "./types.js";

export const SPAN_NAME_MAX = 64;
export const ERROR_MESSAGE_CAP = 200;

/** Lowercase `[a-z0-9_.-]`, at most 64 chars. A longer name keeps its head and
 *  ends in `-<8 hex>` of the full name, so two long names never collide into
 *  one (the same rule the MCP bridge applies to tool names). */
export function sanitizeSpanName(raw: string): string {
  const clean =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "_")
      .replace(/^[_.-]+|[_.-]+$/g, "") || "span";
  if (clean.length <= SPAN_NAME_MAX) return clean;
  return `${clean.slice(0, SPAN_NAME_MAX - 9)}-${fnv1a(raw)}`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface TracerOptions {
  clock: Clock;
  context?: SpanContext;
  /** Where a sink's own failure is reported; never rethrown into traced code. */
  warn?: (message: string) => void;
}

export function createTracer(opts: TracerOptions): Tracer {
  const context = opts.context ?? identityContext;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const shared: Shared = { clock: opts.clock, context, warn };
  return {
    clock: opts.clock,
    start(name, root: RootOptions) {
      const span = new SpanImpl(shared, {
        traceId: newTraceId(),
        parentId: undefined,
        name,
        sinks: root.sinks,
        startedAt: root.startedAt,
        attrs: root.attrs,
      });
      span.emitStart();
      return span;
    },
  };
}

interface Shared {
  clock: Clock;
  context: SpanContext;
  warn: (message: string) => void;
}

interface SpanInit {
  traceId: string;
  parentId: string | undefined;
  name: string;
  sinks: SpanSink[];
  startedAt: number | undefined;
  attrs: SpanAttrs | undefined;
}

class SpanImpl implements Span {
  readonly id = newSpanId();
  readonly traceId: string;
  readonly name: string;
  readonly parentId: string | undefined;
  ended = false;
  private readonly sinks: SpanSink[];
  private readonly rec: SpanRecord;

  constructor(
    private readonly shared: Shared,
    init: SpanInit,
  ) {
    this.traceId = init.traceId;
    this.parentId = init.parentId;
    this.name = sanitizeSpanName(init.name);
    this.sinks = init.sinks;
    this.rec = {
      traceId: this.traceId,
      spanId: this.id,
      ...(init.parentId ? { parentSpanId: init.parentId } : {}),
      name: this.name,
      startedAt: init.startedAt ?? shared.clock(),
      attrs: { ...(init.attrs ?? {}) },
    };
  }

  emitStart(): void {
    for (const s of this.sinks) {
      try {
        s.onStart?.(this.record());
      } catch (err) {
        this.shared.warn(
          `[trace] sink onStart threw for ${this.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async span<T>(name: string, fn: (span: Span) => Promise<T> | T, opts?: SpanOptions): Promise<T> {
    const child = this.start(name, opts);
    try {
      // `fn` is invoked synchronously here (the async wrapper only defers what
      // follows the first await inside `fn`), so a caller's ordering holds.
      const result = await this.shared.context.run(child, () => fn(child));
      child.end("ok");
      return result;
    } catch (err) {
      child.fail(err);
      child.end("error");
      throw err;
    }
  }

  start(name: string, opts?: SpanOptions): Span {
    const child = new SpanImpl(this.shared, {
      traceId: this.traceId,
      parentId: this.id,
      name,
      sinks: this.sinks,
      startedAt: opts?.startedAt,
      attrs: opts?.attrs,
    });
    child.emitStart();
    return child;
  }

  end(status?: SpanStatus, attrs?: SpanAttrs): void {
    if (this.ended) return;
    this.ended = true;
    if (attrs) this.setAttrs(attrs);
    const endedAt = this.shared.clock();
    this.rec.endedAt = endedAt;
    this.rec.durationMs = Math.max(0, endedAt - this.rec.startedAt);
    this.rec.status = status ?? this.rec.status ?? "ok";
    for (const s of this.sinks) {
      try {
        s.onEnd(this.record());
      } catch (err) {
        this.shared.warn(
          `[trace] sink onEnd threw for ${this.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  fail(err: unknown): void {
    this.rec.status = "error";
    const c = classificationOf(err);
    if (c) {
      this.rec.errorKind = c.kind;
      if (c.code !== undefined) this.rec.errorCode = c.code;
      delete this.rec.errorMessage;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.rec.errorMessage = redactAndCap(message, ERROR_MESSAGE_CAP);
  }

  setAttrs(attrs: SpanAttrs): void {
    (this.rec as { attrs: SpanAttrs }).attrs = { ...this.rec.attrs, ...attrs };
  }

  record(): SpanRecord {
    return { ...this.rec, attrs: { ...this.rec.attrs } };
  }
}
