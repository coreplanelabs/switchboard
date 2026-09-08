import { logLineOf, type LogLine } from "./sinks.js";
import type { SpanSink } from "./types.js";

// The bot's span log, kept in the process (features/tracing.md item 26): every
// span end this process's roots see, as the same line the log sink prints,
// in a bounded ring — so an operator can read what the container's stdout
// holds without reading the container's stdout, and at every level, not only
// what `tracing.log` prints. A line here is exactly a log line plus the moment
// the span ended; it never carries text, a body, a header or a credential
// (the log line's own shape test). Bounded by lines and bytes; the oldest
// go first and the reader is told how many did.

export interface SpanLogEntry extends LogLine {
  /** When the span ended: `startedAt + ms`. What `sinceMs` filters on. */
  endedAt: number;
}

export interface SpanLogQuery {
  /** Only spans that ended at or after this stamp (epoch ms). */
  sinceMs?: number;
  /** Only this trace. */
  traceId?: string;
  /** Only this span name, or the family under it (`github` matches `github.rest`). */
  span?: string;
  /** At most this many lines, the newest; default `SPAN_LOG_PAGE_DEFAULT`, capped at `SPAN_LOG_PAGE_MAX`. */
  limit?: number;
}

export interface SpanLogPage {
  /** Oldest first, the newest `limit` of what matched. */
  lines: SpanLogEntry[];
  /** How many lines matched the query before the limit. */
  matched: number;
  /** How many lines the ring holds. */
  kept: number;
  /** How many lines the ring has let go since the process started. */
  dropped: number;
  /** The oldest kept line's end stamp; absent while the ring is empty. */
  oldestAt?: number;
}

export interface SpanLog {
  /** The sink to put on every root this process starts. */
  readonly sink: SpanSink;
  read(query?: SpanLogQuery): SpanLogPage;
}

export const SPAN_LOG_MAX_LINES = 20_000;
export const SPAN_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const SPAN_LOG_PAGE_DEFAULT = 500;
export const SPAN_LOG_PAGE_MAX = 5_000;

export function createSpanLog(opts: { maxLines?: number; maxBytes?: number } = {}): SpanLog {
  const maxLines = opts.maxLines ?? SPAN_LOG_MAX_LINES;
  const maxBytes = opts.maxBytes ?? SPAN_LOG_MAX_BYTES;
  const entries: SpanLogEntry[] = [];
  const sizes: number[] = [];
  let bytes = 0;
  let dropped = 0;
  return {
    sink: {
      onEnd(rec) {
        const entry: SpanLogEntry = { ...logLineOf(rec), endedAt: rec.startedAt + (rec.durationMs ?? 0) };
        const size = JSON.stringify(entry).length;
        entries.push(entry);
        sizes.push(size);
        bytes += size;
        while (entries.length > 0 && (entries.length > maxLines || bytes > maxBytes)) {
          entries.shift();
          bytes -= sizes.shift() ?? 0;
          dropped++;
        }
      },
    },
    read(query = {}) {
      const limit = Math.min(SPAN_LOG_PAGE_MAX, Math.max(1, Math.floor(query.limit ?? SPAN_LOG_PAGE_DEFAULT)));
      const family = query.span === undefined ? undefined : `${query.span}.`;
      const matching = entries.filter(
        (e) =>
          (query.sinceMs === undefined || e.endedAt >= query.sinceMs) &&
          (query.traceId === undefined || e.traceId === query.traceId) &&
          (query.span === undefined || e.span === query.span || e.span.startsWith(family!)),
      );
      return {
        lines: matching.slice(-limit),
        matched: matching.length,
        kept: entries.length,
        dropped,
        ...(entries.length > 0 ? { oldestAt: entries[0]!.endedAt } : {}),
      };
    },
  };
}
