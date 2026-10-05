// The parent ship records (docs/reference/specs/run-history.md item 49): one
// seam, two implementations (docs/decisions/0001-seams-with-two-implementations.md).
// A coordinator instance's record — the requester, channel, thread, repository
// and branch every child of the instance acts as — is written by the bot at
// the instance's creation and read by the coordinator's spawn route, so no
// step ever takes an actor from its caller. It must outlive the bot process
// (the coordinator exists to survive bot deaths), so production is the state
// Worker's `coordinator_instances` table behind an HTTPS client; tests and a
// process without a Worker-backed run history get the in-memory double or the
// null store, which knows no instance and refuses every write by name.

import { isRunRecord } from "../runRecord.js";
import {
  isMaintenanceAdmissionInput,
  isMaintenanceAdmissionResult,
  prepareMaintenanceAdmission,
  planMaintenanceAdmission,
  maintenanceAdmissionMatches,
  type MaintenanceAdmissionInput,
  type MaintenanceAdmissionResult,
} from "./maintenanceAdmission.js";
import { isCoordinatorReportAdmission } from "./reportAdmission.js";
import { coordinatorReportCanReconcile } from "./reportReconcileEligibility.js";
import type { InMemoryRunLedger } from "../runLedger/inMemory.js";
import { PLANE_EFFECTS_TOTAL_CAP } from "../plane/decide.js";
import {
  coordinatorReconciliationEffect,
  coordinatorWorkflowCanReconcile,
  isCoordinatorReconcileEffect,
} from "./workflowReconciliation.js";
import {
  findPullOwnersInRows,
  pullBindingChanges,
  needsPullBindingAdmission,
  isPullBindingRefusal,
  type PullBindingRefusal,
  unitPullBindingRefusal,
  unitPullTargetsRefusal,
  type PullOwnershipRows,
  isPullTarget,
  isPullOwnerLiveMeta,
  PULL_OWNER_SCAN_MAX,
  PULL_OWNER_SCAN_MAX_BYTES,
  isPullOwnersResult,
  type PullTarget,
  type PullOwnersResult,
} from "./pullOwnership.js";
import {
  isUnitEffectTransition,
  isUnitEffectTransitionResult,
  unitEffectResultMatches,
  planUnitEffectTransition,
  unitEffectRunId,
  unitEffectTombstoneMatches,
  type UnitEffectRunEvidence,
  type UnitEffectTransition,
  type UnitEffectTransitionResult,
} from "./unitEffect.js";
import type { MainTaskLink } from "./mainTaskLink.js";
export type { MainTaskLink } from "./mainTaskLink.js";
import type { Secrets } from "../../secrets.js";
import type { RunHistoryConfig } from "../runStore.js";
import { DEFAULT_RUN_STORE_TOKEN_ENV, RUN_STORE_KEY, RUN_STORE_TIMEOUT_MS } from "../runStoreWorker.js";
import {
  capThreadEvent,
  isCoordinatorInstance,
  isCoordinatorUnit,
  isMainTaskKey,
  mainTaskBindingMatches,
  mainTaskClaimMatches,
  preserveWorkBrief,
  prepareUnfencedUnitWrite,
  permitsRecoveryMetadataWrite,
  CoordinatorUnitWriteConflict,
  coordinatorUnitCanBeDiscarded,
  isThreadEvent,
  type CoordinatorInstance,
  type CoordinatorUnit,
  type MainTaskKey,
  type MainTaskBinding,
  type ThreadEvent,
  type UnitWakeAnswer,
} from "./contract.js";
import {
  compareSlackMessageId,
  isRequesterTurnInput,
  sameMainTaskAuthority,
  type MainTaskAuthority,
  type RecordRequesterTurnResult,
  type RequesterKey,
  type RequesterTurn,
  type RequesterTurnInput,
} from "./requesterAuthority.js";
import {
  prepareRecoveryTransition,
  planRecoveryTransition,
  recoveryActionId,
  recoveryHistoryPage,
  isRecoveryAction,
  isRecoveryReceipt,
  type RecoveryTransition,
  type RecoveryTransitionResult,
  type RecoveryRequest,
  type RecoveryAction,
  type RecoveryReceipt,
  type RecoveryHistoryPage,
} from "./recoveryHistory.js";

/** `exists`: a different record already holds the id (an identical put is
 *  idempotent); `unavailable`: no durable store in this process. */
export type PutInstanceResult = { ok: true } | { ok: false; reason: "exists" | "unavailable" };
export type ConfirmCreatedResult = { ok: true } | { ok: false; reason: "stale" | "unavailable" };
export type PutUnitsResult = { ok: true } | { ok: false; reason: PullBindingRefusal };
export type CompareAndReplaceUnitResult =
  { ok: true } | { ok: false; reason: "stale" | "unavailable" | "owned" | "incomplete" };
export type AppendEventResult =
  { ok: true; seq: number; event?: ThreadEvent } | { ok: false; reason: "ended" | "stale" | "unavailable" };
export type MarkConsumedResult = { ok: true } | { ok: false; reason: "unavailable" };
export type AnswerWakeResult = { ok: true } | { ok: false; reason: PullBindingRefusal };
export type MarkStoppedResult = { ok: true } | { ok: false; reason: "unknown_instance" | "stale" | "unavailable" };
export type ReserveDecisionRecordResult = { ok: true; number: string } | { ok: false; reason: "unavailable" };
export type ClaimMainTaskResult =
  { ok: true; created: boolean; link: MainTaskLink } | { ok: false; reason: "conflict" | PullBindingRefusal };

/** The (instance, unit) a thread event belongs to. */
export interface UnitEventKey {
  instanceId: string;
  unit: string;
}

/** What a caller appends: everything but the sequence the store assigns and
 *  the consumer a later step marks. */
export type ThreadEventInput = Omit<ThreadEvent, "seq" | "consumedBy">;

/** Requester status alone may classify an unreadable brief. The rest of the unit
 * remains strictly decoded; this snapshot cannot serve as a coding contract. */
export interface MainTaskUnitSnapshot {
  unit: CoordinatorUnit;
  brief: unknown;
}
function mainTaskUnitSnapshot(rows: unknown, key: UnitEventKey): MainTaskUnitSnapshot | null {
  if (!Array.isArray(rows)) throw new Error("main task unit snapshot unavailable");
  const matches = rows.filter((row) => typeof row === "object" && row !== null && row.unit === key.unit);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("main task unit snapshot is ambiguous");
  const { workBrief: brief, ...unit } = matches[0];
  if (unit.instanceId !== key.instanceId || unit.generatedTask !== undefined || !isCoordinatorUnit(unit))
    throw new Error("main task unit snapshot has invalid ownership or state");
  return { unit, brief };
}

export interface CoordinatorInstanceStore {
  /** Reserve the same unit cell from an already authorized command or native watch intent. */
  admitMaintenance(input: MaintenanceAdmissionInput): Promise<MaintenanceAdmissionResult>;
  /** Complete canonical owner snapshot; reservation must share this owner transaction. */
  findPullOwners(target: PullTarget): Promise<PullOwnersResult>;
  /** Native ended execution discovery persists an exact existing outbox offer. */
  offerReconciliation(key: UnitEventKey): Promise<{ offered: boolean }>;
  transitionRecovery(input: RecoveryTransition): Promise<RecoveryTransitionResult>;
  /** Reads stop, execution, complete owner facts and the whole unit in one transaction. */
  transitionUnitEffect(input: UnitEffectTransition): Promise<UnitEffectTransitionResult>;
  getRecoveryAction(key: UnitEventKey, request: RecoveryRequest | string): Promise<RecoveryAction | null>;
  listRecoveryHistory(key: UnitEventKey, after?: number): Promise<RecoveryHistoryPage>;
  /** The authenticated requester turn, outside model and session content. */
  recordRequesterTurn(input: RequesterTurnInput): Promise<RecordRequesterTurnResult>;
  latestRequesterTurn(key: RequesterKey): Promise<RequesterTurn | null>;
  /** An index from one main-agent decision to the existing Ship unit. */
  getMainTask(key: MainTaskKey): Promise<MainTaskLink | null>;
  /** Narrow status read: unknown brief data never relaxes listUnits or mutation validation. */
  readMainTaskUnit(key: UnitEventKey): Promise<MainTaskUnitSnapshot | null>;
  /** Atomically claim the index, instance and first unit. A replay returns the
   * original link; another key cannot take an existing instance id. */
  claimMainTask(
    key: MainTaskKey,
    instance: CoordinatorInstance,
    unit: CoordinatorUnit,
    authority: MainTaskAuthority,
  ): Promise<ClaimMainTaskResult>;
  put(instance: CoordinatorInstance): Promise<PutInstanceResult>;
  /** The record written over whatever the id holds and the id's unit rows
   *  dropped — an attempt starting over: the leftover of one whose Workflow
   *  instance was never created, once the shim has said so. A private-task
   *  claim, publication or execution evidence refuses replacement as `exists`. */
  replace(instance: CoordinatorInstance): Promise<PutInstanceResult>;
  /** Mark only the exact saved pre-create record as created. Unit rows remain
   * untouched; a duplicate or a replaced owner cannot cross this fence. */
  confirmCreated(expected: CoordinatorInstance): Promise<ConfirmCreatedResult>;
  get(id: string): Promise<CoordinatorInstance | null>;
  /** The unit rows of an instance (run-history item 50), each replaced whole:
   *  written at the instance's creation and rewritten as the runner reaches the
   *  unit — its thread, its pull request, its rounds, its ending. A typed
   *  settlement rejects changed rows atomically with CoordinatorUnitWriteConflict;
   *  further changes require compareAndReplaceUnit. */
  putUnits(units: readonly CoordinatorUnit[]): Promise<PutUnitsResult>;
  /** Replace one unit only while its complete durable row still equals the
   * caller's expected row. A missing or changed row is stale, so concurrent
   * or delayed writers cannot overwrite newer unit state. */
  compareAndReplaceUnit(expected: CoordinatorUnit, replacement: CoordinatorUnit): Promise<CompareAndReplaceUnitResult>;
  /** An instance's unit rows in the order they were first written — the plan's. */
  listUnits(instanceId: string): Promise<CoordinatorUnit[]>;
  /** Every row carrying an active original-unit recovery claim. Boot ownership
   * recovery reads this index independently of the terminal parent Workflow. */
  listActiveRecoveries(): Promise<CoordinatorUnit[]>;
  /** Atomically reserve a decision-record number. The durable implementation
   * includes reservations already persisted on unit and run rows when choosing
   * the next number, so another bot process cannot reuse one after a restart. */
  reserveDecisionRecord(
    repo: string,
    taskKey: string,
    claimed: ReadonlySet<string>,
    existing?: string,
  ): Promise<ReserveDecisionRecordResult>;
  /** The hard stop's mark on the instance row (record 0060; issue 1924):
   *  written when the hosted parent is sealed, read back by the runner's plan,
   *  spawn and read-record routes. Idempotent — a marked row keeps its first
   *  mark; an id no record holds is `unknown_instance`. */
  markStopped(instanceId: string, at: number, binding?: MainTaskBinding): Promise<MarkStoppedResult>;
  /** A thread event onto the unit's list (record 0051's reply-as-event rule): the store assigns
   *  the next sequence and enforces the per-event cap (attachments dropped
   *  whole, the row saying how many). An `id` already on the unit returns its
   *  original sequence without appending, so a retried hand-off is stable. A
   *  sibling of the unit rows, never a
   *  field on them: `putUnits` replaces a row whole, and an append landing
   *  between a route's read and its put would be lost (record 0051). */
  appendEvent(
    key: UnitEventKey,
    event: ThreadEventInput,
    requireActive?: boolean,
    binding?: MainTaskBinding,
    expectedRecovery?: { actionId: string; workflowId: string },
  ): Promise<AppendEventResult>;
  /** The unit's events in sequence order; `unconsumedOnly` filters to the rows no spawn or run has consumed. */
  listEvents(key: UnitEventKey, unconsumedOnly?: boolean): Promise<ThreadEvent[]>;
  /** Named sequences consumed by a spawn step or a run — idempotent: a row already consumed keeps its first consumer. */
  markConsumed(key: UnitEventKey, seqs: readonly number[], by: string): Promise<MarkConsumedResult>;
  /** Store one indexed wake answer, its rewritten unit row and all event
   * consumption marks atomically. */
  answerWake(
    unit: CoordinatorUnit,
    waitId: string,
    answer: UnitWakeAnswer,
    seqs: readonly number[],
    by: string,
  ): Promise<AnswerWakeResult>;
}

const unitKey = (u: Pick<CoordinatorUnit, "instanceId" | "unit">) => `${u.instanceId}\0${u.unit}`;

export class InMemoryCoordinatorInstanceStore implements CoordinatorInstanceStore {
  async admitMaintenance(input: MaintenanceAdmissionInput): Promise<MaintenanceAdmissionResult> {
    if (!isMaintenanceAdmissionInput(input)) return { ok: false, reason: "conflict" };
    try {
      const prepared = await prepareMaintenanceAdmission(input);
      if (!this.runOwner) return { ok: false, reason: "unavailable" };
      const rows = this.pullOwnershipRows();
      const result = planMaintenanceAdmission(
        prepared,
        rows,
        [...this.rows.values()].map((row) => JSON.parse(row)),
      );
      if (!result.ok || result.replayed) return result;
      const existing = this.rows.get(result.instance.id);
      if (existing !== undefined && JSON.stringify(JSON.parse(existing)) !== JSON.stringify(result.instance))
        return { ok: false, reason: "stale" };
      // The complete scan and both owner rows share this synchronous mutation.
      this.rows.set(result.instance.id, JSON.stringify(result.instance));
      this.units.set(unitKey(result.unit), JSON.stringify(result.unit));
      return result;
    } catch {
      return { ok: false, reason: "incomplete" };
    }
  }
  constructor(
    private readonly runOwner?: Pick<
      InMemoryRunLedger,
      | "live"
      | "finished"
      | "events"
      | "finishedWorkEvidence"
      | "workspacePublicationRows"
      | "planeOffers"
      | "readSessionEntry"
    >,
    private readonly workflowStatus?: (workflowId: string) => Promise<string | undefined>,
  ) {}
  async offerReconciliation(key: UnitEventKey): Promise<{ offered: boolean }> {
    if (!this.runOwner || !this.workflowStatus) return { offered: false };
    const instance = await this.get(key.instanceId);
    const unit = (await this.listUnits(key.instanceId)).find((row) => row.unit === key.unit);
    if (!instance || !unit || !isCoordinatorInstance(instance) || !isCoordinatorUnit(unit)) return { offered: false };
    const actionId = unit.recovery?.actionId ?? (unit.recoveryReceipt ? unit.history?.receiptId : undefined);
    const action = actionId ? await this.getRecoveryAction(key, actionId) : undefined;
    if (
      (unit.recovery || unit.recoveryReceipt) &&
      (!action ||
        action.workflowId !== (unit.recovery?.workflowId ?? unit.recoveryReceipt?.workflowId) ||
        action.state !== (unit.recovery ? "pending" : "settled"))
    )
      return { offered: false };
    const effect = await coordinatorReconciliationEffect(instance, unit, action ?? undefined);
    if (this.runOwner.planeOffers.has(effect.id)) return { offered: false };
    const status = await this.workflowStatus(effect.workflowId);
    const eligible = await coordinatorReportCanReconcile(this.runOwner, instance, unit, action ?? undefined);
    if (
      !eligible ||
      !coordinatorWorkflowCanReconcile(instance, unit, action ?? undefined, status) ||
      this.rows.get(instance.id) !== JSON.stringify(instance) ||
      this.units.get(unitKey(unit)) !== JSON.stringify(unit)
    )
      return { offered: false };
    if (this.runOwner.planeOffers.size >= PLANE_EFFECTS_TOTAL_CAP) throw new Error("plane_effects total cap");
    this.runOwner.planeOffers.set(effect.id, effect);
    return { offered: true };
  }
  async findPullOwners(target: PullTarget): Promise<PullOwnersResult> {
    if (!isPullTarget(target)) return { ok: false, reason: "invalid" };
    if (!this.runOwner) return { ok: false, reason: "unavailable" };
    try {
      return findPullOwnersInRows(target, this.pullOwnershipRows());
    } catch {
      return { ok: false, reason: "incomplete" };
    }
  }
  private pullOwnershipRows(): PullOwnershipRows {
    if (!this.runOwner) throw new Error("pull owner unavailable");
    let count = 0,
      bytes = 0;
    const visit = (...text: string[]) => {
      count++;
      bytes += text.reduce((sum, item) => sum + 3 * item.length, 0);
      if (count > PULL_OWNER_SCAN_MAX || bytes > PULL_OWNER_SCAN_MAX_BYTES)
        throw new Error("pull owner scan incomplete");
    };
    for (const text of this.units.values()) {
      const unit = JSON.parse(text);
      visit(text, this.rows.get(unit.instanceId) ?? "");
    }
    for (const row of this.runOwner.live.values()) visit(JSON.stringify(row.meta), JSON.stringify(row.state));
    for (const record of this.runOwner.finished.values()) {
      const { events: _events, ...summary } = record;
      visit(JSON.stringify(summary), JSON.stringify(this.runOwner.finishedWorkEvidence.get(record.id) ?? {}));
    }
    const settlements = this.runOwner.workspacePublicationRows();
    for (const row of settlements) visit(JSON.stringify(row));
    if (
      [...this.runOwner.live.values()].some(
        (row) =>
          !isPullOwnerLiveMeta(row.meta) || !row.state || typeof row.state !== "object" || Array.isArray(row.state),
      )
    )
      throw new Error("unreadable pull owner");
    if ([...this.runOwner.finishedWorkEvidence.keys()].some((id) => !this.runOwner!.finished.has(id)))
      throw new Error("unreadable pull owner");
    return {
      complete: true,
      units: [...this.units.values()].map((text) => {
        const unit = JSON.parse(text);
        const owner = this.rows.get(unit.instanceId);
        return { unit, instance: owner === undefined ? undefined : JSON.parse(owner) };
      }),
      runs: [
        ...[...this.runOwner.live.values()].map((row) => ({
          runId: row.runId,
          repo: row.meta.repo,
          live: true,
          publication: row.state.branchPublication,
          door: row.state.doorPublicationPending,
        })),
        ...[...this.runOwner.finished.values()].map((row) => {
          if (!isRunRecord(row)) throw new Error("unreadable terminal producer");
          return {
            runId: row.id,
            repo: row.repo,
            live: false,
            record: row,
            pushReceipts: Object.hasOwn(this.runOwner!.finishedWorkEvidence.get(row.id) ?? {}, "branchPushReceipts")
              ? this.runOwner!.finishedWorkEvidence.get(row.id)!.branchPushReceipts
              : row.branchPushReceipts,
            publication: Object.hasOwn(this.runOwner!.finishedWorkEvidence.get(row.id) ?? {}, "branchPublication")
              ? this.runOwner!.finishedWorkEvidence.get(row.id)!.branchPublication
              : row.branchPublication,
            door: Object.hasOwn(this.runOwner!.finishedWorkEvidence.get(row.id) ?? {}, "doorPublicationPending")
              ? this.runOwner!.finishedWorkEvidence.get(row.id)!.doorPublicationPending
              : row.doorPublicationPending,
          };
        }),
      ],
      effects: [...this.runOwner.planeOffers.values()],
      settlements,
    };
  }
  private bindingRefusal(
    current: CoordinatorUnit | undefined,
    next: CoordinatorUnit,
    force = false,
    staged: readonly CoordinatorUnit[] = [],
    owner?: CoordinatorInstance,
  ): PullBindingRefusal | undefined {
    if (
      current?.ending &&
      !(
        current.reportDelivery === undefined &&
        isCoordinatorReportAdmission(next.reportDelivery) &&
        JSON.stringify(current) === JSON.stringify({ ...next, reportDelivery: undefined })
      ) &&
      (JSON.stringify(current.ending) !== JSON.stringify(next.ending) ||
        JSON.stringify(current.reportDelivery) !== JSON.stringify(next.reportDelivery)) &&
      [...(this.runOwner?.planeOffers.values() ?? [])].some(
        (effect) =>
          isCoordinatorReconcileEffect(effect) &&
          effect.instanceId === current.instanceId &&
          effect.unit === current.unit,
      )
    )
      return "stale";
    force ||= current?.startedAt === undefined && next.startedAt !== undefined;
    if (!force && !needsPullBindingAdmission(current, next)) return;
    try {
      const instance = owner ?? JSON.parse(this.rows.get(next.instanceId) ?? "null");
      if (!isCoordinatorInstance(instance)) return "incomplete";
      if (!force && !pullBindingChanges(instance, current, next)) return;
      if (!this.runOwner) return "unavailable";
      const rows = this.pullOwnershipRows();
      for (const unit of staged)
        rows.units.push({ unit, instance: JSON.parse(this.rows.get(unit.instanceId) ?? "null") });
      return unitPullBindingRefusal(rows, instance, current, next);
    } catch {
      return "incomplete";
    }
  }
  async transitionUnitEffect(input: UnitEffectTransition): Promise<UnitEffectTransitionResult> {
    if (!isUnitEffectTransition(input)) return { ok: false, reason: "conflict" };
    try {
      const instance = JSON.parse(this.rows.get(input.expected.instanceId) ?? "null");
      const current = JSON.parse(this.units.get(unitKey(input.expected)) ?? "null");
      if ((instance !== null && !isCoordinatorInstance(instance)) || (current !== null && !isCoordinatorUnit(current)))
        return { ok: false, reason: "incomplete" };
      const runId = unitEffectRunId(input);
      let evidence: UnitEffectRunEvidence | undefined;
      if (runId !== undefined && this.runOwner) {
        const live = this.runOwner.live.get(runId),
          finished = this.runOwner.finished.get(runId);
        if (live && (live.runId !== runId || live.threadKey !== live.meta.threadKey))
          return { ok: false, reason: "incomplete" };
        if (finished && (!isRunRecord(finished) || finished.id !== runId)) return { ok: false, reason: "incomplete" };
        if (live && finished && !unitEffectTombstoneMatches(live.meta, live.startedAt, finished))
          return { ok: false, reason: "incomplete" };
        if (!live && finished?.provisional === true) return { ok: false, reason: "unavailable" };
        const meta = live?.meta ?? finished;
        if (meta)
          evidence = {
            runId,
            meta,
            reviewTarget: live?.meta ?? finished!.events.find((e) => e.type === "run_meta"),
            startedAt: live?.startedAt ?? finished!.startedAt,
            tags: (live ? (this.runOwner.events.get(runId) ?? []) : finished!.events).filter(
              (e) => e.type === "coordinator_tag",
            ),
          };
      }
      const result = planUnitEffectTransition(input, instance, current ?? undefined, evidence);
      if (!result.ok) return result;
      if (input.kind === "admit") {
        if (!this.runOwner) return { ok: false, reason: "unavailable" };
        const reason = unitPullTargetsRefusal(this.pullOwnershipRows(), instance, result.unit);
        if (reason) return { ok: false, reason };
      }
      // No awaits separate these owner reads from their single mutation.
      const serialized = JSON.stringify(result.unit);
      this.units.set(unitKey(input.expected), serialized);
      return result;
    } catch {
      return { ok: false, reason: "incomplete" };
    }
  }
  private readonly recoveryActions = new Map<string, string>();
  private readonly recoveryReceipts = new Map<string, string>();
  async transitionRecovery(input: RecoveryTransition): Promise<RecoveryTransitionResult> {
    const prepared = await prepareRecoveryTransition(input);
    const key = unitKey(input.expected);
    const read = <T>(map: Map<string, string>): T[] =>
      [...map].filter(([id]) => id.startsWith(`${key}\0`)).map(([, value]) => JSON.parse(value) as T);
    const current = this.units.get(key);
    const instance = this.rows.get(input.expected.instanceId);
    const result = planRecoveryTransition(
      prepared,
      instance ? JSON.parse(instance) : null,
      current ? JSON.parse(current) : undefined,
      {
        actions: read<RecoveryAction>(this.recoveryActions),
        receipts: read<RecoveryReceipt>(this.recoveryReceipts),
        ...(input.expected.workBrief
          ? { mainTask: this.mainTasks.get(this.mainTaskKey(input.expected.workBrief)) }
          : {}),
      },
    );
    if (!result.ok) return result;
    if (input.kind === "claim" && !result.replayed) {
      const reason = this.bindingRefusal(input.expected, result.unit, true);
      if (reason) return { ok: false, reason };
    }
    if (result.receipt) this.recoveryReceipts.set(`${key}\0${result.receipt.id}`, JSON.stringify(result.receipt));
    if (result.action) this.recoveryActions.set(`${key}\0${result.action.id}`, JSON.stringify(result.action));
    this.units.set(key, JSON.stringify(result.unit));
    return { ok: true, unit: result.unit, ...(result.replayed ? { replayed: true } : {}) };
  }
  async getRecoveryAction(key: UnitEventKey, request: RecoveryRequest | string): Promise<RecoveryAction | null> {
    const actionId = typeof request === "string" ? request : await recoveryActionId(key, request);
    if (!/^r_[a-f0-9]{64}$/.test(actionId)) throw new Error("invalid recovery action identity");
    const value = this.recoveryActions.get(`${unitKey(key)}\0${actionId}`);
    return value ? (JSON.parse(value) as RecoveryAction) : null;
  }
  async listRecoveryHistory(key: UnitEventKey, after = 0): Promise<RecoveryHistoryPage> {
    return recoveryHistoryPage(
      [...this.recoveryReceipts]
        .filter(([id]) => id.startsWith(`${unitKey(key)}\0`))
        .map(([, value]) => JSON.parse(value) as RecoveryReceipt),
      after,
    );
  }
  private readonly rows = new Map<string, string>();
  /** Insertion-ordered, so a replace keeps a row's place. */
  private readonly units = new Map<string, string>();
  private readonly decisionRecords = new Map<string, string>();
  private readonly mainTasks = new Map<string, MainTaskLink>();
  private readonly requesterTurns = new Map<string, RequesterTurn>();
  /** The unit event lists, by unit key — the Worker's `coordinator_unit_events` table mirrored. */
  private readonly events = new Map<string, ThreadEvent[]>();
  private mainTaskKey(key: MainTaskKey): string {
    return `${key.mainThreadKey}\0${key.actId}`;
  }
  private requesterKey(key: RequesterKey): string {
    return `${key.threadKey}\0${key.requesterId}`;
  }
  async recordRequesterTurn(input: RequesterTurnInput): Promise<RecordRequesterTurnResult> {
    if (!isRequesterTurnInput(input)) return { ok: false, reason: "conflict" };
    const key = this.requesterKey(input);
    const previous = this.requesterTurns.get(key);
    if (previous && previous.messageId === input.messageId)
      return previous.questionTarget === input.questionTarget
        ? { ok: true, turn: previous }
        : { ok: false, reason: "conflict" };
    if (previous && compareSlackMessageId(input.messageId, previous.messageId) <= 0)
      return { ok: false, reason: "conflict" };
    const turn: RequesterTurn = {
      ...input,
      revision: (previous?.revision ?? 0) + 1,
      ...(previous?.questionTarget !== undefined ? { priorQuestionTarget: previous.questionTarget } : {}),
    };
    this.requesterTurns.set(key, turn);
    return { ok: true, turn };
  }
  async latestRequesterTurn(key: RequesterKey): Promise<RequesterTurn | null> {
    return this.requesterTurns.get(this.requesterKey(key)) ?? null;
  }
  async getMainTask(key: MainTaskKey): Promise<MainTaskLink | null> {
    return this.mainTasks.get(this.mainTaskKey(key)) ?? null;
  }
  async claimMainTask(
    key: MainTaskKey,
    instance: CoordinatorInstance,
    unit: CoordinatorUnit,
    authority: MainTaskAuthority,
  ): Promise<ClaimMainTaskResult> {
    if (
      !isMainTaskKey(key) ||
      !isCoordinatorInstance(instance) ||
      !isCoordinatorUnit(unit) ||
      unit.currentEffect !== undefined ||
      !mainTaskClaimMatches(key, instance, unit) ||
      authority.requesterId !== instance.userId ||
      authority.repo.toLowerCase() !== instance.repo.toLowerCase()
    )
      return { ok: false, reason: "conflict" };
    const prior = this.mainTasks.get(this.mainTaskKey(key));
    if (prior !== undefined)
      return sameMainTaskAuthority(prior.authority, authority)
        ? { ok: true, created: false, link: prior }
        : { ok: false, reason: "conflict" };
    const current = this.requesterTurns.get(
      this.requesterKey({ threadKey: key.mainThreadKey, requesterId: authority.requesterId }),
    );
    if (current?.messageId !== authority.sourceMessageId || current.revision !== authority.revision)
      return { ok: false, reason: "conflict" };
    if (this.rows.has(instance.id) || this.units.has(unitKey(unit))) return { ok: false, reason: "conflict" };
    const reason = this.bindingRefusal(undefined, unit, true, [], instance);
    if (reason) return { ok: false, reason };
    const link = { instanceId: instance.id, unit: unit.unit, authority };
    const instanceText = JSON.stringify(instance);
    const unitText = JSON.stringify(unit);
    this.rows.set(instance.id, instanceText);
    this.units.set(unitKey(unit), unitText);
    this.mainTasks.set(this.mainTaskKey(key), link);
    return { ok: true, created: true, link };
  }
  async put(instance: CoordinatorInstance): Promise<PutInstanceResult> {
    const text = JSON.stringify(instance);
    const existing = this.rows.get(instance.id);
    if (existing !== undefined && existing !== text) return { ok: false, reason: "exists" };
    this.rows.set(instance.id, text);
    return { ok: true };
  }
  async replace(instance: CoordinatorInstance): Promise<PutInstanceResult> {
    if (
      [...this.mainTasks.values()].some((link) => link.instanceId === instance.id) ||
      [...this.recoveryActions.keys(), ...this.recoveryReceipts.keys()].some((key) =>
        key.startsWith(`${instance.id}\0`),
      )
    )
      return { ok: false, reason: "exists" };
    if (
      [...this.units].some(([key, text]) => key.startsWith(`${instance.id}\0`) && !coordinatorUnitCanBeDiscarded(text))
    )
      return { ok: false, reason: "exists" };
    this.rows.set(instance.id, JSON.stringify(instance));
    for (const key of [...this.units.keys()]) if (key.startsWith(`${instance.id}\0`)) this.units.delete(key);
    return { ok: true };
  }
  async confirmCreated(expected: CoordinatorInstance): Promise<ConfirmCreatedResult> {
    if (expected.admission !== "unreconciled") return { ok: false, reason: "stale" };
    const confirmed = JSON.stringify({ ...expected, admission: "created" });
    const current = this.rows.get(expected.id);
    if (current === confirmed) return { ok: true };
    if (current !== JSON.stringify(expected)) return { ok: false, reason: "stale" };
    this.rows.set(expected.id, confirmed);
    return { ok: true };
  }
  async get(id: string): Promise<CoordinatorInstance | null> {
    const text = this.rows.get(id);
    return text === undefined ? null : (JSON.parse(text) as CoordinatorInstance);
  }
  async putUnits(units: readonly CoordinatorUnit[]): Promise<PutUnitsResult> {
    const pending = new Map<string, CoordinatorUnit>();
    for (const u of units) {
      const current = pending.get(unitKey(u)) ?? this.units.get(unitKey(u));
      pending.set(unitKey(u), prepareUnfencedUnitWrite(typeof current === "string" ? JSON.parse(current) : current, u));
    }
    for (const [key, next] of pending) {
      const current = this.units.get(key);
      const reason = this.bindingRefusal(current ? JSON.parse(current) : undefined, next, false, [...pending.values()]);
      if (reason) return { ok: false, reason };
    }
    const serialized = [...pending].map(([key, next]) => [key, JSON.stringify(next)] as const);
    for (const [key, text] of serialized) this.units.set(key, text);
    return { ok: true };
  }
  async compareAndReplaceUnit(
    expected: CoordinatorUnit,
    replacement: CoordinatorUnit,
  ): Promise<CompareAndReplaceUnitResult> {
    const key = unitKey(expected);
    if (
      unitKey(replacement) !== key ||
      this.units.get(key) !== JSON.stringify(expected) ||
      !permitsRecoveryMetadataWrite(expected, replacement, true)
    )
      return { ok: false, reason: "stale" };
    const reason = this.bindingRefusal(expected, replacement);
    if (reason) return { ok: false, reason };
    this.units.set(key, JSON.stringify(preserveWorkBrief(expected, replacement)));
    return { ok: true };
  }
  async readMainTaskUnit(key: UnitEventKey): Promise<MainTaskUnitSnapshot | null> {
    const text = this.units.get(unitKey(key));
    return mainTaskUnitSnapshot(text === undefined ? [] : [JSON.parse(text)], key);
  }
  async listUnits(instanceId: string): Promise<CoordinatorUnit[]> {
    const out: CoordinatorUnit[] = [];
    for (const [key, text] of this.units)
      if (key.startsWith(`${instanceId}\0`)) out.push(JSON.parse(text) as CoordinatorUnit);
    return out;
  }
  async listActiveRecoveries(): Promise<CoordinatorUnit[]> {
    return [...this.units.values()]
      .map((text) => JSON.parse(text) as CoordinatorUnit)
      .filter((unit) => unit.recovery !== undefined);
  }
  async reserveDecisionRecord(
    repo: string,
    taskKey: string,
    claimed: ReadonlySet<string>,
    existing?: string,
  ): Promise<ReserveDecisionRecordResult> {
    const key = `${repo}\n${taskKey}`;
    const prior = this.decisionRecords.get(key);
    if (prior !== undefined) return { ok: true, number: prior };
    const used = new Set(claimed);
    for (const [reservationKey, number] of this.decisionRecords)
      if (reservationKey.startsWith(`${repo}\n`)) used.add(number);
    for (const text of this.units.values()) {
      const unit = JSON.parse(text) as CoordinatorUnit;
      const instanceText = this.rows.get(unit.instanceId);
      if (instanceText === undefined || (JSON.parse(instanceText) as CoordinatorInstance).repo !== repo) continue;
      if (unit.record !== undefined) used.add(unit.record);
    }
    const highest = [...used].reduce((max, value) => (/^\d{4}$/.test(value) ? Math.max(max, Number(value)) : max), 0);
    const number = existing ?? String(highest + 1).padStart(4, "0");
    this.decisionRecords.set(key, number);
    return { ok: true, number };
  }
  async markStopped(instanceId: string, at: number, binding?: MainTaskBinding): Promise<MarkStoppedResult> {
    const text = this.rows.get(instanceId);
    if (text === undefined) return { ok: false, reason: "unknown_instance" };
    const instance = JSON.parse(text) as CoordinatorInstance;
    if (binding !== undefined) {
      const unitText = this.units.get(unitKey(binding));
      const unit = unitText ? (JSON.parse(unitText) as CoordinatorUnit) : undefined;
      if (
        binding.instanceId !== instanceId ||
        !mainTaskBindingMatches(binding, this.mainTasks.get(this.mainTaskKey(binding.key)) ?? null, instance, unit)
      )
        return { ok: false, reason: "stale" };
    }
    if (instance.stop === undefined) this.rows.set(instanceId, JSON.stringify({ ...instance, stop: { at } }));
    return { ok: true };
  }
  async appendEvent(
    key: UnitEventKey,
    event: ThreadEventInput,
    requireActive = false,
    binding?: MainTaskBinding,
    expectedRecovery?: { actionId: string; workflowId: string },
  ): Promise<AppendEventResult> {
    if (requireActive || binding !== undefined || expectedRecovery !== undefined) {
      const instanceText = this.rows.get(key.instanceId);
      const unitText = this.units.get(unitKey(key));
      const instance = instanceText ? (JSON.parse(instanceText) as CoordinatorInstance) : undefined;
      const unit = unitText ? (JSON.parse(unitText) as CoordinatorUnit) : undefined;
      if (
        binding !== undefined &&
        (binding.instanceId !== key.instanceId ||
          binding.unit !== key.unit ||
          !mainTaskBindingMatches(binding, this.mainTasks.get(this.mainTaskKey(binding.key)) ?? null, instance, unit))
      )
        return { ok: false, reason: "stale" };
      if (expectedRecovery !== undefined) {
        const actionText = this.recoveryActions.get(`${unitKey(key)}\0${expectedRecovery.actionId}`);
        const action = actionText ? JSON.parse(actionText) : undefined;
        if (
          !requireActive ||
          !instance ||
          !unit ||
          !isCoordinatorInstance(instance) ||
          !isCoordinatorUnit(unit) ||
          !isRecoveryAction(action) ||
          action.state !== "pending" ||
          action.id !== expectedRecovery.actionId ||
          action.instanceId !== key.instanceId ||
          action.unit !== key.unit ||
          action.workflowId !== expectedRecovery.workflowId ||
          unit.recovery?.actionId !== expectedRecovery.actionId ||
          unit.recovery.workflowId !== expectedRecovery.workflowId
        )
          return { ok: false, reason: "stale" };
      }
      if (
        !instance ||
        !unit ||
        instance.stop ||
        unit.ending ||
        (unit.recovery && !expectedRecovery) ||
        unit.recoveryHold
      )
        return { ok: false, reason: "ended" };
    }
    const list = this.events.get(unitKey(key)) ?? [];
    // A channel message id and the ship hand-off's seed id are durable event
    // identities. Returning the first row makes an append retry idempotent;
    // events without an id retain the append-every-time behavior.
    const existing = event.id !== undefined ? list.find((e) => e.id === event.id) : undefined;
    if (existing !== undefined)
      return binding === undefined ? { ok: true, seq: existing.seq } : { ok: true, seq: existing.seq, event: existing };
    const seq = (list[list.length - 1]?.seq ?? 0) + 1;
    const stored = capThreadEvent({ ...event, seq });
    list.push(stored);
    this.events.set(unitKey(key), list);
    return binding === undefined ? { ok: true, seq } : { ok: true, seq, event: stored };
  }
  async listEvents(key: UnitEventKey, unconsumedOnly = false): Promise<ThreadEvent[]> {
    const list = this.events.get(unitKey(key)) ?? [];
    return list.filter((e) => !unconsumedOnly || e.consumedBy === undefined).map((e) => ({ ...e }));
  }
  async markConsumed(key: UnitEventKey, seqs: readonly number[], by: string): Promise<MarkConsumedResult> {
    const list = this.events.get(unitKey(key)) ?? [];
    for (const e of list) if (seqs.includes(e.seq) && e.consumedBy === undefined) e.consumedBy = by;
    return { ok: true };
  }
  async answerWake(
    unit: CoordinatorUnit,
    waitId: string,
    answer: UnitWakeAnswer,
    seqs: readonly number[],
    by: string,
  ): Promise<AnswerWakeResult> {
    const updated = { ...unit, wakes: { ...(unit.wakes ?? {}), [waitId]: answer } };
    const current = this.units.get(unitKey(updated));
    const existing = current ? JSON.parse(current) : undefined;
    const prepared = prepareUnfencedUnitWrite(existing, updated);
    const reason = this.bindingRefusal(existing, prepared);
    if (reason) return { ok: false, reason };
    this.units.set(unitKey(prepared), JSON.stringify(prepared));
    const list = this.events.get(unitKey(unit)) ?? [];
    for (const e of list) if (seqs.includes(e.seq) && e.consumedBy === undefined) e.consumedBy = by;
    return { ok: true };
  }
}

/** Without a durable state Worker, writes refuse and unit-owner reads are
 *  unavailable rather than evidence that the instance has no units. */
export class NullCoordinatorInstanceStore implements CoordinatorInstanceStore {
  async admitMaintenance(): Promise<MaintenanceAdmissionResult> {
    return { ok: false, reason: "unavailable" };
  }
  async offerReconciliation(): Promise<{ offered: boolean }> {
    return { offered: false };
  }
  async findPullOwners(_target: PullTarget): Promise<PullOwnersResult> {
    return { ok: false, reason: "unavailable" };
  }
  async transitionUnitEffect(_input: UnitEffectTransition): Promise<UnitEffectTransitionResult> {
    return { ok: false, reason: "unavailable" };
  }
  async transitionRecovery(): Promise<RecoveryTransitionResult> {
    return { ok: false, reason: "unavailable" };
  }
  async getRecoveryAction(): Promise<RecoveryAction | null> {
    throw new Error("recovery action store unavailable");
  }
  async listRecoveryHistory(): Promise<RecoveryHistoryPage> {
    throw new Error("recovery history store unavailable");
  }
  async recordRequesterTurn(_input: RequesterTurnInput): Promise<RecordRequesterTurnResult> {
    return { ok: false, reason: "unavailable" };
  }
  async latestRequesterTurn(_key: RequesterKey): Promise<RequesterTurn | null> {
    return null;
  }
  async getMainTask(_key: MainTaskKey): Promise<MainTaskLink | null> {
    return null;
  }
  async claimMainTask(
    _key: MainTaskKey,
    _instance: CoordinatorInstance,
    _unit: CoordinatorUnit,
    _authority: MainTaskAuthority,
  ): Promise<ClaimMainTaskResult> {
    return { ok: false, reason: "unavailable" };
  }
  async put(_instance: CoordinatorInstance): Promise<PutInstanceResult> {
    return { ok: false, reason: "unavailable" };
  }
  async replace(_instance: CoordinatorInstance): Promise<PutInstanceResult> {
    return { ok: false, reason: "unavailable" };
  }
  async confirmCreated(_expected: CoordinatorInstance): Promise<ConfirmCreatedResult> {
    return { ok: false, reason: "unavailable" };
  }
  async get(_id: string): Promise<CoordinatorInstance | null> {
    return null;
  }
  async putUnits(_units: readonly CoordinatorUnit[]): Promise<PutUnitsResult> {
    return { ok: false, reason: "unavailable" };
  }
  async compareAndReplaceUnit(
    _expected: CoordinatorUnit,
    _replacement: CoordinatorUnit,
  ): Promise<CompareAndReplaceUnitResult> {
    return { ok: false, reason: "unavailable" };
  }
  async readMainTaskUnit(_key: UnitEventKey): Promise<MainTaskUnitSnapshot | null> {
    throw new Error("coordinator instance store unavailable");
  }
  async listUnits(_instanceId: string): Promise<CoordinatorUnit[]> {
    throw new Error("coordinator instance store unavailable");
  }
  async listActiveRecoveries(): Promise<CoordinatorUnit[]> {
    return [];
  }
  async reserveDecisionRecord(
    _repo: string,
    _taskKey: string,
    _claimed: ReadonlySet<string>,
    _existing?: string,
  ): Promise<ReserveDecisionRecordResult> {
    return { ok: false, reason: "unavailable" };
  }
  async markStopped(_instanceId: string, _at: number, _binding?: MainTaskBinding): Promise<MarkStoppedResult> {
    return { ok: false, reason: "unavailable" };
  }
  async appendEvent(
    _key: UnitEventKey,
    _event: ThreadEventInput,
    _requireActive = false,
    _binding?: MainTaskBinding,
    _expectedRecovery?: { actionId: string; workflowId: string },
  ): Promise<AppendEventResult> {
    return { ok: false, reason: "unavailable" };
  }
  async listEvents(_key: UnitEventKey, _unconsumedOnly?: boolean): Promise<ThreadEvent[]> {
    return [];
  }
  async markConsumed(_key: UnitEventKey, _seqs: readonly number[], _by: string): Promise<MarkConsumedResult> {
    return { ok: false, reason: "unavailable" };
  }
  async answerWake(
    _unit: CoordinatorUnit,
    _waitId: string,
    _answer: UnitWakeAnswer,
    _seqs: readonly number[],
    _by: string,
  ): Promise<AnswerWakeResult> {
    return { ok: false, reason: "unavailable" };
  }
}

export interface WorkerCoordinatorInstanceStoreOptions {
  baseUrl: string;
  /** The state Worker's bearer (MEMORY_TOKEN). */
  token: string;
  /** The run-history object the records live beside (`runs:default`). */
  storeKey: string;
  fetch?: typeof fetch;
}

/** The state Worker's `coordinator_instances` table over
 *  `POST /runs/coordinator/put|get` — the same bearer, store key and timeout as
 *  the run store's client. An answer this client cannot read is thrown, never
 *  read as "no instance": a spawn on a guess would be a spawn nobody asked for. */
export class WorkerCoordinatorInstanceStore implements CoordinatorInstanceStore {
  async admitMaintenance(input: MaintenanceAdmissionInput): Promise<MaintenanceAdmissionResult> {
    if (!isMaintenanceAdmissionInput(input)) return { ok: false, reason: "conflict" };
    try {
      const response = await this.post("/runs/coordinator/maintenance/admit", { input });
      if (!isMaintenanceAdmissionResult(response.data)) return { ok: false, reason: "unavailable" };
      const result = response.data;
      if (!result.ok) return response.status === 409 ? result : { ok: false, reason: "unavailable" };
      const prepared = await prepareMaintenanceAdmission(input);
      if (response.status !== 200 || !maintenanceAdmissionMatches(prepared, result))
        return { ok: false, reason: "unavailable" };
      return result;
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }
  async offerReconciliation(key: UnitEventKey): Promise<{ offered: boolean }> {
    const response = await this.post("/runs/coordinator/reconcile/offer", { ...key });
    const result = response.data as { offered?: unknown };
    if (response.status === 200 && typeof result.offered === "boolean") return { offered: result.offered };
    throw new Error(`coordinator reconciliation unavailable (HTTP ${response.status})`);
  }
  async findPullOwners(target: PullTarget): Promise<PullOwnersResult> {
    try {
      const response = await this.post("/runs/coordinator/pull-owners", { target });
      if (response.status !== 200 || !isPullOwnersResult(response.data)) return { ok: false, reason: "unavailable" };
      return response.data;
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }
  async transitionUnitEffect(input: UnitEffectTransition): Promise<UnitEffectTransitionResult> {
    if (!isUnitEffectTransition(input)) return { ok: false, reason: "conflict" };
    try {
      const response = await this.post("/runs/coordinator/units/effect-transition", { input });
      if (!isUnitEffectTransitionResult(response.data)) return { ok: false, reason: "unavailable" };
      const result = response.data;
      if (!result.ok) return response.status === 409 ? result : { ok: false, reason: "unavailable" };
      if (
        response.status !== 200 ||
        result.unit.instanceId !== input.expected.instanceId ||
        result.unit.unit !== input.expected.unit ||
        !unitEffectResultMatches(input, result.unit)
      )
        return { ok: false, reason: "unavailable" };
      return result;
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }
  async transitionRecovery(input: RecoveryTransition): Promise<RecoveryTransitionResult> {
    const response = await this.post("/runs/coordinator/recovery/transition", { input });
    const data = response.data as { ok?: unknown; reason?: unknown; unit?: unknown; replayed?: unknown };
    if (
      data.ok === true &&
      isCoordinatorUnit(data.unit) &&
      data.unit.instanceId === input.expected.instanceId &&
      data.unit.unit === input.expected.unit
    )
      return { ok: true, unit: data.unit, ...(data.replayed === true ? { replayed: true } : {}) };
    if (
      data.ok === false &&
      (data.reason === "stale" ||
        data.reason === "conflict" ||
        data.reason === "capacity" ||
        data.reason === "unavailable" ||
        data.reason === "owned" ||
        data.reason === "incomplete")
    )
      return { ok: false, reason: data.reason };
    throw new Error(`recovery transition unavailable (HTTP ${response.status})`);
  }
  async getRecoveryAction(key: UnitEventKey, request: RecoveryRequest | string): Promise<RecoveryAction | null> {
    const actionId = typeof request === "string" ? request : await recoveryActionId(key, request);
    if (!/^r_[a-f0-9]{64}$/.test(actionId)) throw new Error("invalid recovery action identity");
    const response = await this.post("/runs/coordinator/recovery/action", {
      key,
      ...(typeof request === "string" ? { actionId } : { request }),
    });
    const action = (response.data as { action?: unknown }).action;
    if (action === null) return null;
    if (
      !isRecoveryAction(action) ||
      action.instanceId !== key.instanceId ||
      action.unit !== key.unit ||
      action.id !== actionId
    )
      throw new Error("invalid recovery action response");
    return action;
  }
  async listRecoveryHistory(key: UnitEventKey, after = 0): Promise<RecoveryHistoryPage> {
    const response = await this.post("/runs/coordinator/recovery/history", { key, after });
    const page = response.data as RecoveryHistoryPage;
    if (
      !Array.isArray(page.receipts) ||
      !page.receipts.every(
        (row) => isRecoveryReceipt(row) && row.instanceId === key.instanceId && row.unit === key.unit,
      ) ||
      typeof page.more !== "boolean"
    )
      throw new Error("invalid recovery history response");
    const checked = recoveryHistoryPage(page.receipts, after);
    if (
      checked.cursor !== page.cursor ||
      checked.receipts.length !== page.receipts.length ||
      page.receipts.some((row, i) => row.seq <= (i === 0 ? after : page.receipts[i - 1]!.seq))
    )
      throw new Error("invalid recovery history cursor");
    return page;
  }
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WorkerCoordinatorInstanceStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
      body: JSON.stringify({ storeKey: this.opts.storeKey, ...body }),
      signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 409) throw new Error(`coordinator store ${path}: HTTP ${res.status}`);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error(`coordinator store ${path}: non-JSON body (HTTP ${res.status})`);
    }
    return { status: res.status, data };
  }

  async recordRequesterTurn(input: RequesterTurnInput): Promise<RecordRequesterTurnResult> {
    const r = await this.post("/runs/coordinator/requester-turn/record", { input });
    const d = r.data as { ok?: unknown; reason?: unknown; turn?: unknown };
    if (r.status === 409 && d.reason === "conflict") return { ok: false, reason: "conflict" };
    if (d.ok === true && d.turn && typeof d.turn === "object") return { ok: true, turn: d.turn as RequesterTurn };
    throw new Error(`coordinator store requester-turn/record: unexpected answer (HTTP ${r.status})`);
  }

  async latestRequesterTurn(key: RequesterKey): Promise<RequesterTurn | null> {
    const r = await this.post("/runs/coordinator/requester-turn/latest", { key });
    const d = r.data as { turn?: unknown };
    if (d.turn === null) return null;
    if (d.turn && typeof d.turn === "object") return d.turn as RequesterTurn;
    throw new Error(`coordinator store requester-turn/latest: unexpected answer (HTTP ${r.status})`);
  }

  async getMainTask(key: MainTaskKey): Promise<MainTaskLink | null> {
    const r = await this.post("/runs/coordinator/main-task/get", { key });
    const d = r.data as { link?: unknown };
    if (d.link === null) return null;
    if (
      typeof d.link === "object" &&
      d.link !== null &&
      typeof (d.link as MainTaskLink).instanceId === "string" &&
      typeof (d.link as MainTaskLink).unit === "string"
    )
      return d.link as MainTaskLink;
    throw new Error(`coordinator store /runs/coordinator/main-task/get: unexpected answer (HTTP ${r.status})`);
  }

  async claimMainTask(
    key: MainTaskKey,
    instance: CoordinatorInstance,
    unit: CoordinatorUnit,
    authority: MainTaskAuthority,
  ): Promise<ClaimMainTaskResult> {
    const r = await this.post("/runs/coordinator/main-task/claim", { key, instance, unit, authority });
    const d = r.data as { ok?: unknown; created?: unknown; link?: unknown; reason?: unknown };
    if (r.status === 409 && d.reason === "conflict") return { ok: false, reason: "conflict" };
    if (
      d.ok === true &&
      typeof d.created === "boolean" &&
      typeof d.link === "object" &&
      d.link !== null &&
      typeof (d.link as MainTaskLink).instanceId === "string" &&
      typeof (d.link as MainTaskLink).unit === "string"
    )
      return { ok: true, created: d.created, link: d.link as MainTaskLink };
    throw new Error(`coordinator store /runs/coordinator/main-task/claim: unexpected answer (HTTP ${r.status})`);
  }

  async put(instance: CoordinatorInstance): Promise<PutInstanceResult> {
    const r = await this.post("/runs/coordinator/put", { instance });
    const d = r.data as { ok?: unknown; reason?: unknown };
    if (r.status === 409 && d.reason === "exists") return { ok: false, reason: "exists" };
    if (d.ok === true) return { ok: true };
    throw new Error(`coordinator store /runs/coordinator/put: unexpected answer (HTTP ${r.status})`);
  }

  async replace(instance: CoordinatorInstance): Promise<PutInstanceResult> {
    const r = await this.post("/runs/coordinator/replace", { instance });
    const d = r.data as { ok?: unknown; reason?: unknown };
    if (r.status === 409 && d.reason === "exists") return { ok: false, reason: "exists" };
    if (d.ok === true) return { ok: true };
    throw new Error(`coordinator store /runs/coordinator/replace: unexpected answer (HTTP ${r.status})`);
  }

  async confirmCreated(expected: CoordinatorInstance): Promise<ConfirmCreatedResult> {
    const r = await this.post("/runs/coordinator/admission/confirm", { expected });
    const d = r.data as { ok?: unknown; reason?: unknown };
    if (r.status === 409 && d.reason === "stale") return { ok: false, reason: "stale" };
    if (d.ok === true) return { ok: true };
    throw new Error(`coordinator store /runs/coordinator/admission/confirm: unexpected answer (HTTP ${r.status})`);
  }

  async get(id: string): Promise<CoordinatorInstance | null> {
    const r = await this.post("/runs/coordinator/get", { id });
    const d = r.data as { instance?: unknown };
    if (d.instance === null) return null;
    if (!isCoordinatorInstance(d.instance))
      throw new Error("coordinator store /runs/coordinator/get: the answer is not a coordinator instance");
    return d.instance;
  }

  async putUnits(units: readonly CoordinatorUnit[]): Promise<PutUnitsResult> {
    const r = await this.post("/runs/coordinator/units/put", { units });
    const d = r.data as { ok?: unknown; reason?: unknown };
    if (r.status === 409 && d.reason === "settled") throw new CoordinatorUnitWriteConflict();
    if (r.status === 409 && isPullBindingRefusal(d.reason)) return { ok: false, reason: d.reason };
    if (d.ok === true) return { ok: true };
    throw new Error(`coordinator store /runs/coordinator/units/put: unexpected answer (HTTP ${r.status})`);
  }

  async compareAndReplaceUnit(
    expected: CoordinatorUnit,
    replacement: CoordinatorUnit,
  ): Promise<CompareAndReplaceUnitResult> {
    // Keep the deployed wire spelling during the generic CAS transition: bot
    // and state Worker roll independently, while the seam above is truthful.
    const r = await this.post("/runs/coordinator/units/claim-legacy-continuation", {
      expected,
      recovered: replacement,
    });
    const d = r.data as { ok?: unknown; reason?: unknown };
    if (
      r.status === 409 &&
      (d.reason === "stale" || d.reason === "owned" || d.reason === "incomplete" || d.reason === "unavailable")
    )
      return { ok: false, reason: d.reason };
    if (d.ok === true) return { ok: true };
    throw new Error(
      `coordinator store /runs/coordinator/units/claim-legacy-continuation: unexpected answer (HTTP ${r.status})`,
    );
  }

  async readMainTaskUnit(key: UnitEventKey): Promise<MainTaskUnitSnapshot | null> {
    const r = await this.post("/runs/coordinator/units/list", { instanceId: key.instanceId });
    return mainTaskUnitSnapshot((r.data as { units?: unknown }).units, key);
  }

  async listUnits(instanceId: string): Promise<CoordinatorUnit[]> {
    const r = await this.post("/runs/coordinator/units/list", { instanceId });
    const d = r.data as { units?: unknown };
    if (!Array.isArray(d.units) || !d.units.every(isCoordinatorUnit))
      throw new Error("coordinator store /runs/coordinator/units/list: the answer is not a list of unit rows");
    return d.units;
  }

  async listActiveRecoveries(): Promise<CoordinatorUnit[]> {
    const r = await this.post("/runs/coordinator/units/list-active-recoveries", {});
    const d = r.data as { units?: unknown };
    if (
      !Array.isArray(d.units) ||
      !d.units.every(isCoordinatorUnit) ||
      d.units.some((unit) => unit.recovery === undefined)
    )
      throw new Error(
        "coordinator store /runs/coordinator/units/list-active-recoveries: the answer is not a recovery list",
      );
    return d.units;
  }

  async reserveDecisionRecord(
    repo: string,
    taskKey: string,
    claimed: ReadonlySet<string>,
    existing?: string,
  ): Promise<ReserveDecisionRecordResult> {
    const r = await this.post("/runs/decision-record/reserve", {
      repo,
      taskKey,
      claimed: [...claimed],
      ...(existing !== undefined ? { existing } : {}),
    });
    const d = r.data as { number?: unknown };
    if (typeof d.number === "string" && /^\d{4}$/.test(d.number)) return { ok: true, number: d.number };
    throw new Error(`coordinator store /runs/decision-record/reserve: unexpected answer (HTTP ${r.status})`);
  }

  async markStopped(instanceId: string, at: number, binding?: MainTaskBinding): Promise<MarkStoppedResult> {
    const r = await this.post("/runs/coordinator/stop", { instanceId, at, binding });
    const d = r.data as { ok?: unknown; reason?: unknown };
    if (r.status === 409 && d.reason === "unknown_instance") return { ok: false, reason: "unknown_instance" };
    if (r.status === 409 && d.reason === "stale") return { ok: false, reason: "stale" };
    if (d.ok === true) return { ok: true };
    throw new Error(`coordinator store /runs/coordinator/stop: unexpected answer (HTTP ${r.status})`);
  }

  async appendEvent(
    key: UnitEventKey,
    event: ThreadEventInput,
    requireActive = false,
    binding?: MainTaskBinding,
    expectedRecovery?: { actionId: string; workflowId: string },
  ): Promise<AppendEventResult> {
    // The state Worker caps again after assigning the sequence, but its HTTP
    // request-body fence runs first. Cap here too so an accepted 5–10 MB file
    // reaches that boundary as the small dropped-count row the store contract
    // promises, never as a transport-level 413.
    const capped = capThreadEvent(event);
    const r = await this.post("/runs/coordinator/events/append", {
      ...key,
      event: capped,
      requireActive,
      binding,
      expectedRecovery,
    });
    const d = r.data as { ok?: unknown; seq?: unknown; event?: unknown; reason?: unknown };
    if (d.ok === true && typeof d.seq === "number" && (d.event === undefined || isThreadEvent(d.event)))
      return { ok: true, seq: d.seq, ...(d.event === undefined ? {} : { event: d.event }) };
    if (r.status === 409 && d.reason === "ended") return { ok: false, reason: "ended" };
    if (r.status === 409 && d.reason === "stale") return { ok: false, reason: "stale" };
    throw new Error(`coordinator store /runs/coordinator/events/append: unexpected answer (HTTP ${r.status})`);
  }

  async listEvents(key: UnitEventKey, unconsumedOnly = false): Promise<ThreadEvent[]> {
    const r = await this.post("/runs/coordinator/events/list", { ...key, unconsumedOnly });
    const d = r.data as { events?: unknown };
    if (!Array.isArray(d.events) || !d.events.every(isThreadEvent))
      throw new Error("coordinator store /runs/coordinator/events/list: the answer is not a list of thread events");
    return d.events;
  }

  async markConsumed(key: UnitEventKey, seqs: readonly number[], by: string): Promise<MarkConsumedResult> {
    const r = await this.post("/runs/coordinator/events/mark-consumed", { ...key, seqs: [...seqs], by });
    const d = r.data as { ok?: unknown };
    if (d.ok === true) return { ok: true };
    throw new Error(`coordinator store /runs/coordinator/events/mark-consumed: unexpected answer (HTTP ${r.status})`);
  }
  async answerWake(
    unit: CoordinatorUnit,
    waitId: string,
    answer: UnitWakeAnswer,
    seqs: readonly number[],
    by: string,
  ): Promise<AnswerWakeResult> {
    const r = await this.post("/runs/coordinator/wake", { unit, waitId, answer, seqs: [...seqs], by });
    const d = r.data as { ok?: unknown; reason?: unknown };
    if (r.status === 409 && d.reason === "settled") throw new CoordinatorUnitWriteConflict();
    if (r.status === 409 && isPullBindingRefusal(d.reason)) return { ok: false, reason: d.reason };
    if (d.ok === true) return { ok: true };
    throw new Error(`coordinator store /runs/coordinator/wake: unexpected answer (HTTP ${r.status})`);
  }
}

/** The store a process runs with: the Worker's for a Worker-backed run history
 *  with its bearer set (the same config and secret the run store reads), the
 *  null store otherwise — no history, a file store, a missing bearer. */
export function buildCoordinatorInstanceStore(
  cfg: RunHistoryConfig | undefined,
  secrets: Secrets,
  deps: { fetch?: typeof fetch } = {},
): CoordinatorInstanceStore {
  if (!cfg || cfg.store === "file") return new NullCoordinatorInstanceStore();
  const worker = cfg.worker;
  if (!worker?.baseUrl) return new NullCoordinatorInstanceStore();
  const token = secrets.named(worker.tokenEnv ?? DEFAULT_RUN_STORE_TOKEN_ENV);
  if (!token) return new NullCoordinatorInstanceStore(); // buildRunStore already warned
  return new WorkerCoordinatorInstanceStore({
    baseUrl: worker.baseUrl,
    token: token.reveal(),
    storeKey: RUN_STORE_KEY,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
