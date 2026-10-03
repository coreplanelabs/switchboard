// The sandbox Worker's preservation decision. No SDK, model process, host
// access or secrets: an owner must match every field before a receipt can say
// anything about an R2 backup. The Worker alone decides whether quiescence is
// proved; a model-supplied assertion is never a quiescence witness.
import { IDLE_DAYS_MAX } from "../core/budgets.js";

/** The SDK default is three days. A full Ship idle window plus seven days of
 * grace gives a resumed owner time to take a fresh checkpoint. R2 lifecycle
 * rules must independently retain the objects; an SDK TTL alone cannot. */
export const CHECKPOINT_TTL_SECONDS = (IDLE_DAYS_MAX + 7) * 24 * 60 * 60;
export const CHECKOUT_DIR = "/workspace/checkout";

export interface PreservationOwner {
  run: string;
  requester: string;
  thread: string;
  repository: string;
  ref: string;
  head: string;
  seed: string;
  container: string;
}

export type OwnerClaim = Omit<PreservationOwner, "container">;
export interface CheckpointRecord {
  owner: PreservationOwner;
  /** Bound at the owner's birth, never inferred from a later retry. Old rows have no origin. */
  doorOrigin?: string;
  backupId?: string;
}

/** The trusted seed env supplies an origin, not a URL carrying credentials,
 * path, query or fragment. Canonicalizing the host/port makes equivalent
 * spellings match without accepting a later change of destination. */
export function normalizedSeedDoorOrigin(input: unknown): string | null {
  if (typeof input !== "string" || !/^https:\/\/[^/?#\s]+\/?$/.test(input)) return null;
  try {
    const url = new URL(input);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Missing birth metadata is unknown, not permission to retrofit an old owner. */
export function boundSeedOriginMatches(bound: string | undefined, requested: unknown): boolean {
  const origin = normalizedSeedDoorOrigin(requested);
  return origin !== null && bound === origin;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[a-zA-Z0-9_.-]{1,80}\/[a-zA-Z0-9_.-]{1,80}$/;
// Keep the owner claim's branch grammar aligned with parseSeed: Git permits
// characters such as `+`, while its reserved ref syntax stays forbidden.
const REF = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\.$)(?!.*@\{)[\x21-\x7e]{1,255}$/;
const REF_FORBIDDEN = /[~^:?*[\\]/;
const OWNER_CLAIM_FIELDS = ["run", "requester", "thread", "repository", "ref", "head", "seed"] as const;
const OWNER_FIELDS = [...OWNER_CLAIM_FIELDS, "container"] as const;

/** No path, env, command or arbitrary JSON fields accepted from a receipt. */
export function parsePreservationOwner(input: unknown, requireContainer = true): PreservationOwner | OwnerClaim | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const fields = requireContainer ? OWNER_FIELDS : OWNER_CLAIM_FIELDS;
  if (Object.keys(o).length !== fields.length || Object.keys(o).some((key) => !fields.includes(key as never)))
    return null;
  if (
    typeof o.run !== "string" ||
    !UUID.test(o.run) ||
    typeof o.seed !== "string" ||
    !UUID.test(o.seed) ||
    (requireContainer && (typeof o.container !== "string" || !UUID.test(o.container)))
  )
    return null;
  if (
    typeof o.requester !== "string" ||
    !/^[a-z]+:[^\s]{1,120}$/.test(o.requester) ||
    typeof o.thread !== "string" ||
    !/^[a-z]+:[^\s]{1,120}$/.test(o.thread) ||
    typeof o.repository !== "string" ||
    !REPOSITORY.test(o.repository) ||
    typeof o.ref !== "string" ||
    !REF.test(o.ref) ||
    REF_FORBIDDEN.test(o.ref) ||
    typeof o.head !== "string" ||
    !SHA.test(o.head)
  )
    return null;
  return o as unknown as PreservationOwner | OwnerClaim;
}

export function sameOwner(left: PreservationOwner, right: PreservationOwner): boolean {
  return OWNER_FIELDS.every((field) => left[field] === right[field]);
}

/** A fresh seed must land on the claimed head. A previously verified owner
 * already binds the original seed identity; its checkout HEAD is free to move
 * as the writer commits work, without turning a cached seed into a new owner. */
export function seedClaimHeadMatches(claimedHead: string, checkoutHead: string, bound: boolean): boolean {
  return bound || claimedHead === checkoutHead;
}

/** A bound owner may only reuse the exact seed marker. If the marker changes
 * between the ownership pre-check and the seed's read, fresh restore is
 * forbidden: its initial sweep would remove the owner's checkout and .git. */
export function boundSeedMarkerDecision(
  marker: string | null,
  expected: string,
  bound: boolean,
): "cached" | "fresh" | "refuse" {
  if (marker === expected) return "cached";
  return bound ? "refuse" : "fresh";
}

export interface CheckpointHost {
  safeQuiescence(): Promise<boolean>;
  currentOwner(): Promise<PreservationOwner | null>;
  backup(options: { dir: string; gitignore: false; ttl: number }): Promise<{ id: string }>;
  verify(id: string): Promise<boolean>;
  save(id: string, owner: PreservationOwner): Promise<void>;
}

/** Any uncertainty retains the container. No SDK backup is a coherent snapshot
 * of a detached writer unless quiescence is independently established. */
export async function checkpointIfSafe(owner: PreservationOwner, host: CheckpointHost): Promise<boolean> {
  try {
    if (!(await host.safeQuiescence())) return false;
    const current = await host.currentOwner();
    if (!current || !sameOwner(owner, current)) return false;
    const { id } = await host.backup({ dir: CHECKOUT_DIR, gitignore: false, ttl: CHECKPOINT_TTL_SECONDS });
    if (!id || !(await host.verify(id))) return false;
    const after = await host.currentOwner();
    if (!after || !sameOwner(owner, after) || !(await host.safeQuiescence())) return false;
    await host.save(id, owner);
    // A changed incarnation after persistence cannot license teardown either.
    const saved = await host.currentOwner();
    return !!saved && sameOwner(owner, saved) && (await host.safeQuiescence());
  } catch {
    return false;
  }
}

export type PreservationFact = { state: "present" | "lost" | "unknown" };

/** Evidence for a named, already-running DO. This is deliberately not a
 * retirement decision: durable metadata cannot observe a detached writer or
 * prove that the live checkout still equals a prior checkpoint. */
export type SlotEvidence =
  | { state: "unknown" }
  | {
      state: "retained";
      objectId: string;
      birthContainer: string;
      seedState: "seeded";
      checkpoint: "present" | "lost" | "unknown";
      platformInstance: "unknown";
      liveIncarnation: "unknown";
      exclusiveOwner: "unknown";
      quiescence: "unknown";
      liveCheckout: "unknown";
      reason: "quiescence_and_live_bytes_unproven";
    };

export interface SlotEvidenceRequest {
  claim: OwnerClaim;
  objectId: string;
}

export interface SlotEvidenceSnapshot {
  objectId: string;
  threadName: string | undefined;
  running: boolean | undefined;
  seedState: "seeded" | "unseeded" | undefined;
  record: CheckpointRecord | null;
}

export function parseSlotEvidenceRequest(input: unknown): SlotEvidenceRequest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !("claim" in value) || !("objectId" in value)) return null;
  const claim = parsePreservationOwner(value.claim, false);
  if (!claim || "container" in claim || typeof value.objectId !== "string" || !/^[0-9a-f]{64}$/i.test(value.objectId))
    return null;
  return { claim, objectId: value.objectId };
}

/** No SDK call or container command belongs in this path. A matching row
 * discloses only its birth container and the existing full-checkout backup's
 * R2 status; it cannot certify current bytes or quiescence. */
export async function passiveSlotEvidence(
  request: SlotEvidenceRequest,
  readSnapshot: () => Promise<SlotEvidenceSnapshot>,
  archivePresent: (id: string) => Promise<boolean | undefined>,
): Promise<SlotEvidence> {
  try {
    if (!parseSlotEvidenceRequest(request)) return { state: "unknown" };
    const snapshot = await readSnapshot();
    const owner = snapshot.record?.owner;
    if (
      snapshot.objectId.toLowerCase() !== request.objectId.toLowerCase() ||
      snapshot.threadName !== request.claim.thread ||
      snapshot.running !== true ||
      snapshot.seedState !== "seeded" ||
      !owner ||
      !parsePreservationOwner(owner) ||
      OWNER_CLAIM_FIELDS.some((field) => owner[field] !== request.claim[field])
    )
      return { state: "unknown" };
    const present = snapshot.record?.backupId ? await archivePresent(snapshot.record.backupId) : undefined;
    return {
      state: "retained",
      objectId: snapshot.objectId,
      birthContainer: owner.container,
      seedState: "seeded",
      checkpoint: present === undefined ? "unknown" : present ? "present" : "lost",
      platformInstance: "unknown",
      liveIncarnation: "unknown",
      exclusiveOwner: "unknown",
      quiescence: "unknown",
      liveCheckout: "unknown",
      reason: "quiescence_and_live_bytes_unproven",
    };
  } catch {
    return { state: "unknown" };
  }
}

/** No-wake orchestration: load a DO row and, only for its exact owner, HEAD
 * two R2 objects. No sandbox SDK object is accepted by this seam. */
export async function passivePreservationReceipt(
  request: PreservationOwner,
  readRecord: () => Promise<CheckpointRecord | null>,
  archivePresent: (id: string) => Promise<boolean | undefined>,
): Promise<PreservationFact> {
  try {
    const record = await readRecord();
    if (!record || !sameOwner(request, record.owner) || !record.backupId) return { state: "unknown" };
    return preservationReceipt(request, record, await archivePresent(record.backupId));
  } catch {
    return { state: "unknown" };
  }
}

/** `archivePresent` comes from read-only R2 HEADs of BOTH archive and metadata,
 * not the container. A stopped container needs no SDK call and proves no bytes
 * by itself; an absent checkpoint is unknown without positive loss evidence. */
export function preservationReceipt(
  request: PreservationOwner,
  record: CheckpointRecord | null,
  archivePresent: boolean | undefined,
): PreservationFact {
  if (!record || !sameOwner(request, record.owner) || !record.backupId || archivePresent === undefined)
    return { state: "unknown" };
  return { state: archivePresent ? "present" : "lost" };
}
