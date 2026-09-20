// Types only, and from the zod-free module deliberately: this file is part of
// the node-free contract the memory Worker and web app compile with their own
// tsconfigs — importing prDescription.ts would drag zod into those graphs.
import type { DescriptionIssue, PrDescription, RecordedJson, RenderedPointer } from "./prDescriptionTypes.js";
import type { HarnessScope } from "./harness/scope.js";
import type { ModelCard } from "./modelCard.js";

/** The `pr_description` review artifact minus the event envelope
 *  (docs/reference/specs/reading-diff.md item 7). */
export interface PrDescriptionArtifact {
  artifact: "pr_description";
  /** `submitted`: the typed object a coding run submitted — exact and complete;
   *  `parsed`: read back from the PR body GitHub holds, with `problems` naming
   *  what the body did not carry in the renderer's shape. (Not named `source`:
   *  the `input` event's `source` is an object, and a literal-typed twin here
   *  would make `source` a discriminant of the whole union.) */
  origin: "submitted" | "parsed";
  repo: string;
  pr: number;
  /** The PR head the artifact was produced at: the render head for `submitted`,
   *  the reviewed head for `parsed`. Compare with each anchor's `sha` to know
   *  whether a step points into the head being looked at. */
  headSha?: string;
  /** The coding run a review run copied a `submitted` artifact from. */
  fromRunId?: string;
  title: string;
  /** The body as rendered (submitted) or as GitHub holds it (parsed), capped. */
  body: string;
  tldr?: string;
  why?: string;
  /** The map's "Where to look", each anchor stamped with the sha its permalink
   *  was rendered at. (A record written under the previous contract carries
   *  this array as `tour`; the line parser accepts either name.) */
  pointers: RenderedPointer[];
  decisions: { title: string; rationale: string }[];
  /** Nothing missing or malformed — always true for `submitted`. */
  complete: boolean;
  problems: string[];
  /** The body was cut at the cap before parsing. */
  truncated: boolean;
}

/** The artifact on the stream. An interface, not an intersection, so the
 *  union below stays discriminable on `type` for every object literal. */
export interface PrDescriptionArtifactEvent extends PrDescriptionArtifact {
  type: "review_artifact";
  seq?: number;
  at?: number;
}

// Run visibility (docs/reference/specs/run-visibility.md): a typed stream of what an agent is doing —
// tool calls and their (redacted, summarized) results — emitted by the runner.
// Today the in-channel status card consumes it live; the external live-view
// page (a follow-up) will consume the same stream. Keeping it a small typed
// seam here means neither consumer reaches into the runner's internals.

//
// Timing + lifecycle: every event carries an optional `at`
// (epoch ms, stamped by the runner's injectable clock) so the run-friction
// analyzer (`runFriction.ts`) can attribute delay; a `tool_result` marks exec-
// INFRASTRUCTURE failures (`infra: true`, an `ExecInfraError` — the sandbox, not
// the command) so they are never confused with an ordinary nonzero exit; and
// `run_note` events carry the runner's lifecycle notices (wrap-up warning, budget
// exhaustion, dead sandbox) as typed kinds instead of only free-text progress.
// All additive: consumers that only know tool_call/tool_result keep working.

/** Typed lifecycle notices the harness emits alongside its `onProgress` text.
 *  `stop_requested` is published by the registry when an operator asks the run
 *  to stop from /runs; `stopped` by the harness when it honors it. */
export type RunNoteKind =
  | "wrap_up"
  | "time_budget_exhausted"
  | "turn_budget_exhausted"
  /** The native loop's fail-fast on a wedged sandbox. Written by no loop since
   *  record 0032's series deleted that loop; a record from before it may carry
   *  the note, and every reader still knows the kind. */
  | "sandbox_dead"
  /** The sandbox fleet had no free instance for this thread within the
   *  executor's bounded wait (docs/reference/specs/execution.md item 14). Capacity, not a
   *  dead sandbox. Written by the native loop, whose tool call the executor's
   *  wait had refused; on pi the container is provisioned before pi starts, so
   *  the note is a record fact from before the loop's deletion. */
  | "fleet_busy"
  /** The container the run's process ran in was replaced under the live run
   *  (docs/reference/specs/harness-pi.md item 16; the resident's roll,
   *  resident-repos.md item 65). The harness's note is the verdict: the call
   *  in flight settled with the restart note, the summary naming both
   *  containers. The run loop then decides between two outcomes (harness.md
   *  item 6): a relaunch in the replacement, said in a `resumed` note, or —
   *  the relaunch refused by name, the ceiling among them — a second note of
   *  this kind saying why and that the run closes `interrupted` for a restart
   *  from its request. On a record from before the native loop's deletion the
   *  note says that loop's settlement instead: the executor waited for the
   *  wake and the run went on. */
  | "sandbox_restarted"
  /** The run was admitted onto a drained fleet (docs/reference/specs/resident-repos.md
   *  item 69) and waited at its attach for the deploy to finish: the summary
   *  names the wait. Published by the dispatcher after the attach, so `runs
   *  friction` reads the drain as the wait's category instead of "none". */
  | "drain_wait"
  | "stop_requested"
  | "stopped"
  /** A stop the loop or turn had to ask pi for again reached it: the series a
   *  failed abort's write opened (its `harness_error` line) closes here with
   *  the count of re-asks (harness-pi item 16). Written by the pi harness. */
  | "stop_landed"
  /** Setup spans the request's stream sink had to drop before this run was
   *  bound (docs/reference/specs/tracing.md): `summary` says how many, `from`/`to` the
   *  interval, which the partition reports as not recorded. */
  | "spans_dropped"
  /** The PR head moved while a review ran and the same run is re-reviewing at
   *  the new head (agent-review.md item 12). Published by the dispatcher. */
  | "head_moved"
  /** The run loop threw and the run finishes `failed`: the summary is the
   *  error's message, redacted and capped, so the run page says why a failed
   *  run failed even when the reply is never delivered (run-history.md).
   *  Published by the run loop's catch, before the finish. */
  | "run_failed"
  /** An MCP server configured for this agent did not answer discovery
   *  (docs/reference/specs/mcp-tools.md item 8); the run proceeds without its tools. One
   *  note per server, published by the dispatcher before the first turn. */
  | "mcp_unavailable"
  /** A thread follow-up steered into this run was folded into its next step
   *  (docs/reference/specs/thread-admission.md item 2). Published by the runner as it
   *  drains the inbox, beside an `input` event carrying the follow-up itself. */
  | "follow_up"
  /** The run was resumed by a new bot generation from its ledger transcript
   *  (docs/reference/specs/run-history.md item 37); the summary says how many calls were
   *  in flight at the kill and how each was settled. Published by the runner. */
  | "resumed"
  /** The restart the run's `restarting` close promised never claimed the run
   *  (issue 2081): its dispatch died between the close and the successor's
   *  claim, so this interrupted close is the run's end, not a restart. The
   *  summary names how the dispatch ended. Published by the dispatcher over
   *  the closed record — a kind of its own, so the interruption's cause is
   *  still read off the roll's earlier words, never off the dispatch error. */
  | "restart_died"
  /** A control was decided against the model card and is not native (record
   *  0052): a fallback (`applied` differs from `asked`, `vouched` true) or
   *  an unvouched send (`vouched` false). One note per degraded control,
   *  published by the dispatcher before the first turn. `why` says what the
   *  card could not vouch for; `summary` is the human line. */
  | "control_degraded"
  /** What the run's session seed could not do (docs/reference/specs/session-log.md
   *  item 9): the log could not be read so the run seeds from the channel, the
   *  newest turn alone was over the seed budget, the previous run's end was
   *  unknown so no line since could be told apart. One note per reason,
   *  published by the dispatcher before the first turn. */
  | "seed"
  /** This run is a question's Yes (record 0054;
   *  docs/reference/specs/run-history.md item 2): the stored proposal went
   *  back through `dispatch()` as the requester, and the summary names the
   *  question's refusal code. Published by the dispatcher before the first
   *  turn. */
  | "redispatch"
  /** A coding run pushed onto a branch that already heads an open PR without
   *  resubmitting the PR description, and the same run is being given one
   *  bounded extra model turn to submit it (docs/reference/specs/pr-description.md
   *  item 5). Published by the dispatcher before that turn. */
  | "description_turn"
  /** `submit_pr_description` refused the object (docs/reference/specs/pr-description.md
   *  item 5): the summary counts the fields over their cap and names them
   *  (or the issues, when none is a cap), `description` is the object as
   *  submitted — redacted like the accepted `pr_description` event's, and not
   *  necessarily a valid `PrDescription` — and `issues` the refusal's list
   *  with each cap's count to remove and the prefix that fits, so the record
   *  says what the model changed between one submit and the next. Published
   *  by the tool, before it answers. */
  | "description_refused"
  /** A review run's loop ended on a pull request without `submit_verdict`, and
   *  the same run is being given one bounded extra model turn to call it
   *  (docs/reference/specs/agent-review.md item 5; verdictTurn.ts). Published by
   *  the dispatcher before that turn. */
  | "verdict_turn"
  /** The run is on a cold per-thread sandbox instead of a warm resident, and
   *  the summary says why — the resident attach failed (its steps so far are
   *  grafted under the attach span), the resident was unreachable or not
   *  serviceable, or the repo is not onboarded (docs/reference/specs/resident-repos.md
   *  item 24). The same text the card carries; published by the dispatcher
   *  after the attach, before the first turn, so the run page explains a
   *  sandbox run that shows resident steps. */
  | "cold_sandbox"
  /** The run ledger would not track this run (docs/reference/specs/run-history.md
   *  item 54): its reservation met the row of a run this process was closing
   *  (a restart from its request, or the fresh turn for its follow-ups), waited
   *  for that finish, and the row still stood — the finish failed or was
   *  refused — so no handoff, resume or reclaim reaches this run, and its
   *  record reaches the store when it finishes. The summary names that run and
   *  how its finish ended; published by the dispatcher right after the
   *  reservation, before the attach, and carried on the card's label — the bot
   *  log's warning is not the only witness. */
  | "ledger_untracked"
  /** The resident kept this thread's binding where it was instead of moving
   *  it onto the branch the thread's own run opened a pull request on
   *  (docs/reference/specs/resident-repos.md item 16): the summary names the
   *  branch the run stays on, the PR, the reason and the resident's sentence.
   *  The same word the card carries; published by the dispatcher after the
   *  attach, before the first turn, so the run page explains a follow-up that
   *  runs on the default instead of on its thread's PR. */
  | "rebind_refused"
  /** The run ended with uncommitted changes or unpushed commits in its
   *  workspace, and they do not outlive it: a run starts from a clean tree
   *  (docs/reference/specs/resident-repos.md item 17), so the release that
   *  follows the reply discards them. The summary names both counts and what
   *  to do instead (commit and push). Read off the workspace by the run loop
   *  after the model's last turn — the release itself runs after the record
   *  is sealed — and set on the card's label too, so the loss is never silent. */
  | "work_left_behind"
  /** The run's ending may have left a command running in its workspace — a
   *  call cut by the ending's abort or interrupt, or open when the run failed —
   *  so the release tears the workspace down rather than pair it for the
   *  thread's next run (harness.md item 13). The summary names the calls.
   *  Written by the run loop once the harness session has ended and before the
   *  record is sealed; the release itself runs after. */
  | "workspace_torn_down"
  /** A coding run submitted a PR description but the post-step opened no
   *  pull request because the branch it observed IS the base the pull
   *  request would target (docs/reference/specs/pr-description.md item 5) —
   *  the summary names the branch. Published by the post-step, so a unit
   *  that ends without a pull request says why on the record and the card. */
  | "pr_not_opened"
  /** A coding run's pull request was opened or edited, but its head moved
   *  before the post-step's head pin and the second identity rewrite answered
   *  `unreadable` (docs/reference/specs/agent-coding.md item 2, record 0062):
   *  the open cannot be undone, so the summary names the reason the new tip's
   *  identities could not be verified and the reply carries the same warning.
   *  Published by the post-step. */
  | "pr_head_unverified"
  /** A review run's post-step posted nothing to the pull request — a guard's
   *  refusal, an opt-out, no pull request resolved, GitHub's own error — and
   *  the summary names the pull request (when one was resolved) and the
   *  reason (docs/reference/specs/agent-review.md item 18). Published by the
   *  post-step beside the thread's Slack-only note, so the record says the
   *  verdict is Slack-only and a coordinator reading it never asks GitHub
   *  for a review that was never sent. */
  | "review_not_posted"
  /** A pi run's context was compacted (docs/reference/specs/harness-pi.md item
   *  6): pi summarized its older turns into one entry and the model reads the
   *  summary from here on; the transcript keeps the originals, so the record
   *  is a superset of the model's context. The summary names the token counts
   *  before and after. Published by the pi bridge. */
  | "compacted"
  /** The pi harness itself failed in a way the run must show (harness-pi.md
   *  item 6): the extension threw, pi asked a dialog no one answers (answered
   *  cancelled), or pi emitted an event kind this build's bridge does not
   *  know — named, so a pi bump is visible in the first run's record. Published
   *  by the pi bridge. */
  | "harness_error"
  /** The model provider refused the run's call under its usage policy — the
   *  stop reason its wire names for a classifier's refusal, never the words
   *  (harness-pi.md item 6): the summary carries the provider's explanation
   *  for the run page; the run fails by name, its record says
   *  `failure: policy_refusal` (run-history.md item 57), the thread reads one
   *  sentence on how to go on, and the session's next seed leaves the refused
   *  request out (session-log.md item 9). Published by the pi harness. */
  | "policy_refusal"
  /** The harness's gate refused a tool call the model asked for (harness-pi.md
   *  item 7): the summary names the tool and the rule; the model read the same
   *  reason as the tool's result. Published by the bot's authorize route. */
  | "tool_refused"
  /** OpenCode withdrew a pending ask before the gate's reply to it landed
   *  (harness.md item 2): the server answered the reply 404 and its pending
   *  asks no longer listed the ask — the gate refused a sibling call of the
   *  same step, and at a reject the binary declines every other pending ask
   *  (`packages/core/src/permission.ts:203-220` at the pinned v2.0.3) and
   *  ends their step (measured in `opencode/testing/realDriver.test.ts`).
   *  The summary names the call, the reply the gate had decided and the
   *  sibling's refusal when the step has one (or says no refusal is on the
   *  record). Information, not a failure: nothing ran that the gate did not
   *  decide, the loop is not stopped, and the step ends by the server's word.
   *  Published by the OpenCode bridge. */
  | "ask_withdrawn"
  /** An OpenCode tool settled under a step this loop never saw start and the
   *  settle was set aside (harness.md item 13): an earlier execution's late
   *  result — the pinned binary's ordinary shape after a hung call's interrupt
   *  — or a step lost with the tailer's stream. The summary names the call and
   *  the step. Information, not a failure of the harness: nothing ran that the
   *  gate did not decide. Published by the OpenCode bridge in its own mode. */
  | "settle_set_aside"
  /** OpenCode's store refill carried a permission over something other than a
   *  tool (a directory outside the project, a repeating session) for a call
   *  the record never saw, and the store held no part yet to name the call's
   *  tool by: the call was opened under the permission's own name. The summary
   *  names the call and the step. Information, not a failure: the tool ran
   *  under the gate's decision either way. Published by the OpenCode bridge. */
  | "tool_unnamed"
  /** An `external_directory` ask answered once its call's line was already on
   *  the record (harness.md item 13): the line cannot be amended, so the
   *  directory the call reached is said here, naming the call. Published by
   *  the OpenCode bridge. */
  | "directory_reached"
  /** A ship coding child's budget ended with work still in the tree: the run
   *  loop committed and pushed it to the unit's branch (or says plainly that
   *  there was nothing to push), so a re-issue starts from the partial work
   *  (docs/reference/specs/agent-ship.md item 8). */
  | "budget_salvage"
  /** A pi run's compaction failed for good — the provider refused the summary
   *  (harness-pi.md item 7) — and the run loop treated it as a checkpoint
   *  signal: the tracked changes were committed and pushed to the run's own
   *  branch (a `pushed_head` event, `by: "salvage"`), or the note says plainly
   *  that the tree held nothing, so a context that overflows before the
   *  wind-down loses no work. The summary names the compaction failure.
   *  Published by the run loop's hook, which the pi harness awaits. */
  | "compaction_salvage"
  /** The loop's end found a tool call in flight and ended it, so the write-up
   *  keeps its allowance (decision 0046, unit seven; harness-pi item 6). The
   *  summary names the tools. Published by the harness beside the budget note. */
  | "tool_cut"
  /** The native loop's stuck-loop guard: the same tool call failed identically
   *  six times in a row and the run was forced into its write-up. Written by
   *  no loop since that loop's deletion; a record from before it may carry it. */
  | "stuck_loop"
  /** OpenCode's reject cascade ended the execution `interrupted` after the bot
   *  refused one of a step's two (or more) calls — the binary declines every
   *  other pending ask at a reject and ends the step `session.step.failed
   *  {aborted}`, the execution ending `session.execution.interrupted` — and the
   *  model never read the refusal. The loop re-prompts with the refusal so the
   *  model can continue, exactly as it does after a single refusal. Published
   *  by the OpenCode bridge. */
  | "decline_cascade";

/** Every `RunNoteKind`, as a value (a reader that filters notes by kind uses
 *  this; adding a kind to the union without adding it here is a type error). */
export const RUN_NOTE_KINDS = [
  "wrap_up",
  "time_budget_exhausted",
  "tool_cut",
  "turn_budget_exhausted",
  "sandbox_dead",
  "fleet_busy",
  "sandbox_restarted",
  "drain_wait",
  "stop_requested",
  "stopped",
  "stop_landed",
  "spans_dropped",
  "head_moved",
  "run_failed",
  "mcp_unavailable",
  "follow_up",
  "resumed",
  "restart_died",
  "control_degraded",
  "seed",
  "redispatch",
  "description_turn",
  "description_refused",
  "verdict_turn",
  "cold_sandbox",
  "ledger_untracked",
  "rebind_refused",
  "work_left_behind",
  "workspace_torn_down",
  "pr_not_opened",
  "pr_head_unverified",
  "review_not_posted",
  "compacted",
  "harness_error",
  "policy_refusal",
  "tool_refused",
  "ask_withdrawn",
  "settle_set_aside",
  "tool_unnamed",
  "directory_reached",
  "budget_salvage",
  "compaction_salvage",
  "stuck_loop",
  "decline_cascade",
] as const satisfies readonly RunNoteKind[];
type _EveryKindListed = [RunNoteKind] extends [(typeof RUN_NOTE_KINDS)[number]] ? true : never;
const _everyKindListed: _EveryKindListed = true;
void _everyKindListed;

/** How a run's preset was chosen (docs/reference/specs/routing-and-config.md
 *  items 1–3 and 21), as `run_meta.agentSource` records it: a directive on
 *  the message, the thread's sticky preset, the user or the channel scope's
 *  `agent`, `defaults.agent`, or the request router. The replay harness
 *  (`load route`) reads it to tell a requester's own choice from a fallback. */
export type AgentSource = "directive" | "sticky" | "user" | "channel" | "default" | "route" | "operator";

/** How an operator asked a run to stop: `soft` — take no new steps and
 *  wrap up through the normal finale; `hard` — abort the in-flight call now, no
 *  finale, tear the workspace down. */
export type StopMode = "soft" | "hard";

/** Who asked a run to stop: the caller's surface and its platform-
 *  namespaced identity (`slack:U…`, `access:<sub>`, `mcp:<subject>`,
 *  `cli:local`). Recorded on the `stop_requested` note so the stream itself says
 *  who stopped the run; `id` is charset-restricted to `ACTOR_ID_PATTERN` and
 *  capped by `sanitizeActor` before it is published. Absent on notes published
 *  through the token-gated HTML path (the capability, not a person, is the actor). */
export interface RunActor {
  kind: "access" | "mcp" | "cli" | "chat";
  id: string;
}

/** The character class an `actor.id` may carry (regex body, no brackets) — the
 *  ONE source both the validating pattern and the sanitizer are built from. */
const ACTOR_ID_CHARS = "A-Za-z0-9:@._-";
const ACTOR_ID_MAX = 128;
/** The characters an `actor.id` may carry; anything else is dropped. */
export const ACTOR_ID_PATTERN = new RegExp(`^[${ACTOR_ID_CHARS}]{1,${ACTOR_ID_MAX}}$`);
const ACTOR_ID_FORBIDDEN = new RegExp(`[^${ACTOR_ID_CHARS}]`, "g");

/** Coerce an actor into the published shape: strip every character outside the
 *  allowed set, cap at 128, and fall back to `unknown` when nothing survives —
 *  a hostile id is neutered, never a reason to refuse the stop. */
export function sanitizeActor(actor: RunActor): RunActor {
  const id = actor.id.replace(ACTOR_ID_FORBIDDEN, "").slice(0, ACTOR_ID_MAX);
  return { kind: actor.kind, id: id.length > 0 ? id : "unknown" };
}

/** How one `agent:ship` round boundary reads (docs/reference/specs/agent-ship.md item 12).
 *  `started` marks the round's child being dispatched; the rest settle it:
 *  `pr_opened` — a coding round's post-step opened or edited the PR;
 *  `completed` — a fix round finished without a PR write (e.g. it declined
 *  everything and never resubmitted the description); `approve` /
 *  `request_changes` — a review round's verdict; `no_verdict` — the review
 *  child ended without `submit_verdict`, aborting the pipeline; `aborted` — the
 *  round ended the pipeline (a refusal, no resident worktree, a round-0
 *  terminal); `stopped` — an operator stop settled the round. A cap never
 *  settles a round: caps end the pipeline BETWEEN rounds, visible as the
 *  absence of a next `started` boundary plus the answer's cap report. */
export type ShipRoundOutcome =
  | "started"
  | "pr_opened"
  | "completed"
  | "approve"
  | "request_changes"
  | "no_verdict"
  /** The round's checks step read a failed check at the reviewed head (record
   *  0055): the failures become check findings and the findings step runs as
   *  for any changes-requested round. */
  | "checks_failed"
  /** The round's coding child died on a provider transient with nothing
   *  pushed (issue 1932): the first such boundary marks the round's one
   *  re-run, a second the `transient` ending. */
  | "transient"
  /** The merge door enqueued the pull request — the base takes changes only
   *  through a merge queue (issue 2011): the unit waits for the queue's outcome. */
  | "enqueued"
  /** The merge queue removed the pull request: the removal reason becomes a
   *  finding of the round, like a red check, and a fix round follows. */
  | "dequeued"
  | "aborted"
  | "stopped"
  /** The round-0 coding child concluded its round with an answer instead of a
   *  pull request (issue 2086): its handoff records a deviation — a stop
   *  condition, a blocked precondition — so the unit ends held for the
   *  person's word and no renewal is judged. */
  | "held"
  /** The coding round ended at its lease with the unit unfinished and the row
   *  showing progress, and the grant renewed: the next segment opens (decision 0046). */
  | "continued"
  /** The unit idles instead of ending (record 0051): emitted once the wake
   *  lands (that plan's fifth unit); in the vocabulary now so rows written
   *  then read beside today's — the old kinds stay for rows already written. */
  | "idle";

/**
 * One event in a run's stream. `seq` is stamped by `RunRegistry.publish` — a
 * monotonic, per-run 1-based position (optional on the way in, present on every
 * event read back from the registry) so replays and history pages can resume
 * from a point without comparing payloads.
 */
/** A span record (docs/reference/specs/tracing.md): timing, not content. The registry
 *  accepts them between a run's finish and its seal, they never repaint the
 *  index, and every reader's counts and clocks skip them. */
export function isSpanRecord(e: { type: string }): e is SpanStartEvent | SpanEndEvent {
  return e.type === "span_start" || e.type === "span_end";
}

/** The protected head (docs/reference/specs/tracing.md; live-view item 2) — is this event head material? The root's start, `slack.receive` and the
 *  `dispatch.*` span pairs, `input`, `context`, `run_meta`, `route`, and the
 *  `mcp_unavailable` / `spans_dropped` / `cold_sandbox` / `rebind_refused` notes. */
export function isHeadMaterial(event: RunEvent): boolean {
  switch (event.type) {
    // `reference` (record 0037): a quoted conversation is published right
    // after `input` and is the audit trail a steered run's record needs; the
    // backlog trim and the record budget would otherwise drop it first, being
    // the oldest non-head event.
    case "input":
    case "context":
    case "reference":
    case "run_meta":
    case "route":
      return true;
    case "run_note":
      return (
        event.kind === "mcp_unavailable" ||
        event.kind === "spans_dropped" ||
        event.kind === "cold_sandbox" ||
        event.kind === "control_degraded" ||
        event.kind === "ledger_untracked" ||
        event.kind === "rebind_refused"
      );
    case "span_start":
      return event.name === "request" || event.name === "slack.receive" || event.name.startsWith("dispatch.");
    case "span_end":
      return event.name === "slack.receive" || event.name.startsWith("dispatch.");
    default:
      return false;
  }
}

/** A span's attributes on the wire: the closed-table values `attrs.ts` admits
 *  (literal unions, numbers, booleans; a few sanitized strings). Free text
 *  rides only in `span_end.error`, redacted and capped. */
export type SpanEventAttrs = Readonly<Record<string, string | number | boolean>>;

/** A span opened (docs/reference/specs/tracing.md): the run-stream sink publishes one per
 *  streamed span so a live page can show the step as it runs. `at` is the
 *  span's start on the runner clock. */
export interface SpanStartEvent {
  type: "span_start";
  spanId: string;
  parentSpanId?: string;
  name: string;
  attrs?: SpanEventAttrs;
  seq?: number;
  at?: number;
}

/** A span closed: its measured interval, its outcome and — for a span about
 *  this run's own work whose message we produce — the redacted, capped error
 *  text; a span whose failure came from a remote body carries the
 *  classification (`errorKind`/`errorCode`) in `attrs` and no message. `at` is
 *  the end on the runner clock (`startedAt + durationMs`). */
export interface SpanEndEvent {
  type: "span_end";
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: number;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
  attrs?: SpanEventAttrs;
  seq?: number;
  at?: number;
}

/** A value a `route` event may carry in a bound command input: JSON, nested
 *  at most three objects deep under `options`, and nothing else. The record
 *  crosses the run store's RPC boundary, whose typing walks every field: a
 *  field of `unknown` types the whole record `never`, and a recursive alias is
 *  "excessively deep" to it, so the nesting is spelled out level by level. The
 *  model's tool call is JSON to begin with; the registry's option schemas nest
 *  one object deep (`models.coding`); a deeper value is stored as its JSON
 *  text, still redacted and capped. */
export type RouteInputLeaf = string | number | boolean | null;
export type RouteInputLeafOrList = RouteInputLeaf | ReadonlyArray<RouteInputLeaf>;
export type RouteInputObject1 = { readonly [key: string]: RouteInputLeafOrList };
export type RouteInputObject2 = { readonly [key: string]: RouteInputLeafOrList | RouteInputObject1 };
export type RouteInputObject3 = { readonly [key: string]: RouteInputLeafOrList | RouteInputObject2 };
export type RouteInputValue = RouteInputLeafOrList | RouteInputObject3;

/** How a door decision about a state change ended (docs/decisions/0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md):
 *  `hand_back` — the door held a state-changing command and ran nothing: a
 *  typed surface's refusal naming the typed form, or a chat surface's refusal
 *  naming why the click could not mint; `offered` — the same decision on a
 *  channel that can show a confirmation: the line, its risk and a button, a
 *  row stored in the config object, nothing invoked; `confirmed` — the stored
 *  input ran at the click, as the requester, through the typed line's path.
 *  A routed read carries no outcome: it is not a decision about a state
 *  change. (A record from before the hand-back retired from chat may carry
 *  `pasted`; nothing writes or reads it now.) */
export type RouteOutcome = "hand_back" | "offered" | "confirmed" | "refused";

export type RunEvent =
  /** `callId` is the provider's tool_use id — the explicit pair key between a
   *  call and its result (live-view item 13); the runner stamps it on both. */
  /** `command` rides on bash calls only: the FULL command (redacted, capped at
   *  `COMMAND_CAP`, far above the 200-char `summary`), for consumers that must
   *  judge what the command did — the pushed-branch tracker
   *  (docs/reference/specs/pr-description.md item 5) reads it, because an agent's chained
   *  `git add … && git commit … && git push …` routinely carries its `push`
   *  past the summary cap. The status card and friction analyzer keep reading
   *  `summary`. */
  /** `spanId` (docs/reference/specs/tracing.md): the `tool.*` span this call ran under, once the runner emits spans. */
  /** `logIndex` (docs/reference/specs/run-history.md item 53): the row of the run's
   *  session log holding the assistant turn this call rode in — on a `tool_result`,
   *  the user turn its batch's results make. How a search hit's turn finds its
   *  step on the page. Absent for a run without a session, a record from before
   *  the field, and a call the mirror could not place. */
  | {
      type: "tool_call";
      tool: string;
      summary: string;
      command?: string;
      callId?: string;
      spanId?: string;
      logIndex?: number;
      /** The bound the call itself declared, in ms (a bash `timeout`, clamped
       *  by nothing here — pi runs an unbounded call until the loop's end).
       *  The stall signal (docs/reference/specs/live-view.md item 32) marks a
       *  call past it; absent when the call declared none. */
      boundMs?: number;
      seq?: number;
      at?: number;
    }
  /** `ok` is "the tool succeeded": false when it threw AND (bash) when the
   *  command exited nonzero. `exitCode` rides on bash results (parsed from the
   *  executors' shared `exit N:` prefix, 0 for a clean run; absent when the code
   *  was not numeric). `output` is the tool's text — control-stripped, redacted,
   *  capped at TOOL_OUTPUT_CAP — for the run page's expandable card; the status
   *  card and the friction analyzer keep reading `summary`. `cut` marks the
   *  result of a call the run's ending cut rather than settled — pi's abort (the
   *  tool's own end after it), OpenCode's interrupt (a call still open when its
   *  loop left), a session's end (`closeOpenSpans`): the command behind it may
   *  still be running, and the workspace's release reads it so (`callsInFlight`,
   *  harness.md item 13). */
  | {
      type: "tool_result";
      tool: string;
      ok: boolean;
      summary: string;
      callId?: string;
      exitCode?: number;
      output?: string;
      infra?: true;
      cut?: true;
      spanId?: string;
      logIndex?: number;
      seq?: number;
      at?: number;
    }
  /** `mode` rides only on the stop notes (`stop_requested` / `stopped`); `actor`
   *  only on a `stop_requested` published through `RunsService.stopRun`. */
  | {
      type: "run_note";
      kind: RunNoteKind;
      summary: string;
      mode?: StopMode;
      actor?: RunActor;
      /** On a `control_degraded` note only (record 0052): which control,
       *  the word asked, the word applied, whether a layer vouched for the
       *  applied word, and what the card could not vouch for. */
      control?: string;
      asked?: string;
      applied?: string;
      vouched?: boolean;
      why?: string;
      /** On a `spans_dropped` note only (docs/reference/specs/tracing.md): the runner-clock
       *  interval the dropped setup records covered — a `not recorded` loss. */
      from?: number;
      to?: number;
      /** On a `description_refused` note only: the refused object as submitted
       *  (JSON, not necessarily a valid `PrDescription`; `RecordedJson` says
       *  why it is typed level by level), every string leaf redacted, and the
       *  issues the refusal named. */
      description?: RecordedJson;
      issues?: DescriptionIssue[];
      spanId?: string;
      seq?: number;
      at?: number;
    }
  /** The run's final answer — the same text the channel reply/PR post is
   *  projected from, redacted like every event (NOT capped: the run record is
   *  the source of truth, the summaries are). Published by the dispatcher once
   *  per run, before `finish()` and before the reply goes out; absent when an
   *  AGENT run threw (the card shows ❌). An inline command run that throws
   *  still publishes one — the `⚠️ <error>` reply — so its record explains the
   *  `failed` status. `text` is the CANONICAL Markdown (docs/reference/specs/llm-output.md
   *  item 5); `raw` is the model's own text, present only when normalization
   *  changed it (redacted too, dropped if it would blow the per-event budget). */
  | { type: "answer"; text: string; raw?: string; seq?: number; at?: number }
  /** The request as received (directives stripped, attachments noted as a
   *  one-line count suffix — never bytes or file bodies), redacted, uncapped. Published by the dispatcher once
   *  per run, right after the run is registered — the first event of the record,
   *  so the run page can lead with what was asked (docs/reference/specs/live-view.md item 12). */
  | {
      type: "input";
      text: string;
      /** The message this turn is: the platform's id of the message (Slack's
       *  `ts`), the run id for a request from a channel with none (CLI, HTTP,
       *  MCP), the inbox seq or arrival time for a follow-up with none (a
       *  parent's steer). A received `artifact` names the same id, so the page
       *  puts a file on the card of the message it arrived with by data, never
       *  by the order the events happened to be recorded in (live-view.md item 26). */
      messageId: string;
      /** Where the request came from, for the Request block: the channel and
       *  user display names and a link back to the triggering message —
       *  whatever the adapter supplied (all optional) — and, for a follow-up a
       *  run sent rather than a person (a parent's `send_to_run`), that run's
       *  id (docs/reference/specs/agent-conductor.md item 8). */
      source?: { url?: string; channel?: string; user?: string; run?: string };
      /** How the turn was delivered when it consumed a unit's thread events
       *  (record 0051's mode-as-receipt rule): the mode read off the owner's state when
       *  each event arrived — a receipt, never a switch — and the sequence
       *  numbers consumed, so the record names the events it folded. Absent on
       *  every run that consumed none. */
      mode?: "steer" | "wake" | "interrupt";
      consumed?: number[];
      seq?: number;
      at?: number;
    }
  /** One referenced conversation the model was given (record 0037): a thread
   *  another channel's permalink named, quoted onto the request turn as an
   *  untrusted block. `text` is that block as the model saw it (header, fence,
   *  one line per message), redacted; `messages` its count; `channelName` the
   *  classifier's fresh name, never the link's label. One event per reference,
   *  published right after `input`, so the page shows exactly what was quoted. */
  | {
      type: "reference";
      url: string;
      channelId: string;
      channelName: string;
      messages: number;
      text: string;
      seq?: number;
      at?: number;
    }
  /** One prior thread turn fed to the model, prefixed with its role
   *  (`user: …` / `assistant: …`), humanized and redacted like `input`, with
   *  attachments as metadata lines. Published by the dispatcher right after
   *  `input`, bounded (newest 20 turns / 256 KiB) and gated by
   *  `runHistory.includeContext`. */
  | { type: "context"; text: string; seq?: number; at?: number }
  /** The agent's notes for this thread as the `notes` tool last wrote them
   *  (docs/reference/specs/session-log.md item 10; record 0035, "The notepad"):
   *  the whole notepad, at most `NOTEPAD_MAX_BYTES`, so the record shows what
   *  the next run of the session starts from. Published by the tool on every
   *  write; the record's last one is the final text. */
  | { type: "notes"; text: string; spanId?: string; seq?: number; at?: number }
  /** The model's prose BETWEEN tool calls — text content that rode alongside
   *  tool_use in one completion. Emitted by the runner, redacted, uncapped. The
   *  final text-only completion is NOT one of these (that is the `answer`). */
  | { type: "assistant"; text: string; spanId?: string; seq?: number; at?: number }
  /** What the run is about (live-view item 19): the resolved agent and model,
   *  and — for a repo run — the repo, ref, PR number and PR head as resolved
   *  BEFORE the first model turn (`RepoContext`). Published by the dispatcher
   *  right after `input`, once per run, so the run page can head its Request
   *  block with linked `owner/repo · ref · #PR · sha`. A HOSTED ship parent
   *  (record 0060) carries a second one at the hand-off naming its runner
   *  instance (`instanceId`): `run_meta` may repeat on such a run, and every
   *  reader of a run's instance id resolves it from the LAST `run_meta`
   *  carrying one. Additive: every consumer that only knows the other types
   *  keeps working. */
  | {
      type: "run_meta";
      agent: string;
      /** How `agent` was chosen (`AgentSource`); absent on a command run and on records written before it existed. */
      agentSource?: AgentSource;
      /** Absent on a command run, which resolves no model. */
      model?: string;
      /** The request's trace id (docs/reference/specs/tracing.md), once the root exists. */
      traceId?: string;
      /** The harness the run is driven by (`Harness.name`; docs/reference/specs/harness.md
       *  items 8 and 10): the word the scopes resolved for the preset, `pi`
       *  when none named it. Absent on a command run, which starts no process,
       *  and on a record written before the seam existed. Additive. */
      harness?: string;
      /** Whose word put the run on that harness (item 10): the requester's own
       *  scope, the channel's, or the deployment's top-level block. Absent when
       *  no scope named the preset — the roster's default — and on records
       *  written before the word was a scope setting. */
      harnessScope?: HarnessScope;
      effort?: string;
      /** The model card this run resolved before its first call (record
       *  0052): the wire, vendor, levels, cap field, window, inputs, cache rule
       *  and price source, each with the layer that named it. Absent on a
       *  command run and on a record written before the card existed.
       *  Additive. */
      card?: ModelCard;
      repo?: string;
      ref?: string;
      pr?: number;
      headSha?: string;
      /** The plan runner instance whose story this record is (agent-ship item
       *  17): written on the pipeline's own record alone, so its page can list
       *  the instance's units. A child's instance rides the record's
       *  `parentInstanceId`, never here. */
      instanceId?: string;
      /** The grant the ship request carried (decision 0046, the renewable
       *  lease): renewals and a cost cap — what a renewal could spend. Written
       *  on the pipeline's own record beside `instanceId`; absent elsewhere. */
      grant?: { renewals: number; costCapUsd?: number };
      seq?: number;
      at?: number;
    }
  /** A file moved through the artifact store (docs/reference/specs/execution.md item 20,
   *  record 0033): one the run received from its thread (`in`, staged before
   *  the turn) or one it sent (`out`, `attach_file`). The record keeps the
   *  store KEY and the facts a page needs to list the file — never a URL: the
   *  run page's proxy route (`/runs/:id/artifacts/<key>`, live-view.md item 26)
   *  mints a signed GET per request, so a stored record never carries a
   *  credential that expires or leaks, and the parser refuses a payload that
   *  tries. A side fact beside the tool pair that moved the file (like
   *  `skill_use`), never a step; the friction analyzer ignores it. */
  | ({
      type: "artifact";
      /** The store key (`src/artifacts/keys.ts`): `runs/<runId>/out/<seq>-<basename>` or `threads/<thread>/in/<ts>/<i>-<basename>`. */
      key: string;
      /** The file's name as the person sees it (the Slack filename, the tool's `name`). */
      name: string;
      size: number;
      contentType: string;
      seq?: number;
      at?: number;
    } & (
      | {
          direction: "in";
          /** The `input` event this file arrived with — the same `messageId`
           *  (live-view.md item 26); a file re-pulled from an earlier message
           *  of the thread names the request it was pulled for. */
          messageId: string;
        }
      | {
          direction: "out";
          /** The `tool_call` (`attach_file`) that posted it — its `callId`. */
          callId: string;
        }
    ))
  /** A skill was loaded into the model's context (docs/reference/specs/skills.md). Emitted
   *  by the `use_skill` tool on a successful load — alongside, not instead of,
   *  its `tool_call`/`tool_result` pair — so skill use is a first-class fact in
   *  the run data with its own metadata: which skill, for which agent, from
   *  where (`source`, the pinned upstream URL when vendored), and how much
   *  context it cost (`bodyBytes`). Additive: consumers that only know the
   *  other types keep working; the friction analyzer ignores it. */
  | {
      type: "skill_use";
      skill: string;
      description: string;
      agent: string;
      /** The pinned upstream file URL for a vendored skill (docs/reference/specs/skills.md item 9). */
      source?: string;
      /** Structured vendoring provenance (`Skill.upstream`, recorded by skills:sync). */
      upstream?: { repo: string; commit: string };
      bodyBytes: number;
      spanId?: string;
      seq?: number;
      at?: number;
    }
  /** A review run's reading diff (docs/reference/specs/reading-diff.md): the change as a
   *  reviewer reads it. The baseline artifact is the full `git diff`
   *  (`poweredBy: "git"`, guaranteed on every PR review); with the meat
   *  provider a SECOND artifact may follow — meat.dev's abridged reading diff
   *  (`poweredBy: "meat"`, with its one-line `summary` and the abridging
   *  call's own token usage) — iff meat finishes within the review. Published
   *  by the dispatcher straight to the registry (like `input`/`run_meta`),
   *  produced concurrently with the review by the run's own executor; readers
   *  prefer the meat artifact when both exist. Additive: unknown → ignored. */
  | {
      type: "review_artifact";
      artifact: "reading_diff";
      poweredBy: "git" | "meat";
      baseRef: string;
      diff: string;
      truncated: boolean;
      summary?: string;
      meatTokens?: { input: number; output: number };
      /** meat only (docs/reference/specs/reading-diff.md item 6): which diff meat
       *  read — GitHub's compare of base...head, or the recorded git artifact
       *  (whole) — and how many bytes it was; the `-model` it ran with. */
      input?: "github-compare" | "recorded";
      inputBytes?: number;
      model?: string;
      seq?: number;
      at?: number;
    }
  /** The PR's description as data (docs/reference/specs/reading-diff.md item 7): the TL;DR,
   *  the Tour's steps with their anchors (each carrying the sha its permalink
   *  was rendered at), the Remaining-changes list and the decisions, so the run
   *  page's panel can render a collapsed description and a Tour that jumps to
   *  files and lines in the diff. Two sources, one shape: a coding run publishes
   *  its `submitted` object when the post-step opens or edits the PR (beside
   *  `pr_opened`); a review run copies that object when one exists for the head
   *  it reviews, else `parsed` reads the body GitHub holds back through the
   *  inverse parser. Every string is control-stripped and redacted like the
   *  reading diff. Additive: unknown → ignored. */
  | PrDescriptionArtifactEvent
  /** A coding run's accepted `PrDescription` (docs/reference/specs/pr-description.md): the
   *  typed object the run submitted through `submit_pr_description`, as
   *  validated — the same object the dispatcher renders the GitHub body from,
   *  so the run page's review panel can render it without a second authoring
   *  path. Published by the dispatcher once per run (the last valid submission
   *  wins), string fields redacted like every event payload. Additive: unknown
   *  → ignored. */
  | { type: "pr_description"; description: PrDescription; seq?: number; at?: number }
  /** The coding PR post-step's outcome (docs/reference/specs/pr-description.md item 5):
   *  the PR opened for the run's pushed branch — or, open-or-edit, the
   *  existing open PR that was edited (`created: false`). Published by the
   *  dispatcher straight to the registry BEFORE the stream finishes, so the
   *  run record carries the PR URL as a fact of the run rather than only the
   *  channel reply's projection of it. Additive: unknown → ignored. */
  | {
      type: "pr_opened";
      url: string;
      number: number;
      created: boolean;
      /** The branch the run pushed, which the pull request is opened from —
       *  the fact the run's release hands the resident so the thread remembers
       *  its own branches past the tree (docs/reference/specs/resident-repos.md
       *  item 16). Absent from an event a build before it recorded. */
      head?: string;
      /** How many of the run's commits the identity rewrite re-authored before
       *  the open (record 0062; docs/reference/specs/agent-coding.md item 2).
       *  Absent when none were, and from an event a build before it recorded. */
      rewritten?: number;
      seq?: number;
      at?: number;
    }
  /** The run's lease as the harness started it (docs/reference/specs/run-history.md
   *  item 2; decision 0046): when the wall clock began, when the lease ends,
   *  and when the loop ends — the lease's end less the write-up and the
   *  post-step the lease holds back — so a record says how long the run had
   *  and where its loop was cut. Published by the harness once, at the first
   *  start of the loop; a resumed run carries the original. Head material,
   *  like `run_meta`. Additive: unknown → ignored. */
  | { type: "lease"; startedAt: number; endsAt: number; loopEndsAt: number; seq?: number; at?: number }
  /** A head the run pushed (docs/reference/specs/run-history.md item 2; decision
   *  0046): the branch and the sha the coding post-step observed on the remote
   *  (`by: "push"`), or the budget-end salvage pushed (`by: "salvage"`),
   *  whether or not a pull request follows — the fact renewal reads. Published
   *  straight to the registry like `pr_opened`. Additive: unknown → ignored. */
  | {
      type: "pushed_head";
      ref: string;
      sha: string;
      by: "push" | "salvage";
      /** No uncommitted or unpushed work at the push (record 0064): the fact
       *  the plane's soft stop reads. Absent where the measure was missing. */
      clean?: boolean;
      seq?: number;
      at?: number;
    }
  /** The coordinator tag as a fact of the run (docs/reference/specs/run-history.md
   *  item 48a): the instance the run is a child of, the unit its idempotency
   *  key named, and the base branch its pull request targets — published by
   *  the dispatcher once at dispatch, from `DispatchOptions.coordinator`, so
   *  a run re-attached or restarted after a bot roll (whose spawn options are
   *  gone with the process) reads the plan's base back off its own events
   *  instead of letting the binding ref — the unit branch itself — stand in.
   *  `base` is absent when the spawn knew none; the post-step then falls to
   *  the coordinator store's `instance.base`. Additive: unknown → ignored. */
  | { type: "coordinator_tag"; parentInstanceId: string; unit?: string; base?: string; seq?: number; at?: number }
  /** The plan runner instance a ship run's hand-off created (record 0051 R2;
   *  docs/reference/specs/run-history.md item 2): published by the ship branch
   *  after `handOffToCoordinator` succeeds, straight to the registry like
   *  `pr_opened`, and projected onto `RunRecord.instanceId` the way
   *  `coordinator_tag` is — so the thread's owner rule can find the instance
   *  from the page's ship run. Additive: unknown → ignored. */
  | { type: "ship_handoff"; instanceId: string; seq?: number; at?: number }
  /** A coordinator child interrupted under a deploy roll (docs/reference/specs/run-history.md
   *  item 47a): the run closes `interrupted` for a restart from its request —
   *  a workspace lost across a bot roll, the resident's container replaced
   *  with the relaunch refused — and the record says so as a typed fact
   *  beside the `resumed`/`sandbox_restarted` notes, `reason` the refusal or
   *  note in one line. Published straight to the registry by the reattach
   *  path and the run loop's interruption; the parent's wait settles on its
   *  Workflow twin (`child-interrupted-<runId>`) beside `run-finished-<runId>`
   *  and confirms by `read-record`. Additive: unknown → ignored. */
  | { type: "child_interrupted"; parentInstanceId: string; reason: string; seq?: number; at?: number }
  /** A coordinator child resumed across a deploy roll (run-history item 47a):
   *  the same run re-attached its workspace and carries on under its record,
   *  tag and budget. Published straight to the registry by the reattach path;
   *  the Workflow twin (`child-resumed-<runId>`) tells the parent's wait to
   *  keep waiting rather than walk out the chunk asking. Additive: unknown →
   *  ignored. */
  | { type: "child_resumed"; parentInstanceId: string; summary: string; seq?: number; at?: number }
  /** The review post-step's outcome when the verdict landed
   *  (docs/reference/specs/agent-review.md item 18): the pull request it was
   *  posted to, the head it was pinned to (the carried head after a rebase,
   *  item 12) and the verdict kind when one was submitted. Published by the
   *  post-step straight to the registry BEFORE the stream finishes — the
   *  post-step runs inside the run loop, like the coding one — so the record
   *  carries the post as a fact of the run and a coordinator woken by the
   *  finish reads it there instead of asking GitHub, whose review list can
   *  lag the post it just accepted. A post that did not land is a
   *  `review_not_posted` note. Additive: unknown → ignored. */
  | {
      type: "review_posted";
      repo: string;
      number: number;
      head: string;
      verdict?: "approve" | "request_changes";
      seq?: number;
      at?: number;
    }
  /** One `agent:ship` round boundary (docs/reference/specs/agent-ship.md item 12): the
   *  pipeline publishes a `started` event when a round's child is dispatched
   *  and one settle event when its outcome is known (`ShipRoundOutcome`), so
   *  rounds are legible on the one stream and per-round cost is derivable by
   *  slicing `model.turn` spans between boundaries. `index` is 0-based in the
   *  spec's round vocabulary — round 0 is the initial coding round; a review
   *  round and its fix round share an index. Published by the ship pipeline
   *  straight to the registry (like `pr_opened`), never through the runner.
   *  Additive: unknown → ignored. */
  | {
      type: "ship_round";
      index: number;
      agent: string;
      outcome: ShipRoundOutcome;
      /** The severity gate fired on this approve (agent-ship item 9): the level
       *  in force and the gated findings as `id (severity)` — a mismatch the
       *  child's own parser should have made impossible, kept visible. */
      gate?: { level: string; findings: string[] };
      seq?: number;
      at?: number;
    }
  /** A hosted ship parent's unit fact (record 0060; docs/reference/specs/agent-ship.md
   *  item 17): the runner's routes write it to the parent run through the
   *  coordinator's `hostPublish` — `unit-start` publishes state `started` with
   *  the unit's thread key and lead, `round` the round's outcome as the unit's
   *  state, `unit-end` the ending's kind with its report — carrying the pull
   *  request number when the unit's row knows one. The run page draws it as a
   *  step whose detail is the report; the friction analyzer counts it as a
   *  side fact, never activity. Additive: unknown → ignored. */
  | {
      type: "ship_unit";
      unit: string;
      state: string;
      threadKey?: string;
      lead?: string;
      report?: string;
      pr?: number;
      seq?: number;
      at?: number;
    }
  /** The request router's decision (docs/reference/specs/routing-and-config.md
   *  item 21): the preset a plain message was routed to, the one-line reason
   *  the router gave (redacted, capped — the same text the card's `routed:`
   *  line carries) and the model that decided. A compound route is `preset:
   *  "conductor"` with `parts` — one per child the conductor was told to
   *  spawn: its preset and its text, the child's whole prompt. A compound
   *  answer that carried a write-identity part collapsed onto that preset
   *  (record 0034: a write ask is never a part): `preset` is the write preset
   *  the run is, `collapsed.presets` the preset each part named in answer
   *  order, and no `parts`. A compound the parse refused is recorded too, on
   *  the run that fell to the default: `preset` is `defaults.agent` and
   *  `reason` reads `compound_rejected: <why>` (the run's
   *  `run_meta.agentSource` stays `default`). Published by the dispatcher
   *  straight to the registry right after `run_meta`, once per run the router
   *  answered; absent on every run a directive, a sticky preset or a scope
   *  chose. Head material, like `run_meta`. Additive: unknown → ignored.
   *  A command the router bound from prose (record 0036: the door offers every
   *  chat command as a tool beside `route`) rides the command run's record
   *  instead, right after its `run_meta`: `preset` is the command run's agent
   *  (`command`), `command` the id the model called, `input` the bound input
   *  (redacted, each value capped) and `receipt` the chat form the reply led
   *  with (`routed: <chat form>`, redacted and capped at `ROUTE_RECEIPT_CAP`);
   *  how the invoke ended is the run's own status and `answer`. A door
   *  decision about a state change (record 0044) is a command run too, with
   *  `outcome` saying which: a hand-back invoked nothing and its `answer` is
   *  the refusal the surface was shown (the typed form on a typed surface);
   *  an offer invoked nothing and its `answer` is the offer as the channel
   *  shows it; a confirmation is the stored input run at the click, its
   *  `answer` the command's own text as a routed read's is. */
  | {
      type: "route";
      preset: string;
      reason: string;
      model: string;
      parts?: ReadonlyArray<{ preset: string; text: string }>;
      collapsed?: { presets: ReadonlyArray<string> };
      command?: string;
      input?: { readonly [key: string]: RouteInputValue };
      receipt?: string;
      /** The structured seam's attempts ([record 0067](../../docs/decisions/0067-one-seam-for-a-structured-answer-a-violation-is-re-asked-with-the-violation-named-and-the-callers-declared-floor-holds-never-a-refusal-shown-to-the-person.md)):
       *  what each answer violated, or that it was accepted, so a flaky model
       *  is legible on the record as re-asks, not as silent floors. */
      attempts?: ReadonlyArray<{ outcome: "accepted" | "violation"; violation?: string }>;
      outcome?: RouteOutcome;
      /** The refusal's code (src/core/refusal.ts) when `outcome` is `refused`
       *  (record 0054): a refusal after a command was bound is a run
       *  record, and the door report counts it by cause and code. */
      refusalCode?: string;
      seq?: number;
      at?: number;
    }
  /** The operator's decision beside the routed request ([record 0057](../../docs/decisions/0057-the-operator-is-the-one-door-a-model-binds-every-chat-input-and-deterministic-code-authorizes-fences-and-executes.md);
   *  the one-door plan's operator unit; run-history item 60): one per admitted chat
   *  event under `routing.operator: shadow` or `on`, published beside the
   *  `route` event. The decision is binds, a question, a refusal or — the
   *  structured seam's floor ([record 0067](../../docs/decisions/0067-one-seam-for-a-structured-answer-a-violation-is-re-asked-with-the-violation-named-and-the-callers-declared-floor-holds-never-a-refusal-shown-to-the-person.md)),
   *  never the model's decision — `non_decision`: under `on` the dispatcher
   *  falls back to the readers' route for that event, this event recorded on
   *  the run that then runs; `attempts` lists what each answer violated or
   *  that it was accepted. A bind's `line` is redacted and cut like the
   *  receipt (`ROUTE_RECEIPT_CAP`), never the message text; `intake` carries
   *  the intake gate's verdict when the gate is present; `latencyMs` and
   *  `outputTokens` feed the replay's median rows. Under `shadow` nothing
   *  runs from it. Additive: unknown → ignored. */
  | {
      type: "operator";
      mode: "shadow" | "on";
      outcome: "binds" | "question" | "refusal" | "non_decision";
      reason: string;
      /** The decision was the loop's floor (record 0069, as amended): a turn
       *  that ended with no tool call, or the bounded re-asks ran out — the
       *  readers' route ran the person's own request, and the event never
       *  re-enters the loop. Additive: unknown → ignored. */
      floored?: true;
      /** A bind marked `confirmed` is a pending question's confirmed proposal
       *  (`bindFromAnswer`): the line itself carries the task — the person's
       *  message was the word "yes" — so a confirmed preset line routes its
       *  own tail as the request. Additive: unknown → a fresh bind. */
      binds?: ReadonlyArray<{ line: string; reason: string; confirmed?: true }>;
      question?: string;
      /** A question's proposed line, redacted and cut like the receipt — what
       *  the next turn's "yes" binds (`bindFromAnswer`). */
      proposal?: string;
      /** A question's original ask, redacted and capped: the request the
       *  question interrupted, kept so the person's next words in the thread
       *  join back onto it (`joinedAnswerRequest` —
       *  `<request> — <question>: <answer>`) and bind as the request would
       *  have been, never routed as a bare fragment. Set on `question`
       *  outcomes alone. Additive: unknown → ignored. */
      request?: string;
      refusalCause?: string;
      refusalText?: string;
      attempts?: ReadonlyArray<{ outcome: "accepted" | "violation"; violation?: string }>;
      intake?: { verdict: string; reason: string };
      latencyMs?: number;
      outputTokens?: number;
      seq?: number;
      at?: number;
    }
  /** A refusal the door made ([record 0054](../../docs/decisions/0054-a-refusal-the-person-caused-is-one-question-with-a-best-guess.md),
   *  as amended: every refusal is a run record; run-history.md item 2): the
   *  code, its one cause, and the sentence the person read — redacted and
   *  capped like a route receipt (`ROUTE_RECEIPT_CAP`). Exactly one per `door`
   *  record, published by `recordRefusal` beside the redacted request, so the
   *  door report counts every refusal — a gate refusal before any command is
   *  bound included — from the run store alone. Additive: unknown → ignored. */
  | { type: "refusal"; code: string; cause: string; text: string; seq?: number; at?: number }
  /** The span records (docs/reference/specs/tracing.md): published, counted and stored like
   *  every other event, read as timing and never as content. */
  | SpanStartEvent
  | SpanEndEvent;

// Redaction helpers live in ./redact.ts and are re-exported here so every
// existing import site keeps working.
export { redactAndCap, redactSecrets, stripAnsi } from "./redact.js";
import { redactSecrets, stripAnsi } from "./redact.js";

const SUMMARY_CAP = 200;

/** One-line, control-stripped, redacted, length-capped summary of a tool's output for the run
 *  stream — the first non-empty line plus a size note. */
export function summarizeToolResult(output: string): string {
  return summarizeClean(redactSecrets(stripAnsi(output)));
}

/** `summarizeToolResult` for text that is ALREADY control-stripped and redacted. */
function summarizeClean(clean: string): string {
  const trimmed = clean.trim();
  if (trimmed === "") return "(no output)";
  const firstLine =
    trimmed
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  const head = firstLine.length > SUMMARY_CAP ? `${firstLine.slice(0, SUMMARY_CAP)}…` : firstLine;
  const lineCount = trimmed.split("\n").length;
  const more =
    trimmed.length > head.length ? ` (${trimmed.length} chars${lineCount > 1 ? `, ${lineCount} lines` : ""})` : "";
  return head + more;
}

/** Every executor renders a nonzero command exit as an `exit <code>:` first line
 *  (`LocalExecutor.exec`, `ResidentExecutor.exec`, `CloudflareSandboxExecutor.exec`)
 *  so the model sees the status. This is the single reader of that contract.
 *  `failed` is true for any such prefix; `exitCode` is the code when numeric
 *  (execFile can report an errno string instead). Ordinary output — including
 *  text that merely mentions "exit 1:" later on — is a clean 0. */
export function parseExitPrefix(output: string): { failed: boolean; exitCode?: number } {
  const m = /^\s*exit (\S+?):/.exec(stripAnsi(output));
  if (!m) return { failed: false, exitCode: 0 };
  return /^\d+$/.test(m[1]) ? { failed: true, exitCode: Number(m[1]) } : { failed: true };
}

/** A tool that could not do what it was asked answers the model with a text
 *  that opens `error:` (`attach_file`, the `submit_*` tools, the run tools —
 *  each declares `failsInText` on its `RunnableTool`) instead of throwing, so
 *  the model can read the reason and go on. The record must call that result
 *  what the model reads it as: `ok:false`. The pi bridge derives `ok` for such
 *  a tool through this one reader (the native loop did too, before record
 *  0032's series deleted it); bash keeps `parseExitPrefix`; a tool relaying
 *  content it did not write is never read this way. Ordinary output that
 *  merely contains the word later on is a success. */
export function toolTextFailed(output: string): boolean {
  return /^\s*error:/i.test(stripAnsi(output));
}

/** Upper bound on a `tool_result.output` — large enough for a test run or a
 *  diff to read in full on the run page, small enough that a run of ordinary
 *  length fits the registry's backlog whole (the backlog is bounded by count AND
 *  bytes — `RunRegistry`, 5000 events / 4 MiB — so an output-heavy run trims its
 *  oldest events rather than growing without bound). */
export const TOOL_OUTPUT_CAP = 8_000;

/** Cap on a bash `tool_call.command` (the full command beside the 200-char
 *  `summary`). Generous — an agent's chained `checkout && add && commit && push`
 *  is a few hundred chars; a heredoc-fed script can be a few thousand — and
 *  still a small fraction of `MAX_EVENT_BYTES`. */
export const COMMAND_CAP = 4_000;

/** The full tool output as it may leave the process: control-stripped, then
 *  redacted, then capped (that order — see redactAndCap). Empty output → "". */
export function prepareToolOutput(output: string): string {
  return capClean(redactSecrets(stripAnsi(output)));
}

/** `prepareToolOutput` for text that is ALREADY control-stripped and redacted. */
function capClean(clean: string): string {
  const text = clean.trim();
  if (text.length <= TOOL_OUTPUT_CAP) return text;
  return `${text.slice(0, TOOL_OUTPUT_CAP)}…[${text.length - TOOL_OUTPUT_CAP} more chars]`;
}

/** Both `tool_result` display fields from ONE strip+redact pass. The redaction
 *  battery is ~20 regexes over up to 120k chars of raw tool output; paying it
 *  once per result instead of twice (summary, then output) halves the
 *  synchronous CPU the runner spends per tool call. Byte-identical to calling
 *  `summarizeToolResult` and `prepareToolOutput` separately. */
export function prepareToolResult(output: string): { summary: string; output: string } {
  const clean = redactSecrets(stripAnsi(output));
  return { summary: summarizeClean(clean), output: capClean(clean) };
}

/** `JSON.stringify(event)`, computed once per event object however many readers
 *  it has: the registry measures each event's byte size at publish, then hands
 *  the SAME object to every subscriber (and replays the same backlog entries),
 *  so with k open tabs on one run each tool_result (up to 8 KB of output) would
 *  otherwise be serialized k+1 times. */
const serialized = new WeakMap<object, string>();
export function serializedOnce(event: object): string {
  let s = serialized.get(event);
  if (s === undefined) {
    s = JSON.stringify(event);
    serialized.set(event, s);
  }
  return s;
}
