import { getAgent } from "../agents/registry.js";
import type { LedgerRun } from "./runLedger/writeThrough.js";
import { systemClock } from "./trace/index.js";
import type { SpanSink, Tracer } from "./trace/types.js";
import type { SpanLog } from "./trace/spanLog.js";
import type { RunOwner } from "./trace/streamSpans.js";
import { channelOf, startRequestRoot, type RequestTrace } from "./requestTrace.js";
import { cardShapeLineOf, queuedCaption } from "./runShape.js";
import type { RepoContext } from "./repoContext.js";
import { redactSecrets, type StopMode } from "./runEvents.js";
import { oneLine, redactAndCap, stripAnsi } from "./redact.js";
import type { LiveThread } from "./threadAdmission.js";
import type { RecordDeps } from "./dispatch/record.js";
import { cardLines, errorReply } from "./dispatch/reply.js";
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
import { answerChatCommand, type FastPathDeps } from "./dispatch/fastPath.js";
import { NO_REFERENCES, readReferences, REFERENCE_REFUSAL, type ReferenceDeps } from "./dispatch/references.js";
import { resolveChatActor } from "./authz/actor.js";
import { referencesOn } from "../config.js";
import { readRequest, resolveProfile, resolveRun, resolveTarget, type ResolveDeps } from "./dispatch/resolve.js";
import { compoundBrief, routeRequest, type RouteDecided, type RouteDeps } from "./dispatch/route.js";
import type { McpToolSource } from "../mcp/source.js";
import {
  authorizeAgent,
  authorizeAttachedHead,
  authorizePrHead,
  authorizeProfile,
  authorizeRepo,
  type AuthorizeDeps,
} from "./dispatch/authorize.js";
import { buildMessages, textTurnsOf, type TextTurn } from "./dispatch/messages.js";
import {
  attachmentsLine,
  copyStaged,
  noWorkspaceLine,
  pullStaged,
  stageThreadArtifacts,
  stagingIndex,
  WorkspaceFiles,
  type StagedOutcome,
} from "./dispatch/staging.js";
import type { RunSeed } from "./runRecord.js";
import {
  attachWorkspace,
  budgetClipLabel,
  composePrompt,
  mintRunBearer,
  openAckCard,
  registerRun,
  reserveRun,
  startMemoryRead,
  type ProvisionDeps,
} from "./dispatch/provision.js";
import type { FrictionDiagnosis } from "./runFriction.js";
import { claimRun, type RunDeps } from "./dispatch/run.js";
import { runLoop } from "./dispatch/runLoop.js";
import { afterReply, deliverAnswer, type ReplyDeps } from "./dispatch/reply.js";
import { writeTombstone } from "./dispatch/record.js";
import { runShipBranch, type ShipDeps } from "./dispatch/ship.js";
import { shipPresetFor } from "./shipPipeline.js";
import { DEFAULT_CONTRACT_MAX_CHARS, renderContract, type ChildContract } from "./ship/contract.js";
import { withContractInFirstUserTurn } from "./ship/codingChild.js";
import { prepareFreshTurn, settleThread, tellDropped } from "./dispatch/settle.js";
import {
  abandonLostWorkspace,
  carriedCoordinatorTag,
  carriedWorkspaceBinding,
  prepareRestartTurn,
} from "./dispatch/reattach.js";
import { workspaceBindingFor } from "../execution/factory.js";
import { lineageOf, lineageParent, tellParent, type LineageHeard } from "./dispatch/lineage.js";
import { sessionSeedFor } from "./dispatch/seed.js";
import { sessionCapabilityFor } from "../tools/session.js";
import { readThread, stickyAgentOf, threadPrOf, threadRouteOf } from "./dispatch/thread.js";
import { describeAsset, readThreadAssets, type ThreadAsset } from "./dispatch/threadAssets.js";
import { runToolCapabilities, type ParentRun } from "./dispatch/spawn.js";
import { createRunsService } from "./runsService.js";
import type { CoordinatorTag } from "./coordinator/contract.js";
import type { DispatchOutcome } from "./dispatch/outcome.js";
import type { IssueTracker } from "../execution/githubIssues.js";
import { defaultRunRegistry, type RunHandle } from "./runRegistry.js";
import type { CardShell } from "./statusCardFrame.js";
import { createRunEnding } from "./runEnding.js";
import { messageIdOf, type ChannelIO, type IncomingMessage, type StatusHandle } from "./types.js";

// The dispatcher is the channel-agnostic core: config commands, directive
// parsing, layered resolution, permission gates, history assembly, executor
// selection, and the agent run. Channels are pure transports (src/channels/).

export interface CoreDeps
  extends
    AdmissionDeps,
    FastPathDeps,
    ResolveDeps,
    RouteDeps,
    AuthorizeDeps,
    ProvisionDeps,
    RunDeps,
    ReplyDeps,
    RecordDeps,
    ReferenceDeps,
    ShipDeps {
  /** The MCP tool source: required for provisioning (every run asks it for its tools), and the same instance the
   *  route stage reads the caller's catalog off (record 0040) — declared here so the two bases agree. */
  mcp: McpToolSource;
  /** The tracer behind every root this process starts; the no-gaps test injects one with its `SpanContext`. */
  tracer?: Tracer;
  /** The root's leading sinks (a test's recording sink); default: the one log sink at `tracing.log`. */
  sinks?: SpanSink[];
  /** The in-process span log every root also feeds (docs/reference/specs/tracing.md item 26); `GET /admin/trace/log` reads it. */
  spanLog?: SpanLog;
  /**
   * Where `friction propose` files its proposals. Default: the GitHub REST
   * tracker with the App installation token (App `issues:write`; never a `gh`
   * shell-out — AGENTS.md invariant 5). Injectable so tests assert filing
   * without a network call. No stage reads it: the composition root
   * (`src/index.ts`) hands it to the command catalogue, and the dispatcher
   * tests inject an in-memory tracker through this same bag — it stays here
   * because `CoreDeps` is the one place a process declares what it runs with.
   */
  issueTracker?: IssueTracker;
}

// In-flight run tracking so the process can drain before exiting (restarts
// must not kill runs mid-flight — see index.ts signal handling).
let activeRuns = 0;

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
  /** Set by the restart from the request alone (`prepareRestartTurn`;
   *  run-history item 54, harness-pi item 16): the run this request is the
   *  request of, closed `interrupted` by the dispatch that hands it on. Its
   *  finish write is in flight while this request is admitted, and after a
   *  resume across a bot generation the boot-gap map may still name it
   *  (thread-admission item 5) — so admission never steers this request into
   *  that run's inbox: it runs fresh, as a new run in the thread. Absent for
   *  every other request. */
  restartOf?: string;
  /** Set by `spawnChild()` (dispatch/spawn.ts; routing-and-config item 20):
   *  this request is a child run — the run that spawned it, its depth, and the
   *  wall clock the parent had left, which the child's effective profile takes
   *  as one more boundary. Absent for every request a person, a schedule or a
   *  resume started; the dispatcher's lineage stage (dispatch/lineage.ts;
   *  agent-conductor item 10) then resolves one for a person's reply in a
   *  thread a run spawned — the same parent, no clock. */
  parent?: ParentRun;
  /** Set by `spawnChild()` beside `parent`: the conversation this child starts
   *  from in place of its thread's history — its parent's text turns at the
   *  spawn (user and assistant text; no tool calls, results or thinking), the
   *  request being the one new turn after them. Absent → the thread's
   *  history, as for every request a person, a schedule or a coordinator
   *  started; the record says which (run-history item 52). */
  seed?: TextTurn[];
  /** Set by the coordinator's spawn route alone (src/channels/adminCoordinator.ts;
   *  run-history item 48): this request is a coordinator instance's child —
   *  the instance and the idempotency key ride every row the run has, and a
   *  run in flight on the thread refuses the request instead of taking it as
   *  a steer (thread-admission item 8). Absent for every other request. */
  coordinator?: CoordinatorTag;
  /** Set by the coordinator's spawn route for a plan unit's child (agent-ship
   *  item 13): the unit's contract, rendered once here — into a coding child's
   *  first user turn as its own text part, into a review child's system prompt
   *  after the REVIEW TARGET block — so both children hold one object. Absent
   *  for every other request. */
  contract?: ChildContract;
}

/** How a request ended, for whoever started it (dispatch/outcome.ts): the
 *  request's status and, when a gate ended it, that gate's name — what a
 *  spawning parent relays to its model as a named tool result. */
export type { DispatchOutcome } from "./dispatch/outcome.js";

export async function dispatch(
  deps: CoreDeps,
  msg: IncomingMessage,
  io: ChannelIO,
  opts: DispatchOptions = {},
): Promise<DispatchOutcome> {
  // How this request ends, for the caller: every exit below returns this one
  // object and the outer finally stamps its status before the promise settles,
  // so the function resolves exactly when it did before it answered anything.
  const ended: DispatchOutcome = { status: "completed" };
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
    ended.refusal ??= outcome;
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
  // A run's model-proxy bearer (docs/reference/specs/model-proxy.md) is revoked
  // the moment the run is reported finished, before the seal: no call after the
  // run's end buys a model turn.
  const ending = createRunEnding({
    registry: deps.runRegistry ?? defaultRunRegistry,
    onFinished: (id) => void deps.runBearers?.revoke(id),
  });
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
  // A resumed run whose workspace could not be re-attached (run-history item
  // 54): its row was closed with the note that says why, and its request runs
  // again as a new run once this dispatch has freed the thread.
  let resumeRowClosed = false;
  // The request to dispatch again as a new run once the thread is free (item
  // 54; harness-pi item 16), and the run it restarts — the one this dispatch
  // closed `interrupted`, which admission must never steer the request into
  // (thread-admission item 5). Undefined until a restart is decided.
  let restartRequest: { request: IncomingMessage; restartOf?: string } | undefined;
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
    if (await answerChatCommand(deps, { msg, io, ending, trace })) return ended;

    const { directives, history } = await readRequest({ msg, io, root });

    // The thread's runs, read once (dispatch/thread.ts) for a reply in an
    // existing thread — a message that starts a thread has none, and a spawn,
    // a coordinator's child, a resume and a restart know their parent (or that
    // they have none) already. The one page yields the lineage (dispatch/
    // lineage.ts; agent-conductor item 10: a person's request in a thread a run
    // spawned is a run of that child — the spawning run's id on its record at
    // the child's depth, no clock inherited — and the parent, while it lives,
    // hears the reply as a follow-up from that child), the thread's sticky
    // agent by transcript (routing-and-config item 3) and, once the agent is
    // resolved, the previous run its seed continues from (session-log item 9).
    const runsService = deps.runs ?? createRunsService({ registry, store: deps.runStore });
    const thread =
      opts.parent || opts.coordinator || resume || restart || history.length === 0
        ? undefined
        : await readThread(runsService, msg.threadKey);
    const lineage = lineageOf(thread?.[0]);
    const parent: ParentRun | undefined = opts.parent ?? (lineage ? lineageParent(lineage) : undefined);
    const tellLineage = async (heard: LineageHeard) => {
      if (!lineage) return;
      await tellParent(
        { runs: runsService, config: deps.config, runLedger: deps.runLedger, clock, admission },
        lineage,
        msg,
        heard,
      );
    };

    // The (agent, model, effort) this request resolves to (dispatch/resolve.ts):
    // a directive, else the thread's sticky agent by transcript — the agent of
    // the thread's newest finished run with a session log (routing-and-config
    // item 3) — else the config scopes; the model and the effort from the
    // thread's user turns, then the scopes.
    const stickyAgent = thread ? stickyAgentOf(thread) : undefined;
    // The same page names the pull request the thread's work lives on
    // (resident-repos item 29): the one its newest finished run opened, for
    // the target resolution below.
    const threadPr = thread ? threadPrOf(thread) : undefined;
    const settled = resolveRun(deps, {
      msg,
      directives,
      history,
      ...(stickyAgent !== undefined ? { stickyAgent } : {}),
    });
    const { sticky } = settled;
    let { resolved, agentSource } = settled;

    // The route stage (dispatch/route.ts; record 0026): a plain message — no
    // directive, no sticky preset, no user or channel agent — picks its preset
    // through the fast model when `routing.auto` is on. Whatever it picks
    // meets the gates below like a typed directive; a router that is off,
    // fails or answers outside the requester's allowlist leaves the request
    // on `defaults.agent` exactly as before. A compound (the conductor with
    // its parts) is a route like any other here; a compound the parse refused
    // leaves the request on the default and rides the record as its `route`
    // event with the rejection — `routeEvent` is what the record gets,
    // `route` what the card and the run read.
    let route: RouteDecided | undefined;
    const threadLive =
      admission.get(msg.threadKey) !== undefined ||
      (!resume && !restart && deps.threadsElsewhere.get(msg.threadKey) !== undefined);
    const routing = await routeRequest(deps, {
      msg,
      directives,
      sticky,
      agentSource,
      threadLive,
      root,
      // A restart is the same run under the same card: the row's decision
      // (run-history item 35) is the route, re-resolved, never re-asked.
      ...(restart?.row.meta.route ? { carried: restart.row.meta.route } : {}),
      // The command menu (record 0036, unit 2): the router may call a chat
      // command instead of routing; the branch answers it here — a write
      // handed back, a read run through the registry — with no card, no
      // thread claim and no agent run.
      command: { deps, io, ending, trace, history },
    });
    // A command the router bound has been answered (record 0039): the reply
    // went out, a read's run is sealed by the drain, and the dispatch is over
    // before the agent gate and the thread claim.
    if (routing.kind === "command") return ended;
    if (routing.kind === "routed") {
      resolved = routing.resolved;
      route = routing.route;
      agentSource = "route";
    }
    const routeEvent = routing.kind === "routed" ? routing.route : routing.rejected;
    // A sticky-by-transcript follow-up in a routed thread carries the thread's
    // decision (routing-and-config item 21): the router was rightly not asked
    // — the preset is the transcript's — but the card still says why the
    // preset was chosen (` · routed: <reason>` and the override footer), the
    // row's `meta.route` repaints it on a resume or reclaim, and the record's
    // `route` field hands it to the next follow-up. No `route` event and
    // `agentSource` stays `sticky`: the router made no new decision here.
    if (routing.kind === "unrouted" && stickyAgent !== undefined && agentSource === "sticky" && thread)
      route = threadRouteOf(thread, resolved.agentName);
    // A resume repaints the card as the first generation painted it: the row
    // carries the router's decision (run-history item 35), the resumed message
    // pins the preset by directive so the router is rightly never asked again,
    // and the record already holds the `route` event — the card alone needs it.
    if (resume?.row.meta.route) route = resume.row.meta.route;

    // The agent gate (dispatch/authorize.ts), against the RESOLVED agent and
    // before the thread is claimed.
    if ((await authorizeAgent(deps, { msg, io, refuse, agentName: resolved.agentName })).kind === "refused")
      return ended;

    // The preset as this deployment declares it: the registry's def, except
    // ship, whose declared budget is the `ship.maxMinutes` knob
    // (docs/reference/specs/agent-ship.md item 8) — so the profile below, the
    // card's budget line and the pipeline's wall clock read one number.
    const agent = resolved.agentName === "ship" ? shipPresetFor(deps.config.config.ship) : getAgent(resolved.agentName);
    // The run's effective profile (dispatch/resolve.ts; record 0026): preset ∩
    // the request's `budget:` directive ∩ the boundaries on the path — a
    // child's parent's remaining wall clock among them (routing-and-config
    // item 20) — and the profile gate (dispatch/authorize.ts) right after the
    // agent gate and before the thread is claimed, so an identity or class a
    // boundary caps is refused by name with no card, no row and no executor.
    // Every stage below reads the profile — the factory, the ledger row, the
    // runner — never the preset's own fields.
    const profileGate = await authorizeProfile(deps, {
      msg,
      io,
      refuse,
      agent,
      resolution: resolveProfile({
        agent,
        resolved,
        resume,
        budget: directives.budget,
        ...(parent?.remainingMs !== undefined ? { parentRemainingMs: parent.remainingMs } : {}),
      }),
    });
    if (profileGate.kind === "refused") return ended;
    const { profile } = profileGate;

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
      ...(opts.restartOf !== undefined ? { restartOf: opts.restartOf } : {}),
      ...(opts.coordinator ? { coordinator: opts.coordinator } : {}),
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
    // A redispatch (the boot-gap steer that found its row gone) is a request
    // of its own — its own root, no resume or restart — but the same message:
    // a child stays its parent's child, starts from the same seed, a
    // coordinator's child stays its instance's, and a restart still names the
    // run it restarts, so `parent`, `seed`, `coordinator` and `restartOf` ride
    // along, and its outcome is the one the caller gets.
    if (outcome.kind === "redispatch")
      return dispatch(deps, msg, io, {
        ...(opts.parent ? { parent: opts.parent } : {}),
        ...(opts.seed ? { seed: opts.seed } : {}),
        ...(opts.coordinator ? { coordinator: opts.coordinator } : {}),
        ...(opts.restartOf !== undefined ? { restartOf: opts.restartOf } : {}),
      });
    // A reply folded into the live child of a spawned thread: its parent hears it now.
    if (outcome.kind === "steered") await tellLineage({ kind: "steered" });
    if (outcome.kind !== "proceed") return ended;
    admitted = outcome.admitted;
    const taken = await adoptCarriedRun(deps, admissionCtx);
    ledgerRun = taken.ledgerRun;
    reserved = taken.reserved;
    requestRow = taken.requestRow;
    await foldCarriedInbox(deps, admissionCtx, admitted);

    // The references step (dispatch/references.ts, record 0037): a permalink
    // to another conversation the bot is in becomes a quoted, untrusted block
    // on the request turn — after both fast paths and after admission, so a
    // request they answer or refuse makes no adapter call and spends none of
    // the requester's window; before the model, so nothing it does can widen
    // what was read. The parsers above read `msg.text` and `history`, neither
    // of which this touches. A resume replays its plan's messages and a
    // restart re-dispatches a request already answered, so neither resolves
    // again. Off by default (`references.enabled`).
    const references =
      !resume && !restart && referencesOn(deps.config.config)
        ? await root.span("dispatch.references", () =>
            readReferences(deps, { msg, actor: resolveChatActor(msg, (id) => deps.config.grantsFor(id)) }),
          )
        : NO_REFERENCES;

    // The provider behind the model ref, and the target repo/ref/PR resolution
    // STARTED here (dispatch/resolve.ts) so the GitHub round trip overlaps the
    // memory read below; awaited after the ack.
    const { needsRepo, repoCtxP } = resolveTarget(deps, {
      msg,
      history,
      agent,
      profile,
      resolved,
      resume,
      root,
      ...(threadPr ? { records: { pr: threadPr } } : {}),
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
    const ack = await openAckCard(deps, { io, agent, resolved, startedAt, clock, root, trace, route });
    const { shell, card } = ack;
    setupCard = card;
    setupShell = shell;
    setupHeartbeat = ack.heartbeat;
    // The references step's one refusal line (record 0037), held from the step
    // above until the card existed so it reads as the first line under the
    // run, not a reply to nothing. Nothing between the step and the
    // ack ends the dispatch, so it posts exactly once whenever anything was
    // refused; the `[references]` log lines were written by the step itself.
    if (references.refused.length > 0) await io.reply(REFERENCE_REFUSAL);

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
      profile,
      needsRepo,
      repoCtx,
    });
    if (repoGate.kind === "refused") return ended;

    // A boundary or a `budget:` directive that clipped this run's budget — or
    // a directive that narrowed nothing — is named on the card from here,
    // through the attach and the run, the way a resident note is
    // (dispatch/provision.ts). Before the ship fork: a ship pipeline's wall
    // clock is its clipped budget too, and its card says so.
    const clip = budgetClipLabel(agent, profile, directives.budget);
    if (clip) shell.setLabel(`${shell.label} · ${clip}`);

    // agent:ship fork (docs/reference/specs/agent-ship.md): after agent resolution and the
    // repo gates above, BEFORE the top-level attach — ship attaches nothing
    // here; the plan runner's children each attach their own workspace as
    // runs of their own. The branch owns everything from here: the preflight
    // refusals, the one run record, the hand-off to the runner, the reply. An
    // unexpected throw propagates to the outer catch after the branch closed
    // its own card and persisted its failed record.
    if (agent.name === "ship") {
      setupCard = undefined; // the ship branch owns the card from here
      clearInterval(setupHeartbeat);
      await runShipBranch(deps, msg, io, {
        agent,
        profile,
        modelRef: resolved.modelRef,
        label: shell.label,
        startedAt,
        card,
        directives,
        sticky,
        history,
        repoCtx,
        live: admitted,
        ending,
        trace,
        closeLines,
        refuse,
        doneLines,
        agentSource,
        ...(route ? { route } : {}),
      });
      return ended;
    }

    // A resume continues the exact conversation the ledger held (item 38);
    // the thread history was folded into it when the run started. A plan
    // unit's contract (agent-ship item 13) rides a coding child's first user
    // turn as its own text part after the request's text — the review child
    // gets the same block in its system prompt (composePrompt below). A routed
    // compound's first turn is its brief (dispatch/route.ts): the message as
    // typed, then the parts for the conductor to spawn — the record's `input`
    // stays the message, its `route` event carries the parts.
    const contractBlock = opts.contract
      ? renderContract(opts.contract, { maxChars: DEFAULT_CONTRACT_MAX_CHARS }).text
      : undefined;
    const requestText = route?.parts ? compoundBrief(directives.text, route.parts) : directives.text;
    // Where the conversation starts (run-history item 52), and every row and
    // record the run has says which: a spawned child from its parent's text
    // turns (routing-and-config item 20); a follow-up in a thread from the log
    // of that thread and its agent when the thread has one (session-log item
    // 9: the log's tail within the seed budget, the lines since the previous
    // run ended, the request — the tail's rows reused, not rewritten); every
    // other run from its thread's history. A log that could not be read is the
    // channel, and a note on the record says why.
    const fromSession =
      !resume && !opts.seed && thread
        ? await sessionSeedFor({
            ledger: deps.runLedger,
            threadKey: msg.threadKey,
            agent: agent.name,
            thread,
            history,
            request: {
              text: requestText,
              ...(msg.images ? { images: msg.images } : {}),
              ...(msg.documents ? { documents: msg.documents } : {}),
              ...(references.blocks.length > 0 ? { references: references.blocks } : {}),
            },
          })
        : undefined;
    const session = fromSession?.seed;
    const seedNotes = fromSession?.notes ?? [];
    const seed: RunSeed = opts.seed ? "parent" : session ? "session" : "channel";
    const seedTurns: TextTurn[] | undefined =
      opts.seed ?? (session ? textTurnsOf(session.messages.slice(0, -1)) : undefined);
    const built = session
      ? session.messages
      : buildMessages(opts.seed ?? history, requestText, msg.images, msg.documents, references.blocks);
    const messages = resume
      ? resume.plan.messages
      : contractBlock !== undefined && agent.name !== "review"
        ? withContractInFirstUserTurn(built, contractBlock)
        : built;

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
    if (headPreflight.kind === "refused") return ended;

    // The reservation (item 42): the run's row on every surface BEFORE the
    // workspace attach (dispatch/provision.ts) — the registry row, its label and
    // link, the request and context events — then, for a fresh request, the
    // ledger row. `registered` the moment the row exists: a later throw discards it.
    // A child names its parent on every row (run-history item 46) — a run in a
    // spawned thread the same parent; a coordinator's child its instance and
    // key (item 48).
    const parentRunId = parent?.runId;
    // A resumed run carries its coordinator tag forward (run-history item 48a):
    // the spawn's dispatch options are gone with the process that spawned it,
    // so the tag is rebuilt from the adopted row's meta and the
    // `coordinator_tag` event the spawning dispatch published.
    const coordinator = opts.coordinator ?? (resume ? carriedCoordinatorTag(resume.row, resume.events) : undefined);
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
      parentRunId,
      coordinator,
      seed,
      ...(seedTurns ? { seedTurns } : {}),
      agentSource,
      ...(routeEvent ? { route: routeEvent } : {}),
      ...(references.conversations.length > 0 ? { references } : {}),
    });
    const { run, runId, channelVisibility, liveUrl, publishText, publishMeta } = registration;
    registered = run;
    // What the session seed could not do (session-log item 9), on the record
    // before the first turn — the run is not changed by it.
    for (const summary of seedNotes)
      registry.publish(run.id, { type: "run_note", kind: "seed", summary: oneLine(summary), at: clock() });
    // A new run of a spawned thread's child has its row: its parent hears the
    // reply now, with the run that answers it named.
    await tellLineage({ kind: "started", runId });
    // Staged files (record 0033): the copies into the store START here — after
    // admission and the run's row, before the workspace attach they overlap
    // with — for a run whose agent has a workspace to pull them into; the pulls
    // follow the attach below. A workspace-less agent copies nothing and its
    // turn says so. A resume re-enters a run whose turn already carried them.
    const staged = !resume && deps.artifacts && msg.staged && msg.staged.length > 0 ? msg.staged : [];
    // One counter for every round this run stages (the request here, each
    // steer in the loop): two files of one name never share a workspace path.
    // And one map of where each staged file landed, for `recall` and the prompt.
    const nextStagedIndex = stagingIndex();
    const workspaceFiles = new WorkspaceFiles();
    const stagedCopies: Promise<StagedOutcome[]> | undefined =
      staged.length > 0 && agent.machine !== "none"
        ? copyStaged(staged, {
            store: deps.artifacts!,
            threadKey: msg.threadKey,
            nextIndex: nextStagedIndex,
            publish: (e) => registry.publish(runId, e),
          })
        : undefined;
    // The thread's files (record 0033): the one catalogue — what the thread's
    // runs' records name as received or produced, and whether the store still
    // holds each — read once here for its three readers: the re-pull below, the
    // prompt's list of the thread's files, and `recall` (which reads it again,
    // fresh, on demand). Started beside the message's own copies, so both
    // overlap the workspace attach. Nothing to read for a thread that has not
    // run, nothing on a resume (its turn already carried the files).
    // This run's own row is live in the list already and its copies are
    // recording events while the read runs: its files are the turn's own, so
    // they are left out here — the attachments line names them, and `recall`
    // reads them fresh.
    const threadAssets: Promise<ThreadAsset[]> | undefined =
      !resume && deps.artifacts && thread && thread.length > 0
        ? readThreadAssets({ runs: runsService, store: deps.artifacts }, msg.threadKey).then((assets) =>
            assets.filter((a) => a.runId !== runId),
          )
        : undefined;
    // What prior runs' records name as received is still in the store for the
    // retention window, so a later run pulls it too — never copied again. The
    // message's files took their indexes when `copyStaged` was called, so the
    // earlier files number after them and the pull order is fixed: the
    // message's own, then the thread's earlier ones, oldest first. A
    // workspace-less agent gets nothing here, as for the message's own files.
    const earlierStaged: Promise<StagedOutcome[]> | undefined =
      threadAssets && agent.machine !== "none"
        ? threadAssets.then((assets) =>
            stageThreadArtifacts(
              assets.filter((a) => a.direction === "in"),
              {
                nextIndex: nextStagedIndex,
                messageId: messageIdOf(msg, runId),
                publish: (e) => registry.publish(runId, e),
              },
            ),
          )
        : undefined;
    const reservation = await reserveRun(deps, {
      msg,
      agent,
      profile,
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
      route,
      admitted,
      root,
      parentRunId,
      coordinator,
      seed,
    });
    if (reservation) {
      reserved = reservation.reserved;
      requestRow = reservation.requestRow;
    }

    // The workspace attach (dispatch/provision.ts): the setup step that takes
    // minutes on a cold clone, and the ask-once refusal when no branch is bound.
    // A resume re-attaches where its row says the run ran (dispatch/reattach.ts;
    // run-history item 54), never provisioning again; a fresh run attaches as
    // it always did.
    const reattach = resume ? carriedWorkspaceBinding(resume.row) : undefined;
    const attach = await attachWorkspace(deps, {
      msg,
      io,
      refuse,
      card,
      shell,
      closeLines,
      clock,
      agent,
      profile,
      repoCtx,
      root,
      ...(reattach !== undefined ? { reattach } : {}),
    });
    if (attach.kind === "refused") return ended;
    if (attach.kind === "reattach_refused") {
      // The run's work was on that backend or nowhere: the resumed run closes
      // saying why, and its request runs again as a new run in the thread,
      // provisioned as a fresh run is, after the outer finally frees the thread.
      if (resume) {
        const request = await abandonLostWorkspace({
          msg,
          io,
          refuse,
          card,
          shell,
          closeLines,
          clock,
          run,
          registry,
          resume,
          ledgerRun,
          why: attach.why,
        });
        if (request) restartRequest = { request, restartOf: resume.row.runId };
        resumeRowClosed = true;
      }
      return ended;
    }
    const { round } = attach;
    // A resumed row learns the binding it re-attached on, complete: a row
    // written before the binding was recorded carried only its meta's word.
    if (resume && ledgerRun) {
      const rebound = workspaceBindingFor(round.selection, profile.machine);
      if (rebound !== undefined) ledgerRun.setState({ binding: rebound });
    }
    const { executor, note, resident } = round.selection;
    if (fencedWhileAttaching) {
      // The reservation's lease lapsed during the attach and another generation
      // took the row (item 42): the run is theirs to restart — nothing more
      // runs or replies here, and the row is left alone.
      console.log(
        `[dispatch] ${msg.threadKey} run ${runId}: another generation took the run during the attach — stopping here, it restarts there`,
      );
      if (executor.release) await executor.release("always").catch(() => {});
      return ended;
    }
    // The staged files land now (record 0033): the copies awaited, each pulled
    // into `attachments/` over this run's executor as the thread user, and the
    // request turn gains the line that names every file — landed or not — so a
    // failure carries its reason into the model's first read. A workspace-less
    // agent gets the line that says where the file can be worked with.
    // Awaited only when it exists: a run with nothing to stage keeps its exact
    // sequence of turns (a child's thread slot is released on the tick it was).
    const earlier = earlierStaged ? await earlierStaged : [];
    if (staged.length > 0 || earlier.length > 0) {
      let line: string;
      if (stagedCopies || earlier.length > 0) {
        const pulled = await pullStaged([...(stagedCopies ? await stagedCopies : []), ...earlier], {
          store: deps.artifacts!,
          executor,
          resident: resident !== undefined,
        });
        workspaceFiles.record(pulled);
        line = attachmentsLine(pulled);
      } else line = noWorkspaceLine(staged);
      const request = messages[messages.length - 1];
      if (request && request.role === "user" && line) {
        request.content = Array.isArray(request.content)
          ? [...request.content, { type: "text", text: line }]
          : [
              { type: "text", text: request.content },
              { type: "text", text: line },
            ];
      }
    }
    // The run's model-proxy bearer (dispatch/provision.ts; docs/reference/specs/model-proxy.md):
    // minted the moment the executor is provisioned, bound to this run, pinned
    // to its preset's model and caps, expiring at its budget plus the margin.
    // Revoked by the ending above when the run finishes, and by the outer
    // finally for a run that never reached its loop. A run on the pi harness
    // hands it to pi as its provider key (docs/reference/specs/harness-pi.md);
    // a native run never reads it.
    const bearer = mintRunBearer(deps, { runId, agent, profile, resolved, registry, root, clock });

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
    if (headGate.kind === "refused") return ended;
    repoCtx = headGate.repoCtx;
    const verifiedAtAttach = headGate.verifiedAtAttach;
    // The run's meta went out at the reservation with the head as resolved
    // then; the record and the page must name the head actually reviewed.
    if (headGate.headAdopted) publishMeta(repoCtx);
    // The card's branch/head line is the run's OWN binding (resident-repos
    // item 16): a thread whose binding moved between two plans still resolves
    // the ref and head from the thread's records — the FIRST plan's pull
    // request — while the attach bound this run's own branch. Republish the
    // meta from the binding (readers take the latest), before the loop, so
    // every redraw — the second card's first frame included — names where the
    // run actually is, never the value cached when the first plan bound it.
    const bound = round.selection.binding;
    if (bound !== undefined && (bound.ref !== repoCtx.ref || bound.sha !== repoCtx.headSha))
      publishMeta({ ...repoCtx, ref: bound.ref, headSha: bound.sha });

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
    // The thread's files, one line each, where each is for this run — the
    // pull above has landed the held ones, so their workspace paths are known.
    const threadFiles = threadAssets
      ? (await threadAssets).map((a) => describeAsset(a, workspaceFiles.pathOf(a.key)))
      : [];
    // The prompt (dispatch/provision.ts): skills, MCP discovery, the config and
    // self-description blocks, the custom instructions, the memory block, and
    // the system composer pinned to the head this run reviews.
    const prompt = await composePrompt(deps, {
      msg,
      agent,
      profile,
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
      ...(contractBlock !== undefined && agent.name === "review" ? { contract: contractBlock } : {}),
      // What the session already knows (session-log item 10): the notepad and
      // the newest compaction's summary the seed brought back, and the thread's
      // files (record 0033) with where each is for this run, for the prompt.
      ...(session?.notepad !== undefined || session?.summary !== undefined || threadFiles.length > 0
        ? {
            session: {
              ...(session?.notepad !== undefined ? { notepad: session.notepad } : {}),
              ...(session?.summary !== undefined ? { summary: session.summary } : {}),
              ...(threadFiles.length > 0 ? { files: threadFiles } : {}),
            },
          }
        : {}),
    });
    const { mcpForRun, system } = prompt;
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
    // A follow-up the resident kept off its thread's own PR branch says so on
    // its stream too (resident-repos item 16): the run page explains a run on
    // the default where the thread's pull request was expected, with the
    // resident's own reason. Head material, like the cold-sandbox note.
    const kept = bound?.rebindRefused;
    if (bound && kept) {
      const summary =
        `kept on ${bound.ref} — rebind to ${kept.to} (this thread's PR #${kept.pr}) ` +
        `refused: ${kept.reason}${kept.why ? ` — ${kept.why}` : ""}`;
      registry.publish(run.id, { type: "run_note", kind: "rebind_refused", summary: oneLine(summary), at: clock() });
    }
    console.log(`[run] ${msg.threadKey} user=${msg.userId} agent=${agent.name} model=${resolved.modelRef}`);
    setupCard = undefined; // from here the run loop owns the card's close
    clearInterval(setupHeartbeat);
    card.update(shell.live()); // the ack card becomes the run card
    const loopStartedAt = clock();
    // The run loop owns the run from here: its finally finishes it (the outer
    // finally discards a run that never got this far). Events are fed to the
    // registry in onEvent below; the stream has been live since the reservation.
    runLoopStarted = true;
    if (resume) {
      console.log(
        resume.plan.kind === "finish"
          ? `[resume] ${msg.threadKey} run ${run.id} finishes under ${deps.runLedger.gen}: the model had answered at step ${resume.plan.step}, ${resume.events.length} event(s) replayed`
          : `[resume] ${msg.threadKey} run ${run.id} continues under ${deps.runLedger.gen}: from step ${resume.plan.step}, ${resume.plan.settlements.length} call(s) to settle, ${resume.events.length} event(s) replayed`,
      );
    }
    // Tombstone-first (dispatch/record.ts): a provisional interrupted record
    // the moment the run loop owns the run; the finish write replaces it.
    writeTombstone(deps, {
      msg,
      agent,
      profile,
      resolved,
      repoCtx,
      channelVisibility,
      run,
      registry,
      resume,
      ...(route !== undefined ? { route } : {}),
      parentRunId,
      coordinator,
      seed,
    });
    // The ledger claim (dispatch/run.ts), once the prompt exists: the reserved
    // row promoted, or a resume's adopted row re-subscribed.
    ledgerRun = await claimRun(deps, {
      msg,
      agent,
      profile,
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
      route,
      clock,
      root,
      parentRunId,
      coordinator,
      seed,
      ...(session ? { seedLog: session.log } : {}),
    });
    // The run's reach into its own session log (session-log item 10): the
    // `recall` and `notes` tools over the row's place in the log, once the
    // claim set it; a run without a session (untracked, a ship pipeline, no
    // ledger) has none and the tools say so.
    const sessionTools = sessionCapabilityFor(
      ledgerRun,
      deps.runLedger,
      deps.artifacts
        ? {
            read: () => readThreadAssets({ runs: runsService, store: deps.artifacts! }, msg.threadKey),
            pathOf: (key) => workspaceFiles.pathOf(key),
          }
        : undefined,
    );
    // What this run may do to other runs (dispatch/spawn.ts; docs/reference/specs/
    // agent-conductor.md): spawn a child as this run, read the runs its
    // REQUESTER may, steer a child through the inbox a thread reply takes, and
    // wait on its children within its own clock. Only a toolset that holds the
    // run tools reaches any of them.
    const { spawn, runs, steer, wait } = runToolCapabilities(
      { core: deps, dispatch, registry, clock },
      {
        runId: run.id,
        depth: parent?.depth ?? 0,
        agentName: agent.name,
        msg,
        io,
        control: run.control,
        inbox: admitted.inbox,
      },
    );
    // The agent loop (dispatch/runLoop.ts): the model turn, the follow-up inbox,
    // the settle and the post-steps, the finish. A throw propagates to the
    // outer catch after the workspace is released.
    const ran = await runLoop(deps, {
      msg,
      io,
      agent,
      profile,
      resolved,
      stagingIndex: nextStagedIndex,
      workspaceFiles,
      messages,
      system,
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
      requestText: directives.text,
      card,
      shell,
      doneLines,
      clock,
      root,
      startedAt,
      loopStartedAt,
      channelVisibility,
      publishText,
      ending,
      spawn,
      runs,
      steer,
      wait,
      ...(sessionTools ? { session: sessionTools } : {}),
      ...(route !== undefined ? { route } : {}),
      parentRunId,
      coordinator,
      seed,
      ...(bearer !== undefined ? { bearer } : {}),
    });
    if (ran.kind === "interrupted") {
      // The run was interrupted, not failed (harness.md item 7): the harness's
      // container was replaced under the live run (harness-pi item 16), or the
      // resumed row's harness facts were another harness's. The run loop
      // closed the run `interrupted` with the note that says why and its card
      // says it restarts, so no failure reply lands here. Its request runs
      // again as a new run once the outer finally frees the thread — the path
      // a refused re-attach takes (item 54), and the same outcome for the
      // request: the interruption's refusal by name, never a failure.
      refused = true;
      ended.refusal ??= ran.refusal;
      restartRequest = ran.restart;
      console.log(`[dispatch] ${msg.threadKey} run ${run.id} restarts from its request: ${ran.note}`);
      return ended;
    }
    const { answer, prNote, toolCalls, runDiagnosis, checklistAsLeft, checklistCheckedOff, releaseWorkspace } = ran;

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
      checklistAsLeft,
      checklistCheckedOff,
      doneLines,
      runDiagnosis,
      releaseWorkspace,
      root,
    });
    if (delivery.kind === "fenced") return ended;

    // After the reply (dispatch/reply.ts): the memory reflection pass. The
    // review post-step ran inside the run loop, before the stream finished.
    afterReply(deps, {
      msg,
      resolved,
      directives,
      history,
      repoCtx,
      run,
      channelVisibility,
      referenceVisibilities: references.visibilities,
      stopped,
      answer,
      toolCalls,
    });
    return ended;
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
        () =>
          root.span(replyName, () => {
            // The failure reply carries the run link when a run started: the
            // card scrolls away, and a failed run's transcript should be one
            // click from the thread.
            const line = redactSecrets(stripAnsi(errorReply(err)));
            const link = admitted?.runLink;
            return io.reply(link ? `${line}\n\n[Live run](${link})` : line);
          }),
      )
      .catch(() => {});
  } finally {
    clearInterval(setupHeartbeat); // a refusal or a setup failure ended the request before the run loop took the card
    // The backstop: a finished run no reply attempt reached (a fenced run, a
    // branch that returned early) is sealed with no `replyOk`, and any record
    // still registered is written.
    ending.drain(undefined);
    // …and a bearer minted for a run that never reached its loop (a head gate
    // after the attach, a throw in the prompt) is revoked here — the ending's
    // hook ran only for a run the loop finished.
    if (registered) deps.runBearers?.revoke(registered.id);
    // A resumed dispatch that ended before its run loop started — an unknown
    // provider, a refusal, a gate — has adopted a row it will never finish
    // (item 38). Close it `interrupted` here, or the sweep would relaunch it
    // every lease interval forever.
    if (resume && ledgerRun && !runLoopStarted && !resumeRowClosed) {
      const adopted = ledgerRun;
      await root.span("post.history_write", () =>
        closeResumedRow(adopted, resume, "the resumed dispatch ended before the run started"),
      );
      console.log(
        `[resume] ${msg.threadKey} run ${resume.row.runId} closed interrupted: the resumed dispatch ended before the run started`,
      );
    }
    // Thread admission (dispatch/settle.ts; docs/reference/specs/thread-admission.md item 4):
    // free the thread, and settle what the run never consumed — handed on as
    // ONE fresh turn when the run ended by itself, dropped with a note to each
    // sender when an operator stopped it. The fresh turn is an ordinary
    // dispatch: it claims the thread itself, and a follow-up arriving during it
    // steers into it.
    const settled = settleThread(deps, { msg, admitted, runLoopStarted, control: registered?.control });
    if (settled.kind === "dropped") await tellDropped(root, settled.pending);
    const stopMode = settled.kind === "handed-on" ? undefined : settled.stopMode;
    // The request is over: its root ends here, after the seal and the tail,
    // with how it went — before the fresh turn below starts a root of its own.
    // The same status is the caller's outcome.
    ended.status = caught ? "failed" : refused ? "refused" : stopMode ? "stopped" : "completed";
    root.end(caught ? "error" : "ok", { status: ended.status });
    if (restartRequest) {
      // The run's request, dispatched again as a new run now that the thread
      // is free — a resumed run whose workspace could not be re-attached (item
      // 54), or a live run whose pi container was replaced under it
      // (harness-pi item 16) — with the follow-ups the run never consumed
      // appended, as a fresh turn would carry them, and the closed run named
      // so admission never steers the request into its row: the finish above
      // is still in flight, and the boot-gap map may still list the run.
      const pending = settled.kind === "handed-on" ? settled.pending : [];
      const restart = prepareRestartTurn(deps, {
        request: restartRequest.request,
        pending,
        clock,
        ...(restartRequest.restartOf !== undefined ? { restartOf: restartRequest.restartOf } : {}),
      });
      await dispatch(deps, restart.msg, io, restart.opts).catch((err: unknown) =>
        console.error(
          `[dispatch] ${msg.threadKey} restart from the request failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    } else if (settled.kind === "handed-on") {
      const fresh = prepareFreshTurn(deps, { agent: settled.agent, pending: settled.pending, clock });
      await dispatch(deps, fresh.msg, fresh.io, fresh.opts).catch((err: unknown) =>
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
  // Reached from the catch alone (every path in the try returns): the failed
  // request's outcome, its status stamped by the finally above.
  return ended;
}
