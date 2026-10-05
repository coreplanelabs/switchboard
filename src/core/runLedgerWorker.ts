import { isContextCheckpointReceipt, type CanonicalCheckpointSource } from "./references/contextCheckpoint.js";
import {
  isCoordinatorReconcileReceipt,
  type CoordinatorReconcileReceipt,
} from "./coordinator/workflowReconciliation.js";
import {
  workspaceSettlementOf,
  workspaceOwnerKey,
  isWorkspaceOwner,
  type WorkspaceOwner,
  type WorkspaceSettlement,
  type WorkspaceAck,
} from "./workspaceSettlement.js";
import type { ContextCheckpointRequest, ContextCheckpointResult } from "./runLedger/ledger.js";
import {
  isContextDependencies,
  UNKNOWN_CONTEXT_DEPENDENCIES,
  type ContextDependencies,
} from "./references/contextDependencies.js";
import { type SessionSources, isSessionSources } from "./references/receipts.js";
// The production ledger: HTTPS to the state Worker's `/runs/*` ledger routes
// (docs/reference/specs/run-history.md items 28–34), beside `WorkerRunStore`. Same bearer,
// same error classes, same body convention (a STRING JSON body so the runtime
// derives Content-Length). Fenced answers are results, not errors: a
// `409 fenced` is what a zombie generation is supposed to see, and the caller
// acts on it (stop the run locally) rather than retrying.
//
//   POST /runs/claim            {storeKey, run}                          → 200 {ok:true} | 409 {ok:false, reason:"thread-live", live}
//   POST /runs/heartbeat        {storeKey, runId, gen, leaseMs}          → {ok, stop, phase} | 409 fenced
//   POST /runs/append           {storeKey, runId, gen, events}           → {ok} | 409 fenced
//   POST /runs/live-state       {storeKey, runId, gen, assignment}       → atomic event + projection
//   POST /runs/step             {storeKey, runId, gen, record}           → {ok} | 409 fenced   (after the transcript write)
//   POST /runs/state            {storeKey, runId, gen, state}            → {ok} | 409 fenced
//   POST /runs/inbox            {storeKey, runId, message}               → {ok, seq}
//   POST /runs/stop             {storeKey, runId, mode}                  → {ok, ownerLive}
//   POST /runs/handoff          {storeKey, gen, runIds}                  → {marked}
//   POST /runs/finishing        {storeKey, runId, gen}                   → {ok} | 409 fenced
//   POST /runs/finish           {storeKey, runId, gen, record, point?}   → {ok, stored} | 409 fenced
//   POST /runs/abandon          {storeKey, runId, gen}                   → {ok} | 409 fenced   (the live rows go, no record)
//   POST /runs/reclaim          {storeKey, gen, now, leaseMs}            → {runs: ReclaimedRun[]}
//   POST /runs/live             {storeKey}                               → {runs: LiveRunRow[]}
//   POST /runs/live-events      {storeKey, runId}                        → {events: AppendableEvent[]}
//   POST /runs/transcript/owner {runId, gen}                             → {ok}        (rows claimed before the session log)
//   POST /runs/transcript/write {runId, gen, rows, attachments}          → {ok} | 409 fenced
//   POST /runs/transcript/read  {runId}                                  → {rows, attachments}
//   POST /runs/transcript/clear {runId}                                  → {ok}
//   POST /runs/session/tail        {key}                                 → {next}
//   POST /runs/session/owner       {key, runId, gen, maxBytes}           → {ok}
//   POST /runs/session/write       {key, gen, rows, attachments}         → {ok, bytes} | 409 fenced
//   POST /runs/session/append      {key, rowId, rows}                    → {ok, appended}
//   POST /runs/session/entry       {key, rowId}                          → {rows: TranscriptRow[] | null}
//   POST /runs/session/read        {key, from, to?}                      → {rows, attachments}
//   POST /runs/session/read-tail   {key, maxBytes}                       → {rows, attachments, from}
//   POST /runs/session/clear-owner {key, runId, gen}                     → {ok} | 409 fenced
//   POST /runs/session/search      {key, query, limit}                   → {hits, gaps}
//   POST /runs/session/notepad     {key}                                 → {notepad: {text, updatedAt} | null}
//   POST /runs/session/notepad/write {key, gen, text}                    → {ok} | 409 fenced | 400 over the size
//   POST /runs/intake           {storeKey, key, receipt, windowMs?}      → {inserted, stored}   (insert-if-absent, item 59)
//   POST /runs/intake/read      {storeKey, key}                          → {receipt: IntakeReceipt | null}
//   POST /runs/intake/delivery/claim {storeKey, key, poster, claimedAt}   → {claimed}
//   POST /runs/intake/delivery/finish {storeKey, key, poster, delivered}  → {ok:true}
//   POST /runs/intake/list      {storeKey, threadKey?, since?}           → {receipts: IntakeReceipt[]}

import { RUN_ID_PATTERN, SESSION_KEY_PATTERN, type RunRecord } from "./runRecord.js";
import { RUN_LIVE_STATE_NAMES } from "./runLiveState.js";
import { pointOf } from "./runMetrics.js";
import type { ModelPriceTable } from "./modelPricing.js";
import type { Notepad, SessionHit } from "./runLedger/types.js";
import { retentionPolicyOf, type RunHistoryConfig } from "./runStore.js";
import {
  DEFAULT_RUN_STORE_TOKEN_ENV,
  PermanentStoreError,
  RouteMissingError,
  RUN_STORE_KEY,
  RUN_STORE_TIMEOUT_MS,
  TransientStoreError,
} from "./runStoreWorker.js";
import type { FinishResult, HeartbeatFacts, HeartbeatResult, RequesterTarget, RunLedger } from "./runLedger/ledger.js";
import type {
  PlaneAckOutcome,
  PlaneAskAnswer,
  PlaneEffect,
  PlaneEndingCause,
  PlaneOutcomePost,
  PlaneQueueRow,
  PlaneReclaimWord,
} from "./plane/decide.js";
import type { PlaneAdmitPost, PlaneLevelPost, PlaneObservePost } from "./runLedger/ledger.js";
import { DEFAULT_SESSION_LOG_MAX_BYTES } from "./runLedger/sessionLog.js";
import { assembleTranscript, chunkRows, turnRows, type AssembledTranscript } from "./runLedger/transcript.js";
import {
  GEN_PATTERN,
  isIntakeReceipt,
  TRANSCRIPT_REQUEST_BYTES,
  type AppendableEvent,
  type IntakeQuery,
  type IntakeReceipt,
  type IntakeWriteResult,
  type ClaimRequest,
  type ClaimResult,
  type FenceResult,
  type LiveRunRow,
  type LiveStateAssignRequest,
  type LiveStateAssignResult,
  type ReclaimedRun,
  type RunState,
  type StepRecord,
  type StopMode,
  type TranscriptAttachment,
  type TranscriptRow,
  type TranscriptTurn,
  type InboxItem,
} from "./runLedger/types.js";
import type { Secrets } from "../secrets.js";

export interface WorkerRunLedgerOptions {
  baseUrl: string;
  token: string;
  /** The history store this ledger's live rows belong to (`runs:default`). */
  storeKey: string;
  /** The session log byte budget every owner claim carries (`RetentionPolicy.sessionLogMaxBytes`). */
  sessionLogMaxBytes?: number;
  /** The reconnect catch-up window, carried on every intake write so the
   *  object prunes by run-history item 59's bound (24 h, or the window plus
   *  the drain deadline); absent, the object keeps the 24-hour floor. */
  catchUpWindowMs?: number;
  /** The price table the finish's metrics point is priced through (`pointOf`,
   *  docs/reference/specs/run-metrics.md). Absent: the list prices alone. */
  prices?: ModelPriceTable;
  fetch?: typeof fetch;
}

/** The ledger client for the configured run history, or null when history is
 *  off, on host disk (`store: file` — the ledger is Worker-only, so a file
 *  store means no write-through), or the bearer is unset. Mirrors
 *  `buildRunStore`'s selection so the two always point at the same Worker. */
export function buildRunLedger(
  cfg: RunHistoryConfig | undefined,
  secrets: Secrets,
  deps: { fetch?: typeof fetch; prices?: ModelPriceTable } = {},
): WorkerRunLedger | null {
  if (!cfg || cfg.store === "file") return null;
  const worker = cfg.worker;
  if (!worker?.baseUrl) return null;
  const token = secrets.named(worker.tokenEnv ?? DEFAULT_RUN_STORE_TOKEN_ENV);
  if (!token) return null; // buildRunStore already warned
  return new WorkerRunLedger({
    baseUrl: worker.baseUrl,
    token: token.reveal(),
    storeKey: RUN_STORE_KEY,
    // The same clamped policy the run store proposes, so the session logs and
    // the run records are bounded by one configuration.
    sessionLogMaxBytes: retentionPolicyOf(cfg).sessionLogMaxBytes,
    ...(deps.prices ? { prices: deps.prices } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

export class WorkerRunLedger implements RunLedger {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WorkerRunLedgerOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    acceptBadRequest = false,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RUN_STORE_TIMEOUT_MS),
      });
    } catch (err) {
      throw new TransientStoreError(`run ledger ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 404) throw new RouteMissingError(`run ledger ${path}: route missing (older state Worker)`);
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      throw new TransientStoreError(`run ledger ${path}: HTTP ${res.status}`);
    }
    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new PermanentStoreError(`run ledger ${path}: non-JSON body (HTTP ${res.status})`);
    }
    if (res.status === 409 || res.ok || (acceptBadRequest && res.status === 400)) return { status: res.status, data };
    throw new PermanentStoreError(`run ledger ${path}: HTTP ${res.status} ${String(data.error ?? "")}`.trim());
  }

  private fenceResult(r: { status: number; data: Record<string, unknown> }): FenceResult {
    if (r.status === 409) {
      return { ok: false, reason: r.data.reason === "unknown-run" ? "unknown-run" : "fenced" };
    }
    return { ok: true };
  }

  private checkIds(runId: string, gen?: string): void {
    if (!RUN_ID_PATTERN.test(runId))
      throw new PermanentStoreError(`run ledger: malformed run id ${JSON.stringify(runId)}`);
    if (gen !== undefined && !GEN_PATTERN.test(gen)) throw new PermanentStoreError(`run ledger: malformed generation`);
  }

  async residentClaim(
    runId: string,
    gen: string,
    threadKey: string,
  ): Promise<{ ok: true; fence: number } | { ok: false; reason: "fenced" | "unknown-run" }> {
    this.checkIds(runId, gen);
    const r = await this.post("/runs/resident-claim", { storeKey: this.opts.storeKey, runId, gen, threadKey });
    if (r.status === 409) return { ok: false, reason: r.data.reason === "unknown-run" ? "unknown-run" : "fenced" };
    if (!Number.isSafeInteger(r.data.fence) || (r.data.fence as number) <= 0)
      throw new PermanentStoreError("run ledger resident claim: invalid fence");
    return { ok: true, fence: r.data.fence as number };
  }

  async workspaceSettlement(owner: WorkspaceOwner): Promise<WorkspaceSettlement | undefined> {
    if (!isWorkspaceOwner(owner)) throw new PermanentStoreError("run ledger: invalid workspace owner");
    const r = await this.post("/runs/preservation-owner", { storeKey: this.opts.storeKey, ...owner });
    if (r.data.kind === "live" || r.data.kind === "unknown") return;
    if (
      r.data.kind === "absent" &&
      isWorkspaceOwner(r.data.owner) &&
      workspaceOwnerKey(r.data.owner) === workspaceOwnerKey(owner)
    )
      return;
    if (
      r.data.kind === "acknowledged" &&
      isWorkspaceOwner(r.data.owner) &&
      workspaceOwnerKey(r.data.owner) === workspaceOwnerKey(owner) &&
      Number.isSafeInteger(r.data.revision) &&
      Number(r.data.revision) > 0
    )
      return;
    const value = workspaceSettlementOf(r.data.settlement);
    if (r.data.kind !== "terminal" || !value || workspaceOwnerKey(value.owner) !== workspaceOwnerKey(owner))
      throw new PermanentStoreError("run ledger: invalid workspace settlement");
    return value;
  }

  async ackWorkspaceSettlement(owner: WorkspaceOwner, revision: number): Promise<WorkspaceAck> {
    if (!isWorkspaceOwner(owner) || !Number.isSafeInteger(revision) || revision <= 0)
      throw new PermanentStoreError("run ledger: invalid workspace acknowledgment");
    const r = await this.post("/runs/workspace-ack", { storeKey: this.opts.storeKey, ...owner, revision });
    if (r.status === 200 && r.data.ok === true) return { ok: true };
    const reason = r.data.reason;
    if (
      r.status === 409 &&
      r.data.ok === false &&
      (reason === "owner-live" || reason === "stale" || reason === "unverified")
    )
      return { ok: false, reason };
    throw new PermanentStoreError("run ledger: invalid workspace acknowledgment response");
  }

  async claim(req: ClaimRequest): Promise<ClaimResult> {
    this.checkIds(req.runId, req.gen);
    const r = await this.post("/runs/claim", { storeKey: this.opts.storeKey, run: req });
    if (r.status === 409) {
      const live = (r.data.live ?? {}) as {
        runId?: string;
        agent?: string;
        startedAt?: number;
        idempotencyKey?: string;
      };
      return {
        ok: false,
        reason: "thread-live",
        live: {
          runId: String(live.runId ?? ""),
          ...(live.agent ? { agent: live.agent } : {}),
          startedAt: Number(live.startedAt ?? 0),
          ...(typeof live.idempotencyKey === "string" ? { idempotencyKey: live.idempotencyKey } : {}),
        },
      };
    }
    // The run's rows go to its session log, owned by `claimSession` once the
    // caller knows the log's tail; a run's own transcript object is never
    // owned any more (rows claimed before the log existed keep theirs).
    return { ok: true };
  }

  /** The write route and its body for a run's rows: the session log when the
   *  run has one, the run's own transcript object otherwise. */
  private target(runId: string, gen: string, session: string | undefined) {
    if (session === undefined) return { path: "/runs/transcript/write", body: { runId, gen } };
    this.checkSessionKey(session);
    return { path: "/runs/session/write", body: { key: session, runId, gen } };
  }

  private async writeTurns(
    runId: string,
    gen: string,
    turns: TranscriptTurn[],
    session?: string,
    seed = false,
  ): Promise<FenceResult> {
    const rows: TranscriptRow[] = [];
    const attachments: TranscriptAttachment[] = [];
    for (const t of turns) {
      const out = turnRows(
        t.idx,
        "message" in t ? t.message : { compaction: t.compaction },
        {},
        "message" in t ? t.actor : undefined,
      );
      rows.push(...out.rows);
      attachments.push(...out.attachments);
    }
    const { path, body: targetBody } = this.target(runId, gen, session);
    const body = { ...targetBody, ...(seed && session !== undefined ? { seed: true } : {}) };
    // Attachments travel one per request (each is under the fence by the ref
    // threshold); rows are chunked under the fence.
    for (const a of attachments) {
      const r = await this.post(path, { ...body, rows: [], attachments: [a] });
      const f = this.fenceResult(r);
      if (!f.ok) return f;
    }
    const chunks = chunkRows(rows, TRANSCRIPT_REQUEST_BYTES - 4_096);
    for (const chunk of chunks.length ? chunks : [[]]) {
      if (chunk.length === 0 && attachments.length > 0) continue;
      const r = await this.post(path, { ...body, rows: chunk, attachments: [] });
      const f = this.fenceResult(r);
      if (!f.ok) return f;
    }
    return { ok: true };
  }

  async readContextCheckpoint(runId: string): Promise<CanonicalCheckpointSource | undefined> {
    const result = await this.post("/runs/context-checkpoint", { storeKey: this.opts.storeKey, runId });
    const source = result.data.source as CanonicalCheckpointSource | undefined;
    return source?.runId === runId && isContextCheckpointReceipt(source.receipt) ? source : undefined;
  }

  async normalizeContextOrigins(request: ContextCheckpointRequest): Promise<ContextCheckpointResult> {
    this.checkSessionKey(request.key);
    this.checkIds(request.runId, request.gen);
    const result = await this.post("/runs/session/checkpoint", { storeKey: this.opts.storeKey, ...request });
    const body = result.data as unknown as ContextCheckpointResult;
    if (body.ok && isContextCheckpointReceipt(body.receipt) && body.receipt.runId === request.runId) return body;
    return {
      ok: false,
      reason:
        !body.ok && (body.reason === "fenced" || body.reason === "unknown-run")
          ? body.reason
          : "checkpoint-unavailable",
    };
  }

  async writeSessionSources(key: string, runId: string, gen: string, sources: SessionSources): Promise<FenceResult> {
    this.checkSessionKey(key);
    this.checkIds(runId, gen);
    const result = await this.post("/runs/session/write", {
      storeKey: this.opts.storeKey,
      key,
      gen,
      sourceRunId: runId,
      sources,
      rows: [],
      attachments: [],
    });
    const fence = this.fenceResult(result);
    return fence.ok && result.data.sourcesSaved !== true ? { ok: false, reason: "fenced" } : fence;
  }

  async seed(runId: string, gen: string, turns: TranscriptTurn[], session?: string): Promise<FenceResult> {
    this.checkIds(runId, gen);
    return this.writeTurns(runId, gen, turns, session, true);
  }

  async step(
    runId: string,
    gen: string,
    record: StepRecord,
    turns: TranscriptTurn[],
    session?: string,
  ): Promise<FenceResult> {
    this.checkIds(runId, gen);
    const written = await this.writeTurns(runId, gen, turns, session);
    if (!written.ok) return written;
    return this.fenceResult(await this.post("/runs/step", { storeKey: this.opts.storeKey, runId, gen, record }));
  }

  private checkSessionKey(key: string): void {
    if (!SESSION_KEY_PATTERN.test(key))
      throw new PermanentStoreError(`run ledger: malformed session key ${JSON.stringify(key)}`);
  }

  async sessionTail(key: string): Promise<number> {
    this.checkSessionKey(key);
    const r = await this.post("/runs/session/tail", { key });
    return typeof r.data.next === "number" ? r.data.next : 0;
  }

  async appendSession(
    key: string,
    rowId: string,
    rows: readonly { part: number; json: string }[],
    context?: ContextDependencies,
  ): Promise<{ ok: boolean; appended: boolean }> {
    this.checkSessionKey(key);
    if (context !== undefined && !isContextDependencies(context)) throw new Error("invalid context dependencies");
    const r = await this.post("/runs/session/append", {
      storeKey: this.opts.storeKey,
      key,
      rowId,
      rows,
      context: context ?? UNKNOWN_CONTEXT_DEPENDENCIES,
    });
    return { ok: r.data.ok === true && r.data.contextSaved === true, appended: r.data.appended === true };
  }

  async claimSession(key: string, runId: string, gen: string, maxBytes?: number): Promise<void> {
    this.checkSessionKey(key);
    this.checkIds(runId, gen);
    // Every claim carries the budget, so the object never keeps a stale one
    // from an earlier configuration.
    await this.post("/runs/session/owner", {
      key,
      runId,
      gen,
      maxBytes: maxBytes ?? this.opts.sessionLogMaxBytes ?? DEFAULT_SESSION_LOG_MAX_BYTES,
    });
  }

  async releaseSession(key: string, runId: string, gen: string): Promise<FenceResult> {
    this.checkSessionKey(key);
    this.checkIds(runId, gen);
    return this.fenceResult(await this.post("/runs/session/clear-owner", { key, runId, gen }));
  }

  async readSessionEntry(key: string, rowId: string): Promise<readonly TranscriptRow[] | undefined> {
    this.checkSessionKey(key);
    const response = await this.post("/runs/session/entry", { key, rowId });
    const rows = response.data.rows;
    if (
      !Array.isArray(rows) ||
      rows.length === 0 ||
      !rows.every((row: unknown) => {
        if (!row || typeof row !== "object") return false;
        const part = row as TranscriptRow;
        return (
          Number.isSafeInteger(part.idx) &&
          part.idx >= 0 &&
          Number.isSafeInteger(part.part) &&
          part.part >= 0 &&
          typeof part.json === "string"
        );
      })
    )
      return undefined;
    return rows as TranscriptRow[];
  }

  async readSession(key: string, from: number, to?: number): Promise<AssembledTranscript> {
    this.checkSessionKey(key);
    const r = await this.post("/runs/session/read", { key, from, ...(to !== undefined ? { to } : {}) });
    return assembleTranscript(
      Array.isArray(r.data.rows) ? (r.data.rows as TranscriptRow[]) : [],
      Array.isArray(r.data.attachments) ? (r.data.attachments as TranscriptAttachment[]) : [],
      from,
    );
  }

  async readSessionTail(
    key: string,
    maxBytes: number,
  ): Promise<{ from: number; transcript: AssembledTranscript; sources?: SessionSources; requiresFreshSources?: true }> {
    this.checkSessionKey(key);
    const r = await this.post("/runs/session/read-tail", { key, maxBytes });
    const from = typeof r.data.from === "number" ? r.data.from : 0;
    return {
      from,
      ...(isSessionSources(r.data.sources) ? { sources: r.data.sources } : {}),
      ...(r.data.requiresFreshSources === true ? { requiresFreshSources: true as const } : {}),
      transcript: assembleTranscript(
        Array.isArray(r.data.rows) ? (r.data.rows as TranscriptRow[]) : [],
        Array.isArray(r.data.attachments) ? (r.data.attachments as TranscriptAttachment[]) : [],
        from,
      ),
    };
  }

  async searchSession(key: string, query: string, limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }> {
    this.checkSessionKey(key);
    const r = await this.post("/runs/session/search", { key, query, limit });
    return {
      hits: Array.isArray(r.data.hits) ? (r.data.hits as SessionHit[]) : [],
      gaps: Array.isArray(r.data.gaps) ? (r.data.gaps as number[]) : [],
    };
  }

  async readRequesterTarget(key: string, actor: string): Promise<RequesterTarget | null> {
    this.checkSessionKey(key);
    const r = await this.post("/runs/session/requester-target", { key, actor });
    return (r.data.target as RequesterTarget | null) ?? null;
  }

  async checkpointRequesterTarget(key: string, actor: string, target: RequesterTarget): Promise<RequesterTarget> {
    this.checkSessionKey(key);
    const r = await this.post("/runs/session/requester-target/write", { key, actor, target });
    if (!r.data.target) throw new PermanentStoreError("run ledger: requester target checkpoint missing");
    return r.data.target as RequesterTarget;
  }

  async readNotepad(key: string): Promise<Notepad | null> {
    this.checkSessionKey(key);
    const r = await this.post("/runs/session/notepad", { key });
    const n = r.data.notepad as { text?: unknown; updatedAt?: unknown } | null | undefined;
    return n && typeof n.text === "string" && typeof n.updatedAt === "number"
      ? { text: n.text, updatedAt: n.updatedAt }
      : null;
  }

  async writeNotepad(key: string, gen: string, text: string, runId?: string): Promise<FenceResult> {
    this.checkSessionKey(key);
    if (!GEN_PATTERN.test(gen)) throw new PermanentStoreError(`run ledger: malformed generation`);
    return this.fenceResult(await this.post("/runs/session/notepad/write", { key, gen, text, runId }));
  }

  async heartbeat(runId: string, gen: string, leaseMs: number, facts?: HeartbeatFacts): Promise<HeartbeatResult> {
    this.checkIds(runId, gen);
    const r = await this.post("/runs/heartbeat", {
      storeKey: this.opts.storeKey,
      runId,
      gen,
      leaseMs,
      ...(facts !== undefined ? { facts } : {}),
    });
    const f = this.fenceResult(r);
    if (!f.ok) return f;
    return {
      ok: true,
      stop: (r.data.stop as StopMode | null | undefined) ?? null,
      phase: r.data.phase as HeartbeatResult["phase"],
      // The plane's open effects (orchestration-plane; record 0064; orchestration-plane item 7) — an
      // older state Worker's answer has no field, read as none offered.
      effects: Array.isArray(r.data.effects) ? (r.data.effects as PlaneEffect[]) : [],
    };
  }

  async planeOutcome(post: PlaneOutcomePost): Promise<{ ok: boolean; decider?: string; agreed?: boolean | null }> {
    const r = await this.post("/plane/outcome", { storeKey: this.opts.storeKey, ...post });
    return r.data as { ok: boolean; decider?: string; agreed?: boolean | null };
  }

  async planeFenceSteer(id: string, runId: string, gen: string, leaseMs: number): Promise<boolean> {
    this.checkIds(runId, gen);
    const r = await this.post("/plane/steer/fence", { storeKey: this.opts.storeKey, id, runId, gen, leaseMs });
    return r.data.accepted === true;
  }

  async planeAck(
    id: string,
    outcome: PlaneAckOutcome,
    owner?: { runId: string; gen: string },
    reconciliation?: CoordinatorReconcileReceipt,
  ): Promise<void> {
    if (owner) this.checkIds(owner.runId, owner.gen);
    if (reconciliation !== undefined && (!isCoordinatorReconcileReceipt(reconciliation) || outcome !== "done"))
      throw new PermanentStoreError("run ledger: invalid reconciliation acknowledgement");
    const response = await this.post("/plane/ack", {
      storeKey: this.opts.storeKey,
      id,
      outcome,
      ...(owner ? { owner } : {}),
      ...(reconciliation ? { reconciliation } : {}),
    });
    if (reconciliation !== undefined && (response.status !== 200 || response.data.ok !== true))
      throw new TransientStoreError("run ledger: reconciliation acknowledgement unconfirmed");
  }

  async planeAdmit(post: PlaneAdmitPost): Promise<PlaneAskAnswer> {
    const r = await this.post("/plane/admit", { storeKey: this.opts.storeKey, ...post });
    return r.data as unknown as PlaneAskAnswer;
  }

  async planeWithdraw(runId: string): Promise<{ withdrawn: boolean }> {
    const r = await this.post("/plane/withdraw", { storeKey: this.opts.storeKey, runId });
    return r.data as unknown as { withdrawn: boolean };
  }

  async planeQueued(runId: string): Promise<PlaneQueueRow | null> {
    const r = await this.post("/plane/queued", { storeKey: this.opts.storeKey, runId });
    return (r.data as { row?: PlaneQueueRow | null }).row ?? null;
  }

  async planeReclaimed(
    outcomes: readonly { runId: string; outcome: PlaneReclaimWord }[],
  ): Promise<{ runId: string; cause: PlaneEndingCause }[]> {
    const r = await this.post("/plane/reclaimed", { storeKey: this.opts.storeKey, outcomes });
    return (r.data as { recorded?: { runId: string; cause: PlaneEndingCause }[] }).recorded ?? [];
  }

  async planeLevel(post: PlaneLevelPost): Promise<void> {
    await this.post("/plane/level", { storeKey: this.opts.storeKey, ...post });
  }

  async planePark(runId: string, provider: string): Promise<void> {
    await this.post("/plane/park", { storeKey: this.opts.storeKey, runId, provider });
  }

  async planeObserve(post: PlaneObservePost): Promise<{ reentered: boolean }> {
    const r = await this.post("/plane/observe", { storeKey: this.opts.storeKey, ...post });
    return r.data as unknown as { reentered: boolean };
  }

  async append(runId: string, gen: string, events: AppendableEvent[]): Promise<FenceResult> {
    this.checkIds(runId, gen);
    if (events.length === 0) return { ok: true };
    return this.fenceResult(await this.post("/runs/append", { storeKey: this.opts.storeKey, runId, gen, events }));
  }

  async assignLiveState(
    runId: string,
    gen: string,
    assignment: LiveStateAssignRequest,
  ): Promise<LiveStateAssignResult> {
    this.checkIds(runId, gen);
    const r = await this.post("/runs/live-state", { storeKey: this.opts.storeKey, runId, gen, assignment }, true);
    const data = r.data;
    if (data && !Array.isArray(data) && data.ok === false) {
      const reason = data.reason;
      if (
        (r.status === 400 &&
          (reason === "stale-sequence" ||
            reason === "invalid-transition" ||
            reason === "terminal" ||
            reason === "bound-required" ||
            reason === "invalid-bound" ||
            reason === "cause-required")) ||
        (r.status === 409 && (reason === "fenced" || reason === "unknown-run"))
      )
        return { ok: false, reason };
    }
    const liveState = data?.liveState as Record<string, unknown> | undefined;
    if (
      r.status === 200 &&
      data?.ok === true &&
      liveState &&
      RUN_LIVE_STATE_NAMES.includes(liveState.state as (typeof RUN_LIVE_STATE_NAMES)[number]) &&
      typeof liveState.since === "number" &&
      Number.isFinite(liveState.since) &&
      Number.isSafeInteger(data.liveStateSeq) &&
      (data.liveStateSeq as number) >= 0
    )
      return data as unknown as LiveStateAssignResult;
    throw new PermanentStoreError(`run ledger /runs/live-state: invalid acknowledgement (HTTP ${r.status})`);
  }

  async setState(runId: string, gen: string, state: RunState): Promise<FenceResult> {
    this.checkIds(runId, gen);
    return this.fenceResult(await this.post("/runs/state", { storeKey: this.opts.storeKey, runId, gen, state }));
  }

  async pushInbox(runId: string, message: Record<string, unknown>): Promise<{ ok: boolean; seq?: number }> {
    this.checkIds(runId);
    const r = await this.post("/runs/inbox", { storeKey: this.opts.storeKey, runId, message });
    return { ok: r.data.ok === true, ...(typeof r.data.seq === "number" ? { seq: r.data.seq } : {}) };
  }

  async readInbox(runId: string, afterSeq: number): Promise<InboxItem[]> {
    this.checkIds(runId);
    const r = await this.post("/runs/inbox/read", { storeKey: this.opts.storeKey, runId, afterSeq });
    return Array.isArray(r.data.items) ? (r.data.items as InboxItem[]) : [];
  }

  async requestStop(runId: string, mode: StopMode): Promise<{ ok: boolean; ownerLive?: boolean }> {
    this.checkIds(runId);
    const r = await this.post("/runs/stop", { storeKey: this.opts.storeKey, runId, mode });
    return {
      ok: r.data.ok === true,
      ...(typeof r.data.ownerLive === "boolean" ? { ownerLive: r.data.ownerLive } : {}),
    };
  }

  async handoff(gen: string, runIds: string[], opts?: { pausedForRetry: true }): Promise<{ marked: string[] }> {
    const r = await this.post("/runs/handoff", { storeKey: this.opts.storeKey, gen, runIds, ...opts });
    return { marked: Array.isArray(r.data.marked) ? (r.data.marked as string[]) : [] };
  }

  async finishing(runId: string, gen: string): Promise<FenceResult> {
    this.checkIds(runId, gen);
    return this.fenceResult(await this.post("/runs/finishing", { storeKey: this.opts.storeKey, runId, gen }));
  }

  async finish(
    runId: string,
    gen: string,
    record: RunRecord,
    opts?: { requireStoppedPause: true },
  ): Promise<FinishResult> {
    this.checkIds(runId, gen);
    // The record's metrics point rides the finish (run-metrics.md): the object
    // writes it after its commit, only when the row turned final.
    const point = pointOf(record, this.opts.prices);
    const r = await this.post("/runs/finish", {
      storeKey: this.opts.storeKey,
      runId,
      gen,
      record,
      ...opts,
      ...(point !== undefined ? { point } : {}),
    });
    const f = this.fenceResult(r);
    if (!f.ok) return f;
    // The session log is kept whole for the thread's next run; only the owner
    // is released, best-effort — a stale owner is replaced by the next claim,
    // and a run's own transcript object, when it has one, is swept with it.
    if (record.session)
      await this.post("/runs/session/clear-owner", { key: record.session.key, runId, gen }).catch(() => {});
    return { ok: true, stored: r.data.stored === true };
  }

  async abandon(runId: string, gen: string): Promise<FenceResult> {
    this.checkIds(runId, gen);
    // An abandoned run never had a prompt, so it owns no session log and wrote no row.
    return this.fenceResult(await this.post("/runs/abandon", { storeKey: this.opts.storeKey, runId, gen }));
  }

  async reclaim(gen: string, now: number, leaseMs: number): Promise<ReclaimedRun[]> {
    const r = await this.post("/runs/reclaim", { storeKey: this.opts.storeKey, gen, now, leaseMs });
    const runs = Array.isArray(r.data.runs) ? (r.data.runs as ReclaimedRun[]) : [];
    // The rows' logs change hands before the caller may resume anything: a
    // row's session log, or — for one claimed before the log existed — its own
    // transcript object.
    for (const run of runs) {
      const session = run.row.meta?.session;
      if (session) await this.claimSession(session.key, run.row.runId, gen);
      else await this.post("/runs/transcript/owner", { runId: run.row.runId, gen });
    }
    return runs;
  }

  async listLive(): Promise<LiveRunRow[]> {
    const r = await this.post("/runs/live", { storeKey: this.opts.storeKey });
    const rows = r.data.runs;
    if (
      !Array.isArray(rows) ||
      r.data.nextBefore !== undefined ||
      rows.some(
        (row: LiveRunRow) =>
          !row ||
          typeof row.runId !== "string" ||
          !RUN_ID_PATTERN.test(row.runId) ||
          !Number.isFinite(row.startedAt) ||
          !row.meta ||
          [row.meta.channelId, row.meta.userId, row.meta.threadKey].some((field) => typeof field !== "string") ||
          [row.meta.parentInstanceId, row.meta.idempotencyKey].some(
            (field) => field !== undefined && typeof field !== "string",
          ),
      ) ||
      new Set(rows.map((row: LiveRunRow) => row.runId)).size !== rows.length
    )
      throw new PermanentStoreError("run ledger /runs/live returned incomplete or malformed rows");
    return rows as LiveRunRow[];
  }

  async readEvents(runId: string): Promise<AppendableEvent[]> {
    this.checkIds(runId);
    const r = await this.post("/runs/live-events", { storeKey: this.opts.storeKey, runId });
    return Array.isArray(r.data.events) ? (r.data.events as AppendableEvent[]) : [];
  }

  async recordIntake(key: string, receipt: IntakeReceipt): Promise<IntakeWriteResult> {
    const r = await this.post("/runs/intake", {
      storeKey: this.opts.storeKey,
      key,
      receipt,
      ...(this.opts.catchUpWindowMs !== undefined ? { windowMs: this.opts.catchUpWindowMs } : {}),
    });
    return {
      inserted: r.data.inserted === true,
      stored: isIntakeReceipt(r.data.stored) ? r.data.stored : receipt,
    };
  }

  async readIntake(key: string): Promise<IntakeReceipt | undefined> {
    const r = await this.post("/runs/intake/read", { storeKey: this.opts.storeKey, key });
    return isIntakeReceipt(r.data.receipt) ? r.data.receipt : undefined;
  }

  async claimIntakeDelivery(key: string, poster: string, claimedAt: number): Promise<boolean> {
    const r = await this.post("/runs/intake/delivery/claim", {
      storeKey: this.opts.storeKey,
      key,
      poster,
      claimedAt,
    });
    return r.data.claimed === true;
  }

  async finishIntakeDelivery(key: string, poster: string, delivered: boolean): Promise<void> {
    await this.post("/runs/intake/delivery/finish", {
      storeKey: this.opts.storeKey,
      key,
      poster,
      delivered,
    });
  }

  async listIntake(query: IntakeQuery): Promise<IntakeReceipt[]> {
    const r = await this.post("/runs/intake/list", {
      storeKey: this.opts.storeKey,
      ...(query.threadKey !== undefined ? { threadKey: query.threadKey } : {}),
      ...(query.since !== undefined ? { since: query.since } : {}),
    });
    return Array.isArray(r.data.receipts) ? r.data.receipts.filter(isIntakeReceipt) : [];
  }

  async readTranscript(runId: string): Promise<AssembledTranscript> {
    this.checkIds(runId);
    const r = await this.post("/runs/transcript/read", { runId });
    return assembleTranscript(
      Array.isArray(r.data.rows) ? (r.data.rows as TranscriptRow[]) : [],
      Array.isArray(r.data.attachments) ? (r.data.attachments as TranscriptAttachment[]) : [],
    );
  }
}
