import type { LiveRunRow, StepRecord } from "./types.js";
import { MAX_RECORD_BYTES } from "../runRecord.js";

/** Private cursor custody, outside the nonnegative public step namespace. */
export const INBOX_SEGMENT_ARCHIVE_STEP = -1;

interface Closure {
  owner: {
    runId: string;
    gen: string;
    channelId?: string;
    threadKey: string;
    requester?: string;
    startedAt: number;
  };
  lastStep: StepRecord | null;
  highWater: number;
  undelivered: boolean;
}

interface InboxSegmentArchive {
  version: 1;
  kind: "closed-inbox-segment";
  first: Closure;
  latest: Closure;
  heldThrough: number;
}

export type StepHistory = StepRecord[] & { inboxSegmentArchive?: unknown };

function closureOf(value: unknown): Closure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const c = value as Closure;
  if (!c.owner || typeof c.owner !== "object") return;
  if (![c.owner.runId, c.owner.gen, c.owner.threadKey].every((v) => typeof v === "string" && v.length > 0)) return;
  // Plane-born attaching rows can precede resolved route/principal metadata.
  // Preserve that absence; it is never repaired from request text.
  if ([c.owner.channelId, c.owner.requester].some((v) => v !== undefined && typeof v !== "string")) return;
  if (
    !Number.isFinite(c.owner.startedAt) ||
    !Number.isSafeInteger(c.highWater) ||
    c.highWater < 0 ||
    typeof c.undelivered !== "boolean"
  )
    return;
  if (c.lastStep !== null) {
    const s = c.lastStep;
    if (!s || typeof s !== "object" || Array.isArray(s)) return;
    if ((s as unknown as { version?: unknown }).version !== undefined) return;
    if (
      ["step", "seq", "turnIndex", "inboxConsumedSeq", "remainingMs", "turn", "iteration"].some(
        (k) => !Number.isFinite(s[k as keyof StepRecord]) || Number(s[k as keyof StepRecord]) < 0,
      )
    )
      return;
    if (
      !Array.isArray(s.inFlight) ||
      (s.inboxDeferredSeqs !== undefined &&
        (!Array.isArray(s.inboxDeferredSeqs) ||
          s.inboxDeferredSeqs.some((seq) => !Number.isSafeInteger(seq) || seq <= 0)))
    )
      return;
  }
  if (c.undelivered && c.lastStep !== null) return;
  return c;
}

function archiveOf(value: unknown): InboxSegmentArchive | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const a = value as InboxSegmentArchive;
  if (a.version !== 1 || a.kind !== "closed-inbox-segment" || !closureOf(a.first) || !closureOf(a.latest)) return;
  if (!Number.isSafeInteger(a.heldThrough) || a.heldThrough < 0 || a.heldThrough > a.latest.highWater) return;
  return a;
}

function belongs(closure: Closure, row: LiveRunRow): boolean {
  return (
    closure.owner.runId === row.runId &&
    closure.owner.threadKey === row.threadKey &&
    closure.owner.channelId === row.meta.channelId &&
    closure.owner.requester === row.meta.userId &&
    closure.owner.startedAt === row.startedAt
  );
}

/** Undefined is an unreadable or foreign archive: offer no new eligibility. */
export function inboxSegmentFloor(value: unknown, row: LiveRunRow): number | undefined {
  if (value === undefined) return 0;
  const archive = archiveOf(value);
  if (!archive || !belongs(archive.first, row) || !belongs(archive.latest, row)) return;
  try {
    if (new TextEncoder().encode(JSON.stringify(archive)).byteLength > MAX_RECORD_BYTES) return;
  } catch {
    return;
  }
  return archive.heldThrough;
}

/** The first boundary stays original; the latest and floor fold subsequent
 * closures without nesting an execution history or claiming consumption. */
export function closeInboxSegment(
  previous: unknown,
  row: LiveRunRow,
  lastStep: StepRecord | null,
  highWater: number,
): unknown {
  const prior = previous === undefined ? undefined : archiveOf(previous);
  if (previous !== undefined && (!prior || !belongs(prior.first, row) || !belongs(prior.latest, row))) return previous;
  const latest: Closure = {
    owner: {
      runId: row.runId,
      gen: row.ownerGen,
      channelId: row.meta.channelId,
      threadKey: row.threadKey,
      requester: row.meta.userId,
      startedAt: row.startedAt,
    },
    lastStep: lastStep === null ? null : structuredClone(lastStep),
    highWater,
    undelivered: row.phase === "attaching" && lastStep === null,
  };
  return {
    version: 1,
    kind: "closed-inbox-segment",
    first: prior?.first ?? latest,
    latest,
    heldThrough: Math.max(prior?.heldThrough ?? 0, latest.undelivered ? 0 : highWater),
  } satisfies InboxSegmentArchive;
}

/** The carrier uses the existing private record ceiling. Reject before
 * cleanup; its original cursor and inbox stay in their existing rows. */
export function encodeInboxSegment(value: unknown, maxBytes: number): string {
  if (!archiveOf(value)) throw new Error("retained inbox segment boundary is unreadable");
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > maxBytes)
    throw new Error("retained inbox segment boundary exceeds the private record byte limit");
  return json;
}
