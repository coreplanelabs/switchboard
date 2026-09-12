// The run ledger's contract (docs/decisions/0019-durable-run-ledger-resume-after-kill.md;
// docs/reference/specs/run-history.md items 28–34): what a live run leaves on the state
// Worker so the next bot generation can resume it. Node-free — imported by the
// bot and by `deploy/cloudflare-memory/worker.ts` alike, the way runRecord.ts is.

import type { ChatMessage, ToolDef } from "../../providers/types.js";
import type { ChannelVisibility } from "../authz/types.js";
import type { RunProfile } from "../../config/profile.js";
import type { RunEvent } from "../runEvents.js";

/** How long a generation's claim on a run lasts without a heartbeat. */
export const LEASE_MS = 30_000;
/** How often the owning generation renews the lease. */
export const HEARTBEAT_MS = 10_000;
/** The append flusher's batch window and size. */
export const APPEND_FLUSH_MS = 500;
export const APPEND_FLUSH_EVENTS = 32;
/** Request-body ceiling for a transcript write (the Worker's `/runs/put` fence). */
export const TRANSCRIPT_REQUEST_BYTES = 2 * 1024 * 1024;
/** One content part per row; a row must stay under the Durable Object's 2 MB
 *  row limit with headroom for the JSON envelope. */
export const TRANSCRIPT_PART_BYTES = 1_500_000;
/** Base64 attachment data over this size is stored once and referenced. */
export const ATTACHMENT_REF_BYTES = 1_000_000;
/** A generation id: the bot's process start plus a random suffix. */
export const GEN_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** `attaching`: reserved at admission (item 42) — the row holds the request
 *  and no prompt yet; a reclaim restarts the run from the request. `live`:
 *  the prompt and seed landed. `handoff`: the owner drained. `finishing`: the
 *  owner replied. */
export type LivePhase = "attaching" | "live" | "handoff" | "finishing";
export type StopMode = "soft" | "hard";

/** Where the run's status card is, so a resumed run edits the same message. */
export interface CardHandle {
  channel: string;
  ts: string;
}

/** The registry's `RunMeta` fields (spelled out rather than imported: the
 *  registry is a Node module and this file is shared with the state Worker)
 *  plus what a resume needs that the dispatcher otherwise keeps in closures. */
export interface LiveRunMeta {
  agent?: string;
  model?: string;
  channelId: string;
  userId: string;
  threadKey: string;
  channelVisibility?: ChannelVisibility;
  repo?: string;
  sourceUrl?: string;
  userName?: string;
  effort?: string;
  ref?: string;
  headSha?: string;
  pr?: number;
  readonly?: boolean;
  /** The effective profile the run was admitted with — its class, identity,
   *  the budget it runs on and what clipped it — so a resume keeps the clipped
   *  budget instead of re-reading the preset's. Absent on rows written before
   *  profiles existed. */
  profile?: RunProfile;
  /** The run that spawned this one (item 46), so a reclaimed child's record
   *  still names its parent. Absent on every run a person or a schedule started. */
  parentRunId?: string;
  /** Which executor the run attached: what `makeExecutor` chose. */
  selection?: "resident" | "sandbox" | "local" | "none";
  /** The worktree path the system prompt names. */
  workspace?: string;
  /** The request the run was admitted for (item 42), in the durable inbox
   *  row's shape — text with its directives, sender, link, arrival time, the
   *  attachments when they fit — so a reclaim of an `attaching` row can
   *  dispatch it again under the same run id and card. */
  request?: Record<string, unknown>;
}

/** Dispatcher-local run state a resume must restore (the `submit_*` callbacks,
 *  the checklist, the pushed branch, the review head, the infra counters). */
export type RunState = Record<string, unknown>;

export interface LiveRunRow {
  runId: string;
  threadKey: string;
  ownerGen: string;
  /** Epoch ms. */
  leaseUntil: number;
  startedAt: number;
  phase: LivePhase;
  stop: StopMode | null;
  meta: LiveRunMeta;
  card: CardHandle | null;
  /** The composed system prompt, verbatim. */
  system: string;
  /** The tool definitions the run was started with, verbatim. */
  tools: ToolDef[];
  state: RunState;
}

/** One tool call the step dispatched; `tool` decides how a resume settles it. */
export interface InFlightCall {
  callId: string;
  tool: string;
}

/** Written BEFORE a step's tools run (after its transcript turns landed). */
export interface StepRecord {
  step: number;
  /** The registry `seq` at the time, for ordering against events. */
  seq: number;
  /** Transcript turns present when this record was written. */
  turnIndex: number;
  inFlight: InFlightCall[];
  /** The inbox `seq` the run has consumed up to (0 = none). */
  inboxConsumedSeq: number;
  remainingMs: number;
  turn: number;
  iteration: number;
}

export interface InboxItem {
  seq: number;
  /** The `IncomingMessage` minus attachment bytes, plus channel/ts/threadTs. */
  message: Record<string, unknown>;
}

export interface RunJob {
  kind: string;
  payload: unknown;
}

export interface ClaimRequest {
  runId: string;
  threadKey: string;
  gen: string;
  leaseMs: number;
  startedAt: number;
  meta: LiveRunMeta;
  card?: CardHandle | null;
  system: string;
  tools: ToolDef[];
  state?: RunState;
  /** `attaching` reserves the thread at admission with an empty prompt (item
   *  42); absent (or `live`) is the claim with the prompt — which, on the
   *  owner's own attaching row, promotes it in place. */
  phase?: "attaching" | "live";
}

export type ClaimResult =
  { ok: true } | { ok: false; reason: "thread-live"; live: { runId: string; agent?: string; startedAt: number } };

export type FenceResult = { ok: true } | { ok: false; reason: "fenced" | "unknown-run" };

export interface ReclaimedRun {
  /** The row as the new generation now holds it (`phase: live`, its lease). */
  row: LiveRunRow;
  /** The phase the row was in when taken: `live` (an expired lease — the
   *  owner died), `handoff` (the owner drained), or `finishing` (the owner
   *  had replied and died before `finish` — the run is closed, never resumed). */
  reclaimedFrom: LivePhase;
  lastStep: StepRecord | null;
  inbox: InboxItem[];
  jobs: RunJob[];
}

/** One transcript row: a content part of turn `idx`. */
export interface TranscriptRow {
  idx: number;
  part: number;
  json: string;
}

/** An externalized attachment: base64 data stored once, referenced from a row. */
export interface TranscriptAttachment {
  ref: string;
  mediaType: string;
  data: string;
}

/** The turns a step write carries: the previous step's results and this step's assistant turn. */
export interface TranscriptTurn {
  idx: number;
  message: ChatMessage;
}

export type AppendableEvent = RunEvent & { seq: number };
