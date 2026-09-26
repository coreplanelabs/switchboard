// The run stage's loop (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// the model turn and everything that rides on it. The card frame the loop
// paints (checklist, activity line, the shutdown notice); the run on the pi
// harness (docs/reference/specs/harness-pi.md) with the follow-up inbox; the
// reviewed-head settle; the workspace observation, the description turn and
// the coding PR post-step; the answer published as the record's source of
// truth; then the finish — the registry closed with the terminal status, the
// friction diagnosis, the record registered for the drain — and the workspace
// released on a failure. The run's pi session outlives the loop for the
// settle's re-review, the review's verdict turn and the description turn
// (harness-pi item 14) and is ended here after them. The stage's claim and
// the tools' capabilities are run.ts.
import type { ResolvedRequest } from "../../config.js";
import type { AgentDef } from "../../agents/registry.js";
import { chatActorOf } from "../authz/actor.js";
import { predicateFor } from "../authz/predicate.js";
import { unitOfIdempotencyKey, type CoordinatorTag } from "../coordinator/contract.js";
import { DECISION_RECORD_ENV } from "../decisionRecordReservation.js";
import { budgetedAgent, type RunProfile } from "../../config/profile.js";
import { parseModelRef } from "../provider.js";
import type { ModelCard } from "../modelCard.js";
import { mergeTools, TOOLSETS } from "../../tools/toolsets.js";
import {
  HarnessContainerReplacedError,
  HarnessGateBypassedError,
  HarnessInterruptedError,
  harnessFactsOf,
  openThroughSeam,
  type HarnessFacts,
  type HarnessResume,
  type HarnessSession,
} from "../harness/contract.js";
import { prepareRelaunch } from "./relaunch.js";
import { harnessNamed } from "../harness/roster.js";
import { harnessContainerFor } from "../harness/botHostContainer.js";
import { workspaceBindingFor } from "../../execution/factory.js";
import type { BranchStartState } from "../../execution/identityRewrite.js";
import { isContainerGone } from "../harness/container.js";
import { ModelPolicyRefusedError, ModelTransientFailureError } from "../harness/pi/harness.js";
import type { ExistingPrPublicationAuthority, ExistingPrPublicationFence } from "../harness/pi/toolRules.js";
import {
  HARD_STOP_MESSAGE,
  windDownAnswer,
  type EndingFacts,
  type WindDownEnding,
  type WorkspaceAtEnd,
} from "../harness/windDown.js";
import { loopEndingOf, reviewPostedBefore, type LoopEnding } from "../runLedger/resume.js";
import type { RouteDecided } from "./route.js";
import {
  commitsOverBase,
  fetchPullRequestFacts,
  fetchRepoShipInfo,
  findOpenPrByHead,
  openPullRequest,
  updatePullRequest,
} from "../../execution/githubPulls.js";
import type { ChatMessage } from "../chatMessage.js";
import type { McpToolsForRun } from "../../mcp/source.js";
import { currentPrHeadSha, prCommitsSince, recordPrOf, type RepoContext } from "../repoContext.js";
import { verifyExistingPrPublication } from "../existingPrPublication.js";
import { pairedPublicationPush, restoredPublicationHead, publicationReceiptsFromState } from "../publicationPush.js";
import { PrDescriptionSchema, redactPrDescription, type PrDescription } from "../prDescription.js";
import { parseHandoff, type Handoff } from "../ship/handoff.js";
import {
  parseDispositionsInput,
  parseVerdictInput,
  type AddressSeverity,
  type AddressSeveritySource,
  type FindingDisposition,
  type ReviewVerdict,
} from "../reviewVerdict.js";
import { parseDigestReport, type DigestReport } from "../diffDigest.js";
import { runReviewPostStep, settleReviewedHead, type ReviewPostOutcome, type RoundWorkspace } from "../reviewRound.js";
import { postReviewComment } from "../../execution/githubComments.js";
import {
  observeCodingWorkspace,
  runCodingPrPostStep,
  salvageBudgetPush,
  salvageTargetOf,
  trackPushedBranch,
  workLeftBehindLabel,
  workLeftBehindOf,
  workLeftBehindSummary,
} from "../codingPrPostStep.js";
import { descriptionTurnTarget, runDescriptionTurn } from "../descriptionTurn.js";
import { runVerdictTurn } from "../verdictTurn.js";
import { reviewPostOptedOut } from "../reviewPost.js";
import { startReviewReadingDiff } from "../readingDiff.js";
import { startReviewDescription } from "../reviewDescription.js";
import { isSpanRecord, redactAndCap, type RunEvent } from "../runEvents.js";
import { RunEventLane } from "../runEventLane.js";
import { oneLine } from "../redact.js";
import { analyzeRunFriction, type FrictionDiagnosis } from "../runFriction.js";
import { markdownOutput } from "../llmOutput/index.js";
import { callsInFlight, pushedBranchesOf, type RunFailure, type RunSeed, type RunStatus } from "../runRecord.js";
import type { RunHandle, RunRegistry } from "../runRegistry.js";
import type { LedgerRun } from "../runLedger/writeThrough.js";
import { assignRunLiveState } from "../runLiveState.js";
import { causeOfClose } from "../plane/decide.js";
import { RefusalError } from "../refusal.js";
import type { RunsReadCapability, SteerCapability } from "../../tools/runs.js";
import type { WaitCapability } from "./awaitChildren.js";
import type { SpawnCapability } from "./spawn.js";
import type { SessionCapability } from "../../tools/session.js";
import { inFlightCallAfter, quietSuffix, type InFlightTool } from "../statusCardLabel.js";
import { eventsInWindow, paceText, PACE_WINDOW_MS } from "../runPace.js";
import { activityText, type CardShell } from "../statusCardFrame.js";
import type { RunEnding } from "../runEnding.js";
import type { LiveThread } from "../threadAdmission.js";
import type { ChannelVisibility } from "../authz/types.js";
import type { Clock, Span } from "../trace/types.js";
import { publicEnv } from "../../secrets.js";
import type { ChannelIO, IncomingMessage, StagedFile, StatusActivity, StatusHandle } from "../types.js";
import type { DispatchFollowUp, ResumeContext } from "./admission.js";
import type { RegisteredRun } from "./provision.js";
import { registerFinishRecord } from "./record.js";
import { artifactLink, cardActivity, compactActivity, replyAck, threadPageLink } from "./reply.js";
import { shows } from "../verbosity.js";
import { stageIntoWorkspace, stagingIndex, type WorkspaceFiles } from "./staging.js";
import { githubCapabilityFor, shutdownNotice, webCapability, type RunDeps } from "./run.js";
import { buildDepotCi } from "../../execution/depotCi.js";

/** Longest note summary the loop writes for an ending (`run_failed`, `workspace_torn_down`): a reason, not a stack dump. */
const ENDING_NOTE_MAX = 500;

/** What the loop hands back once the run has answered: the answer as
 *  canonicalized for every projection, the head the review settled on, the
 *  coding post-step's note, the finish-site diagnosis the done card carries,
 *  the checklist views for the closed card, and the workspace release the
 *  reply stage calls after the answer landed. The review post-step runs
 *  inside the loop (agent-review.md item 18), so its inputs stay here. */
export interface RunOutcome {
  kind: "answered";
  answer: string;
  reviewHead: string | undefined;
  /** The verdict the review submitted, and how its post-step ended — the
   *  reply stage renders the channel reply from them (agent-review.md item 5b). */
  verdict: ReviewVerdict | undefined;
  reviewPost: ReviewPostOutcome | undefined;
  /** A stop landed before the review used any substantive tool. The reply is
   *  the stop sentence itself, not the normal verdict projection. */
  reviewStoppedBeforeStart: boolean;
  prNote: string | undefined;
  /** "Did real work" — the memory reflection gate. */
  toolCalls: number;
  runDiagnosis: FrictionDiagnosis | undefined;
  /** The agent's checklist exactly as it left it (○/✱ items still open) — what a failed or stopped card shows. */
  checklistAsLeft: () => string | undefined;
  /** The same checklist with every open item ticked ✓ — what a completed card shows. */
  checklistCheckedOff: () => string | undefined;
  releaseWorkspace: (span?: Span) => Promise<void>;
}

/** The run was interrupted rather than answered (harness.md item 7; the floor
 *  of record 0038's survival clause): its container was replaced under it, or
 *  its row's facts were another harness's. The loop has finished the run
 *  `interrupted`, ended the harness's process, released the workspace and
 *  closed the card 🔁 with `reason`; what is left is the dispatcher's — the
 *  request's outcome by name, and the request run again as a new run in the
 *  thread once the thread is free, the path a refused workspace re-attach
 *  takes (run-history item 54). */
export interface RunInterrupted {
  kind: "interrupted";
  /** The closed card's one line: why the run restarts from its request. */
  reason: string;
  /** The request's outcome by name — the dispatcher's refusal token. */
  refusal: string;
  /** The interruption's words, as the record's note carries them. */
  note: string;
  /** The request to run again as a new run, the run it restarts — the one
   *  just closed, which admission must never steer the request into — and
   *  the coordinator tag the run carried, so a coordinator's child restarts as
   *  the same instance's child: its unit branch its own push target, the
   *  plan's base the branch its pull request targets (run-history item 48a). */
  restart: { request: IncomingMessage; restartOf: string; coordinator?: CoordinatorTag };
}

export type RunLoopOutcome = RunOutcome | RunInterrupted;

/** What `runLoop` reads off the dispatch. */
export interface RunLoopContext {
  msg: IncomingMessage;
  io: ChannelIO;
  agent: AgentDef;
  /** The run's effective profile: the budget the runner is handed is its minutes. */
  profile: RunProfile;
  resolved: ResolvedRequest;
  messages: ChatMessage[];
  system: string;
  mcpForRun: McpToolsForRun;
  run: RunHandle;
  registry: RunRegistry;
  /** The registration-time lane shared with the request trace. */
  events?: RunEventLane;
  round: RoundWorkspace;
  admitted: LiveThread<DispatchFollowUp>;
  ledgerRun: LedgerRun | undefined;
  resume: ResumeContext | undefined;
  repoCtx: RepoContext;
  isPrReview: boolean;
  isCodingPrRun: boolean;
  /** The head this run reviews at the start; the settle may advance it. */
  reviewHead: string | undefined;
  /** The request's text with its directives stripped — what the review
   *  post-step reads the opt-out from (agent-review.md item 18). */
  requestText: string;
  /** Decision-record reservation exposed to the child process and its brief. */
  decisionRecord?: string;
  card: StatusHandle;
  shell: CardShell;
  /** The done card's shape and queued lines, from the finish-site diagnosis (the dispatch's `doneLines`). */
  doneLines: (diagnosis: FrictionDiagnosis | undefined) => { shape?: string; queued?: string };
  clock: Clock;
  root: Span;
  /** When the run started — the ack card's clock, before the attach and the prompt. */
  startedAt: number;
  /** When the loop took the card, after the claim: the activity clock's start (the "quiet for …" suffix counts from here, not from `startedAt`). */
  loopStartedAt: number;
  /** Recheck the fixed setup deadline after pre-harness awaits, before the
   *  first open. Relaunches continue the harness's lease instead. */
  assertAdmissionBudget: () => void;
  channelVisibility: ChannelVisibility;
  /** The severity to address in force for this run (agent-review.md item 5a),
   *  resolved by the dispatcher — directive > user > channel > org — for the
   *  verdict parser: a submitted or restored approve carrying a finding at or
   *  above it is a `request_changes`. */
  addressSeverity: { level: AddressSeverity; source: AddressSeveritySource };
  publishText: RegisteredRun["publishText"];
  ending: RunEnding;
  /** This run's spawn capability, the requester's run reads, the steer into a
   *  child and the wait on the children, for the run tools
   *  (docs/reference/specs/agent-conductor.md); `dispatch()` always hands all
   *  four. Absent (a loop driven outside it, in a test) → the tools answer
   *  honestly that no run is spawning here. */
  spawn?: SpawnCapability;
  runs?: RunsReadCapability;
  steer?: SteerCapability;
  wait?: WaitCapability;
  /** The run's reach into its own session log (docs/reference/specs/session-log.md
   *  item 10) for the `recall` and `notes` tools and the notepad the pi harness
   *  steers after a compaction; absent for a run without a session. */
  session?: SessionCapability;
  /** The run's staging counter (record 0033), shared with the request's
   *  staging in the dispatcher so a steer's files never reuse a workspace
   *  path. Absent (a loop driven outside `dispatch()`) → a counter of its own. */
  stagingIndex?: () => number;
  /** Where this run's staged files sit in its workspace (record 0033), shared
   *  with the dispatcher's staging so a steer's files resolve for `recall` too. */
  workspaceFiles?: WorkspaceFiles;
  /** The route the run ran under (routing-and-config item 21) — the router's
   *  decision or the thread's a sticky follow-up carried — for the finish
   *  record; absent for a preset a person, a scope or the default chose. */
  route?: RouteDecided;
  /** The run that spawned this one (run-history item 46), when it is a child. */
  parentRunId?: string;
  /** The coordinator's instance and key (item 48), when a coordinator spawned it. */
  coordinator?: CoordinatorTag;
  /** Where the run's conversation started (run-history item 52), for the finish
   *  record; `dispatch()` always hands it. */
  seed?: RunSeed;
  /** The run's model-proxy bearer as minted (docs/reference/specs/model-proxy.md):
   *  the harness hands it to pi as its provider key. Absent without a store —
   *  then no run can start here, and the loop says so by name. */
  bearer?: string;
  /** The run's resolved model card (record 0052), the dispatcher's resolve
   *  stage's answer: the harness writes it into its process's configuration in
   *  place of an invented one. Absent on a hand-built context (a test). */
  modelCard?: ModelCard;
}

/**
 * The agent loop and everything that rides on it, from the first model call to
 * the finished stream: the card frame per event, the follow-up inbox, the
 * reviewed-head settle, the workspace observation, the description turn, the
 * coding PR post-step, the answer published as the record's source of truth;
 * then the finish — the registry closed with the terminal status, the
 * diagnosis, the record registered for the drain, a failed run's card closed.
 * A run interrupted rather than failed is the loop's own outcome, finished
 * and closed here for the dispatcher to run again. A throw propagates after
 * the workspace is released, as before; the caller's outer catch replies.
 */
export async function runLoop(deps: RunDeps, ctx: RunLoopContext): Promise<RunLoopOutcome> {
  const {
    msg,
    io,
    profile,
    resolved,
    messages,
    system,
    mcpForRun,
    run,
    registry,
    admitted,
    ledgerRun,
    resume,
    repoCtx,
    isPrReview,
    isCodingPrRun,
    card,
    shell,
    doneLines,
    clock,
    root,
    startedAt,
    channelVisibility,
    publishText,
    ending,
    spawn,
    runs,
    steer,
    wait,
    session,
    route,
    parentRunId,
    coordinator,
    seed,
  } = ctx;
  const events = ctx.events ?? new RunEventLane((event) => registry.publish(run.id, event));
  // The def the runner and the post-run turns read: the preset with the
  // EFFECTIVE budget (its deadline, wrap-up warning and budget label read
  // `maxMinutes`) — a copy, never the shared registry entry.
  const agent = budgetedAgent(ctx.agent, profile);
  // The executor the run holds: the dispatch's attach, or — after its
  // container was replaced under a living bot and the process relaunched
  // (harness.md item 6) — the same workspace re-attached in the replacement,
  // which the harness's container and the relayed tools read from then on.
  // The round stays the dispatch's: its release gives the same workspace back.
  const { round } = ctx;
  let { executor } = round.selection;
  const { binding } = round.selection;
  // The plan's base for a coordinator's child (run-history item 48a): the
  // tag's — the spawn's own, or the one the `coordinator_tag` event carried
  // across a roll — else, when the tag lost it, the second guard: the parent
  // instance's record in the coordinator store, read by `parentInstanceId`.
  // Resolved once and shared by the gate's push rules (the base a child may
  // never push to — judged before the session opens, whatever the run's
  // post-steps) and the PR post-step (the base its pull request targets).
  const coordinatorBase: Promise<string | undefined> = (async () => {
    if (coordinator === undefined) return undefined;
    if (coordinator.base !== undefined || repoCtx.baseRef !== undefined) return coordinator.base;
    try {
      return (await deps.coordinatorInstances?.get(coordinator.parentInstanceId))?.base;
    } catch (err) {
      console.warn(
        `[pr-post] ${msg.threadKey} coordinator store lookup failed for ${coordinator.parentInstanceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  })();
  /** The existing-PR receipt resolved immediately before the harness opens.
   * Mechanical salvage shares it, so no ending path can bypass the atomic
   * lease or redirect committed work to another ref. */
  let existingPrPublication: ExistingPrPublicationAuthority | undefined;
  /** The harness receives this wrapper by reference. If any mechanical push
   * loses its atomic lease, replacing `authority` revokes the already-open
   * harness's model-issued pushes as well as every later salvage path. */
  let existingPrPublicationFence: ExistingPrPublicationFence | undefined;
  const blockExistingPrPublication = (reason: string): void => {
    existingPrPublication = { blocked: reason };
    if (existingPrPublicationFence !== undefined) existingPrPublicationFence.authority = existingPrPublication;
  };
  // The start state of the run's branch (record 0062; identityRewrite.ts):
  // fired HERE, at the attach, so the identity rewrite in the post-step
  // judges only the run's own commits. The read runs concurrently with the
  // model loop and is awaited only when the PR target is built — one HTTP
  // compare ordinarily settles long before the model's first push, but a push
  // that landed faster would fold into the start state and pass unjudged; the
  // guarantee is the head start, not a barrier. A RESUMED run whose ledger
  // row records a pre-restart push of this very branch is that fold made
  // systematic, not a race: the re-read would list the run's own pre-restart
  // commits as "start state" and pass them unjudged — so no read is fired and
  // the start state is `unknown`, on which the rewrite fails closed. The
  // branch the dispatch knows at attach is the binding's ref (a coordinator's
  // unit branch, a fix round's PR head); a run that later pushes a branch of
  // its own cut it in this workspace, so that branch's start state is empty —
  // the post-step tells the two apart by `startBranch`. Fired once, joined at
  // the PR target below; a failed read records `unknown`, on which the
  // rewrite fails closed.
  const identitySeam = deps.identityRewrite;
  const startStateRead: Promise<{ branch: string; state: BranchStartState } | undefined> | undefined =
    identitySeam !== undefined && isCodingPrRun && repoCtx.repo !== undefined
      ? (async () => {
          const repo = repoCtx.repo;
          if (repo === undefined) return undefined;
          const branch = binding?.ref ?? repoCtx.ref;
          if (branch === undefined) return undefined;
          const preRestartPush = resume?.row.state.pushedBranch;
          if (typeof preRestartPush === "string" && preRestartPush === branch)
            return {
              branch,
              state: {
                kind: "unknown" as const,
                reason: `the run pushed ${branch} before a restart, so a start state read now would fold the run's own commits in`,
              },
            };
          const base = repoCtx.baseRef ?? (await coordinatorBase) ?? branch;
          const state = await identitySeam
            .readStartState(repo, base, branch)
            .catch((): BranchStartState => ({ kind: "unknown" }));
          return { branch, state };
        })()
      : undefined;
  let reviewHead = ctx.reviewHead;
  let lastActivityAt = ctx.loopStartedAt;
  // The card body is the agent's own checklist (via the update_status tool)
  // plus a live one-line activity trace (current tool call + redacted result
  // summary) so the card reflects progress per tool event, not only on the
  // 5s heartbeat. Full command output still goes to stdout for operators.
  // On a resume the dispatcher-local state comes back from the row (item 38):
  // the checklist the card shows, the verdict/description already submitted,
  // the branch already pushed.
  const restored = resume?.row.state ?? {};
  // The bounded display backlog may trim a push during a long test run. Its
  // small typed receipts also ride the durable state, atomically with results.
  const restoredReceipts = publicationReceiptsFromState(restored.publicationReceipts);
  const publicationReceipts =
    coordinator?.publication !== undefined &&
    restoredPublicationHead(restoredReceipts, coordinator.publication) !== undefined
      ? restoredReceipts
      : [];
  const retainPublicationReceipts = () => {
    const history = registry.snapshot(run.id, run.token)?.events ?? [];
    const latest = publicationReceipts.at(-1);
    // Rehydrate only the final projected head, never append an older receipt
    // behind a newer mechanical salvage or identity-rewrite push.
    if (latest !== undefined && !history.some((e) => e.type === "pushed_head" && e.ref === latest.ref))
      registry.publish(run.id, latest);
  };
  let checklist: string | undefined = typeof restored.checklist === "string" ? restored.checklist : undefined;
  // Typed (`StatusActivity`): a bash call rides as its full command, which
  // the Slack card draws as a code block; everything else as its one line.
  let lastActivity: StatusActivity | undefined;
  // The call whose tool has no result yet — the title says the wait is the
  // tool's (`running bash (Ns)`, or the bound-exceeded mark), not the model's
  // (`thinking …`).
  let inFlightTool: InFlightTool | undefined;
  // The stall signal's pace facts (live-view item 32): the content events'
  // clock stamps inside the window, and the newest tool call's — the card's
  // title carries `· 2.8/min`, or `· no tool call for N min` once nothing has
  // landed for a window, the same words the runs-index row shows.
  const paceEventAts: number[] = [];
  let lastToolCallAt: number | undefined;
  const cardPace = () => {
    const now = clock();
    while (paceEventAts.length > 0 && paceEventAts[0] <= now - PACE_WINDOW_MS) paceEventAts.shift();
    const pace = paceText(
      { startedAt: ctx.loopStartedAt, lastToolCallAt, eventsLast5m: eventsInWindow(paceEventAts, now) },
      now,
    );
    return pace ? ` · ${pace}` : "";
  };
  // The shutdown notice rides on the LIVE frame only: the closed card is
  // built from `shell.close` and never mentions the restart.
  // Activity and pace are internal narration: quiet keeps the checklist and
  // outcome alone, verbose keeps the existing short tool caption and pace,
  // and debug adds the full command plus wait diagnosis.
  const showsActivity = shows(resolved.verbosity, "verbose");
  const chatty = shows(resolved.verbosity, "debug");
  // The update_status round trip is bookkeeping: the checklist itself just
  // repainted the card, so below `verbose` its call/result pair never rides
  // as activity — the card shows the fresh checklist alone instead of a meta
  // line restating that it was updated (routing-and-config item 28).
  const showBookkeeping = shows(resolved.verbosity, "verbose");
  const currentFrame = () =>
    shell.live({
      suffix: showsActivity
        ? chatty
          ? `${quietSuffix(clock() - lastActivityAt, inFlightTool)}${cardPace()}`
          : cardPace()
        : "",
      notice: shutdownNotice(),
      detail: [checklist],
      activity: showsActivity ? (chatty ? lastActivity : compactActivity(lastActivity)) : undefined,
    });
  // The closed card keeps the run link (the run page outlives the run and
  // shows the final answer) and the agent's checklist; only the transient
  // activity trace is dropped. On a clean ✅ finish every item is marked ✓ —
  // the run completing IS the proof they happened, and the model rarely
  // re-posts the checklist after its last step; a stop/failure keeps the
  // honest partial state.
  const checklistAsLeft = () => checklist;
  const checklistCheckedOff = () => checklist?.replace(/^(\s*)[○✱](?=\s)/gm, "$1✓");
  // The runner's progress notes carry the 💭 thought line at each model turn
  // (docs/reference/specs/tracing.md): the card shows it as activity, as it showed the
  // `turn` event before spans replaced it.
  const onProgress = (note: string) => {
    console.log(`[note] ${msg.threadKey} ${note}`);
    lastActivityAt = clock();
    lastActivity = { kind: "line", text: note };
    card.update(currentFrame());
  };
  // Live run-visibility (Area 2): each tool call/result refreshes the card
  // immediately, so activity is visible without waiting for the heartbeat.
  let toolCalls = 0; // "did real work" signal for the memory reflection gate
  // The branch the run's own `git push` named, read off its bash calls and
  // results as they stream by (docs/reference/specs/pr-description.md item 5):
  // a standalone PR post-step opens from THIS branch, and from the checkout
  // only when no push was observed. A coordinator child owns its bound ref
  // instead: the checkout and the last push may be an auxiliary branch.
  const pushes = trackPushedBranch(typeof restored.pushedBranch === "string" ? restored.pushedBranch : undefined);
  // The loop ended at its time budget (the harness's wind-down note): a ship
  // coding child then salvages what its tree still holds (push-before-abort,
  // agent-ship.md item 8) after the workspace observation below.
  let budgetEnded = false;
  // The registry backlog is the run's ONE event store: the live
  // page, the post-run friction diagnosis and the run record all read it back
  // via `registry.snapshot` — there is no second copy to drift from it.
  let recordedPushedBranch: string | undefined;
  let modelBudgetEndsAt: number | undefined;
  // The successful result owns the receipt, not the later salvage/post-step.
  // Its full source SHA must agree with Git's exact leased result. A later
  // GitHub outage or competing push cannot erase a push that already happened;
  // the coordinator independently rechecks live PR/ref ownership before use.
  const receiptAtToolResult = async (e: RunEvent): Promise<Extract<RunEvent, { type: "pushed_head" }> | undefined> => {
    const binding = coordinator?.publication;
    const authority = existingPrPublicationFence?.authority;
    if (
      e.type !== "tool_result" ||
      e.tool !== "bash" ||
      !e.ok ||
      e.exitCode !== 0 ||
      e.cut ||
      binding === undefined ||
      authority === undefined ||
      "blocked" in authority
    )
      return;
    const history = registry.snapshot(run.id, run.token)?.events ?? [];
    const gates = history.filter((event) => event.type === "publication_push_authorized" && event.callId === e.callId);
    if (
      gates.length !== 1 ||
      gates[0]?.type !== "publication_push_authorized" ||
      gates[0].ref !== authority.ref ||
      gates[0].expectedHeadSha !== authority.expectedHeadSha
    )
      return;
    try {
      const head = (await executor.exec(`git rev-parse refs/heads/${authority.ref}`)).trim();
      const current = { ...binding, expectedHeadSha: authority.expectedHeadSha };
      return pairedPublicationPush([...history, e], current, head, e.callId);
    } catch {
      // An uncertain result is not permission to invent a push or retry one.
      return;
    }
  };
  const publishEvent = (e: RunEvent, startsRunBudget: boolean) => {
    registry.publish(run.id, e); // feed the external live-view stream
    if (isSpanRecord(e)) return; // timing, not activity (docs/reference/specs/tracing.md): the card and its clock ignore it
    if (startsRunBudget) return; // budget metadata, not activity
    if (e.type === "tool_call") toolCalls++;
    if (e.type === "run_note" && e.kind === "time_budget_exhausted") budgetEnded = true;
    if (isCodingPrRun) {
      pushes.observe(e);
      const pushedBranch = pushes.branch();
      if (pushedBranch !== undefined && pushedBranch !== recordedPushedBranch) {
        recordedPushedBranch = pushedBranch;
        ledgerRun?.setState({ pushedBranch });
      }
    }
    inFlightTool = inFlightCallAfter(inFlightTool, e);
    lastActivityAt = clock();
    paceEventAts.push(lastActivityAt);
    if (e.type === "tool_call") lastToolCallAt = lastActivityAt;
    const bookkeeping = (e.type === "tool_call" || e.type === "tool_result") && e.tool === "update_status";
    // The operator log keeps every event; only the card's activity is gated.
    console.log(`[tool] ${msg.threadKey} ${activityText(cardActivity(e))}`);
    lastActivity = bookkeeping && !showBookkeeping ? undefined : cardActivity(e);
    card.update(currentFrame());
  };
  const onEvent = (e: RunEvent) => {
    // Authorization precedes execution, while streamed results and their local
    // ref reads may lag behind it. Close both harness gates synchronously so
    // no later tool can move/delete the source before attribution finishes.
    if (e.type === "publication_push_authorized" && existingPrPublicationFence !== undefined)
      existingPrPublicationFence.attributingCallId = e.callId;
    // A harness starts consuming the run budget in the same turn that emits
    // its boundary. Start the control synchronously; publication still goes
    // through the ordered lane below with every other event.
    const startsRunBudget = e.type === "lease";
    if (startsRunBudget) {
      modelBudgetEndsAt = e.endsAt;
      run.control.startLease(() => e.endsAt - clock());
    }
    // One ordered lane owns every streamed event. Tool projection may await the
    // ledger, so letting later events publish outside this lane would let them
    // consume the sequence the durable source event is about to commit.
    void events.write(async () => {
      const receipt = await receiptAtToolResult(e);
      // Losing ledger tracking is not a successful commit. Only the atomic
      // write below can grant receipt authority, never the local projection.
      let receiptCommitted = false;
      if ((e.type === "tool_call" || e.type === "tool_result") && typeof registry.commitLiveState === "function") {
        const summary = registry.getById(run.id);
        if (summary?.liveState?.state === "working") {
          const at = e.at ?? clock();
          const bound =
            e.type === "tool_call" && e.boundMs !== undefined
              ? at + e.boundMs
              : (modelBudgetEndsAt ?? summary.liveState.bound);
          if (bound !== undefined) {
            const sourceSeq = summary.eventCount + 1;
            const assignment = {
              expectedSeq: summary.liveStateSeq ?? 0,
              at,
              state: "working" as const,
              bound,
              detail: e.type === "tool_call" ? "running a tool" : "model turn",
              sourceEvents: [{ ...e, seq: sourceSeq }, ...(receipt ? [{ ...receipt, seq: sourceSeq + 1, at }] : [])],
              ...(receipt ? { statePatch: { publicationReceipts: [...publicationReceipts, receipt] } } : {}),
            };
            try {
              if (ledgerRun?.tracked()) {
                const committed = await ledgerRun.assignLiveState(assignment);
                if (committed.ok) {
                  registry.commitLiveState(run.id, committed);
                  receiptCommitted = true;
                }
              } else {
                const local = assignRunLiveState(summary.liveState, summary.liveStateSeq ?? 0, assignment);
                if (local.ok) registry.commitLiveState(run.id, { ...local, liveStateSeq: sourceSeq });
              }
            } catch (err) {
              // Projection is a durable convenience; the run's event stream is
              // still the operator log and must survive a failed projection.
              console.warn(
                `[run] ${msg.threadKey} live-state projection failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      }
      publishEvent(e, startsRunBudget);
      if (receipt !== undefined) {
        if (receiptCommitted) {
          // assignLiveState owns the receipt's only durable write, atomically
          // with its result. A later state patch must never promote a failed
          // commit into restart authority or the run's pushed projection.
          publicationReceipts.push(receipt);
          publishEvent(receipt, false);
          existingPrPublication = { ref: receipt.ref, expectedHeadSha: receipt.sha };
          if (existingPrPublicationFence !== undefined) existingPrPublicationFence.authority = existingPrPublication;
        } else blockExistingPrPublication("the successful push receipt could not be committed durably");
      }
      if (
        e.type === "tool_result" &&
        existingPrPublicationFence !== undefined &&
        existingPrPublicationFence.attributingCallId === e.callId
      )
        delete existingPrPublicationFence.attributingCallId;
    });
  };
  // A configured MCP server that did not answer discovery is a fact of the
  // run (docs/reference/specs/mcp-tools.md item 8): one note per server, before the
  // first tool event, so the run page explains a missing tool.
  for (const s of mcpForRun?.servers ?? []) {
    if (s.unavailable !== undefined)
      onEvent({
        type: "run_note",
        kind: "mcp_unavailable",
        summary: `MCP server ${s.server} unavailable: ${s.unavailable}`,
      });
  }
  const reportProgress = (list: string) => {
    const trimmed = list.trim();
    // An empty update never erases the checklist: the closed card is the
    // run's durable progress record, and an agent "clearing" its status as
    // it wraps up would blank it (review agents do exactly that).
    if (!trimmed) return;
    checklist = trimmed;
    ledgerRun?.setState({ checklist: trimmed });
    card.update(currentFrame());
  };
  // Heartbeat: the card ticks every 5s no matter what. A ticking timer means
  // the run is alive; a stopped timer means the process died — the reader
  // can always tell the difference.
  const heartbeat = setInterval(() => card.update(currentFrame()), 5000);

  // The reading-diff baseline (docs/reference/specs/reading-diff.md item 4): a PR review
  // run gets the change as a reviewer reads it — the full git diff, produced
  // CONCURRENTLY with the review by the run's own executor (a read-only
  // command; the resident runs it beside the model's) and published straight
  // to the registry like the other dispatcher facts. Guaranteed: the
  // dispatcher joins it before the answer publish below (a join on a
  // seconds-long command started here — never a timeout race). The ABRIDGED
  // diff is not this run's business: it is produced on the bot host after the
  // record is durable (reviewAbridge.ts — on demand, or automatically with
  // `provider: meat` through the run-history writer's persist hook).
  let readingDiffBaseline: Promise<boolean> | undefined;
  let descriptionArtifact: Promise<boolean> | undefined;
  if (agent.name === "review" && repoCtx.pr !== undefined) {
    // The PR's description as data (docs/reference/specs/reading-diff.md item 7): the
    // object a coding run submitted for this head when the run store has one,
    // else the body GitHub holds parsed back. A store read, so it is joined
    // before the answer like the baseline below — never awaited here.
    descriptionArtifact = startReviewDescription({
      store: deps.runStore,
      repoCtx,
      publish: (event) => events.publish(event),
    });
    // One background span (docs/reference/specs/tracing.md): concurrent with the loop,
    // structure for the partition, never a counted term — started under the
    // root inside `startReviewReadingDiff`, so the diff's exec is its child.
    readingDiffBaseline = startReviewReadingDiff({
      executor,
      cfg: deps.config.config.review?.readingDiff,
      env: publicEnv(),
      baseRef: repoCtx.baseRef,
      publish: (event) => events.publish(event),
      parent: root,
    }).baseline.then((published) => {
      console.log(`[reading-diff] ${msg.threadKey} baseline ${published ? "published" : "none"}`);
      return published;
    });
  }

  let answer: string;
  // Review verdict, set only through the structured submit_verdict tool; the
  // post-step below turns it into the deterministic first line of the GitHub
  // body (fail-closed: no call → not approving). See reviewVerdict.ts.
  // Ledger state is a system boundary: the row's verdict and description are
  // re-validated through the same parsers the tools use, never trusted as-is.
  let verdict: ReviewVerdict | undefined =
    typeof restored.verdict === "object" && restored.verdict !== null
      ? (parseVerdictInput(restored.verdict as Record<string, unknown>, {
          addressSeverity: ctx.addressSeverity.level,
        }) ?? undefined)
      : undefined;
  const onVerdict = (v: ReviewVerdict) => {
    verdict = v;
    ledgerRun?.setState({ verdict: v });
  };
  // The review's diff digest, set only through the diff_digest tool (the last
  // call wins); the post-step holds its totals against the PR's size and
  // refuses a verdict whose digest covered less. Restored like the verdict, so
  // a resumed run keeps what its earlier generation digested.
  let digest: DigestReport | undefined = parseDigestReport(restored.digest);
  const onDigest = (d: DigestReport) => {
    digest = d;
    ledgerRun?.setState({ digest: d });
  };
  // Coding PR description, set only through the structured
  // submit_pr_description tool (the last valid call wins — a resubmit after
  // a fix-up push supersedes the earlier one); the post-step below renders
  // the GitHub body from it at the observed pushed head and opens/edits the
  // PR. See prDescription.ts.
  // Restored against the universal schema, never the title gate's: the gate
  // judged the title when it was submitted, and a row written before a gate
  // change must not lose its description on resume. A row that still fails is
  // dropped fail-closed — said in the log, so the post-step's "no valid
  // description" has a cause on record.
  const restoredDescription = PrDescriptionSchema.safeParse(restored.prDescription);
  let prDescription: PrDescription | undefined = restoredDescription.success ? restoredDescription.data : undefined;
  if (!restoredDescription.success && restored.prDescription !== undefined) {
    const why = restoredDescription.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    console.log(`[resume] ${msg.threadKey} the restored PR description no longer parses and is dropped — ${why}`);
  }
  const onPrDescription = (d: PrDescription) => {
    prDescription = d;
    ledgerRun?.setState({ prDescription: d });
  };
  // The unit handoff (docs/reference/specs/agent-coding.md item 9), set only
  // through submit_handoff — the last valid call wins — and restored like the
  // description so a resumed run keeps what its earlier generation submitted.
  // A plain coding run has no board issue to post it to: the finish record
  // (redacted there) is where it lands.
  const restoredHandoff = parseHandoff(restored.handoff);
  let handoff: Handoff | undefined = restoredHandoff.ok ? restoredHandoff.handoff : undefined;
  const onHandoff = (h: Handoff) => {
    handoff = h;
    ledgerRun?.setState({ handoff: h });
  };
  // The dispositions a coding run records through submit_dispositions (agent-ship
  // item 6): whatever it submits, the last call wins, restored like the handoff
  // and recorded on the finish record. The run holds no list of a review's
  // finding ids; the plan runner matches the set to its round's findings when
  // it reads the record.
  const restoredDispositions = parseDispositionsInput({ dispositions: restored.dispositions })?.dispositions;
  let dispositions: FindingDisposition[] | undefined = restoredDispositions;
  const onDispositions = (d: FindingDisposition[]) => {
    dispositions = d;
    ledgerRun?.setState({ dispositions: d });
  };
  // The commit actually checked out in the run's workspace when the model
  // finished — read by us, not reported by the model — for the reviewed-head
  // guard below. Undefined when the cwd is not a git repo (cold sandbox root).
  let observedHead: string | undefined;
  // The PR head branch (coding runs), read alongside it for the PR
  // post-step: the coordinator's owned ref, or for standalone coding the
  // branch the run's push named, else the checked-out branch.
  // Undefined when unreadable or detached ("HEAD" is not a branch — nothing
  // a PR could be opened from) with no push observed.
  let observedBranch: string | undefined;
  // The branch checked out when the workspace was observed — the same as
  // observedBranch unless HEAD moved after the push, in which case
  // observedHead is the PUSHED branch's tip, not HEAD.
  let observedCheckedOut: string | undefined;
  // The commit the remote holds for that branch (`git ls-remote origin
  // refs/heads/<branch>`), the post-step's proof of a push: the branch
  // counts as pushed only when this matches the observed head. Undefined
  // when the remote has no such branch or could not be asked.
  let observedRemoteHead: string | undefined;
  // `owner/name` parsed from the workspace's origin remote, probed only when
  // the dispatch resolved no repo (the agent discovered the repo itself) —
  // the PR-open repo of last resort.
  let observedRemoteRepo: string | undefined;
  // What the run leaves in its tree that will not outlive it (resident-repos
  // item 17): tracked changes and commits no remote holds, read in the same
  // observation, for the `work_left_behind` note. Undefined when unreadable.
  let observedUncommitted: number | undefined;
  let observedUnpushed: number | undefined;
  // The PR post-step's reply note: assembled in the try below — the open
  // runs BEFORE the stream finishes, so its outcome is a fact of the run —
  // and appended to the channel reply at the end.
  let prNote: string | undefined;
  // How the review post-step ended (agent-review.md item 18) — the record's fact.
  let reviewPost: ReviewPostOutcome | undefined;
  // Set when the head moved during the run by a rebase of the same commits
  // (item 12): the post is pinned to `current` with a footer, and the thread
  // is told the review was carried forward.
  let carried: { reviewed: string; current: string; commits: number } | undefined;
  let runFailed = false; // the runner threw → terminal status `failed`
  /** The runner threw the gate's bypass: what ran in the workspace was never vetted, so its release tears it down whatever the record shows in flight. */
  let gateBypassed = false;
  /** Whether the run's ending may have left a command running in its workspace
   *  — a call the ending's abort or interrupt cut (its result marked `cut`), or
   *  open when the run failed, was interrupted or hard-stopped (`callsInFlight`
   *  under the run's status) — read off the record once the harness session has
   *  ended (its end settles what it cut, marked) and before the record is
   *  sealed, said on the record as a `workspace_torn_down` note naming the
   *  calls, and handed to the release, which tears the workspace down for it
   *  rather than pair it (harness.md item 13). */
  let commandInFlight = false;
  /** The registry's retained backlog, copied at the call (a shallow copy of the
   *  event references, `snapshotOf`). */
  const recordEvents = () => registry.snapshot(run.id, run.token)?.events ?? [];
  // The failure by name (run-history item 57), when the harness's throw has
  // one: the record says it, so the session's next seed can act on it.
  let failure: RunFailure | undefined;
  // The verdict that the run is interrupted, not failed (harness.md item 7):
  // the harness's container was replaced under the run (harness-pi item 16),
  // or the row's facts were written by another harness. The harness threw it;
  // the loop finishes the run on it and answers it as its own outcome
  // (`RunInterrupted`): the card says the run restarts, and the dispatcher
  // runs the request again once the thread is free, the path a refused
  // re-attach takes (run-history item 54).
  let interrupted: HarnessInterruptedError | undefined;
  /** The run's terminal status as of now: what the finish hands the registry,
   *  and what the record read deciding the workspace's release goes by. */
  const statusNow = (): RunStatus => {
    const stopped = run.control.requested;
    return interrupted
      ? "interrupted"
      : runFailed
        ? "failed"
        : stopped === "hard"
          ? "stopped_hard"
          : stopped === "soft"
            ? "stopped_soft"
            : "completed";
  };
  /** The harness session's end, once: the process ended (a no-op when the
   *  harness handed no session over), then what its ending left running read
   *  off the record — under the run's status at that moment, which is the
   *  ending's. Called on the loop's way out and again from its catch, since
   *  either may come first; the second call does nothing, so a throw after a
   *  clean end (a publish, a join) fails the run without re-reading the record
   *  under `failed` — which would count a relayed call's unpaired line as a
   *  command in flight, and note a cut call's tear-down twice. An end that
   *  throws is no clean end: the process may still be running with its
   *  command, since the end failed before it could cut or kill anything, so
   *  a run not already interrupted is failed BEFORE the read — an open call is
   *  then a command that may run on — and the end's error is thrown on to the
   *  caller. An interrupted run stays interrupted: that status already reads
   *  an open call as in flight, and the card, the finish and the restart must
   *  say one thing. */
  let harnessEnded = false;
  const endHarness = async (): Promise<void> => {
    if (harnessEnded) return;
    harnessEnded = true;
    try {
      await harnessSession?.end();
    } catch (err) {
      if (interrupted === undefined) runFailed = true;
      throw err;
    } finally {
      // Session end may emit the cut/result that settles an open call. Its
      // publication lane must drain before teardown judges the record.
      await events.drain();
      const calls = callsInFlight(recordEvents(), statusNow());
      commandInFlight = calls.length > 0;
      if (commandInFlight)
        events.publish({
          type: "run_note",
          kind: "workspace_torn_down",
          summary: redactAndCap(
            `a command may still be running in the workspace, so it is torn down rather than paired: ${calls.map((c) => c.summary).join("; ")}`,
            ENDING_NOTE_MAX,
          ),
          at: clock(),
        });
    }
  };
  let runDiagnosis: FrictionDiagnosis | undefined; // the finish-site diagnosis: the done card's shape line
  // The run keeps its harness process alive past the loop (harness-pi item
  // 14): the reviewed-head settle's re-review and the description turn below
  // are one more prompt on that session, and it is ended here once they are
  // done — or on a throw, before the workspace it runs in is released. A
  // `finish` plan has none: the loop had answered before the restart and its
  // process is ended below, so the post-turns run no turn (item 14).
  let harnessSession: HarnessSession | undefined;
  /** The budget's answer when a relaunch found the run inside its write-up reserve (`lease_spent`): the run ends on its budget with no process to write up. */
  let leaseSpentDuringRelaunch: string | undefined;
  /** The wind-down that labelled the loop's answer, when one did — the
   *  harness's (`HarnessSession.ending`), a resumed run's notes' or the lease
   *  spent in a relaunch — so the thread's answer is composed again once the
   *  tail has established the facts (harness-pi item 6, `endingFacts`). */
  let windDownEnding: WindDownEnding | undefined;
  /** Where the ending salvage pushed what the tree held, when it did: the
   *  fact the answer names over the observation that preceded the push. */
  let salvagedTo: { branch: string; head?: string } | undefined;
  let workspaceObserved = false;
  let workSalvageAttempted = false;
  let endingSalvageAttempted = false;
  // A coordinator child publishes one owned ref. An auxiliary push must not
  // redirect its observation, completion checkpoint, or PR post-step.
  const coordinatorBranch =
    coordinator?.publication?.publicationRef ?? (coordinator !== undefined ? (binding?.ref ?? repoCtx.ref) : undefined);
  const observeWorkspaceNow = async () => {
    const pushedBranch = coordinator !== undefined ? coordinatorBranch : pushes.branch();
    const observed = await root.span("run.observe_workspace", (span) =>
      observeCodingWorkspace(
        executor,
        {
          probeRemote: repoCtx.repo === undefined,
          ...(pushedBranch !== undefined ? { pushedBranch } : {}),
        },
        span,
      ),
    );
    workspaceObserved = true;
    observedHead = observed.head;
    observedBranch = observed.branch;
    observedCheckedOut = observed.checkedOut;
    observedRemoteHead = observed.remoteHead;
    observedRemoteRepo = observed.remoteRepo;
    observedUncommitted = observed.uncommittedChanges;
    observedUnpushed = observed.unpushedCommits;
  };
  /** Preserve a coordinator coding child's work before its workspace is
   *  released. Abnormal endings always leave a mechanical marker; an ordinary
   *  completion checkpoints only work the child left dirty or unpushed, so a
   *  clean completed run can still use the description and PR post-steps. */
  const preserveCodingChildWork = async (cue: "budget" | "ending" | "completion"): Promise<void> => {
    if (workSalvageAttempted || !isCodingPrRun || coordinator === undefined) return;
    await events.drain();
    retainPublicationReceipts();
    if (!workspaceObserved) await observeWorkspaceNow();
    const target =
      coordinatorBranch === undefined
        ? { skipped: "the ending checkpoint was skipped: the unit's branch is unavailable" }
        : salvageTargetOf({
            pushedBranch: pushes.branch(),
            checkedOut: observedCheckedOut,
            ownedBranch: coordinatorBranch,
            base: repoCtx.baseRef ?? (await coordinatorBase),
          });
    // The checkpoint measures for itself and includes untracked, non-ignored
    // files. The ordinary workspace observation deliberately counts tracked
    // dirt only and therefore cannot decide that a completed child is clean.
    const salvaged =
      "skipped" in target
        ? { pushed: false, summary: target.skipped }
        : await root.span(cue === "budget" ? "run.budget_salvage" : "run.work_salvage", (span) =>
            salvageBudgetPush(
              executor,
              {
                branch: target.branch,
                cue,
                ...(existingPrPublication !== undefined ? { publication: existingPrPublication } : {}),
              },
              span,
            ),
          );
    if ("publicationBlocked" in salvaged && salvaged.publicationBlocked !== undefined)
      blockExistingPrPublication(salvaged.publicationBlocked);
    const cleanCompletion =
      cue === "completion" &&
      !salvaged.pushed &&
      (/ended with nothing to preserve/i.test(salvaged.summary) ||
        ("skipped" in target && (observedUncommitted ?? 0) === 0 && (observedUnpushed ?? 0) === 0));
    if (cleanCompletion) return;
    workSalvageAttempted = true;
    // A moved checkout was not checkpointed. The owned branch can still be
    // independently proven at the remote and published as a pull request.
    if (cue === "ending" || (cue === "completion" && !("skipped" in target))) endingSalvageAttempted = true;
    onEvent({
      type: "run_note",
      kind: cue === "budget" ? "budget_salvage" : "work_salvage",
      summary: salvaged.summary,
    });
    if (salvaged.pushed && "head" in salvaged && salvaged.head !== undefined && !("skipped" in target)) {
      onEvent({ type: "pushed_head", ref: target.branch, sha: salvaged.head, by: "salvage" });
      salvagedTo = { branch: target.branch, head: salvaged.head };
    } else if (salvaged.pushed && !("skipped" in target)) salvagedTo = { branch: target.branch };
    if (salvaged.pushed) await observeWorkspaceNow();
    else if (existingPrPublication !== undefined && "blocked" in existingPrPublication) {
      // The checkpoint commit is still local. Re-read it so the record/card can
      // name what is retained, and keep this workspace attached at release.
      await observeWorkspaceNow();
      shell.note("quiet", salvaged.summary);
    } else if ("skipped" in target || /failed|not attempted/i.test(salvaged.summary))
      shell.note("quiet", salvaged.summary);
  };
  /** The relaunch's re-attach ended the run — a stop, or the lease spent — so
   *  no process runs and the executor is the replaced container's, whose
   *  worktree was never re-attached: a coding run's workspace observation,
   *  push-before-abort salvage, description turn, work-left-behind note and PR
   *  post-step, and a review's head settle (`git rev-parse HEAD` on the
   *  replaced container), verdict turn and review post-step would each drive
   *  or read a tree nobody looked at (each `/exec` a `needs: attach` the
   *  recovery refuses inside the reserve), or post the budget's answer to the
   *  PR as a verdict it is not. The whole tail is skipped through
   *  `tailSkipped`, as a hard stop skips it — the one predicate every tail
   *  step keys on. */
  let relaunchEndedRun = false;
  // A review stopped before its first substantive tool has no reviewed head or
  // verdict. `update_status` is bookkeeping, not evidence that code was read;
  // any other tool (including submit_verdict) establishes that the review did
  // begin. Only activity before the first stop request counts — the soft-stop
  // write-up and the synthetic verdict turn it used to trigger are tail work.
  let reviewStoppedBeforeStart = false;
  const latchReviewStoppedBeforeStart = (): boolean => {
    if (reviewStoppedBeforeStart || agent.name !== "review") return reviewStoppedBeforeStart;
    const events = recordEvents();
    const stopAt = events.findIndex(
      (event) => event.type === "run_note" && (event.kind === "stop_requested" || event.kind === "stopped"),
    );
    if (stopAt < 0) return false;
    reviewStoppedBeforeStart = !events
      .slice(0, stopAt)
      .some((event) => event.type === "tool_call" && event.tool !== "update_status");
    return reviewStoppedBeforeStart;
  };
  const clearStoppedReviewTail = (): boolean => {
    if (!latchReviewStoppedBeforeStart()) return false;
    answer = "⏹ Review stopped before it started.";
    verdict = undefined;
    reviewHead = undefined;
    observedHead = undefined;
    carried = undefined;
    reviewPost = undefined;
    return true;
  };
  /** Whether the run's tail — a coding run's observation, salvage, description
   *  turn, work-left-behind note and PR post-step; a review's head settle,
   *  verdict turn and review post-step — is skipped: a hard stop observed
   *  nothing and posts nothing, and a relaunch that ended the run has no tree
   *  to look at and no verdict to post. Re-latch at every boundary, since a
   *  soft pre-review stop can land while the preceding tail step awaits. */
  const tailSkipped = (): boolean =>
    run.control.requested === "hard" || relaunchEndedRun || latchReviewStoppedBeforeStart();
  // Give the workspace back now rather than at the inactivity sweep: a
  // resident's pool user is a scarce slot (docs/reference/specs/resident-repos.md item
  // 16a). The release mode is paired to the round's agent by the attach
  // helper (reviewRound.ts): a run's normal end releases the tree whatever
  // it holds — a run starts from a clean tree, and what it left behind was
  // said above — keeping it only while a command is still in flight in it;
  // a read-only agent's, or one an operator HARD-stopped ("tear it down
  // now": the abandoned command may still be running in there, and the
  // whole point of a hard stop is to free the resources), is released
  // unconditionally — and so is one whose ending may have left a command
  // running in it (`callsInFlight`, read once the harness session had ended and
  // before the record was sealed, said on it as a `workspace_torn_down` note:
  // the tool the ending's abort or interrupt cut, a call open when the run
  // failed or was interrupted — a run that completed with a call unpaired left
  // nothing running), since a release that waits for idle would be refused by
  // that command and hold the workspace past the run; and one the gate's
  // bypass failed, whatever the record shows in flight (harness.md item 13).
  // Best-effort — a failed release is a log line, never a failed run. Called AFTER the
  // answer has been sent (or the failure card closed): the `/detach` round
  // trip is bounded at 10 s on a sick resident, and nothing about the reply
  // depends on it, so it must never sit between "answer ready" and the
  // thread. Hard-stop is read at CALL time — it may land during the run.
  // Under `post.workspace_release`: the release's own call is that span's child.
  // The release hands over what the run pushed (resident-repos item 16a) —
  // the branches its `pr_opened` events name, read off the run's own backlog
  // (the same read the finish makes) at CALL time so the post-step's event is
  // in — so a resident thread remembers its own branches once the clean tree
  // is gone and a follow-up can rebind onto them.
  const keepBlockedPublicationWorkspace = (): boolean =>
    existingPrPublication !== undefined &&
    "blocked" in existingPrPublication &&
    run.control.requested !== "hard" &&
    !commandInFlight &&
    !gateBypassed &&
    ((observedUncommitted ?? 0) > 0 || (observedUnpushed ?? 0) > 0);
  const releaseWorkspace = (span?: Span) => {
    // A denied existing-PR publication may leave the only copy of a tested
    // commit in this checkout. Do not detach and prove its deletion; keep the
    // workspace available to the resident/sandbox retention policy and report
    // that retention beyond this run is not guaranteed. Hard stops, live
    // commands and gate bypasses retain their mandatory teardown.
    if (keepBlockedPublicationWorkspace()) return Promise.resolve();
    const events = recordEvents();
    const pushed = pushedBranchesOf(events);
    return round.release({
      hardStopped: run.control.requested === "hard",
      commandInFlight,
      gateBypassed,
      ...(span ? { span } : {}),
      ...(pushed.length > 0 ? { pushed } : {}),
    });
  };
  // One tool context for the whole run: the first turn and any re-review
  // turn (settleReviewedHead) share it, so submit_pr_description and the
  // progress checklist keep flowing to the same hooks.
  // The thread's file upload rides only when the channel has one: a tool that
  // finds it absent says so, rather than the core inventing a fallback for bytes.
  const attachFile = io.attachFile?.bind(io);
  // The store path (record 0033): with `artifacts:` configured the tool moves
  // the file by reference under this run's keys; the channel's upload ticket
  // rides beside it when the channel has one, else the lead goes through `reply`.
  const uploadTicket = io.uploadTicket?.bind(io);
  // The run's staging counter: the dispatcher's when it handed one over (the
  // request's files took 1..n there), else this loop's own.
  const nextStagedIndex = ctx.stagingIndex ?? stagingIndex();
  // A steered follow-up's staged files (record 0033): copied into the store and
  // pulled into this workspace before the model reads the turn — the same hook
  // for the native loop and the pi harness, bound only when a store exists.
  const stageFollowUps = deps.artifacts
    ? async (inputs: readonly { staged?: readonly StagedFile[] }[]): Promise<string> => {
        const files = inputs.flatMap((i) => i.staged ?? []);
        if (files.length === 0) return "";
        const staged = await stageIntoWorkspace(files, {
          store: deps.artifacts!,
          threadKey: msg.threadKey,
          publish: (event) => events.publish(event),
          nextIndex: nextStagedIndex,
          executor,
          resident: round.selection.resident !== undefined,
        });
        ctx.workspaceFiles?.record(staged.outcomes);
        return staged.line;
      }
    : undefined;
  let artifactSeq = 0;
  // A ticketless channel's lead links the file itself: this run's artifact proxy
  // under its live token (the same capability the status card's link carries).
  const artifacts = deps.artifacts
    ? {
        store: deps.artifacts,
        runId: run.id,
        nextSeq: () => ++artifactSeq,
        artifactUrl: (key: string) => artifactLink(run.id, key, run.token),
        reply: (text: string) => io.reply(text),
      }
    : undefined;
  // The plane's read for the orchestrator preset (record 0070): the one plane
  // service under the REQUESTER's own predicate, so the chat cites exactly the
  // rows its person may see — the same rows `plane show` would print them.
  const plane = deps.plane
    ? {
        table: async () => (await deps.plane!()).table(predicateFor(chatActorOf(deps.config, msg), "runs:read", "run")),
      }
    : undefined;
  const toolContext = {
    executor,
    reportProgress,
    ...(attachFile ? { attach: attachFile } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(uploadTicket ? { uploadTicket } : {}),
    web: webCapability(),
    skills: deps.skills,
    github: githubCapabilityFor(deps, chatActorOf(deps.config, msg)),
    depotCi:
      agent.name === "coding"
        ? buildDepotCi({
            runId: run.id,
            repo: repoCtx.repo,
            canUseRepo: (repo) =>
              run.control.requested === undefined &&
              registry.getById(run.id)?.finished === false &&
              deps.config.canUseRepo(chatActorOf(deps.config, msg), repo),
            baseUrl: deps.harness?.harnessUrl,
          })
        : undefined,
    agentName: agent.name,
    ...(repoCtx.repo ? { repo: repoCtx.repo } : {}),
    ...(spawn ? { spawn } : {}),
    ...(runs ? { runs } : {}),
    ...(plane ? { plane } : {}),
    ...(steer ? { steer } : {}),
    ...(wait ? { wait } : {}),
    ...(session ? { session } : {}),
    onVerdict,
    addressSeverity: ctx.addressSeverity.level,
    onDigest,
    onPrDescription,
    onHandoff,
    onDispositions,
  };
  // A resume whose plan is `finish` (run-history item 37): the model had
  // already answered when the previous generation died, so no loop runs here
  // and only the post-steps and the reply are owed, with that answer in hand.
  // How its loop ended is read back from the notes it published: this
  // generation's RunControl knows no stop, so an operator's soft stop is
  // restored onto it, which makes the status, the card and the label the
  // stop's, exactly as if this process had taken it.
  const finish = resume?.plan.kind === "finish" ? resume.plan : undefined;
  const reentry = resume?.plan.kind === "resume" ? resume.plan : undefined;
  const loopEnding: LoopEnding = finish && resume ? loopEndingOf(resume.events) : { kind: "answered" };
  if (loopEnding.kind === "soft_stop") run.control.requestStop("soft");
  // A verdict a previous generation already posted (agent-review item 18): the
  // replayed `review_posted` event is the post-step's outcome, so neither the
  // settle nor the post runs again, and the reviewed head is the event's.
  const postedBefore = resume ? reviewPostedBefore(resume.events) : undefined;
  if (postedBefore) reviewHead = postedBefore.head;
  // The row's harness facts (harness.md item 7; harness-pi item 8), read by
  // whichever harness wrote them: for the harness's re-attach or, on a finish,
  // for ending the process the previous generation left behind. The row's
  // word wins (item 8): the harness that judges, ends or resumes this run is
  // the one the facts name, picked off the roster, whatever the scopes' word
  // says now — a preset flipped between generations, or a person who moved
  // their own runs mid-flight, never mismatches a run in flight. A fresh run,
  // or a row with no facts, opens on the word the scopes resolved for the
  // preset (`resolved.harness`: the requester's own scope, the channel's, the
  // deployment's block), pi when none named it.
  const facts = resume ? harnessFactsOf(resume.row.state.harness) : undefined;
  const harnessOf = (roster: NonNullable<RunDeps["harness"]>) =>
    facts ? roster.harnesses[facts.harness] : harnessNamed(roster.harnesses, resolved.harness?.name);
  // A row that names a harness this build does not know (a rollback under a
  // newer build's row, a harness removed) is no facts, so the run is rebuilt on
  // the preset's harness — the survival clause working — but the process the
  // row names is neither judged nor ended here, and item 7's rule for a
  // process that is not this one's to judge is "named, not ended": one
  // `resumed` note says so before the rebuild, or before a finish runs its
  // post-steps with that process still up.
  const unknownWord = facts === undefined ? unknownHarnessWordOf(resume?.row.state.harness) : undefined;
  const noteUnknownWord = (ending: string) => {
    if (unknownWord === undefined) return;
    onEvent({
      type: "run_note",
      kind: "resumed",
      summary: `the row names the ${unknownWord.word} harness, which this build does not know; its process (pid ${unknownWord.pid} in container ${unknownWord.container}) was neither judged nor ended here; ${ending}`,
    });
  };
  // The facts as this run last saved them: the relaunch count the ceiling is
  // read off (harness.md item 6), whichever generation wrote it; the harness's
  // every save goes through here and onto the row.
  let lastFacts: HarnessFacts | undefined = facts;
  const saveFacts = (h: HarnessFacts) => {
    lastFacts = h;
    ledgerRun?.setState({ harness: h });
  };
  // Where the run's workspace is (run-history item 54): the dispatch's binding,
  // then the one each relaunch re-attached — what the next relaunch re-attaches.
  let workspaceBinding = workspaceBindingFor(round.selection, profile.machine);
  try {
    const prBase = repoCtx.baseRef ?? (await coordinatorBase);
    if (coordinator?.publication !== undefined) {
      const original = coordinator.publication;
      const restoredHead = resume === undefined ? undefined : restoredPublicationHead(publicationReceipts, original);
      const publication = restoredHead === undefined ? original : { ...original, expectedHeadSha: restoredHead };
      const fresh = await (deps.fetchPrFacts ?? fetchPullRequestFacts)({
        repo: publication.repo,
        number: publication.pr,
      }).catch(() => undefined);
      const verified = verifyExistingPrPublication(
        publication,
        {
          repo: repoCtx.repo,
          pr: repoCtx.pr,
          ref: repoCtx.ref,
          baseRef: prBase,
          requestHeadSha: restoredHead ?? repoCtx.headSha,
          workspaceRef: binding?.ref,
          workspaceHeadSha: binding?.sha,
          owner: {
            instanceId: coordinator.parentInstanceId,
            unit: unitOfIdempotencyKey(coordinator.idempotencyKey) ?? "",
          },
        },
        fresh,
      );
      existingPrPublication = verified.ok ? verified.publication : { blocked: verified.reason };
      existingPrPublicationFence = { authority: existingPrPublication };
      if (!verified.ok)
        shell.note(
          "quiet",
          `Existing-PR publication is blocked: ${verified.reason}. Work stays on the bound checkout; no alternate branch or pull request will be published.`,
        );
    }
    if (finish) {
      onEvent({
        type: "run_note",
        kind: "resumed",
        summary: `resumed after a restart: the model had already answered (${describeEnding(loopEnding)}); running the post-steps with its answer`,
      });
      if (facts) {
        // The loop had ended too, but the process that would have ended the
        // harness's process died first: the harness the facts name finds it
        // (harness.md items 7 and 8) and ends it at the pid and root the row
        // recorded, best-effort, only in the container the row names: in
        // another container that pid is a stranger's, and a row the judge
        // disowns is not its to end — either is named, not ended.
        if (!deps.harness)
          throw new Error(
            `the ${agent.name} preset's run left ${facts.harness} harness facts on its row, but this process has no harness roster to end that process with`,
          );
        const judge = harnessOf(deps.harness);
        const container =
          deps.harness.containerFor?.(executor, profile.machine) ?? harnessContainerFor(executor, profile.machine);
        // The container itself may be gone under the question (harness.md
        // item 9: the seam rethrows the executor's typed word instead of
        // answering no name): then nothing of the leftover is here to end, the
        // record says so, and the post-steps run with the answer as before.
        const found = await judge.find(facts, container).catch((err: unknown) => {
          if (!isContainerGone(err)) throw err;
          return "gone" as const;
        });
        switch (found) {
          case "gone":
            onEvent({
              type: "run_note",
              kind: "resumed",
              summary: `the container this run was handed is gone under the finish, so nothing of the run's ${facts.harness} process (pid ${facts.pid}) is here to end`,
            });
            break;
          case "another-container": {
            // Both words go on the note — the row's and this container's — so
            // forensics can tell which generation ran where after a roll.
            const here = await container.identity().catch(() => undefined);
            onEvent({
              type: "run_note",
              kind: "resumed",
              summary: `the run's ${facts.harness} process (pid ${facts.pid}) ran in container ${facts.container ?? "unknown"}, not the one this run was handed (${here ?? "unknown"}): it was not ended here`,
            });
            break;
          }
          case "another-harness":
            // The roster's object was picked by the row's own word, so this
            // is the judge disowning a row that names it — said, never ended.
            onEvent({
              type: "run_note",
              kind: "resumed",
              summary: `the run's row carries ${facts.harness} harness facts (pid ${facts.pid}) that the ${judge.name} harness does not own: that process was neither judged nor ended here`,
            });
            break;
          default:
            await judge.end(facts, container);
        }
      } else noteUnknownWord("the run finished on the answer it already had");
      windDownEnding = windDownEndingUnder(finish.answer, loopEnding);
      answer = answerUnderEnding(finish.answer, loopEnding, agent.maxMinutes);
    } else {
      // The harness (harness.md; pi's is harness-pi.md): the process in the
      // run's own container, the bearer as its key, its bridge putting its
      // events on this same stream, the relayed tools running here under this
      // same tool context. Which object: the row's word for a resume, the
      // scopes' word for the preset on a fresh run (item 8, `harnessOf`).
      if (!deps.harness)
        throw new Error(`the ${agent.name} preset runs on a harness, but this process has no harness roster`);
      const harnessDeps = deps.harness;
      const harness = harnessOf(harnessDeps);
      noteUnknownWord(`the run was rebuilt on ${harness.name}`);
      // Where the harness runs and how it reaches the bot follow the run's
      // machine class (harness-pi.md item 12): a class with a workspace has an
      // executor to exec through, and the process reaches the bot at its
      // public URL; `none` has no workspace, so the process is a child of the
      // bot and reaches this process's own server over loopback.
      const onBotHost = profile.machine === "none";
      const harnessUrl = onBotHost ? deps.harness.loopbackUrl : deps.harness.harnessUrl;
      if (!harnessUrl)
        throw new Error(
          onBotHost
            ? `the ${harness.name} harness needs PORT: a run without a workspace runs its process on the bot host, which reaches the model proxy over loopback`
            : `the ${harness.name} harness needs PUBLIC_BASE_URL: the run's container reaches the model proxy through it`,
        );
      if (ctx.bearer === undefined)
        throw new Error(`the ${harness.name} harness needs the run's model-proxy bearer, and this process minted none`);
      // The row's facts are read by the harness that wrote them (harness.md
      // item 7): the object above was picked by the row's own word, and the
      // seam's door (`openThroughSeam`, below) keeps the refusal of a foreign
      // row as its defence for any caller that is not this loop — said on the
      // record first, then thrown for the finally and the dispatcher's restart.
      const { provider: providerName, model: modelId } = parseModelRef(resolved.modelRef);
      const providerCfg = deps.config.config.providers[providerName];
      if (!providerCfg)
        throw new Error(`the ${harness.name} harness found no provider named ${providerName} in the config`);
      // The gate's push rules (harness-pi.md item 7) follow the thread the
      // way the post-step's PR target does (CodingPrTarget): when the thread
      // came from a pull request or a coordinator's spawn, the thread is bound
      // AT the run's own branch — a fix round repushes the PR's head, a unit
      // child is dispatched at its unit branch — so that branch is the one
      // push target and the base its pull request targets is protected;
      // otherwise the binding IS that base, protected, and the run pushes a
      // branch of its own making. The plan's base is resolved here, once —
      // the tag's, else the coordinator store's (run-history item 48a) — so a
      // child resumed from a row written before the tag carried a base still
      // has its base protected, not its own unit branch.
      const ownBranch =
        coordinator?.publication !== undefined
          ? coordinator.publication.publicationRef
          : prBase !== undefined
            ? (binding?.ref ?? repoCtx.ref)
            : undefined;
      const protectedBranches = [
        ...new Set(
          (prBase !== undefined ? [prBase] : [binding?.ref, repoCtx.ref]).filter(
            (b): b is string => typeof b === "string",
          ),
        ),
      ];
      // What the harness opens the run on: the bearer as minted, and a bot
      // death's resume plan when there is one — or, after a relaunch, the
      // rotated bearer and the record the harness held at the interruption.
      let bearer = ctx.bearer;
      if (reentry) {
        // A resume publishes no second `lease` event (the record holds the
        // lease), so the control's clock starts here from the remainder the
        // record kept — the run loop's reading of the same lease the harness
        // continues, a moment earlier than the harness's own.
        const resumeDeadline = clock() + reentry.remainingMs;
        run.control.startLease(() => resumeDeadline - clock());
      }
      let harnessResume: HarnessResume | undefined = reentry
        ? {
            messages: reentry.messages,
            compactions: reentry.compactions,
            settlements: reentry.settlements,
            remainingMs: reentry.remainingMs,
            turn: reentry.turn,
            inboxConsumedSeq: reentry.inboxConsumedSeq,
            ...(facts ? { facts } : {}),
          }
        : undefined;
      const openRun = () =>
        openThroughSeam(
          harness,
          {
            container:
              harnessDeps.containerFor?.(executor, profile.machine) ?? harnessContainerFor(executor, profile.machine),
            bearer,
            harnessUrl,
            registry: harnessDeps.registry,
            ...(deps.runBearers ? { bearers: deps.runBearers } : {}),
            clock,
            sleep: harnessDeps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
            ...(harnessDeps.pollMs !== undefined ? { pollMs: harnessDeps.pollMs } : {}),
            ...(harnessDeps.tickMs !== undefined ? { tickMs: harnessDeps.tickMs } : {}),
          },
          {
            runId: run.id,
            agent,
            ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
            model: { id: modelId, provider: providerName, providerType: providerCfg.type },
            ...(ctx.modelCard ? { card: ctx.modelCard } : {}),
            system,
            messages,
            tools: mergeTools(TOOLSETS[agent.toolset] ?? [], mcpForRun?.tools),
            toolContext,
            ...(ctx.decisionRecord !== undefined ? { environment: { [DECISION_RECORD_ENV]: ctx.decisionRecord } } : {}),
            ...(session
              ? { notepad: () => session.readNotepad(), conversation: () => session.readConversation() }
              : {}),
            // A failed compaction is a checkpoint signal (harness-pi.md item
            // 7): the provider can refuse the process's summary for good, and
            // the window may overflow before the budget salvage below can run
            // — so a coding run bound at a branch of its own pushes the tree's
            // tracked work the moment the harness reports the failure, in the
            // push-before-abort's own shape (`pushed_head`, `by: "salvage"`),
            // and the loop goes on. Best-effort like the budget salvage: a
            // failed push is the note's to report, never the run's.
            ...(isCodingPrRun && ownBranch !== undefined && !protectedBranches.includes(ownBranch)
              ? {
                  onCompactionFailed: async (why: string) => {
                    const branch = ownBranch;
                    const salvaged = await root.span("run.compaction_salvage", (span) =>
                      salvageBudgetPush(
                        executor,
                        {
                          branch,
                          cue: "compaction",
                          ...(existingPrPublication !== undefined ? { publication: existingPrPublication } : {}),
                        },
                        span,
                      ),
                    );
                    if (salvaged.publicationBlocked !== undefined)
                      blockExistingPrPublication(salvaged.publicationBlocked);
                    onEvent({
                      type: "run_note",
                      kind: "compaction_salvage",
                      summary: `the compaction failed (${redactAndCap(why, 200)}); ${salvaged.summary}`,
                    });
                    // The salvaged head is a fact of the run (run-history item 2): what renewal reads.
                    if (salvaged.pushed && salvaged.head !== undefined)
                      onEvent({ type: "pushed_head", ref: branch, sha: salvaged.head, by: "salvage" });
                  },
                }
              : {}),
            rules: {
              checkout: binding?.workspace ?? "/workspace",
              ...(ownBranch !== undefined ? { branch: ownBranch } : {}),
              protectedBranches,
              ...(existingPrPublicationFence !== undefined ? { publication: existingPrPublicationFence } : {}),
            },
            ...(round.selection.backend ? { backend: round.selection.backend } : {}),
            span: root,
            control: run.control,
            inbox: admitted.inbox,
            ...(stageFollowUps ? { stageFollowUps } : {}),
            onEvent,
            onProgress,
            // The provider park's capability (model-proxy item 12a; record
            // 0064): only a ledger-tracked run can be parked — the proxy's
            // park and the plane's reissue steer both land on the run's live
            // row — so only such a run holds a failed turn for the steer;
            // without the ledger the harness's retry ladder answers as before.
            ...(ledgerRun
              ? {
                  onStep: ledgerRun.step.bind(ledgerRun),
                  logIndexOf: ledgerRun.logIndexOf.bind(ledgerRun),
                  providerPark: true,
                }
              : {}),
            saveFacts,
            ...(harnessResume ? { resume: harnessResume } : {}),
          },
        );
      // The survival clause's ceiling (harness.md item 6; dispatch/relaunch.ts):
      // the harness's typed word that the run's container was replaced under
      // it — the bot lives, or this loop would not be running — relaunches the
      // process from the record in the container the run holds: the bound
      // read off the row's facts, the workspace re-attached or refused by
      // name, the bearer rotated with the row written inside the rotation,
      // then the harness's own rebuild through the same door. A refusal is an
      // interruption like the floor's: the relay registration the harness left
      // standing for the relaunch is forgotten, the record says why, and the
      // catch below finishes the run `interrupted` for the dispatcher's
      // restart. Every other throw is the run's, as before.
      ctx.assertAdmissionBudget();
      for (;;) {
        try {
          harnessSession = await openRun();
          break;
        } catch (err) {
          if (!(err instanceof HarnessContainerReplacedError)) throw err;
          let decision: Awaited<ReturnType<typeof prepareRelaunch>>;
          try {
            decision = await prepareRelaunch(deps, {
              runId: run.id,
              threadKey: msg.threadKey,
              requester: msg.userId,
              agent: ctx.agent,
              profile,
              repoCtx,
              root,
              clock,
              harness,
              replaced: err,
              facts: lastFacts,
              binding: workspaceBinding,
              stopSignal: run.control.hardSignal,
              remainingMs: () => run.control.remainingMs(),
              saveFacts,
            });
          } catch (failed) {
            // The relaunch itself failed (the row's write threw inside the
            // rotation): the run fails as any throw fails it, and the
            // registration left for the relaunch goes with it.
            harnessDeps.registry.forget(run.id);
            throw failed;
          }
          if (decision.kind === "refused") {
            // The floor's own note kind carries the outcome, starting at the
            // why: the harness's `sandbox_restarted` note said the verdict, this
            // one says what followed. Never `resumed` — the run is not.
            harnessDeps.registry.forget(run.id);
            onEvent({ type: "run_note", kind: "sandbox_restarted", summary: decision.interruption.message });
            throw decision.interruption;
          }
          if (decision.kind === "stopped") {
            // An operator's hard stop ended the re-attach's wait: the run ends
            // as a hard-stopped run does — the stop's one-line answer, the
            // finally's `stopped_hard` — with no process relaunched and nothing
            // restarted from the request. The registration left for the
            // relaunch goes with it.
            harnessDeps.registry.forget(run.id);
            relaunchEndedRun = true;
            // The stop's own note kind, with its mode — never a second
            // `sandbox_restarted`, which every reader counts as a replaced
            // container's verdict: the harness's note already said that.
            onEvent({
              type: "run_note",
              kind: "stopped",
              mode: "hard",
              summary:
                "the run was stopped while its workspace was being re-attached in the replacement container; pi was not relaunched",
            });
            break;
          }
          if (decision.kind === "lease_spent") {
            // The container was replaced with the run inside its write-up
            // reserve: nothing is re-attached or relaunched, and the run ends on
            // its budget as a run whose loop ran out of time does — the budget's
            // own note and answer, the status `completed` — never `workspace_lost`
            // (the worktree was never asked for) and never a new run from the
            // request with a fresh lease. The registration left for the relaunch
            // goes with it. The note (which `onEvent` reads as the budget's end)
            // says what happened and why there was no write-up; the answer is the
            // budget's "without finishing" form, no label around empty text.
            harnessDeps.registry.forget(run.id);
            relaunchEndedRun = true;
            onEvent({ type: "run_note", kind: "time_budget_exhausted", summary: decision.why });
            windDownEnding = { kind: "time", text: "" };
            leaseSpentDuringRelaunch = windDownAnswer(windDownEnding, agent.maxMinutes);
            break;
          }
          if (decision.round !== undefined) {
            // The run holds the re-attached round's executor and binding from
            // here: the next relaunch re-attaches what this one bound, and the
            // row learns the binding complete, as a resumed row does.
            executor = decision.round.selection.executor;
            toolContext.executor = executor;
            const rebound = workspaceBindingFor(decision.round.selection, profile.machine);
            if (rebound !== undefined) {
              workspaceBinding = rebound;
              ledgerRun?.setState({ binding: rebound });
            }
          }
          if (decision.bearer !== undefined) bearer = decision.bearer;
          harnessResume = decision.resume;
          // A coordinator's child relaunched in the replacement container says
          // the resume on its own record (run-history item 47a; issue 1364
          // part 1): the typed `child_resumed` beside the harness's
          // `sandbox_restarted` note, so the parent's read-record and the run
          // page read the roll as survived — the run keeps its id, budget, tag
          // and worktree. No Workflow twin from here: a resumed child settles
          // nothing, the parent's wait keeps waiting on the finish.
          if (coordinator !== undefined)
            onEvent({
              type: "child_resumed",
              parentInstanceId: coordinator.parentInstanceId,
              summary:
                "resumed after the container was replaced: the run's worktree was re-attached and its process relaunched from the record",
              at: clock(),
            });
        }
      }
      // No session only when the relaunch's re-attach ended the run: on the
      // lease's end, the budget's answer; on a stop, the stop's.
      answer = harnessSession?.answer ?? leaseSpentDuringRelaunch ?? HARD_STOP_MESSAGE;
      if (harnessSession?.ending !== undefined) windDownEnding = harnessSession.ending;
    }
    clearStoppedReviewTail();
    // Reviewed-head settle (docs/reference/specs/agent-review.md items 8 + 12,
    // settleReviewedHead in reviewRound.ts): for a PR review, read the
    // workspace HEAD NOW — after the model is done, BEFORE the finally
    // below releases the workspace — and reconcile a PR head that moved
    // during the run: adopt the current head when the run reviewed it,
    // carry the review across a rebase of the same commits, or void the
    // verdict and re-review ONCE at the new head (worktree moved, one more
    // prompt on the run's own pi session, harness-pi item 14). A hard stop
    // observes nothing and settles nothing, and so does a relaunch that ended
    // the run (`tailSkipped`: the HEAD read would be a `needs: attach` on the
    // replaced container); a verdict already posted before a
    // restart is settled (it landed at its head) and is not re-reviewed; a
    // `finish` plan has no session, so a move it finds is left to the post
    // gate (agent-review item 10).
    if (isPrReview && repoCtx.repo && repoCtx.pr !== undefined && !tailSkipped() && postedBefore === undefined) {
      const settled = await settleReviewedHead({
        span: root,
        pr: { repo: repoCtx.repo, number: repoCtx.pr },
        baseRef: repoCtx.baseRef,
        reviewHead,
        verdict,
        answer,
        messages,
        executor,
        turn: {
          agent,
          toolContext,
          onEvent,
          control: run.control,
          ...(harnessSession ? { followUp: harnessSession.followUp } : {}),
        },
        fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
        fetchPrCommits: deps.fetchPrCommits ?? prCommitsSince,
        preReviewStopped: latchReviewStoppedBeforeStart,
        // What the run did about a moved head: the re-review's note is an
        // acknowledgement (`verbose`), the card's word is `debug` material
        // (routing-and-config item 28). The verdict that follows is the reply
        // everyone gets.
        notify: {
          reply: (text) => replyAck(io, resolved.verbosity, text),
          headMoved: (suffix) => {
            shell.note("debug", suffix);
            card.update(currentFrame());
          },
        },
        logKey: msg.threadKey,
      });
      answer = settled.answer;
      verdict = settled.verdict;
      reviewHead = settled.reviewHead;
      observedHead = settled.observedHead;
      carried = settled.carried;
    }
    // The verdict turn (agent-review item 5, verdictTurn.ts): the review prompt
    // requires submit_verdict before the final message and the post step is
    // fail-closed without it, but a prompt rule alone can be skipped — a run
    // has approved in prose and never called the tool. So a review that will
    // post to a pull request and still has NO verdict after the head settle
    // (whose re-review turn asks for a fresh verdict itself, so a moved head
    // is never nudged twice) gets ONE bounded extra model turn asking for the
    // call, before the post step builds the body. The verdict arrives through
    // the same onVerdict hook the loop fed (so the ledger row sees it) and is
    // also returned. A hard stop asks nothing; a request that opted out of the
    // GitHub post has no body to lead and asks nothing; a `finish` plan has no
    // session and asks nothing — the body then carries the no-verdict line as
    // before.
    if (
      isPrReview &&
      repoCtx.repo &&
      repoCtx.pr !== undefined &&
      !tailSkipped() &&
      postedBefore === undefined &&
      verdict === undefined &&
      !reviewPostOptedOut(ctx.requestText)
    ) {
      const reviewOf = { repo: repoCtx.repo, number: repoCtx.pr };
      const turned = await root.span("run.verdict_turn", (span) =>
        runVerdictTurn({
          span,
          target: reviewOf,
          turn: {
            agent,
            toolContext,
            onProgress,
            onEvent,
            ...(harnessSession ? { followUp: harnessSession.followUp, remainingMs: harnessSession.remainingMs } : {}),
          },
          logKey: msg.threadKey,
        }),
      );
      if (turned.verdict !== undefined) verdict = turned.verdict;
    }
    // PR post-step observation (docs/reference/specs/pr-description.md item 5): for a
    // writable coding run, read the workspace's head branch — the one the
    // run's `git push` named, else the checkout — its tip, and the remote's
    // head for that branch NOW — after the model is done, BEFORE the
    // finally below can release the workspace (a resident re-attach would
    // show the ref's current tip, not what this run pushed). The cold path
    // clones into a SUBDIRECTORY of the workspace root, so a failed root
    // HEAD probe discovers the single clone and re-probes inside it; with
    // no dispatch-resolved repo the origin remote is read too (an
    // agent-discovered repo). Best-effort: a failed probe leaves its field
    // undefined and the post-step reports honestly instead of guessing. A
    // hard stop tore the work down mid-flight — nothing observed, nothing
    // posted.
    // Where the post-step's PR would open (CodingPrTarget), in order: the PR's
    // true base ref when the thread's context came from a PR (a fix round
    // repushes the PR's own head branch — the PR, not the thread, knows its
    // base), else the base a coordinator's spawn put on the tag (its child is
    // dispatched AT the unit branch so the resident attaches there, which
    // makes the binding ref the branch itself, and a PR whose base is its own
    // head cannot open — the plan's base is the only signal that names the
    // target, and only the tag carries it), else the resident binding ref,
    // else the dispatch's resolved ref. Shared by the description turn's
    // decision and the post-step below. `ownPr`: the pull request the thread's
    // own run opened — open, or merged or closed since — where a description
    // resubmitted without a push lands even from a workspace on the base or
    // on that pull request's own head branch (pr-description.md item 5).
    const ownPr = recordPrOf(repoCtx);
    // The plan's base for a coordinator's child (run-history item 48a),
    // resolved once above before the harness session opened. Still unknown
    // after the tag and the store, the base is LOST, not resolvable: the
    // binding ref is the unit branch itself and the repo default is not the
    // plan's base, so neither may stand in — the post-step says so with a
    // `pr_not_opened` note instead of opening against the wrong branch. The
    // flag rides only a coding PR run's target, the one the post-step reads.
    const planBase = await coordinatorBase;
    const planBaseLost =
      isCodingPrRun && coordinator !== undefined && repoCtx.baseRef === undefined && planBase === undefined;
    // The branch's start state as recorded at attach (record 0062): what
    // the identity rewrite subtracts before judging the run's commits. For a
    // branch other than the recorded one, the run's own first push says where
    // it found the branch (`pushedStart`: created, or moved from a pre-push
    // head the rewrite never rewrites below); without either the rewrite
    // fails closed rather than judging a pre-existing branch as empty.
    const recordedStart = startStateRead !== undefined ? await startStateRead : undefined;
    const pushedStart = pushes.startPoint();
    const prTarget = {
      repo: repoCtx.repo,
      baseRef: repoCtx.baseRef ?? planBase,
      bindingRef: binding?.ref,
      resolvedRef: repoCtx.ref,
      ...(planBaseLost ? { planBaseLost: true } : {}),
      ...(ownPr !== undefined ? { ownPr } : {}),
      ...(recordedStart !== undefined ? { startState: recordedStart.state, startBranch: recordedStart.branch } : {}),
      ...(pushedStart !== undefined ? { pushedStart } : {}),
    };
    const endingNeedsPreservation =
      isCodingPrRun && coordinator !== undefined && (budgetEnded || run.control.requested !== undefined);
    // A hard stop ends pi before git is touched; unlike the old skipped tail,
    // its workspace still gets the same WIP checkpoint before force teardown.
    if (endingNeedsPreservation && run.control.requested === "hard") await endHarness();
    await events.drain(); // the successful push receipt must precede every completion/salvage observation
    retainPublicationReceipts();
    if (isCodingPrRun && !tailSkipped()) await observeWorkspaceNow();
    if (endingNeedsPreservation) await preserveCodingChildWork(budgetEnded ? "budget" : "ending");
    else if (isCodingPrRun && coordinator !== undefined && !tailSkipped()) await preserveCodingChildWork("completion");
    // The description turn (docs/reference/specs/pr-description.md item 5,
    // descriptionTurn.ts): the coding prompt requires a resubmitted
    // description after EVERY push to a PR that already exists (agent-coding.md
    // item 3), and a prompt rule alone can be rationalized away. So a run
    // whose loop ended with a proven push onto a branch that already heads
    // an open PR and NO submit_pr_description call gets ONE bounded extra
    // model turn asking for it — here, after the model is done and BEFORE
    // the answer lands or the workspace is released. The description arrives
    // through the same onPrDescription hook the first turn fed (so
    // `prDescription` and the ledger row see it); the workspace is observed
    // again afterwards in case the turn pushed. A hard stop asks nothing. The
    // turn is one more prompt on the run's own pi session (harness-pi item
    // 14), the same hook fed through the relay; a `finish` plan has no session
    // and asks nothing — the post-step's note then says the description was
    // not resubmitted.
    let descriptionTurnRan = false;
    if (isCodingPrRun && !tailSkipped() && !endingSalvageAttempted && prDescription === undefined) {
      const turnTarget = await descriptionTurnTarget({
        observed: {
          head: observedHead,
          branch: observedBranch,
          checkedOut: observedCheckedOut,
          remoteHead: observedRemoteHead,
          remoteRepo: observedRemoteRepo,
        },
        description: prDescription,
        target: prTarget,
        findOpenPr: deps.findOpenPrByHead ?? findOpenPrByHead,
        logKey: msg.threadKey,
      });
      if (turnTarget) {
        descriptionTurnRan = true;
        await root.span("run.description_turn", (span) =>
          runDescriptionTurn({
            span,
            target: turnTarget,
            turn: {
              agent,
              toolContext,
              onProgress,
              onEvent,
              ...(harnessSession ? { followUp: harnessSession.followUp, remainingMs: harnessSession.remainingMs } : {}),
            },
            logKey: msg.threadKey,
          }),
        );
        // Re-read, not narrowed: a hard stop may have landed during the turn.
        if (!run.control.hardSignal.aborted) await observeWorkspaceNow();
      }
    }
    // A clean first checkpoint leaves the description turn available, and
    // that turn can still use workspace tools. Checkpoint again after the
    // actual last model turn so its dirty tree or unpushed commit cannot reach
    // release as work_left_behind. A clean turn remains eligible for the PR
    // post-step; a pushed checkpoint marks the child unfinished as usual.
    if (descriptionTurnRan) await preserveCodingChildWork("completion");
    // The last prompt on the run's pi has been sent: pi ends here, before the
    // post-step and before the workspace it runs in can be released; what its
    // ending left running is read off the record once it has — here, once,
    // whatever the post-step does next.
    await endHarness();
    // Ordinarily, what the run leaves uncommitted or unpushed does not outlive
    // it: a run starts from a clean tree (resident-repos item 17), and release
    // discards a resident tree. The one bounded exception is a publication
    // fence that denied the existing PR: the run keeps that checkout attached
    // and says its later retention is unverified. Said HERE — on the record
    // before finish() seals it, and on the card before it closes — because the
    // release happens afterward. Read off the last observation above (after
    // the description turn, in case it pushed); a hard stop observed nothing
    // and has its own ⛔.
    const leftBehind =
      isCodingPrRun && !tailSkipped() && !workSalvageAttempted
        ? workLeftBehindOf({ uncommittedChanges: observedUncommitted, unpushedCommits: observedUnpushed })
        : undefined;
    const blockedCheckpoint =
      keepBlockedPublicationWorkspace() &&
      existingPrPublication !== undefined &&
      "blocked" in existingPrPublication &&
      observedUncommitted !== undefined &&
      observedUnpushed !== undefined &&
      (observedUncommitted > 0 || observedUnpushed > 0)
        ? {
            reason: existingPrPublication.blocked,
            uncommitted: observedUncommitted,
            unpushed: observedUnpushed,
            ...(observedHead !== undefined ? { head: observedHead } : {}),
          }
        : undefined;
    /** What the tail established, for the wind-down's answer (harness-pi item
     *  6): the tree as the salvage or the last observation left it, its fate
     *  under the release the record decides (`releaseModeFor`: torn down when
     *  a command may still run in it; a publication-blocked checkpoint stays
     *  attached; else a cold workspace is kept for the thread by `if-idle`
     *  and a resident's tree is discarded, a run starting from a clean tree),
     *  and whether a description was
     *  submitted. A run with no workspace, or whose tail was skipped or
     *  observes no tree, establishes only that. */
    const endingFacts = (): EndingFacts => {
      if (profile.machine === "none") return { workspace: { kind: "none" } };
      if (!isCodingPrRun || tailSkipped()) return { workspace: { kind: "unread" } };
      const branch = observedBranch ?? observedCheckedOut;
      let workspace: WorkspaceAtEnd;
      if (salvagedTo !== undefined) workspace = { kind: "salvaged", ...salvagedTo };
      else if (observedUncommitted === undefined || observedUnpushed === undefined) workspace = { kind: "unmeasured" };
      else if (observedUncommitted === 0 && observedUnpushed === 0)
        workspace = {
          kind: "clean",
          ...(branch !== undefined ? { branch } : {}),
          ...(observedHead !== undefined ? { head: observedHead } : {}),
        };
      else
        workspace = {
          kind: "left",
          uncommitted: observedUncommitted,
          unpushed: observedUnpushed,
          fate:
            blockedCheckpoint !== undefined
              ? "retained_unverified"
              : commandInFlight
                ? "torn_down"
                : profile.machine === "repo-resident"
                  ? "discarded"
                  : "kept",
        };
      return { workspace, description: prDescription !== undefined ? "submitted" : "not_submitted" };
    };
    if (blockedCheckpoint !== undefined) {
      const checkpoint = blockedCheckpoint.head ? ` at ${blockedCheckpoint.head.slice(0, 7)}` : "";
      const summary =
        `the existing-PR push is blocked (${blockedCheckpoint.reason}); kept the local checkpoint${checkpoint} with ` +
        `${blockedCheckpoint.uncommitted} uncommitted change(s) and ${blockedCheckpoint.unpushed} unpushed commit(s) in the run workspace; ` +
        "no alternate ref or pull request was created, and retention beyond this run is unverified";
      events.publish({ type: "run_note", kind: "publication_blocked", summary: oneLine(summary), at: clock() });
      shell.note("quiet", `⚠️ ${summary}`);
    } else if (leftBehind) {
      events.publish({
        type: "run_note",
        kind: "work_left_behind",
        summary: oneLine(workLeftBehindSummary(leftBehind)),
        at: clock(),
      });
      // Work the person has to go and find: on the label at every level.
      shell.note("quiet", workLeftBehindLabel(leftBehind));
    }
    // The accepted PrDescription is a fact of the run: publish it as a typed
    // event BEFORE the finally below finish()es the stream, string fields
    // redacted like every payload, so the run page's review panel renders
    // the same object the GitHub body is rendered from.
    if (prDescription) {
      events.publish({
        type: "pr_description",
        description: redactPrDescription(prDescription),
        at: clock(),
      });
    }
    // Deterministic coding PR post-step (docs/reference/specs/pr-description.md item 5,
    // agent-coding.md item 2, runCodingPrPostStep in codingPrPostStep.ts):
    // a writable coding run that pushed a branch and submitted its typed
    // PrDescription gets its PR opened — or edited, the open-or-edit
    // idempotency lives in githubPulls — HERE, in the bot process, BEFORE
    // the finally below finish()es the stream, so the outcome lands in the
    // run record as a typed `pr_opened` event and not only in a console
    // line. The base is `prTarget`'s (above): the PR's true base ref, else
    // the coordinator tag's, else the thread's resident binding ref, else
    // the dispatch's resolved ref — binding is only ever set on the resident
    // path (factory.ts), so no resident check is needed. The note rides on
    // the final reply below. A hard stop observed nothing above and posts
    // nothing; a relaunch that ended the run likewise (`tailSkipped`). An
    // existing-PR publication denial skips the whole post-step: no lookup,
    // edit or open may reuse stale intent or create a replacement pull request.
    if (
      isCodingPrRun &&
      !tailSkipped() &&
      !endingSalvageAttempted &&
      !(existingPrPublication !== undefined && "blocked" in existingPrPublication)
    ) {
      // A child may run in its own unit thread: link the request that started
      // the pipeline, with the copied message as fallback for older records.
      const instance =
        coordinator && deps.coordinatorInstances
          ? await deps.coordinatorInstances.get(coordinator.parentInstanceId).catch(() => undefined)
          : undefined;
      const requester = instance?.userId === msg.userId ? instance : msg;
      // A verified GitHub login controls assignment, never header visibility.
      const requestedLogin =
        identitySeam !== undefined
          ? await identitySeam.requestedLogin(requester.userId).catch(() => undefined)
          : undefined;
      prNote = await root.span("run.pr_post_step", () =>
        runCodingPrPostStep({
          verbosity: resolved.verbosity,
          observed: {
            head: observedHead,
            branch: observedBranch,
            checkedOut: observedCheckedOut,
            remoteHead: observedRemoteHead,
            remoteRepo: observedRemoteRepo,
          },
          description: prDescription,
          requestedBy: {
            name: requester.userName?.trim() || requestedLogin || requester.userId,
            threadUrl: threadPageLink(requester.threadKey),
          },
          target: prTarget,
          openPullRequest: deps.openPullRequest ?? openPullRequest,
          findOpenPr: deps.findOpenPrByHead ?? findOpenPrByHead,
          updatePullRequest: deps.updatePullRequest ?? updatePullRequest,
          fetchRepoInfo: deps.fetchRepoShipInfo ?? fetchRepoShipInfo,
          commitsOverBase: deps.commitsOverBase ?? commitsOverBase,
          ...(identitySeam !== undefined
            ? {
                identity: {
                  rewrite: (args) => identitySeam.rewrite({ ...args, requester: msg.userId }),
                  pullRequestHead: identitySeam.pullRequestHead,
                  isAssignable: identitySeam.isAssignable,
                  addAssignee: identitySeam.addAssignee,
                  ...(requestedLogin !== undefined ? { requestedLogin } : {}),
                },
              }
            : {}),
          descriptionTurnRan,
          publish: (event) => events.publish(event),
          logKey: msg.threadKey,
        }),
      );
    }
    // The run record is the source of truth and Slack/GitHub are projections
    // of it: publish the final answer into the stream FIRST (redacted like
    // every event, uncapped — a soft stop's "findings so far" included; a
    // re-review's answer supersedes the first one, which is not the run's
    // answer). It MUST precede the finally below: `finish()` runs there, and a
    // publish on a finished run is a silent no-op. Only after that is the
    // reply sent.
    // Join the reading-diff BASELINE so it is in the record before finish()
    // (which drops later publishes). This is a join on the git command fired
    // at run start, not a timeout: by now it finished minutes ago.
    const baseline = readingDiffBaseline;
    if (baseline) await root.span("run.reading_diff_join", () => baseline);
    const description = descriptionArtifact;
    if (description) await root.span("run.pr_description_join", () => description);
    // The finale answer reads what the ending established (harness-pi item 6):
    // the harness composed its answer when its loop ended, before the salvage,
    // the description turn and the PR post-step above ran, so it is composed
    // again HERE from the ending it handed over and the facts those steps left
    // — the tree first, then the description — through the one composer in
    // windDown.ts, never by guessing at a tree the salvage just measured. Only
    // an answer that is still the harness's own composition is replaced: one a
    // post-turn put in its place (a review's re-review at a moved head) stands.
    if (windDownEnding !== undefined && answer === windDownAnswer(windDownEnding, agent.maxMinutes))
      answer = windDownAnswer(windDownEnding, agent.maxMinutes, endingFacts());
    // A soft stop may have landed during any awaited tail step above. Latch it
    // immediately before the synchronous publication boundary and discard
    // every review claim the tail may have computed since the prior check.
    clearStoppedReviewTail();
    // Typed-output boundary (docs/reference/specs/llm-output.md item 5): the answer is
    // canonicalized ONCE here, so the event text, the channel reply, the
    // GitHub post, and memory all read one Markdown dialect; the model's raw
    // text rides on the event only when normalization changed it.
    const acceptedAnswer = markdownOutput.parse(answer);
    const rawAnswer = acceptedAnswer.ok && acceptedAnswer.changed ? answer : undefined;
    if (acceptedAnswer.ok) answer = acceptedAnswer.value;
    publishText("answer", answer, undefined, rawAnswer);
    // Deterministic review post-step (runReviewPostStep in reviewRound.ts;
    // agent-review.md items 8, 10, 12, 15 and 18): a `review` run against a
    // resolved PR posts its findings back to that PR by default — no need to
    // ask — behind the reviewed-head guard (fail-closed) and pinned to the
    // verified head (or the carried one). HERE, in the run loop BEFORE the
    // finally below finish()es the stream — like the coding post-step above —
    // so the outcome is a fact of the record (`reviewPost`, the
    // `review_posted` event or the `review_not_posted` note) and a
    // coordinator woken by the finish reads whether the verdict landed
    // without asking GitHub, whose review list can lag a post it accepted a
    // second ago. Best-effort: a post failure is recorded and said in the
    // thread but never fails the run (the review lands in Slack regardless).
    // A HARD-stopped review has no findings — only the abort line — so
    // nothing is posted and nothing is recorded; a relaunch that ended the run
    // likewise (`tailSkipped`): the budget's answer is no verdict, and the
    // replaced container was never re-attached. The step reads the canonical
    // answer above: the GitHub body and the `answer` event are one dialect.
    // Only a review run reaches it: every other run's stream is as before. A
    // verdict a previous generation posted before the restart is the outcome
    // already (`postedBefore`): the record carries it, GitHub is not asked twice.
    if (postedBefore) reviewPost = postedBefore;
    else if (agent.name === "review" && !tailSkipped())
      reviewPost = await root.span("run.review_post_step", () =>
        runReviewPostStep({
          agent,
          requestText: ctx.requestText,
          repoCtx,
          heads: { reviewHead, observedHead },
          verdict,
          digest,
          answer,
          carried,
          hardStopped: false,
          ...(coordinator !== undefined
            ? {
                guardTransition: true as const,
                fetchPrFacts: deps.fetchPrFacts ?? fetchPullRequestFacts,
              }
            : { guardTransition: false as const }),
          post: deps.postReviewComment ?? postReviewComment,
          fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
          reply: (text) => io.reply(text),
          ack: (text) => replyAck(io, resolved.verbosity, text),
          publish: (event) => events.publish(event),
          logKey: msg.threadKey,
        }),
      );
  } catch (err) {
    if (err instanceof HarnessInterruptedError) interrupted = err;
    else {
      runFailed = true;
      gateBypassed = err instanceof HarnessGateBypassedError;
      if (err instanceof RefusalError) {
        const { code, cause, text } = err.refusal;
        events.publish({ type: "refusal", code, cause, text });
      }
      if (err instanceof ModelPolicyRefusedError) failure = { kind: "policy_refusal" };
      else if (err instanceof ModelTransientFailureError) failure = { kind: "provider_transient" };
      // The record must say why a failed run failed even when the reply is
      // never delivered (run-history.md): the error's message, redacted and
      // capped, published before the finish below closes the stream.
      events.publish({
        type: "run_note",
        kind: "run_failed",
        summary: redactAndCap(err instanceof Error ? err.message : String(err), ENDING_NOTE_MAX),
      });
    }
    // pi first: it runs in the workspace released next; what the ending left
    // running is read off the record once it has — unless the loop's way out
    // ended it already and the throw came after (then that read stands). An
    // end that fails here is the harness's own error, said on the record as
    // every failure of that shape is (a `harness_error` note: the cause, where
    // the `workspace_torn_down` note says the consequence) and logged: the
    // record was read all the same, the release below must run whatever the
    // end did, and the loop's own error — the one the record names as the
    // run's — is the one that propagates.
    await endHarness().catch((endErr: unknown) => {
      const detail = `the harness session's end failed after the loop's own error: ${endErr instanceof Error ? endErr.message : String(endErr)}`;
      console.warn(`[run] ${msg.threadKey} ${detail}`);
      events.publish({
        type: "run_note",
        kind: "harness_error",
        summary: redactAndCap(detail, ENDING_NOTE_MAX),
        at: clock(),
      });
    });
    // A failed or interrupted coordinator coding child is the highest-risk
    // teardown: its model cannot make another push. Preserve the tree now,
    // before the release removes it, whatever raised the ending.
    // A fresh run's admission expiry leaves no model work to checkpoint; do
    // not turn it into a mechanical push. A resume may retain earlier work.
    if (resume !== undefined || !(err instanceof RefusalError && err.refusal.code === "run_budget_exhausted"))
      await preserveCodingChildWork("ending").catch((salvageErr: unknown) => {
        const summary = `the interrupted-work checkpoint failed before teardown: ${salvageErr instanceof Error ? salvageErr.message : String(salvageErr)}`;
        events.publish({ type: "run_note", kind: "work_salvage", summary, at: clock() });
        shell.note("quiet", summary);
      });
    await root.span("post.workspace_release", (span) => releaseWorkspace(span));
    if (!interrupted) throw err;
    // A coordinator's child says the interruption on its own record
    // (run-history item 47a): the typed event beside the harness's notes, so
    // the parent's read-record and the run page read the roll as a fact. The
    // Workflow wake rides the terminal record's put (item 47).
    if (coordinator !== undefined)
      events.publish({
        type: "child_interrupted",
        parentInstanceId: coordinator.parentInstanceId,
        reason: redactAndCap(interrupted.message, ENDING_NOTE_MAX),
        at: clock(),
      });
    // The interruption is the loop's own outcome: answered from here, the
    // finally below finishing the run `interrupted` and closing its card first.
    return {
      kind: "interrupted",
      reason: interrupted.reason,
      refusal: interrupted.refusal,
      note: interrupted.message,
      restart: { request: msg, restartOf: run.id, ...(coordinator !== undefined ? { coordinator } : {}) },
    };
  } finally {
    clearInterval(heartbeat);
    await events.drain();
    retainPublicationReceipts();
    const status = statusNow();
    // The two final boundaries land before the registry closes. A tracked run
    // commits each boundary durably before fan-out; an untracked run keeps the
    // same local projection so every admitted run still has one condition.
    if (typeof registry.commitLiveState === "function") {
      const commitBoundary = async (state: "wrapping_up" | "ended", at: number): Promise<void> => {
        const summary = registry.getById(run.id);
        if (!summary) return;
        const eventSeq = summary.eventCount + 1;
        const assignment =
          state === "ended"
            ? {
                expectedSeq: summary.liveStateSeq ?? 0,
                eventSeq,
                at,
                state,
                cause: causeOfClose(status, interrupted !== undefined),
              }
            : {
                expectedSeq: summary.liveStateSeq ?? 0,
                eventSeq,
                at,
                state,
                bound: summary.liveState?.bound ?? at,
                detail: "writing the final answer",
              };
        if (ledgerRun?.tracked()) {
          const committed = await ledgerRun.assignLiveState(assignment);
          if (committed.ok) registry.commitLiveState(run.id, committed);
          return;
        }
        const local = assignRunLiveState(summary.liveState, summary.liveStateSeq ?? 0, assignment);
        if (!local.ok || !local.event) return;
        registry.commitLiveState(run.id, {
          ...local,
          event: { ...local.event, seq: eventSeq },
          liveStateSeq: eventSeq,
        });
      };
      const at = clock();
      await commitBoundary("wrapping_up", at);
      await commitBoundary("ended", clock());
    }
    // Close the live-view stream and start the TTL, handing the registry the
    // terminal status so every summary projects it (the index, `runs list`)
    // instead of re-deriving it. The one status the registry cannot know is
    // `failedAfterFinish` (a reply that throws AFTER the loop): the record
    // says `failed`, the registry row keeps `completed` for its TTL.
    registry.finish(run.id, status);
    // The registry backlog is read back ONCE here, synchronously at finish
    // (docs/decisions/0006-runs-have-two-lives.md): it feeds both the friction diagnosis and the run
    // record. Reading it now, not after the reply, is what makes a slow reply
    // safe — the registry evicts a finished run after its TTL, and the record
    // must not depend on winning that race. Skipped entirely when neither
    // consumer is wired (nothing to diagnose for, nothing to persist). The
    // backlog is byte-bounded (oldest evicted), so the diagnosis is told when
    // it is looking at a head-truncated stream. Read with or without a
    // writer: the closed card's shape line comes from this diagnosis too.
    const snap = registry.snapshot(run.id, run.token);
    const recordEventList = snap?.events ?? [];
    const finishedAt = snap?.finishedAt ?? clock(); // the registry's finish clock: row and record agree
    // The diagnosis over the run's window (docs/reference/specs/tracing.md): its shape is
    // what the closed card and the record carry.
    const diagnosis = analyzeRunFriction(recordEventList, {
      finished: true,
      truncated: snap?.truncated ?? false,
      window: { start: snap?.receivedAt ?? startedAt, end: finishedAt },
    });
    runDiagnosis = diagnosis;
    // The channel's receipt (id + terminal status, never the token): a
    // single-shot channel hands it to its caller — the Worker shim records a
    // scheduled firing's run from it.
    io.runFinished?.({ id: run.id, status });
    // The run finished: it is sealed by the next drain (after the reply), and
    // its record — everything captured now, assembled after the seal — is
    // written by that drain. The card's total stops at the finish stamp.
    ending.finished(run.id);
    shell.freeze(finishedAt);
    registerFinishRecord(deps, {
      ending,
      run,
      snap,
      agent,
      profile,
      resolved,
      msg,
      channelVisibility,
      repoCtx,
      finishedAt,
      status,
      diagnosis,
      root,
      ledgerRun,
      ...(observedHead !== undefined ? { headSha: observedHead } : {}),
      ...(handoff !== undefined ? { handoff } : {}),
      ...(verdict !== undefined ? { verdict } : {}),
      ...(reviewHead !== undefined ? { reviewHead } : {}),
      ...(dispositions !== undefined ? { dispositions } : {}),
      ...(reviewPost !== undefined ? { reviewPost } : {}),
      ...(route !== undefined ? { route } : {}),
      ...(parentRunId !== undefined ? { parentRunId } : {}),
      ...(coordinator !== undefined ? { coordinator } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(failure !== undefined ? { failure } : {}),
    });
    // The diagnosis rides the run record (above): the friction ledger the
    // cross-run proposer reads is run history, so nothing is written twice.
    // A run whose loop threw closes its card here, after the finish, so the
    // card's total is the run's; the outer catch replies and drains. A run
    // interrupted — a replaced container (harness-pi item 16), another
    // harness's row (harness.md item 7) — closes saying it restarts from its
    // request: the fresh run's card follows this one.
    if (runFailed)
      await root
        .span("post.card_close", () =>
          card.done(shell.close({ kind: "done", icon: "❌", detail: checklistAsLeft(), ...doneLines(diagnosis) })),
        )
        .catch(() => {});
    else if (interrupted) {
      const { reason } = interrupted;
      await root
        .span("post.card_close", () =>
          card.done(shell.close({ kind: "refused", icon: "🔁", reason, ...doneLines(diagnosis) })),
        )
        .catch(() => {});
    }
  }
  return {
    kind: "answered",
    answer,
    reviewHead,
    verdict,
    reviewPost,
    reviewStoppedBeforeStart,
    prNote,
    toolCalls,
    runDiagnosis,
    checklistAsLeft,
    checklistCheckedOff,
    releaseWorkspace,
  };
}

/** The `resumed` note's word for how the loop had ended. */
function describeEnding(ending: LoopEnding): string {
  switch (ending.kind) {
    case "answered":
      return "it ended its loop";
    case "soft_stop":
      return "after an operator's soft stop";
    case "written_up":
      return `a write-up: ${ending.summary}`;
  }
}

/** The wind-down a resumed run's notes name (`loopEndingOf`) as the ending the
 *  loop composes the answer from once its tail has run (harness-pi item 6): a
 *  soft stop or the time budget over the text the record kept; nothing for a
 *  plain answer, and nothing for the labels only the deleted native loop wrote
 *  — the turn guard's, `stuck_loop`, `sandbox_dead` — which a row from before
 *  this release may still carry and `answerUnderEnding` keeps as they were. */
function windDownEndingUnder(text: string, ending: LoopEnding): WindDownEnding | undefined {
  if (ending.kind === "soft_stop") return { kind: "soft", text };
  if (ending.kind === "written_up" && ending.note === "time_budget_exhausted") return { kind: "time", text };
  return undefined;
}

/** The answer the thread would have seen had the previous generation lived to
 *  reply: the harness's own label for the ending (the ⏹ of a soft stop, the ⚠️
 *  of a budget) over the write-up, or the text as it stands. The turn guard's
 *  label — and the labels of the notes only the deleted native loop wrote
 *  (`stuck_loop`, `sandbox_dead`), which a row from before this release may
 *  still carry — carry their note's summary, which names the pace or the
 *  diagnosis that loop put there. */
function answerUnderEnding(text: string, ending: LoopEnding, maxMinutes: number): string {
  const windDown = windDownEndingUnder(text, ending);
  if (windDown !== undefined) return windDownAnswer(windDown, maxMinutes);
  if (ending.kind !== "written_up") return text || "_(no response)_";
  return text ? `⚠️ _${ending.summary}_\n\n${text}` : `⚠️ ${ending.summary}`;
}

/** The harness word a row names when `harnessFactsOf` reads it as no facts —
 *  a word outside this build's roster — with the pid and container it recorded,
 *  each `unknown` when the row lacks it; nothing for a row that names no
 *  harness at all (a fresh run, a row from before the seam wrote one). */
function unknownHarnessWordOf(state: unknown): { word: string; pid: string; container: string } | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const { harness, pid, container } = state as Record<string, unknown>;
  if (typeof harness !== "string") return undefined;
  return {
    word: harness,
    pid: typeof pid === "number" ? String(pid) : "unknown",
    container: typeof container === "string" ? container : "unknown",
  };
}
