import { isPublicationRepo } from "../branchPublication.js";
import {
  isCoordinatorInstance,
  isCoordinatorUnit,
  hasUnitEffectCapacity,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";
import {
  findPullOwnersInRows,
  unitPullTargets,
  PULL_OWNER_SCAN_MAX,
  PULL_OWNER_SCAN_MAX_BYTES,
  type PullOwnershipRows,
} from "./pullOwnership.js";
import {
  isUnitCurrentEffect,
  unitEffectResultMatches,
  type UnitEffectExecution,
  type UnitEffectRefusal,
  type UnitEffectTransition,
} from "./unitEffect.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";

import { isMaintenanceIntent, isMaintenanceExecution, type MaintenanceAdmissionInput } from "./maintenanceIdentity.js";
export {
  isMaintenanceIntent,
  isMaintenanceExecution,
  type MaintenanceAdmissionInput,
  type MaintenanceExecution,
} from "./maintenanceIdentity.js";
export interface PreparedMaintenanceAdmission {
  input: MaintenanceAdmissionInput;
  actionId: string;
}
export type MaintenanceAdmissionResult =
  | {
      ok: true;
      instance: CoordinatorInstance;
      unit: CoordinatorUnit;
      execution: UnitEffectExecution;
      effectId: string;
      ordinal: number;
      replayed: boolean;
    }
  | { ok: false; reason: UnitEffectRefusal };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const canonical = (v: unknown) =>
  JSON.stringify(v, (_k, p: unknown) =>
    object(p) ? Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))) : p,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function isMaintenanceAdmissionInput(v: unknown): v is MaintenanceAdmissionInput {
  return (
    object(v) &&
    keys(v, ["version", "intent", "target", "owner", "createdAt", "bounds"]) &&
    v.version === 1 &&
    isMaintenanceIntent(v.intent) &&
    object(v.target) &&
    keys(v.target, ["repo", "pr", "ref", "base", "headSha"]) &&
    isPublicationRepo(v.target.repo) &&
    Number.isSafeInteger(v.target.pr) &&
    (v.target.pr as number) > 0 &&
    text(v.target.ref) &&
    text(v.target.base) &&
    typeof v.target.headSha === "string" &&
    /^[a-f0-9]{40}$/i.test(v.target.headSha) &&
    (v.owner === undefined ||
      (object(v.owner) && keys(v.owner, ["instanceId", "unit"]) && text(v.owner.instanceId) && text(v.owner.unit))) &&
    typeof v.createdAt === "number" &&
    Number.isFinite(v.createdAt) &&
    isMaintenanceExecution({ id: "m_" + "a".repeat(64), intent: v.intent, admittedAt: v.createdAt, bounds: v.bounds })
  );
}
export async function prepareMaintenanceAdmission(
  input: MaintenanceAdmissionInput,
): Promise<PreparedMaintenanceAdmission> {
  if (!isMaintenanceAdmissionInput(input)) throw new Error("invalid maintenance admission");
  const frozen = structuredClone(input);
  frozen.target.repo = frozen.target.repo.toLowerCase();
  frozen.target.headSha = frozen.target.headSha.toLowerCase();
  const semantic = {
    version: frozen.version,
    intent: frozen.intent,
    owner: frozen.owner,
    target: { repo: frozen.target.repo, pr: frozen.target.pr, ref: frozen.target.ref, base: frozen.target.base },
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(semantic)));
  return {
    input: frozen,
    actionId: `m_${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
  };
}
function sameMaintenanceRequester(instance: CoordinatorInstance, intent: MaintenanceAdmissionInput["intent"]): boolean {
  return intent.kind === "watch"
    ? intent.requester === instance.userId
    : intent.userId === instance.userId &&
        intent.channelId === instance.channelId &&
        intent.authenticatedAs === instance.authenticatedAs &&
        intent.postedBy === instance.postedBy;
}
/** One synchronous decision inside the existing owner transaction; no new scheduler. */
export function planMaintenanceAdmission(
  prepared: PreparedMaintenanceAdmission,
  rows: PullOwnershipRows,
  instances: readonly unknown[],
): MaintenanceAdmissionResult {
  const { input, actionId } = prepared;
  if (!isMaintenanceAdmissionInput(input) || !/^m_[a-f0-9]{64}$/.test(actionId))
    return { ok: false, reason: "conflict" };
  if (
    !Array.isArray(instances) ||
    instances.length > PULL_OWNER_SCAN_MAX ||
    new TextEncoder().encode(canonical({ instances, rows })).byteLength > PULL_OWNER_SCAN_MAX_BYTES ||
    !instances.every(isCoordinatorInstance) ||
    new Set(instances.map((i) => i.id)).size !== instances.length
  )
    return { ok: false, reason: "incomplete" };
  const target = input.target;
  const owners = findPullOwnersInRows({ repo: target.repo, pr: target.pr, ref: target.ref }, rows);
  if (!owners.ok) return { ok: false, reason: owners.reason === "unavailable" ? "unavailable" : "incomplete" };
  if (rows.units.some((r) => !isCoordinatorInstance(r.instance) || !instances.some((i) => same(i, r.instance))))
    return { ok: false, reason: "incomplete" };
  // A saved pre-create Ship row without a unit may still represent an admitted Workflow.
  if (
    instances.some(
      (instance) =>
        instance.repo.toLowerCase() === target.repo &&
        instance.branch === target.ref &&
        !rows.units.some((r) => isCoordinatorUnit(r.unit) && r.unit.instanceId === instance.id),
    )
  )
    return { ok: false, reason: "owned" };
  const matching = rows.units.filter(
    (r) =>
      isCoordinatorInstance(r.instance) &&
      isCoordinatorUnit(r.unit) &&
      unitPullTargets(r.instance, r.unit).some(
        (t) => t.repo.toLowerCase() === target.repo && (t.pr === target.pr || t.ref === target.ref),
      ),
  ) as Array<{ instance: CoordinatorInstance; unit: CoordinatorUnit }>;
  if (matching.length > 1) return { ok: false, reason: "owned" };
  let original = matching[0];
  if (
    input.owner &&
    (!original || original.instance.id !== input.owner.instanceId || original.unit.unit !== input.owner.unit)
  )
    return { ok: false, reason: "stale" };
  if (
    input.intent.kind === "watch" &&
    (!original ||
      original.instance.id !== input.intent.instanceId ||
      original.unit.unit !== input.intent.unit ||
      original.instance.userId !== input.intent.requester)
  )
    return { ok: false, reason: "stale" };
  if (original && !sameMaintenanceRequester(original.instance, input.intent)) return { ok: false, reason: "owned" };
  const previousIntent = original?.unit.currentEffect?.execution.maintenance;
  if (previousIntent && same(previousIntent.intent, input.intent) && previousIntent.id !== actionId)
    return { ok: false, reason: "conflict" };
  if (original?.unit.currentEffect?.execution.maintenance?.id === actionId) {
    const cell = original.unit.currentEffect;
    const maintenance = cell.execution.maintenance!;
    const acceptedPush = cell.calls.filter((c) => c.operation === "rebase_push" && c.state === "accepted").at(-1);
    const replayHead = acceptedPush?.state === "accepted" ? acceptedPush.commitSha : undefined;
    if (
      !same(maintenance.intent, input.intent) ||
      !same(maintenance.bounds, input.bounds) ||
      !same({ ...cell.target, headSha: target.headSha }, target) ||
      (cell.target.headSha !== target.headSha && replayHead?.toLowerCase() !== target.headSha) ||
      owners.owners.some(
        (o) => o.kind !== "unit" || o.instanceId !== original!.instance.id || o.unit !== original!.unit.unit,
      )
    )
      return { ok: false, reason: "conflict" };
    return {
      ok: true,
      ...original,
      execution: cell.execution,
      effectId: cell.id,
      ordinal: cell.ordinal,
      replayed: true,
    };
  }
  if (owners.owners.length) return { ok: false, reason: "owned" };
  if (original) {
    if (original.instance.stop) return { ok: false, reason: "stopped" };
    const standaloneSettled =
      original.instance.kind === "maintenance" &&
      original.unit.startedAt === undefined &&
      original.unit.ending === undefined &&
      original.unit.currentEffect?.phase === "settled" &&
      !!original.unit.currentEffect.execution.maintenance;
    if (
      (!original.unit.ending?.outcome && !standaloneSettled) ||
      original.unit.recovery ||
      original.unit.recoveryHold ||
      original.unit.currentEffect?.phase === "active"
    )
      return { ok: false, reason: "owned" };
    const bound = original.unit.publication;
    if (
      !bound ||
      bound.repo.toLowerCase() !== target.repo ||
      bound.pr !== target.pr ||
      bound.headRef !== target.ref ||
      bound.publicationRef !== target.ref ||
      bound.owner.instanceId !== original.instance.id ||
      bound.owner.unit !== original.unit.unit
    )
      return { ok: false, reason: "conflict" };
    // New intent follows the native target under this same complete owner
    // transaction. Historical requester, report and instance base stay intact.
    original = {
      instance: original.instance,
      unit: { ...original.unit, publication: { ...bound, expectedHeadSha: target.headSha, baseRef: target.base } },
    };
  } else {
    if (input.intent.kind !== "command") return { ok: false, reason: "stale" };
    const intent = input.intent;
    const instance: CoordinatorInstance = {
      id: actionId,
      kind: "maintenance",
      userId: intent.userId,
      channelId: intent.channelId,
      threadKey: intent.threadKey,
      ...(intent.authenticatedAs ? { authenticatedAs: intent.authenticatedAs } : {}),
      ...(intent.postedBy ? { postedBy: intent.postedBy } : {}),
      repo: target.repo,
      branch: target.ref,
      base: target.base,
      createdAt: input.createdAt,
      merge: "person",
    };
    const unit: CoordinatorUnit = {
      instanceId: instance.id,
      unit: "ONE",
      slug: "maintenance",
      branch: target.ref,
      dependsOn: [],
      rounds: [],
      pr: { number: target.pr, url: `https://github.com/${target.repo}/pull/${target.pr}` },
      publication: {
        repo: target.repo,
        pr: target.pr,
        headRef: target.ref,
        baseRef: target.base,
        publicationRef: target.ref,
        expectedHeadSha: target.headSha,
        owner: { instanceId: instance.id, unit: "ONE" },
      },
    };
    original = { instance, unit };
  }
  const execution: UnitEffectExecution = {
    maintenance: {
      id: actionId,
      intent: structuredClone(input.intent),
      admittedAt: input.createdAt,
      bounds: structuredClone(input.bounds),
    },
  };
  const effectId = `${original.unit.unit}/maintenance/${actionId}`;
  const ordinal = (original.unit.currentEffect?.ordinal ?? 0) + 1;
  const unit = {
    ...original.unit,
    currentEffect: {
      version: 1 as const,
      id: effectId,
      ordinal,
      execution,
      target: structuredClone(target),
      phase: "active" as const,
      preparation: "reserved" as const,
      calls: [{ operation: "rebase_push" as const, state: "unstarted" as const }],
    },
  };
  if (!isUnitCurrentEffect(unit.currentEffect) || !hasUnitEffectCapacity(unit))
    return { ok: false, reason: "conflict" };
  return { ok: true, instance: original.instance, unit, execution, effectId, ordinal, replayed: false };
}
export function isMaintenanceAdmissionResult(v: unknown): v is MaintenanceAdmissionResult {
  if (!object(v)) return false;
  if (v.ok === false)
    return (
      keys(v, ["ok", "reason"]) &&
      ["stale", "stopped", "execution", "busy", "uncertain", "conflict", "owned", "incomplete", "unavailable"].includes(
        v.reason as string,
      )
    );
  return (
    v.ok === true &&
    keys(v, ["ok", "instance", "unit", "execution", "effectId", "ordinal", "replayed"]) &&
    isCoordinatorInstance(v.instance) &&
    isCoordinatorUnit(v.unit) &&
    v.unit.instanceId === v.instance.id &&
    isUnitCurrentEffect(v.unit.currentEffect) &&
    same(v.execution, v.unit.currentEffect.execution) &&
    v.effectId === v.unit.currentEffect.id &&
    v.ordinal === v.unit.currentEffect.ordinal &&
    typeof v.replayed === "boolean" &&
    isMaintenanceExecution(v.unit.currentEffect.execution.maintenance)
  );
}
/** A transport receipt stays bound to the source and its original exact target. */
export function maintenanceAdmissionMatches(
  prepared: PreparedMaintenanceAdmission,
  result: Extract<MaintenanceAdmissionResult, { ok: true }>,
): boolean {
  const { input, actionId } = prepared;
  const cell = result.unit.currentEffect!;
  const maintenance = result.execution.maintenance;
  const push = cell.calls.filter((c) => c.operation === "rebase_push" && c.state === "accepted").at(-1);
  const replayHead = result.replayed && push?.state === "accepted" ? push.commitSha?.toLowerCase() : undefined;
  return (
    maintenance?.id === actionId &&
    sameMaintenanceRequester(result.instance, input.intent) &&
    same(maintenance.intent, input.intent) &&
    same(maintenance.bounds, input.bounds) &&
    same({ ...cell.target, headSha: input.target.headSha }, input.target) &&
    (cell.target.headSha.toLowerCase() === input.target.headSha || replayHead === input.target.headSha) &&
    (!input.owner || (input.owner.instanceId === result.instance.id && input.owner.unit === result.unit.unit)) &&
    (input.intent.kind !== "watch" ||
      (input.intent.instanceId === result.instance.id &&
        input.intent.unit === result.unit.unit &&
        input.intent.requester === result.instance.userId)) &&
    (result.replayed || (cell.preparation === "reserved" && cell.phase === "active"))
  );
}
/** Release only the same never-started reservation; an unknown or begun call stays owned. */
export async function releaseMaintenanceReservation(
  admitted: Extract<MaintenanceAdmissionResult, { ok: true }>,
  instances: Pick<CoordinatorInstanceStore, "listUnits" | "transitionUnitEffect">,
): Promise<boolean> {
  try {
    const read = async () => {
      const rows = (await instances.listUnits(admitted.instance.id)).filter((r) => r.unit === admitted.unit.unit);
      if (rows.length !== 1 || !isCoordinatorUnit(rows[0])) return undefined;
      const row = rows[0]!;
      const cell = row.currentEffect;
      return cell?.id === admitted.effectId &&
        cell.ordinal === admitted.ordinal &&
        same(cell.execution, admitted.execution) &&
        same(cell.target, admitted.unit.currentEffect?.target)
        ? row
        : undefined;
    };
    let row = await read();
    if (
      !row ||
      !row.currentEffect!.calls.every(
        (call) => call.state === "unstarted" || (call.state === "refused" && call.cause === "not_started"),
      )
    )
      return false;
    const confirm = async (input: UnitEffectTransition) => {
      let result;
      try {
        result = await instances.transitionUnitEffect(input);
      } catch {
        /* Inspect only this exact original durable change. */
      }
      if (result?.ok && unitEffectResultMatches(input, result.unit)) return result.unit;
      const actual = await read();
      return actual && unitEffectResultMatches(input, actual) ? actual : undefined;
    };
    for (let call = 0; call < row.currentEffect!.calls.length; call++) {
      if (row.currentEffect!.calls[call]!.state !== "unstarted") continue;
      row = await confirm({
        kind: "cancel",
        expected: row,
        execution: admitted.execution,
        effectId: admitted.effectId,
        call,
      });
      if (!row) return false;
    }
    if (!row.currentEffect!.calls.every((call) => call.state === "refused" && call.cause === "not_started"))
      return false;
    if (row.currentEffect!.phase === "settled") return true;
    return !!(await confirm({
      kind: "settle",
      expected: row,
      execution: admitted.execution,
      effectId: admitted.effectId,
    }));
  } catch {
    return false;
  }
}
