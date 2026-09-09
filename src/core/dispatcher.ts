import { configAwarenessBlock } from "./configAwareness.js";
import { selfDescriptionBlock } from "./selfDescription.js";
import { customInstructionsBlock } from "./customInstructions.js";
import { AGENTS, getAgent, type AgentDef } from "../agents/registry.js";
import type { RequestDirectives, ThreadDirectives } from "../directives.js";
import type { LedgerRun } from "./runLedger/writeThrough.js";
import { systemClock } from "./trace/index.js";
import type { SpanSink, Tracer } from "./trace/types.js";
import type { SpanLog } from "./trace/spanLog.js";
import type { RunOwner } from "./trace/streamSpans.js";
import { channelOf, startRequestRoot, type RequestTrace } from "./requestTrace.js";
import { cardShapeLineOf, queuedCaption } from "./runShape.js";
import { SPAN_SCHEMA } from "./normalizeSpans.js";
import { parseModelRef } from "../providers/types.js";
import { currentPrHeadSha, prCommitsSince, type RepoContext } from "./repoContext.js";
import { postReviewComment } from "../execution/githubComments.js";
import {
  createBranchRef,
  fetchPullRequestFacts,
  fetchRepoShipInfo,
  findOpenPrByHead,
  openPullRequest,
  type PullRequestFacts,
} from "../execution/githubPulls.js";
import { resolveGithubIdentity, type GithubIdentity } from "../execution/githubApp.js";
import {
  resolveShipCaps,
  runShipPipeline,
  shipPreflight,
  shipRoundHeader,
  type ShipBlocks,
  type ShipChildSpec,
  type ShipOutcome,
} from "./shipPipeline.js";
import { skillGuidanceBlock } from "../skills/index.js";
import { isSpanRecord, redactSecrets, type RunEvent, type StopMode } from "./runEvents.js";
import { oneLine, redactAndCap, stripAnsi } from "./redact.js";
import { mergeFollowUps, type LiveThread } from "./threadAdmission.js";
import { utf8ByteLength, type RunStatus } from "./runRecord.js";
import { assembleRunRecord, channelVisibilityOf, type RecordDeps } from "./dispatch/record.js";
import {
  activityLine,
  attachmentSuffix,
  cardLines,
  composeRunLabel,
  errorReply,
  humanizeMessageText,
  isMrkdwnChannel,
  liveViewLink,
} from "./dispatch/reply.js";
import {
  admit,
  adoptCarriedRun,
  closeResumedRow,
  defaultAdmission,
  foldCarriedInbox,
  type AdmissionContext,
  type AdmissionDeps,
  type DispatchFollowUp,
  type RestartContext,
  type ResumeContext,
} from "./dispatch/admission.js";
import { answerChatCommand, answerOperation, type FastPathDeps } from "./dispatch/fastPath.js";
import { readRequest, resolveRun, resolveTarget, type ResolveDeps } from "./dispatch/resolve.js";
import {
  authorizeAgent,
  authorizeAttachedHead,
  authorizePrHead,
  authorizeRepo,
  type AuthorizeDeps,
} from "./dispatch/authorize.js";
import { buildMessages, contextMessageTexts } from "./dispatch/messages.js";
import {
  attachWorkspace,
  composePrompt,
  openAckCard,
  registerRun,
  reserveRun,
  startMemoryRead,
  type ProvisionDeps,
} from "./dispatch/provision.js";
import { analyzeRunFriction, type FrictionDiagnosis } from "./runFriction.js";
import { claimRun, githubCapabilityFor, shutdownNotice, webCapability, type RunDeps } from "./dispatch/run.js";
import { redactPrDescription, runLoop } from "./dispatch/runLoop.js";
import { afterReply, deliverAnswer, type ReplyDeps } from "./dispatch/reply.js";
import { writeTombstone } from "./dispatch/record.js";
import type { IssueTracker } from "../execution/githubIssues.js";
import { defaultRunRegistry, type RunHandle, REPLAY_EVERYTHING } from "./runRegistry.js";
import { createCardShell, type CardShell } from "./statusCardFrame.js";
import { createRunEnding, type RunEnding } from "./runEnding.js";
import type { ChannelIO, HistoryItem, IncomingMessage, StatusHandle } from "./types.js";

// The dispatcher is the channel-agnostic core: config commands, directive
// parsing, layered resolution, permission gates, history assembly, executor
// selection, and the agent run. Channels are pure transports (src/channels/).

export interface CoreDeps
  extends AdmissionDeps, FastPathDeps, ResolveDeps, AuthorizeDeps, ProvisionDeps, RunDeps, ReplyDeps, RecordDeps {
  /** The tracer behind every root this process starts; the no-gaps test injects one with its `SpanContext`. */
  tracer?: Tracer;
  /** The root's leading sinks (a test's recording sink); default: the one log sink at `tracing.log`. */
  sinks?: SpanSink[];
  /** The in-process span log every root also feeds (docs/reference/specs/tracing.md item 26); `GET /admin/trace/log` reads it. */
  spanLog?: SpanLog;
  /**
   * Ship round 0's pipeline-branch create (docs/reference/specs/agent-ship.md item 3):
   * `refs/heads/<branch>` at the base ref's tip, so the ref exists on
   * origin BEFORE the resident is asked to bind the thread to it. Default:
   * githubPulls' `createBranchRef` (App token REST, 422 already-exists is
   * success). Injectable so tests assert the call without a network call.
   */
  createBranchRef?: (repo: string, branch: string, fromRef: string) => Promise<void>;
  /**
   * One PR's entry-check facts for agent:ship (item 10): open/closed, author
   * identity (login + immutable numeric id), same-repo head, head ref/sha —
   * the resume-at-review checks, and the merge-ready "still open" re-check.
   * Default: githubPulls' `fetchPullRequestFacts`. Injectable for tests.
   */
  fetchPrFacts?: (pr: { repo: string; number: number }) => Promise<PullRequestFacts | undefined>;
  /**
   * The GitHub identity this process acts as (agent-ship.md item 10): the App's
   * bot user, or the static token's user — what ship's own PRs are authored by.
   * Default: githubApp's `resolveGithubIdentity`. Injectable for tests.
   */
  fetchSelfIdentity?: () => Promise<GithubIdentity | undefined>;
  /**
   * Where `friction propose` files its proposals. Default: the GitHub REST
   * tracker with the App installation token (App `issues:write`; never a `gh`
   * shell-out — AGENTS.md invariant 5). Injectable so tests assert filing
   * without a network call.
   */
  issueTracker?: IssueTracker;
}

// In-flight run tracking so the process can drain before exiting (restarts
// must not kill runs mid-flight — see index.ts signal handling).
let activeRuns = 0;

/** The note a follow-up's sender gets when the run it was folded into was
 *  stopped by an operator before its next step read it. */
const FOLLOW_UP_DROPPED_BY_STOP =
  "⛔ The run this was folded into was stopped before it read this follow-up, so it was not run. Re-send it to run it fresh.";
export function activeRunCount(): number {
  return activeRuns;
}

export interface DispatchOptions {
  resume?: ResumeContext;
  restart?: RestartContext;
  /** The request's root, started by the channel adapter at receipt
   *  (docs/reference/specs/tracing.md). Absent (tests, a caller without one) → the
   *  dispatcher starts its own at entry. Ended in the outermost finally. */
  trace?: RequestTrace;
  /** A fresh turn's wait behind the run it was parked on (the `queued …
   *  behind the previous run` caption; a `request` attr; never a duration term). */
  queuedBehindMs?: number;
}

export async function dispatch(
  deps: CoreDeps,
  msg: IncomingMessage,
  io: ChannelIO,
  opts: DispatchOptions = {},
): Promise<void> {
  const resume = opts.resume;
  const restart = opts.restart;
  const clock = deps.clock ?? systemClock;
  // The request's root (docs/reference/specs/tracing.md): the adapter's, started when our
  // process saw the message, or our own now. Every awaited step below is a
  // `span(fn)` child of it; the run-stream sink delivers the streamed ones to
  // the run once it exists; the outermost finally ends it. The window opens at
  // `receivedAt`; the queued captions are attrs on the root and lines on the
  // card, never part of a duration.
  // The queued numbers ride on the root FROM ITS START (`originAt`,
  // `queuedBehindMs` in the root options): the root's only streamed event is
  // its `span_start`, so an attr set later would never reach a run's record,
  // and the page's `queued …` caption reads the record.
  const trace =
    opts.trace ??
    startRequestRoot(deps, {
      channel: channelOf(msg.channelId),
      receivedAt: msg.receivedAt ?? clock(),
      ...(msg.originAt !== undefined ? { originAt: msg.originAt } : {}),
      ...(opts.queuedBehindMs !== undefined ? { queuedBehindMs: opts.queuedBehindMs } : {}),
    });
  const root = trace.root;
  const receivedAt = trace.receivedAt;
  const queuedBeforeMs = msg.originAt !== undefined ? Math.max(0, receivedAt - msg.originAt) : undefined;
  // A fresh turn's wait is the one behind the run; a platform delay is only
  // named when no such wait exists.
  const queued = queuedCaption("behind", opts.queuedBehindMs) ?? queuedCaption("before", queuedBeforeMs);
  // A refusal — a close and a reply that end the request without a run — is
  // one `dispatch.refuse` span naming why.
  let refused = false;
  const refuse = <T>(outcome: string, fn: () => Promise<T>) => {
    refused = true;
    return root.span("dispatch.refuse", fn, { attrs: { outcome } });
  };
  // The card's shape and queued lines at a close (docs/reference/specs/tracing.md item 5):
  // a runless close reads the root's children so far over a live window; a
  // done close the whole window to the finish.
  const closeLines = (end: number, finished: boolean, owner: RunOwner = "agent") =>
    cardLines(trace, { end, finished, owner, queued });
  // A done close reads the finish-site diagnosis (docs/reference/specs/tracing.md item 5):
  // the same shape the record carries and the friction report prints.
  const doneLines = (diagnosis: FrictionDiagnosis | undefined) => {
    const shape = diagnosis?.shape ? cardShapeLineOf(diagnosis.shape) : undefined;
    return { ...(shape ? { shape } : {}), ...(queued ? { queued } : {}) };
  };
  let caught = false;
  // Counted in flight from the first line — before history, repo resolution,
  // the setup card and the executor attach — until the post-run steps (reply,
  // review post, memory reflection scheduling) have run; decremented in the
  // outer finally. The shutdown drain (index.ts) polls this count: a SIGTERM
  // that lands between the channel's 👀 ack and the first status card used to
  // see "0 run(s) in flight" and exit at once, abandoning an acked run.
  // Config commands and refusals hold the slot for their few hundred
  // milliseconds too — cheaper than a second gap.
  activeRuns++;
  // How this dispatch's runs end (runEnding.ts; docs/reference/specs/tracing.md): a run is
  // SEALED once its first reply attempt has completed, and its record — its
  // inputs (the registry snapshot, the diagnosis) captured synchronously at
  // finish inside the run's try/catch, so a failed run has them too — is
  // assembled, byte-budgeted (`fitRecordToBudget`) and written by the drain
  // right after the seal, so it carries the seal's stamps and the events
  // published between finish and seal, and neither persistence nor the
  // budgeting pass ever delays the user. The reply wrap drains on the success
  // path, the outer catch drains around the error reply, and the outer finally
  // drains as the backstop: every run is sealed and its record written exactly
  // once. A writer's `failedAfterFinish` flips a run whose loop completed but
  // whose card close or reply threw to `failed` — the thread never saw the
  // answer — while a stop that already ended it keeps its `stopped_*` status.
  const ending = createRunEnding({ registry: deps.runRegistry ?? defaultRunRegistry });
  // The ack card while setup is still in progress. Cleared the moment it
  // becomes the run card, so the outer catch closes ONLY a card that setup
  // left open — a run failure is closed (with its checklist) by the run loop.
  let setupCard: StatusHandle | undefined;
  let setupShell: CardShell | undefined;
  // The card ticks from the ack (docs/reference/specs/tracing.md): a 5 s heartbeat repaints
  // it through setup — the elapsed time and the setup step in flight — until
  // the run loop's own heartbeat takes over (or the request ends without one).
  let setupHeartbeat: ReturnType<typeof setInterval> | undefined;
  // Thread admission (docs/reference/specs/thread-admission.md): the slot this dispatch
  // holds on its thread while its run is in flight, claimed after the agent
  // gate below and released in the outer finally — where whatever follow-ups
  // the run never consumed are run as a fresh turn (or, after an operator
  // stop, answered with a note).
  const admission = deps.admission ?? defaultAdmission;
  const registry = deps.runRegistry ?? defaultRunRegistry;
  let admitted: LiveThread<DispatchFollowUp> | undefined;
  // The run's registry row, created at its reservation (item 42) — before the
  // workspace attach, so the runs index, the run page and the stop routes know
  // the run from the moment its thread does. Hoisted for the reservation's
  // stop hooks and the outer finally, and read there — never cached from a
  // return value, so a run that THREW after a stop was requested still counts
  // as stopped.
  let registered: RunHandle | undefined;
  // True once the run loop owns the run (its own finally finishes it). Until
  // then the outer finally discards the row — the run never started — as it
  // abandons the reservation.
  let runLoopStarted = false;
  // The run's row on the ledger (item 35), once claimed; undefined for an
  // untracked run. Read by the record writer (the finish goes through it) and
  // the outer finally (its heartbeat stops with the run).
  let ledgerRun: LedgerRun | undefined;
  // The run's reservation on the ledger (item 42): its row from before the
  // workspace attach, promoted by the claim below (then `ledgerRun` is the
  // same handle) or abandoned in the outer finally when the dispatch ends
  // before that. `requestRow` is the request as the row carries it. A fence
  // during the attach means another generation restarted the run: this one
  // stops at the attach's end and says nothing. A stop relayed during the
  // attach latches in the run's control; the run loop reads it at its first
  // step.
  let reserved: LedgerRun | undefined;
  let requestRow: Record<string, unknown> | undefined;
  let fencedWhileAttaching = false;
  const reservationHooks = {
    onStop: (mode: StopMode) => void registered?.control.requestStop(mode),
    onFenced: () => {
      fencedWhileAttaching = true;
      void registered?.control.requestStop("hard");
    },
  };
  try {
    // Stage A (dispatch/fastPath.ts): a message that names a registered chat
    // command is answered inline — never a model turn, and before the history
    // fetch, so a command costs none.
    if (await answerChatCommand(deps, { msg, io, ending, trace })) return;

    const { directives, history } = await readRequest({ msg, io, root });

    // The natural-language op fast path (dispatch/fastPath.ts): a conservative
    // op form is the registry command it names; an op that cannot serve falls
    // through to the agent.
    if (await answerOperation(deps, { msg, io, ending, trace, directives, history })) return;

    // The (agent, model, effort) this request resolves to (dispatch/resolve.ts):
    // a directive, else the thread's sticky one, else the config scopes.
    const { sticky, resolved } = resolveRun(deps, { msg, directives, history });

    // The agent gate (dispatch/authorize.ts), against the RESOLVED agent and
    // before the thread is claimed.
    if ((await authorizeAgent(deps, { msg, io, refuse, agentName: resolved.agentName })).kind === "refused") return;

    const agent = getAgent(resolved.agentName);

    // Thread admission (docs/reference/specs/thread-admission.md item 1) and the
    // carried run's row and inbox: the admission stage (dispatch/admission.ts).
    // What the stage takes hold of — the thread slot, an adopted row, a
    // reservation — comes back here before the next step that can throw, so
    // the outer finally releases exactly what it did before the extraction.
    const carriedRow = resume?.row ?? restart?.row;
    const admissionCtx: AdmissionContext = {
      msg,
      io,
      directives,
      agentName: agent.name,
      resume,
      restart,
      carriedRow,
      clock,
      root,
      refuse,
      admission,
      hooks: {
        reservation: reservationHooks,
        adopt: {
          onStop: (mode) => void registered?.control.requestStop(mode),
          onFenced: () => void registered?.control.requestStop("hard"),
        },
      },
    };
    const outcome = await admit(deps, admissionCtx);
    if (outcome.kind === "redispatch") return dispatch(deps, msg, io);
    if (outcome.kind !== "proceed") return;
    admitted = outcome.admitted;
    const taken = await adoptCarriedRun(deps, admissionCtx);
    ledgerRun = taken.ledgerRun;
    reserved = taken.reserved;
    requestRow = taken.requestRow;
    await foldCarriedInbox(deps, admissionCtx, admitted);

    // The provider behind the model ref, and the target repo/ref/PR resolution
    // STARTED here (dispatch/resolve.ts) so the GitHub round trip overlaps the
    // memory read below; awaited after the ack.
    const { provider, model, needsRepo, repoCtxP } = resolveTarget(deps, {
      msg,
      history,
      agent,
      resolved,
      resume,
      root,
    });

    // Cross-session memory — READ path, started here (dispatch/provision.ts) so
    // the memory Worker round trip overlaps the repo/PR resolution and the
    // attach; awaited when the prompt is composed.
    const memoryBlockP = startMemoryRead(deps, { msg, directives, repoCtxP, root });

    // Acknowledge NOW, before anything slow. Everything between here and the
    // model turn can take minutes — repo/PR resolution (GitHub REST), memory
    // retrieval, and above all executor selection (resident attach or a cold
    // sandbox clone+install) — and until this card existed the thread saw
    // nothing for that whole stretch. The same handle becomes the run's status
    // card below; a refusal or setup failure closes it with a reason instead of
    // leaving a spinner behind.
    // A resumed run's clock is the original start (its ledger row's), so the
    // card's elapsed time spans the whole run, not the resume.
    // The card's clock is the request's: it ticks from receipt (docs/reference/specs/tracing.md).
    const startedAt = carriedRow?.startedAt ?? receivedAt;
    const ack = await openAckCard(deps, { io, agent, resolved, startedAt, clock, root, trace });
    const { shell, card } = ack;
    setupCard = card;
    setupShell = shell;
    setupHeartbeat = ack.heartbeat;

    // The repo/ref resolution started above (before the ack) lands here; the
    // gate below runs against it exactly as before.
    // `let`: the attach-head check below may adopt the PR's current head when
    // the branch moved between resolution and attach (item 12).
    let repoCtx: RepoContext = await repoCtxP;

    // The repository gates (dispatch/authorize.ts): not onboarded, unverified,
    // access — each closes the card and replies by name.
    const repoGate = await authorizeRepo(deps, {
      msg,
      io,
      refuse,
      card,
      shell,
      closeLines,
      clock,
      agent,
      needsRepo,
      repoCtx,
    });
    if (repoGate.kind === "refused") return;

    // agent:ship fork (docs/reference/specs/agent-ship.md): after agent resolution and the
    // repo gates above, BEFORE the top-level attach — ship names its own
    // pipeline branch and each child round attaches its own workspace
    // (shipPipeline.ts). The branch owns everything from here: the preflight
    // refusals, the one run record, the round loop, the final report. An
    // unexpected throw propagates to the outer catch after the branch closed
    // its own card and persisted its failed record.
    if (agent.name === "ship") {
      setupCard = undefined; // the ship branch owns the card from here
      clearInterval(setupHeartbeat);
      await runShipBranch(deps, msg, io, {
        agent,
        modelRef: resolved.modelRef,
        label: shell.label,
        startedAt,
        card,
        directives,
        sticky,
        history,
        repoCtx,
        memoryBlockP,
        live: admitted,
        ending,
        trace,
        closeLines,
        refuse,
        doneLines,
      });
      return;
    }

    // A resume continues the exact conversation the ledger held (item 38);
    // the thread history was folded into it when the run started.
    const messages = resume ? resume.plan.messages : buildMessages(history, directives.text, msg.images, msg.documents);

    // Executor selection is context-aware: the agent's resource declarations
    // decide whether anything is provisioned at all (general gets nothing),
    // and repo/ref carry resident-repo inference. A resident fallback comes
    // back with a named note that rides on every status frame below.
    // Unknown-head check (dispatch/authorize.ts): a review whose PR head could
    // not be resolved is not started, before any attach.
    const headPreflight = await authorizePrHead({
      msg,
      io,
      refuse,
      card,
      shell,
      closeLines,
      clock,
      agent,
      directives,
      repoCtx,
    });
    if (headPreflight.kind === "refused") return;

    // The reservation (item 42): the run's row on every surface BEFORE the
    // workspace attach (dispatch/provision.ts) — the registry row, its label and
    // link, the request and context events — then, for a fresh request, the
    // ledger row. `registered` the moment the row exists: a later throw discards it.
    const registration = await registerRun(deps, {
      msg,
      io,
      agent,
      resolved,
      directives,
      history,
      repoCtx,
      carriedRow,
      resume,
      startedAt,
      receivedAt,
      clock,
      root,
      trace,
      registry,
      shell,
      admitted,
    });
    const { run, runId, channelVisibility, liveUrl, publishText, publishRunMeta } = registration;
    registered = run;
    const reservation = await reserveRun(deps, {
      msg,
      agent,
      resolved,
      repoCtx,
      channelVisibility,
      runId,
      startedAt,
      receivedAt,
      resume,
      restart,
      card,
      hooks: reservationHooks,
      admitted,
      root,
    });
    if (reservation) {
      reserved = reservation.reserved;
      requestRow = reservation.requestRow;
    }

    // The workspace attach (dispatch/provision.ts): the setup step that takes
    // minutes on a cold clone, and the ask-once refusal when no branch is bound.
    const attach = await attachWorkspace(deps, {
      msg,
      io,
      refuse,
      card,
      shell,
      closeLines,
      clock,
      agent,
      repoCtx,
      root,
    });
    if (attach.kind === "refused") return;
    const { round } = attach;
    const { executor, note, resident } = round.selection;
    if (fencedWhileAttaching) {
      // The reservation's lease lapsed during the attach and another generation
      // took the row (item 42): the run is theirs to restart — nothing more
      // runs or replies here, and the row is left alone.
      console.log(
        `[dispatch] ${msg.threadKey} run ${runId}: another generation took the run during the attach — stopping here, it restarts there`,
      );
      if (executor.release) await executor.release("always").catch(() => {});
      return;
    }

    // Attach-head check (dispatch/authorize.ts): for a PR review on the resident
    // path, the attached sha against the resolved PR head, before any model turn.
    const headGate = await authorizeAttachedHead(deps, {
      msg,
      io,
      refuse,
      card,
      shell,
      closeLines,
      clock,
      agent,
      resume,
      selection: round.selection,
      repoCtx,
      root,
    });
    if (headGate.kind === "refused") return;
    repoCtx = headGate.repoCtx;
    const verifiedAtAttach = headGate.verifiedAtAttach;
    // The run's meta went out at the reservation with the head as resolved
    // then; the record and the page must name the head actually reviewed.
    if (headGate.headAdopted) publishRunMeta(repoCtx);

    // Whether this run reviews a resolved PR (its system prompt carries the
    // REVIEW TARGET block, item 9) — the same predicate the post-step and the
    // head-settle key on.
    const isPrReview = agent.name === "review" && repoCtx.repo !== undefined && repoCtx.pr !== undefined;
    // Coding PR post-step gate (docs/reference/specs/pr-description.md item 5): only a
    // writable-toolset run can have pushed a branch — readonly (review) and
    // none/web toolsets never trigger the post-step. The repo is deliberately
    // NOT part of the gate: a dispatch that resolved no slug can still open
    // the PR from the workspace's observed origin remote (an agent-discovered
    // repo; the App token bounds what is writable either way).
    const isCodingPrRun = agent.toolset === "full";
    // The prompt (dispatch/provision.ts): skills, MCP discovery, the config and
    // self-description blocks, the custom instructions, the memory block, and
    // the system composer pinned to the head this run reviews.
    const prompt = await composePrompt(deps, {
      msg,
      agent,
      resolved,
      directives,
      sticky,
      repoCtx,
      selection: round.selection,
      isPrReview,
      memoryBlockP,
      verifiedAtAttach,
      resume,
      root,
    });
    const { mcpForRun, composeSystem, system } = prompt;
    // The PR head this run reviews — the resolved head, or the one adopted at
    // attach; the head settle (item 12) advances it after the model turn.
    const reviewHead = prompt.reviewHead;

    if (note) shell.setLabel(`${shell.label} · ${oneLine(note)}`);
    // A run that went to a cold sandbox says why on its stream too (resident-
    // repos item 24): the card is not the only witness — the run page would
    // otherwise show resident steps grafted under an attach that ended on the
    // sandbox backend, with nothing saying the resident gave up. Only a
    // sandbox-backed run: a resident run's note is the positive `resident ·
    // <repo> · <ref>@<sha7>` (or "attached to the last snapshot"), not a
    // fallback. Head material, like every setup event ahead of the loop.
    if (note && !resident)
      registry.publish(run.id, { type: "run_note", kind: "cold_sandbox", summary: oneLine(note), at: clock() });
    console.log(`[run] ${msg.threadKey} user=${msg.userId} agent=${agent.name} model=${resolved.modelRef}`);
    setupCard = undefined; // from here the run loop owns the card's close
    clearInterval(setupHeartbeat);
    card.update(shell.live()); // the ack card becomes the run card
    const activityAt = clock();
    // The run loop owns the run from here: its finally finishes it (the outer
    // finally discards a run that never got this far). Events are fed to the
    // registry in onEvent below; the stream has been live since the reservation.
    runLoopStarted = true;
    if (resume) {
      console.log(
        `[resume] ${msg.threadKey} run ${run.id} continues under ${deps.runLedger.gen}: from step ${resume.plan.step}, ${resume.plan.settlements.length} call(s) to settle, ${resume.events.length} event(s) replayed`,
      );
    }
    // Tombstone-first (dispatch/record.ts): a provisional interrupted record
    // the moment the run loop owns the run; the finish write replaces it.
    writeTombstone(deps, { msg, agent, resolved, repoCtx, channelVisibility, run, registry, resume });
    // The ledger claim (dispatch/run.ts), once the prompt exists: the reserved
    // row promoted, or a resume's adopted row re-subscribed.
    ledgerRun = await claimRun(deps, {
      msg,
      agent,
      resolved,
      repoCtx,
      channelVisibility,
      run,
      registry,
      selection: round.selection,
      requestRow,
      reserved,
      system,
      mcpForRun,
      messages,
      resume,
      ledgerRun,
      card,
      clock,
      root,
    });
    // The agent loop (dispatch/runLoop.ts): the model turn, the follow-up inbox,
    // the settle and the post-steps, the finish. A throw propagates to the
    // outer catch after the workspace is released.
    const ran = await runLoop(deps, {
      msg,
      io,
      agent,
      resolved,
      provider,
      model,
      messages,
      system,
      composeSystem,
      mcpForRun,
      run,
      registry,
      round,
      admitted,
      ledgerRun,
      resume,
      repoCtx,
      isPrReview,
      isCodingPrRun,
      reviewHead,
      card,
      shell,
      doneLines,
      clock,
      root,
      startedAt,
      activityAt,
      channelVisibility,
      publishText,
      ending,
    });
    const {
      answer,
      verdict,
      observedHead,
      carried,
      prNote,
      toolCalls,
      runDiagnosis,
      finalDetail,
      checkedOffDetail,
      releaseWorkspace,
    } = ran;

    // The card's final icon tells the stop apart from a normal finish: ⏹ soft
    // (a summary was written), ⛔ hard (aborted, no summary).
    const stopped = run.control.requested;
    console.log(`[done] ${msg.threadKey} ${answer.length} chars${stopped ? ` (stopped: ${stopped})` : ""}`);

    // The answer reaches the thread (dispatch/reply.ts): finishing on the
    // ledger, the card close, the reply, the seal — the workspace released
    // after. A fenced run is another generation's now: nothing more from here.
    const delivery = await deliverAnswer({
      msg,
      io,
      agent,
      run,
      answer,
      liveUrl,
      prNote,
      stopped,
      ledgerRun,
      ending,
      card,
      shell,
      finalDetail,
      checkedOffDetail,
      doneLines,
      runDiagnosis,
      releaseWorkspace,
      root,
    });
    if (delivery === "fenced") return;

    // After the reply (dispatch/reply.ts): the memory reflection pass and the
    // deterministic review post-step.
    await afterReply(deps, {
      msg,
      io,
      agent,
      resolved,
      directives,
      history,
      repoCtx,
      run,
      channelVisibility,
      stopped,
      answer,
      toolCalls,
      reviewHead: ran.reviewHead,
      observedHead,
      verdict,
      carried,
      root,
    });
  } catch (err) {
    caught = true;
    const errMsg = err instanceof Error ? err.message : String(err);
    // A card left spinning after a setup failure looks like a hang; close it.
    // Only a card still in setup — a run failure was already closed by the run
    // loop with its checklist, and must not be relabeled here.
    // Item 62: the error may carry remote text (a resident reason, a GitHub
    // body) — one redacted line on the card, a redacted reply in the thread.
    if (setupCard && setupShell) {
      const [failedCard, failedShell] = [setupCard, setupShell];
      await refuse("setup_failed", () =>
        failedCard.done(
          failedShell.close({
            kind: "setup_failed",
            reason: oneLine(redactAndCap(errMsg, 120)),
            ...closeLines(clock(), false),
          }),
        ),
      ).catch(() => {});
    }
    // The error reply seals whatever finished run is still unsealed (a run
    // whose loop threw: `replyOk` says how this reply went) and drains: the
    // `failed` record is written now. A setup failure before any run started
    // has nothing to seal or write. A run whose card close or reply threw was
    // already sealed and written by its own wrap; this is a no-op for it.
    // A run's failure reply is a `post.reply`; a setup failure's is the refusal.
    const replyName = root.record().attrs.runId !== undefined ? "post.reply" : "dispatch.refuse";
    await ending
      .sealAfterReply(
        async () => {},
        () => root.span(replyName, () => io.reply(redactSecrets(stripAnsi(errorReply(err))))),
      )
      .catch(() => {});
  } finally {
    clearInterval(setupHeartbeat); // a refusal or a setup failure ended the request before the run loop took the card
    // The backstop: a finished run no reply attempt reached (a fenced run, a
    // branch that returned early) is sealed with no `replyOk`, and any record
    // still registered is written.
    ending.drain(undefined);
    // A resumed dispatch that ended before its run loop started — an unknown
    // provider, a refusal, a gate — has adopted a row it will never finish
    // (item 38). Close it `interrupted` here, or the sweep would relaunch it
    // every lease interval forever.
    if (resume && ledgerRun && !runLoopStarted) {
      const adopted = ledgerRun;
      await root.span("post.history_write", () =>
        closeResumedRow(adopted, resume, "the resumed dispatch ended before the run started"),
      );
      console.log(
        `[resume] ${msg.threadKey} run ${resume.row.runId} closed interrupted: the resumed dispatch ended before the run started`,
      );
    }
    // Thread admission (docs/reference/specs/thread-admission.md item 4): free the thread,
    // and settle what the run never consumed. A run that ended by itself (an
    // answer, a budget, a failure, a dead sandbox) hands its unconsumed
    // follow-ups on as ONE fresh turn — on the most recent sender's channel
    // handle, so the reply lands where they asked — never a silent drop. A run
    // an operator stopped does not: the stop meant "no more work here", and
    // each sender is told their follow-up was not run. The fresh turn is an
    // ordinary dispatch: it claims the thread itself, and a follow-up arriving
    // during it steers into it.
    const pending = admitted ? admission.release(msg.threadKey, admitted) : [];
    // A stop counts once the run loop had the run: a stop relayed during an
    // attach that then refused stopped nothing, and the follow-ups run fresh.
    const stopMode: StopMode | undefined = runLoopStarted ? registered?.control.requested : undefined;
    if (pending.length > 0 && stopMode) {
      console.log(`[dispatch] ${msg.threadKey} ${pending.length} follow-up(s) dropped: run stopped (${stopMode})`);
      await root.span("post.followups", async () => {
        for (const p of pending) await p.io.reply(FOLLOW_UP_DROPPED_BY_STOP).catch(() => {});
      });
    }
    // The request is over: its root ends here, after the seal and the tail,
    // with how it went — before the fresh turn below starts a root of its own.
    root.end(caught ? "error" : "ok", {
      status: caught ? "failed" : refused ? "refused" : stopMode ? "stopped" : "completed",
    });
    if (pending.length > 0 && !stopMode && admitted) {
      const merged = mergeFollowUps(pending)!;
      const last = pending[pending.length - 1];
      console.log(`[dispatch] ${msg.threadKey} ${pending.length} unconsumed follow-up(s) → fresh turn`);
      // The fresh turn is a request of its own (docs/reference/specs/tracing.md): it was
      // received NOW, and it waited behind this run since its earliest
      // follow-up arrived — the `queued … behind the previous run` caption.
      const freshAt = clock();
      const earliestAt = Math.min(...pending.map((p) => p.at));
      const queuedBehindMs = Math.max(0, freshAt - earliestAt);
      // The wait is on the root at start, so the fresh run's record carries it.
      const fresh = startRequestRoot(deps, {
        channel: channelOf(last.msg.channelId),
        receivedAt: freshAt,
        queuedBehindMs,
      });
      // Pinned to the agent the follow-ups were addressed to: they were
      // admitted as input FOR this run's agent (a different one would have
      // been refused), so the fresh turn must not fall back to whatever the
      // thread's history or the channel default resolves to.
      await dispatch(
        deps,
        // The follow-up's own platform stamp stays behind: the fresh turn's
        // wait is `queuedBehindMs`, not a `queued … before we saw it`.
        {
          ...last.msg,
          ...merged,
          text: `agent:${admitted.agent} ${merged.text}`,
          receivedAt: freshAt,
          originAt: undefined,
        },
        last.io,
        { trace: fresh, queuedBehindMs },
      ).catch((err: unknown) =>
        console.error(
          `[dispatch] ${msg.threadKey} fresh turn for unconsumed follow-ups failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    // A reservation never promoted (item 42): the dispatch ended before its
    // prompt existed — a refusal after the reserve, an attach that failed, a
    // throw — so the run never started and nothing is recorded; the row goes,
    // or the sweep would restart it forever. A fenced reservation is another
    // generation's to restart: `abandon` is a no-op on it.
    if (reserved && !ledgerRun) await root.span("post.ledger_abandon", () => reserved!.abandon());
    // …and the registry row created with it goes the same way: no finished
    // frame, no record — a run that never started is not listed as one that did.
    if (registered && !runLoopStarted) registry.discard(registered.id);
    // The ledger heartbeat stops with the run (the finish write, in flight
    // through the writer, closes the row itself).
    void ledgerRun?.close();
    activeRuns--;
  }
}

/** What the agent:ship fork carries out of dispatch()'s prelude — values the
 *  pipeline must not re-derive, because the gates already ran against them. */
interface ShipBranchContext {
  /** AGENTS["ship"] — labels and run meta only; never handed to runAgent. */
  agent: AgentDef;
  /** The modelRef resolved for the ship request — recorded on the run, never
   *  called; child rounds resolve their own per-agent models. */
  modelRef: string;
  label: string;
  startedAt: number;
  /** The coalesced ack card; the ship branch owns its close from here. */
  card: StatusHandle;
  directives: RequestDirectives;
  sticky: ThreadDirectives;
  history: HistoryItem[];
  repoCtx: RepoContext;
  memoryBlockP: Promise<string | undefined>;
  /** The thread's admission slot this dispatch holds (thread-admission item
   *  1): the ship branch names its run on it once registered, so a refused
   *  follow-up in a live ship thread links the run page like any other. */
  live: LiveThread<DispatchFollowUp>;
  /** The dispatch's run ending: the ship run seals after its reply like any other. */
  ending: RunEnding;
  /** The request's trace (docs/reference/specs/tracing.md): the ship run binds to it, its steps are spans under the root. */
  trace: RequestTrace;
  /** The card's shape and queued lines at a close, from the dispatch's window. */
  closeLines: (end: number, finished: boolean, owner?: RunOwner) => { shape?: string; queued?: string };
  /** A refusal as one `dispatch.refuse` span. */
  refuse: <T>(outcome: string, fn: () => Promise<T>) => Promise<T>;
  /** The done card's shape and queued lines, from the finish-site diagnosis. */
  doneLines: (diagnosis: FrictionDiagnosis | undefined) => { shape?: string; queued?: string };
}

/**
 * The agent:ship branch (docs/reference/specs/agent-ship.md): preflight refusals, then
 * the ONE run record + card shell around `runShipPipeline`'s round loop —
 * the ship counterpart of the main path's run shell, reusing the same label,
 * event, record, and friction vocabulary so /runs shows a pipeline exactly
 * like any run. Handled endings reply here; an unexpected throw closes the
 * card, persists the `failed` record, and propagates to dispatch()'s outer
 * catch for the error reply.
 */
async function runShipBranch(
  deps: CoreDeps,
  msg: IncomingMessage,
  io: ChannelIO,
  ctx: ShipBranchContext,
): Promise<void> {
  // `closeLines` keeps its default owner (`agent`): a ship run's children are
  // agent runs, so its `run.command` grafts — none today — would count as
  // getting ready, never as a command's own tools.
  const { agent, card, directives, history, repoCtx, label, ending, trace, closeLines, refuse, doneLines } = ctx;
  const root = trace.root;
  const clock = deps.clock ?? systemClock;
  // The same one-builder card shell as the main path, on the same label and clock.
  const shell = createCardShell({ label, startedAt: ctx.startedAt, now: clock });
  const pre = await root.span("dispatch.ship_preflight", () =>
    shipPreflight({
      channelId: msg.channelId,
      threadKey: msg.threadKey,
      requestText: directives.text,
      repoCtx,
      gates: { canRunAgent: (a) => deps.config.canRunAgent(msg.userId, a), adminsHint: () => deps.config.adminsHint() },
      repoInfo: deps.fetchRepoShipInfo ?? fetchRepoShipInfo,
      prFacts: deps.fetchPrFacts ?? fetchPullRequestFacts,
      selfIdentity: deps.fetchSelfIdentity ?? resolveGithubIdentity,
      runsBase: process.env.PUBLIC_BASE_URL,
    }),
  );
  if (!pre.ok) {
    console.log(`[ship] ${msg.threadKey} not started: ${pre.where}`);
    await refuse("ship_preflight", async () => {
      await card.done(shell.close({ kind: "refused", icon: "🚫", reason: pre.card, ...closeLines(clock(), false) }));
      await io.reply(pre.reply);
    });
    return;
  }
  const entry = pre.entry;

  // The one run record: registered and stamped exactly like the main
  // path — input, run_meta, bounded context, the tombstone.
  const registry = deps.runRegistry ?? defaultRunRegistry;
  const channelVisibility = await root.span("dispatch.channel_visibility", () =>
    channelVisibilityOf(deps, msg.channelId),
  );
  const run = registry.create(
    composeRunLabel({
      agent: agent.name,
      repo: repoCtx.repo,
      channelId: msg.channelId,
      userId: msg.userId,
      channelName: msg.channelName,
      userName: msg.userName,
      text: directives.text,
    }),
    {
      agent: agent.name,
      model: ctx.modelRef,
      channelId: msg.channelId,
      userId: msg.userId,
      threadKey: msg.threadKey,
      channelVisibility,
      receivedAt: trace.receivedAt,
      ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
      ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
      ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
    },
  );
  io.runStarted?.({ id: run.id });
  const publishText = (
    type: "input" | "context" | "answer",
    text: string,
    source?: { url?: string; channel?: string; user?: string },
  ) => {
    const redacted = redactSecrets(text);
    registry.publish(run.id, { type, text: redacted, ...(source ? { source } : {}), at: clock() });
    console.log(`[event] ${msg.threadKey} type=${type} bytes=${utf8ByteLength(redacted)}`);
  };
  const humanize = isMrkdwnChannel(msg.channelId);
  const attachments = attachmentSuffix(msg.images, msg.documents);
  const source = {
    ...(msg.sourceUrl ? { url: msg.sourceUrl } : {}),
    ...(msg.channelName ? { channel: msg.channelName } : {}),
    ...(msg.userName ? { user: msg.userName } : {}),
  };
  const request = humanize ? humanizeMessageText(directives.text) : directives.text;
  publishText(
    "input",
    attachments ? `${request} ${attachments}` : request,
    Object.keys(source).length > 0 ? source : undefined,
  );
  registry.publish(run.id, {
    type: "run_meta",
    agent: agent.name,
    model: ctx.modelRef,
    traceId: root.traceId,
    ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
    ...(entry.resume !== undefined ? { pr: entry.resume.pr } : {}),
    at: clock(),
  });
  if (deps.config.config.runHistory?.includeContext !== false) {
    for (const text of contextMessageTexts(history, humanize)) publishText("context", text);
  }
  // Tombstone-first, like the main path — a pipeline can run for
  // hours, so the provisional terminal record matters even more here.
  const startSnap = registry.snapshot(run.id, run.token);
  if (startSnap) {
    deps.runHistoryWriter.write(
      assembleRunRecord({
        run,
        snap: startSnap,
        agent: agent.name,
        model: ctx.modelRef,
        msg,
        channelVisibility,
        repo: repoCtx.repo,
        finishedAt: startSnap.startedAt,
        status: "interrupted",
        diagnosis: analyzeRunFriction(startSnap.events, {
          finished: false,
          truncated: startSnap.truncated,
          schema: SPAN_SCHEMA,
        }),
      }),
      { provisional: true },
    );
  }
  // The ledger claim (run-history item 35) for the live index and the finish.
  // A pipeline has no single model loop of its own — each child round runs
  // `runAgent` with its own prompt and conversation — so it is claimed without
  // a seed or step records and closes `interrupted` at a reclaim; resuming a
  // pipeline mid-round is not built. Untracked (a process without a ledger
  // included) → undefined, and the pipeline runs as before.
  const ledgerRun: LedgerRun | undefined = await root.span("dispatch.ledger_claim", () =>
    deps.runLedger.open({
      runId: run.id,
      threadKey: msg.threadKey,
      startedAt: registry.snapshot(run.id, run.token)?.startedAt ?? clock(),
      meta: {
        agent: agent.name,
        model: ctx.modelRef,
        channelId: msg.channelId,
        userId: msg.userId,
        threadKey: msg.threadKey,
        channelVisibility,
        ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
        ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
        ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
        ...(entry.resume !== undefined ? { pr: entry.resume.pr } : {}),
      },
      card: card.handle ?? null,
      system: "",
      tools: [],
      onStop: (mode) => void run.control.requestStop(mode),
      onFenced: () => void run.control.requestStop("hard"),
    }),
  );
  if (ledgerRun) {
    const opened = ledgerRun;
    registry.subscribe(run.id, run.token, {
      onEvent: (event, seq) => opened.event(event, seq),
      ...REPLAY_EVERYTHING,
    });
  }

  // The card's frames — the main path's vocabulary (spinner title, checklist +
  // one-line activity trace, heartbeat, shutdown notice) through `shell`.
  const liveUrl = liveViewLink(run.id, run.token);
  const liveLink = liveUrl ? { url: liveUrl, label: "Live run" } : undefined;
  ctx.live.runId = run.id;
  if (liveUrl) ctx.live.runLink = liveUrl;
  let checklist: string | undefined;
  let lastActivity: string | undefined;
  // The round header is orchestrator-owned (spec item 12): its OWN variable,
  // composed into the frame ABOVE the checklist — the same pattern as
  // `lastActivity` — so a child's update_status (which replaces the checklist
  // outright) can never erase which round the pipeline is in.
  let roundHeader: string | undefined;
  const currentFrame = () => shell.live({ notice: shutdownNotice, detail: [roundHeader, checklist, lastActivity] });
  const finalDetail = () => checklist;
  const checkedOffDetail = () => checklist?.replace(/^(\s*)[○✱](?=\s)/gm, "$1✓");
  const onEvent = (e: RunEvent) => {
    registry.publish(run.id, e);
    if (isSpanRecord(e)) return; // timing, not activity (docs/reference/specs/tracing.md)
    lastActivity = activityLine(e);
    console.log(`[tool] ${msg.threadKey} ${lastActivity}`);
    card.update(currentFrame());
  };
  const onProgress = (note: string) => {
    console.log(`[note] ${msg.threadKey} ${note}`);
    lastActivity = note;
    card.update(currentFrame());
  };
  trace.bindRun(run.id, (e) => registry.publish(run.id, e));
  const reportProgress = (list: string) => {
    const trimmed = list.trim();
    if (!trimmed) return; // never blank the durable progress record
    checklist = trimmed;
    card.update(currentFrame());
  };

  // Child resolution: each round resolves ITS agent's model/effort through
  // the standard layers — a `model:`/`effort:` directive on the ship request
  // wins for every child, exactly like a directive wins on any request.
  const child = (name: "coding" | "review"): ShipChildSpec => {
    const r = deps.config.resolve({
      channelId: msg.channelId,
      userId: msg.userId,
      request: {
        agent: name,
        model: directives.model ?? ctx.sticky.model,
        effort: directives.effort ?? ctx.sticky.effort,
      },
    });
    const { provider: providerName, model } = parseModelRef(r.modelRef);
    return {
      agent: getAgent(name),
      provider: deps.providers.get(providerName),
      modelRef: r.modelRef,
      model,
      ...(r.effort !== undefined ? { effort: r.effort } : {}),
    };
  };
  const scopes = deps.config.scopes(msg.channelId, msg.userId);
  const instructionsBlock = customInstructionsBlock(scopes);
  const memoryBlock = await root.span("dispatch.compose", () => ctx.memoryBlockP);
  const blocks = (spec: ShipChildSpec): ShipBlocks => ({
    memory: memoryBlock,
    config: configAwarenessBlock({
      agentName: spec.agent.name,
      modelRef: spec.modelRef,
      effort: spec.effort,
      channel: scopes.channel,
      user: scopes.user,
      messageDirective: { agent: directives.agent, model: directives.model, effort: directives.effort },
      threadDirective: { agent: ctx.sticky.agent, model: ctx.sticky.model, effort: ctx.sticky.effort },
      canEditChannelConfig: deps.config.canEditChannelConfig(msg.userId),
      // No `mcp` here: ship rounds receive no MCP tools yet (docs/reference/specs/mcp-tools.md
      // roadmap), and a line inviting `mcp add` into a run that could not use
      // the result would mislead. The line arrives with the tools.
    }),
    about: selfDescriptionBlock(AGENTS, deps.config.config.organization, deps.capabilities, deps.residentFleet.cap()),
    instructions: instructionsBlock,
    skills: deps.skills ? skillGuidanceBlock(deps.skills, spec.agent.name) : undefined,
  });

  console.log(
    `[run] ${msg.threadKey} user=${msg.userId} agent=ship model=${ctx.modelRef} entry=${entry.resume ? `resume ${entry.repo}#${entry.resume.pr}` : `round0 ${entry.branch}`}`,
  );
  card.update(shell.live());
  shell.setLink(liveLink);
  const heartbeat = setInterval(() => card.update(currentFrame()), 5000);
  let outcome: ShipOutcome | undefined;
  let shipDiagnosis: FrictionDiagnosis | undefined;
  try {
    outcome = await runShipPipeline({
      span: root,
      entry,
      round0Messages: buildMessages(history, directives.text, msg.images, msg.documents),
      child,
      blocks,
      factory: {
        execution: deps.config.config.execution,
        workspaceDir: deps.config.config.workspaceDir ?? "./workspaces",
        dataDir: deps.dataDir ?? "./data",
      },
      threadKey: msg.threadKey,
      caps: resolveShipCaps(deps.config.config.ship),
      control: run.control,
      inbox: ctx.live.inbox, // thread follow-ups steered into this run reach the child round in flight (thread-admission item 2)
      onEvent,
      onProgress,
      reportProgress,
      publish: (e) => {
        registry.publish(run.id, e);
        // A round's `started` boundary retitles the card's round header (the
        // settle events stay stream-only — the next round or the close frame
        // takes over the card).
        if (e.type === "ship_round" && e.outcome === "started") {
          roundHeader = shipRoundHeader(e);
          card.update(currentFrame());
        }
      },
      reply: (text) => io.reply(text),
      web: webCapability(),
      skills: deps.skills,
      githubTools: githubCapabilityFor(deps, msg.userId),
      github: {
        createBranchRef: deps.createBranchRef ?? createBranchRef,
        openPullRequest: deps.openPullRequest ?? openPullRequest,
        findOpenPrByHead: deps.findOpenPrByHead ?? findOpenPrByHead,
        postReviewComment: deps.postReviewComment ?? postReviewComment,
        fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
        fetchPrCommits: deps.fetchPrCommits ?? prCommitsSince,
        prFacts: deps.fetchPrFacts ?? fetchPullRequestFacts,
        fetchRepoShipInfo: deps.fetchRepoShipInfo ?? fetchRepoShipInfo,
      },
      redactDescription: redactPrDescription,
      logKey: msg.threadKey,
    });
    // The run record is the source of truth: the report enters the stream
    // BEFORE finish() below (a publish on a finished run is a no-op).
    publishText("answer", outcome.reply);
  } finally {
    // A throw passes through to dispatch()'s outer catch (the error reply, the
    // drain); this block still finishes the run, registers its `failed` record
    // and closes the card.
    clearInterval(heartbeat);
    // RunStatus is the run-store contract (shared with the memory worker):
    // an aborted or capped pipeline still finished and delivered its report,
    // so record and registry say `completed` — the abort/cap distinction
    // lives in ShipOutcome, the reply, and the card close below.
    const status: RunStatus =
      outcome === undefined
        ? "failed"
        : outcome.status === "stopped_soft" || outcome.status === "stopped_hard"
          ? outcome.status
          : "completed";
    registry.finish(run.id, status);
    const snap = registry.snapshot(run.id, run.token);
    const finishedAt = snap?.finishedAt ?? clock();
    const diagnosis = analyzeRunFriction(snap?.events ?? [], {
      finished: true,
      truncated: snap?.truncated ?? false,
      schema: SPAN_SCHEMA,
      window: { start: trace.receivedAt, end: finishedAt },
    });
    shipDiagnosis = diagnosis;
    io.runFinished?.({ id: run.id, status });
    ending.finished(run.id);
    shell.freeze(finishedAt);
    // Mirrors the main path: a completed pipeline whose final reply throws is
    // recorded `failed` — the thread never saw the report — while a stopped
    // status stays what it was. Written by the drain after the seal; a throw
    // reaches dispatch()'s outer catch, which drains. A tracked run finishes
    // through the ledger sink, which also closes its row.
    ending.register({
      runId: run.id,
      flipOnPostFinishFailure: true,
      write: (seal, failedAfterFinish) =>
        deps.runHistoryWriter.write(
          assembleRunRecord({
            run,
            snap,
            agent: agent.name,
            model: ctx.modelRef,
            msg,
            channelVisibility,
            repo: repoCtx.repo,
            finishedAt,
            status: failedAfterFinish && status === "completed" ? "failed" : status,
            diagnosis,
            seal,
          }),
          { span: root, ...(ledgerRun ? { via: ledgerRun.sink } : {}) },
        ),
    });
    // A pipeline that threw closes its card here, after the finish, so the
    // card's total is the run's.
    if (outcome === undefined)
      await root
        .span("post.card_close", () =>
          card.done(shell.close({ kind: "done", icon: "❌", detail: finalDetail(), ...doneLines(diagnosis) })),
        )
        .catch(() => {});
  }
  if (!outcome) return; // unreachable: the catch above rethrew
  console.log(`[done] ${msg.threadKey} ship ${outcome.reply.length} chars (${outcome.status})`);
  // The close tells the truth about HOW the pipeline ended: only a COMPLETED
  // pipeline checks its checklist off — an abort or cap closes ⚠️ over the
  // un-rewritten checklist (✓s over an abort would claim work that never
  // finished); stops keep their ⏹/⛔.
  const icon =
    outcome.status === "stopped_hard"
      ? "⛔"
      : outcome.status === "stopped_soft"
        ? "⏹"
        : outcome.status === "completed"
          ? "✅"
          : "⚠️";
  ledgerRun?.setState({
    finalStatus: outcome.status === "stopped_soft" || outcome.status === "stopped_hard" ? outcome.status : "completed",
  });
  if ((await root.span("post.ledger_finishing", () => ledgerRun?.finishing())) === "fenced") {
    console.log(`[ship] ${msg.threadKey} run ${run.id}: another generation owns this run — not replying`);
    ending.drop(run.id); // the record is the other generation's; the outer finally still seals the stream here
    return;
  }
  // The card close, the reply, then the drain: sealed with how the reply went,
  // the record written after the seal (fire-and-forget; the writer's
  // `pending()` counts it for the shutdown drain). A report that never reached
  // the thread flips the record to `failed`, never `completed` — the main
  // path's invariant — and the throw reaches the outer catch; the registry row
  // keeps its terminal status for the TTL, exactly like the main path.
  await ending.sealAfterReply(
    () =>
      root.span("post.card_close", () =>
        card.done(
          shell.close({
            kind: "done",
            icon,
            detail: outcome.status === "completed" ? checkedOffDetail() : finalDetail(),
            ...doneLines(shipDiagnosis),
          }),
        ),
      ),
    () => root.span("post.reply", () => io.reply(outcome.reply)),
  );
}
