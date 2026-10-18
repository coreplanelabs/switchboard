import type { AppendableEvent } from "./types.js";

/** One review artifact may use the existing 1.5 MiB record budget. */
export const LIVE_EVENT_PAGE_BYTES = 2 * 1024 * 1024;
export const LIVE_EVENT_PAGE_ROWS = 128;

/** A read consistency witness, never execution or source authority. */
export interface LiveEventSnapshot {
  version: number;
  through: number;
  ownerGen: string | null;
  phase: string | null;
  startedAt: number | null;
}
export interface LiveEventPage {
  events: AppendableEvent[];
  snapshot: LiveEventSnapshot;
  readThrough: number;
  nextAfterSeq?: number;
}
export function liveEventSnapshotOf(value: unknown): LiveEventSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => !["version", "through", "ownerGen", "phase", "startedAt"].includes(key)) ||
    !Number.isSafeInteger(v.version) ||
    Number(v.version) < 0 ||
    !Number.isSafeInteger(v.through) ||
    Number(v.through) < 0 ||
    (v.ownerGen !== null && typeof v.ownerGen !== "string") ||
    (v.phase !== null && typeof v.phase !== "string") ||
    (v.startedAt !== null && (typeof v.startedAt !== "number" || !Number.isFinite(v.startedAt)))
  )
    return;
  return v as unknown as LiveEventSnapshot;
}
export function sameLiveEventSnapshot(a: LiveEventSnapshot, b: LiveEventSnapshot): boolean {
  return (
    a.version === b.version &&
    a.through === b.through &&
    a.ownerGen === b.ownerGen &&
    a.phase === b.phase &&
    a.startedAt === b.startedAt
  );
}
