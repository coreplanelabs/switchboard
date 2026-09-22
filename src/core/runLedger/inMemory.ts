// The in-memory ledger: the reference implementation the bot's tests run
// against, applying the same pure decisions the Durable Object applies. It
// also documents the storage shape in the plainest form.

import { INTAKE_DELIVERY_CLAIM_MS } from "../budgets.js";
import { utf8ByteLength, type RunRecord } from "../runRecord.js";
import {
  checkFence,
  decideClaim,
  decideClaimWrite,
  decideIntakeInsert,
  phaseTransition,
  reclaimPhase,
  selectReclaim,
  unreadInbox,
} from "./decisions.js";
import type { FinishResult, HeartbeatFacts, HeartbeatResult, RunLedger } from "./ledger.js";
import {
  causeOfClose,
  causeOfReclaim,
  type PlaneAckOutcome,
  type PlaneAskAnswer,
  type PlaneEnding,
  type PlaneEndingCause,
  type PlaneOutcomePost,
  type PlaneQueueRow,
  type PlaneReclaimWord,
} from "../plane/decide.js";
import type { PlaneAdmitPost, PlaneLevelPost, PlaneObservePost } from "./ledger.js";
import {
  attachmentRefsOf,
  DEFAULT_SESSION_LOG_MAX_BYTES,
  droppedToolResultRow,
  GAP_MARKER,
  planSessionTrim,
  roleOfStoredRow,
  rowKind,
  tailCut,
  textOfStoredRow,
} from "./sessionLog.js";
import { tokenize } from "../memory/scorer.js";
import type { Notepad, SessionHit } from "./types.js";
import { assembleTranscript, turnRows, type AssembledTranscript } from "./transcript.js";
import type {
  AppendableEvent,
  ClaimRequest,
  ClaimResult,
  FenceResult,
  InboxItem,
  IntakeQuery,
  IntakeReceipt,
  IntakeWriteResult,
  LiveRunRow,
  ReclaimedRun,
  RunJob,
  RunState,
  StepRecord,
  StopMode,
  TranscriptAttachment,
  TranscriptRow,
  TranscriptTurn,
} from "./types.js";

interface Transcript {
  ownerGen: string;
  rows: TranscriptRow[];
  attachments: TranscriptAttachment[];
}

/** One session log (docs/reference/specs/session-log.md): the rows of every run
 *  of a thread-and-agent session, the run whose writes land right now, and the
 *  byte budget the log is held to. */
export interface SessionLog {
  owner?: { runId: string; gen: string };
  rows: TranscriptRow[];
  attachments: TranscriptAttachment[];
  maxBytes: number;
  /** The `(idx, part)` keys the byte policy already replaced, so a pass never picks them again. */
  trimmed: Set<string>;
  /** The session's notepad (item 10), once a run wrote it. */
  notepad?: Notepad;
  /** The row ids the keyed append has seen (item 13), so a replay appends nothing twice. */
  rowIds?: Set<string>;
}

/** A marker's bytes, for the trim plan's first estimate; the pass re-measures. */
const TRIM_MARKER_BYTES_ESTIMATE = 260;

export class InMemoryRunLedger implements RunLedger {
  readonly live = new Map<string, LiveRunRow>();
  readonly steps = new Map<string, StepRecord[]>();
  readonly events = new Map<string, AppendableEvent[]>();
  readonly inbox = new Map<string, InboxItem[]>();
  readonly jobs = new Map<string, RunJob[]>();
  /** The transcript objects of runs claimed before the session log existed: a
   *  claim whose meta names no session. A run with a session has none. */
  readonly transcripts = new Map<string, Transcript>();
  readonly sessions = new Map<string, SessionLog>();
  readonly finished = new Map<string, RunRecord>();
  readonly intake = new Map<string, IntakeReceipt>();
  readonly intakeDeliveries = new Map<string, { poster: string; claimUntil: number; delivered: boolean }>();
  /** The failure toggle (run-history item 59): tests flip a flag to make the
   *  next intake write or read throw, the way a lost Worker does. */
  readonly intakeFailure: { write?: boolean; read?: boolean } = {};

  constructor(private readonly now: () => number = Date.now) {}

  private byThread(threadKey: string): LiveRunRow | undefined {
    for (const row of this.live.values()) if (row.threadKey === threadKey) return row;
    return undefined;
  }

  private fence(runId: string, gen: string): FenceResult {
    return checkFence(this.live.get(runId), gen);
  }

  async claim(req: ClaimRequest): Promise<ClaimResult> {
    const existing = this.byThread(req.threadKey);
    const decision = decideClaim(
      existing
        ? {
            runId: existing.runId,
            agent: existing.meta.agent,
            startedAt: existing.startedAt,
            ownerGen: existing.ownerGen,
            idempotencyKey: existing.meta.idempotencyKey,
          }
        : undefined,
      req,
    );
    if (!decision.ok) return decision;
    switch (decideClaimWrite(existing, req)) {
      case "keep":
        return decision; // idempotent re-claim
      case "refresh":
        existing!.leaseUntil = this.now() + req.leaseMs;
        return decision;
      case "promote":
        Object.assign(existing!, {
          leaseUntil: this.now() + req.leaseMs,
          phase: "live",
          meta: req.meta,
          card: req.card ?? null,
          system: req.system,
          tools: req.tools,
          state: req.state ?? {},
        });
        return decision;
      case "insert":
        break;
    }
    this.live.set(req.runId, {
      runId: req.runId,
      threadKey: req.threadKey,
      ownerGen: req.gen,
      leaseUntil: this.now() + req.leaseMs,
      startedAt: req.startedAt,
      phase: req.phase ?? "live",
      stop: null,
      meta: req.meta,
      card: req.card ?? null,
      system: req.system,
      tools: req.tools,
      state: req.state ?? {},
    });
    // A row with a session owns nothing but its log — the Worker never owns a
    // per-run transcript object for a new claim, so a write of such a run that
    // misses the log is refused here as it is live. A claim without a session
    // models a row from before the log existed: it owns its own object.
    if (!req.meta.session) this.transcripts.set(req.runId, { ownerGen: req.gen, rows: [], attachments: [] });
    return decision;
  }

  /** The rows of `turns`, into `target` under the same `(idx, part)` upsert the objects apply. */
  private static append(
    target: { rows: TranscriptRow[]; attachments: TranscriptAttachment[] },
    turns: TranscriptTurn[],
  ) {
    for (const turn of turns) {
      const actor = "message" in turn ? turn.actor : undefined;
      const { rows, attachments } = turnRows(
        turn.idx,
        "message" in turn ? turn.message : { compaction: turn.compaction },
        {},
        actor,
      );
      for (const row of rows) {
        const at = target.rows.findIndex((r) => r.idx === row.idx && r.part === row.part);
        if (at >= 0) target.rows[at] = row;
        else target.rows.push(row);
      }
      target.attachments.push(...attachments);
    }
  }

  private writeTurns(runId: string, gen: string, turns: TranscriptTurn[], session?: string): FenceResult {
    if (session !== undefined) {
      const log = this.sessions.get(session);
      if (!log?.owner) return { ok: false, reason: "unknown-run" };
      if (log.owner.gen !== gen) return { ok: false, reason: "fenced" };
      InMemoryRunLedger.append(log, turns);
      this.enforceBytePolicy(session);
      return { ok: true };
    }
    const t = this.transcripts.get(runId);
    if (!t) return { ok: false, reason: "unknown-run" };
    if (t.ownerGen !== gen) return { ok: false, reason: "fenced" };
    InMemoryRunLedger.append(t, turns);
    return { ok: true };
  }

  async seed(runId: string, gen: string, turns: TranscriptTurn[], session?: string): Promise<FenceResult> {
    return this.writeTurns(runId, gen, turns, session);
  }

  async step(
    runId: string,
    gen: string,
    record: StepRecord,
    turns: TranscriptTurn[],
    session?: string,
  ): Promise<FenceResult> {
    const written = this.writeTurns(runId, gen, turns, session);
    if (!written.ok) return written;
    const fence = this.fence(runId, gen);
    if (!fence.ok) return fence;
    const list = this.steps.get(runId) ?? [];
    list.push(record);
    this.steps.set(runId, list);
    return { ok: true };
  }

  /** The heartbeat facts each beat carried, kept for assertions (record 0064). */
  readonly heartbeatFacts: Array<{ runId: string; facts?: HeartbeatFacts }> = [];

  async heartbeat(runId: string, gen: string, leaseMs: number, facts?: HeartbeatFacts): Promise<HeartbeatResult> {
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok || !row) return fence;
    this.heartbeatFacts.push({ runId, ...(facts !== undefined ? { facts } : {}) });
    row.leaseUntil = this.now() + leaseMs;
    // The in-memory ledger offers no plane effects; the field is present like
    // the Worker's answer (orchestration-plane; record 0064; orchestration-plane item 7).
    return { ok: true, stop: row.stop, phase: row.phase, effects: [] };
  }

  /** The shadow posts and the acks, kept for assertions (orchestration-plane items 7 and 8). */
  readonly planeOutcomes: PlaneOutcomePost[] = [];
  readonly planeAcks: Array<{ id: string; outcome: PlaneAckOutcome }> = [];

  async planeOutcome(post: PlaneOutcomePost): Promise<{ ok: boolean; decider?: string; agreed?: boolean | null }> {
    this.planeOutcomes.push(post);
    return { ok: true };
  }

  async planeFenceSteer(_id: string, runId: string, gen: string, leaseMs: number): Promise<boolean> {
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok || row?.phase !== "live") return false;
    row.leaseUntil = this.now() + leaseMs;
    return true;
  }

  async planeAck(id: string, outcome: PlaneAckOutcome): Promise<void> {
    this.planeAcks.push({ id, outcome });
  }

  /** The admission asks, kept for assertions; the answer is settable per test
   *  (default: admitted — an empty plane holds nothing). */
  readonly planeAdmits: PlaneAdmitPost[] = [];
  planeAdmitAnswer: PlaneAskAnswer | undefined;
  readonly planeWithdraws: string[] = [];
  planeWithdrawAnswer = false;

  async planeAdmit(post: PlaneAdmitPost): Promise<PlaneAskAnswer> {
    this.planeAdmits.push(post);
    return this.planeAdmitAnswer ?? { kind: "admitted", reservation: `resv-${this.planeAdmits.length}` };
  }

  async planeWithdraw(runId: string): Promise<{ withdrawn: boolean }> {
    this.planeWithdraws.push(runId);
    return { withdrawn: this.planeWithdrawAnswer };
  }

  /** The level reports and observations, kept for assertions (record 0064/record 0064). */
  readonly planeLevels: PlaneLevelPost[] = [];
  readonly planeObservations: PlaneObservePost[] = [];
  planeObserveAnswer = false;

  async planeLevel(post: PlaneLevelPost): Promise<void> {
    this.planeLevels.push(post);
  }

  /** The parks, kept for assertions (record 0064). */
  readonly planeParks: Array<{ runId: string; provider: string }> = [];

  async planePark(runId: string, provider: string): Promise<void> {
    this.planeParks.push({ runId, provider });
  }

  async planeObserve(post: PlaneObservePost): Promise<{ reentered: boolean }> {
    this.planeObservations.push(post);
    return { reentered: this.planeObserveAnswer };
  }

  /** Settable per test: the queued row `planeQueued` answers (default none). */
  planeQueuedRows = new Map<string, PlaneQueueRow>();

  async planeQueued(runId: string): Promise<PlaneQueueRow | null> {
    return this.planeQueuedRows.get(runId) ?? null;
  }

  /** The reclaim outcome reports, kept for assertions (record 0064): only a
   *  `closed` row records an ending — the reference applies `causeOfReclaim`
   *  exactly as the object does. */
  readonly planeReclaims: Array<{ runId: string; outcome: PlaneReclaimWord }> = [];

  async planeReclaimed(
    outcomes: readonly { runId: string; outcome: PlaneReclaimWord }[],
  ): Promise<{ runId: string; cause: PlaneEndingCause }[]> {
    const recorded: { runId: string; cause: PlaneEndingCause }[] = [];
    for (const o of outcomes) {
      this.planeReclaims.push({ ...o });
      const cause = causeOfReclaim(o.outcome);
      if (cause === undefined) continue;
      if (!this.planeEndings.has(o.runId)) this.planeEndings.set(o.runId, { kind: "interrupted", cause, at: 0 });
      recorded.push({ runId: o.runId, cause: this.planeEndings.get(o.runId)!.cause });
    }
    return recorded;
  }

  /** The endings the plane recorded (record 0064): one per closed row, the
   *  first cause standing — what the reference keeps for assertions. */
  readonly planeEndings = new Map<string, PlaneEnding>();

  async append(runId: string, gen: string, events: AppendableEvent[]): Promise<FenceResult> {
    const fence = this.fence(runId, gen);
    if (!fence.ok) return fence;
    const list = this.events.get(runId) ?? [];
    list.push(...events);
    this.events.set(runId, list);
    return { ok: true };
  }

  async setState(runId: string, gen: string, state: RunState): Promise<FenceResult> {
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok || !row) return fence;
    row.state = state;
    return { ok: true };
  }

  async pushInbox(runId: string, message: Record<string, unknown>): Promise<{ ok: boolean; seq?: number }> {
    if (!this.live.has(runId)) return { ok: false };
    const list = this.inbox.get(runId) ?? [];
    const seq = list.length + 1;
    list.push({ seq, message });
    this.inbox.set(runId, list);
    return { ok: true, seq };
  }

  async readInbox(runId: string, afterSeq: number): Promise<InboxItem[]> {
    return (this.inbox.get(runId) ?? []).filter((i) => i.seq > afterSeq);
  }

  async requestStop(runId: string, mode: StopMode): Promise<{ ok: boolean; ownerLive?: boolean }> {
    const row = this.live.get(runId);
    if (!row) return { ok: false };
    row.stop = mode;
    return { ok: true, ownerLive: row.leaseUntil > this.now() };
  }

  async handoff(gen: string, runIds: string[]): Promise<{ marked: string[] }> {
    const marked: string[] = [];
    for (const id of runIds) {
      const row = this.live.get(id);
      if (row && row.ownerGen === gen && phaseTransition(row.phase, "handoff")) {
        row.phase = "handoff";
        marked.push(id);
      }
    }
    return { marked };
  }

  async finishing(runId: string, gen: string): Promise<FenceResult> {
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok || !row) return fence;
    if (!phaseTransition(row.phase, "finishing")) return { ok: false, reason: "fenced" };
    row.phase = "finishing";
    return { ok: true };
  }

  async finish(runId: string, gen: string, record: RunRecord): Promise<FinishResult> {
    const fence = this.fence(runId, gen);
    if (!fence.ok) return fence;
    this.finished.set(runId, record);
    // The ending's cause (record 0064): recorded when the row closes, first
    // cause standing — exactly the object's rule, its one keyed exception
    // included: a standing `resident_replaced` was a `restarting` close, the
    // run carried on under its own id, so that run's own later finish
    // replaces it and the ending agrees with the record.
    if (this.live.has(runId)) {
      const cause = causeOfClose(record.status, record.restarting === true);
      const standing = this.planeEndings.get(runId);
      if (standing === undefined || (standing.cause === "resident_replaced" && cause !== "resident_replaced"))
        this.planeEndings.set(runId, { kind: record.status, cause, at: record.finishedAt });
    }
    this.live.delete(runId);
    this.steps.delete(runId);
    this.inbox.delete(runId);
    this.jobs.delete(runId);
    this.transcripts.delete(runId);
    // The session log is kept whole; only the owner is released.
    if (record.session) await this.releaseSession(record.session.key, runId, gen);
    return { ok: true, stored: true };
  }

  private session(key: string): SessionLog {
    let log = this.sessions.get(key);
    if (!log)
      this.sessions.set(
        key,
        (log = { rows: [], attachments: [], maxBytes: DEFAULT_SESSION_LOG_MAX_BYTES, trimmed: new Set() }),
      );
    return log;
  }

  async sessionTail(key: string): Promise<number> {
    const rows = this.sessions.get(key)?.rows ?? [];
    return rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.idx)) + 1;
  }

  async appendSession(
    key: string,
    rowId: string,
    rows: readonly { part: number; json: string }[],
  ): Promise<{ ok: boolean; appended: boolean }> {
    // One synchronous span, as the object's transaction is: the seen-check,
    // the append and the id's record admit no interleaving — two concurrent
    // appends of one row id land one row.
    const log = this.session(key);
    log.rowIds ??= new Set();
    if (log.rowIds.has(rowId)) return { ok: true, appended: false };
    const idx = log.rows.length === 0 ? 0 : Math.max(...log.rows.map((r) => r.idx)) + 1;
    for (const r of rows) log.rows.push({ idx, part: r.part, json: r.json });
    log.rowIds.add(rowId);
    return { ok: true, appended: true };
  }

  async claimSession(key: string, runId: string, gen: string, maxBytes?: number): Promise<void> {
    const log = this.session(key);
    log.owner = { runId, gen };
    log.maxBytes = maxBytes ?? DEFAULT_SESSION_LOG_MAX_BYTES;
  }

  /** The log's rows and attachments in UTF-8 bytes — what the byte policy bounds. */
  sessionBytes(key: string): number {
    const log = this.sessions.get(key);
    if (!log) return 0;
    return (
      log.rows.reduce((n, r) => n + utf8ByteLength(r.json), 0) +
      log.attachments.reduce((n, a) => n + utf8ByteLength(a.data), 0)
    );
  }

  /** The byte policy (session-log item 5), as the object enforces it: over the
   *  budget, the oldest un-replaced tool results are replaced by the marker,
   *  each taking with it the attachments no remaining row references, until
   *  the log fits or no candidate is left; text rows are never candidates. */
  private enforceBytePolicy(key: string): void {
    const log = this.session(key);
    const rowKey = (r: TranscriptRow) => `${r.idx}:${r.part}`;
    const soleAttachmentBytes = (row: TranscriptRow): number => {
      const others = new Set(log.rows.filter((r) => r !== row).flatMap((r) => attachmentRefsOf(r.json)));
      return attachmentRefsOf(row.json)
        .filter((ref) => !others.has(ref))
        .reduce((n, ref) => n + (log.attachments.find((a) => a.ref === ref)?.data.length ?? 0), 0);
    };
    for (;;) {
      const total = this.sessionBytes(key);
      if (total <= log.maxBytes) return;
      const candidates = [...log.rows]
        .filter((r) => rowKind(r.json) === "tool_result" && !log.trimmed.has(rowKey(r)))
        .sort((a, b) => a.idx - b.idx || a.part - b.part);
      const byId = new Map(candidates.map((r, i) => [i, r]));
      const ids = planSessionTrim(
        candidates.map((r, i) => ({ id: i, bytes: utf8ByteLength(r.json) + soleAttachmentBytes(r) })),
        total - log.maxBytes,
        TRIM_MARKER_BYTES_ESTIMATE,
      );
      if (ids.length === 0) return;
      for (const id of ids) {
        const row = byId.get(id)!;
        const marker = droppedToolResultRow(row.json);
        log.trimmed.add(rowKey(row));
        if (marker === undefined) continue;
        const refs = attachmentRefsOf(row.json);
        row.json = marker;
        const stillReferenced = new Set(log.rows.flatMap((r) => attachmentRefsOf(r.json)));
        log.attachments = log.attachments.filter((a) => !refs.includes(a.ref) || stillReferenced.has(a.ref));
      }
    }
  }

  async releaseSession(key: string, runId: string, gen: string): Promise<FenceResult> {
    const log = this.sessions.get(key);
    if (!log?.owner) return { ok: false, reason: "unknown-run" };
    if (log.owner.runId !== runId || log.owner.gen !== gen) return { ok: false, reason: "fenced" };
    delete log.owner;
    return { ok: true };
  }

  async readSession(key: string, from: number, to?: number): Promise<AssembledTranscript> {
    const log = this.sessions.get(key);
    const rows = (log?.rows ?? []).filter((r) => r.idx >= from && (to === undefined || r.idx <= to));
    return assembleTranscript(rows, log?.attachments ?? [], from);
  }

  async readSessionTail(key: string, maxBytes: number): Promise<{ from: number; transcript: AssembledTranscript }> {
    const rows = [...(this.sessions.get(key)?.rows ?? [])].sort((a, b) => b.idx - a.idx || b.part - a.part);
    const from = tailCut(
      rows.map((r) => ({ idx: r.idx, bytes: utf8ByteLength(r.json) })),
      maxBytes,
    );
    if (from === undefined) {
      const next = await this.sessionTail(key);
      return { from: next, transcript: assembleTranscript([], [], next) };
    }
    return { from, transcript: await this.readSession(key, from) };
  }

  /** The search as the object answers it (session-log item 10), by the memory
   *  scorer's tokens: a row scores the distinct query words its indexed text
   *  carries, the highest first and the newest among equals — the same order
   *  the object's bm25 rank gives for one-word texts, close enough for the
   *  reference — with the gap markers between the oldest and the newest hit. */
  async searchSession(key: string, query: string, limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }> {
    const log = this.sessions.get(key);
    const words = [...new Set(tokenize(query))];
    if (!log || words.length === 0) return { hits: [], gaps: [] };
    const scored = log.rows
      .map((r) => {
        const text = textOfStoredRow(r.json);
        const has = new Set(tokenize(text));
        return { r, text, score: words.filter((w) => has.has(w)).length };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.r.idx - a.r.idx || b.r.part - a.r.part)
      .slice(0, limit);
    const hits: SessionHit[] = scored.map(({ r, text }) => {
      const role = roleOfStoredRow(r.json);
      return { idx: r.idx, part: r.part, ...(role !== undefined ? { role } : {}), kind: rowKind(r.json), text };
    });
    if (hits.length < 2) return { hits, gaps: [] };
    const lo = Math.min(...hits.map((h) => h.idx));
    const hi = Math.max(...hits.map((h) => h.idx));
    const gaps = [
      ...new Set(
        log.rows.filter((r) => r.idx >= lo && r.idx <= hi && textOfStoredRow(r.json) === GAP_MARKER).map((r) => r.idx),
      ),
    ].sort((a, b) => a - b);
    return { hits, gaps };
  }

  async readNotepad(key: string): Promise<Notepad | null> {
    return this.sessions.get(key)?.notepad ?? null;
  }

  async writeNotepad(key: string, gen: string, text: string): Promise<FenceResult> {
    const log = this.sessions.get(key);
    if (!log?.owner) return { ok: false, reason: "unknown-run" };
    if (log.owner.gen !== gen) return { ok: false, reason: "fenced" };
    log.notepad = { text, updatedAt: this.now() };
    return { ok: true };
  }

  async abandon(runId: string, gen: string): Promise<FenceResult> {
    const fence = this.fence(runId, gen);
    if (!fence.ok) return fence;
    this.live.delete(runId);
    this.steps.delete(runId);
    this.inbox.delete(runId);
    this.jobs.delete(runId);
    this.transcripts.delete(runId);
    return { ok: true };
  }

  async reclaim(gen: string, now: number, leaseMs: number): Promise<ReclaimedRun[]> {
    const taken = selectReclaim([...this.live.values()], now, gen);
    const out: ReclaimedRun[] = [];
    for (const row of taken) {
      const reclaimedFrom = row.phase;
      row.ownerGen = gen;
      row.leaseUntil = now + leaseMs;
      row.phase = reclaimPhase(reclaimedFrom);
      const t = this.transcripts.get(row.runId);
      if (t) t.ownerGen = gen;
      // The row's session log changes hands with it, as the transcript object does.
      if (row.meta.session) this.session(row.meta.session.key).owner = { runId: row.runId, gen };
      const steps = this.steps.get(row.runId) ?? [];
      const lastStep = steps.length ? steps[steps.length - 1] : null;
      const unread = unreadInbox(lastStep);
      out.push({
        row,
        reclaimedFrom,
        lastStep,
        inbox: (this.inbox.get(row.runId) ?? []).filter(unread),
        jobs: this.jobs.get(row.runId) ?? [],
      });
    }
    return out;
  }

  async recordIntake(key: string, receipt: IntakeReceipt): Promise<IntakeWriteResult> {
    if (this.intakeFailure.write) throw new Error("intake write failed (toggled)");
    const out = decideIntakeInsert(this.intake.get(key), receipt);
    if (out.inserted) this.intake.set(key, receipt);
    return out;
  }

  async readIntake(key: string): Promise<IntakeReceipt | undefined> {
    if (this.intakeFailure.read) throw new Error("intake read failed (toggled)");
    return this.intake.get(key);
  }

  async claimIntakeDelivery(key: string, poster: string, claimedAt: number): Promise<boolean> {
    if (this.intakeFailure.write) throw new Error("intake write failed (toggled)");
    if (this.intake.get(key)?.providerFailure === undefined) return false;
    const existing = this.intakeDeliveries.get(key);
    if (existing?.delivered === true || (existing !== undefined && existing.claimUntil > claimedAt)) return false;
    this.intakeDeliveries.set(key, {
      poster,
      claimUntil: claimedAt + INTAKE_DELIVERY_CLAIM_MS,
      delivered: false,
    });
    return true;
  }

  async finishIntakeDelivery(key: string, poster: string, delivered: boolean): Promise<void> {
    if (this.intakeFailure.write) throw new Error("intake write failed (toggled)");
    const existing = this.intakeDeliveries.get(key);
    if (existing?.poster !== poster || existing.delivered) return;
    if (delivered) this.intakeDeliveries.set(key, { ...existing, delivered: true });
    else this.intakeDeliveries.delete(key);
  }

  async listIntake(query: IntakeQuery): Promise<IntakeReceipt[]> {
    if (this.intakeFailure.read) throw new Error("intake read failed (toggled)");
    return [...this.intake.values()]
      .filter(
        (r) =>
          (query.threadKey === undefined || r.threadKey === query.threadKey) &&
          (query.since === undefined || r.decidedAt >= query.since),
      )
      .sort((a, b) => a.decidedAt - b.decidedAt);
  }

  async readEvents(runId: string): Promise<AppendableEvent[]> {
    return [...(this.events.get(runId) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async listLive(): Promise<LiveRunRow[]> {
    return [...this.live.values()];
  }

  async readTranscript(runId: string): Promise<AssembledTranscript> {
    const t = this.transcripts.get(runId);
    return assembleTranscript(t?.rows ?? [], t?.attachments ?? []);
  }
}
