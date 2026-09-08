import type { SpanRecord, SpanSink } from "../trace/types.js";

/** Test double: a sink that keeps every start and end it saw. */
export interface RecordingSink extends SpanSink {
  readonly starts: SpanRecord[];
  readonly ends: SpanRecord[];
  /** The ended record of the span named `name` (the first, when several). */
  ended(name: string): SpanRecord | undefined;
}

export function recordingSink(): RecordingSink {
  const starts: SpanRecord[] = [];
  const ends: SpanRecord[] = [];
  return {
    starts,
    ends,
    onStart: (s) => {
      starts.push(s);
    },
    onEnd: (s) => {
      ends.push(s);
    },
    ended: (name) => ends.find((e) => e.name === name),
  };
}
