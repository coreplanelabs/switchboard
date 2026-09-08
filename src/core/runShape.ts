import {
  isInformative,
  partition,
  printedShape,
  type LossInterval,
  type Partition,
  type Window,
} from "./trace/partition.js";
import type { RunOwner } from "./trace/streamSpans.js";
import type { SpanRecord } from "./trace/types.js";
import { formatDuration } from "./time/formatDuration.js";

// The shape line (docs/reference/specs/tracing.md item 5): the window partitioned into its
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

/** The line for a partition already computed (a diagnosis's `shape`), or
 *  nothing when fewer than two buckets are informative (the caller then says
 *  the total and nothing more). */
export function formatShape(p: Partition | Omit<Partition, "backgroundOnlyMs">): string | undefined {
  const full: Partition = { backgroundOnlyMs: 0, ...p };
  if (!isInformative(full)) return undefined;
  const printed = printedShape(full);
  if (printed.items.length === 0) return undefined;
  return printed.items.map(({ term, s }) => `${formatDuration(s * 1000, "clock")} ${term}`).join(" · ");
}

/** The shape line from a span set. */
export function shapeLine(spans: readonly SpanRecord[], input: ShapeInput): string | undefined {
  return formatShape(partition(spans, { ...input, losses: input.losses ?? [] }));
}

/** The Slack card's own gate on top of the informativeness rule: the shape is
 *  worth a line when the run took a minute or more, or getting ready alone took
 *  15 s or more (docs/reference/specs/tracing.md — the card's size threshold). */
export function cardShapeLineOf(p: Partition | Omit<Partition, "backgroundOnlyMs">): string | undefined {
  if (p.windowMs < 60_000 && p.gettingReadyMs < 15_000) return undefined;
  return formatShape(p);
}

/** The card's gated shape line from a span set (a close before any run existed). */
export function cardShapeLine(spans: readonly SpanRecord[], input: ShapeInput): string | undefined {
  return cardShapeLineOf(partition(spans, { ...input, losses: input.losses ?? [] }));
}

/** The queued captions, never part of a duration (docs/reference/specs/tracing.md): shown
 *  from a minute of waiting. */
export function queuedCaption(kind: "before" | "behind", ms: number | undefined): string | undefined {
  if (ms === undefined || ms < 60_000) return undefined;
  const d = formatDuration(ms, "clock");
  return kind === "before" ? `queued ${d} before we saw it` : `queued ${d} behind the previous run`;
}
