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
  type WorkflowSender,
} from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";

/** The tool integration supplies only a resolved actor and a stable act id.
 * The actor's origin, never model text, selects the main conversation. */
export interface MainTaskActionsDeps {
  instances: Pick<CoordinatorInstanceStore, "getMainTask" | "get" | "listUnits" | "appendEvent" | "listEvents">;
  workflow?: WorkflowSender;
  plane: Pick<PlaneService, "stop">;
  clock: () => number;
}

export interface MainTaskStatus {
  key: string;
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
  instance: CoordinatorInstance;
  unit: CoordinatorUnit;
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
  async function bound(actor: Actor, actId: string): Promise<Binding> {
    const origin = actor.origin;
    if (!origin || !isMainTaskKey({ mainThreadKey: origin.threadKey, actId })) return { kind: "not_found" };
    try {
      const link = await deps.instances.getMainTask({ mainThreadKey: origin.threadKey, actId });
      if (!link) return { kind: "not_found" };
      const [instance, units] = await Promise.all([
        deps.instances.get(link.instanceId),
        deps.instances.listUnits(link.instanceId),
      ]);
      const unit = units.find((row) => row.unit === link.unit);
      if (!instance || !unit || !isWorkBrief(unit.workBrief)) return { kind: "not_found" };
      const brief = unit.workBrief;
      if (
        instance.kind !== "ship" ||
        instance.merge !== "person" ||
        instance.plan === undefined ||
        instance.plan.path !== undefined ||
        instance.threadKey !== origin.threadKey ||
        instance.channelId !== origin.channelId ||
        !selfIdsOf(actor).includes(instance.userId) ||
        unit.instanceId !== instance.id ||
        unit.dependsOn.length !== 0 ||
        brief.mainThreadKey !== origin.threadKey ||
        brief.actId !== actId ||
        brief.requesterId !== instance.userId ||
        brief.repo !== instance.repo ||
        brief.base !== instance.base
      )
        return { kind: "not_found" };
      return { kind: "bound", value: { instance, unit } };
    } catch {
      return { kind: "unavailable" };
    }
  }

  async function status(actor: Actor, actId: string): Promise<ReadResult> {
    const found = await bound(actor, actId);
    if (found.kind !== "bound") return found;
    const { instance, unit } = found.value;
    if (!authorize(actor, "runs:read", runResource(instance)).allow) return { kind: "forbidden" };
    return {
      kind: "found",
      unit: {
        key: unitKeyOf(unit),
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
      const appended = await deps.instances.appendEvent(key, event);
      if (!appended.ok) return { kind: "unavailable" };
      const persisted = (await deps.instances.listEvents(key)).find((row) => row.id === id);
      // An id is a replay key, never permission to silently replace a prior steer.
      if (!persisted) return { kind: "unavailable" };
      if (persisted.sender !== event.sender || persisted.text !== event.text) return { kind: "conflict" };
      const nudge = await sendUnitNudge(deps.workflow, key);
      return { kind: "queued", seq: appended.seq, nudge: nudge.kind === "sent" ? "sent" : "pending" };
    } catch {
      return { kind: "unavailable" };
    }
  }

  async function stop(actor: Actor, actId: string): Promise<StopResult> {
    const found = await bound(actor, actId);
    if (found.kind !== "bound") return found;
    const { instance } = found.value;
    if (actor.viewingAs || !authorize(actor, "main-task:stop", runResource(instance)).allow)
      return { kind: "forbidden" };
    try {
      const report = await deps.plane.stop(
        instance.id,
        runActorOf(actor),
        predicateFor(actor, "main-task:stop", "run"),
      );
      if (report.kind === "unknown_instance") return { kind: "not_found" };
      if (report.kind === "unavailable") return { kind: "unavailable" };
      return {
        kind: report.runnerStopped ? "stopped" : "partial",
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
