// The run ledger's contract (docs/decisions/0019-durable-run-ledger-resume-after-kill.md;
// docs/reference/specs/run-history.md items 28–34): what a live run leaves on the state
// Worker so the next bot generation can resume it. Node-free — imported by the
// bot and by `deploy/cloudflare-memory/worker.ts` alike, the way runRecord.ts is.

import type { ChatMessage } from "../chatMessage.js";
import type { ToolDef } from "../provider.js";
import type { ChannelVisibility } from "../authz/types.js";
import type { RunProfile } from "../../config/profile.js";
import type { RunEvent } from "../runEvents.js";
import type { RunSeed, RunSession } from "../runRecord.js";

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
  /** The bound credential behind the person (authorization.md item 15): a
   *  resume or restart dispatches under ITS grants again, never the person's. */
  authenticatedAs?: string;
  /** The app that relayed the request for the person (authorization.md item 14): a resume or restart keeps app ∩ person at the gates. */
  postedBy?: string;
  effort?: string;
  /** A ship pipeline's parent (record 0060): claimed under the host key
   *  (`hostKey.ts`) while `threadKey` here names the thread itself, so every
   *  record, notice and rebuilt handle files by the metadata's thread and the
   *  occupancy readers that key on the ledger's key column never see it. */
  hosted?: true;
  /** The run's index label (the registry sets it at create): on the row so a
   *  hosted run listed from the ledger reads as its registry view does. */
  label?: string;
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
  /** The coordinator instance this run is a child of, and the key its spawn
   *  carried (item 48) — stored at the claim, so a reclaimed child's record
   *  still sends the parent its event and a retried spawn finds its run. */
  parentInstanceId?: string;
  idempotencyKey?: string;
  /** Where the run's conversation started (item 52), so a reclaimed run's
   *  record still says so: `parent` for a spawned child, `channel` otherwise. */
  seed?: RunSeed;
  /** The run's place in its session's log (docs/reference/specs/session-log.md item
   *  2): set at the claim, so a resume reads the rows from `seedFrom` and
   *  continues appending at its indices. Absent on rows claimed before the
   *  session log existed — those resume from their own transcript object —
   *  and on runs without a conversation of their own. */
  session?: RunSession;
  /** Which executor the run attached: what `makeExecutor` chose. */
  selection?: "resident" | "sandbox" | "local" | "none";
  /** The worktree path the system prompt names. */
  workspace?: string;
  /** The request the run was admitted for (item 42), in the durable inbox
   *  row's shape — text with its directives, sender, link, arrival time, the
   *  attachments when they fit — so a reclaim of an `attaching` row can
   *  dispatch it again under the same run id and card. */
  request?: Record<string, unknown>;
  /** The router's decision when it chose the run's preset (routing-and-config
   *  item 21) — the same fields the record's `route` event carries. On the row
   *  so a resume repaints the card as it was (the `route reason:` note at
   *  debug, the parts) and a record built from the row knows it was routed
   *  without reading the events. Absent for a preset a person, a scope or the
   *  default chose. */
  route?: {
    preset: string;
    reason: string;
    model: string;
    parts?: { preset: string; text: string }[];
    collapsed?: { presets: string[] };
  };
}

/** Dispatcher-local run state a resume must restore (the `submit_*` callbacks,
 *  the checklist, the pushed branch, the review head, the infra counters). */
export type RunState = Record<string, unknown>;

/** A hosted ship parent's hosting fact on the row's state (record 0060): the
 *  runner instance the run hosts and the deadline past which a reclaim closes
 *  the row `interrupted` instead of re-hosting it. Set by the ship branch once
 *  the instance exists; read by the boot reclaim. */
export interface HostingState {
  instanceId: string;
  /** Epoch ms: the hand-off time plus the instance's `caps.maxMinutes` plus
   *  `HOSTED_DEADLINE_MARGIN_MINUTES`. */
  until: number;
}

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

/** One tool call the step dispatched; `tool` decides how a resume settles it.
 *  `boundMs` is the bound the call declared (a bash `timeout`), when it stated
 *  one — what the plane judges a `long_call` steer against (record 0064). */
export interface InFlightCall {
  callId: string;
  tool: string;
  boundMs?: number;
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

/** A refused claim names the run holding the thread — and the coordinator key
 *  its row carries (item 48), so a retried spawn can tell its own child from
 *  a busy thread. */
export type ClaimResult =
  | { ok: true }
  | {
      ok: false;
      reason: "thread-live";
      live: { runId: string; agent?: string; startedAt: number; idempotencyKey?: string };
    };

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

/** One hit of a session log's full-text search (session-log item 10): the
 *  row's turn and part, whose turn it is, what kind of row (`rowKind`), and
 *  the text the index held for it. */
export interface SessionHit {
  idx: number;
  part: number;
  role?: "user" | "assistant";
  kind: string;
  text: string;
}

/** A session's notepad (record 0035, "The notepad"): the text and when it was last written. */
export interface Notepad {
  text: string;
  updatedAt: number;
}

/** An externalized attachment: base64 data stored once, referenced from a row. */
export interface TranscriptAttachment {
  ref: string;
  mediaType: string;
  data: string;
}

/** pi's compaction entry as the log stores it (docs/reference/specs/session-log.md item
 *  6): the summary pi wrote of everything before the row, the size it replaced,
 *  pi's own id for the first entry it kept (forensics: it names nothing in a
 *  rebuilt file) and, when the mirror can say, `keptFrom` — the log index of
 *  that entry — so a rebuilt session keeps what pi kept. */
export interface CompactionEntry {
  summary: string;
  tokensBefore?: number;
  firstKeptEntryId?: string;
  keptFrom?: number;
}

/** The rows a step write carries, each at its log index: the previous step's
 *  results and this step's assistant turn as messages, and pi's compaction
 *  entry as a row of its own between them. The optional `actor` on a message
 *  turn is the platform-namespaced id of the person who authored it (record
 *  0057); absent for machine turns, compaction rows and pre-0057 rows. */
export type TranscriptTurn =
  { idx: number; message: ChatMessage; actor?: string } | { idx: number; compaction: CompactionEntry };

export type AppendableEvent = RunEvent & { seq: number };

/** One intake verdict as the ledger stores it (docs/reference/specs/run-history.md item
 *  59; docs/decisions/0058): keyed by the message (`<channel>:<ts>`), written
 *  first-writer-wins so one unmentioned thread reply is decided once across
 *  processes and the reconnect catch-up reads the verdict instead of deciding
 *  again. The shape is the intake seam's (`src/core/intake.ts` re-exports it);
 *  spelled out here because this file is shared with the state Worker. */
export interface IntakeReceipt {
  verdict: "addressed" | "silent";
  reason: string;
  source: "model" | "mode" | "question" | "error" | "timeout";
  /** The structured seam's attempts (docs/decisions/0067): what each answer
   *  violated, or that it was accepted; absent when no model was asked. */
  attempts?: ReadonlyArray<{ outcome: "accepted" | "violation"; violation?: string }>;
  mode: "mention" | "classify";
  /** The `<provider>/<model>` ref the verdict ran on. */
  model: string;
  /** The deciding process's generation counter, for telling a retried write's
   *  own landed row from another writer's. */
  gen: number;
  threadKey: string;
  /** Epoch ms. */
  decidedAt: number;
}

/** What an intake write answers: whether THIS write landed, and the row that
 *  stands — the first writer's, whoever that was. */
export interface IntakeWriteResult {
  inserted: boolean;
  stored: IntakeReceipt;
}

/** `listIntake`'s filters: a thread's rows, rows since an instant, or both. */
export interface IntakeQuery {
  threadKey?: string;
  since?: number;
}

/** The receipt as the Worker route validates it: every field present and of
 *  its type, the enums closed — a malformed receipt is 400, never stored. */
export function isIntakeReceipt(v: unknown): v is IntakeReceipt {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r.verdict === "addressed" || r.verdict === "silent") &&
    typeof r.reason === "string" &&
    (r.source === "model" ||
      r.source === "mode" ||
      r.source === "question" ||
      r.source === "error" ||
      r.source === "timeout") &&
    (r.mode === "mention" || r.mode === "classify") &&
    typeof r.model === "string" &&
    typeof r.gen === "number" &&
    Number.isFinite(r.gen) &&
    typeof r.threadKey === "string" &&
    r.threadKey.length > 0 &&
    r.threadKey.length <= 256 &&
    typeof r.decidedAt === "number" &&
    Number.isFinite(r.decidedAt)
  );
}
