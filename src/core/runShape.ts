import { isInformative, partition, printedShape, type LossInterval, type Window } from "./trace/partition.js";
import type { RunOwner } from "./trace/streamSpans.js";
import type { SpanRecord } from "./trace/types.js";
import { formatDuration } from "./time/formatDuration.js";

// The shape line (features/tracing.md item 5): the window partitioned into its
// buckets and printed as `32s getting ready · 2m 30s thinking · 55s in tools ·
// 8s finishing up · 7s Switchboard overhead` — the residual last, no repeated
// total, every non-zero bucket, the printed items summing to the printed total.
// One vocabulary for the card, the page and the friction report.

export interface ShapeInput {
  window: Window;
  owner: RunOwner;
  finished: boolean;
  losses?: readonly LossInterval[];
}

/** The shape line, or nothing when fewer than two buckets are informative
 *  (the caller then says the total and nothing more). */
export function shapeLine(spans: readonly SpanRecord[], input: ShapeInput): string | undefined {
  const p = partition(spans, { ...input, losses: input.losses ?? [] });
  if (!isInformative(p)) return undefined;
  const printed = printedShape(p);
  if (printed.items.length === 0) return undefined;
  return printed.items.map(({ term, s }) => `${formatDuration(s * 1000, "clock")} ${term}`).join(" · ");
}

/** The Slack card's own gate on top of the informativeness rule: the shape is
 *  worth a line when the run took a minute or more, or getting ready alone took
 *  15 s or more (features/tracing.md — the card's size threshold). */
export function cardShapeLine(spans: readonly SpanRecord[], input: ShapeInput): string | undefined {
  const windowMs = input.window.end - input.window.start;
  const p = partition(spans, { ...input, losses: input.losses ?? [] });
  if (windowMs < 60_000 && p.gettingReadyMs < 15_000) return undefined;
  return shapeLine(spans, input);
}

/** The queued captions, never part of a duration (features/tracing.md): shown
 *  from a minute of waiting. */
export function queuedCaption(kind: "before" | "behind", ms: number | undefined): string | undefined {
  if (ms === undefined || ms < 60_000) return undefined;
  const d = formatDuration(ms, "clock");
  return kind === "before" ? `queued ${d} before we saw it` : `queued ${d} behind the previous run`;
}
