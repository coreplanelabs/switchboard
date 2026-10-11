import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { sha256Hex } from "../ship/coordinator.js";
import { INSTANCE_ID_PATTERN, RUN_ID_PATTERN } from "../runIdentity.js";

export type UnitWait = { kind: "child"; runId: string } | { kind: "checks"; headSha: string } | { kind: "retry" };
export interface UnitProgress {
  version: 1;
  revision: number;
  workflowId: string;
  ownerRunId?: string;
  step: string;
  at: number;
  basis: string;
  round?: { index: number; kind: "coding" | "review" | "findings" };
  waiting?: UnitWait;
}
export interface UnitProgressInput {
  expectedRevision: number;
  step: string;
  round?: UnitProgress["round"];
  waiting?: UnitWait;
  clear?: true;
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function round(v: unknown): v is NonNullable<UnitProgress["round"]> {
  return (
    object(v) &&
    keys(v, ["index", "kind"]) &&
    count(v.index) &&
    ["coding", "review", "findings"].includes(v.kind as string)
  );
}
function wait(v: unknown): v is UnitWait {
  if (!object(v)) return false;
  return v.kind === "child"
    ? keys(v, ["kind", "runId"]) && typeof v.runId === "string" && RUN_ID_PATTERN.test(v.runId)
    : v.kind === "checks"
      ? keys(v, ["kind", "headSha"]) && typeof v.headSha === "string" && /^[a-f0-9]{40}$/.test(v.headSha)
      : v.kind === "retry" && keys(v, ["kind"]);
}
export function isUnitProgress(v: unknown): v is UnitProgress {
  return (
    object(v) &&
    keys(v, ["version", "revision", "workflowId", "ownerRunId", "step", "at", "basis", "round", "waiting"]) &&
    v.version === 1 &&
    count(v.revision) &&
    v.revision > 0 &&
    text(v.workflowId) &&
    INSTANCE_ID_PATTERN.test(v.workflowId) &&
    (v.ownerRunId === undefined || (text(v.ownerRunId) && RUN_ID_PATTERN.test(v.ownerRunId))) &&
    text(v.step) &&
    count(v.at) &&
    hash(v.basis) &&
    (v.round === undefined || round(v.round)) &&
    (v.waiting === undefined || wait(v.waiting))
  );
}
export function isUnitProgressInput(v: unknown): v is UnitProgressInput {
  return (
    object(v) &&
    keys(v, ["expectedRevision", "step", "round", "waiting", "clear"]) &&
    count(v.expectedRevision) &&
    text(v.step) &&
    (v.round === undefined || round(v.round)) &&
    (v.clear === true ? v.waiting === undefined && v.round === undefined : v.clear === undefined && wait(v.waiting))
  );
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  );
}
/** A new round, question, head, effect or ending makes old progress inert. */
export function unitProgressBasis(unit: CoordinatorUnit): string {
  const { recordedProgress: _progress, ...facts } = unit;
  return sha256Hex(canonical(facts));
}
export function currentUnitProgress(unit: CoordinatorUnit): UnitProgress | undefined {
  return unit.recordedProgress?.waiting && unit.recordedProgress.basis === unitProgressBasis(unit)
    ? unit.recordedProgress
    : undefined;
}

/** Metadata only; the caller commits the result through the original unit CAS. */
export function nextUnitProgress(
  instance: CoordinatorInstance,
  unit: CoordinatorUnit,
  workflowId: string,
  input: UnitProgressInput,
  at: number,
): { ok: true; progress: UnitProgress; replay: boolean } | { ok: false; reason: "owner" | "stale" | "ended" } {
  const owner = unit.recovery?.workflowId ?? instance.id;
  if (workflowId !== owner) return { ok: false, reason: "owner" };
  const prior = unit.recordedProgress;
  const basis = unitProgressBasis(unit);
  const latest = unit.rounds.at(-1);
  const observedRound =
    input.round ??
    (!input.clear && latest && (latest.agent === "coding" || latest.agent === "review")
      ? { index: latest.index, kind: latest.agent as "coding" | "review" }
      : undefined);
  const intended = {
    version: 1 as const,
    revision: input.expectedRevision + 1,
    workflowId,
    ...(instance.runId ? { ownerRunId: instance.runId } : {}),
    step: input.step,
    basis,
    ...(observedRound ? { round: observedRound } : {}),
    ...(input.waiting ? { waiting: input.waiting } : {}),
  };
  if (prior && canonical({ ...prior, at: undefined }) === canonical(intended))
    return { ok: true, progress: prior, replay: true };
  if ((prior?.revision ?? 0) !== input.expectedRevision || !Number.isSafeInteger(intended.revision))
    return { ok: false, reason: "stale" };
  if (instance.stop || unit.ending || unit.idle || unit.recoveryHold) return { ok: false, reason: "ended" };
  if (
    input.clear &&
    (!prior?.waiting || prior.step !== input.step || prior.workflowId !== workflowId || prior.basis !== basis)
  )
    return { ok: false, reason: "stale" };
  if (input.round && unit.rounds.at(-1)?.index !== input.round.index) return { ok: false, reason: "stale" };
  if (input.waiting?.kind === "checks" && unit.lastPush && unit.lastPush !== input.waiting.headSha)
    return { ok: false, reason: "stale" };
  return { ok: true, progress: { ...intended, at }, replay: false };
}
