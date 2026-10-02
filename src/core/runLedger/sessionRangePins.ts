import type { ChildHandoff } from "../dispatch/handoff.js";
import type { TranscriptRow } from "./types.js";

export interface SessionRangePin {
  from: number;
  to: number;
}
export type SessionRangePins = Record<string, readonly SessionRangePin[]>;

export function handoffRangePins(handoff: ChildHandoff | undefined): Map<string, SessionRangePin[]> {
  const pins = new Map<string, SessionRangePin[]>();
  for (const source of handoff ? [handoff, ...(handoff.ancestors ?? [])] : []) {
    const { key, from, to } = source.session;
    if (to < from) continue;
    const ranges = pins.get(key) ?? [];
    ranges.push({ from, to });
    pins.set(key, ranges);
  }
  return pins;
}
export function sessionRowIsPinned(pins: SessionRangePins, idx: number): boolean {
  return Object.values(pins).some((ranges) => ranges.some((range) => idx >= range.from && idx <= range.to));
}
export function sessionRangesAvailable(
  rows: readonly (TranscriptRow & { trimmed?: number | boolean })[],
  ranges: readonly SessionRangePin[],
): boolean {
  return ranges.every(({ from, to }) => {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return false;
    const found = rows.filter((row) => row.idx >= from && row.idx <= to);
    return !found.some((row) => row.trimmed) && new Set(found.map((row) => row.idx)).size === to - from + 1;
  });
}
