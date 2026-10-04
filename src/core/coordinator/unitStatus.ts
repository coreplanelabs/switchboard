import {
  contextDependenciesHash,
  isContextDependencies,
  type ContextDependencies,
} from "../references/contextDependencies.js";
import { isUnitStatusReference, type UnitStatusReference } from "../references/unitStatusReference.js";
import { sourceHash } from "../references/receipts.js";
import { contextThreadSessionKey, storedTurnRow } from "../runLedger/sessionLog.js";
import {
  isCoordinatorInstance,
  isCoordinatorUnit,
  mainTaskClaimMatches,
  STEP_NAME_PATTERN,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import type { CoordinatorReportLedger, CoordinatorReportOwner } from "./reportContext.js";
import { isShipOutcome, isShipOutcomeKind, type ShipOutcome } from "./shipOutcome.js";
import { privateWorkerThreadKey } from "../privateWorkerLog.js";

export interface CoordinatorStatusSnapshot {
  version: 1;
  owner: CoordinatorReportOwner;
  destinationThreadKey: string;
  repo: string;
  actId?: string;
  observedAt: number;
  status: { state: "recorded"; kind: ShipOutcome["kind"] } | { state: "unverified" | "idle" | "continued" };
  pr?: { number: number; url: string };
}
const same = async (a: unknown, b: unknown) => (await sourceHash(a)) === (await sourceHash(b));
const canonicalOwner = (o: CoordinatorReportOwner): CoordinatorReportOwner => ({
  instanceId: o.instanceId,
  unit: o.unit,
  attempt: o.attempt,
  requester: o.requester,
  channelId: o.channelId,
  threadKey: o.threadKey,
  deliveryId: o.deliveryId,
});
const rowIdOf = async (owner: CoordinatorReportOwner) =>
  `coordinator-status:${await sourceHash(canonicalOwner(owner))}`;
const contextOf = (ref: UnitStatusReference): ContextDependencies => ({
  version: 1,
  status: "known",
  revision: 0,
  origins: [],
  slack: [],
  mcp: [],
  unitStatuses: [ref],
});

function validSnapshot(value: unknown): value is CoordinatorStatusSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as CoordinatorStatusSnapshot;
  const status = s.status;
  return (
    Object.keys(s).every((k) =>
      ["version", "owner", "destinationThreadKey", "repo", "actId", "observedAt", "status", "pr"].includes(k),
    ) &&
    s.version === 1 &&
    isUnitStatusReference({
      ...s.owner,
      destinationThreadKey: s.destinationThreadKey,
      repo: s.repo,
      snapshotHash: "0".repeat(64),
    }) &&
    (s.actId === undefined || (typeof s.actId === "string" && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(s.actId))) &&
    Number.isFinite(s.observedAt) &&
    status !== null &&
    typeof status === "object" &&
    (status.state === "recorded"
      ? Object.keys(status).length === 2 && isShipOutcomeKind(status.kind)
      : Object.keys(status).length === 1 && ["unverified", "idle", "continued"].includes(status.state)) &&
    (s.pr === undefined ||
      (Object.keys(s.pr).length === 2 &&
        Number.isSafeInteger(s.pr.number) &&
        s.pr.number > 0 &&
        s.pr.url === `https://github.com/${s.repo}/pull/${s.pr.number}`))
  );
}

export function renderCoordinatorStatus(snapshot: CoordinatorStatusSnapshot): string {
  const state = snapshot.status.state === "recorded" ? snapshot.status.kind : snapshot.status.state;
  // The opaque original delivery is bound internally. Legacy transports can
  // embed display strings in it; only canonical machine steps are rendered.
  const delivery = STEP_NAME_PATTERN.test(snapshot.owner.deliveryId)
    ? snapshot.owner.deliveryId
    : snapshot.owner.deliveryId.startsWith("recovery:")
      ? "recovery"
      : "legacy";
  return (
    `Recorded work status: ${snapshot.actId ? `work ${snapshot.actId}; ` : ""}${snapshot.owner.instanceId}/${snapshot.owner.unit}; ${state}; observed at ${snapshot.observedAt}; attempt ${snapshot.owner.attempt}; delivery ${delivery}.` +
    (snapshot.pr ? ` Pull request: ${snapshot.pr.url}.` : "") +
    (snapshot.actId
      ? " Read work_progress for current details."
      : " This is a recorded observation, not a current status check.")
  );
}

/** Verify the original immutable row; a newer mutable unit ending never
 * substitutes for the bytes selected by this reference. */
export async function readCoordinatorStatus(
  ledger: Pick<CoordinatorReportLedger, "readSessionEntry">,
  ref: UnitStatusReference,
): Promise<CoordinatorStatusSnapshot | undefined> {
  if (!isUnitStatusReference(ref)) return undefined;
  const { destinationThreadKey, repo, snapshotHash, ...owner } = ref;
  const rows = await ledger.readSessionEntry(contextThreadSessionKey(destinationThreadKey), await rowIdOf(owner));
  if (rows?.length !== 1 || rows[0]!.part !== 0) return undefined;
  try {
    const stored = JSON.parse(rows[0]!.json);
    const snapshot = stored.coordinatorStatus;
    if (
      !validSnapshot(snapshot) ||
      !(await same(canonicalOwner(snapshot.owner), canonicalOwner(owner))) ||
      snapshot.repo !== repo ||
      snapshot.destinationThreadKey !== destinationThreadKey ||
      (await sourceHash(snapshot)) !== snapshotHash ||
      stored.role !== "assistant" ||
      stored.part?.type !== "text" ||
      stored.part.text !== renderCoordinatorStatus(snapshot) ||
      !isContextDependencies(stored.context) ||
      (await contextDependenciesHash(stored.context)) !== (await contextDependenciesHash(contextOf(ref)))
    )
      return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

/** Called after settlement. The first write independently rereads the exact
 * committed unit; retries preserve their earlier immutable delivery. */
export async function appendCoordinatorStatus(
  deps: {
    ledger: CoordinatorReportLedger;
    instances: Pick<CoordinatorInstanceStore, "get" | "listUnits" | "getMainTask">;
  },
  input: { owner: CoordinatorReportOwner; instance: CoordinatorInstance; unit: CoordinatorUnit },
): Promise<UnitStatusReference | undefined> {
  const { owner, instance, unit } = input;
  if (
    !isCoordinatorInstance(instance) ||
    !isCoordinatorUnit(unit) ||
    unit.instanceId !== instance.id ||
    owner.instanceId !== instance.id ||
    owner.unit !== unit.unit ||
    owner.attempt !== (instance.attempt ?? 0) ||
    owner.requester !== instance.userId ||
    owner.channelId !== instance.channelId
  )
    return undefined;
  const destinationThreadKey = unit.workBrief?.mainThreadKey ?? owner.threadKey;
  const repo = instance.repo.toLowerCase();
  const key = contextThreadSessionKey(destinationThreadKey);
  const rowId = await rowIdOf(owner);
  const actualInstance = await deps.instances.get(instance.id);
  const actualUnits = await deps.instances.listUnits(instance.id);
  const confirmedInstance = await deps.instances.get(instance.id);
  const actual = actualUnits.filter((u) => u.unit === unit.unit);
  if (
    !actualInstance ||
    !confirmedInstance ||
    !(await same(actualInstance, instance)) ||
    !(await same(confirmedInstance, instance)) ||
    actual.length !== 1 ||
    !(await same(actual[0], unit))
  )
    return undefined;
  if (unit.workBrief) {
    const task = { mainThreadKey: unit.workBrief.mainThreadKey, actId: unit.workBrief.actId };
    const link = await deps.instances.getMainTask(task);
    if (
      !mainTaskClaimMatches(task, instance, unit) ||
      owner.threadKey !== privateWorkerThreadKey({ instanceId: instance.id, unit: unit.unit }) ||
      link?.instanceId !== instance.id ||
      link.unit !== unit.unit ||
      link.authority?.requesterId !== instance.userId ||
      link.authority.repo.toLowerCase() !== repo
    )
      return undefined;
  } else if (owner.threadKey !== (unit.threadKey ?? instance.threadKey)) return undefined;
  const prior = await deps.ledger.readSessionEntry(key, rowId);
  if (prior !== undefined) {
    if (prior.length !== 1) throw new Error("original coordinator status is unavailable");
    const snapshot = JSON.parse(prior[0]!.json).coordinatorStatus;
    const ref = { ...owner, destinationThreadKey, repo, snapshotHash: await sourceHash(snapshot) };
    if (!(await readCoordinatorStatus(deps.ledger, ref))) throw new Error("original coordinator status is invalid");
    return ref;
  }
  const outcome = unit.ending?.outcome;
  const status: CoordinatorStatusSnapshot["status"] =
    outcome && isShipOutcome(outcome)
      ? { state: "recorded", kind: outcome.kind }
      : unit.ending
        ? { state: "unverified" }
        : unit.idle
          ? { state: "idle" }
          : unit.segments?.length
            ? { state: "continued" }
            : { state: "unverified" };
  const observedAt = unit.ending?.at ?? unit.idle?.at ?? unit.segments?.at(-1)?.at ?? instance.createdAt;
  const pr =
    unit.pr &&
    outcome?.terminalPr?.number === unit.pr.number &&
    outcome.terminalPr.url === unit.pr.url &&
    unit.pr.url.toLowerCase() === `https://github.com/${repo}/pull/${unit.pr.number}` &&
    Number.isSafeInteger(unit.pr.number) &&
    unit.pr.number > 0
      ? { number: unit.pr.number, url: `https://github.com/${repo}/pull/${unit.pr.number}` }
      : undefined;
  const snapshot: CoordinatorStatusSnapshot = {
    version: 1,
    owner: canonicalOwner(owner),
    destinationThreadKey,
    repo,
    ...(unit.workBrief ? { actId: unit.workBrief.actId } : {}),
    observedAt,
    status,
    ...(pr ? { pr } : {}),
  };
  if (!validSnapshot(snapshot)) return undefined;
  const ref: UnitStatusReference = { ...owner, destinationThreadKey, repo, snapshotHash: await sourceHash(snapshot) };
  const context = contextOf(ref);
  const json = JSON.stringify({
    ...JSON.parse(storedTurnRow({ role: "assistant", text: renderCoordinatorStatus(snapshot), folded: true, context })),
    coordinatorStatus: snapshot,
  });
  const saved = await deps.ledger.appendSession(key, rowId, [{ part: 0, json }], context);
  if (!saved.ok || !(await readCoordinatorStatus(deps.ledger, ref)))
    throw new Error("coordinator status could not be saved");
  return ref;
}
