import { childPresetOfStep } from "./recoveryStep.js";
import { RUN_ID_PATTERN } from "../runRecord.js";
import { isPublicationRepo } from "../branchPublication.js";
import { isMaintenanceExecution, type MaintenanceExecution } from "./maintenanceIdentity.js";
import {
  INSTANCE_ID_PATTERN,
  isCoordinatorUnit,
  hasUnitEffectCapacity,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";

/** One bounded action on the existing unit, retained through unknown call outcomes. */
export interface UnitEffectExecution {
  workflowId?: string;
  recoveryActionId?: string;
  maintenance?: MaintenanceExecution;
}
export interface UnitEffectTarget {
  repo: string;
  ref: string;
  base: string;
  headSha: string;
  pr?: number;
}
export type UnitEffectOperation =
  | "spawn"
  | "branch_create"
  | "merge"
  | "enqueue"
  | "rebase_push"
  | "pull_create"
  | "pull_close"
  | "pull_reopen"
  | "actions_rerun"
  | "check_rerequest"
  | "approval_reset"
  | "review_anchor";
export type UnitEffectCompletionOutcome =
  | { state: "accepted"; commitSha?: string; runId?: string; pr?: { number: number; url: string } }
  | { state: "refused"; cause: "external_refused" }
  | { state: "uncertain" };
export type UnitEffectOutcome = UnitEffectCompletionOutcome | { state: "refused"; cause: "not_started" };
export type UnitEffectCall = { operation: UnitEffectOperation; resourceId?: number; agent?: "coding" } & (
  { state: "unstarted" | "pending" } | UnitEffectOutcome
);
export interface UnitCurrentEffect {
  version: 1;
  id: string;
  ordinal: number;
  execution: UnitEffectExecution;
  target: UnitEffectTarget;
  phase: "active" | "settled";
  /** A maintenance owner reserves before local preparation; begin cannot cross this marker. */
  preparation?: "reserved";
  calls: readonly UnitEffectCall[];
}
export type UnitEffectTransition = { expected: CoordinatorUnit; execution: UnitEffectExecution } & (
  | { kind: "admit"; effect: UnitCurrentEffect }
  | { kind: "prepare"; effect: UnitCurrentEffect }
  | { kind: "publish"; effectId: string }
  | { kind: "begin"; effectId: string; call: number }
  | { kind: "cancel"; effectId: string; call: number }
  | { kind: "complete"; effectId: string; call: number; outcome: UnitEffectCompletionOutcome }
  | {
      kind: "resolve";
      effectId: string;
      call: number;
      observation:
        | { kind: "branch_ref"; repo: string; ref: string; headSha: string }
        | { kind: "spawn_run"; runId: string }
        | {
            kind: "pull_merged";
            repo: string;
            ref: string;
            base: string;
            pr: number;
            headSha: string;
            commitSha: string;
          }
        | {
            kind: "pull_enqueued" | "pull_dequeued";
            repo: string;
            ref: string;
            base: string;
            pr: number;
            headSha: string;
          };
    }
  | { kind: "settle"; effectId: string }
);
export type UnitEffectRefusal =
  "stale" | "stopped" | "execution" | "busy" | "uncertain" | "conflict" | "owned" | "incomplete" | "unavailable";
export type UnitEffectTransitionResult = { ok: true; unit: CoordinatorUnit } | { ok: false; reason: UnitEffectRefusal };
export const UNIT_EFFECT_MAX_CALLS = 32;
export const UNIT_EFFECT_MAX_BYTES = 8 * 1024;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/i.test(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameExecution = (a: UnitEffectExecution | undefined, b: UnitEffectExecution | undefined): boolean => {
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, part: unknown) =>
      object(part)
        ? Object.fromEntries(Object.entries(part).sort(([left], [right]) => left.localeCompare(right)))
        : part,
    );
  return canonical(a) === canonical(b);
};
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((key) => allowed.includes(key));
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
export function isUnitEffectExecution(v: unknown): v is UnitEffectExecution {
  return (
    object(v) &&
    keys(v, ["workflowId", "recoveryActionId", "maintenance"]) &&
    (v.maintenance !== undefined
      ? v.workflowId === undefined && v.recoveryActionId === undefined && isMaintenanceExecution(v.maintenance)
      : typeof v.workflowId === "string" &&
        INSTANCE_ID_PATTERN.test(v.workflowId) &&
        (v.recoveryActionId === undefined ||
          (typeof v.recoveryActionId === "string" && /^r_[a-f0-9]{64}$/.test(v.recoveryActionId))))
  );
}
const operations: readonly UnitEffectOperation[] = [
  "spawn",
  "branch_create",
  "merge",
  "enqueue",
  "rebase_push",
  "pull_create",
  "pull_close",
  "pull_reopen",
  "actions_rerun",
  "check_rerequest",
  "approval_reset",
  "review_anchor",
];
export function isUnitEffectOutcome(v: unknown): v is UnitEffectOutcome {
  if (!object(v)) return false;
  if (v.state === "uncertain") return keys(v, ["state"]);
  if (v.state === "refused")
    return keys(v, ["state", "cause"]) && (v.cause === "external_refused" || v.cause === "not_started");
  return (
    v.state === "accepted" &&
    keys(v, ["state", "commitSha", "runId", "pr"]) &&
    (v.commitSha === undefined || sha(v.commitSha)) &&
    (v.runId === undefined || (typeof v.runId === "string" && RUN_ID_PATTERN.test(v.runId))) &&
    (v.pr === undefined ||
      (object(v.pr) &&
        keys(v.pr, ["number", "url"]) &&
        positive(v.pr.number) &&
        typeof v.pr.url === "string" &&
        v.pr.url.length > 0 &&
        v.pr.url.length <= 2048))
  );
}
function isUnitEffectCompletionOutcome(v: unknown): v is UnitEffectCompletionOutcome {
  return isUnitEffectOutcome(v) && (v.state !== "refused" || v.cause === "external_refused");
}

function validOperationOutcome(operation: UnitEffectOperation | undefined, outcome: UnitEffectOutcome): boolean {
  if (outcome.state !== "accepted") return true;
  if (operation === "pull_create")
    return sha(outcome.commitSha) && outcome.runId === undefined && outcome.pr !== undefined;
  if (outcome.pr !== undefined) return false;
  return operation === "merge"
    ? sha(outcome.commitSha) && outcome.runId === undefined
    : operation === "enqueue"
      ? outcome.commitSha === undefined && outcome.runId === undefined
      : true;
}

export function isUnitCurrentEffect(v: unknown): v is UnitCurrentEffect {
  if (
    !object(v) ||
    !keys(v, ["version", "id", "ordinal", "execution", "target", "phase", "preparation", "calls"]) ||
    v.version !== 1 ||
    !text(v.id) ||
    !positive(v.ordinal) ||
    !isUnitEffectExecution(v.execution) ||
    (v.preparation !== undefined &&
      (v.preparation !== "reserved" || v.phase !== "active" || v.execution.maintenance === undefined)) ||
    !object(v.target) ||
    !keys(v.target, ["repo", "ref", "base", "headSha", "pr"]) ||
    !isPublicationRepo(v.target.repo) ||
    !text(v.target.ref) ||
    !text(v.target.base) ||
    !sha(v.target.headSha) ||
    (v.target.pr !== undefined && !positive(v.target.pr)) ||
    (v.phase !== "active" && v.phase !== "settled") ||
    !Array.isArray(v.calls) ||
    v.calls.length < 1 ||
    v.calls.length > UNIT_EFFECT_MAX_CALLS
  )
    return false;
  if (
    v.preparation === "reserved" &&
    (v.calls.length !== 1 || !same(v.calls[0], { operation: "rebase_push", state: "unstarted" }))
  )
    return false;
  for (const call of v.calls) {
    if (
      !object(call) ||
      !keys(call, ["operation", "resourceId", "agent", "state", "commitSha", "runId", "pr", "cause"]) ||
      !operations.includes(call.operation as UnitEffectOperation) ||
      (call.operation === "actions_rerun" || call.operation === "check_rerequest"
        ? !positive(call.resourceId)
        : call.resourceId !== undefined)
    )
      return false;
    if (
      call.agent !== undefined &&
      (call.agent !== "coding" ||
        call.operation !== "spawn" ||
        !v.execution.maintenance ||
        v.calls.length !== 1 ||
        (v.execution.maintenance.bounds.spendCapUsd ?? 0) <= 0)
    )
      return false;
    const { operation: _operation, resourceId: _resource, agent: _agent, ...outcome } = call;
    if (!(same(outcome, { state: "unstarted" }) || same(outcome, { state: "pending" }) || isUnitEffectOutcome(outcome)))
      return false;
    if (isUnitEffectOutcome(outcome) && !validOperationOutcome(call.operation as UnitEffectOperation, outcome))
      return false;
    if (
      call.agent === "coding" &&
      outcome.state === "accepted" &&
      (outcome.runId === undefined || outcome.commitSha !== undefined || outcome.pr !== undefined)
    )
      return false;
    if (call.operation === "enqueue" && v.calls.length !== 1) return false;
    if (v.phase === "settled" && call.state !== "accepted" && call.state !== "refused") return false;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(v)).byteLength <= UNIT_EFFECT_MAX_BYTES;
  } catch {
    return false;
  }
}
export function isUnitEffectTransition(v: unknown): v is UnitEffectTransition {
  if (!object(v) || !isCoordinatorUnit(v.expected) || !isUnitEffectExecution(v.execution)) return false;
  if (v.kind === "admit" || v.kind === "prepare")
    return keys(v, ["expected", "execution", "kind", "effect"]) && isUnitCurrentEffect(v.effect);
  if (!text(v.effectId)) return false;
  if (v.kind === "settle" || v.kind === "publish") return keys(v, ["expected", "execution", "kind", "effectId"]);
  return (
    (v.kind === "begin" || v.kind === "cancel" || v.kind === "complete" || v.kind === "resolve") &&
    Number.isSafeInteger(v.call) &&
    (v.call as number) >= 0 &&
    keys(v, [
      "expected",
      "execution",
      "kind",
      "effectId",
      "call",
      ...(v.kind === "complete" ? ["outcome"] : v.kind === "resolve" ? ["observation"] : []),
    ]) &&
    (v.kind !== "complete" ||
      (isUnitEffectCompletionOutcome(v.outcome) &&
        validOperationOutcome(v.expected.currentEffect?.calls[v.call as number]?.operation, v.outcome))) &&
    (v.kind !== "resolve" ||
      (object(v.observation) &&
        ((v.observation.kind === "branch_ref" &&
          keys(v.observation, ["kind", "repo", "ref", "headSha"]) &&
          isPublicationRepo(v.observation.repo) &&
          text(v.observation.ref) &&
          sha(v.observation.headSha)) ||
          (v.observation.kind === "spawn_run" &&
            keys(v.observation, ["kind", "runId"]) &&
            typeof v.observation.runId === "string" &&
            RUN_ID_PATTERN.test(v.observation.runId)) ||
          (["pull_merged", "pull_enqueued", "pull_dequeued"].includes(v.observation.kind as string) &&
            keys(v.observation, [
              "kind",
              "repo",
              "ref",
              "base",
              "pr",
              "headSha",
              ...(v.observation.kind === "pull_merged" ? ["commitSha"] : []),
            ]) &&
            isPublicationRepo(v.observation.repo) &&
            text(v.observation.ref) &&
            text(v.observation.base) &&
            positive(v.observation.pr) &&
            sha(v.observation.headSha) &&
            (v.observation.kind !== "pull_merged" || sha(v.observation.commitSha))))))
  );
}
export function isUnitEffectTransitionResult(v: unknown): v is UnitEffectTransitionResult {
  return (
    object(v) &&
    (v.ok === true
      ? keys(v, ["ok", "unit"]) && isCoordinatorUnit(v.unit)
      : v.ok === false && keys(v, ["ok", "reason"]) && isUnitEffectRefusal(v.reason))
  );
}
export function isUnitEffectRefusal(v: unknown): v is UnitEffectRefusal {
  return [
    "stale",
    "stopped",
    "execution",
    "busy",
    "uncertain",
    "conflict",
    "owned",
    "incomplete",
    "unavailable",
  ].includes(v as string);
}
/** Reserve the largest closed receipt for every unstarted call before admission. */
export function reserveUnitEffectOutcomes(effect: UnitCurrentEffect): UnitCurrentEffect {
  return {
    ...effect,
    phase: "settled",
    calls: effect.calls.map((call) => ({
      operation: call.operation,
      ...(call.agent === undefined ? {} : { agent: call.agent }),
      ...(call.resourceId === undefined ? {} : { resourceId: call.resourceId }),
      state: "accepted" as const,
      commitSha: "a".repeat(40),
      runId: "r".repeat(64),
      ...(call.operation === "pull_create" ? { pr: { number: Number.MAX_SAFE_INTEGER, url: "u".repeat(2048) } } : {}),
    })),
  };
}

function observationMatches(
  effect: UnitCurrentEffect,
  call: UnitEffectCall,
  proof: Extract<UnitEffectTransition, { kind: "resolve" }>["observation"],
): boolean {
  if (
    effect.phase !== "active" ||
    (call.state !== "pending" &&
      call.state !== "uncertain" &&
      !(
        call.operation === "enqueue" &&
        call.state === "accepted" &&
        (proof.kind === "pull_merged" || proof.kind === "pull_dequeued")
      ))
  )
    return false;
  if (proof.kind === "spawn_run") return call.operation === "spawn";
  if (proof.kind === "pull_merged" || proof.kind === "pull_enqueued" || proof.kind === "pull_dequeued")
    return (
      (proof.kind === "pull_merged" ? ["merge", "enqueue"].includes(call.operation) : call.operation === "enqueue") &&
      (proof.kind !== "pull_dequeued" || call.state === "accepted") &&
      proof.pr === effect.target.pr &&
      proof.base === effect.target.base &&
      proof.ref === effect.target.ref &&
      proof.repo.toLowerCase() === effect.target.repo.toLowerCase() &&
      proof.headSha.toLowerCase() === effect.target.headSha.toLowerCase()
    );
  return (
    call.operation === "branch_create" &&
    proof.repo.toLowerCase() === effect.target.repo.toLowerCase() &&
    proof.ref === effect.target.ref &&
    proof.headSha.toLowerCase() === effect.target.headSha.toLowerCase()
  );
}

function observationOutcome(
  proof: Extract<UnitEffectTransition, { kind: "resolve" }>["observation"],
  call: UnitEffectCall,
): UnitEffectCompletionOutcome {
  return proof.kind === "spawn_run"
    ? { state: "accepted", runId: proof.runId }
    : call.operation === "enqueue"
      ? { state: "accepted" }
      : { state: "accepted", commitSha: proof.kind === "pull_merged" ? proof.commitSha : proof.headSha };
}

/** Private facts read by the existing run owner, never supplied by a caller. */
export interface UnitEffectRunEvidence {
  runId: string;
  startedAt: number;
  meta: unknown;
  /** Original resolved review target; a terminal summary describes later workspace facts. */
  reviewTarget: unknown;
  tags: readonly unknown[];
}
/** A provisional close may coexist with its live claim, but cannot replace it. */
export function unitEffectTombstoneMatches(meta: unknown, startedAt: number, record: unknown): boolean {
  if (!object(meta) || !object(record) || record.provisional !== true || record.startedAt !== startedAt) return false;
  return [
    "agent",
    "hosted",
    "channelId",
    "userId",
    "authenticatedAs",
    "postedBy",
    "threadKey",
    "repo",
    "parentInstanceId",
    "coordinatorUnit",
    "maintenanceActionId",
    "coordinatorAttempt",
    "idempotencyKey",
  ].every((field) => same(meta[field], record[field]));
}
export function unitEffectRunId(input: UnitEffectTransition): string | undefined {
  if (input.kind === "resolve" && input.observation.kind === "spawn_run") return input.observation.runId;
  if (
    input.kind === "complete" &&
    input.expected.currentEffect?.calls[input.call]?.operation === "spawn" &&
    input.outcome.state === "accepted"
  )
    return input.outcome.runId;
}
function spawnEvidenceRefusal(
  instance: CoordinatorInstance,
  unit: CoordinatorUnit,
  effect: UnitCurrentEffect,
  runId: string | undefined,
  evidence: UnitEffectRunEvidence | undefined,
): UnitEffectRefusal | undefined {
  if (!evidence) return "unavailable";
  if (!object(evidence.meta) || evidence.tags.length !== 1 || !object(evidence.tags[0])) return "incomplete";
  const meta = evidence.meta,
    tag = evidence.tags[0],
    reviewTarget = evidence.reviewTarget;
  const spawnIndex = effect.calls.findIndex((call) => call.operation === "spawn");
  const priorPush = effect.calls
    .slice(0, spawnIndex)
    .filter((call) => call.operation === "rebase_push")
    .at(-1);
  const deltaReview =
    spawnIndex > 0 &&
    effect.calls.filter((call) => call.operation === "spawn").length === 1 &&
    effect.calls.slice(0, spawnIndex).every((call) => call.state === "accepted") &&
    priorPush?.state === "accepted" &&
    sha(priorPush.commitSha);
  const modelRound =
    effect.execution.maintenance !== undefined &&
    effect.calls.length === 1 &&
    effect.calls[0]?.operation === "spawn" &&
    effect.calls[0].agent === "coding";
  const expectedAgent = modelRound ? "coding" : deltaReview ? "review" : childPresetOfStep(effect.id);
  const expectedHead = deltaReview && priorPush?.state === "accepted" ? priorPush.commitSha! : effect.target.headSha;
  const thread = meta.agent === "review" ? (unit.reviewThread?.threadKey ?? unit.threadKey) : unit.threadKey;
  if (
    evidence.runId !== runId ||
    !Number.isFinite(evidence.startedAt) ||
    (effect.execution.maintenance === undefined && evidence.startedAt < instance.createdAt) ||
    expectedAgent === undefined ||
    meta.agent !== expectedAgent ||
    (effect.execution.maintenance
      ? meta.maintenanceActionId !== effect.execution.maintenance.id ||
        tag.maintenanceActionId !== effect.execution.maintenance.id
      : meta.maintenanceActionId !== undefined || tag.maintenanceActionId !== undefined) ||
    (meta.agent === "review" &&
      (effect.target.pr === undefined ||
        !object(reviewTarget) ||
        reviewTarget.pr !== effect.target.pr ||
        typeof reviewTarget.repo !== "string" ||
        reviewTarget.repo.toLowerCase() !== effect.target.repo.toLowerCase() ||
        reviewTarget.ref !== effect.target.ref ||
        typeof reviewTarget.headSha !== "string" ||
        reviewTarget.headSha.toLowerCase() !== expectedHead.toLowerCase())) ||
    meta.hosted !== undefined ||
    meta.channelId !== instance.channelId ||
    meta.userId !== instance.userId ||
    meta.authenticatedAs !== instance.authenticatedAs ||
    meta.postedBy !== instance.postedBy ||
    meta.threadKey !== (thread ?? instance.threadKey) ||
    typeof meta.repo !== "string" ||
    meta.repo.toLowerCase() !== effect.target.repo.toLowerCase() ||
    meta.parentInstanceId !== instance.id ||
    meta.coordinatorUnit !== unit.unit ||
    meta.coordinatorAttempt !== (instance.attempt ?? 0) ||
    meta.idempotencyKey !== `${instance.id}:${effect.id}` ||
    (meta.ref !== undefined && meta.ref !== effect.target.ref) ||
    (meta.operationTarget !== undefined &&
      (!object(meta.operationTarget) ||
        typeof meta.operationTarget.repo !== "string" ||
        meta.operationTarget.repo.toLowerCase() !== effect.target.repo.toLowerCase() ||
        (meta.operationTarget.ref !== undefined && meta.operationTarget.ref !== effect.target.ref))) ||
    tag.type !== "coordinator_tag" ||
    tag.parentInstanceId !== instance.id ||
    tag.unit !== unit.unit ||
    tag.branch !== effect.target.ref ||
    tag.base !== effect.target.base ||
    (effect.execution.maintenance
      ? tag.transportWorkflowId !== undefined || (!deltaReview && !modelRound)
      : (tag.transportWorkflowId === undefined ? instance.id : tag.transportWorkflowId) !==
        effect.execution.workflowId) ||
    !same(tag.publication, unit.publication)
  )
    return "conflict";
}

function maintenanceSpawnRounds(
  unit: CoordinatorUnit,
  effect: UnitCurrentEffect,
  runId: string,
): CoordinatorUnit["rounds"] {
  const maintenance = effect.execution.maintenance!;
  return [
    ...unit.rounds,
    {
      index: Math.max(0, ...unit.rounds.map((round) => round.index)) + 1,
      agent: "coding",
      outcome: "started",
      at: maintenance.admittedAt,
      maintenance: { actionId: maintenance.id, runId, budgetUsd: maintenance.bounds.spendCapUsd! },
    },
  ];
}

/** The owner transaction supplies the current stop and unit; this planner never performs a call. */
export function planUnitEffectTransition(
  input: UnitEffectTransition,
  instance: CoordinatorInstance | null,
  current: CoordinatorUnit | undefined,
  runEvidence?: UnitEffectRunEvidence,
): UnitEffectTransitionResult {
  if (!isUnitEffectTransition(input)) return { ok: false, reason: "conflict" };
  if (!instance || !current || current.instanceId !== instance.id || !same(current, input.expected))
    return { ok: false, reason: "stale" };
  const effect = input.kind === "admit" ? input.effect : current.currentEffect;
  if (!effect || !isUnitCurrentEffect(effect)) return { ok: false, reason: "conflict" };
  if (
    !sameExecution(effect.execution, input.execution) ||
    (input.execution.maintenance
      ? input.kind === "admit" ||
        !!current.recovery ||
        !!current.recoveryHold ||
        !sameExecution(current.currentEffect?.execution, input.execution)
      : instance.kind !== "ship" ||
        effect.execution.workflowId !== (current.recovery?.workflowId ?? instance.id) ||
        effect.execution.recoveryActionId !== current.recovery?.actionId)
  )
    return { ok: false, reason: "execution" };
  const bound = current.publication;
  const acceptedRebase = effect.calls
    .filter((part) => part.operation === "rebase_push" && part.state === "accepted")
    .at(-1);
  if (
    effect.target.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    effect.target.ref !== current.branch ||
    effect.target.base !== (effect.execution.maintenance ? bound?.baseRef : (instance.base ?? "main")) ||
    effect.target.pr !== current.pr?.number ||
    (current.pr !== undefined && bound === undefined) ||
    (bound === undefined &&
      current.lastPush !== undefined &&
      (!sha(current.lastPush) || effect.target.headSha.toLowerCase() !== current.lastPush.toLowerCase())) ||
    (bound !== undefined &&
      ((effect.target.headSha.toLowerCase() !== bound.expectedHeadSha.toLowerCase() &&
        !(
          acceptedRebase?.state === "accepted" &&
          acceptedRebase.commitSha?.toLowerCase() === bound.expectedHeadSha.toLowerCase()
        )) ||
        bound.repo.toLowerCase() !== instance.repo.toLowerCase() ||
        bound.pr !== effect.target.pr ||
        bound.headRef !== effect.target.ref ||
        bound.baseRef !== effect.target.base ||
        bound.publicationRef !== effect.target.ref ||
        bound.owner.instanceId !== current.instanceId ||
        bound.owner.unit !== current.unit))
  )
    return { ok: false, reason: "conflict" };
  if (input.kind === "publish") {
    if (
      effect.id !== input.effectId ||
      !bound ||
      acceptedRebase?.state !== "accepted" ||
      !sha(acceptedRebase.commitSha) ||
      acceptedRebase.runId !== undefined ||
      acceptedRebase.pr !== undefined
    )
      return { ok: false, reason: "conflict" };
    return {
      ok: true,
      unit: {
        ...current,
        publication: { ...bound, expectedHeadSha: acceptedRebase.commitSha },
        lastPush: acceptedRebase.commitSha,
      },
    };
  }
  if (input.kind === "prepare") {
    if (instance.stop) return { ok: false, reason: "stopped" };
    const proposed = input.effect;
    if (
      effect.preparation !== "reserved" ||
      effect.phase !== "active" ||
      !sameExecution(effect.execution, proposed.execution) ||
      !same(effect.target, proposed.target) ||
      proposed.id !== effect.id ||
      proposed.ordinal !== effect.ordinal ||
      proposed.phase !== "active" ||
      proposed.preparation !== undefined ||
      proposed.calls.some((call) => call.state !== "unstarted") ||
      !(
        proposed.calls[0]?.operation === "rebase_push" ||
        (proposed.calls.length === 1 &&
          proposed.calls[0]?.operation === "spawn" &&
          proposed.calls[0].agent === "coding" &&
          (proposed.execution.maintenance?.bounds.spendCapUsd ?? 0) > 0 &&
          !current.rounds.some((round) => round.maintenance))
      ) ||
      !hasUnitEffectCapacity({ ...current, currentEffect: proposed })
    )
      return { ok: false, reason: "conflict" };
    return { ok: true, unit: { ...current, currentEffect: proposed } };
  }
  if (input.kind === "admit") {
    if (instance.stop) return { ok: false, reason: "stopped" };
    if (current.ending || current.idle) return { ok: false, reason: "execution" };
    if (current.currentEffect?.phase === "active") return { ok: false, reason: "busy" };
    if (
      effect.ordinal !== (current.currentEffect?.ordinal ?? 0) + 1 ||
      current.currentEffect?.id === effect.id ||
      effect.phase !== "active" ||
      !hasUnitEffectCapacity({ ...current, currentEffect: effect }) ||
      effect.calls.some((call) => call.state !== "unstarted")
    )
      return { ok: false, reason: "conflict" };
    return { ok: true, unit: { ...current, currentEffect: effect } };
  }
  if (effect.id !== input.effectId || effect.phase !== "active") return { ok: false, reason: "conflict" };
  if (input.kind === "settle") {
    if (
      effect.calls.some(
        (call) =>
          (call.state !== "accepted" && call.state !== "refused") ||
          (call.operation === "enqueue" && call.state === "accepted"),
      )
    )
      return { ok: false, reason: "uncertain" };
    return { ok: true, unit: { ...current, currentEffect: { ...effect, phase: "settled" } } };
  }
  if (!Number.isSafeInteger(input.call) || input.call < 0 || !effect.calls[input.call])
    return { ok: false, reason: "conflict" };
  const call = effect.calls[input.call]!;
  if (input.kind === "cancel") {
    if (call.state !== "unstarted") return { ok: false, reason: "uncertain" };
    return {
      ok: true,
      unit: {
        ...current,
        currentEffect: {
          ...effect,
          ...(effect.preparation === "reserved" ? { preparation: undefined } : {}),
          calls: effect.calls.map((part, index) =>
            index === input.call
              ? {
                  operation: part.operation,
                  ...(part.agent === undefined ? {} : { agent: part.agent }),
                  ...(part.resourceId === undefined ? {} : { resourceId: part.resourceId }),
                  state: "refused",
                  cause: "not_started",
                }
              : part,
          ),
        },
      },
    };
  }
  if (input.kind === "begin") {
    if (effect.preparation === "reserved") return { ok: false, reason: "conflict" };
    const restoreAcceptedClose =
      input.call === 1 &&
      effect.calls.length === 2 &&
      effect.calls[0]?.operation === "pull_close" &&
      effect.calls[0].state === "accepted" &&
      call.operation === "pull_reopen";
    if (instance.stop && !restoreAcceptedClose) return { ok: false, reason: "stopped" };
    if ((current.ending || current.idle) && !restoreAcceptedClose && !effect.execution.maintenance)
      return { ok: false, reason: "execution" };
    // A pending receipt cannot prove whether its caller crossed the external boundary.
    if (effect.calls.some((part) => part.state === "pending" || part.state === "uncertain"))
      return { ok: false, reason: "uncertain" };
    if (call.state !== "unstarted") return { ok: false, reason: "conflict" };
    return {
      ok: true,
      unit: {
        ...current,
        currentEffect: {
          ...effect,
          calls: effect.calls.map((part, index) => (index === input.call ? { ...part, state: "pending" } : part)),
        },
      },
    };
  }
  if (input.kind === "resolve") {
    const proof = input.observation;
    if (!observationMatches(effect, call, proof)) return { ok: false, reason: "conflict" };
    if (proof.kind === "spawn_run") {
      const reason = spawnEvidenceRefusal(instance, current, effect, proof.runId, runEvidence);
      if (reason) return { ok: false, reason };
    }
    return {
      ok: true,
      unit: {
        ...current,
        ...(call.agent === "coding" && proof.kind === "spawn_run"
          ? { rounds: maintenanceSpawnRounds(current, effect, proof.runId) }
          : {}),
        currentEffect: {
          ...effect,
          ...(call.operation === "enqueue" &&
          (proof.kind === "pull_merged" || proof.kind === "pull_dequeued") &&
          effect.calls.length === 1
            ? { phase: "settled" as const }
            : {}),
          calls: effect.calls.map((part, index) =>
            index === input.call
              ? {
                  operation: call.operation,
                  ...(call.agent === undefined ? {} : { agent: call.agent }),
                  ...observationOutcome(
                    proof.kind === "branch_ref" ? { ...proof, headSha: effect.target.headSha } : proof,
                    call,
                  ),
                }
              : part,
          ),
        },
      },
    };
  }
  if (call.state !== "pending" || !isUnitEffectCompletionOutcome(input.outcome))
    return { ok: false, reason: "conflict" };
  if (!validOperationOutcome(call.operation, input.outcome)) return { ok: false, reason: "conflict" };
  if (call.operation === "pull_create" && input.outcome.state === "accepted") {
    const prior = effect.calls
      .slice(0, input.call)
      .filter((part) => part.operation === "rebase_push")
      .at(-1);
    const head = prior?.state === "accepted" ? prior.commitSha : effect.target.headSha;
    if (!sha(head) || input.outcome.commitSha?.toLowerCase() !== head.toLowerCase())
      return { ok: false, reason: "conflict" };
  }
  if (call.operation === "spawn" && input.outcome.state === "accepted") {
    const reason = spawnEvidenceRefusal(instance, current, effect, input.outcome.runId, runEvidence);
    if (reason) return { ok: false, reason };
  }
  const outcome = {
    ...input.outcome,
    operation: call.operation,
    ...(call.agent === undefined ? {} : { agent: call.agent }),
    ...(call.resourceId === undefined ? {} : { resourceId: call.resourceId }),
  };
  const next = {
    ...current,
    ...(call.operation === "spawn" && call.agent === "coding" && input.outcome.state === "accepted"
      ? { rounds: maintenanceSpawnRounds(current, effect, input.outcome.runId!) }
      : {}),
    currentEffect: { ...effect, calls: effect.calls.map((part, index) => (index === input.call ? outcome : part)) },
  };
  return isUnitCurrentEffect(next.currentEffect) ? { ok: true, unit: next } : { ok: false, reason: "conflict" };
}

/** A successful transport receipt proves only this requested whole-row change. */
export function unitEffectResultMatches(input: UnitEffectTransition, unit: CoordinatorUnit): boolean {
  if (!isUnitEffectTransition(input) || !isCoordinatorUnit(unit)) return false;
  if (input.kind === "publish") {
    const previous = input.expected.currentEffect;
    const push = previous?.calls.filter((call) => call.operation === "rebase_push" && call.state === "accepted").at(-1);
    return (
      !!previous &&
      previous.id === input.effectId &&
      !!input.expected.publication &&
      push?.state === "accepted" &&
      sha(push.commitSha) &&
      push.runId === undefined &&
      push.pr === undefined &&
      same(unit, {
        ...input.expected,
        publication: { ...input.expected.publication, expectedHeadSha: push.commitSha },
        lastPush: push.commitSha,
      })
    );
  }
  const chargedRun =
    input.kind === "complete" && input.outcome.state === "accepted"
      ? input.outcome.runId
      : input.kind === "resolve" && input.observation.kind === "spawn_run"
        ? input.observation.runId
        : undefined;
  const expected =
    (input.kind === "complete" || input.kind === "resolve") &&
    chargedRun !== undefined &&
    input.expected.currentEffect?.calls[input.call]?.agent === "coding"
      ? { ...input.expected, rounds: maintenanceSpawnRounds(input.expected, input.expected.currentEffect, chargedRun) }
      : input.expected;
  const { currentEffect: _before, ...expectedFields } = expected;
  const { currentEffect: effect, ...actualFields } = unit;
  if (!same(expectedFields, actualFields) || !effect) return false;
  if (input.kind === "admit" || input.kind === "prepare") return same(effect, input.effect);
  const previous = input.expected.currentEffect;
  if (!previous || previous.id !== input.effectId) return false;
  if (input.kind === "settle")
    return (
      !previous.calls.some((call) => call.operation === "enqueue" && call.state === "accepted") &&
      same(effect, { ...previous, phase: "settled" })
    );
  const call = previous.calls[input.call];
  if (!call || (input.kind === "resolve" && !observationMatches(previous, call, input.observation))) return false;
  const identity = {
    operation: call.operation,
    ...(call.agent === undefined ? {} : { agent: call.agent }),
    ...(call.resourceId === undefined ? {} : { resourceId: call.resourceId }),
  };
  const next =
    input.kind === "begin"
      ? { ...call, state: "pending" }
      : input.kind === "cancel"
        ? { ...identity, state: "refused", cause: "not_started" }
        : input.kind === "resolve"
          ? {
              ...identity,
              ...observationOutcome(
                input.observation.kind === "branch_ref"
                  ? { ...input.observation, headSha: previous.target.headSha }
                  : input.observation,
                call,
              ),
            }
          : { ...input.outcome, ...identity };
  return same(effect, {
    ...previous,
    ...(input.kind === "cancel" && previous.preparation === "reserved" ? { preparation: undefined } : {}),
    ...(input.kind === "resolve" &&
    call.operation === "enqueue" &&
    ["pull_merged", "pull_dequeued"].includes(input.observation.kind) &&
    previous.calls.length === 1
      ? { phase: "settled" }
      : {}),
    calls: previous.calls.map((part, index) => (index === input.call ? next : part)),
  });
}
