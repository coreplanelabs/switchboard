import { MIN_BOUNDARY_MINUTES } from "../../config/validate.js";
import { MINUTE_MS, minutesToMs } from "../budgets.js";
import { childRequestText } from "../dispatch/spawn.js";
import type { DispatchOptions, DispatchOutcome } from "../dispatcher.js";
import type { PrivateWorkerIdentity, PrivateWorkerLog } from "../privateWorkerLog.js";
import type { SweepDispatchRequest } from "../pullSweepWiring.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { RUN_ID_PATTERN } from "../runRecord.js";
import { directAudienceStampOf } from "../runLedger/inboxMessage.js";
import {
  isCoordinatorInstance,
  isCoordinatorUnit,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";
import type { UnitEffectCompletionOutcome } from "./unitEffect.js";

export interface MaintenanceChildDeps {
  dispatch(msg: IncomingMessage, io: ChannelIO, options: DispatchOptions): Promise<DispatchOutcome>;
  ioFor(thread: { threadKey: string; userId: string }, request?: IncomingMessage): ChannelIO | undefined;
  now(): number;
  readOwner(
    instanceId: string,
    unit: string,
  ): Promise<{ instance: CoordinatorInstance; unit: CoordinatorUnit } | undefined>;
  childAdmission: { enter(): (() => void) | undefined };
  privateWorkerLog?: PrivateWorkerLog;
  appendPrivateInput?(
    log: PrivateWorkerLog,
    identity: PrivateWorkerIdentity,
    input: { id: string; sender: string; text: string; at: number },
  ): Promise<void>;
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const identity = ({ stop: _stop, ...instance }: CoordinatorInstance) => instance;

/** Native runStarted acknowledges admission while the admitted child continues. */
export async function dispatchMaintenanceChild(
  owner: { instance: CoordinatorInstance; unit: CoordinatorUnit },
  request: SweepDispatchRequest,
  agent: "coding" | "review",
  deps: MaintenanceChildDeps,
): Promise<UnitEffectCompletionOutcome> {
  const { instance, unit } = structuredClone(owner);
  const cell = unit.currentEffect;
  const publication = unit.publication;
  const spawnIndex =
    cell?.calls.findIndex(
      (call) => call.operation === "spawn" && (call.agent ?? "review") === agent && call.state === "pending",
    ) ?? -1;
  const pushed = cell?.calls
    .slice(0, spawnIndex)
    .filter((call) => call.operation === "rebase_push" && call.state === "accepted")
    .at(-1);
  const expectedHead = pushed?.state === "accepted" ? pushed.commitSha : cell?.target.headSha;
  const expectedBase = cell?.execution.maintenance ? cell.target.base : (instance.base ?? "main");
  if (
    !isCoordinatorInstance(instance) ||
    !isCoordinatorUnit(unit) ||
    !cell ||
    !publication ||
    unit.instanceId !== instance.id ||
    cell.phase !== "active" ||
    cell.preparation !== undefined ||
    spawnIndex < 0 ||
    cell.calls.slice(0, spawnIndex).some((call) => call.state !== "accepted") ||
    cell.target.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    cell.target.ref !== unit.branch ||
    cell.target.base !== expectedBase ||
    publication.owner.instanceId !== instance.id ||
    publication.owner.unit !== unit.unit ||
    publication.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    publication.pr !== cell.target.pr ||
    publication.headRef !== unit.branch ||
    publication.publicationRef !== unit.branch ||
    publication.baseRef !== cell.target.base ||
    publication.expectedHeadSha.toLowerCase() !== expectedHead?.toLowerCase()
  )
    return { state: "uncertain" };
  if (instance.stop || unit.recoveryHold) return { state: "refused", cause: "external_refused" };
  const threadKey =
    (agent === "review" ? unit.reviewThread?.threadKey : undefined) ?? unit.threadKey ?? instance.threadKey;
  if (request.channelId !== instance.channelId || request.userId !== instance.userId || request.threadKey !== threadKey)
    return { state: "refused", cause: "external_refused" };
  const deadline = cell.execution.maintenance
    ? cell.execution.maintenance.admittedAt + minutesToMs(cell.execution.maintenance.bounds.leaseMinutes)
    : unit.recovery?.deadlineAt;
  const at = deps.now();
  const budget = deadline === undefined ? undefined : Math.floor((deadline - at) / MINUTE_MS);
  if (budget !== undefined && budget < MIN_BOUNDARY_MINUTES) return { state: "refused", cause: "external_refused" };
  const inputId = `${instance.id}:${cell.id}`;
  const msg: IncomingMessage = {
    channelId: instance.channelId,
    userId: instance.userId,
    threadKey,
    ...(instance.authenticatedAs ? { authenticatedAs: instance.authenticatedAs } : {}),
    ...(instance.postedBy ? { postedBy: instance.postedBy } : {}),
    ...(unit.workBrief ? { messageId: inputId } : {}),
    receivedAt: at,
    text: childRequestText({
      preset: agent,
      repo: instance.repo,
      ref: unit.branch,
      ...(budget !== undefined ? { budget } : {}),
      prompt: request.text,
    }),
  };
  let io: ChannelIO | undefined;
  try {
    io = deps.ioFor({ threadKey, userId: instance.userId }, msg);
    if (!io) return { state: "refused", cause: "external_refused" };
    const audience = io.directAudience?.();
    if (audience) {
      const candidate = directAudienceStampOf({ ...msg, directAudience: { kind: "slack-unshared-im", ...audience } });
      if (!candidate || !(await io.verifyDirectAudience?.(candidate))?.ok)
        return { state: "refused", cause: "external_refused" };
      msg.directAudience = candidate;
    }
    if (unit.workBrief) {
      if (!deps.privateWorkerLog || !deps.appendPrivateInput) return { state: "refused", cause: "external_refused" };
      await deps.appendPrivateInput(
        deps.privateWorkerLog,
        { instanceId: instance.id, unit: unit.unit },
        { id: inputId, sender: instance.userId, text: msg.text, at },
      );
      if (!(await io.verifyPrivateWorkerAudience?.(msg))?.ok) return { state: "refused", cause: "external_refused" };
    }
  } catch {
    return { state: "uncertain" };
  }
  let current: Awaited<ReturnType<MaintenanceChildDeps["readOwner"]>>;
  try {
    current = await deps.readOwner(instance.id, unit.unit);
  } catch {
    return { state: "uncertain" };
  }
  if (
    !current ||
    !isCoordinatorInstance(current.instance) ||
    !isCoordinatorUnit(current.unit) ||
    !same(identity(current.instance), identity(instance)) ||
    !same(current.unit, unit)
  )
    return { state: "uncertain" };
  if (current.instance.stop || current.unit.recoveryHold) return { state: "refused", cause: "external_refused" };
  const remainingMs = deadline === undefined ? undefined : deadline - deps.now();
  if (remainingMs !== undefined && remainingMs < minutesToMs(MIN_BOUNDARY_MINUTES))
    return { state: "refused", cause: "external_refused" };
  const release = deps.childAdmission.enter();
  if (!release) return { state: "refused", cause: "external_refused" };
  let acknowledge!: (outcome: UnitEffectCompletionOutcome) => void;
  const admitted = new Promise<UnitEffectCompletionOutcome>((resolve) => {
    acknowledge = resolve;
  });
  let acknowledged = false;
  const finish = (outcome: UnitEffectCompletionOutcome) => {
    if (acknowledged) return;
    acknowledged = true;
    release();
    acknowledge(outcome);
  };
  const watched = new Proxy(io, {
    get(target, key) {
      if (key === "runStarted")
        return (started: { id: string }) => {
          if (acknowledged || typeof started.id !== "string" || !RUN_ID_PATTERN.test(started.id)) return;
          finish({ state: "accepted", runId: started.id });
          target.runStarted?.(started);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const running = deps.dispatch(msg, watched, {
      ...(deadline !== undefined ? { parentDeadlineAt: deadline } : {}),
      ...(remainingMs !== undefined ? { parentRemainingMs: remainingMs } : {}),
      operationTarget: { repo: instance.repo, ref: unit.branch },
      coordinator: {
        parentInstanceId: instance.id,
        unit: unit.unit,
        instanceAttempt: instance.attempt ?? 0,
        idempotencyKey: `${instance.id}:${cell.id}`,
        branch: unit.branch,
        base: expectedBase,
        publication: unit.publication,
        ...(cell.execution.maintenance
          ? {
              maintenanceActionId: cell.execution.maintenance.id,
              // Existing round reservation metadata; the lease and model turn
              // gate bound execution. This is not a per-call dollar cutoff.
              costCapUsd: cell.execution.maintenance.bounds.spendCapUsd,
            }
          : cell.execution.workflowId !== instance.id
            ? { transportWorkflowId: cell.execution.workflowId }
            : {}),
      },
    });
    void Promise.resolve(running).then(
      () => finish({ state: "uncertain" }),
      () => finish({ state: "uncertain" }),
    );
  } catch {
    finish({ state: "uncertain" });
  }
  return admitted;
}
