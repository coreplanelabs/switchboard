import { doorPublicationOf, branchPublicationOf, isPublicationRepo } from "../branchPublication.js";
import { workspaceSettlementOf } from "../workspaceSettlement.js";
import {
  isCoordinatorInstance,
  isCoordinatorUnit,
  permitsRecoveryMetadataWrite,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";

export interface PullTarget {
  repo: string;
  pr?: number;
  ref?: string;
}

export function unitPullTargets(instance: CoordinatorInstance, unit: CoordinatorUnit): PullTarget[] {
  const numbers = [
    ...new Set([unit.pr?.number, unit.resume?.pr, unit.publication?.pr, unit.adoption?.pr?.number]),
  ].filter((pr): pr is number => pr !== undefined);
  const refs = [...new Set([unit.branch, unit.publication?.headRef, unit.publication?.publicationRef])].filter(
    (ref): ref is string => ref !== undefined,
  );
  return [
    ...numbers.map((pr) => ({ repo: instance.repo, pr })),
    ...refs.map((ref) => ({ repo: instance.repo, ref })),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export type PullBindingRefusal = "stale" | "owned" | "incomplete" | "unavailable";

export function needsPullBindingAdmission(current: CoordinatorUnit | undefined, next: CoordinatorUnit): boolean {
  const established = (unit: CoordinatorUnit | undefined) =>
    !!(unit && (unit.pr || unit.resume || unit.publication || unit.adoption || unit.startedAt !== undefined));
  return established(current) || established(next) || !!next.recovery;
}

export function isPullBindingRefusal(value: unknown): value is PullBindingRefusal {
  return value === "stale" || value === "owned" || value === "incomplete" || value === "unavailable";
}

/** New bindings retain prior targets; unchanged display writes need no admission. */
export function pullBindingChanges(
  instance: CoordinatorInstance,
  current: CoordinatorUnit | undefined,
  next: CoordinatorUnit,
): boolean {
  const binding = (unit: CoordinatorUnit | undefined) =>
    unit && {
      pr: unit.pr?.number,
      resume: unit.resume && { pr: unit.resume.pr, headSha: unit.resume.headSha },
      publication: unit.publication,
      adoption: unit.adoption && { ...unit.adoption, pr: unit.adoption.pr && { number: unit.adoption.pr.number } },
    };
  return (
    JSON.stringify(binding(current)) !== JSON.stringify(binding(next)) ||
    JSON.stringify(current ? unitPullTargets(instance, current) : []) !==
      JSON.stringify(unitPullTargets(instance, next))
  );
}

export function unitPullBindingRefusal(
  rows: PullOwnershipRows,
  instance: CoordinatorInstance,
  current: CoordinatorUnit | undefined,
  next: CoordinatorUnit,
): PullBindingRefusal | undefined {
  if (!isCoordinatorInstance(instance) || !isCoordinatorUnit(next) || next.instanceId !== instance.id)
    return "incomplete";
  const adoptionTransition =
    next.adoption !== undefined &&
    JSON.stringify(current?.adoption) !== JSON.stringify(next.adoption) &&
    permitsRecoveryMetadataWrite(current, next, true);
  if (instance.stop !== undefined && !adoptionTransition) return "stale";
  if (next.adoption && next.adoption.requester !== instance.userId) return "incomplete";
  if (!unitHoldsPulls(next) && !(current?.adoption?.state === "posting" && next.adoption?.state === "bound"))
    return "stale";
  if (
    next.publication &&
    (next.publication.repo.toLowerCase() !== instance.repo.toLowerCase() ||
      next.publication.owner.instanceId !== next.instanceId ||
      next.publication.owner.unit !== next.unit)
  )
    return "incomplete";
  const targets = unitPullTargets(instance, next);
  if (
    current &&
    unitPullTargets(instance, current).some(
      (old) => !targets.some((target) => JSON.stringify(target) === JSON.stringify(old)),
    )
  )
    return "stale";
  for (const target of targets) {
    const owners = findPullOwnersInRows(target, rows);
    if (!owners.ok) return owners.reason === "unavailable" ? "unavailable" : "incomplete";
    if (
      owners.owners.some(
        (owner) => owner.kind !== "unit" || owner.instanceId !== next.instanceId || owner.unit !== next.unit,
      )
    )
      return "owned";
  }
}

export type PullOwner =
  | { kind: "unit"; instanceId: string; unit: string; actionId?: string }
  | { kind: "run"; runId: string }
  | { kind: "effect"; id: string };
export type PullOwnersResult =
  { ok: true; owners: PullOwner[] } | { ok: false; reason: "unavailable" | "incomplete" | "invalid" };

/** Bound work in the owner transaction; reaching it never proves absence. */
export const PULL_OWNER_SCAN_MAX = 32768;
export const PULL_OWNER_SCAN_MAX_BYTES = 16 * 1024 * 1024;
export interface PullOwnershipRows {
  complete: boolean;
  units: Array<{ instance: unknown; unit: unknown }>;
  runs: Array<{ runId: string; repo?: unknown; live: boolean; publication?: unknown; door?: unknown }>;
  effects: unknown[];
  settlements?: unknown[];
}

export function isPullTarget(value: unknown): value is PullTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    isPublicationRepo(v.repo) &&
    (v.pr === undefined || (Number.isSafeInteger(v.pr) && (v.pr as number) > 0)) &&
    (v.ref === undefined || (typeof v.ref === "string" && pullRef(v.ref).length > 0)) &&
    (v.pr !== undefined || v.ref !== undefined)
  );
}

const pullRef = (ref: string) => (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref);

export function isPullOwnerLiveMeta(value: unknown): value is { repo?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return (
    ["channelId", "userId", "threadKey"].every((key) => typeof meta[key] === "string" && !!meta[key]) &&
    (meta.repo === undefined || isPublicationRepo(meta.repo))
  );
}

export function unitHoldsPulls(unit: CoordinatorUnit): boolean {
  return (
    !unit.ending ||
    !unit.ending.outcome ||
    !!unit.recovery ||
    (unit.adoption !== undefined && unit.adoption.state !== "bound")
  );
}

/** A complete snapshot is useful only inside the same owner's admission transaction. */
export function findPullOwnersInRows(target: PullTarget, rows: PullOwnershipRows): PullOwnersResult {
  if (!isPullTarget(target)) return { ok: false, reason: "invalid" };
  if (
    !rows.complete ||
    rows.units.length + rows.runs.length + rows.effects.length + (rows.settlements?.length ?? 0) > PULL_OWNER_SCAN_MAX
  )
    return { ok: false, reason: "incomplete" };
  const owners = new Map<string, PullOwner>();
  const sameRepo = (repo: string) => repo.toLowerCase() === target.repo.toLowerCase();
  const matches = (pr?: number, ref?: string) =>
    (target.pr !== undefined && pr === target.pr) ||
    (target.ref !== undefined && ref !== undefined && pullRef(ref) === pullRef(target.ref));
  const add = (owner: PullOwner) => owners.set(JSON.stringify(owner), owner);
  for (const row of rows.units) {
    if (!isCoordinatorInstance(row.instance) || !isCoordinatorUnit(row.unit) || row.unit.instanceId !== row.instance.id)
      return { ok: false, reason: "incomplete" };
    const unit = row.unit;
    if (
      unit.publication &&
      (unit.publication.repo.toLowerCase() !== row.instance.repo.toLowerCase() ||
        unit.publication.owner.instanceId !== unit.instanceId ||
        unit.publication.owner.unit !== unit.unit)
    )
      return { ok: false, reason: "incomplete" };
    if (!sameRepo(row.instance.repo)) continue;
    const held = unitHoldsPulls(unit);
    if (
      held &&
      (matches(unit.pr?.number, unit.branch) ||
        matches(unit.resume?.pr) ||
        matches(unit.publication?.pr, unit.publication?.publicationRef) ||
        matches(undefined, unit.publication?.headRef) ||
        matches(unit.adoption?.pr?.number))
    )
      add({
        kind: "unit",
        instanceId: unit.instanceId,
        unit: unit.unit,
        ...(unit.recovery
          ? { actionId: unit.recovery.actionId }
          : unit.adoption && unit.adoption.state !== "bound"
            ? { actionId: unit.adoption.actionId }
            : {}),
      });
  }
  for (const run of rows.runs) {
    if (typeof run.runId !== "string" || !run.runId) return { ok: false, reason: "incomplete" };
    if (run.publication !== undefined) {
      const publication = branchPublicationOf(run.publication, typeof run.repo === "string" ? run.repo : undefined);
      if (!publication || (!publication.complete && publication.repo === undefined))
        return { ok: false, reason: "incomplete" };
      if (publication.repo && sameRepo(publication.repo)) {
        if (!publication.complete && !publication.pending) return { ok: false, reason: "incomplete" };
        if (
          (run.live || !publication.complete) &&
          (publication.branches.some((b) => matches(b.pr, b.ref)) ||
            publication.targets?.some((t) => matches(t.pr, t.ref)) ||
            (publication.pending && matches(publication.pending.pr, publication.pending.ref)))
        )
          add({ kind: "run", runId: run.runId });
      }
    }
    if (run.door !== undefined && run.door !== null) {
      const door = doorPublicationOf(run.door);
      if (!door) return { ok: false, reason: "incomplete" };
      const update = door.update;
      if (door.outcome === "rejected" || door.outcome === "not_forwarded") continue;
      if (sameRepo(door.repo) && matches(door.pr as number | undefined, update.ref))
        add({ kind: "run", runId: run.runId });
    }
  }
  for (const value of rows.settlements ?? []) {
    const settlement = workspaceSettlementOf(value);
    if (!settlement) return { ok: false, reason: "incomplete" };
    const publication = settlement.publication;
    if (!publication || publication.complete) continue;
    if (!publication.repo || !publication.pending) return { ok: false, reason: "incomplete" };
    if (
      sameRepo(publication.repo) &&
      (matches(publication.pending.pr, publication.pending.ref) ||
        publication.branches.some((b) => matches(b.pr, b.ref)) ||
        publication.targets?.some((t) => matches(t.pr, t.ref)))
    )
      add({ kind: "run", runId: settlement.owner.runId });
  }
  for (const value of rows.effects) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "incomplete" };
    const effect = value as Record<string, unknown>;
    if (typeof effect.id !== "string" || !effect.id) return { ok: false, reason: "incomplete" };
    if (["admit", "probe", "steer", "reissue"].includes(effect.kind as string)) continue;
    if (!["retitle", "pr_open", "rebase_round"].includes(effect.kind as string) || !isPublicationRepo(effect.repo))
      return { ok: false, reason: "incomplete" };
    if (
      effect.kind === "pr_open"
        ? typeof effect.branch !== "string" || !effect.branch
        : !Number.isSafeInteger(effect.number) || (effect.number as number) < 1
    )
      return { ok: false, reason: "incomplete" };
    if (sameRepo(effect.repo) && matches(effect.number as number | undefined, effect.branch as string | undefined))
      add({ kind: "effect", id: effect.id });
  }
  return { ok: true, owners: [...owners.values()] };
}

export function isPullOwnersResult(value: unknown): value is PullOwnersResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.ok === false) return ["unavailable", "incomplete", "invalid"].includes(v.reason as string);
  return (
    v.ok === true &&
    Array.isArray(v.owners) &&
    v.owners.length <= PULL_OWNER_SCAN_MAX &&
    v.owners.every((owner) => {
      if (!owner || typeof owner !== "object") return false;
      const o = owner as Record<string, unknown>;
      return o.kind === "unit"
        ? typeof o.instanceId === "string" &&
            !!o.instanceId &&
            typeof o.unit === "string" &&
            !!o.unit &&
            (o.actionId === undefined || (typeof o.actionId === "string" && !!o.actionId))
        : o.kind === "run"
          ? typeof o.runId === "string" && !!o.runId
          : o.kind === "effect" && typeof o.id === "string" && !!o.id;
    })
  );
}
