// The in-memory ledger: the reference implementation the bot's tests run
// against, applying the same pure decisions the Durable Object applies. It
// also documents the storage shape in the plainest form.

import type { RunRecord } from "../runRecord.js";
import { checkFence, decideClaim, phaseTransition, selectReclaim } from "./decisions.js";
import type { FinishResult, HeartbeatResult, RunLedger } from "./ledger.js";
import { assembleTranscript, turnRows, type AssembledTranscript } from "./transcript.js";
import type {
  AppendableEvent,
  ClaimRequest,
  ClaimResult,
  FenceResult,
  InboxItem,
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

export class InMemoryRunLedger implements RunLedger {
  readonly live = new Map<string, LiveRunRow>();
  readonly steps = new Map<string, StepRecord[]>();
  readonly events = new Map<string, AppendableEvent[]>();
  readonly inbox = new Map<string, InboxItem[]>();
  readonly jobs = new Map<string, RunJob[]>();
  readonly transcripts = new Map<string, Transcript>();
  readonly finished = new Map<string, RunRecord>();

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
          }
        : undefined,
      req,
    );
    if (!decision.ok) return decision;
    if (existing) return decision; // idempotent re-claim
    this.live.set(req.runId, {
      runId: req.runId,
      threadKey: req.threadKey,
      ownerGen: req.gen,
      leaseUntil: this.now() + req.leaseMs,
      startedAt: req.startedAt,
      phase: "live",
      stop: null,
      meta: req.meta,
      card: req.card ?? null,
      system: req.system,
      tools: req.tools,
      state: req.state ?? {},
    });
    this.transcripts.set(req.runId, { ownerGen: req.gen, rows: [], attachments: [] });
    return decision;
  }

  private writeTurns(runId: string, gen: string, turns: TranscriptTurn[]): FenceResult {
    const t = this.transcripts.get(runId);
    if (!t) return { ok: false, reason: "unknown-run" };
    if (t.ownerGen !== gen) return { ok: false, reason: "fenced" };
    for (const turn of turns) {
      const { rows, attachments } = turnRows(turn.idx, turn.message);
      t.rows.push(...rows);
      t.attachments.push(...attachments);
    }
    return { ok: true };
  }

  async seed(runId: string, gen: string, turns: TranscriptTurn[]): Promise<FenceResult> {
    return this.writeTurns(runId, gen, turns);
  }

  async step(runId: string, gen: string, record: StepRecord, turns: TranscriptTurn[]): Promise<FenceResult> {
    const written = this.writeTurns(runId, gen, turns);
    if (!written.ok) return written;
    const fence = this.fence(runId, gen);
    if (!fence.ok) return fence;
    const list = this.steps.get(runId) ?? [];
    list.push(record);
    this.steps.set(runId, list);
    return { ok: true };
  }

  async heartbeat(runId: string, gen: string, leaseMs: number): Promise<HeartbeatResult> {
    const row = this.live.get(runId);
    const fence = checkFence(row, gen);
    if (!fence.ok || !row) return fence;
    row.leaseUntil = this.now() + leaseMs;
    return { ok: true, stop: row.stop, phase: row.phase };
  }

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
    this.live.delete(runId);
    this.steps.delete(runId);
    this.inbox.delete(runId);
    this.jobs.delete(runId);
    this.transcripts.delete(runId);
    return { ok: true, stored: true };
  }

  async reclaim(gen: string, now: number, leaseMs: number): Promise<ReclaimedRun[]> {
    const taken = selectReclaim([...this.live.values()], now);
    const out: ReclaimedRun[] = [];
    for (const row of taken) {
      const reclaimedFrom = row.phase;
      row.ownerGen = gen;
      row.leaseUntil = now + leaseMs;
      row.phase = "live";
      const t = this.transcripts.get(row.runId);
      if (t) t.ownerGen = gen;
      const steps = this.steps.get(row.runId) ?? [];
      const lastStep = steps.length ? steps[steps.length - 1] : null;
      const consumed = lastStep?.inboxConsumedSeq ?? 0;
      out.push({
        row,
        reclaimedFrom,
        lastStep,
        inbox: (this.inbox.get(row.runId) ?? []).filter((i) => i.seq > consumed),
        jobs: this.jobs.get(row.runId) ?? [],
      });
    }
    return out;
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
