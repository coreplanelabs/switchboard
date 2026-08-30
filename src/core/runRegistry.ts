import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RunEvent, StopMode } from "./runEvents.js";

// The run registry is the unit-testable core of the external live-view page
// (Area 2 / #43). It is deliberately **in-memory and live-only**: a run's
// events live here only while the run is active, plus a bounded backlog so a
// viewer who opens the capability link mid-run sees what already happened, and
// finished runs are evicted after a short TTL. Persisting/replaying past runs
// is out of scope (Area 7). Per AGENTS.md invariant 6 this ephemeral state is
// intentional — nothing durable is lost on restart: a restart ends the runs it
// was streaming, and their (already-visible) events simply stop.
//
// Access is a capability model: create() mints a random run id AND a random
// view token; every read (subscribe/has) requires the correct token for that
// id, compared in constant time. The token is the gate — an unguessable,
// per-run secret carried in the live URL.

/**
 * Per-run stop control (#101). One per run, minted by `RunRegistry.create()` and
 * handed to the runner; `requestStop` is driven through the registry's
 * token-gated `requestStop(id, token, mode)`. Two modes, one direction:
 *   - `soft`: only records the request. The runner polls `requested` between
 *     steps, takes no new step, and wraps up through the guaranteed finale.
 *   - `hard`: records the request AND aborts `hardSignal`, which the runner
 *     threads into the in-flight provider call and tool execution so they are
 *     cancelled now, with no finale.
 * A soft request escalates to hard; a hard request never de-escalates; repeats
 * are idempotent. Everything here is synchronous and never throws.
 */
export class RunControl {
  private mode: StopMode | undefined;
  private readonly hard = new AbortController();

  /** The strongest stop requested so far, or undefined while none has been. */
  get requested(): StopMode | undefined {
    return this.mode;
  }

  /** Aborted iff a HARD stop has been requested. Pass to anything cancellable. */
  get hardSignal(): AbortSignal {
    return this.hard.signal;
  }

  /** Record a stop request; returns the effective mode after it (hard wins). */
  requestStop(mode: StopMode): StopMode {
    if (this.mode === "hard") return "hard";
    this.mode = mode;
    if (mode === "hard") this.hard.abort(new Error("run stopped (hard) by operator"));
    return this.mode;
  }
}

/** The identifiers a freshly created run is addressed by, plus its control. */
export interface RunHandle {
  /** Random, unguessable run id — the `:id` in `/runs/:id`. */
  id: string;
  /** Random, unguessable view token — the `?t=` capability for this run. */
  token: string;
  /** This run's stop control — the dispatcher hands it to the runner. */
  control: RunControl;
}

/** A run's stop status for the index: `stopping` from the request until the run
 *  finishes, then `stopped`. Absent when no stop was ever requested. */
export interface RunStopStatus {
  mode: StopMode;
  state: "stopping" | "stopped";
}

/** Outcome of `RunRegistry.requestStop`. `not-found` covers BOTH an unknown run
 *  and a wrong token (the caller maps it to 404 — existence is never revealed);
 *  `finished` is a run that already ended (409). */
export type StopRequestResult = { ok: true; mode: StopMode } | { ok: false; reason: "not-found" | "finished" };

/**
 * A live-only snapshot of one non-evicted run, for the Access-gated runs index
 * (`GET /runs`). It intentionally carries the per-run `token` so the index can
 * render each run's full capability link — the index is the ONE place tokens
 * surface, and it must only ever be exposed behind Cloudflare Access (see
 * features/live-view.md). `eventCount` is monotonic (total published, not the
 * bounded-backlog length) and `startedAt` is the injectable-clock time at
 * `create()`, so callers can sort/label without reaching into run internals.
 */
export interface RunSummary {
  id: string;
  token: string;
  /** Short human label set at create() (e.g. "coding · owner/repo"); optional. */
  label?: string;
  finished: boolean;
  startedAt: number;
  eventCount: number;
  /** Present only once a stop has been requested (#101). */
  stop?: RunStopStatus;
}

/** `seq` is the event's 1-based position in the run's stream (the registry's
 *  `eventCount` at publish) — the SSE `id:` a client resumes from. */
export type RunSubscriber = (event: RunEvent, seq: number) => void;
/** Called once when the run it is subscribed to finishes. */
export type RunFinishListener = () => void;
/** Tear-down returned by a successful subscribe(); safe to call more than once. */
export type Unsubscribe = () => void;

/**
 * A single change on the Access-gated runs index (`GET /runs`), delivered live to
 * `subscribeIndex` listeners. `upsert` carries the run's current summary — the
 * same shape `listActive()` returns — and covers create, per-event activity, and
 * finish (a finished run is an `upsert` with `finished: true`, not a removal).
 * `removed` fires exactly once, when a finished run is finally evicted by the TTL
 * sweep — the only removal signal (eviction stays lazy/timer-free).
 */
export type IndexEvent = { type: "upsert"; run: RunSummary } | { type: "removed"; id: string };

/** A live subscriber to the runs-index feed. */
export type IndexSubscriber = (event: IndexEvent) => void;

export interface RunRegistryOptions {
  /** Max events retained per run for late-subscriber replay. Default 1000. */
  backlogLimit?: number;
  /** How long a finished run stays subscribable before eviction. Default 60s. */
  ttlMs?: number;
  /** Injectable id generator (tests); default `crypto.randomUUID`. */
  genId?: () => string;
  /** Injectable token generator (tests); default 32 random bytes as hex. */
  genToken?: () => string;
  /** Injectable clock (tests); default `Date.now`. */
  now?: () => number;
}

interface Subscription {
  onEvent: RunSubscriber;
  onFinish?: RunFinishListener;
}

interface RunState {
  id: string;
  token: string;
  /** The newest `backlogLimit` events with their stream positions. */
  backlog: Array<{ seq: number; event: RunEvent }>;
  subscribers: Set<Subscription>;
  finished: boolean;
  /** Wall-clock finish time; drives TTL eviction. */
  finishedAt?: number;
  /** Short human label for the runs index; set at create(). */
  label?: string;
  /** Clock time at create() — the index sorts newest-first on this. */
  startedAt: number;
  /** Monotonic creation order; a stable tiebreak when two runs share a clock. */
  seq: number;
  /** Total events published (monotonic; unlike backlog, never trimmed). */
  eventCount: number;
  /** Stop control handed to the runner at create(); driven by requestStop(). */
  control: RunControl;
}

/** Equal-length constant-time string compare (mirrors channels/http.ts). Guards
 *  length first — differing lengths can't be timingSafeEqual'd and never match —
 *  and never logs the compared material. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class RunRegistry {
  private readonly runs = new Map<string, RunState>();
  /** Live subscribers to the runs-index feed (see subscribeIndex). Separate from
   *  per-run `subscribers`: these get every run's lifecycle, not one run's events. */
  private readonly indexSubscribers = new Set<IndexSubscriber>();
  private readonly backlogLimit: number;
  private readonly ttlMs: number;
  private readonly genId: () => string;
  private readonly genToken: () => string;
  private readonly now: () => number;
  /** Monotonic creation counter; stamps each run's `seq` for stable ordering. */
  private seq = 0;

  constructor(opts: RunRegistryOptions = {}) {
    this.backlogLimit = opts.backlogLimit ?? 1000;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.genId = opts.genId ?? (() => randomUUID());
    this.genToken = opts.genToken ?? (() => randomBytes(32).toString("hex"));
    this.now = opts.now ?? Date.now;
  }

  /** Register a new run; returns its capability handle (id + view token). An
   *  optional short human `label` (e.g. the agent + repo/thread) is stored for
   *  the runs index and is otherwise inert. */
  create(label?: string): RunHandle {
    this.sweep();
    const id = this.genId();
    const token = this.genToken();
    const run: RunState = {
      id,
      token,
      backlog: [],
      subscribers: new Set(),
      finished: false,
      label,
      startedAt: this.now(),
      seq: ++this.seq,
      eventCount: 0,
      control: new RunControl(),
    };
    this.runs.set(id, run);
    this.notifyIndex({ type: "upsert", run: this.summaryOf(run) });
    return { id, token, control: run.control };
  }

  /**
   * Ask a live run to stop (#101) — the control-plane entry behind
   * `POST /runs/:id/stop`. Same constant-time token gate as every read (wrong
   * token and unknown run are indistinguishable: `not-found`); a finished run is
   * refused (`finished`). On success the run's `RunControl` is driven (the runner
   * observes it), a typed `stop_requested` run_note is published to the run's
   * stream so viewers see the request, and the index is upserted so rows repaint
   * as `stopping`. Never throws.
   */
  requestStop(id: string, token: string, mode: StopMode): StopRequestResult {
    this.sweep();
    const run = this.validate(id, token);
    if (!run) return { ok: false, reason: "not-found" };
    if (run.finished) return { ok: false, reason: "finished" };
    const effective = run.control.requestStop(mode);
    this.publish(id, {
      type: "run_note",
      kind: "stop_requested",
      mode: effective,
      summary: effective === "hard" ? "hard stop requested — aborting now" : "soft stop requested — wrapping up",
      at: this.now(),
    });
    return { ok: true, mode: effective };
  }

  /** Append an event to a run's backlog and fan it out to live subscribers.
   *  A no-op for an unknown or already-finished run — never throws. */
  publish(id: string, event: RunEvent): void {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    const seq = ++run.eventCount;
    run.backlog.push({ seq, event });
    if (run.backlog.length > this.backlogLimit) run.backlog.shift();
    for (const sub of run.subscribers) sub.onEvent(event, seq);
    // Index rows show live activity (event count + running state). Agent tool
    // events are seconds apart, so one upsert per event is not chatty; the
    // summary is built cheaply from the run we already hold.
    this.notifyIndex({ type: "upsert", run: this.summaryOf(run) });
  }

  /** Mark a run finished: notify live subscribers, stop forwarding, and start
   *  the eviction TTL. Idempotent; a no-op for an unknown run. */
  finish(id: string): void {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    run.finished = true;
    run.finishedAt = this.now();
    const subs = [...run.subscribers];
    run.subscribers.clear();
    for (const sub of subs) sub.onFinish?.();
    // A finished run stays on the index (marked finished) until the TTL evicts
    // it — so finish is an upsert, not a removal. Eviction emits the removal.
    this.notifyIndex({ type: "upsert", run: this.summaryOf(run) });
  }

  /** True iff the run exists (not yet evicted) and the token matches — the same
   *  constant-time capability gate subscribe() applies, for the page route. */
  has(id: string, token: string): boolean {
    this.sweep();
    return this.validate(id, token) !== null;
  }

  /**
   * Subscribe to a run's events: validates the token in constant time, replays
   * the bounded backlog, then live-forwards new events. Returns an unsubscribe
   * fn, or `null` if the run is unknown or the token is wrong (the caller maps
   * both to a 404 — never reveal which). If the run is already finished (but not
   * yet evicted), the backlog is replayed and `onFinish` fires immediately.
   * `afterSeq` resumes a dropped stream: only events with a higher `seq` are
   * replayed (the SSE `Last-Event-ID`); 0 replays the whole retained backlog.
   */
  subscribe(
    id: string,
    token: string,
    onEvent: RunSubscriber,
    onFinish?: RunFinishListener,
    afterSeq = 0,
  ): Unsubscribe | null {
    this.sweep();
    const run = this.validate(id, token);
    if (!run) return null;

    for (const { seq, event } of run.backlog) if (seq > afterSeq) onEvent(event, seq);

    if (run.finished) {
      onFinish?.();
      return () => {};
    }

    const sub: Subscription = { onEvent, onFinish };
    run.subscribers.add(sub);
    return () => void run.subscribers.delete(sub);
  }

  /**
   * Subscribe to the Access-gated runs index as a live feed. On subscribe, the
   * current active set is replayed as `upsert` events in `listActive()` order
   * (newest-first) — mirroring the per-run backlog replay — so a viewer who opens
   * the index sees every current run before any live delta. Thereafter each
   * create/publish/finish is an `upsert` and each TTL eviction a `removed`.
   * Returns an idempotent unsubscribe. Runs of every channel flow through the
   * shared lifecycle, so this feed reflects all of them without a dispatcher hook.
   */
  subscribeIndex(onEvent: IndexSubscriber): Unsubscribe {
    for (const run of this.listActive()) onEvent({ type: "upsert", run });
    this.indexSubscribers.add(onEvent);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.indexSubscribers.delete(onEvent);
    };
  }

  /**
   * Token-gated, read-only snapshot of a run's retained backlog plus whether it
   * has finished — the input to the run-friction analyzer (#84) for a run that
   * is still in the registry (live, or finished within the TTL). A COPY of the
   * backlog, so callers can't reach the live array. Same constant-time gate as
   * subscribe(); `null` for an unknown run or wrong token (caller → 404).
   */
  snapshot(id: string, token: string): { events: RunEvent[]; finished: boolean } | null {
    this.sweep();
    const run = this.validate(id, token);
    if (!run) return null;
    return { events: run.backlog.map((entry) => entry.event), finished: run.finished };
  }

  /** Live + finished-but-unevicted run count (observability / tests). */
  size(): number {
    this.sweep();
    return this.runs.size;
  }

  /**
   * Snapshot of every non-evicted run (live plus recently-finished within the
   * TTL), newest-first, for the Access-gated runs index. Sweeps first so evicted
   * runs never appear. Each summary carries the per-run token so the index can
   * render full capability links — this method (and the index it feeds) is the
   * only place tokens surface outside a per-run link, which is why the index
   * must sit behind Cloudflare Access (see features/live-view.md). Ordering is
   * by `startedAt` descending, tie-broken by creation `seq` descending so runs
   * created within the same clock tick still come out newest-first.
   */
  listActive(): RunSummary[] {
    this.sweep();
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt || b.seq - a.seq)
      .map((run) => this.summaryOf(run));
  }

  /** Build the index summary for one run. The single source of the run→summary
   *  mapping, shared by `listActive()` and the `subscribeIndex` feed so the two
   *  can never drift. `label` is omitted (not set to `undefined`) when absent. */
  private summaryOf(run: RunState): RunSummary {
    return {
      id: run.id,
      token: run.token,
      ...(run.label !== undefined ? { label: run.label } : {}),
      finished: run.finished,
      startedAt: run.startedAt,
      eventCount: run.eventCount,
      ...(run.control.requested !== undefined
        ? { stop: { mode: run.control.requested, state: run.finished ? ("stopped" as const) : ("stopping" as const) } }
        : {}),
    };
  }

  /** Fan an index event out to index subscribers. Each callback is isolated: one
   *  that throws (e.g. a dead SSE sink) is swallowed so it can neither corrupt
   *  registry state nor throw into the create/publish/finish/sweep caller. */
  private notifyIndex(ev: IndexEvent): void {
    for (const onEvent of this.indexSubscribers) {
      try {
        onEvent(ev);
      } catch {
        // A misbehaving index subscriber must not break the lifecycle call that
        // triggered this notification, nor stop the other subscribers.
      }
    }
  }

  /** Constant-time token check against a live run. Unknown id → null (fast);
   *  the token is the capability, and run ids are themselves unguessable. */
  private validate(id: string, token: string): RunState | null {
    const run = this.runs.get(id);
    if (!run) return null;
    if (!safeEqual(token, run.token)) return null;
    return run;
  }

  /** Evict finished runs whose TTL has elapsed. Called on every entry point so
   *  no background timer is needed (which would keep the process alive / leak). */
  private sweep(): void {
    if (this.runs.size === 0) return;
    const cutoff = this.now() - this.ttlMs;
    for (const [id, run] of this.runs) {
      if (run.finished && run.finishedAt !== undefined && run.finishedAt <= cutoff) {
        this.runs.delete(id);
        // Eviction is the ONLY removal signal for the index feed (a finished-but-
        // -unevicted run stays listed). Fires once per run — the delete above
        // ensures a later sweep won't re-emit it.
        this.notifyIndex({ type: "removed", id });
      }
    }
  }
}

/** Process-wide singleton shared by the dispatcher (which publishes run events)
 *  and the served /runs endpoints (which subscribe). One instance so a run
 *  created during dispatch is the same run the live page streams. */
export const defaultRunRegistry = new RunRegistry();
