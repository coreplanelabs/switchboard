import type { ChannelVisibility } from "../authz/types.js";
import { SPAN_SCHEMA } from "../normalizeSpans.js";
import type { RunEvent, StopMode } from "../runEvents.js";
import type { RunStatus } from "../runRecord.js";
import type { RunState, SealedFrame } from "./state.js";

// What a run's state looks like from outside: the read shapes the registry
// hands out (the index summary, the snapshot the record and the friction
// diagnosis are built from, the seal result, the `end` frame) and the one
// function each that projects `RunState` onto it. Pure over the state; the
// registry calls them so that `listActive()`, the index feed and the token-free
// operator reads can never drift apart.

/** A run's stop status for the index: `stopping` from the request until the run
 *  finishes, then `stopped`. Absent when no stop was ever requested. */
export interface RunStopStatus {
  mode: StopMode;
  state: "stopping" | "stopped";
}

/**
 * A live-only snapshot of one non-evicted run, for the Access-gated runs index
 * (`GET /runs`). It intentionally carries the per-run `token` so the index can
 * render each run's full capability link — the index is the ONE place tokens
 * surface, and it must only ever be exposed behind Cloudflare Access (see
 * docs/reference/specs/live-view.md). `eventCount` is monotonic (total published, not the
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
  /** Present only once a stop has been requested. */
  stop?: RunStopStatus;
  /** Present (true) once the history writer confirmed the run is in the durable
   *  store — how an index client learns a row outlives eviction. */
  persisted?: boolean;
  /** The seven stamps and the one duration (docs/reference/specs/tracing.md). `receivedAt`:
   *  our process saw the message, from the adapter's clock (stamped by the
   *  dispatcher once the adapters carry it; absent until then, so every reader
   *  falls back to `startedAt`). `sealedAt`: the stream closed, when the first
   *  reply attempt completed or the branch was abandoned; `replyOk` is
   *  tri-state — `true` a reply was attempted and delivered, `false` attempted
   *  and threw, absent none was made. `stepCount`: content events only (span
   *  records excluded). `schema`: the stream schema — always `SPAN_SCHEMA` on a
   *  registry summary (this runner emitted it); a STORED record absent it or
   *  below it carries no timing. All omitted when absent. */
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
  /** `RunMeta.receivedAt`, when the run was created with it (docs/reference/specs/tracing.md). */
  receivedAt?: number;
  eventCount: number;
  /** Content events published — span records excluded (docs/reference/specs/tracing.md). */
  stepCount: number;
  /** True when the bounded backlog dropped events (`eventCount > events.length`):
   *  a consumer analyzing `events` is looking at a head-truncated stream. */
  truncated: boolean;
}

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

/** Build the index summary for one run. The single source of the run→summary
 *  mapping, shared by `listActive()` and the `subscribeIndex` feed so the two
 *  can never drift. `label` is omitted (not set to `undefined`) when absent. */
export function summaryOf(run: RunState): RunSummary {
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
    stepCount: run.stepCount,
    schema: SPAN_SCHEMA, // a registry run is this runner's: spans carry its timing
    ...(run.activity !== undefined ? { activity: run.activity } : {}),
    ...(run.control.requested !== undefined
      ? { stop: { mode: run.control.requested, state: run.finished ? ("stopped" as const) : ("stopping" as const) } }
      : {}),
    ...(run.persisted ? { persisted: true } : {}),
  };
}

/** The snapshot shape: a COPY of the backlog plus the record fields not
 *  derivable from it. `truncated` says the bounded backlog dropped events. */
export function snapshotOf(run: RunState): RunSnapshot {
  return {
    events: [...run.backlog],
    finished: run.finished,
    startedAt: run.startedAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.meta?.receivedAt !== undefined ? { receivedAt: run.meta.receivedAt } : {}),
    eventCount: run.eventCount,
    stepCount: run.stepCount,
    truncated: run.eventCount > run.backlog.length,
  };
}

export function sealResultOf(run: RunState): SealResult {
  const since = run.finishSeq ?? run.eventCount;
  return {
    events: run.backlog.filter((e) => (e.seq ?? 0) > since),
    eventCount: run.eventCount,
    ...(run.sealedAt !== undefined ? { sealedAt: run.sealedAt } : {}),
    ...(run.replyOk !== undefined ? { replyOk: run.replyOk } : {}),
  };
}

export function sealedFrameOf(run: RunState): SealedFrame {
  return { sealedAt: run.sealedAt ?? 0, ...(run.replyOk !== undefined ? { replyOk: run.replyOk } : {}) };
}
