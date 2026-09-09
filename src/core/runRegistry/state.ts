import type { ChannelVisibility } from "../authz/types.js";
import type { RunEvent } from "../runEvents.js";
import type { RunStatus } from "../runRecord.js";
import type { RunControl } from "./runControl.js";

// The row a run occupies in the registry while it is live (`RunState`), the
// identity the dispatcher hands `create()` for it (`RunMeta`), and the contract
// of a per-run subscriber: the event callback, the `finished` and `end` frames.
// The registry's other parts read slices of this state; only the registry
// itself writes it.

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
   *  (authorization) — what `member-of` reads on a live run. The dispatcher
   *  always stamps it; a hand-built run without it is `unknown`, never public. */
  channelVisibility?: ChannelVisibility;
  /** `owner/name` for repo runs. */
  repo?: string;
  /** A link back to the message that started the run (`IncomingMessage.sourceUrl`),
   *  so the index can offer the thread without opening the run (live-view item 20). */
  sourceUrl?: string;
  /** Resolved display name of who started it (`IncomingMessage.userName`) — the
   *  source mark's hover says `via Slack · alice`, never a raw member id. */
  userName?: string;
  /** Our process saw the message that started this run (docs/reference/specs/tracing.md);
   *  the run's duration opens here, falling back to `startedAt` when absent. */
  receivedAt?: number;
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
 *  (docs/reference/specs/tracing.md): `true` a reply was attempted and delivered, `false`
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

export interface Subscription {
  onEvent: RunSubscriber;
  onFinished?: RunFinishedListener;
  onSealed?: RunSealListener;
}

export interface RunState {
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
  /** Content events published (span records excluded); monotonic like `eventCount`. */
  stepCount: number;
  /** The protected head: the first `headLen` backlog entries, never trimmed,
   *  `headBytes` of them (docs/reference/specs/tracing.md). Grows only while the backlog
   *  holds nothing but head material and the budget allows. */
  headLen: number;
  headBytes: number;
  /** Stop control handed to the runner at create(); driven by requestStop(). */
  control: RunControl;
  /** Set by markPersisted() once the durable store confirmed the record. */
  persisted: boolean;
}
