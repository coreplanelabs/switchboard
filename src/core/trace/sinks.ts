/** The process log sink and the Null Object sink (features/tracing.md).
 *
 *  A `LogSink` writes one JSON line per span end:
 *  `{"span","traceId","spanId","parentSpanId","startedAt","ms","status",
 *    "errorKind"?,"errorCode"?,"errorMessage"?,"attrs"}` — never text, summary
 *  or output; attrs are the validated bag the span carried. Verbosity:
 *  `roots` prints roots only (one or two lines per run), `slow` prints roots
 *  plus every span of `slowMs` or more. */
import type { SpanRecord, SpanSink } from "./types.js";

export type TracingLogLevel = "roots" | "slow";
export const TRACING_LOG_LEVELS: readonly TracingLogLevel[] = ["roots", "slow"];
export const SLOW_SPAN_MS = 1000;

export interface LogSinkOptions {
  level: TracingLogLevel;
  write: (line: string) => void;
  slowMs?: number;
}

export interface LogLine {
  span: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startedAt: number;
  ms: number;
  status: "ok" | "error";
  errorKind?: string;
  errorCode?: string;
  errorMessage?: string;
  attrs: Record<string, string | number | boolean>;
}

export function logLineOf(rec: SpanRecord): LogLine {
  return {
    span: rec.name,
    traceId: rec.traceId,
    spanId: rec.spanId,
    ...(rec.parentSpanId ? { parentSpanId: rec.parentSpanId } : {}),
    startedAt: rec.startedAt,
    ms: rec.durationMs ?? 0,
    status: rec.status ?? "ok",
    ...(rec.errorKind ? { errorKind: rec.errorKind } : {}),
    ...(rec.errorCode ? { errorCode: rec.errorCode } : {}),
    ...(rec.errorMessage ? { errorMessage: rec.errorMessage } : {}),
    attrs: Object.fromEntries(Object.entries(rec.attrs).filter(([, v]) => v !== undefined)) as LogLine["attrs"],
  };
}

export function createLogSink(opts: LogSinkOptions): SpanSink {
  const slowMs = opts.slowMs ?? SLOW_SPAN_MS;
  return {
    onEnd(rec) {
      const isRoot = rec.parentSpanId === undefined;
      if (!isRoot && (opts.level === "roots" || (rec.durationMs ?? 0) < slowMs)) return;
      opts.write(JSON.stringify(logLineOf(rec)));
    },
  };
}

/** A sink that observes nothing — what a request's stream and card sinks are
 *  until they are bound (Null Object). */
export const NULL_SINK: SpanSink = { onEnd: () => {} };
