import { getAgent } from "../agents/registry.js";
import { declaredProfile } from "../config/profile.js";
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
import { answerChatCommand, answerOperation, type FastPathDeps } from "./dispatch/fastPath.js";
import { readRequest, resolveRun, resolveTarget, type ResolveDeps } from "./dispatch/resolve.js";
import {
  authorizeAgent,
  authorizeAttachedHead,
  authorizePrHead,
  authorizeRepo,
  type AuthorizeDeps,
} from "./dispatch/authorize.js";
import { buildMessages } from "./dispatch/messages.js";
import {
  attachWorkspace,
  composePrompt,
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
import { prepareFreshTurn, settleThread, tellDropped } from "./dispatch/settle.js";
import type { IssueTracker } from "../execution/githubIssues.js";
import { defaultRunRegistry, type RunHandle } from "./runRegistry.js";
import type { CardShell } from "./statusCardFrame.js";
import { createRunEnding } from "./runEnding.js";
import type { ChannelIO, IncomingMessage, StatusHandle } from "./types.js";

// The dispatcher is the channel-agnostic core: config commands, directive
// parsing, layered resolution, permission gates, history assembly, executor
// selection, and the agent run. Channels are pure transports (src/channels/).

export interface CoreDeps
  extends
    AdmissionDeps,
    FastPathDeps,
    ResolveDeps,
    AuthorizeDeps,
    ProvisionDeps,
    RunDeps,
    ReplyDeps,
    RecordDeps,
    ShipDeps {
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
    // The run's effective profile (docs/decisions/0026-capability-profiles-and-request-routing.md):
    // the machine class, identity and budget every stage below reads — the
    // factory, the ledger row, the runner — never the preset's own fields.
    const profile = declaredProfile(agent);

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
      profile,
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
      profile,
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
    const { run, runId, channelVisibility, liveUrl, publishText, publishMeta } = registration;
    registered = run;
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
      profile,
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
    if (headGate.headAdopted) publishMeta(repoCtx);

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
    const loopStartedAt = clock();
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
      profile,
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
      loopStartedAt,
      channelVisibility,
      publishText,
      ending,
    });
    const {
      answer,
      verdict,
      digest,
      observedHead,
      carried,
      prNote,
      toolCalls,
      runDiagnosis,
      checklistAsLeft,
      checklistCheckedOff,
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
      checklistAsLeft,
      checklistCheckedOff,
      doneLines,
      runDiagnosis,
      releaseWorkspace,
      root,
    });
    if (delivery.kind === "fenced") return;

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
      digest,
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
    root.end(caught ? "error" : "ok", {
      status: caught ? "failed" : refused ? "refused" : stopMode ? "stopped" : "completed",
    });
    if (settled.kind === "handed-on") {
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
}
