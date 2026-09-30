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

/** `exists`: a different record already holds the id (an identical put is
 *  idempotent); `unavailable`: no durable store in this process. */
export type PutInstanceResult = { ok: true } | { ok: false; reason: "exists" | "unavailable" };
export type PutUnitsResult = { ok: true } | { ok: false; reason: "unavailable" };
export type CompareAndReplaceUnitResult = { ok: true } | { ok: false; reason: "stale" | "unavailable" };
export type AppendEventResult =
  { ok: true; seq: number; event?: ThreadEvent } | { ok: false; reason: "ended" | "stale" | "unavailable" };
export type MarkConsumedResult = { ok: true } | { ok: false; reason: "unavailable" };
export type AnswerWakeResult = { ok: true } | { ok: false; reason: "unavailable" };
export type MarkStoppedResult = { ok: true } | { ok: false; reason: "unknown_instance" | "stale" | "unavailable" };
export type ReserveDecisionRecordResult = { ok: true; number: string } | { ok: false; reason: "unavailable" };
export interface MainTaskLink {
  instanceId: string;
  unit: string;
  /** Missing on legacy links, which cannot authorize a new Workflow create. */
  authority?: MainTaskAuthority;
}
export type ClaimMainTaskResult =
  { ok: true; created: boolean; link: MainTaskLink } | { ok: false; reason: "conflict" | "unavailable" };

/** The (instance, unit) a thread event belongs to. */
export interface UnitEventKey {
  instanceId: string;
  unit: string;
}

/** What a caller appends: everything but the sequence the store assigns and
 *  the consumer a later step marks. */
export type ThreadEventInput = Omit<ThreadEvent, "seq" | "consumedBy">;

export interface CoordinatorInstanceStore {
  /** The authenticated requester turn, outside model and session content. */
  recordRequesterTurn(input: RequesterTurnInput): Promise<RecordRequesterTurnResult>;
  latestRequesterTurn(key: RequesterKey): Promise<RequesterTurn | null>;
  /** An index from one main-agent decision to the existing Ship unit. */
  getMainTask(key: MainTaskKey): Promise<MainTaskLink | null>;
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
   *  instance was never created, once the shim has said so. Never `exists`;
   *  the same `unavailable` as `put`. */
  replace(instance: CoordinatorInstance): Promise<PutInstanceResult>;
  get(id: string): Promise<CoordinatorInstance | null>;
  /** The unit rows of an instance (run-history item 50), each replaced whole:
   *  written at the instance's creation and rewritten as the runner reaches the
   *  unit — its thread, its pull request, its rounds, its ending. */
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
    const link = { instanceId: instance.id, unit: unit.unit, authority };
    this.rows.set(instance.id, JSON.stringify(instance));
    this.units.set(unitKey(unit), JSON.stringify(unit));
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
    if ([...this.mainTasks.values()].some((link) => link.instanceId === instance.id))
      return { ok: false, reason: "exists" };
    this.rows.set(instance.id, JSON.stringify(instance));
    for (const key of [...this.units.keys()]) if (key.startsWith(`${instance.id}\0`)) this.units.delete(key);
    return { ok: true };
  }
  async get(id: string): Promise<CoordinatorInstance | null> {
    const text = this.rows.get(id);
    return text === undefined ? null : (JSON.parse(text) as CoordinatorInstance);
  }
  async putUnits(units: readonly CoordinatorUnit[]): Promise<PutUnitsResult> {
    for (const u of units) {
      const current = this.units.get(unitKey(u));
      this.units.set(unitKey(u), JSON.stringify(preserveWorkBrief(current ? JSON.parse(current) : undefined, u)));
    }
    return { ok: true };
  }
  async compareAndReplaceUnit(
    expected: CoordinatorUnit,
    replacement: CoordinatorUnit,
  ): Promise<CompareAndReplaceUnitResult> {
    const key = unitKey(expected);
    if (unitKey(replacement) !== key || this.units.get(key) !== JSON.stringify(expected))
      return { ok: false, reason: "stale" };
    this.units.set(key, JSON.stringify(preserveWorkBrief(expected, replacement)));
    return { ok: true };
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
  ): Promise<AppendEventResult> {
    if (requireActive || binding !== undefined) {
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
      if (!instance || !unit || instance.stop || unit.ending || unit.recovery || unit.recoveryHold)
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
    this.units.set(
      unitKey(updated),
      JSON.stringify(preserveWorkBrief(current ? JSON.parse(current) : undefined, updated)),
    );
    const list = this.events.get(unitKey(unit)) ?? [];
    for (const e of list) if (seqs.includes(e.seq) && e.consumedBy === undefined) e.consumedBy = by;
    return { ok: true };
  }
}

/** The store of a process without a durable state Worker: no instance exists
 *  and none can be written, so every coordinator route answers by name. */
export class NullCoordinatorInstanceStore implements CoordinatorInstanceStore {
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
  async listUnits(_instanceId: string): Promise<CoordinatorUnit[]> {
    return [];
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
    const d = r.data as { ok?: unknown };
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
    if (r.status === 409 && d.reason === "stale") return { ok: false, reason: "stale" };
    if (d.ok === true) return { ok: true };
    throw new Error(
      `coordinator store /runs/coordinator/units/claim-legacy-continuation: unexpected answer (HTTP ${r.status})`,
    );
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
  ): Promise<AppendEventResult> {
    // The state Worker caps again after assigning the sequence, but its HTTP
    // request-body fence runs first. Cap here too so an accepted 5–10 MB file
    // reaches that boundary as the small dropped-count row the store contract
    // promises, never as a transport-level 413.
    const capped = capThreadEvent(event);
    const r = await this.post("/runs/coordinator/events/append", { ...key, event: capped, requireActive, binding });
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
    const d = r.data as { ok?: unknown };
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
