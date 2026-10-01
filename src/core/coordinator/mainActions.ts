import { authorize, effectiveGrants, selfIdsOf } from "../authz/authorize.js";
import { predicateFor } from "../authz/predicate.js";
import type { Actor } from "../authz/types.js";
import { authorizeSteerOwner } from "../dispatch/authorize.js";
import type { PlaneService } from "../planeService.js";
import type { RunActor } from "../runEvents.js";
import {
  isMainTaskKey,
  isThreadEvent,
  isWorkBrief,
  sendUnitNudge,
  unitKeyOf,
  type CoordinatorInstance,
  type CoordinatorUnit,
  type MainTaskBinding,
  type WorkflowSender,
} from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import { isMainTaskAuthority } from "./requesterAuthority.js";

/** The tool integration supplies only a resolved actor and a stable act id.
 * The actor's origin, never model text, selects the main conversation. */
export interface MainTaskActionsDeps {
  instances: Pick<CoordinatorInstanceStore, "getMainTask" | "get" | "listUnits" | "appendEvent"> &
    Partial<Pick<CoordinatorInstanceStore, "readMainTaskUnit">>;
  workflow?: WorkflowSender;
  plane: Pick<PlaneService, "stop">;
  clock: () => number;
  /** A live model turn may lose requester authority while joined records load. */
  liveAuthority?: { verify(): Promise<boolean>; active(): boolean };
}

/** No private values or source URLs cross this projection. Completeness is structural,
 * not a claim that a source was read or an analysis was independently verified. */
export type BriefProof = { briefId: string; actId: string; provenance: "unverified" } & (
  | {
      state: "complete";
      schemaVersion: 1;
      completeness: "structural";
      cause: "unknown" | "hypothesis";
      acceptancePresent: true;
      evidence: { availability: "provided" | "unavailable"; analysis: number; observation: number };
    }
  | { state: "legacy" | "missing" | "invalid"; schemaVersion: null; completeness: "unknown" }
);
function briefProofOf(unit: CoordinatorUnit, actId: string, brief: unknown): BriefProof {
  const identity = { briefId: unitKeyOf(unit), actId, provenance: "unverified" as const };
  if (!isWorkBrief(brief) || brief.schemaVersion !== 1)
    return {
      ...identity,
      state: brief === undefined ? "missing" : isWorkBrief(brief) ? "legacy" : "invalid",
      schemaVersion: null,
      completeness: "unknown",
    };
  return {
    ...identity,
    state: "complete",
    schemaVersion: 1,
    completeness: "structural",
    cause: brief.cause.kind,
    acceptancePresent: true,
    evidence: {
      availability: brief.evidence.availability,
      analysis: brief.findings.filter((f) => f.kind === "analysis").length,
      observation: brief.findings.filter((f) => f.kind === "observation").length,
    },
  };
}

export interface MainTaskStatus {
  key: string;
  briefProof: BriefProof;
  repo: string;
  branch: string;
  state: "queued" | "running" | "idle" | "recovering" | "ended" | "stopped";
  pr?: { number: number; url: string };
}

type ReadResult = { kind: "found"; unit: MainTaskStatus } | { kind: "not_found" | "forbidden" | "unavailable" };
type SteerResult =
  | { kind: "queued"; seq: number; nudge: "sent" | "pending" }
  | { kind: "not_found" | "forbidden" | "unavailable" | "invalid" | "conflict" | "ended" };
type StopResult =
  | { kind: "stopped" | "partial"; runnerStopped: boolean; parentOutcome?: string; childOutcomes: string[] }
  | { kind: "not_found" | "forbidden" | "unavailable" };

interface BoundUnit {
  brief: unknown;
  instance: CoordinatorInstance;
  unit: CoordinatorUnit;
}

function bindingOf(instance: CoordinatorInstance, unit: CoordinatorUnit, actId: string): MainTaskBinding {
  return {
    key: { mainThreadKey: instance.threadKey, actId },
    instanceId: instance.id,
    unit: unit.unit,
    branch: instance.branch,
    channelId: instance.channelId,
    requesterId: instance.userId,
  };
}
type Binding = { kind: "bound"; value: BoundUnit } | { kind: "not_found" | "unavailable" };

function runResource(instance: CoordinatorInstance) {
  return {
    type: "run" as const,
    id: instance.runId ?? instance.id,
    channelId: instance.channelId,
    userId: instance.userId,
    repo: instance.repo,
    channelVisibility: "unknown" as const,
  };
}

function stateOf(instance: CoordinatorInstance, unit: CoordinatorUnit): MainTaskStatus["state"] {
  if (instance.stop) return "stopped";
  if (unit.ending || unit.recoveryHold) return "ended";
  if (unit.recovery) return "recovering";
  if (unit.idle) return "idle";
  return unit.startedAt === undefined ? "queued" : "running";
}

function runActorOf(actor: Actor): RunActor {
  const id = actor.id;
  return {
    kind: id.startsWith("access:") ? "access" : id.startsWith("mcp:") ? "mcp" : id.startsWith("cli:") ? "cli" : "chat",
    id,
  };
}

export function createMainTaskActions(deps: MainTaskActionsDeps) {
  /** The index is an address, not authority: verify the joined records before every effect. */
  async function bound(actor: Actor, actId: string, readUnknownBrief = false): Promise<Binding> {
    const origin = actor.origin;
    if (!origin || !isMainTaskKey({ mainThreadKey: origin.threadKey, actId })) return { kind: "not_found" };
    try {
      const link = await deps.instances.getMainTask({ mainThreadKey: origin.threadKey, actId });
      if (!link) return { kind: "not_found" };
      const [instance, snapshot] = await Promise.all([
        deps.instances.get(link.instanceId),
        readUnknownBrief && deps.instances.readMainTaskUnit
          ? deps.instances.readMainTaskUnit(link)
          : deps.instances.listUnits(link.instanceId).then((rows) => {
              const unit = rows.find((row) => row.unit === link.unit);
              return unit ? { unit, brief: unit.workBrief } : null;
            }),
      ]);
      if (!instance || instance.id !== link.instanceId || !snapshot) return { kind: "not_found" };
      const { unit, brief } = snapshot;
      const identity = typeof brief === "object" && brief !== null ? (brief as Record<string, unknown>) : undefined;
      if (
        !isWorkBrief(brief) &&
        (!readUnknownBrief ||
          !isMainTaskAuthority(link.authority) ||
          link.authority.requesterId !== instance.userId ||
          link.authority.repo !== instance.repo)
      )
        return { kind: "not_found" };
      if (
        brief !== undefined &&
        (!identity ||
          identity.mainThreadKey !== origin.threadKey ||
          identity.actId !== actId ||
          identity.requesterId !== instance.userId ||
          identity.repo !== instance.repo ||
          identity.base !== instance.base)
      )
        return { kind: "not_found" };
      if (
        instance.kind !== "ship" ||
        instance.merge !== "person" ||
        instance.plan === undefined ||
        instance.plan.path !== undefined ||
        instance.threadKey !== origin.threadKey ||
        instance.channelId !== origin.channelId ||
        !selfIdsOf(actor).includes(instance.userId) ||
        unit.instanceId !== instance.id ||
        unit.branch !== instance.branch ||
        unit.dependsOn.length !== 0
      )
        return { kind: "not_found" };
      return { kind: "bound", value: { instance, unit, brief } };
    } catch {
      return { kind: "unavailable" };
    }
  }

  async function status(actor: Actor, actId: string): Promise<ReadResult> {
    if (actor.viewingAs) return { kind: "not_found" };
    const found = await bound(actor, actId, true);
    if (found.kind !== "bound") return found;
    const { instance, unit } = found.value;
    if (!authorize(actor, "runs:read", runResource(instance)).allow) return { kind: "forbidden" };
    try {
      if (!deps.liveAuthority || !(await deps.liveAuthority.verify()) || !deps.liveAuthority.active())
        return { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
    return {
      kind: "found",
      unit: {
        key: unitKeyOf(unit),
        briefProof: briefProofOf(unit, actId, found.value.brief),
        repo: instance.repo,
        branch: unit.branch,
        state: stateOf(instance, unit),
        ...(unit.pr ? { pr: { number: unit.pr.number, url: unit.pr.url } } : {}),
      },
    };
  }

  async function steer(actor: Actor, input: { actId: string; eventId: string; words: string }): Promise<SteerResult> {
    if (
      !isMainTaskKey({ mainThreadKey: actor.origin?.threadKey, actId: input.actId }) ||
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(input.eventId) ||
      typeof input.words !== "string" ||
      input.words.trim().length === 0 ||
      input.words.length > 12_000
    )
      return { kind: "invalid" };
    const found = await bound(actor, input.actId);
    if (found.kind !== "bound") return found;
    const { instance, unit } = found.value;
    if (
      actor.viewingAs ||
      !authorize(actor, "runs:read", runResource(instance)).allow ||
      !authorize(actor, "steer:write", { type: "command", id: "steer.run" }).allow ||
      authorizeSteerOwner({
        caller: { ids: selfIdsOf(actor), grants: effectiveGrants(actor) },
        target: { requesterId: instance.userId, parentInstanceId: instance.id },
      }).kind !== "allowed"
    )
      return { kind: "forbidden" };
    if (instance.stop || unit.ending || unit.recovery || unit.recoveryHold) return { kind: "ended" };
    const id = `main-action:${input.actId}:${input.eventId}`;
    const event = {
      id,
      // The unit's idle wake checks this id against its stored requester.
      sender: instance.userId,
      text: input.words,
      mode: unit.idle ? ("wake" as const) : ("steer" as const),
      at: deps.clock(),
    };
    if (!isThreadEvent({ ...event, seq: 1 })) return { kind: "invalid" };
    const key = { instanceId: instance.id, unit: unit.unit };
    try {
      if (deps.liveAuthority) {
        const verified = await deps.liveAuthority.verify();
        if (!verified || !deps.liveAuthority.active()) return { kind: "unavailable" };
      }
      const appended = await deps.instances.appendEvent(key, event, true, bindingOf(instance, unit, input.actId));
      if (!appended.ok)
        return {
          kind: appended.reason === "stale" ? "not_found" : appended.reason === "ended" ? "ended" : "unavailable",
        };
      const persisted = appended.event;
      // An id is a replay key, never permission to silently replace a prior steer.
      if (!persisted) return { kind: "unavailable" };
      if (persisted.id !== id || persisted.sender !== event.sender || persisted.text !== event.text)
        return { kind: "conflict" };
      const nudge = await sendUnitNudge(deps.workflow, key);
      return { kind: "queued", seq: appended.seq, nudge: nudge.kind === "sent" ? "sent" : "pending" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  async function stop(actor: Actor, actId: string): Promise<StopResult> {
    const found = await bound(actor, actId);
    if (found.kind !== "bound") return found;
    const { instance, unit } = found.value;
    if (actor.viewingAs || !authorize(actor, "main-task:stop", runResource(instance)).allow)
      return { kind: "forbidden" };
    try {
      if (deps.liveAuthority) {
        const verified = await deps.liveAuthority.verify();
        if (!verified || !deps.liveAuthority.active()) return { kind: "unavailable" };
      }
      const report = await deps.plane.stop(
        instance.id,
        runActorOf(actor),
        predicateFor(actor, "main-task:stop", "run"),
        bindingOf(instance, unit, actId),
      );
      if (report.kind === "unknown_instance") return { kind: "not_found" };
      if (report.kind === "unavailable") return { kind: "unavailable" };
      return {
        kind: report.runnerStopped && report.stopsSucceeded ? "stopped" : "partial",
        runnerStopped: report.runnerStopped,
        ...(report.parent ? { parentOutcome: report.parent.outcome } : {}),
        childOutcomes: report.children.map((child) => child.outcome),
      };
    } catch {
      return { kind: "unavailable" };
    }
  }

  return { status, steer, stop };
}
