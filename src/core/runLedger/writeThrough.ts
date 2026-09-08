// The bot's write-through onto the run ledger (features/run-history.md item
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
import type { StepReport } from "../../runner.js";
import type { ChatMessage, ToolDef } from "../../providers/types.js";
import type { RunEvent } from "../runEvents.js";
import type { RunRecord } from "../runRecord.js";
import { PermanentStoreError, RouteMissingError } from "../runStoreWorker.js";
import { createAppendFlusher } from "./flusher.js";
import type { RunLedger } from "./ledger.js";
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
  };
  /** A stop another generation requested (`/runs/stop` on a different
   *  container), relayed by the heartbeat — once per mode. */
  onStop?: (mode: StopMode) => void;
}

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
  /** `live → finishing`, before the reply. False when refused or unreachable. */
  finishing(): Promise<boolean>;
  /** The finish record's sink: the ledger's one-transaction `finish`, else the
   *  plain store — never both, never neither. Throws only a transient failure
   *  (the writer retries it; a repeated `finish` is idempotent). */
  readonly sink: RecordSink;
  /** Stop the heartbeat and flush the events. Idempotent; `sink.put` does it too. */
  close(): Promise<void>;
}

/** A run this generation reclaimed at boot (features/run-history.md item 37):
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
  onStop?: (mode: StopMode) => void;
}

export interface LedgerWriteThrough {
  readonly gen: string;
  /** Claim and seed. `undefined` when the run is not tracked: the thread has a
   *  live row already (another generation's — reclaim is the resume phase's),
   *  the routes are missing, or the claim kept failing. */
  open(req: OpenRunRequest): Promise<LedgerRun | undefined>;
  /** Take up a reclaimed run: heartbeat, steps, events and state continue
   *  under this generation with no claim and no seed. Synchronous — the row is
   *  ours since the boot reclaim, and the heartbeat must start at once. */
  adopt(req: AdoptRunRequest): LedgerRun;
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

  const routeMissing = (): void => {
    if (routeMissingWarned) return;
    routeMissingWarned = true;
    warn(
      "[ledger] state Worker has no run-ledger routes — deploy it before this bot version; runs are not tracked until then",
    );
  };

  async function claim(req: OpenRunRequest): Promise<"ok" | "untracked"> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await ledger.claim({
          runId: req.runId,
          threadKey: req.threadKey,
          gen,
          leaseMs,
          startedAt: req.startedAt,
          meta: req.meta,
          card: req.card ?? null,
          system: req.system,
          tools: req.tools,
          ...(req.state !== undefined ? { state: req.state } : {}),
        });
        if (result.ok) return "ok";
        warn(
          `[ledger] ${req.threadKey} not tracked: the thread's live row belongs to run ${result.live.runId} (started ${new Date(result.live.startedAt).toISOString()}) — reclaim is the resume phase's`,
        );
        return "untracked";
      } catch (err) {
        if (err instanceof RouteMissingError) {
          routeMissing();
          return "untracked";
        }
        if (err instanceof PermanentStoreError || attempt >= claimAttempts) {
          warn(`[ledger] ${req.threadKey} not tracked: claim failed after ${attempt} attempt(s): ${describe(err)}`);
          return "untracked";
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
    private detached = false;
    private finished = false;
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
      req: Pick<OpenRunRequest, "runId" | "threadKey" | "state" | "onStop">,
      from: { stepNo: number; lastSeq: number } = { stepNo: 0, lastSeq: 0 },
    ) {
      this.runId = req.runId;
      this.threadKey = req.threadKey;
      this.state = req.state ?? {};
      this.onStop = req.onStop;
      this.stepNo = from.stepNo;
      this.lastSeq = from.lastSeq;
    }

    readonly sink: RecordSink = {
      put: async (record) => {
        this.finished = true; // no event or state write after this point
        await this.close();
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
    private detach(reason: string): void {
      if (this.detached) return;
      this.detached = true;
      warn(`[ledger] ${this.threadKey} run ${this.runId} detached: ${reason} — this run is not resumable`);
      this.stopHeartbeat();
    }

    /** The seed, then the seed record: step 0 with no calls in flight and
     *  `turnIndex` = the seed's length, so a reclaim always has a step record
     *  to judge the transcript against (`transcriptCompleteness`) — a row with
     *  no record at all was killed before its conversation was stored and
     *  closes `interrupted`. */
    async seed(messages: ChatMessage[], budgetMs: number): Promise<void> {
      const turns: TranscriptTurn[] = messages.map((message, idx) => ({ idx, message }));
      try {
        const seeded = await ledger.seed(this.runId, gen, turns);
        if (!seeded.ok) {
          this.detach(`seed refused (${seeded.reason})`);
          return;
        }
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
        );
        if (!recorded.ok) this.detach(`seed record refused (${recorded.reason})`);
      } catch (err) {
        this.detach(`seed failed: ${describe(err)}`);
      }
    }

    async step(report: StepReport): Promise<void> {
      if (this.detached) return;
      const turns: TranscriptTurn[] = report.turns.map((message, i) => ({ idx: report.firstIdx + i, message }));
      const record: StepRecord = {
        step: ++this.stepNo,
        seq: this.lastSeq,
        turnIndex: report.firstIdx + report.turns.length,
        inFlight: report.inFlight,
        inboxConsumedSeq: 0, // the durable inbox is the admission phase's
        remainingMs: report.remainingMs,
        turn: report.turn,
        iteration: report.iteration,
      };
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await ledger.step(this.runId, gen, record, turns);
          if (!result.ok) this.detach(`step ${record.step} refused (${result.reason})`);
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

    async finishing(): Promise<boolean> {
      if (this.detached) return false;
      try {
        const result = await ledger.finishing(this.runId, gen);
        if (!result.ok) warn(`[ledger] ${this.threadKey} finishing refused (${result.reason})`);
        return result.ok;
      } catch (err) {
        warn(`[ledger] ${this.threadKey} finishing failed: ${describe(err)}`);
        return false;
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
    async open(req) {
      if ((await claim(req)) !== "ok") return undefined;
      const run = new TrackedRun(req);
      if (req.seed) await run.seed(req.seed.messages, req.seed.budgetMs);
      run.startHeartbeat();
      return run;
    },
    adopt(req) {
      const run = new TrackedRun(req, { stepNo: req.lastStep, lastSeq: req.lastSeq });
      run.startHeartbeat();
      return run;
    },
  };
}
