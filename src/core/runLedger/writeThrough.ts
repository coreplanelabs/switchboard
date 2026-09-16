// The bot's write-through onto the run ledger (docs/reference/specs/run-history.md item
// 35): one `LedgerRun` per dispatched run that mirrors what the process holds
// in closures — the claim with the composed system prompt and tool
// definitions, the seed, a step record before each step's tools, the event
// stream in batches, the dispatcher's state, the finishing CAS, the finish —
// so the next container generation can pick the run up (the plan's D1–D3).
//
// Phase 2 rule: the ledger never changes what a run does. A refused or failed
// write detaches the run from the ledger (one warning, this run is not
// resumable) and the run goes on exactly as before; only the finish record is
// never dropped — it falls back to the plain store. The resume phase turns a
// fence refusal into a stop (a zombie must not keep working); this file is
// where that lands.

import { randomUUID } from "node:crypto";
import type { StepReport } from "./stepReport.js";
import type { ChatMessage } from "../chatMessage.js";
import type { ToolDef } from "../provider.js";
import type { RunEvent } from "../runEvents.js";
import type { RunRecord, RunSession } from "../runRecord.js";
import type { AssembledTranscript } from "./transcript.js";
import type { FenceResult, Notepad, SessionHit } from "./types.js";
import { PermanentStoreError, RouteMissingError } from "../runStoreWorker.js";
import { createAppendFlusher } from "./flusher.js";
import type { RunLedger } from "./ledger.js";
import { requestIndex, sessionKey } from "./sessionLog.js";
import {
  APPEND_FLUSH_EVENTS,
  APPEND_FLUSH_MS,
  GEN_PATTERN,
  HEARTBEAT_MS,
  LEASE_MS,
  type AppendableEvent,
  type CardHandle,
  type LiveRunMeta,
  type RunState,
  type StepRecord,
  type StopMode,
  type TranscriptTurn,
  type InboxItem,
} from "./types.js";

/** The generation id: the process's fencing token, minted once at boot. Time
 *  first so a listing sorts by boot, then randomness so two containers booting
 *  in the same second (a rollout) never share one. Matches `GEN_PATTERN`. */
export function mintGeneration(now: () => number = Date.now, random: () => string = randomUUID): string {
  const stamp = new Date(now())
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const gen = `${stamp}-${random().replace(/-/g, "").slice(0, 8)}`;
  if (!GEN_PATTERN.test(gen)) throw new Error(`minted generation ${gen} does not match GEN_PATTERN`);
  return gen;
}

/** Where a finished record goes: the ledger's `finish`, or the plain store. */
export interface RecordSink {
  put(record: RunRecord): Promise<unknown>;
}

export interface LedgerWriteThroughOptions {
  ledger: RunLedger;
  gen: string;
  /** The plain run store, for a finish record the ledger cannot take (an older
   *  state Worker without the routes, a run the ledger never tracked, a fence). */
  fallback: RecordSink;
  warn: (message: string) => void;
  leaseMs?: number;
  heartbeatMs?: number;
  flushMs?: number;
  flushEvents?: number;
  /** Attempts for the whole claim (the ledger's convention: retry the claim,
   *  never proceed past one that did not resolve `ok`). Default 3. */
  claimAttempts?: number;
  /** Injectable timers (tests). */
  sleep?: (ms: number) => Promise<void>;
  setInterval?: (fn: () => void, ms: number) => { unref?(): void };
  clearInterval?: (timer: { unref?(): void }) => void;
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

export interface OpenRunRequest {
  runId: string;
  threadKey: string;
  startedAt: number;
  meta: LiveRunMeta;
  card?: CardHandle | null;
  /** The composed system prompt, verbatim, and the tool definitions the run
   *  starts with — what a resume hands the model again. */
  system: string;
  tools: ToolDef[];
  state?: RunState;
  /** The conversation the run's model loop starts from (its `messages`);
   *  absent for a run without one loop of its own (a ship pipeline), which is
   *  tracked for the live index and the finish but closes `interrupted` at a
   *  reclaim. */
  seed?: {
    messages: ChatMessage[];
    /** The run's whole wall-clock budget (`agent.maxMinutes`), recorded as the
     *  seed record's `remainingMs` — paired with the messages so a seed can
     *  never be written without it. */
    budgetMs: number;
    /** A seed read from the session's own log (session-log item 9): the first
     *  `turns` messages are the log's rows from `from`, one row each, and are
     *  not written again — the row's `seedFrom` is `from` and its range begins
     *  at the log's tail. Named rows that do not end at the tail (the log moved
     *  under the seed) are written whole as new rows, with one warning. */
    log?: { from: number; turns: number };
  };
  /** A stop another generation requested (`/runs/stop` on a different
   *  container), relayed by the heartbeat — once per mode. */
  onStop?: (mode: StopMode) => void;
  /** Another generation owns this run now (a write was `fenced`, plan D9): the
   *  caller must stop the run at once — it must not reply, and its next tool
   *  call would act on a run someone else is driving. Once per run. */
  onFenced?: () => void;
  /** The run's reservation from admission (item 42), when it has one: the open
   *  promotes that row in place — same tracked run, same heartbeat — instead
   *  of claiming a new one. */
  reservation?: LedgerRun;
}

/** The row a run leaves at admission, before its prompt exists (item 42): the
 *  identity, the request it was admitted for, the card — so a kill during the
 *  workspace attach leaves something to restart from. */
export interface ReserveRunRequest {
  runId: string;
  threadKey: string;
  startedAt: number;
  /** With `request` set: the message in the durable inbox row's shape. */
  meta: LiveRunMeta;
  card?: CardHandle | null;
  onStop?: (mode: StopMode) => void;
  onFenced?: () => void;
}

/** `finishing()`'s answer: `ok` — reply; `fenced` — another generation owns
 *  the run, do NOT reply (it will); `unavailable` — the ledger could not be
 *  asked or this run is untracked, reply as before (the run is this process's). */
export type FinishingGate = "ok" | "fenced" | "unavailable";

/** One tracked run. Every method is safe to call after a detach (a no-op). */
export interface LedgerRun {
  readonly runId: string;
  /** False once a write was refused or failed for good: the ledger no longer
   *  mirrors this run (it is not resumable); the finish still lands. */
  tracked(): boolean;
  /** The runner's step hook: the step's turns, then its record — awaited. */
  step(report: StepReport): Promise<void>;
  /** A registry event, in publish order, with the registry's `seq`. */
  event(event: RunEvent, seq: number): void;
  /** Merge into the run's state and send it (coalesced: the newest wins). */
  setState(patch: RunState): void;
  /** `live → finishing`, before the reply — the double-answer gate (D9). */
  finishing(): Promise<FinishingGate>;
  /** A reserved run that never started (item 42): the row goes with no record,
   *  so nothing restarts it. A no-op for a detached run (fenced: another
   *  generation owns the row) and for an untracked one. */
  abandon(): Promise<void>;
  /** True when a resume could continue this run: its seed and seed record
   *  landed (or it was adopted from a resume). A ship pipeline, a detached run
   *  and a run whose seed failed are not. */
  readonly resumable: boolean;
  /** True once this generation handed the run to the next (SIGTERM). */
  readonly handedOff: boolean;
  /** The run's place in its session log (session-log item 2), once the claim
   *  set it — what the session tools read and write by (item 10); undefined
   *  for a run without a session or before its claim. */
  readonly session: RunSession | undefined;
  /** The log row a local index of the run's conversation lands on — `seedFrom`
   *  plus the index, the arithmetic every seed and step write uses — so what a
   *  `tool_call`'s and a `tool_result`'s `logIndex` is stamped with (run-history
   *  item 53) and the row the step wrote cannot disagree. Undefined for a run
   *  without a session: its rows are its own and no search reaches them. */
  logIndexOf(localIndex: number): number | undefined;
  /** The finish record's sink: the ledger's one-transaction `finish`, else the
   *  plain store — never both, never neither. Throws only a transient failure
   *  (the writer retries it; a repeated `finish` is idempotent). */
  readonly sink: RecordSink;
  /** Stop the heartbeat and flush the events. Idempotent; `sink.put` does it too. */
  close(): Promise<void>;
}

/** A run this generation reclaimed at boot (docs/reference/specs/run-history.md item 37):
 *  its row is already ours — no claim, no seed — and its writes continue from
 *  where the previous generation stopped. */
export interface AdoptRunRequest {
  runId: string;
  threadKey: string;
  /** The row's state, so patches merge into what the previous generation recorded. */
  state: RunState;
  /** The last step record's number; the next step write is `lastStep + 1`. */
  lastStep: number;
  /** The highest event `seq` on the ledger; the next append continues past it. */
  lastSeq: number;
  /** The row's place in its session log (session-log item 2): the adopted run
   *  appends at its indices and its record closes the range. Absent for a row
   *  claimed before the log existed, which keeps writing its own object. */
  session?: RunSession;
  onStop?: (mode: StopMode) => void;
  onFenced?: () => void;
}

export interface LedgerWriteThrough {
  readonly gen: string;
  /** Reserve the thread at admission (item 42): an `attaching` row with the
   *  request and no prompt, its heartbeat running. `undefined` when the run is
   *  not tracked (as `open`). The run is not resumable until `open` promotes
   *  it; a reclaim of the row restarts the run from its request. */
  reserve(req: ReserveRunRequest): Promise<LedgerRun | undefined>;
  /** Claim and seed. `undefined` when the run is not tracked: the thread has a
   *  live row already (another generation's — reclaim is the resume phase's),
   *  the routes are missing, or the claim kept failing — or, with a
   *  reservation, the row was taken by another generation (the reservation is
   *  told through `onFenced`; this process must not run it). */
  open(req: OpenRunRequest): Promise<LedgerRun | undefined>;
  /** Take up a reclaimed run: heartbeat, steps, events and state continue
   *  under this generation with no claim and no seed. Synchronous — the row is
   *  ours since the boot reclaim, and the heartbeat must start at once. */
  adopt(req: AdoptRunRequest): LedgerRun;
  /** The runs this generation is driving right now (opened or adopted, not yet finished). */
  liveRuns(): LedgerRun[];
  /** A durable copy of a steered follow-up (run-history item 40), under the
   *  run's row whichever generation holds it: the ledger's inbox seq, or
   *  undefined (with a warning) when the ledger refuses — the row is gone — or
   *  cannot be reached. Never fenced: a steer arrives on whichever container is
   *  up. */
  pushInbox(runId: string, message: Record<string, unknown>): Promise<number | undefined>;
  /** The run's durable inbox past `afterSeq` (run-history item 40) — the
   *  resume's re-read at adopt time. Empty, with a warning, when the ledger
   *  cannot be asked (a state Worker without the route included). */
  readInbox(runId: string, afterSeq: number): Promise<InboxItem[]>;
  /** A session log's newest whole turns within `maxBytes` (session-log item 4),
   *  oldest first, with the log index they start at — what a follow-up's seed
   *  is cut from (item 9). A log with no rows answers `from` 0 and no turns.
   *  Throws as the ledger does; the caller decides what a failed read means. */
  readSessionTail(key: string, maxBytes: number): Promise<{ from: number; transcript: AssembledTranscript }>;
  /** The rows `[from, to]` of a session log as a conversation counted from `from` (item 3) — one turn when `to` is `from`. */
  readSession(key: string, from: number, to?: number): Promise<AssembledTranscript>;
  /** The full-text search `recall` makes (item 10): hits in relevance order, and the gap markers between them. */
  searchSession(key: string, query: string, limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }>;
  /** The session's notepad, or null when nothing wrote it (item 10). */
  readNotepad(key: string): Promise<Notepad | null>;
  /** Replace the notepad whole under this generation's fence (item 10). */
  writeNotepad(key: string, text: string): Promise<FenceResult>;
  /** SIGTERM (plan D8): mark every resumable live run `handoff` on the ledger so
   *  the next generation takes it at once, whatever its lease. The runs keep
   *  running here until the process exits; their writes are fenced the moment
   *  the next generation reclaims them. Returns the run ids marked. */
  handoff(): Promise<{ marked: string[]; failed?: string }>;
}

/** The write-through of a process without a run ledger (a Null Object,
 *  routing-and-config item 16): nothing is claimed, so `open` answers as the
 *  real one does for an untracked run and every run goes on exactly as it did
 *  before the ledger existed; the inbox and the handoff hold nothing. `adopt`
 *  has nothing to adopt — a reclaim needs a ledger — and answers a detached run
 *  whose finish sink is the plain store, so a record can never vanish. */
export class NullLedgerWriteThrough implements LedgerWriteThrough {
  constructor(
    readonly gen: string,
    private readonly fallback: RecordSink,
  ) {}
  async reserve(_req: ReserveRunRequest): Promise<LedgerRun | undefined> {
    return undefined;
  }
  async open(_req: OpenRunRequest): Promise<LedgerRun | undefined> {
    return undefined;
  }
  adopt(req: AdoptRunRequest): LedgerRun {
    return new NullLedgerRun(req.runId, this.fallback);
  }
  liveRuns(): LedgerRun[] {
    return [];
  }
  async pushInbox(_runId: string, _message: Record<string, unknown>): Promise<number | undefined> {
    return undefined;
  }
  async readInbox(_runId: string, _afterSeq: number): Promise<InboxItem[]> {
    return [];
  }
  async readSessionTail(_key: string, _maxBytes: number): Promise<{ from: number; transcript: AssembledTranscript }> {
    return { from: 0, transcript: { complete: true, turns: 0, messages: [], compactions: [] } };
  }
  async readSession(_key: string, _from: number, _to?: number): Promise<AssembledTranscript> {
    return { complete: true, turns: 0, messages: [], compactions: [] };
  }
  async searchSession(_key: string, _query: string, _limit: number): Promise<{ hits: SessionHit[]; gaps: number[] }> {
    return { hits: [], gaps: [] };
  }
  async readNotepad(_key: string): Promise<Notepad | null> {
    return null;
  }
  async writeNotepad(_key: string, _text: string): Promise<FenceResult> {
    return { ok: false, reason: "unknown-run" };
  }
  async handoff(): Promise<{ marked: string[]; failed?: string }> {
    return { marked: [] };
  }
}

/** A run the null write-through was asked to adopt: untracked, not resumable,
 *  every mirror a no-op, its finish landing on the plain store. */
export class NullLedgerRun implements LedgerRun {
  readonly resumable = false;
  readonly handedOff = false;
  readonly session = undefined;
  constructor(
    readonly runId: string,
    readonly sink: RecordSink,
  ) {}
  tracked(): boolean {
    return false;
  }
  logIndexOf(_localIndex: number): number | undefined {
    return undefined; // no session log holds this run's rows
  }
  async step(_report: StepReport): Promise<void> {
    // no ledger to mirror onto
  }
  event(_event: RunEvent, _seq: number): void {
    // no ledger to mirror onto
  }
  setState(_patch: RunState): void {
    // no ledger to mirror onto
  }
  async finishing(): Promise<FinishingGate> {
    return "unavailable";
  }
  async abandon(): Promise<void> {}
  async close(): Promise<void> {
    // nothing was open
  }
}

/** Backoff before a retry: the claim gets both, a step or state write the first. */
const RETRY_MS: readonly number[] = [200, 800];

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createLedgerWriteThrough(opts: LedgerWriteThroughOptions): LedgerWriteThrough {
  const { ledger, gen, fallback, warn } = opts;
  const leaseMs = opts.leaseMs ?? LEASE_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startInterval =
    opts.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
  const stopInterval = opts.clearInterval ?? ((t) => clearInterval(t as NodeJS.Timeout));
  const claimAttempts = opts.claimAttempts ?? RETRY_MS.length + 1;
  let routeMissingWarned = false;
  const live = new Set<TrackedRun>();

  const routeMissing = (): void => {
    if (routeMissingWarned) return;
    routeMissingWarned = true;
    warn(
      "[ledger] state Worker has no run-ledger routes — deploy it before this bot version; runs are not tracked until then",
    );
  };

  type Claimed = { outcome: "ok"; session?: RunSession } | { outcome: "untracked" | "fenced" };

  /** `fenced`: the thread's row is THIS run under another generation — the
   *  reservation's lease lapsed and a reclaim took it (item 42); this process
   *  must not drive it. With a `seed`, the run is a range of its thread-and-
   *  agent session log (session-log item 2): the log's tail is read first,
   *  the row's meta names the range the seed will occupy, and the log's owner
   *  is taken AFTER the history claim — so a refused claim never steals a live
   *  run's log. The three requests are one claim: any failure retries them all. */
  async function claim(
    req: Omit<OpenRunRequest, "seed" | "reservation">,
    opts: { phase?: "attaching"; seed?: readonly ChatMessage[]; log?: { from: number; turns: number } } = {},
  ): Promise<Claimed> {
    for (let attempt = 1; ; attempt++) {
      try {
        let session: RunSession | undefined;
        if (opts.seed) {
          const key = sessionKey(req.threadKey, req.meta.agent);
          const next = await ledger.sessionTail(key);
          // A seed read from the log (session-log item 9) begins at its cut when
          // the rows it names end exactly at the tail; otherwise the log moved
          // under it and the whole seed is written as new rows from the tail.
          let seedFrom = next;
          if (opts.log) {
            if (opts.log.from + opts.log.turns === next) seedFrom = opts.log.from;
            else
              warn(
                `[ledger] ${req.threadKey} run ${req.runId}: the seed names log rows ${opts.log.from}..${opts.log.from + opts.log.turns - 1} but the log's tail is ${next} — the whole seed is written as new rows`,
              );
          }
          session = { key, seedFrom, request: seedFrom + requestIndex(opts.seed), range: { from: next } };
        }
        const result = await ledger.claim({
          runId: req.runId,
          threadKey: req.threadKey,
          gen,
          leaseMs,
          startedAt: req.startedAt,
          meta: session ? { ...req.meta, session } : req.meta,
          card: req.card ?? null,
          system: req.system,
          tools: req.tools,
          ...(req.state !== undefined ? { state: req.state } : {}),
          ...(opts.phase ? { phase: opts.phase } : {}),
        });
        if (result.ok) {
          if (session) await ledger.claimSession(session.key, req.runId, gen);
          return session ? { outcome: "ok", session } : { outcome: "ok" };
        }
        if (result.live.runId === req.runId) return { outcome: "fenced" };
        warn(
          `[ledger] ${req.threadKey} not tracked: the thread's live row belongs to run ${result.live.runId} (started ${new Date(result.live.startedAt).toISOString()}) — reclaim is the resume phase's`,
        );
        return { outcome: "untracked" };
      } catch (err) {
        if (err instanceof RouteMissingError) {
          routeMissing();
          return { outcome: "untracked" };
        }
        if (err instanceof PermanentStoreError || attempt >= claimAttempts) {
          warn(`[ledger] ${req.threadKey} not tracked: claim failed after ${attempt} attempt(s): ${describe(err)}`);
          return { outcome: "untracked" };
        }
        await sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length) - 1]);
      }
    }
  }

  /** The per-run state machine behind `LedgerRun`. */
  class TrackedRun implements LedgerRun {
    readonly runId: string;
    private readonly threadKey: string;
    private readonly onStop?: (mode: StopMode) => void;
    private readonly onFenced?: () => void;
    private fencedTold = false;
    /** Detached BY A FENCE (another generation took the row), as opposed to a
     *  write that failed for good while the run stayed ours. */
    private fencedOut = false;
    private detached = false;
    private finished = false;
    private seeded = false;
    private adopted = false;
    handedOff = false;
    /** The run's place in its session log (session-log item 2); undefined for
     *  a run without a conversation of its own and for an adopted row claimed
     *  before the log existed. */
    private sessionRow: RunSession | undefined;
    get session(): RunSession | undefined {
      return this.sessionRow;
    }
    /** Every row at its log index (session-log item 2): the run's local index
     *  plus where its seed began; a run without a session writes its own
     *  object from 0. The one arithmetic the seed, every step and `logIndexOf`
     *  share. */
    private rowIndex(localIndex: number): number {
      return (this.sessionRow?.seedFrom ?? 0) + localIndex;
    }
    logIndexOf(localIndex: number): number | undefined {
      return this.sessionRow ? this.rowIndex(localIndex) : undefined;
    }
    /** Turns of the run's conversation on the ledger, counted from its seed —
     *  the last step record's `turnIndex` — so the finish can close the range. */
    private turnsWritten: number | undefined;
    /** A detach left the log short of what the model saw: the record says `broken`. */
    private broken = false;
    private stepNo: number;
    private lastSeq: number;
    private state: RunState;
    private stateSending: Promise<void> = Promise.resolve();
    private stateDirty = false;
    private stopRelayed: StopMode | undefined;
    private heartbeat: { unref?(): void } | undefined;
    private readonly flusher = createAppendFlusher<AppendableEvent>({
      flushMs: opts.flushMs ?? APPEND_FLUSH_MS,
      maxEvents: opts.flushEvents ?? APPEND_FLUSH_EVENTS,
      send: async (batch) => {
        if (this.detached) return;
        const result = await ledger.append(this.runId, gen, batch);
        if (!result.ok && !this.finished) this.detach(`append refused (${result.reason})`);
      },
      onError: (err, batch) => {
        if (!this.finished) warn(`[ledger] ${this.threadKey} ${batch.length} event(s) not appended: ${err.message}`);
      },
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
    });

    constructor(
      req: Pick<OpenRunRequest, "runId" | "threadKey" | "state" | "onStop" | "onFenced">,
      from: { stepNo: number; lastSeq: number; resumable?: boolean; session?: RunSession } = {
        stepNo: 0,
        lastSeq: 0,
      },
    ) {
      this.runId = req.runId;
      this.threadKey = req.threadKey;
      this.state = req.state ?? {};
      this.onStop = req.onStop;
      this.onFenced = req.onFenced;
      this.stepNo = from.stepNo;
      this.lastSeq = from.lastSeq;
      this.adopted = from.resumable === true;
      this.sessionRow = from.session;
    }

    /** A reservation learns its session when the prompt's claim promotes it. */
    bindSession(session: RunSession): void {
      this.sessionRow = session;
    }

    /** The state the promoting claim already wrote to the row, folded into this
     *  run's own so later patches merge into it rather than replace it. */
    adoptState(state: RunState): void {
      this.state = { ...this.state, ...state };
    }

    get resumable(): boolean {
      return !this.detached && (this.seeded || this.adopted);
    }

    markHandedOff(): void {
      this.handedOff = true;
    }

    /** The run's range as the finished record carries it (session-log item 2):
     *  closed at the last turn written, or `broken` after a detach — the log
     *  ends short of what the model saw, and the next run in the session must
     *  know. A run that wrote no turn leaves the range open. */
    private sessionOnRecord(): RunSession | undefined {
      if (!this.sessionRow) return undefined;
      if (this.broken) return { ...this.sessionRow, range: "broken" };
      const from = this.sessionRow.range === "broken" ? this.sessionRow.seedFrom : this.sessionRow.range.from;
      const to =
        this.turnsWritten !== undefined && this.turnsWritten > 0
          ? this.sessionRow.seedFrom + this.turnsWritten - 1
          : undefined;
      return { ...this.sessionRow, range: to !== undefined && to >= from ? { from, to } : { from } };
    }

    readonly sink: RecordSink = {
      put: async (plain) => {
        this.finished = true; // no event or state write after this point
        live.delete(this);
        await this.close();
        const session = this.sessionOnRecord();
        const record = session ? { ...plain, session } : plain;
        let result: Awaited<ReturnType<RunLedger["finish"]>>;
        try {
          result = await ledger.finish(this.runId, gen, record);
        } catch (err) {
          if (!(err instanceof RouteMissingError)) throw err; // transient: the writer retries this sink
          routeMissing();
          return fallback.put(record);
        }
        if (result.ok) return result;
        warn(`[ledger] ${this.threadKey} finish refused (${result.reason}) — record written to the store directly`);
        return fallback.put(record);
      },
    };

    tracked(): boolean {
      return !this.detached;
    }

    /** One warning, then silence: the run continues untracked. */
    detach(reason: string): void {
      if (this.detached) return;
      this.detached = true;
      this.broken = true; // the log ends short of what the model saw from here on
      warn(`[ledger] ${this.threadKey} run ${this.runId} detached: ${reason} — this run is not resumable`);
      this.stopHeartbeat();
      live.delete(this);
      // A fence means another generation owns the run now (it reclaimed the
      // row): this process must stop driving it, and must not reply (D9) —
      // `finishing()` answers `fenced` from here on, not `unavailable`.
      if (reason.includes("(fenced)")) {
        this.fencedOut = true;
        if (this.onFenced && !this.fencedTold) {
          this.fencedTold = true;
          this.onFenced();
        }
      }
    }

    /** The seed, then the seed record: step 0 with no calls in flight and
     *  `turnIndex` = the seed's length, so a reclaim always has a step record
     *  to judge the transcript against (`transcriptCompleteness`) — a row with
     *  no record at all was killed before its conversation was stored and
     *  closes `interrupted`. */
    async seed(messages: ChatMessage[], budgetMs: number): Promise<void> {
      // Every row at its log index (`rowIndex`). The messages the seed reused
      // from the log (item 9) — the rows between `seedFrom` and the range's
      // start — are there already and are skipped.
      const reused =
        this.sessionRow && this.sessionRow.range !== "broken"
          ? this.sessionRow.range.from - this.sessionRow.seedFrom
          : 0;
      const turns: TranscriptTurn[] = messages
        .slice(reused)
        .map((message, i) => ({ idx: this.rowIndex(reused + i), message }));
      try {
        const seeded = await ledger.seed(this.runId, gen, turns, this.sessionRow?.key);
        if (!seeded.ok) {
          this.detach(`seed refused (${seeded.reason})`);
          return;
        }
        this.turnsWritten = messages.length;
        // The record's write names the log too: a run with a session owns no
        // object of its own, so a write that names none is refused.
        const recorded = await ledger.step(
          this.runId,
          gen,
          {
            step: 0,
            seq: this.lastSeq,
            turnIndex: messages.length,
            inFlight: [],
            inboxConsumedSeq: 0,
            remainingMs: budgetMs,
            turn: 0,
            iteration: 0,
          },
          [],
          this.sessionRow?.key,
        );
        if (!recorded.ok) this.detach(`seed record refused (${recorded.reason})`);
        else this.seeded = true;
      } catch (err) {
        this.detach(`seed failed: ${describe(err)}`);
      }
    }

    async step(report: StepReport): Promise<void> {
      if (this.detached) return;
      // Every row at its log index (`rowIndex`). A compaction entry rides as
      // the row after the step's turns and counts as a turn, so the
      // completeness rule sees one index per row.
      const turns: TranscriptTurn[] = report.turns.map((message, i) => ({
        idx: this.rowIndex(report.firstIdx + i),
        message,
      }));
      if (report.compaction)
        turns.push({ idx: this.rowIndex(report.firstIdx + report.turns.length), compaction: report.compaction });
      const record: StepRecord = {
        step: ++this.stepNo,
        seq: this.lastSeq,
        turnIndex: report.firstIdx + turns.length,
        inFlight: report.inFlight,
        inboxConsumedSeq: report.inboxConsumedSeq,
        remainingMs: report.remainingMs,
        turn: report.turn,
        iteration: report.iteration,
      };
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await ledger.step(this.runId, gen, record, turns, this.sessionRow?.key);
          if (!result.ok) this.detach(`step ${record.step} refused (${result.reason})`);
          else this.turnsWritten = record.turnIndex;
          return;
        } catch (err) {
          if (err instanceof RouteMissingError || err instanceof PermanentStoreError || attempt >= 2) {
            this.detach(`step ${record.step} failed: ${describe(err)}`);
            return;
          }
          await sleep(RETRY_MS[0]); // a blip a microsecond later is still a blip
        }
      }
    }

    event(event: RunEvent, seq: number): void {
      if (this.detached || this.finished) return;
      this.lastSeq = seq;
      this.flusher.push({ ...event, seq });
    }

    setState(patch: RunState): void {
      if (this.detached) return;
      this.state = { ...this.state, ...patch };
      this.stateDirty = true;
      this.stateSending = this.stateSending.then(() => this.sendState());
    }

    /** The merged snapshot, sent once per burst of patches; a transient failure
     *  is retried once after a backoff and, failing that, leaves the state
     *  dirty so the next patch carries it — the LAST state of a run (a verdict
     *  set near the end) must not be lost to one blip. */
    private async sendState(): Promise<void> {
      if (!this.stateDirty || this.detached || this.finished) return;
      this.stateDirty = false;
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await ledger.setState(this.runId, gen, this.state);
          if (!result.ok) this.detach(`state refused (${result.reason})`);
          return;
        } catch (err) {
          if (err instanceof RouteMissingError || err instanceof PermanentStoreError || attempt >= 2) {
            this.stateDirty = true;
            warn(`[ledger] ${this.threadKey} state not written: ${describe(err)}`);
            return;
          }
          await sleep(RETRY_MS[0]);
        }
      }
    }

    async finishing(): Promise<FinishingGate> {
      // Detached by a fence: the run is another generation's now — no reply, no
      // record from here (item 39), whatever the fenced write was. Detached for
      // any other reason: the run is still ours and replies as before.
      if (this.detached) return this.fencedOut ? "fenced" : "unavailable";
      try {
        const result = await ledger.finishing(this.runId, gen);
        if (result.ok) return "ok";
        // Refused: another generation took the row (`fenced`), or the row is
        // gone (`unknown-run` — the other generation already finished it).
        // Either way this process must not answer the thread.
        warn(
          `[ledger] ${this.threadKey} finishing refused (${result.reason}) — another generation owns this run; no reply from here`,
        );
        this.detach(`finishing refused (fenced)`);
        return "fenced";
      } catch (err) {
        warn(`[ledger] ${this.threadKey} finishing failed: ${describe(err)}`);
        return "unavailable";
      }
    }

    async abandon(): Promise<void> {
      if (this.detached || this.finished) return;
      this.finished = true; // nothing is written after this
      live.delete(this);
      await this.close();
      try {
        const result = await ledger.abandon(this.runId, gen);
        // `unknown-run` is silence: the row is already gone (a stale
        // reservation never had one of its own); `fenced` names a row another
        // generation drives now.
        if (!result.ok && result.reason === "fenced")
          warn(`[ledger] ${this.threadKey} abandon refused (fenced) — the row is another generation's`);
      } catch (err) {
        warn(
          `[ledger] ${this.threadKey} abandon failed: ${describe(err)} — the sweep will take the row once its lease lapses`,
        );
      }
    }

    startHeartbeat(): void {
      if (this.detached || this.heartbeat) return;
      this.heartbeat = startInterval(() => void this.beat(), heartbeatMs);
    }

    private async beat(): Promise<void> {
      if (this.detached || this.finished) return;
      try {
        const result = await ledger.heartbeat(this.runId, gen, leaseMs);
        if (!result.ok) {
          this.detach(`heartbeat refused (${result.reason})`);
          return;
        }
        if (result.stop && this.stopRelayed !== result.stop && this.onStop) {
          this.stopRelayed = result.stop;
          this.onStop(result.stop);
        }
      } catch (err) {
        warn(`[ledger] ${this.threadKey} heartbeat failed: ${describe(err)}`);
      }
    }

    private stopHeartbeat(): void {
      if (!this.heartbeat) return;
      stopInterval(this.heartbeat);
      this.heartbeat = undefined;
    }

    async close(): Promise<void> {
      this.stopHeartbeat();
      await this.stateSending;
      await this.flusher.close();
    }
  }

  return {
    gen,
    async reserve(req) {
      const claimed = await claim({ ...req, system: "", tools: [], state: {} }, { phase: "attaching" });
      if (claimed.outcome !== "ok") return undefined;
      const run = new TrackedRun(req);
      run.startHeartbeat();
      live.add(run);
      return run;
    },
    async open(req) {
      const reserved = req.reservation;
      const seed = req.seed?.messages;
      if (reserved instanceof TrackedRun) {
        // The promotion (item 42): the claim the dispatcher always made, now
        // landing on the row reserved at admission — same tracked run, its
        // heartbeat already running. A row another generation took meanwhile
        // fences this run (it is theirs to restart); an untracked answer means
        // the thread's row is someone else's (a stale reservation) — the run
        // goes on untracked, as an open without a reservation would.
        if (!reserved.tracked()) return undefined;
        const claimed = await claim(req, seed ? { seed, ...(req.seed?.log ? { log: req.seed.log } : {}) } : {});
        if (claimed.outcome === "fenced") {
          reserved.detach("promotion refused (fenced)");
          return undefined;
        }
        if (claimed.outcome !== "ok") {
          await reserved.close();
          live.delete(reserved);
          return undefined;
        }
        if (claimed.session) reserved.bindSession(claimed.session);
        // The claim wrote the dispatcher's state onto the row (the workspace
        // binding, item 54); the reserved run merges it into its own, so the
        // first patch after the claim carries it on instead of writing over it.
        if (req.state) reserved.adoptState(req.state);
        if (req.seed) await reserved.seed(req.seed.messages, req.seed.budgetMs);
        return reserved;
      }
      const claimed = await claim(req, seed ? { seed, ...(req.seed?.log ? { log: req.seed.log } : {}) } : {});
      if (claimed.outcome === "fenced") {
        warn(`[ledger] ${req.threadKey} not tracked: run ${req.runId} is live under another generation`);
        return undefined;
      }
      if (claimed.outcome !== "ok") return undefined;
      const run = new TrackedRun(req, {
        stepNo: 0,
        lastSeq: 0,
        ...(claimed.session ? { session: claimed.session } : {}),
      });
      if (req.seed) await run.seed(req.seed.messages, req.seed.budgetMs);
      run.startHeartbeat();
      live.add(run);
      return run;
    },
    adopt(req) {
      const run = new TrackedRun(req, {
        stepNo: req.lastStep,
        lastSeq: req.lastSeq,
        resumable: true,
        ...(req.session ? { session: req.session } : {}),
      });
      run.startHeartbeat();
      live.add(run);
      return run;
    },
    liveRuns: () => [...live],
    async pushInbox(runId, message) {
      try {
        const result = await ledger.pushInbox(runId, message);
        if (result.ok && result.seq !== undefined) return result.seq;
        warn(`[ledger] inbox push refused for run ${runId}: no live row — the follow-up rides in memory only`);
        return undefined;
      } catch (err) {
        warn(`[ledger] inbox push failed for run ${runId}: ${describe(err)} — the follow-up rides in memory only`);
        return undefined;
      }
    },

    async readInbox(runId, afterSeq) {
      try {
        return await ledger.readInbox(runId, afterSeq);
      } catch (err) {
        warn(
          err instanceof RouteMissingError
            ? `[ledger] state Worker has no inbox read route — run ${runId} resumes with the reclaim's inbox snapshot only`
            : `[ledger] inbox read failed for run ${runId}: ${describe(err)} — resuming with the reclaim's snapshot only`,
        );
        return [];
      }
    },
    readSessionTail: (key, maxBytes) => ledger.readSessionTail(key, maxBytes),
    readSession: (key, from, to) => ledger.readSession(key, from, to),
    searchSession: (key, query, limit) => ledger.searchSession(key, query, limit),
    readNotepad: (key) => ledger.readNotepad(key),
    writeNotepad: (key, text) => ledger.writeNotepad(key, gen, text),

    async handoff() {
      const candidates = [...live].filter((r) => r.resumable && r.tracked() && !r.handedOff);
      if (candidates.length === 0) return { marked: [] };
      try {
        const { marked } = await ledger.handoff(
          gen,
          candidates.map((r) => r.runId),
        );
        const markedSet = new Set(marked);
        for (const r of candidates) if (markedSet.has(r.runId)) r.markHandedOff();
        return { marked };
      } catch (err) {
        return { marked: [], failed: describe(err) };
      }
    },
  };
}
