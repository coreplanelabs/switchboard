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
  backupId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[a-zA-Z0-9_.-]{1,80}\/[a-zA-Z0-9_.-]{1,80}$/;
const REF = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\.$)(?!.*@\{)[a-zA-Z0-9_./-]{1,255}$/;
const OWNER_FIELDS = ["run", "requester", "thread", "repository", "ref", "head", "seed", "container"] as const;

/** No path, env, command or arbitrary JSON fields accepted from a receipt. */
export function parsePreservationOwner(input: unknown, requireContainer = true): PreservationOwner | OwnerClaim | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const fields = requireContainer ? OWNER_FIELDS : OWNER_FIELDS.slice(0, -1);
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
    typeof o.head !== "string" ||
    !SHA.test(o.head)
  )
    return null;
  return o as unknown as PreservationOwner | OwnerClaim;
}

export function sameOwner(left: PreservationOwner, right: PreservationOwner): boolean {
  return OWNER_FIELDS.every((field) => left[field] === right[field]);
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
