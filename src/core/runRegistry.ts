import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { redactAndCap, sanitizeActor, type RunActor, type RunEvent, type StopMode, isSpanRecord } from "./runEvents.js";
import type { RunStatus } from "./runRecord.js";
import { RunControl } from "./runRegistry/runControl.js";
import { activityOfEvents } from "./runRegistry/activity.js";
import {
  appendToBacklog,
  DEFAULT_BACKLOG_BYTES,
  DEFAULT_BACKLOG_LIMIT,
  DEFAULT_REPLAY_BYTES,
  DEFAULT_REPLAY_LIMIT,
  replayWindow,
  type BacklogBounds,
} from "./runRegistry/backlog.js";
import type {
  FinishedFrame,
  RunFinishedListener,
  RunMeta,
  RunSealListener,
  RunState,
  RunSubscriber,
  SealedFrame,
  Subscription,
  Unsubscribe,
} from "./runRegistry/state.js";
import {
  sealResultOf,
  sealedFrameOf,
  snapshotOf,
  summaryOf,
  type RunSnapshot,
  type RunSummary,
  type SealResult,
} from "./runRegistry/projections.js";

// The run registry is the unit-testable core of the external live-view page
// (docs/reference/specs/live-view.md) and the ONE per-run event store while a run is live
// (docs/decisions/0006-runs-have-two-lives.md): a run's events (tool steps and
// the `message` events carrying the exchange) live here in a bounded backlog —
// so a viewer who opens the
// capability link mid-run sees what already happened, and the finish-time
// snapshot feeds the friction diagnosis and the persisted run record — and
// finished runs are evicted after a short TTL. Durability is the run store's
// job (docs/reference/specs/run-history.md); per AGENTS.md invariant 6 the eviction here
// is intentional: a restart ends the runs it was streaming, and their
// (already-visible) events simply stop.
//
// Access is "capability OR operator" (docs/decisions/0013-capability-tokens-for-live-run-pages.md).
// The capability: create()
// mints a random run id AND a random view token; the token-gated reads
// (subscribe/has/snapshot/requestStop) require the correct token for that id,
// compared in constant time — the gate behind the live URL, kept as defense in
// depth for the HTML/SSE routes. The operator: the token-free `getById` /
// `snapshotById` / `requestStopById` grant the same reads to `RunsService`,
// whose callers are authorized ONE LAYER UP (the command registry's policy table
// plus the Cloudflare Access gate). Nothing in this file decides who
// an operator is; it only trusts that its token-free callers already did.
//
// The registry's parts live as sibling modules under `./runRegistry/`; this
// file is the registry itself and its public contract. The dispatcher's stages
// (`src/core/dispatch/`, `src/core/shipPipeline.ts`) still import a few of the
// moved names from here while their own split (decision record 0024) is in
// flight, so those names are re-exported below; once the stages import the
// sibling modules directly, the re-exports go.
export { RunControl, activityOfEvents };
export type { RunSnapshot, RunSummary, SealResult };

/** The identifiers a freshly created run is addressed by, plus its control. */
/** `create()` for a run that already has an identity and a past (a resume,
 *  docs/reference/specs/run-history.md item 37): the ledger's run id, so the page URL and
 *  the ledger row are the same run, and the events published before the
 *  restart under their original seqs. */
export interface CreateOptions {
  id?: string;
  replay?: RunEvent[];
  /** The run's original start (the ledger row's), so the record and the
   *  card's elapsed time span the whole run, not the resume. */
  startedAt?: number;
}

export interface RunHandle {
  /** Random, unguessable run id — the `:id` in `/runs/:id`. */
  id: string;
  /** Random, unguessable view token — the `?t=` capability for this run. */
  token: string;
  /** This run's stop control — the dispatcher hands it to the runner. */
  control: RunControl;
  /** The label as stored: redacted then capped (`RUN_LABEL_MAX`). The ONLY
   *  label a record or a friction row may carry — never the raw input. */
  label?: string;
}

/** Outcome of `RunRegistry.requestStop`. `not-found` covers BOTH an unknown run
 *  and a wrong token (the caller maps it to 404 — existence is never revealed);
 *  `finished` is a run that already ended (409). */
export type StopRequestResult = { ok: true; mode: StopMode } | { ok: false; reason: "not-found" | "finished" };

/** How long a finished run may stay unsealed before the sweep seals it (with
 *  no `replyOk`) and evicts it: the reply that would have sealed it never
 *  settled. Reachable only when a reply hangs; while it holds, the run's row,
 *  its subscribers and its live-view token stay pinned. */
export const UNSEALED_HOLD_MS = 15 * 60_000;

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

/** Longest label kept on a run summary (redacted first — see `create()`). Wider
 *  than the dispatcher's own composed-label cap, so this is a safety net, not
 *  the display truncation. */
export const RUN_LABEL_MAX = 200;

/** The budget override for a subscriber that must see every retained event —
 *  the run ledger, which is a store, not a viewer. Viewers take the defaults. */
export const REPLAY_EVERYTHING: Pick<SubscribeOptions, "limit" | "byteLimit"> = {
  limit: Number.POSITIVE_INFINITY,
  byteLimit: Number.POSITIVE_INFINITY,
};

/** What `subscribe()` needs: the two callbacks, the resume cursor and a replay
 *  budget override (`REPLAY_EVERYTHING` for a store; tests). */
export interface SubscribeOptions {
  onEvent: RunSubscriber;
  /** The `finished` frame: fires at finish, or immediately for a finished run;
   *  the subscriber stays attached for the span records until the seal. */
  onFinished?: RunFinishedListener;
  /** The `end` frame: fires at the seal, or immediately for a sealed run, and
   *  detaches the subscriber. */
  onSealed?: RunSealListener;
  /** The SSE `Last-Event-ID`: only events with a higher `seq` are offered; 0
   *  (the default) offers the whole retained backlog. */
  afterSeq?: number;
  /** Replay budget by count; default `DEFAULT_REPLAY_LIMIT`. At least one
   *  event is always replayed when any is retained. */
  limit?: number;
  /** Replay budget by bytes (each event's UTF-8 JSON); default
   *  `DEFAULT_REPLAY_BYTES`. The newest event is replayed even when it alone
   *  exceeds it. */
  byteLimit?: number;
}

/** The successful result of `subscribe()`: how to detach, how many retained
 *  events were replayed, and — when the budget left retained events out — the
 *  contiguous `seq` range that was skipped (the transport's `replay_elided`
 *  frame). Events the backlog itself no longer holds are not elided: they are
 *  a `seq` gap, and the record is the only place that still has them. */
export interface Subscribed {
  unsubscribe: Unsubscribe;
  replayed: number;
  elided?: { fromSeq: number; toSeq: number };
}

export interface RunRegistryOptions {
  /** Max events retained per run (oldest dropped past it). Default 5000. */
  backlogLimit?: number;
  /** Max bytes retained per run, measured as each event's UTF-8 JSON size; the
   *  oldest events are dropped until under budget (the newest always stays).
   *  Default 4 MiB. */
  backlogBytes?: number;
  /** How long a finished run stays subscribable before eviction. Default 60s. */
  ttlMs?: number;
  /** Injectable id generator (tests); default `crypto.randomUUID`. */
  genId?: () => string;
  /** Injectable token generator (tests); default 32 random bytes as hex. */
  genToken?: () => string;
  /** Injectable clock (tests); default `Date.now`. */
  now?: () => number;
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
  private readonly bounds: BacklogBounds;
  private readonly ttlMs: number;
  private readonly genId: () => string;
  private readonly genToken: () => string;
  private readonly now: () => number;
  /** Monotonic creation counter; stamps each run's `seq` for stable ordering. */
  private seq = 0;

  constructor(opts: RunRegistryOptions = {}) {
    this.bounds = {
      limit: opts.backlogLimit ?? DEFAULT_BACKLOG_LIMIT,
      bytes: opts.backlogBytes ?? DEFAULT_BACKLOG_BYTES,
    };
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.genId = opts.genId ?? (() => randomUUID());
    this.genToken = opts.genToken ?? (() => randomBytes(32).toString("hex"));
    this.now = opts.now ?? Date.now;
  }

  /** Register a new run; returns its capability handle (id + view token). An
   *  optional short human `label` (e.g. the agent + repo/thread) is stored for
   *  the runs index and is otherwise inert. The label derives from the request
   *  text, so it is redacted (then capped) here — a pasted secret never reaches
   *  a `RunSummary`, the index, or the run record; the handle carries the
   *  redacted label so callers persist that one. `meta` (identity fields) is
   *  stored as given and projected onto every summary. */
  /** A run id from this registry's generator, for a caller that needs the id
   *  before `create()` (the ledger reservation at admission, item 42) — passed
   *  back as `CreateOptions.id`. */
  mintId(): string {
    return this.genId();
  }

  create(label?: string, meta?: RunMeta, opts: CreateOptions = {}): RunHandle {
    this.sweep();
    const id = opts.id ?? this.genId();
    const token = this.genToken();
    const stored = label === undefined ? undefined : redactAndCap(label, RUN_LABEL_MAX);
    const run: RunState = {
      id,
      token,
      backlog: [],
      backlogSizes: [],
      backlogBytes: 0,
      subscribers: new Set(),
      finished: false,
      label: stored,
      meta,
      startedAt: opts.startedAt ?? this.now(),
      seq: ++this.seq,
      eventCount: 0,
      stepCount: 0,
      headLen: 0,
      headBytes: 0,
      control: new RunControl(),
      persisted: false,
    };
    this.runs.set(id, run);
    // A resumed run (docs/reference/specs/run-history.md item 37) brings the events it
    // published before the restart, under their original `seq`: they are
    // appended as if published (bounded like any backlog, no subscribers yet)
    // and the counter continues past the highest, so the record assembled at
    // finish and the seqs appended to the ledger stay one contiguous stream.
    for (const event of [...(opts.replay ?? [])].sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0))) {
      const seq = event.seq ?? run.eventCount + 1;
      run.eventCount = Math.max(run.eventCount, seq);
      if (!isSpanRecord(event)) run.stepCount++;
      appendToBacklog(run, this.bounds, { ...event, seq });
    }
    this.notifyIndex({ type: "upsert", run: summaryOf(run) });
    return { id, token, control: run.control, ...(stored !== undefined ? { label: stored } : {}) };
  }

  /**
   * Ask a live run to stop — the control-plane entry behind
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
    return this.stopRun(run, mode);
  }

  /**
   * Token-free stop for an authorized operator — `RunsService.stopRun`
   * after the command layer authorized the caller. Same outcomes as
   * `requestStop`; additionally the `stop_requested` note carries the structured
   * `actor` (sanitized: `ACTOR_ID_PATTERN` charset, ≤ 128 chars) so the stream
   * records who asked. Never throws.
   */
  requestStopById(id: string, mode: StopMode, actor: RunActor): StopRequestResult {
    this.sweep();
    const run = this.runs.get(id);
    if (!run) return { ok: false, reason: "not-found" };
    return this.stopRun(run, mode, sanitizeActor(actor));
  }

  private stopRun(run: RunState, mode: StopMode, actor?: RunActor): StopRequestResult {
    if (run.finished) return { ok: false, reason: "finished" };
    const effective = run.control.requestStop(mode);
    this.publish(run.id, {
      type: "run_note",
      kind: "stop_requested",
      mode: effective,
      ...(actor ? { actor } : {}),
      summary: effective === "hard" ? "hard stop requested — aborting now" : "soft stop requested — wrapping up",
      at: this.now(),
    });
    return { ok: true, mode: effective };
  }

  /** Stamp an event with the run's next `seq`, append it to the backlog (dropping
   *  the oldest past the count or byte bound — the newest always survives), and
   *  fan it out to live subscribers. Content stops at finish and span records
   *  stop at the seal (docs/reference/specs/tracing.md): a content event on a finished run
   *  and anything on a sealed or unknown run is a silent no-op. Never throws,
   *  and a throwing subscriber is isolated like an index sink: it can neither
   *  stop the other subscribers nor reach the publisher. */
  publish(id: string, event: RunEvent): void {
    const run = this.runs.get(id);
    if (!run || run.sealedAt !== undefined) return;
    const span = isSpanRecord(event);
    if (run.finished && !span) return;
    // ONE counter: `eventCount` is the monotonic published total AND the `seq`
    // stamped on the event — the SSE `id:` a client resumes from.
    const seq = ++run.eventCount;
    if (!span) run.stepCount++;
    const stamped: RunEvent = { ...event, seq };
    appendToBacklog(run, this.bounds, stamped);
    for (const sub of run.subscribers) {
      try {
        sub.onEvent(stamped, seq);
      } catch {
        // A dead sink (e.g. a closed SSE response) must not break this publish
        // for the remaining subscribers or throw into the runner.
      }
    }
    // Index rows show live activity (event count + running state). Agent tool
    // events are seconds apart, so one upsert per event is not chatty; the
    // summary is built cheaply from the run we already hold. A span record is
    // timing, not activity: it never repaints the index.
    if (!span) this.notifyIndex({ type: "upsert", run: summaryOf(run) });
  }

  /** Mark a run finished — the agent stopped: stamp `finishedAt`, send every
   *  attached subscriber the `finished` frame WITHOUT detaching it (span records
   *  still flow until the seal), and upsert the index. `status` is the terminal
   *  status the caller computed (the dispatcher's), stored so every summary
   *  projects it — consumers never re-derive it. Idempotent; a no-op for an
   *  unknown run. The seal comes later, from the dispatcher once the first
   *  reply attempt has completed (`seal`), or from the sweep. */
  finish(id: string, status?: RunStatus): void {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    run.finished = true;
    run.finishedAt = this.now();
    run.finishSeq = run.eventCount;
    if (status !== undefined) run.status = status;
    const frame: FinishedFrame = { finishedAt: run.finishedAt };
    for (const sub of [...run.subscribers]) {
      try {
        sub.onFinished?.(frame);
      } catch {
        // A dead sink must not break the finish for the remaining subscribers.
      }
    }
    // A finished run stays on the index (marked finished) until the TTL evicts
    // it — so finish is an upsert, not a removal. Eviction emits the removal.
    this.notifyIndex({ type: "upsert", run: summaryOf(run) });
  }

  /**
   * Drop a run that never started (docs/reference/specs/run-history.md item 42):
   * the run was created at its reservation, before the workspace attach, and
   * the dispatch ended before its run loop — a refusal, a failed attach, a
   * throw. The row goes with no finished frame and no record, as the ledger's
   * `abandon` drops the reservation: a live subscriber gets the `end` frame
   * (nothing more will come, nothing to reply about), the index feed gets the
   * removal, and the id is unknown afterwards. A no-op for an unknown run and
   * for a finished one — a finished run has a record, the sweep evicts it.
   */
  discard(id: string): void {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    this.runs.delete(id);
    const subs = [...run.subscribers];
    run.subscribers.clear();
    const frame: SealedFrame = { sealedAt: this.now() };
    for (const sub of subs) {
      try {
        sub.onSealed?.(frame);
      } catch {
        // A dead sink must not break the discard for the remaining subscribers.
      }
    }
    this.notifyIndex({ type: "removed", id });
  }

  /**
   * Seal a run — the stream closed: the first reply attempt completed
   * (`replyOk` true or false), or the run's branch was abandoned without one
   * (`replyOk` absent). Stamps `sealedAt`, detaches every subscriber with the
   * `end` frame, upserts the index once, and returns the events published
   * since finish with the seal stamps. Idempotent and re-readable: a second
   * seal returns the same result and changes nothing. A live run is untouched
   * (no stamps in the result); an unknown or evicted run yields the empty
   * result. Never throws.
   */
  seal(id: string, opts: { replyOk?: boolean } = {}): SealResult {
    this.sweep();
    const run = this.runs.get(id);
    if (!run) return { events: [] };
    return this.sealRun(run, { replyOk: opts.replyOk, upsert: true });
  }

  /** Seal every finished-but-unsealed run (the drain, before exit); returns how
   *  many it sealed. */
  sealAllFinished(opts: { replyOk?: boolean } = {}): number {
    this.sweep();
    let sealed = 0;
    for (const run of this.runs.values()) {
      if (!run.finished || run.sealedAt !== undefined) continue;
      this.sealRun(run, { replyOk: opts.replyOk, upsert: true });
      sealed++;
    }
    return sealed;
  }

  /** The one seal: the public `seal()` (upsert) and the sweep (no upsert) both
   *  come here. `sealedAt` is stamped and the subscriber set copied-and-cleared
   *  BEFORE any callback fires, so a re-entrant call is a no-op. */
  private sealRun(run: RunState, opts: { replyOk: boolean | undefined; upsert: boolean }): SealResult {
    if (!run.finished) return { events: [], eventCount: run.eventCount };
    if (run.sealedAt === undefined) {
      run.sealedAt = this.now();
      if (opts.replyOk !== undefined) run.replyOk = opts.replyOk;
      const subs = [...run.subscribers];
      run.subscribers.clear();
      const frame = sealedFrameOf(run);
      for (const sub of subs) {
        try {
          sub.onSealed?.(frame);
        } catch {
          // A dead sink must not break the seal for the remaining subscribers.
        }
      }
      if (opts.upsert) this.notifyIndex({ type: "upsert", run: summaryOf(run) });
    }
    return sealResultOf(run);
  }

  /**
   * Record that the durable run store confirmed this run's record:
   * the history writer calls this on a successful put. The summary gains
   * `persisted: true` and the index is upserted, so an `?all=1` client can keep
   * the row when eviction fires. A no-op for an unknown or already-evicted run
   * (the write may land after the TTL — that is fine, the store has it). Not
   * token-gated: it grants nothing and is only reachable from bot code.
   */
  markPersisted(id: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.persisted = true;
    this.notifyIndex({ type: "upsert", run: summaryOf(run) });
  }

  /** True iff the run exists (not yet evicted) and the token matches — the same
   *  constant-time capability gate subscribe() applies, for the page route. */
  has(id: string, token: string): boolean {
    this.sweep();
    return this.validate(id, token) !== null;
  }

  /**
   * Subscribe to a run's events: validates the token in constant time, replays
   * the retained backlog within the replay budget, then live-forwards new
   * events. Returns `null` if the run is unknown or the token is wrong (the
   * caller maps both to a 404 — never reveal which). If the run is already
   * finished (but not yet evicted), the replay happens and `onFinished` fires
   * immediately — then `onSealed` too when it is sealed, else the subscriber
   * stays attached until the seal. `afterSeq` resumes a dropped stream: only events with a higher
   * `seq` are offered (the SSE `Last-Event-ID`); 0 offers the whole retained
   * backlog. Of the offered events the NEWEST are replayed, up to `limit` and
   * `byteLimit`; the older ones the budget skipped come back as `elided`, a
   * contiguous `seq` range, so the transport can say what a viewer did not get.
   */
  subscribe(id: string, token: string, opts: SubscribeOptions): Subscribed | null {
    this.sweep();
    const run = this.validate(id, token);
    if (!run) return null;

    const { onEvent, onFinished, onSealed, afterSeq = 0 } = opts;
    const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_REPLAY_LIMIT));
    const byteLimit = opts.byteLimit ?? DEFAULT_REPLAY_BYTES;
    const { backlog } = run;
    const { head, start, elided } = replayWindow(run, afterSeq, limit, byteLimit);
    for (let i = 0; i < head; i++) onEvent(backlog[i]!, backlog[i]!.seq ?? 0);
    for (let i = start; i < backlog.length; i++) onEvent(backlog[i]!, backlog[i]!.seq ?? 0);
    const replayed = head + (backlog.length - start);

    // A finished run says so at once; a sealed run then ends at once and never
    // attaches. A finished-but-unsealed run attaches like a live one, for the
    // span records still to come and the `end` frame at the seal.
    if (run.finished) onFinished?.({ finishedAt: run.finishedAt ?? run.startedAt });
    if (run.sealedAt !== undefined) {
      onSealed?.(sealedFrameOf(run));
      return { unsubscribe: () => {}, replayed, ...(elided ? { elided } : {}) };
    }

    const sub: Subscription = { onEvent, onFinished, onSealed };
    run.subscribers.add(sub);
    return { unsubscribe: () => void run.subscribers.delete(sub), replayed, ...(elided ? { elided } : {}) };
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
   * has finished — the input to the run-friction analyzer and the run
   * record for a run that is still in the registry (live, or finished
   * within the TTL). `eventCount` is the monotonic published total (the backlog
   * is bounded, so `events.length` may be smaller) and `startedAt` the create()
   * clock time — the two record fields not derivable from the events. A COPY of
   * the backlog, so callers can't reach the live array. Same constant-time gate
   * as subscribe(); `null` for an unknown run or wrong token (caller → 404).
   */
  snapshot(id: string, token: string): RunSnapshot | null {
    this.sweep();
    const run = this.validate(id, token);
    if (!run) return null;
    return snapshotOf(run);
  }

  /** Token-free summary of one non-evicted run for `RunsService`,
   *  or null when unknown/evicted. Carries the token like every `RunSummary` —
   *  the service projects it out before anything leaves the core. */
  getById(id: string): RunSummary | null {
    this.sweep();
    const run = this.runs.get(id);
    return run ? summaryOf(run) : null;
  }

  /** Token-free `snapshot` for `RunsService`: the same copied
   *  backlog + finished/startedAt/eventCount, null when unknown/evicted. */
  snapshotById(id: string): RunSnapshot | null {
    this.sweep();
    const run = this.runs.get(id);
    if (!run) return null;
    return snapshotOf(run);
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
   * must sit behind Cloudflare Access (see docs/reference/specs/live-view.md). Ordering is
   * by `startedAt` descending, tie-broken by creation `seq` descending so runs
   * created within the same clock tick still come out newest-first.
   */
  listActive(): RunSummary[] {
    this.sweep();
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt || b.seq - a.seq)
      .map((run) => summaryOf(run));
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

  /** Evict sealed runs whose TTL (from `sealedAt`) has elapsed, and seal-then-
   *  evict finished runs left unsealed past `UNSEALED_HOLD_MS` (their reply never
   *  settled). Called on every entry point so no background timer is needed
   *  (which would keep the process alive / leak). */
  private sweep(): void {
    if (this.runs.size === 0) return;
    const now = this.now();
    for (const [id, run] of this.runs) {
      if (!run.finished || run.finishedAt === undefined) continue;
      if (run.sealedAt === undefined) {
        if (run.finishedAt > now - UNSEALED_HOLD_MS) continue;
        this.sealRun(run, { replyOk: undefined, upsert: false });
      } else if (run.sealedAt > now - this.ttlMs) continue;
      this.runs.delete(id);
      // Eviction is the ONLY removal signal for the index feed (a finished-but-
      // -unevicted run stays listed). Fires once per run — the delete above
      // ensures a later sweep won't re-emit it.
      this.notifyIndex({ type: "removed", id });
    }
  }
}

/** Process-wide singleton shared by the dispatcher (which publishes run events)
 *  and the served /runs endpoints (which subscribe). One instance so a run
 *  created during dispatch is the same run the live page streams. */
export const defaultRunRegistry = new RunRegistry();
