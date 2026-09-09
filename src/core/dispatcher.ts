import type { ResidentFleetFacts } from "./residentFleet.js";
import { configAwarenessBlock } from "./configAwareness.js";
import { selfDescriptionBlock } from "./selfDescription.js";
import { customInstructionsBlock } from "./customInstructions.js";
import { AGENTS, getAgent, type AgentDef } from "../agents/registry.js";
import type { RequestDirectives, ThreadDirectives } from "../directives.js";
import { mergeTools, runAgent } from "../runner.js";
import { TOOLSETS } from "../tools/workspace.js";
import type { LedgerRun } from "./runLedger/writeThrough.js";
import { durableInboxMessage } from "./runLedger/inboxMessage.js";
import { systemClock } from "./trace/index.js";
import type { Span, SpanSink, Tracer } from "./trace/types.js";
import type { SpanLog } from "./trace/spanLog.js";
import type { RunOwner } from "./trace/streamSpans.js";
import { channelOf, startRequestRoot, type RequestTrace } from "./requestTrace.js";
import { cardShapeLineOf, queuedCaption } from "./runShape.js";
import { graftResidentSteps, residentTraceOf } from "../execution/residentTrace.js";
import type { ResidentStep } from "../execution/residentStepTrace.js";
import { SPAN_SCHEMA } from "./normalizeSpans.js";
import { makeWebCapability } from "../tools/web.js";
import { ResidentNeedsRefError } from "../execution/resident.js";
import { parseModelRef } from "../providers/types.js";
import { currentPrHeadSha, prCommitsSince, type RepoContext } from "./repoContext.js";
import type { PrCommitList } from "./headMoved.js";
import { postReviewComment, type ReviewCommentTarget } from "../execution/githubComments.js";
import {
  createBranchRef,
  fetchPullRequestFacts,
  fetchRepoShipInfo,
  findOpenPrByHead,
  openPullRequest,
  type OpenedPullRequest,
  type OpenPrRef,
  type PullRequestFacts,
  type PullRequestTarget,
  type RepoShipInfo,
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
import { PrDescriptionSchema, type PrDescription } from "./prDescription.js";
import { parseVerdictInput, type ReviewVerdict } from "./reviewVerdict.js";
import {
  attachRoundWorkspace,
  makeSystemComposer,
  runReviewPostStep,
  settleReviewedHead,
  type RoundWorkspace,
} from "./reviewRound.js";
import { observeCodingWorkspace, runCodingPrPostStep, trackPushedBranch } from "./codingPrPostStep.js";
import { descriptionTurnTarget, runDescriptionTurn } from "./descriptionTurn.js";
import { memoryContextBlock, scheduleReflection, type MemoryStore } from "./memory/index.js";
import { skillGuidanceBlock, type SkillStore } from "../skills/index.js";
import { mcpGuidanceBlock, type McpToolSource } from "../mcp/source.js";
import { isSpanRecord, redactSecrets, type RunEvent, type StopMode } from "./runEvents.js";
import { oneLine, redactAndCap, stripAnsi } from "./redact.js";
import { mergeFollowUps, type LiveThread } from "./threadAdmission.js";
import { resolveChatActor } from "./authz/actor.js";
import { MAX_EVENT_BYTES, utf8ByteLength, type RunStatus } from "./runRecord.js";
import { markdownOutput } from "./llmOutput/index.js";
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
import { analyzeRunFriction, type FrictionDiagnosis } from "./runFriction.js";
import { startReviewReadingDiff } from "./readingDiff.js";
import type { IssueTracker } from "../execution/githubIssues.js";
import { RestGithubApi, type GithubApi } from "../execution/githubApi.js";
import type { GithubCapability } from "../tools/github.js";
import { defaultRunRegistry, type RunHandle, REPLAY_EVERYTHING } from "./runRegistry.js";
import { inFlightToolAfter, quietSuffix } from "./statusCardLabel.js";
import { createCardShell, type CardShell } from "./statusCardFrame.js";
import { createRunEnding, type RunEnding } from "./runEnding.js";
import { coalesceStatus } from "./statusCoalescer.js";
import type { ChannelIO, HistoryItem, IncomingMessage, StatusHandle } from "./types.js";

// The dispatcher is the channel-agnostic core: config commands, directive
// parsing, layered resolution, permission gates, history assembly, executor
// selection, and the agent run. Channels are pure transports (src/channels/).

export interface CoreDeps extends AdmissionDeps, FastPathDeps, ResolveDeps, AuthorizeDeps, RecordDeps {
  /** What the resident Worker last said about the fleet (its cap), read in the
   *  background so the About block names the Worker's number, never a constant
   *  (routing-and-config item 11). `NO_FLEET` without residents. */
  residentFleet: ResidentFleetFacts;
  /** The tracer behind every root this process starts; the no-gaps test injects one with its `SpanContext`. */
  tracer?: Tracer;
  /** The root's leading sinks (a test's recording sink); default: the one log sink at `tracing.log`. */
  sinks?: SpanSink[];
  /** The in-process span log every root also feeds (docs/reference/specs/tracing.md item 26); `GET /admin/trace/log` reads it. */
  spanLog?: SpanLog;
  /** where runtime state (sandboxes.json) lives; default ./data */
  dataDir?: string;
  /**
   * Posts a review comment back to a PR. Called after a `review`
   * run against a resolved PR, unless the request opted out. Default: the real
   * GitHub REST post with the App installation token (App `pull_requests:write`;
   * no `gh` shell-out — AGENTS.md invariant 5). Injectable so tests assert the
   * decision without a network call.
   */
  postReviewComment?: (target: ReviewCommentTarget, body: string) => Promise<void>;
  /**
   * Opens the PR for a coding run's pushed branch — or edits the one already
   * open for it (open-or-edit idempotency) — after the run submitted its typed
   * `PrDescription` (docs/reference/specs/pr-description.md item 5). Default: the real
   * GitHub REST call with the App installation token
   * (src/execution/githubPulls.ts; no `gh` shell-out — AGENTS.md invariant 5).
   * Injectable so tests assert the typed inputs without a network call.
   */
  openPullRequest?: (target: PullRequestTarget) => Promise<OpenedPullRequest>;
  /**
   * The open PR heading a branch, or null (githubPulls.findOpenPrByHead): the
   * post-step asks it when a proven-pushed branch comes with no description,
   * so a follow-up that repushed an existing PR's branch is reported as that
   * PR updated, never as "open one manually". Injectable for the same reason.
   */
  findOpenPrByHead?: (repo: string, branch: string) => Promise<OpenPrRef | null>;
  /**
   * Ship round 0's pipeline-branch create (docs/reference/specs/agent-ship.md item 3):
   * `refs/heads/<branch>` at the base ref's tip, so the ref exists on
   * origin BEFORE the resident is asked to bind the thread to it. Default:
   * githubPulls' `createBranchRef` (App token REST, 422 already-exists is
   * success). Injectable so tests assert the call without a network call.
   */
  createBranchRef?: (repo: string, branch: string, fromRef: string) => Promise<void>;
  /**
   * Repo facts for the agent:ship gate (docs/reference/specs/agent-ship.md item 9): the
   * `allow_auto_merge` flag — ship refuses when it is enabled OR unknown
   * (fail-closed: an LGTM into auto-merge would merge with no human) — and
   * the repo's default branch, the PR base of last resort. Default: one REST
   * GET via githubPulls' `fetchRepoShipInfo` (App token, never `gh`).
   * Injectable so tests assert the refusal without a network call.
   */
  fetchRepoShipInfo?: (repo: string) => Promise<RepoShipInfo | undefined>;
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
   * The commits a PR head carries over its base (agent-review.md item 12):
   * asked once for the reviewed head and once for the current one when the
   * head moved during a review run, to tell a rebase of the same commits from
   * a real change. Default: one REST GET per side via repoContext's
   * `prCommitsSince`; undefined (or a throw) → the move is unclassified and
   * the post-step falls back to item 10 (pinned post + note).
   */
  fetchPrCommits?: (q: { repo: string; base: string; sha: string }) => Promise<PrCommitList | undefined>;
  /**
   * Cross-session memory store (docs/decisions/0017-memory-off-by-default.md). When `config.memory.enabled`
   * is true the dispatcher retrieves scope-relevant records from this store
   * and injects them as an advisory context block before the model turn, and
   * after the reply a background reflection pass writes distilled records back
   * to it. With memory off (the default) production wires a `NullMemoryStore`
   * (src/index.ts, src/cli.ts) — and the memory module selects one whatever
   * is wired — so model input is byte-identical to memory-off and nothing is
   * written. Injectable for tests.
   */
  memory: MemoryStore;
  /**
   * Skill store backing the load-a-skill capability. When present, the
   * dispatcher appends the calling agent's scoped skill name+description list to
   * its system prompt (progressive disclosure) and passes the store to the tool
   * context so list_skills/use_skill work. Absent (as in most unit tests) →
   * no skill block and the skill tools report themselves unavailable, leaving
   * the request unchanged. Production wires a BundledSkillStore (src/index.ts,
   * src/cli.ts); the DO-backed upload store is PR2, behind this same interface.
   */
  skills?: SkillStore;
  /**
   * External MCP servers as tools (docs/reference/specs/mcp-tools.md). Asked once
   * per run, before the first model turn, for the servers scoped to the
   * resolved agent; the bridged tools ride `RunOptions.extraTools` and the
   * outcome becomes the MCP prompt block + one `mcp_unavailable` note per
   * server that did not answer. No server scoped to the agent — the
   * `NullMcpToolSource` of a process without MCP included — → the request is
   * byte-identical to before the feature. Whether the self-serve surface
   * (`mcp add …`) exists is `capabilities.mcp`, which the config awareness
   * block tells the model (docs/reference/specs/mcp-tools.md item 17).
   */
  mcp: McpToolSource;
  /**
   * The GitHub API behind the `github_*` tools (docs/reference/specs/github-tools.md).
   * Absent → the production REST client on the App credential; tests inject an
   * `InMemoryGithubApi`. The per-run capability adds the requesting user's
   * `canUseRepo` write gate (`githubCapabilityFor`).
   */
  githubApi?: GithubApi;
  /**
   * Where `friction propose` files its proposals. Default: the GitHub REST
   * tracker with the App installation token (App `issues:write`; never a `gh`
   * shell-out — AGENTS.md invariant 5). Injectable so tests assert filing
   * without a network call.
   */
  issueTracker?: IssueTracker;
  /** Floor between two status-card edits (default `STATUS_UPDATE_MIN_MS`).
   *  Tests that assert on an individual intermediate frame set 0. */
  statusUpdateMinMs?: number;
}

/** Floor between two edits of a run's status card (see `coalesceStatus`). Below
 *  the 5 s heartbeat so a heartbeat frame is never held back by it. */
const STATUS_UPDATE_MIN_MS = 3000;

/** The web capability (undici Agent with the SSRF-checking connector + the
 *  search adapter) is built ONCE per process, not per run: the Agent owns the
 *  connection pool, so sharing it lets every run reuse warm TLS sockets to the
 *  same hosts instead of paying a fresh DNS+TCP+TLS handshake per fetch — and a
 *  per-run Agent was never closed, so its keep-alive sockets accumulated. */
let sharedWeb: ReturnType<typeof makeWebCapability> | undefined;
const webCapability = () => (sharedWeb ??= makeWebCapability(process.env));

/** The `github_*` tools' capability for one run (docs/reference/specs/github-tools.md):
 *  the process-wide REST client on the App credential (or the injected test
 *  double) plus the REQUESTING USER's per-repo write gate — `canUseRepo`, the
 *  same allowlist that admits a user to a repo's resident — so an issue
 *  write from a plain mention is authorized like a coding run on that repo. */
let sharedGithubApi: GithubApi | undefined;
function githubCapabilityFor(deps: CoreDeps, userId: string): GithubCapability {
  const api = deps.githubApi ?? (sharedGithubApi ??= new RestGithubApi());
  return { api, canWrite: (repo) => deps.config.canUseRepo(userId, repo) };
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

    // Cross-session memory — READ path, STARTED here and awaited
    // below, so the memory Worker round trip (up to 5 s) overlaps the repo/PR
    // resolution and the executor attach instead of adding to them. Its scopes
    // are the org, this channel, this user, and — once resolution settles —
    // the bound repo; the read never depends on the repo GATE, only on
    // the repo NAME, and a failed resolution simply means no repo scope.
    // Started after the agent gate, never before: a refused request must not
    // touch memory (retrieval bumps usage counters). Flag-gated: with memory
    // disabled (default) this resolves to undefined via a NullMemoryStore,
    // leaving `messages` and `system` byte-identical to memory-off. The no-op
    // catch keeps an early return (repo refusal, ask-once) from leaving the
    // rejection unhandled; the real await below still surfaces a failure where
    // it did.
    const memoryBlockP = root.span("dispatch.memory_read", (span) =>
      memoryContextBlock(
        deps.config.config.organization,
        deps.config.config.memory,
        deps.memory,
        directives.text,
        msg.userId,
        { channelId: msg.channelId, repo: repoCtxP.then((ctx) => ctx.repo) },
        span,
      ),
    );
    memoryBlockP.catch(() => {});

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
    // One builder for every paint of this card (statusCardFrame.ts): the ack,
    // the spinner frames, the closes before the run starts, the done frame.
    const shell = createCardShell({
      label: `*${agent.name}* on \`${resolved.modelRef}\``,
      startedAt,
      now: clock,
    });
    // Coalesced: the run below refreshes it on every event, the channel sees at
    // most one edit per STATUS_UPDATE_MIN_MS, always the newest frame.
    const card = coalesceStatus(
      await root.span("dispatch.ack_card", () => io.status(shell.ack())),
      deps.statusUpdateMinMs ?? STATUS_UPDATE_MIN_MS,
    );
    setupCard = card;
    setupShell = shell;
    // From here the card names the setup step in flight (the card sink's
    // display label — `attaching the workspace…`) until the agent loop starts;
    // the setup heartbeat paints it.
    trace.bindCard({ setupLabel: (label) => shell.setSetupLabel(label) });
    setupHeartbeat = setInterval(() => card.update(shell.live()), 5000);

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

    // The reservation (item 42): the run's row BEFORE the workspace attach —
    // identity, request, card, no prompt — so a kill during a slow attach (a
    // resident's mutex wait, a cold clone) leaves a row the next generation
    // restarts instead of a run that vanished. Its heartbeat holds the lease
    // through the attach; the claim after the prompt exists promotes it. A
    // resume adopted its row above; a restart reserved it above.
    // The run's id, minted here (item 42) — after the ship fork, which mints
    // its own — so the registry row, the row reserved before the attach and
    // the record all share it; a resume or a restart keeps the row's.
    const runId = carriedRow?.runId ?? registry.mintId();
    // Asked once per run (the authorization spec's channel-visibility rule):
    // the registry row, the reservation and the claim reuse it.
    const channelVisibility = await root.span("dispatch.channel_visibility", () =>
      channelVisibilityOf(deps, msg.channelId),
    );
    // The registry row, created NOW — before the reservation and the attach —
    // so the run is one row on every surface from the moment it is admitted:
    // the runs index lists it with its label and its capability link, the run
    // page serves it, a stop during the attach latches in its control. Before
    // this the row came after the attach, and the runs index showed the
    // reservation meanwhile as a labelless ledger row with a tokenless link.
    // Its stream stays empty until the run loop binds the trace below (the
    // request is the first event of the record, live-view item 12).
    // A human-first label for the Access-gated runs index (`GET /runs`): agent +
    // repo (repo runs) or channel/user (chat runs) + a snippet of the request,
    // so a row reads like `review · #general · alice · "…"` rather
    // than raw ids. Built from the directive-stripped text so directives (agent:/
    // model:) never clutter the snippet. The registry redacts and caps it;
    // `run.label` is the one the record and the friction row carry (never
    // `runLabel`, which may hold a pasted secret).
    const runLabel = composeRunLabel({
      agent: agent.name,
      repo: repoCtx.repo,
      channelId: msg.channelId,
      userId: msg.userId,
      channelName: msg.channelName,
      userName: msg.userName,
      text: directives.text,
    });
    const run = registry.create(
      runLabel,
      {
        agent: agent.name,
        model: resolved.modelRef,
        channelId: msg.channelId,
        userId: msg.userId,
        threadKey: msg.threadKey,
        channelVisibility,
        ...(carriedRow ? {} : { receivedAt }), // the window opens at receipt (docs/reference/specs/tracing.md); a resume or restart keeps its original stamps
        ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
        ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
        ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
      },
      // Under the run's id, at the card's start (the reservation's, or the
      // carried row's) — a resume replays its events, a restart starts them
      // afresh at the row's original start.
      { id: runId, startedAt, ...(resume ? { replay: resume.events } : {}) },
    );
    registered = run;
    // With no PUBLIC_BASE_URL the link is simply omitted — the feature
    // degrades gracefully, the run is otherwise unchanged. The card carries it
    // from here, and a follow-up's ack/refusal can link the run page
    // (thread-admission item 1).
    const liveUrl = liveViewLink(run.id, run.token);
    shell.setLink(liveUrl ? { url: liveUrl, label: "Live run" } : undefined);
    if (liveUrl) admitted.runLink = liveUrl;
    io.runStarted?.({ id: run.id });
    // The run's stream is live from here (docs/reference/specs/tracing.md item 6): the
    // spans so far — the root, the ack card, the repo resolution — are
    // backfilled, and the attach and the resident's grafted steps stream as
    // they happen, so the run page and the index's event count move through a
    // long attach. Every streamed setup span is head material
    // (`isHeadMaterial`: `request`, `slack.receive`, `dispatch.*`), so the
    // protected head still runs unbroken from the first event through the
    // request published next.
    trace.bindRun(run.id, (e) => registry.publish(run.id, e));
    // The narrative events the dispatcher itself publishes — the request, the
    // thread context, the final answer — go straight to the registry: redacted
    // like every event, uncapped (the run record is the source of truth; the
    // registry's byte-bounded backlog and the record's per-event budget bound
    // persistence), never through onEvent (no card refresh, no friction input),
    // and logged as ONE line of type + byte-length — never the text, which may
    // span lines or carry what redaction missed.
    const publishText = (
      type: "input" | "context" | "answer",
      text: string,
      source?: { url?: string; channel?: string; user?: string },
      raw?: string,
    ) => {
      const redacted = redactSecrets(text);
      const event = { type, text: redacted, ...(source ? { source } : {}), at: clock() };
      // The model's raw answer rides on the event only when normalization
      // changed it AND the event still fits the per-event byte budget — the
      // budget already truncates `text` and must not be starved by a second
      // copy (docs/reference/specs/llm-output.md item 5).
      const withRaw = raw !== undefined ? { ...event, raw: redactSecrets(raw) } : event;
      registry.publish(run.id, utf8ByteLength(JSON.stringify(withRaw)) <= MAX_EVENT_BYTES ? withRaw : event);
      console.log(`[event] ${msg.threadKey} type=${type} bytes=${utf8ByteLength(redacted)}`);
    };
    // The request is the first content event of the run record (live-view item
    // 12), published NOW — before the attach — so the run page shows what the
    // run is about while the workspace is still being attached: the
    // directive-stripped text, humanized (Slack `<url|label>`/mention markup
    // unwrapped, entities unescaped — it is channel-authored mrkdwn, not prose)
    // + an attachment count. Every other channel's text is recorded exactly as
    // it was dispatched to the model, so the record never diverges from the input.
    const humanize = isMrkdwnChannel(msg.channelId);
    const attachments = attachmentSuffix(msg.images, msg.documents);
    const source = {
      ...(msg.sourceUrl ? { url: msg.sourceUrl } : {}),
      ...(msg.channelName ? { channel: msg.channelName } : {}),
      ...(msg.userName ? { user: msg.userName } : {}),
    };
    const requestText = humanize ? humanizeMessageText(directives.text) : directives.text;
    if (!resume)
      publishText(
        "input",
        attachments ? `${requestText} ${attachments}` : requestText,
        Object.keys(source).length > 0 ? source : undefined,
      );
    // What the run is about (live-view item 19): agent, model, and the repo
    // context as resolved NOW — so the page can head the record with linked
    // owner/repo · ref · #PR · sha. Straight after the request; published once
    // more if the attach adopts a moved PR head below (readers take the latest).
    const publishRunMeta = () =>
      registry.publish(run.id, {
        type: "run_meta",
        agent: agent.name,
        model: resolved.modelRef,
        traceId: root.traceId,
        ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
        ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
        ...(repoCtx.ref !== undefined ? { ref: repoCtx.ref } : {}),
        ...(repoCtx.pr !== undefined ? { pr: repoCtx.pr } : {}),
        ...(repoCtx.headSha !== undefined ? { headSha: repoCtx.headSha } : {}),
        at: clock(),
      });
    if (!resume) publishRunMeta();
    // The thread context fed to the model follows the request as `context`
    // events — text only, attachments as metadata lines, bounded to
    // the newest CONTEXT_MAX_ITEMS turns within CONTEXT_MAX_BYTES.
    if (!resume && deps.config.config.runHistory?.includeContext !== false) {
      for (const text of contextMessageTexts(history, humanize)) publishText("context", text);
    }
    if (!resume && !restart) {
      requestRow = durableInboxMessage(msg, msg.text, receivedAt);
      const request = requestRow;
      reserved = await root.span("dispatch.ledger_reserve", () =>
        deps.runLedger.reserve({
          runId,
          threadKey: msg.threadKey,
          startedAt,
          meta: {
            agent: agent.name,
            model: resolved.modelRef,
            channelId: msg.channelId,
            userId: msg.userId,
            threadKey: msg.threadKey,
            channelVisibility,
            ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
            ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
            ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
            ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
            ...(repoCtx.ref !== undefined ? { ref: repoCtx.ref } : {}),
            ...(repoCtx.headSha !== undefined ? { headSha: repoCtx.headSha } : {}),
            ...(repoCtx.pr !== undefined ? { pr: repoCtx.pr } : {}),
            readonly: agent.toolset === "readonly",
            request,
          },
          card: card.handle ?? null,
          ...reservationHooks,
        }),
      );
      // Named on the slot from here (the row exists now): a steer's durable
      // copy lands under it, and the boot-gap hand-off finds it. Deliberately
      // AFTER the reserve resolves, not before: a steer that lands during the
      // round trip rides in memory alone (thread-admission item 5 scopes the
      // durable window "from the reserve on"), where naming the run earlier
      // would push to a row that may not exist yet and warn for nothing.
      admitted.runId = runId;
    }

    // The workspace attach is paired with its release on the round's agent
    // (reviewRound.ts): readonly toolset → readonly worktree +
    // release("always"); writable → release("if-clean").
    let round: RoundWorkspace;
    try {
      // The attach is one `dispatch.workspace.attach` span naming its backend
      // (docs/reference/specs/tracing.md): the setup step that takes minutes on a cold clone.
      round = await root.span("dispatch.workspace.attach", async (span) => {
        // The resident's own steps (clone, install, the mutex wait…) graft under
        // this span, rebased to its start (docs/reference/specs/tracing.md item 19) — on a
        // failed attach too, where the trace says which step blew the budget.
        const graft = (steps: readonly ResidentStep[], residentTotalMs?: number) =>
          graftResidentSteps(steps, {
            parent: span,
            prefix: "dispatch.workspace.attach",
            baseAt: span.record().startedAt,
            clipAt: clock(),
            ...(residentTotalMs !== undefined ? { residentTotalMs } : {}),
          });
        let attached: Awaited<ReturnType<typeof attachRoundWorkspace>>;
        try {
          attached = await attachRoundWorkspace({
            factory: {
              execution: deps.config.config.execution,
              workspaceDir: deps.config.config.workspaceDir ?? "./workspaces",
              dataDir: deps.dataDir ?? "./data",
            },
            round: { threadKey: msg.threadKey, agent, repo: repoCtx.repo, ref: repoCtx.ref, headSha: repoCtx.headSha },
            logKey: msg.threadKey,
            span,
          });
        } catch (err) {
          const failed = residentTraceOf(err);
          if (failed) graft(failed.steps, failed.residentMs);
          throw err;
        }
        if (attached.selection.backend) span.setAttrs({ backend: attached.selection.backend });
        if (attached.selection.trace) graft(attached.selection.trace, attached.selection.attachMs);
        return attached;
      });
    } catch (err) {
      // Ask-once: the resident has no ref binding for this thread, the
      // message named no branch, AND the resident did not name a default to
      // bind to (the factory binds to `defaultRef` itself when the 409 carries
      // one — only a Worker predating that field reaches here). Binding is
      // explicit-or-ask-once, never a silent guess. ONE clarifying question,
      // no model turn burned (mirrors the named-refusal reply shape). The
      // user's answer in the thread (e.g. "on main") carries the ref on the
      // next message and re-attach binds it.
      if (err instanceof ResidentNeedsRefError) {
        const repo = repoCtx.repo;
        await refuse("which_branch", async () => {
          await card.done(
            shell.close({ kind: "not_started", icon: "🌿", reason: "which branch?", ...closeLines(clock(), false) }),
          );
          await io.reply(
            `🌿 Which branch of \`${repo}\` should this thread work on? ` +
              `No branch is bound yet — reply naming one (e.g. "on main" or "on branch fix/login") and I'll pick it up from there.`,
          );
        });
        return;
      }
      throw err;
    }
    const { executor, note, resident, binding } = round.selection;
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
    if (headGate.headAdopted) publishRunMeta();

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
    // Progressive disclosure: the calling agent's scoped skill
    // name+description list trails the agent's own instructions (it is
    // guidance about the agent's tools, not advisory context like the memory
    // block). Bodies load on demand via use_skill — never dumped here. No
    // store, or an agent with no scoped skills (general/research) → undefined
    // and the prompt is untouched.
    const skillsBlock = deps.skills ? skillGuidanceBlock(deps.skills, agent.name) : undefined;
    // External MCP tools (docs/reference/specs/mcp-tools.md item 8): discovery for
    // the servers scoped to THIS agent, once, before the model turn. A server
    // that does not answer contributes no tools and is named in the MCP block
    // (and, once the run is registered, in an `mcp_unavailable` note). Nothing
    // scoped — a process without MCP has the null source — → no tools, no
    // block, request unchanged.
    const mcpForRun = await root.span("dispatch.mcp_discovery", () =>
      deps.mcp.toolsFor(agent.name, { userId: msg.userId, channelId: msg.channelId }),
    );
    const mcpBlock = mcpGuidanceBlock(mcpForRun.servers);

    // Config awareness (routing-and-config behavior 8): tell the model the
    // RESOLVED agent/model/scope of this very run and how users tune it, so no
    // agent can confabulate "I'm stateless / nothing is tunable". Built from
    // the same `resolved`/`directives`/`sticky` values that selected the run,
    // so it can never describe a different state than the one executing.
    // Universal (every agent, every turn), a few lines, names only.
    const scopes = deps.config.scopes(msg.channelId, msg.userId);
    const configBlock = configAwarenessBlock({
      agentName: agent.name,
      modelRef: resolved.modelRef,
      effort: resolved.effort,
      channel: scopes.channel,
      user: scopes.user,
      messageDirective: { agent: directives.agent, model: directives.model, effort: directives.effort },
      threadDirective: { agent: sticky.agent, model: sticky.model, effort: sticky.effort },
      canEditChannelConfig: deps.config.canEditChannelConfig(msg.userId),
      mcp: {
        registryOn: deps.capabilities.mcp,
        served: mcpForRun.servers.filter((s) => s.toolCount !== undefined).map((s) => s.server),
        unavailable: mcpForRun.servers.filter((s) => s.unavailable !== undefined).map((s) => s.server),
      },
    });

    // Self-description (routing-and-config behavior 11): what Switchboard is —
    // agents, residents, runs, where the source and specs live — built from
    // the live agent registry, on every agent's prompt, so "how does your
    // resident system work?" is answered from fact instead of a public-web
    // 404 on our private repo.
    const aboutBlock = selfDescriptionBlock(
      AGENTS,
      deps.config.config.organization,
      deps.capabilities,
      deps.residentFleet.cap(),
    );

    // Custom instructions: the requester's user text + this
    // channel's text, as ONE advisory block. Read from the same resolved
    // scopes as the config block, AFTER resolution and every gate above — so
    // by construction they cannot influence agent, model, or permissions.
    // Absent (the default) → no block, prompt unchanged.
    const instructionsBlock = customInstructionsBlock(scopes);

    // Effective system prompt, composed AFTER executor resolution (via
    // RunOptions.system) by the extracted composer (reviewRound.ts): a
    // resident-path run swaps in the agent's resident variant with the
    // resolved repo named and the worktree path when the attach answered it;
    // a PR review gets the REVIEW TARGET block (item 9) recomposed
    // per pinned head. Order: memory (advisory context, leads when present) →
    // config block → custom instructions → the agent's effective instructions
    // (+ skills). The memory block is absent with memory off (default),
    // keeping the memory-off request byte-identical to a NullMemoryStore run.
    // Retrieval was started before the repo resolution and executor selection
    // above; by now it has usually landed. The shared AgentDef is never
    // mutated (concurrent dispatches share it).
    // The prompt waits on the memory read here: `dispatch.compose` is that wait
    // (the composition itself is synchronous).
    const memoryBlock = await root.span("dispatch.compose", () => memoryBlockP);
    const composeSystem = makeSystemComposer({
      agent,
      resident: resident === true,
      repo: repoCtx.repo,
      workspace: binding?.workspace,
      prTarget:
        isPrReview && repoCtx.repo && repoCtx.pr !== undefined
          ? { repo: repoCtx.repo, pr: repoCtx.pr, ref: repoCtx.ref, baseRef: repoCtx.baseRef }
          : undefined,
      blocks: {
        memory: memoryBlock,
        config: configBlock,
        about: aboutBlock,
        instructions: instructionsBlock,
        skills: skillsBlock,
        mcp: mcpBlock,
      },
    });
    // The PR head this run reviews — the resolved head, or the one adopted at
    // attach; the head settle (item 12) advances it after the model turn. The
    // post-step pins to it and the reviewed-head guard checks against it.
    let reviewHead = repoCtx.headSha;
    // The first turn's system, pinned to that head; a re-review recomposes its
    // own inside settleReviewedHead.
    // A resume re-sends the prompt the run started with, verbatim (plan D3):
    // memory retrieval and MCP discovery are not reproducible, and the model's
    // cached prefix and thinking blocks are bound to it.
    const system = resume ? resume.row.system : composeSystem({ sha: reviewHead, verified: verifiedAtAttach });

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
    let lastActivityAt = clock();
    // The run loop owns the run from here: its finally finishes it (the outer
    // finally discards a run that never got this far). Events are fed to the
    // registry in onEvent below; the stream has been live since the reservation.
    runLoopStarted = true;
    if (resume) {
      console.log(
        `[resume] ${msg.threadKey} run ${run.id} continues under ${deps.runLedger.gen}: from step ${resume.plan.step}, ${resume.plan.settlements.length} call(s) to settle, ${resume.events.length} event(s) replayed`,
      );
    }
    // Tombstone-first: a provisional TERMINAL record — status
    // `interrupted`, `finishedAt` = `startedAt` — goes to the store now, built
    // from the events published so far (the setup spans, request, run_meta,
    // context). Written here, once the run loop owns the run, and not at the
    // reservation: a dispatch that ends before this point leaves NO record
    // (item 42 — its row is discarded and its reservation abandoned), and a
    // crash during the attach is the reservation's to restart, not a record's
    // to remember. Because it is already terminal, a crash or a
    // drain-abandonment needs NO store-side
    // fixup by the next container: the tombstone is already the truth (its
    // `finishedAt` stays the start time — nobody knows the real death time of a
    // crash). The finish write below replaces it (same-id upsert) for every run
    // that ends normally, and the drain deadline upgrades it with the full
    // transcript for a run it abandons. Fire-and-forget through the same writer
    // (retry + drain accounting), but `provisional`: `onPersisted`/
    // `markPersisted` must NOT run — the index's persisted flag means "finished
    // and durably stored". Synchronous assembly over a handful of bounded
    // events; the first model call is not delayed.
    if (!resume) {
      const startSnap = registry.snapshot(run.id, run.token);
      if (startSnap) {
        deps.runHistoryWriter.write(
          assembleRunRecord({
            run,
            snap: startSnap,
            agent: agent.name,
            model: resolved.modelRef,
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
    }
    // The ledger claim (docs/reference/specs/run-history.md item 35): the run's row on the
    // state Worker, with everything a resume must hand the model again — the
    // composed system prompt and the tool definitions verbatim, the card, the
    // repo context — plus the conversation as its seed. Claimed HERE, once the
    // prompt exists, not at the in-process admission above: a row without a
    // prompt could not be resumed. Awaited (one round trip per run) so the
    // first step's record never precedes its claim. An untracked run (a stale
    // row on the thread, no routes, a claim that kept failing) runs exactly as
    // before — the write-through warned once.
    // Only a reserved run is claimed (item 42): a reservation the ledger refused
    // — another run's row on the thread, no routes, a claim that kept failing —
    // already made this run untracked, with the one warning; asking again
    // would only warn again.
    if (!resume && reserved) {
      const ledger = deps.runLedger;
      const opened = await root.span("dispatch.ledger_claim", () =>
        ledger.open({
          runId: run.id,
          threadKey: msg.threadKey,
          startedAt: registry.snapshot(run.id, run.token)?.startedAt ?? clock(),
          meta: {
            agent: agent.name,
            model: resolved.modelRef,
            channelId: msg.channelId,
            userId: msg.userId,
            threadKey: msg.threadKey,
            channelVisibility,
            ...(repoCtx.repo !== undefined ? { repo: repoCtx.repo } : {}),
            ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
            ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
            ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
            ...(repoCtx.ref !== undefined ? { ref: repoCtx.ref } : {}),
            ...(repoCtx.headSha !== undefined ? { headSha: repoCtx.headSha } : {}),
            ...(repoCtx.pr !== undefined ? { pr: repoCtx.pr } : {}),
            readonly: agent.toolset === "readonly",
            selection: resident === true ? "resident" : "sandbox",
            ...(binding?.workspace !== undefined ? { workspace: binding.workspace } : {}),
            ...(requestRow !== undefined ? { request: requestRow } : {}),
          },
          card: card.handle ?? null,
          // The row reserved before the attach (item 42), promoted in place;
          // its hooks (a stop, a fence) were wired at the reservation and stay.
          ...(reserved ? { reservation: reserved } : {}),
          system,
          tools: mergeTools(TOOLSETS[agent.toolset] ?? [], mcpForRun?.tools).map(
            ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
          ),
          seed: { messages, budgetMs: agent.maxMinutes * 60_000 },
          // A stop asked of another container (`/runs/stop` there) reaches this
          // run through its heartbeat and is honored like a local one; a fence
          // (another generation took the run) is a hard stop — nothing more may
          // run or reply here (D9).
          onStop: (mode) => void run.control.requestStop(mode),
          onFenced: () => void run.control.requestStop("hard"),
        }),
      );
      if (opened) {
        ledgerRun = opened;
        // Every event published so far (the request, run_meta, context) and
        // every one to come, in `seq` order, through the batched flusher. The
        // ledger is a store: the viewer replay budget never applies to it.
        registry.subscribe(run.id, run.token, {
          onEvent: (event, seq) => opened.event(event, seq),
          ...REPLAY_EVERYTHING,
        });
      }
    }
    if (resume && ledgerRun) {
      // The events before the restart are on the ledger already (and in the
      // registry by replay); only what this generation publishes is appended.
      const adopted = ledgerRun;
      registry.subscribe(run.id, run.token, {
        onEvent: (event, seq) => adopted.event(event, seq),
        afterSeq: resume.lastSeq,
        ...REPLAY_EVERYTHING,
      });
    }
    // The card body is the agent's own checklist (via the update_status tool)
    // plus a live one-line activity trace (current tool call + redacted result
    // summary) so the card reflects progress per tool event, not only on the
    // 5s heartbeat. Full command output still goes to stdout for operators.
    // On a resume the dispatcher-local state comes back from the row (item 38):
    // the checklist the card shows, the verdict/description already submitted,
    // the branch already pushed.
    const restored = resume?.row.state ?? {};
    let checklist: string | undefined = typeof restored.checklist === "string" ? restored.checklist : undefined;
    let lastActivity: string | undefined;
    // The tool whose call has no result yet — the title says the wait is the
    // tool's (`running bash (Ns)`), not the model's (`thinking …`).
    let inFlightTool: string | undefined;
    // The shutdown notice rides on the LIVE frame only: the closed card is
    // built from `shell.close` and never mentions the restart.
    const currentFrame = () =>
      shell.live({
        suffix: quietSuffix(clock() - lastActivityAt, inFlightTool),
        notice: shutdownNotice,
        detail: [checklist, lastActivity],
      });
    // The closed card keeps the run link (the run page outlives the run and
    // shows the final answer) and the agent's checklist; only the transient
    // activity trace is dropped. On a clean ✅ finish every item is marked ✓ —
    // the run completing IS the proof they happened, and the model rarely
    // re-posts the checklist after its last step; a stop/failure keeps the
    // honest partial state.
    const finalDetail = () => checklist;
    const checkedOffDetail = () => checklist?.replace(/^(\s*)[○✱](?=\s)/gm, "$1✓");
    // The runner's progress notes carry the 💭 thought line at each model turn
    // (docs/reference/specs/tracing.md): the card shows it as activity, as it showed the
    // `turn` event before spans replaced it.
    const onProgress = (note: string) => {
      console.log(`[note] ${msg.threadKey} ${note}`);
      lastActivityAt = clock();
      lastActivity = note;
      card.update(currentFrame());
    };
    // Live run-visibility (Area 2): each tool call/result refreshes the card
    // immediately, so activity is visible without waiting for the heartbeat.
    let toolCalls = 0; // "did real work" signal for the memory reflection gate
    // The branch the run's own `git push` named, read off its bash calls and
    // results as they stream by (docs/reference/specs/pr-description.md item 5):
    // the PR post-step opens from THIS branch, and from the checkout only
    // when no push was observed — the checkout can move between the push and
    // the post. The latest push wins.
    const pushes = trackPushedBranch(typeof restored.pushedBranch === "string" ? restored.pushedBranch : undefined);
    // The registry backlog is the run's ONE event store: the live
    // page, the post-run friction diagnosis and the run record all read it back
    // via `registry.snapshot` — there is no second copy to drift from it.
    let recordedPushedBranch: string | undefined;
    const onEvent = (e: RunEvent) => {
      registry.publish(run.id, e); // feed the external live-view stream
      if (isSpanRecord(e)) return; // timing, not activity (docs/reference/specs/tracing.md): the card and its clock ignore it
      if (e.type === "tool_call") toolCalls++;
      if (isCodingPrRun) {
        pushes.observe(e);
        const pushedBranch = pushes.branch();
        if (pushedBranch !== undefined && pushedBranch !== recordedPushedBranch) {
          recordedPushedBranch = pushedBranch;
          ledgerRun?.setState({ pushedBranch });
        }
      }
      inFlightTool = inFlightToolAfter(inFlightTool, e);
      lastActivityAt = clock();
      lastActivity = activityLine(e);
      console.log(`[tool] ${msg.threadKey} ${lastActivity}`);
      card.update(currentFrame());
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

    // Reading-diff artifacts (docs/reference/specs/reading-diff.md): a PR review run gets
    // the change as a reviewer reads it, produced CONCURRENTLY with the review
    // by the run's own executor (read-only commands; the resident runs execs
    // beside the model's) and published straight to the registry like the
    // other dispatcher facts. The git BASELINE is guaranteed: the dispatcher
    // joins it before the answer publish below (a join on a seconds-long
    // command started here — never a timeout race). meat, when configured, is
    // an UPGRADE artifact under its own runtime budget, never awaited: it
    // lands iff it finishes within the review (a later publish is dropped by
    // the registry's finished-run rule, and the baseline still stands).
    let readingDiffBaseline: Promise<boolean> | undefined;
    if (agent.name === "review" && repoCtx.pr !== undefined) {
      // Two background spans (docs/reference/specs/tracing.md): concurrent with the loop,
      // structure for the partition, never a counted term — started under the
      // root inside `startReviewReadingDiff`, so each diff's exec is a child.
      const started = startReviewReadingDiff({
        executor,
        cfg: deps.config.config.review?.readingDiff,
        env: process.env,
        baseRef: repoCtx.baseRef,
        publish: (e) => registry.publish(run.id, e),
        parent: root,
      });
      readingDiffBaseline = started.baseline.then((published) => {
        console.log(`[reading-diff] ${msg.threadKey} baseline ${published ? "published" : "none"}`);
        return published;
      });
      const upgrade = started.upgrade;
      if (upgrade)
        void upgrade.then((published) => {
          console.log(`[reading-diff] ${msg.threadKey} meat ${published ? "published" : "did not land"}`);
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
        ? (parseVerdictInput(restored.verdict as Record<string, unknown>) ?? undefined)
        : undefined;
    const onVerdict = (v: ReviewVerdict) => {
      verdict = v;
      ledgerRun?.setState({ verdict: v });
    };
    // Coding PR description, set only through the structured
    // submit_pr_description tool (the last valid call wins — a resubmit after
    // a fix-up push supersedes the earlier one); the post-step below renders
    // the GitHub body from it at the observed pushed head and opens/edits the
    // PR. See prDescription.ts.
    const restoredDescription = PrDescriptionSchema.safeParse(restored.prDescription);
    let prDescription: PrDescription | undefined = restoredDescription.success ? restoredDescription.data : undefined;
    const onPrDescription = (d: PrDescription) => {
      prDescription = d;
      ledgerRun?.setState({ prDescription: d });
    };
    // The commit actually checked out in the run's workspace when the model
    // finished — read by us, not reported by the model — for the reviewed-head
    // guard below. Undefined when the cwd is not a git repo (cold sandbox root).
    let observedHead: string | undefined;
    // The PR head branch (coding runs), read alongside it for the PR
    // post-step: the branch the run's push named, else the checked-out branch.
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
    // The PR post-step's reply note: assembled in the try below — the open
    // runs BEFORE the stream finishes, so its outcome is a fact of the run —
    // and appended to the channel reply at the end.
    let prNote: string | undefined;
    // Set when the head moved during the run by a rebase of the same commits
    // (item 12): the post is pinned to `current` with a footer, and the thread
    // is told the review was carried forward.
    let carried: { reviewed: string; current: string; commits: number } | undefined;
    let runFailed = false; // the runner threw → terminal status `failed`
    let runDiagnosis: FrictionDiagnosis | undefined; // the finish-site diagnosis: the done card's shape line
    // Give the workspace back now rather than at the inactivity sweep: a
    // resident's pool user is a scarce slot (docs/reference/specs/resident-repos.md item
    // 16a). The release mode is paired to the round's agent by the attach
    // helper (reviewRound.ts): read-only agents hold nothing worth keeping; a
    // coding run keeps its worktree only while it has uncommitted/unpushed
    // work — unless an operator HARD-stopped it, which means "tear it
    // down now": the abandoned command may still be running in there, and the
    // whole point of a hard stop is to free the resources. Best-effort — a
    // failed release is a log line, never a failed run. Called AFTER the
    // answer has been sent (or the failure card closed): the `/detach` round
    // trip is bounded at 10 s on a sick resident, and nothing about the reply
    // depends on it, so it must never sit between "answer ready" and the
    // thread. Hard-stop is read at CALL time — it may land during the run.
    // Under `post.workspace_release`: the release's own call is that span's child.
    const releaseWorkspace = (span?: Span) =>
      round.release({ hardStopped: run.control.requested === "hard", ...(span ? { span } : {}) });
    // One tool context for the whole run: the first turn and any re-review
    // turn (settleReviewedHead) share it, so submit_pr_description and the
    // progress checklist keep flowing to the same hooks.
    const toolContext = {
      executor,
      reportProgress,
      web: webCapability(),
      skills: deps.skills,
      github: githubCapabilityFor(deps, msg.userId),
      agentName: agent.name,
      onVerdict,
      onPrDescription,
    };
    try {
      answer = await runAgent({
        provider,
        model,
        agent,
        messages,
        system,
        effort: resolved.effort,
        toolContext,
        ...(mcpForRun && mcpForRun.tools.length > 0 ? { extraTools: mcpForRun.tools } : {}),
        onProgress,
        onEvent,
        span: root, // the loop is `run.agent` under the run's root (docs/reference/specs/tracing.md)
        ...(round.selection.backend ? { backend: round.selection.backend } : {}),
        control: run.control, // operator stop from /runs
        inbox: admitted.inbox, // thread follow-ups steered into this run (thread-admission item 2)
        // The step record before each step's tools (run-history item 35).
        ...(ledgerRun ? { onStep: ledgerRun.step.bind(ledgerRun) } : {}),
        // A resume re-enters the loop from the plan (run-history item 37).
        ...(resume
          ? {
              resume: {
                settlements: resume.plan.settlements,
                stepRecorded: resume.plan.stepRecorded,
                inboxConsumedSeq: resume.plan.inboxConsumedSeq,
                turn: resume.plan.turn,
                iteration: resume.plan.iteration,
                remainingMs: resume.plan.remainingMs,
              },
            }
          : {}),
      });
      // Reviewed-head settle (docs/reference/specs/agent-review.md items 8 + 12,
      // settleReviewedHead in reviewRound.ts): for a PR review, read the
      // workspace HEAD NOW — after the model is done, BEFORE the finally
      // below releases the workspace — and reconcile a PR head that moved
      // during the run: adopt the current head when the run reviewed it,
      // carry the review across a rebase of the same commits, or void the
      // verdict and re-review ONCE at the new head (worktree moved, prompt
      // recomposed, one more model turn). A hard stop observes nothing and
      // settles nothing.
      if (isPrReview && repoCtx.repo && repoCtx.pr !== undefined && run.control.requested !== "hard") {
        const settled = await settleReviewedHead({
          span: root,
          pr: { repo: repoCtx.repo, number: repoCtx.pr },
          baseRef: repoCtx.baseRef,
          reviewHead,
          verdict,
          answer,
          messages,
          composeSystem,
          executor,
          turn: {
            provider,
            model,
            agent,
            effort: resolved.effort,
            toolContext,
            extraTools: mcpForRun?.tools,
            onProgress,
            onEvent,
            control: run.control,
            ...(round.selection.backend ? { backend: round.selection.backend } : {}),
          },
          fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
          fetchPrCommits: deps.fetchPrCommits ?? prCommitsSince,
          notify: {
            reply: (text) => io.reply(text),
            headMoved: (suffix) => {
              shell.setLabel(`${shell.label} · ${suffix}`);
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
      const observeWorkspaceNow = async () => {
        const pushedBranch = pushes.branch();
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
        observedHead = observed.head;
        observedBranch = observed.branch;
        observedCheckedOut = observed.checkedOut;
        observedRemoteHead = observed.remoteHead;
        observedRemoteRepo = observed.remoteRepo;
      };
      // Where the post-step's PR would open (CodingPrTarget): the PR's true
      // base ref when the thread's context came from a PR, else the resident
      // binding ref, else the dispatch's resolved ref. Shared by the
      // description turn's decision and the post-step below.
      const prTarget = {
        repo: repoCtx.repo,
        baseRef: repoCtx.baseRef,
        bindingRef: binding?.ref,
        resolvedRef: repoCtx.ref,
      };
      if (isCodingPrRun && run.control.requested !== "hard") await observeWorkspaceNow();
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
      // again afterwards in case the turn pushed. A hard stop asks nothing.
      let descriptionTurnRan = false;
      if (isCodingPrRun && run.control.requested !== "hard" && prDescription === undefined) {
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
              answer,
              messages,
              system,
              turn: {
                provider,
                model,
                agent,
                effort: resolved.effort,
                toolContext,
                extraTools: mcpForRun?.tools,
                onProgress,
                onEvent,
                control: run.control,
                ...(round.selection.backend ? { backend: round.selection.backend } : {}),
              },
              logKey: msg.threadKey,
            }),
          );
          // Re-read, not narrowed: a hard stop may have landed during the turn.
          if (!run.control.hardSignal.aborted) await observeWorkspaceNow();
        }
      }
      // The accepted PrDescription is a fact of the run: publish it as a typed
      // event BEFORE the finally below finish()es the stream, string fields
      // redacted like every payload, so the run page's review panel renders
      // the same object the GitHub body is rendered from.
      if (prDescription) {
        registry.publish(run.id, {
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
      // line. The base is the PR's true base ref when the thread's context
      // came from a PR (a fix round repushes the PR's OWN head branch, so the
      // binding ref equals the branch and is NOT the merge base), else the
      // thread's resident binding ref, else the dispatch's resolved ref —
      // binding is only ever set on the resident path (factory.ts), so no
      // resident check is needed. The note rides on the final reply below. A
      // hard stop observed nothing above and posts nothing.
      if (isCodingPrRun && run.control.requested !== "hard") {
        prNote = await root.span("run.pr_post_step", () =>
          runCodingPrPostStep({
            observed: {
              head: observedHead,
              branch: observedBranch,
              checkedOut: observedCheckedOut,
              remoteHead: observedRemoteHead,
              remoteRepo: observedRemoteRepo,
            },
            description: prDescription,
            target: prTarget,
            openPullRequest: deps.openPullRequest ?? openPullRequest,
            findOpenPr: deps.findOpenPrByHead ?? findOpenPrByHead,
            fetchRepoInfo: deps.fetchRepoShipInfo ?? fetchRepoShipInfo,
            descriptionTurnRan,
            publish: (e) => registry.publish(run.id, e),
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
      // at run start, not a timeout: by now it finished minutes ago. The meat
      // upgrade is deliberately NOT awaited — see the comment at the start.
      const baseline = readingDiffBaseline;
      if (baseline) await root.span("run.reading_diff_join", () => baseline);
      // Typed-output boundary (docs/reference/specs/llm-output.md item 5): the answer is
      // canonicalized ONCE here, so the event text, the channel reply, the
      // GitHub post, and memory all read one Markdown dialect; the model's raw
      // text rides on the event only when normalization changed it.
      const acceptedAnswer = markdownOutput.parse(answer);
      const rawAnswer = acceptedAnswer.ok && acceptedAnswer.changed ? answer : undefined;
      if (acceptedAnswer.ok) answer = acceptedAnswer.value;
      publishText("answer", answer, undefined, rawAnswer);
    } catch (err) {
      runFailed = true;
      await root.span("post.workspace_release", (span) => releaseWorkspace(span));
      throw err;
    } finally {
      clearInterval(heartbeat);
      const stopped = run.control.requested;
      const status: RunStatus = runFailed
        ? "failed"
        : stopped === "hard"
          ? "stopped_hard"
          : stopped === "soft"
            ? "stopped_soft"
            : "completed";
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
      const events = snap?.events ?? [];
      const finishedAt = snap?.finishedAt ?? clock(); // the registry's finish clock: row and record agree
      // The diagnosis over the run's window (docs/reference/specs/tracing.md): its shape is
      // what the closed card and the record carry.
      const diagnosis = analyzeRunFriction(events, {
        finished: true,
        truncated: snap?.truncated ?? false,
        schema: SPAN_SCHEMA,
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
      // A tracked run finishes through the ledger: the record replaces its
      // live rows in one transaction (a refused finish falls back to the store).
      ending.register({
        runId: run.id,
        flipOnPostFinishFailure: true,
        write: (seal, failedAfterFinish) =>
          deps.runHistoryWriter.write(
            assembleRunRecord({
              run,
              snap,
              agent: agent.name,
              model: resolved.modelRef,
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
      // The diagnosis rides the run record (above): the friction ledger the
      // cross-run proposer reads is run history, so nothing is written twice.
      // A run whose loop threw closes its card here, after the finish, so the
      // card's total is the run's; the outer catch replies and drains.
      if (runFailed)
        await root
          .span("post.card_close", () =>
            card.done(shell.close({ kind: "done", icon: "❌", detail: finalDetail(), ...doneLines(diagnosis) })),
          )
          .catch(() => {});
    }

    // The card's final icon tells the stop apart from a normal finish: ⏹ soft
    // (a summary was written), ⛔ hard (aborted, no summary).
    const stopped = run.control.requested;
    console.log(`[done] ${msg.threadKey} ${answer.length} chars${stopped ? ` (stopped: ${stopped})` : ""}`);

    // The coding PR post-step ran INSIDE the try above (before the stream
    // finished — its outcome is the `pr_opened` event); `prNote` carries what
    // it has to say to the thread.
    // `finally`, not sequential: a Slack failure in either call (outage, an
    // unchunkable line) must still give the pool user back, or it is held
    // until the hourly sweep — the toil 16a exists to avoid.
    try {
      // `live → finishing` on the ledger BEFORE anything reaches the thread
      // (item 35): the double-answer protection once runs resume — a
      // generation that lost the run is refused here and must not reply.
      // The status the record will carry rides on the row first, so a reclaim
      // of a `finishing` row (replied, died before `finish`) closes it
      // truthfully. A `fenced` answer means another generation reclaimed this
      // run while it ran (a handoff, or a lease that lapsed) and is driving it
      // now: nothing more reaches the thread from here — the record is theirs.
      ledgerRun?.setState({ finalStatus: stopped ? `stopped_${stopped}` : "completed" });
      if ((await root.span("post.ledger_finishing", () => ledgerRun?.finishing())) === "fenced") {
        // Nothing more from here: no reply, no card close, and no record — the
        // run is the other generation's now and its record is theirs to write
        // (a partial record from this process could race the real finish). The
        // outer finally still seals the stream here.
        console.log(`[run] ${msg.threadKey} run ${run.id}: another generation owns this run — not replying`);
        ending.drop(run.id);
        return;
      }
      // A review verdict carries its run link (as standard Markdown — each
      // adapter renders its own dialect): the verdict message is what gets
      // scanned in the review loop, and the card above scrolls away. Projection
      // only — the `answer` event published above and the GitHub post body stay
      // link-free.
      const channelAnswer = agent.name === "review" && liveUrl ? `${answer}\n\n[Live run](${liveUrl})` : answer;
      // The PR note (post-step above) is a projection too: the `answer` event
      // stays the model's own words — the PR facts live in the pr_description
      // event and the [pr-post] log line.
      // The card close, the reply, then the drain: the run is sealed with how
      // the reply went and its record goes to the store — BEFORE the
      // workspace release below: the record does not depend on it, and on the
      // ledger the finish is what frees the thread, which must not wait ~90 s on
      // a sandbox teardown (docs/reference/specs/run-history.md item 36). Fire-and-forget;
      // the writer's `pending()` is incremented inside the drain, before the
      // outer finally's `activeRuns--`, so the shutdown drain never observes
      // "0 runs, 0 writes". A reply that threw still seals (`replyOk: false`)
      // and writes (`failed`) here, then reaches the outer catch for the error
      // reply.
      await ending.sealAfterReply(
        () =>
          root.span("post.card_close", () =>
            card.done(
              shell.close({
                kind: "done",
                icon: stopped === "hard" ? "⛔" : stopped === "soft" ? "⏹" : "✅",
                detail: stopped ? finalDetail() : checkedOffDetail(),
                ...doneLines(runDiagnosis),
              }),
            ),
          ),
        () => root.span("post.reply", () => io.reply(prNote ? `${channelAnswer}\n\n${prNote}` : channelAnswer)),
      );
    } finally {
      await root.span("post.workspace_release", (span) => releaseWorkspace(span));
    }

    // Cross-session memory — WRITE path. AFTER the reply has
    // landed, distill this run into memory records: fire-and-forget (tracked
    // only for the shutdown drain), so its latency/failures never reach the
    // user; gated on memory.enabled (default off → nothing happens) and on the
    // run having done real work (tools used, or a long thread) and not being a
    // `review` run (findings live on the PR; distilling them floods org
    // memory with per-PR ephemera). Fast paths above returned before this
    // point and never reflect. A HARD-stopped run has no summary to distill
    // (its answer is the abort line), so it is skipped too; a soft stop wrote
    // a real finale and reflects normally.
    if (stopped !== "hard")
      scheduleReflection({
        cfg: deps.config.config.memory,
        store: deps.memory,
        providers: deps.providers,
        runModelRef: resolved.modelRef,
        gate: { toolCalls, historyTurns: history.length, agentName: resolved.agentName },
        threadKey: msg.threadKey,
        runId: run.id,
        // The writes are the policy's decision for the run's principal under the
        // run's stamped origin (authorization.md item 8): the same actor the chat
        // commands resolve, the same stamp the record carries.
        actor: resolveChatActor(msg, (id) => deps.config.grantsFor(id)),
        originChannelVisibility: channelVisibility,
        organization: deps.config.config.organization,
        userId: msg.userId,
        channelId: msg.channelId,
        repo: repoCtx.repo,
        history,
        request: directives.text,
        answer,
      });

    // Deterministic review post-step (runReviewPostStep in
    // reviewRound.ts): a `review` run against a resolved PR posts its findings
    // back to that PR by default — no need to ask — behind the reviewed-head
    // guard (item 8, fail-closed) and pinned to the verified head (or the
    // carried one, item 12). Best-effort: a post failure is logged and said in
    // the thread but never fails the dispatch (the review already landed in
    // Slack). A HARD-stopped review has no findings — only the abort line — so
    // nothing is posted; a soft stop's "findings so far" finale posts as
    // usual. Deliberately AFTER the workspace release and registry finish
    // above — the plain path's lifecycle position is unchanged.
    await root.span("post.review_post", () =>
      runReviewPostStep({
        agent,
        requestText: directives.text,
        repoCtx,
        heads: { reviewHead, observedHead },
        verdict,
        answer,
        carried,
        hardStopped: stopped === "hard",
        post: deps.postReviewComment ?? postReviewComment,
        fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
        reply: (text) => io.reply(text),
        logKey: msg.threadKey,
      }),
    );
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

/** The `pr_description` event's payload: every string LEAF passed through
 *  `redactSecrets` by a generic deep walk — numbers/booleans ride unchanged,
 *  structure preserved — so a field added to the schema (or a secret smuggled
 *  into an anchor path) can never dodge redaction by being missed in a
 *  hand-walk. */
function redactPrDescription(d: PrDescription): PrDescription {
  return redactStringLeaves(d) as PrDescription;
}

function redactStringLeaves(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactStringLeaves);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redactStringLeaves(v)]));
  }
  return value;
}

/** The notice the drain (src/index.ts) sets on SIGTERM from a deploy rollout.
 *  Exported so the Slack adapter's orphan sweep can strip it from a frozen
 *  card's title — an interrupted card must not keep the stale
 *  "finishing this run" clause. Shared like LIVE_CARD_PREFIXES, so the text
 *  the drain appends and the text the sweep strips cannot drift apart. */
export const DEPLOY_RESTART_NOTICE = "⏸ deploy in progress — this run continues through the bot restart";

/** Set by the process-wide drain (SIGTERM from a deploy rollout) and appended to
 *  every live card's heartbeat frame, so a reader can tell "finishing this run
 *  before the bot restarts" from a run that is merely slow. `undefined` clears
 *  it (tests). A plain module-level value: the drain is process-wide by nature
 *  and every in-flight run must show it, not only runs started after it. */
let shutdownNotice: string | undefined;
export function setShutdownNotice(notice: string | undefined): void {
  shutdownNotice = notice;
}
