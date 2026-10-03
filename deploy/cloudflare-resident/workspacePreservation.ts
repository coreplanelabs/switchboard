import { publicationSettlementForRun } from "../../src/core/publicationSettlement.js";
import type { PrivateTreeObservation } from "../../src/execution/residentCleanliness.js";

export interface PreservationRegistration {
  threadKey: string;
  runId?: string;
  ownerGen?: string;
  ownerFence?: number;
  legacyRetainedAt?: number;
}

export interface PreservationBinding {
  threadKey: string;
  ref: string;
  user: string;
  worktreePath: string;
  sha?: string;
  lastRunOwner?: { runId?: string; ownerGen?: string; ownerFence?: number } | null;
}

export type PreservationDecision = { removable: true } | { removable: false; reason: string };
const keep = (reason: string): PreservationDecision => ({ removable: false, reason });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
export const hasRunOwnerField = (value: unknown): boolean =>
  object(value) &&
  (Object.hasOwn(value, "runId") || Object.hasOwn(value, "ownerGen") || Object.hasOwn(value, "ownerFence"));
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const privateTreeObservation = (value: unknown): value is PrivateTreeObservation =>
  object(value) &&
  value.present === true &&
  typeof value.branch === "string" &&
  typeof value.head === "string" &&
  /^[a-f0-9]{40}$/.test(value.head) &&
  natural(value.uncommittedChanges) &&
  natural(value.untrackedNonIgnored) &&
  natural(value.unpushedCommits);

/** Only the exact terminal owner and current Git tree can authorize automatic
 * removal. Missing evidence never converts a known run into a legacy cache. */
export function decideWorkspaceRemoval(input: {
  binding: PreservationBinding;
  registration: PreservationRegistration | undefined;
  fence: unknown;
  owner: unknown;
  tree: unknown;
}): PreservationDecision {
  const { binding, registration, fence, owner, tree } = input;
  // Reconciliation is an ownership read/ledger repair, never a grant to
  // delete an unidentified run's private worktree on the next idle sweep.
  if (registration && Object.hasOwn(registration, "legacyRetainedAt"))
    return keep(
      Number.isSafeInteger(registration.legacyRetainedAt) ? "legacy-retained" : "retention-marker-unverified",
    );
  if (
    (registration === undefined ||
      (object(registration) && registration.threadKey === binding.threadKey && !hasRunOwnerField(registration))) &&
    fence === undefined &&
    binding.lastRunOwner == null
  )
    return { removable: true }; // positively untracked legacy cache
  if (
    !registration?.runId ||
    !registration.ownerGen ||
    !natural(registration.ownerFence) ||
    registration.threadKey !== binding.threadKey
  )
    return keep("owner-registration-incomplete");
  if (
    !object(fence) ||
    fence.runId !== registration.runId ||
    fence.ownerGen !== registration.ownerGen ||
    fence.ownerFence !== registration.ownerFence
  )
    return keep("owner-fence-mismatch");
  if (!object(owner)) return keep("owner-unavailable");
  if (owner.kind === "live") return keep("owner-live");
  if (owner.kind !== "terminal" || !object(owner.record)) return keep("owner-unverified");
  const record = owner.record;
  if (
    record.id !== registration.runId ||
    record.threadKey !== binding.threadKey ||
    record.provisional === true ||
    !["completed", "stopped_soft", "stopped_hard", "failed", "interrupted"].includes(String(record.status))
  )
    return keep("owner-mismatch");
  if (!privateTreeObservation(tree) || tree.branch !== binding.ref) return keep("private-tree-unverified");
  if (tree.uncommittedChanges !== 0 || tree.untrackedNonIgnored !== 0) return keep("private-tree-changed");
  // A clean tree still at the resident's attach HEAD has no local work to
  // preserve, including when a read-only coordinator child has no coding receipt.
  if (binding.sha && /^[a-f0-9]{40}$/.test(binding.sha) && tree.head === binding.sha && tree.unpushedCommits === 0)
    return { removable: true };
  const settlement = publicationSettlementForRun(record.publicationSettlement, record);
  if (
    !settlement ||
    settlement.binding.generation !== registration.ownerGen ||
    settlement.binding.branch !== binding.ref
  )
    return keep("preservation-unverified");
  if (
    settlement.checkpoint.kind === "created" &&
    settlement.preservation.kind === "saved" &&
    tree.head === settlement.checkpoint.head
  )
    return { removable: true };
  if (settlement.checkpoint.kind === "clean" && tree.head === settlement.checkpoint.head && tree.unpushedCommits === 0)
    return { removable: true };
  return keep("preservation-unverified");
}
