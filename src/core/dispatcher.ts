import { runSessionIdentity } from "./dispatch/sessionIdentity.js";
import { resumedPilotBindingFor } from "./dispatch/readyBinding.js";
import { appendThreadTurn } from "./runLedger/threadSession.js";
import { contextAccessForMessage, contextAccessForRun, revalidateAdmittedContext } from "./dispatch/contextAccess.js";
import { contextForReferences, contextForSourceReads, freshContext } from "./dispatch/contextSeed.js";
import { applyContextCheckpoint, type ContextCheckpointReceipt } from "./references/contextCheckpoint.js";
import {
  contextDependenciesOf,
  mergeContextDependencies,
  UNKNOWN_CONTEXT_DEPENDENCIES,
  type ContextDependencies,
} from "./references/contextDependencies.js";
import { readOperatorNotes } from "./dispatch/operatorNotes.js";
import { readOperatorMemory } from "./dispatch/operatorMemory.js";
import { reflectionActor } from "./memory/index.js";
import { readOperatorTailContext } from "./dispatch/operatorTail.js";
import { isChildHandoff, type ChildHandoff, type HandoffConsumer, type ParentContext } from "./dispatch/handoff.js";
import { validateChildHandoff } from "./dispatch/handoffValidation.js";
import { contextCapsuleOf, type UnitContext, type UnitContextBinding } from "./dispatch/unitContext.js";
import { capturePrivateWorkContext } from "./dispatch/mainContextCapture.js";
import type { HandoffAccess, HandoffAccessFactory } from "./dispatch/handoffRuntime.js";
import { isBudgetAnswer } from "./answerOutcome.js";
import {
  audienceRefusalOf,
  audienceRefusalText,
  noteAudienceRefusal,
  type AudienceCheck,
  type AudienceRefusalCode,
  type AudienceTrace,
} from "./audienceDecision.js";
import { sourceBinding, type SessionSources } from "./references/receipts.js";
import { configuredAgent } from "../config/agents.js";
import { isRunProfile } from "../config/profile.js";
import { MINUTE_MS, minutesToMs } from "./budgets.js";
import type { LedgerRun } from "./runLedger/writeThrough.js";
import { settleRetryPause } from "./runLedger/threadsElsewhere.js";
import { TerminalCommitmentUnknownError } from "./runLedger/writeThrough.js";
import { systemClock } from "./trace/index.js";
import type { SpanSink, Tracer } from "./trace/types.js";
import type { SpanLog } from "./trace/spanLog.js";
import type { RunOwner } from "./trace/streamSpans.js";
import { assignRunLiveState, type ResidentLiveStateObservation } from "./runLiveState.js";
import { assignLedgerLiveState } from "./runLedger/decisions.js";
import { liveStateWords } from "./plane/decide.js";
import { channelOf, startRequestRoot, type RequestTrace } from "./requestTrace.js";
import { cardShapeLineOf, queuedCaption } from "./runShape.js";
import { barePrNumberOf, explicitPrOf, type RepoContext, type OperationTarget } from "./repoContext.js";
import { redactSecrets, type StopMode } from "./runEvents.js";
import { oneLine, redactAndCap, stripAnsi } from "./redact.js";
import type { LiveThread } from "./threadAdmission.js";
import type { RecordDeps } from "./dispatch/record.js";
import { cardLines, errorReply, renderRefusal, replyAck, REFUSAL_SENTENCES } from "./dispatch/reply.js";
import type { Verbosity } from "./verbosity.js";
import { causeOf, refusalOf, RefusalError, type Refusal, type RefusalCause, type RefusalCode } from "./refusal.js";
import {
  admit,
  adoptCarriedRun,
  closeResumedRow,
  defaultAdmission,
  foldCarriedInbox,
  STEER_OWNER_REFUSED,
  type AdmissionContext,
  type AdmissionDeps,
  type DispatchFollowUp,
  type RestartContext,
  type ResumeContext,
} from "./dispatch/admission.js";
import { answerChatCommand, type FastPathDeps } from "./dispatch/fastPath.js";
import { actorIdsOf, cancelPending, consumeAndRun, OFFER_CONTEXT_LINE, REFUSED_REASON } from "./dispatch/confirm.js";
import type { PrWorkBinding } from "./ship/prWorkBinding.js";
import {
  postSettledOutcome,
  recordOperatorDecision,
  recordRefusal,
  recordRoutedDecision,
} from "./dispatch/commandRun.js";
import { COMMAND_RUN_AGENT } from "./runOwner.js";
import { redactedInput } from "./dispatch/route.js";
import type { Actor, ChannelVisibility } from "./authz/types.js";
import {
  NO_REFERENCES,
  readReferences,
  REFERENCE_REFUSAL,
  referenceRefusalCode,
  type ReferenceDeps,
} from "./dispatch/references.js";
import { authorize } from "./authz/authorize.js";
import { chatActorOf, resolveChatActor } from "./authz/actor.js";
import { operatorModeOf, referencesOn } from "../config.js";
import { parseChatCommand } from "./commandChat.js";
import { parseDirectives } from "../directives.js";
import {
  readRequest,
  resolveProfile,
  resolveRepoTarget,
  resolveRun,
  resolveTarget,
  type ResolveDeps,
} from "./dispatch/resolve.js";
import { compoundBrief, type RouteDecided, type RouteModel } from "./dispatch/route.js";
import type { ProviderTable } from "./harness/piAi.js";
import {
  executeOperatorDecision,
  answeredRepositoryTarget,
  checkpointRequesterMessageTarget,
  isYesAnswer,
  joinedAnswerRequest,
  operatorStage,
  pendingQuestionOf,
  type OperatorEventFields,
  type OperatorBind,
  type OperatorThreadOwner,
} from "./dispatch/operator.js";
import type { ProviderModelsReader } from "./dispatch/providerModels.js";
import type { PrBatchBinding } from "./prBatchBinding.js";
import type { IntakeVerdict } from "./intake.js";
import type { McpToolSource } from "../mcp/source.js";
import {
  authorizeAgent,
  authorizeAttachedHead,
  authorizePrHead,
  authorizeProfile,
  authorizeRepo,
  authorizeSteerOwner,
  type AuthorizeDeps,
} from "./dispatch/authorize.js";
import { effectiveGrants } from "./authz/authorize.js";
import { buildConversation, textTurnsOf, type TextTurn } from "./dispatch/messages.js";
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
import { RUN_LIST_MAX_LIMIT, type RunFailure, type RunRecord, type RunSeed } from "./runRecord.js";
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
import { claimRun, githubCapabilityFor, type RunDeps } from "./dispatch/run.js";
import { bindSlackContext, sourceIntakeFor, type SlackContextBinding } from "./dispatch/slackContextBinding.js";
import {
  privateAudienceRequired,
  privateAudienceDecision,
  recoveredPrivateAudienceLatch,
  revalidateSavedSlackContextDecision,
  savedSlackContextNeedsRecheck,
} from "./dispatch/privateAudience.js";
import { directAudienceStampOf } from "./runLedger/inboxMessage.js";
import { parsePrivateWorkerThreadKey } from "./privateWorkerLog.js";
import { runLoop } from "./dispatch/runLoop.js";
import { afterReply, deliverAnswer, type ReplyDeps } from "./dispatch/reply.js";
import { mainAudienceAtPrompt, mainAudienceAtReply, planeRowIdentities } from "./dispatch/mainAudience.js";
import { createSourceReads } from "../mcp/sourceRead.js";
import { readThreadWorkEvidence } from "../tools/threadWork.js";
import { predicateFor } from "./authz/predicate.js";
import { channelVisibilityOf, finishSetupRun, writeTombstone } from "./dispatch/record.js";
import {
  namesOriginalUnitRecovery,
  parseOriginalUnitAdoptionRequest,
  parseOriginalUnitRecoveryRequest,
  runShipBranch,
  type ShipContext,
  type ShipDeps,
} from "./dispatch/ship.js";
import { fetchInstanceStatusViaShim, processShimOptions } from "./coordinator/instancesClient.js";
import { shipPresetFor } from "./shipPipeline.js";
import { resolveAddressSeverity } from "./reviewVerdict.js";
import { closedReviewPreflight, type RoundWorkspace } from "./reviewRound.js";
import { DEFAULT_CONTRACT_MAX_CHARS, renderContract, type ChildContract } from "./ship/contract.js";
import { withContractInFirstUserTurn } from "./ship/codingChild.js";
import { acknowledgeUnitSeed } from "./dispatch/unitSeedProof.js";
import { prepareFreshTurn, settleThread, tellDropped } from "./dispatch/settle.js";
import {
  abandonLostWorkspace,
  announceChildRoll,
  carriedCoordinatorTag,
  carriedOperationTarget,
  carriedRunIdentity,
  carriedRepoContext,
  restartEvidenceOf,
  carriedWorkspaceBinding,
  hasPilotWorkspaceBinding,
  prepareRestartTurn,
  recordRestartDeath,
  type CarriedRunIdentity,
} from "./dispatch/reattach.js";
import { prepareColdPublicationCheckout, workspaceBindingFor, workspaceBindingOf } from "../execution/factory.js";
import { readyEnvironmentCommand, type ReadyEnvironmentRequirement } from "../execution/seedPlan.js";
import { fleetBusyEndingFactsOf, fleetBusyRunEndedLine } from "../execution/sandboxErrors.js";
import { lineageOf, lineageParent, tellParent, type LineageHeard } from "./dispatch/lineage.js";
import { sessionSeedFor } from "./dispatch/seed.js";
import { sessionCapabilityFor } from "../tools/session.js";
import {
  endedPipelineForPrOf,
  establishedMainDmOf,
  PrOwnerConflictError,
  newestFinishedRunOf,
  ownerOf,
  readThread,
  readPrOwnerThread,
  releasedPrOf,
  requesterOf,
  stickyAgentOf,
  threadPrOf,
  threadRouteOf,
  type ThreadOwner,
  type ThreadPullRequest,
} from "./dispatch/thread.js";
import { threadArtifactsFor } from "./dispatch/threadArtifacts.js";
import { describeAsset, readThreadAssets, type ThreadAsset } from "./dispatch/threadAssets.js";
import { runToolCapabilities, type ParentRun } from "./dispatch/spawn.js";
import { createRunsService, type RunsService, type RunView } from "./runsService.js";
import {
  unitKeyOf,
  unitNudgeEventType,
  unitOfIdempotencyKey,
  type CoordinatorTag,
  type CoordinatorUnit,
} from "./coordinator/contract.js";
import type { DispatchOutcome } from "./dispatch/outcome.js";
import type { IssueTracker } from "../execution/githubIssues.js";
import { defaultRunRegistry, type RunHandle } from "./runRegistry.js";
import type { CardShell } from "./statusCardFrame.js";
import { createRunEnding } from "./runEnding.js";
import { shipTaskText, shipUnitText } from "./ship/preflight.js";
import { messageIdOf, type ChannelIO, type IncomingMessage, type StatusHandle } from "./types.js";
import {
  DECISION_RECORD_STORE_REFUSAL,
  DecisionRecordReservationUnavailableError,
  asksForDecisionRecord,
  decisionRecordTaskKey,
} from "./decisionRecordReservation.js";

// The dispatcher is the channel-agnostic core: config commands, directive
// parsing, layered resolution, permission gates, history assembly, executor
// selection, and the agent run. Channels are pure transports (src/channels/).

async function priorDecisionRecord(
  store: CoreDeps["runStore"],
  threadKey: string,
  repo: string,
  taskKey: string,
): Promise<string | undefined> {
  let before: number | undefined;
  let beforeId: string | undefined;
  for (;;) {
    const rows = await store.list({
      threadKey,
      agent: "coding",
      limit: RUN_LIST_MAX_LIMIT,
      ...(before !== undefined ? { before, beforeId } : {}),
    });
    const match = rows.find((row) => row.repo === repo && row.recordTaskKey === taskKey && row.record !== undefined);
    if (match?.record !== undefined) return match.record;
    if (rows.length < RUN_LIST_MAX_LIMIT) return undefined;
    const last = rows.at(-1)!;
    if (last.finishedAt === before && last.id === beforeId) return undefined;
    before = last.finishedAt;
    beforeId = last.id;
  }
}

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
    ReferenceDeps,
    ShipDeps {
  /** The MCP tool source required for provisioning every run. */
  mcp: McpToolSource;
  /** Canonical context storage and current source authorization. */
  handoffAccessForRun?: HandoffAccessFactory;
  /** The configured providers used to build the one door's model call. */
  completions: ProviderTable;
  /** The operator's model call (record 0057; routing-and-config item 29).
   *  Default: the provider behind the resolved operator model. Tests script one. */
  operatorModel?: RouteModel;
  /** The providers catalogue behind the loop's `provider_models` read tool
   *  (issue 2088): the refs this deployment can run, so a write proposal
   *  names a real one. Absent, the tool answers its no-reader fallback. */
  providerModels?: ProviderModelsReader;
  /** The one runs service (`RunDeps.runs`): the run tools, the thread read and stage A's paste check
   *  (record 0044) all read it — declared here so the two bases that name it agree. */
  runs?: RunsService;
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

/** A plain reply into a thread an unfinished unit owns (record 0051's reply-as-event and gone-instance rules):
 *  the message becomes one thread event on the unit's list — the mode read
 *  off the owner's state, `steer` between rounds — the instance is nudged
 *  through the shim's event relay, and the sender is acked with where the
 *  message went; the router is never called. `route-fresh` when the instance
 *  is gone — the relay's "no such instance", or a status of complete, errored
 *  or terminated — with the row ended `terminated` and the thread told, or
 *  when no durable store could hold the event: the request runs on as if the
 *  thread were unowned. Any other send failure keeps the event appended and
 *  acks it as queued for the pipeline's next step (which reads the unconsumed
 *  list whether or not a nudge arrived), and nothing routes fresh. */
async function answerUnitOwnedThread(
  deps: CoreDeps,
  ctx: {
    msg: IncomingMessage;
    io: ChannelIO;
    /** The directive-free text — what the pipeline's next step folds in. */
    text: string;
    owner: { instanceId: string; unit: CoordinatorUnit };
    clock: () => number;
    /** The request's level (routing-and-config item 28): the ack is `verbose` material. */
    verbosity: Verbosity;
  },
): Promise<"acked" | "route-fresh"> {
  const { msg, io, owner } = ctx;
  const store = deps.coordinatorInstances!;
  const key = { instanceId: owner.instanceId, unit: owner.unit.unit };
  const unitKey = unitKeyOf(key);
  const at = ctx.clock();
  // No run exists here, so the event's id is the platform's own message id when the channel gave one.
  const messageId = msg.messageId;
  // The mode is a receipt of the owner's state at append (record 0051), never
  // the text's: an idle owner receives a wake; between rounds it is a steer.
  // The store's append enforces the per-event cap.
  const attachments = [...(msg.images ?? []), ...(msg.documents ?? [])].map((a) => ({
    mediaType: a.mediaType,
    data: a.data,
    ...(a.name !== undefined ? { name: a.name } : {}),
  }));
  // No durable store to hold the event — the null store's `unavailable`, or
  // the Worker store's throw on a failed call (a 5xx, a timeout, a body it
  // cannot read): the thread cannot be owned durably, so the request runs as
  // today rather than vanish, unacked and unrouted, into the adapter's error path.
  const appended = await store
    .appendEvent(key, {
      ...(messageId !== undefined ? { id: messageId } : {}),
      sender: msg.userId,
      ...(msg.userName !== undefined ? { senderName: msg.userName } : {}),
      text: ctx.text,
      ...(attachments.length > 0 ? { attachments } : {}),
      mode: owner.unit.idle !== undefined ? "wake" : "steer",
      at,
    })
    .catch((err: unknown) => {
      console.warn(
        `[dispatch] ${msg.threadKey}: unit ${unitKey} event append failed (${err instanceof Error ? err.message : String(err)}) — routing fresh`,
      );
      return { ok: false as const, reason: "unavailable" as const };
    });
  if (!appended.ok) return "route-fresh";
  // The nudge (record 0051): every append nudges, so the send doubles as the liveness probe.
  try {
    if (deps.workflow === undefined) throw new Error("no workflow sender in this process");
    const workflowId = owner.unit.recovery?.workflowId ?? owner.instanceId;
    const handle = await deps.workflow.get(workflowId);
    await handle.sendEvent({ type: unitNudgeEventType(key), payload: {} });
  } catch (err) {
    // The gone instance (record 0051): the relay's "no such instance", or an instance that already ended,
    // ends the row `terminated` — the thread is unowned from then on — and
    // the message routes fresh. The engine's refusal texts vary, so the
    // instance's own status route decides, fail-safe: unanswered is a send
    // failure, never an absence. The reader is the injected one when a test
    // wires it, else the process's own shim — the same address the ship
    // branch creates and reads instances at — so production reaches the route.
    const readStatus =
      deps.fetchCoordinatorInstanceStatus ?? ((id: string) => fetchInstanceStatusViaShim(processShimOptions(), id));
    const workflowId = owner.unit.recovery?.workflowId ?? owner.instanceId;
    const status = await readStatus(workflowId);
    const gone =
      status.kind === "absent" ||
      (status.kind === "status" && ["complete", "errored", "terminated"].includes(status.status));
    if (gone) {
      const why = status.kind === "absent" ? "no such instance" : status.status;
      if (owner.unit.recovery !== undefined) {
        const recovery = owner.unit.recovery;
        const { recovery: _recovery, ...withoutRecovery } = owner.unit;
        const closed = {
          ...withoutRecovery,
          recoveryReceipt: {
            ...(recovery.kind === "coding"
              ? { codingRunId: recovery.codingRunId }
              : { reviewRunId: recovery.reviewRunId }),
            workflowId: recovery.workflowId,
            at,
          },
          ending: {
            kind: "terminated",
            report: `the original-unit recovery checkpoint is gone (${why}); no replacement pipeline was started`,
            at,
          },
        };
        const replaced = await store.compareAndReplaceUnit(owner.unit, closed).catch(() => undefined);
        if (replaced?.ok !== true) {
          await replyAck(
            io,
            ctx.verbosity,
            `📌 Noted for unit ${owner.unit.unit} (\`${unitKey}\`): its recovery checkpoint is gone, but the durable claim could not be closed safely — your message remains queued and no replacement ran.`,
          );
          return "acked";
        }
        await store
          .markConsumed(key, [appended.seq], `recovery-terminal:${recovery.workflowId}`)
          .catch(() => undefined);
        await io.reply(
          `⚠️ Unit ${owner.unit.unit}'s original-unit recovery checkpoint \`${recovery.workflowId}\` is gone (${why}). The claim is closed; this message did not start replacement work.`,
        );
        return "acked";
      }
      const settled = await store.putUnits([
        {
          ...owner.unit,
          ending: {
            kind: "terminated",
            report: `the plan runner instance is gone (${why}) — the thread is unowned from here`,
            at,
          },
        },
      ]);
      if (!settled.ok) {
        await io.reply(`Unit ${unitKey}'s ending could not be recorded; this message started no replacement work.`);
        return "acked";
      }
      console.log(`[dispatch] ${msg.threadKey}: unit ${unitKey} ended terminated (${why}) — routing fresh`);
      await io.reply(
        `⚠️ Unit ${owner.unit.unit}'s plan runner instance \`${owner.instanceId}\` is gone (${why}) — the unit's row is closed and this message runs fresh.`,
      );
      return "route-fresh";
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[dispatch] ${msg.threadKey}: unit ${unitKey} nudge failed (${reason}) — event ${appended.seq} stays queued`,
    );
    await replyAck(
      io,
      ctx.verbosity,
      `📌 Noted for unit ${owner.unit.unit} (\`${unitKey}\`): the pipeline could not be nudged — your message is queued for its next step.`,
    );
    return "acked";
  }
  console.log(`[dispatch] ${msg.threadKey}: event ${appended.seq} appended to unit ${unitKey}, instance nudged`);
  await replyAck(
    io,
    ctx.verbosity,
    `📌 Noted for unit ${owner.unit.unit} (\`${unitKey}\`) — the pipeline folds it into its next step.`,
  );
  return "acked";
}

// In-flight run tracking so the process can drain before exiting (restarts
// must not kill runs mid-flight — see index.ts signal handling).
let activeRuns = 0;

export function activeRunCount(): number {
  return activeRuns;
}

export interface DispatchOptions {
  /** Trusted original action clock, without inventing run lineage. */
  parentRemainingMs?: number;
  /** The original action's absolute deadline. A sampled remainder cannot
   * renew this bound while authorization, reservation or setup awaits. */
  parentDeadlineAt?: number;
  /** The parent's admitted operation target, not a prompt hint. Reviews keep
   * their independently resolved PR target; ordinary authorization still runs. */
  operationTarget?: OperationTarget;
  resume?: ResumeContext;
  restart?: RestartContext;
  /** Set by a channel adapter whose intake gate already read the thread's runs
   *  page (record 0058, R2; docs/reference/specs/slack-channel.md item 15):
   *  used in place of `readThread`, so the page is read once per reply.
   *  Absent for every other request. */
  thread?: RunView[];
  /** The intake gate's verdict for this reply (record 0058), when the channel
   *  adapter ran the gate: the operator's shadow row carries it (record 0057),
   *  so the shadow log says what the gate said beside what the operator bound. */
  intake?: { verdict: IntakeVerdict; reason: string };
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
   *  that run's inbox: it runs fresh in the thread. Absent for
   *  every other request. */
  restartOf?: string;
  /** Set beside `restartOf` when the closed run's registry row could still be
   *  read (run-history item 54): the restart keeps the run's identity — the
   *  same id, the same capability token, the predecessor's events replayed —
   *  so the page a person opened, the posted links and the ledger row stay
   *  valid across the replacement, and every list counts one run. Absent, the
   *  restart runs under a fresh id. */
  restartCarried?: CarriedRunIdentity;
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
  /** Structured evidence must be proven against its durable source before seed. */
  parentContext?: ParentContext;
  /** A previously bound immutable manifest restored from the original run. */
  childHandoff?: ChildHandoff;
  /** Trusted coordinator identity for its previously captured immutable context. */
  unitContextAdmission?: UnitContextBinding;
  /** Set by the coordinator's spawn route alone (src/channels/adminCoordinator.ts;
   *  run-history item 48): this request is a coordinator instance's child —
   *  the instance and the idempotency key ride every row the run has, and a
   *  run in flight on the thread refuses the request instead of taking it as
   *  a steer (thread-admission item 8). Absent for every other request. */
  coordinator?: CoordinatorTag;
  /** A recovered original unit's immutable execution boundary. The dispatcher
   * independently resolves review targets, so it must prove that resolution is
   * still the claimed PR/ref/base/head before provisioning or model spend. */
  recovery?: {
    repo: string;
    pr: number;
    headRef: string;
    baseRef: string;
    expectedHeadSha: string;
    deadlineAt: number;
  };
  /** Set by the coordinator's spawn route for a plan unit's child (agent-ship
   *  item 13): the unit's contract, rendered once here — into a coding child's
   *  first user turn as its own text part, into a review child's system prompt
   *  after the REVIEW TARGET block — so both children hold one object. Absent
   *  for every other request. */
  contract?: ChildContract;
  /** Set by `dispatchClick` alone, for a Yes on a question's `redispatch` row
   *  (record 0054): the question's refusal code — the run's record names it
   *  in a `run_note` ([run-history.md](../../docs/reference/specs/run-history.md) item 2)
   *  — and the click's one drain slot is handed over: this dispatch counts no
   *  second one. Absent for every other request. */
  redispatch?: { code: string; binding?: PrWorkBinding };
}

/** How a request ended, for whoever started it (dispatch/outcome.ts): the
 *  request's status and, when a gate ended it, that gate's name — what a
 *  spawning parent relays to its model as a named tool result. */
export type { DispatchOutcome } from "./dispatch/outcome.js";

type LiveCommitFailure = {
  ok: false;
  kind: "missing-run" | "durable-rejection" | "durable-unavailable" | "projection-rejection";
  reason: string;
};

class LiveStateCommitError extends Error {
  constructor(stage: string, failure: LiveCommitFailure) {
    super(
      `The ${stage} live state ${failure.kind === "durable-unavailable" ? "could not be confirmed" : "was refused"}: ${failure.kind} (${failure.reason}).`,
    );
  }
}

/** A reclaimed pilot uses its saved admission check, not a later config edit. */
function recordedReadyRequirement(value: unknown): ReadyEnvironmentRequirement | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => !["testCommand", "dependencyDir", "requiredTools", "firstAction"].includes(key)))
    return undefined;
  try {
    const requirement = value as ReadyEnvironmentRequirement;
    readyEnvironmentCommand("/workspace", requirement);
    return {
      ...(requirement.testCommand !== undefined ? { testCommand: requirement.testCommand } : {}),
      dependencyDir: requirement.dependencyDir,
      requiredTools: [...requirement.requiredTools],
      ...(requirement.firstAction ? { firstAction: { ...requirement.firstAction } } : {}),
    };
  } catch {
    return undefined;
  }
}

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
  let incomingHandoff: unknown =
    opts.parentContext !== undefined
      ? (opts.parentContext.handoff ?? null)
      : opts.childHandoff !== undefined
        ? opts.childHandoff
        : (resume?.row.meta.childHandoff ?? restart?.row.meta.childHandoff);
  let hasHandoff = incomingHandoff !== undefined;
  let continuedHandoff = false;
  const handoffFactory = deps.handoffAccessForRun ?? contextAccessForRun(deps);
  const contextReader = contextAccessForMessage(deps, { msg, io });
  let operatorContext = freshContext();
  let memoryContext = freshContext();
  let boundHandoff: ChildHandoff | undefined;
  let handoffAccess: HandoffAccess | undefined;
  let handoffConsumer: HandoffConsumer | undefined;
  // Recovery authority is a durable fact of the coordinator child, not a
  // process-local spawn option. A resume/restart rebuilds the full boundary
  // from the run's coordinator event before any profile or target decision.
  const coordinator =
    opts.coordinator ??
    (resume
      ? carriedCoordinatorTag(resume.row, resume.events)
      : restart
        ? carriedCoordinatorTag(restart.row, restart.events)
        : undefined);
  const recovery = opts.recovery ?? coordinator?.recovery;
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
  // The count's first home (record 0054): the code and its cause on the
  // refuse span AND the request's root, so the telemetry query the forensics
  // recipe uses can count refusals from root spans alone.
  const stampRefusal = (outcome: RefusalCode): RefusalCause => {
    refused = true;
    const cause = causeOf(outcome);
    ended.refusal ??= outcome;
    ended.cause ??= cause;
    root.setAttrs({ refusal: outcome, cause });
    return cause;
  };
  // Every refusal is a run record (record 0054, as amended): one `door` record
  // per request — written after the sentence on the same `dispatch.refuse`
  // span, and never twice when the catch-all follows a gate that already
  // recorded (a setup failure's silent close, then its error reply).
  let refusalRecorded = false;
  let operatorEvent: OperatorEventFields | undefined;
  let setupFinalizer: (() => void) | undefined;
  let setupRefusal: Refusal | undefined;
  let setupFailure: RunFailure | undefined;
  let setupFinished = false;
  let setupTerminalHeld = false;
  let setupUntrackedWhy: string | undefined;
  const audienceTrace: AudienceTrace = { refusal: audienceRefusalOf(resume?.row.state.audienceRefusal) };
  const recordRefusalOnce = async (refusal: Refusal) => {
    if (refusalRecorded) return;
    refusalRecorded = true;
    if (setupFinalizer && !runLoopStarted) {
      setupRefusal ??= refusal;
      return;
    }
    await recordRefusal(deps, msg, io, refusal, ending, trace, operatorEvent, audienceTrace.refusal);
    operatorEvent = undefined;
  };
  // A gate refusal is the site's `Refusal` — its own sentence, the cause from
  // the one table — stamped, the side work (a card close, a release) run
  // inside the span, the sentence rendered by the ONE renderer, and the
  // decision recorded as a `door` run.
  const refuse = async (refusal: Refusal, side?: () => Promise<void>) => {
    if (audienceTrace.refusal) {
      const writer = ledgerRun ?? reserved;
      if (writer && (await writer.commitState({ audienceRefusal: audienceTrace.refusal })) === "fenced") {
        fencedWhileAttaching = true;
        return;
      }
    }
    const cause = stampRefusal(refusal.code);
    await root.span(
      "dispatch.refuse",
      async () => {
        await side?.();
        // The store rides along so a question with a guess can mint its Yes
        // (record 0054): the renderer offers Yes and No where the channel can
        // show them, and the line to type everywhere else.
        await renderRefusal(refusal, io, { confirmations: deps.confirmations });
        await recordRefusalOnce(refusal);
      },
      { attrs: { outcome: refusal.code, refusal: refusal.code, cause } },
    );
  };
  // A refusal nothing is said for — a coordinator spawn (the thread must not
  // hear a bot-to-bot retry), a lost workspace whose card says it, the
  // catch-all's card close (the error reply follows on its own path): stamped,
  // recorded and counted like any other, rendered by nobody — the record's
  // refusal event carries no sentence because none was said.
  const refuseSilently = <T>(outcome: RefusalCode, side: () => Promise<T>) => {
    const cause = stampRefusal(outcome);
    return root.span(
      "dispatch.refuse",
      async () => {
        const result = await side();
        await recordRefusalOnce(refusalOf(outcome, ""));
        return result;
      },
      { attrs: { outcome, refusal: outcome, cause } },
    );
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
  // milliseconds too — cheaper than a second gap. A redispatched request
  // (record 0054's Yes) arrives holding the click's slot: `dispatchClick`
  // counted it and decrements it after this dispatch returns, so counting it
  // again would read one click as two runs in flight.
  if (!opts.redispatch) activeRuns++;
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
  let setupReviewTarget: { repo: string; pr: number } | undefined;
  let decisionRecord: string | undefined;
  let decisionRecordTask: string | undefined;
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
  // The setup finalizer owns an advertised run until the model loop takes it.
  let runLoopStarted = false;
  // A successful attach belongs to this setup until the run loop takes it.
  // A failed setup releases an ordinary tree; a resumed pilot retains its
  // original checkout and row for recovery.
  let setupRound: RoundWorkspace | undefined;
  let attachedPilotResume = false;
  let pausePilotAfterAttach: ((message: string, options?: { nextAction?: string }) => Promise<void>) | undefined;
  // The ship fork ran, and whether its branch deliberately left its run live —
  // the hosted parent of a completed hand-off (record 0060). Read by the outer
  // finally's second net (run-history item 42), which finishes any run a
  // branch opened and left `running` behind it.
  let shipForked = false;
  let shipHostedLive = false;
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
  // A stop relayed during the attach that ended the attach itself (the attach's
  // wait for a transient refusal reads the run's signal, execution.md item 9):
  // the run never started, so `settleThread` reports no stop for it; this is
  // the mode the request's status reads instead.
  let stoppedWhileAttaching: StopMode | undefined;
  // A resumed run whose workspace could not be re-attached (run-history item
  // 54): its row was closed with the note that says why, and its request runs
  // again as a new run once this dispatch has freed the thread.
  let resumeRowClosed = false;
  // A readiness failure after re-attach retains the same row and workspace for
  // the next generation; the generic pre-loop closer must leave it alone.
  let resumeRowRetained = false;
  // The request to dispatch again as a new run once the thread is free (item
  // 54; harness-pi item 16), and the run it restarts — the one this dispatch
  // closed `interrupted`, which admission must never steer the request into
  // (thread-admission item 5). Undefined until a restart is decided.
  let restartRequest:
    | {
        request: IncomingMessage;
        restartOf?: string;
        note: string;
        coordinator?: CoordinatorTag;
        operationTarget?: OperationTarget;
        /** The `restarting` record the row was closed with (issue 2081): kept so
         *  a restart dispatch that dies before the successor's claim ends that
         *  record for real instead of leaving it answering still-running. */
        closed?: RunRecord;
        profile?: CarriedRunIdentity["profile"];
        branchIdentityBaseline?: unknown;
        pushedBranch?: unknown;
        identityUncertain?: boolean;
        repoCtx?: CarriedRunIdentity["repoCtx"];
      }
    | undefined;
  let pendingStop: StopMode | undefined;
  const relayStop = (mode: StopMode) => {
    if (registered) {
      registered.control.requestStop(mode);
      return;
    }
    // A carried row starts its heartbeat before registerRun creates a control.
    // Keep the strongest stop until that control exists; the heartbeat relays
    // each mode only once.
    if (mode === "hard" || pendingStop === undefined) pendingStop = mode;
  };
  const reservationHooks = {
    onStop: relayStop,
    onFenced: () => {
      fencedWhileAttaching = true;
      relayStop("hard");
    },
  };
  let directAudienceVerified = false;
  try {
    // A later DM turn may inherit private tool results from its session log.
    // Stop before the operator, history or seed can read that log unless Slack
    // still proves this is the same requester's private conversation.
    const directDm = /^slack:D[A-Z0-9_]+$/.test(msg.channelId);
    const workerIdentity = parsePrivateWorkerThreadKey(msg.threadKey);
    const boundPrivateWorker =
      workerIdentity !== undefined &&
      coordinator?.parentInstanceId === workerIdentity.instanceId &&
      coordinator.idempotencyKey === msg.messageId &&
      coordinator.idempotencyKey.startsWith(`${workerIdentity.instanceId}:${workerIdentity.unit}/`) &&
      msg.directAudience === undefined;
    // An indirect reply to a live private run must revoke that run before this
    // turn is refused. It cannot enter the model inbox or read the saved session.
    const revokePrivateLive = () => {
      const live = admission.get(msg.threadKey);
      if (live?.agent === "orchestrator") live.inbox.markUntrustedFollowUp();
    };
    if (directDm && directAudienceStampOf(msg) === undefined) revokePrivateLive();
    if (directDm || workerIdentity) {
      const checked =
        workerIdentity !== undefined
          ? boundPrivateWorker && io.verifyPrivateWorkerAudience
            ? await io
                .verifyPrivateWorkerAudience(msg)
                .catch(() => ({ ok: false, code: "direct-audience-unavailable" as const }))
            : { ok: false, code: "direct-address-unproved" as const }
          : await privateAudienceDecision(msg, io);
      directAudienceVerified = checked.ok;
      if (!checked.ok) noteAudienceRefusal(audienceTrace, checked.code, "prompt", "prompt");
    }
    if ((directDm || workerIdentity) && !directAudienceVerified) {
      revokePrivateLive();
      await refuse(
        refusalOf(
          "slack_direct_audience_unverified",
          "I can't verify that this Slack DM is private. Use a private DM with the bot, or ask an admin to check the app's Slack permissions.",
        ),
      );
      return ended;
    }
    // Record the authenticated turn before routing or model work. A later
    // message advances this private revision even if it is only a cancellation
    // or correction; an older unclaimed request then loses the claim CAS.
    if (directDm && !workerIdentity && directAudienceVerified && msg.messageId && deps.coordinatorInstances) {
      try {
        await deps.coordinatorInstances.recordRequesterTurn({
          threadKey: msg.threadKey,
          requesterId: msg.userId,
          messageId: msg.messageId,
        });
      } catch {
        // The main agent may still answer; work_start fails closed when the
        // private authority record cannot be read.
      }
    }
    if (
      deps.runLedger.sessionPersistence &&
      !resume &&
      !restart &&
      !opts.parent &&
      !coordinator &&
      !opts.seed &&
      !hasHandoff
    ) {
      await appendThreadTurn(deps.runLedger, {
        threadKey: msg.threadKey,
        rowId: msg.messageId ?? `request:${root.traceId}:${root.id}`,
        role: "user",
        text: msg.text,
        actor: msg.userId,
        ...(opts.intake?.verdict === "silent" ? { silent: true } : {}),
        context: freshContext(),
      });
    }
    // Keep the requester's target before the model transcript can grow.
    // Child requests and replay are not requester-authored evidence.
    if (!resume && !restart && !opts.parent && !opts.coordinator) {
      try {
        await checkpointRequesterMessageTarget(deps.runLedger, msg.threadKey, msg.userId, msg.text);
      } catch {
        // An inherited write still requires a readable checkpoint at the door.
      }
    }
    // The operator (record 0057; routing-and-config item 29): under
    // `routing.operator: shadow` or `on`, ONE operator turn per admitted chat
    // event — here, ahead of the legacy stage A reader, so shadow observes
    // the replies and typed lines that reader answers. The deterministic exception
    // under `on` is an ended pipeline's continuation-shaped reply: owner
    // resolution bypasses the operator before any model or command can run.
    // Under `shadow` the decision
    // only rides the record, beside the routed request: onto the live run a
    // reply is folded into (below, beside admission's fold), onto stage A's
    // inline run for a typed line, onto the agent run's events otherwise —
    // nothing a person reads changes. Under `on` the decision is what runs:
    // binds in order with receipts naming line, class and reason, a question
    // with record 0054's marker, a refusal (`policy` renders no Yes). A
    // resume, a restart, a spawn and a coordinator's child re-enter a decided
    // request: the operator never re-reads those.
    const configuredOperator =
      !resume && !restart && !opts.parent && !opts.coordinator ? operatorModeOf(deps.config.config) : "off";
    // Legacy readers still supply owner and target hints during the typed
    // target migration. Under `on` they do not execute a typed chat line;
    // the operator binds the action and the registry executes its typed call.
    const typed = parseDirectives(msg.text);
    const typedAgent = typed.agent;
    const explicitPr = explicitPrOf(msg.text);
    const namedShipTask = typedAgent === "ship" && explicitPr ? shipTaskText(typed.text, explicitPr.repo) : "";
    const freshShipTask =
      namedShipTask !== "" &&
      !/^(?:please\s+)?(?:continue|resume|retry|keep going|carry on|finish)(?:\s+(?:with|on))?(?:\s+(?:it|this|the task|the plan|(?:the\s+)?work|working|(?:the\s+)?review|reviewing))?(?:\s+(?:of|on|for|with))?[.!]?$/i.test(
        namedShipTask,
      );
    const exactPrReply =
      explicitPr !== undefined &&
      (typedAgent === undefined || typedAgent === "ship" || typedAgent === "review") &&
      !opts.parent &&
      !opts.coordinator &&
      !resume &&
      !restart;
    const typedDecision =
      directDm &&
      (typedAgent !== undefined || (deps.commands !== undefined && parseChatCommand(msg.text, deps.commands) !== null));
    // An explicitly opted-in one-person DM is the main conversation. Plain
    // questions stay with its configured agent; typed commands still use the
    // registry, and other channels keep the operator's normal routing.
    const mainScopes = deps.config.scopes(msg.channelId, msg.userId);
    const mainDm =
      msg.channelId.startsWith("slack:D") &&
      (mainScopes.user.agent ?? mainScopes.channel.agent ?? deps.config.config.defaults.agent) === "orchestrator";
    // A named PR Ship request is an action, not a continuation of the main
    // conversation. Let the operator's exact-target gate route it to Ship.
    const bareShipPrRequest = typedAgent === undefined && /^ship\s+\S/i.test(msg.text.trimStart()) && !!explicitPr;
    // Exact original-unit operations have their own requester, thread and
    // publication gates. The operator cannot turn one into another action.
    const originalRecoveryCommand =
      (typedAgent === undefined || typedAgent === "ship") && namesOriginalUnitRecovery(typed.text);
    const originalAdoptionCommand =
      typedAgent === "ship" &&
      Object.keys(typed).every((key) => key === "agent" || key === "text") &&
      parseOriginalUnitAdoptionRequest(typed.text) !== undefined;
    let operatorMode =
      configuredOperator === "on" &&
      (originalRecoveryCommand || originalAdoptionCommand || (mainDm && typedAgent !== "ship" && !bareShipPrRequest))
        ? "off"
        : configuredOperator;
    // The preset an `on` decision binds on the person's own words, with the
    // decision's event on the run.
    let operatorPreset: string | undefined;
    // The request the route runs instead of the person's message: a confirmed
    // proposal's own tail (`presetRequestOf`) — the person's message was the
    // word "yes", which routes nothing. Absent for every fresh bind.
    let operatorRequest: string | undefined;
    // The model ref a bind resolved from a model the person named in plain
    // words (the plain-words model unit): applied at directive precedence
    // (`resolveRun`'s `operatorModel`), exactly as `model:<ref>` would.
    let operatorModel: string | undefined;
    let operatorSettings: Pick<OperatorBind, "effort" | "budget" | "severity" | "renewals" | "verbosity"> = {};
    // The accepted bind is authority, not the thread/channel fallback facts.
    let operatorRepo: string | undefined;
    let operatorRepoSource: ShipContext["shipRepoSource"];
    let operatorPrTarget: OperatorBind["prTarget"];
    let operatorShipEntry: ShipContext["shipEntry"];
    let operatorPrBatch: PrBatchBinding | undefined;
    // The thread page the operator reads (newest first): the tail's session
    // keys and, on the newest record, an `on` question still pending — whose
    // "yes" this event may be (routing-and-config item 29). Read here once and
    // reused below, so the operator costs the dispatch no second page.
    let operatorThread: RunView[] | undefined;
    let establishedMainDm = false;
    // The thread's owner off the page (record 0051's owner order), with unit
    // rows cached per instance so the operator view and an ended-owner check
    // still cost at most one durable read.
    let pageOwner: ThreadOwner | undefined;
    // A review of an ended unit's explicit PR is read-only work, not another
    // attempt at the durable task. The operator decides intent; ownership
    // only makes this narrow choice available, never releases a writer.
    let canReviewEndedPr = false;
    if (operatorMode !== "off") {
      const runsService = deps.runs ?? createRunsService({ registry, store: deps.runStore });
      if (exactPrReply) operatorThread = await readPrOwnerThread(runsService, msg.threadKey);
      else if (opts.thread !== undefined) operatorThread = opts.thread;
      else {
        const read = await readThread(runsService, msg.threadKey);
        if (read.kind === "unavailable") {
          await io.reply("This thread's earlier work could not be verified, so no new work started.");
          return ended;
        }
        operatorThread = read.runs;
      }
      if (exactPrReply && operatorThread === undefined) {
        await io.reply("This thread's earlier Ship runs could not be verified, so no new plan started.");
        return ended;
      }
      // A main conversation established in a one-person DM remains with its
      // main agent on plain follow-ups, even without a channel override. The
      // current message's typed agent or exact PR target still uses its door.
      if (
        operatorMode === "on" &&
        !typedDecision &&
        !exactPrReply &&
        msg.channelId.startsWith("slack:D") &&
        operatorThread !== undefined &&
        requesterOf(operatorThread) === msg.userId &&
        (await establishedMainDmOf(
          runsService,
          { channelId: msg.channelId, threadKey: msg.threadKey, userId: msg.userId },
          operatorThread,
        ))
      ) {
        operatorMode = "off";
        establishedMainDm = true;
      }
      if (operatorMode !== "off" && operatorThread !== undefined && deps.coordinatorInstances !== undefined) {
        const unitReads = new Map<string, Promise<CoordinatorUnit[]>>();
        const unitsOf = (id: string) => {
          let read = unitReads.get(id);
          if (read === undefined) {
            read = deps.coordinatorInstances!.listUnits(id);
            unitReads.set(id, read);
          }
          return read;
        };
        pageOwner = await ownerOf(operatorThread, unitsOf, msg.threadKey);
        if (pageOwner.kind === "unavailable") {
          await io.reply("This thread's work owner could not be verified, so no new work started.");
          return ended;
        }
        const unfinishedOwner = pageOwner.kind === "unit";
        if (exactPrReply && pageOwner.kind !== "live") {
          try {
            pageOwner = (await endedPipelineForPrOf(operatorThread, unitsOf, msg.threadKey, explicitPr)) ?? pageOwner;
          } catch (err) {
            await io.reply(
              err instanceof PrOwnerConflictError
                ? `${explicitPr.repo}#${explicitPr.number} already has an unfinished unit in this thread, so continuation did not start. Nothing else ran.`
                : `The original unit for ${explicitPr.repo}#${explicitPr.number} could not be verified, so no new plan started.`,
            );
            return ended;
          }
        }
        // An ended pipeline retains its durable owner while the operator
        // decides whether this reply is a continuation, review, or new work.
        // No read command may substitute for a continuation. When one has
        // already claimed the local slot, ignore that new live row only for
        // this historical-owner check; ordinary admission below folds the
        // duplicate into the winner without another operator turn.
        if (operatorMode === "on" && (typedAgent === undefined || typedAgent === "review")) {
          const continuationOwner =
            pageOwner.kind === "pipeline" || pageOwner.kind === "pipeline_ambiguous"
              ? pageOwner
              : await ownerOf(
                  operatorThread.filter((run) => run.finished),
                  unitsOf,
                  msg.threadKey,
                );
          if (continuationOwner.kind === "unavailable") {
            await io.reply("This thread's work owner could not be verified, so no new work started.");
            return ended;
          }
          if (continuationOwner.kind === "pipeline" || continuationOwner.kind === "pipeline_ambiguous") {
            const endedPrOwner =
              pageOwner.kind === "pipeline" || pageOwner.kind === "pipeline_ambiguous" ? pageOwner : undefined;
            const ownedUnits = endedPrOwner?.kind === "pipeline" ? [endedPrOwner.unit] : (endedPrOwner?.units ?? []);
            const releasedReviewTarget =
              explicitPr !== undefined
                ? await releasedPrOf(operatorThread, unitsOf, msg.threadKey, explicitPr.number).catch(() => undefined)
                : undefined;
            canReviewEndedPr =
              !unfinishedOwner &&
              explicitPr !== undefined &&
              operatorThread.every((run) => run.finished) &&
              admission.get(msg.threadKey) === undefined &&
              deps.threadsElsewhere.get(msg.threadKey) === undefined &&
              ((endedPrOwner !== undefined &&
                ownedUnits.length > 0 &&
                ownedUnits.every((unit) => unit.pr?.number === explicitPr.number) &&
                endedPrOwner.run.repo?.toLowerCase() === explicitPr.repo) ||
                releasedReviewTarget?.repo.toLowerCase() === explicitPr.repo);
            pageOwner = continuationOwner;
            if (!canReviewEndedPr) {
              const actor = chatActorOf(deps.config, msg);
              if (
                continuationOwner.run.userId === undefined ||
                authorizeSteerOwner({
                  caller: { ids: actorIdsOf(actor), grants: effectiveGrants(actor) },
                  target: { runId: continuationOwner.run.id, requesterId: continuationOwner.run.userId },
                }).kind === "refused"
              ) {
                await io.reply(STEER_OWNER_REFUSED);
                return ended;
              }
            }
          }
        }
      }
    }
    if (operatorMode !== "off") {
      // The thread's owner as the operator reads it (issue 2027; record 0051's
      // owner order; thread-admission item 9): a live run — the local slot, one
      // live on another generation, or a non-hosted live run on the page —
      // else the page's idle unit, then a hosted runner guarding its seed
      // thread. Under a live owner the projection narrows to steers and reads;
      // an ended pipeline asks the operator to classify continuation, review,
      // or new work before any durable reissue.
      const slot = admission.get(msg.threadKey);
      const liveElsewhere = deps.threadsElsewhere.get(msg.threadKey) !== undefined;
      // A pending question's free-text answer (issue 2046; routing-and-config
      // item 29): when the thread's newest record is an `on` question and this
      // reply is not the bare "yes" the proposal path binds, the person's words
      // are the question's answer — joined back onto the original ask
      // (`joinedAnswerRequest`) and decided and folded as the request would
      // have been — mention or not, never reduced to a bare answer. The joined
      // line is what the operator decides, so the fragment
      // never becomes a request by itself.
      const pendingDecision =
        operatorMode === "on" && operatorThread?.[0]?.operator?.outcome === "question"
          ? await contextReader.readOperatorDecision(operatorThread[0].id)
          : undefined;
      const pendingQuestion = pendingDecision
        ? pendingQuestionOf([{ userId: operatorThread?.[0]?.userId, operator: pendingDecision.operator }], msg.userId)
        : undefined;
      const pendingContext = pendingQuestion ? pendingDecision?.context : undefined;
      const joinedAnswer =
        pendingQuestion !== undefined && !(pendingQuestion.proposal !== undefined && isYesAnswer(msg.text))
          ? joinedAnswerRequest(pendingQuestion, msg.text)
          : undefined;
      const answeredTarget =
        joinedAnswer !== undefined && pendingQuestion !== undefined
          ? answeredRepositoryTarget(msg.userId, pendingQuestion, msg.text)
          : undefined;
      const doorMsg = joinedAnswer !== undefined ? { ...msg, text: joinedAnswer } : msg;
      const threadOwner: OperatorThreadOwner | undefined =
        slot !== undefined || liveElsewhere
          ? { kind: "live", ...(slot?.runId !== undefined ? { runId: slot.runId } : {}) }
          : pageOwner?.kind === "live"
            ? // A hosted pipeline runner takes no inbox (thread-admission item
              // 9's seed rule): a steer offered here would queue words nothing
              // drains, so the owner rides without a run id — the prompt
              // offers no steer line, the executor folds a steer bind like any
              // other, and the fold runs on to the seed refusal below, which
              // names the unit threads to reply in.
              pageOwner.run.hosted === true
              ? { kind: "live" }
              : { kind: "live", runId: pageOwner.run.id }
            : pageOwner?.kind === "unit"
              ? { kind: "unit", unit: pageOwner.unit.unit }
              : pageOwner?.kind === "pipeline"
                ? {
                    kind: "pipeline",
                    unit: pageOwner.unit.unit,
                    ...(canReviewEndedPr ? { allowReview: true } : {}),
                  }
                : pageOwner?.kind === "pipeline_ambiguous"
                  ? {
                      kind: "pipeline",
                      unit: pageOwner.units.map((unit) => unit.unit).join(", "),
                      ...(canReviewEndedPr ? { allowReview: true } : {}),
                    }
                  : undefined;
      operatorEvent = await root.span("dispatch.operator", async (span) => {
        const github = githubCapabilityFor(deps, chatActorOf(deps.config, msg), {
          requesterId: msg.userId,
          verifiedDirectAudience: directAudienceVerified && directAudienceStampOf(msg) !== undefined,
        });
        const event = await operatorStage(
          {
            ...deps,
            github: {
              listRepos: () => github.readableRepos?.() ?? Promise.resolve([]),
              listTree: (...args) => github.api.listTree(...args),
              readFile: (...args) => github.api.readFile(...args),
            },
          },
          {
            msg: doorMsg,
            mode: operatorMode,
            pending: pendingQuestion,
            onContext: (context) => {
              operatorContext = mergeContextDependencies(context, ...(pendingContext ? [pendingContext] : []));
            },
            readTail: () =>
              readOperatorTailContext({
                ledger: deps.runLedger,
                runs: operatorThread ?? [],
                msg,
                validateDependencies: contextReader.validateDependencies,
                normalizeDependencies: contextReader.normalizeDependencies,
              }),
            readNotes: () =>
              readOperatorNotes({
                ledger: deps.runLedger,
                runs: operatorThread ?? [],
                msg,
                io,
                validateDependencies: contextReader.validateDependencies,
                normalizeDependencies: contextReader.normalizeDependencies,
              }),
            readMemory: () =>
              readOperatorMemory({
                organization: deps.config.config.organization,
                requester: msg.userId,
                channelId: msg.channelId,
                text: doorMsg.text,
                memoryConfig: deps.config.config.memory,
                memory: deps.memory,
                canReadScope: (key) => {
                  const kind = key.slice(0, key.indexOf(":"));
                  return (
                    (kind === "org" || kind === "user" || kind === "repo" || kind === "channel") &&
                    authorize(
                      reflectionActor(chatActorOf(deps.config, msg), { channelId: msg.channelId }),
                      "memory:read",
                      { type: "memory-scope", key, kind },
                    ).allow
                  );
                },
                authorizeSource: ({ candidate }) => contextReader.authorizeMemory(candidate),
              }),
            ...(operatorThread ? { thread: operatorThread } : {}),
            ...(opts.intake ? { intake: opts.intake } : {}),
            ...(threadOwner ? { owner: threadOwner } : {}),
            ...(answeredTarget ? { answeredTarget } : {}),
          },
        );
        if (event) {
          const repoSource = event.binds?.find((bind) => bind.repoSource !== undefined)?.repoSource;
          const attrs = {
            operatorOutcome: event.outcome,
            operatorAttempts: event.attempts?.length ?? 0,
            ...(event.repoContext
              ? {
                  operatorRepoCatalog: event.repoContext.candidateStatus,
                  operatorRepoCandidates: event.repoContext.candidateCount,
                }
              : {}),
            ...(repoSource ? { operatorRepoSource: repoSource } : {}),
          };
          span.setAttrs(attrs);
          root.setAttrs(attrs);
        }
        return event;
      });
      // Under `shadow`, a reply into a thread a run holds is a follow-up
      // admission steers, not a request of its own: the decision is written
      // beside the fold, onto the live run's record, and the reply goes on to
      // admission unchanged. Under `on`, admission runs AFTER the operator
      // (the one-door plan's admission unit): the decision — not the
      // thread's live slot — says what this event is. A bind of `steer` names
      // its run and folds into it at that run's next boundary, whichever
      // thread holds it (the wired `steer.run` sender, under the owner rule of
      // authorization item 16a); every other bind runs as its own work beside
      // the live run. Thread occupancy itself is untouched: one live run per
      // thread, and nothing here starts a rival in an occupied one.
      const live = operatorEvent ? admission.get(msg.threadKey) : undefined;
      // Shadow records its decision beside a live owner's run. Under `on`,
      // even an exhausted operator turn ends at the door without a reader
      // interpreting the same message a second time.
      if (operatorMode === "shadow" && operatorEvent && live?.runId !== undefined) {
        registry.publish(live.runId, { type: "operator", ...operatorEvent, at: clock() });
        operatorEvent = undefined;
      } else if (operatorMode === "on" && operatorEvent) {
        let operatorReplyIndex = 0;
        const execution = await root.span("dispatch.operator_decision", () =>
          executeOperatorDecision(deps, {
            msg: doorMsg,
            io,
            ending,
            trace,
            event: operatorEvent!,
            contextDependencies: structuredClone(operatorContext),
            validateContext: () => revalidateAdmittedContext(() => operatorContext, contextReader.validateDependencies),
            appendReply: async (text) => {
              if (!deps.runLedger.sessionPersistence) return;
              await appendThreadTurn(deps.runLedger, {
                threadKey: msg.threadKey,
                rowId: `${msg.messageId ?? `request:${root.traceId}:${root.id}`}:operator-reply:${operatorReplyIndex++}`,
                role: "assistant",
                text,
                context: operatorContext,
              });
            },
            ...(operatorThread ? { thread: operatorThread } : {}),
            ...(threadOwner ? { owner: threadOwner } : {}),
          }),
        );
        if (execution.kind === "answered")
          return operatorEvent?.outcome === "non_decision" ? { status: "failed" } : ended;
        // A command bind that ran before the preset already carries the
        // decision's event on its record: the agent run does not repeat it.
        if (execution.kind !== "fold" && execution.carried) operatorEvent = undefined;
        if (execution.kind === "route") {
          operatorPreset = execution.preset;
          operatorRequest = execution.request;
          operatorModel = execution.model;
          operatorSettings = {
            effort: execution.effort,
            budget: execution.budget,
            severity: execution.severity,
            renewals: execution.renewals,
            verbosity: execution.verbosity,
          };
          operatorRepo = execution.repo;
          operatorRepoSource = execution.repoSource;
          operatorPrTarget = execution.prTarget;
          operatorShipEntry = execution.shipEntry;
          operatorPrBatch = execution.prBatch;
        }
        // `kind: "fold"` (issue 2027; thread-admission item 9): the decision was
        // neither steers-and-reads nor a question in an owned thread, so the
        // words are the owner's follow-up — the dispatch runs on to admission's
        // fold (a live run) or the unit's one thread event (an idle unit), the
        // decision's event riding the fold or a door record, no prose posted.
        // An ended pipeline accepts a Ship continuation bind below; an
        // unrelated fold stops at its owner gate.
        // A confirmed "yes" to a question minted before the thread became
        // owned folds the proposal's own words: the person's message is the
        // word "yes", which tells the owner nothing.
        if (execution.kind === "fold" && execution.request !== undefined) operatorRequest = execution.request;
      }
      // Whatever path the decision took past the door — a preset routed or
      // an owned thread's fold — the request
      // that runs is the joined ask, never the answer's bare words (issue 2046).
      if (joinedAnswer !== undefined && operatorRequest === undefined) operatorRequest = joinedAnswer;
    }
    // Item 29's ledger promise (run-history item 60): a decision still pending
    // — a routed preset whose event was to ride the run, or a shadow row with
    // no live slot to land on — that meets a terminal path which starts no run
    // records on a door record of its own, exactly as a question, a refusal
    // and an all-handed-back decision do.
    const recordPendingOperator = async () => {
      if (operatorEvent === undefined) return;
      const event = operatorEvent;
      operatorEvent = undefined;
      await recordOperatorDecision(deps, msg, event, ending, trace);
    };

    // A typed Ship request now asks the operator for its starting stage. A
    // repaired bind to another preset must not fall through to the
    // legacy directive and silently start coding without that stage.
    if (
      typedAgent === "ship" &&
      operatorMode === "on" &&
      pageOwner?.kind !== "live" &&
      pageOwner?.kind !== "unit" &&
      pageOwner?.kind !== "pipeline" &&
      pageOwner?.kind !== "pipeline_ambiguous" &&
      (operatorPreset !== "ship" || operatorShipEntry === undefined)
    ) {
      await refuse(
        refusalOf("setup_failed", "I couldn't bind this Ship request to review, work or a plan, so nothing started."),
      );
      await recordPendingOperator();
      return ended;
    }
    if (operatorShipEntry === "plan" && typedAgent !== "ship") {
      await refuse(
        refusalOf("setup_failed", "A seeded Ship plan needs an explicit `agent:ship` request, so nothing started."),
      );
      await recordPendingOperator();
      return ended;
    }

    // Stage A remains for off and shadow. Under on, the operator's decision
    // is final even when it folds into an existing owner.
    if (
      operatorMode !== "on" &&
      operatorPreset === undefined &&
      (await answerChatCommand(deps, { msg, io, ending, trace, ...(operatorEvent ? { operator: operatorEvent } : {}) }))
    )
      return ended;

    // Every operator-on request has already been interpreted, including a
    // fold. Keep the author's whole message and typed settings through resolution.
    const { directives, history } = await readRequest({
      msg,
      io,
      root,
      ...(operatorMode === "on"
        ? { request: { text: operatorRequest ?? msg.text, ...operatorSettings, interpreter: "operator" as const } }
        : {}),
    });
    // The operator's preset stands where a directive would in the RESOLUTION
    // (`resolveRun`'s own `operatorPreset` field, `agentSource: "operator"`
    // below) — never written into `directives.agent`, so admission's follow-up
    // rule and the thread-owner rule below keep reading the person's typed
    // intent alone: a preset bind into a thread a live run or idle unit owns
    // folds or is refused by the owner's rule, never refused as an agent request
    // nobody typed and never started as a rival run (issue 2010's
    // class). A confirmed proposal carries its own task: its tail is the
    // request, since the person's message was the word "yes".
    if (operatorRequest !== undefined) directives.text = operatorRequest;
    const originalUnitRecovery =
      (directives.agent === undefined || directives.agent === "ship") &&
      /^\s*(?:recover|renew)\s+unit\b/i.test(directives.text);
    if (originalUnitRecovery) directives.agent ??= "ship";

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
    let thread: RunView[] | undefined;
    if (exactPrReply && !originalUnitRecovery)
      thread = operatorThread ?? (await readPrOwnerThread(runsService, msg.threadKey));
    else if (opts.thread !== undefined) thread = opts.thread;
    else if (
      !opts.parent &&
      !opts.coordinator &&
      !resume &&
      !restart &&
      (history.length > 0 || establishedMainDm || msg.threadReply === true)
    ) {
      if (operatorThread !== undefined) thread = operatorThread;
      else {
        const read = await readThread(runsService, msg.threadKey);
        if (read.kind === "unavailable") {
          await io.reply("This thread's earlier work could not be verified, so no new work started.");
          await recordPendingOperator();
          return ended;
        }
        thread = read.runs;
      }
    }
    if (
      thread === undefined &&
      !opts.parent &&
      !opts.coordinator &&
      !resume &&
      !restart &&
      !originalUnitRecovery &&
      ((operatorPreset ?? directives.agent) === undefined || (operatorPreset ?? directives.agent) === "ship") &&
      explicitPr !== undefined
    ) {
      await io.reply("This thread's earlier Ship runs could not be verified, so no new plan started.");
      await recordPendingOperator();
      return ended;
    }
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
    // item 3) — else the config scopes; the model and effort from the thread's
    // user turns, then the scopes. A ledger resume is a fresh lease segment:
    // it keeps the preset but resolves model and effort from today's scopes.
    // The configured one-person main DM owns its conversation across an
    // explicit specialist turn. A fresh plain follow-up without an exact PR
    // target returns to its orchestrator; typed and exact PR requests keep
    // their existing authority.
    const stickyAgent = establishedMainDm
      ? "orchestrator"
      : thread && !(mainDm && !exactPrReply && !resume && !restart && !opts.parent && !opts.coordinator)
        ? stickyAgentOf(thread)
        : undefined;
    // A completed unit's publication can name the PR when the hosted run
    // record has none. A later completed run's PR supersedes that publication.
    const laterPr = (runPr: ThreadPullRequest | undefined, releasedPr: ThreadPullRequest | undefined) =>
      releasedPr !== undefined && (runPr === undefined || releasedPr.at > runPr.at) ? releasedPr : runPr;
    let threadPr = laterPr(thread ? threadPrOf(thread) : undefined, pageOwner?.releasedPr);
    const barePrNumber = barePrNumberOf(msg.text);
    const currentPrNumber = explicitPr?.number ?? barePrNumber;
    let namedReleasedPr: ThreadPullRequest | undefined;
    if (thread && barePrNumber !== undefined && deps.coordinatorInstances !== undefined) {
      try {
        namedReleasedPr = await releasedPrOf(
          thread,
          (id) => deps.coordinatorInstances!.listUnits(id),
          msg.threadKey,
          barePrNumber,
        );
      } catch {
        await io.reply("This thread's pull request owner could not be verified, so no new work started.");
        await recordPendingOperator();
        return ended;
      }
      if (namedReleasedPr !== undefined) threadPr = namedReleasedPr;
    }
    const inheritedRepo =
      (thread ? newestFinishedRunOf(thread)?.repo : undefined) ??
      deps.config.scopes(msg.channelId, msg.userId).channel.repo;
    const carriedTarget = resume
      ? carriedOperationTarget(resume.row)
      : restart
        ? carriedOperationTarget(restart.row)
        : undefined;
    const operationTarget =
      operatorRepo !== undefined && operatorPrTarget !== undefined
        ? { repo: operatorRepo, prTarget: operatorPrTarget }
        : (opts.operationTarget ?? carriedTarget ?? (operatorRepo !== undefined ? { repo: operatorRepo } : undefined));
    const historicalRoutePreset = restart?.row.meta.route?.preset;
    const resolveCurrent = () =>
      resolveRun(deps, {
        msg,
        directives,
        history,
        ...(stickyAgent !== undefined ? { stickyAgent } : {}),
        ...(operatorPreset !== undefined
          ? { operatorPreset }
          : historicalRoutePreset !== undefined
            ? { operatorPreset: historicalRoutePreset }
            : {}),
        ...(operatorModel !== undefined ? { operatorModel } : {}),
        ...(resume !== undefined ? { freshSegment: true } : {}),
      });
    let settled = resolveCurrent();
    let { sticky, resolved } = settled;
    let { agentSource } = settled;
    if (operatorPreset !== undefined) agentSource = "operator";
    else if (historicalRoutePreset !== undefined) agentSource = "route";

    // Route metadata survives only for records written before the readers'
    // router retired. A resumed, restarted or sticky run can still repaint
    // the historical reason on its card; no new dispatch asks a second model
    // or publishes a route event.
    let route: RouteDecided | undefined = restart?.row.meta.route;
    const threadLive =
      admission.get(msg.threadKey) !== undefined ||
      (!resume && !restart && deps.threadsElsewhere.get(msg.threadKey) !== undefined);
    // The thread's owner (record 0051's owner rule): computed here, where the
    // dispatcher already decides `threadLive`, from the page it already read
    // plus at most one read of the instance's unit rows. A plain reply into a
    // thread owned by an unfinished unit with no live run is one thread event
    // on that unit — appended with the mode read off the row, the instance
    // nudged and the sender acked before any fresh run resolves.
    // In a UNIT's thread a directive naming an agent normally falls through
    // to today's path. A parked human-gated question is the exception: the
    // next human input is its answer, not a rival run. A live thread
    // is the live run's (admission steers below); a session or no owner follows
    // the ordinary sticky or door-bound path.
    if (thread && !threadLive && deps.coordinatorInstances !== undefined) {
      let owner: ThreadOwner =
        pageOwner ?? (await ownerOf(thread, (id) => deps.coordinatorInstances!.listUnits(id), msg.threadKey));
      if (owner.kind === "unavailable") {
        // Only the complete, typed recovery grammar can defer an unreadable
        // unit owner to the original-unit boundary. That boundary verifies
        // the original requester, thread, publication and lifetime budget;
        // ordinary requests cannot treat an unreadable owner as unowned.
        if (
          originalUnitRecovery &&
          parseOriginalUnitRecoveryRequest(directives.text) !== undefined &&
          thread.every((run) => run.finished)
        ) {
          owner = { kind: "none" };
        } else {
          await io.reply("This thread's work owner could not be verified, so no new work started.");
          await recordPendingOperator();
          return ended;
        }
      }
      if (
        !originalUnitRecovery &&
        (directives.agent === undefined || directives.agent === "ship") &&
        explicitPr !== undefined &&
        owner.kind !== "live"
      ) {
        try {
          owner =
            (await endedPipelineForPrOf(
              thread,
              (id) => deps.coordinatorInstances!.listUnits(id),
              msg.threadKey,
              explicitPr,
            )) ?? owner;
        } catch (err) {
          await io.reply(
            err instanceof PrOwnerConflictError
              ? `${explicitPr.repo}#${explicitPr.number} already has an unfinished unit in this thread, so continuation did not start. Nothing else ran.`
              : `The original unit for ${explicitPr.repo}#${explicitPr.number} could not be verified, so no new plan started.`,
          );
          await recordPendingOperator();
          return ended;
        }
      }
      threadPr = namedReleasedPr ?? laterPr(threadPr, owner.releasedPr);
      const releasedPr = namedReleasedPr ?? owner.releasedPr;
      if (
        releasedPr !== undefined &&
        operatorEvent?.outcome === "binds" &&
        operatorEvent.binds?.length === 1 &&
        operatorEvent.binds[0]?.shipEntry === "continue" &&
        (currentPrNumber === undefined || currentPrNumber === releasedPr.number) &&
        (explicitPr === undefined || explicitPr.repo === releasedPr.repo)
      ) {
        await io.reply(
          `${releasedPr.repo}#${releasedPr.number} is already merge-ready, so there is no ended unit to continue. Name a separate task to start new work. Nothing started.`,
        );
        await recordPendingOperator();
        return ended;
      }
      if (
        freshShipTask &&
        owner.kind === "pipeline" &&
        explicitPr !== undefined &&
        owner.unit.pr?.number === explicitPr.number &&
        owner.run.repo?.toLowerCase() === explicitPr.repo
      )
        threadPr = { repo: explicitPr.repo, number: explicitPr.number, at: owner.unit.ending!.at };
      if (owner.kind === "live" && owner.run.hosted === true) {
        // The seed thread of a live pipeline runner (issue 2010; record 0051's
        // owner rule, thread-admission item 9): a hosted runner occupies no
        // admission slot, so `threadLive` is false here, yet the thread is the
        // runner's for its life — nothing runs beside it. A reply, directive
        // or not, is refused naming the owner and the unit thread to reply in,
        // never started as a rival run beside the live pipeline.
        const open = (owner.units ?? []).filter((u) => u.ending === undefined);
        await refuse(
          refusalOf(
            "pipeline_thread_owned",
            REFUSAL_SENTENCES.pipeline_thread_owned({
              agent: owner.run.agent ?? "ship",
              units: open.map((u) => ({
                unit: u.unit,
                ...(u.threadKey !== undefined ? { threadKey: u.threadKey } : {}),
              })),
            }),
          ),
        );
        await recordPendingOperator();
        return ended;
      }
      if (
        operatorMode === "on" &&
        operatorEvent !== undefined &&
        (owner.kind === "pipeline" || owner.kind === "pipeline_ambiguous") &&
        !(canReviewEndedPr && operatorPreset === "review")
      ) {
        const bind =
          operatorEvent.outcome === "binds" && operatorEvent.binds?.length === 1 ? operatorEvent.binds[0] : undefined;
        if (typedAgent === "review" || bind?.shipEntry === undefined) {
          await io.reply("A read-only or unrelated action cannot continue the ended Ship writer. Nothing started.");
          await recordPendingOperator();
          return ended;
        }
        if (bind.shipEntry !== "continue") {
          await io.reply("A separate Ship task cannot reuse this ended unit. Nothing started.");
          await recordPendingOperator();
          return ended;
        }
      }
      if (
        owner.kind === "pipeline_ambiguous" &&
        !(canReviewEndedPr && operatorPreset === "review") &&
        (directives.agent === undefined || (directives.agent === "ship" && explicitPr !== undefined))
      ) {
        await io.reply(
          `This thread matches multiple ended plan units (${owner.units.map((unit) => unit.unit).join(", ")}), so continuation is ambiguous. Nothing started.`,
        );
        await recordPendingOperator();
        return ended;
      }
      if (
        owner.kind === "pipeline" &&
        !originalUnitRecovery &&
        !(canReviewEndedPr && operatorPreset === "review") &&
        (!freshShipTask || operatorMode === "on") &&
        ((operatorMode === "on" &&
          operatorEvent?.outcome === "binds" &&
          operatorEvent.binds?.length === 1 &&
          operatorEvent.binds[0]?.shipEntry === "continue") ||
          directives.agent === undefined ||
          (directives.agent === "ship" &&
            !originalUnitRecovery &&
            currentPrNumber !== undefined &&
            owner.unit.pr?.number === currentPrNumber &&
            (explicitPr === undefined || explicitPr.repo === owner.run.repo?.toLowerCase())))
      ) {
        if (
          currentPrNumber !== undefined &&
          (owner.unit.pr?.number !== currentPrNumber ||
            (explicitPr !== undefined && explicitPr.repo !== owner.run.repo?.toLowerCase()))
        ) {
          const named = explicitPr ? `${explicitPr.repo}#${explicitPr.number}` : `PR #${currentPrNumber}`;
          await io.reply(
            `This reply names ${named}, but the ended pipeline owns PR #${owner.unit.pr?.number ?? "unknown"}. Nothing started. Name the target with \`agent:ship\` and its full PR URL to start separate work.`,
          );
          await recordPendingOperator();
          return ended;
        }
        // Recovery owns the original identity, budget and GitHub checks. A reply
        // carries its adapter event ID to that same durable action journal.
        Object.assign(directives, {
          agent: "ship",
          text: `recover unit ${owner.instanceId}:${owner.unit.unit}`,
        });
        operatorPreset = "ship";
        settled = resolveCurrent();
        ({ sticky, resolved, agentSource } = settled);
        agentSource = "sticky";
      }
      if (owner.kind === "unit" && (directives.agent === undefined || owner.unit.idle?.humanGate !== undefined)) {
        // The same gate a live steer passes (admission's allowlist check): the
        // event is read by the unit's next coding child — a write-identity run
        // — so its sender must be allowed to run `coding`, refused the same
        // named way, before anything is appended. "Run" includes "is heard by".
        if ((await authorizeAgent(deps, { msg, io, refuse, agentName: "coding" })).kind === "refused") {
          await recordPendingOperator();
          return ended;
        }
        const answer = await root.span("dispatch.unit_owned_thread", () =>
          answerUnitOwnedThread(deps, {
            msg,
            io,
            text: directives.text,
            owner,
            clock,
            verbosity: deps.config.verbosityFor(msg.channelId, msg.userId, directives.verbosity),
          }),
        );
        if (answer === "acked") {
          await recordPendingOperator();
          return ended;
        }
        // `route-fresh`: the instance is gone — the row was ended `terminated`
        // and the thread told — so the request runs on as if the thread were
        // unowned by any unit.
      }
    }
    // A sticky follow-up may carry a historical router decision so its old
    // card remains legible; the door itself chose no route on this event.
    if (route === undefined && stickyAgent !== undefined && agentSource === "sticky" && thread)
      route = threadRouteOf(thread, resolved.agentName);
    if (resume?.row.meta.route) route = resume.row.meta.route;

    // The agent gate (dispatch/authorize.ts), against the RESOLVED agent and
    // before the thread is claimed.
    if ((await authorizeAgent(deps, { msg, io, refuse, agentName: resolved.agentName })).kind === "refused")
      return ended;

    // The preset as this deployment declares it: the registry's def, except
    // ship, whose declared budget is the `ship.maxMinutes` knob
    // (docs/reference/specs/agent-ship.md item 8) — so the profile below, the
    // card's budget line and the pipeline's wall clock read one number.
    const agent = configuredAgent(deps.config.config, resolved.agentName);
    if (resolved.agentName === "ship") agent.maxMinutes = shipPresetFor(deps.config.config.ship).maxMinutes;
    // The run's effective profile (dispatch/resolve.ts; record 0026): preset ∩
    // the request's `budget:` directive ∩ the boundaries on the path — a
    // child's parent's remaining wall clock among them (routing-and-config
    // item 20) — and the profile gate (dispatch/authorize.ts) right after the
    // agent gate and before the thread is claimed, so an identity or class a
    // boundary caps is refused by name with no card, no row and no executor.
    // Every stage below reads the profile — the factory, the ledger row, the
    // runner — never the preset's own fields.
    if (opts.parentDeadlineAt !== undefined && !Number.isFinite(opts.parentDeadlineAt)) {
      await refuseSilently("run_budget_exhausted", async () => {});
      return ended;
    }
    const recoveryRemainingMs = recovery === undefined ? undefined : Math.max(0, recovery.deadlineAt - clock());
    const actionRemainingMs =
      opts.parentDeadlineAt === undefined ? undefined : Math.max(0, opts.parentDeadlineAt - clock());
    const inheritedBounds = [
      parent?.remainingMs,
      recoveryRemainingMs,
      opts.parentRemainingMs,
      actionRemainingMs,
    ].filter((value): value is number => value !== undefined);
    const inheritedRemainingMs = inheritedBounds.length ? Math.min(...inheritedBounds) : undefined;
    const originalEvents = resume?.events ?? restart?.events ?? opts.restartCarried?.events;
    const savedMeta = (resume ?? restart)?.row.meta;
    const hadCoordinator =
      coordinator !== undefined ||
      savedMeta?.parentInstanceId !== undefined ||
      savedMeta?.idempotencyKey !== undefined ||
      savedMeta?.coordinatorUnit !== undefined ||
      originalEvents?.some((event) => event.type === "coordinator_tag") === true;
    const recoveringCanonical =
      hadCoordinator && (resume !== undefined || restart !== undefined || opts.restartOf !== undefined);
    const originalProfile = recoveringCanonical
      ? (resume?.row.meta.profile ?? restart?.row.meta.profile ?? opts.restartCarried?.profile)
      : undefined;
    const originalAdmission = originalEvents?.find((event) => event.type === "run_state" && event.state === "admitted");
    if (
      recoveringCanonical &&
      (coordinator === undefined ||
        (resume !== undefined &&
          (typeof resume.plan.remainingMs !== "number" ||
            !Number.isFinite(resume.plan.remainingMs) ||
            resume.plan.remainingMs <= 0)) ||
        !isRunProfile(originalProfile) ||
        originalAdmission?.type !== "run_state" ||
        typeof originalAdmission.at !== "number" ||
        !Number.isFinite(originalAdmission.at) ||
        typeof originalAdmission.bound !== "number" ||
        !Number.isFinite(originalAdmission.bound) ||
        originalAdmission.bound <= originalAdmission.at)
    ) {
      resumeRowRetained = true;
      await refuseSilently("run_budget_exhausted", async () => {});
      return ended;
    }
    const originalDeadlineBounds = [
      recoveringCanonical && originalAdmission?.type === "run_state" ? originalAdmission.bound : undefined,
      recovery?.deadlineAt,
      opts.parentDeadlineAt,
    ].filter((value): value is number => value !== undefined);
    const originalDeadline = originalDeadlineBounds.length ? Math.min(...originalDeadlineBounds) : undefined;
    const minimumActionRemainder =
      opts.parentDeadlineAt !== undefined || coordinator?.maintenanceActionId !== undefined ? MINUTE_MS : 0;
    const assertOriginalActionBudget = (at = clock()) => {
      if (originalDeadline === undefined && coordinator?.maintenanceActionId === undefined) return;
      if (originalDeadline === undefined)
        throw new RefusalError(refusalOf("run_budget_exhausted", "The original work's time allowance is unavailable."));
      const remaining = originalDeadline - at;
      if (remaining <= 0 || remaining < minimumActionRemainder)
        throw new RefusalError(
          refusalOf("run_budget_exhausted", "The original work's time allowance ended before its model started."),
        );
    };
    assertOriginalActionBudget();

    const profileGate = await authorizeProfile(deps, {
      msg,
      io,
      refuse,
      agent,
      resolution: resolveProfile({
        agent,
        resolved,
        resume,
        ...(coordinator && restart ? { restart } : {}),
        ...(coordinator && opts.restartCarried?.profile ? { carriedProfile: opts.restartCarried.profile } : {}),
        budget: directives.budget,
        ...(inheritedRemainingMs !== undefined ? { parentRemainingMs: inheritedRemainingMs } : {}),
      }),
    });
    if (profileGate.kind === "refused") return ended;
    let { profile } = profileGate;
    assertOriginalActionBudget();

    // A review resolves its repository state before admission. A pull request
    // GitHub already closed cannot be reviewed, so it must not claim the
    // thread, open a card, register a run or provision a workspace merely to
    // say so. The full target stage below reuses this same promise for an open
    // pull request; every other agent starts resolution in its old position.
    const earlyRepoTarget =
      agent.name === "review"
        ? resolveRepoTarget(deps, {
            msg,
            history,
            profile,
            resume,
            root,
            ...(threadPr ? { records: { pr: threadPr } } : {}),
            ...(operatorRepo !== undefined || inheritedRepo !== undefined
              ? { operatorRepo: operatorRepo ?? inheritedRepo }
              : {}),
            reviewBarePr: true,
            ...(operationTarget?.prTarget !== undefined ? { operationTarget } : {}),
          })
        : undefined;
    if (earlyRepoTarget !== undefined) {
      const preflightRepoCtx = await earlyRepoTarget.repoCtxP;
      const preflight = closedReviewPreflight({ agent, repoCtx: preflightRepoCtx });
      if (!preflight.ok) {
        // State is never disclosed around the repository authorization table.
        // This request ends here, so this is the one and only repo check.
        if (
          preflightRepoCtx.repo !== undefined &&
          !deps.config.canUseRepo(chatActorOf(deps.config, msg), preflightRepoCtx.repo)
        ) {
          await refuse(
            refusalOf(
              "repo_access",
              REFUSAL_SENTENCES.repo_access({
                repo: preflightRepoCtx.repo,
                adminsHint: deps.config.adminsHint(),
              }),
            ),
          );
        } else {
          await io.reply(preflight.reply);
        }
        await recordPendingOperator();
        return ended;
      }
    }

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
      refuseSilently,
      admission,
      hooks: {
        reservation: reservationHooks,
        adopt: {
          onStop: relayStop,
          onFenced: reservationHooks.onFenced,
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
        ...(operationTarget !== undefined ? { operationTarget } : {}),
        ...(opts.parent ? { parent: opts.parent } : {}),
        ...(opts.seed ? { seed: opts.seed } : {}),
        ...(opts.parentContext !== undefined ? { parentContext: opts.parentContext } : {}),
        ...(opts.childHandoff !== undefined ? { childHandoff: opts.childHandoff } : {}),
        ...(opts.unitContextAdmission !== undefined ? { unitContextAdmission: opts.unitContextAdmission } : {}),
        ...(opts.coordinator ? { coordinator: opts.coordinator } : {}),
        ...(opts.restartOf !== undefined ? { restartOf: opts.restartOf } : {}),
        ...(opts.restartCarried !== undefined ? { restartCarried: opts.restartCarried } : {}),
      });
    // A reply folded into the live child of a spawned thread: its parent hears it now.
    if (outcome.kind === "steered") {
      await tellLineage({ kind: "steered" });
      // A decision that routed a preset into a live thread was folded by the
      // owner rule instead of starting a run: the decision's event rides the
      // live run's record — exactly where a shadow row lands. A fold with no
      // local slot (a run live on another generation, or one still in setup
      // whose slot has no runId yet) has no record here to ride, so the event
      // lands on a door record instead — item 29's ledger promise holds on
      // every steered exit, not only the local one.
      const liveRun = operatorEvent !== undefined ? admission.get(msg.threadKey)?.runId : undefined;
      if (operatorEvent !== undefined && liveRun !== undefined) {
        registry.publish(liveRun, { type: "operator", ...operatorEvent, at: clock() });
        operatorEvent = undefined;
      } else await recordPendingOperator();
    }
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
    // A declared source tool owns all linked content and earlier files through
    // its requester-bound, durable receipt path. URLs stay in the request; a
    // missing private capability must never restore automatic preload.
    const sourceIntake = sourceIntakeFor(agent.toolset);
    const references =
      sourceIntake === "automatic" && !resume && !restart && referencesOn(deps.config.config)
        ? await root.span("dispatch.references", () =>
            readReferences(deps, { msg, actor: resolveChatActor(msg, (id) => deps.config.grantsFor(id)) }),
          )
        : NO_REFERENCES;

    // The provider behind the model ref, and the target repo/ref/PR resolution
    // STARTED here (dispatch/resolve.ts) so the GitHub round trip overlaps the
    // memory read below; awaited after the ack.
    const {
      needsRepo,
      repoCtxP,
      modelCard,
      decisions: cardDecisions,
    } = resolveTarget(deps, {
      msg,
      history,
      agent,
      profile,
      resolved,
      resume,
      root,
      ...(threadPr ? { records: { pr: threadPr } } : {}),
      ...(inheritedRepo !== undefined ? { operatorRepo: inheritedRepo } : {}),
      ...(operationTarget !== undefined && (agent.name !== "review" || operationTarget.prTarget !== undefined)
        ? { operationTarget }
        : {}),
      ...(earlyRepoTarget !== undefined ? { repoTarget: earlyRepoTarget } : {}),
    });

    // Cross-session memory — READ path, started here (dispatch/provision.ts) so
    // the memory Worker round trip overlaps the repo/PR resolution and the
    // attach; awaited when the prompt is composed.
    const memoryBlockP = startMemoryRead(deps, {
      msg,
      directives,
      repoCtxP,
      root,
      authorizeMemory: contextReader.authorizeMemory,
      onContext: (context) => {
        memoryContext = context;
      },
    });

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
    // A restart that carries its predecessor's identity keeps the original
    // start too (run-history item 54): the card and the record span one run.
    const startedAt = carriedRow?.startedAt ?? opts.restartCarried?.startedAt ?? receivedAt;
    const ack = await openAckCard(deps, { msg, io, agent, resolved, startedAt, clock, root, trace, route });
    const { shell, card } = ack;
    setupCard = card;
    setupShell = shell;
    setupHeartbeat = ack.heartbeat;
    // The references step's one refusal line (record 0037), held from the step
    // above until the card existed so it reads as the first line under the
    // run, not a reply to nothing. Nothing between the step and the
    // ack ends the dispatch, so it posts exactly once whenever anything was
    // refused; the `[references]` log lines were written by the step itself.
    // Rendered through the seam with the first refused token's code (record
    // 0054): the sentence stays record 0037's one line; the code and the
    // cause live on the span alone.
    if (references.refused.length > 0)
      await renderRefusal(refusalOf(referenceRefusalCode(references.refused[0]), REFERENCE_REFUSAL), io);

    // The repo/ref resolution started above (before the ack) lands here; the
    // gate below runs against it exactly as before.
    // `let`: the attach-head check below may adopt the PR's current head when
    // the branch moved between resolution and attach (item 12).
    const restartEvidence = restart ? restartEvidenceOf(restart.row, restart.events) : opts.restartCarried;
    let repoCtx: RepoContext = carriedRepoContext(await repoCtxP, restartEvidence?.repoCtx);

    if (
      recovery !== undefined &&
      (agent.name === "review" || agent.name === "coding") &&
      (repoCtx.repo?.toLowerCase() !== recovery.repo.toLowerCase() ||
        repoCtx.pr !== recovery.pr ||
        repoCtx.ref !== recovery.headRef ||
        repoCtx.baseRef !== recovery.baseRef ||
        repoCtx.headSha !== recovery.expectedHeadSha)
    ) {
      const reason = "the recovered pull request moved or no longer matches its durable target";
      await refuse(refusalOf("setup_failed", reason), () =>
        card.done(shell.close({ kind: "refused", icon: "🚫", reason, ...closeLines(clock(), false) })),
      );
      return ended;
    }
    if (recovery !== undefined) {
      const remainingMinutes = Math.floor((recovery.deadlineAt - clock()) / 60_000);
      if (remainingMinutes <= 0) {
        const reason = "the original unit's absolute recovery deadline expired during setup";
        await refuse(refusalOf("setup_failed", reason), () =>
          card.done(shell.close({ kind: "refused", icon: "🚫", reason, ...closeLines(clock(), false) })),
        );
        return ended;
      }
      profile = { ...profile, minutes: Math.min(profile.minutes, remainingMinutes) };
    }

    // A coordinator child's ref hint is its contract's branch, always (issue
    // 1860): a pull request cited in the child's own request text is a
    // receipt, never the attach target — a PR-derived ref (`refFromPr`) would
    // rebind the attach off the unit branch, the resident's push guard would
    // refuse the contract branch, and the commit would orphan on the cited
    // branch. The resolver's comment on `refFromPr` says a consumer that does
    // not bind the PR must drop its ref; the coding child does not bind it —
    // its facts stay context — and the head sha goes with the ref (it pinned
    // the cited PR's head, not the contract branch). A review child keeps the
    // binding: the pull request IS its target.
    const contractBranch = opts.contract?.rebase.branch;
    if (coordinator?.branch && contractBranch && coordinator.branch !== contractBranch)
      throw new Error("the coordinator contract branch differs from its durable unit branch");
    const coordinatorBranch = coordinator?.branch ?? contractBranch;
    if (coordinator && agent.name === "coding") {
      const targets = [recovery?.headRef, coordinator.publication?.headRef, coordinatorBranch]
        .filter((value): value is string => value !== undefined)
        .map((value) => (value.startsWith("refs/heads/") ? value : `refs/heads/${value}`));
      if (targets.some((value) => value !== targets[0]))
        throw new Error("the coordinator's durable branch targets disagree");
      if (coordinator.publication && repoCtx.repo?.toLowerCase() !== coordinator.publication.repo.toLowerCase())
        throw new Error("the coordinator's publication repository differs from the resolved repository");
    }
    if (
      coordinator !== undefined &&
      coordinatorBranch !== undefined &&
      agent.name === "coding" &&
      repoCtx.ref !== coordinatorBranch
    ) {
      const { refFromPr: _refFromPr, headSha: _headSha, ...kept } = repoCtx;
      repoCtx = { ...kept, ref: coordinatorBranch };
    }

    // The other half of issue 1860: a cited pull request that did NOT bind the
    // ref (merged or closed — `refFromPr` unset — or a phrase's ref standing
    // beside it) still resolved a frozen `headSha`. Riding the attach as the
    // expected commit (resident-repos item 51's `wantSha`) it can only refuse:
    // no fetch brings a live branch's tip to a dead pull request's frozen
    // head, the resident answers `stale-tip`, and the run falls back cold at
    // the dead commit — the coordinator child off its unit branch, the plain
    // ask off the default. For a non-review run the sha pins the ref that came
    // with the same open PR, or an accepted ref verified as that PR's head;
    // otherwise it is context, never the attach's expected commit. A review
    // run keeps it: the pull request is its target and the sha pins that head.
    const matchedAcceptedPrHead =
      operationTarget?.ref !== undefined &&
      repoCtx.pr !== undefined &&
      repoCtx.ref === operationTarget.ref &&
      /^[0-9a-f]{40}$/.test(repoCtx.headSha ?? "");
    if (
      agent.name !== "review" &&
      repoCtx.prFromMessage === true &&
      repoCtx.refFromPr !== true &&
      !matchedAcceptedPrHead &&
      repoCtx.headSha !== undefined
    ) {
      const { headSha: _headSha, ...kept } = repoCtx;
      repoCtx = kept;
    }

    // A direct typed coding act keeps an accepted branch when one was named.
    // A repository-only target may resolve its branch from the request or PR.
    const directCodingTarget = !coordinator && agent.name === "coding" ? operationTarget : undefined;
    if (
      directCodingTarget !== undefined &&
      directCodingTarget.ref === undefined &&
      repoCtx.prFromMessage === true &&
      repoCtx.pr !== undefined &&
      (repoCtx.refFromPr !== true || !/^[0-9a-f]{40}$/.test(repoCtx.headSha ?? ""))
    ) {
      const reason = "The requested pull request head could not be verified. Retry this task when GitHub can read it.";
      await refuse(refusalOf("pr_head_unknown", reason), () =>
        card.done(shell.close({ kind: "not_started", icon: "🔀", reason, ...closeLines(clock(), false) })),
      );
      return ended;
    }
    if (
      directCodingTarget &&
      (repoCtx.repo?.toLowerCase() !== directCodingTarget.repo.toLowerCase() ||
        (directCodingTarget.ref !== undefined && repoCtx.ref !== directCodingTarget.ref))
    )
      throw new Error("the accepted coding branch is missing or differs from the resolved target");

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
    const clip = budgetClipLabel(agent, profile, directives.budget, {
      coordinator: opts.coordinator !== undefined,
      operator: directives.interpreter === "operator",
    });
    if (clip) shell.note("debug", clip);

    // A coordinator child already carries the reservation on its contract. A
    // direct coding directive that asks to write a record reserves here, after
    // the repository gate and before its brief, attach or model turn. Re-issues
    // read the same task key from prior run records; the allocator closes the
    // concurrent interval before either task has an open pull request.
    decisionRecord = opts.contract?.record ?? carriedRow?.meta.record;
    decisionRecordTask = carriedRow?.meta.recordTaskKey;
    if (
      decisionRecord === undefined &&
      agent.name === "coding" &&
      agentSource === "directive" &&
      repoCtx.repo !== undefined &&
      asksForDecisionRecord(directives.text)
    ) {
      decisionRecordTask = decisionRecordTaskKey(
        repoCtx.repo,
        msg.threadKey,
        shipUnitText(directives.text, repoCtx.repo).trim(),
      );
      const prior = await priorDecisionRecord(deps.runStore, msg.threadKey, repoCtx.repo, decisionRecordTask);
      const reserve =
        deps.reserveDecisionRecord ??
        (async () => {
          throw new DecisionRecordReservationUnavailableError();
        });
      try {
        decisionRecord = await reserve(repoCtx.repo, decisionRecordTask, prior);
      } catch (error) {
        if (!(error instanceof DecisionRecordReservationUnavailableError)) throw error;
        await refuse(refusalOf("decision_record_store_unavailable", DECISION_RECORD_STORE_REFUSAL), () =>
          card.done(
            shell.close({
              kind: "not_started",
              icon: "⚠️",
              reason: "durable coordinator store unavailable",
              ...closeLines(clock(), false),
            }),
          ),
        );
        return ended;
      }
    }

    // agent:ship fork (docs/reference/specs/agent-ship.md): after agent resolution and the
    // repo gates above, BEFORE the top-level attach — ship attaches nothing
    // here; the plan runner's children each attach their own workspace as
    // runs of their own. The branch owns everything from here: the preflight
    // refusals, the one run record, the hand-off to the runner, the reply. An
    // unexpected throw propagates to the outer catch after the branch closed
    // its own card and persisted its failed record.
    if (agent.name === "ship") {
      let context: UnitContext | undefined;
      if (opts.parentContext !== undefined) {
        const handoff = opts.parentContext.handoff;
        if (!isChildHandoff(handoff)) throw new Error("The parent context cannot be durably captured.");
        const consumer = { ...handoff.source, attempt: handoff.source.runId };
        const access = await handoffFactory({ consumer, msg, io });
        const captured = await validateChildHandoff({
          value: handoff,
          consumer,
          mode: "capture",
          deps: access,
          inline: opts.parentContext,
        });
        if (captured.kind !== "valid") throw new Error("The parent context cannot be durably captured.");
        context = contextCapsuleOf(captured.context.handoff);
      }
      setupCard = undefined; // the ship branch owns the card from here
      clearInterval(setupHeartbeat);
      shipForked = true;
      const branchEnd = await (deps.shipBranch ?? runShipBranch)(deps, msg, io, {
        agent,
        ...(context ? { context } : {}),
        profile,
        modelRef: resolved.modelRef,
        label: shell.label,
        verbosity: resolved.verbosity,
        startedAt,
        card,
        directives,
        ...(operatorShipEntry !== undefined ? { shipEntry: operatorShipEntry } : {}),
        ...(opts.redispatch?.code === "ship_preflight_pr_work_question" && opts.redispatch.binding
          ? { confirmedPrWork: opts.redispatch.binding }
          : {}),
        ...(operatorRepoSource !== undefined ? { shipRepoSource: operatorRepoSource } : {}),
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
        onHosted: () => {
          shipHostedLive = true;
        },
        ...(route ? { route } : {}),
        ...(operatorEvent ? { operator: operatorEvent } : {}),
      });
      shipHostedLive ||= branchEnd.hostedLive;
      // Original-unit recovery returns before Ship registers a run. Keep a
      // shadow decision on the door record instead of losing its audit trail.
      if (originalRecoveryCommand) await recordPendingOperator();
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
    // Beside the seed, the thread's artifacts since the agent's previous run
    // (session-log item 9; dispatch/threadArtifacts.ts): the records of the
    // finished runs newer than that run — another agent's, a coordinator's
    // child — read off the same page, whatever the seed's source, and rendered
    // as data into the prompt (composePrompt below), never into the
    // conversation. The main agent does not inherit specialist artifacts:
    // their source audience cannot be proven from those records, so it must
    // check the source itself before using or sharing a specialist result.
    // When both reads apply, they are independent reads of the same thread.
    const sessionIdentity = runSessionIdentity(
      msg.threadKey,
      agent.name,
      coordinator,
      resume?.row.meta.session ?? restart?.row.meta.session,
    );
    const runSessionKey = sessionIdentity.key;
    const [fromSession, threadArtifacts] = await Promise.all([
      !resume && !opts.seed && !hasHandoff && thread
        ? sessionSeedFor({
            ledger: deps.runLedger,
            threadKey: msg.threadKey,
            agent: agent.name,
            sessionKey: runSessionKey,
            ...(sessionIdentity.legacyKey ? { legacySessionKey: sessionIdentity.legacyKey } : {}),
            thread,
            history,
            request: {
              text: requestText,
              ...(msg.images ? { images: msg.images } : {}),
              ...(msg.documents ? { documents: msg.documents } : {}),
              ...(references.blocks.length > 0 ? { references: references.blocks } : {}),
              actor: msg.userId,
            },
          })
        : undefined,
      thread && agent.name !== "orchestrator"
        ? threadArtifactsFor({
            runs: runsService,
            thread,
            agent: agent.name,
            readContext: contextReader.readRunDependencies,
          })
        : undefined,
    ]);
    // A bare continuation after an unanswered general budget uses the original
    // request, not a session tail carrying source results whose grant or
    // revision may have changed. Only the original requester can reuse it.
    let sourceContinuation: string | undefined;
    if (
      (agent.name === "general" || agent.name === "research") &&
      requestText.trim().toLowerCase() === "continue" &&
      thread
    ) {
      const previous = thread.find((view) => view.finished && view.agent === agent.name && !view.parentInstanceId);
      if (previous) {
        const prior = await runsService.getRun(previous.id, { include: "messages" }).catch(() => undefined);
        if (!prior?.ok || !prior.value.events) {
          await refuse(
            refusalOf(
              "setup_failed",
              "I couldn't recover the earlier question in this conversation; no source was read.",
            ),
          );
          return ended;
        }
        const events = prior.value.events;
        if (
          !isBudgetAnswer(prior.value.answerOutcome) &&
          events.some((event) => event.type === "run_note" && event.kind === "time_budget_exhausted")
        ) {
          await refuse(
            refusalOf("setup_failed", "I couldn't verify the saved result of that source lookup; no source was read."),
          );
          return ended;
        }
        if (isBudgetAnswer(prior.value.answerOutcome)) {
          if (previous.userId !== msg.userId) {
            await refuse(refusalOf("setup_failed", "Only the original requester can continue that source lookup."));
            return ended;
          }
          const missingQuestion = () =>
            refuse(
              refusalOf(
                "setup_failed",
                "I couldn't recover the earlier question in this conversation; no source was read.",
              ),
            );
          const original = events.find((e) => e.type === "input");
          if (!original || original.type !== "input") {
            await missingQuestion();
            return ended;
          }
          let question = original.text;
          // A continued run records its actual input ("continue"), not the
          // reconstructed ask. Walk only verified, same-requester budget closes
          // until we reach the original input; never use an old source result.
          let older = thread.slice(thread.findIndex((view) => view.id === previous.id) + 1);
          const oldest = thread.at(-1);
          let before = oldest?.finishedAt !== undefined ? { finishedAt: oldest.finishedAt, id: oldest.id } : undefined;
          let pages = 0;
          while (question.trim().toLowerCase() === "continue") {
            if (older.length === 0) {
              if (!before || pages++ >= 10) {
                await missingQuestion();
                return ended;
              }
              const page = await runsService
                .listRuns({
                  status: "all",
                  visibleTo: { kind: "all" },
                  threadKey: msg.threadKey,
                  limit: RUN_LIST_MAX_LIMIT,
                  before: before.finishedAt,
                  beforeId: before.id,
                })
                .catch(() => undefined);
              if (!page || page.storeUnavailable || page.ledgerUnavailable || page.runs.length === 0) {
                await missingQuestion();
                return ended;
              }
              older = page.runs;
              before = page.nextBefore;
            }
            const ancestor = older.shift()!;
            if (!ancestor.finished || ancestor.agent !== agent.name || ancestor.parentInstanceId) continue;
            if (ancestor.userId !== msg.userId) {
              await refuse(refusalOf("setup_failed", "Only the original requester can continue that source lookup."));
              return ended;
            }
            const record = await runsService.getRun(ancestor.id, { include: "messages" }).catch(() => undefined);
            const ancestorEvents = record?.ok ? record.value.events : undefined;
            if (!record?.ok || !isBudgetAnswer(record.value.answerOutcome) || !ancestorEvents) {
              await missingQuestion();
              return ended;
            }
            const input = ancestorEvents.find((e) => e.type === "input");
            if (!input || input.type !== "input") {
              await missingQuestion();
              return ended;
            }
            question = input.text;
          }
          sourceContinuation = question;
        }
      }
    }
    // Saved text is reusable only with its complete current dependency envelope.
    // An unavailable optional context leaves the new request runnable.
    const candidateContext = contextDependenciesOf(fromSession?.seed?.sources);
    const savedContextValid =
      fromSession?.seed !== undefined && (await contextReader.validateDependencies(candidateContext)).ok;
    const sourceSession = savedContextValid ? fromSession?.seed : undefined;
    const session = sourceContinuation !== undefined ? undefined : sourceSession;
    const mainHistory = history.filter(
      (item) => item.role === "user" && (agent.name !== "orchestrator" || item.user === msg.userId),
    );
    let seedContext = mergeContextDependencies(
      freshContext(),
      operatorContext,
      ...(opts.seed ? [UNKNOWN_CONTEXT_DEPENDENCIES] : []),
      contextForReferences(references, msg),
      ...(session ? [candidateContext] : []),
      ...(threadArtifacts?.context ? [threadArtifacts.context] : []),
    );
    const seedNotes = [
      ...(sourceContinuation === undefined ? (fromSession?.notes ?? []) : []),
      ...(threadArtifacts?.notes ?? []),
      ...(fromSession?.seed && !savedContextValid
        ? ["Earlier saved context could not be verified; this request starts from the available conversation."]
        : []),
    ];
    const recovered = resume !== undefined || restart !== undefined || opts.restartOf !== undefined;
    const sourceReadOwnerOf = (runId: string) => ({
      runId,
      requester: msg.userId,
      agent: agent.name,
      channelId: msg.channelId,
      threadKey: msg.threadKey,
    });
    // Recovery cannot prove whether an indirect source was consumed before the
    // crash. Refuse before a saved plan or session can reach the model.
    if (recovered && privateAudienceRequired(msg)) {
      noteAudienceRefusal(audienceTrace, "recovered-provenance-unproved", "recovery", "prompt");
      await refuse(refusalOf("setup_failed", "This run restarted, so please ask again in a private DM."));
      return ended;
    }
    const needsSavedSlackRecheck =
      agent.name === "orchestrator" &&
      /^slack:D[A-Z0-9_]+$/.test(msg.channelId) &&
      savedSlackContextNeedsRecheck(sourceSession, mainHistory);
    const savedSlackVisibility = needsSavedSlackRecheck
      ? await root.span("dispatch.channel_visibility", () => channelVisibilityOf(deps, msg.channelId))
      : undefined;
    const savedSlackBinding: SlackContextBinding | undefined = needsSavedSlackRecheck
      ? await bindSlackContext({
          agentName: agent.name,
          actor: chatActorOf(deps.config, msg),
          msg,
          io,
          visibility: savedSlackVisibility!,
          recovered,
          create: deps.slackContextForRun,
        })
      : undefined;
    const savedSlackCheck: AudienceCheck = needsSavedSlackRecheck
      ? savedSlackBinding
        ? await revalidateSavedSlackContextDecision(sourceSession, savedSlackBinding.revalidate)
        : { ok: false, code: "slack-source-unverified" }
      : { ok: true };
    if (!savedSlackCheck.ok) {
      noteAudienceRefusal(audienceTrace, savedSlackCheck.code, "prompt", "prompt");
      await refuse(
        refusalOf(
          "setup_failed",
          "I need to check the Slack source again before using earlier details. Please start a new DM message with the source.",
        ),
      );
      return ended;
    }
    // A new turn in a child's thread continues its own session. The parent's
    // immutable recall view is inherited separately from those accumulated turns.
    if (!hasHandoff && session && !resume && !restart) {
      const previous = thread?.find(
        (view) =>
          view.finished &&
          (view.session?.key === runSessionKey ||
            (sessionIdentity.legacyKey !== undefined && view.session?.key === sessionIdentity.legacyKey)),
      );
      if (previous) {
        const reader = await handoffFactory({
          consumer: {
            runId: previous.id,
            requester: msg.userId,
            channelId: msg.channelId,
            threadKey: msg.threadKey,
            attempt: previous.id,
          },
          msg,
          io,
        });
        const prior = await reader.loadRun(previous.id);
        if (!prior) throw new Error("The previous conversation's stored context could not be checked.");
        if (prior.childHandoff !== undefined) {
          incomingHandoff = prior.childHandoff;
          hasHandoff = true;
          continuedHandoff = true;
        }
      }
    }
    const seed: RunSeed = opts.seed || (hasHandoff && !continuedHandoff) ? "parent" : session ? "session" : "channel";
    const seedTurns: TextTurn[] | undefined =
      hasHandoff && !continuedHandoff
        ? []
        : (opts.seed ?? (session ? textTurnsOf(session.messages.slice(0, -1)) : undefined));
    // The channel (and parent) seed keeps its authors too (session-log item 12):
    // a thread's first run stores each history line's author and the request row
    // the requester's, exactly as the session path does through SessionSeed.actors.
    const channelBuilt = session
      ? undefined
      : buildConversation(
          sourceContinuation !== undefined
            ? [{ role: "user", text: sourceContinuation, user: msg.userId }]
            : hasHandoff
              ? []
              : (opts.seed ?? mainHistory),
          requestText,
          msg.images,
          msg.documents,
          references.blocks,
          msg.userId,
        );
    const built = session ? session.messages : channelBuilt!.messages;
    let seedActors = session ? session.actors : channelBuilt?.actors;
    const withRecord =
      !resume && decisionRecord !== undefined && agent.name === "coding"
        ? withContractInFirstUserTurn(built, `record: ${decisionRecord}`)
        : built;
    const messages = resume
      ? resume.plan.messages
      : contractBlock !== undefined && agent.name !== "review"
        ? withContractInFirstUserTurn(withRecord, contractBlock)
        : withRecord;

    // Executor selection is context-aware: the agent's resource declarations
    // decide whether anything is provisioned at all (general gets nothing),
    // and repo/ref carry resident-repo inference. A resident fallback comes
    // back with a named note that rides on every status frame below.
    // Unknown-head check (dispatch/authorize.ts): a review whose PR head could
    // not be resolved is not started, before any attach.
    if (coordinator && agent.name === "review" && !coordinator.publication) {
      await refuse(refusalOf("workspace_head_mismatch", "The saved review target could not be verified."));
      return ended;
    }
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
      ...(coordinator?.publication ? { publication: coordinator.publication } : {}),
    });
    if (headPreflight.kind === "refused") return ended;
    if (agent.name === "review" && repoCtx.repo !== undefined && repoCtx.pr !== undefined)
      setupReviewTarget = { repo: repoCtx.repo, pr: repoCtx.pr };

    // Reserve before publishing the registry row and link. Setup finishes that
    // same row if the model never starts.
    // A child names its parent on every row (run-history item 46) — a run in a
    // spawned thread the same parent; a coordinator's child its instance and
    // key (item 48).
    const parentRunId = parent?.runId;
    // A resumed run carries its coordinator tag forward (run-history item 48a):
    // the spawn's dispatch options are gone with the process that spawned it,
    // so the tag is rebuilt from the adopted row's meta and the
    // `coordinator_tag` event the spawning dispatch published.
    // `coordinator` was reconstructed before profile resolution so its
    // recovery deadline constrains every resumed/restarted phase.
    const reserveIdentity = async (runId: string, channelVisibility: ChannelVisibility) => {
      assertOriginalActionBudget();
      const reservation = await reserveRun(deps, {
        msg,
        agent,
        profile,
        resolved,
        repoCtx,
        ...(operationTarget !== undefined && (agent.name !== "review" || operationTarget.prTarget !== undefined)
          ? { operationTarget }
          : {}),
        channelVisibility,
        runId,
        startedAt,
        receivedAt,
        resume,
        restart,
        card,
        hooks: reservationHooks,
        route,
        admitted: admitted!,
        root,
        parentRunId,
        ...(boundHandoff ? { childHandoff: boundHandoff } : {}),
        coordinator,
        seed,
        ...(decisionRecord !== undefined ? { decisionRecord } : {}),
        ...(decisionRecordTask !== undefined ? { decisionRecordTask } : {}),
        ...(opts.restartOf !== undefined ? { restartOf: opts.restartOf } : {}),
      });
      if (reservation) {
        reserved = reservation.reserved;
        requestRow = reservation.requestRow;
        setupUntrackedWhy = reservation.untrackedWhy;
      }
    };

    const installSetupFinalizer = (runId: string, channelVisibility: ChannelVisibility) => {
      const reservation = reserved;
      // The same finalizer serves every admitted run.
      setupFinalizer = () => {
        if (setupFinished || setupTerminalHeld || runLoopStarted || fencedWhileAttaching) return;
        setupFinished = true;
        const status =
          stoppedWhileAttaching === "hard"
            ? "stopped_hard"
            : stoppedWhileAttaching === "soft"
              ? "stopped_soft"
              : "failed";
        finishSetupRun(deps, {
          audience: audienceTrace,
          runId,
          registry,
          ...(reservation ? { ledgerRun: reservation } : {}),
          ending,
          root,
          msg,
          agent,
          profile,
          resolved,
          repoCtx,
          channelVisibility,
          ...(coordinator !== undefined ? { coordinator } : {}),
          ...(parentRunId !== undefined ? { parentRunId } : {}),
          seed,
          finishedAt: clock(),
          status,
          ...(setupFailure !== undefined ? { failure: setupFailure } : {}),
          refusal: setupRefusal ?? refusalOf("setup_failed", "The run ended before its model started."),
        });
        try {
          io.runFinished?.({ id: runId, status });
        } catch {
          console.warn(`[dispatch] run ${runId}: setup finish notification failed`);
        }
      };
    };

    const registration = await registerRun(deps, {
      msg,
      io,
      ...((!resume && !restart) || hasHandoff
        ? {
            beforeRegister: async ({
              runId,
              channelVisibility,
            }: {
              runId: string;
              channelVisibility: ChannelVisibility;
            }) => {
              if (hasHandoff) {
                const saved = isChildHandoff(incomingHandoff) ? incomingHandoff : undefined;
                handoffConsumer = {
                  runId,
                  requester: msg.userId,
                  channelId: msg.channelId,
                  threadKey: msg.threadKey,
                  attempt:
                    saved?.consumer?.runId === runId
                      ? saved.consumer.attempt
                      : (opts.unitContextAdmission?.idempotencyKey ?? runId),
                };
                handoffAccess = await handoffFactory({ consumer: handoffConsumer, msg, io });
                if (!handoffAccess) throw new Error("The child context storage and source checks are unavailable.");
                const checked = await validateChildHandoff({
                  value: incomingHandoff,
                  consumer: handoffConsumer,
                  mode: saved?.consumer
                    ? saved.consumer.runId === runId
                      ? "consume"
                      : "inherit"
                    : opts.unitContextAdmission
                      ? "admitted-bind"
                      : "bind",
                  ...(opts.unitContextAdmission ? { admission: opts.unitContextAdmission } : {}),
                  deps: handoffAccess,
                  ...(opts.parentContext ? { inline: opts.parentContext } : {}),
                });
                if (checked.kind !== "valid")
                  throw new Error(checked.kind === "invalid" ? checked.reason : "The parent context is missing.");
                boundHandoff = checked.context.handoff;
                if (!resume && !continuedHandoff) {
                  // Only canonical rows enter the prompt. Historical tool calls
                  // are evidence; unfinished calls were rendered as text.
                  const childRequest = buildConversation(
                    [],
                    requestText,
                    msg.images,
                    msg.documents,
                    references.blocks,
                    msg.userId,
                  );
                  let combined = [...checked.context.messages, ...childRequest.messages];
                  if (decisionRecord !== undefined && agent.name === "coding")
                    combined = withContractInFirstUserTurn(combined, `record: ${decisionRecord}`);
                  if (contractBlock !== undefined && agent.name !== "review")
                    combined = withContractInFirstUserTurn(combined, contractBlock);
                  messages.splice(0, messages.length, ...combined);
                  seedActors = [
                    ...(checked.context.actors ?? checked.context.messages.map(() => undefined)),
                    ...(childRequest.actors ?? childRequest.messages.map(() => undefined)),
                  ];
                  seedTurns!.push(...textTurnsOf(checked.context.messages));
                }
              }
              if (!resume && !restart) await reserveIdentity(runId, channelVisibility);
            },
          }
        : {}),
      ...(!resume && !restart
        ? {
            afterCreate: ({ runId, channelVisibility }: { runId: string; channelVisibility: ChannelVisibility }) => {
              installSetupFinalizer(runId, channelVisibility);
              // A reserve-time refusal predates registry.create. Publish its
              // reason only now, so the live stream and final record keep it.
              const why = setupUntrackedWhy;
              if (why === undefined) return;
              registry.publish(runId, {
                type: "run_note",
                kind: "ledger_untracked",
                summary: redactAndCap(
                  oneLine(
                    `not tracked by the run ledger: ${why} — no handoff, resume or reclaim reaches this run; its record still reaches the store`,
                  ),
                  500,
                ),
                at: clock(),
              });
              shell.note("debug", "untracked by the ledger");
            },
            linkable: () => setupUntrackedWhy === undefined,
          }
        : {}),
      agent,
      resolved,
      directives,
      history,
      repoCtx,
      carriedRow,
      resume,
      restart,
      startedAt,
      receivedAt,
      clock,
      root,
      trace,
      registry,
      ...(savedSlackVisibility !== undefined ? { channelVisibility: savedSlackVisibility } : {}),
      shell,
      admitted,
      parentRunId,
      coordinator,
      seed,
      ...(opts.restartOf !== undefined ? { restartOf: opts.restartOf } : {}),
      ...(opts.restartCarried !== undefined ? { restartCarried: opts.restartCarried } : {}),
      ...(seedTurns ? { seedTurns } : {}),
      agentSource,
      ...(decisionRecord !== undefined ? { decisionRecord } : {}),
      ...(decisionRecordTask !== undefined ? { decisionRecordTask } : {}),
      modelCard,
      cardDecisions,
      ...(operatorEvent ? { operator: operatorEvent } : {}),
      ...(references.conversations.length > 0 ? { references } : {}),
    });
    const { run, runId, channelVisibility, liveUrl, events, publishText, publishMeta } = registration;
    registered = run;
    if (pendingStop) {
      run.control.requestStop(pendingStop);
      pendingStop = undefined;
    }
    // What the session seed could not do (session-log item 9), on the record
    // before the first turn — the run is not changed by it.
    for (const summary of seedNotes)
      events.publish({ type: "run_note", kind: "seed", summary: oneLine(summary), at: clock() });
    // A redispatched request's record names the question it answered
    // (record 0054; run-history item 2): the code the refusal carried, so the
    // Yes-run is traceable to the question whose proposal it ran.
    if (opts.redispatch)
      events.publish({
        type: "run_note",
        kind: "redispatch",
        summary: `confirmed after question ${opts.redispatch.code}`,
        at: clock(),
      });
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
            preserveWorkspaceIndexes: true,
            publish: (event) => events.publish(event),
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
    const artifactContexts: ContextDependencies[] = [];
    const ownThreadAssets: Promise<ThreadAsset[]> | undefined =
      sourceIntake === "automatic" && !resume && deps.artifacts && thread && thread.length > 0
        ? readThreadAssets(
            { runs: runsService, store: deps.artifacts, trustedCoordinatorChild: opts.coordinator !== undefined },
            msg.threadKey,
          ).then(async (assets) => {
            const contexts = new Map<string, ContextDependencies | undefined>();
            const admitted: ThreadAsset[] = [];
            for (const asset of assets) {
              if (asset.runId === runId) continue;
              if (!contexts.has(asset.runId)) {
                const context = await contextReader.readRunDependencies(asset.runId);
                contexts.set(asset.runId, context);
                if (context) artifactContexts.push(context);
              }
              if (contexts.get(asset.runId)) admitted.push(asset);
            }
            return admitted;
          })
        : undefined;
    const inheritedAssetKeys = new Set<string>();
    const threadAssets =
      boundHandoff && handoffAccess && handoffConsumer
        ? Promise.resolve(
            await (async (): Promise<ThreadAsset[]> => {
              const inherited: ThreadAsset[] = [];
              for (const source of [boundHandoff!, ...(boundHandoff!.ancestors ?? [])]) {
                if (!(await handoffAccess!.canRead(source, handoffConsumer!)))
                  throw new Error("The inherited files are no longer readable.");
                const files = await handoffAccess!.readAssets(source);
                for (const file of files) {
                  if (!source.omitted?.assets && !source.assets.some((a) => a.key === file.key)) continue;
                  inheritedAssetKeys.add(file.key);
                  inherited.push(file);
                }
              }
              return [
                ...new Map([...((await ownThreadAssets) ?? []), ...inherited].map((file) => [file.key, file])).values(),
              ];
            })(),
          )
        : ownThreadAssets;
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
              assets.filter((a) => a.direction === "in" || inheritedAssetKeys.has(a.key)),
              {
                nextIndex: nextStagedIndex,
                messageId: messageIdOf(msg, runId),
                publish: (event) => events.publish(event),
              },
            ),
          )
        : undefined;

    // Admission owns the first live condition. Its absolute bound is the
    // effective run budget already admitted for this profile, and the durable
    // assignment acknowledges before the registry exposes the boundary or
    // workspace attachment starts. Legacy resumed rows gain the same first
    // state before they continue; rows that already carry one keep it.
    const resumeNeedsSegment =
      resume !== undefined && (resume.row.liveState !== undefined || registry.getById(runId)?.liveState !== undefined);
    const admissionAt = clock();
    const segmentBound = resume
      ? admissionAt + resume.plan.remainingMs
      : Math.max(startedAt, admissionAt) + minutesToMs(profile.minutes);
    const admissionBound = originalDeadline === undefined ? segmentBound : Math.min(originalDeadline, segmentBound);
    assertOriginalActionBudget(admissionAt);

    if (typeof registry.commitLiveState === "function") {
      await events.write(async () => {
        const current = registry.getById(runId);
        if (current && current.liveState === undefined) {
          const at = clock();
          assertOriginalActionBudget(at);
          const eventSeq = current.eventCount + 1;
          const assignment = {
            expectedSeq: 0,
            eventSeq,
            at,
            state: "admitted" as const,
            bound: admissionBound,
            detail: "waiting to attach the workspace",
            // A reservation is not subscribed to the registry until promotion.
            // Commit the setup stream that already exists with admission, or
            // advancing its ledger cursor here would make promotion skip it.
            ...(reserved
              ? {
                  sourceEvents: (registry.snapshotById(runId)?.events ?? []).map((event) => ({
                    ...event,
                    seq: event.seq!,
                  })),
                }
              : {}),
            ...((current.liveStateSeq ?? 0) > 0 ? { restart: true } : {}),
          };
          const tracked = reserved ?? ledgerRun;
          if (tracked?.tracked()) {
            let committed = await tracked.assignLiveState(assignment);
            // A failed finish can leave the predecessor's row standing. Its
            // stream is already durable, so retry the new segment against that
            // projection sequence without inserting the replay twice.
            if (!committed.ok && committed.reason === "stale-sequence" && (current.liveStateSeq ?? 0) > 0)
              committed = await tracked.assignLiveState({
                ...assignment,
                expectedSeq: current.liveStateSeq ?? 0,
                sourceEvents: undefined,
                restart: true,
              });
            if (!committed.ok || !registry.commitLiveState(runId, committed))
              throw new Error(
                `live state admission was not committed (${committed.ok ? "registry sequence" : committed.reason})`,
              );
          } else {
            const expectedSeq = current.liveStateSeq ?? 0;
            const local = assignRunLiveState(undefined, expectedSeq, { ...assignment, expectedSeq });
            if (!local.ok || !local.event) throw new Error("live state admission was invalid");
            registry.commitLiveState(runId, {
              ...local,
              event: { ...local.event, seq: eventSeq },
              liveStateSeq: eventSeq,
            });
          }
        }
      });
    }

    // Admission commits the reserved identity and setup stream, including the coordinator tag, before notifying its owner.
    if (coordinator) {
      assertOriginalActionBudget();
      if (!(reserved ?? ledgerRun)?.tracked() || typeof registry.commitLiveState !== "function")
        throw new Error("the coordinator child has no durable admission receipt");
      io.runStarted?.({ id: runId });
    }

    type LiveCommit = { ok: true } | LiveCommitFailure;
    const assignLive = async (
      next:
        | Pick<ResidentLiveStateObservation, "state" | "bound">
        | {
            state: "admitted" | "preparing" | "working" | "falling_back" | "waiting_provider" | "wrapping_up";
            bound: number;
          },
      at: number,
      detail?: string,
      intent: "ordinary" | "resume-segment" = "ordinary",
    ): Promise<LiveCommit> => {
      if (typeof registry.commitLiveState !== "function") return { ok: true };
      let result: LiveCommit = { ok: false, kind: "missing-run", reason: "registry row missing" };
      await events.write(async () => {
        const summary = registry.getById(runId);
        if (!summary) return;
        const eventSeq = summary.eventCount + 1;
        const assignment = {
          expectedSeq: summary.liveStateSeq ?? 0,
          eventSeq,
          at,
          state: next.state,
          bound: next.bound,
          ...(detail !== undefined ? { detail } : {}),
          ...(intent === "resume-segment" ? { resumeSegment: true } : {}),
        };
        const tracked = ledgerRun ?? reserved;
        const committed = tracked
          ? await tracked.assignLiveState(assignment)
          : (() => {
              const local = assignLedgerLiveState(summary.liveState, summary.liveStateSeq ?? 0, assignment);
              return local.ok
                ? {
                    ...local,
                    ...(local.event ? { event: { ...local.event, seq: eventSeq } } : {}),
                    liveStateSeq: local.event ? eventSeq : (summary.liveStateSeq ?? 0),
                  }
                : local;
            })();
        if (!committed.ok) {
          result = {
            ok: false,
            kind: committed.reason === "unavailable" ? "durable-unavailable" : "durable-rejection",
            reason: committed.reason,
          };
          return;
        }
        if (!registry.commitLiveState?.(runId, committed)) {
          result = { ok: false, kind: "projection-rejection", reason: "registry sequence or sealed row" };
          return;
        }
        result = { ok: true };
      });
      return result;
    };
    let residentAttachAttempt = 0;
    const observeResidentLiveState = async (observation: ResidentLiveStateObservation): Promise<void> => {
      if (observation.attempt < residentAttachAttempt) return;
      residentAttachAttempt = observation.attempt;
      const accepted = await assignLive(
        { state: observation.state, bound: Math.min(observation.bound, admissionBound) },
        clock(),
        liveStateWords(observation.state),
      );
      if (!accepted.ok) throw new LiveStateCommitError("resident observation", accepted);
      shell.setSetupLabel(`${liveStateWords(observation.state)}…`);
    };

    // The same revocable run bearer also authenticates Git/gh at the trusted
    // door. Mint it before attach so a cold clone never needs an installation
    // token in the workspace. The outer finally revokes it on setup refusal.
    const rawGithubBinding = resume?.row.state.githubDoorBinding;
    const carriedGithubBinding =
      rawGithubBinding && typeof rawGithubBinding === "object" && !Array.isArray(rawGithubBinding)
        ? (rawGithubBinding as { repo?: string; ref?: string; refConfirmed?: boolean })
        : undefined;
    if (
      rawGithubBinding !== undefined &&
      (!carriedGithubBinding ||
        (carriedGithubBinding.repo !== undefined && typeof carriedGithubBinding.repo !== "string") ||
        (carriedGithubBinding.ref !== undefined && typeof carriedGithubBinding.ref !== "string") ||
        (carriedGithubBinding.refConfirmed !== undefined && typeof carriedGithubBinding.refConfirmed !== "boolean"))
    )
      throw new Error("the resumed run's GitHub binding is invalid");
    // A coding unit owns its contract branch even before it has a PR. The
    // resolver's branch can be a cited PR or the repository default, neither
    // of which may become this unit's first push target.
    const githubBoundRef =
      coordinator && agent.name === "coding"
        ? (recovery?.headRef ??
          coordinator.publication?.headRef ??
          coordinatorBranch ??
          carriedGithubBinding?.ref ??
          resume?.row.meta.ref)
        : (directCodingTarget?.ref ?? (directCodingTarget || repoCtx.pr ? repoCtx.ref : undefined));
    if (coordinator && agent.name === "coding" && !githubBoundRef)
      throw new Error("the coordinator coding unit has no durable branch target");
    const bearer = mintRunBearer(deps, {
      runId,
      agent,
      ...(modelCard ? { card: modelCard } : {}),
      profile,
      resolved,
      registry,
      root,
      clock,
      github: {
        identity: profile.identity,
        ...(repoCtx.repo ? { repo: repoCtx.repo } : {}),
        ...(githubBoundRef ? { ref: githubBoundRef } : {}),
      },
    });
    const githubDoor = bearer && deps.githubDoor ? { ...deps.githubDoor, bearer } : undefined;
    if (githubDoor && deps.githubBindings && profile.identity !== "none") {
      const registeredBinding = deps.githubBindings.register(
        runId,
        { ...(repoCtx.repo ? { repo: repoCtx.repo } : {}), ...(githubBoundRef ? { ref: githubBoundRef } : {}) },
        carriedGithubBinding,
        async (binding) =>
          ledgerRun?.tracked() ? ledgerRun.setStateAndFlush({ githubDoorBinding: binding }) : deps.hostedRuns !== true,
        // A cited PR is context for a different owned unit branch, not its
        // publication target. A direct open/head PR remains protected as before.
        coordinator?.publication !== undefined ||
          (coordinator === undefined &&
            repoCtx.pr !== undefined &&
            !(repoCtx.prFromMessage === true && repoCtx.refFromPr !== true)),
      );
      if (!registeredBinding) throw new Error("the resumed run's GitHub binding differs from its target");
      // Persist an initial contract target before provisioning. Otherwise a
      // restart before the first push could lose its branch fence.
      if (githubBoundRef && !carriedGithubBinding && ledgerRun?.tracked()) {
        const binding = deps.githubBindings.get(runId);
        if (!binding || !(await ledgerRun.setStateAndFlush({ githubDoorBinding: binding })))
          throw new Error("the coordinator branch binding could not be saved");
      }
    }

    // The workspace attach (dispatch/provision.ts): the setup step that takes
    // minutes on a cold clone, and the ask-once refusal when no branch is bound.
    // A resume re-attaches where its row says the run ran (dispatch/reattach.ts;
    // run-history item 54), never provisioning again; a fresh run attaches as
    // it always did.
    const reattach = resume ? carriedWorkspaceBinding(resume.row) : undefined;
    const currentReadyRequirement =
      agent.name === "coding" && repoCtx.repo !== undefined
        ? deps.config.config.execution?.readyPilotRepos?.[repoCtx.repo.toLowerCase()]
        : undefined;
    // A pilot's saved policy survives config changes. An unstamped older run
    // keeps its ordinary resume behavior; no current config opts it in later.
    const recordedPreservation = resume?.row.state.preserveOnReattachRefusal;
    const preserveOnReattachRefusal = resume
      ? recordedPreservation === true
      : agent.name === "coding" &&
        profile.identity === "write" &&
        repoCtx.repo !== undefined &&
        currentReadyRequirement !== undefined;
    const readyRequirement = resume
      ? recordedReadyRequirement(resume.row.state.readyPilotRequirement)
      : currentReadyRequirement;
    const readyRequirementVerified = !preserveOnReattachRefusal || readyRequirement !== undefined;
    // A pilot cannot edit a checkout whose run has no durable owner. The
    // reservation/adopted row is checked before attachment, then again after
    // promotion in case the ledger detached during setup.
    if (preserveOnReattachRefusal && !(reserved ?? ledgerRun)?.tracked())
      throw new Error("The coding run could not be durably tracked. Restore the run ledger, then retry this task.");
    const pauseResumedPilot = async (
      message: string,
      options: { missingBinding?: boolean; nextAction?: string } = {},
    ): Promise<void> => {
      if (!resume || !ledgerRun) throw new Error("a readiness retry needs the resumed run's ledger row");
      resumeRowRetained = true;
      const handedOff = await ledgerRun.pauseForRetry().catch(() => false);
      if (fencedWhileAttaching) return;
      if (ledgerRun.tracked()) {
        settleRetryPause(
          deps.threadsElsewhere,
          msg.threadKey,
          {
            runId: resume.row.runId,
            agent: resume.row.meta.agent,
            startedAt: resume.row.startedAt,
          },
          ledgerRun.pauseRetained === true,
        );
      }
      const pausedWhere = options.missingBinding
        ? "without starting a replacement"
        : "with its recorded workspace binding";
      const nextAction =
        options.nextAction ??
        (options.missingBinding
          ? "After restoring the binding, restart the service to resume this run."
          : "After repairing the environment, restart the service to resume this run.");
      await refuse(
        refusalOf(
          "setup_failed",
          ledgerRun.pauseStopped
            ? `${message} The original run was hard-stopped and its saved workspace remains intact. No replacement started.`
            : handedOff && ledgerRun.pauseRetained
              ? `${message} This run is paused ${pausedWhere}. ${nextAction}`
              : `${message} The original run could not be confirmed for immediate recovery. No replacement started; an operator needs to check its saved workspace before a retry.`,
        ),
        () =>
          card.done(
            shell.close({
              kind: "not_started",
              icon: "⏸️",
              reason: options.missingBinding
                ? "coding workspace binding missing, original run retained"
                : "coding environment not ready, original binding retained",
              ...closeLines(clock(), false),
            }),
          ),
      );
    };
    if (resume && preserveOnReattachRefusal) pausePilotAfterAttach = pauseResumedPilot;
    if (resume && preserveOnReattachRefusal && !hasPilotWorkspaceBinding(resume.row)) {
      await pauseResumedPilot(
        "The original coding workspace binding is missing or invalid. Repair the saved run record before resuming this task.",
        { missingBinding: true },
      );
      return ended;
    }
    // A resumed run re-enters admission on its existing row and remaining
    // budget before attachment can report waits. Every later boundary follows
    // the ordinary transition table, including post-attach preparation.
    if (resumeNeedsSegment && typeof registry.commitLiveState === "function") {
      const at = clock();
      if (admissionBound <= at) {
        const message = "The original run's time budget ended before its workspace could be reattached.";
        if (preserveOnReattachRefusal) {
          await pauseResumedPilot(message, {
            nextAction: "Review the original run's expired grant before deciding on supported recovery.",
          });
          return ended;
        }
        throw new RefusalError(refusalOf("run_budget_exhausted", message));
      }
      const resumed = await assignLive(
        { state: "admitted", bound: admissionBound },
        at,
        "reattaching the original workspace",
        "resume-segment",
      );
      if (!resumed.ok) {
        const error = new LiveStateCommitError("resume preparation", resumed);
        if (preserveOnReattachRefusal) {
          await pauseResumedPilot(error.message, {
            nextAction:
              "Reconcile the saved run state and owner, then resume this original run through the supported restart path.",
          });
          return ended;
        }
        throw error;
      }
    }
    assertOriginalActionBudget();
    if (originalDeadline !== undefined && admissionBound <= clock())
      throw new RefusalError(refusalOf("run_budget_exhausted", "The original child budget ended before attachment."));
    const control = registered?.control;
    const attach = await attachWorkspace(deps, {
      runId: run.id,
      ownerGen: deps.runLedger.gen,
      setupRemainingMs: () => (runLoopStarted ? undefined : Math.max(0, admissionBound - clock())),
      msg,
      io,
      refuse,
      card,
      shell,
      closeLines,
      clock,
      agent,
      profile,
      ...(githubDoor ? { githubDoor } : {}),
      repoCtx,
      root,
      ...(reattach !== undefined ? { reattach } : {}),
      ...(preserveOnReattachRefusal ? { preserveOnReattachRefusal: true } : {}),
      readyRequirementVerified,
      ...(preserveOnReattachRefusal && readyRequirement !== undefined
        ? { readyRequirementOverride: readyRequirement }
        : {}),
      // The run's control exists from the registry row above: a stop relayed
      // during the attach ends its wake wait at once, and once the harness
      // starts the lease every attach the executor opens is clipped to the
      // run's remaining clock (execution.md item 9).
      ...(control
        ? {
            stopSignal: control.hardSignal,
            remainingMs: () => {
              const remaining = control.remainingMs();
              return resume || coordinator !== undefined || originalDeadline !== undefined
                ? Math.min(remaining ?? Infinity, Math.max(0, admissionBound - clock()))
                : remaining;
            },
          }
        : {}),
      onLiveStateObservation: observeResidentLiveState,
    });
    if (attach.kind === "refused") return ended;
    if (attach.kind === "stopped") {
      // The run's own stop ended the attach: not a failure (no `setup_failed`,
      // no error reply) and never a cold fallback. A fence during the attach
      // requested that stop too, and a fenced dispatch says nothing — the row
      // is another generation's to restart (item 42); otherwise the card says
      // the run was stopped before it started, the stop's card being the word,
      // and the request ends `stopped`.
      if (!fencedWhileAttaching) {
        stoppedWhileAttaching = registered?.control.requested ?? "hard";
        await root.span(
          "dispatch.stop",
          () =>
            card.done(
              shell.close({
                kind: "not_started",
                icon: "⛔",
                reason: "stopped before the run started",
                ...closeLines(clock(), false),
              }),
            ),
          { attrs: { outcome: "stopped_while_attaching" } },
        );
      }
      return ended;
    }
    if (attach.kind === "reattach_refused") {
      // The run's work was on that backend or nowhere: the resumed run closes
      // saying why, and its request runs again as a new run in the thread,
      // provisioned as a fresh run is, after the outer finally frees the thread.
      if (resume) {
        const evidence = restartEvidenceOf(resume.row, resume.events);
        const originalRepoCtx = carriedRepoContext(resume.repoCtx, evidence.repoCtx);
        const abandoned = await abandonLostWorkspace({
          msg,
          io,
          refuse: refuseSilently,
          card,
          shell,
          closeLines,
          clock,
          run,
          registry,
          resume,
          ledgerRun,
          why: attach.why,
          ...(coordinator !== undefined ? { coordinator } : {}),
          ...(deps.workflow !== undefined ? { workflow: deps.workflow } : {}),
        });
        // The restart is the same instance's child (run-history item 48a): the
        // tag rebuilt from the row and its event rides along, as the run loop's
        // interruption carries the tag it ran under. The `restarting` record the
        // row closed with rides too, so a restart dispatch that dies before the
        // successor's claim can end that record for real (issue 2081).
        if (abandoned)
          restartRequest = {
            request: abandoned.request,
            profile,
            restartOf: resume.row.runId,
            note: "workspace lost, resumed from the request",
            ...evidence,
            identityUncertain: evidence.identityUncertain || resume.lastSeq !== resume.events.length,
            repoCtx: originalRepoCtx,
            ...(abandoned.closed !== undefined ? { closed: abandoned.closed } : {}),
            ...(coordinator !== undefined ? { coordinator } : {}),
            ...(operationTarget !== undefined ? { operationTarget } : {}),
          };
        resumeRowClosed = true;
      }
      return ended;
    }
    if (attach.kind === "reattach_unready") {
      await pauseResumedPilot(attach.message);
      return ended;
    }
    const { round } = attach;
    setupRound = round;
    // Cold registration preparation resolved and observed the effective ref.
    // Keep it in the run context as well as the checkout and durable binding.
    if (repoCtx.ref === undefined && round.selection.cold !== undefined) {
      repoCtx = { ...repoCtx, ref: round.selection.cold.ref };
      if (!resume) publishMeta(repoCtx);
    }
    attachedPilotResume = !!(resume && preserveOnReattachRefusal);
    // A resident wait owns only its short wait deadline, not the run's budget.
    // Keep the admission deadline across setup transitions; if a running lease
    // exists, it may narrow that deadline, never renew it. Recheck each boundary
    // because committing fallback or preparing the prompt can consume the rest.
    const assertAdmissionBudget = (at = clock()): number => {
      assertOriginalActionBudget(at);
      const remaining = control?.remainingMs();
      const bound = remaining === undefined ? admissionBound : Math.min(admissionBound, at + remaining);
      if (bound <= at) {
        const text = "The run's time budget ended before its model started.";
        registry.publish(runId, { type: "run_note", kind: "time_budget_exhausted", summary: text, at });
        throw new RefusalError(refusalOf("run_budget_exhausted", text));
      }
      return bound;
    };
    const assignSetupLive = async (state: "falling_back" | "preparing" | "working", detail: string) => {
      const at = clock();
      const bound = assertAdmissionBudget(at);
      return assignLive({ state, bound }, at, detail);
    };
    if (typeof registry.commitLiveState === "function") {
      const summary = registry.getById(runId);
      if (
        summary?.liveState &&
        (summary.liveState.state === "waiting_deploy" || summary.liveState.state === "waiting_repository") &&
        round.selection.backend !== "resident"
      ) {
        const fallback = await assignSetupLive("falling_back", "switching to a fallback workspace");
        if (!fallback.ok) throw new LiveStateCommitError("fallback", fallback);
      }
      const preparing = await assignSetupLive("preparing", "preparing the workspace");
      if (!preparing.ok) throw new LiveStateCommitError("preparation", preparing);
      shell.setSetupLabel(`${liveStateWords("preparing")}…`);
    }
    // A resumed row learns the binding it re-attached on, complete: a row
    // written before the binding was recorded carried only its meta's word.
    if (resume && ledgerRun) {
      const recorded = workspaceBindingOf(resume.row.state.binding);
      if (preserveOnReattachRefusal) {
        // A pilot's dependency source must reach the SAME run's ledger before
        // coordinator notification or model continuation, not just the local
        // write-through queue. A fence belongs to the new owner; an unavailable
        // store pauses only while this generation still owns the run.
        const binding = recorded && resumedPilotBindingFor(round.selection, profile.machine, recorded);
        const committed = binding
          ? await ledgerRun.commitState({ binding }).catch(() => "unavailable" as const)
          : "unavailable";
        if (committed === "fenced" || fencedWhileAttaching) {
          fencedWhileAttaching = true;
          resumeRowRetained = true;
          return ended;
        }
        if (committed !== "ok") {
          await pauseResumedPilot("The coding workspace binding could not be durably verified after re-attachment.");
          return ended;
        }
      } else {
        const rebound = workspaceBindingFor(round.selection, profile.machine, recorded ?? null);
        if (rebound !== undefined) ledgerRun.setState({ binding: rebound });
      }
    }
    // A coordinator's child resumed across a bot roll says so to its parent
    // (run-history item 47a): the typed `child_resumed` event on its record
    // and the Workflow twin, so the parent's wait keeps waiting for the same
    // run instead of reading a roll as a lost round.
    if (resume && coordinator !== undefined)
      await announceChildRoll({
        registry,
        runId: run.id,
        coordinator,
        kind: "resumed",
        reason: "resumed after a restart: the run's workspace was re-attached and the run carries on",
        clock,
        ...(deps.workflow !== undefined ? { workflow: deps.workflow } : {}),
      });
    const { executor, note, resident } = round.selection;
    // A run admitted onto a drained fleet says so on its record (issue 2044):
    // the note is what `runs friction` reads as the wait's category and the
    // plane's table shows as the run's cause — a half-hour wait with a card
    // that counted "attaching the workspace…" and a friction verdict of
    // "none" was the incident's shape. A run the drain sent to the sandbox
    // fallback carries the wait on the selection instead of a binding (issue
    // 2101: the incident's run fell cold and `runs friction` counted zero).
    const drainWaitMs = round.selection.binding?.drainWaitMs ?? round.selection.drainWaitMs ?? 0;
    if (drainWaitMs > 0)
      registry.publish(run.id, {
        type: "run_note",
        kind: "drain_wait",
        summary: `waited ${Math.max(1, Math.round(drainWaitMs / MINUTE_MS))} min at the fleet drain for a deploy to finish`,
        at: clock(),
      });
    if (fencedWhileAttaching) {
      // The reservation's lease lapsed during the attach and another generation
      // took the row (item 42): the run is theirs to restart — nothing more
      // runs or replies here, and the row is left alone.
      console.log(
        `[dispatch] ${msg.threadKey} run ${runId}: another generation took the run during the attach — stopping here, it restarts there`,
      );
      await round.release({ hardStopped: true });
      setupRound = undefined;
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
      ...(coordinator?.publication ? { publication: coordinator.publication } : {}),
      ...(githubDoor ? { githubDoor } : {}),
      stopSignal: run.control.hardSignal,
      root,
    });
    // A fence also aborts the hard signal. The replacement generation owns the
    // card and row, so only a still-owned stop may close them.
    if (fencedWhileAttaching) return ended;
    if (headGate.kind === "stopped") {
      stoppedWhileAttaching = run.control.requested ?? "hard";
      await root.span(
        "dispatch.stop",
        () =>
          card.done(
            shell.close({
              kind: "not_started",
              icon: "⛔",
              reason: "stopped before the run started",
              ...closeLines(clock(), false),
            }),
          ),
        { attrs: { outcome: "stopped_during_head_check" } },
      );
      return ended;
    }
    if (headGate.kind === "refused") return ended;
    repoCtx = headGate.repoCtx;
    // A fresh unseeded Ship child needs a verified fetched head before the
    // model turn. Recheck the factory's prepared path when present: its clean
    // sibling must never be replaced by a retained predecessor at checkout.
    if (
      !resume &&
      coordinator !== undefined &&
      agent.name === "coding" &&
      repoCtx.repo &&
      repoCtx.ref &&
      !round.selection.binding &&
      !round.selection.seeded &&
      round.selection.executor.execResult &&
      round.selection.executor.publishBranchResult &&
      githubDoor
    ) {
      round.selection.cold = await prepareColdPublicationCheckout(
        round.selection,
        {
          repo: repoCtx.repo,
          ref: repoCtx.ref,
          doorUrl: githubDoor.baseUrl,
          ...(round.selection.cold ? { prepared: round.selection.cold } : {}),
          ...((coordinator.publication?.expectedHeadSha ?? recovery?.expectedHeadSha)
            ? { expectedHeadSha: coordinator.publication?.expectedHeadSha ?? recovery?.expectedHeadSha }
            : {}),
        },
        run.control.hardSignal,
      );
    }
    if (
      recovery !== undefined &&
      (agent.name === "review" || agent.name === "coding") &&
      (repoCtx.repo?.toLowerCase() !== recovery.repo.toLowerCase() ||
        repoCtx.pr !== recovery.pr ||
        repoCtx.ref !== recovery.headRef ||
        repoCtx.baseRef !== recovery.baseRef ||
        repoCtx.headSha !== recovery.expectedHeadSha)
    ) {
      const reason = "the recovered pull request moved during setup and no longer matches its durable target";
      await refuse(refusalOf("setup_failed", reason), () =>
        card.done(shell.close({ kind: "refused", icon: "🚫", reason, ...closeLines(clock(), false) })),
      );
      return ended;
    }
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
    const seedNotepad = session?.notepad ?? boundHandoff?.notepad?.text;
    const prompt = await composePrompt(deps, {
      msg,
      directAudienceVerified,
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
      // What the thread's other runs recorded since this agent last ran here
      // (session-log item 9), as data, right after the notes.
      ...(threadArtifacts?.block !== undefined ? { threadArtifacts: threadArtifacts.block.text } : {}),
      // What the session already knows (session-log item 10): the notepad and
      // the newest compaction's summary the seed brought back, and the thread's
      // files (record 0033) with where each is for this run, for the prompt.
      ...(seedNotepad !== undefined || session?.summary !== undefined || threadFiles.length > 0
        ? {
            session: {
              ...(seedNotepad !== undefined ? { notepad: seedNotepad } : {}),
              ...(session?.summary !== undefined ? { summary: session.summary } : {}),
              ...(threadFiles.length > 0 ? { files: threadFiles } : {}),
            },
          }
        : {}),
    });
    const { mcpForRun, system } = prompt;
    seedContext = mergeContextDependencies(
      seedContext,
      memoryContext,
      ...artifactContexts,
      ...(boundHandoff?.dependencies?.value ? [boundHandoff.dependencies.value] : []),
    );
    const contextValidation =
      agent.name === "orchestrator" ? await contextReader.validateDependencies(seedContext) : undefined;
    let admittedContext = structuredClone(seedContext);
    let committedContextCheckpoint: ContextCheckpointReceipt | undefined;
    const normalizeAdmittedOrigins = (context: ContextDependencies) =>
      committedContextCheckpoint ? applyContextCheckpoint(context, committedContextCheckpoint) : context;
    const revalidateAdmitted = () =>
      revalidateAdmittedContext(() => admittedContext, contextReader.validateDependencies);
    seedContext = mergeContextDependencies(seedContext, {
      ...freshContext(),
      origins: [{ runId: run.id, requester: msg.userId, channelId: msg.channelId, threadKey: msg.threadKey }],
    });
    let currentSources: SessionSources = {
      version: 1,
      status: "known",
      binding: sourceBinding(msg),
      receipts: [],
      context: seedContext,
    };
    const sourceReads =
      agent.name === "orchestrator"
        ? createSourceReads({
            owner: sourceReadOwnerOf(run.id),
            operations: mcpForRun.tools.flatMap((tool) => (tool.sourceRead ? [tool.sourceRead] : [])),
            ...(resume ? { previous: resume.row.state.sourceReads } : {}),
            canRecover:
              !session &&
              !threadArtifacts?.block &&
              opts.seed === undefined &&
              !hasHandoff &&
              (!sourceSession ||
                (sourceSession.sources?.status === "known" && sourceSession.sources.receipts.length === 0)) &&
              !msg.images?.length &&
              !msg.documents?.length,
            now: clock,
            audience: async () => {
              const checked = await privateAudienceDecision(msg, io);
              return audienceTrace.refusal === undefined && checked.ok;
            },
            save: async (state) => {
              if (ledgerRun?.tracked() !== true || !(await ledgerRun.setStateAndFlush({ sourceReads: state })))
                return false;
              const exposed = normalizeAdmittedOrigins(await contextForSourceReads(state));
              const context = mergeContextDependencies(contextDependenciesOf(currentSources), exposed);
              const next = { ...currentSources, context };
              if (!(await ledgerRun.writeSources(next))) return false;
              currentSources = next;
              admittedContext = mergeContextDependencies(admittedContext, exposed);
              return true;
            },
          })
        : undefined;
    const mainAudience =
      agent.name === "orchestrator"
        ? mainAudienceAtPrompt({
            requester: msg.userId,
            channelId: msg.channelId,
            verifiedDirectAudience: directAudienceVerified,
            servers: mcpForRun.servers,
            session,
            ...(resume
              ? {
                  resumed: {
                    kind: resume.plan.kind,
                    messages: resume.plan.messages,
                    originalToolNames: resume.row.tools.map((tool) => tool.name),
                    originalAudienceChecked: resume.row.meta.mainAudienceChecked === true,
                    compacted: resume.plan.kind === "resume" && resume.plan.compactions.length > 0,
                    requester: resume.row.meta.userId,
                    channelId: resume.row.meta.channelId,
                  },
                }
              : {}),
            thread,
            history: agent.name === "orchestrator" ? history.filter((item) => item.role === "user") : history,
            threadArtifacts: threadArtifacts?.block?.text,
            parentSeed: opts.seed !== undefined || hasHandoff,
            contextValidation,
          })
        : undefined;
    if (mainAudience && !mainAudience.ok) {
      noteAudienceRefusal(audienceTrace, mainAudience.code, "prompt", "prompt");
      const reason = audienceRefusalText(mainAudience.code);
      await refuse(refusalOf("setup_failed", reason), () =>
        card.done(shell.close({ kind: "refused", icon: "🚫", reason, ...closeLines(clock(), false) })),
      );
      return ended;
    }
    // The PR head this run reviews — the resolved head, or the one adopted at
    // attach; the head settle (item 12) advances it after the model turn.
    const reviewHead = prompt.reviewHead;

    // The workspace the run is on — `debug` material (routing-and-config item 28).
    if (note) shell.note("debug", oneLine(note));
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
    if (resume) {
      console.log(
        resume.plan.kind === "finish"
          ? `[resume] ${msg.threadKey} run ${run.id} finishes under ${deps.runLedger.gen}: the model had answered at step ${resume.plan.step}, ${resume.events.length} event(s) replayed`
          : `[resume] ${msg.threadKey} run ${run.id} continues under ${deps.runLedger.gen}: from step ${resume.plan.step}, ${resume.plan.settlements.length} call(s) to settle, ${resume.events.length} event(s) replayed`,
      );
    }
    // The ledger claim (dispatch/run.ts), once the prompt exists: the reserved
    // row promoted, or a resume's adopted row re-subscribed.
    // A prior generation may have consumed an indirect follow-up before its
    // source-revocation latch was saved. Recovery cannot prove that source
    // history, so neither private reads nor private publication resume.
    const slackContext =
      savedSlackBinding ??
      (await bindSlackContext({
        agentName: agent.name,
        actor: chatActorOf(deps.config, msg),
        msg,
        io,
        visibility: channelVisibility,
        recovered,
        create: deps.slackContextForRun,
      }));
    const privateAudienceLatch = Object.assign(audienceTrace, recoveredPrivateAudienceLatch(msg, recovered));
    if (privateAudienceLatch.code === "recovered-provenance-unproved")
      noteAudienceRefusal(privateAudienceLatch, "recovered-provenance-unproved", "recovery");
    privateAudienceLatch.revalidateSources = async () => {
      if (slackContext) {
        const checked = await slackContext.sourcesStillValid();
        if (!checked.ok) return checked;
      }
      if (sourceReads) {
        const checked = await sourceReads.revalidate();
        if (!checked.ok) return checked;
      }
      return revalidateAdmitted();
    };
    ledgerRun = await claimRun(deps, {
      msg,
      sessionKey: runSessionKey,
      verifyDirectAudience: io.verifyDirectAudience?.bind(io),
      privateWorkVerifierAvailable: io.verifyDirectAudience !== undefined,
      io,
      admitted: admitted!,
      agent,
      profile,
      resolved,
      repoCtx,
      ...(operationTarget !== undefined && (agent.name !== "review" || operationTarget.prTarget !== undefined)
        ? { operationTarget }
        : {}),
      channelVisibility,
      slackContext,
      run,
      registry,
      selection: round.selection,
      requestRow,
      reserved,
      system,
      mcpForRun,
      ...(mainAudience?.ok ? { mainAudienceChecked: true as const } : {}),
      messages,
      seedContext,
      ...(seedNotepad !== undefined ? { seedNotepad } : {}),
      resume,
      ledgerRun,
      restartBranchIdentityBaseline: restartEvidence?.branchIdentityBaseline,
      restartPushedBranch: restartEvidence?.pushedBranch,
      card,
      route,
      clock,
      root,
      parentRunId,
      ...(boundHandoff ? { childHandoff: boundHandoff } : {}),
      coordinator,
      seed,
      ...(opts.restartOf !== undefined ? { restartOf: opts.restartOf } : {}),
      ...(session ? { seedLog: session.log } : {}),
      // A promotion gone untracked marks the card as the reserve-time path
      // above does — the label, not the bot log alone, says the run's row is gone.
      markUntracked: () => shell.note("debug", "untracked by the ledger"),
      ...(seedActors !== undefined ? { seedActors } : {}),
    });
    if (slackContext) {
      const sources: SessionSources = currentSources;
      if (
        !(await slackContext.initialize(sources, async (next) => {
          next = { ...next, context: normalizeAdmittedOrigins(contextDependenciesOf(next)) };
          if (!(await ledgerRun?.writeSources(next))) return false;
          currentSources = {
            ...next,
            context: mergeContextDependencies(contextDependenciesOf(currentSources), contextDependenciesOf(next)),
          };
          admittedContext = mergeContextDependencies(admittedContext, contextDependenciesOf(next));
          return true;
        }))
      ) {
        privateAudienceLatch.revoked = true;
        privateAudienceLatch.code = "slack-source-unverified";
        throw new Error("The Slack source receipts could not be saved.");
      }
    }
    if (boundHandoff) {
      if (!ledgerRun?.tracked() || !handoffAccess || !handoffConsumer)
        throw new Error("The child context was not durably claimed.");
      const childCheckpoint = await ledgerRun.checkpointSession();
      if (!childCheckpoint) throw new Error("The child context checkpoint could not be saved.");
      const consumed = await validateChildHandoff({
        value: boundHandoff,
        consumer: handoffConsumer,
        mode: "consume",
        deps: handoffAccess,
      });
      if (consumed.kind !== "valid")
        throw new Error(consumed.kind === "invalid" ? consumed.reason : "The persisted child context is missing.");
      if (opts.unitContextAdmission && deps.coordinatorInstances) {
        const proof = await acknowledgeUnitSeed(
          { runLedger: deps.runLedger, runStore: deps.runStore, instances: deps.coordinatorInstances },
          {
            run: ledgerRun,
            binding: opts.unitContextAdmission,
            handoff: boundHandoff,
            contract: opts.contract,
            contractBlock,
            messages,
            actors: seedActors,
            system,
            checkpoint: childCheckpoint,
            acknowledgedAt: clock(),
          },
        );
        if (proof.kind === "unavailable") throw new Error("The unit's saved seed could not be acknowledged.");
      }
    }
    handoffConsumer ??= {
      runId,
      requester: msg.userId,
      channelId: msg.channelId,
      threadKey: msg.threadKey,
      attempt: runId,
    };
    handoffAccess ??= await handoffFactory({ consumer: handoffConsumer, msg, io });
    if (ledgerRun?.tracked()) {
      const normalized = await ledgerRun.normalizeContextOrigins();
      if (normalized.ok) {
        committedContextCheckpoint = normalized.receipt;
        // Only the committed store receipt can substitute canonical ordinary
        // origins. A union would restore every earlier turn's origin here.
        currentSources = { ...currentSources, context: structuredClone(normalized.receipt.normalized) };
        admittedContext = applyContextCheckpoint(admittedContext, normalized.receipt);
      }
    }
    if (preserveOnReattachRefusal && !ledgerRun?.tracked())
      throw new Error("The coding run lost its durable owner during setup. Retry after the run ledger recovers.");
    if (agent.name === "coding" && ledgerRun?.tracked()) {
      if (
        !(await ledgerRun.setStateAndFlush({
          preserveOnReattachRefusal,
          ...(preserveOnReattachRefusal && readyRequirement !== undefined
            ? { readyPilotRequirement: readyRequirement }
            : {}),
        }))
      )
        throw new Error("the coding workspace preservation policy could not be saved");
    }
    if (typeof registry.commitLiveState === "function") {
      const working = await assignSetupLive("working", "model turn");
      if (!working.ok) throw new LiveStateCommitError("working", working);
    }
    // The run's reach into its own session log (session-log item 10): the
    // `recall` and `notes` tools over the row's place in the log, once the
    // claim set it; a run without a session (untracked, a ship pipeline, no
    // ledger) has none and the tools say so.
    const sessionTools =
      fromSession?.seed !== undefined && !savedContextValid
        ? undefined
        : sessionCapabilityFor(
            ledgerRun,
            deps.runLedger,
            sourceIntake === "automatic" && deps.artifacts
              ? {
                  read: async () => {
                    const assets = await readThreadAssets(
                      {
                        runs: runsService,
                        store: deps.artifacts!,
                        trustedCoordinatorChild: opts.coordinator !== undefined,
                      },
                      msg.threadKey,
                    );
                    const allowed = new Map<string, boolean>();
                    for (const asset of assets) {
                      if (!allowed.has(asset.runId)) allowed.set(asset.runId, await admitRunContext(asset.runId));
                    }
                    return assets.filter((asset) => allowed.get(asset.runId));
                  },
                  pathOf: (key) => workspaceFiles.pathOf(key),
                }
              : undefined,
            boundHandoff && handoffAccess && handoffConsumer
              ? {
                  handoff: boundHandoff,
                  canRead: async (source) => {
                    const checked = await validateChildHandoff({
                      value: boundHandoff,
                      consumer: handoffConsumer!,
                      mode: "consume",
                      deps: handoffAccess!,
                    });
                    return checked.kind === "valid" && (await handoffAccess!.canRead(source, handoffConsumer!));
                  },
                  loadSource: (source) => handoffAccess!.loadSource(source),
                }
              : undefined,
            () => admitRunContext(runId),
          );
    const captureParentContext = async (): Promise<ParentContext> => {
      if (!sessionTools?.captureHandoff || !ledgerRun?.tracked() || !handoffAccess)
        throw new Error("The parent context cannot be durably captured.");
      const checkpoint = await ledgerRun.checkpointSession();
      if (!checkpoint || checkpoint.key !== sessionTools.session.key)
        throw new Error("The parent context checkpoint is unavailable.");
      return sessionTools.captureHandoff(
        { runId, requester: msg.userId, channelId: msg.channelId, threadKey: msg.threadKey },
        (source) => handoffAccess!.captureDependencies(source),
        checkpoint.through,
      );
    };
    const captureUnitContext = async (): Promise<UnitContext> =>
      capturePrivateWorkContext({
        run: ledgerRun,
        capability: sessionTools,
        captureDependencies: handoffAccess?.captureDependencies,
        source: { runId, requester: msg.userId, channelId: msg.channelId, threadKey: msg.threadKey },
        validate: async (parent) => {
          if (!handoffAccess || !handoffConsumer) return "invalid";
          const captured = await validateChildHandoff({
            value: parent.handoff,
            consumer: handoffConsumer,
            mode: "capture",
            deps: handoffAccess,
            inline: parent,
          });
          return captured.kind === "valid" ? "valid" : "invalid";
        },
      });
    // What this run may do to other runs (dispatch/spawn.ts; docs/reference/specs/
    // agent-conductor.md): spawn a child as this run, read the runs its
    // REQUESTER may, steer a child through the inbox a thread reply takes, and
    // wait on its children within its own clock. Only a toolset that holds the
    // run tools reaches any of them.
    const prBatch = operatorPrBatch ?? resume?.events.find((event) => event.type === "operator")?.binds?.[0]?.prBatch;
    const { spawn, runs, steer, wait } = runToolCapabilities(
      { core: deps, dispatch, registry, clock },
      {
        runId: run.id,
        depth: parent?.depth ?? 0,
        agentName: agent.name,
        ...(prBatch ? { prBatch } : {}),
        msg,
        io,
        control: run.control,
        inbox: admitted.inbox,
      },
    );
    const threadWorkSnapshots: string[] = [];
    const admitSourceContext = async (context: ContextDependencies): Promise<boolean> => {
      context = normalizeAdmittedOrigins(context);
      if (!ledgerRun?.tracked()) return false;
      const next = {
        ...currentSources,
        context: mergeContextDependencies(contextDependenciesOf(currentSources), context),
      };
      if (!(await ledgerRun.writeSources(next))) return false;
      currentSources = next;
      admittedContext = mergeContextDependencies(admittedContext, context);
      return true;
    };
    const admitRunContext = async (sourceRunId: string): Promise<boolean> => {
      const context = await contextReader.readRunDependencies(sourceRunId);
      return context ? admitSourceContext(context) : false;
    };
    const fencedRuns = {
      ...runs,
      admitContext: admitRunContext,
      recordThreadWorkRead: (result: string) => threadWorkSnapshots.push(result),
    };
    // The severity to address for this run (agent-review.md item 5a): the
    // request's `severity:` directive over the user's scope over the channel's
    // over the org's `review.addressSeverity` — the one level the verdict
    // parser holds an approve to, resolved here where the directives and the
    // scopes both are. A ship review child carries its instance's level as
    // its directive, so it resolves to the hand-off's answer.
    const scopes = deps.config.scopes(msg.channelId, msg.userId);
    const addressSeverity = resolveAddressSeverity({
      org: deps.config.config.review?.addressSeverity,
      channel: scopes.channel.review?.addressSeverity,
      user: scopes.user.review?.addressSeverity,
      run: directives.severity,
    });
    card.update(shell.live()); // a failed update still belongs to setup
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
    setupCard = undefined;
    clearInterval(setupHeartbeat);
    const loopStartedAt = clock();
    // Only the loop's own finally may replace the setup finalizer: promotion,
    // its seed and the working-state commit have all succeeded before here.
    runLoopStarted = true;
    setupRound = undefined;
    // The agent loop (dispatch/runLoop.ts): the model turn, the follow-up inbox,
    // the settle and the post-steps, the finish. A throw propagates to the
    // outer catch after the workspace is released.
    const ran = await runLoop(deps, {
      ...(sourceReads ? { sourceReads } : {}),
      msg,
      io,
      addressSeverity,
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
      events,
      round,
      admitted,
      ledgerRun,
      ...(preserveOnReattachRefusal ? { preserveOnReattachRefusal: true } : {}),
      ...(preserveOnReattachRefusal && readyRequirement !== undefined
        ? { readyRequirementOverride: readyRequirement }
        : {}),
      resume,
      repoCtx,
      restartBranchIdentityBaseline: restartEvidence?.branchIdentityBaseline,
      restartPushedBranch: restartEvidence?.pushedBranch,
      restartIdentityUncertain: restartEvidence?.identityUncertain,
      ...(deps.config.scopes(msg.channelId, msg.userId).channel.repo !== undefined
        ? { configuredRepo: deps.config.scopes(msg.channelId, msg.userId).channel.repo }
        : {}),
      ...(githubDoor ? { githubDoor } : {}),
      isPrReview,
      isCodingPrRun,
      reviewHead,
      requestText: directives.text,
      ...(decisionRecord !== undefined ? { decisionRecord } : {}),
      card,
      shell,
      doneLines,
      clock,
      root,
      startedAt,
      loopStartedAt,
      assertAdmissionBudget,
      admissionRemainingMs: () => Math.max(0, admissionBound - clock()),
      ...(coordinator || originalDeadline !== undefined ? { admissionDeadlineAt: admissionBound } : {}),
      channelVisibility,
      slackContext,
      privateAudienceLatch,
      publicationContextCheck: revalidateAdmitted,
      publishText,
      ending,
      spawn,
      runs: fencedRuns,
      steer,
      wait,
      ...(sessionTools ? { session: sessionTools } : {}),
      captureParentContext,
      captureUnitContext,
      admitSourceContext,
      ...(route !== undefined ? { route } : {}),
      parentRunId,
      coordinator,
      seed,
      ...(bearer !== undefined ? { bearer } : {}),
      ...(modelCard ? { modelCard } : {}),
    });
    if (ran.kind === "paused") {
      // A mid-run binding commit can fence while the relaunch is pausing. The
      // successor owns the row and reply; this generation must say nothing.
      if (fencedWhileAttaching) return ended;
      resumeRowRetained = true;
      const checkpointPaused = ran.reason === "checkpoint_unavailable";
      if (ledgerRun?.tracked())
        deps.threadsElsewhere.remember(msg.threadKey, {
          runId: run.id,
          agent: agent.name,
          startedAt: resume?.row.startedAt ?? startedAt,
        });
      await refuse(
        refusalOf(
          "setup_failed",
          checkpointPaused
            ? ran.handedOff
              ? `${ran.message} The saved run is ready for recovery on the next service restart.`
              : `${ran.message} Recovery could not be confirmed; the result remains unpublished.`
            : ran.reason === "first_test_required"
              ? ran.message
              : ran.handedOff
                ? `${ran.message} This run is paused with its recorded workspace binding. After repairing the environment, restart the service to resume this run.`
                : `${ran.message} The original run could not be marked for immediate recovery. No replacement started; an operator needs to check its saved workspace before a retry.`,
        ),
        () =>
          card.done(
            shell.close({
              kind: "refused",
              icon: "⏸️",
              reason: checkpointPaused
                ? "final result awaiting storage recovery"
                : ran.reason === "first_test_required"
                  ? "required first test held, original binding retained"
                  : "coding environment not ready, original binding retained",
              ...closeLines(clock(), false),
            }),
          ),
      );
      return ended;
    }
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
      // The replacement in user words — the one `resumed` line the restarted
      // run's transcript carries (run-history item 54). Both refusals of the
      // replaced-container road (harness-pi item 16) — the relaunch ceiling's
      // `container_replaced` and the lost worktree's `workspace_lost` — read
      // as the replacement; anything else (a harness mismatch) keeps its own
      // reason.
      restartRequest = {
        ...ran.restart,
        profile,
        repoCtx: { repo: repoCtx.repo, ref: repoCtx.ref, baseRef: repoCtx.baseRef },
        pushedBranch: registry
          .snapshotById(run.id)
          ?.events.filter((event) => event.type === "pushed_head")
          .at(-1)?.ref,
        ...(operationTarget !== undefined ? { operationTarget } : {}),
        note:
          ran.refusal === "container_replaced" || ran.refusal === "workspace_lost"
            ? "container replaced, resumed from the request"
            : `${ran.reason}; resumed from the request`,
      };
      console.log(`[dispatch] ${msg.threadKey} run ${run.id} restarts from its request: ${ran.note}`);
      return ended;
    }
    const {
      answer,
      prNote,
      toolCalls,
      runDiagnosis,
      checklistAsLeft,
      hasIncompleteToolEffects,
      answerOutcome,
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
      slackContext,
      privateAudienceLatch,
      verdict: ran.verdict,
      reviewPost: ran.reviewPost,
      reviewStoppedBeforeStart: ran.reviewStoppedBeforeStart,
      verbosity: resolved.verbosity,
      liveUrl,
      prNote,
      stopped,
      ledgerRun,
      ending,
      card,
      shell,
      checklistAsLeft,
      hasIncompleteToolEffects,
      answerOutcome,
      doneLines: privateAudienceRequired(msg) || slackContext !== undefined ? () => ({}) : doneLines,
      runDiagnosis,
      releaseWorkspace,
      root,
      currentWorkCheck: ran.currentWorkCheck,
      publicationCheck: revalidateAdmitted,
      ...(mainAudience?.ok
        ? {
            publicationCheck: async (): Promise<AudienceCheck> => {
              let checking: AudienceRefusalCode = "direct-audience-unavailable";
              try {
                const directSlack = /^slack:D[A-Z0-9_]+$/.test(msg.channelId);
                const directCheck: AudienceCheck =
                  directSlack || mainAudience.audience.sources.length > 0
                    ? await privateAudienceDecision(msg, io)
                    : { ok: true };
                if (!directCheck.ok) return directCheck;
                const directAudienceStillValid = directSlack || mainAudience.audience.sources.length > 0;
                checking = "mcp-check-unavailable";
                const fresh = await deps.mcp.toolsFor("orchestrator", {
                  userId: msg.userId,
                  channelId: msg.channelId,
                  ...(msg.directAudience ? { directAudience: msg.directAudience } : {}),
                });
                checking = "github-check-unavailable";
                const readable =
                  ran.githubReadRepos.length > 0 || ran.githubReadUnknown
                    ? await githubCapabilityFor(deps, chatActorOf(deps.config, msg), {
                        requesterId: msg.userId,
                        verifiedDirectAudience: directAudienceStillValid && directAudienceStampOf(msg) !== undefined,
                      }).readableRepos?.(ran.githubReadRepos)
                    : [];
                if (!readable) return { ok: false, code: checking };
                checking = "plane-check-unavailable";
                if (ran.planeRead && !deps.plane) return { ok: false, code: checking };
                const currentPlaneRows = ran.planeRead
                  ? planeRowIdentities(
                      await (
                        await deps.plane!()
                      ).table(predicateFor(chatActorOf(deps.config, msg), "runs:read", "run")),
                    )
                  : undefined;
                checking = "thread-work-check-unavailable";
                const currentThreadWork =
                  threadWorkSnapshots.length > 0
                    ? await readThreadWorkEvidence({ ...fencedRuns, actor: chatActorOf(deps.config, msg) }, agent.name)
                    : undefined;
                if (currentThreadWork && !currentThreadWork.ok)
                  return { ok: false, code: "thread-work-check-unavailable" };
                const checked = mainAudienceAtReply(
                  mainAudience.audience,
                  fresh.servers,
                  msg.channelId,
                  msg.userId,
                  {
                    repos: ran.githubReadRepos,
                    current: readable.map((repo) => repo.fullName),
                    unknown: ran.githubReadUnknown,
                  },
                  {
                    read: ran.planeRead,
                    exposed: ran.planeReadRows,
                    current: currentPlaneRows?.rows,
                    unknown: ran.planeReadUnknown || currentPlaneRows?.unknown === true,
                  },
                  directAudienceStillValid,
                  {
                    exposed: threadWorkSnapshots,
                    current: currentThreadWork?.ok ? currentThreadWork.snapshot : undefined,
                  },
                );
                return checked.ok ? revalidateAdmitted() : checked;
              } catch {
                return { ok: false, code: checking };
              }
            },
          }
        : {}),
    });
    if (delivery.kind === "fenced" || (await ran.currentWorkCheck?.()) !== undefined) return ended;

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
      producerContext: await contextReader.readRunDependencies(run.id).catch(() => undefined),
      admitMemory: contextReader.authorizeMemory,
      stopped,
      answer,
      toolCalls,
    });
    return ended;
  } catch (err) {
    // Promotion can discover a fence after the attach's ownership check. The
    // new generation owns the same child: no model, reply or finish from here.
    if (fencedWhileAttaching) return ended;
    caught = true;
    if (err instanceof TerminalCommitmentUnknownError) {
      setupTerminalHeld = true;
      resumeRowRetained = true;
      ended.refusal = "setup_failed";
      ended.cause = "system";
      root.setAttrs({ refusal: "setup_failed", cause: "system" });
      const original = registry.getById(err.hold.runId);
      if (original && err.hold.threadKey === msg.threadKey)
        deps.threadsElsewhere.remember(msg.threadKey, {
          runId: err.hold.runId,
          agent: original.agent,
          startedAt: original.startedAt,
        });
      const text = "The original terminal outcome is unconfirmed; its saved work and owner remain held.";
      if (setupCard && setupShell)
        await setupCard
          .done(
            setupShell.close({
              kind: "setup_failed",
              reason: text,
              ...closeLines(clock(), false),
            }),
          )
          .catch(() => {});
      await io.reply(text).catch(() => {});
      return ended;
    }
    // The catch-all is the last line (record 0054): an uncaught throw is a
    // `system`/`uncaught` refusal on the trace, counted like any other —
    // unless the throw carried its own `Refusal` (a `RefusalError` from the
    // directive or resolve parsers, a resident attach), whose code and cause
    // stamp the trace instead. The sentence is the error's message either way.
    const thrown = err instanceof RefusalError ? err.refusal : undefined;
    ended.refusal ??= thrown?.code ?? "uncaught";
    ended.cause ??= thrown?.cause ?? "system";
    // A throw inside a gate's own refusal must not overwrite the root's
    // already-stamped code: the root and the outcome tell the same story.
    if (!refused) root.setAttrs({ refusal: thrown?.code ?? "uncaught", cause: thrown?.cause ?? "system" });
    const errMsg = err instanceof Error ? err.message : String(err);
    if (attachedPilotResume && setupRound && pausePilotAfterAttach) {
      await pausePilotAfterAttach(
        err instanceof LiveStateCommitError
          ? err.message
          : `The coding run failed during setup after reattaching its original workspace (${oneLine(redactAndCap(errMsg, 120))}).`,
        err instanceof LiveStateCommitError
          ? {
              nextAction:
                "Reconcile the saved run state and owner, then resume this original run through the supported restart path.",
            }
          : undefined,
      );
      return ended;
    }
    if (setupFinalizer && !runLoopStarted) {
      setupRefusal ??= thrown ?? refusalOf("setup_failed", errMsg);
      if (fleetBusyEndingFactsOf(err) !== undefined) setupFailure = { kind: "sandbox_fleet_busy" };
      setupFinalizer();
    }
    // A run the full sandbox fleet ended is one queryable line in the bot's
    // own log (docs/reference/specs/execution.md item 14) — this line is what a log sweep
    // counts after a capacity incident, when reading every card is the only
    // other way to find which runs the burst killed. Here, the one site every
    // failing run passes (the run loop rethrows), so it is emitted once; any
    // other ending leaves `fleetBusyRunEndedLine` null and logs nothing.
    const fleetBusyLine = fleetBusyRunEndedLine(registered?.id, msg.threadKey, err);
    if (fleetBusyLine !== null) console.log(fleetBusyLine);
    // A card left spinning after a setup failure looks like a hang; close it.
    // Only a card still in setup — a run failure was already closed by the run
    // loop with its checklist, and must not be relabeled here.
    // Item 62: the error may carry remote text (a resident reason, a GitHub
    // body) — one redacted line on the card, a redacted reply in the thread.
    if (setupCard && setupShell) {
      const [failedCard, failedShell] = [setupCard, setupShell];
      await refuseSilently(thrown?.code ?? "setup_failed", () =>
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
    const replyAttrs =
      replyName === "dispatch.refuse"
        ? {
            attrs: {
              outcome: thrown?.code ?? "uncaught",
              refusal: thrown?.code ?? "uncaught",
              cause: thrown?.cause ?? "system",
            },
          }
        : undefined;
    await ending
      .sealAfterReply(
        async () => {},
        () =>
          root.span(
            replyName,
            async () => {
              // The card scrolls away after this reply, so retain the run link.
              const directReviewCapacity =
                !runLoopStarted && setupReviewTarget !== undefined && fleetBusyEndingFactsOf(err) !== undefined;
              const line = redactSecrets(
                stripAnsi(
                  directReviewCapacity
                    ? `Review never reached ${setupReviewTarget!.repo}#${setupReviewTarget!.pr} because sandbox capacity stayed full. No verdict or GitHub review was posted.`
                    : errorReply(err),
                ),
              );
              const link = admitted?.runLink;
              await io.reply(link ? `${line}\n\n[Live run](${link})` : line);
              // The catch-all's refusal is a record too (record 0054, as
              // amended) — after the reply, on the same span, and once: a
              // setup failure's silent close already recorded this request's.
              if (replyName === "dispatch.refuse") await recordRefusalOnce(thrown ?? refusalOf("uncaught", errMsg));
            },
            replyAttrs,
          ),
      )
      .catch(() => {});
  } finally {
    clearInterval(setupHeartbeat); // a refusal or a setup failure ended the request before the run loop took the card
    // Every admitted run has a terminal same-id path, including a refusal
    // returned before the model loop.
    setupFinalizer?.();
    // The backstop: a finished run no reply attempt reached (a fenced run, a
    // branch that returned early) is sealed with no `replyOk`, and any record
    // still registered is written.
    if (!setupTerminalHeld) ending.drain(undefined);
    if (setupRound && !resumeRowRetained) await setupRound.release({ hardStopped: true });
    // …and a bearer minted for a run that never reached its loop (a head gate
    // after the attach, a throw in the prompt) is revoked here — the ending's
    // hook ran only for a run the loop finished.
    if (registered) deps.runBearers?.revoke(registered.id);
    if (registered) deps.githubBindings?.unregister(registered.id);
    // A resumed dispatch that ended before its run loop started — an unknown
    // provider, a refusal, a gate — has adopted a row it will never finish
    // (item 38). Close it `interrupted` here, or the sweep would relaunch it
    // every lease interval forever.
    if (resume && ledgerRun && !runLoopStarted && !resumeRowClosed && !resumeRowRetained && !fencedWhileAttaching) {
      const adopted = ledgerRun;
      // The row says what the request says: a stop that ended the re-attach's
      // wait closes it with the stop's status, not `interrupted` with a note
      // that reads like a crash.
      const why =
        stoppedWhileAttaching !== undefined
          ? "the resumed run was stopped before it started"
          : "the resumed dispatch ended before the run started";
      const status =
        stoppedWhileAttaching === "hard"
          ? "stopped_hard"
          : stoppedWhileAttaching === "soft"
            ? "stopped_soft"
            : "interrupted";
      await root.span("post.history_write", () => closeResumedRow(adopted, resume, why, status));
      console.log(`[resume] ${msg.threadKey} run ${resume.row.runId} closed ${status}: ${why}`);
    }
    // Thread admission (dispatch/settle.ts; docs/reference/specs/thread-admission.md item 4):
    // free the thread, and settle what the run never consumed — handed on as
    // ONE fresh turn when the run ended by itself, dropped with a note to each
    // sender when an operator stopped it. The fresh turn is an ordinary
    // dispatch: it claims the thread itself, and a follow-up arriving during it
    // steers into it.
    //
    // A reservation that never got a registry row or setup finalizer must be
    // abandoned before the next queued turn claims the thread. A fenced row
    // belongs to another generation and its abandon is a no-op.
    if (reserved && !ledgerRun && !setupFinished && !setupTerminalHeld)
      await root.span("post.ledger_abandon", () => reserved!.abandon());
    // The predecessor's identity a restart keeps (run-history item 54), read
    // BEFORE the discard below takes the row: its events, its token, its
    // start — so the restart runs under the same run id and every posted link,
    // the ledger row and the run page stay valid across the replacement.
    const restartIdentity =
      restartRequest?.restartOf !== undefined
        ? carriedRunIdentity(registry, restartRequest.restartOf, restartRequest.note, {
            branchIdentityBaseline: Object.hasOwn(restartRequest, "branchIdentityBaseline")
              ? restartRequest.branchIdentityBaseline
              : restartRequest.closed?.branchIdentityBaseline,
            pushedBranch: restartRequest.pushedBranch,
            identityUncertain: restartRequest.identityUncertain || restartRequest.closed?.truncated,
            repoCtx: restartRequest.repoCtx,
          })
        : undefined;
    // A finalized setup run keeps its frame and record under the original id.
    if (registered && !runLoopStarted && !setupFinished && !setupTerminalHeld) registry.discard(registered.id);
    // The second net under that discard (run-history item 42): a branch that
    // opens its own registry row — `runShipBranch` does — and throws or returns
    // before finishing it would leave the row `running` with no runner behind
    // it: a stop is a request to the runner, so it can never take, and the
    // shutdown drain waits on the row to its deadline. Finish, `failed`, any
    // run bound to this dispatch — the trace's bound run, the thread slot's —
    // still unfinished once the branch has returned. The one deliberate
    // survivor is the hosted parent of a completed hand-off (record 0060): the
    // branch names it (`ShipBranchEnd.hostedLive`) and the plan runner's
    // `finish` ends it, so the net leaves it live.
    if (!shipHostedLive && !fencedWhileAttaching && !setupTerminalHeld) {
      for (const boundId of new Set([trace.runId, admitted?.runId])) {
        if (boundId === undefined || registry.snapshotById?.(boundId)?.finished !== false) continue;
        console.warn(
          `[dispatch] ${msg.threadKey} run ${boundId} left running by the ${shipForked ? "ship branch" : "dispatch"} — finished failed by the outer finally (run-history item 42)`,
        );
        registry.finish(boundId, "failed");
        io.runFinished?.({ id: boundId, status: "failed" });
      }
    }
    // The successor owns durable inbox entries. A local follow-up without a
    // durable sequence cannot follow it, so tell that sender it was not saved.
    const fencedPending = fencedWhileAttaching && admitted ? admission.release(msg.threadKey, admitted) : [];
    for (const pending of fencedPending) {
      if (pending.ledgerSeq === undefined)
        await pending.io?.reply("This reply was not saved with the run and will not be processed.").catch(() => {});
    }
    const settled = settleThread(deps, {
      msg,
      admitted: fencedWhileAttaching ? undefined : admitted,
      // A stop that ended the attach counts as the loop's stop would: the
      // request ends `stopped`, and a follow-up queued during the wait is told.
      stopCounts: !fencedWhileAttaching && (runLoopStarted || stoppedWhileAttaching !== undefined),
      control: registered?.control,
    });
    if (settled.kind === "dropped") await tellDropped(root, settled.pending);
    const stopMode = (settled.kind === "handed-on" ? undefined : settled.stopMode) ?? stoppedWhileAttaching;
    // The request is over: its root ends here, after the seal and the tail,
    // with how it went — before the fresh turn below starts a root of its own.
    // The same status is the caller's outcome.
    ended.status = caught ? "failed" : refused ? "refused" : stopMode ? "stopped" : "completed";
    root.end(caught ? "error" : "ok", { status: ended.status });
    if (resumeRowRetained && settled.kind === "handed-on") {
      for (const pending of settled.pending) {
        if (pending.ledgerSeq === undefined)
          await pending.io
            .reply(
              "This reply could not be saved with the paused run. A new reply after the run resumes will be processed.",
            )
            .catch(() => undefined);
      }
    } else if (restartRequest) {
      // The run's request, dispatched again now that the thread is free — a
      // resumed run whose workspace could not be re-attached (item 54), or a
      // live run whose pi container was replaced under it (harness-pi item 16)
      // — with the follow-ups the run never consumed appended, as a fresh turn
      // would carry them, and the closed run named so admission never steers
      // the request into its row: the finish above is still in flight, and the
      // boot-gap map may still list the run. The identity captured above rides
      // along, so the restart continues the SAME run — one id, one page.
      const pending = settled.kind === "handed-on" ? settled.pending : [];
      const restart = prepareRestartTurn(deps, {
        request: restartRequest.request,
        pending,
        clock,
        ...(restartRequest.restartOf !== undefined ? { restartOf: restartRequest.restartOf } : {}),
        ...(restartIdentity !== undefined
          ? {
              carried: {
                ...restartIdentity,
                ...((restartRequest.profile ?? restartRequest.closed?.profile)
                  ? { profile: restartRequest.profile ?? restartRequest.closed!.profile }
                  : {}),
              },
            }
          : {}),
        ...(restartRequest.coordinator !== undefined ? { coordinator: restartRequest.coordinator } : {}),
        ...(restartRequest.operationTarget !== undefined ? { operationTarget: restartRequest.operationTarget } : {}),
      });
      const restarted = await dispatch(deps, restart.msg, io, {
        ...restart.opts,
        ...(boundHandoff ? { childHandoff: boundHandoff } : {}),
      }).catch((err: unknown) => {
        console.error(
          `[dispatch] ${msg.threadKey} restart from the request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return err instanceof Error ? err.message : String(err);
      });
      // The restart died between the `restarting` close and the successor's
      // claim (issue 2081): the carried id never re-registered, so no successor
      // row will ever appear and the record would answer still-running until
      // the unit's wall clock ran out. End the record for real — `restarting`
      // dropped, the death on it — so `read-record` answers `interrupted` with
      // the roll's recorded cause and the unit ends on the interrupted note.
      // Only judged where the identity was carried: with it the successor is
      // the same id, so a missing snapshot after the dispatch settled proves no
      // claim happened; a death after the claim is the outer net's (the
      // registered run finished `failed`, its record replacing the close's).
      if (
        restartRequest.closed?.restarting === true &&
        restartRequest.restartOf !== undefined &&
        restartIdentity !== undefined &&
        !registry.snapshotById(restartRequest.restartOf)
      )
        await recordRestartDeath({
          writer: deps.runHistoryWriter,
          closed: restartRequest.closed,
          why: typeof restarted === "string" ? restarted : `the restart's dispatch ended ${restarted.status}`,
          clock,
          ...(restartRequest.coordinator !== undefined ? { coordinator: restartRequest.coordinator } : {}),
          ...(deps.workflow !== undefined ? { workflow: deps.workflow } : {}),
        });
    } else if (
      settled.kind === "handed-on" &&
      recovery !== undefined &&
      coordinator !== undefined &&
      deps.coordinatorInstances !== undefined
    ) {
      const unit = unitOfIdempotencyKey(coordinator.idempotencyKey);
      if (unit === undefined) {
        console.error(
          `[dispatch] ${msg.threadKey} could not retain ${settled.pending.length} recovery follow-up(s): the coordinator key names no unit`,
        );
      } else {
        const key = { instanceId: coordinator.parentInstanceId, unit };
        let retained = 0;
        for (const pending of settled.pending) {
          const attachments = [...(pending.msg.images ?? []), ...(pending.msg.documents ?? [])].map((asset) => ({
            mediaType: asset.mediaType,
            data: asset.data,
            ...(asset.name !== undefined ? { name: asset.name } : {}),
          }));
          try {
            const appended = await deps.coordinatorInstances.appendEvent(key, {
              ...(pending.msg.messageId !== undefined ? { id: pending.msg.messageId } : {}),
              sender: pending.msg.userId,
              ...(pending.msg.userName !== undefined ? { senderName: pending.msg.userName } : {}),
              text: pending.msg.text,
              ...(attachments.length > 0 ? { attachments } : {}),
              mode: "steer",
              at: pending.at,
            });
            if (appended.ok) retained++;
            else {
              console.error(`[dispatch] ${msg.threadKey} could not retain a recovery follow-up: ${appended.reason}`);
              await pending.io
                .reply(
                  "Your reply could not be saved on the recovered unit. No replacement work was started; please retry the reply.",
                )
                .catch(() => undefined);
            }
          } catch (err) {
            console.error(
              `[dispatch] ${msg.threadKey} could not retain a recovery follow-up: ${err instanceof Error ? err.message : String(err)}`,
            );
            await pending.io
              .reply(
                "Your reply could not be saved on the recovered unit. No replacement work was started; please retry the reply.",
              )
              .catch(() => undefined);
          }
        }
        console.log(
          `[dispatch] ${msg.threadKey} retained ${retained}/${settled.pending.length} recovery follow-up(s) on ${key.instanceId}:${key.unit}; no fresh turn ran`,
        );
      }
    } else if (settled.kind === "handed-on") {
      const fresh = prepareFreshTurn(deps, { agent: settled.agent, pending: settled.pending, clock });
      await dispatch(deps, fresh.msg, fresh.io, fresh.opts).catch((err: unknown) =>
        console.error(
          `[dispatch] ${msg.threadKey} fresh turn for unconsumed follow-ups failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    // The ledger heartbeat stops with the run (the finish write, in flight
    // through the writer, closes the row itself).
    void ledgerRun?.close();
    if (!opts.redispatch) activeRuns--;
  }
  // Reached from the catch alone (every path in the try returns): the failed
  // request's outcome, its status stamped by the finally above.
  return ended;
}

/** A click on a confirmation's affordance, as an adapter hands it over
 *  (record 0044; routing-and-config item 25): which button, the offer's id its
 *  value carried, the actor the adapter proved (identity, never authority —
 *  the store checks the requester against its id and `self`), and the channel
 *  handle bound to the offer's conversation, where the answer goes. */
export interface ClickRequest {
  kind: "confirm" | "cancel";
  id: string;
  actor: Actor;
  io: ChannelIO;
}

/**
 * The second entry into the core, beside `dispatch()`: a click on a
 * confirmation (record 0044). Channels are transports, so an adapter's action
 * intake resolves the actor, constructs the channel handle and calls this;
 * it builds no ending and no trace. This entry counts itself in the shutdown
 * drain as `dispatch()` does, builds the run ending and the request trace the
 * same way — neither needs a message — and runs the pure pieces in
 * dispatch/confirm.ts: a confirm consumes the row for the clicker's ids and
 * runs the stored input through the typed line's own path, replying the
 * receipt first and the command's own text under it (a deferred outcome's
 * settle follow-up posted as a typed one is); a cancel deletes it. Every
 * refusal — used, expired, foreign, a store that could not be read — is a
 * named line and a `refused` outcome, nothing run. A throw is answered the way
 * `dispatch()` answers one: the redacted error line, the request `failed`.
 */
export async function dispatchClick(deps: CoreDeps, click: ClickRequest): Promise<DispatchOutcome> {
  const ended: DispatchOutcome = { status: "completed" };
  const clock = deps.clock ?? systemClock;
  const trace = startRequestRoot(deps, {
    channel: click.actor.origin ? channelOf(click.actor.origin.channelId) : undefined,
    receivedAt: clock(),
  });
  const root = trace.root;
  const io = click.io;
  const actorIds = actorIdsOf(click.actor);
  let caught = false;
  let refused = false;
  // A Yes that redispatched: the click's outcome is the redispatched
  // request's own, stamped in the finally over the click's default.
  let redispatched: DispatchOutcome | undefined;
  // Counted in flight from the first line to the reply, like a dispatch: a
  // SIGTERM between the click and the command's run must not abandon it.
  activeRuns++;
  const ending = createRunEnding({
    registry: deps.runRegistry ?? defaultRunRegistry,
    onFinished: (id) => void deps.runBearers?.revoke(id),
  });
  const refuse = (refusal: Refusal) => {
    refused = true;
    ended.refusal = refusal.code;
    ended.cause = refusal.cause;
    root.setAttrs({ refusal: refusal.code, cause: refusal.cause });
    // The one renderer (record 0054): the click's named line goes out as a
    // `Refusal`, byte-identical to the line the store named.
    return root.span("dispatch.refuse", () => renderRefusal(refusal, io), {
      attrs: { outcome: refusal.code, refusal: refusal.code, cause: refusal.cause },
    });
  };
  try {
    if (click.kind === "cancel") {
      const res = await cancelPending(deps, { id: click.id, actorIds });
      if (res.kind === "refused")
        await ending.sealAfterReply(
          async () => {},
          () => refuse(refusalOf(res.refusal, res.text)),
        );
      else
        await ending.sealAfterReply(
          async () => {},
          () => root.span("post.reply", () => io.reply(res.text)),
        );
      return ended;
    }
    // A question's Yes (record 0054): the consumed `redispatch` row goes back
    // through `dispatch()` whole — the proposal as the requester's own message,
    // the click's drain slot handed over, the question's code on the record.
    const res = await consumeAndRun(
      deps,
      { id: click.id, actorIds },
      io,
      ending,
      trace,
      (row) =>
        dispatch(deps, row.message, io, {
          redispatch: { code: row.code, ...(row.binding ? { binding: row.binding } : {}) },
        }),
      (context, message) =>
        revalidateAdmittedContext(
          () => context,
          contextAccessForMessage(deps, { msg: message, io }).validateDependencies,
        ),
    );
    if (res.kind === "redispatched") {
      redispatched = res.outcome;
      if (res.outcome.refusal !== undefined) ended.refusal = res.outcome.refusal;
      if (res.outcome.cause !== undefined) ended.cause = res.outcome.cause;
      return ended;
    }
    if (res.kind === "refused") {
      const refusal = refusalOf(res.refusal, res.text);
      // A refusal after a command was bound is a run record (record 0054;
      // run-history item 2): when the store's refusal still named the row
      // (`expired`, `foreign`), the decision is written like a hand-back's —
      // nothing invoked, no surface told — with `outcome: "refused"` and the
      // code, so the door report counts it. `used` and an unreadable store
      // name no row and are counted from the trace alone.
      const clickRow = res.row;
      if (clickRow && clickRow.kind === "run") {
        const row = clickRow;
        await recordRoutedDecision(
          deps,
          row.message,
          io,
          { id: row.command },
          {
            preset: COMMAND_RUN_AGENT,
            reason: REFUSED_REASON,
            model: row.model,
            command: row.command,
            input: redactedInput(row.input),
            receipt: row.receipt,
            outcome: "refused",
            refusalCode: refusal.code,
          },
          res.text,
          ending,
          trace,
        );
      } else if (clickRow && clickRow.kind === "redispatch") {
        // A question's refused click is a record too (record 0054, as amended:
        // every refusal is a run record): the stored proposal is the request
        // the door refused, so the `door` record carries it. A `used` click and
        // an unreadable store name no row — there is no message to record.
        await recordRefusal(deps, clickRow.message, io, refusal, ending, trace);
      }
      await ending.sealAfterReply(
        async () => {},
        () => refuse(refusal),
      );
      return ended;
    }
    // The command run (if the command made one) seals after its reply, as a
    // typed line's does; the receipt leads, the command's text follows.
    await ending.sealAfterReply(
      async () => {},
      () =>
        root.span("post.reply", async () => {
          const current = await res.publicationCheck?.();
          return io.reply(current && !current.ok ? OFFER_CONTEXT_LINE : res.text);
        }),
    );
    if (res.result.ok && res.result.followUp) postSettledOutcome(res.result.followUp, io, root);
    return ended;
  } catch (err) {
    caught = true;
    await ending
      .sealAfterReply(
        async () => {},
        () => root.span("post.reply", () => io.reply(redactSecrets(stripAnsi(errorReply(err))))),
      )
      .catch(() => {});
    return ended;
  } finally {
    // The backstop, as in dispatch(): a finished run no reply reached is sealed and written.
    ending.drain(undefined);
    ended.status = caught ? "failed" : refused ? "refused" : (redispatched?.status ?? "completed");
    root.end(caught ? "error" : "ok", { status: ended.status });
    activeRuns--;
  }
}
