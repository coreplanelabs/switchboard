import { reviewPublicationOf } from "./reviewPublication.js";
import { parsePushed, PUSHED_MAX, type PushedBranch } from "../execution/residentRebind.js";

export function isPublicationRepo(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}

/** Producer facts retained independently of the bounded display event stream. */
export interface BranchPublication {
  version: 1;
  repo?: string;
  branches: PushedBranch[];
  complete: boolean;
  /** Accepted PR writes without a pushed branch retain their target independently. */
  targets?: Array<{ pr: number; ref?: string; headSha: string }>;
  pending?: { id: string; ref?: string; headSha: string; pr?: number };
}

export function branchPublicationOf(value: unknown, repo?: string): BranchPublication | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    (v.repo !== undefined && !isPublicationRepo(v.repo)) ||
    (repo !== undefined && v.repo !== undefined && v.repo !== repo)
  )
    return undefined;
  if (typeof v.complete !== "boolean") return undefined;
  const parsed = parsePushed(v.branches);
  if (
    v.branches === undefined ||
    "error" in parsed ||
    new Set(parsed.pushed.map((b) => b.ref)).size !== parsed.pushed.length
  )
    return undefined;
  if ((parsed.pushed.length > 0 || v.pending !== undefined || v.targets !== undefined) && v.repo === undefined)
    return undefined;
  if (
    v.targets !== undefined &&
    (!Array.isArray(v.targets) ||
      v.targets.length > PUSHED_MAX ||
      new Set(v.targets.map((t) => t?.pr)).size !== v.targets.length ||
      !v.targets.every(
        (t) =>
          t &&
          typeof t === "object" &&
          Number.isSafeInteger(t.pr) &&
          t.pr > 0 &&
          (t.ref === undefined || (typeof t.ref === "string" && t.ref.length > 0)) &&
          typeof t.headSha === "string" &&
          /^[0-9a-f]{40}$/.test(t.headSha),
      ))
  )
    return undefined;
  if (v.pending !== undefined) {
    if (v.complete || typeof v.pending !== "object" || v.pending === null) return undefined;
    const p = v.pending as Record<string, unknown>;
    if (
      typeof p.id !== "string" ||
      !p.id ||
      (p.ref !== undefined && (typeof p.ref !== "string" || !p.ref)) ||
      typeof p.headSha !== "string" ||
      !/^[0-9a-f]{40}$/.test(p.headSha)
    )
      return undefined;
    if (p.pr !== undefined && (!Number.isSafeInteger(p.pr) || (p.pr as number) <= 0)) return undefined;
    if (p.ref === undefined && p.pr === undefined) return undefined;
  }
  return structuredClone(value) as BranchPublication;
}

/** Unsettled or unreadable producer facts remain evidence, never mutation authority. */
export function publicationRetentionRequired(value: unknown): boolean {
  if (value === undefined) return false;
  const publication = branchPublicationOf(value);
  return publication === undefined || !publication.complete || publication.pending !== undefined;
}

export interface DoorPublication {
  id: string;
  repo: string;
  pr?: number;
  owner?: { instanceId: string; unit: string };
  update: { ref: string; old: string; next: string };
  outcome?: "rejected" | "not_forwarded";
}

export function doorPublicationOf(value: unknown): DoorPublication | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>,
    update = v.update as Record<string, unknown> | undefined;
  if (
    typeof v.id !== "string" ||
    !v.id ||
    !isPublicationRepo(v.repo) ||
    !update ||
    Array.isArray(update) ||
    typeof update.ref !== "string" ||
    !update.ref.startsWith("refs/heads/") ||
    update.ref === "refs/heads/" ||
    typeof update.old !== "string" ||
    !/^[0-9a-f]{40}$/.test(update.old) ||
    typeof update.next !== "string" ||
    !/^[0-9a-f]{40}$/.test(update.next) ||
    (v.pr !== undefined && (!Number.isSafeInteger(v.pr) || (v.pr as number) < 1)) ||
    (v.outcome !== undefined && v.outcome !== "rejected" && v.outcome !== "not_forwarded")
  )
    return undefined;
  if (v.owner !== undefined) {
    if (!v.owner || typeof v.owner !== "object" || Array.isArray(v.owner)) return undefined;
    const owner = v.owner as Record<string, unknown>;
    if (typeof owner.instanceId !== "string" || !owner.instanceId || typeof owner.unit !== "string" || !owner.unit)
      return undefined;
  }
  return structuredClone(value) as DoorPublication;
}

/** Unknown Door bytes retain their producer until an exact no-write outcome exists. */
export function doorPublicationRetentionRequired(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const door = doorPublicationOf(value);
  return !door || door.outcome === undefined;
}

export function terminalPublicationRetentionRequired(record: {
  branchPublication?: unknown;
  doorPublicationPending?: unknown;
  reviewPublication?: unknown;
}): boolean {
  const review = reviewPublicationOf(record.reviewPublication);
  return (
    publicationRetentionRequired(record.branchPublication) ||
    doorPublicationRetentionRequired(record.doorPublicationPending) ||
    (record.reviewPublication !== undefined && (!review || review.state === "pending" || review.state === "uncertain"))
  );
}
