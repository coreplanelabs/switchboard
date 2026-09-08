// The production ledger: HTTPS to the state Worker's `/runs/*` ledger routes
// (features/run-history.md items 28–34), beside `WorkerRunStore`. Same bearer,
// same error classes, same body convention (a STRING JSON body so the runtime
// derives Content-Length, #313). Fenced answers are results, not errors: a
// `409 fenced` is what a zombie generation is supposed to see, and the caller
// acts on it (stop the run locally) rather than retrying.
//
//   POST /runs/claim            {storeKey, run}                          → 200 {ok:true} | 409 {ok:false, reason:"thread-live", live}
//   POST /runs/heartbeat        {storeKey, runId, gen, leaseMs}          → {ok, stop, phase} | 409 fenced
//   POST /runs/append           {storeKey, runId, gen, events}           → {ok} | 409 fenced
//   POST /runs/step             {storeKey, runId, gen, record}           → {ok} | 409 fenced   (after the transcript write)
//   POST /runs/state            {storeKey, runId, gen, state}            → {ok} | 409 fenced
//   POST /runs/inbox            {storeKey, runId, message}               → {ok, seq}
//   POST /runs/stop             {storeKey, runId, mode}                  → {ok, ownerLive}
//   POST /runs/handoff          {storeKey, gen, runIds}                  → {marked}
//   POST /runs/finishing        {storeKey, runId, gen}                   → {ok} | 409 fenced
//   POST /runs/finish           {storeKey, runId, gen, record}           → {ok, stored} | 409 fenced
//   POST /runs/abandon          {storeKey, runId, gen}                   → {ok} | 409 fenced   (the live rows go, no record)
//   POST /runs/reclaim          {storeKey, gen, now, leaseMs}            → {runs: ReclaimedRun[]}
//   POST /runs/live             {storeKey}                               → {runs: LiveRunRow[]}
//   POST /runs/live-events      {storeKey, runId}                        → {events: AppendableEvent[]}
//   POST /runs/transcript/owner {runId, gen}                             → {ok}
//   POST /runs/transcript/write {runId, gen, rows, attachments}          → {ok} | 409 fenced
//   POST /runs/transcript/read  {runId}                                  → {rows, attachments}
//   POST /runs/transcript/clear {runId}                                  → {ok}

import { RUN_ID_PATTERN, type RunRecord } from "./runRecord.js";
import type { RunHistoryConfig } from "./runStore.js";
import {
  DEFAULT_RUN_STORE_TOKEN_ENV,
  PermanentStoreError,
  RouteMissingError,
  RUN_STORE_KEY,
  RUN_STORE_TIMEOUT_MS,
  TransientStoreError,
} from "./runStoreWorker.js";
import type { FinishResult, HeartbeatResult, RunLedger } from "./runLedger/ledger.js";
import { assembleTranscript, chunkRows, turnRows, type AssembledTranscript } from "./runLedger/transcript.js";
import {
  GEN_PATTERN,
  TRANSCRIPT_REQUEST_BYTES,
  type AppendableEvent,
  type ClaimRequest,
  type ClaimResult,
  type FenceResult,
  type LiveRunRow,
  type ReclaimedRun,
  type RunState,
  type StepRecord,
  type StopMode,
  type TranscriptAttachment,
  type TranscriptRow,
  type TranscriptTurn,
  type InboxItem,
} from "./runLedger/types.js";

export interface WorkerRunLedgerOptions {
  baseUrl: string;
  token: string;
  /** The history store this ledger's live rows belong to (`runs:default`). */
  storeKey: string;
  fetch?: typeof fetch;
}

/** The ledger client for the configured run history, or null when history is
 *  off, on host disk (`store: file` — the ledger is Worker-only, so a file
 *  store means no write-through), or the bearer is unset. Mirrors
 *  `buildRunStore`'s selection so the two always point at the same Worker. */
export function buildRunLedger(
  cfg: RunHistoryConfig | undefined,
  env: Record<string, string | undefined>,
  deps: { fetch?: typeof fetch } = {},
): WorkerRunLedger | null {
  if (!cfg || cfg.store === "file") return null;
  const worker = cfg.worker;
  if (!worker?.baseUrl) return null;
  const token = env[worker.tokenEnv ?? DEFAULT_RUN_STORE_TOKEN_ENV]?.trim();
  if (!token) return null; // buildRunStore already warned
  return new WorkerRunLedger({
    baseUrl: worker.baseUrl,
    token,
    storeKey: RUN_STORE_KEY,
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
    if (res.status === 409 || res.ok) return { status: res.status, data };
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

  async claim(req: ClaimRequest): Promise<ClaimResult> {
    this.checkIds(req.runId, req.gen);
    const r = await this.post("/runs/claim", { storeKey: this.opts.storeKey, run: req });
    if (r.status === 409) {
      const live = (r.data.live ?? {}) as { runId?: string; agent?: string; startedAt?: number };
      return {
        ok: false,
        reason: "thread-live",
        live: {
          runId: String(live.runId ?? ""),
          ...(live.agent ? { agent: live.agent } : {}),
          startedAt: Number(live.startedAt ?? 0),
        },
      };
    }
    // The transcript object learns its owner at claim. Two requests, not one
    // transaction: a failure here leaves a claimed run whose transcript answers
    // `unknown-run` until the caller retries the whole claim (idempotent for
    // the owner) or a reclaim resets the owner. Callers never proceed past a
    // claim that threw.
    await this.post("/runs/transcript/owner", { runId: req.runId, gen: req.gen });
    return { ok: true };
  }

  private async writeTurns(runId: string, gen: string, turns: TranscriptTurn[]): Promise<FenceResult> {
    const rows: TranscriptRow[] = [];
    const attachments: TranscriptAttachment[] = [];
    for (const t of turns) {
      const out = turnRows(t.idx, t.message);
      rows.push(...out.rows);
      attachments.push(...out.attachments);
    }
    // Attachments travel one per request (each is under the fence by the ref
    // threshold); rows are chunked under the fence.
    for (const a of attachments) {
      const r = await this.post("/runs/transcript/write", { runId, gen, rows: [], attachments: [a] });
      const f = this.fenceResult(r);
      if (!f.ok) return f;
    }
    const chunks = chunkRows(rows, TRANSCRIPT_REQUEST_BYTES - 4_096);
    for (const chunk of chunks.length ? chunks : [[]]) {
      if (chunk.length === 0 && attachments.length > 0) continue;
      const r = await this.post("/runs/transcript/write", { runId, gen, rows: chunk, attachments: [] });
      const f = this.fenceResult(r);
      if (!f.ok) return f;
    }
    return { ok: true };
  }

  async seed(runId: string, gen: string, turns: TranscriptTurn[]): Promise<FenceResult> {
    this.checkIds(runId, gen);
    return this.writeTurns(runId, gen, turns);
  }

  async step(runId: string, gen: string, record: StepRecord, turns: TranscriptTurn[]): Promise<FenceResult> {
    this.checkIds(runId, gen);
    const written = await this.writeTurns(runId, gen, turns);
    if (!written.ok) return written;
    return this.fenceResult(await this.post("/runs/step", { storeKey: this.opts.storeKey, runId, gen, record }));
  }

  async heartbeat(runId: string, gen: string, leaseMs: number): Promise<HeartbeatResult> {
    this.checkIds(runId, gen);
    const r = await this.post("/runs/heartbeat", { storeKey: this.opts.storeKey, runId, gen, leaseMs });
    const f = this.fenceResult(r);
    if (!f.ok) return f;
    return {
      ok: true,
      stop: (r.data.stop as StopMode | null | undefined) ?? null,
      phase: r.data.phase as HeartbeatResult["phase"],
    };
  }

  async append(runId: string, gen: string, events: AppendableEvent[]): Promise<FenceResult> {
    this.checkIds(runId, gen);
    if (events.length === 0) return { ok: true };
    return this.fenceResult(await this.post("/runs/append", { storeKey: this.opts.storeKey, runId, gen, events }));
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

  async handoff(gen: string, runIds: string[]): Promise<{ marked: string[] }> {
    const r = await this.post("/runs/handoff", { storeKey: this.opts.storeKey, gen, runIds });
    return { marked: Array.isArray(r.data.marked) ? (r.data.marked as string[]) : [] };
  }

  async finishing(runId: string, gen: string): Promise<FenceResult> {
    this.checkIds(runId, gen);
    return this.fenceResult(await this.post("/runs/finishing", { storeKey: this.opts.storeKey, runId, gen }));
  }

  async finish(runId: string, gen: string, record: RunRecord): Promise<FinishResult> {
    this.checkIds(runId, gen);
    const r = await this.post("/runs/finish", { storeKey: this.opts.storeKey, runId, gen, record });
    const f = this.fenceResult(r);
    if (!f.ok) return f;
    // Best-effort: an orphaned transcript is harmless and swept.
    await this.post("/runs/transcript/clear", { runId }).catch(() => {});
    return { ok: true, stored: r.data.stored === true };
  }

  async abandon(runId: string, gen: string): Promise<FenceResult> {
    this.checkIds(runId, gen);
    const f = this.fenceResult(await this.post("/runs/abandon", { storeKey: this.opts.storeKey, runId, gen }));
    if (!f.ok) return f;
    // Best-effort, as after a finish: an orphaned transcript is harmless and swept.
    await this.post("/runs/transcript/clear", { runId }).catch(() => {});
    return f;
  }

  async reclaim(gen: string, now: number, leaseMs: number): Promise<ReclaimedRun[]> {
    const r = await this.post("/runs/reclaim", { storeKey: this.opts.storeKey, gen, now, leaseMs });
    const runs = Array.isArray(r.data.runs) ? (r.data.runs as ReclaimedRun[]) : [];
    // The transcript objects change hands before the caller may resume anything.
    for (const run of runs) await this.post("/runs/transcript/owner", { runId: run.row.runId, gen });
    return runs;
  }

  async listLive(): Promise<LiveRunRow[]> {
    const r = await this.post("/runs/live", { storeKey: this.opts.storeKey });
    return Array.isArray(r.data.runs) ? (r.data.runs as LiveRunRow[]) : [];
  }

  async readEvents(runId: string): Promise<AppendableEvent[]> {
    this.checkIds(runId);
    const r = await this.post("/runs/live-events", { storeKey: this.opts.storeKey, runId });
    return Array.isArray(r.data.events) ? (r.data.events as AppendableEvent[]) : [];
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
