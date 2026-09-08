import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  redactAndCap,
  sanitizeActor,
  serializedOnce,
  type RunActor,
  type RunEvent,
  type StopMode,
  isSpanRecord,
} from "./runEvents.js";
import type { ChannelVisibility } from "./authz/types.js";
import type { RunStatus } from "./runRecord.js";
import { utf8ByteLength } from "./runRecord.js";

// The run registry is the unit-testable core of the external live-view page
// (Area 2 / #43) and the ONE per-run event store while a run is live (#157
// KTD9): a run's events (tool steps and the `message` events carrying the
// exchange) live here in a bounded backlog — so a viewer who opens the
// capability link mid-run sees what already happened, and the finish-time
// snapshot feeds the friction diagnosis and the persisted run record — and
// finished runs are evicted after a short TTL. Durability is the run store's
// job (features/run-history.md); per AGENTS.md invariant 6 the eviction here
// is intentional: a restart ends the runs it was streaming, and their
// (already-visible) events simply stop.
//
// Access is "capability OR operator" (#157 KTD7). The capability: create()
// mints a random run id AND a random view token; the token-gated reads
// (subscribe/has/snapshot/requestStop) require the correct token for that id,
// compared in constant time — the gate behind the live URL, kept as defense in
// depth for the HTML/SSE routes. The operator: the token-free `getById` /
// `snapshotById` / `requestStopById` grant the same reads to `RunsService`,
// whose callers are authorized ONE LAYER UP (the command registry's policy table
// plus the Cloudflare Access gate). Nothing in this file decides who
// an operator is; it only trusts that its token-free callers already did.

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
/** `create()` for a run that already has an identity and a past (a resume,
 *  features/run-history.md item 37): the ledger's run id, so the page URL and
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

/** What the dispatcher knows about a run at `create()` beyond its label: the
 *  same identity fields the persisted record carries, so a live row projects
 *  like a persisted one (`RunsService.listRuns` filters on them, F8). */
export interface RunMeta {
  /** Resolved agent name. */
  agent?: string;
  /** `<provider>/<model>` the run resolved to. */
  model?: string;
  /** Platform-namespaced ids (AGENTS.md invariant 4). */
  channelId: string;
  userId: string;
  threadKey: string;
  /** The channel's visibility as the `ChannelDirectory` reported it at dispatch
   *  (authorization KTD7) — what `member-of` reads on a live run. The dispatcher
   *  always stamps it; a hand-built run without it is `unknown`, never public. */
  channelVisibility?: ChannelVisibility;
  /** `owner/name` for repo runs. */
  repo?: string;
  /** A link back to the message that started the run (`IncomingMessage.sourceUrl`),
   *  so the index can offer the thread without opening the run (live-view item 20). */
  sourceUrl?: string;
  /** Resolved display name of who started it (`IncomingMessage.userName`) — the
   *  source mark's hover says `via Slack · justin`, never a raw member id. */
  userName?: string;
  /** Our process saw the message that started this run (features/tracing.md);
   *  the run's duration opens here, falling back to `startedAt` when absent. */
  receivedAt?: number;
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
  /** The identity `RunMeta` given at create(); absent fields are omitted. */
  agent?: string;
  model?: string;
  channelId?: string;
  userId?: string;
  threadKey?: string;
  /** `RunMeta.channelVisibility`; absent = `unknown`. */
  channelVisibility?: ChannelVisibility;
  repo?: string;
  finished: boolean;
  startedAt: number;
  /** The clock time at `finish()`; absent while the run is live. */
  finishedAt?: number;
  /** The terminal status the dispatcher computed and handed to `finish()`;
   *  absent while live, and for a finish that reported none. */
  status?: RunStatus;
  eventCount: number;
  /** What the run is doing right now, one line (live-view item 20): the latest
   *  narration's first line, the latest tool call's summary, or `answering`;
   *  absent until the first such event. The index shows it on the status dot so
   *  a glance answers "what step is it on" without opening the run. */
  activity?: string;
  /** `RunMeta.sourceUrl`: the thread that started the run, for the index's hover link. */
  sourceUrl?: string;
  /** `RunMeta.userName`: who started it, resolved. */
  userName?: string;
  /** Present only once a stop has been requested (#101). */
  stop?: RunStopStatus;
  /** Present (true) once the history writer confirmed the run is in the durable
   *  store (#157 KTD9) — how an index client learns a row outlives eviction. */
  persisted?: boolean;
  /** The seven stamps and the one duration (features/tracing.md). `receivedAt`:
   *  our process saw the message, from the adapter's clock (stamped by the
   *  dispatcher once the adapters carry it; absent until then, so every reader
   *  falls back to `startedAt`). `sealedAt`: the stream closed, when the first
   *  reply attempt completed or the branch was abandoned; `replyOk` is
   *  tri-state — `true` a reply was attempted and delivered, `false` attempted
   *  and threw, absent none was made. `stepCount`: content events only (span
   *  records excluded). `schema`: the record's stream schema (2 once spans are
   *  emitted); absent is legacy. All omitted when absent. */
  receivedAt?: number;
  sealedAt?: number;
  replyOk?: boolean;
  stepCount?: number;
  schema?: number;
}

/** What `snapshot`/`snapshotById` return: a COPY of the retained backlog plus the
 *  two record fields not derivable from the events. */
export interface RunSnapshot {
  events: RunEvent[];
  finished: boolean;
  startedAt: number;
  /** The clock time at `finish()`; absent while the run is live. The record's
   *  `finishedAt` is this value, so the registry row and the record agree. */
  finishedAt?: number;
  /** `RunMeta.receivedAt`, when the run was created with it (features/tracing.md). */
  receivedAt?: number;
  eventCount: number;
  /** True when the bounded backlog dropped events (`eventCount > events.length`):
   *  a consumer analyzing `events` is looking at a head-truncated stream. */
  truncated: boolean;
}

/** `seq` is the event's 1-based position in the run's stream (the registry's
 *  `eventCount` at publish) — the SSE `id:` a client resumes from. */
export type RunSubscriber = (event: RunEvent, seq: number) => void;
/** The agent stopped (`finish()`): the SSE `finished` frame. Content events
 *  stop here; span records keep flowing until the seal. */
export interface FinishedFrame {
  finishedAt: number;
}
/** The stream closed (`seal()`): the SSE `end` frame. `replyOk` is tri-state
 *  (features/tracing.md): `true` a reply was attempted and delivered, `false`
 *  attempted and threw, absent none was measured. */
export interface SealedFrame {
  sealedAt: number;
  replyOk?: boolean;
}
/** Called once when the run finishes (immediately, for a run already finished). */
export type RunFinishedListener = (frame: FinishedFrame) => void;
/** Called once when the run's stream closes (immediately, for a run already sealed). */
export type RunSealListener = (frame: SealedFrame) => void;
/** Tear-down returned by a successful subscribe(); safe to call more than once. */
export type Unsubscribe = () => void;

/** What `seal()` returns, and what the record writer merges after the reply:
 *  the events published between finish and seal (span records), the published
 *  total, and the two seal stamps. An unknown or evicted run yields the empty
 *  result; a live run yields no stamps; a sealed run yields the same result on
 *  every call. */
export interface SealResult {
  events: RunEvent[];
  eventCount?: number;
  sealedAt?: number;
  replyOk?: boolean;
}

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

/** Default per-run backlog bounds (#157 KTD9): count and bytes. The registry
 *  backlog is the ONLY per-run event store — the friction diagnosis and the run
 *  record are built from it — so it is bounded generously and by both axes. */
export const DEFAULT_BACKLOG_LIMIT = 5000;
export const DEFAULT_BACKLOG_BYTES = 4 * 1024 * 1024;

/** The replay budget a late subscriber gets from the retained backlog
 *  (features/live-view.md item 5): at most this many events and at most
 *  `DEFAULT_REPLAY_BYTES` of UTF-8 JSON, the newest first. The backlog keeps
 *  more than a browser needs to follow a live run, and a page must not stall on
 *  a 4 MiB burst; what the budget leaves out is reported as `elided`, never
 *  silently dropped. */
export const DEFAULT_REPLAY_LIMIT = 2000;
export const DEFAULT_REPLAY_BYTES = 1024 * 1024;

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

interface Subscription {
  onEvent: RunSubscriber;
  onFinished?: RunFinishedListener;
  onSealed?: RunSealListener;
}

interface RunState {
  id: string;
  token: string;
  /** The newest events, each carrying its `seq` (stream position). Bounded by
   *  count and bytes — see `publish()`. */
  backlog: RunEvent[];
  /** UTF-8 JSON size of each backlog entry, index-aligned with `backlog`. */
  backlogSizes: number[];
  /** Sum of `backlogSizes`; compared against the byte budget on publish. */
  backlogBytes: number;
  subscribers: Set<Subscription>;
  finished: boolean;
  /** Wall-clock finish time (the agent stopped). */
  finishedAt?: number;
  /** `eventCount` at finish: the seal result's events are the ones after it. */
  finishSeq?: number;
  /** Wall-clock seal time (the stream closed); drives TTL eviction. Absent
   *  between finish and seal — the unsealed hold. */
  sealedAt?: number;
  /** The first seal's `replyOk`, when one was given. */
  replyOk?: boolean;
  /** Terminal status given to `finish()`, projected onto the summary. */
  status?: RunStatus;
  /** Short human label for the runs index; set at create(). */
  label?: string;
  /** Identity fields given at create(); projected onto every summary. */
  meta?: RunMeta;
  /** Clock time at create() — the index sorts newest-first on this. */
  startedAt: number;
  /** Monotonic creation order; a stable tiebreak when two runs share a clock. */
  seq: number;
  /** The latest one-line activity (see `RunSummary.activity`); set by `publish()`. */
  activity?: string;
  /** Total events published (monotonic; unlike backlog, never trimmed). */
  eventCount: number;
  /** Stop control handed to the runner at create(); driven by requestStop(). */
  control: RunControl;
  /** Set by markPersisted() once the durable store confirmed the record. */
  persisted: boolean;
}

/** First line of `text`, whitespace collapsed, cut at `max` with an ellipsis —
 *  the index's one-line activity (events are already redacted upstream). */
function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The one-line activity an event contributes (live-view item 20): the newest
 *  narration's first line, a tool call's summary, or the answer's first line —
 *  for a failed inline run that is the `⚠️ <error>` reply, so the index can
 *  say WHAT failed. Other events contribute nothing (`undefined`). One rule for
 *  the live summary (`publish`) and the persisted record (`activityOfEvents`). */
export function activityOf(event: RunEvent): string | undefined {
  if (event.type === "assistant" || event.type === "answer") return oneLine(event.text, 120);
  if (event.type === "tool_call") return oneLine(event.summary, 120);
  return undefined;
}

/** The latest activity across a run's events (the record writer's rule). */
export function activityOfEvents(events: readonly RunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const a = activityOf(events[i]);
    if (a !== undefined) return a;
  }
  return undefined;
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
  private readonly backlogBytes: number;
  private readonly ttlMs: number;
  private readonly genId: () => string;
  private readonly genToken: () => string;
  private readonly now: () => number;
  /** Monotonic creation counter; stamps each run's `seq` for stable ordering. */
  private seq = 0;

  constructor(opts: RunRegistryOptions = {}) {
    this.backlogLimit = opts.backlogLimit ?? DEFAULT_BACKLOG_LIMIT;
    this.backlogBytes = opts.backlogBytes ?? DEFAULT_BACKLOG_BYTES;
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
      control: new RunControl(),
      persisted: false,
    };
    this.runs.set(id, run);
    // A resumed run (features/run-history.md item 37) brings the events it
    // published before the restart, under their original `seq`: they are
    // appended as if published (bounded like any backlog, no subscribers yet)
    // and the counter continues past the highest, so the record assembled at
    // finish and the seqs appended to the ledger stay one contiguous stream.
    for (const event of [...(opts.replay ?? [])].sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0))) {
      const seq = event.seq ?? run.eventCount + 1;
      run.eventCount = Math.max(run.eventCount, seq);
      this.appendToBacklog(run, { ...event, seq });
    }
    this.notifyIndex({ type: "upsert", run: this.summaryOf(run) });
    return { id, token, control: run.control, ...(stored !== undefined ? { label: stored } : {}) };
  }

  /** Append one stamped event to the run's bounded backlog and refresh its activity line. */
  private appendToBacklog(run: RunState, stamped: RunEvent): void {
    const bytes = utf8ByteLength(serializedOnce(stamped)); // memoized: the SSE frame reuses this string
    run.backlog.push(stamped);
    run.backlogSizes.push(bytes);
    run.backlogBytes += bytes;
    // The one-line "what is it doing" the index shows (item 20). Narration wins
    // over the tool call it explains only until the next call arrives.
    const activity = activityOf(stamped);
    if (activity !== undefined) run.activity = activity;
    while (run.backlog.length > 1 && (run.backlog.length > this.backlogLimit || run.backlogBytes > this.backlogBytes)) {
      run.backlog.shift();
      run.backlogBytes -= run.backlogSizes.shift() ?? 0;
    }
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
    return this.stopRun(run, mode);
  }

  /**
   * Token-free stop for an authorized operator (#157 KTD7) — `RunsService.stopRun`
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
   *  stop at the seal (features/tracing.md): a content event on a finished run
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
    const stamped: RunEvent = { ...event, seq };
    this.appendToBacklog(run, stamped);
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
    if (!span) this.notifyIndex({ type: "upsert", run: this.summaryOf(run) });
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
    this.notifyIndex({ type: "upsert", run: this.summaryOf(run) });
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
      const frame = RunRegistry.sealedFrameOf(run);
      for (const sub of subs) {
        try {
          sub.onSealed?.(frame);
        } catch {
          // A dead sink must not break the seal for the remaining subscribers.
        }
      }
      if (opts.upsert) this.notifyIndex({ type: "upsert", run: this.summaryOf(run) });
    }
    return this.sealResultOf(run);
  }

  private sealResultOf(run: RunState): SealResult {
    const since = run.finishSeq ?? run.eventCount;
    return {
      events: run.backlog.filter((e) => (e.seq ?? 0) > since),
      eventCount: run.eventCount,
      ...(run.sealedAt !== undefined ? { sealedAt: run.sealedAt } : {}),
      ...(run.replyOk !== undefined ? { replyOk: run.replyOk } : {}),
    };
  }

  private static sealedFrameOf(run: RunState): SealedFrame {
    return { sealedAt: run.sealedAt ?? 0, ...(run.replyOk !== undefined ? { replyOk: run.replyOk } : {}) };
  }

  /**
   * Record that the durable run store confirmed this run's record (#157 KTD9):
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
    const { backlog, backlogSizes } = run;
    // The backlog is `seq`-ascending: the offered events are one suffix, and the
    // replayed ones a suffix of that. Walk newest-first, admitting an event while
    // both bounds hold; the newest is admitted unconditionally.
    let first = backlog.findIndex((e) => (e.seq ?? 0) > afterSeq);
    if (first === -1) first = backlog.length;
    let start = backlog.length;
    let bytes = 0;
    while (start > first) {
      const next = start - 1;
      const count = backlog.length - next;
      const size = backlogSizes[next] ?? 0;
      if (count > 1 && (count > limit || bytes + size > byteLimit)) break;
      bytes += size;
      start = next;
    }
    const elided =
      start > first ? { fromSeq: backlog[first]!.seq ?? 0, toSeq: backlog[start - 1]!.seq ?? 0 } : undefined;
    for (let i = start; i < backlog.length; i++) onEvent(backlog[i]!, backlog[i]!.seq ?? 0);
    const replayed = backlog.length - start;

    // A finished run says so at once; a sealed run then ends at once and never
    // attaches. A finished-but-unsealed run attaches like a live one, for the
    // span records still to come and the `end` frame at the seal.
    if (run.finished) onFinished?.({ finishedAt: run.finishedAt ?? run.startedAt });
    if (run.sealedAt !== undefined) {
      onSealed?.(RunRegistry.sealedFrameOf(run));
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
   * has finished — the input to the run-friction analyzer (#84) and the run
   * record (#157) for a run that is still in the registry (live, or finished
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
    return RunRegistry.snapshotOf(run);
  }

  /** Token-free summary of one non-evicted run for `RunsService` (#157 KTD7),
   *  or null when unknown/evicted. Carries the token like every `RunSummary` —
   *  the service projects it out before anything leaves the core. */
  getById(id: string): RunSummary | null {
    this.sweep();
    const run = this.runs.get(id);
    return run ? this.summaryOf(run) : null;
  }

  /** Token-free `snapshot` for `RunsService` (#157 KTD7): the same copied
   *  backlog + finished/startedAt/eventCount, null when unknown/evicted. */
  snapshotById(id: string): RunSnapshot | null {
    this.sweep();
    const run = this.runs.get(id);
    if (!run) return null;
    return RunRegistry.snapshotOf(run);
  }

  /** The snapshot shape: a COPY of the backlog plus the record fields not
   *  derivable from it. `truncated` says the bounded backlog dropped events. */
  private static snapshotOf(run: RunState): RunSnapshot {
    return {
      events: [...run.backlog],
      finished: run.finished,
      startedAt: run.startedAt,
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      ...(run.meta?.receivedAt !== undefined ? { receivedAt: run.meta.receivedAt } : {}),
      eventCount: run.eventCount,
      truncated: run.eventCount > run.backlog.length,
    };
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
    const m = run.meta;
    return {
      id: run.id,
      token: run.token,
      ...(run.label !== undefined ? { label: run.label } : {}),
      ...(m?.agent !== undefined ? { agent: m.agent } : {}),
      ...(m?.model !== undefined ? { model: m.model } : {}),
      ...(m ? { channelId: m.channelId, userId: m.userId, threadKey: m.threadKey } : {}),
      ...(m?.channelVisibility !== undefined ? { channelVisibility: m.channelVisibility } : {}),
      ...(m?.repo !== undefined ? { repo: m.repo } : {}),
      ...(m?.sourceUrl !== undefined ? { sourceUrl: m.sourceUrl } : {}),
      ...(m?.userName !== undefined ? { userName: m.userName } : {}),
      finished: run.finished,
      startedAt: run.startedAt,
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      ...(m?.receivedAt !== undefined ? { receivedAt: m.receivedAt } : {}),
      ...(run.sealedAt !== undefined ? { sealedAt: run.sealedAt } : {}),
      ...(run.replyOk !== undefined ? { replyOk: run.replyOk } : {}),
      ...(run.status !== undefined ? { status: run.status } : {}),
      eventCount: run.eventCount,
      ...(run.activity !== undefined ? { activity: run.activity } : {}),
      ...(run.control.requested !== undefined
        ? { stop: { mode: run.control.requested, state: run.finished ? ("stopped" as const) : ("stopping" as const) } }
        : {}),
      ...(run.persisted ? { persisted: true } : {}),
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
