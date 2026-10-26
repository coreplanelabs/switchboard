import { SOURCE_EVENT_STORE_MAX_BYTES, SOURCE_JOB_MAX_ATTEMPTS, SOURCE_RELEVANCE_MAX_CONTEXTS } from "../budgets.js";
import { isContextDependencies, type ContextDependencies } from "../references/contextDependencies.js";
import {
  sourceInputIdentity,
  sourceInputReferenceOf,
  type SourceInputReference,
} from "../references/sourceInputReference.js";
import {
  isSourceEventKey,
  sourceSnapshot,
  sourceEventJobOf,
  type ReceivedSourceEventJob,
  type ClaimedSourceEventJob,
} from "./sourceEvents.js";
import { custodyPinRevisionOf, type CustodyPinRevision } from "./custodyPinRevision.js";
import type { SessionRangePin, SessionRangePins } from "./sessionRangePins.js";
import { contextReferencesOf, type ContextReference } from "./contextRetention.js";

export const SOURCE_OBLIGATION_HOLDER_PREFIX = "@source-obligation:";
const PREFIX = SOURCE_OBLIGATION_HOLDER_PREFIX;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export interface SourceObligation {
  reference: SourceInputReference;
  context: ContextDependencies;
  state: "pending" | "uncertain" | "expired";
  automaticUntil: number;
  /** Includes metadata, protection receipts and the bounded future settlement. */
  reservedBytes: number;
  settlementMaxBytes: number;
  protections: readonly {
    sessionKey: string;
    ranges: readonly SessionRangePin[];
    receipt?: CustodyPinRevision;
  }[];
}

/** Reader-first format only. No production writer creates this frame yet.
 * Waiting and expiry retain evidence; neither is an operational retry or ACK. */
export interface SourceObligationJob {
  version: 4;
  eventKey: string;
  stage: "received";
  state: "waiting";
  /** Retained queue provenance, not a current execution or source grant. */
  prior: ReceivedSourceEventJob | ClaimedSourceEventJob;
  attempts: number;
  nextAttemptAt: number | null;
  obligations: readonly SourceObligation[];
}

export function sourceObligationHolder(reference: SourceInputReference): string {
  return `${PREFIX}${sourceInputIdentity(reference)}`;
}

export function sourceObligationHolderOf(
  value: unknown,
): { rootRunId: string; eventKey: string; kind: "notice" | "fold"; decisionId: string | null } | undefined {
  if (typeof value !== "string" || !value.startsWith(PREFIX) || value.length > 2048) return;
  try {
    const raw: unknown = JSON.parse(value.slice(PREFIX.length));
    if (!Array.isArray(raw) || raw.length !== 4 || JSON.stringify(raw) !== value.slice(PREFIX.length)) return;
    const [rootRunId, eventKey, kind, decisionId] = raw;
    if (typeof rootRunId !== "string" || !rootRunId || rootRunId.length > 256 || !isSourceEventKey(eventKey)) return;
    if (kind === "notice" && decisionId === null) return { rootRunId, eventKey, kind, decisionId };
    if (kind !== "fold" || typeof decisionId !== "string" || decisionId.length > 512) return;
    const decision: unknown = JSON.parse(decisionId);
    if (
      !Array.isArray(decision) ||
      decision.length !== 2 ||
      decision[0] !== rootRunId ||
      typeof decision[1] !== "string" ||
      !decision[1] ||
      decision[1].length > 256
    )
      return;
    return { rootRunId, eventKey, kind, decisionId };
  } catch {
    return;
  }
}

export function sourceObligationJobOf(value: unknown): SourceObligationJob | undefined {
  try {
    const v = sourceSnapshot(value);
    if (
      !object(v) ||
      !closed(v, ["version", "eventKey", "stage", "state", "prior", "attempts", "nextAttemptAt", "obligations"]) ||
      v.version !== 4 ||
      !isSourceEventKey(v.eventKey) ||
      v.stage !== "received" ||
      v.state !== "waiting" ||
      !natural(v.attempts) ||
      v.attempts > SOURCE_JOB_MAX_ATTEMPTS ||
      !Array.isArray(v.obligations) ||
      !v.obligations.length ||
      v.obligations.length > SOURCE_RELEVANCE_MAX_CONTEXTS * (SOURCE_RELEVANCE_MAX_CONTEXTS + 1)
    )
      return;
    if (!object(v.prior) || ![1, 2, 3].includes(Number(v.prior.version))) return;
    const prior = sourceEventJobOf(v.prior);
    if (!prior || prior.version === 4 || prior.eventKey !== v.eventKey || prior.attempts !== v.attempts) return;
    const obligations: SourceObligation[] = [],
      identities = new Set<string>(),
      roots = new Map<string, number>(),
      rootCoordinates = new Map<string, string>();
    for (const raw of v.obligations) {
      if (
        !object(raw) ||
        !closed(raw, [
          "reference",
          "context",
          "state",
          "automaticUntil",
          "reservedBytes",
          "settlementMaxBytes",
          "protections",
        ])
      )
        return;
      const reference = sourceInputReferenceOf(raw.reference),
        context = raw.context;
      if (
        !reference ||
        reference.receipt.key !== v.eventKey ||
        !isContextDependencies(context) ||
        context.status !== "known" ||
        (raw.state !== "pending" && raw.state !== "uncertain" && raw.state !== "expired") ||
        !natural(raw.automaticUntil) ||
        raw.automaticUntil < reference.receipt.receivedAt ||
        !natural(raw.reservedBytes) ||
        !natural(raw.settlementMaxBytes) ||
        raw.settlementMaxBytes === 0 ||
        raw.reservedBytes > SOURCE_EVENT_STORE_MAX_BYTES ||
        bytes(raw) + raw.settlementMaxBytes > raw.reservedBytes ||
        !Array.isArray(raw.protections) ||
        raw.protections.length > 32
      )
        return;
      const protections: SourceObligation["protections"][number][] = [];
      for (const protection of raw.protections) {
        if (
          !object(protection) ||
          !closed(protection, ["sessionKey", "ranges", "receipt"]) ||
          typeof protection.sessionKey !== "string" ||
          !protection.sessionKey ||
          protection.sessionKey.length > 2048 ||
          !Array.isArray(protection.ranges) ||
          !protection.ranges.length ||
          protection.ranges.length > 32 ||
          protection.ranges.some(
            (range) =>
              !object(range) ||
              !closed(range, ["from", "to"]) ||
              !natural(range.from) ||
              !natural(range.to) ||
              range.to < range.from,
          ) ||
          (protection.receipt !== undefined && custodyPinRevisionOf(protection.receipt)?.guarded !== true)
        )
          return;
        const ranges: SessionRangePin[] = [];
        for (const range of protection.ranges) {
          if (!object(range) || !natural(range.from) || !natural(range.to)) return;
          ranges.push({ from: range.from, to: range.to });
        }
        const receipt = protection.receipt === undefined ? undefined : custodyPinRevisionOf(protection.receipt);
        protections.push({ sessionKey: protection.sessionKey, ranges, ...(receipt ? { receipt } : {}) });
      }
      if (obligations.length && JSON.stringify(reference.receipt) !== JSON.stringify(obligations[0]!.reference.receipt))
        return;
      const coordinates = JSON.stringify(reference.root),
        priorCoordinates = rootCoordinates.get(reference.root.runId);
      if (priorCoordinates !== undefined && priorCoordinates !== coordinates) return;
      rootCoordinates.set(reference.root.runId, coordinates);
      const identity = sourceInputIdentity(reference);
      const inherited = context.sourceInputs?.find((input) => sourceInputIdentity(input) === identity);
      if (inherited && JSON.stringify(inherited) !== JSON.stringify(reference)) return;
      if (identities.has(identity)) return;
      identities.add(identity);
      const folds = roots.get(reference.root.runId) ?? 0;
      roots.set(reference.root.runId, folds + (reference.routing.kind === "fold" ? 1 : 0));
      if (
        roots.size > SOURCE_RELEVANCE_MAX_CONTEXTS ||
        (roots.get(reference.root.runId) ?? 0) > SOURCE_RELEVANCE_MAX_CONTEXTS
      )
        return;
      obligations.push({
        reference,
        context,
        state: raw.state,
        automaticUntil: raw.automaticUntil,
        reservedBytes: raw.reservedBytes,
        settlementMaxBytes: raw.settlementMaxBytes,
        protections,
      });
    }
    const deadlines = obligations.filter((o) => o.state !== "expired").map((o) => o.automaticUntil);
    const next = deadlines.length ? Math.min(...deadlines) : null;
    if (
      v.nextAttemptAt !== next ||
      obligations.reduce((sum, o) => sum + o.reservedBytes, 0) > SOURCE_EVENT_STORE_MAX_BYTES
    )
      return;
    return {
      version: 4,
      eventKey: v.eventKey,
      stage: "received",
      state: "waiting",
      prior,
      attempts: v.attempts,
      nextAttemptAt: next,
      obligations,
    };
  } catch {
    return;
  }
}

export function sourceObligationContextReferences(job: SourceObligationJob): ContextReference[] {
  return job.obligations.flatMap((o) => {
    const holder = sourceObligationHolder(o.reference);
    return contextReferencesOf(holder, undefined, {
      ...o.context,
      version: 4,
      sourceInputs: [
        ...new Map(
          [...(o.context.sourceInputs ?? []), o.reference].map((input) => [sourceInputIdentity(input), input]),
        ).values(),
      ],
    });
  });
}

/** The later writer must persist this charge in source_events.bytes too so
 * supported older capacity readers cannot ignore a reservation. */
export function sourceEventStorageCharge(eventJson: string, rawJob: unknown, storedBytes: number): number {
  if (!natural(storedBytes)) return SOURCE_EVENT_STORE_MAX_BYTES;
  const eventBytes = new TextEncoder().encode(eventJson).byteLength;
  // Unknown job formats remain held by claimants. Their persisted charge is
  // authoritative unless they declare obligation metadata that we cannot read.
  if (
    !object(rawJob) ||
    typeof rawJob.version !== "number" ||
    rawJob.version < 4 ||
    (rawJob.version !== 4 && !("obligations" in rawJob))
  )
    return Math.max(storedBytes, eventBytes);
  const job = sourceObligationJobOf(rawJob);
  if (!job) return Math.max(storedBytes, SOURCE_EVENT_STORE_MAX_BYTES);
  const overhead = bytes(job) - job.obligations.reduce((sum, o) => sum + bytes(o), 0);
  return Math.max(storedBytes, eventBytes + overhead + job.obligations.reduce((sum, o) => sum + o.reservedBytes, 0));
}

/** Only a future verified transfer/release protocol can remove these pins.
 * A deadline or an incomplete canonical census is not that receipt. */
export function retainSourceObligationRangeHolders(pins: SessionRangePins, holders: readonly string[]): string[] {
  return [...new Set([...holders, ...Object.keys(pins).filter((holder) => holder.startsWith(PREFIX))])];
}
