import {
  initialOwnerUnits,
  pullOwnerQualificationSnapshot,
  type PullOwnerQualificationSnapshot,
  type PullOwnerQualification,
  type InitialOwnerPredicate,
} from "./pullOwnerQualification.js";
import { doorPublicationOf, branchPublicationOf, isPublicationRepo } from "../branchPublication.js";
import { branchPushReceiptsOf, isRunWorkOwner } from "../runRecord.js";
import {
  historicalNativeChain,
  isHistoricalNativeAudit,
  isHistoricalOwnerRecord,
  type HistoricalOwnerEvent,
} from "./historicalNativeAudit.js";
import { publicationSettlementForRun } from "../publicationSettlement.js";
import { workspaceSettlementOf } from "../workspaceSettlement.js";
import { isCoordinatorReconcileEffect } from "./workflowReconciliation.js";
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
  const activeEffect = unit.currentEffect?.phase === "active" ? unit.currentEffect : undefined;
  const numbers = [
    ...new Set([
      unit.pr?.number,
      unit.resume?.pr,
      unit.publication?.pr,
      unit.adoption?.pr?.number,
      activeEffect?.target.pr,
    ]),
  ].filter((pr): pr is number => pr !== undefined);
  const refs = [
    ...new Set([unit.branch, unit.publication?.headRef, unit.publication?.publicationRef, activeEffect?.target.ref]),
  ].filter((ref): ref is string => ref !== undefined);
  return [
    ...numbers.map((pr) => ({ repo: instance.repo, pr })),
    ...refs.map((ref) => ({ repo: instance.repo, ref })),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export type PullBindingRefusal = "stale" | "owned" | "incomplete" | "unavailable";

export const PULL_OWNERSHIP_CHECKS = [
  "target",
  "inventory_incomplete",
  "inventory_limit",
  "binding_identity",
  "adoption_requester",
  "instance_stopped",
  "unit_not_held",
  "publication_owner",
  "target_removed",
  "rival_owner",
  "pending_report",
  "instance_read",
  "instance_shape",
  "ownership_scan",
  "binding_validation",
  "inventory_row_limit",
  "inventory_byte_limit",
  "inventory_live_producer",
  "inventory_terminal_producer",
  "inventory_private_producer",
  "inventory_workspace_owner",
  "unit_shape",
  "unit_publication_binding",
  "unit_effect_binding",
  "run_shape",
  "run_publication",
  "run_initial_coding_owner",
  "run_door",
  "settlement_shape",
  "settlement_repository",
  "settlement_initial_coding_owner",
  "effect_shape",
  "effect_identity",
  "effect_reconciliation",
  "effect_unit_binding",
  "effect_kind",
  "effect_target",
] as const;
export type PullOwnershipCheck = (typeof PULL_OWNERSHIP_CHECKS)[number];
export type PullOwnershipSource = "units" | "runs" | "live_runs" | "settlements" | "effects";
export type PullOwnerDiagnosticCause =
  "row-limit" | "byte-limit" | "json" | "shape" | "historical" | "validation" | "read";
export interface PullOwnerReadDiagnostic {
  version: 1;
  stage: PullOwnershipCheck;
  cause: PullOwnerDiagnosticCause;
  source?: PullOwnershipSource;
  rowIndex?: number;
  rowsRead: number;
  /** Existing conservative UTF-16-to-UTF-8 estimate, not decoded private bytes. */
  sourceBytes: number;
}
export interface PullOwnershipDiagnostics {
  qualifyRecord?: true;
  qualificationSnapshot?: PullOwnerQualificationSnapshot;
  /** Physical locations align with merged run rows; they carry no ownership facts. */
  runOrigins?: Array<{ source: "live_runs" | "runs"; rowIndex: number }>;
  cursor?: { source: PullOwnershipSource; rowIndex?: number };
  cause?: PullOwnerDiagnosticCause;
  failure?: { check: PullOwnershipCheck; source?: PullOwnershipSource; rowIndex?: number };
  scan?: { source: PullOwnershipSource; rowIndex: number; rowsRead: number; sourceBytes: number };
}

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
  diagnostics?: PullOwnershipDiagnostics,
): PullBindingRefusal | undefined {
  const fail = (reason: PullBindingRefusal, check: PullOwnershipCheck): PullBindingRefusal => {
    if (diagnostics) diagnostics.failure = { check };
    return reason;
  };
  if (!isCoordinatorInstance(instance) || !isCoordinatorUnit(next) || next.instanceId !== instance.id)
    return fail("incomplete", "binding_identity");
  const adoptionTransition =
    next.adoption !== undefined &&
    JSON.stringify(current?.adoption) !== JSON.stringify(next.adoption) &&
    permitsRecoveryMetadataWrite(current, next, true);
  if (instance.stop !== undefined && !adoptionTransition) return fail("stale", "instance_stopped");
  if (next.adoption && next.adoption.requester !== instance.userId) return fail("incomplete", "adoption_requester");
  if (!unitHoldsPulls(next, instance) && !(current?.adoption?.state === "posting" && next.adoption?.state === "bound"))
    return fail("stale", "unit_not_held");
  if (
    next.publication &&
    (next.publication.repo.toLowerCase() !== instance.repo.toLowerCase() ||
      next.publication.owner.instanceId !== next.instanceId ||
      next.publication.owner.unit !== next.unit)
  )
    return fail("incomplete", "publication_owner");
  const targets = unitPullTargets(instance, next);
  if (
    current &&
    unitPullTargets(instance, current).some(
      (old) => !targets.some((target) => JSON.stringify(target) === JSON.stringify(old)),
    )
  )
    return fail("stale", "target_removed");
  return unitPullTargetsRefusal(rows, instance, next, diagnostics);
}

/** Exact canonical targets, checked inside the existing owner transaction. */
export function unitPullTargetsRefusal(
  rows: PullOwnershipRows,
  instance: CoordinatorInstance,
  next: CoordinatorUnit,
  diagnostics?: PullOwnershipDiagnostics,
): PullBindingRefusal | undefined {
  const fail = (reason: PullBindingRefusal, check: PullOwnershipCheck): PullBindingRefusal => {
    if (diagnostics) diagnostics.failure = { check };
    return reason;
  };
  if (!isCoordinatorInstance(instance) || !isCoordinatorUnit(next) || next.instanceId !== instance.id)
    return fail("incomplete", "binding_identity");
  for (const target of unitPullTargets(instance, next)) {
    const owners = findPullOwnersInRows(target, rows, diagnostics);
    if (!owners.ok) return owners.reason === "unavailable" ? "unavailable" : "incomplete";
    if (
      owners.owners.some(
        (owner) => owner.kind !== "unit" || owner.instanceId !== next.instanceId || owner.unit !== next.unit,
      )
    )
      return fail("owned", "rival_owner");
  }
}

export type PullOwner =
  | { kind: "unit"; instanceId: string; unit: string; actionId?: string }
  | { kind: "run"; runId: string }
  | { kind: "effect"; id: string };
export type PullOwnersResult =
  | { ok: true; owners: PullOwner[] }
  | {
      ok: false;
      reason: "unavailable" | "incomplete" | "invalid";
      diagnostic?: PullOwnerReadDiagnostic;
      qualification?: PullOwnerQualification;
    };

/** Bound work in the owner transaction; reaching it never proves absence. */
export const PULL_OWNER_SCAN_MAX = 32768;
export const PULL_OWNER_SCAN_MAX_BYTES = 16 * 1024 * 1024;
export interface PullOwnershipRows {
  complete: boolean;
  units: Array<{ instance: unknown; unit: unknown }>;
  runs: Array<{
    runId: string;
    repo?: unknown;
    live: boolean;
    publication?: unknown;
    door?: unknown;
    record?: unknown;
    pushReceipts?: unknown;
    historicalEvents?: readonly HistoricalOwnerEvent[];
  }>;
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

/** Candidate keys only, after canonical producer decoding. Unknown evidence
 * blocks every target; a key never replaces the owning transaction's proof. */
export function terminalPullOwnerTargets(
  run: PullOwnershipRows["runs"][number],
  diagnostics?: PullOwnershipDiagnostics,
): PullTarget[] | undefined {
  const fail = (check: PullOwnershipCheck): undefined => {
    if (diagnostics) {
      diagnostics.failure = { check, ...diagnostics.cursor };
      diagnostics.cause = "validation";
    }
    return undefined;
  };
  if (run.live || !isRunWorkOwner(run.record) || run.record.id !== run.runId || run.record.repo !== run.repo)
    return fail("run_shape");
  const targets: PullTarget[] = [];
  if (run.publication !== undefined) {
    const publication = branchPublicationOf(run.publication, typeof run.repo === "string" ? run.repo : undefined);
    if (!publication || (!publication.complete && !publication.repo)) return fail("run_publication");
    if (!publication.complete) {
      const repo = publication.repo!;
      if (!publication.pending) targets.push({ repo });
      else {
        targets.push({ repo, pr: publication.pending.pr, ref: publication.pending.ref });
        for (const branch of publication.branches) targets.push({ repo, pr: branch.pr, ref: branch.ref });
        for (const target of publication.targets ?? []) targets.push({ repo, pr: target.pr, ref: target.ref });
      }
    }
  }
  if (run.door !== undefined && run.door !== null) {
    const door = doorPublicationOf(run.door);
    if (!door) return fail("run_door");
    if (door.outcome !== "rejected" && door.outcome !== "not_forwarded")
      targets.push({ repo: door.repo, pr: door.pr, ref: door.update.ref });
  }
  return targets.map((target) => ({
    repo: target.repo.toLowerCase(),
    ...(target.pr !== undefined ? { pr: target.pr } : {}),
    ...(target.ref !== undefined ? { ref: pullRef(target.ref) } : {}),
  }));
}

export function pullOwnerTargetMatches(candidate: PullTarget, target: PullTarget): boolean {
  return (
    candidate.repo.toLowerCase() === target.repo.toLowerCase() &&
    ((candidate.pr === undefined && candidate.ref === undefined) ||
      (target.pr !== undefined && candidate.pr === target.pr) ||
      (target.ref !== undefined && candidate.ref !== undefined && pullRef(candidate.ref) === pullRef(target.ref)))
  );
}

export function isPullOwnerLiveMeta(value: unknown): value is { repo?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return (
    ["channelId", "userId", "threadKey"].every((key) => typeof meta[key] === "string" && !!meta[key]) &&
    (meta.repo === undefined || isPublicationRepo(meta.repo))
  );
}

export function unitHoldsPulls(unit: CoordinatorUnit, instance?: CoordinatorInstance): boolean {
  if (
    instance?.kind === "maintenance" &&
    unit.currentEffect?.phase === "settled" &&
    unit.currentEffect.execution.maintenance &&
    unit.startedAt === undefined &&
    unit.ending === undefined &&
    !unit.recovery &&
    !unit.recoveryHold &&
    unit.currentEffect.execution.workflowId === undefined
  )
    return false;
  return (
    unit.currentEffect?.phase === "active" ||
    !unit.ending ||
    !unit.ending.outcome ||
    !!unit.recovery ||
    (unit.adoption !== undefined && unit.adoption.state !== "bound")
  );
}

/** A complete snapshot is useful only inside the same owner's admission transaction. */
export function findPullOwnersInRows(
  target: PullTarget,
  rows: PullOwnershipRows,
  diagnostics?: PullOwnershipDiagnostics,
): PullOwnersResult {
  const fail = (
    check: PullOwnershipCheck,
    source?: PullOwnershipSource,
    rowIndex?: number,
    reason: "invalid" | "incomplete" = "incomplete",
  ): PullOwnersResult => {
    if (diagnostics)
      diagnostics.failure = { check, ...(source ? { source } : {}), ...(rowIndex !== undefined ? { rowIndex } : {}) };
    return { ok: false, reason };
  };
  if (!isPullTarget(target)) return fail("target", undefined, undefined, "invalid");
  if (!rows.complete && diagnostics?.failure) return { ok: false, reason: "incomplete" };
  if (
    !rows.complete ||
    rows.units.length + rows.runs.length + rows.effects.length + (rows.settlements?.length ?? 0) > PULL_OWNER_SCAN_MAX
  )
    return fail(!rows.complete ? "inventory_incomplete" : "inventory_limit");
  const owners = new Map<string, PullOwner>();
  const sameRepo = (repo: string) => repo.toLowerCase() === target.repo.toLowerCase();
  const matches = (pr?: number, ref?: string) =>
    (target.pr !== undefined && pr === target.pr) ||
    (target.ref !== undefined && ref !== undefined && pullRef(ref) === pullRef(target.ref));
  const add = (owner: PullOwner) => owners.set(JSON.stringify(owner), owner);
  const unitOwner = (unit: CoordinatorUnit): Extract<PullOwner, { kind: "unit" }> => ({
    kind: "unit",
    instanceId: unit.instanceId,
    unit: unit.unit,
    ...(unit.recovery
      ? { actionId: unit.recovery.actionId }
      : unit.adoption && unit.adoption.state !== "bound"
        ? { actionId: unit.adoption.actionId }
        : {}),
  });
  for (const [rowIndex, row] of rows.units.entries()) {
    if (!isCoordinatorInstance(row.instance) || !isCoordinatorUnit(row.unit) || row.unit.instanceId !== row.instance.id)
      return fail("unit_shape", "units", rowIndex);
    const unit = row.unit;
    if (
      unit.publication &&
      (unit.publication.repo.toLowerCase() !== row.instance.repo.toLowerCase() ||
        unit.publication.owner.instanceId !== unit.instanceId ||
        unit.publication.owner.unit !== unit.unit)
    )
      return fail("unit_publication_binding", "units", rowIndex);
    if (
      unit.currentEffect?.phase === "active" &&
      (unit.currentEffect.target.repo.toLowerCase() !== row.instance.repo.toLowerCase() ||
        unit.currentEffect.target.ref !== unit.branch ||
        unit.currentEffect.target.pr !== unit.pr?.number)
    )
      return fail("unit_effect_binding", "units", rowIndex);
    if (!sameRepo(row.instance.repo)) continue;
    const held =
      unitHoldsPulls(unit, row.instance) ||
      unit.currentEffect?.calls.some(
        (call) =>
          call.operation === "spawn" &&
          call.state === "accepted" &&
          rows.runs.some((run) => run.live === true && run.runId === call.runId),
      );
    if (
      held &&
      (matches(unit.pr?.number, unit.branch) ||
        matches(unit.resume?.pr) ||
        matches(unit.publication?.pr, unit.publication?.publicationRef) ||
        matches(undefined, unit.publication?.headRef) ||
        matches(unit.adoption?.pr?.number) ||
        (unit.currentEffect?.phase === "active" &&
          matches(unit.currentEffect.target.pr, unit.currentEffect.target.ref)))
    )
      add(unitOwner(unit));
  }
  // The first coding child pushes before its coordinator creates the PR.
  // Its missing branch-to-PR mapping is not an unknown write when native
  // receipts and the original unit's admission identify the sole owner.
  const initialCodingOwner = (
    run: PullOwnershipRows["runs"][number],
  ): { owner: Extract<PullOwner, { kind: "unit" }>; ref: string; holds: boolean } | undefined => {
    const refuse = (predicate: InitialOwnerPredicate): undefined => {
      if (diagnostics?.qualifyRecord) {
        try {
          diagnostics.qualificationSnapshot = pullOwnerQualificationSnapshot(target, run, rows.units, predicate);
        } catch {
          diagnostics.qualificationSnapshot = undefined;
        }
      }
      return undefined;
    };
    const record = run.record;
    if (run.live || !isRunWorkOwner(record) || record.id !== run.runId || record.repo !== run.repo)
      return refuse("record_identity");
    const terminal = record as typeof record & {
      agent?: unknown;
      status?: unknown;
      provisional?: unknown;
      publicationSettlement?: unknown;
    };
    if (
      terminal.agent !== "coding" ||
      (terminal.provisional !== undefined && terminal.provisional !== false) ||
      !["completed", "failed", "interrupted", "stopped_soft", "stopped_hard"].includes(String(terminal.status))
    )
      return refuse("terminal_coding");
    const publication = branchPublicationOf(run.publication, record.repo);
    if (
      !publication ||
      publication.complete ||
      publication.pending ||
      publication.branches.length ||
      publication.targets?.length
    )
      return refuse("publication_shape");
    if (run.door !== undefined && run.door !== null) {
      const door = doorPublicationOf(run.door);
      if (!door || (door.outcome !== "rejected" && door.outcome !== "not_forwarded")) return refuse("door_intent");
    }
    const bound = initialOwnerUnits(record, rows.units);
    if (bound.length !== 1) return refuse("canonical_unit");
    const { instance, unit } = bound[0] as { instance: CoordinatorInstance; unit: CoordinatorUnit };
    const proof = publicationSettlementForRun(terminal.publicationSettlement, record);
    const full = { ...record, branchPublication: run.publication, branchPushReceipts: run.pushReceipts };
    const audited =
      unit.adoption?.audit &&
      isHistoricalNativeAudit(unit.adoption.audit) &&
      unit.adoption.runId === run.runId &&
      unit.adoption.requester === instance.userId &&
      unit.adoption.threadKey === (unit.threadKey ?? instance.threadKey) &&
      isHistoricalOwnerRecord(full) &&
      run.historicalEvents !== undefined
        ? historicalNativeChain({ instance, unit, record: full, events: run.historicalEvents }, true)
        : undefined;
    const audit = unit.adoption?.audit;
    const historical =
      audited &&
      audit &&
      audit.head === audited.head &&
      audit.firstHead === audited.firstHead &&
      audit.eventCount === (full as { eventCount?: unknown }).eventCount &&
      unit.adoption?.headSha === audited.head;
    const accepted = proof?.checkpoint.kind === "created" && proof.publication.kind === "accepted";
    const branch = historical ? unit.branch : proof?.binding.branch;
    const head = historical
      ? audited.head
      : proof?.publication.kind === "accepted"
        ? proof.publication.head
        : undefined;
    const firstHead = historical ? audited.firstHead : proof?.binding.baseHeadSha;
    const pushes = branchPushReceiptsOf(run.pushReceipts);
    if (
      (!accepted && !historical) ||
      !branch ||
      !head ||
      pushes?.length !== 1 ||
      pushes[0]?.ref !== branch ||
      pushes[0].sha !== head
    )
      return refuse(!accepted && !historical ? "native_confirmation" : "native_receipt");
    const effect = unit.currentEffect;
    if (
      instance.kind !== "ship" ||
      record.coordinatorAttempt !== (instance.attempt ?? 0) ||
      record.idempotencyKey !== `${instance.id}:${unit.unit}/0/coding` ||
      instance.repo !== record.repo ||
      instance.userId !== record.userId ||
      instance.channelId !== record.channelId ||
      (unit.threadKey ?? instance.threadKey) !== record.threadKey ||
      unit.branch !== branch ||
      (effect !== undefined && effect.target.base !== instance.base)
    )
      return refuse("owner_binding");
    const admitted =
      effect?.id === `${unit.unit}/0/coding` &&
      effect.phase === "settled" &&
      effect.calls.length === 1 &&
      effect.execution.workflowId === instance.id &&
      effect.execution.recoveryActionId === undefined &&
      effect.execution.maintenance === undefined &&
      effect.target.ref === unit.branch &&
      effect.target.repo === instance.repo &&
      (firstHead === undefined || effect.target.headSha === firstHead) &&
      effect.calls.some((call) => call.operation === "spawn" && call.state === "accepted" && call.runId === run.runId);
    const publishing =
      effect?.id === `${unit.unit}/0/coding/pr-check` &&
      effect.target.ref === unit.branch &&
      effect.target.repo === instance.repo &&
      effect.target.headSha === head;
    const mapped = unit.publication?.headRef === unit.branch && unit.publication.repo === instance.repo;
    if (
      !admitted &&
      !publishing &&
      !mapped &&
      (unit.recovery?.kind !== "coding" || unit.recovery.codingRunId !== run.runId)
    )
      return refuse("unit_authority");
    return {
      owner: unitOwner(unit),
      ref: branch,
      holds: unitHoldsPulls(unit, instance),
    };
  };
  for (const [rowIndex, run] of rows.runs.entries()) {
    const origin = diagnostics?.runOrigins?.[rowIndex];
    if (typeof run.runId !== "string" || !run.runId || typeof run.live !== "boolean")
      return fail("run_shape", origin?.source ?? "runs", origin?.rowIndex ?? rowIndex);
    if (run.publication !== undefined) {
      const publication = branchPublicationOf(run.publication, typeof run.repo === "string" ? run.repo : undefined);
      if (!publication || (!publication.complete && publication.repo === undefined))
        return fail("run_publication", origin?.source ?? "runs", origin?.rowIndex ?? rowIndex);
      if (publication.repo && sameRepo(publication.repo)) {
        if (!publication.complete && !publication.pending) {
          const owner = initialCodingOwner(run);
          if (!owner) return fail("run_initial_coding_owner", origin?.source ?? "runs", origin?.rowIndex ?? rowIndex);
          if (owner.holds && matches(undefined, owner.ref)) add(owner.owner);
          continue;
        }
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
      if (!door) return fail("run_door", origin?.source ?? "runs", origin?.rowIndex ?? rowIndex);
      const update = door.update;
      if (door.outcome === "rejected" || door.outcome === "not_forwarded") continue;
      if (sameRepo(door.repo) && matches(door.pr as number | undefined, update.ref))
        add({ kind: "run", runId: run.runId });
    }
  }
  for (const [rowIndex, value] of (rows.settlements ?? []).entries()) {
    const settlement = workspaceSettlementOf(value);
    if (!settlement) return fail("settlement_shape", "settlements", rowIndex);
    const publication = settlement.publication;
    if (!publication || publication.complete) continue;
    if (!publication.repo) return fail("settlement_repository", "settlements", rowIndex);
    if (!sameRepo(publication.repo)) continue;
    if (!publication.pending) {
      const run = rows.runs.find((run) => run.runId === settlement.owner.runId);
      const owner = run && initialCodingOwner(run);
      const proof = publicationSettlementForRun(settlement.record.publicationSettlement, settlement.record);
      const historical =
        proof?.checkpoint.kind === "clean" &&
        proof.binding.generation === settlement.owner.ownerGen &&
        settlement.binding?.ref === proof.binding.branch &&
        (settlement.binding.publicationBaseSha === undefined ||
          settlement.binding.publicationBaseSha === proof.binding.baseHeadSha) &&
        (rows.settlements ?? []).filter((value) => {
          const candidate = workspaceSettlementOf(value);
          return (
            candidate?.owner.runId === settlement.owner.runId &&
            JSON.stringify(candidate.record.publicationSettlement) ===
              JSON.stringify(settlement.record.publicationSettlement) &&
            JSON.stringify(candidate.publication) === JSON.stringify(settlement.publication)
          );
        }).length === 1 &&
        rows.units.some(
          (row) =>
            isCoordinatorUnit(row.unit) &&
            row.unit.adoption?.audit !== undefined &&
            row.unit.adoption.runId === run?.runId &&
            row.unit.adoption.headSha === (proof.checkpoint.kind === "clean" ? proof.checkpoint.head : undefined),
        );
      if (
        !owner ||
        !proof ||
        (proof.publication.kind !== "accepted" && !historical) ||
        !run ||
        JSON.stringify(settlement.publication) !== JSON.stringify(run.publication) ||
        JSON.stringify(settlement.record.publicationSettlement) !==
          JSON.stringify((run.record as { publicationSettlement?: unknown }).publicationSettlement)
      )
        return fail("settlement_initial_coding_owner", "settlements", rowIndex);
      if (owner.holds && matches(undefined, proof.binding.branch)) add(owner.owner);
      continue;
    }
    if (
      sameRepo(publication.repo) &&
      (matches(publication.pending.pr, publication.pending.ref) ||
        publication.branches.some((b) => matches(b.pr, b.ref)) ||
        publication.targets?.some((t) => matches(t.pr, t.ref)))
    )
      add({ kind: "run", runId: settlement.owner.runId });
  }
  for (const [rowIndex, value] of rows.effects.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail("effect_shape", "effects", rowIndex);
    const effect = value as Record<string, unknown>;
    if (typeof effect.id !== "string" || !effect.id) return fail("effect_identity", "effects", rowIndex);
    if (effect.kind === "coordinator_reconcile") {
      if (!isCoordinatorReconcileEffect(effect)) return fail("effect_reconciliation", "effects", rowIndex);
      const bound = rows.units.filter(
        (row) =>
          isCoordinatorInstance(row.instance) &&
          isCoordinatorUnit(row.unit) &&
          row.instance.id === effect.instanceId &&
          row.unit.instanceId === effect.instanceId &&
          row.unit.unit === effect.unit,
      );
      if (bound.length !== 1) return fail("effect_unit_binding", "effects", rowIndex);
      const { instance, unit } = bound[0] as { instance: CoordinatorInstance; unit: CoordinatorUnit };
      if (
        unitPullTargets(instance, unit).some(
          (candidate) => sameRepo(candidate.repo) && matches(candidate.pr, candidate.ref),
        )
      )
        add({
          kind: "unit",
          instanceId: instance.id,
          unit: unit.unit,
          ...(unit.recovery ? { actionId: unit.recovery.actionId } : {}),
        });
      continue;
    }
    if (["admit", "probe", "steer", "reissue"].includes(effect.kind as string)) continue;
    if (!["retitle", "pr_open", "rebase_round"].includes(effect.kind as string) || !isPublicationRepo(effect.repo))
      return fail("effect_kind", "effects", rowIndex);
    if (
      effect.kind === "pr_open"
        ? typeof effect.branch !== "string" || !effect.branch
        : !Number.isSafeInteger(effect.number) || (effect.number as number) < 1
    )
      return fail("effect_target", "effects", rowIndex);
    if (sameRepo(effect.repo) && matches(effect.number as number | undefined, effect.branch as string | undefined))
      add({ kind: "effect", id: effect.id });
  }
  return { ok: true, owners: [...owners.values()] };
}

/** Diagnostic data only: a malformed optional payload never clears ownership. */
export function pullOwnerReadDiagnosticFrom(value: unknown): PullOwnerReadDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) => !["version", "stage", "cause", "source", "rowIndex", "rowsRead", "sourceBytes"].includes(key),
    ) ||
    v.version !== 1 ||
    !PULL_OWNERSHIP_CHECKS.includes(v.stage as PullOwnershipCheck) ||
    !["row-limit", "byte-limit", "json", "shape", "historical", "validation", "read"].includes(v.cause as string) ||
    !Number.isSafeInteger(v.rowsRead) ||
    Number(v.rowsRead) < 0 ||
    Number(v.rowsRead) > PULL_OWNER_SCAN_MAX + 1 ||
    !Number.isSafeInteger(v.sourceBytes) ||
    Number(v.sourceBytes) < 0 ||
    (v.source !== undefined &&
      !["units", "runs", "live_runs", "settlements", "effects"].includes(v.source as string)) ||
    (v.rowIndex !== undefined &&
      (v.source === undefined ||
        !Number.isSafeInteger(v.rowIndex) ||
        Number(v.rowIndex) < 0 ||
        Number(v.rowIndex) > PULL_OWNER_SCAN_MAX))
  )
    return;
  return {
    version: 1,
    stage: v.stage as PullOwnershipCheck,
    cause: v.cause as PullOwnerDiagnosticCause,
    rowsRead: Number(v.rowsRead),
    sourceBytes: Number(v.sourceBytes),
    ...(v.source !== undefined ? { source: v.source as PullOwnershipSource } : {}),
    ...(v.rowIndex !== undefined ? { rowIndex: Number(v.rowIndex) } : {}),
  };
}

export function pullOwnerReadDiagnosticFor(
  diagnostics: PullOwnershipDiagnostics,
  fallback: "read" | "validation",
): PullOwnerReadDiagnostic | undefined {
  const stage = diagnostics.failure?.check ?? "ownership_scan";
  const position = diagnostics.failure?.source ? diagnostics.failure : diagnostics.cursor;
  const cause =
    stage === "inventory_byte_limit"
      ? "byte-limit"
      : stage === "inventory_row_limit" || stage === "inventory_limit"
        ? "row-limit"
        : (diagnostics.cause ?? (stage.startsWith("inventory_") && diagnostics.failure ? "shape" : fallback));
  return pullOwnerReadDiagnosticFrom({
    version: 1,
    stage,
    cause,
    rowsRead: diagnostics.scan?.rowsRead ?? 0,
    sourceBytes: diagnostics.scan?.sourceBytes ?? 0,
    ...(position?.source ? { source: position.source } : {}),
    ...(position?.rowIndex !== undefined ? { rowIndex: position.rowIndex } : {}),
  });
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
