import { preserveCheckpointState } from "./checkpointState.js";
import {
  checkpointMembersOf,
  checkpointMemberHashesOf,
  applyContextCheckpointAliases,
  planContextCheckpoint,
  validateContextCheckpoint,
  isContextCheckpointReceipt,
  type CanonicalCheckpointSource,
  type ContextCheckpointRequest,
  type ContextCheckpointResult,
} from "../references/contextCheckpoint.js";
import { contextDependenciesContain } from "../references/contextDependencies.js";
import {
  handoffRangePins,
  sessionRangesAvailable,
  sessionRowIsPinned,
  type SessionRangePins,
} from "./sessionRangePins.js";
import { uncoveredSourceResult, verifiedSourceResults } from "../references/sourceResultContext.js";
import {
  isContextDependencies,
  UNKNOWN_CONTEXT_DEPENDENCIES,
  type ContextDependencies,
} from "../references/contextDependencies.js";
import {
  type SessionSources,
  mergeSessionSources,
  appendSessionContext,
  sourceHash,
  taintSessionSources,
  isSessionSources,
  sourcesBelongToSession,
} from "../references/receipts.js";
// The in-memory ledger: the reference implementation the bot's tests run
// against, applying the same pure decisions the Durable Object applies. It
// also documents the storage shape in the plainest form.

import { INTAKE_DELIVERY_CLAIM_MS } from "../budgets.js";
import { utf8ByteLength, workEvidenceBelongsToRun, type RunRecord } from "../runRecord.js";
import type { UnitSeedReceipt } from "../coordinator/unitSeedReceipt.js";
import {
  assignLedgerLiveState,
  checkFence,
  decideClaim,
  decideClaimWrite,
  decideIntakeInsert,
  phaseTransition,
  reclaimPhase,
  selectReclaim,
  unreadInbox,
} from "./decisions.js";
import {
  mergeRequesterTarget,
  type RequesterTarget,
  type FinishResult,
  type HeartbeatFacts,
  type HeartbeatResult,
  type RunLedger,
} from "./ledger.js";
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
  keyedAppendContextMatches,
  DEFAULT_SESSION_LOG_MAX_BYTES,
  droppedToolResultRow,
  GAP_MARKER,
  planSessionTrim,
  storedRowRequiresFreshSources,
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
  LiveStateAssignRequest,
  LiveStateAssignResult,
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
  rangePins?: SessionRangePins;
  sources?: SessionSources;
  requiresFreshSources?: true;
  sourceStart?: number;
  sourceOwner?: string;
  pendingSourceOwner?: string;
  owner?: { runId: string; gen: string };
  rows: TranscriptRow[];
  attachments: TranscriptAttachment[];
  maxBytes: number;
  /** The `(idx, part)` keys the byte policy already replaced, so a pass never picks them again. */
  trimmed: Set<string>;
  /** Actor-stamped targets stay separate from turns and byte trimming. */
  requesterTargets?: Map<string, RequesterTarget>;
  /** The session's notepad (item 10), once a run wrote it. */
  notepad?: Notepad;
  /** The row ids the keyed append has seen (item 13), so a replay appends nothing twice. */
  rowIds?: Map<string, number>;
  rowHashes?: Map<string, string>;
}

/** A marker's bytes, for the trim plan's first estimate; the pass re-measures. */
const TRIM_MARKER_BYTES_ESTIMATE = 260;

export class InMemoryRunLedger implements RunLedger {
  private residentClaimFence = 0;
  async residentClaim(
    runId: string,
    gen: string,
    threadKey: string,
  ): Promise<{ ok: true; fence: number } | { ok: false; reason: "fenced" | "unknown-run" }> {
    const row = this.live.get(runId);
    if (!row) return { ok: false, reason: "unknown-run" };
    if (row.ownerGen !== gen || row.threadKey !== threadKey) return { ok: false, reason: "fenced" };
    return { ok: true, fence: ++this.residentClaimFence };
  }
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
  /** Transaction failure injection for the reference live-state writer. The
   *  drafts must remain invisible when the commit point throws. */
  readonly liveStateFailure: { beforeCommit?: boolean } = {};

  constructor(private readonly now: () => number = Date.now) {}

  private byThread(threadKey: string): LiveRunRow | undefined {
    for (const row of this.live.values()) if (row.threadKey === threadKey) return row;
    return undefined;
  }

  private fence(runId: string, gen: string): FenceResult {
    return checkFence(this.live.get(runId), gen);
  }

  private protectHandoff(req: ClaimRequest): void {
    const ranges = handoffRangePins(req.meta.childHandoff);
    for (const [key, pins] of ranges) {
      const log = this.sessions.get(key);
      if (
        !log ||
        !sessionRangesAvailable(
          log.rows.map((row) => ({ ...row, trimmed: log.trimmed.has(`${row.idx}:${row.part}`) })),
          pins,
        )
      )
        throw new Error("context source range is unavailable");
    }
    for (const [key, pins] of ranges) {
      const log = this.sessions.get(key)!;
      log.rangePins ??= {};
      log.rangePins[req.runId] = pins;
    }
  }

  async claim(req: ClaimRequest): Promise<ClaimResult> {
    const existing = this.byThread(req.threadKey);
    if (!preserveCheckpointState(existing?.state ?? {}, req.state ?? {}))
      throw new Error("checkpoint state is immutable");
    if (!workEvidenceBelongsToRun(req.state ?? {}, { id: req.runId, ...req.meta }))
      throw new Error("work evidence does not match its canonical run");
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
        this.protectHandoff(req);
        Object.assign(existing!, {
          leaseUntil: this.now() + req.leaseMs,
          phase: "live",
          meta: req.meta,
          card: req.card ?? null,
          system: req.system,
          tools: req.tools,
          state: { ...existing!.state, ...(req.state ?? {}) },
        });
        return decision;
      case "insert":
        break;
    }
    this.protectHandoff(req);
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
    // A new live segment starts without a live-event table. Clear any prior
    // generation's entries, then let the first append create the table so its
    // absence still means that a pending event batch has not flushed.
    this.events.delete(req.runId);
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

  private async writeTurns(
    runId: string,
    gen: string,
    turns: TranscriptTurn[],
    session?: string,
    seed = false,
  ): Promise<FenceResult> {
    const frozen = structuredClone(turns);
    const incoming = frozen.flatMap(
      (t) =>
        turnRows(
          t.idx,
          "message" in t ? t.message : { compaction: t.compaction },
          {},
          "message" in t ? t.actor : undefined,
        ).rows,
    );
    const verified = await verifiedSourceResults(incoming);

    if (session !== undefined) {
      const log = this.sessions.get(session);
      if (!log?.owner) return { ok: false, reason: "unknown-run" };
      if (log.owner.gen !== gen || log.owner.runId !== runId) return { ok: false, reason: "fenced" };
      for (const row of incoming) {
        if (!sessionRowIsPinned(log.rangePins ?? {}, row.idx)) continue;
        if (log.rows.find((original) => original.idx === row.idx && original.part === row.part)?.json !== row.json)
          return { ok: false, reason: "fenced" };
      }
      if (log.sources && turns.length && log.sourceOwner !== `${log.owner.runId}:${gen}`)
        log.pendingSourceOwner = `${log.owner.runId}:${gen}`;
      if (
        log.sources?.context &&
        uncoveredSourceResult(log.rows, incoming, log.sources.context, seed ? undefined : runId, verified)
      )
        log.sources = taintSessionSources(log.sources);
      InMemoryRunLedger.append(log, frozen);
      if (log.rows.some((r) => storedRowRequiresFreshSources(r.json))) log.requiresFreshSources = true;
      this.enforceBytePolicy(session);
      return { ok: true };
    }
    const t = this.transcripts.get(runId);
    if (!t) return { ok: false, reason: "unknown-run" };
    if (t.ownerGen !== gen) return { ok: false, reason: "fenced" };
    InMemoryRunLedger.append(t, frozen);
    return { ok: true };
  }

  readonly checkpointMembers = new Map<string, readonly string[]>();
  readonly checkpointMemberHashes = new Map<string, Readonly<Record<string, string>>>();

  private async checkpointSource(runId: string): Promise<CanonicalCheckpointSource | undefined> {
    const live = this.live.get(runId);
    const archived = this.finished.get(runId);
    const meta = live?.meta ?? archived;
    const context = live?.state.contextDependencies ?? archived?.contextDependencies;
    if (!meta || !isContextDependencies(context)) return undefined;
    const value = live?.state.contextCheckpointReceipt ?? archived?.contextCheckpointReceipt;
    const receipt = isContextCheckpointReceipt(value) ? value : undefined;
    return {
      runId,
      meta: structuredClone(meta),
      context: structuredClone(context),
      ...(receipt
        ? {
            receipt: structuredClone(receipt),
            transcriptHash: await sourceHash(
              await this.readSession(receipt.session.key, receipt.session.seedFrom, receipt.session.through),
            ),
            members: [...(this.checkpointMembers.get(runId) ?? [])],
            memberCheckpoints: { ...(this.checkpointMemberHashes.get(runId) ?? {}) },
          }
        : {}),
    };
  }

  async readContextCheckpoint(runId: string): Promise<CanonicalCheckpointSource | undefined> {
    const source = await this.checkpointSource(runId);
    return source?.receipt && (await validateContextCheckpoint(source.receipt, source)) ? source : undefined;
  }

  async normalizeContextOrigins(request: ContextCheckpointRequest): Promise<ContextCheckpointResult> {
    const row = this.live.get(request.runId);
    const fence = checkFence(row, request.gen);
    if (!fence.ok) return fence;
    if (!row) return { ok: false, reason: "unknown-run" };
    const unavailable = (): ContextCheckpointResult => ({ ok: false, reason: "checkpoint-unavailable" });
    const committed = await this.readContextCheckpoint(request.runId);
    if (committed?.receipt) return { ok: true, receipt: committed.receipt };
    const log = this.sessions.get(request.key);
    const session = row.meta.session;
    const last = this.steps.get(request.runId)?.at(-1);
    if (
      !session ||
      session.key !== request.key ||
      session.range === "broken" ||
      !last ||
      last.step !== 0 ||
      last.inFlight.length ||
      log?.owner?.runId !== request.runId ||
      log.owner.gen !== request.gen ||
      !isContextDependencies(log.sources?.context) ||
      !isContextDependencies(row.state.contextDependencies) ||
      !contextDependenciesContain(log.sources.context, row.state.contextDependencies)
    )
      return unavailable();
    const through = session.seedFrom + last.turnIndex - 1;
    const checkpoint = row.state.contextCheckpoint as { key?: string; through?: number } | undefined;
    if (
      (checkpoint && (checkpoint.key !== request.key || checkpoint.through !== through)) ||
      (await this.sessionTail(request.key)) !== through + 1
    )
      return unavailable();
    const before = JSON.stringify({ row, log, last });
    const transcript = await this.readSession(request.key, session.seedFrom, through);
    const inputs = {
      transcriptHash: await sourceHash(transcript),
      systemHash: await sourceHash(row.system),
      notepadHash: await sourceHash(log.notepad?.text ?? ""),
    };
    const sources = (
      await Promise.all(
        log.sources.context.origins
          .filter((origin) => origin.runId !== row.runId)
          .map((origin) => this.checkpointSource(origin.runId)),
      )
    ).filter((source): source is CanonicalCheckpointSource => source !== undefined);
    const receipt = await planContextCheckpoint({
      run: { runId: row.runId, meta: row.meta, context: log.sources.context },
      ownerGen: request.gen,
      through,
      inputs,
      expected: request.expected,
      sources,
    });
    if (
      !receipt ||
      before !== JSON.stringify({ row, log, last }) ||
      this.live.get(request.runId) !== row ||
      row.ownerGen !== request.gen ||
      !sessionRangesAvailable(
        log.rows.map((part) => ({ ...part, trimmed: log.trimmed.has(`${part.idx}:${part.part}`) })),
        [{ from: session.seedFrom, to: through }],
      )
    )
      return unavailable();
    this.checkpointMembers.set(row.runId, checkpointMembersOf(row.runId, receipt.coveredOrigins, sources));
    this.checkpointMemberHashes.set(row.runId, checkpointMemberHashesOf(row.runId, receipt.coveredOrigins, sources));
    log.rangePins ??= {};
    log.rangePins[row.runId] = [{ from: session.seedFrom, to: through }];
    log.sources = { ...log.sources, context: structuredClone(receipt.normalized) };
    row.state = {
      ...row.state,
      contextDependencies: structuredClone(receipt.normalized),
      contextCheckpointReceipt: structuredClone(receipt),
    };
    return { ok: true, receipt };
  }

  async writeSessionSources(key: string, runId: string, gen: string, sources: SessionSources): Promise<FenceResult> {
    const log = this.sessions.get(key);
    if (!log?.owner) return { ok: false, reason: "unknown-run" };
    if (log.owner.gen !== gen || log.owner.runId !== runId) return { ok: false, reason: "fenced" };
    const row = this.live.get(runId);
    const owner =
      row === undefined
        ? undefined
        : row.ownerGen === gen && row.meta.session?.key === key
          ? { key, threadKey: row.meta.threadKey, channelId: row.meta.channelId, requester: row.meta.userId }
          : null;
    if (!isSessionSources(sources) || !sourcesBelongToSession(key, sources, owner))
      return { ok: false, reason: "fenced" };
    if (log.pendingSourceOwner && log.pendingSourceOwner !== `${runId}:${gen}`)
      log.sources = taintSessionSources(log.sources);
    log.sources = structuredClone(mergeSessionSources(log.sources, sources, log.sourceStart === 0));
    if (JSON.stringify(log.sources) !== JSON.stringify(sources)) return { ok: false, reason: "fenced" };
    log.sourceOwner = `${runId}:${gen}`;
    delete log.pendingSourceOwner;
    return { ok: true };
  }

  async seed(runId: string, gen: string, turns: TranscriptTurn[], session?: string): Promise<FenceResult> {
    return this.writeTurns(runId, gen, turns, session, true);
  }

  async step(
    runId: string,
    gen: string,
    record: StepRecord,
    turns: TranscriptTurn[],
    session?: string,
  ): Promise<FenceResult> {
    const written = await this.writeTurns(runId, gen, turns, session);
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

  async assignLiveState(
    runId: string,
    gen: string,
    assignment: LiveStateAssignRequest,
  ): Promise<LiveStateAssignResult> {
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok) return fence;
    if (!row) return { ok: false, reason: "unknown-run" };
    if (!preserveCheckpointState(row.state, assignment.statePatch ?? {})) return { ok: false, reason: "fenced" };
    if (!workEvidenceBelongsToRun({ ...row.state, ...assignment.statePatch }, { id: row.runId, ...row.meta }))
      return { ok: false, reason: "fenced" };
    const result = assignLedgerLiveState(row.liveState, row.liveStateSeq ?? 0, assignment);
    if (!result.ok) return result;
    let liveStateSeq = row.liveStateSeq ?? 0;
    const events = [...(this.events.get(runId) ?? [])];
    let lastEventSeq = Math.max(0, ...events.map((event) => event.seq));
    for (const source of assignment.sourceEvents ?? []) {
      if (source.seq <= lastEventSeq) return { ok: false, reason: "stale-sequence" };
      lastEventSeq = source.seq;
    }
    const boundarySeq = result.event ? (assignment.eventSeq ?? lastEventSeq + 1) : undefined;
    if (boundarySeq !== undefined && boundarySeq <= lastEventSeq) return { ok: false, reason: "stale-sequence" };
    for (const source of assignment.sourceEvents ?? []) {
      events.push(source);
      liveStateSeq = source.seq;
    }
    if (result.event && boundarySeq !== undefined) {
      liveStateSeq = boundarySeq;
      events.push({ ...result.event, seq: liveStateSeq });
    }
    if (this.liveStateFailure.beforeCommit) throw new Error("live-state commit failed");
    if ((assignment.sourceEvents?.length ?? 0) > 0 || result.event) this.events.set(runId, events);
    const preserved = preserveCheckpointState(row.state, {
      ...row.state,
      ...assignment.statePatch,
      liveState: result.liveState,
      liveStateSeq,
    });
    if (!preserved) return { ok: false, reason: "fenced" };
    row.state = preserved;
    row.liveState = result.liveState;
    row.liveStateSeq = liveStateSeq;
    return {
      ...result,
      ...(result.event ? { event: { ...result.event, seq: liveStateSeq } } : {}),
      liveStateSeq,
    };
  }

  async setState(runId: string, gen: string, state: RunState): Promise<FenceResult> {
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok || !row) return fence;
    const mintSeed = state.unitSeedReceipt !== undefined && row.state.unitSeedReceipt === undefined;
    const preserved = preserveCheckpointState(row.state, state, mintSeed);
    if (!preserved) return { ok: false, reason: "fenced" };
    if (!workEvidenceBelongsToRun(preserved, { id: row.runId, ...row.meta })) return { ok: false, reason: "fenced" };
    if (mintSeed) {
      const receipt = preserved.unitSeedReceipt as UnitSeedReceipt;
      const checkpoint = row.state.contextCheckpoint as { key?: string; through?: number } | undefined;
      const last = this.steps.get(runId)?.at(-1);
      const log = this.sessions.get(receipt.seed.key);
      if (
        receipt.ownerGen !== gen ||
        checkpoint?.key !== receipt.seed.key ||
        checkpoint.through !== receipt.seed.through ||
        !last ||
        last.step !== 0 ||
        last.inFlight.length ||
        receipt.seed.through !== receipt.seed.from + last.turnIndex - 1 ||
        log?.owner?.runId !== runId ||
        log.owner.gen !== gen
      )
        return { ok: false, reason: "fenced" };
      const before = JSON.stringify({ row, log });
      const transcript = await this.readSession(receipt.seed.key, receipt.seed.from, receipt.seed.through);
      if (
        (await sourceHash(transcript)) !== receipt.seed.messagesHash ||
        (await sourceHash(row.system)) !== receipt.seed.systemHash ||
        this.live.get(runId) !== row ||
        before !== JSON.stringify({ row, log }) ||
        !sessionRangesAvailable(
          log.rows.map((part) => ({ ...part, trimmed: log.trimmed.has(`${part.idx}:${part.part}`) })),
          [{ from: receipt.seed.from, to: receipt.seed.through }],
        )
      )
        return { ok: false, reason: "fenced" };
      log.rangePins ??= {};
      log.rangePins[runId] = [...(log.rangePins[runId] ?? []), { from: receipt.seed.from, to: receipt.seed.through }];
    }
    row.state = preserved;
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

  async handoff(gen: string, runIds: string[], opts?: { pausedForRetry: true }): Promise<{ marked: string[] }> {
    const marked: string[] = [];
    for (const id of runIds) {
      const row = this.live.get(id);
      if (row && row.ownerGen === gen && phaseTransition(row.phase, "handoff")) {
        row.phase = "handoff";
        if (opts?.pausedForRetry) row.state = { ...row.state, pausedForRetry: true };
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

  async finish(
    runId: string,
    gen: string,
    record: RunRecord,
    opts?: { requireStoppedPause: true },
  ): Promise<FinishResult> {
    const fence = this.fence(runId, gen);
    if (!fence.ok) return fence;
    const row = this.live.get(runId)!;
    if (
      opts?.requireStoppedPause &&
      (row.phase !== "handoff" ||
        row.state.pausedForRetry !== true ||
        row.stop !== "hard" ||
        record.status !== "stopped_hard")
    )
      return { ok: false, reason: "fenced" };
    const canonicalWork = this.live.get(runId)?.state ?? this.finished.get(runId) ?? {};
    if (
      record.unitSeedReceipt !== undefined &&
      JSON.stringify(record.unitSeedReceipt) !== JSON.stringify(canonicalWork.unitSeedReceipt)
    )
      return { ok: false, reason: "fenced" };
    for (const field of ["workReads", "unitSeedReceipt"] as const) {
      const canonical = canonicalWork[field];
      if (canonical === undefined) continue;
      if (record[field] !== undefined && JSON.stringify(record[field]) !== JSON.stringify(canonical))
        return { ok: false, reason: "fenced" };
      record = { ...record, [field]: structuredClone(canonical) };
    }
    if (!workEvidenceBelongsToRun(record, record)) return { ok: false, reason: "fenced" };
    const priorReceipt =
      this.live.get(runId)?.state.contextCheckpointReceipt ?? this.finished.get(runId)?.contextCheckpointReceipt;
    if (
      record.contextCheckpointReceipt !== undefined &&
      JSON.stringify(record.contextCheckpointReceipt) !== JSON.stringify(priorReceipt)
    )
      return { ok: false, reason: "fenced" };
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
    context?: ContextDependencies,
  ): Promise<{ ok: boolean; appended: boolean }> {
    if (!keyedAppendContextMatches(rows, context)) return { ok: false, appended: false };
    const hash = await sourceHash({ rows, context: context ?? UNKNOWN_CONTEXT_DEPENDENCIES });
    // Hashing precedes the synchronous append; every retry checks the durable
    // original payload, including after byte trimming replaces its content.
    const receipts = (
      await Promise.all(
        (context?.origins ?? [])
          .filter((origin) => origin.checkpoint)
          .map((origin) => this.readContextCheckpoint(origin.runId)),
      )
    ).flatMap((source) =>
      source?.receipt &&
      context?.origins.some((origin) => origin.runId === source.runId && origin.checkpoint === source.receipt!.hash)
        ? [source]
        : [],
    );
    const log = this.session(key);
    log.rowIds ??= new Map();
    log.rowHashes ??= new Map();
    if (log.rowIds.has(rowId)) return { ok: log.rowHashes.get(rowId) === hash, appended: false };
    const idx = log.rows.length === 0 ? 0 : Math.max(...log.rows.map((r) => r.idx)) + 1;
    for (const source of receipts)
      if (log.sources?.context) log.sources.context = applyContextCheckpointAliases(log.sources.context, source);
    log.sources = structuredClone(appendSessionContext(log.sources, context, idx === 0));
    for (const source of receipts)
      if (log.sources.context) log.sources.context = applyContextCheckpointAliases(log.sources.context, source);
    for (const r of rows) log.rows.push({ idx, part: r.part, json: r.json });
    log.rowIds.set(rowId, idx);
    log.rowHashes.set(rowId, hash);
    this.enforceBytePolicy(key);
    return { ok: true, appended: true };
  }

  async claimSession(key: string, runId: string, gen: string, maxBytes?: number): Promise<void> {
    const log = this.session(key);
    if (log.pendingSourceOwner && log.pendingSourceOwner !== `${runId}:${gen}`)
      log.sources = taintSessionSources(log.sources);
    log.sourceStart = await this.sessionTail(key);
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
        .filter(
          (r) =>
            rowKind(r.json) === "tool_result" &&
            !log.trimmed.has(rowKey(r)) &&
            !sessionRowIsPinned(log.rangePins ?? {}, r.idx),
        )
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

  async readSessionEntry(key: string, rowId: string): Promise<readonly TranscriptRow[] | undefined> {
    const log = this.sessions.get(key);
    const index = log?.rowIds?.get(rowId);
    if (index === undefined || !log) return undefined;
    const rows = log.rows.filter((row) => row.idx === index).sort((a, b) => a.part - b.part);
    if (!rows.length || rows.some((row) => log.trimmed.has(`${row.idx}:${row.part}`))) return undefined;
    return structuredClone(rows);
  }

  async readSession(key: string, from: number, to?: number): Promise<AssembledTranscript> {
    const log = this.sessions.get(key);
    const rows = (log?.rows ?? []).filter((r) => r.idx >= from && (to === undefined || r.idx <= to));
    return assembleTranscript(rows, log?.attachments ?? [], from);
  }

  async readSessionTail(
    key: string,
    maxBytes: number,
  ): Promise<{ from: number; transcript: AssembledTranscript; sources?: SessionSources; requiresFreshSources?: true }> {
    const log = this.sessions.get(key);
    const sources = log?.pendingSourceOwner ? taintSessionSources(log.sources) : log?.sources;
    const rows = [...(this.sessions.get(key)?.rows ?? [])].sort((a, b) => b.idx - a.idx || b.part - a.part);
    const from = tailCut(
      rows.map((r) => ({ idx: r.idx, bytes: utf8ByteLength(r.json) })),
      maxBytes,
    );
    if (from === undefined) {
      const next = await this.sessionTail(key);
      return {
        from: next,
        transcript: assembleTranscript([], [], next),
        ...(sources ? { sources: structuredClone(sources) } : {}),
        ...(log?.requiresFreshSources ? { requiresFreshSources: true as const } : {}),
      };
    }
    return {
      from,
      transcript: await this.readSession(key, from),
      ...(sources ? { sources: structuredClone(sources) } : {}),
      ...(log?.requiresFreshSources ? { requiresFreshSources: true as const } : {}),
    };
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

  async readRequesterTarget(key: string, actor: string): Promise<RequesterTarget | null> {
    return this.sessions.get(key)?.requesterTargets?.get(actor) ?? null;
  }

  async checkpointRequesterTarget(key: string, actor: string, target: RequesterTarget): Promise<RequesterTarget> {
    const log = this.session(key);
    const targets = (log.requesterTargets ??= new Map());
    const merged = mergeRequesterTarget(targets.get(actor) ?? null, target);
    targets.set(actor, merged);
    return merged;
  }

  async readNotepad(key: string): Promise<Notepad | null> {
    return this.sessions.get(key)?.notepad ?? null;
  }

  async writeNotepad(key: string, gen: string, text: string, runId?: string): Promise<FenceResult> {
    const log = this.sessions.get(key);
    if (!log?.owner) return { ok: false, reason: "unknown-run" };
    if (log.owner.gen !== gen || ((log.sources || runId !== undefined) && log.owner.runId !== runId))
      return { ok: false, reason: "fenced" };
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
    if (!this.finished.has(runId))
      for (const log of this.sessions.values()) if (log.rangePins) delete log.rangePins[runId];
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
      delete row.state.pausedForRetry;
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
