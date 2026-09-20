// The plane's decider (docs/reference/specs/orchestration-plane.md, the
// decider items; record 0064, "Where it lives"): one pure function over a
// closed event union and a closed effect union. The ledger object reads its
// state, calls `decide` and commits the writes and the effects inside ONE
// `transactionSync`, so a decision and its consequences land together or not
// at all. Node-free by design, like `table.ts`: no clock, no io, no ids it
// did not derive from its inputs — the same event over the same state is the
// same answer, which is what the shadow comparison and the tests rest on.
// (`budgets.ts` is constants, not io — the one import keeps every duration
// literal where `clock:check` expects it.)

import { PLANE, minutesToMs } from "../budgets.js";
import type { PlaneFinding } from "./findings.js";

// ---- endings and their causes (record 0064, "Endings and the watches") ------------------------

/** The closed set an ending's cause comes from (record 0064): the plane
 *  assigns it because it is the only component that saw both the lease and
 *  the generation; the bot's notes, the reattach text and the runner's report
 *  render it and never compose one. */
export type PlaneEndingCause =
  "completed" | "failed" | "stopped" | "withdrawn" | "refused" | "lease_lapsed" | "resident_replaced" | "runner_gone";

export const PLANE_ENDING_CAUSES: readonly PlaneEndingCause[] = [
  "completed",
  "failed",
  "stopped",
  "withdrawn",
  "refused",
  "lease_lapsed",
  "resident_replaced",
  "runner_gone",
];

/** The ending fact the object records when a live row closes: the record's
 *  own kind (its status word) and the cause from the closed set. One per
 *  closed row — the first cause stands, except that the same run's later
 *  finish replaces a standing `resident_replaced`: a restarting close is the
 *  run continuing under its own id, not its end. */
export interface PlaneEnding {
  kind: string;
  cause: PlaneEndingCause;
  at: number;
}

/** How the bot's reclaim classified one row (record 0064): `resume`, `restart`
 *  and `rehost` continue the run, so the plane records nothing for them; only
 *  `closed` assigns a cause. */
export type PlaneReclaimWord = "resume" | "restart" | "rehost" | "closed";

/** The cause a closing record's status maps to (record 0064). An `interrupted`
 *  close with `restarting` set is the reattach path restarting the run after
 *  its workspace vanished — the resident's container was replaced under it;
 *  any other `interrupted` close falls to `lease_lapsed`, which is true and
 *  blames nobody. */
export function causeOfClose(status: string, restarting?: boolean): PlaneEndingCause {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped_soft":
    case "stopped_hard":
    case "stopped":
      return "stopped";
    default:
      return restarting === true ? "resident_replaced" : "lease_lapsed";
  }
}

/** The cause a reclaim outcome records: only `closed` assigns one — a row
 *  resumed, restarted or re-hosted did not close, so a roll that resumes every
 *  row assigns nothing. */
export function causeOfReclaim(word: PlaneReclaimWord): PlaneEndingCause | undefined {
  return word === "closed" ? "lease_lapsed" : undefined;
}

/** The one rendering of a cause, in the user's nouns (record 0064): every
 *  surface that says why a run ended reads this, so no note composes its own
 *  cause. */
export function endingCauseWords(cause: PlaneEndingCause): string {
  switch (cause) {
    case "completed":
      return "it completed";
    case "failed":
      return "it failed";
    case "stopped":
      return "it was stopped";
    case "withdrawn":
      return "its wait was withdrawn";
    case "refused":
      return "its admission was refused";
    case "lease_lapsed":
      return "its lease lapsed with no heartbeat";
    case "resident_replaced":
      return "the resident container running it was replaced";
    case "runner_gone":
      return "the runner instance driving it is gone";
  }
}

/** The three stages an ask is judged at (record 0064): the bot's admission
 *  door, the plan runner's seed door, the resident's seat. this unit decides the
 *  admission stage alone; the others' conditions arrive with their units. */
export type PlaneStage = "admission" | "runner" | "resident";

/** A queue condition: what must become true before the row may run. Each is
 *  flipped by an event the plane already sees, never polled. The admission
 *  stage's full set (record 0064, "The queue"): `thread_free` — flipped by the
 *  seal or closing reclaim of the thread's run; `window_open` — flipped by the
 *  window's lift; `deploy_settled` — flipped by the deploy runner's
 *  `deploy.landed` post. The union grows one member per stage as the later
 *  units land. */
export type PlaneCondition =
  | { kind: "thread_free"; threadKey: string; met: boolean }
  | { kind: "window_open"; window: string; met: boolean }
  | { kind: "deploy_settled"; met: boolean }
  /** The resident stage's pair (record 0064, "The queue"; the resident unit):
   *  `seat` — the thread/op user pool has room; `memory` — the gate's soft
   *  side. Each is flipped by the resident's own level report, forwarded by
   *  the bot to `POST /plane/level`, never polled. */
  | { kind: "seat"; resident: string; met: boolean }
  | { kind: "memory"; resident: string; met: boolean }
  /** The provider condition (record 0064, "The queue"): the model proxy's last
   *  report for the provider is `up`. A parked run (a turn the proxy could not
   *  complete after its retry) waits on it; the provider's next relayed
   *  success, for any run, flips it. */
  | { kind: "provider_up"; provider: string; met: boolean };

/** One resident level as the plane stores it (`plane_levels`): the side of
 *  the line the resident last reported, stamped with the report time and the
 *  resident's generation. A resident with no row — or whose generation moved
 *  without a report — is `unknown` (`residentSideOf`), never assumed below. */
export interface PlaneLevelRow {
  resident: string;
  /** `provider` rows carry the model proxy's level for a provider (record
   *  0064): `below` is `up` (the condition met), `above` is `down`. */
  name: "seat" | "memory" | "provider";
  side: "below" | "above";
  reportedAt: number;
  generation: string;
}

/** The side a resident's level reads for an observer that knows the current
 *  generation: `unknown` for a resident that never reported or whose report
 *  predates the generation given (record 0064; the resident unit's record 0064). */
export function residentSideOf(
  levels: PlaneLevelRow[],
  resident: string,
  name: "seat" | "memory" | "provider",
  generation?: string,
): "below" | "above" | "unknown" {
  const row = levels.find((l) => l.resident === resident && l.name === name);
  if (!row) return "unknown";
  if (generation !== undefined && row.generation !== generation) return "unknown";
  return row.side;
}

/** A reservation: an admitted ask's hold on its thread between the answer and
 *  the ledger claim that promotes it (the `plane_reservations` row). A second
 *  ask meanwhile sees the thread taken and queues. The seal deletes it. */
export interface PlaneReservation {
  /** `thread`: an admitted ask's hold. `steer`: a checkpoint steer's dedupe
   *  row, key `<runId>#<round>#<cause>` — the fixed sentence lands at most
   *  once per run per round per cause and once per round in all (record 0064,
   *  "The backpressure contract"). `park`: a run whose turn the proxy could
   *  not complete, key `<provider>#<runId>`, waiting on `provider_up`. */
  kind: "thread" | "steer" | "park";
  key: string;
  runId: string;
  at: number;
}

/** One queued ask: the `plane_queue` row. `position` counts the waiting rows
 *  ahead of it on the same conditions when it queued — the number a person is
 *  told, never recomputed for them. */
export interface PlaneQueueRow {
  runId: string;
  requester: string;
  threadKey: string;
  stage: PlaneStage;
  /** The stored request, replayed verbatim when the row is admitted (the transport unit). */
  request: Record<string, unknown>;
  conditions: PlaneCondition[];
  position: number;
  queuedAt: number;
  state: "waiting" | "admitted" | "withdrawn";
}

/** What the decider knows: the queue and the threads with a live run. The
 *  object builds it from its own tables inside the same transaction that
 *  commits the answer. */
export interface PlaneState {
  queue: PlaneQueueRow[];
  liveThreads: string[];
  /** Threads an admitted ask holds before its claim lands (or after, until the seal). */
  reservations: PlaneReservation[];
  /** Open window kinds; `deploy` is the pending-deploy window (`deploy_settled` is its absence). */
  openWindows: string[];
  /** The residents' last level reports (`plane_levels`), one row per resident and name. */
  levels: PlaneLevelRow[];
}

export function emptyPlaneState(): PlaneState {
  return { queue: [], liveThreads: [], reservations: [], openWindows: [], levels: [] };
}

/** The window kind behind `deploy_settled`: opened while a deploy is pending,
 *  lifted by the deploy runner's `deploy.landed` post (record 0064). */
export const DEPLOY_WINDOW = "deploy";

/** The window behind the resident fleet's drain (resident-repos item 69):
 *  opened by the registry's `set` post, lifted by its `cleared` or — from the
 *  registry's one alarm at `until` — `expired` post. A `restartOf` claim
 *  passes it like every window: the drain never refuses a run it waits for. */
export const RESIDENT_DRAIN_WINDOW = "resident-drain";

/** The closed event union. `ask`: may this run start now; `sealed`: a thread's
 *  live run ended (the ledger's seal, the event that flips `thread_free`);
 *  `withdraw`: the requester gave the wait up (`runs stop` on a queued id, the transport unit). */
export interface PlaneAskEvent {
  kind: "ask";
  at: number;
  runId: string;
  requester: string;
  threadKey: string;
  stage: PlaneStage;
  request: Record<string, unknown>;
  /** The resident the ask is for (stage `resident` only): its seat and memory
   *  levels become the ask's conditions. */
  resident?: string;
  /** A restart of a run the resident already holds (record 0064): it
   *  passes the windows and the memory line — its worktree lives there or
   *  nowhere, and the drain never refuses a run it waits for. */
  restartOf?: boolean;
}
/** The facts one heartbeat carries (record 0064, "The backpressure contract"):
 *  the round index, the in-flight call with its declared bound, the last
 *  event's time and the newest pushed head. The bot assembles them from what
 *  its write-through already sees; every stamp is one it was given, never a
 *  clock it read. */
export interface HeartbeatFacts {
  /** The round index: the run's step counter — a steer lands at most once per round. */
  round: number;
  /** Whether this is a coding (write-preset) run: only those are steered. */
  coding: boolean;
  /** The run's start — the no-push clock's floor before any head is pushed. */
  startedAt: number;
  /** The call in flight, its declared bound (a bash timeout) when it stated one,
   *  and when the run's stream last moved as it went out. */
  inFlight?: { callId: string; tool: string; sinceAt: number; boundMs?: number };
  /** The last event's time on the run's stream. */
  lastEventAt?: number;
  /** The newest pushed head the stream carried (`pushed_head`, with its `clean` fact). */
  pushedHead?: { ref: string; sha: string; at: number; clean?: boolean };
}

/** The checkpoint steer's one fixed sentence (record 0064): the same words for
 *  every cause, so a person and a child read one instruction, never a variant. */
export const CHECKPOINT_STEER_SENTENCE =
  "finish the step you are on, push a checkpoint and end the round; start no new command; the resident takes your push";

/** The steer that re-issues a held turn once its provider reports up (record 0064). */
export function reissueSteerSentence(provider: string): string {
  return `the model provider ${provider} is answering again — re-issue the held turn and continue`;
}

/** The reissue steer read back (model-proxy item 12a): what the pi harness
 *  releases a held turn on — the sentence above with any provider's name,
 *  judged whole against the inbox row's text beside its `plane` sender, so a
 *  parked turn is only re-driven by the plane's own words, never a person's
 *  follow-up that happens to mention a provider. */
export function isReissueSteerText(text: string): boolean {
  return /^the model provider .+ is answering again — re-issue the held turn and continue$/.test(text.trim());
}

/** The checkpoint steer's causes: an in-flight call past its bound (or the
 *  no-bound line) and a coding round with no pushed head past `noPushMinutes`. */
export type SteerCause = "long_call" | "no_push";

/** The `dirty_at_approval` move's one brief (record 0064, "Endings and the
 *  watches"): what the fix round on the unit's coding lane is told — the
 *  reviewed-head gate voids the approval at the new head, and re-review
 *  follows, so the brief asks only for the rebase and the push. */
export const REBASE_ROUND_BRIEF = "rebase onto the base and push";

export type PlaneEvent =
  | PlaneAskEvent
  | { kind: "sealed"; at: number; threadKey: string }
  | { kind: "withdraw"; at: number; runId: string }
  /** One heartbeat's facts (record 0064): judged for the checkpoint steer.
   *  `noPushMs`/`noBoundMs` override the defaults (tests, config — a later
   *  unit's `plane.noPushMinutes`). */
  | { kind: "heartbeat"; at: number; runId: string; facts: HeartbeatFacts; noPushMs?: number; noBoundMs?: number }
  /** A provider's level as the model proxy reported it: `up` on a relayed
   *  success, `down` on a failure past its one retry. `up` re-issues every
   *  turn held parked on the provider, once each. */
  | { kind: "provider_level"; at: number; provider: string; level: "up" | "down" }
  /** A run parked on its provider (record 0064): the harness holds the turn,
   *  the lease keeps counting, and the provider's next `up` steers it once. */
  | { kind: "park"; at: number; runId: string; provider: string }
  /** A window's open or lift (`window_open`); kind `deploy` is the pending deploy (`deploy_settled`). */
  | { kind: "window"; at: number; window: string; phase: "opened" | "lifted" }
  /** A resident's level report (record 0064): forwarded by the bot from the levels a
   *  resident answer carried, or posted from the registry's outbox. A `below`
   *  side walks the queue — the event that admits a waiting resident ask. */
  | {
      kind: "level";
      at: number;
      resident: string;
      name: "seat" | "memory";
      side: "below" | "above";
      generation: string;
    }
  /** A refusal-by-name the bot met at attach or exec (record 0064): an admitted run
   *  that meets one re-enters the queue at its old position, waiting on the
   *  condition the refusal names, instead of falling cold. */
  | { kind: "observation"; at: number; runId: string; resident: string; refusal: string }
  /** The re-ask cadence (record 0064; `plane.reaskMinutes`): while a queued run
   *  waits on a resident that has said nothing within the cadence, one
   *  `probe(resident)` effect is emitted — a silent resident is probed, never
   *  waited on forever. */
  | { kind: "reask"; at: number; cadenceMs: number }
  /** A tracked pull request's title as the bot read it (`pr_opened`; the
   *  adoption read), already judged against the title rule (`check:pr-title`)
   *  by the caller — the decider is node-free and holds no vocabulary. A
   *  failing title is the `unit_title` watch (record 0064): the move is one
   *  `retitle` effect under the same rule. */
  | { kind: "pr_tracked"; at: number; repo: string; number: number; titleOk: boolean }
  /** A child's seal, with the facts the `orphaned_child` watch reads (record
   *  0064): the branch its newest `pushed_head` named, the pull request its
   *  record holds, and whether a runner instance is live over it. */
  | {
      kind: "child_sealed";
      at: number;
      runId: string;
      runnerLive: boolean;
      repo?: string;
      branch?: string;
      prNumber?: number;
    }
  /** An approval as the merge door's pr-check read it (record 0064): the
   *  `dirty_at_approval` watch fires on `mergeableState: dirty` at an approved
   *  head — the move is a `rebase_round` effect on the unit's coding lane. */
  | { kind: "approval"; at: number; repo: string; number: number; headSha: string; mergeableState?: string }
  /** The engine's status for a runner instance (record 0064): read at the
   *  bot's status report, the re-ask while a seed waits, and the deadline
   *  alarm. `runner_gone` — `errored` or `terminated` with units unfinished,
   *  or the hosting deadline passed on an instance not `waiting` — emits one
   *  `reissue` keyed by the attempt number. */
  | {
      kind: "runner_status";
      at: number;
      instanceId: string;
      status: string;
      unfinishedUnits: string[];
      attempt: number;
      deadlinePassed?: boolean;
    };

/** The closed effect union: what the bot is asked to do, offered on its
 *  heartbeat and reclaim answers and acknowledged by id (`/plane/ack`). The
 *  id is derived from the run, so a duplicate offer after a roll is the same
 *  effect, acknowledged once. The transport unit adds execution; this one only shapes and stores. */
export type PlaneEffect =
  | {
      id: string;
      kind: "admit";
      runId: string;
      threadKey: string;
      request: Record<string, unknown>;
    }
  /** Ask the bot to probe the resident's `/status` and forward its levels
   *  (record 0064): the id is `probe:<resident>`, so the object holds at most one
   *  open probe per resident and a duplicate offer is the same effect. */
  | { id: string; kind: "probe"; resident: string }
  /** The `unit_title` move (record 0064): retitle the pull request under the
   *  title rule — the bot re-reads the title before acting, so a person's own
   *  retitle first makes this a `skipped`. Id `retitle:<repo>#<number>`. */
  | { id: string; kind: "retitle"; repo: string; number: number }
  /** The `orphaned_child` move (record 0064): open the pull request from the
   *  pushed branch — the same open-or-edit the recover pr-check uses, titled
   *  by the head commit's subject when it passes the title rule. A pull
   *  request already heading the branch makes this a `skipped`. */
  | { id: string; kind: "pr_open"; repo: string; branch: string; runId: string }
  /** The `dirty_at_approval` move (record 0064): a fix round on the unit's
   *  coding lane briefed `REBASE_ROUND_BRIEF`; the reviewed-head gate voids
   *  the approval at the new head and re-review follows. */
  | { id: string; kind: "rebase_round"; repo: string; number: number; headSha: string; brief: string }
  /** The `runner_gone` move (record 0064): re-issue the plan's remaining
   *  units as the next attempt — the id carries the attempt number, so a
   *  status read twice offers the same effect once. */
  | { id: string; kind: "reissue"; instanceId: string; attempt: number; units: string[] };

/** What the object must persist beside the returned state — the decider names
 *  the rows, the object owns the SQL, both inside one `transactionSync`. */
export type PlaneWrite =
  | { table: "plane_levels"; op: "put"; row: PlaneLevelRow }
  | { table: "plane_queue"; op: "put"; row: PlaneQueueRow }
  | { table: "plane_queue"; op: "state"; runId: string; state: PlaneQueueRow["state"] }
  | { table: "plane_effects"; op: "offer"; effect: PlaneEffect; at: number }
  | { table: "plane_reservations"; op: "put"; row: PlaneReservation }
  | { table: "plane_reservations"; op: "del"; key: string; kind?: PlaneReservation["kind"] }
  | { table: "plane_windows"; op: "put"; window: string; at: number }
  | { table: "plane_windows"; op: "del"; window: string }
  /** A steer into a live run's durable inbox (run-history item 40), written in
   *  the decider's transaction: the row's sender is `plane` (record 0057's
   *  amendment), and the run reads it at its next boundary like any follow-up. */
  | { table: "run_inbox"; op: "push"; runId: string; message: Record<string, unknown> }
  /** A finding (record 0064): filed when no move applies, keyed by watch and
   *  subject — the object folds it with `mergePlaneFindings`, so two findings
   *  on one subject are one row with a merged timeline. */
  | { table: "plane_findings"; op: "put"; finding: PlaneFinding };

/** The bot's own outcome for one dispatch, posted to `POST /plane/outcome`
 *  under `plane.admission: shadow` (orchestration-plane item 8): `proceeded`, `refused:<code>` or
 *  `fell_cold:<token>` — the ledger object logs the decider's word beside it.
 *  `runId` is absent when the dispatch never minted one (a refusal). */
export interface PlaneOutcomePost {
  runId?: string;
  requester: string;
  threadKey: string;
  stage: PlaneStage;
  outcome: string;
}

/** How the bot answers an offered effect (orchestration-plane item 7): `done` and `skipped` close it,
 *  `deferred` leaves it on the next heartbeat or reclaim answer. */
export type PlaneAckOutcome = "done" | "skipped" | "deferred";

/** The effect bounds (record 0064, "Where it lives"): a run holds at most this
 *  many open effects, the object at most the total — an offer past either is
 *  refused by the cap's name, never queued silently. */
export const PLANE_EFFECTS_PER_RUN_CAP = 4;
export const PLANE_EFFECTS_TOTAL_CAP = 256;

/** The named refusal an over-cap offer gets (the object counts, this judges). */
export function effectCapRefusal(counts: { total: number; forRun: number }, effect: PlaneEffect): string | undefined {
  if (counts.total >= PLANE_EFFECTS_TOTAL_CAP)
    return `plane_effects total cap (${PLANE_EFFECTS_TOTAL_CAP}): effect ${effect.id} refused`;
  if (counts.forRun >= PLANE_EFFECTS_PER_RUN_CAP)
    return `plane_effects per-run cap (${PLANE_EFFECTS_PER_RUN_CAP}): effect ${effect.id} refused`;
  return undefined;
}

export interface PlaneDecision {
  state: PlaneState;
  effects: PlaneEffect[];
  writes: PlaneWrite[];
}

/** One event in, the next state out, with the writes and effects that carry
 *  it — and nothing else: no transition, no writes (the state comes back as
 *  given). Never throws: an event about a run or thread the state does not
 *  know is a no-op, because the object replays outcomes from a bot whose view
 *  can be older than the tables. */
export function decide(state: PlaneState, event: PlaneEvent): PlaneDecision {
  switch (event.kind) {
    case "ask":
      return onAsk(state, event);
    case "sealed":
      return onSealed(state, event);
    case "withdraw":
      return onWithdraw(state, event);
    case "window":
      return onWindow(state, event);
    case "level":
      return onLevel(state, event);
    case "observation":
      return onObservation(state, event);
    case "reask":
      return onReask(state, event);
    case "heartbeat":
      return onHeartbeat(state, event);
    case "provider_level":
      return onProviderLevel(state, event);
    case "park":
      return onPark(state, event);
    case "pr_tracked":
      return onPrTracked(state, event);
    case "child_sealed":
      return onChildSealed(state, event);
    case "approval":
      return onApproval(state, event);
    case "runner_status":
      return onRunnerStatus(state, event);
  }
}

/** One finding as the moves shape it: the watch, the subject, one event —
 *  the object folds it by `planeFindingKey` (watch and subject), so the same
 *  incident observed twice is one finding with a merged timeline. */
function findingOf(watch: string, subject: string, at: number, what: string): PlaneFinding {
  return { watch, subject, timeline: [{ at, what }], firstAt: at, lastAt: at };
}

/** `unit_title` (record 0064): a tracked pull request whose title fails the
 *  rule gets one `retitle` effect under the same rule; a passing title is a
 *  no-op. The id is the pull request's, so a re-read offers the same effect. */
function onPrTracked(
  state: PlaneState,
  event: { kind: "pr_tracked"; at: number; repo: string; number: number; titleOk: boolean },
): PlaneDecision {
  if (event.titleOk) return { state, effects: [], writes: [] };
  const effect: PlaneEffect = {
    id: `retitle:${event.repo}#${event.number}`,
    kind: "retitle",
    repo: event.repo,
    number: event.number,
  };
  return { state, effects: [effect], writes: [{ table: "plane_effects", op: "offer", effect, at: event.at }] };
}

/** `orphaned_child` (record 0064): a child that ends with a pushed branch, no
 *  pull request and no live runner gets a `pr_open` effect from the branch. A
 *  seal with a pull request, a live runner or no pushed branch is a no-op; a
 *  pushed branch whose repository the seal could not name is a finding — the
 *  move needs a fact the plane lacks, so it degrades instead of guessing. */
function onChildSealed(
  state: PlaneState,
  event: {
    kind: "child_sealed";
    at: number;
    runId: string;
    runnerLive: boolean;
    repo?: string;
    branch?: string;
    prNumber?: number;
  },
): PlaneDecision {
  if (event.runnerLive || event.prNumber !== undefined || event.branch === undefined)
    return { state, effects: [], writes: [] };
  if (event.repo === undefined) {
    const finding = findingOf(
      "orphaned_child",
      event.runId,
      event.at,
      `the run sealed with pushed branch ${event.branch}, no pull request and no live runner, and no repository is known to open one on`,
    );
    return { state, effects: [], writes: [{ table: "plane_findings", op: "put", finding }] };
  }
  const effect: PlaneEffect = {
    id: `pr_open:${event.repo}#${event.branch}`,
    kind: "pr_open",
    repo: event.repo,
    branch: event.branch,
    runId: event.runId,
  };
  return { state, effects: [effect], writes: [{ table: "plane_effects", op: "offer", effect, at: event.at }] };
}

/** `dirty_at_approval` (record 0064): `mergeableState: dirty` on an approved
 *  head opens a fix round on the unit's coding lane briefed to rebase and
 *  push; any other mergeable state — clean, unknown, unread — is a no-op. The
 *  id carries the head, so the same dirty head offers one round. */
function onApproval(
  state: PlaneState,
  event: { kind: "approval"; at: number; repo: string; number: number; headSha: string; mergeableState?: string },
): PlaneDecision {
  if (event.mergeableState !== "dirty") return { state, effects: [], writes: [] };
  const effect: PlaneEffect = {
    id: `rebase_round:${event.repo}#${event.number}@${event.headSha}`,
    kind: "rebase_round",
    repo: event.repo,
    number: event.number,
    headSha: event.headSha,
    brief: REBASE_ROUND_BRIEF,
  };
  return { state, effects: [effect], writes: [{ table: "plane_effects", op: "offer", effect, at: event.at }] };
}

/** `runner_gone` (record 0064): the engine reports `errored` or `terminated`
 *  with units unfinished, or the hosting deadline passed on an instance the
 *  engine does not report `waiting` — one `reissue(plan, remaining units)`
 *  keyed by the attempt number, so a status read twice is the same effect. A
 *  plan with nothing unfinished has no move — the precondition is gone. */
function onRunnerStatus(
  state: PlaneState,
  event: {
    kind: "runner_status";
    at: number;
    instanceId: string;
    status: string;
    unfinishedUnits: string[];
    attempt: number;
    deadlinePassed?: boolean;
  },
): PlaneDecision {
  const ended = event.status === "errored" || event.status === "terminated";
  const overdue = event.deadlinePassed === true && event.status !== "waiting";
  if ((!ended && !overdue) || event.unfinishedUnits.length === 0) return { state, effects: [], writes: [] };
  const effect: PlaneEffect = {
    id: `reissue:${event.instanceId}#${event.attempt}`,
    kind: "reissue",
    instanceId: event.instanceId,
    attempt: event.attempt,
    units: event.unfinishedUnits,
  };
  return { state, effects: [effect], writes: [{ table: "plane_effects", op: "offer", effect, at: event.at }] };
}

/** The inbox row a plane steer writes: sender `plane` (record 0064), the sentence as
 *  the text, and the cause under `plane` so the run page can say why. */
function planeInboxMessage(text: string, at: number, plane: Record<string, unknown>): Record<string, unknown> {
  return { text, at, userId: "plane", userName: "plane", plane };
}

/** The checkpoint steer (record 0064, "The backpressure contract"): a stalled
 *  or push-less coding run reads one fixed sentence at its next boundary. At
 *  most one reservation per run per round per cause, and — the sentence being
 *  the same for every cause — one inbox row per run per round: a second
 *  heartbeat in the same round writes none, a new round writes one again. */
function onHeartbeat(
  state: PlaneState,
  event: { kind: "heartbeat"; at: number; runId: string; facts: HeartbeatFacts; noPushMs?: number; noBoundMs?: number },
): PlaneDecision {
  const { facts } = event;
  if (!facts.coding) return { state, effects: [], writes: [] };
  const noPushMs = event.noPushMs ?? minutesToMs(PLANE.noPushMinutes);
  const noBoundMs = event.noBoundMs ?? minutesToMs(PLANE.noBoundMinutes);
  const causes: SteerCause[] = [];
  if (facts.inFlight && event.at - facts.inFlight.sinceAt > (facts.inFlight.boundMs ?? noBoundMs))
    causes.push("long_call");
  if (event.at - Math.max(facts.pushedHead?.at ?? 0, facts.startedAt) > noPushMs) causes.push("no_push");
  const roundPrefix = `${event.runId}#${facts.round}#`;
  const seen = (cause: SteerCause) =>
    state.reservations.some((r) => r.kind === "steer" && r.key === `${roundPrefix}${cause}`);
  const fresh = causes.filter((c) => !seen(c));
  if (fresh.length === 0) return { state, effects: [], writes: [] };
  const roundSteered = state.reservations.some((r) => r.kind === "steer" && r.key.startsWith(roundPrefix));
  const rows: PlaneReservation[] = fresh.map((cause) => ({
    kind: "steer",
    key: `${roundPrefix}${cause}`,
    runId: event.runId,
    at: event.at,
  }));
  const writes: PlaneWrite[] = rows.map((row) => ({ table: "plane_reservations", op: "put", row }));
  if (!roundSteered)
    writes.push({
      table: "run_inbox",
      op: "push",
      runId: event.runId,
      message: planeInboxMessage(CHECKPOINT_STEER_SENTENCE, event.at, {
        steer: "checkpoint",
        causes: fresh,
        round: facts.round,
      }),
    });
  return { state: { ...state, reservations: [...state.reservations, ...rows] }, effects: [], writes };
}

/** A provider's level (record 0064): the row is written under name `provider`
 *  (`up` ≡ `below`, `down` ≡ `above`), and an `up` re-issues every turn held
 *  parked on the provider — one steer each, the park row deleted with it —
 *  then walks the queue for anything waiting on `provider_up`. */
function onProviderLevel(
  state: PlaneState,
  event: { kind: "provider_level"; at: number; provider: string; level: "up" | "down" },
): PlaneDecision {
  const row: PlaneLevelRow = {
    resident: event.provider,
    name: "provider",
    side: event.level === "up" ? "below" : "above",
    reportedAt: event.at,
    generation: "",
  };
  const levels = [...state.levels.filter((l) => !(l.resident === event.provider && l.name === "provider")), row];
  const writes: PlaneWrite[] = [{ table: "plane_levels", op: "put", row }];
  let next = { ...state, levels };
  if (event.level === "down") return { state: next, effects: [], writes };
  const parked = next.reservations.filter((r) => r.kind === "park" && r.key.startsWith(`${event.provider}#`));
  for (const p of parked) {
    writes.push({
      table: "run_inbox",
      op: "push",
      runId: p.runId,
      message: planeInboxMessage(reissueSteerSentence(event.provider), event.at, {
        steer: "reissue",
        provider: event.provider,
      }),
    });
    writes.push({ table: "plane_reservations", op: "del", key: p.key, kind: "park" });
  }
  if (parked.length > 0) next = { ...next, reservations: next.reservations.filter((r) => !parked.includes(r)) };
  const walked = walk(next, event.at);
  return { ...walked, writes: [...writes, ...walked.writes] };
}

/** A run parked on its provider: one park row — a second park of the same run
 *  on the same provider is the same wait, never a second steer later. */
function onPark(
  state: PlaneState,
  event: { kind: "park"; at: number; runId: string; provider: string },
): PlaneDecision {
  const key = `${event.provider}#${event.runId}`;
  if (state.reservations.some((r) => r.kind === "park" && r.key === key)) return { state, effects: [], writes: [] };
  const row: PlaneReservation = { kind: "park", key, runId: event.runId, at: event.at };
  return {
    state: { ...state, reservations: [...state.reservations, row] },
    effects: [],
    writes: [{ table: "plane_reservations", op: "put", row }],
  };
}

/** The `/plane/admit` answer (record 0064, "The queue"): `admitted` with the
 *  reservation the decision wrote, or `queued` with the row's id, its position
 *  and the conditions it waits on. */
export type PlaneAskAnswer =
  | { kind: "admitted"; reservation: string }
  | { kind: "queued"; id: string; position: number; waiting: PlaneCondition[] };

export function planeAskAnswerOf(decision: PlaneDecision, runId: string): PlaneAskAnswer {
  const row = decision.state.queue.find((r) => r.runId === runId);
  return row && row.state === "waiting"
    ? { kind: "queued", id: runId, position: row.position, waiting: row.conditions }
    : { kind: "admitted", reservation: runId };
}

/** The shadow word for an ask the decider just judged (orchestration-plane item 8): `queued` when the
 *  decision holds a waiting row for the run, `proceed` when it holds none —
 *  what the object logs beside the bot's own outcome. */
export function planeAskWordOf(decision: PlaneDecision, runId: string): "proceed" | "queued" {
  const row = decision.state.queue.find((r) => r.runId === runId);
  return row && row.state === "waiting" ? "queued" : "proceed";
}

/** The queue's waiting words (record 0064, "The queue"): what a person is
 *  told the row waits on — the queued reply in the thread and the queued id's
 *  page say the same thing, so the two surfaces cannot drift. */
export function waitingWords(waiting: PlaneCondition[]): string {
  if (waiting.length === 0) return "its turn";
  return waiting
    .map((c) =>
      c.kind === "thread_free"
        ? "the thread's live run"
        : c.kind === "deploy_settled"
          ? "the pending deploy"
          : c.kind === "seat"
            ? `a seat on ${c.resident}`
            : c.kind === "memory"
              ? `memory on ${c.resident}`
              : c.kind === "provider_up"
                ? `the ${c.provider} provider`
                : `the ${c.window} window`,
    )
    .join(", then ");
}

/** The unmet conditions an ask meets right now. The admission stage asks the
 *  thread and the windows; the resident stage asks the windows and the
 *  resident's own levels — its thread is already this run's (reserved at
 *  admission), so it is never a condition there. A `restartOf` ask passes the
 *  windows and the memory line (record 0064); an `unknown` level is not a wait — the
 *  bot falls cold for it (record 0064) — so only a reported `above` side queues. */
function unmetConditionsOf(state: PlaneState, event: PlaneAskEvent): PlaneCondition[] {
  const out: PlaneCondition[] = [];
  if (
    event.stage === "admission" &&
    (state.liveThreads.includes(event.threadKey) ||
      state.reservations.some((r) => r.kind === "thread" && r.key === event.threadKey))
  )
    out.push({ kind: "thread_free", threadKey: event.threadKey, met: false });
  if (!event.restartOf)
    for (const w of state.openWindows)
      out.push(
        w === DEPLOY_WINDOW ? { kind: "deploy_settled", met: false } : { kind: "window_open", window: w, met: false },
      );
  if (event.stage === "resident" && event.resident !== undefined) {
    if (residentSideOf(state.levels, event.resident, "seat") === "above")
      out.push({ kind: "seat", resident: event.resident, met: false });
    if (!event.restartOf && residentSideOf(state.levels, event.resident, "memory") === "above")
      out.push({ kind: "memory", resident: event.resident, met: false });
  }
  return out;
}

/** The condition a refusal-by-name waits on (record 0064): the pool's is the seat,
 *  the gate's the memory line, the drain's its window; a replaced or
 *  unreachable runtime waits on the resident's next seat report (the probe
 *  reaches it). An unrecognized refusal maps to nothing — the observation is
 *  a no-op and the bot's own fallback stands. */
export function conditionOfRefusal(refusal: string, resident: string): PlaneCondition | undefined {
  if (refusal.startsWith("user-pool-exhausted")) return { kind: "seat", resident, met: false };
  if (refusal.startsWith("memory-pressure")) return { kind: "memory", resident, met: false };
  if (refusal.startsWith("draining")) return { kind: "window_open", window: RESIDENT_DRAIN_WINDOW, met: false };
  if (refusal.startsWith("runtime-unreachable") || refusal.startsWith("runtime-replaced"))
    return { kind: "seat", resident, met: false };
  return undefined;
}

/** Whether two conditions are the same wait: same kind, same subject. */
function sameCondition(a: PlaneCondition, b: PlaneCondition): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "thread_free" && b.kind === "thread_free") return a.threadKey === b.threadKey;
  if (a.kind === "window_open" && b.kind === "window_open") return a.window === b.window;
  if ((a.kind === "seat" && b.kind === "seat") || (a.kind === "memory" && b.kind === "memory"))
    return a.resident === b.resident;
  if (a.kind === "provider_up" && b.kind === "provider_up") return a.provider === b.provider;
  return true; // deploy_settled has one subject
}

function onAsk(state: PlaneState, event: PlaneAskEvent): PlaneDecision {
  const conditions = unmetConditionsOf(state, event);
  if (conditions.length === 0) {
    // The resident stage's ask holds nothing new on admission: its thread was
    // reserved at the admission stage under this same run, so a reservation
    // here would only shadow it.
    if (event.stage === "resident") return { state, effects: [], writes: [] };
    // Admitted: the thread is reserved in the same transaction (record 0064,
    // "The queue") so a second ask a moment later queues; the ledger claim
    // promotes the reservation and the seal deletes it.
    const reservation: PlaneReservation = { kind: "thread", key: event.threadKey, runId: event.runId, at: event.at };
    return {
      state: { ...state, reservations: [...state.reservations, reservation] },
      effects: [],
      writes: [{ table: "plane_reservations", op: "put", row: reservation }],
    };
  }
  // Position (record 0064): the rank among queued runs sharing an unmet condition.
  const waitingAhead = state.queue.filter(
    (r) => r.state === "waiting" && r.conditions.some((c) => conditions.some((n) => sameCondition(c, n))),
  ).length;
  const row: PlaneQueueRow = {
    runId: event.runId,
    requester: event.requester,
    threadKey: event.threadKey,
    stage: event.stage,
    request: event.request,
    conditions,
    position: waitingAhead + 1,
    queuedAt: event.at,
    state: "waiting",
  };
  return {
    state: { ...state, queue: [...state.queue, row] },
    effects: [],
    writes: [{ table: "plane_queue", op: "put", row }],
  };
}

function onSealed(state: PlaneState, event: { kind: "sealed"; at: number; threadKey: string }): PlaneDecision {
  const liveThreads = state.liveThreads.filter((t) => t !== event.threadKey);
  const reservations = state.reservations.filter((r) => r.kind !== "thread" || r.key !== event.threadKey);
  const freed = liveThreads.length !== state.liveThreads.length || reservations.length !== state.reservations.length;
  if (!freed && !hasWaiting(state, event.threadKey)) return { state, effects: [], writes: [] };
  const writes: PlaneWrite[] =
    reservations.length !== state.reservations.length
      ? [{ table: "plane_reservations", op: "del", key: event.threadKey }]
      : [];
  const walked = walk({ ...state, liveThreads, reservations }, event.at);
  return { ...walked, writes: [...writes, ...walked.writes] };
}

function onWindow(
  state: PlaneState,
  event: { kind: "window"; at: number; window: string; phase: string },
): PlaneDecision {
  if (event.phase === "opened") {
    if (state.openWindows.includes(event.window)) return { state, effects: [], writes: [] };
    return {
      state: { ...state, openWindows: [...state.openWindows, event.window] },
      effects: [],
      writes: [{ table: "plane_windows", op: "put", window: event.window, at: event.at }],
    };
  }
  if (!state.openWindows.includes(event.window)) return { state, effects: [], writes: [] };
  const next = { ...state, openWindows: state.openWindows.filter((w) => w !== event.window) };
  const walked = walk(next, event.at);
  return { ...walked, writes: [{ table: "plane_windows", op: "del", window: event.window }, ...walked.writes] };
}

/** A level report (record 0064): the row is upserted, and a `below` side walks the
 *  queue — the admitting event for every resident condition. An unchanged
 *  side is still written (the report time and generation move), but only a
 *  crossing to `below` can admit, and the walk judges that. */
function onLevel(
  state: PlaneState,
  event: {
    kind: "level";
    at: number;
    resident: string;
    name: "seat" | "memory";
    side: "below" | "above";
    generation: string;
  },
): PlaneDecision {
  const row: PlaneLevelRow = {
    resident: event.resident,
    name: event.name,
    side: event.side,
    reportedAt: event.at,
    generation: event.generation,
  };
  const levels = [...state.levels.filter((l) => !(l.resident === event.resident && l.name === event.name)), row];
  const next = { ...state, levels };
  const write: PlaneWrite = { table: "plane_levels", op: "put", row };
  if (event.side === "above") return { state: next, effects: [], writes: [write] };
  const walked = walk(next, event.at);
  return { ...walked, writes: [write, ...walked.writes] };
}

/** A refusal-by-name met by an admitted run (record 0064): its queue row re-enters
 *  `waiting` at its old position on the refusal's condition, and a seat or
 *  memory refusal is itself evidence of the side — the level row is written
 *  `above` so the walk does not re-admit the run into the same refusal. A run
 *  the queue never held, or a refusal with no condition, is a no-op. */
function onObservation(
  state: PlaneState,
  event: { kind: "observation"; at: number; runId: string; resident: string; refusal: string },
): PlaneDecision {
  const row = state.queue.find((r) => r.runId === event.runId && r.state === "admitted");
  const condition = conditionOfRefusal(event.refusal, event.resident);
  if (!row || !condition) return { state, effects: [], writes: [] };
  const reentered: PlaneQueueRow = { ...row, state: "waiting", conditions: [condition] };
  const writes: PlaneWrite[] = [{ table: "plane_queue", op: "put", row: reentered }];
  let levels = state.levels;
  if (condition.kind === "seat" || condition.kind === "memory") {
    // The refusal names no generation, so the row keeps the resident's last
    // known one (any name) — a refusal is evidence about the resident as it
    // reports now, not about an older build.
    const prior =
      state.levels.find((l) => l.resident === event.resident && l.name === condition.kind) ??
      state.levels.find((l) => l.resident === event.resident);
    const level: PlaneLevelRow = {
      resident: event.resident,
      name: condition.kind,
      side: "above",
      reportedAt: event.at,
      generation: prior?.generation ?? "",
    };
    levels = [...state.levels.filter((l) => !(l.resident === event.resident && l.name === condition.kind)), level];
    writes.push({ table: "plane_levels", op: "put", row: level });
  }
  return {
    state: { ...state, queue: state.queue.map((r) => (r === row ? reentered : r)), levels },
    effects: [],
    writes,
  };
}

/** The re-ask cadence (record 0064): for every resident a waiting row waits on
 *  whose last report is older than the cadence (or that never reported), one
 *  `probe` effect — id `probe:<resident>`, so the object holds at most one
 *  open probe per resident. Nothing else moves: the probe's answer arrives as
 *  a level event and that walks the queue. */
function onReask(state: PlaneState, event: { kind: "reask"; at: number; cadenceMs: number }): PlaneDecision {
  const waitedOn = new Set<string>();
  for (const r of state.queue)
    if (r.state === "waiting")
      for (const c of r.conditions) if (c.kind === "seat" || c.kind === "memory") waitedOn.add(c.resident);
  const effects: PlaneEffect[] = [];
  const writes: PlaneWrite[] = [];
  for (const resident of [...waitedOn].sort()) {
    const latest = Math.max(0, ...state.levels.filter((l) => l.resident === resident).map((l) => l.reportedAt));
    if (latest > event.at - event.cadenceMs) continue;
    const effect: PlaneEffect = { id: `probe:${resident}`, kind: "probe", resident };
    effects.push(effect);
    writes.push({ table: "plane_effects", op: "offer", effect, at: event.at });
  }
  return { state, effects, writes };
}

function onWithdraw(state: PlaneState, event: { kind: "withdraw"; at: number; runId: string }): PlaneDecision {
  const row = state.queue.find((r) => r.runId === event.runId && r.state === "waiting");
  if (!row) return { state, effects: [], writes: [] };
  const queue = state.queue.map((r) => (r === row ? { ...r, state: "withdrawn" as const } : r));
  return {
    state: { ...state, queue },
    effects: [],
    writes: [{ table: "plane_queue", op: "state", runId: event.runId, state: "withdrawn" }],
  };
}

function hasWaiting(state: PlaneState, threadKey: string): boolean {
  return state.queue.some((r) => r.state === "waiting" && r.threadKey === threadKey);
}

/** The queue walk (record 0064): oldest first, and the state is re-evaluated
 *  after each admission — an admitted run's thread is live again, so a second
 *  row on the same thread keeps waiting for the next seal. */
function walk(state: PlaneState, at: number): PlaneDecision {
  let next = state;
  const effects: PlaneEffect[] = [];
  const writes: PlaneWrite[] = [];
  for (;;) {
    const row = next.queue.find((r) => r.state === "waiting" && conditionsMet(next, r));
    if (!row) break;
    const admitted: PlaneQueueRow = { ...row, state: "admitted" };
    const effect: PlaneEffect = {
      id: `admit:${row.runId}`,
      kind: "admit",
      runId: row.runId,
      threadKey: row.threadKey,
      request: row.request,
    };
    // The admitted run reserves its thread like a fresh admission does, so the
    // ledger claim under its id promotes the same row and a rival ask queues.
    const reservation: PlaneReservation = { kind: "thread", key: row.threadKey, runId: row.runId, at };
    next = {
      ...next,
      queue: next.queue.map((r) => (r === row ? admitted : r)),
      reservations: [...next.reservations, reservation],
    };
    effects.push(effect);
    writes.push({ table: "plane_queue", op: "state", runId: row.runId, state: "admitted" });
    writes.push({ table: "plane_effects", op: "offer", effect, at });
    writes.push({ table: "plane_reservations", op: "put", row: reservation });
  }
  return { state: next, effects, writes };
}

function conditionsMet(state: PlaneState, row: PlaneQueueRow): boolean {
  return row.conditions.every((c) => {
    switch (c.kind) {
      case "thread_free":
        return (
          !state.liveThreads.includes(c.threadKey) &&
          !state.reservations.some((r) => r.kind === "thread" && r.key === c.threadKey)
        );
      case "window_open":
        return !state.openWindows.includes(c.window);
      case "deploy_settled":
        return !state.openWindows.includes(DEPLOY_WINDOW);
      // A resident condition is met only by a reported `below` side: an
      // `unknown` resident admits nothing — the probe reaches it first (record 0064).
      case "seat":
        return residentSideOf(state.levels, c.resident, "seat") === "below";
      case "memory":
        return residentSideOf(state.levels, c.resident, "memory") === "below";
      // A provider condition is met only by the proxy's `up` report (stored `below`).
      case "provider_up":
        return residentSideOf(state.levels, c.provider, "provider") === "below";
    }
  });
}
