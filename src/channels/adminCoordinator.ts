// The bot steps a ship coordinator calls (docs/reference/specs/http-ingress.md
// item 9; docs/decisions/0029-durable-objects-store-workflows-schedule.md,
// docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md): the
// coordinator is a Workflow instance in the bot's shim Worker that holds no
// credential of its own, so every GitHub fact, every Slack post and every child
// run is the bot's to produce. The steps, in the order a plan runs them: `plan`
// (the units and the caps the instance was created with), `unit-start` (the
// unit's thread, opened through the requesting thread's channel; its board
// issue), `branch`, `spawn`, `read-record` (a finished child's typed artifacts:
// the pull request it opened, the verdict and whether it stands on the pull
// request at the reviewed head — from the child's own record of its post, and
// from GitHub only when that record is silent — the dispositions), `pr-check` (what heads the
// unit's branch: an open pull request, or — with none open — one already
// merged, which makes the unit done), `round` (a boundary the card draws),
// `unit-end` (the report in the unit's thread),
// `finish` (the parent's run record), plus `authorize`, the question the shim
// asks before it creates an instance. The shim forwards `/admin/*` to the
// container untouched and the Access gate does not cover it, so the bearer is
// the whole door, like the restart, the crash and the span log: the
// `coordinator` entry of `SWITCHBOARD_INGRESS_TOKENS`, whose `http:coordinator`
// actor the policy table admits on `coordinator:step` and nothing else does.
//
// The spawn never takes an actor from its caller. The body names an instance
// and a step; the requester, channel and thread come from the parent ship
// record the bot wrote at the instance's creation (a plan unit's thread from
// its own row), and the child is an ordinary `dispatch()` as that user, so the
// agent gate, the profile gate and the repository gates judge it with that
// person's grants — a requester who lost `agent:run:coding` during a days-long
// wait ends the step with the gate's own name. A spawn carries either a
// `prompt` (the conductor's free text) or a typed `brief` (ids only: the unit,
// the pull request, the review run) the bot composes into the child's turn
// itself, so no prompt text ever crosses from the Workflow. Every step is safe
// to retry: the spawn carries the key `<parentInstanceId>:<step>`, the child's
// claim stores it, and a retry that meets the child live or finished answers
// `alreadySpawned` with its id; a thread held by a run without the key answers
// `busy`. Every answer carries `at`, the bot's clock — the only time the
// machine reads.
//
// Per-unit state is one row in the state Worker's `coordinator_units` table
// (`CoordinatorUnit`): a unit's thread, branch, pull request, rounds and
// ending, readable by a person as one row; the instance row keeps identity.
//
// The handler here is pure over a parsed request (`handleCoordinatorRequest`),
// like the ingress; `createAdminCoordinatorHandler` is the node:http adapter.

import type { RunnerPullOwner } from "../core/runnerOwnership.js";
import {
  DEFAULT_GRANT,
  carve,
  GRANT_RENEWALS_MAX,
  HOSTED_DEADLINE_MARGIN_MINUTES,
  IDLE_DAYS_DEFAULT,
  IDLE_WAKES_MAX,
  leaseMinimum,
  minutesToMs,
  SECOND_MS,
  type Grant,
  type GrantSource,
} from "../core/budgets.js";
import { DEFAULT_VERBOSITY, shows } from "../core/verbosity.js";
import { mentionsGitPush, pairedPublicationPush } from "../core/publicationPush.js";
import { publicationSettlementForRun } from "../core/publicationSettlement.js";
import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { requestedByLine } from "../core/prDescription.js";
import { threadPageLink } from "../core/dispatch/reply.js";
import { AGENTS } from "../agents/registry.js";
import { authorize } from "../core/authz/authorize.js";
import { resolveActor, type GrantsLookup } from "../core/authz/actor.js";
import type { ChannelVisibility } from "../core/authz/types.js";
import { composeChild, type BriefReaders } from "../core/coordinator/briefs.js";
import {
  COORDINATOR_STEP_ACTION,
  COORDINATOR_STEP_PATH_PREFIX,
  PLAN_MERGE_ACTION,
  idempotencyKeyFor,
  IDLE_WHY_MAX,
  isHumanGatePending,
  isSavedFindingsPatch,
  INSTANCE_ID_PATTERN,
  STEP_NAME_PATTERN,
  unitOfIdempotencyKey,
  type CoordinatorInstance,
  type CoordinatorTag,
  type CoordinatorUnit,
  type ExistingPrPublicationBinding,
  type RecoveryAccounting,
  type RecoveryReviewEvidence,
  type SavedFindingsPatch,
  type ThreadEvent,
  type UnitIdle,
  type UnitWakeAnswer,
  CoordinatorUnitWriteConflict,
} from "../core/coordinator/contract.js";
import { isShipOutcome, sameShipOutcome } from "../core/coordinator/shipOutcome.js";
import { foldThreadAttachments } from "../core/dispatch/admission.js";
import { attributedText, foldThreadEvents } from "../core/threadEvents.js";
import { assembleRunRecord } from "../core/dispatch/record.js";
import type { CoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import {
  freezeCoordinatorReport,
  freezeAdmittedCoordinatorReport,
  coordinatorReportAdmission,
  sameCoordinatorReportAdmission,
  sameCoordinatorReportOwner,
  readCoordinatorReport,
  type CoordinatorReportOwner,
  type CoordinatorReportLedger,
} from "../core/coordinator/reportContext.js";
import { appendCoordinatorStatus } from "../core/coordinator/unitStatus.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { PrivateWorkerLog } from "../core/privateWorkerLog.js";
import { PRIVATE_WORKER_INTERNAL_READ } from "../core/runsService.js";
import {
  appendPrivateWorkerInput,
  appendPrivateWorkerReply,
  privateWorkerAudienceFor,
  privateWorkerIO,
  privateWorkerThreadKey,
} from "./privateWorker.js";
import type { CreateInstanceAnswer, InstanceStatusAnswer } from "../core/coordinator/instancesRoute.js";
import type { OriginalUnitRecoveryParams } from "../core/coordinator/driver.js";
import type { DispatchOptions } from "../core/dispatcher.js";
import type { DispatchOutcome } from "../core/dispatch/outcome.js";
import { childRequestText, spawnTierRefusal } from "../core/dispatch/spawn.js";
import { EFFORT_LEVELS_HINT, isEffort, type Effort } from "../effort.js";
import {
  CHANGES_TOKEN,
  escapeMarkdownTableCell,
  findingsAtOrAbove,
  isAddressSeverity,
  isFindingShape,
  LGTM_TOKEN,
  type Finding,
  type ReviewVerdictKind,
  unescapeMarkdownTableCell,
} from "../core/reviewVerdict.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import { COMMAND_CAP, type RunEvent, type ShipRoundOutcome } from "../core/runEvents.js";
import type { RunHistoryWriter } from "../core/runHistoryWriter.js";
import { RUN_ID_PATTERN, RUN_LIST_MAX_LIMIT } from "../core/runRecord.js";
import type { RunRegistry } from "../core/runRegistry.js";
import type { LedgerRun } from "../core/runLedger/writeThrough.js";
import { directAudienceStampOf } from "../core/runLedger/inboxMessage.js";
import type { HostingState } from "../core/runLedger/types.js";
import type { RunsService, RunView } from "../core/runsService.js";
import type { SweepReport } from "../core/pullSweep.js";
import {
  interruptionCauseOfWords,
  parsePlanBranch,
  planInstanceId,
  type Brief,
  type InterruptionCause,
  type RoundChecks,
  stepPrefixOf,
  strictPatternWidening,
  MAX_PATTERN_CONTINUATIONS,
} from "../core/ship/coordinator.js";
import { renderRenewal, renewalDecision } from "../core/ship/renewal.js";
import { BOT_SCOPES, checkPrTitle, TITLE_MAX_LENGTH } from "../core/prTitle.mjs";
import PR_TITLE_VOCABULARY from "../core/prTitleVocabulary.json" with { type: "json" };
import { isHandoffShape, renderHandoffComment, type Handoff } from "../core/ship/handoff.js";
import { normalizeHead, sameCommit } from "../core/reviewedHead.js";
import { endingWordOf, hostedStageDetail, pipelineStandingOf, roundOutcomeWordOf } from "../core/pipelineStanding.js";
import {
  DEFAULT_ADDRESS_SEVERITY,
  resolveShipCaps,
  shipRoundHeader,
  type AddressSeverity,
  type AddressSeveritySource,
} from "../core/shipPipeline.js";
import { createCardShell } from "../core/statusCardFrame.js";
import { systemClock } from "../core/trace/clock.js";
import {
  isRecoveryRequest,
  recoveryActionId,
  type RecoveryRequest,
  type RecoveryAction,
} from "../core/coordinator/recoveryHistory.js";
import { generatedTaskText } from "../core/coordinator/generatedTask.js";
import { publishedHeadEvidence } from "../core/coordinator/publishedHeadAdoption.js";
import type { ChannelIO, IncomingMessage } from "../core/types.js";
import { authenticateIngressBearer } from "../deploy/restart.js";
import type { GithubApi } from "../execution/githubApi.js";
import { isReleasePullRequest } from "../core/commands/merge.js";
import type { GithubIdentity } from "../execution/githubApp.js";
import {
  MERGE_QUEUE_405,
  type CommitChecks,
  type EnqueueResult,
  type MergedPrRef,
  type MergeQueueState,
  type MergeResult,
  type OpenedPullRequest,
  type OpenPrRef,
  type AnyHeadPullRequest,
  type PullRequestComment,
  type PullRequestFacts,
  type PullRequestReview,
  type PullRequestTarget,
} from "../execution/githubPulls.js";
import { EMPTY_START_STATE, type BranchStartState, type RewriteResult } from "../execution/identityRewrite.js";
import type { Secret } from "../secrets.js";
import { readBody, type IngressResponse } from "./http.js";

export const COORDINATOR_ADMIN_PREFIX = COORDINATOR_STEP_PATH_PREFIX;
export function isCoordinatorAdminPath(path: string): boolean {
  return path.startsWith(COORDINATOR_ADMIN_PREFIX) && path.length > COORDINATOR_ADMIN_PREFIX.length;
}

/** The child's prompt is the contract a coordinator renders: bounded, never unbounded input. */
export const MAX_SPAWN_PROMPT_CHARS = 200_000;
/** How many pages of the instance's channel a spawn reads back for a finished
 *  run carrying its key: the default retention's `maxRuns` in full pages, so a
 *  retry that lands after its child ended finds it however busy the channel. */
export const FINISHED_LOOKBACK_PAGES = 25;
const MAX_ADMIN_BODY_BYTES = 1_000_000;

/** The synchronous fence between a coordinator spawn's last drain check and
 * its child's registration. A permit keeps the drain alive until either the
 * registry can hold the child or dispatch ends without one. */
export interface CoordinatorChildAdmission {
  draining(): boolean;
  enter(): (() => void) | undefined;
  pending(): number;
}

export function createCoordinatorChildAdmission(draining: () => boolean): CoordinatorChildAdmission {
  let pending = 0;
  return {
    draining,
    enter: () => {
      if (draining()) return undefined;
      pending++;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        pending--;
      };
    },
    pending: () => pending,
  };
}

export interface AdminCoordinatorDeps {
  /** The `SWITCHBOARD_INGRESS_TOKENS` secret as the process sees it. */
  tokens: Secret | undefined;
  /** Public Git door URL used to authenticate retained push output in recovery. */
  gitDoorBaseUrl?: string;
  /** The process drain's child-admission fence. Once draining, a runner's
   * durable spawn step is held for the next generation; a permit acquired at
   * dispatch keeps this generation alive until the child registers. */
  childAdmission?: CoordinatorChildAdmission;
  /** Grants by actor id (`ConfigStore.grantsFor`): the bearer's `http:<subject>` must hold `coordinator:step`. */
  grantsFor: GrantsLookup;
  /** The parent ship records (run-history item 49). */
  instances: CoordinatorInstanceStore;
  /** Private saved-work evidence must exist before a terminal findings retry can be claimed. */
  artifacts?: Pick<ArtifactStore, "head">;
  /** Admit the separate durable checkpoint after the original row is claimed. */
  startRecovery?: (id: string, params: OriginalUnitRecoveryParams) => Promise<CreateInstanceAnswer>;
  recoveryStatus?: (id: string) => Promise<InstanceStatusAnswer>;
  /** The app config handed to the spawn tier gate. */
  appConfig?: () => unknown;
  /** The runs page base (`<PUBLIC_BASE_URL>/runs`), answered to the plan
   *  runner so a unit-end report can link a child's write-up to its run page
   *  (agent-ship item 12); absent without PUBLIC_BASE_URL — the report names
   *  the run id instead. */
  runPageBase?: string;
  /** Rung one for a pull request this live runner owns. The sweep's git and
   *  approval-carry rules are reused, but a conflict returns to this runner
   *  instead of starting a detached fix round. */
  runnerRebase?: (instance: CoordinatorInstance, prNumber: number) => Promise<SweepReport>;
  /** Process-local ownership fence shared with the sweep. The durable runner
   *  remains authoritative; this fence only makes a simultaneous command defer. */
  runnerOwnership?: {
    claim(repo: string, prNumber: number, owner?: RunnerPullOwner): boolean;
    reserve?(repo: string, prNumber: number, owner: RunnerPullOwner): symbol | undefined;
    transferReservation?(
      repo: string,
      prNumber: number,
      token: symbol,
      currentOwner: RunnerPullOwner,
      nextOwner: RunnerPullOwner,
    ): boolean;
    releaseReservation?(repo: string, prNumber: number, token: symbol): boolean;
    release(repo: string, prNumber: number, owner?: RunnerPullOwner): boolean;
    owner(repo: string, prNumber: number): RunnerPullOwner | undefined;
  };
  /** The ship grant as the requester's channel and user scopes say now. Idle
   * waits can outlive a config change, so a wake never relies on the grant
   * captured when the instance was created. */
  shipGrantFor?: (instance: CoordinatorInstance) => { grant: Grant; source: GrantSource };
  /** The one runs service every surface reads: the live and finished runs of the instance's thread. */
  runs: RunsService;
  /** The registry the hosted parent run lives in (record 0060): the four
   *  runner routes write the pipeline's facts to it through `hostPublish`,
   *  and `finish` ends and seals the row. */
  registry: Pick<RunRegistry, "publish" | "finish" | "getById" | "snapshotById" | "seal" | "commitLiveState">;
  /** The ledger runs this generation drives (`LedgerWriteThrough.liveRuns`):
   *  the hosted parent's handle, whose state carries the deadline every runner
   *  write renews (`hosting.until`) and whose sink `finish` seals the record
   *  through the ledger — releasing the host key with the row. */
  ledgerRuns: () => LedgerRun[];
  /** Immutable coordinator deliveries share the same durable thread log as agent answers. */
  reportLedger?: CoordinatorReportLedger;
  /** `dispatch()` bound over the process's deps: the child as the requesting
   *  user, tagged, with the unit's contract for a round-0 child. */
  dispatch: (
    msg: IncomingMessage,
    io: ChannelIO,
    opts?: Pick<
      DispatchOptions,
      "coordinator" | "contract" | "operationTarget" | "childHandoff" | "unitContextAdmission"
    > & { coordinator: CoordinatorTag },
  ) => Promise<DispatchOutcome>;
  /** A terminal or moved pull request revokes a live child's authority. The
   * coordinator folds a fixed instruction into that run as the requester; it
   * never stops the process, so the child can leave a truthful final record. */
  steerChild?: (runId: string, text: string, instance: CoordinatorInstance) => Promise<boolean>;
  /** The channel handle for a thread (the resume's `resumeSlackIO` from the
   *  row's parts — the card's ts when the handle must redraw it); undefined for
   *  a platform no thread can be rebuilt on. */
  ioFor: (thread: { threadKey: string; userId: string; cardTs?: string }) => ChannelIO | undefined;
  /** Durable internal conversation for main-agent workers. Missing means no worker admission. */
  privateWorkerLog?: PrivateWorkerLog;
  /** The open pull request heading a branch (githubPulls.findOpenPrByHead), and
   *  — asked only when there is none — the merged one (githubPulls.findMergedPrByHead):
   *  a unit whose pull request merged before the runner reached it is done, not aborted. */
  findOpenPrByHead: (repo: string, branch: string) => Promise<OpenPrRef | null>;
  findMergedPrByHead: (repo: string, branch: string) => Promise<MergedPrRef | null>;
  /** All states, bounded and complete; required for create-only original-head adoption. */
  listAnyPrByHead?: (repo: string, branch: string) => Promise<AnyHeadPullRequest[]>;
  createDraftPullRequest?: (target: PullRequestTarget) => Promise<OpenedPullRequest>;
  /** Identity check at a pinned head; it must have no write seam. */
  verifyIdentitiesReadOnly?: (args: {
    repo: string;
    base: string;
    branch: string;
    expectedTip: string;
    startState: BranchStartState;
    requester: string;
  }) => Promise<RewriteResult>;
  /** The recover path's one write (githubPulls.openPullRequest, open-or-edit by
   *  head branch): a coding child that pushed and then died leaves its work on
   *  the branch — the pr-check opens the pull request from the branch itself
   *  instead of answering `none` over stranded work (agent-ship item 15). */
  openPullRequest: (target: PullRequestTarget) => Promise<OpenedPullRequest>;
  /** The branch head commit's subject (githubPulls.branchHeadSubject): the
   *  recover open's preferred title when the record holds no submitted
   *  description and the subject passes the title rule (record 0064's
   *  `unit_title` move — the runner's own open takes the rule at open, so the
   *  required check passes first time). Absent, or unreadable, or failing the
   *  rule: the conventional fallback stands. */
  branchHeadSubject?: (repo: string, branch: string) => Promise<string | undefined>;
  /** Exact original branch head required for a pre-PR recovery claim and every coding admission. */
  fetchBranchHeadSha?: (repo: string, branch: string) => Promise<string | undefined>;
  /** The identity rewrite before the recover path's open (record 0062;
   *  agent-ship items 10 and 15): the same rewrite the coding post-step runs,
   *  over an EMPTY start state — every earlier round's commits were rewritten
   *  before their own pull request opened, so they pass. Unreadable throws,
   *  which the pr-check reports as `github_unavailable`, never an open over
   *  unverified identities. Absent (a test of the other paths): no rewrite. */
  rewriteIdentities?: (args: {
    repo: string;
    base: string;
    branch: string;
    startState: BranchStartState;
    requester: string;
  }) => Promise<RewriteResult>;
  /** The branch's commits over the base (githubPulls.commitsOverBase): read on a
   *  plain pr-check that found no pull request, so the machine can end a unit
   *  whose scope already landed `already_landed` instead of aborting it
   *  (agent-ship item 12). Undefined, or a throw, leaves the fact out of the answer. */
  commitsOverBase: (repo: string, base: string, branch: string) => Promise<number | undefined>;
  /** The target repository at the base ref (the plan, the specs, the rules), its
   *  issues (a unit's board issue) and the comment a unit's ending leaves there
   *  — the App's GitHub reads and the one write beside the merge. */
  github: Pick<GithubApi, "readFile" | "listIssues" | "commentIssue">;
  /** Round 0's branch create (githubPulls.createBranchRef): 422 already-exists is success inside. */
  createBranchRef: (repo: string, branch: string, fromRef: string) => Promise<void>;
  /** The reviews on a pull request (githubPulls.fetchPullRequestReviews) and the
   *  identity this bot posts as: whether the bot's verdict stands at a head. */
  fetchPrReviews: (pr: { repo: string; number: number }) => Promise<PullRequestReview[] | undefined>;
  /** Conversation comments let an adopted attempt consume a trusted person's
   * answer posted after the last human-gated verdict before it reviews again. */
  fetchPrComments?: (pr: { repo: string; number: number }) => Promise<PullRequestComment[] | undefined>;
  /** A pull-request comment may brief the requester's write-capable child only
   * when its GitHub author is trusted to speak for that requester. */
  commenterAuthorized(requester: string, author: { login: string; id?: number }): Promise<boolean>;
  selfIdentity: () => Promise<GithubIdentity | undefined>;
  /** The pause between `read-record`'s looks at GitHub's review list when the
   *  child's record carries no post of its own (`REVIEW_POSTED_RECHECK_MS`
   *  apart); tests pass one that records instead of waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** The merge step's facts and its one write (githubPulls): the pull request
   *  as GitHub has it, the checks at a head, the squash at exactly that head.
   *  The pr-check follows the machine's adopted pull request through the same
   *  read when nothing heads the unit's branch (issue 1799). */
  fetchPrFacts: (pr: { repo: string; number: number }) => Promise<PullRequestFacts | undefined>;
  fetchCommitChecks: (repo: string, sha: string) => Promise<CommitChecks | undefined>;
  /** The head's self-declared fix-up commits (githubPulls.fixupCommitSubjects):
   *  read on the ending's facts pr-check so the merge-ready report can name an
   *  unsquashed head instead of calling it ready (agent-ship item 9). */
  fixupCommitSubjects: (pr: { repo: string; number: number }) => Promise<string[] | undefined>;
  mergePullRequest: (
    pr: { repo: string; number: number },
    opts: { sha: string; title: string },
  ) => Promise<MergeResult>;
  /** Whether a merge-queue rule protects the base branch (githubPulls.
   *  branchHasMergeQueue), read before the squash so a merge-queue repository
   *  is enqueued, never refused (issue 2011). Undefined = the rules could not
   *  be read — the door falls back to recognising GitHub's 405. Optional:
   *  without it, only the 405 recognition. */
  branchHasMergeQueue?: (repo: string, branch: string) => Promise<boolean | undefined>;
  /** The queue's one write (githubPulls.enqueuePullRequest): the GraphQL
   *  `enqueuePullRequest` mutation — the same act `gh pr merge --auto`
   *  performs. Optional: without it a merge-queue base is refused by name. */
  enqueuePullRequest?: (pr: { repo: string; number: number }, opts: { sha: string }) => Promise<EnqueueResult>;
  /** Where the pull request stands with the queue (githubPulls.
   *  fetchMergeQueueState), read on a `queued` re-ask: still in it, or removed
   *  with the queue's own reason. */
  fetchMergeQueueState?: (pr: { repo: string; number: number }) => Promise<MergeQueueState | undefined>;
  /** Records "this instance's merge step waits at this head" on every `pending`
   *  answer — the check-run intake's address book (checksIntake.ts,
   *  http-ingress.md item 12). The round's checks step registers through the
   *  same book, so one settled head wakes both waits. Optional: without it the
   *  bounded wait stands alone. */
  noteMergeWait?: (headSha: string, instanceId: string, at: number) => void;
  /** The round's checks read (record 0055): the check runs at the reviewed
   *  head with each failure classified against the pull request's changed
   *  paths (githubPulls.fetchCheckRunDetails + checkFindings.classifyRoundChecks).
   *  Optional: without it the step falls back to `fetchCommitChecks`, every
   *  failure a real one — the flake rule simply never fires. */
  fetchRoundChecks?: (
    repo: string,
    sha: string,
    prNumber: number,
    baseRef?: string,
  ) => Promise<RoundChecks | undefined>;
  /** The flake rule's one re-run (record 0055): re-run the failed jobs behind
   *  the named check runs at the head (githubPulls.rerunFailedJobs — the same
   *  `rerun-failed-jobs` retry the deploy pipeline documents). Optional:
   *  without it a retry ask answers false and the second read makes the finding. */
  rerunFailedChecks?: (repo: string, sha: string, names: string[]) => Promise<boolean>;
  /** Empty required-check recovery: close and reopen the pull request once so
   *  GitHub emits `pull_request` again without moving the reviewed head. */
  refirePullRequest?: (repo: string, prNumber: number) => Promise<boolean>;
  /** Where the parent's record goes when the instance ends. */
  runHistoryWriter: RunHistoryWriter;
  /** The channel's visibility stamp for that record (dispatch/record.ts `channelVisibilityOf`). */
  channelVisibilityOf: (channelId: string) => Promise<ChannelVisibility>;
  clock?: () => number;
  log?: (line: string) => void;
}

export interface CoordinatorRouteRequest {
  method?: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** The parsed spawn body: the instance, the step, the child's preset, an
 *  optional narrower budget, and the child's turn — the caller's own `prompt`,
 *  or a `brief` (ids) the bot composes the turn from, with the unit it runs for. */
export interface SpawnStepRequest {
  parentInstanceId: string;
  step: string;
  preset: string;
  budget?: number;
  /** The decision's tier for the child, as `<provider>/<model>`: written into
   *  the child's request as its own `model:` directive (`childRequestText`),
   *  so the child resolves it ahead of every scope. Held to the child
   *  preset's tier set (`spawnTierRefusal`) at the spawn. */
  model?: string;
  /** The decision's effort for the child: the child's own `effort:` directive. */
  effort?: Effort;
  prompt?: string;
  brief?: Brief;
  unit?: string;
}

const UNIT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const PRESETS_OF_KIND: Readonly<Record<Brief["kind"], string>> = {
  contract: "coding",
  review: "review",
  findings: "coding",
  rebase: "coding",
};

/** A brief as the coordinator sends it (`Brief`, ship/coordinator.ts): ids only, each shaped. */
function parseBrief(v: unknown): Parsed<Brief> {
  if (typeof v !== "object" || v === null) return invalid("brief must be an object");
  const b = v as Record<string, unknown>;
  if (typeof b.unit !== "string" || !UNIT_ID.test(b.unit)) return invalid("brief.unit must be a unit id");
  const pr = (): Parsed<number> =>
    typeof b.pr === "number" && Number.isInteger(b.pr) && b.pr > 0
      ? { ok: true, value: b.pr }
      : invalid("brief.pr must be a pull request number");
  const runId = (key: string): Parsed<string> =>
    typeof b[key] === "string" && RUN_ID_PATTERN.test(b[key] as string)
      ? { ok: true, value: b[key] as string }
      : invalid(`brief.${key} must be a run id`);
  // The round's check findings, carried by value (record 0055): finding rows
  // whose id is `check:<name>` and whose severity is the ladder's `blocking`.
  // The parsed rows carry `check: true` — machine provenance by construction
  // here — though the sender's own flag is not required, so a brief from a
  // Workflow instance deployed before the flag still parses across a roll.
  const checkRows = (): Parsed<Finding[] | undefined> => {
    if (b.checks === undefined) return { ok: true, value: undefined };
    if (
      !Array.isArray(b.checks) ||
      !b.checks.every(
        (f: unknown) =>
          typeof f === "object" &&
          f !== null &&
          typeof (f as Finding).id === "string" &&
          (f as Finding).id.startsWith("check:") &&
          (f as Finding).severity === "blocking" &&
          typeof (f as Finding).file === "string" &&
          typeof (f as Finding).title === "string",
      )
    )
      return invalid("brief.checks must be check-finding rows (id check:<name>, severity blocking)");
    return {
      ok: true,
      value: (b.checks as Finding[]).map((f) => ({
        id: f.id,
        severity: f.severity,
        file: f.file,
        title: f.title,
        check: true as const,
      })),
    };
  };
  switch (b.kind) {
    case "contract": {
      const r = b.rebase as Record<string, unknown> | undefined;
      if (typeof r !== "object" || r === null || typeof r.branch !== "string" || typeof r.onto !== "string")
        return invalid("brief.rebase must name the branch and what it is rebased onto");
      const c = b.continue as Record<string, unknown> | undefined;
      if (
        c !== undefined &&
        (typeof c !== "object" ||
          c === null ||
          !Number.isSafeInteger(c.segment) ||
          Number(c.segment) < 1 ||
          (c.from !== undefined && !fullHead(c.from)) ||
          (c.previousRunId !== undefined &&
            (typeof c.previousRunId !== "string" || !RUN_ID_PATTERN.test(c.previousRunId))) ||
          (c.texts !== undefined && (!Array.isArray(c.texts) || !c.texts.every((text) => typeof text === "string"))) ||
          (c.recovery !== undefined && c.recovery !== true))
      )
        return invalid("brief.continue must name a valid prior coding attempt");
      return {
        ok: true,
        value: {
          kind: "contract",
          unit: b.unit,
          rebase: { branch: r.branch, onto: r.onto },
          ...(c !== undefined
            ? {
                continue: {
                  segment: c.segment as number,
                  ...(c.from !== undefined ? { from: c.from as string } : {}),
                  ...(c.previousRunId !== undefined ? { previousRunId: c.previousRunId as string } : {}),
                  ...(c.texts !== undefined ? { texts: c.texts as string[] } : {}),
                  ...(c.recovery === true ? { recovery: true as const } : {}),
                },
              }
            : {}),
        },
      };
    }
    case "review": {
      const n = pr();
      if (!n.ok) return n;
      if (typeof b.round !== "number" || !Number.isInteger(b.round) || b.round < 1)
        return invalid("brief.round must be a whole number, at least 1");
      if (b.headSha !== undefined && typeof b.headSha !== "string") return invalid("brief.headSha must be a string");
      let prior: Extract<Brief, { kind: "review" }>["prior"];
      if (b.prior !== undefined) {
        const p = b.prior as Record<string, unknown>;
        if (
          typeof p !== "object" ||
          p === null ||
          typeof p.reviewRunId !== "string" ||
          !RUN_ID_PATTERN.test(p.reviewRunId)
        )
          return invalid("brief.prior.reviewRunId must be a run id");
        if (p.codingRunId !== undefined && (typeof p.codingRunId !== "string" || !RUN_ID_PATTERN.test(p.codingRunId)))
          return invalid("brief.prior.codingRunId must be a run id");
        prior = {
          reviewRunId: p.reviewRunId,
          ...(p.codingRunId !== undefined ? { codingRunId: p.codingRunId as string } : {}),
        };
      }
      const checks = checkRows();
      if (!checks.ok) return checks;
      return {
        ok: true,
        value: {
          kind: "review",
          unit: b.unit,
          pr: n.value,
          ...(b.headSha !== undefined ? { headSha: b.headSha as string } : {}),
          round: b.round,
          ...(prior ? { prior } : {}),
          ...(checks.value !== undefined ? { checks: checks.value } : {}),
        },
      };
    }
    case "findings": {
      const n = pr();
      if (!n.ok) return n;
      const review = runId("reviewRunId");
      if (!review.ok) return review;
      const checks = checkRows();
      if (!checks.ok) return checks;
      if (b.headSha !== undefined && (typeof b.headSha !== "string" || !/^[0-9a-f]{40}$/i.test(b.headSha)))
        return invalid("brief.headSha must be a full commit sha");
      return {
        ok: true,
        value: {
          kind: "findings",
          unit: b.unit,
          pr: n.value,
          reviewRunId: review.value,
          ...(b.headSha !== undefined ? { headSha: b.headSha as string } : {}),
          ...(checks.value !== undefined ? { checks: checks.value } : {}),
        },
      };
    }
    case "rebase": {
      const n = pr();
      if (!n.ok) return n;
      if (typeof b.headSha !== "string" || !/^[0-9a-f]{7,40}$/i.test(b.headSha))
        return invalid("brief.headSha must be a commit sha");
      if (typeof b.base !== "string" || b.base.length === 0) return invalid("brief.base must be a branch");
      return {
        ok: true,
        value: { kind: "rebase", unit: b.unit, pr: n.value, headSha: b.headSha, base: b.base },
      };
    }
    default:
      return invalid("brief.kind must be contract, review, findings or rebase");
  }
}

/** What `read-record` answers: the run's own facts and nothing of its stream
 *  but the final reply — the coordinator confirms an event and reads the
 *  child's handoff from it. */
export interface CoordinatorRunView {
  id: string;
  finished: boolean;
  status?: string;
  agent?: string;
  startedAt: number;
  finishedAt?: number;
  activity?: string;
  parentInstanceId: string;
  idempotencyKey?: string;
  /** The generation driving a live run elsewhere (run-history item 41). */
  ownerGen?: string;
  finalReply?: string;
  /** The final Git head independently observed by the run loop. */
  headSha?: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const invalid = <T>(error: string): Parsed<T> => ({ ok: false, error });
const json = (status: number, body: Record<string, unknown>): IngressResponse => ({ status, body });
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function parseObject(text: string): Parsed<Record<string, unknown>> {
  if (text.trim() === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid("body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return invalid("body must be a JSON object");
  return { ok: true, value: parsed as Record<string, unknown> };
}

function parseInstanceId(v: unknown): Parsed<string> {
  if (typeof v !== "string" || !INSTANCE_ID_PATTERN.test(v))
    return invalid("parentInstanceId must be a Workflow instance id");
  return { ok: true, value: v };
}

/** The spawn body: every field shaped before any store is read. The `ship`
 *  preset is refused — a coordinator's child is a round of a pipeline, never
 *  another pipeline — and the body's `userId`/`channelId`, if any, are ignored:
 *  the requester is the parent record's. */
export function parseSpawnStep(body: Record<string, unknown>): Parsed<SpawnStepRequest> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return id;
  if (typeof body.step !== "string" || !STEP_NAME_PATTERN.test(body.step))
    return invalid("step must be a step name (letters, digits, `_ . / -`, no colon)");
  if (typeof body.preset !== "string" || !Object.hasOwn(AGENTS, body.preset))
    return invalid(`preset must be a registered preset (${Object.keys(AGENTS).join(", ")})`);
  if (body.preset === "ship")
    return invalid("preset must not be ship: a coordinator's child is a round, not a pipeline");
  if (
    body.budget !== undefined &&
    (typeof body.budget !== "number" || !Number.isInteger(body.budget) || body.budget < 2)
  )
    return invalid("budget must be a whole number of minutes, at least 2");
  if (body.model !== undefined && (typeof body.model !== "string" || !/^\S+\/\S+$/.test(body.model)))
    return invalid("model must be a `<provider>/<model>` ref");
  if (body.effort !== undefined && !isEffort(body.effort))
    return invalid(`effort must be one of ${EFFORT_LEVELS_HINT}`);
  if (body.unit !== undefined && (typeof body.unit !== "string" || !UNIT_ID.test(body.unit)))
    return invalid("unit must be a unit id");
  const value: SpawnStepRequest = {
    parentInstanceId: id.value,
    step: body.step,
    preset: body.preset,
    ...(body.budget !== undefined ? { budget: body.budget as number } : {}),
    ...(body.model !== undefined ? { model: body.model as string } : {}),
    ...(body.effort !== undefined ? { effort: body.effort as Effort } : {}),
    ...(body.unit !== undefined ? { unit: body.unit as string } : {}),
  };
  // The child's turn: the caller's own prompt, or a brief the bot composes it
  // from — one of the two, and a brief's kind fixes the preset.
  if (body.brief !== undefined) {
    if (body.prompt !== undefined) return invalid("prompt and brief are one or the other");
    const brief = parseBrief(body.brief);
    if (!brief.ok) return brief;
    if (PRESETS_OF_KIND[brief.value.kind] !== body.preset)
      return invalid(`preset must be ${PRESETS_OF_KIND[brief.value.kind]} for a ${brief.value.kind} brief`);
    return { ok: true, value: { ...value, brief: brief.value, unit: brief.value.unit } };
  }
  if (typeof body.prompt !== "string" || body.prompt.trim() === "" || body.prompt.length > MAX_SPAWN_PROMPT_CHARS)
    return invalid(`prompt must be a non-empty string of at most ${MAX_SPAWN_PROMPT_CHARS} characters`);
  return { ok: true, value: { ...value, prompt: body.prompt } };
}

/** The unit row a body names, when it names one, beside the instance's rows —
 *  their count decides the unit's thread (record 0055 item 3): `unit_not_found`
 *  when the instance has no such unit. Absent `unit` → undefined row (the
 *  instance's own thread). */
async function unitRowOf(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  unit: string | undefined,
): Promise<
  | { ok: true; row: CoordinatorUnit | undefined; rows: readonly CoordinatorUnit[] }
  | { ok: false; response: IngressResponse }
> {
  const rows = await deps.instances.listUnits(instance.id);
  if (unit === undefined) return { ok: true, row: undefined, rows };
  const row = rows.find((u) => u.unit === unit);
  if (!row) return { ok: false, response: json(404, { ok: false, error: "unit_not_found", unit }) };
  return { ok: true, row, rows };
}

/** A generated plan's instance: `plan` without a `path` — the mark the hand-off
 *  writes for a task request, which means the task wording (no unit id on the
 *  card and summary lines, no board issue); the unit's thread is the count's
 *  to decide, not this mark's (agent-ship item 16). */
const isGenerated = (instance: CoordinatorInstance): boolean => instance.plan?.path === undefined;

/** The thread a unit's coding children run in, and where its findings are
 *  dispatched: the unit's own once opened, the requesting thread for a one-unit
 *  plan — whatever its source, keyed on the unit count (record 0055 item 3) —
 *  the thread every child of the unit runs in (record 0055). */
function unitThread(instance: CoordinatorInstance, row: CoordinatorUnit | undefined, unitCount: number) {
  if (row?.workBrief !== undefined)
    return { threadKey: privateWorkerThreadKey({ instanceId: instance.id, unit: row.unit }), sourceUrl: undefined };
  const threadKey = row?.threadKey ?? (row === undefined || unitCount === 1 ? instance.threadKey : undefined);
  const sourceUrl = row?.sourceUrl ?? (threadKey === instance.threadKey ? instance.sourceUrl : undefined);
  return { threadKey, sourceUrl };
}

function unitIO(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  currentInputId?: string,
): ChannelIO | undefined {
  if (row.workBrief !== undefined) {
    if (!deps.privateWorkerLog) return undefined;
    // A final report and a wake append to the durable internal log without a
    // model read. Only a new coding/review spawn needs the requester gate.
    if (!currentInputId)
      return privateWorkerIO(
        deps.privateWorkerLog,
        { instanceId: instance.id, unit: row.unit },
        {
          clock: deps.clock ?? systemClock,
        },
      );
    const audience = privateWorkerAudienceFor(instance, row, currentInputId, deps.ioFor, deps.instances);
    if (!audience) return undefined;
    return privateWorkerIO(
      deps.privateWorkerLog,
      { instanceId: instance.id, unit: row.unit },
      {
        clock: deps.clock ?? systemClock,
        currentInputId,
        audience,
      },
    );
  }
  const thread = unitThread(instance, row, 1);
  return thread.threadKey === undefined
    ? undefined
    : deps.ioFor({ threadKey: thread.threadKey, userId: instance.userId });
}

type OpenedThreadRef = { threadKey: string; sourceUrl?: string };

/** A thread opened top-level in the requesting thread's channel with `lead`
 *  (`ChannelIO.openThread`): `503 no_channel` without a channel that can,
 *  `502 thread_failed` on a failed open, both passing conditions the runner
 *  asks again on. */
async function openThreadFromRequester(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  unit: string,
  lead: string,
  at: number,
): Promise<{ ok: true; thread: OpenedThreadRef } | { ok: false; response: IngressResponse }> {
  const parent = deps.ioFor({ threadKey: instance.threadKey, userId: instance.userId });
  if (!parent?.openThread) return { ok: false, response: json(503, { ok: false, error: "no_channel", at }) };
  try {
    const opened = await parent.openThread(lead, `${instance.id}:${unit}`);
    return {
      ok: true,
      thread: {
        threadKey: opened.thread.threadKey,
        ...(opened.thread.sourceUrl !== undefined ? { sourceUrl: opened.thread.sourceUrl } : {}),
      },
    };
  } catch (err) {
    return { ok: false, response: json(502, { ok: false, error: "thread_failed", message: describe(err), at }) };
  }
}

/** The whole door: WHO (the bearer in the token map — 401/503) and WHETHER (the
 *  actor `http:<subject>` on `coordinator:step` against the policy table —
 *  403). The deny reason stays in the log; the reply names the grant. */
function authorizeStep(
  headers: IncomingHttpHeaders,
  step: string,
  deps: AdminCoordinatorDeps,
): { ok: true; subject: string } | { ok: false; response: IngressResponse; reason: string } {
  const raw = headers.authorization;
  const authorization = Array.isArray(raw) ? raw[0] : raw;
  const authn = authenticateIngressBearer(authorization, deps.tokens?.reveal(), "coordinator");
  if (!authn.ok)
    return { ok: false, response: json(authn.status, { ok: false, error: authn.reason }), reason: authn.reason };
  const subject = authn.identity.subject;
  const actor = resolveActor({ surface: "http", subjectId: subject }, deps.grantsFor);
  const decision = authorize(actor, COORDINATOR_STEP_ACTION, { type: "command", id: `coordinator.${step}` });
  if (!decision.allow) {
    return {
      ok: false,
      reason: decision.reason,
      response: json(403, {
        ok: false,
        error: `forbidden: identity "${subject}" holds no ${COORDINATOR_STEP_ACTION} grant (grants["http:${subject}"] in config.yaml)`,
      }),
    };
  }
  return { ok: true, subject };
}

/** Every run — the bot's own bookkeeping over the instance's thread, not a
 *  person's read: the requester was authorized at the child's dispatch. */
const EVERY_RUN = { kind: "all" } as const;

/** The run holding the unit's thread right now: here, or on another generation's
 *  ledger row. A hosted ship parent occupies no thread (record 0060;
 *  thread-admission item 1): its view carries the thread from the metadata
 *  while its ledger row sits under the host key, so it is skipped — a one-unit
 *  task's child spawns into the requesting thread beside it. */
async function liveOnThread(
  runs: RunsService,
  instance: CoordinatorInstance,
  threadKey: string,
): Promise<RunView | undefined> {
  const active = await runs.listRuns({
    privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
    status: "active",
    visibleTo: EVERY_RUN,
    channel: instance.channelId,
    limit: RUN_LIST_MAX_LIMIT,
  });
  return active.runs.find((r) => r.threadKey === threadKey && !r.finished && !r.hosted);
}

/** A finished run in the unit's thread carrying the key, since the instance was created. */
async function finishedWithKey(
  runs: RunsService,
  instance: CoordinatorInstance,
  threadKey: string,
  key: string,
): Promise<RunView | undefined> {
  let cursor: { before: number; beforeId: string } | undefined;
  for (let page = 0; page < FINISHED_LOOKBACK_PAGES; page++) {
    const result = await runs.listRuns({
      privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
      status: "finished",
      visibleTo: EVERY_RUN,
      channel: instance.channelId,
      sinceMs: instance.createdAt,
      limit: RUN_LIST_MAX_LIMIT,
      ...(cursor ?? {}),
    });
    const hit = result.runs.find((r) => r.threadKey === threadKey && r.idempotencyKey === key);
    if (hit) return hit;
    if (!result.nextBefore) return undefined;
    cursor = { before: result.nextBefore.finishedAt, beforeId: result.nextBefore.id };
  }
  return undefined;
}

/** The spawn's answer for a run already holding the step or the thread. */
function answerForLive(live: RunView, key: string, threadKey: string, at: number): IngressResponse {
  if (live.idempotencyKey === key) return json(200, { ok: true, runId: live.id, threadKey, alreadySpawned: true, at });
  return json(409, {
    ok: false,
    error: "busy",
    runId: live.id,
    ...(live.agent !== undefined ? { agent: live.agent } : {}),
    at,
  });
}

/** The child's channel with two ears on it: the registration and every reply
 *  (a gate's refusal is the last one before the dispatch ends). By method,
 *  never a spread — the adapter's IO is a class instance. */
function watched(io: ChannelIO, on: { started: (id: string) => void; replied: (text: string) => void }): ChannelIO {
  const out: ChannelIO = {
    reply: async (text) => {
      on.replied(text);
      await io.reply(text);
    },
    status: (initial, display) => io.status(initial, display),
    history: () => io.history(),
    runStarted: (started) => {
      io.runStarted?.(started);
      on.started(started.id);
    },
  };
  if (io.attach) out.attach = (file) => io.attach!(file);
  if (io.attachFile) out.attachFile = (file) => io.attachFile!(file);
  if (io.uploadTicket) out.uploadTicket = (file) => io.uploadTicket!(file);
  if (io.runFinished) out.runFinished = (receipt) => io.runFinished!(receipt);
  if (io.requestFailed) out.requestFailed = () => io.requestFailed!();
  if (io.openThread) out.openThread = (lead) => io.openThread!(lead);
  if (io.directAudience) out.directAudience = () => io.directAudience!();
  if (io.verifyDirectAudience) out.verifyDirectAudience = (audience) => io.verifyDirectAudience!(audience);
  if (io.verifyPrivateWorkerAudience)
    out.verifyPrivateWorkerAudience = (request) => io.verifyPrivateWorkerAudience!(request);
  return out;
}

async function spawn(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const parsed = parseSpawnStep(body);
  if (!parsed.ok) return json(400, { ok: false, error: parsed.error });
  const req = parsed.value;
  // The tier gate (the one-door plan's tiers rule): the runner's children do
  // not go through `spawnChild`, so the same gate holds here — a coding or
  // review child on the fast tier is refused before any store is read.
  const tierProblem = spawnTierRefusal(req, deps.appConfig?.() ?? {});
  if (tierProblem !== undefined) return json(400, { ok: false, error: "spawn_tier", message: tierProblem });
  const at = (deps.clock ?? systemClock)();
  const queued = () =>
    json(409, {
      ok: false,
      error: "queued",
      message: "waiting for the next bot generation",
      at,
    });
  if (deps.childAdmission?.draining() === true) return queued();
  const log = deps.log ?? console.log;
  const instance = await deps.instances.get(req.parentInstanceId);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  // The hard stop's mark (record 0060; issue 1924): a sealed parent's runner
  // spawns nothing more — the refusal is terminal, and the machine ends the
  // unit stopped on it.
  if (instance.stop !== undefined) return json(409, { ok: false, error: "stopped", at });
  const unit = await unitRowOf(deps, instance, req.unit);
  if (!unit.ok) return unit.response;
  if (unit.rows.some((candidate) => candidate.workBrief !== undefined) && unit.row?.workBrief === undefined)
    return json(409, { ok: false, error: "private_worker_unit_required", at });
  if (unit.row?.workBrief !== undefined) {
    const expected = privateWorkerThreadKey({ instanceId: instance.id, unit: unit.row.unit });
    if (unit.row.threadKey !== expected || unit.row.reviewThread !== undefined)
      return json(409, { ok: false, error: "private_worker_not_started", at });
    if (deps.privateWorkerLog === undefined)
      return json(503, { ok: false, error: "private_worker_log_unavailable", at });
  }
  const own = unitThread(instance, unit.row, unit.rows.length);
  // A plan unit's thread is opened by `unit-start`; a spawn before it has no
  // thread to run in — a passing condition (the runner asks again), stamped
  // like every answer.
  if (own.threadKey === undefined) return json(409, { ok: false, error: "unit_not_started", unit: req.unit, at });
  // The thread the child runs in: the unit's own, for every child (record
  // 0055) — the review child seeds from its own session (`<thread>:review`)
  // and attaches a tree of its own life, so nothing needs a second thread; a
  // coding child and the findings step's run continue the coding session
  // there. A row a bot wrote before record 0055 names a review thread; its
  // review rounds stay there, so a unit in flight across the release keeps
  // its review session where it began.
  const row = unit.row;
  if (row?.workBrief !== undefined && req.brief === undefined)
    return json(409, { ok: false, error: "private_worker_brief_required", at });
  const legacy = req.preset === "review" ? row?.reviewThread : undefined;
  const thread: OpenedThreadRef = legacy ?? {
    threadKey: own.threadKey,
    ...(own.sourceUrl !== undefined ? { sourceUrl: own.sourceUrl } : {}),
  };
  const threadKey = thread.threadKey;
  const key = idempotencyKeyFor(instance.id, req.step);
  // Retry-safe before anything starts: the step's child, live or finished, or
  // another run holding the unit's thread.
  const live = await liveOnThread(deps.runs, instance, threadKey);
  if (live) return answerForLive(live, key, threadKey, at);
  const done = await finishedWithKey(deps.runs, instance, threadKey, key);
  if (done) return json(200, { ok: true, runId: done.id, threadKey, alreadySpawned: true, at });
  if (row?.recovery?.kind === "coding") {
    if (
      req.preset !== "coding" ||
      req.brief?.kind !== "contract" ||
      req.step !== row.recovery.step ||
      req.brief.unit !== row.unit ||
      req.brief.rebase.branch !== row.branch ||
      req.brief.rebase.onto !== instance.base ||
      req.brief.continue?.segment !== 1 ||
      req.brief.continue.recovery !== true ||
      req.brief.continue.from !== row.recovery.expectedHeadSha ||
      req.brief.continue.previousRunId !== row.recovery.codingRunId ||
      typeof req.budget !== "number" ||
      req.budget > Math.floor((row.recovery.deadlineAt - at) / minutesToMs(1))
    )
      return json(409, { ok: false, error: "recovery_claim_mismatch", at });
    const head = await deps.fetchBranchHeadSha?.(instance.repo, row.branch).catch(() => undefined);
    if (head === undefined) return json(409, { ok: false, error: "recovery_ref_unavailable", at });
    if (head !== row.recovery.expectedHeadSha) return json(409, { ok: false, error: "recovery_head_moved", at });
    const [open, merged] = await Promise.all([
      deps.findOpenPrByHead(instance.repo, row.branch).catch(() => undefined),
      deps.findMergedPrByHead(instance.repo, row.branch).catch(() => undefined),
    ]);
    if (open === undefined || merged === undefined) return json(409, { ok: false, error: "github_unavailable", at });
    if (open !== null || merged !== null) return json(409, { ok: false, error: "recovery_stage_changed", at });
  } else if (row?.recovery !== undefined) {
    const expectedKind = req.preset === "coding" ? "findings" : "review";
    const stepMatch = new RegExp(`^${row.unit}/recovery/[1-9][0-9]*/${expectedKind}(?:/a[1-9][0-9]*)?$`).test(req.step);
    const briefHead =
      req.brief !== undefined && "headSha" in req.brief && typeof req.brief.headSha === "string"
        ? req.brief.headSha
        : undefined;
    if (
      !stepMatch ||
      row.publication === undefined ||
      briefHead !== row.publication.expectedHeadSha ||
      typeof req.budget !== "number" ||
      req.budget > Math.floor((row.recovery.deadlineAt - at) / minutesToMs(1))
    )
      return json(409, { ok: false, error: "recovery_claim_mismatch", at });
    if (row.recovery.externalReview !== undefined) {
      const trigger = row.recovery.externalReview;
      if (req.step === row.recovery.step) {
        // Revalidate immediately before the first read-only child, not merely
        // when the Workflow was queued. Human prose never authorizes coding.
        const current = await laterRecoveryReview(
          deps,
          instance,
          row.pr!,
          trigger.headSha,
          row.recovery.previousEnding.at,
          at,
        );
        if (
          req.preset !== "review" ||
          req.brief?.kind !== "review" ||
          req.brief.prior !== undefined ||
          JSON.stringify(current) !== JSON.stringify(trigger)
        )
          return json(409, { ok: false, error: "recovery_later_review_invalid", at });
      } else {
        if (!(await claimedRecoveryReviewValid(deps, instance, row.pr!, trigger)))
          return json(409, { ok: false, error: "recovery_later_review_invalid", at });
        const reviewId =
          req.brief?.kind === "findings"
            ? req.brief.reviewRunId
            : req.brief?.kind === "review"
              ? req.brief.prior?.reviewRunId
              : undefined;
        const review =
          reviewId === undefined
            ? undefined
            : await deps.runs.getRun(reviewId, { privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ });
        const run = review?.ok ? review.value : undefined;
        const round = Number(req.step.split("/")[2]);
        const priorRound = req.preset === "review" ? round - 1 : round;
        if (
          run === undefined ||
          !run.finished ||
          run.persisted !== true ||
          run.status !== "completed" ||
          run.agent !== "review" ||
          run.parentInstanceId !== instance.id ||
          run.userId !== instance.userId ||
          run.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
          run.threadKey !== (row.reviewThread?.threadKey ?? row.threadKey ?? instance.threadKey) ||
          priorRound < row.recovery.round ||
          round > (instance.caps?.maxRounds ?? 0) + (row.recovery.patternContinuations ?? 0) ||
          !isStepAttempt(run.idempotencyKey, `${instance.id}:${row.unit}/recovery/${priorRound}/review`) ||
          run.verdict === undefined ||
          run.reviewPost?.posted !== true ||
          run.reviewPost.target.repo.toLowerCase() !== instance.repo.toLowerCase() ||
          run.reviewPost.target.number !== row.pr!.number ||
          run.reviewPost.head !== run.reviewHead ||
          (req.preset === "coding" && run.reviewHead !== briefHead)
        )
          return json(409, { ok: false, error: "recovery_review_evidence_ambiguous", at });
      }
    }
    let facts: PullRequestFacts | undefined;
    try {
      facts = await deps.fetchPrFacts({ repo: instance.repo, number: row.publication.pr });
    } catch (err) {
      return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
    }
    const verified = facts?.verifiedHead;
    if (
      facts?.state !== "open" ||
      facts.sameRepoHead !== true ||
      facts.headBranchExists !== true ||
      facts.headRef !== row.publication.headRef ||
      facts.baseRef !== row.publication.baseRef ||
      facts.headSha !== row.publication.expectedHeadSha ||
      verified?.repo.toLowerCase() !== instance.repo.toLowerCase() ||
      verified.ref !== row.publication.publicationRef ||
      verified.sha !== row.publication.expectedHeadSha
    )
      return json(409, {
        ok: false,
        error:
          fullHead(facts?.headSha) && facts.headSha !== row.publication.expectedHeadSha
            ? "recovery_head_moved"
            : "recovery_facts_mismatch",
        at,
      });
    try {
      if (deps.runnerOwnership?.claim(instance.repo, row.publication.pr, row.publication.owner) !== true)
        return json(409, { ok: false, error: "publication_ownership_changed", at });
    } catch (err) {
      return json(409, { ok: false, error: "publication_ownership_unknown", message: describe(err), at });
    }
  }
  const io =
    row?.workBrief !== undefined
      ? unitIO(deps, instance, row, key)
      : deps.ioFor({ threadKey, userId: instance.userId });
  if (!io) return json(503, { ok: false, error: "no_channel", at });
  // The child's turn: the caller's prompt, or the brief composed from what the
  // bot holds — the plan at the base ref, the prior rounds' records.
  let turn: { prompt: string; ref?: string; contract?: DispatchOptions["contract"]; issuedFindingIds?: string[] };
  if (req.brief !== undefined) {
    if (row === undefined) return json(400, { ok: false, error: "a brief needs the unit it runs for" });
    try {
      turn = await composeChild(req.brief, instance, row, briefReaders(deps, instance));
    } catch (err) {
      // A brief the bot cannot compose — the plan missing at the base, a run
      // the history lacks — is a failed spawn: the machine ends the unit as an
      // abort naming the reason, never a child half-briefed and never a retry
      // of a read that cannot change.
      log(`[coordinator] ${instance.id} ${req.step}: the brief could not be composed: ${describe(err)}`);
      return json(502, { ok: false, error: "brief_failed", message: describe(err), at });
    }
  } else {
    turn = { prompt: req.prompt! };
  }
  // The fold (record 0051's fold rule): every coding spawn carries the unit's
  // unconsumed thread events — in arrival order, each text attributed to its
  // sender, appended after the brief's own text — and marks them consumed by
  // this spawn's step once the child registers; a review spawn leaves them
  // (the review reads the diff, not the thread), and a replayed spawn answers
  // `alreadySpawned` above before this read, so nothing folds twice.
  let folded: ThreadEvent[] = [];
  if (req.preset === "coding" && row !== undefined) {
    folded = await deps.instances.listEvents({ instanceId: instance.id, unit: row.unit }, true).catch(() => []);
    if (folded.length > 0)
      turn = { ...turn, prompt: `${turn.prompt}\n\nThe thread since the last step:\n\n${foldThreadEvents(folded)}` };
  }
  // The events' stored attachments ride the child's message as its own images
  // and documents (`foldThreadAttachments`): what the append kept under the cap
  // has a reader, as the ack promised.
  const carried = foldThreadAttachments(folded);
  // An existing-PR coding child is admitted only with a complete durable
  // publication binding and while this exact unit still owns the pull request.
  // A missing binding/recovery view or a rival owner blocks before the model.
  const existingPrCodingTarget =
    req.preset === "coding" &&
    row !== undefined &&
    (row.publication !== undefined ||
      row.pr !== undefined ||
      row.resume !== undefined ||
      parsePlanBranch(row.branch) === undefined);
  if (existingPrCodingTarget) {
    if (row.publication === undefined)
      return json(409, {
        ok: false,
        error: "publication_binding_missing",
        message: "the existing pull request has no durable publication binding",
        at,
      });
    try {
      // A recovery Workflow can outlive the bot process that admitted it. Its
      // durable claim is sufficient to rebuild only this exact owner before
      // every write-child admission; a rival process-local owner still wins.
      if (
        row.recovery !== undefined &&
        deps.runnerOwnership?.claim(instance.repo, row.publication.pr, row.publication.owner) !== true
      )
        return json(409, {
          ok: false,
          error: "publication_ownership_changed",
          message: "the durable recovery claim no longer owns the pull request",
          at,
        });
      const owner = deps.runnerOwnership?.owner(instance.repo, row.publication.pr);
      if (
        owner === undefined ||
        owner.instanceId !== row.publication.owner.instanceId ||
        owner.unit !== row.publication.owner.unit
      )
        return json(409, {
          ok: false,
          error: "publication_ownership_changed",
          message: "the durable existing-PR publication owner is no longer the runner's sole owner",
          at,
        });
    } catch (err) {
      return json(409, {
        ok: false,
        error: "publication_ownership_unknown",
        message: describe(err),
        at,
      });
    }
  }
  // The child's message is the one the requester would have typed, in the
  // child's thread, as the requester the parent record names. The directive is
  // the message's own (`childRequestText`), so the findings step's `agent:coding`
  // resolves the coding preset whatever a person's detour in the thread or a
  // lost store would have made sticky.
  // A coordinator child is synthetic: its requester and thread come from the
  // durable instance, not a new Slack event. Rebuild private authority only
  // from the adapter's current address and a fresh Slack verification. The
  // dispatch gate checks it again after this handoff, so a changed audience
  // cannot inherit the parent's former access.
  const address = io.directAudience?.();
  const candidate = address
    ? directAudienceStampOf({
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey,
        ...(instance.postedBy !== undefined ? { postedBy: instance.postedBy } : {}),
        ...(instance.authenticatedAs !== undefined ? { authenticatedAs: instance.authenticatedAs } : {}),
        directAudience: { kind: "slack-unshared-im", ...address },
      })
    : undefined;
  let verifiedAudience: typeof candidate;
  if (candidate && io.verifyDirectAudience) {
    try {
      if ((await io.verifyDirectAudience(candidate)).ok) verifiedAudience = candidate;
    } catch {
      // A failed Slack read cannot mint authority for a synthetic child.
    }
  }
  const msg: IncomingMessage = {
    channelId: instance.channelId,
    userId: instance.userId,
    ...(instance.userName !== undefined ? { userName: instance.userName } : {}),
    ...(instance.authenticatedAs !== undefined ? { authenticatedAs: instance.authenticatedAs } : {}),
    ...(instance.postedBy !== undefined ? { postedBy: instance.postedBy } : {}),
    ...(instance.channelName !== undefined ? { channelName: instance.channelName } : {}),
    threadKey,
    ...(verifiedAudience !== undefined ? { directAudience: verifiedAudience } : {}),
    ...(row?.workBrief !== undefined ? { messageId: key } : {}),
    ...(thread.sourceUrl !== undefined ? { sourceUrl: thread.sourceUrl } : {}),
    text: childRequestText({
      preset: req.preset,
      prompt: turn.prompt,
      repo: instance.repo,
      ...(turn.ref !== undefined ? { ref: turn.ref } : {}),
      ...(req.budget !== undefined ? { budget: req.budget } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.effort !== undefined ? { effort: req.effort } : {}),
    }),
    ...carried,
    receivedAt: at,
  };
  if (row?.workBrief !== undefined) {
    if (!(await io.verifyPrivateWorkerAudience?.(msg))?.ok)
      return json(409, { ok: false, error: "private_worker_audience_unverified", at });
    try {
      await appendPrivateWorkerInput(
        deps.privateWorkerLog!,
        { instanceId: instance.id, unit: row.unit },
        {
          id: key,
          sender: instance.userId,
          text: msg.text,
          at,
        },
      );
    } catch (err) {
      return json(503, { ok: false, error: "private_worker_log_unavailable", message: describe(err), at });
    }
  }
  if (row?.recovery?.kind === "coding") {
    const [head, open, merged, rows] = await Promise.all([
      deps.fetchBranchHeadSha?.(instance.repo, row.branch).catch(() => undefined),
      deps.findOpenPrByHead(instance.repo, row.branch).catch(() => undefined),
      deps.findMergedPrByHead(instance.repo, row.branch).catch(() => undefined),
      deps.instances.listUnits(instance.id).catch(() => undefined),
    ]);
    if (
      head !== row.recovery.expectedHeadSha ||
      open === undefined ||
      open !== null ||
      merged === undefined ||
      merged !== null ||
      rows?.filter((candidate) => candidate.unit === row.unit).length !== 1 ||
      JSON.stringify(rows.find((candidate) => candidate.unit === row.unit)) !== JSON.stringify(row)
    )
      return json(409, { ok: false, error: "recovery_claim_mismatch", at });
  }
  // The definitive drain fence sits beside dispatch, after every asynchronous
  // read. Its synchronous permit acquisition and dispatch call cannot have a
  // signal callback interleave; once dispatch yields, the drain counts this
  // permit until a registry row exists (or dispatch ends without one).
  const leaveAdmission = deps.childAdmission?.enter();
  if (deps.childAdmission !== undefined && leaveAdmission === undefined) return queued();
  const releaseAdmission = leaveAdmission ?? (() => {});
  let startedId: string | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let lastReply: string | undefined;
  let resolveStarted!: (id: string) => void;
  const started = new Promise<string>((resolve) => {
    resolveStarted = resolve;
  });
  const child = watched(io, {
    started: (id) => {
      startedId = id;
      if (row?.recovery !== undefined) {
        const stopAtDeadline = () => {
          void deps.runs.stopRun(id, "hard", { kind: "access", id: "original-unit-recovery-deadline" });
        };
        const left = row.recovery.deadlineAt - (deps.clock ?? systemClock)();
        if (left <= 0) stopAtDeadline();
        else deadlineTimer = setTimeout(stopAtDeadline, left);
      }
      releaseAdmission();
      resolveStarted(id);
    },
    replied: (text) => {
      lastReply = text;
    },
  });
  // The child is dispatched at its unit branch (the resident attaches there),
  // so the thread cannot tell the post-step which branch the pull request
  // targets: the tag says it — the plan's base — when the instance knows one.
  const roundExpectedHead =
    req.brief?.kind === "findings" || req.brief?.kind === "rebase"
      ? req.brief.headSha
      : req.brief?.kind === "contract"
        ? req.brief.continue?.from
        : undefined;
  const publication =
    req.preset === "coding" && row?.publication !== undefined
      ? {
          ...row.publication,
          ...(roundExpectedHead !== undefined ? { expectedHeadSha: roundExpectedHead } : {}),
        }
      : undefined;
  const tag: CoordinatorTag = {
    parentInstanceId: instance.id,
    idempotencyKey: key,
    ...(row ? { unit: row.unit, instanceAttempt: instance.attempt ?? 0 } : {}),
    ...(instance.grant?.costCapUsd !== undefined ? { costCapUsd: instance.grant.costCapUsd } : {}),
    ...((row?.branch ?? instance.branch) !== undefined ? { branch: row?.branch ?? instance.branch } : {}),
    ...(row?.recovery !== undefined ? { transportWorkflowId: row.recovery.workflowId } : {}),
    ...(row?.recovery !== undefined && row.publication !== undefined
      ? {
          recovery: {
            repo: row.publication.repo,
            pr: row.publication.pr,
            headRef: row.publication.headRef,
            baseRef: row.publication.baseRef,
            expectedHeadSha: row.recovery.expectedHeadSha,
            deadlineAt: row.recovery.deadlineAt,
            ...(row.recovery.patch !== undefined ? { patch: row.recovery.patch } : {}),
          },
        }
      : {}),
    ...(instance.base !== undefined ? { base: instance.base } : {}),
    ...(publication !== undefined ? { publication } : {}),
    ...(req.brief?.kind === "findings" && turn.issuedFindingIds !== undefined
      ? { issuedFindingIds: turn.issuedFindingIds }
      : {}),
  };
  let dispatching: Promise<DispatchOutcome>;
  try {
    dispatching = deps.dispatch(msg, child, {
      operationTarget: {
        repo: instance.repo,
        ...(req.preset === "coding" ? { ref: turn.ref ?? row?.branch ?? instance.branch } : {}),
      },
      coordinator: tag,
      ...(row?.context
        ? {
            childHandoff: row.context.handoff,
            unitContextAdmission: {
              instanceId: instance.id,
              unit: row.unit,
              instanceAttempt: instance.attempt ?? 0,
              idempotencyKey: key,
            },
          }
        : {}),
      ...(row?.recovery !== undefined && row.publication !== undefined
        ? {
            recovery: {
              repo: row.publication.repo,
              pr: row.publication.pr,
              headRef: row.publication.headRef,
              baseRef: row.publication.baseRef,
              expectedHeadSha: row.publication.expectedHeadSha,
              deadlineAt: row.recovery.deadlineAt,
            },
          }
        : {}),
      ...(turn.contract !== undefined ? { contract: turn.contract } : {}),
    });
  } catch (err) {
    releaseAdmission();
    return json(502, { ok: false, error: "spawn_failed", message: describe(err), at });
  }
  const settled = dispatching.then(
    (outcome) => ({ kind: "ended" as const, outcome }),
    (err: unknown) => ({ kind: "threw" as const, err }),
  );
  void settled.finally(() => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  });
  // The dispatch runs on in the process (counted in flight like any run); the
  // route answers at registration, and a throw after that is a log line.
  void settled.then((end) => {
    releaseAdmission();
    if (end.kind === "threw")
      log(`[coordinator] ${instance.id} ${req.step}: the child's dispatch threw: ${describe(end.err)}`);
  });
  const first = await Promise.race([started.then((id) => ({ kind: "started" as const, id })), settled]);
  if (first.kind === "started" || startedId !== undefined) {
    const runId = first.kind === "started" ? first.id : startedId!;
    if (folded.length > 0) {
      // Consumed by the spawn's step (record 0051's fold rule): the same identity a
      // replay carries, so the marks and the retry answer agree. A failed mark
      // is a log line — the next coding spawn folds the rows again rather than
      // losing them.
      await deps.instances
        .markConsumed(
          { instanceId: instance.id, unit: row!.unit },
          folded.map((e) => e.seq),
          req.step,
        )
        .catch((err) => log(`[coordinator] ${instance.id} ${req.step}: the consumed marks failed: ${describe(err)}`));
      log(
        `[coordinator] ${instance.id} ${req.step}: folded ${folded.length} thread event(s) into the ${req.preset} child`,
      );
    }
    log(`[coordinator] ${instance.id} ${req.step}: spawned ${req.preset} run ${runId} in ${threadKey}`);
    return json(200, { ok: true, runId, threadKey, at });
  }
  if (first.kind === "threw") return json(502, { ok: false, error: "spawn_failed", message: describe(first.err), at });
  const refusal = first.outcome.refusal;
  if (refusal === "coordinator_thread_live") {
    // A run took the thread between the read above and the claim: answer from it.
    const now = await liveOnThread(deps.runs, instance, threadKey);
    if (now) return answerForLive(now, key, threadKey, at);
    return json(409, { ok: false, error: "busy", at });
  }
  log(`[coordinator] ${instance.id} ${req.step}: ${req.preset} child not started (${refusal ?? first.outcome.status})`);
  if (refusal !== undefined)
    return json(403, { ok: false, error: refusal, ...(lastReply !== undefined ? { message: lastReply } : {}), at });
  return json(502, {
    ok: false,
    error: "spawn_failed",
    message: lastReply ?? `the child ended (${first.outcome.status}) before it started`,
    at,
  });
}

function reviewAskedAtOf(events: readonly RunEvent[] | undefined): number | undefined {
  const posted = [...(events ?? [])].reverse().find((event) => event.type === "review_posted");
  return posted?.type === "review_posted" && typeof posted.at === "number" ? posted.at : undefined;
}

function finalReplyOf(events: readonly RunEvent[] | undefined): string | undefined {
  const last = [...(events ?? [])].reverse().find((e) => e.type === "answer");
  return last && last.type === "answer" ? last.text : undefined;
}

function coordinatorRunView(
  view: RunView,
  parentInstanceId: string,
  finalReply: string | undefined,
): CoordinatorRunView {
  return {
    id: view.id,
    finished: view.finished,
    ...(view.status !== undefined ? { status: view.status } : {}),
    ...(view.agent !== undefined ? { agent: view.agent } : {}),
    startedAt: view.startedAt,
    ...(view.finishedAt !== undefined ? { finishedAt: view.finishedAt } : {}),
    ...(view.activity !== undefined ? { activity: view.activity } : {}),
    parentInstanceId,
    ...(view.idempotencyKey !== undefined ? { idempotencyKey: view.idempotencyKey } : {}),
    ...(view.ownerGen !== undefined ? { ownerGen: view.ownerGen } : {}),
    ...(finalReply !== undefined ? { finalReply } : {}),
    ...(view.headSha !== undefined ? { headSha: view.headSha } : {}),
  };
}

/** The pull request a finished coding child opened or edited (`pr_opened`), from its events. `head` is the branch the post-step paired with the push status; it stays internal to the runner's row update. */
function prOpenedOf(
  events: readonly RunEvent[] | undefined,
): { number: number; url: string; created: boolean; head?: string } | undefined {
  const last = [...(events ?? [])].reverse().find((e) => e.type === "pr_opened");
  return last && last.type === "pr_opened"
    ? {
        number: last.number,
        url: last.url,
        created: last.created,
        ...(last.head !== undefined ? { head: last.head } : {}),
      }
    : undefined;
}

/** How many times `read-record` looks at GitHub's review list for a review
 *  child whose record carries no post of its own, and the pause between looks:
 *  the list can lag a post it accepted a second ago, and the finish event that
 *  wakes the runner arrives within that second. Three looks over a few
 *  seconds cover the lag seen live; the merge step re-verifies the approval at
 *  the head regardless, so this pre-check can afford patience and the guard
 *  stays strict. */
export const REVIEW_POSTED_CHECKS = 3;
export const REVIEW_POSTED_RECHECK_MS = 2_000;

/** Whether the bot's own verdict stands on the pull request at the head the
 *  child reviewed: a review by this bot's identity, pinned to that head, whose
 *  body starts with the verdict's token. Unknown (no identity, GitHub silent)
 *  → undefined, never a guess either way. */
async function reviewPostedAt(
  deps: AdminCoordinatorDeps,
  pr: { repo: string; number: number },
  verdict: ReviewVerdictKind,
  head: string,
): Promise<boolean | undefined> {
  const [reviews, self] = await Promise.all([
    deps.fetchPrReviews(pr).catch(() => undefined),
    deps.selfIdentity().catch(() => undefined),
  ]);
  if (reviews === undefined || self === undefined) return undefined;
  const token = verdict === "approve" ? LGTM_TOKEN : CHANGES_TOKEN;
  return reviews.some(
    (r) =>
      r.author?.login === self.login &&
      (r.author.id === undefined || r.author.id === self.id) &&
      r.commitId !== undefined &&
      sameCommit(r.commitId.toLowerCase(), head) &&
      r.body.startsWith(token),
  );
}

interface PostedHumanGate {
  round: number;
  findings: Finding[];
  verdict: "approve" | "request_changes";
  answer: string;
  author: string;
  commentId: string;
}

/** GitHub timestamps lose sub-second order. Treat their whole reported second
 * as the verdict boundary so a later comment in that second is not discarded. */
const githubSecondStart = (at: number): number => Math.floor(at / SECOND_MS) * SECOND_MS;

/** Recover the title omitted by legacy verdict markers from the typed table
 * in the same immutable review body. Ambiguous or malformed rows fail closed. */
function legacyPostedFinding(value: unknown, body: string): Finding | undefined {
  if (isFindingShape(value)) return value;
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (row.title !== undefined || typeof row.id !== "string" || typeof row.severity !== "string") return undefined;
  const prefix = `| ${row.severity} | **${escapeMarkdownTableCell(row.id)}** `;
  const header = "| Severity | Finding | Where |\n| --- | --- | --- |\n";
  const tableStart = body.indexOf(header);
  if (tableStart < 0) return undefined;
  const table = body.slice(tableStart + header.length).split("\n\n", 1)[0]!;
  const titles = table
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .flatMap((line) => {
      const tail = line.slice(prefix.length);
      const boundary = tail.lastIndexOf(" | ");
      return boundary > 0 ? [unescapeMarkdownTableCell(tail.slice(0, boundary)).trim()] : [];
    })
    .filter(Boolean);
  if (titles.length !== 1) return undefined;
  const recovered = { ...row, title: titles[0] };
  return isFindingShape(recovered) ? recovered : undefined;
}

/** The typed human-gated verdict marker and the newest later comment from the
 * requester's trusted GitHub account. A legacy marker recovers its omitted
 * title from the review's typed table; a comment is never guessed to answer a
 * finding we could not recover. */
async function postedHumanGateAnswer(
  deps: AdminCoordinatorDeps,
  pr: { repo: string; number: number },
  requester: string,
  addressSeverity: AddressSeverity,
): Promise<PostedHumanGate | undefined> {
  if (deps.fetchPrComments === undefined) return undefined;
  const [reviews, comments, self] = await Promise.all([
    deps.fetchPrReviews(pr).catch(() => undefined),
    deps.fetchPrComments(pr).catch(() => undefined),
    deps.selfIdentity().catch(() => undefined),
  ]);
  if (reviews === undefined || comments === undefined || self === undefined) return undefined;
  const own = reviews
    .filter(
      (review) =>
        review.author?.login === self.login &&
        (review.author.id === undefined || review.author.id === self.id) &&
        review.submittedAt !== undefined &&
        Number.isFinite(Date.parse(review.submittedAt)),
    )
    .sort((a, b) => Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!))
    .at(-1);
  if (own === undefined) return undefined;
  // Cases and review prose can contain marker-shaped text. The renderer puts
  // its own marker after both (before an optional carried-head footer), so
  // only the last complete marker line may authorize a resumed human gate.
  const marker = [...own.body.matchAll(/^<!-- switchboard:verdict (\{[^\r\n]*\}) -->\r?$/gm)].at(-1);
  if (marker === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(marker[1]!);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const row = payload as Record<string, unknown>;
  if (row.verdict !== "approve" && row.verdict !== "request_changes") return undefined;
  if (!Array.isArray(row.findings)) return undefined;
  const postedFindings = row.findings.map((finding) => legacyPostedFinding(finding, own.body));
  if (!postedFindings.every((finding): finding is Finding => finding !== undefined)) return undefined;
  const findings = row.verdict === "approve" ? findingsAtOrAbove(postedFindings, addressSeverity) : postedFindings;
  if (findings.length === 0 || !findings.every((finding) => finding.humanGated === true)) return undefined;
  const candidates = comments
    .filter(
      (comment) =>
        comment.author.type === "User" &&
        comment.body.trim() !== "" &&
        Number.isFinite(Date.parse(comment.createdAt)) &&
        Date.parse(comment.createdAt) >= githubSecondStart(Date.parse(own.submittedAt!)),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  let answer: PullRequestComment | undefined;
  for (const candidate of candidates) {
    const authorized = await deps.commenterAuthorized(requester, candidate.author).catch(() => false);
    if (authorized) {
      answer = candidate;
      break;
    }
  }
  if (answer === undefined) return undefined;
  return {
    round: 1,
    findings,
    verdict: row.verdict,
    answer: answer.body.trim(),
    author: answer.author.login,
    commentId: String(answer.id),
  };
}

/** `reviewPostedAt`, asked up to `REVIEW_POSTED_CHECKS` times a pause apart
 *  until it answers true: a review posted a second ago may not be in GitHub's
 *  list yet, and a silent GitHub may answer on the next look. The last look's
 *  answer stands — false when every look found nothing, undefined when every
 *  look was silent. */
async function reviewPostedAtPatiently(
  deps: AdminCoordinatorDeps,
  pr: { repo: string; number: number },
  verdict: ReviewVerdictKind,
  head: string,
): Promise<boolean | undefined> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let answer: boolean | undefined;
  for (let look = 1; look <= REVIEW_POSTED_CHECKS; look++) {
    answer = await reviewPostedAt(deps, pr, verdict, head);
    if (answer === true || look === REVIEW_POSTED_CHECKS) break;
    await sleep(REVIEW_POSTED_RECHECK_MS);
  }
  return answer;
}

/** What the child's own record says about its post (agent-review.md item 18),
 *  for the unit's pull request: `true` when it posted this verdict at the
 *  reviewed head to that pull request, `false` with the reason when it recorded
 *  a skip or a failure, and nothing when the record is silent (a child from
 *  before the fact existed) or names another head, verdict or pull request —
 *  then GitHub decides. */
function reviewPostedByRecord(
  record: Pick<RunView, "reviewPost" | "reviewHead" | "verdict">,
  pr: { repo: string; number: number },
): { reviewPosted: boolean; reviewPostReason?: string } | undefined {
  const post = record.reviewPost;
  if (post === undefined || record.reviewHead === undefined || record.verdict === undefined) return undefined;
  if (!post.posted) return { reviewPosted: false, reviewPostReason: post.reason };
  const same =
    post.target.repo === pr.repo &&
    post.target.number === pr.number &&
    sameCommit(post.head.toLowerCase(), record.reviewHead) &&
    post.verdict === record.verdict.verdict;
  return same ? { reviewPosted: true } : undefined;
}

function headBranchStateUnknown(facts: PullRequestFacts): boolean {
  return facts.state === "open" && facts.headBranchExists === undefined;
}

function headBranchStateError(repo: string, number: number): string {
  return `could not verify whether ${repo}#${number}'s head branch exists`;
}

function pullRequestState(
  number: number,
  fallbackUrl: string,
  facts: PullRequestFacts,
): Record<string, unknown> | undefined {
  if (headBranchStateUnknown(facts)) return undefined;
  const url = facts.htmlUrl ?? fallbackUrl;
  if (facts.mergedAt !== undefined && facts.mergeCommitSha !== undefined)
    return {
      state: "merged",
      prNumber: number,
      url,
      ...(facts.headSha !== undefined ? { headSha: facts.headSha } : {}),
      sha: facts.mergeCommitSha,
      mergedAt: facts.mergedAt,
      ...(facts.mergedBy !== undefined ? { mergedBy: facts.mergedBy } : {}),
    };
  if (facts.state === "closed")
    return { state: "closed", prNumber: number, url, closedBy: facts.closedBy ?? "unknown GitHub user" };
  return {
    state: "open",
    prNumber: number,
    url,
    ...(facts.headSha !== undefined ? { headSha: facts.headSha } : {}),
    ...(facts.headBranchExists !== undefined ? { headBranchExists: facts.headBranchExists } : {}),
  };
}

async function childPullRequestState(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance | null | undefined,
  unit: string | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (instance == null || unit === undefined) return undefined;
  const row = (await deps.instances.listUnits(instance.id)).find((candidate) => candidate.unit === unit);
  if (row?.pr === undefined) return undefined;
  const facts = await deps.fetchPrFacts({ repo: instance.repo, number: row.pr.number });
  if (facts === undefined) throw new Error(`could not read ${instance.repo}#${row.pr.number}`);
  const state = pullRequestState(row.pr.number, row.pr.url, facts);
  if (state === undefined) throw new Error(headBranchStateError(instance.repo, row.pr.number));
  return state;
}

/** A re-issued plan's later runner may finish reading a child the earlier
 * attempt spawned. The lineage is admitted only where both durable instance
 * rows prove the same plan, repository and unit, with the caller on the latest
 * attempt; every other mismatch keeps the opaque read mask. */
async function isEarlierAttemptRun(
  deps: AdminCoordinatorDeps,
  current: CoordinatorInstance | null,
  view: RunView,
  unit: string | undefined,
): Promise<boolean> {
  if (current?.plan === undefined || view.parentInstanceId === undefined || unit === undefined) return false;
  if (unitOfIdempotencyKey(view.idempotencyKey ?? "") !== unit) return false;
  const prior = await deps.instances.get(view.parentInstanceId);
  if (prior?.plan === undefined) return false;
  const currentAttempt = current.attempt ?? 1;
  const priorAttempt = prior.attempt ?? 1;
  if (
    currentAttempt <= priorAttempt ||
    current.plan.id !== prior.plan.id ||
    current.plan.path !== prior.plan.path ||
    current.repo !== prior.repo
  )
    return false;
  const [nextAttempt, currentUnits, priorUnits] = await Promise.all([
    deps.instances.get(planInstanceId(current.plan.id, currentAttempt + 1)),
    deps.instances.listUnits(current.id),
    deps.instances.listUnits(prior.id),
  ]);
  if (nextAttempt !== null) return false;
  const currentUnit = currentUnits.find((row) => row.unit === unit);
  const priorUnit = priorUnits.find((row) => row.unit === unit);
  return currentUnit !== undefined && priorUnit !== undefined && currentUnit.branch === priorUnit.branch;
}

async function readRecord(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.runId !== "string" || !RUN_ID_PATTERN.test(body.runId))
    return json(400, { ok: false, error: "runId must be a run id" });
  if (body.unit !== undefined && (typeof body.unit !== "string" || !UNIT_ID.test(body.unit)))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const at = (deps.clock ?? systemClock)();
  // A run outside the instance is `not_found`, byte-identical to a missing one
  // (authorization.md: a denied read reveals nothing). The only moved identity
  // admitted is an earlier attempt of this same plan and unit, proven from both
  // durable instance rows rather than from caller-supplied ids alone.
  const [res, instanceRow] = await Promise.all([
    deps.runs.getRun(body.runId, { privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ }),
    deps.instances.get(id.value),
  ]);
  if (!res.ok) return json(404, { ok: false, error: "not_found" });
  const view = res.value;
  if (
    view.parentInstanceId !== id.value &&
    !(await isEarlierAttemptRun(deps, instanceRow, view, typeof body.unit === "string" ? body.unit : undefined))
  )
    return json(404, { ok: false, error: "not_found" });
  let pullRequest: Record<string, unknown> | undefined;
  try {
    pullRequest = await childPullRequestState(deps, instanceRow, typeof body.unit === "string" ? body.unit : undefined);
  } catch (err) {
    return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
  }
  if (!view.finished)
    return json(200, {
      ok: true,
      run: coordinatorRunView(view, id.value, undefined),
      ...(pullRequest !== undefined ? { pullRequest } : {}),
      at,
    });
  // Finished: the final reply and the typed artifacts the record carries — the
  // coding child's pull request, the review child's verdict and whether it
  // stands on the pull request, the coding run's dispositions.
  const full = await deps.runs
    .getRun(body.runId, {
      include: "messages",
      requireFinalRecord: true,
      privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
    })
    .catch(() => undefined);
  if (full === undefined) return json(503, { ok: false, error: "record_unavailable", at });
  if (!full.ok) return json(409, { ok: false, error: "record_pending", at });
  const record = full.value;
  // A Git report may have been accepted upstream after our receive-pack
  // request became uncertain. Neither an absent pushed[] receipt nor the
  // child's completed status proves the original PR head stayed put.
  if (record.doorPublicationPending !== undefined)
    return json(409, { ok: false, error: "door_publication_unresolved", at });
  const finalReply = finalReplyOf(record.events);
  const reviewAskedAt = reviewAskedAtOf(record.events);
  const description = record.events?.some((event) => event.type === "pr_description") === true;
  const opened = prOpenedOf(record.events);
  const pr = opened !== undefined ? { number: opened.number, url: opened.url, created: opened.created } : undefined;
  // The hard stop's mark (record 0060; issue 1924): a finished child's unit
  // ends stopped on it, whatever the child's own status.
  // The post-step's PR head is accepted as the pipeline ref only when the run's
  // own push record names that same ref. `RunRecord.pushed` is folded from the
  // push-status block, so a stale resident binding can no longer leave the row
  // naming one attempt while the pull request heads another.
  let coordinatorUnit: CoordinatorUnit | undefined;
  if (instanceRow !== null && typeof body.unit === "string") {
    coordinatorUnit = (await deps.instances.listUnits(instanceRow.id)).find((u) => u.unit === body.unit);
    const pushedPrRef =
      opened?.head !== undefined && record.pushed?.some((pushed) => pushed.ref === opened.head)
        ? opened.head
        : undefined;
    if (coordinatorUnit !== undefined && pushedPrRef !== undefined && coordinatorUnit.branch !== pushedPrRef) {
      coordinatorUnit = { ...coordinatorUnit, branch: pushedPrRef };
      await deps.instances.putUnits([coordinatorUnit]);
    }
  }
  // An interrupted child that restarted from its request (issue 1903: a
  // replaced container's child resumes by itself) is not the round's end: the
  // successor — a run of the same instance and idempotency key in the same
  // thread — is answered as the child still running, and the machine keeps the
  // wait on it instead of ending the unit over a resume that succeeded.
  if (view.status === "interrupted") {
    const successor = await restartedChildOf(deps, id.value, view).catch(() => undefined);
    if (successor !== undefined)
      return json(200, {
        ok: true,
        ...(instanceRow?.stop !== undefined ? { stopped: true } : {}),
        run: { id: successor, finished: false },
        ...(pullRequest !== undefined ? { pullRequest } : {}),
        restartedAs: successor,
        at,
      });
    // The ending itself says a restart follows (`RunRecord.restarting`, record
    // 0064; run-history item 47a): before its persisted claim deadline the
    // reattach path may still be dispatching the run under the same id, so the
    // child reads as running. At the deadline the close becomes the run's real
    // interrupted ending when no successor exists. A legacy restarting record
    // has no deadline and keeps the old compatibility behavior.
    if (view.restarting === true && (view.restartUntil === undefined || at < view.restartUntil))
      return json(200, {
        ok: true,
        ...(instanceRow?.stop !== undefined ? { stopped: true } : {}),
        run: { id: view.id, finished: false },
        ...(pullRequest !== undefined ? { pullRequest } : {}),
        at,
      });
  }
  // Whether the verdict stands on the unit's pull request: the child's own
  // record of its post first (item 18) — it posted, or it recorded why not —
  // and GitHub only when the record is silent, looked at patiently: the
  // finish event wakes the runner within a second of the post, and GitHub's
  // review list can lag it. The merge step re-verifies the approval at the
  // head regardless, so the pre-check may be patient while the guard stays strict.
  let posted: { reviewPosted: boolean; reviewPostReason?: string } | undefined;
  if (record.verdict !== undefined && record.reviewHead !== undefined && typeof body.unit === "string") {
    const instance = instanceRow;
    if (instance && coordinatorUnit?.pr !== undefined) {
      const unitPr = { repo: instance.repo, number: coordinatorUnit.pr.number };
      posted = reviewPostedByRecord(record, unitPr);
      if (posted === undefined) {
        const seen = await reviewPostedAtPatiently(deps, unitPr, record.verdict.verdict, record.reviewHead);
        if (seen !== undefined) posted = { reviewPosted: seen };
      }
    }
  }
  return json(200, {
    ok: true,
    ...(instanceRow?.stop !== undefined ? { stopped: true } : {}),
    ...(pullRequest !== undefined ? { pullRequest } : {}),
    run: {
      ...coordinatorRunView(view, id.value, finalReply),
      ...(pr !== undefined ? { pr } : {}),
      ...(record.verdict !== undefined ? { verdict: record.verdict } : {}),
      ...(record.reviewHead !== undefined ? { reviewHead: record.reviewHead } : {}),
      ...(reviewAskedAt !== undefined ? { reviewAskedAt } : {}),
      ...(posted !== undefined ? { reviewPosted: posted.reviewPosted } : {}),
      ...(posted?.reviewPostReason !== undefined ? { reviewPostReason: posted.reviewPostReason } : {}),
      ...(record.dispositions !== undefined ? { dispositions: record.dispositions } : {}),
      // Findings readiness requires the typed description output. Its event is
      // durable on the child record, so the runner can verify it without
      // trusting final-reply prose.
      ...(description ? { description: true } : {}),
      ...(record.handoff !== undefined ? { handoff: true } : {}),
      // The renewal's facts (decision 0046): progress is read off these.
      ...(record.pushed !== undefined ? { pushed: record.pushed } : {}),
      ...(record.publicationSettlement !== undefined ? { publicationSettlement: record.publicationSettlement } : {}),
      ...(record.lease !== undefined ? { leaseStartedAt: record.lease.startedAt } : {}),
      // What the child cost, as the runs service prices it (costs.md item 4c):
      // null when unknown — no usage on the record, or a model without a price
      // — so a capped grant never renews on an understated total.
      costUsd: record.cost?.usd ?? null,
      ...(record.handoff !== undefined ? { handoffLists: record.handoff } : {}),
      // The failure by name (run-history item 57): a retryable model-call
      // failure lets the machine re-run a round-0 child that pushed nothing.
      ...(record.failure !== undefined ? { failure: record.failure } : {}),
      // What ended an interrupted child (issue 1876), off its record's own
      // events: the unit's ending names the actual cause in the user's nouns.
      ...(view.status === "interrupted" ? interruptionOf(record.events) : {}),
    },
    at,
  });
}

/** The interruption's cause off the record's own events (issue 1876): the last
 *  words the roll wrote — a `child_interrupted` reason, a resume or
 *  sandbox-roll note — classified by `interruptionCauseOfWords`; none when the
 *  record names none, so the ending's sentence never guesses. */
function interruptionOf(events: readonly RunEvent[] | undefined): { interruption: InterruptionCause } | object {
  if (events === undefined) return {};
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const words =
      e.type === "child_interrupted"
        ? e.reason
        : e.type === "run_note" &&
            (e.kind === "resumed" || e.kind === "sandbox_restarted" || e.kind === "harness_error")
          ? e.summary
          : undefined;
    if (words === undefined) continue;
    const cause = interruptionCauseOfWords(words);
    if (cause !== undefined) return { interruption: cause };
  }
  return {};
}

/** The run an interrupted child restarted as (run-history item 54; issue
 *  1903): the newest run of the same instance and idempotency key in the same
 *  thread that is not the closed run itself — the restart's dispatch carried
 *  the coordinator tag forward. None for a child without a key or thread, or
 *  when nothing restarted it. */
async function restartedChildOf(
  deps: AdminCoordinatorDeps,
  instanceId: string,
  view: RunView,
): Promise<string | undefined> {
  if (view.threadKey === undefined || view.idempotencyKey === undefined) return undefined;
  // The route is already instance-scoped (the run named must belong to the
  // instance), so the listing reads everything and filters on the tag.
  const listing = await deps.runs.listRuns({
    privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
    status: "all",
    visibleTo: { kind: "all" },
    threadKey: view.threadKey,
    limit: RUN_LIST_MAX_LIMIT,
  });
  const successor = listing.runs.find(
    (r) =>
      r.id !== view.id &&
      r.parentInstanceId === instanceId &&
      r.idempotencyKey === view.idempotencyKey &&
      r.startedAt >= view.startedAt,
  );
  return successor?.id;
}

/** Why a recover pr-check opened nothing: GitHub refused the create because
 *  nothing sits between the base and the head (`no_commits`), or the instance
 *  names no base to open against and no create was tried (`no_base`). Any
 *  other GitHub failure is not a reason but an outage: it propagates, the
 *  check answers `github_unavailable`, and the step is asked again. */
type Unrecovered = "no_commits" | "no_base";
type Recovered = { kind: "opened"; pr: OpenedPullRequest } | { kind: "none"; why: Unrecovered };

/** GitHub's refusal of a pull request over an empty branch: HTTP 422 with
 *  "No commits between <base> and <head>". Everything else that fails the
 *  create is treated as GitHub being unavailable. */
function isEmptyBranchRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /HTTP 422\b/.test(message) && /no commits between/i.test(message);
}

/** The last line with the cap: over `max`, cut at the last word boundary that
 *  fits, never mid-word, and drop what a cut leaves dangling (a period the
 *  title gate refuses, a comma, a dash). A single over-long word past the
 *  `after` index (the description's start — cutting into the `type(scope): `
 *  prefix would leave no title at all) is hard-cut at the cap. */
function cutAtWordBoundary(line: string, max: number, after: number): string {
  const tidy = (s: string) => s.replace(/[\s.,;:—–-]+$/u, "");
  if (line.length <= max) return tidy(line);
  const head = line.slice(0, max + 1);
  const space = head.lastIndexOf(" ");
  return tidy(space > after ? head.slice(0, space) : line.slice(0, max));
}

/** The recovered pull request's fallback title (issue 1877), when the dead
 *  coding child's record holds no submitted description: never the unit
 *  heading verbatim — `U<n>: <unit title>` fails the required `title` check and
 *  costs a fix round on a title, not on code. A unit title that already reads
 *  as a conventional line the gate accepts is kept; otherwise the line is
 *  `<type>[(<area>)]: <unit title>` — the type the title's own leading word
 *  when the release config knows it, else `chore`; the scope the plan's area,
 *  the first plan-id segment naming a code-map scope (never a bot's), omitted
 *  when none does (the gate allows an unscoped line) — the whole line cut to
 *  the 72-character cap at a word boundary. */
export function recoveredFallbackTitle(
  row: { unit: string; title?: string } | undefined,
  branch: string,
  planId: string | undefined,
): string {
  const raw = (row?.title ?? `${row?.unit ?? "the unit"} — ${branch}`).trim();
  if (checkPrTitle(raw, PR_TITLE_VOCABULARY).ok) return raw;
  const words = raw.split(/\s+/u);
  const first = (words[0] ?? "").toLowerCase().replace(/:$/u, "");
  const type = PR_TITLE_VOCABULARY.types.includes(first) ? first : "chore";
  const rest = (type === first ? words.slice(1) : words).join(" ");
  const area = planId?.split("-").find((seg) => PR_TITLE_VOCABULARY.scopes.includes(seg) && !BOT_SCOPES.includes(seg));
  const prefix = `${type}${area !== undefined ? `(${area})` : ""}: `;
  return cutAtWordBoundary(`${prefix}${rest === "" ? branch : rest}`, TITLE_MAX_LENGTH, prefix.length);
}

/** The recover path's pull request (agent-ship items 10 and 15): a coding
 *  child pushed its branch and then died — the pull request is opened from the
 *  branch itself through the same open-or-edit as any run's, the title from
 *  the child's submitted description when the record holds one (used as is —
 *  the submit tool's gate already judged it), else the head commit's subject
 *  when it passes the title rule (record 0064's `unit_title` move), else the
 *  unit's title as the conventional fallback above (issue 1877); the body from
 *  the description,
 *  else a minimal body naming the unit. `none` names why when nothing could be
 *  opened; a GitHub failure that is neither reason is thrown for the caller's
 *  `github_unavailable`. */
async function recoverPushedBranch(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  row: CoordinatorUnit | undefined,
  branch: string,
  runId: string,
): Promise<Recovered> {
  if (instance.base === undefined) return { kind: "none", why: "no_base" };
  const unitName = row?.unit ?? "the unit";
  let title: string | undefined;
  let prBody = `Opened by the plan runner from the pushed branch \`${branch}\`: the coding run ${runId} of ${unitName} ended before it could open the pull request or submit its description. The review round asks for the description.`;
  try {
    const full = await deps.runs.getRun(runId, {
      include: "messages",
      privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
    });
    if (full.ok && full.value.parentInstanceId === instance.id) {
      const events = full.value.events ?? [];
      const descEvent = [...events].reverse().find((e) => e.type === "pr_description");
      const desc = descEvent?.type === "pr_description" ? descEvent.description : undefined;
      if (desc !== undefined) {
        title = desc.title;
        // A record written under the previous contract carries the why as
        // `whatWhy`; a body with neither gets no second paragraph, never "undefined".
        const why = desc.why ?? (desc as { whatWhy?: string }).whatWhy;
        prBody = [
          desc.tldr,
          why,
          "_Rendered by the plan runner from the coding run's submitted description; the run ended before it could open the pull request itself._",
        ]
          .filter((part) => part !== undefined && part !== "")
          .join("\n\n");
      }
    }
  } catch {
    // the minimal body stands
  }
  // No submitted description: the head commit's subject when it passes the
  // title rule (record 0064's `unit_title` move — the open passes the required
  // check first time), else the conventional fallback from the unit's title
  // (issue 1877). An unreadable subject claims nothing and the fallback stands.
  if (title === undefined && deps.branchHeadSubject !== undefined) {
    const subject = await deps.branchHeadSubject(instance.repo, branch).catch(() => undefined);
    if (subject !== undefined && checkPrTitle(subject, PR_TITLE_VOCABULARY).ok) title = subject;
  }
  title ??= recoveredFallbackTitle(row, branch, instance.plan?.id ?? parsePlanBranch(branch)?.planId);
  // Recovery has no normal coding post-step, but the durable instance still
  // owns the requester and the original thread even when its child is gone.
  const header = requestedByLine({
    name: instance.userName?.trim() || instance.userId,
    threadUrl: threadPageLink(instance.threadKey, deps.runPageBase?.replace(/\/runs\/?$/, "") ?? ""),
  });
  prBody = `${header}\n\n${prBody}`;
  // The identity rewrite before the open (record 0062): the recover path
  // opens over the same guarantee the coding post-step gives — the commits
  // carry only the allowed identities. Unreadable is thrown for the caller's
  // `github_unavailable`, never an open over unverified identities.
  if (deps.rewriteIdentities !== undefined) {
    const rewritten = await deps.rewriteIdentities({
      repo: instance.repo,
      base: instance.base,
      branch,
      startState: EMPTY_START_STATE,
      requester: instance.userId,
    });
    if (rewritten.kind === "unreadable")
      throw new Error(`the identity rewrite could not verify ${branch}: ${rewritten.reason}`);
  }
  try {
    const pr = await deps.openPullRequest({
      repo: instance.repo,
      headBranch: branch,
      base: instance.base,
      title,
      body: prBody,
    });
    return { kind: "opened", pr };
  } catch (err) {
    // Nothing to recover only when GitHub says the branch is empty; any other
    // failure is an outage the caller reports, never a claim that nothing was pushed.
    if (isEmptyBranchRefusal(err)) return { kind: "none", why: "no_commits" };
    throw err;
  }
}

const CHILD_SUPERSESSION_REASONS = new Set(["merged", "closed", "head_moved", "branch_deleted"]);

async function steerChild(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.runId !== "string" || !RUN_ID_PATTERN.test(body.runId))
    return json(400, { ok: false, error: "runId must be a run id" });
  if (typeof body.reason !== "string" || !CHILD_SUPERSESSION_REASONS.has(body.reason))
    return json(400, { ok: false, error: "reason must name a pull request transition" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (instance === null) return json(404, { ok: false, error: "unknown_instance", at });
  const child = await deps.runs.getRun(body.runId, { privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ });
  if (!child.ok || child.value.parentInstanceId !== instance.id)
    return json(404, { ok: false, error: "not_found", at });
  const reason =
    body.reason === "merged"
      ? "The pull request merged while this run was live."
      : body.reason === "closed"
        ? "The pull request closed while this run was live."
        : body.reason === "head_moved"
          ? "The pull request moved to another head while this review was live."
          : "The pull request's head branch was deleted while this run was live.";
  const text = `${reason} End now without a push or a review post. Record what already happened in the run's final reply.`;
  const steered = (await deps.steerChild?.(body.runId, text, instance)) ?? false;
  return json(200, { ok: true, outcome: steered ? "steered" : "not_live", at });
}

type PublicationBindingRefusalReason =
  | "publication_facts_mismatch"
  | "publication_ownership_changed"
  | "publication_ownership_unknown"
  | "publication_binding_stale"
  | "publication_rollback_failed"
  | "publication_store_unavailable";

class PublicationBindingRefusal extends Error {
  constructor(readonly reason: PublicationBindingRefusalReason) {
    super(reason);
  }
}

const samePublicationOwner = (
  left: { instanceId: string; unit: string } | undefined,
  right: { instanceId: string; unit: string },
) => left?.instanceId === right.instanceId && left.unit === right.unit;

/** Bindings cross independent serializers; property insertion order is not authority. */
const samePublicationBinding = (
  left: ExistingPrPublicationBinding | undefined,
  right: ExistingPrPublicationBinding,
): boolean =>
  left !== undefined &&
  left.repo === right.repo &&
  left.pr === right.pr &&
  left.headRef === right.headRef &&
  left.baseRef === right.baseRef &&
  left.expectedHeadSha === right.expectedHeadSha &&
  left.publicationRef === right.publicationRef &&
  samePublicationOwner(left.owner, right.owner);

/** Replay the durable wake chain, not a child's claimed /rN. Each same-segment
 * lease answer opens exactly one resume; gaps or two answers for one idle
 * cannot authorize a current publication step. This reconstructs identity,
 * never a missing lease start or additional recovery budget. */
function publicationStepPrefix(row: CoordinatorUnit): string {
  const segment = row.segments?.reduce((latest, entry) => Math.max(latest, entry.index), 1) ?? 1;
  if ((row.segments?.filter((entry) => entry.index === segment).length ?? 0) > 1)
    throw new PublicationBindingRefusal("publication_facts_mismatch");
  const base = stepPrefixOf(row.unit, segment > 1 ? { segment, renewalsSpent: 0, spendUsd: null } : undefined);
  const resumes = Object.entries(row.wakes ?? {}).filter(
    ([, answer]) => answer.kind === "segment" && answer.index === segment && answer.leaseMs !== undefined,
  );
  let prefix = base;
  for (let attempt = 1; attempt <= resumes.length; attempt += 1) {
    const idlePrefix = `${prefix}/idle/`;
    const answers = resumes.filter(
      ([key]) => key.startsWith(idlePrefix) && /^[1-9][0-9]*$/.test(key.slice(idlePrefix.length)),
    );
    if (answers.length !== 1) throw new PublicationBindingRefusal("publication_facts_mismatch");
    prefix = `${base}/r${attempt}`;
  }
  return prefix;
}

/** Missing projections are repairable only from a complete, priced durable
 * child. No remote observation or post-step prose can replace the tool pair.
 * Also read earlier failed attempts: their missing projection is not proof
 * that they did not push. The caller owns fresh facts and the ownership CAS. */
async function reconcileMissingFindingsPush(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  runId: string,
  head: string,
  siblings: RunView[],
  after: number,
): Promise<boolean> {
  const binding = row.publication;
  if (binding === undefined) return false;
  const read = await deps.runs.getRun(runId, {
    include: "messages",
    privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
  });
  if (!read.ok) return false;
  const run = read.value;
  const complete = (r: typeof run) => {
    const models = Object.values(r.usage?.byModel ?? {});
    return (
      r.finished &&
      r.persisted === true &&
      !r.provisional &&
      !r.restarting &&
      r.truncated === false &&
      r.events !== undefined &&
      r.eventCount === r.events.length &&
      r.storedEventCount === r.events.length &&
      r.events.every(
        (e) =>
          e.type !== "tool_call" ||
          e.tool !== "bash" ||
          (e.command !== undefined && e.command.length < COMMAND_CAP && !e.command.includes("…")),
      ) &&
      !r.events.some((e) => (e.type === "tool_result" && e.cut) || e.type === "pushed_head") &&
      models.length > 0 &&
      models.every((m) => typeof m.usd === "number" && Number.isFinite(m.usd) && m.usd >= 0)
    );
  };
  const tags = run.events?.filter((e) => e.type === "coordinator_tag") ?? [];
  const tag = tags.length === 1 ? tags[0] : undefined;
  if (
    !complete(run) ||
    run.status !== "completed" ||
    (run.pushed?.length ?? 0) !== 0 ||
    run.headSha !== head ||
    run.parentInstanceId !== instance.id ||
    run.userId !== instance.userId ||
    run.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
    run.threadKey !== (row.threadKey ?? instance.threadKey) ||
    run.agent !== "coding" ||
    run.startedAt < after ||
    run.finishedAt === undefined ||
    run.finishedAt < run.startedAt ||
    tag?.parentInstanceId !== instance.id ||
    tag.unit !== row.unit ||
    tag.base !== instance.base ||
    !samePublicationBinding(tag.publication, binding) ||
    (run.pr !== undefined &&
      (run.pr.number !== binding.pr || (run.pr.head !== undefined && run.pr.head !== row.branch))) ||
    pairedPublicationPush(run.events!, binding, head, undefined, deps.gitDoorBaseUrl) === undefined
  )
    return false;
  for (const sibling of siblings.filter(
    (r) => r.id !== runId && r.agent === "coding" && (r.finishedAt === undefined || r.finishedAt >= after),
  )) {
    if (
      !sibling.finished ||
      (sibling.status !== "failed" && sibling.status !== "interrupted") ||
      sibling.parentInstanceId !== instance.id ||
      sibling.userId !== instance.userId ||
      sibling.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
      sibling.threadKey !== run.threadKey ||
      sibling.startedAt < after ||
      sibling.finishedAt === undefined ||
      sibling.finishedAt > run.startedAt ||
      (sibling.pushed?.length ?? 0) > 0
    )
      return false;
    const prior = await deps.runs.getRun(sibling.id, {
      include: "messages",
      privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
    });
    if (
      !prior.ok ||
      !complete(prior.value) ||
      prior.value.events!.some(
        (e) =>
          e.type === "pushed_head" ||
          (e.type === "tool_call" && e.tool === "bash" && mentionsGitPush(e.command ?? e.summary)),
      )
    )
      return false;
  }
  // Evidence reads may take time. Recheck the ref after them, immediately
  // before the caller reserves ownership and compares the original row.
  const fresh = await deps.fetchPrFacts({ repo: instance.repo, number: binding.pr }).catch(() => undefined);
  return (
    fresh?.state === "open" &&
    fresh.sameRepoHead === true &&
    fresh.headBranchExists === true &&
    fresh.headRef === binding.headRef &&
    fresh.baseRef === binding.baseRef &&
    fresh.headSha === head &&
    fresh.verifiedHead?.repo.toLowerCase() === instance.repo.toLowerCase() &&
    fresh.verifiedHead.ref === binding.publicationRef &&
    fresh.verifiedHead.sha === head
  );
}

/** The machine can start findings after a changes request, failed checks
 * following a same-round approval, a gated approval or a merge-queue removal.
 * A bare approval or an orphan checks note cannot authorize a publication. */
function findingsRoundAuthorized(
  row: CoordinatorUnit,
  review: CoordinatorUnit["rounds"][number],
  childStartedAt: number,
): boolean {
  if (childStartedAt < review.at) return false;
  if (review.outcome === "request_changes") return true;
  if (review.outcome === "checks_failed") {
    const preceding = row.rounds
      .slice(0, row.rounds.lastIndexOf(review))
      .reverse()
      // Ordinary round writes can replay after a lost response. Ignore only
      // same-round check notes; a different review boundary must still block.
      .find(
        (note) =>
          note.agent === "review" &&
          !(note.index === review.index && (note.outcome === "checks_restarted" || note.outcome === "checks_failed")),
      );
    return preceding?.index === review.index && preceding.outcome === "approve" && preceding.at <= review.at;
  }
  return (
    review.outcome === "approve" &&
    ((review.gate?.findings.length ?? 0) > 0 ||
      row.rounds.some(
        (round) =>
          round.agent === "coding" &&
          round.outcome === "dequeued" &&
          round.index === review.index &&
          round.at >= review.at &&
          round.at <= childStartedAt,
      ))
  );
}

/** Advance a publication binding only to the exact head recorded by its completed
 * authorized findings child. An unrelated force-push can never rewrite the durable
 * publication binding merely because the branch currently points there. */
async function advanceFindingsPublication(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  facts: PullRequestFacts,
  runId: string,
): Promise<CoordinatorUnit> {
  if (row.publication === undefined || facts.headSha === row.publication.expectedHeadSha) return row;
  const child = await deps.runs.getRun(runId, {
    include: "messages",
    privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
  });
  const owner = { instanceId: instance.id, unit: row.unit };
  const latestReview = [...row.rounds].reverse().find((round) => round.agent === "review");
  const prefix = row.recovery !== undefined ? `${row.unit}/recovery` : publicationStepPrefix(row);
  const findingsPrefix = `${instance.id}:${prefix}/${latestReview?.index}/findings`;
  let reconciledPush = false;
  // Ordinary findings must carry the exact authority used at dispatch, not
  // merely a receipt for whatever head happens to be on the remote now.
  if (row.recovery === undefined) {
    const tags = child.ok ? (child.value.events?.filter((event) => event.type === "coordinator_tag") ?? []) : [];
    const tag = tags.length === 1 ? tags[0] : undefined;
    if (
      row.ending !== undefined ||
      row.idle !== undefined ||
      latestReview === undefined ||
      !child.ok ||
      !findingsRoundAuthorized(row, latestReview, child.value.startedAt) ||
      tag?.parentInstanceId !== instance.id ||
      tag.unit !== row.unit ||
      tag.base !== instance.base ||
      !samePublicationBinding(tag.publication, row.publication)
    )
      throw new PublicationBindingRefusal("publication_facts_mismatch");
    const listing = await deps.runs.listRuns({
      privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
      status: "all",
      visibleTo: EVERY_RUN,
      threadKey: row.threadKey ?? instance.threadKey,
      limit: RUN_LIST_MAX_LIMIT,
    });
    const attempts = listing.runs.filter(
      (run) => run.parentInstanceId === instance.id && isStepAttempt(run.idempotencyKey, findingsPrefix),
    );
    // A failed attempt without a push is not a second publication. Only an
    // earlier, finished, same-author attempt may be disregarded: a second
    // success, any push, overlap, or live child keeps the evidence ambiguous.
    if (
      listing.storeUnavailable ||
      listing.ledgerUnavailable ||
      listing.nextBefore !== undefined ||
      attempts.filter((run) => run.id === runId).length !== 1 ||
      attempts.some(
        (run) =>
          run.id !== runId &&
          !(
            run.finished &&
            (run.status === "failed" || run.status === "interrupted") &&
            run.agent === "coding" &&
            run.userId === instance.userId &&
            run.repo?.toLowerCase() === instance.repo.toLowerCase() &&
            run.threadKey === (row.threadKey ?? instance.threadKey) &&
            run.startedAt >= latestReview.at &&
            run.finishedAt !== undefined &&
            run.finishedAt >= run.startedAt &&
            run.finishedAt <= child.value.startedAt &&
            (run.pushed?.length ?? 0) === 0
          ),
      )
    )
      throw new PublicationBindingRefusal("publication_facts_mismatch");
    if (child.ok && (child.value.pushed?.length ?? 0) === 0 && fullHead(facts.headSha))
      reconciledPush = await reconcileMissingFindingsPush(
        deps,
        instance,
        row,
        runId,
        facts.headSha,
        listing.runs,
        latestReview.at,
      );
  }
  if (
    !child.ok ||
    child.value.finished !== true ||
    child.value.status !== "completed" ||
    child.value.agent !== "coding" ||
    child.value.parentInstanceId !== instance.id ||
    child.value.userId !== instance.userId ||
    child.value.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
    child.value.threadKey !== (row.threadKey ?? instance.threadKey) ||
    (row.recovery !== undefined
      ? child.value.idempotencyKey?.startsWith(`${instance.id}:${row.unit}/recovery/`) !== true ||
        !/\/findings(?:\/a[1-9][0-9]*)?$/.test(child.value.idempotencyKey ?? "")
      : !isStepAttempt(child.value.idempotencyKey, findingsPrefix)) ||
    !fullHead(facts.headSha) ||
    child.value.headSha !== facts.headSha ||
    (!reconciledPush &&
      child.value.pushed?.some((push) => push.ref === row.branch && push.sha === facts.headSha) !== true) ||
    facts.state !== "open" ||
    facts.sameRepoHead !== true ||
    facts.headBranchExists !== true ||
    facts.headRef !== row.publication.headRef ||
    facts.baseRef !== row.publication.baseRef ||
    facts.verifiedHead?.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    facts.verifiedHead.ref !== row.publication.publicationRef ||
    facts.verifiedHead.sha !== facts.headSha ||
    row.publication.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    row.publication.pr !== row.pr?.number ||
    row.publication.baseRef !== instance.base ||
    row.publication.headRef !== row.branch ||
    row.publication.publicationRef !== row.branch ||
    !samePublicationOwner(row.publication.owner, owner)
  )
    throw new PublicationBindingRefusal("publication_facts_mismatch");
  // Child evidence can take longer to read than the ref remains at that head.
  // Never credit a push against an initial PR snapshot that has since moved.
  const fresh = await deps.fetchPrFacts({ repo: instance.repo, number: row.publication.pr }).catch(() => undefined);
  if (
    fresh?.state !== "open" ||
    fresh.sameRepoHead !== true ||
    fresh.headBranchExists !== true ||
    fresh.headRef !== row.publication.headRef ||
    fresh.baseRef !== row.publication.baseRef ||
    fresh.headSha !== facts.headSha ||
    fresh.verifiedHead?.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    fresh.verifiedHead.ref !== row.publication.publicationRef ||
    fresh.verifiedHead.sha !== facts.headSha
  )
    throw new PublicationBindingRefusal("publication_facts_mismatch");
  try {
    if (row.recovery !== undefined && deps.runnerOwnership?.claim(instance.repo, row.publication.pr, owner) !== true)
      throw new PublicationBindingRefusal("publication_ownership_changed");
    if (!samePublicationOwner(deps.runnerOwnership?.owner(instance.repo, row.publication.pr), owner))
      throw new PublicationBindingRefusal("publication_ownership_changed");
  } catch (err) {
    if (err instanceof PublicationBindingRefusal) throw err;
    throw new PublicationBindingRefusal("publication_ownership_unknown");
  }
  const updated: CoordinatorUnit = {
    ...row,
    lastPush: facts.headSha,
    publication: { ...row.publication, expectedHeadSha: facts.headSha },
    ...(row.recovery !== undefined
      ? { recovery: { ...row.recovery, previousBinding: undefined, expectedHeadSha: facts.headSha } }
      : {}),
  };
  let replaced: Awaited<ReturnType<CoordinatorInstanceStore["compareAndReplaceUnit"]>> | undefined;
  try {
    replaced = await deps.instances.compareAndReplaceUnit(row, updated);
  } catch {
    const reread = await deps.instances.listUnits(instance.id).catch(() => undefined);
    const current = reread?.filter((candidate) => candidate.unit === row.unit);
    if (current?.length === 1 && JSON.stringify(current[0]) === JSON.stringify(updated)) replaced = { ok: true };
  }
  if (replaced?.ok !== true)
    throw new PublicationBindingRefusal(
      replaced?.reason === "stale" ? "publication_binding_stale" : "publication_store_unavailable",
    );
  let stillOwned = false;
  try {
    stillOwned = samePublicationOwner(deps.runnerOwnership?.owner(instance.repo, row.publication.pr), owner);
  } catch {
    /* Unknown ownership also requires rollback. */
  }
  if (!stillOwned) {
    const restored = await deps.instances.compareAndReplaceUnit(updated, row).catch(() => undefined);
    if (restored?.ok !== true) throw new PublicationBindingRefusal("publication_rollback_failed");
    throw new PublicationBindingRefusal("publication_ownership_changed");
  }
  return updated;
}

/** Round zero can update an already-adopted PR. Its ordinary check names the
 * writer, not an adopt action; credit only its exact completed push under the
 * original binding, never the remote head by itself. */
async function advanceCodingPublication(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  facts: PullRequestFacts,
  runId: string,
): Promise<CoordinatorUnit> {
  const binding = row.publication;
  if (binding === undefined || binding.expectedHeadSha === facts.headSha) return row;
  const owner = { instanceId: instance.id, unit: row.unit };
  const prefix = `${instance.id}:${publicationStepPrefix(row)}/0/coding`;
  const coding = row.rounds.filter((note) => note.agent === "coding" && note.index === 0 && note.outcome === "started");
  if (
    row.ending !== undefined ||
    row.idle !== undefined ||
    row.rounds.some((note) => note.agent === "review") ||
    coding.length !== 1 ||
    row.rounds.length !== 1 ||
    row.pr?.number !== binding.pr ||
    binding.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    binding.baseRef !== instance.base ||
    binding.headRef !== row.branch ||
    binding.publicationRef !== row.branch ||
    !samePublicationOwner(binding.owner, owner)
  )
    throw new PublicationBindingRefusal("publication_facts_mismatch");
  const listing = await deps.runs.listRuns({
    privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
    status: "all",
    visibleTo: EVERY_RUN,
    limit: RUN_LIST_MAX_LIMIT,
    recoveryEvidence: {
      instanceId: instance.id,
      unit: row.unit,
      threadKeys: [row.threadKey ?? instance.threadKey],
    },
  });
  const attempts = listing.runs.filter((run) => isStepAttempt(run.idempotencyKey, prefix));
  const result = await deps.runs.getRun(runId, {
    include: "messages",
    privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
  });
  const child = result.ok ? result.value : undefined;
  const tags = child?.events?.filter((event) => event.type === "coordinator_tag") ?? [];
  if (
    listing.storeUnavailable ||
    listing.ledgerUnavailable ||
    listing.nextBefore !== undefined ||
    listing.runs.length >= RUN_LIST_MAX_LIMIT ||
    attempts.length !== 1 ||
    attempts[0]?.id !== runId ||
    listing.runs.some(
      (run) =>
        run.id !== runId &&
        ((!run.finished &&
          (run.parentInstanceId === instance.id || run.idempotencyKey?.startsWith(`${instance.id}:${row.unit}/`))) ||
          ((run.finishedAt === undefined || run.finishedAt >= coding[0]!.at) &&
            run.pushed?.some((push) => push.ref === row.branch))),
    ) ||
    child?.finished !== true ||
    child.persisted !== true ||
    child.truncated !== false ||
    child.events === undefined ||
    child.eventCount !== child.storedEventCount ||
    child.status !== "completed" ||
    child.agent !== "coding" ||
    child.parentInstanceId !== instance.id ||
    !isStepAttempt(child.idempotencyKey, prefix) ||
    child.userId !== instance.userId ||
    child.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
    child.threadKey !== (row.threadKey ?? instance.threadKey) ||
    (child.pr !== undefined &&
      (child.pr.number !== binding.pr ||
        child.pr.url !== row.pr?.url ||
        (child.pr.head !== undefined && child.pr.head !== row.branch))) ||
    child.headSha !== facts.headSha ||
    child.pushed?.length !== 1 ||
    child.pushed[0]?.ref !== row.branch ||
    child.pushed[0]?.sha !== facts.headSha ||
    child.startedAt < (row.startedAt ?? coding[0]!.at) ||
    child.finishedAt === undefined ||
    child.finishedAt < coding[0]!.at ||
    child.finishedAt < child.startedAt ||
    tags.length !== 1 ||
    tags[0]?.parentInstanceId !== instance.id ||
    tags[0].unit !== row.unit ||
    tags[0].base !== instance.base ||
    !samePublicationBinding(tags[0].publication, binding) ||
    facts.state !== "open" ||
    facts.sameRepoHead !== true ||
    facts.headBranchExists !== true ||
    facts.headRef !== binding.headRef ||
    facts.baseRef !== binding.baseRef ||
    !fullHead(facts.headSha) ||
    facts.verifiedHead?.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    facts.verifiedHead.ref !== binding.publicationRef ||
    facts.verifiedHead.sha !== facts.headSha
  )
    throw new PublicationBindingRefusal("publication_facts_mismatch");
  const fresh = await deps.fetchPrFacts({ repo: instance.repo, number: binding.pr }).catch(() => undefined);
  if (
    fresh?.state !== "open" ||
    fresh.sameRepoHead !== true ||
    fresh.headBranchExists !== true ||
    fresh.headRef !== binding.headRef ||
    fresh.baseRef !== binding.baseRef ||
    fresh.headSha !== facts.headSha ||
    fresh.verifiedHead?.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    fresh.verifiedHead.ref !== binding.publicationRef ||
    fresh.verifiedHead.sha !== facts.headSha
  )
    throw new PublicationBindingRefusal("publication_facts_mismatch");
  try {
    if (!samePublicationOwner(deps.runnerOwnership?.owner(instance.repo, binding.pr), owner))
      throw new PublicationBindingRefusal("publication_ownership_changed");
  } catch (err) {
    if (err instanceof PublicationBindingRefusal) throw err;
    throw new PublicationBindingRefusal("publication_ownership_unknown");
  }
  const updated = { ...row, lastPush: facts.headSha, publication: { ...binding, expectedHeadSha: facts.headSha } };
  let replaced: Awaited<ReturnType<CoordinatorInstanceStore["compareAndReplaceUnit"]>> | undefined;
  try {
    replaced = await deps.instances.compareAndReplaceUnit(row, updated);
  } catch {
    const reread = await deps.instances.listUnits(instance.id).catch(() => undefined);
    const current = reread?.filter((candidate) => candidate.unit === row.unit);
    if (current?.length === 1 && JSON.stringify(current[0]) === JSON.stringify(updated)) replaced = { ok: true };
  }
  if (replaced?.ok !== true)
    throw new PublicationBindingRefusal(
      replaced?.reason === "stale" ? "publication_binding_stale" : "publication_store_unavailable",
    );
  let stillOwned = false;
  try {
    stillOwned = samePublicationOwner(deps.runnerOwnership?.owner(instance.repo, binding.pr), owner);
  } catch {
    /* An unknown owner cannot credit the child either. */
  }
  if (!stillOwned) {
    const restored = await deps.instances.compareAndReplaceUnit(updated, row).catch(() => undefined);
    if (restored?.ok !== true) throw new PublicationBindingRefusal("publication_rollback_failed");
    throw new PublicationBindingRefusal("publication_ownership_changed");
  }
  return updated;
}

/** A drained child may have lost the ref to another writer. Adopt that head
 * only as the next review target; it is never attributed to the child push. */
async function adoptSupersededHead(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  facts: PullRequestFacts,
  source: { runId: string; childStep: string; previousHeadSha: string },
): Promise<CoordinatorUnit> {
  const binding = row.publication;
  if (binding === undefined) throw new PublicationBindingRefusal("publication_facts_mismatch");
  const owner = { instanceId: instance.id, unit: row.unit };
  const latestReview = [...row.rounds].reverse().find((round) => round.agent === "review");
  const prefix = publicationStepPrefix(row);
  const reviewStep = `${prefix}/${latestReview?.index}/review`;
  const findingsStep = `${prefix}/${latestReview?.index}/findings`;
  const review = isStepAttempt(source.childStep, reviewStep);
  const findings = isStepAttempt(source.childStep, findingsStep);
  const validFacts = (candidate: PullRequestFacts | undefined) =>
    candidate?.state === "open" &&
    candidate.sameRepoHead === true &&
    candidate.headBranchExists === true &&
    candidate.headRef === binding.headRef &&
    candidate.baseRef === binding.baseRef &&
    fullHead(candidate.headSha) &&
    candidate.headSha !== source.previousHeadSha &&
    candidate.verifiedHead?.repo.toLowerCase() === instance.repo.toLowerCase() &&
    candidate.verifiedHead.ref === binding.publicationRef &&
    candidate.verifiedHead.sha === candidate.headSha;
  if (
    row.instanceId !== instance.id ||
    instance.stop !== undefined ||
    row.ending !== undefined ||
    row.idle !== undefined ||
    row.recovery !== undefined ||
    row.pr?.number !== binding.pr ||
    binding.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    binding.baseRef !== instance.base ||
    binding.headRef !== row.branch ||
    binding.publicationRef !== row.branch ||
    !samePublicationOwner(binding.owner, owner) ||
    !fullHead(source.previousHeadSha) ||
    binding.expectedHeadSha !== source.previousHeadSha ||
    latestReview === undefined ||
    (!review && !findings) ||
    !validFacts(facts)
  )
    throw new PublicationBindingRefusal("publication_facts_mismatch");
  const result = await deps.runs.getRun(source.runId, {
    include: "messages",
    privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
  });
  const child = result.ok ? result.value : undefined;
  const tags = child?.events?.filter((event) => event.type === "coordinator_tag") ?? [];
  if (
    child?.finished !== true ||
    child.parentInstanceId !== instance.id ||
    child.userId !== instance.userId ||
    child.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
    (review && child.threadKey !== (row.reviewThread?.threadKey ?? row.threadKey ?? instance.threadKey)) ||
    (findings && child.threadKey !== (row.threadKey ?? instance.threadKey)) ||
    child.idempotencyKey !== `${instance.id}:${source.childStep}` ||
    child.agent !== (review ? "review" : "coding") ||
    (findings && child !== undefined && !findingsRoundAuthorized(row, latestReview, child.startedAt)) ||
    (findings &&
      ((child.status === "completed" &&
        (!fullHead(child.headSha) ||
          (child.headSha !== facts.headSha &&
            child.pushed?.some((push) => push.ref === row.branch && push.sha === facts.headSha) === true))) ||
        tags.length !== 1 ||
        tags[0]?.parentInstanceId !== instance.id ||
        tags[0].unit !== row.unit ||
        tags[0].base !== instance.base ||
        !samePublicationBinding(tags[0].publication, binding)))
  )
    throw new PublicationBindingRefusal("publication_facts_mismatch");
  // The child's own head is a publication, not a foreign review target.
  // Reuse the completed-findings proof and CAS so only a verified push
  // receives lastPush credit; incomplete evidence must not become adoption.
  if (findings && child.status === "completed" && child.headSha === facts.headSha)
    return advanceFindingsPublication(deps, instance, row, facts, source.runId);
  const fence = deps.runnerOwnership;
  if (fence === undefined) throw new PublicationBindingRefusal("publication_ownership_unknown");
  let priorOwner: { instanceId: string; unit: string } | undefined;
  try {
    priorOwner = fence.owner(instance.repo, binding.pr);
    if (priorOwner !== undefined && !samePublicationOwner(priorOwner, owner))
      throw new PublicationBindingRefusal("publication_ownership_changed");
    if (!fence.claim(instance.repo, binding.pr, owner))
      throw new PublicationBindingRefusal("publication_ownership_changed");
  } catch (err) {
    if (err instanceof PublicationBindingRefusal) throw err;
    throw new PublicationBindingRefusal("publication_ownership_unknown");
  }
  const releaseClaim = () => {
    if (priorOwner === undefined) fence.release(instance.repo, binding.pr, owner);
  };
  const fresh = await deps.fetchPrFacts({ repo: instance.repo, number: binding.pr }).catch(() => undefined);
  if (fresh === undefined || !validFacts(fresh) || fresh.headSha !== facts.headSha) {
    releaseClaim();
    throw new PublicationBindingRefusal("publication_facts_mismatch");
  }
  const updated: CoordinatorUnit = {
    ...row,
    publication: { ...binding, expectedHeadSha: fresh.headSha! },
  };
  let replaced: Awaited<ReturnType<CoordinatorInstanceStore["compareAndReplaceUnit"]>>;
  try {
    replaced = await deps.instances.compareAndReplaceUnit(row, updated);
  } catch {
    releaseClaim();
    throw new PublicationBindingRefusal("publication_store_unavailable");
  }
  if (!replaced.ok) {
    releaseClaim();
    throw new PublicationBindingRefusal(
      replaced.reason === "stale" ? "publication_binding_stale" : "publication_store_unavailable",
    );
  }
  let stillOwned = false;
  try {
    stillOwned = samePublicationOwner(fence.owner(instance.repo, binding.pr), owner);
  } catch {
    /* Unknown ownership also requires rollback. */
  }
  if (!stillOwned) {
    const restored = await deps.instances.compareAndReplaceUnit(updated, row).catch(() => undefined);
    if (restored?.ok !== true) throw new PublicationBindingRefusal("publication_rollback_failed");
    releaseClaim();
    throw new PublicationBindingRefusal("publication_ownership_changed");
  }
  return updated;
}

/** One fail-closed transition from a freshly read open pull request to the
 * exact durable authority later coding rounds require. The ownership claim is
 * synchronous and precedes the full-row CAS; only a claim acquired by this
 * call is conditionally released after a failed durable transition. */
async function bindOpenPullRequest(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  row: CoordinatorUnit | undefined,
  pr: { number: number; url: string },
  facts: PullRequestFacts,
): Promise<void> {
  if (row === undefined) return;
  const verified = facts.verifiedHead;
  if (
    instance.base === undefined ||
    facts.state !== "open" ||
    facts.sameRepoHead !== true ||
    facts.headBranchExists !== true ||
    facts.headRef !== row.branch ||
    facts.baseRef !== instance.base ||
    verified === undefined ||
    verified.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    verified.ref !== row.branch ||
    !/^[0-9a-f]{40}$/i.test(verified.sha) ||
    facts.headSha !== verified.sha ||
    (row.pr !== undefined && row.pr.number !== pr.number)
  )
    throw new PublicationBindingRefusal("publication_facts_mismatch");

  const owner = { instanceId: instance.id, unit: row.unit };
  const publication: ExistingPrPublicationBinding = {
    repo: instance.repo,
    pr: pr.number,
    headRef: row.branch,
    baseRef: instance.base,
    expectedHeadSha: verified.sha,
    publicationRef: row.branch,
    owner,
  };
  const existing = row.publication;
  if (
    existing !== undefined &&
    (existing.repo !== publication.repo ||
      existing.pr !== publication.pr ||
      existing.headRef !== publication.headRef ||
      existing.baseRef !== publication.baseRef ||
      existing.expectedHeadSha !== publication.expectedHeadSha ||
      existing.publicationRef !== publication.publicationRef ||
      !samePublicationOwner(existing.owner, owner))
  )
    throw new PublicationBindingRefusal("publication_facts_mismatch");

  const fence = deps.runnerOwnership;
  if (fence === undefined) throw new PublicationBindingRefusal("publication_ownership_unknown");
  let priorOwner: { instanceId: string; unit: string } | undefined;
  try {
    priorOwner = fence.owner(instance.repo, pr.number);
  } catch {
    throw new PublicationBindingRefusal("publication_ownership_unknown");
  }
  if (priorOwner !== undefined && !samePublicationOwner(priorOwner, owner))
    throw new PublicationBindingRefusal("publication_ownership_changed");
  try {
    if (!fence.claim(instance.repo, pr.number, owner))
      throw new PublicationBindingRefusal("publication_ownership_changed");
  } catch (err) {
    if (err instanceof PublicationBindingRefusal) throw err;
    throw new PublicationBindingRefusal("publication_ownership_unknown");
  }
  let claimedHere = priorOwner === undefined;
  const releaseClaim = () => {
    if (!claimedHere) return;
    fence.release(instance.repo, pr.number, owner);
    claimedHere = false;
  };
  try {
    if (!samePublicationOwner(fence.owner(instance.repo, pr.number), owner)) {
      releaseClaim();
      throw new PublicationBindingRefusal("publication_ownership_unknown");
    }
  } catch (err) {
    releaseClaim();
    if (err instanceof PublicationBindingRefusal) throw err;
    throw new PublicationBindingRefusal("publication_ownership_unknown");
  }

  const replacement = { ...row, pr, publication };
  if (JSON.stringify(replacement) === JSON.stringify(row)) return;
  let replaced: Awaited<ReturnType<CoordinatorInstanceStore["compareAndReplaceUnit"]>>;
  try {
    replaced = await deps.instances.compareAndReplaceUnit(row, replacement);
  } catch {
    releaseClaim();
    throw new PublicationBindingRefusal("publication_store_unavailable");
  }
  if (!replaced.ok) {
    releaseClaim();
    throw new PublicationBindingRefusal(
      replaced.reason === "stale" ? "publication_binding_stale" : "publication_store_unavailable",
    );
  }
}

const fullHead = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);

/** Only the driver's numeric attempt suffix is part of the original step. */
const isStepAttempt = (key: string | undefined, step: string): boolean =>
  key === step || (key?.startsWith(`${step}/a`) === true && /^[1-9][0-9]*$/.test(key.slice(step.length + 2)));

type RecoveryReviewStartDiagnostic =
  | { reviewStart: "verified_no_work"; runId: string; key: string }
  | { reviewStart: "evidence_unavailable"; reason: string };

const unavailableReviewStart = (reason: string): RecoveryReviewStartDiagnostic => ({
  reviewStart: "evidence_unavailable",
  reason,
});

/** Zero-turn review starts are evidence only with the complete final attach
 * refusal, not merely a zero-usage summary or an absent review post. */
async function verifiedReviewAttachRefusal(
  run: RunView,
  service: RunsService,
): Promise<"verified" | "invalid" | "unavailable"> {
  if (
    run.agent !== "review" ||
    !run.finished ||
    run.status !== "failed" ||
    (run.liveState?.state !== "preparing" && run.liveState?.state !== "admitted") ||
    run.usage?.turns !== 0 ||
    run.usage.byModel === undefined ||
    Object.keys(run.usage.byModel).length !== 0 ||
    run.reviewHead !== undefined ||
    run.verdict !== undefined ||
    run.reviewPost !== undefined ||
    run.headSha !== undefined ||
    run.pushed !== undefined ||
    run.pr !== undefined ||
    run.doorPublicationPending !== undefined
  )
    return "invalid";
  let final: Awaited<ReturnType<RunsService["getRun"]>>;
  try {
    final = await service.getRun(run.id, {
      include: "messages",
      requireFinalRecord: true,
      privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
    });
  } catch {
    return "unavailable";
  }
  const child = final.ok === true ? final.value : undefined;
  const events = child?.events;
  const preparing = events?.findIndex((event) => event.type === "run_state" && event.state === "preparing") ?? -1;
  const attachStart =
    events?.findIndex((event) => event.type === "span_start" && event.name === "dispatch.workspace.attach") ?? -1;
  const attachEnd =
    events?.findIndex(
      (event) => event.type === "span_end" && event.name === "dispatch.workspace.attach" && event.status === "error",
    ) ?? -1;
  const refusal =
    events?.findIndex(
      (event) => event.type === "refusal" && event.code === "setup_failed" && event.cause === "workspace",
    ) ?? -1;
  const start = events?.[attachStart];
  const end = events?.[attachEnd];
  const admitted = events?.findIndex((event) => event.type === "run_state" && event.state === "admitted") ?? -1;
  const memoryStart =
    events?.findIndex((event) => event.type === "span_start" && event.name === "dispatch.memory_read") ?? -1;
  const memoryEnd =
    events?.findIndex((event) => event.type === "span_end" && event.name === "dispatch.memory_read") ?? -1;
  const systemRefusal =
    events?.findIndex(
      (event) => event.type === "refusal" && event.code === "setup_failed" && event.cause === "system",
    ) ?? -1;
  const memoryOpened = events?.[memoryStart];
  const memoryClosed = events?.[memoryEnd];
  const postRefusal = events?.slice(systemRefusal + 1) ?? [];
  const matchingCleanupPair = (offset: number, name: string): boolean => {
    const opened = postRefusal[offset];
    const closed = postRefusal[offset + 1];
    return (
      opened?.type === "span_start" &&
      opened.name === name &&
      closed?.type === "span_end" &&
      closed.name === name &&
      closed.spanId === opened.spanId &&
      closed.status === "ok" &&
      events?.filter(
        (event) => (event.type === "span_start" || event.type === "span_end") && event.spanId === opened.spanId,
      ).length === 2
    );
  };
  // The memory read may finish while attach is in flight. Previously opened
  // setup spans may close after refusal; the only newly opened spans are the
  // ordered refusal and reply cleanup pairs, never another dispatch action.
  const pairedRefusalReply =
    postRefusal.length === 4 && matchingCleanupPair(0, "dispatch.refuse") && matchingCleanupPair(2, "post.reply");
  // The already-started memory read may end just before attach starts or
  // while attach runs. Both orders are setup-only when the three events are
  // adjacent after admission and attach itself ends in an error.
  const adjacentAttachSetup =
    (attachStart === admitted + 1 && memoryEnd === admitted + 2) ||
    (memoryEnd === admitted + 1 && attachStart === admitted + 2);
  const admittedAttachRefusal =
    run.liveState?.state === "admitted" &&
    child?.liveState?.state === "admitted" &&
    preparing < 0 &&
    admitted >= 0 &&
    events?.filter((event) => event.type === "run_state").length === 1 &&
    memoryStart >= 0 &&
    memoryStart < admitted &&
    adjacentAttachSetup &&
    attachEnd === admitted + 3 &&
    systemRefusal === attachEnd + 1 &&
    memoryOpened?.type === "span_start" &&
    memoryClosed?.type === "span_end" &&
    memoryOpened.spanId === memoryClosed.spanId &&
    events?.every((event, index) => {
      if (event.seq !== index + 1) return false;
      if (index < admitted)
        return (
          event.type === "input" ||
          event.type === "run_meta" ||
          event.type === "coordinator_tag" ||
          event.type === "context" ||
          ((event.type === "span_start" || event.type === "span_end") &&
            (event.name === "request" ||
              event.name === "slack.receive" ||
              event.name === "post.card_close" ||
              event.name === "post.reply" ||
              (event.name.startsWith("dispatch.") && event.name !== "dispatch.workspace.attach")))
        );
      if (index === admitted) return event.type === "run_state" && event.state === "admitted";
      if (index === attachStart || index === memoryEnd || index === attachEnd) return true;
      if (index === systemRefusal) return event.type === "refusal";
      if (pairedRefusalReply && index > systemRefusal) return true;
      if (event.type !== "span_end" || index < systemRefusal) return false;
      if (
        event.name !== "request" &&
        event.name !== "slack.receive" &&
        event.name !== "post.card_close" &&
        event.name !== "post.reply" &&
        (!event.name.startsWith("dispatch.") ||
          event.name === "dispatch.workspace.attach" ||
          event.name === "dispatch.memory_read")
      )
        return false;
      const opened = events.findIndex(
        (prior) => prior.type === "span_start" && prior.spanId === event.spanId && prior.name === event.name,
      );
      return (
        opened >= 0 &&
        opened < admitted &&
        events.filter((prior) => prior.type === "span_end" && prior.spanId === event.spanId).length === 1
      );
    }) === true;
  return child !== undefined &&
    child.id === run.id &&
    child.idempotencyKey === run.idempotencyKey &&
    child.parentInstanceId === run.parentInstanceId &&
    child.userId === run.userId &&
    child.repo === run.repo &&
    child.threadKey === run.threadKey &&
    child.agent === "review" &&
    child.startedAt === run.startedAt &&
    child.finishedAt === run.finishedAt &&
    child.status === "failed" &&
    (child.liveState?.state === "preparing" || child.liveState?.state === "admitted") &&
    child.truncated === false &&
    child.eventCount === run.eventCount &&
    child.storedEventCount === run.eventCount &&
    events !== undefined &&
    events.length === run.eventCount &&
    child.usage?.turns === 0 &&
    child.usage.byModel !== undefined &&
    Object.keys(child.usage.byModel).length === 0 &&
    child.reviewHead === undefined &&
    child.verdict === undefined &&
    child.reviewPost === undefined &&
    child.headSha === undefined &&
    child.pushed === undefined &&
    child.pr === undefined &&
    child.dispositions === undefined &&
    child.doorPublicationPending === undefined &&
    child.lease === undefined &&
    (admittedAttachRefusal ||
      (run.liveState?.state === "preparing" &&
        preparing >= 0 &&
        attachStart > preparing &&
        attachEnd > attachStart &&
        refusal > attachEnd)) &&
    start?.type === "span_start" &&
    end?.type === "span_end" &&
    start.spanId === end.spanId &&
    events.filter((event) => event.type === "refusal").length === 1 &&
    events.filter((event) => event.type === "run_meta" && event.agent === "review").length === 1 &&
    (admittedAttachRefusal ||
      events.every(
        (event, index) =>
          event.seq === index + 1 &&
          (event.type === "input" ||
            event.type === "run_meta" ||
            (event.type === "coordinator_tag" && index < preparing) ||
            (event.type === "context" && index < preparing) ||
            (event.type === "refusal" && index === refusal) ||
            (event.type === "run_state" && ["admitted", "waiting_repository", "preparing"].includes(event.state)) ||
            ((event.type === "span_start" || event.type === "span_end") &&
              (index === attachStart ||
                index === attachEnd ||
                (index < preparing &&
                  (event.name === "request" ||
                    event.name === "slack.receive" ||
                    event.name === "post.card_close" ||
                    event.name === "post.reply" ||
                    event.name.startsWith("dispatch.")))))),
      ))
    ? "verified"
    : "invalid";
}

/** Audit the retained original children, not today's cost projection. A known
 * per-turn meter total is historical price evidence; repricing old tokens with
 * the current operator table is not. This total is a lower bound until every
 * started round is accounted for, and is never used to mint a new budget. */
async function historicalRecoverySpend(
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  runs: RunView[],
  service: RunsService,
): Promise<
  | { usd: number; children: RecoveryAccounting["children"]; noWork: string[]; noWorkReviews: string[] }
  | { reason: string }
> {
  const unitKey = `${instance.id}:${row.unit}`;
  const unitPrefix = `${unitKey}/`;
  // A bare unit key claims this unit but has no auditable step identity.
  const children = runs.filter(
    (run) => run.idempotencyKey === unitKey || run.idempotencyKey?.startsWith(unitPrefix) === true,
  );
  if (
    runs.some(
      (run) => run.parentInstanceId === instance.id && run.idempotencyKey?.startsWith(`${instance.id}:`) !== true,
    )
  )
    return { reason: "child_identity_mismatch" };
  const pricedChildren: RecoveryAccounting["children"] = [];
  const noWork: string[] = [];
  const noWorkReviews: string[] = [];
  const stagedChildren: {
    run: RunView;
    segment: number;
    round: number;
    order: number;
    action: "coding" | "review" | "findings" | "rebase";
  }[] = [];
  const stageOrder = (agent: "coding" | "review", index: number): number =>
    agent === "review" ? index * 2 - 1 : index * 2;
  const segmentAt = (at: number): number => row.segments?.filter((segment) => segment.at <= at).at(-1)?.index ?? 1;
  const approvalGateMatches = (note: CoordinatorUnit["rounds"][number], run: RunView): boolean => {
    if (run.verdict?.verdict !== "approve") return false;
    const level = instance.addressSeverity ?? DEFAULT_ADDRESS_SEVERITY;
    const labels = findingsAtOrAbove(run.verdict.findings ?? [], level).map(
      (finding) => `${finding.id} (${finding.severity})`,
    );
    if (labels.length === 0) return note.gate === undefined;
    return (
      note.gate?.level === level &&
      note.gate.findings.length === labels.length &&
      new Set(note.gate.findings).size === labels.length &&
      labels.every((label) => note.gate!.findings.includes(label))
    );
  };
  const permitsNextStage = (note: CoordinatorUnit["rounds"][number], action: string): boolean => {
    if (note.agent === "coding") return note.outcome === "pr_opened";
    if (action === "rebase") return note.outcome === "approve" && note.gate === undefined;
    if (action === "findings")
      return (
        note.outcome === "request_changes" ||
        note.outcome === "checks_failed" ||
        note.outcome === "dequeued" ||
        (note.outcome === "approve" && (note.gate?.findings.length ?? 0) > 0)
      );
    return (
      note.outcome === "approve" ||
      note.outcome === "request_changes" ||
      note.outcome === "checks_failed" ||
      note.outcome === "dequeued"
    );
  };
  for (const run of children) {
    if (!run.finished) return { reason: "child_active" };
    const suffix = run.idempotencyKey!.slice(unitPrefix.length);
    // Resumed /rN histories cannot prove their lease start in this schema.
    const match =
      /^(?:s([2-9]|[1-9][0-9]+)\/)?(0|[1-9][0-9]*)\/(coding|review|findings|rebase)(?:\/a[1-9][0-9]*)?$/.exec(suffix);
    const roundIndex = Number(match?.[2]);
    const action = match?.[3] as "coding" | "review" | "findings" | "rebase" | undefined;
    if (
      match === null ||
      !Number.isSafeInteger(roundIndex) ||
      (roundIndex === 0 ? action !== "coding" : action === "coding") ||
      run.parentInstanceId !== instance.id ||
      run.userId !== instance.userId ||
      run.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
      run.agent !== (action === "review" ? "review" : "coding") ||
      run.threadKey !==
        (run.agent === "review"
          ? (row.reviewThread?.threadKey ?? row.threadKey ?? instance.threadKey)
          : (row.threadKey ?? instance.threadKey)) ||
      (run.pr !== undefined &&
        (run.pr.number !== row.pr?.number ||
          run.pr.url !== row.pr?.url ||
          (run.pr.head !== undefined && run.pr.head !== row.branch))) ||
      run.pushed?.some((push) => push.ref !== row.branch || !fullHead(push.sha)) === true ||
      (match[1] !== undefined && !row.segments?.some((segment) => segment.index === Number(match[1])))
    )
      return { reason: "child_identity_mismatch" };
    if (
      run.persisted !== true ||
      run.provisional ||
      run.restarting ||
      run.truncated !== false ||
      !Number.isSafeInteger(run.eventCount) ||
      run.eventCount !== run.storedEventCount
    )
      return { reason: "child_history_incomplete" };
    if (
      !Number.isFinite(run.startedAt) ||
      run.startedAt < row.startedAt! ||
      run.finishedAt === undefined ||
      !Number.isFinite(run.finishedAt) ||
      run.finishedAt < run.startedAt ||
      run.finishedAt > row.ending!.at
    )
      return { reason: "child_time_invalid" };
    const segmentIndex = Number(match[1] ?? 1);
    const segmentStart = row.segments?.find((segment) => segment.index === segmentIndex)?.at ?? row.startedAt!;
    const segmentEnd = row.segments?.find((segment) => segment.index === segmentIndex + 1)?.at ?? row.ending!.at;
    if (run.startedAt < segmentStart || run.finishedAt > segmentEnd) return { reason: "child_round_mismatch" };
    const models = Object.values(run.usage?.byModel ?? {});
    let childUsd: number;
    if (run.usage?.turns === 0 && models.length === 0 && action === "review") {
      const refusal = await verifiedReviewAttachRefusal(run, service);
      if (refusal !== "verified")
        return {
          reason: refusal === "unavailable" ? "review_start_store_unavailable" : "review_start_evidence_unavailable",
        };
      childUsd = 0;
      noWorkReviews.push(run.id);
    } else if (run.usage?.turns === 0 && models.length === 0 && action === "findings") {
      // Zero tokens are not a price receipt. Only a complete final server
      // record that stopped in setup before any model/tool/work is $0 evidence.
      const final = await service
        .getRun(run.id, {
          include: "messages",
          requireFinalRecord: true,
          privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
        })
        .catch(() => undefined);
      const child = final?.ok === true ? final.value : undefined;
      const events = child?.events;
      const preparingIndex =
        events?.findIndex((event) => event.type === "run_state" && event.state === "preparing") ?? -1;
      const waitingDeployIndex =
        events?.findIndex((event) => event.type === "run_state" && event.state === "waiting_deploy") ?? -1;
      const drainStartIndex =
        events?.findIndex(
          (event) => event.type === "span_start" && event.name === "dispatch.workspace.attach.drain-wait",
        ) ?? -1;
      const drainEndIndex =
        events?.findIndex(
          (event) =>
            event.type === "span_end" &&
            event.name === "dispatch.workspace.attach.drain-wait" &&
            event.status === "error",
        ) ?? -1;
      const attachStartIndex =
        events?.findIndex((event) => event.type === "span_start" && event.name === "dispatch.workspace.attach") ?? -1;
      const attachEndIndex =
        events?.findIndex(
          (event) =>
            event.type === "span_end" && event.name === "dispatch.workspace.attach" && event.status === "error",
        ) ?? -1;
      const refusalIndex =
        events?.findIndex((event) => event.type === "refusal" && event.code === "setup_failed") ?? -1;
      const attachStart = events?.[attachStartIndex];
      const attachEnd = events?.[attachEndIndex];
      const drainStart = events?.[drainStartIndex];
      const drainEnd = events?.[drainEndIndex];
      const drainWaitSetupRefusal =
        run.liveState?.state === "waiting_deploy" &&
        child?.liveState?.state === "waiting_deploy" &&
        preparingIndex < 0 &&
        attachStartIndex >= 0 &&
        attachStartIndex < waitingDeployIndex &&
        waitingDeployIndex < drainStartIndex &&
        drainStartIndex < drainEndIndex &&
        drainEndIndex < attachEndIndex &&
        attachEndIndex < refusalIndex &&
        attachStart?.type === "span_start" &&
        attachEnd?.type === "span_end" &&
        attachStart.spanId === attachEnd.spanId &&
        drainStart?.type === "span_start" &&
        drainEnd?.type === "span_end" &&
        drainStart.spanId === drainEnd.spanId &&
        events?.slice(waitingDeployIndex + 1).every((event) => event.type !== "run_state") === true &&
        events?.[refusalIndex]?.type === "refusal" &&
        events[refusalIndex].cause === "system";
      const setupBoundaryIndex = drainWaitSetupRefusal ? waitingDeployIndex : preparingIndex;
      if (
        child === undefined ||
        child.id !== run.id ||
        child.idempotencyKey !== run.idempotencyKey ||
        child.parentInstanceId !== run.parentInstanceId ||
        child.userId !== run.userId ||
        child.repo !== run.repo ||
        child.agent !== run.agent ||
        child.threadKey !== run.threadKey ||
        child.startedAt !== run.startedAt ||
        child.finishedAt !== run.finishedAt ||
        run.status !== "failed" ||
        (run.liveState?.state !== "preparing" && !drainWaitSetupRefusal) ||
        child.status !== "failed" ||
        (child.liveState?.state !== "preparing" && !drainWaitSetupRefusal) ||
        child.truncated !== false ||
        child.eventCount !== run.eventCount ||
        child.storedEventCount !== run.eventCount ||
        events === undefined ||
        events.length !== run.eventCount ||
        child.usage?.turns !== 0 ||
        child.usage.byModel === undefined ||
        Object.keys(child.usage.byModel).length !== 0 ||
        run.headSha !== undefined ||
        run.pushed !== undefined ||
        run.pr !== undefined ||
        child.headSha !== undefined ||
        child.pushed !== undefined ||
        child.pr !== undefined ||
        child.verdict !== undefined ||
        child.reviewPost !== undefined ||
        child.reviewHead !== undefined ||
        child.dispositions !== undefined ||
        child.doorPublicationPending !== undefined ||
        child.lease !== undefined ||
        events.filter((event) => event.type === "refusal" && event.code === "setup_failed").length !== 1 ||
        setupBoundaryIndex < 0 ||
        events.some(
          (event, index) =>
            event.seq !== index + 1 ||
            !(
              event.type === "input" ||
              event.type === "run_meta" ||
              event.type === "coordinator_tag" ||
              // The dispatcher records prior-thread context before setup; later
              // narrative events cannot attest to a pre-model refusal.
              (event.type === "context" && typeof event.text === "string" && index < setupBoundaryIndex) ||
              (event.type === "refusal" && event.code === "setup_failed") ||
              (event.type === "run_state" &&
                ["admitted", "waiting_deploy", "waiting_repository", "falling_back", "preparing"].includes(
                  event.state,
                )) ||
              ((event.type === "span_start" || event.type === "span_end") &&
                (event.name === "request" ||
                  event.name === "slack.receive" ||
                  event.name === "post.card_close" ||
                  event.name === "post.reply" ||
                  event.name.startsWith("dispatch.")))
            ),
        )
      )
        return { reason: "child_price_unknown" };
      childUsd = 0;
      noWork.push(run.id);
    } else if (
      models.length === 0 ||
      !Number.isSafeInteger(run.usage?.turns) ||
      run.usage!.turns < 1 ||
      models.reduce((total, model) => total + model.turns, 0) !== run.usage!.turns ||
      models.some(
        (model) =>
          !Number.isSafeInteger(model.turns) ||
          model.turns < 1 ||
          typeof model.usd !== "number" ||
          !Number.isFinite(model.usd) ||
          model.usd < 0,
      )
    )
      return { reason: "child_price_unknown" };
    else childUsd = models.reduce((total, model) => total + model.usd!, 0);
    pricedChildren.push({ runId: run.id, key: run.idempotencyKey!, usd: childUsd });
    stagedChildren.push({
      run,
      segment: segmentIndex,
      round: roundIndex,
      order: stageOrder(run.agent === "review" ? "review" : "coding", roundIndex),
      action: action!,
    });
  }
  const ordered = [...children].sort((left, right) => left.startedAt - right.startedAt);
  if (ordered.some((run, index) => index > 0 && run.startedAt < ordered[index - 1]!.finishedAt!))
    return { reason: "child_history_overlapping" };
  if (new Set(children.map((run) => run.idempotencyKey)).size !== children.length)
    return { reason: "child_history_ambiguous" };
  for (const child of stagedChildren) {
    // No later stage may precede an earlier paid child, even when a legacy
    // coding run has no retained start note.
    if (
      stagedChildren.some(
        (prior) =>
          (prior.segment < child.segment || (prior.segment === child.segment && prior.order < child.order)) &&
          prior.run.finishedAt! > child.run.startedAt,
      )
    )
      return { reason: "child_round_mismatch" };
    // A later child may precede its own started note, but the previous
    // round's terminal note was persisted before the driver could spawn it.
    if (
      row.rounds.some(
        (note) =>
          note.outcome !== "started" &&
          (row.segments?.filter((segment) => segment.at <= note.at).at(-1)?.index ?? 1) === child.segment &&
          stageOrder(note.agent === "review" ? "review" : "coding", note.index) < child.order &&
          child.run.startedAt < note.at,
      )
    )
      return { reason: "child_round_mismatch" };
  }
  const terminalRetryEvidence = (child: (typeof stagedChildren)[number]): boolean => {
    const ending = row.ending;
    if (
      child.action !== "findings" ||
      ending?.kind !== "failed" ||
      ending.cause !== "step_threw" ||
      ending.round !== child.round ||
      !ending.step?.endsWith("/pr-check")
    )
      return false;
    const stage = `${stepPrefixOf(row.unit, child.segment > 1 ? { segment: child.segment, renewalsSpent: 0, spendUsd: null } : undefined)}/${child.round}/findings`;
    const checkedStep = ending.step.slice(0, -"/pr-check".length);
    if (!isStepAttempt(checkedStep, stage)) return false;
    const prefix = `${instance.id}:${stage}`;
    const key = child.run.idempotencyKey!;
    if (!isStepAttempt(key, prefix)) return false;
    const ordinal = (value: string, base: string) => (value === base ? 0 : Number(value.slice(base.length + 2)));
    if (ordinal(key, prefix) > ordinal(checkedStep, stage)) return false;
    return (
      key === `${instance.id}:${checkedStep}` ||
      ((child.run.status === "failed" || child.run.status === "interrupted") && (child.run.pushed?.length ?? 0) === 0)
    );
  };
  const abortedSalvageRetryEvidence = (
    child: (typeof stagedChildren)[number],
    stageChildren: typeof stagedChildren,
    starts: CoordinatorUnit["rounds"],
  ): boolean => {
    if (
      row.ending?.kind !== "aborted" ||
      row.rounds.at(-1)?.agent !== "coding" ||
      row.rounds.at(-1)?.outcome !== "aborted" ||
      child.action !== "findings" ||
      stageChildren.length !== 2 ||
      starts.length !== 1 ||
      child !== stageChildren[0]
    )
      return false;
    const later = stageChildren[1]!;
    const prefix = `${instance.id}:${stepPrefixOf(row.unit, child.segment > 1 ? { segment: child.segment, renewalsSpent: 0, spendUsd: null } : undefined)}/${child.round}/findings`;
    const ordinal = (key: string) => (key === prefix ? 0 : Number(key.slice(prefix.length + 2)));
    return (
      later.action === "findings" &&
      later.run.status === "completed" &&
      later.run.pushed?.some((push) => push.ref === row.branch && push.by === "salvage") === true &&
      (child.run.status === "failed" || child.run.status === "interrupted") &&
      (child.run.pushed?.length ?? 0) === 0 &&
      ordinal(child.run.idempotencyKey!) < ordinal(later.run.idempotencyKey!) &&
      child.run.finishedAt! <= later.run.startedAt &&
      child.run.finishedAt! <= starts[0]!.at
    );
  };
  const startedNotes = row.rounds
    .filter((note) => note.outcome === "started")
    .map((note) => ({
      note,
      segment: segmentAt(note.at),
      order: stageOrder(note.agent === "review" ? "review" : "coding", note.index),
    }));
  const groupKeys = new Set([
    ...stagedChildren.map((child) => `${child.segment}:${child.order}`),
    ...startedNotes.map((start) => `${start.segment}:${start.order}`),
  ]);
  for (const groupKey of groupKeys) {
    const stageChildren = stagedChildren
      .filter((child) => `${child.segment}:${child.order}` === groupKey)
      .sort((left, right) => left.run.startedAt - right.run.startedAt);
    const starts = startedNotes.filter((start) => `${start.segment}:${start.order}` === groupKey);
    const noWorkReview =
      stageChildren.length === 1 &&
      stageChildren[0]?.action === "review" &&
      noWorkReviews.includes(stageChildren[0].run.id) &&
      row.ending?.kind === "failed" &&
      row.ending.cause === "step_threw" &&
      row.ending.round === stageChildren[0].round &&
      /^.+\/note\/[1-9][0-9]*$/.test(row.ending.step ?? "") &&
      starts.length > 0 &&
      starts[0]!.note.at <= stageChildren[0].run.finishedAt! &&
      starts.every(
        (start) =>
          start.note.agent === "review" &&
          start.note.outcome === "started" &&
          start.note.at >= stageChildren[0]!.run.startedAt &&
          start.note.at <= row.ending!.at,
      ) &&
      stageChildren[0].run.finishedAt! <= row.ending.at &&
      row.rounds
        .filter(
          (note) =>
            note.agent === "review" &&
            note.index === stageChildren[0]!.round &&
            segmentAt(note.at) === stageChildren[0]!.segment,
        )
        .every((note) => note.outcome === "started");
    if (
      new Set(stageChildren.map((child) => child.action)).size > 1 ||
      (starts.length > stageChildren.length && !noWorkReview)
    )
      return { reason: "child_history_missing" };
    const admittedStarts = noWorkReview ? starts.slice(0, 1) : starts;
    const first = stageChildren[0];
    if (
      first?.action === "review" &&
      (stageChildren.length !== 1 ||
        first.run.idempotencyKey !==
          `${instance.id}:${stepPrefixOf(row.unit, first.segment > 1 ? { segment: first.segment, renewalsSpent: 0, spendUsd: null } : undefined)}/${first.round}/review`)
    )
      return { reason: "child_round_mismatch" };
    const extraCount = stageChildren.length - admittedStarts.length;
    const extras = stageChildren.slice(0, extraCount);
    if (
      extras.some(
        (child) =>
          !terminalRetryEvidence(child) &&
          !abortedSalvageRetryEvidence(
            child,
            stageChildren,
            starts.map((start) => start.note),
          ) &&
          !(
            starts.length === 0 &&
            stageChildren.length === 1 &&
            child.segment === 1 &&
            child.round === 0 &&
            child.action === "coding" &&
            child.run.idempotencyKey === `${unitPrefix}0/coding` &&
            child.run.status === "completed" &&
            child.run.pushed?.some((push) => push.ref === row.branch) === true
          ),
      )
    )
      return { reason: "child_history_missing" };
    for (const [index, start] of admittedStarts.entries()) {
      const child = stageChildren[extraCount + index]!;
      if (child.run.startedAt > start.note.at || (index > 0 && child.run.startedAt < starts[index - 1]!.note.at))
        return { reason: "child_history_missing" };
      if (child.action === "review") {
        const terminal = row.rounds
          .filter(
            (note) =>
              note.agent === "review" &&
              note.index === child.round &&
              note.outcome !== "started" &&
              note.outcome !== "checks_restarted" &&
              segmentAt(note.at) === child.segment &&
              note.at >= start.note.at,
          )
          .at(-1);
        if (noWorkReview) continue;
        if (terminal === undefined || child.run.finishedAt! > terminal.at) return { reason: "child_round_mismatch" };
        const expectedVerdict =
          terminal.outcome === "checks_failed"
            ? "approve"
            : terminal.outcome === "approve" || terminal.outcome === "request_changes"
              ? terminal.outcome
              : undefined;
        const approvalNotes = row.rounds.filter(
          (note) =>
            note.agent === "review" &&
            note.index === child.round &&
            note.outcome === "approve" &&
            segmentAt(note.at) === child.segment &&
            note.at >= start.note.at &&
            note.at <= terminal.at,
        );
        if (
          terminal.outcome === "dequeued" ||
          approvalNotes.some((note) => !approvalGateMatches(note, child.run)) ||
          (terminal.outcome === "checks_failed" && approvalNotes.length === 0) ||
          (expectedVerdict !== undefined &&
            (child.run.verdict?.verdict !== expectedVerdict ||
              row.pr === undefined ||
              !fullHead(child.run.reviewHead) ||
              reviewPostedByRecord(child.run, { repo: instance.repo, number: row.pr.number })?.reviewPosted !== true))
        )
          return { reason: "child_round_mismatch" };
      }
    }
    const stage = stageChildren[0]!;
    const later = stagedChildren
      .filter((child) => child.segment === stage.segment && child.order > stage.order)
      .sort((left, right) => left.order - right.order || left.run.startedAt - right.run.startedAt)[0];
    if (later !== undefined) {
      if (later.order !== stage.order + 1) return { reason: "child_round_mismatch" };
      const lastStart = admittedStarts.at(-1)?.note.at;
      const terminal = row.rounds
        .filter(
          (note) =>
            note.outcome !== "started" &&
            note.agent === stage.run.agent &&
            note.index === stage.round &&
            segmentAt(note.at) === stage.segment &&
            note.at <= later.run.startedAt,
        )
        .at(-1);
      if (
        (lastStart !== undefined && (terminal === undefined || terminal.at < lastStart)) ||
        (terminal === undefined && !stageChildren.every((child) => child.action === "coding" && child.round === 0)) ||
        (terminal !== undefined &&
          (!(
            permitsNextStage(terminal, later.action) ||
            (stage.action === "review" &&
              later.action === "findings" &&
              terminal.outcome === "approve" &&
              row.rounds.some(
                (note) =>
                  note.agent === "coding" &&
                  note.index === stage.round &&
                  note.outcome === "dequeued" &&
                  segmentAt(note.at) === stage.segment &&
                  note.at >= terminal.at &&
                  note.at <= later.run.startedAt,
              ))
          ) ||
            stageChildren.some((child) => child.run.finishedAt! > terminal.at)))
      )
        return { reason: "child_round_mismatch" };
    }
  }
  pricedChildren.sort((left, right) => left.key.localeCompare(right.key));
  // The receipt validates this sum in child order. Compute it after sorting
  // so a different listing order cannot change the fractional USD total.
  const usd = pricedChildren.reduce((sum, child) => sum + child.usd, 0);
  if (!Number.isFinite(usd)) return { reason: "child_price_unknown" };
  return { usd, children: pricedChildren, noWork, noWorkReviews };
}

/** Select exactly one later review from the complete GitHub list. A later
 * approval from any author makes the old trigger stale. */
async function laterRecoveryReview(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  pr: { number: number },
  head: string,
  after: number,
  at: number,
): Promise<RecoveryReviewEvidence | undefined> {
  const reviews = await deps.fetchPrReviews({ repo: instance.repo, number: pr.number }).catch(() => undefined);
  if (reviews === undefined) return undefined;
  const later = reviews.filter(
    (r) =>
      r.state !== "PENDING" &&
      (!Number.isFinite(Date.parse(r.submittedAt ?? "")) || Date.parse(r.submittedAt!) > after),
  );
  const requests = later.filter((r) => r.state === "CHANGES_REQUESTED");
  if (requests.length !== 1) return undefined;
  const review = requests[0]!;
  const submittedAt = Date.parse(review.submittedAt ?? "");
  const id = review.id;
  const reviewer = review.author;
  if (
    id === undefined ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    reviewer?.id === undefined ||
    !Number.isSafeInteger(reviewer.id) ||
    reviewer.id <= 0 ||
    !reviewer.login ||
    review.commitId !== head ||
    !Number.isFinite(submittedAt) ||
    submittedAt <= after ||
    submittedAt > at ||
    reviews.filter((r) => r.id === id).length !== 1 ||
    later.some(
      (r) =>
        r !== review &&
        (r.state === "APPROVED" || r.author?.id === reviewer.id || !Number.isFinite(Date.parse(r.submittedAt ?? ""))) &&
        (!Number.isFinite(Date.parse(r.submittedAt ?? "")) || Date.parse(r.submittedAt!) >= submittedAt),
    ) ||
    !(await deps.commenterAuthorized(instance.userId, { login: reviewer.login, id: reviewer.id }).catch(() => false))
  )
    return undefined;
  return { id, reviewer: { login: reviewer.login, id: reviewer.id }, headSha: head, submittedAt, body: review.body };
}

/** Independent findings can add changes requests, but a later approval makes
 * the original external trigger stale before another child is admitted. */
async function claimedRecoveryReviewValid(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  pr: { number: number },
  trigger: RecoveryReviewEvidence,
): Promise<boolean> {
  const reviews = await deps.fetchPrReviews({ repo: instance.repo, number: pr.number }).catch(() => undefined);
  const matches = reviews?.filter((review) => review.id === trigger.id);
  if (matches?.length !== 1) return false;
  if (
    reviews?.some((candidate) => {
      if (candidate.id === trigger.id || candidate.state !== "APPROVED") return false;
      const submittedAt = Date.parse(candidate.submittedAt ?? "");
      return !Number.isFinite(submittedAt) || submittedAt >= trigger.submittedAt;
    })
  )
    return false;
  const review = matches[0]!;
  return (
    review.state === "CHANGES_REQUESTED" &&
    review.author?.id === trigger.reviewer.id &&
    review.author.login === trigger.reviewer.login &&
    review.commitId === trigger.headSha &&
    Date.parse(review.submittedAt ?? "") === trigger.submittedAt &&
    review.body === trigger.body &&
    (await deps.commenterAuthorized(instance.userId, trigger.reviewer).catch(() => false))
  );
}

/** A uniquely owned, completed and posted review is the only prior table a
 * recovered review may compare with its next verdict. */
function postedPatternReviewAt(
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  runs: readonly RunView[],
  segmentPrefix: string,
  leaseStartedAt: number,
  index: number,
): RunView | undefined {
  const threadKey = row.reviewThread?.threadKey ?? row.threadKey ?? instance.threadKey;
  const key = `${instance.id}:${segmentPrefix}/${index}/review`;
  const candidates = runs.filter(
    (run) =>
      run.finished &&
      run.status === "completed" &&
      run.agent === "review" &&
      run.parentInstanceId === instance.id &&
      isStepAttempt(run.idempotencyKey, key) &&
      run.userId === instance.userId &&
      run.repo?.toLowerCase() === instance.repo.toLowerCase() &&
      run.threadKey === threadKey &&
      run.startedAt >= leaseStartedAt &&
      run.verdict !== undefined &&
      fullHead(run.reviewHead) !== undefined &&
      run.reviewPost?.posted === true &&
      run.reviewPost.head === run.reviewHead &&
      run.reviewPost.verdict === run.verdict.verdict &&
      run.reviewPost.target.repo.toLowerCase() === instance.repo.toLowerCase() &&
      run.reviewPost.target.number === row.pr?.number,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** A continuation note buys recovery time only if the original, posted reviews
 * prove the same strict widening the live pipeline credited. Missing or
 * ambiguous evidence never creates a new slot on replay. */
function verifiedPatternContinuations(
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  runs: readonly RunView[],
  segmentPrefix: string,
  leaseStartedAt: number,
  throughRound: number,
): number | undefined {
  const credits = row.rounds.filter((note) => note.at >= leaseStartedAt && note.patternContinuation === true);
  if (credits.length > MAX_PATTERN_CONTINUATIONS || credits.some((note) => note.index < 2 || note.index > throughRound))
    return undefined;
  for (const note of credits) {
    const before = postedPatternReviewAt(instance, row, runs, segmentPrefix, leaseStartedAt, note.index - 1);
    const after = postedPatternReviewAt(instance, row, runs, segmentPrefix, leaseStartedAt, note.index);
    const boundaries = row.rounds.filter(
      (entry) =>
        entry.at >= leaseStartedAt &&
        entry.index === note.index &&
        entry.agent === "review" &&
        entry.outcome === note.outcome,
    );
    if (
      before === undefined ||
      after === undefined ||
      boundaries.length !== 1 ||
      note.outcome !== after.verdict!.verdict ||
      before.finishedAt === undefined ||
      before.finishedAt > after.startedAt ||
      after.finishedAt === undefined ||
      after.finishedAt > note.at ||
      !strictPatternWidening(
        before.verdict!.verdict === "request_changes"
          ? (before.verdict!.findings ?? [])
          : findingsAtOrAbove(before.verdict!.findings ?? [], instance.addressSeverity ?? DEFAULT_ADDRESS_SEVERITY),
        after.verdict!.verdict === "request_changes"
          ? (after.verdict!.findings ?? [])
          : findingsAtOrAbove(after.verdict!.findings ?? [], instance.addressSeverity ?? DEFAULT_ADDRESS_SEVERITY),
      )
    )
      return undefined;
  }
  return credits.length;
}

/** Recover one ended original unit without passing through generated-plan
 * hand-off. Every authoritative fact comes from the original durable rows,
 * their owned review record and one fresh GitHub read. */
export interface OriginalUnitRecoveryCaller {
  userId: string;
  threadKey: string;
  /** Original adapter event identity, never a model call or run-id fallback. */
  messageId?: string;
}

/** Adopt only the original child's accepted remote head. This never resumes
 *  its sandbox, replays its uncertain description, or grants another round. */
export async function adoptOriginalPublishedHead(
  body: Record<string, unknown>,
  deps: AdminCoordinatorDeps,
  caller?: OriginalUnitRecoveryCaller,
): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const at = (deps.clock ?? systemClock)();
  if (caller === undefined || !isRecoveryRequest(caller))
    return json(403, { ok: false, error: "adoption_caller_required", at });
  const instance = await deps.instances.get(id.value);
  if (instance === null) return json(404, { ok: false, error: "unknown_instance", at });
  const rows = await deps.instances.listUnits(instance.id);
  const matches = rows.filter((candidate) => candidate.unit === body.unit);
  if (matches.length !== 1) return json(409, { ok: false, error: "unit_evidence_ambiguous", at });
  let row = matches[0]!;
  if (
    caller.userId !== instance.userId ||
    caller.threadKey !== (row.threadKey ?? instance.threadKey) ||
    instance.base === undefined ||
    row.instanceId !== instance.id ||
    row.resume !== undefined ||
    row.recovery !== undefined ||
    (row.pr !== undefined && row.adoption?.state !== "bound") ||
    (row.publication !== undefined && row.adoption?.state !== "bound") ||
    row.ending === undefined ||
    row.idle !== undefined ||
    row.startedAt === undefined ||
    row.rounds.some((note) => note.agent !== "coding" || note.index !== 0)
  )
    return json(409, { ok: false, error: "adoption_identity_or_stage_mismatch", at });
  const branch = parsePlanBranch(row.branch);
  if (branch === undefined || branch.planId !== instance.plan?.id || branch.unitSlug !== row.slug)
    return json(409, { ok: false, error: "adoption_branch_mismatch", at });
  try {
    generatedTaskText(row.generatedTask, instance);
  } catch {
    return json(409, { ok: false, error: "adoption_task_unverified", at });
  }
  if (
    deps.listAnyPrByHead === undefined ||
    deps.createDraftPullRequest === undefined ||
    deps.verifyIdentitiesReadOnly === undefined ||
    deps.fetchBranchHeadSha === undefined
  )
    return json(503, { ok: false, error: "adoption_seam_unavailable", at });
  const listing = await deps.runs.listRuns({
    privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
    status: "all",
    visibleTo: EVERY_RUN,
    limit: RUN_LIST_MAX_LIMIT,
    recoveryEvidence: { instanceId: instance.id, unit: row.unit, threadKeys: [row.threadKey ?? instance.threadKey] },
  });
  if (
    listing.storeUnavailable ||
    listing.ledgerUnavailable ||
    listing.nextBefore !== undefined ||
    listing.runs.length >= RUN_LIST_MAX_LIMIT
  )
    return json(409, { ok: false, error: "adoption_ledger_incomplete", at });
  const key = `${instance.id}:${row.unit}/0/coding`;
  const children = listing.runs.filter((run) => run.idempotencyKey === key);
  if (children.length !== 1) return json(409, { ok: false, error: "child_evidence_ambiguous", at });
  const full = await deps.runs
    .getRun(children[0]!.id, {
      include: "messages",
      privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
    })
    .catch(() => undefined);
  if (!full?.ok) return json(409, { ok: false, error: "adoption_ledger_incomplete", at });
  const proof = publishedHeadEvidence({
    instance: {
      id: instance.id,
      repo: instance.repo,
      base: instance.base,
      userId: instance.userId,
      threadKey: instance.threadKey,
    },
    row: { ...row, startedAt: row.startedAt },
    run: full.value,
    runs: listing.runs,
  });
  if (!proof.ok) return json(409, { ok: false, error: proof.error, at });
  const head = proof.head;
  const actionId = await recoveryActionId(row, caller);
  const existing = row.adoption;
  if (
    existing?.state === "bound" &&
    (existing.pr === undefined ||
      row.pr?.number !== existing.pr.number ||
      row.pr?.url !== existing.pr.url ||
      row.lastPush !== head ||
      row.publication?.pr !== existing.pr.number ||
      row.publication?.expectedHeadSha !== head ||
      row.publication?.headRef !== row.branch ||
      row.publication?.baseRef !== instance.base)
  )
    return json(409, { ok: false, error: "adoption_pr_mismatch", at });
  if (
    existing !== undefined &&
    (existing.actionId !== actionId ||
      existing.headSha !== head ||
      existing.runId !== proof.runId ||
      existing.requester !== caller.userId ||
      existing.threadKey !== caller.threadKey ||
      existing.messageId !== caller.messageId)
  )
    return json(409, { ok: false, error: "adoption_already_claimed", at });
  const freshHead = await deps.fetchBranchHeadSha(instance.repo, row.branch).catch(() => undefined);
  if (freshHead !== head) return json(409, { ok: false, error: "adoption_head_moved", at });
  const ahead = await deps.commitsOverBase(instance.repo, instance.base, row.branch).catch(() => undefined);
  if (ahead === undefined || ahead <= 0) return json(409, { ok: false, error: "adoption_no_verified_commits", at });
  const identities = await deps
    .verifyIdentitiesReadOnly({
      repo: instance.repo,
      base: instance.base,
      branch: row.branch,
      expectedTip: head,
      startState: EMPTY_START_STATE,
      requester: instance.userId,
    })
    .catch(() => undefined);
  if (identities?.kind !== "clean" || identities.tip !== head)
    return json(409, { ok: false, error: "adoption_identity_unverified", at });
  const readPrs = async () => deps.listAnyPrByHead!(instance.repo, row.branch).catch(() => undefined);
  let prs = await readPrs();
  if (prs === undefined) return json(502, { ok: false, error: "github_unavailable", at });
  if (existing === undefined && prs.length !== 0) return json(409, { ok: false, error: "adoption_pr_exists", at });
  if (existing === undefined) {
    const claimed: CoordinatorUnit = {
      ...row,
      adoption: {
        version: 1,
        actionId,
        runId: proof.runId,
        headSha: head,
        requester: caller.userId,
        threadKey: caller.threadKey,
        messageId: caller.messageId,
        claimedAt: at,
        state: "claimed",
      },
    };
    const saved = await deps.instances.compareAndReplaceUnit(row, claimed).catch(() => undefined);
    if (saved?.ok !== true)
      return json(saved?.reason === "stale" ? 409 : 503, {
        ok: false,
        error: saved?.reason === "stale" ? "adoption_claim_stale" : "adoption_store_unavailable",
        at,
      });
    row = claimed;
  }
  const marker = `<!-- switchboard-adoption:${actionId}:${head} -->`;
  let mayPost = false;
  if (row.adoption?.state === "claimed") {
    const posting: CoordinatorUnit = { ...row, adoption: { ...row.adoption, state: "posting" } };
    const saved = await deps.instances.compareAndReplaceUnit(row, posting).catch(() => undefined);
    if (saved?.ok !== true)
      return json(saved?.reason === "stale" ? 409 : 503, {
        ok: false,
        error: saved?.reason === "stale" ? "adoption_claim_stale" : "adoption_store_unavailable",
        at,
      });
    row = posting;
    mayPost = true;
  }
  if (row.adoption?.state === "bound") {
    if (prs.length !== 1 || prs[0]?.number !== row.adoption.pr?.number || !prs[0]?.body.includes(marker))
      return json(409, { ok: false, error: "adoption_pr_mismatch", at });
  } else if (prs.length === 0 && mayPost) {
    // Recheck the ref after the durable claim. A lost create response leaves
    // this claim for a same-action retry; it never authorizes a second writer.
    if ((await deps.fetchBranchHeadSha(instance.repo, row.branch).catch(() => undefined)) !== head)
      return json(409, { ok: false, error: "adoption_head_moved", at });
    const subject = await deps.branchHeadSubject?.(instance.repo, row.branch).catch(() => undefined);
    const title =
      subject && checkPrTitle(subject, PR_TITLE_VOCABULARY).ok
        ? subject
        : recoveredFallbackTitle(row, row.branch, instance.plan?.id);
    const header = requestedByLine({
      name: instance.userName?.trim() || instance.userId,
      threadUrl: threadPageLink(instance.threadKey, deps.runPageBase?.replace(/\/runs\/?$/, "") ?? ""),
    });
    const prBody = `${header}\n\n${marker}\n\nOpened from the original unit's accepted pushed head \`${head}\`. The interrupted PR description and any later uncommitted sandbox work remain unverified. Review this committed head only.`;
    try {
      await deps.createDraftPullRequest({
        repo: instance.repo,
        headBranch: row.branch,
        base: instance.base,
        title,
        body: prBody,
      });
    } catch {
      // An accepted POST may have lost its response. Reconcile from GitHub.
    }
    prs = await readPrs();
    if (prs === undefined) return json(502, { ok: false, error: "github_unavailable", at });
  }
  if (prs.length === 0) return json(200, { ok: true, outcome: "indeterminate", head, at });
  const found = prs.length === 1 ? prs[0] : undefined;
  if (
    found?.state !== "open" ||
    found.draft !== true ||
    found.headSha !== head ||
    found.headRef !== row.branch ||
    found.baseRef !== instance.base ||
    !found.body.includes(marker) ||
    (await deps.fetchBranchHeadSha(instance.repo, row.branch).catch(() => undefined)) !== head
  )
    return json(409, { ok: false, error: "adoption_pr_mismatch", at });
  const facts = await deps.fetchPrFacts({ repo: instance.repo, number: found.number }).catch(() => undefined);
  if (
    facts?.state !== "open" ||
    facts.sameRepoHead !== true ||
    facts.headBranchExists !== true ||
    facts.headRef !== row.branch ||
    facts.baseRef !== instance.base ||
    facts.headSha !== head ||
    facts.verifiedHead?.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    facts.verifiedHead.ref !== row.branch ||
    facts.verifiedHead.sha !== head
  )
    return json(409, { ok: false, error: "adoption_pr_mismatch", at });
  if (row.adoption?.state === "bound")
    return json(200, { ok: true, outcome: "already_bound", pr: found.number, head, at });
  const owner = { instanceId: instance.id, unit: row.unit };
  try {
    if (deps.runnerOwnership?.claim(instance.repo, found.number, owner) !== true)
      return json(409, { ok: false, error: "publication_ownership_changed", at });
  } catch {
    return json(503, { ok: false, error: "publication_ownership_unknown", at });
  }
  const pr = { number: found.number, url: found.htmlUrl };
  const replacement: CoordinatorUnit = {
    ...row,
    pr,
    lastPush: head,
    publication: {
      repo: instance.repo,
      pr: pr.number,
      headRef: row.branch,
      baseRef: instance.base,
      expectedHeadSha: head,
      publicationRef: row.branch,
      owner,
    },
    adoption: { ...row.adoption!, state: "bound", pr },
  };
  const saved = await deps.instances.compareAndReplaceUnit(row, replacement).catch(() => undefined);
  deps.runnerOwnership?.release(instance.repo, found.number, owner);
  if (saved?.ok !== true)
    return json(saved?.reason === "stale" ? 409 : 503, {
      ok: false,
      error: saved?.reason === "stale" ? "adoption_claim_stale" : "adoption_store_unavailable",
      at,
    });
  return json(200, { ok: true, outcome: "bound", pr: found.number, url: found.htmlUrl, head, at });
}

/** A terminal first coding round has no PR owner to reserve. Its durable unit
 * CAS is the writer claim; the accepted push and ref are independently read
 * again before the new child starts. Local-only bytes provide no authority. */
async function recoverOriginalCodingUnit(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  request: RecoveryRequest | undefined,
  savedAction: RecoveryAction | null,
  requestedWorkflowId: string | undefined,
  at: number,
): Promise<IngressResponse> {
  if (request === undefined && (requestedWorkflowId === undefined || row.recovery?.kind !== "coding"))
    return json(409, { ok: false, error: "recovery_request_identity_required", at });
  if (instance.stop !== undefined || row.publication !== undefined || row.resume !== undefined || row.pr !== undefined)
    return json(409, { ok: false, error: "recovery_stage_ambiguous", at });
  const branch = parsePlanBranch(row.branch);
  if (
    instance.base === undefined ||
    branch === undefined ||
    branch.planId !== instance.plan?.id ||
    branch.unitSlug !== row.slug
  )
    return json(409, { ok: false, error: "recovery_binding_mismatch", at });
  try {
    generatedTaskText(row.generatedTask, instance);
  } catch {
    return json(409, { ok: false, error: "recovery_task_unverified", at });
  }
  const current = row.recovery;
  if (current !== undefined && current.kind !== "coding")
    return json(409, { ok: false, error: "recovery_stage_ambiguous", at });
  if (current === undefined && (row.idle !== undefined || row.ending === undefined))
    return json(409, { ok: false, error: "unit_not_terminal", at });
  if (current === undefined && row.recoveryReceipt?.codingRunId !== undefined)
    return json(409, { ok: false, error: "recovery_already_completed", at });
  if (current === undefined && !["aborted", "stopped", "interrupted", "failed"].includes(row.ending!.kind))
    return json(409, { ok: false, error: "recovery_ending_unsupported", at });
  if (
    row.segments?.length ||
    Object.keys(row.wakes ?? {}).length ||
    row.rounds.some((note) => note.agent !== "coding" || note.index !== 0)
  )
    return json(409, { ok: false, error: "recovery_stage_ambiguous", at });
  const caps = instance.caps;
  const grant = instance.grant;
  if (
    caps === undefined ||
    grant === undefined ||
    !Number.isSafeInteger(caps.maxRounds) ||
    caps.maxRounds < 1 ||
    !Number.isFinite(caps.maxMinutes) ||
    caps.maxMinutes <= 0 ||
    !Number.isSafeInteger(minutesToMs(caps.maxMinutes)) ||
    !Number.isSafeInteger(grant.renewals) ||
    grant.renewals < 0 ||
    grant.renewals > GRANT_RENEWALS_MAX ||
    (grant.costCapUsd !== undefined && (!Number.isFinite(grant.costCapUsd) || grant.costCapUsd <= 0)) ||
    row.startedAt === undefined ||
    !Number.isFinite(row.startedAt) ||
    row.startedAt > at ||
    (row.ending !== undefined && (row.ending.at < row.startedAt || row.ending.at > at))
  )
    return json(409, { ok: false, error: "recovery_budget_unknown", at });
  const deadlineAt = row.startedAt + minutesToMs(caps.maxMinutes);
  if (carve(deadlineAt - at, { kind: "coding", index: 0 }, { maxRounds: caps.maxRounds }).kind === "refused")
    return json(409, { ok: false, error: "recovery_wall_clock_exhausted", at });

  let claim = current;
  if (claim === undefined) {
    const listing = await deps.runs.listRuns({
      privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
      status: "all",
      visibleTo: EVERY_RUN,
      limit: RUN_LIST_MAX_LIMIT,
      recoveryEvidence: { instanceId: instance.id, unit: row.unit, threadKeys: [row.threadKey ?? instance.threadKey] },
    });
    if (
      listing.storeUnavailable ||
      listing.ledgerUnavailable ||
      listing.nextBefore !== undefined ||
      listing.runs.length >= RUN_LIST_MAX_LIMIT
    )
      return json(409, { ok: false, error: "recovery_evidence_incomplete", at });
    const key = `${instance.id}:${row.unit}/0/coding`;
    const matching = listing.runs.filter((run) => run.idempotencyKey === key);
    const coding = matching.length === 1 ? matching[0] : undefined;
    const settlement =
      coding === undefined ? undefined : publicationSettlementForRun(coding.publicationSettlement, coding);
    if (
      coding === undefined ||
      listing.runs.some(
        (run) =>
          run.doorPublicationPending?.owner?.instanceId === instance.id &&
          run.doorPublicationPending.owner.unit === row.unit,
      ) ||
      listing.runs.some(
        (run) =>
          !run.finished &&
          (run.parentInstanceId === instance.id || run.idempotencyKey?.startsWith(`${instance.id}:${row.unit}/`)),
      ) ||
      coding.parentInstanceId !== instance.id ||
      coding.agent !== "coding" ||
      coding.userId !== instance.userId ||
      coding.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
      coding.threadKey !== (row.threadKey ?? instance.threadKey) ||
      !coding.finished ||
      coding.headSha === undefined ||
      !fullHead(coding.headSha) ||
      coding.pushed?.filter((push) => push.ref === row.branch && push.sha === coding.headSha).length !== 1 ||
      coding.pushed?.some((push) => push.ref !== row.branch) === true ||
      settlement?.binding.branch !== row.branch ||
      settlement?.checkpoint.kind !== "created" ||
      settlement.checkpoint.head !== coding.headSha ||
      settlement.publication.kind !== "accepted" ||
      settlement.publication.head !== coding.headSha ||
      settlement.release.kind !== "released" ||
      settlement.release.leftBehind !== undefined ||
      (row.lastPush !== undefined && row.lastPush !== coding.headSha)
    )
      return json(409, { ok: false, error: "recovery_work_unverified", at });
    const spend = await historicalRecoverySpend(instance, row, listing.runs, deps.runs);
    if ("reason" in spend) return json(409, { ok: false, error: "recovery_budget_unknown", reason: spend.reason, at });
    if (grant.costCapUsd !== undefined && spend.usd >= grant.costCapUsd)
      return json(409, {
        ok: false,
        error: "recovery_cost_cap_exhausted",
        spendUsd: spend.usd,
        costCapUsd: grant.costCapUsd,
        at,
      });
    claim = {
      kind: "coding",
      round: 0,
      codingRunId: coding.id,
      codingKey: key,
      expectedHeadSha: coding.headSha,
      accounting: {
        spendUsd: spend.usd,
        children: spend.children,
        grant: { ...grant },
        ...(instance.grantSource !== undefined ? { grantSource: instance.grantSource } : {}),
        renewalsSpent: 0,
      },
      remainingMs: deadlineAt - at,
      claimedAt: at,
      step: `${row.unit}/recovery/0/coding`,
      previousEnding: row.ending!,
      ...(row.lastPush !== undefined ? {} : { previousBinding: {} }),
      workflowId: `recovery-coding-${coding.id}`,
      deadlineAt,
    };
  }
  if (requestedWorkflowId !== undefined && requestedWorkflowId !== claim.workflowId)
    return json(409, { ok: false, error: "recovery_claim_mismatch", at });
  if (
    savedAction !== null &&
    (savedAction.codingRunId !== claim.codingRunId || savedAction.workflowId !== claim.workflowId)
  )
    return json(409, { ok: false, error: "recovery_claim_mismatch", at });
  if (claim.accounting.grant.costCapUsd !== grant.costCapUsd || claim.accounting.grant.renewals !== grant.renewals)
    return json(409, { ok: false, error: "recovery_budget_unknown", at });
  const head = await deps.fetchBranchHeadSha?.(instance.repo, row.branch).catch(() => undefined);
  if (head === undefined) return json(409, { ok: false, error: "recovery_ref_unavailable", at });
  if (head !== claim.expectedHeadSha) return json(409, { ok: false, error: "recovery_head_moved", at });
  const [open, merged] = await Promise.all([
    deps.findOpenPrByHead(instance.repo, row.branch).catch(() => undefined),
    deps.findMergedPrByHead(instance.repo, row.branch).catch(() => undefined),
  ]);
  if (open === undefined || merged === undefined) return json(409, { ok: false, error: "github_unavailable", at });
  if (open !== null || merged !== null) return json(409, { ok: false, error: "recovery_stage_changed", at });
  if (at >= claim.deadlineAt) return json(409, { ok: false, error: "recovery_wall_clock_exhausted", at });

  let claimed = row;
  if (current === undefined) {
    const { ending: _ending, ...active } = row;
    const replacement: CoordinatorUnit = {
      ...active,
      lastPush: head,
      recovery: claim,
    };
    const result = await deps.instances
      .transitionRecovery({ kind: "claim", expected: row, replacement, request: request! })
      .catch(() => undefined);
    if (result?.ok !== true)
      return json(result?.reason === "stale" ? 409 : 503, {
        ok: false,
        error: result?.reason === "stale" ? "recovery_claim_stale" : "recovery_store_unavailable",
        at,
      });
    claimed = result.unit;
  }
  const codingClaim = claimed.recovery;
  if (codingClaim?.kind !== "coding") return json(409, { ok: false, error: "recovery_claim_mismatch", at });
  const rollback = async (error: string, consumed = false): Promise<IngressResponse> => {
    const { recovery: _claim, history: _history, ...rest } = claimed;
    const replacement: CoordinatorUnit = {
      ...rest,
      ending: codingClaim.previousEnding,
      ...(codingClaim.previousBinding !== undefined ? { lastPush: codingClaim.previousBinding.lastPush } : {}),
      ...(consumed
        ? { recoveryReceipt: { codingRunId: codingClaim.codingRunId, workflowId: codingClaim.workflowId, at } }
        : {}),
    };
    const result = await deps.instances
      .transitionRecovery({ kind: "refuse", expected: claimed, replacement, error, consumed })
      .catch(() => undefined);
    if (result?.ok !== true) return json(500, { ok: false, error: "recovery_rollback_failed", cause: error, at });
    return json(409, { ok: false, error, at });
  };
  if (requestedWorkflowId !== undefined)
    return json(200, {
      ok: true,
      parentInstanceId: instance.id,
      unit: row.unit,
      workflowId: codingClaim.workflowId,
      at,
    });
  if (current !== undefined) {
    const status = await deps.recoveryStatus?.(codingClaim.workflowId).catch(() => ({ kind: "unanswered" as const }));
    if (status?.kind === "status") {
      if (["complete", "errored", "terminated"].includes(status.status))
        return rollback("recovery_workflow_terminal", true);
      return json(200, {
        ok: true,
        outcome: "already_started",
        parentInstanceId: instance.id,
        unit: row.unit,
        workflowId: codingClaim.workflowId,
        at,
      });
    }
    if (status?.kind !== "absent")
      return json(200, {
        ok: true,
        outcome: "indeterminate",
        parentInstanceId: instance.id,
        unit: row.unit,
        workflowId: codingClaim.workflowId,
        at,
      });
  }
  const reread = await deps.fetchBranchHeadSha?.(instance.repo, row.branch).catch(() => undefined);
  if (reread !== codingClaim.expectedHeadSha) return rollback("recovery_head_moved");
  const started = await deps
    .startRecovery?.(codingClaim.workflowId, {
      kind: "recover-original-unit",
      parentInstanceId: instance.id,
      unit: row.unit,
    })
    .catch(() => ({ kind: "unanswered" as const }));
  if (started === undefined) return rollback("recovery_workflow_unavailable");
  if (started.kind === "failed") return rollback("recovery_workflow_failed");
  if (
    started.kind === "duplicate" &&
    started.status !== undefined &&
    ["complete", "errored", "terminated"].includes(started.status)
  )
    return rollback("recovery_workflow_terminal", true);
  return json(200, {
    ok: true,
    outcome:
      started.kind === "created" ? "started" : started.kind === "duplicate" ? "already_started" : "indeterminate",
    parentInstanceId: instance.id,
    unit: row.unit,
    workflowId: codingClaim.workflowId,
    at,
  });
}

export async function recoverOriginalUnit(
  body: Record<string, unknown>,
  deps: AdminCoordinatorDeps,
  caller?: OriginalUnitRecoveryCaller,
): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (instance === null) return json(404, { ok: false, error: "unknown_instance", at });
  const requestedWorkflowId = typeof body.workflowId === "string" ? body.workflowId : undefined;
  const renew = body.renew === true;
  if (body.renew !== undefined && body.renew !== true)
    return json(400, { ok: false, error: "recovery_renewal_invalid", at });
  if (renew && requestedWorkflowId !== undefined)
    return json(409, { ok: false, error: "recovery_renewal_requester_required", at });
  if (caller === undefined && requestedWorkflowId === undefined)
    return json(403, { ok: false, error: "recovery_caller_required", at });
  if (caller !== undefined && caller.userId !== instance.userId)
    return json(403, { ok: false, error: "recovery_requester_mismatch", at });
  const rows = await deps.instances.listUnits(instance.id);
  const matches = rows.filter((candidate) => candidate.unit === body.unit);
  if (matches.length !== 1) return json(409, { ok: false, error: "unit_evidence_ambiguous", at });
  const row = matches[0]!;
  if (row.instanceId !== instance.id) return json(409, { ok: false, error: "recovery_identity_mismatch", at });
  if (caller !== undefined && caller.threadKey !== (row.threadKey ?? instance.threadKey))
    return json(403, { ok: false, error: "recovery_requester_mismatch", at });
  const request: RecoveryRequest | undefined = caller !== undefined && isRecoveryRequest(caller) ? caller : undefined;
  if (caller !== undefined && request === undefined)
    return json(409, { ok: false, error: "recovery_request_identity_required", at });
  let savedAction: RecoveryAction | null;
  try {
    savedAction = request === undefined ? null : await deps.instances.getRecoveryAction(row, request);
  } catch {
    return json(503, { ok: false, error: "recovery_history_unavailable", at });
  }
  if (savedAction !== null) {
    if (
      savedAction.repo !== instance.repo ||
      savedAction.base !== instance.base ||
      savedAction.branch !== row.branch ||
      savedAction.mainThreadKey !== instance.threadKey ||
      savedAction.workerThreadKey !== (row.threadKey ?? instance.threadKey) ||
      savedAction.actId !== row.workBrief?.actId
    )
      return json(409, { ok: false, error: "recovery_identity_mismatch", at });
    if (savedAction.state === "refused") {
      // A refusal can commit while every response is lost. Only its action
      // may release the old fence; the same unit can already have a successor.
      if (row.pr !== undefined)
        deps.runnerOwnership?.release(instance.repo, row.pr.number, {
          instanceId: instance.id,
          unit: row.unit,
          recoveryActionId: savedAction.id,
        });
      return json(409, { ok: false, error: savedAction.error, workflowId: savedAction.workflowId, at });
    }
    if (savedAction.state === "settled")
      return json(200, {
        ok: true,
        outcome: "already_completed",
        workflowId: savedAction.workflowId,
        parentInstanceId: instance.id,
        unit: row.unit,
        at,
      });
    if (row.recovery?.actionId !== savedAction.id)
      return json(409, { ok: false, error: "recovery_claim_mismatch", at });
  } else if (request !== undefined && row.recovery?.actionId !== undefined)
    return json(409, { ok: false, error: "recovery_already_claimed", workflowId: row.recovery.workflowId, at });
  if (row.recovery === undefined && instance.admission === "unreconciled")
    return json(409, { ok: false, error: "recovery_admission_unreconciled", at });
  if (row.idle !== undefined && row.ending !== undefined)
    return json(409, { ok: false, error: "unit_lifecycle_ambiguous", at });

  if (row.pr === undefined && (row.recovery === undefined || row.recovery.kind === "coding"))
    return renew
      ? json(409, { ok: false, error: "recovery_renewal_stage_unsupported", at })
      : recoverOriginalCodingUnit(deps, instance, row, request, savedAction, requestedWorkflowId, at);

  const originalOwner = { instanceId: instance.id, unit: row.unit };
  let publication = row.publication;
  const pr = row.pr;
  const base = instance.base;
  // A step-threw ending after findings/pr-check carries no `headSha`, so
  // unit-end cannot populate `lastPush`. The existing publication binding is
  // still the durable reviewed-head authority; completed findings evidence
  // below may advance it, but an absent optional continuation hint must not
  // hide that authority. A verified review-target move can leave lastPush at
  // the last attributed push; the owned review and fresh PR facts below prove
  // the newer target before recovery can claim it.
  let expectedHead = publication?.expectedHeadSha ?? row.lastPush;
  if (
    pr === undefined ||
    base === undefined ||
    (row.lastPush !== undefined && !fullHead(row.lastPush)) ||
    (expectedHead !== undefined && !fullHead(expectedHead)) ||
    (publication !== undefined &&
      (publication.repo.toLowerCase() !== instance.repo.toLowerCase() ||
        publication.pr !== pr.number ||
        publication.headRef !== row.branch ||
        publication.baseRef !== base ||
        publication.publicationRef !== row.branch ||
        !fullHead(publication.expectedHeadSha) ||
        !samePublicationOwner(publication.owner, originalOwner)))
  )
    return json(409, { ok: false, error: "recovery_binding_mismatch", at });

  // Legacy round notes retain the check outcome, but not the typed findings
  // or their dispositions. An earlier failed check cannot authorize a later
  // findings child merely because another review followed it.
  if (row.rounds.some((note) => note.outcome === "checks_failed"))
    return json(409, {
      ok: false,
      error: "recovery_checks_evidence_unavailable",
      reason: "check_findings_not_retained",
      at,
    });

  const existingClaim = row.recovery?.kind === "coding" ? undefined : row.recovery;
  let kind: "findings" | "review";
  let round: number;
  let patternContinuations: number;
  let remainingMs: number;
  let reviewRunId: string;
  let stepName: string;
  let workflowId: string;
  let reviewKey: string;
  let deadlineAt: number;
  let findings: Finding[] | undefined;
  let priorFindings: Finding[] | undefined;
  let findingsRunId: string | undefined;
  let findingsKey: string | undefined;
  let savedPatch: SavedFindingsPatch | undefined;
  let bundleHistory: RunView[] | undefined;
  let externalReview: RecoveryReviewEvidence | undefined;
  let accounting: RecoveryAccounting | undefined;
  let claimRow = row;
  let noWorkFindings = false;
  let reviewStartEvidence: RecoveryReviewStartDiagnostic | undefined;
  let renewalEvidence: RunView[] | undefined;
  let reviewStartHistory: RunView[] | undefined;
  let facts: PullRequestFacts | undefined;
  let originalRow: CoordinatorUnit | undefined;
  if (existingClaim !== undefined) {
    ({
      kind,
      round,
      remainingMs,
      reviewRunId,
      step: stepName,
      workflowId,
      reviewKey,
      deadlineAt,
      findings,
      priorFindings,
      findingsRunId,
      findingsKey,
      patch: savedPatch,
      externalReview,
      accounting,
    } = existingClaim);
    patternContinuations = existingClaim.patternContinuations ?? 0;
    if (requestedWorkflowId === undefined && renew !== (existingClaim.renewed === true))
      return json(409, { ok: false, error: "recovery_claim_mismatch", at });
    if (
      !Number.isSafeInteger(patternContinuations) ||
      patternContinuations < 0 ||
      patternContinuations > MAX_PATTERN_CONTINUATIONS ||
      (kind === "findings"
        ? round >= (instance.caps?.maxRounds ?? 0) + patternContinuations
        : round > (instance.caps?.maxRounds ?? 0) + patternContinuations)
    )
      return json(409, { ok: false, error: "recovery_rounds_exhausted", at });
    if (externalReview !== undefined && requestedWorkflowId === undefined && savedAction === null)
      return json(409, { ok: false, error: "recovery_already_claimed", workflowId, at });
    if (
      (instance.grant?.costCapUsd !== undefined && accounting === undefined) ||
      (accounting !== undefined &&
        (accounting.grant.renewals !== instance.grant?.renewals ||
          accounting.grant.costCapUsd !== instance.grant?.costCapUsd))
    )
      return json(409, { ok: false, error: "recovery_budget_unknown", reason: "grant_carry_mismatch", at });
    if (
      publication === undefined ||
      existingClaim.expectedHeadSha !== expectedHead ||
      publication.expectedHeadSha !== expectedHead
    )
      return json(409, { ok: false, error: "recovery_binding_mismatch", at });
    const { recovery: _recovery, ...withoutRecovery } = row;
    originalRow = { ...withoutRecovery, ending: existingClaim.previousEnding };
    if (existingClaim.previousBinding !== undefined) {
      const { publication: _publication, lastPush: _lastPush, ...prior } = originalRow;
      originalRow = { ...prior, ...existingClaim.previousBinding };
    }
  } else {
    if (row.idle !== undefined || row.ending === undefined)
      return json(409, { ok: false, error: "unit_not_terminal", at });
    let boundaryPosition = -1;
    for (let index = row.rounds.length - 1; index >= 0; index -= 1)
      if (row.rounds[index]!.agent === "review" && row.rounds[index]!.outcome !== "started") {
        boundaryPosition = index;
        break;
      }
    const boundary = boundaryPosition >= 0 ? row.rounds[boundaryPosition] : undefined;
    // Check failures are synthesized findings, not the approving review's
    // findings. The legacy row retained only the outcome word, so neither
    // that approval nor a later push proves the check-disposition contract.
    if (boundary?.outcome === "checks_failed")
      return json(409, {
        ok: false,
        error: "recovery_checks_evidence_unavailable",
        reason: "check_findings_not_retained",
        at,
      });
    const postApproval = boundary?.outcome === "approve" && row.ending.kind === "merge_ready";
    if (
      boundary === undefined ||
      (!postApproval && boundary.outcome !== "request_changes" && boundary.outcome !== "no_verdict")
    )
      return json(409, { ok: false, error: "recovery_ending_unsupported", at });
    const laterReviewStarts = row.rounds.slice(boundaryPosition + 1).filter((note) => note.agent === "review");
    if (
      laterReviewStarts.length > 0 &&
      (boundary.outcome !== "request_changes" ||
        row.ending.kind !== "failed" ||
        row.ending.cause !== "step_threw" ||
        row.ending.round !== boundary.index + 1 ||
        !new RegExp(`^${row.unit}/note/[1-9][0-9]*$`).test(row.ending.step ?? "") ||
        laterReviewStarts.some((note) => note.outcome !== "started" || note.index !== boundary.index + 1) ||
        row.rounds.at(-1) !== laterReviewStarts.at(-1))
    )
      return json(409, { ok: false, error: "recovery_stage_ambiguous", at });
    kind = boundary.outcome === "request_changes" ? "findings" : "review";
    if (kind === "review" && !postApproval && row.ending.kind !== "no_verdict")
      return json(409, { ok: false, error: "recovery_ending_mismatch", at });
    round = boundary.index;
    const caps = instance.caps;
    const unknownBudget = (reason: string) => json(409, { ok: false, error: "recovery_budget_unknown", reason, at });
    if (caps === undefined) return unknownBudget("caps_missing");
    if (
      !Number.isSafeInteger(caps.maxRounds) ||
      caps.maxRounds < 1 ||
      !Number.isFinite(caps.maxMinutes) ||
      caps.maxMinutes <= 0 ||
      !Number.isSafeInteger(minutesToMs(caps.maxMinutes))
    )
      return unknownBudget("caps_invalid");
    if (row.startedAt === undefined) return unknownBudget("started_at_missing");
    if (!Number.isFinite(row.startedAt) || row.startedAt > at) return unknownBudget("started_at_invalid");
    if (!Number.isFinite(row.ending.at) || row.ending.at < row.startedAt || row.ending.at > at)
      return unknownBudget("ending_at_invalid");
    // Absence is not an uncapped historical grant. In particular, today's
    // configuration cannot prove the terms under which an old unit ran.
    const grant = instance.grant;
    if (grant === undefined) return unknownBudget("grant_missing");
    if (
      !Number.isSafeInteger(grant.renewals) ||
      grant.renewals < 0 ||
      grant.renewals > GRANT_RENEWALS_MAX ||
      (grant.costCapUsd !== undefined && (!Number.isFinite(grant.costCapUsd) || grant.costCapUsd <= 0))
    )
      return unknownBudget("grant_invalid");
    // Ordinary recovery resumes the active segment's original wall-clock
    // lease. A grant-backed renewal below is admitted only after proven
    // no-work findings failure and claims its own bounded lease. A stopped
    // segment can carry the smaller unspent lease on its durable wake answer.
    const latestSegmentIndex = row.segments?.reduce((latest, candidate) => Math.max(latest, candidate.index), 1) ?? 1;
    const latestSegments = row.segments?.filter((candidate) => candidate.index === latestSegmentIndex) ?? [];
    if (latestSegments.length > 1) return unknownBudget("latest_segment_ambiguous");
    const segments = row.segments ?? [];
    if (segments.some((entry, index) => entry.index !== index + 2)) return unknownBudget("segment_history_invalid");
    if (
      segments.some(
        (entry, index) =>
          !Number.isFinite(entry.at) ||
          entry.at < (segments[index - 1]?.at ?? row.startedAt!) ||
          entry.at > row.ending!.at,
      )
    )
      return unknownBudget("segment_time_invalid");
    if (segments.length > grant.renewals) return unknownBudget("segment_grant_exhausted");
    const segment = latestSegments[0];
    const leaseStartedAt = segment?.at ?? row.startedAt;
    for (const [key, answer] of Object.entries(row.wakes ?? {})) {
      if (answer.kind !== "segment") continue;
      // A wake belongs to the segment that was idle, not the next segment it
      // grants. A same-segment wake instead carries a smaller resumed lease.
      const origin = answer.leaseMs === undefined ? answer.index - 1 : answer.index;
      const prefix = stepPrefixOf(
        row.unit,
        origin > 1 ? { segment: origin, renewalsSpent: 0, spendUsd: null } : undefined,
      );
      if (
        !Number.isSafeInteger(answer.index) ||
        answer.index < 1 ||
        answer.index > latestSegmentIndex ||
        origin < 1 ||
        !key.startsWith(`${prefix}/`) ||
        !/^(?:r[1-9][0-9]*\/)?idle\/[1-9][0-9]*$/.test(key.slice(prefix.length + 1))
      )
        return unknownBudget("wake_origin_invalid");
    }
    let previousRoundAt = row.startedAt;
    const reviewCounts = new Map<number, number>();
    for (const entry of row.rounds) {
      if (
        (entry.agent !== "review" && entry.agent !== "coding") ||
        !Number.isSafeInteger(entry.index) ||
        entry.index < (entry.agent === "review" ? 1 : 0) ||
        !Number.isFinite(entry.at) ||
        entry.at < previousRoundAt ||
        entry.at > row.ending.at
      )
        return unknownBudget("round_history_invalid");
      if (entry.agent === "review" && entry.outcome === "started") {
        const segmentIndex = segments.filter((segment) => segment.at <= entry.at).at(-1)?.index ?? 1;
        const previous = reviewCounts.get(segmentIndex) ?? 0;
        if (entry.index !== previous + 1 && !(laterReviewStarts.includes(entry) && entry.index === previous))
          return unknownBudget("round_history_invalid");
        reviewCounts.set(segmentIndex, entry.index);
      }
      previousRoundAt = entry.at;
    }
    const started = row.rounds
      .slice(0, boundaryPosition)
      .filter((entry) => entry.agent === "review" && entry.outcome === "started" && entry.index === boundary.index)
      .at(-1);
    if (started === undefined) return unknownBudget("round_history_invalid");
    if (started.at < leaseStartedAt) return unknownBudget("segment_round_mismatch");
    const resumedLeases = Object.values(row.wakes ?? {}).filter(
      (answer) => answer.kind === "segment" && answer.index === latestSegmentIndex && answer.leaseMs !== undefined,
    );
    // A stopped-segment wake stores the remaining lease but not when that
    // smaller lease began. Subtracting from the original segment time would
    // invent a budget, so this legacy shape is unrecoverable.
    if (resumedLeases.length > 0) return unknownBudget("resume_time_missing");
    remainingMs = minutesToMs(caps.maxMinutes) - (at - leaseStartedAt);
    const reviewThreadKey = row.reviewThread?.threadKey ?? row.threadKey ?? instance.threadKey;
    const unitThreadKey = row.threadKey ?? instance.threadKey;
    // Query both identity claims across threads before selecting review/coding
    // evidence. Unrelated global history must not consume the evidence bound.
    const listing = await deps.runs.listRuns({
      privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
      status: "all",
      visibleTo: EVERY_RUN,
      limit: RUN_LIST_MAX_LIMIT,
      recoveryEvidence: { instanceId: instance.id, unit: row.unit, threadKeys: [unitThreadKey, reviewThreadKey] },
    });
    const segmentPrefix = stepPrefixOf(
      row.unit,
      latestSegmentIndex > 1 ? { segment: latestSegmentIndex, renewalsSpent: 0, spendUsd: null } : undefined,
    );
    if (
      listing.storeUnavailable ||
      listing.ledgerUnavailable ||
      listing.nextBefore !== undefined ||
      // A full live-only page carries no cursor but can still hide children.
      listing.runs.length >= RUN_LIST_MAX_LIMIT
    )
      return json(409, {
        ok: false,
        error: "recovery_evidence_incomplete",
        ...(laterReviewStarts.length > 0 ? { diagnostic: unavailableReviewStart("history_incomplete") } : {}),
        at,
      });
    const histories = new Map<string, RunView>();
    for (const run of listing.runs) {
      const previous = histories.get(run.id);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(run))
        return unknownBudget("child_history_ambiguous");
      histories.set(run.id, run);
    }
    const credited = verifiedPatternContinuations(
      instance,
      row,
      [...histories.values()],
      segmentPrefix,
      leaseStartedAt,
      round,
    );
    if (credited === undefined) return json(409, { ok: false, error: "recovery_continuation_evidence_ambiguous", at });
    patternContinuations = credited;
    // The boundary itself must still leave a review slot; only a completed
    // findings child below may advance directly to that last review index.
    if (round >= caps.maxRounds + patternContinuations)
      return json(409, { ok: false, error: "recovery_rounds_exhausted", at });
    // Do not renew a terminal unit over an earlier uncertain Git-door write.
    // This is a durable run-record fact, independent of the current PR head.
    if (
      [...histories.values()].some(
        (run) =>
          run.finished &&
          run.parentInstanceId === instance.id &&
          run.agent === "coding" &&
          run.doorPublicationPending?.owner?.instanceId === instance.id &&
          run.doorPublicationPending.owner?.unit === row.unit,
      )
    )
      return json(409, { ok: false, error: "door_publication_unresolved", at });
    if (grant.costCapUsd !== undefined && histories.size === 0) return unknownBudget("cost_cap_spend_unknown");
    const spend = await historicalRecoverySpend(instance, row, [...histories.values()], deps.runs);
    if ("reason" in spend)
      return laterReviewStarts.length > 0
        ? json(spend.reason === "review_start_store_unavailable" ? 503 : 409, {
            ok: false,
            error:
              spend.reason === "review_start_store_unavailable"
                ? "recovery_history_unavailable"
                : "recovery_budget_unknown",
            reason: spend.reason,
            diagnostic: unavailableReviewStart(spend.reason),
            at,
          })
        : unknownBudget(spend.reason);
    if (
      laterReviewStarts.length > 0 &&
      (spend.noWorkReviews.length !== 1 ||
        listing.runs.filter((run) => run.id === spend.noWorkReviews[0]).length !== 1 ||
        listing.runs.find((run) => run.id === spend.noWorkReviews[0])?.idempotencyKey !==
          `${instance.id}:${segmentPrefix}/${boundary.index + 1}/review`)
    )
      return json(409, {
        ok: false,
        error: "recovery_review_evidence_ambiguous",
        diagnostic: unavailableReviewStart("review_child_ambiguous"),
        at,
      });
    if (grant.costCapUsd !== undefined && spend.usd >= grant.costCapUsd)
      return json(409, {
        ok: false,
        error: "recovery_cost_cap_exhausted",
        spendUsd: spend.usd,
        costCapUsd: grant.costCapUsd,
        at,
      });
    if (grant.costCapUsd !== undefined || postApproval)
      accounting = {
        spendUsd: spend.usd,
        children: spend.children,
        grant: { ...grant },
        ...(instance.grantSource !== undefined ? { grantSource: instance.grantSource } : {}),
        renewalsSpent: latestSegmentIndex - 1,
      };
    if (postApproval) {
      if (
        publication === undefined ||
        expectedHead !== publication.expectedHeadSha ||
        row.rounds.slice(boundaryPosition + 1).length > 0
      )
        return json(409, { ok: false, error: "recovery_binding_mismatch", at });
      if (
        [...histories.values()].some(
          (run) =>
            (!run.finished && (run.agent === "coding" || run.agent === "review")) ||
            (run.pushed?.some((push) => push.ref === row.branch) &&
              (run.finishedAt === undefined ||
                run.finishedAt > boundary.at ||
                (run.finishedAt >= row.startedAt! && !run.idempotencyKey?.startsWith(`${instance.id}:${row.unit}/`)))),
        )
      )
        return json(409, { ok: false, error: "recovery_child_active", at });
    }
    const reviewRuns = listing.runs.filter((run) => run.threadKey === reviewThreadKey);
    const unitRuns = listing.runs.filter((run) => run.threadKey === unitThreadKey);
    const reviewKeyPrefix = `${instance.id}:${segmentPrefix}/${round}/review`;
    const candidates = reviewRuns.filter((run) => {
      if (
        !run.finished ||
        run.agent !== "review" ||
        run.parentInstanceId !== instance.id ||
        !isStepAttempt(run.idempotencyKey, reviewKeyPrefix) ||
        run.userId !== instance.userId ||
        run.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
        run.threadKey !== reviewThreadKey
      )
        return false;
      const originalFindingsHead =
        kind === "findings" &&
        row.ending?.kind === "aborted" &&
        fullHead(row.lastPush) !== undefined &&
        run.reviewHead === row.lastPush &&
        publication !== undefined &&
        publication.expectedHeadSha !== row.lastPush;
      const precedingFindingsHead =
        laterReviewStarts.length > 0 &&
        row.lastPush === publication?.expectedHeadSha &&
        run.reviewHead !== row.lastPush;
      if (
        !fullHead(run.reviewHead) ||
        (publication !== undefined &&
          run.reviewHead !== publication.expectedHeadSha &&
          !originalFindingsHead &&
          !precedingFindingsHead)
      )
        return false;
      const reviewedHead = run.reviewHead;
      if (postApproval)
        return (
          run.status === "completed" &&
          run.verdict?.verdict === "approve" &&
          run.reviewPost?.posted === true &&
          run.reviewPost.verdict === "approve" &&
          run.reviewPost.head === reviewedHead &&
          run.reviewPost.target.repo.toLowerCase() === instance.repo.toLowerCase() &&
          run.reviewPost.target.number === pr.number &&
          run.finishedAt !== undefined &&
          run.finishedAt <= boundary.at &&
          boundary.at <= row.ending!.at
        );
      if (kind === "review") return run.verdict === undefined && run.reviewPost === undefined;
      return (
        run.verdict?.verdict === "request_changes" &&
        run.reviewHead === reviewedHead &&
        run.reviewPost?.posted === true &&
        run.reviewPost.head === reviewedHead &&
        run.reviewPost.verdict === "request_changes" &&
        run.reviewPost.target.repo.toLowerCase() === instance.repo.toLowerCase() &&
        run.reviewPost.target.number === pr.number
      );
    });
    if (candidates.length !== 1) return json(409, { ok: false, error: "recovery_review_evidence_ambiguous", at });
    const review = candidates[0]!;
    const reviewedHead = review.reviewHead!;
    if (publication === undefined) {
      if (
        reviewRuns.filter(
          (run) => run.parentInstanceId === instance.id && isStepAttempt(run.idempotencyKey, reviewKeyPrefix),
        ).length !== 1
      )
        return json(409, { ok: false, error: "recovery_review_evidence_ambiguous", at });
      if (
        [...reviewRuns, ...unitRuns].some((run) => !run.finished && (run.agent === "coding" || run.agent === "review"))
      )
        return json(409, { ok: false, error: "recovery_child_active", at });
      // The PR may have been opened by the runner after coding ended, so a
      // missing pr_opened event is not a missing push. Require the exact ref
      // receipt plus observed final head before the uniquely owned review.
      const codingKey = `${instance.id}:${segmentPrefix}/${round === 1 ? "0/coding" : `${round - 1}/findings`}`;
      const coding = unitRuns.filter(
        (run) => run.parentInstanceId === instance.id && isStepAttempt(run.idempotencyKey, codingKey),
      );
      const child = coding.length === 1 ? coding[0] : undefined;
      if (
        child?.finished !== true ||
        child.status !== "completed" ||
        child.agent !== "coding" ||
        child.userId !== instance.userId ||
        child.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
        child.threadKey !== unitThreadKey ||
        child.headSha !== reviewedHead ||
        child.pushed?.some((push) => push.ref === row.branch && push.sha === reviewedHead) !== true ||
        (child.pr !== undefined &&
          (child.pr.number !== pr.number || (child.pr.head !== undefined && child.pr.head !== row.branch))) ||
        child.finishedAt === undefined ||
        child.startedAt < leaseStartedAt ||
        child.finishedAt > review.startedAt ||
        review.finishedAt === undefined ||
        review.finishedAt > row.ending.at ||
        (expectedHead !== undefined && expectedHead !== reviewedHead)
      )
        return json(409, { ok: false, error: "recovery_binding_evidence_ambiguous", at });
      publication = {
        repo: instance.repo,
        pr: pr.number,
        headRef: row.branch,
        baseRef: base,
        expectedHeadSha: reviewedHead,
        publicationRef: row.branch,
        owner: originalOwner,
      };
      expectedHead = reviewedHead;
      claimRow = { ...row, lastPush: reviewedHead, publication };
    }
    reviewRunId = review.id;
    reviewKey = review.idempotencyKey!;
    if (postApproval) {
      externalReview = await laterRecoveryReview(deps, instance, pr, reviewedHead, row.ending.at, at);
      if (externalReview === undefined) return json(409, { ok: false, error: "recovery_later_review_invalid", at });
      round = boundary.index + 1;
      // Leave room for the typed findings fix and its independent re-review.
      if (round >= caps.maxRounds + patternContinuations)
        return json(409, { ok: false, error: "recovery_rounds_exhausted", at });
    }
    try {
      facts = await deps.fetchPrFacts({ repo: instance.repo, number: pr.number });
    } catch (err) {
      return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
    }
    if (facts === undefined) return json(502, { ok: false, error: "github_unavailable", at });
    const verified = facts.verifiedHead;
    if (
      facts.state !== "open" ||
      facts.sameRepoHead !== true ||
      facts.headBranchExists !== true ||
      facts.headRef !== row.branch ||
      facts.baseRef !== base ||
      !fullHead(facts.headSha) ||
      verified === undefined ||
      verified.repo.toLowerCase() !== instance.repo.toLowerCase() ||
      verified.ref !== row.branch ||
      verified.sha !== facts.headSha
    )
      return json(409, { ok: false, error: "recovery_facts_mismatch", at });

    const findingsStep = `${segmentPrefix}/${boundary.index}/findings`;
    const findingsPrefix = `${instance.id}:${findingsStep}`;
    const headMoved = facts.headSha !== reviewedHead || expectedHead !== reviewedHead;
    const failedStep = row.ending.step;
    if (laterReviewStarts.length > 0) {
      const afterBoundary = row.rounds.slice(boundaryPosition + 1);
      const findings = unitRuns.filter(
        (run) => run.parentInstanceId === instance.id && isStepAttempt(run.idempotencyKey, findingsPrefix),
      );
      const fixed = findings.length === 1 ? findings[0] : undefined;
      const reviewStarts = reviewRuns.filter(
        (run) =>
          run.parentInstanceId === instance.id &&
          isStepAttempt(run.idempotencyKey, `${instance.id}:${segmentPrefix}/${boundary.index + 1}/review`),
      );
      const noWork = reviewStarts.length === 1 ? reviewStarts[0] : undefined;
      let final: Awaited<ReturnType<RunsService["getRun"]>> | undefined;
      try {
        if (fixed !== undefined)
          final = await deps.runs.getRun(fixed.id, {
            include: "messages",
            requireFinalRecord: true,
            privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
          });
      } catch {
        return json(503, {
          ok: false,
          error: "recovery_history_unavailable",
          diagnostic: unavailableReviewStart("findings_store_unavailable"),
          at,
        });
      }
      const full = final?.ok === true ? final.value : undefined;
      const postedFindings = review.verdict?.findings ?? [];
      const originalCodingKey = `${instance.id}:${row.unit}/0/coding`;
      const originalCoding = listing.runs.filter((run) => run.idempotencyKey === originalCodingKey);
      const original = originalCoding.length === 1 ? originalCoding[0] : undefined;
      const verifiedOriginalPush =
        original !== undefined &&
        spend.children.some((child) => child.runId === original.id && child.key === originalCodingKey) &&
        original.finished === true &&
        original.status === "completed" &&
        original.agent === "coding" &&
        original.parentInstanceId === instance.id &&
        original.userId === instance.userId &&
        original.repo?.toLowerCase() === instance.repo.toLowerCase() &&
        original.threadKey === unitThreadKey &&
        original.headSha === reviewedHead &&
        original.finishedAt !== undefined &&
        original.finishedAt <= review.startedAt &&
        (original.pr === undefined ||
          (original.pr.number === pr.number &&
            original.pr.url === pr.url &&
            (original.pr.head === undefined || original.pr.head === row.branch))) &&
        original.pushed?.length === 1 &&
        original.pushed[0]?.ref === row.branch &&
        original.pushed[0].sha === reviewedHead &&
        original.pushed[0].by === "push";
      if (
        row.lastPush !== publication.expectedHeadSha ||
        expectedHead !== publication.expectedHeadSha ||
        review.finishedAt === undefined ||
        review.status !== "completed" ||
        fixed === undefined ||
        fixed.finished !== true ||
        fixed.status !== "completed" ||
        fixed.agent !== "coding" ||
        fixed.idempotencyKey !== findingsPrefix ||
        fixed.startedAt < review.finishedAt ||
        fixed.finishedAt === undefined ||
        fixed.finishedAt > laterReviewStarts[0]!.at ||
        fixed.headSha !== expectedHead ||
        fixed.pushed?.length !== 1 ||
        fixed.pushed[0]?.ref !== row.branch ||
        fixed.pushed[0].sha !== expectedHead ||
        fixed.pushed[0].by !== "push" ||
        full?.id !== fixed.id ||
        full.idempotencyKey !== fixed.idempotencyKey ||
        full.parentInstanceId !== fixed.parentInstanceId ||
        full.agent !== fixed.agent ||
        full.userId !== fixed.userId ||
        full.repo !== fixed.repo ||
        full.threadKey !== fixed.threadKey ||
        full.startedAt !== fixed.startedAt ||
        full.finishedAt !== fixed.finishedAt ||
        JSON.stringify(full.pr) !== JSON.stringify(fixed.pr) ||
        JSON.stringify(full.pushed) !== JSON.stringify(fixed.pushed) ||
        JSON.stringify(full.usage) !== JSON.stringify(fixed.usage) ||
        full.status !== "completed" ||
        full.headSha !== expectedHead ||
        full.eventCount !== fixed.eventCount ||
        full.storedEventCount !== full.eventCount ||
        full.truncated !== false ||
        full.events?.length !== full.eventCount ||
        full.events.some((event, index) => event.seq !== index + 1) ||
        full.events.filter((event) => event.type === "pr_description").length !== 1 ||
        JSON.stringify(full.dispositions) !== JSON.stringify(fixed.dispositions) ||
        fixed.dispositions?.length !== postedFindings.length ||
        new Set(fixed.dispositions.map((item) => item.findingId)).size !== postedFindings.length ||
        postedFindings.some((item) => !fixed.dispositions!.some((decision) => decision.findingId === item.id)) ||
        reviewedHead === expectedHead ||
        facts.headSha !== expectedHead ||
        noWork?.id !== spend.noWorkReviews[0] ||
        noWork.idempotencyKey !== `${instance.id}:${segmentPrefix}/${boundary.index + 1}/review` ||
        noWork.startedAt < fixed.finishedAt ||
        noWork.finishedAt === undefined ||
        noWork.finishedAt > row.ending.at ||
        afterBoundary.length !== laterReviewStarts.length + 2 ||
        afterBoundary[0]?.agent !== "coding" ||
        afterBoundary[0].index !== boundary.index ||
        afterBoundary[0].outcome !== "started" ||
        afterBoundary[0].at < fixed.startedAt ||
        afterBoundary[0].at > fixed.finishedAt ||
        afterBoundary[1]?.agent !== "coding" ||
        afterBoundary[1].index !== boundary.index ||
        afterBoundary[1].outcome !== "pr_opened" ||
        afterBoundary[1].at < fixed.finishedAt ||
        afterBoundary[1].at > noWork.startedAt ||
        afterBoundary.slice(2).some((note) => note.agent !== "review" || note.index !== round + 1) ||
        listing.runs.some(
          (run) =>
            run.id !== fixed.id &&
            run.id !== review.id &&
            run.id !== noWork.id &&
            (!run.finished ||
              (run.pushed?.some((push) => push.ref === row.branch) &&
                !(verifiedOriginalPush && run.id === original?.id))),
        )
      )
        return json(409, {
          ok: false,
          error: "recovery_review_evidence_ambiguous",
          diagnostic: unavailableReviewStart("review_or_findings_mismatch"),
          at,
        });
      reviewStartHistory = listing.runs;
      findingsRunId = fixed.id;
      findingsKey = fixed.idempotencyKey!;
      kind = "review";
      round = boundary.index + 1;
      reviewStartEvidence = { reviewStart: "verified_no_work", runId: noWork.id, key: noWork.idempotencyKey! };
    } else if (row.ending.cause === "step_threw" && failedStep?.includes("/pr-check") === true) {
      // A malformed check suffix or trailing path cannot authorize more coding.
      const checkedStep = failedStep.slice(0, -"/pr-check".length);
      // A failed post-findings check is never permission to code again. Even
      // when the head did not move, its exact completed attempt must be proven.
      if (
        !failedStep.endsWith("/pr-check") ||
        boundary.outcome !== "request_changes" ||
        !isStepAttempt(checkedStep, findingsStep) ||
        row.ending.round !== boundary.index
      )
        return json(409, { ok: false, error: "recovery_head_moved", at });
      const attempts = unitRuns.filter(
        (run) => run.parentInstanceId === instance.id && isStepAttempt(run.idempotencyKey, findingsPrefix),
      );
      const checkedAttempts = attempts.filter((run) => run.idempotencyKey === `${instance.id}:${checkedStep}`);
      const completed = checkedAttempts.length === 1 ? checkedAttempts[0] : undefined;
      const reviewFinishedAt = review.finishedAt;
      const reconciledPush =
        completed !== undefined &&
        headMoved &&
        reviewFinishedAt !== undefined &&
        (completed.pushed?.length ?? 0) === 0 &&
        (await reconcileMissingFindingsPush(
          deps,
          instance,
          row,
          completed.id,
          facts.headSha,
          unitRuns,
          reviewFinishedAt,
        ));
      if (
        reviewFinishedAt === undefined ||
        completed === undefined ||
        !completed.finished ||
        completed.status !== "completed" ||
        completed.agent !== "coding" ||
        completed.userId !== instance.userId ||
        completed.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
        completed.threadKey !== unitThreadKey ||
        (completed.pr !== undefined &&
          (completed.pr.number !== pr.number ||
            (completed.pr.head !== undefined && completed.pr.head !== row.branch))) ||
        completed.headSha !== facts.headSha ||
        (expectedHead !== reviewedHead && expectedHead !== facts.headSha) ||
        completed.pushed?.some((push) => push.ref !== row.branch) === true ||
        (headMoved &&
          !reconciledPush &&
          completed.pushed?.some((push) => push.ref === row.branch && push.sha === facts!.headSha) !== true) ||
        completed.startedAt < reviewFinishedAt ||
        completed.finishedAt === undefined ||
        completed.finishedAt < completed.startedAt ||
        completed.finishedAt > row.ending.at ||
        // Inspect every attempt, not just runs matching the current PR head:
        // any competing success or push remains ambiguous after a later push.
        attempts.some(
          (run) =>
            run.id !== completed.id &&
            !(
              run.finished &&
              (run.status === "failed" || run.status === "interrupted") &&
              run.agent === "coding" &&
              run.userId === instance.userId &&
              run.repo?.toLowerCase() === instance.repo.toLowerCase() &&
              run.threadKey === unitThreadKey &&
              run.startedAt >= reviewFinishedAt &&
              run.finishedAt !== undefined &&
              run.finishedAt >= run.startedAt &&
              run.finishedAt <= completed.startedAt &&
              (run.pushed?.length ?? 0) === 0
            ),
        )
      )
        return json(409, { ok: false, error: "recovery_head_moved", at });
      findingsRunId = completed.id;
      findingsKey = completed.idempotencyKey!;
      expectedHead = facts.headSha;
      kind = "review";
      round = boundary.index + 1;
      if (round > caps.maxRounds + patternContinuations)
        return json(409, { ok: false, error: "recovery_rounds_exhausted", at });
      claimRow = {
        ...claimRow,
        lastPush: expectedHead,
        publication: { ...publication, expectedHeadSha: expectedHead },
      };
    } else if (
      kind === "findings" &&
      row.ending.kind === "aborted" &&
      !headMoved &&
      spend.noWork.length === 1 &&
      row.rounds.slice(boundaryPosition + 1).some((candidate) => candidate.agent === "coding")
    ) {
      const afterReview = row.rounds.slice(boundaryPosition + 1);
      const attempts = unitRuns.filter((run) => isStepAttempt(run.idempotencyKey, findingsPrefix));
      const child = attempts.length === 1 ? attempts[0] : undefined;
      if (
        // lastPush is a continuation hint, not the publication authority. If
        // absent, require the original durable binding at the reviewed head;
        // the fresh PR/ref proof above must independently agree with that head.
        (row.lastPush === undefined
          ? row.publication?.expectedHeadSha !== reviewedHead
          : row.lastPush !== reviewedHead) ||
        row.ending.cause !== undefined ||
        row.ending.step !== undefined ||
        child === undefined ||
        child.id !== spend.noWork[0] ||
        child.idempotencyKey !== findingsPrefix ||
        review.finishedAt === undefined ||
        child.startedAt < review.finishedAt ||
        child.finishedAt === undefined ||
        afterReview.length !== 2 ||
        afterReview[0]?.agent !== "coding" ||
        afterReview[0].index !== round ||
        afterReview[0].outcome !== "started" ||
        afterReview[0].at < child.startedAt ||
        afterReview[0].at > child.finishedAt ||
        afterReview[1]?.agent !== "coding" ||
        afterReview[1].index !== round ||
        afterReview[1].outcome !== "aborted" ||
        afterReview[1].at < child.finishedAt ||
        afterReview[1].at > row.ending.at ||
        listing.runs.some(
          (run) =>
            run.id !== child.id &&
            run.id !== review.id &&
            ((!run.finished && (run.agent === "coding" || run.agent === "review")) ||
              (run.startedAt >= review.finishedAt! &&
                (run.agent === "coding" ||
                  run.agent === "review" ||
                  run.pushed !== undefined ||
                  run.headSha !== undefined ||
                  run.pr !== undefined))),
        )
      )
        return json(409, { ok: false, error: "recovery_head_moved", reason: "findings_no_work_guard", at });
      // The failed dispatch consumed neither a findings contract nor a review
      // slot. Keep the posted review as the claim's identity and original lease.
      noWorkFindings = true;
      renewalEvidence = listing.runs;
    } else if (
      kind === "findings" &&
      row.ending.kind === "aborted" &&
      (headMoved || row.rounds.slice(boundaryPosition + 1).some((candidate) => candidate.agent === "coding"))
    ) {
      // Normal aborted endings carry no typed cause or step. Prove the
      // incomplete contract from the child, never from the report's prose.
      const codingBoundary = row.rounds.at(-1)!;
      const codingStart = row.rounds
        .slice(boundaryPosition + 1)
        .reverse()
        .find((candidate) => candidate.agent === "coding" && candidate.outcome === "started");
      const attempts = listing.runs.filter(
        (run) => run.parentInstanceId === instance.id && isStepAttempt(run.idempotencyKey, findingsPrefix),
      );
      const pushedOrCompleted = attempts.filter(
        (run) =>
          run.finished &&
          (run.status === "completed" ||
            ((run.status === "failed" || run.status === "interrupted") && (run.pushed?.length ?? 0) > 0)),
      );
      const unpushed = attempts.filter(
        (run) =>
          run.finished &&
          (run.status === "completed" || run.status === "failed" || run.status === "interrupted") &&
          (run.pushed?.length ?? 0) === 0 &&
          fullHead(run.headSha) !== undefined &&
          run.headSha !== facts!.headSha,
      );
      const eligible = pushedOrCompleted.length > 0 ? pushedOrCompleted : unpushed;
      const selected = eligible.length === 1 ? eligible[0] : undefined;
      const full =
        selected === undefined
          ? undefined
          : await deps.runs.getRun(selected.id, {
              include: "messages",
              privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
            });
      const child = full?.ok === true ? full.value : undefined;
      const tags = child?.events?.filter((event) => event.type === "coordinator_tag") ?? [];
      const tag = tags.length === 1 ? tags[0] : undefined;
      const patchEvents = child?.events?.filter((event) => event.type === "unfinished_patch") ?? [];
      const textPatch = patchEvents.length === 1 && isSavedFindingsPatch(patchEvents[0]) ? patchEvents[0] : undefined;
      const settlementEvents = child?.events?.filter((event) => event.type === "publication_settlement") ?? [];
      const settlement =
        child === undefined ? undefined : publicationSettlementForRun(child.publicationSettlement, child);
      const preserved = settlement?.preservation;
      const bundle =
        child !== undefined &&
        patchEvents.length === 0 &&
        settlementEvents.length === 1 &&
        JSON.stringify(settlementEvents[0].settlement) === JSON.stringify(settlement) &&
        settlement?.checkpoint.kind === "created" &&
        settlement.publication.kind === "rejected" &&
        /^publication refused by cold controller \(phase: cold-publication-(?:base-unavailable-or-over-limit|graph-unavailable-or-over-limit|transfer-refused|validation-refused)\)$/.test(
          settlement.publication.reason,
        ) &&
        preserved?.kind === "saved" &&
        settlement.binding.branch === row.branch &&
        settlement.binding.baseHeadSha === reviewedHead &&
        settlement.checkpoint.head === child.headSha &&
        child.doorPublicationPending === undefined &&
        (child.pushed?.length ?? 0) === 0 &&
        child.truncated === false &&
        child.eventCount === child.storedEventCount &&
        child.events?.length === child.storedEventCount
          ? {
              kind: "bundle" as const,
              runId: child.id,
              key: preserved.key,
              size: preserved.size,
              sha256: preserved.sha256,
              baseHeadSha: reviewedHead,
              targetHeadSha: reviewedHead,
              sourceHeadSha: settlement.checkpoint.head,
            }
          : undefined;
      const patch = textPatch ?? bundle;
      const movedHead = facts.headSha;
      // The live superseded check may already have advanced the uncredited
      // review target from H0 to H1. The child tag still pins immutable H0.
      const originalBinding = tag?.publication;
      const currentBinding = row.publication;
      const patchBindingMatches =
        originalBinding !== undefined &&
        currentBinding !== undefined &&
        originalBinding.expectedHeadSha === reviewedHead &&
        (currentBinding.expectedHeadSha === reviewedHead || currentBinding.expectedHeadSha === movedHead) &&
        samePublicationBinding({ ...originalBinding, expectedHeadSha: currentBinding.expectedHeadSha }, currentBinding);
      const unfinishedPatch =
        patch !== undefined &&
        child !== undefined &&
        patchBindingMatches &&
        patch.runId === child.id &&
        patch.baseHeadSha === originalBinding?.expectedHeadSha &&
        patch.targetHeadSha === movedHead &&
        patch.sourceHeadSha === child.headSha &&
        (patch.kind === "bundle"
          ? movedHead === reviewedHead &&
            currentBinding?.expectedHeadSha === reviewedHead &&
            isSavedFindingsPatch(patch)
          : (child.pushed ?? []).every((push) => push.ref === row.branch && push.sha !== movedHead));
      const storedPatch =
        unfinishedPatch && deps.artifacts !== undefined ? await deps.artifacts.head(patch.key).catch(() => null) : null;
      const patchVerified =
        unfinishedPatch &&
        storedPatch?.size === patch.size &&
        storedPatch.contentType === (patch?.kind === "bundle" ? "application/octet-stream" : "text/plain");
      if (child !== undefined && (child.pushed?.length ?? 0) === 0 && child.headSha !== facts.headSha && !patchVerified)
        return json(409, { ok: false, error: "recovery_patch_unavailable", at });
      const reviewFinishedAt = review.finishedAt;
      const missingOutputs =
        child !== undefined &&
        (patchVerified ||
          child.status !== "completed" ||
          child.events?.some((event) => event.type === "pr_description") !== true ||
          (review.verdict?.findings ?? []).some(
            (finding) => !child.dispositions?.some((disposition) => disposition.findingId === finding.id),
          ));
      if (
        row.publication === undefined ||
        (row.ending.cause !== undefined &&
          row.ending.cause !== "incomplete_outputs" &&
          row.ending.cause !== "step_threw") ||
        (row.ending.step !== undefined && !isStepAttempt(row.ending.step, findingsStep)) ||
        (row.ending.round !== undefined && row.ending.round !== boundary.index) ||
        codingBoundary.agent !== "coding" ||
        codingBoundary.index !== boundary.index ||
        codingBoundary.outcome !== "aborted" ||
        row.rounds.slice(boundaryPosition + 1).some((candidate) => candidate.index !== boundary.index) ||
        review.status !== "completed" ||
        reviewFinishedAt === undefined ||
        !Number.isFinite(reviewFinishedAt) ||
        child === undefined ||
        child.finished !== true ||
        (child.status !== "completed" && child.status !== "failed" && child.status !== "interrupted") ||
        child.agent !== "coding" ||
        child.parentInstanceId !== instance.id ||
        child.idempotencyKey !== selected!.idempotencyKey ||
        child.userId !== instance.userId ||
        child.repo?.toLowerCase() !== instance.repo.toLowerCase() ||
        child.threadKey !== unitThreadKey ||
        child.truncated === true ||
        (patchVerified && child.truncated !== false) ||
        child.events === undefined ||
        (patchVerified && child.eventCount !== child.storedEventCount) ||
        tag?.parentInstanceId !== instance.id ||
        tag.unit !== row.unit ||
        tag.base !== base ||
        (patchVerified ? !patchBindingMatches : !samePublicationBinding(tag.publication, row.publication)) ||
        !missingOutputs ||
        (child.pr !== undefined &&
          (child.pr.number !== pr.number ||
            child.pr.url !== pr.url ||
            (child.pr.head !== undefined && child.pr.head !== row.branch))) ||
        (!patchVerified && child.headSha !== facts.headSha) ||
        (expectedHead !== reviewedHead && expectedHead !== facts.headSha) ||
        (!patchVerified &&
          (child.pushed?.length !== 1 ||
            child.pushed[0]?.ref !== row.branch ||
            child.pushed[0]?.sha !== facts.headSha ||
            child.pushed[0]?.by !== "salvage")) ||
        codingStart === undefined ||
        !Number.isFinite(codingStart.at) ||
        !Number.isFinite(codingBoundary.at) ||
        codingStart.at < reviewFinishedAt ||
        !Number.isFinite(child.startedAt) ||
        child.startedAt < reviewFinishedAt ||
        child.finishedAt === undefined ||
        !Number.isFinite(child.finishedAt) ||
        child.finishedAt < child.startedAt ||
        child.finishedAt < codingStart.at ||
        child.finishedAt > codingBoundary.at ||
        codingBoundary.at > row.ending.at ||
        attempts.some(
          (run) =>
            run.id !== child.id &&
            !(
              run.finished &&
              (run.status === "failed" || run.status === "interrupted") &&
              run.agent === "coding" &&
              run.userId === instance.userId &&
              run.repo?.toLowerCase() === instance.repo.toLowerCase() &&
              run.threadKey === unitThreadKey &&
              run.startedAt >= reviewFinishedAt &&
              run.finishedAt !== undefined &&
              run.finishedAt >= run.startedAt &&
              run.finishedAt <= child.startedAt &&
              (run.pushed?.length ?? 0) === 0
            ),
        ) ||
        // A foreign key does not hide a competing writer in the unit's thread.
        listing.runs.some(
          (run) =>
            run.id !== child.id &&
            ((!run.finished && (run.agent === "coding" || run.agent === "review")) ||
              ((run.finishedAt === undefined || run.finishedAt >= reviewFinishedAt) &&
                run.pushed?.some((push) => push.ref === row.branch))),
        )
      )
        return json(409, { ok: false, error: "recovery_head_moved", at });
      expectedHead = facts.headSha;
      if (patchVerified) {
        savedPatch = patch;
        if (patch.kind === "bundle") bundleHistory = listing.runs;
      }
      // A failed child's salvaged head is a review target, not publication
      // credit. Both paths must redo the missing findings contract before review.
      claimRow = {
        ...claimRow,
        ...(child.status === "completed" && !patchVerified ? { lastPush: expectedHead } : {}),
        publication: { ...publication, expectedHeadSha: expectedHead },
      };
    } else {
      if (headMoved) return json(409, { ok: false, error: "recovery_head_moved", at });
      expectedHead = reviewedHead;
    }
    if (kind === "review" && round > caps.maxRounds + patternContinuations)
      return json(409, { ok: false, error: "recovery_rounds_exhausted", at });
    const floor = minutesToMs(leaseMinimum(kind === "findings" ? "fix" : "review"));
    if (renew) {
      if (!noWorkFindings || remainingMs >= floor || row.recoveryReceipt !== undefined)
        return json(409, { ok: false, error: "recovery_renewal_stage_unsupported", at });
      if (segments.length >= grant.renewals) return json(409, { ok: false, error: "recovery_renewals_exhausted", at });
      remainingMs = minutesToMs(caps.maxMinutes);
      accounting = {
        spendUsd: spend.usd,
        children: spend.children,
        grant: { ...grant },
        ...(instance.grantSource !== undefined ? { grantSource: instance.grantSource } : {}),
        renewalsSpent: segments.length + 1,
      };
    }
    if (!Number.isFinite(remainingMs) || remainingMs < floor)
      return json(409, { ok: false, error: "recovery_wall_clock_exhausted", at });
    stepName = `${row.unit}/recovery/${round}/${kind}`;
    workflowId = renew
      ? `recovery-renewal-${reviewRunId}`
      : externalReview !== undefined
        ? `recovery-review-${externalReview.id}`
        : `recovery-${findingsRunId ?? reviewRunId}`;
    deadlineAt = at + remainingMs;
    findings = kind === "findings" ? candidates[0]!.verdict?.findings : undefined;
    if (kind === "review" && round >= 2) {
      const preceding = postedPatternReviewAt(
        instance,
        row,
        [...histories.values()],
        segmentPrefix,
        leaseStartedAt,
        round - 1,
      );
      const notes = row.rounds.filter(
        (note) =>
          note.index === round - 1 &&
          note.agent === "review" &&
          note.outcome === preceding?.verdict?.verdict &&
          note.at >= leaseStartedAt &&
          preceding.finishedAt !== undefined &&
          preceding.finishedAt <= note.at,
      );
      if (notes.length === 1) priorFindings = preceding?.verdict?.findings;
    }
    if (
      row.recoveryReceipt?.reviewRunId === reviewRunId ||
      (externalReview !== undefined && row.recoveryReceipt?.externalReview?.id === externalReview.id)
    )
      return json(409, { ok: false, error: "recovery_already_completed", at });
    originalRow = row;
  }

  const expiredExistingClaim = existingClaim !== undefined && at >= deadlineAt;
  if (requestedWorkflowId !== undefined) {
    if (existingClaim === undefined || requestedWorkflowId !== workflowId)
      return json(409, { ok: false, error: "recovery_claim_mismatch", at });
  }

  const actionId =
    existingClaim?.actionId ?? (request === undefined ? undefined : await recoveryActionId(row, request));
  const fenceOwner: RunnerPullOwner = {
    ...originalOwner,
    ...(actionId !== undefined ? { recoveryActionId: actionId } : {}),
  };
  const fence = deps.runnerOwnership;
  if (
    fence === undefined ||
    fence.reserve === undefined ||
    fence.transferReservation === undefined ||
    fence.releaseReservation === undefined
  )
    return json(503, { ok: false, error: "publication_ownership_unknown", at });
  const releaseReservation = fence.releaseReservation.bind(fence);
  if (existingClaim !== undefined) {
    try {
      // The claim is durable while the ownership fence is process-local. A
      // Workflow can outlive a bot process, so reconstruct this exact owner's
      // fence from the claim before revalidating it; a rival claim still wins.
      if (!fence.claim(instance.repo, pr.number, fenceOwner))
        return json(409, { ok: false, error: "publication_ownership_changed", at });
    } catch (err) {
      return json(503, { ok: false, error: "publication_ownership_unknown", message: describe(err), at });
    }
  }

  let claimedRow = row;
  let claimReplayed = false;
  let token: symbol | undefined;
  let transferred = existingClaim !== undefined;
  const rollback = async (error: string, consumed = false): Promise<IngressResponse> => {
    // A committed renewal is spent even if Workflow admission fails: a later
    // request must not mint another lease from the same original grant.
    consumed ||= claimedRow.recovery?.renewed === true;
    if (originalRow !== undefined) {
      const replacement = consumed
        ? {
            ...originalRow,
            recoveryReceipt: {
              reviewRunId,
              workflowId,
              at,
              ...(externalReview !== undefined ? { externalReview } : {}),
              ...(accounting !== undefined ? { accounting } : {}),
            },
          }
        : originalRow;
      const refusal = { kind: "refuse" as const, expected: claimedRow, replacement, error, consumed };
      const restored = await (
        claimedRow.recovery?.actionId !== undefined
          ? deps.instances.transitionRecovery(refusal).catch(() => deps.instances.transitionRecovery(refusal))
          : deps.instances.compareAndReplaceUnit(claimedRow, replacement)
      ).catch(() => undefined);
      if (restored?.ok !== true)
        return json(500, {
          ok: false,
          error: "recovery_rollback_failed",
          cause: error,
          reason: restored?.reason ?? "unavailable",
          at,
        });
    }
    const released = transferred
      ? fence.release(instance.repo, pr.number, fenceOwner)
      : token !== undefined
        ? releaseReservation(instance.repo, pr.number, token)
        : true;
    if (!released) return json(500, { ok: false, error: "recovery_cleanup_failed", cause: error, at });
    return json(409, { ok: false, error, at });
  };

  const reconcileWorkflow = async (): Promise<IngressResponse | undefined> => {
    const status = await deps
      .recoveryStatus?.(workflowId)
      .catch(() => ({ kind: "unanswered" as const, reason: "unavailable" }));
    if (status?.kind === "status") {
      if (["complete", "errored", "terminated"].includes(status.status))
        return rollback("recovery_workflow_terminal", true);
      return json(200, {
        ok: true,
        outcome: "already_started",
        workflowId,
        parentInstanceId: instance.id,
        unit: row.unit,
        at,
      });
    }
    if (status?.kind !== "absent")
      return json(200, {
        ok: true,
        outcome: "indeterminate",
        workflowId,
        parentInstanceId: instance.id,
        unit: row.unit,
        at,
      });
    return undefined;
  };

  if (requestedWorkflowId === undefined && expiredExistingClaim) {
    const status = await deps.recoveryStatus?.(workflowId).catch((err) => ({
      kind: "unanswered" as const,
      reason: describe(err),
    }));
    if (status === undefined || status.kind === "unanswered")
      return json(503, {
        ok: false,
        error: "recovery_status_unanswered",
        ...(status?.kind === "unanswered" ? { message: status.reason } : {}),
        workflowId,
        at,
      });
    if (status.kind === "status" && !["complete", "errored", "terminated"].includes(status.status))
      return json(409, { ok: false, error: "recovery_wall_clock_exhausted", workflowId, at });
    return rollback("recovery_wall_clock_exhausted", status.kind !== "absent");
  }

  // A retry observes its saved Workflow before mutable admission evidence.
  // A failed review read cannot revoke work that may already be running.
  if (savedAction !== null && requestedWorkflowId === undefined) {
    const replay = await reconcileWorkflow();
    if (replay !== undefined) return replay;
  }

  if (facts === undefined)
    try {
      facts = await deps.fetchPrFacts({ repo: instance.repo, number: pr.number });
    } catch (err) {
      return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
    }
  if (facts === undefined) return json(502, { ok: false, error: "github_unavailable", at });
  if (savedPatch !== undefined) {
    const object = await deps.artifacts?.head(savedPatch.key).catch(() => null);
    if (
      !isSavedFindingsPatch(savedPatch) ||
      object?.size !== savedPatch.size ||
      object.contentType !== (savedPatch.kind === "bundle" ? "application/octet-stream" : "text/plain")
    )
      return json(409, { ok: false, error: "recovery_patch_unavailable", at });
    try {
      facts = await deps.fetchPrFacts({ repo: instance.repo, number: pr.number });
    } catch (err) {
      return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
    }
    if (facts === undefined) return json(502, { ok: false, error: "github_unavailable", at });
  }
  const verified = facts.verifiedHead;
  if (
    facts.state !== "open" ||
    facts.sameRepoHead !== true ||
    facts.headBranchExists !== true ||
    facts.headRef !== row.branch ||
    facts.baseRef !== base ||
    !fullHead(facts.headSha) ||
    facts.headSha !== expectedHead ||
    verified === undefined ||
    verified.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    verified.ref !== row.branch ||
    verified.sha !== expectedHead
  ) {
    const error =
      fullHead(facts.headSha) && facts.headSha !== expectedHead ? "recovery_head_moved" : "recovery_facts_mismatch";
    return requestedWorkflowId === undefined ? json(409, { ok: false, error, at }) : rollback(error);
  }

  if (externalReview !== undefined && existingClaim !== undefined) {
    // An absent status is not an exclusive create claim: another retry can
    // start this Workflow during the read. Only its callback may revoke it.
    const refuseRevalidation = (error: string) =>
      requestedWorkflowId === undefined ? json(409, { ok: false, error, workflowId, at }) : rollback(error, true);
    if (at >= deadlineAt) return refuseRevalidation("recovery_wall_clock_exhausted");
    const current = await laterRecoveryReview(
      deps,
      instance,
      pr,
      externalReview.headSha,
      existingClaim.previousEnding.at,
      at,
    );
    if (JSON.stringify(current) !== JSON.stringify(externalReview))
      return refuseRevalidation("recovery_later_review_invalid");
    if (accounting === undefined || JSON.stringify(accounting.grant) !== JSON.stringify(instance.grant))
      return refuseRevalidation("recovery_budget_unknown");
  }

  if (existingClaim === undefined) {
    if (instance.stop !== undefined) return json(409, { ok: false, error: "stopped", at });
    // Historical evidence and remote reads can outlive the remaining lease.
    // Refuse before reserving ownership; the claimed deadline never moves.
    if (deadlineAt - (deps.clock ?? systemClock)() < minutesToMs(leaseMinimum(kind === "findings" ? "fix" : "review")))
      return json(409, { ok: false, error: "recovery_wall_clock_exhausted", at });
    if (reviewStartHistory !== undefined) {
      // The initial complete listing preceded full-record and PR reads. Neither
      // a newly live child nor a later push can be hidden by those old facts.
      const current = await deps.runs
        .listRuns({
          privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
          status: "all",
          visibleTo: EVERY_RUN,
          limit: RUN_LIST_MAX_LIMIT,
          recoveryEvidence: {
            instanceId: instance.id,
            unit: row.unit,
            threadKeys: [
              row.threadKey ?? instance.threadKey,
              row.reviewThread?.threadKey ?? row.threadKey ?? instance.threadKey,
            ],
          },
        })
        .catch(() => undefined);
      if (
        current === undefined ||
        current.storeUnavailable ||
        current.ledgerUnavailable ||
        current.nextBefore !== undefined ||
        current.runs.length >= RUN_LIST_MAX_LIMIT
      )
        return json(409, {
          ok: false,
          error: "recovery_evidence_incomplete",
          diagnostic: unavailableReviewStart("history_incomplete"),
          at,
        });
      if (JSON.stringify(current.runs) !== JSON.stringify(reviewStartHistory))
        return json(409, {
          ok: false,
          error: "recovery_evidence_incomplete",
          diagnostic: unavailableReviewStart("history_changed"),
          at,
        });
      const remote = await deps.fetchBranchHeadSha?.(instance.repo, row.branch).catch(() => undefined);
      if (remote === undefined)
        return json(409, {
          ok: false,
          error: "recovery_ref_unavailable",
          diagnostic: unavailableReviewStart("ref_unavailable"),
          at,
        });
      if (remote !== expectedHead) return json(409, { ok: false, error: "recovery_head_moved", at });
    }
    if (renew) {
      // Evidence and PR facts read before a claim are not a lock. A fresh
      // complete scope, exact remote ref and PR binding must still agree.
      const current = await deps.runs
        .listRuns({
          privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
          status: "all",
          visibleTo: EVERY_RUN,
          limit: RUN_LIST_MAX_LIMIT,
          recoveryEvidence: {
            instanceId: instance.id,
            unit: row.unit,
            threadKeys: [
              row.threadKey ?? instance.threadKey,
              row.reviewThread?.threadKey ?? row.threadKey ?? instance.threadKey,
            ],
          },
        })
        .catch(() => undefined);
      if (
        current === undefined ||
        current.storeUnavailable ||
        current.ledgerUnavailable ||
        current.nextBefore !== undefined ||
        current.runs.length >= RUN_LIST_MAX_LIMIT ||
        renewalEvidence === undefined ||
        JSON.stringify(current.runs) !== JSON.stringify(renewalEvidence)
      )
        return json(409, { ok: false, error: "recovery_evidence_incomplete", at });
      const remote = await deps.fetchBranchHeadSha?.(instance.repo, row.branch).catch(() => undefined);
      if (remote === undefined) return json(409, { ok: false, error: "recovery_ref_unavailable", at });
      if (remote !== expectedHead) return json(409, { ok: false, error: "recovery_head_moved", at });
    }
    if (bundleHistory !== undefined) {
      const current = await deps.runs
        .listRuns({
          privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
          status: "all",
          visibleTo: EVERY_RUN,
          limit: RUN_LIST_MAX_LIMIT,
          recoveryEvidence: {
            instanceId: instance.id,
            unit: row.unit,
            threadKeys: [
              row.threadKey ?? instance.threadKey,
              row.reviewThread?.threadKey ?? row.threadKey ?? instance.threadKey,
            ],
          },
        })
        .catch(() => undefined);
      if (
        current === undefined ||
        current.storeUnavailable ||
        current.ledgerUnavailable ||
        current.nextBefore !== undefined ||
        current.runs.length >= RUN_LIST_MAX_LIMIT ||
        JSON.stringify(current.runs) !== JSON.stringify(bundleHistory)
      )
        return json(409, { ok: false, error: "recovery_evidence_incomplete", at });
      const remote = await deps.fetchBranchHeadSha?.(instance.repo, row.branch).catch(() => undefined);
      if (remote === undefined) return json(409, { ok: false, error: "recovery_ref_unavailable", at });
      if (remote !== expectedHead) return json(409, { ok: false, error: "recovery_head_moved", at });
    }
    if (renew || reviewStartHistory !== undefined || bundleHistory !== undefined) {
      // Neither the earlier H2 admission nor a renewal's PR observation can
      // prove the owned PR is still open when the claim reserves its writer.
      const refreshed = await deps.fetchPrFacts({ repo: instance.repo, number: pr.number }).catch(() => undefined);
      if (
        refreshed?.state !== "open" ||
        refreshed.sameRepoHead !== true ||
        refreshed.headBranchExists !== true ||
        refreshed.headRef !== row.branch ||
        refreshed.baseRef !== base ||
        refreshed.headSha !== expectedHead ||
        refreshed.verifiedHead?.sha !== expectedHead ||
        refreshed.verifiedHead.ref !== row.branch ||
        refreshed.verifiedHead.repo.toLowerCase() !== instance.repo.toLowerCase()
      )
        return json(409, {
          ok: false,
          error: "recovery_facts_mismatch",
          ...(reviewStartHistory !== undefined && (refreshed === undefined || refreshed.verifiedHead === undefined)
            ? {
                diagnostic: unavailableReviewStart(
                  refreshed === undefined ? "pr_facts_unavailable" : "pr_binding_unverified",
                ),
              }
            : {}),
          at,
        });
    }
    try {
      token = fence.reserve(instance.repo, pr.number, fenceOwner);
    } catch (err) {
      return json(503, { ok: false, error: "publication_ownership_unknown", message: describe(err), at });
    }
    if (token === undefined) return json(409, { ok: false, error: "publication_ownership_changed", at });
    const { ending: _ending, ...withoutEnding } = claimRow;
    claimedRow = {
      ...withoutEnding,
      recovery: {
        kind,
        round,
        ...(renew ? { renewed: true } : {}),
        ...(patternContinuations > 0 ? { patternContinuations } : {}),
        expectedHeadSha: expectedHead,
        remainingMs,
        claimedAt: at,
        step: stepName,
        reviewRunId,
        ...(externalReview !== undefined ? { externalReview } : {}),
        ...(accounting !== undefined ? { accounting } : {}),
        ...(findingsRunId !== undefined ? { findingsRunId } : {}),
        ...(findingsKey !== undefined ? { findingsKey } : {}),
        ...(findings !== undefined ? { findings } : {}),
        ...(priorFindings !== undefined ? { priorFindings } : {}),
        ...(savedPatch !== undefined ? { patch: savedPatch } : {}),
        previousEnding: row.ending!,
        ...(claimRow !== row
          ? {
              previousBinding: {
                ...(row.publication !== undefined ? { publication: row.publication } : {}),
                ...(row.lastPush !== undefined ? { lastPush: row.lastPush } : {}),
              },
            }
          : {}),
        workflowId,
        deadlineAt,
        reviewKey,
      },
    };
    let replaced: Awaited<ReturnType<CoordinatorInstanceStore["compareAndReplaceUnit"]>> | undefined;
    let historyError: string | undefined;
    try {
      if (request === undefined) return rollback("recovery_request_identity_required");
      const replacement = claimedRow;
      claimedRow = {
        ...replacement,
        history: { version: 1, receiptId: row.history?.receiptId ?? "observed" },
        recovery: { ...replacement.recovery!, actionId: actionId! },
      };
      const result = await deps.instances.transitionRecovery({ kind: "claim", expected: row, replacement, request });
      replaced = result.ok ? { ok: true } : { ok: false, reason: result.reason === "stale" ? "stale" : "unavailable" };
      if (!result.ok && (result.reason === "capacity" || result.reason === "conflict"))
        historyError = `recovery_history_${result.reason}`;
      if (result.ok) {
        claimedRow = result.unit;
        claimReplayed = result.replayed === true;
      }
    } catch (err) {
      // A lost CAS response is not a definite failure. Re-read the exact row:
      // committed means continue under the still-held reservation; unchanged
      // means release; unreadable or another value stays fenced for restart
      // reconciliation rather than exposing a claimed row as unowned.
      const reread = await deps.instances.listUnits(instance.id).catch(() => undefined);
      const current = reread?.filter((candidate) => candidate.unit === row.unit);
      if (current?.length === 1 && JSON.stringify(current[0]) === JSON.stringify(claimedRow)) replaced = { ok: true };
      else if (current?.length === 1 && JSON.stringify(current[0]) === JSON.stringify(row)) {
        const released = releaseReservation(instance.repo, pr.number, token);
        if (!released)
          return json(500, { ok: false, error: "recovery_cleanup_failed", cause: "recovery_store_unavailable", at });
        return json(503, { ok: false, error: "recovery_store_unavailable", message: describe(err), at });
      } else return json(503, { ok: false, error: "recovery_claim_unanswered", message: describe(err), at });
    }
    if (replaced.ok !== true) {
      const error =
        historyError ?? (replaced.reason === "stale" ? "recovery_claim_stale" : "recovery_store_unavailable");
      const released = releaseReservation(instance.repo, pr.number, token);
      if (!released) return json(500, { ok: false, error: "recovery_cleanup_failed", cause: error, at });
      return json(409, { ok: false, error, at });
    }
    if (!fence.transferReservation(instance.repo, pr.number, token, fenceOwner, fenceOwner))
      return rollback("publication_ownership_changed");
    token = undefined;
    transferred = true;
  }
  if (requestedWorkflowId !== undefined)
    return json(200, { ok: true, parentInstanceId: instance.id, unit: row.unit, workflowId, at });

  if (claimReplayed) {
    const replay = await reconcileWorkflow();
    if (replay !== undefined) return replay;
  }

  const startRecovery = deps.startRecovery;
  if (startRecovery === undefined) return rollback("recovery_workflow_unavailable");
  const started = await startRecovery(workflowId, {
    kind: "recover-original-unit",
    parentInstanceId: instance.id,
    unit: row.unit,
  }).catch((err) => ({ kind: "unanswered" as const, reason: describe(err) }));
  if (started.kind !== "created" && started.kind !== "duplicate") {
    if (started.kind === "failed") return rollback("recovery_workflow_failed");
    return json(200, {
      ok: true,
      outcome: "indeterminate",
      workflowId,
      parentInstanceId: instance.id,
      unit: row.unit,
      message: started.reason,
      at,
    });
  }
  if (
    started.kind === "duplicate" &&
    started.status !== undefined &&
    ["complete", "errored", "terminated"].includes(started.status)
  )
    return rollback("recovery_workflow_terminal", true);
  return json(200, {
    ok: true,
    outcome: started.kind === "duplicate" ? "already_started" : "started",
    workflowId,
    parentInstanceId: instance.id,
    unit: row.unit,
    ...(reviewStartEvidence !== undefined ? { diagnostic: reviewStartEvidence } : {}),
    at,
  });
}

async function prCheck(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (body.unit !== undefined && (typeof body.unit !== "string" || !UNIT_ID.test(body.unit)))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const recover =
    typeof body.recover === "object" &&
    body.recover !== null &&
    typeof (body.recover as Record<string, unknown>).runId === "string" &&
    RUN_ID_PATTERN.test((body.recover as Record<string, unknown>).runId as string)
      ? { runId: (body.recover as Record<string, unknown>).runId as string }
      : undefined;
  if (body.adopt !== undefined && (typeof body.adopt !== "object" || body.adopt === null))
    return json(400, { ok: false, error: "adopt must name a drained child and previous head" });
  const adoptBody = body.adopt as Record<string, unknown> | undefined;
  const adopt =
    adoptBody !== undefined &&
    typeof adoptBody.runId === "string" &&
    RUN_ID_PATTERN.test(adoptBody.runId) &&
    typeof adoptBody.childStep === "string" &&
    typeof adoptBody.previousHeadSha === "string" &&
    fullHead(adoptBody.previousHeadSha)
      ? {
          runId: adoptBody.runId,
          childStep: adoptBody.childStep,
          previousHeadSha: adoptBody.previousHeadSha,
        }
      : undefined;
  if (body.adopt !== undefined && adopt === undefined)
    return json(400, { ok: false, error: "adopt must name a drained child and previous head" });
  if (adopt !== undefined && (recover !== undefined || body.entry === true || body.checks === true))
    return json(400, { ok: false, error: "adopt cannot be combined with another PR check" });
  // The pull request the machine has adopted (issue 1799): followed by number
  // when nothing heads the unit's branch, so the answer is the pull request's
  // live state, never `none` over a record fact written minutes earlier.
  if (body.pr !== undefined && (typeof body.pr !== "number" || !Number.isInteger(body.pr) || body.pr <= 0))
    return json(400, { ok: false, error: "pr must be a pull request number" });
  const follow = typeof body.pr === "number" ? body.pr : undefined;
  if (adopt !== undefined && follow === undefined)
    return json(400, { ok: false, error: "adopt requires the adopted pull request" });
  // The unit-start's pre-check (issue 1689): read the entry facts beside the
  // listing — the branch's own tip, whether the bot's approval stands at it,
  // and the checks there — so a re-issued plan's unit resumes at review, or
  // at the merge decision, instead of a coding round over a shipped head.
  const entry = body.entry === true;
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const unit = await unitRowOf(deps, instance, body.unit as string | undefined);
  if (!unit.ok) return unit.response;
  const branch = unit.row?.branch ?? instance.branch;
  // Terminal pull requests remain readable on the unit row. Open pull
  // requests never use this ordinary whole-row write: bindOpenPullRequest owns
  // their one atomic {pr, publication} transition.
  const rememberTerminal = async (pr: { number: number; url: string }) => {
    if (!unit.row || (unit.row.pr?.number === pr.number && unit.row.pr.url === pr.url)) return;
    await deps.instances.putUnits([{ ...unit.row, pr }]);
  };
  try {
    // Once the machine has adopted a pull request, its number is the authority:
    // read and enrich it before any branch discovery. The unit branch may have
    // another pull request, but entry, transition and ending reads all stay on
    // the adopted one through a merge, close or force-push.
    if (follow !== undefined) {
      if (unit.row?.pr !== undefined && unit.row.pr.number !== follow)
        throw new PublicationBindingRefusal("publication_facts_mismatch");
      const facts = await deps.fetchPrFacts({ repo: instance.repo, number: follow });
      if (facts === undefined) throw new Error(`could not read ${instance.repo}#${follow}`);
      const fallbackUrl = unit.row?.pr?.url ?? `https://github.com/${instance.repo}/pull/${follow}`;
      const state = pullRequestState(follow, fallbackUrl, facts);
      if (state === undefined) throw new Error(headBranchStateError(instance.repo, follow));
      const followedPr = { number: follow, url: String(state.url) };
      if (state.state !== "open") {
        await rememberTerminal(followedPr);
        return json(200, { ok: true, ...state, at });
      }
      const bindingRow =
        unit.row !== undefined && recover !== undefined
          ? unit.row.rounds.some((note) => note.agent === "review")
            ? await advanceFindingsPublication(deps, instance, unit.row, facts, recover.runId)
            : await advanceCodingPublication(deps, instance, unit.row, facts, recover.runId)
          : unit.row !== undefined && adopt !== undefined && facts.headSha !== unit.row.publication?.expectedHeadSha
            ? await adoptSupersededHead(deps, instance, unit.row, facts, adopt)
            : unit.row;
      await bindOpenPullRequest(deps, instance, bindingRow, followedPr, facts);
      const prRef = { repo: instance.repo, number: follow };
      const headSha = facts.headSha;
      const approved =
        entry && headSha !== undefined ? await reviewPostedAt(deps, prRef, "approve", headSha) : undefined;
      const humanGate = entry
        ? await postedHumanGateAnswer(
            deps,
            prRef,
            instance.userId,
            instance.addressSeverity ?? DEFAULT_ADDRESS_SEVERITY,
          )
        : undefined;
      const entryChecks =
        entry && headSha !== undefined
          ? await deps.fetchCommitChecks(instance.repo, headSha).catch(() => undefined)
          : undefined;
      const checks =
        body.checks === true && headSha !== undefined
          ? await deps.fetchCommitChecks(instance.repo, headSha).catch(() => undefined)
          : entryChecks;
      const fixups = body.checks === true ? await deps.fixupCommitSubjects(prRef).catch(() => undefined) : undefined;
      const queueBase = facts.baseRef ?? instance.base;
      const baseHasMergeQueue =
        body.checks === true && deps.branchHasMergeQueue !== undefined && queueBase !== undefined
          ? await deps.branchHasMergeQueue(instance.repo, queueBase).catch(() => undefined)
          : undefined;
      return json(200, {
        ok: true,
        ...state,
        ...(entry && headSha !== undefined ? { branchHead: headSha } : {}),
        ...(approved !== undefined ? { approved } : {}),
        ...(humanGate !== undefined ? { humanGate } : {}),
        ...(facts.autoMergeEnabled !== undefined ? { autoMergeEnabled: facts.autoMergeEnabled } : {}),
        ...(checks !== undefined ? { checks } : {}),
        ...(body.checks === true && facts.mergeableState !== undefined ? { mergeableState: facts.mergeableState } : {}),
        ...(fixups !== undefined ? { fixupCommits: fixups } : {}),
        ...(typeof baseHasMergeQueue === "boolean" ? { baseHasMergeQueue } : {}),
        at,
      });
    }
    const open = await deps.findOpenPrByHead(instance.repo, branch);
    if (open) {
      // The branch listing is discovery only. Re-read the pull request whole
      // before this transition acts: the listing can lag a merge/close, and
      // only the facts read proves the head ref still exists.
      const liveFacts = await deps.fetchPrFacts({ repo: instance.repo, number: open.number });
      if (liveFacts === undefined) throw new Error(`could not read ${instance.repo}#${open.number}`);
      const current = pullRequestState(open.number, open.htmlUrl, liveFacts);
      if (current === undefined) throw new Error(headBranchStateError(instance.repo, open.number));
      const discoveredPr = { number: open.number, url: open.htmlUrl };
      if (current.state !== "open") {
        await rememberTerminal(discoveredPr);
        return json(200, { ok: true, ...current, at });
      }
      await bindOpenPullRequest(deps, instance, unit.row, discoveredPr, liveFacts);
      // The entry facts (issue 1689). The branch's tip comes from the pull
      // request's own facts read, which prefers the head ref's tip over the
      // possibly-stale listing sha; the approval and the checks are read at
      // that tip.
      const entryFacts = entry ? liveFacts : undefined;
      const branchHead = entryFacts?.headSha;
      const entryHead = branchHead ?? open.headSha;
      const approved =
        entry && entryHead !== undefined
          ? await reviewPostedAt(deps, { repo: instance.repo, number: open.number }, "approve", entryHead)
          : undefined;
      const humanGate = entry
        ? await postedHumanGateAnswer(
            deps,
            { repo: instance.repo, number: open.number },
            instance.userId,
            instance.addressSeverity ?? DEFAULT_ADDRESS_SEVERITY,
          )
        : undefined;
      const entryChecks =
        entry && entryHead !== undefined
          ? await deps.fetchCommitChecks(instance.repo, entryHead).catch(() => undefined)
          : undefined;
      // The check runs at the head, as the merge door reads them, only when
      // the caller asks (`checks: true`: the ending's facts read, agent-ship
      // item 9; record 0055): a merge-ready report is a claim about the head,
      // so it names the checks it read. GitHub unreadable leaves the field out.
      const checks =
        body.checks === true && open.headSha !== undefined
          ? await deps.fetchCommitChecks(instance.repo, open.headSha).catch(() => undefined)
          : entryChecks;
      // The ready state beside the checks (agent-ship item 9): the pull
      // request's own mergeable state — the open-PR listing does not carry it,
      // so the facts are read whole — and the head's self-declared fix-up
      // commits. Read only on the ending's facts read (`checks: true`);
      // GitHub unreadable leaves each field out, never fails the check.
      const prRef = { repo: instance.repo, number: open.number };
      const facts = body.checks === true ? liveFacts : undefined;
      const fixups = body.checks === true ? await deps.fixupCommitSubjects(prRef).catch(() => undefined) : undefined;
      // The base's merge-queue rule beside the checks (issue 2011): read only
      // on the ending's facts read, so a `merge: person` report can say the
      // person's merge is queued. Unreadable rules leave the field out.
      const queueBase = facts?.baseRef ?? instance.base;
      const baseHasMergeQueue =
        body.checks === true && deps.branchHasMergeQueue !== undefined && queueBase !== undefined
          ? await deps.branchHasMergeQueue(instance.repo, queueBase).catch(() => undefined)
          : undefined;
      return json(200, {
        ok: true,
        state: "open",
        prNumber: open.number,
        url: open.htmlUrl,
        ...(liveFacts.headSha !== undefined ? { headSha: liveFacts.headSha } : {}),
        ...(liveFacts.headBranchExists !== undefined ? { headBranchExists: liveFacts.headBranchExists } : {}),
        ...(branchHead !== undefined ? { branchHead } : {}),
        ...(approved !== undefined ? { approved } : {}),
        ...(humanGate !== undefined ? { humanGate } : {}),
        // The pull request's own auto-merge fact (agent-ship item 9), so a
        // merge_ready ending can name it at the approved head.
        ...(open.autoMergeEnabled !== undefined ? { autoMergeEnabled: open.autoMergeEnabled } : {}),
        ...(checks !== undefined ? { checks } : {}),
        ...(facts?.mergeableState !== undefined ? { mergeableState: facts.mergeableState } : {}),
        ...(fixups !== undefined ? { fixupCommits: fixups } : {}),
        ...(typeof baseHasMergeQueue === "boolean" ? { baseHasMergeQueue } : {}),
        at,
      });
    }
    // No open pull request heads the branch: one already merged — by a person,
    // or by an earlier attempt that died after its merge — makes the unit done
    // rather than aborted (record 0031's `merged` ending, reached without the
    // runner's merge). Asked only now: an open pull request is the round's.
    const merged = await deps.findMergedPrByHead(instance.repo, branch);
    if (!merged) {
      // A dead coding child's pushed work is recovered here: the pull request
      // is opened from the branch itself rather than the round ending aborted
      // with the work stranded (agent-ship items 10 and 15).
      if (recover === undefined) {
        // A plain check carries the branch's commits over the base when it can
        // read them (issue 1699): zero, beside a handoff that names where the
        // scope landed, is the machine's `already_landed` ending. A fact that
        // cannot be read is left out, never guessed — the check still answers.
        const ahead =
          instance.base === undefined
            ? undefined
            : await deps.commitsOverBase(instance.repo, instance.base, branch).catch((err: unknown) => {
                (deps.log ?? console.log)(
                  `[coordinator] ${instance.id} pr-check: the compare of ${branch} over ${instance.base} could not be read: ${describe(err)}`,
                );
                return undefined;
              });
        return json(200, { ok: true, state: "none", ...(ahead !== undefined ? { aheadOfBase: ahead } : {}), at });
      }
      const recovered = await recoverPushedBranch(deps, instance, unit.row, branch, recover.runId);
      if (recovered.kind === "opened") {
        // Open-or-edit is not a transition fact: the request can merge, close
        // or lose its head ref before this route returns. Re-read the pull
        // request whole and let an unknown branch state throw into the step's
        // retry instead of dispatching a child on the optimistic open result.
        const recoveredFacts = await deps.fetchPrFacts({ repo: instance.repo, number: recovered.pr.number });
        if (recoveredFacts === undefined) throw new Error(`could not read ${instance.repo}#${recovered.pr.number}`);
        const recoveredState = pullRequestState(recovered.pr.number, recovered.pr.htmlUrl, recoveredFacts);
        if (recoveredState === undefined) throw new Error(headBranchStateError(instance.repo, recovered.pr.number));
        const recoveredPr = { number: recovered.pr.number, url: recovered.pr.htmlUrl };
        if (recoveredState.state === "open")
          await bindOpenPullRequest(deps, instance, unit.row, recoveredPr, recoveredFacts);
        else await rememberTerminal(recoveredPr);
        return json(200, { ok: true, ...recoveredState, at });
      }
      return json(200, { ok: true, state: "none", unrecovered: recovered.why, at });
    }
    const mergedFacts = await deps.fetchPrFacts({ repo: instance.repo, number: merged.number });
    if (mergedFacts === undefined) throw new Error(`could not read ${instance.repo}#${merged.number}`);
    const state = pullRequestState(merged.number, merged.htmlUrl, mergedFacts);
    if (state?.state !== "merged") throw new Error(`${instance.repo}#${merged.number} no longer reads merged`);
    await rememberTerminal({ number: merged.number, url: merged.htmlUrl });
    return json(200, { ok: true, ...state, at });
  } catch (err) {
    if (err instanceof PublicationBindingRefusal)
      return json(409, { ok: false, error: err.reason, message: "the open pull request was not durably bound", at });
    if (err instanceof CoordinatorUnitWriteConflict) throw err;
    return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
  }
}

// ---- the hosted parent's write door (record 0060) --------------------------------------------

/** Where the pipeline's parent run lives, resolved server-side from the
 *  instance's own `runId` — never a body field. `host`: this process's
 *  registry holds the run live, the routes write to it. `not_host`: a ledger
 *  row for the run is live under another generation — the route answers
 *  `409 not_host` and writes nothing (the driver re-asks under its retry policy).
 *  `untracked`: no live row anywhere — an untracked hand-off, whose
 *  parent finished at the hand-off — so the routes publish nothing and answer
 *  as before. */
type HostAnswer = { kind: "host"; runId: string } | { kind: "not_host" } | { kind: "untracked" };

async function hostRunOf(deps: AdminCoordinatorDeps, instance: CoordinatorInstance): Promise<HostAnswer> {
  const runId = instance.runId;
  if (runId === undefined) return { kind: "untracked" };
  const here = deps.registry.getById(runId);
  if (here && !here.finished) return { kind: "host", runId };
  const res = await deps.runs
    .getRun(runId, { privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ })
    .catch(() => undefined);
  if (res !== undefined && res.ok && !res.value.finished && res.value.ownerGen !== undefined)
    return { kind: "not_host" };
  return { kind: "untracked" };
}

/** The runner routes' one write to the hosted parent (record 0060): the
 *  events enter the registry's stream (the ship branch's write-through
 *  subscription mirrors them onto the ledger row), and the row's deadline
 *  moves forward by the pipeline's wall clock plus the runner's scheduling
 *  slack (record 0046's lease shape) — so a pipeline whose Workflow dies
 *  without `finish` is closed by the reclaim within that window of its last
 *  word, and a live one is never closed under it. */
async function hostPublish(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  runId: string,
  events: RunEvent[],
  at: number,
): Promise<void> {
  const caps = instance.caps ?? resolveShipCaps(undefined);
  const hosting: HostingState = {
    instanceId: instance.id,
    until: at + minutesToMs(caps.maxMinutes + HOSTED_DEADLINE_MARGIN_MINUTES),
  };
  const ledgerRun = deps.ledgerRuns().find((run) => run.runId === runId);
  let summary = deps.registry.getById(runId);
  if (ledgerRun && summary) {
    // A parent reclaimed from a writer predating live state is backfilled at
    // the first host fact, preserving read compatibility without inventing a
    // rival source for current writers.
    if (summary.liveState === undefined) {
      const admitted = await ledgerRun.assignLiveState({
        expectedSeq: 0,
        eventSeq: summary.eventCount + 1,
        at,
        state: "admitted",
        bound: hosting.until,
        detail: "waiting for the pipeline hand-off",
      });
      if (!admitted.ok || !deps.registry.commitLiveState(runId, admitted))
        throw new Error(
          `hosted live state backfill was not committed (${admitted.ok ? "registry sequence" : admitted.reason})`,
        );
      summary = deps.registry.getById(runId);
      if (!summary) throw new Error("hosted run disappeared during live-state backfill");
      const working = await ledgerRun.assignLiveState({
        expectedSeq: summary.liveStateSeq ?? 0,
        eventSeq: summary.eventCount + 1,
        at,
        state: "working",
        bound: hosting.until,
        detail: "pipeline starting",
        statePatch: { hosting },
      });
      if (!working.ok || !deps.registry.commitLiveState(runId, working))
        throw new Error(
          `hosted working backfill was not committed (${working.ok ? "registry sequence" : working.reason})`,
        );
      summary = deps.registry.getById(runId);
      if (!summary) throw new Error("hosted run disappeared after live-state backfill");
    }
    const firstSeq = summary.eventCount + 1;
    const sourceEvents = events.map((event, index) => ({ ...event, seq: firstSeq + index }));
    const prior =
      deps.registry
        .snapshotById(runId)
        ?.events.filter((event) => event.type === "ship_round" || event.type === "ship_unit") ?? [];
    const standing = pipelineStandingOf([...prior, ...events]);
    const stage = standing.changes.at(-1)?.stage ?? "idle";
    const committed = await ledgerRun.assignLiveState({
      expectedSeq: summary.liveStateSeq ?? 0,
      at,
      state: "working",
      bound: hosting.until,
      detail: hostedStageDetail(stage),
      statePatch: { hosting },
      sourceEvents,
    });
    if (!committed.ok || !deps.registry.commitLiveState(runId, committed))
      throw new Error(
        `hosted live state refresh was not committed (${committed.ok ? "registry sequence" : committed.reason})`,
      );
  } else {
    ledgerRun?.setState({ hosting });
  }
  for (const event of events) deps.registry.publish(runId, event);
}

/** Record 0060: the run the routes write to is the instance's own — a body naming any
 *  other run id publishes nothing and answers `not_found`, byte-identical to a
 *  missing run (`readRecord`'s instance-scoped rule). */
function namesForeignRun(instance: CoordinatorInstance, body: Record<string, unknown>): boolean {
  return typeof body.runId === "string" && body.runId !== instance.runId;
}

// ---- the plan runner's own steps: the plan, a unit's start and end, the branch, the card, the record ----

/** What the coordinator reads first: the instance's units with where each
 *  stands and the caps — the numbers its machine runs on, none of them in the
 *  instance's params; the children's asks and floors it reads from the budgets
 *  module itself. */
async function plan(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const units = await deps.instances.listUnits(instance.id);
  const confirmed = await deps.instances.get(instance.id);
  if (JSON.stringify(confirmed) !== JSON.stringify(instance))
    return json(503, { ok: false, error: "coordinator_snapshot_unavailable", at });
  return json(200, {
    ok: true,
    instance,
    ...(instance.plan !== undefined ? { planId: instance.plan.id } : {}),
    // Who merges: the instance's field; a record written before it existed is a person's merge.
    merge: instance.merge ?? "person",
    // The severity to address, beside `merge`: one value the machine reads.
    addressSeverity: instance.addressSeverity ?? "minor",
    addressSeveritySource: instance.addressSeveritySource ?? "org",
    // The grant beside it (decision 0046): absent on the record, nothing renews.
    grant: instance.grant ?? DEFAULT_GRANT,
    grantSource: instance.grantSource ?? "org",
    // The request's verbosity (routing-and-config item 28): what the runner
    // says in the unit threads; absent on the record, quiet.
    verbosity: instance.verbosity ?? DEFAULT_VERBOSITY,
    // The idle flag beside them (record 0051): absent on the record, nothing idles.
    idleDays: instance.idleDays ?? IDLE_DAYS_DEFAULT,
    // The mark (item 16): the machine's report keys its re-issue line on it.
    generated: isGenerated(instance),
    // The hard stop's mark (record 0060; issue 1924): the walk reads it before
    // every unit start and ends the remaining units stopped on it.
    ...(instance.stop !== undefined ? { stopped: true } : {}),
    // The runs page base: the report's pointer at a child's write-up links its
    // run page with it (agent-ship item 12); left out, the run id is named.
    ...(deps.runPageBase !== undefined ? { runPageBase: deps.runPageBase } : {}),
    repo: instance.repo,
    base: instance.base ?? "main",
    caps: instance.caps ?? resolveShipCaps(undefined),
    units,
    at,
  });
}

/** The board issue titled by the unit id (`U<n>: …`), when the repository has one open. */
async function unitIssueOf(deps: AdminCoordinatorDeps, repo: string, unit: string): Promise<number | undefined> {
  try {
    const issues = await deps.github.listIssues(repo, { state: "open", limit: 100 });
    const pattern = new RegExp(`^${unit}\\b`);
    return issues.find((i) => pattern.test(i.title))?.number;
  } catch {
    return undefined;
  }
}

/** A unit starts: its thread is opened by the requesting thread's channel (a
 *  task's is the requesting thread itself), its board issue looked up, and the
 *  row says so. Idempotent: a started unit answers its thread again. No review
 *  thread is opened (record 0055): every child of the unit runs in this one. */
async function unitStart(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  if (namesForeignRun(instance, body)) return json(404, { ok: false, error: "not_found" });
  const host = await hostRunOf(deps, instance);
  if (host.kind === "not_host") return json(409, { ok: false, error: "not_host", at });
  const unit = await unitRowOf(deps, instance, body.unit);
  if (!unit.ok) return unit.response;
  let row = unit.row!;
  if (row.workBrief !== undefined) {
    const threadKey = privateWorkerThreadKey({ instanceId: instance.id, unit: row.unit });
    if (deps.privateWorkerLog === undefined)
      return json(503, { ok: false, error: "private_worker_log_unavailable", at });
    if ((row.threadKey !== undefined && row.threadKey !== threadKey) || row.reviewThread !== undefined)
      return json(409, { ok: false, error: "private_worker_thread_conflict", at });
    // Prove the durable log is reachable before admitting a worker. No Slack thread is opened.
    try {
      await deps.privateWorkerLog.list(threadKey);
    } catch {
      return json(503, { ok: false, error: "private_worker_log_unavailable", at });
    }
    row = { ...row, threadKey };
  }
  if (row.threadKey === undefined) {
    // A one-unit plan — generated or checked-in — runs its unit where the
    // request was made (record 0055 item 3): the count decides, not the source.
    if (unit.rows.length === 1) {
      row = {
        ...row,
        threadKey: instance.threadKey,
        ...(instance.sourceUrl !== undefined ? { sourceUrl: instance.sourceUrl } : {}),
      };
    } else {
      const opened = await openThreadFromRequester(deps, instance, row.unit, unitLead(instance, row), at);
      if (!opened.ok) return opened.response;
      row = { ...row, ...opened.thread };
    }
  }
  if (row.issue === undefined && !isGenerated(instance)) {
    const issue = await unitIssueOf(deps, instance.repo, row.unit);
    if (issue !== undefined) row = { ...row, issue };
  }
  row = { ...row, startedAt: row.startedAt ?? at };
  await deps.instances.putUnits([row]);
  if (host.kind === "host")
    await hostPublish(
      deps,
      instance,
      host.runId,
      [
        {
          type: "ship_unit",
          unit: row.unit,
          state: "started",
          ...(row.workBrief === undefined && row.threadKey !== undefined ? { threadKey: row.threadKey } : {}),
          ...(row.workBrief === undefined ? { lead: unitLead(instance, row) } : {}),
          ...(row.pr !== undefined ? { pr: row.pr.number } : {}),
          at,
        },
      ],
      at,
    );
  (deps.log ?? console.log)(`[coordinator] ${instance.id} ${row.unit}: started in ${row.threadKey}`);
  return json(200, {
    ok: true,
    threadKey: row.threadKey,
    branch: row.branch,
    base: instance.base ?? "main",
    ...(row.issue !== undefined ? { issue: row.issue } : {}),
    at,
  });
}

/** The lead of a unit's thread — what a reader in the channel needs to know why a new thread appeared. */
function unitLead(instance: CoordinatorInstance, row: CoordinatorUnit): string {
  const who = instance.userName ?? instance.userId;
  const from = instance.sourceUrl !== undefined ? `[the *ship* run](${instance.sourceUrl})` : "the *ship* run";
  return `↳ *ship* unit ${row.unit}${row.title ? ` — ${row.title}` : ""} for ${who}, from ${from}: \`${row.branch}\` in ${instance.repo}`;
}

/** Round 0's pipeline branch: `refs/heads/<branch>` at the base's tip, on
 *  origin before any attach; a branch already there is success inside. */
async function branch(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (body.unit !== undefined && (typeof body.unit !== "string" || !UNIT_ID.test(body.unit)))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const unit = await unitRowOf(deps, instance, body.unit as string | undefined);
  if (!unit.ok) return unit.response;
  const name = unit.row?.branch ?? instance.branch;
  const base = instance.base;
  if (base === undefined) return json(200, { ok: false, reason: `no base branch is known for ${instance.repo}`, at });
  try {
    await deps.createBranchRef(instance.repo, name, base);
    return json(200, { ok: true, branch: name, base, at });
  } catch (err) {
    return json(200, { ok: false, reason: describe(err), at });
  }
}

/** Every word the runner may report a round with — the whole of
 *  `ShipRoundOutcome`, pinned below so the route and the union can never
 *  drift apart again (record 0065; a renewed round 0's `continued` once threw
 *  in the driver because the route lacked it, issue 1968). `idle` has no emitter
 *  until record 0051's wake lands; accepted now so rows written then read
 *  beside today's. */
const ROUND_OUTCOMES = [
  "started",
  "pr_opened",
  "completed",
  "approve",
  "request_changes",
  "no_verdict",
  "checks_failed",
  "checks_restarted",
  "transient",
  "enqueued",
  "dequeued",
  "aborted",
  "stopped",
  "held",
  "continued",
  "idle",
] as const satisfies readonly ShipRoundOutcome[];
// Type-level exhaustiveness: an outcome added to the union and missing here
// leaves `MissingRoundOutcome` non-never, and this assignment fails the build.
type MissingRoundOutcome = Exclude<ShipRoundOutcome, (typeof ROUND_OUTCOMES)[number]>;
const ROUND_OUTCOMES_COVER_THE_UNION: [MissingRoundOutcome] extends [never] ? true : never = true;
void ROUND_OUTCOMES_COVER_THE_UNION;

/** One line per unit on the parent's card: the round in flight or how the unit
 *  ended — the task wording (no unit id) for a generated plan's one unit. The
 *  round header names the severity in force and its source (agent-ship item
 *  6) — the instance's value beside `merge` — at `verbose` and above; a quiet
 *  card's rows keep the round, the phase and the outcome alone (routing-and-
 *  config item 28). */
function unitLines(
  units: readonly CoordinatorUnit[],
  generated: boolean,
  severity: { level: AddressSeverity; source: AddressSeveritySource } | undefined,
): string[] {
  return units.map((u) => {
    const last = u.rounds.at(-1);
    // The card prints the user's words (record 0066): `merge-ready`, never
    // `merge_ready`; `checks failed`, never `checks_failed`.
    const state = u.ending
      ? endingWordOf(u.ending.kind)
      : u.idle
        ? // The idle line names the old kind's word (record 0051): `idle · out of budget`.
          `idle · ${endingWordOf(u.idle.why)}`
        : last
          ? `${shipRoundHeader({ index: last.index, agent: last.agent }, severity)} · ${roundOutcomeWordOf(last.outcome)}${
              last.gate && u.workBrief === undefined
                ? ` · ⚠️ gate fired: ${last.gate.findings.join(", ")} at or above ${last.gate.level}`
                : ""
            }`
          : u.threadKey
            ? "starting"
            : "waiting";
    // A renewed unit names its segment (decision 0046): `segment 2 · …`.
    const lastWake = u.wakes ? Object.values(u.wakes).at(-1) : undefined;
    const wakeSenders =
      lastWake?.kind === "segment" && lastWake.senders.length > 0
        ? ` · with ${lastWake.texts.length} message${lastWake.texts.length === 1 ? "" : "s"} from ${lastWake.senders.join(", ")}`
        : "";
    const seg =
      u.ending === undefined && u.segments !== undefined && u.segments.length > 0
        ? `segment ${u.segments[u.segments.length - 1]!.index}${wakeSenders} · `
        : "";
    return generated ? `${seg}${state}` : `${u.unit} · ${seg}${state}`;
  });
}

/** Redraw the parent's card from the unit rows (`StatusHandle.handle` on the
 *  instance record): the same shell frames every run draws, the round header
 *  per unit. No card (a channel without one) → nothing. */
async function drawCard(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  units: readonly CoordinatorUnit[],
  close?: { icon: string },
): Promise<void> {
  if (units.some((row) => row.workBrief !== undefined)) return;
  if (!instance.card) return;
  const io = deps.ioFor({ threadKey: instance.threadKey, userId: instance.userId, cardTs: instance.card.ts });
  if (!io) return;
  const clock = deps.clock ?? systemClock;
  const shell = createCardShell({ label: instance.label ?? "*ship*", startedAt: instance.createdAt, now: clock });
  const detail = unitLines(
    units,
    isGenerated(instance),
    shows(instance.verbosity ?? DEFAULT_VERBOSITY, "verbose")
      ? {
          level: instance.addressSeverity ?? DEFAULT_ADDRESS_SEVERITY,
          source: instance.addressSeveritySource ?? "org",
        }
      : undefined,
  );
  const display = { verbosity: instance.verbosity ?? DEFAULT_VERBOSITY };
  if (!close) {
    await io.status(shell.live({ detail }), display);
    return;
  }
  shell.freeze(clock());
  const handle = await io.status(shell.live({ detail }), display);
  await handle.done(shell.close({ kind: "done", icon: close.icon, detail: detail.join("\n") }));
}

/** The gate a round boundary may carry, held to its shape: a level on the
 *  ladder and the gated findings as strings. `null` names a malformed one. */
function parseGate(raw: unknown): { level: AddressSeverity; findings: string[] } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  if (!isAddressSeverity(g.level)) return null;
  if (!Array.isArray(g.findings) || !g.findings.every((f) => typeof f === "string")) return null;
  return { level: g.level, findings: g.findings as string[] };
}

/** A round boundary: appended to the unit's row and drawn on the card. */
async function round(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  if (typeof body.index !== "number" || !Number.isInteger(body.index) || body.index < 0)
    return json(400, { ok: false, error: "index must be a whole number" });
  if (body.agent !== "coding" && body.agent !== "review")
    return json(400, { ok: false, error: "agent must be coding or review" });
  if (!ROUND_OUTCOMES.includes(body.outcome as ShipRoundOutcome))
    return json(400, { ok: false, error: `outcome must be one of ${ROUND_OUTCOMES.join(", ")}` });
  // The gate note (agent-ship item 9): the machine's severity check caught an
  // approve carrying a finding at or above the level in force — a verdict the
  // child's own parser should have downgraded (agent-review item 5a). Optional;
  // when present it is held to its shape, kept on the round and said out loud.
  const gate = body.gate === undefined ? undefined : parseGate(body.gate);
  if (gate === null)
    return json(400, {
      ok: false,
      error: "gate must be { level: blocking|major|minor|nit, findings: string[] }",
    });
  if (
    body.patternContinuation !== undefined &&
    (body.patternContinuation !== true ||
      body.agent !== "review" ||
      (body.outcome !== "request_changes" && body.outcome !== "approve"))
  )
    return json(400, { ok: false, error: "patternContinuation must mark a settled review" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  if (namesForeignRun(instance, body)) return json(404, { ok: false, error: "not_found" });
  const units = await deps.instances.listUnits(instance.id);
  const row = units.find((u) => u.unit === body.unit);
  if (!row) return json(404, { ok: false, error: "unit_not_found", unit: body.unit });
  if (row.workBrief !== undefined && deps.privateWorkerLog === undefined)
    return json(503, { ok: false, error: "private_worker_log_unavailable", at });
  const recoveryWorkflowId =
    typeof body.recoveryWorkflowId === "string" && INSTANCE_ID_PATTERN.test(body.recoveryWorkflowId)
      ? body.recoveryWorkflowId
      : undefined;
  if (body.recoveryWorkflowId !== undefined && recoveryWorkflowId === undefined)
    return json(400, { ok: false, error: "recoveryWorkflowId must be a Workflow instance id", at });
  if (row.recovery !== undefined && recoveryWorkflowId !== row.recovery.workflowId)
    return json(409, { ok: false, error: "recovery_claim_mismatch", at });
  const host = row.recovery !== undefined ? ({ kind: "not_host" } as const) : await hostRunOf(deps, instance);
  if (host.kind === "not_host" && row.recovery === undefined) return json(409, { ok: false, error: "not_host", at });
  const note = {
    index: body.index,
    agent: body.agent,
    outcome: body.outcome as string,
    at,
    ...(gate ? { gate } : {}),
    ...(body.patternContinuation === true ? { patternContinuation: true as const } : {}),
  };
  const previous = row.rounds.at(-1);
  if (
    row.recovery !== undefined &&
    previous?.index === note.index &&
    previous.agent === note.agent &&
    previous.outcome === note.outcome &&
    JSON.stringify(previous.gate) === JSON.stringify(note.gate) &&
    previous.patternContinuation === note.patternContinuation
  )
    return json(200, { ok: true, at: previous.at });
  const updated: CoordinatorUnit = {
    ...row,
    rounds: [...row.rounds, note],
    // The transport has started doing work. Admission rollback must no longer
    // remove publication authority already used by this recovery.
    ...(row.recovery?.previousBinding !== undefined
      ? { recovery: { ...row.recovery, previousBinding: undefined } }
      : {}),
  };
  if (row.recovery !== undefined) {
    let replaced: Awaited<ReturnType<CoordinatorInstanceStore["compareAndReplaceUnit"]>> | undefined;
    try {
      replaced = await deps.instances.compareAndReplaceUnit(row, updated);
    } catch {
      const reread = await deps.instances.listUnits(instance.id).catch(() => undefined);
      const current = reread?.filter((candidate) => candidate.unit === row.unit);
      if (current?.length === 1 && JSON.stringify(current[0]) === JSON.stringify(updated)) replaced = { ok: true };
      else if (current?.length === 1 && JSON.stringify(current[0]) === JSON.stringify(row))
        return json(503, { ok: false, error: "recovery_store_unavailable", at });
      else return json(409, { ok: false, error: "recovery_claim_stale", at });
    }
    if (replaced?.ok !== true)
      return json(409, {
        ok: false,
        error: replaced?.reason === "stale" ? "recovery_claim_stale" : "recovery_store_unavailable",
        at,
      });
  } else await deps.instances.putUnits([updated]);
  if (host.kind === "host") {
    const thread = unitThread(instance, updated, units.length);
    await hostPublish(
      deps,
      instance,
      host.runId,
      [
        {
          type: "ship_round",
          index: body.index,
          agent: body.agent,
          outcome: body.outcome as ShipRoundOutcome,
          ...(gate && row.workBrief === undefined ? { gate } : {}),
          at,
        },
        {
          type: "ship_unit",
          unit: updated.unit,
          state: body.outcome as string,
          ...(row.workBrief === undefined && thread.threadKey !== undefined ? { threadKey: thread.threadKey } : {}),
          ...(updated.pr !== undefined ? { pr: updated.pr.number } : {}),
          at,
        },
      ],
      at,
    );
  }
  if (gate && row.workBrief === undefined)
    (deps.log ?? console.warn)(
      `[coordinator] ${instance.id} ${row.unit}: severity gate fired on round ${body.index} — the review's approve carried ${gate.findings.join(", ")} at or above ${gate.level}, the level in force; the verdict was parsed at another level (agent-ship item 9)`,
    );
  await drawCard(
    deps,
    instance,
    units.map((u) => (u.unit === updated.unit ? updated : u)),
  ).catch((err) =>
    (deps.log ?? console.warn)(`[coordinator] ${instance.id}: the card could not be redrawn: ${describe(err)}`),
  );
  return json(200, { ok: true, at });
}

/** The idle an `idle` ending writes on the row (record 0051; run-history item
 *  50): the old kind as `why`, the renewals the grant still holds, the head a
 *  continuation opens from, the coding run id the driver sends today
 *  (`codingRunId`), the spend and the handoff — `wakes` starts at zero.
 *  Undefined names a malformed one. */
function parseIdle(ending: Record<string, unknown>, runId: unknown, at: number): UnitIdle | undefined {
  if (typeof ending.why !== "string" || ending.why.length === 0 || ending.why.length > IDLE_WHY_MAX) return undefined;
  if (typeof ending.renewalsLeft !== "number" || !Number.isInteger(ending.renewalsLeft) || ending.renewalsLeft < 0)
    return undefined;
  const from = normalizeHead(ending.from);
  return {
    why: ending.why,
    at,
    renewalsLeft: ending.renewalsLeft,
    ...(from !== undefined ? { from } : {}),
    ...(typeof runId === "string" && RUN_ID_PATTERN.test(runId) ? { runId } : {}),
    spendUsd: typeof ending.spendUsd === "number" && Number.isFinite(ending.spendUsd) ? ending.spendUsd : null,
    ...(isHandoffShape(ending.handoff) ? { handoff: ending.handoff } : {}),
    ...(isHumanGatePending(ending.humanGate) ? { humanGate: ending.humanGate } : {}),
    wakes: 0,
  };
}

/** The segment a continued ending opens, as the driver names it: its index (two up), the sha it continues from, the run whose write-up briefs it. */
function parseSegment(raw: unknown): { index: number; from?: string; runId?: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.index !== "number" || !Number.isInteger(s.index) || s.index < 2) return undefined;
  const from = normalizeHead(s.from);
  return {
    index: s.index,
    ...(from !== undefined ? { from } : {}),
    ...(typeof s.runId === "string" && RUN_ID_PATTERN.test(s.runId) ? { runId: s.runId } : {}),
  };
}

/** One indexed idle wake. Its answer and every event mark are one store
 * transaction; the answer is read first, making a reclaimed runner's replay a
 * pure read. */
async function unitWake(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  if (typeof body.waitId !== "string" || !STEP_NAME_PATTERN.test(body.waitId))
    return json(400, { ok: false, error: "waitId must be a step name" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  if (namesForeignRun(instance, body)) return json(404, { ok: false, error: "not_found" });
  const units = await deps.instances.listUnits(instance.id);
  const row = units.find((u) => u.unit === body.unit);
  if (!row) return json(404, { ok: false, error: "unit_not_found", unit: body.unit });
  if (row.workBrief !== undefined && deps.privateWorkerLog === undefined)
    return json(503, { ok: false, error: "private_worker_log_unavailable", at });
  if (row.workBrief !== undefined) {
    try {
      await deps.privateWorkerLog!.list(privateWorkerThreadKey({ instanceId: instance.id, unit: row.unit }));
    } catch {
      return json(503, { ok: false, error: "private_worker_log_unavailable", at });
    }
  }
  const host = await hostRunOf(deps, instance);
  if (host.kind === "not_host") return json(409, { ok: false, error: "not_host", at });
  const deliverPrivateWake = async (answer: UnitWakeAnswer): Promise<boolean> => {
    if (row.workBrief === undefined || answer.kind !== "answered") return true;
    try {
      await appendPrivateWorkerReply(
        deps.privateWorkerLog!,
        { instanceId: instance.id, unit: row.unit },
        {
          id: body.waitId as string,
          text: answer.reply,
          at,
        },
      );
      return true;
    } catch {
      return false;
    }
  };
  const stored = row.wakes?.[body.waitId];
  if (stored !== undefined) {
    if (!(await deliverPrivateWake(stored)))
      return json(503, { ok: false, error: "private_worker_log_unavailable", at });
    return json(200, { ok: true, answer: stored, at });
  }
  if (!row.idle) {
    const answer: UnitWakeAnswer = row.ending?.kind === "stopped" ? { kind: "stopped" } : { kind: "expired" };
    await deps.instances.answerWake(row, body.waitId, answer, [], body.waitId);
    return json(200, { ok: true, answer, at });
  }

  const events = await deps.instances.listEvents({ instanceId: instance.id, unit: row.unit }, true);
  const idle = row.idle;
  // A human-gated question is answered only by input after the verdict that
  // asked it. GitHub rounds comments to seconds, so its boundary includes the
  // reported verdict second; precise channel timestamps keep strict ordering.
  const askedAt = idle.humanGate?.askedAt;
  const wakeEvents =
    askedAt !== undefined
      ? events.filter((event) =>
          event.id?.startsWith("github:issue-comment:") ? event.at >= githubSecondStart(askedAt) : event.at > askedAt,
        )
      : events;
  const senderOf = (e: ThreadEvent): string => e.senderName ?? e.sender;
  const senders = [...new Set(wakeEvents.map(senderOf))];
  const requesterWoke = wakeEvents.some((event) => event.sender === instance.userId);
  const stopperWoke = wakeEvents.some((event) => event.mode === "interrupt");
  const grantFact = deps.shipGrantFor?.(instance) ?? {
    grant: instance.grant ?? DEFAULT_GRANT,
    source: instance.grantSource ?? ("org" as const),
  };
  const renewalsSpent = row.segments?.length ?? 0;
  let answer: UnitWakeAnswer;

  if (wakeEvents.length === 0) {
    answer = { kind: "answered", reply: "Nothing new was waiting for this unit." };
  } else if (idle.wakes + 1 >= IDLE_WAKES_MAX) {
    answer = { kind: "expired" };
  } else if (idle.humanGate !== undefined) {
    // A person's answer to a human-gated question resumes the same segment;
    // it is not a request for another renewal. The fresh lease is the bounded
    // room needed for the answer's fix round and re-review.
    answer = {
      kind: "segment",
      index: row.segments?.at(-1)?.index ?? 1,
      ...(idle.from !== undefined ? { from: idle.from } : {}),
      ...(idle.runId !== undefined ? { runId: idle.runId } : {}),
      spendUsd: idle.spendUsd,
      ...(idle.handoff !== undefined ? { handoff: idle.handoff } : {}),
      texts: wakeEvents.map(attributedText),
      senders,
      leaseMs: minutesToMs(instance.caps?.maxMinutes ?? resolveShipCaps(undefined).maxMinutes),
      humanGate: idle.humanGate,
    };
  } else {
    const segmentStart = row.segments?.at(-1)?.at ?? row.startedAt ?? idle.at;
    const leaseMs = Math.max(
      0,
      minutesToMs(instance.caps?.maxMinutes ?? resolveShipCaps(undefined).maxMinutes) - (idle.at - segmentStart),
    );
    if (idle.why === "stopped" && (requesterWoke || stopperWoke) && leaseMs >= minutesToMs(leaseMinimum("coding"))) {
      answer = {
        kind: "segment",
        index: row.segments?.at(-1)?.index ?? 1,
        ...(idle.from !== undefined ? { from: idle.from } : {}),
        ...(idle.runId !== undefined ? { runId: idle.runId } : {}),
        spendUsd: idle.spendUsd,
        ...(idle.handoff !== undefined ? { handoff: idle.handoff } : {}),
        texts: wakeEvents.map(attributedText),
        senders,
        leaseMs,
      };
    } else if (!requesterWoke) {
      answer = {
        kind: "answered",
        reply: `The grant's renewals are the requester's to spend; ${Math.max(0, grantFact.grant.renewals - renewalsSpent)} left.`,
      };
    } else {
      const decision = renewalDecision({
        grant: grantFact.grant,
        renewalsSpent,
        spendUsd: idle.spendUsd,
        progress: "set_aside",
        pipeline: instance.caps ?? resolveShipCaps(undefined),
      });
      if (decision.renew) {
        answer = {
          kind: "segment",
          index: decision.segment,
          ...(idle.from !== undefined
            ? { from: idle.from }
            : decision.from !== undefined
              ? { from: decision.from }
              : {}),
          ...(idle.runId !== undefined ? { runId: idle.runId } : {}),
          spendUsd: idle.spendUsd,
          ...(idle.handoff !== undefined ? { handoff: idle.handoff } : {}),
          texts: wakeEvents.map(attributedText),
          senders,
        };
      } else {
        answer = {
          kind: "answered",
          reply: `${renderRenewal(decision, grantFact.grant, { idle: true })} (grant from ${grantFact.source}); the idle unit remains open, and \`runs stop ${instance.id}:${row.unit}\` is its stop command.`,
        };
      }
    }
  }

  const countedIdle = wakeEvents.length > 0 ? { ...idle, wakes: idle.wakes + 1 } : idle;
  const segments = row.segments ?? [];
  // A segment answer resumes work. Keep its durable wake, but stop marking the
  // unit idle so publication and intake read the current lifecycle correctly.
  const { idle: _idle, ...activeRow } = row;
  const updated: CoordinatorUnit = {
    ...(answer.kind === "segment" ? activeRow : { ...row, idle: countedIdle }),
    ...(answer.kind === "segment" && answer.index >= 2 && !segments.some((s) => s.index === answer.index)
      ? {
          segments: [
            ...segments,
            {
              index: answer.index,
              ...(answer.from ? { from: answer.from } : {}),
              ...(answer.runId ? { runId: answer.runId } : {}),
              at,
            },
          ],
        }
      : {}),
  };
  const by = answer.kind === "segment" ? `segment:${answer.index}` : body.waitId;
  await deps.instances.answerWake(
    updated,
    body.waitId,
    answer,
    events.map((e) => e.seq),
    by,
  );
  const visible = { ...updated, wakes: { ...(updated.wakes ?? {}), [body.waitId]: answer } };
  if (answer.kind === "answered") {
    if (row.workBrief !== undefined) {
      if (!(await deliverPrivateWake(answer)))
        return json(503, { ok: false, error: "private_worker_log_unavailable", at });
    } else {
      const io = unitIO(deps, instance, visible);
      await io?.reply(answer.reply);
    }
  }
  await drawCard(
    deps,
    instance,
    units.map((u) => (u.unit === visible.unit ? visible : u)),
  ).catch((err) =>
    (deps.log ?? console.warn)(`[coordinator] ${instance.id}: the card could not be redrawn: ${describe(err)}`),
  );
  return json(200, { ok: true, answer, at });
}

/** A unit ended: the row says how, the unit's thread gets the report, the card is redrawn. */
async function unitEnd(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const ending = body.ending as Record<string, unknown> | undefined;
  if (
    typeof ending !== "object" ||
    ending === null ||
    typeof ending.kind !== "string" ||
    typeof ending.report !== "string"
  )
    return json(400, { ok: false, error: "ending must carry a kind and a report" });
  const outcome = ending.outcome;
  if (outcome !== undefined && (!isShipOutcome(outcome) || outcome.kind !== ending.kind))
    return json(400, { ok: false, error: "ending outcome must match its kind" });
  const cause =
    typeof ending.cause === "string" && ending.cause.length > 0 && ending.cause.length <= 64 ? ending.cause : undefined;
  if (ending.cause !== undefined && cause === undefined)
    return json(400, { ok: false, error: "ending cause must be 1 to 64 characters" });
  const failedStep = typeof ending.step === "string" && STEP_NAME_PATTERN.test(ending.step) ? ending.step : undefined;
  if (ending.step !== undefined && failedStep === undefined)
    return json(400, { ok: false, error: "ending step must be a step name" });
  const failedRound =
    typeof ending.round === "number" && Number.isInteger(ending.round) && ending.round >= 0 ? ending.round : undefined;
  if (ending.round !== undefined && failedRound === undefined)
    return json(400, { ok: false, error: "ending round must be a non-negative integer" });
  // The thread's copy of the report (routing-and-config item 28): the driver
  // renders it at the request's verbosity beside the full report the row and
  // the board keep; absent (an older driver), the full report is the thread's.
  // Empty means the level says nothing here — a quiet segment boundary.
  let fullReport = ending.report as string;
  let threadReport = typeof ending.threadReport === "string" ? ending.threadReport : ending.report;
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  if (namesForeignRun(instance, body)) return json(404, { ok: false, error: "not_found" });
  const units = await deps.instances.listUnits(instance.id);
  const row = units.find((u) => u.unit === body.unit);
  if (!row) return json(404, { ok: false, error: "unit_not_found", unit: body.unit });
  if (
    body.deliveryId !== undefined &&
    (typeof body.deliveryId !== "string" || !STEP_NAME_PATTERN.test(body.deliveryId))
  )
    return json(400, { ok: false, error: "deliveryId must be a step name", at });
  const reportThread = unitThread(instance, row, units.length).threadKey ?? instance.threadKey;
  if (!deps.reportLedger) return json(503, { ok: false, error: "report_context_unavailable", at });
  const deliveryStep =
    typeof body.deliveryId === "string"
      ? body.deliveryId
      : typeof body.recoveryWorkflowId === "string"
        ? `recovery:${body.recoveryWorkflowId}`
        : ending.kind === "continued"
          ? `legacy-segment:${parseSegment(body.segment)?.index ?? "invalid"}`
          : ending.kind === "idle"
            ? `legacy-idle:${row.segments?.at(-1)?.index ?? 1}:${body.codingRunId ?? "none"}`
            : `legacy-end:${ending.kind}`;
  const reportDelivery =
    typeof body.recoveryWorkflowId === "string" ? `recovery:${body.recoveryWorkflowId}:${deliveryStep}` : deliveryStep;
  const reportOwner: CoordinatorReportOwner = {
    instanceId: instance.id,
    unit: row.unit,
    attempt: instance.attempt ?? 0,
    requester: instance.userId,
    channelId: instance.channelId,
    threadKey: reportThread,
    deliveryId: reportDelivery,
  };
  const freezeReport = async (committed: CoordinatorUnit) => {
    const frozen = await freezeAdmittedCoordinatorReport(deps.reportLedger!, committed.reportDelivery, reportOwner, {
      text: fullReport,
      threadText: threadReport as string,
    });
    fullReport = frozen.text;
    threadReport = frozen.threadText;
    ending.report = fullReport;
  };
  try {
    const frozen = await readCoordinatorReport(deps.reportLedger, reportOwner);
    if (frozen) {
      fullReport = frozen.text;
      threadReport = frozen.threadText;
      ending.report = fullReport;
    }
  } catch {
    return json(503, { ok: false, error: "report_context_unavailable", at });
  }
  const pr = body.pr as { number?: unknown; url?: unknown } | undefined;
  if (
    outcome !== undefined &&
    pr !== undefined &&
    (pr === null ||
      typeof pr !== "object" ||
      !Number.isSafeInteger(pr.number) ||
      (pr.number as number) <= 0 ||
      typeof pr.url !== "string" ||
      pr.url.length === 0)
  )
    return json(400, { ok: false, error: "ending pull request must carry a number and URL", at });
  if (
    outcome !== undefined &&
    pr !== undefined &&
    row.pr !== undefined &&
    (pr.number !== row.pr.number || pr.url !== row.pr.url)
  )
    return json(400, { ok: false, error: "ending outcome must match the unit pull request", at });
  if (outcome?.terminalPr !== undefined) {
    const target = pr ?? row.pr;
    if (
      target?.number !== outcome.terminalPr.number ||
      target.url !== outcome.terminalPr.url ||
      (row.pr !== undefined && (row.pr.number !== outcome.terminalPr.number || row.pr.url !== outcome.terminalPr.url))
    )
      return json(400, { ok: false, error: "ending outcome must match the unit pull request", at });
  }
  // A producer retry may finish delivery, but cannot rewrite a recorded result.
  // Recovery first claims and removes the old ending under its own fenced path.
  if (
    row.ending !== undefined &&
    (row.ending.kind !== ending.kind ||
      row.ending.report !== ending.report ||
      !sameShipOutcome(row.ending.outcome, outcome))
  )
    return json(409, { ok: false, error: "settlement_conflict", at });
  if (
    row.workBrief !== undefined &&
    row.ending !== undefined &&
    (row.ending.outcome !== undefined || row.history !== undefined) &&
    row.ending.deliveryId !== body.deliveryId
  )
    return json(409, { ok: false, error: "settlement_conflict", at });
  if (row.workBrief !== undefined && deps.privateWorkerLog === undefined)
    return json(503, { ok: false, error: "private_worker_log_unavailable", at });
  if (row.workBrief !== undefined) {
    if (typeof body.deliveryId !== "string" || !STEP_NAME_PATTERN.test(body.deliveryId))
      return json(400, { ok: false, error: "deliveryId must be a step name", at });
    try {
      await deps.privateWorkerLog!.list(privateWorkerThreadKey({ instanceId: instance.id, unit: row.unit }));
    } catch {
      return json(503, { ok: false, error: "private_worker_log_unavailable", at });
    }
  }
  const deliverPrivateReport = async (): Promise<boolean> => {
    try {
      await appendPrivateWorkerReply(
        deps.privateWorkerLog!,
        { instanceId: instance.id, unit: row.unit },
        { id: body.deliveryId as string, text: fullReport, at },
      );
      return true;
    } catch {
      return false;
    }
  };
  const recordStatus = async (committed: CoordinatorUnit): Promise<boolean> => {
    try {
      const status = await appendCoordinatorStatus(
        { ledger: deps.reportLedger!, instances: deps.instances },
        { owner: reportOwner, instance, unit: committed },
      );
      return status !== undefined;
    } catch {
      return false;
    }
  };
  const recoveryWorkflowId =
    typeof body.recoveryWorkflowId === "string" && INSTANCE_ID_PATTERN.test(body.recoveryWorkflowId)
      ? body.recoveryWorkflowId
      : undefined;
  if (body.recoveryWorkflowId !== undefined && recoveryWorkflowId === undefined)
    return json(400, { ok: false, error: "recoveryWorkflowId must be a Workflow instance id", at });
  if (row.recovery !== undefined && recoveryWorkflowId !== row.recovery.workflowId)
    return json(409, { ok: false, error: "recovery_claim_mismatch", at });
  if (
    recoveryWorkflowId !== undefined &&
    row.recoveryReceipt?.workflowId === recoveryWorkflowId &&
    row.ending === undefined
  )
    return json(409, { ok: false, error: "settlement_conflict", at });
  if (
    outcome?.recoveryStop !== undefined &&
    !(
      (row.recovery?.kind === "coding" && row.recovery.round === 0 && row.recovery.workflowId === recoveryWorkflowId) ||
      (row.recovery === undefined &&
        row.recoveryReceipt?.codingRunId !== undefined &&
        row.recoveryReceipt.workflowId === recoveryWorkflowId &&
        sameShipOutcome(row.ending?.outcome, outcome))
    )
  )
    return json(409, { ok: false, error: "recovery_outcome_mismatch", at });
  const settlementActionId =
    row.recovery?.actionId ?? (row.history?.receiptId !== "observed" ? row.history?.receiptId : undefined);
  const settlementOwner: RunnerPullOwner = {
    instanceId: instance.id,
    unit: row.unit,
    ...(settlementActionId !== undefined ? { recoveryActionId: settlementActionId } : {}),
  };
  const reportAdmission = await coordinatorReportAdmission(reportOwner, {
    text: fullReport,
    threadText: threadReport as string,
  });
  const sameReport = await sameCoordinatorReportAdmission(row.reportDelivery, reportAdmission);
  if (
    row.reportDelivery !== undefined &&
    !sameReport &&
    (sameCoordinatorReportOwner(row.reportDelivery.owner, reportOwner) || row.ending !== undefined)
  )
    return json(409, { ok: false, error: "settlement_conflict", at });
  if (recoveryWorkflowId !== undefined && row.recoveryReceipt?.workflowId === recoveryWorkflowId) {
    const committed = sameReport ? row : { ...row, reportDelivery: reportAdmission };
    if (!sameReport) {
      try {
        const accepted = await deps.instances.compareAndReplaceUnit(row, committed);
        if (!accepted.ok)
          return json(accepted.reason === "unavailable" ? 503 : 409, {
            ok: false,
            error: accepted.reason === "unavailable" ? "settlement_store_unavailable" : "settlement_conflict",
            at,
          });
      } catch {
        const current = await deps.instances.listUnits(instance.id).catch(() => undefined);
        const matches = current?.filter((candidate) => candidate.unit === row.unit);
        if (matches === undefined || (matches.length === 1 && JSON.stringify(matches[0]) === JSON.stringify(row)))
          return json(503, { ok: false, error: "settlement_store_unavailable", at });
        if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(committed))
          return json(409, { ok: false, error: "settlement_conflict", at });
      }
    }
    try {
      await freezeReport(committed);
    } catch {
      return json(503, { ok: false, error: "report_context_unavailable", at });
    }
    if (!(await recordStatus(committed))) return json(503, { ok: false, error: "report_context_unavailable", at });
    if (row.workBrief !== undefined && !(await deliverPrivateReport()))
      return json(503, { ok: false, error: "private_worker_log_unavailable", at });
    if (row.pr !== undefined) {
      deps.runnerOwnership?.release(instance.repo, row.pr.number, settlementOwner);
    }
    return json(200, {
      ok: true,
      alreadySettled: true,
      ...(row.workBrief !== undefined ? { told: true } : {}),
      at: row.recoveryReceipt.at,
    });
  }

  const host = row.recovery !== undefined ? ({ kind: "not_host" } as const) : await hostRunOf(deps, instance);
  if (host.kind === "not_host" && row.recovery === undefined) return json(409, { ok: false, error: "not_host", at });
  // The driver's `headSha` is the exact continuation boundary: the coding
  // child's last push for review_pending, or the final approved head for
  // merge_ready. Persist it as `lastPush` for the next attempt's pre-check.
  const lastPush = normalizeHead(body.headSha);
  // A continued ending is a segment's end, not the unit's (decision 0046):
  // the renewal is written as a row keyed by the segment it opens — once; a
  // runner reclaimed between the segment's end and its renewal finds the row
  // and does not renew twice — and the unit keeps no ending.
  const segment = ending.kind === "continued" ? parseSegment(body.segment) : undefined;
  if (ending.kind === "continued" && segment === undefined)
    return json(400, { ok: false, error: "a continued ending must carry the segment it opens" });
  // An idle ending is not the unit's end (record 0051): the row gets the idle
  // — the old kind as `why` and the continuation facts — and no `ending`, so
  // the unit stays unfinished and keeps owning its thread.
  const idle = ending.kind === "idle" ? parseIdle(ending, body.codingRunId, at) : undefined;
  if (ending.kind === "idle" && idle === undefined)
    return json(400, { ok: false, error: "an idle ending must carry its why and the renewals left" });
  const segments = row.segments ?? [];
  const recoveryHold =
    row.recovery !== undefined && ending.kind === "held" && isHumanGatePending(ending.humanGate)
      ? ({ cause: "human", gate: ending.humanGate } as const)
      : row.recovery !== undefined &&
          ending.kind === "held" &&
          ending.holdCause === "draft" &&
          pr !== undefined &&
          typeof pr.number === "number" &&
          typeof pr.url === "string"
        ? ({ cause: "draft", pr: { number: pr.number, url: pr.url } } as const)
        : row.recovery !== undefined && ending.kind === "held" && ending.holdCause === "blocked"
          ? ({ cause: "blocked" } as const)
          : undefined;
  if (row.recovery !== undefined && ending.kind === "held" && recoveryHold === undefined)
    return json(400, { ok: false, error: "a recovered held ending must carry a typed hold cause", at });
  if (row.recovery !== undefined && (idle !== undefined || segment !== undefined))
    return json(409, { ok: false, error: "recovery_continuation_unsupported", at });
  if (row.recovery !== undefined && row.pr !== undefined) {
    try {
      if (deps.runnerOwnership?.claim(instance.repo, row.pr.number, settlementOwner) !== true)
        return json(409, { ok: false, error: "publication_ownership_changed", at });
    } catch (err) {
      return json(409, { ok: false, error: "publication_ownership_unknown", message: describe(err), at });
    }
  }
  // A real ending is the unit's end: an idle the row carried from an earlier
  // stop is dropped with it, so the row says one thing about how the unit stands.
  const { idle: _idle, recovery: _recovery, ...rowWithoutLifecycle } = row;
  let updated: CoordinatorUnit =
    sameReport || row.ending !== undefined
      ? row
      : {
          ...(idle !== undefined || segment !== undefined ? row : rowWithoutLifecycle),
          ...(row.recovery !== undefined
            ? {
                recoveryReceipt: {
                  ...(row.recovery.kind === "coding"
                    ? { codingRunId: row.recovery.codingRunId }
                    : { reviewRunId: row.recovery.reviewRunId }),
                  ...(row.recovery.externalReview !== undefined ? { externalReview: row.recovery.externalReview } : {}),
                  ...(row.recovery.accounting !== undefined ? { accounting: row.recovery.accounting } : {}),
                  workflowId: row.recovery.workflowId,
                  at,
                },
              }
            : {}),
          ...(recoveryHold !== undefined ? { recoveryHold } : {}),
          ...(pr && typeof pr.number === "number" && typeof pr.url === "string"
            ? { pr: { number: pr.number, url: pr.url } }
            : {}),
          ...(lastPush !== undefined ? { lastPush } : {}),
          ...(idle !== undefined
            ? { idle }
            : segment !== undefined
              ? {
                  segments: segments.some((s) => s.index === segment.index)
                    ? segments
                    : [...segments, { ...segment, at }],
                }
              : {
                  ending: {
                    kind: ending.kind,
                    report: fullReport,
                    ...(outcome !== undefined ? { outcome } : {}),
                    ...((outcome !== undefined || row.history !== undefined) && row.workBrief !== undefined
                      ? { deliveryId: body.deliveryId as string }
                      : {}),
                    // Machine-readable failure context (issue 2100): readers do not
                    // need to parse the person's report to locate a thrown step.
                    ...(cause !== undefined ? { cause } : {}),
                    ...(failedStep !== undefined ? { step: failedStep } : {}),
                    ...(failedRound !== undefined ? { round: failedRound } : {}),
                    at,
                  },
                }),
        };
  updated = { ...updated, reportDelivery: sameReport ? row.reportDelivery : reportAdmission };
  // Every caller participates, including an older driver's unprojected ending:
  // a stale legacy or idle write must not erase a newer typed settlement.
  const storeError = row.recovery !== undefined ? "recovery_store_unavailable" : "settlement_store_unavailable";
  const staleError = row.recovery !== undefined ? "recovery_claim_stale" : "settlement_conflict";
  let replaced:
    | Awaited<ReturnType<CoordinatorInstanceStore["compareAndReplaceUnit"]>>
    | Awaited<ReturnType<CoordinatorInstanceStore["transitionRecovery"]>>
    | undefined;
  try {
    if (row.recovery?.actionId !== undefined) {
      const replacement = updated;
      updated = { ...updated, history: { version: 1, receiptId: row.recovery.actionId } };
      const result = await deps.instances.transitionRecovery({ kind: "settle", expected: row, replacement });
      replaced = result;
      if (result.ok) updated = result.unit;
    } else replaced = await deps.instances.compareAndReplaceUnit(row, updated);
  } catch {
    const reread = await deps.instances.listUnits(instance.id).catch(() => undefined);
    const current = reread?.filter((candidate) => candidate.unit === row.unit);
    if (current === undefined) return json(503, { ok: false, error: storeError, at });
    if (current?.length === 1 && JSON.stringify(current[0]) === JSON.stringify(updated)) {
      replaced = { ok: true };
      updated = current[0]!;
    } else if (current?.length === 1 && JSON.stringify(current[0]) === JSON.stringify(row))
      return json(503, { ok: false, error: storeError, at });
    else return json(409, { ok: false, error: staleError, at });
  }
  if (replaced?.ok !== true)
    return json(replaced?.reason === "unavailable" || replaced === undefined ? 503 : 409, {
      ok: false,
      error:
        replaced?.reason === "stale"
          ? staleError
          : replaced?.reason === "conflict"
            ? "settlement_conflict"
            : replaced?.reason === "capacity"
              ? "recovery_history_capacity"
              : storeError,
      at,
    });
  try {
    await freezeReport(updated);
  } catch {
    return json(503, { ok: false, error: "report_context_unavailable", at });
  }
  if (!(await recordStatus(updated))) return json(503, { ok: false, error: "report_context_unavailable", at });
  if (segment === undefined && idle === undefined && updated.pr !== undefined)
    deps.runnerOwnership?.release(instance.repo, updated.pr.number, settlementOwner);
  const thread = unitThread(instance, updated, units.length);
  if (host.kind === "host")
    await hostPublish(
      deps,
      instance,
      host.runId,
      [
        {
          type: "ship_unit",
          unit: updated.unit,
          state: ending.kind,
          ...(row.workBrief === undefined && thread.threadKey !== undefined ? { threadKey: thread.threadKey } : {}),
          ...(row.workBrief === undefined ? { report: fullReport } : {}),
          ...(updated.pr !== undefined ? { pr: updated.pr.number } : {}),
          at,
        },
      ],
      at,
    );
  const io = unitIO(deps, instance, updated);
  // The leftovers (record 0051's fold rule): events still unconsumed when the unit ends
  // run as ONE fresh turn in the unit's thread — as a run's unconsumed
  // follow-ups do at the settle — dispatched as the requester with each text
  // attributed to its sender. Marked consumed BEFORE the dispatch under this
  // ending's identity, so a replayed unit-end finds nothing and never runs
  // them twice; the row's ending is already written, so the fresh turn routes
  // as an unowned thread's message, never back onto this list. With no channel
  // handle to run the turn in, the events stay unconsumed on the ended row and
  // the log says so by count — a loss the operator can read, never a silent one.
  // An idle unit has not ended: its events wait for the fold or the wake
  // (record 0051; the wait lands with this plan's fifth unit).
  if (segment === undefined && idle === undefined && row.recovery === undefined && row.workBrief === undefined) {
    const leftovers = await deps.instances
      .listEvents({ instanceId: instance.id, unit: row.unit }, true)
      .catch(() => [] as ThreadEvent[]);
    if (leftovers.length > 0 && io === undefined) {
      (deps.log ?? console.warn)(
        `[coordinator] ${instance.id} ${row.unit}: ${leftovers.length} leftover thread event(s) stay unconsumed — ` +
          `no channel handle for the unit's thread${thread.threadKey !== undefined ? ` ${thread.threadKey}` : ""}, so no fresh turn ran`,
      );
    } else if (leftovers.length > 0 && io !== undefined) {
      await deps.instances
        .markConsumed(
          { instanceId: instance.id, unit: row.unit },
          leftovers.map((e) => e.seq),
          `unit-end:${row.unit}`,
        )
        .catch((err) =>
          (deps.log ?? console.warn)(
            `[coordinator] ${instance.id} ${row.unit}: the leftover marks failed: ${describe(err)}`,
          ),
        );
      const freshTurn: IncomingMessage = {
        channelId: instance.channelId,
        userId: instance.userId,
        ...(instance.userName !== undefined ? { userName: instance.userName } : {}),
        ...(instance.authenticatedAs !== undefined ? { authenticatedAs: instance.authenticatedAs } : {}),
        ...(instance.postedBy !== undefined ? { postedBy: instance.postedBy } : {}),
        ...(instance.channelName !== undefined ? { channelName: instance.channelName } : {}),
        threadKey: thread.threadKey!,
        ...(thread.sourceUrl !== undefined ? { sourceUrl: thread.sourceUrl } : {}),
        text: foldThreadEvents(leftovers),
        ...foldThreadAttachments(leftovers),
        receivedAt: at,
      };
      void deps
        .dispatch(freshTurn, io)
        .catch((err) =>
          (deps.log ?? console.warn)(
            `[coordinator] ${instance.id} ${row.unit}: the leftovers' fresh turn threw: ${describe(err)}`,
          ),
        );
      (deps.log ?? console.log)(
        `[coordinator] ${instance.id} ${row.unit}: ${leftovers.length} leftover thread event(s) run as one fresh turn`,
      );
    }
  }
  if (segment === undefined && idle === undefined && row.recovery !== undefined) {
    const leftovers = await deps.instances
      .listEvents({ instanceId: instance.id, unit: row.unit }, true)
      .catch(() => [] as ThreadEvent[]);
    if (leftovers.length > 0)
      (deps.log ?? console.warn)(
        `[coordinator] ${instance.id} ${row.unit}: ${leftovers.length} recovery event(s) stay unconsumed — terminal recovery never redispatches a replacement pipeline`,
      );
  }
  let told = false;
  if (row.workBrief !== undefined) {
    if (!(await deliverPrivateReport())) return json(503, { ok: false, error: "private_worker_log_unavailable", at });
    told = true;
  } else if (io && threadReport.length === 0)
    told = true; // nothing owed to the thread at this level
  else if (io) {
    try {
      await io.reply(threadReport);
      told = true;
    } catch (err) {
      (deps.log ?? console.warn)(
        `[coordinator] ${instance.id} ${row.unit}: the report could not be posted: ${describe(err)}`,
      );
    }
  }
  // The unit's ending reaches the board (agent-ship item 14's destination):
  // when the row names an issue, the report lands there too — a merge GitHub
  // refused, a cap, a stop — and under it the last coding child's typed handoff
  // as the parent renders it, so a deviation the child recorded reaches the
  // board without a person copying it over. Best effort, like the thread's.
  if (row.issue !== undefined && row.workBrief === undefined) {
    const handoff = await codingHandoffOf(deps, instance, body.codingRunId);
    const rendered =
      handoff !== undefined
        ? renderHandoffComment(handoff, { unitId: row.unit, ...(updated.pr !== undefined ? { pr: updated.pr } : {}) })
        : undefined;
    const comment =
      `**Plan runner — ${row.unit} ended \`${ending.kind}\`**${updated.pr ? ` · ${updated.pr.url}` : ""}\n\n${ending.report}` +
      (rendered !== undefined ? `\n\n${rendered}` : "");
    await deps.github
      .commentIssue(instance.repo, row.issue, comment)
      .catch((err) =>
        (deps.log ?? console.warn)(
          `[coordinator] ${instance.id} ${row.unit}: the board comment could not be posted: ${describe(err)}`,
        ),
      );
  }
  // An ordinary human-gated unit leaves its report on the pull request beside
  // the review. A private worker reports only to the main agent's durable log.
  const parkedHumanGate = ending.kind === "idle" && idle?.humanGate !== undefined;
  if (row.workBrief === undefined && (ending.kind === "held" || parkedHumanGate) && updated.pr !== undefined) {
    const state = parkedHumanGate ? "waiting for a person" : "held";
    await deps.github
      .commentIssue(instance.repo, updated.pr.number, `**Plan runner — ${row.unit} ${state}**\n\n${ending.report}`)
      .catch((err) =>
        (deps.log ?? console.warn)(
          `[coordinator] ${instance.id} ${row.unit}: the human-gated report could not be posted on the pull request: ${describe(err)}`,
        ),
      );
  }
  await drawCard(
    deps,
    instance,
    units.map((u) => (u.unit === updated.unit ? updated : u)),
  ).catch(() => {});
  (deps.log ?? console.log)(`[coordinator] ${instance.id} ${row.unit}: ended ${ending.kind}`);
  return json(200, { ok: true, told, at });
}

/** The typed handoff the unit's last coding child submitted (agent-ship item
 *  14), read from its record — a run of this instance and no other, as
 *  `read-record` reads; none for a run the history lacks, a run outside the
 *  instance, a record without one, or an id that is not a run id. Never a
 *  refusal: the ending is recorded whatever became of the handoff. */
async function codingHandoffOf(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  runId: unknown,
): Promise<Handoff | undefined> {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) return undefined;
  const res = await deps.runs
    .getRun(runId, { privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ })
    .catch(() => undefined);
  if (res === undefined || !res.ok || res.value.parentInstanceId !== instance.id) return undefined;
  return isHandoffShape(res.value.handoff) ? res.value.handoff : undefined;
}

// ---- the merge (docs/reference/specs/http-ingress.md item 9; record 0031's merge grant) ------------

/**
 * `POST /admin/coordinator/merge {parentInstanceId, unit, prNumber, headSha}`:
 * the runner's squash of a unit's pull request, executed only when every guard
 * holds — the bearer holds `plan:merge`, the unit's branch is a plan branch of
 * THIS instance's plan, the pull request is open, heads that branch and stands
 * at exactly the approved head, the bot's own approving review is pinned to it
 * and every check at it is green — and refused by reason otherwise, so a person
 * decides: the release pull request by name, any other branch as "waits for a
 * person", GitHub's own refusal (a conflict, a branch protection, a moved head)
 * in GitHub's words. Checks still running answer `pending` for the machine's
 * poll. GitHub unreachable is a passing condition (502), never a verdict.
 *
 * A base that takes changes only through a merge queue is enqueued, never
 * squashed and never refused (issue 2011): the base branch's ruleset says so
 * ahead of the attempt, or — when the rules could not be read — GitHub's own
 * 405 wording does; either way the door enqueues (the GraphQL
 * `enqueuePullRequest` mutation, the same act `gh pr merge --auto` performs)
 * and answers `enqueued`. A `queued: true` re-ask reads the queue's outcome
 * instead: merged from the facts, still `enqueued`, or `removed` with the
 * queue's own reason for the machine's finding round.
 */
/** A runner rebase reports its own pushed commit. Verify that report against
 * the PR ref before making the new head durable for later checks and rounds. */
async function advanceRunnerRebasePublication(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  from: string,
  reportedHead?: string,
): Promise<string | undefined> {
  const binding = row.publication;
  if (binding === undefined) return undefined;
  const owner = { instanceId: instance.id, unit: row.unit };
  if (
    instance.stop !== undefined ||
    row.ending !== undefined ||
    row.pr?.number !== binding.pr ||
    !samePublicationOwner(binding.owner, owner) ||
    binding.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    binding.headRef !== row.branch ||
    binding.publicationRef !== row.branch ||
    binding.baseRef !== instance.base ||
    !fullHead(from) ||
    (reportedHead !== undefined && !fullHead(reportedHead)) ||
    binding.expectedHeadSha !== from
  )
    throw new PublicationBindingRefusal("publication_facts_mismatch");
  const facts = await deps.fetchPrFacts({ repo: instance.repo, number: binding.pr });
  if (
    facts?.state !== "open" ||
    facts.sameRepoHead !== true ||
    facts.headBranchExists !== true ||
    facts.headRef !== binding.headRef ||
    facts.baseRef !== binding.baseRef ||
    !fullHead(facts.headSha) ||
    (reportedHead !== undefined && facts.headSha !== reportedHead) ||
    facts.verifiedHead?.repo.toLowerCase() !== instance.repo.toLowerCase() ||
    facts.verifiedHead.ref !== binding.publicationRef ||
    facts.verifiedHead.sha !== facts.headSha
  )
    throw new PublicationBindingRefusal("publication_facts_mismatch");
  const to = facts.headSha;
  if (to === from) return undefined;
  const updated: CoordinatorUnit = {
    ...row,
    ...(reportedHead !== undefined ? { lastPush: to } : {}),
    publication: { ...binding, expectedHeadSha: to },
  };
  const replaced = await deps.instances.compareAndReplaceUnit(row, updated).catch(() => undefined);
  if (replaced?.ok !== true)
    throw new PublicationBindingRefusal(
      replaced?.reason === "stale" ? "publication_binding_stale" : "publication_store_unavailable",
    );
  let stillOwned = false;
  try {
    stillOwned = samePublicationOwner(deps.runnerOwnership?.owner(instance.repo, binding.pr), owner);
  } catch {
    /* Unknown ownership also requires rollback. */
  }
  if (!stillOwned) {
    const restored = await deps.instances.compareAndReplaceUnit(updated, row).catch(() => undefined);
    if (restored?.ok !== true) throw new PublicationBindingRefusal("publication_rollback_failed");
    throw new PublicationBindingRefusal("publication_ownership_changed");
  }
  return to;
}

async function rebaseStep(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  if (typeof body.prNumber !== "number" || !Number.isInteger(body.prNumber) || body.prNumber <= 0)
    return json(400, { ok: false, error: "prNumber must be a pull request number" });
  if (typeof body.headSha !== "string" || !/^[0-9a-f]{7,40}$/i.test(body.headSha))
    return json(400, { ok: false, error: "headSha must be a commit sha" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance", at });
  const row = (await deps.instances.listUnits(instance.id)).find((u) => u.unit === body.unit);
  if (!row) return json(404, { ok: false, error: "unknown_unit", at });
  if (row.pr?.number !== undefined && row.pr.number !== body.prNumber)
    return json(409, { ok: false, error: "pull_request_moved", at });
  try {
    if (
      deps.runnerOwnership?.claim(instance.repo, body.prNumber, {
        instanceId: instance.id,
        unit: row.unit,
      }) !== true
    )
      return json(409, { ok: false, error: "publication_ownership_changed", at });
  } catch (err) {
    return json(503, { ok: false, error: "publication_ownership_unknown", message: describe(err), at });
  }
  if (deps.runnerRebase === undefined)
    return json(200, { ok: true, outcome: "refused", reason: "the runner's rebase resolver is unavailable", at });
  let report: SweepReport;
  try {
    report = await deps.runnerRebase(instance, body.prNumber);
  } catch (err) {
    try {
      const observed = await advanceRunnerRebasePublication(deps, instance, row, body.headSha);
      if (observed !== undefined) return json(200, { ok: true, outcome: "changed", headSha: observed, at });
    } catch {
      /* An unverifiable head cannot be adopted after an unrecorded rebase. */
    }
    return json(200, { ok: true, outcome: "refused", reason: describe(err), at });
  }
  try {
    const result = report.results.find((r) => r.number === body.prNumber);
    if (result?.outcome === "carried" && result.headSha !== undefined) {
      await advanceRunnerRebasePublication(deps, instance, row, body.headSha, result.headSha);
      return json(200, {
        ok: true,
        outcome: result.approvalCarried === true ? "carried" : "changed",
        headSha: result.headSha,
        at,
      });
    }
    if (result?.outcome === "delta-review" && result.headSha !== undefined) {
      await advanceRunnerRebasePublication(deps, instance, row, body.headSha, result.headSha);
      return json(200, { ok: true, outcome: "changed", headSha: result.headSha, at });
    }
    // Only a lost rebase outcome (the throw above) permits an unattributed
    // head reconciliation. An explicit result cannot credit another writer.
    if (result?.outcome === "conflict") return json(200, { ok: true, outcome: "conflict", reason: result.line, at });
    if (result?.outcome === "skipped") return json(200, { ok: true, outcome: "carried", headSha: body.headSha, at });
    return json(200, {
      ok: true,
      outcome: "refused",
      reason: result?.line ?? `the rebase of ${instance.repo}#${body.prNumber} returned no result`,
      at,
    });
  } catch (err) {
    return json(200, { ok: true, outcome: "refused", reason: describe(err), at });
  }
}

async function merge(
  body: Record<string, unknown>,
  deps: AdminCoordinatorDeps,
  subject: string,
): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  if (typeof body.prNumber !== "number" || !Number.isInteger(body.prNumber) || body.prNumber < 1)
    return json(400, { ok: false, error: "prNumber must be a pull request number" });
  const headSha = normalizeHead(body.headSha);
  if (headSha === undefined) return json(400, { ok: false, error: "headSha must be the approved head (7 to 40 hex)" });
  const at = (deps.clock ?? systemClock)();
  const refused = (reason: string) => json(200, { ok: true, outcome: "refused", reason, at });
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const unit = await unitRowOf(deps, instance, body.unit);
  if (!unit.ok) return unit.response;
  const row = unit.row!;
  const log = deps.log ?? console.log;
  // The grant: the bearer's actor on `plan:merge`, decided here beside the
  // door's `coordinator:step`. Withdrawn, every merge is a person's.
  const actor = resolveActor({ surface: "http", subjectId: subject }, deps.grantsFor);
  if (!authorize(actor, PLAN_MERGE_ACTION, { type: "command", id: "coordinator.merge" }).allow)
    return refused(
      `the runner holds no ${PLAN_MERGE_ACTION} grant (grants["http:${subject}"] in config.yaml) — a person merges`,
    );
  // The instance's field decides, never the requester or the branch's name:
  // the hand-off wrote `merge: runner` only on a seeded plan.
  if (instance.merge !== "runner")
    return refused(`the instance's \`merge\` field says ${instance.merge ?? "person"} — waits for a person's merge`);
  // Defense in depth: the field only ever rides a plan instance, so the unit's
  // branch must still be a branch of THIS instance's plan.
  const planBranch = parsePlanBranch(row.branch);
  if (instance.plan === undefined || planBranch === undefined || planBranch.planId !== instance.plan.id)
    return refused(
      `the instance's \`merge\` field says runner but \`${row.branch}\` is not a branch of plan \`${instance.plan?.id ?? "(none)"}\` — waits for a person's merge`,
    );
  const pr = { repo: instance.repo, number: body.prNumber };
  const where = `${instance.repo}#${pr.number}`;
  let facts: PullRequestFacts | undefined;
  try {
    facts = await deps.fetchPrFacts(pr);
  } catch (err) {
    return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
  }
  if (facts === undefined)
    return json(502, { ok: false, error: "github_unavailable", message: `${where} could not be read`, at });
  if (headBranchStateUnknown(facts))
    return json(502, {
      ok: false,
      error: "github_unavailable",
      message: headBranchStateError(instance.repo, pr.number),
      at,
    });
  if (isReleasePullRequest(facts))
    return refused(`${where} is the release pull request — always a person's merge, never the runner's`);
  if (facts.state !== "open") {
    // Already merged — auto-merge fired, a person merged after the approval,
    // or the merge queue merged what the door enqueued: the unit is done, not
    // refused. The door merged nothing, so the outcome says `by: other` with
    // the merge commit and the time (spec item 9).
    if (facts.mergedAt !== undefined && facts.mergeCommitSha !== undefined)
      return json(200, {
        ok: true,
        outcome: "merged",
        by: "other",
        sha: facts.mergeCommitSha,
        mergedAt: facts.mergedAt,
        ...(facts.mergedBy !== undefined ? { mergedBy: facts.mergedBy } : {}),
        at,
      });
    const pullRequest = pullRequestState(
      body.prNumber,
      row.pr?.url ?? `https://github.com/${instance.repo}/pull/${body.prNumber}`,
      facts,
    );
    return pullRequest === undefined
      ? refused(`${where} is ${facts.state}`)
      : json(200, { ok: true, outcome: "recheck", pullRequest, at });
  }
  if (facts.headBranchExists === false) {
    const pullRequest = pullRequestState(
      body.prNumber,
      row.pr?.url ?? `https://github.com/${instance.repo}/pull/${body.prNumber}`,
      facts,
    );
    if (pullRequest !== undefined) return json(200, { ok: true, outcome: "recheck", pullRequest, at });
  }
  if (body.queued === true) {
    // The pull request is in the base's merge queue (issue 2011): the door
    // reads the queue's outcome instead of attempting the squash — a merge is
    // answered above from the facts; still queued keeps the machine's wait;
    // removed carries the queue's own reason for the finding round. The head
    // guards are the queue's now: a push removes the entry, and the removal is
    // the answer.
    const queue =
      deps.fetchMergeQueueState !== undefined ? await deps.fetchMergeQueueState(pr).catch(() => undefined) : undefined;
    if (queue === undefined)
      return json(502, {
        ok: false,
        error: "github_unavailable",
        message: `the merge queue of ${where} could not be read`,
        at,
      });
    if (queue.queued)
      return json(200, {
        ok: true,
        outcome: "enqueued",
        reason: queue.position !== undefined ? `position ${queue.position} in the merge queue` : "in the merge queue",
        at,
      });
    return json(200, {
      ok: true,
      outcome: "removed",
      reason: queue.reason ?? "removed from the merge queue with no reason given",
      at,
    });
  }
  if (facts.headRef !== row.branch)
    return refused(`${where} heads \`${facts.headRef ?? "?"}\`, not the unit's branch \`${row.branch}\``);
  if (facts.headSha === undefined || !sameCommit(facts.headSha, headSha)) {
    const pullRequest = pullRequestState(
      body.prNumber,
      row.pr?.url ?? `https://github.com/${instance.repo}/pull/${body.prNumber}`,
      facts,
    );
    return pullRequest === undefined
      ? refused(`the head of ${where} could not be read`)
      : json(200, { ok: true, outcome: "recheck", pullRequest, at });
  }
  // A conflicting approved head stays owned by this runner. The typed outcome
  // re-enters rung one; only a conflict git leaves buys a coding child. A
  // second base move takes this same path again under the run's remaining
  // lease, never a pull-request-lifetime spend flag or a hand-rebase ending.
  if (facts.mergeableState === "dirty") {
    const base = facts.baseRef ?? "its base";
    return json(200, {
      ok: true,
      outcome: "conflict",
      reason: `${where} conflicts with \`${base}\` at \`${headSha.slice(0, 7)}\``,
      at,
    });
  }
  const approved = await reviewPostedAt(deps, pr, "approve", headSha);
  if (approved === undefined)
    return json(502, {
      ok: false,
      error: "github_unavailable",
      message: `the reviews of ${where} could not be read`,
      at,
    });
  if (!approved) return refused(`no approving review by the bot stands on ${where} at \`${headSha.slice(0, 7)}\``);
  const checks = await deps.fetchCommitChecks(instance.repo, headSha).catch(() => undefined);
  if (checks === undefined)
    return json(502, {
      ok: false,
      error: "github_unavailable",
      message: `the checks at ${headSha.slice(0, 7)} could not be read`,
      at,
    });
  if (checks.failed.length > 0) return refused(`CI is red at \`${headSha.slice(0, 7)}\`: ${checks.failed.join(", ")}`);
  // A `pending` answer is what the machine's merge wait rides: the intake
  // (checksIntake.ts) reads this registry to know whom the checks-settled
  // event at this head wakes (http-ingress.md item 12).
  if (checks.total === 0) {
    deps.noteMergeWait?.(headSha, unit.row?.recovery?.workflowId ?? id.value, at);
    return json(200, {
      ok: true,
      outcome: "pending",
      reason: `no check has reported at \`${headSha.slice(0, 7)}\` yet`,
      at,
    });
  }
  if (checks.pending.length > 0) {
    deps.noteMergeWait?.(headSha, row.recovery?.workflowId ?? id.value, at);
    return json(200, {
      ok: true,
      outcome: "pending",
      reason: `${checks.pending.length} check(s) still running at \`${headSha.slice(0, 7)}\`: ${checks.pending.join(", ")}`,
      at,
    });
  }
  // The merge queue (issue 2011): a base whose ruleset routes every change
  // through the queue is enqueued — the same act `gh pr merge --auto` performs
  // — and never squashed; an unreadable ruleset decides nothing, and the 405's
  // own wording below catches what the read missed.
  const enqueue = async (): Promise<IngressResponse> => {
    if (deps.enqueuePullRequest === undefined)
      return refused(
        `\`${facts.baseRef ?? "the base"}\` takes changes only through a merge queue and the door cannot enqueue — this is a bug: automatic merge-queue enqueue is unavailable; the approved work stands`,
      );
    let queued: EnqueueResult;
    try {
      queued = await deps.enqueuePullRequest(pr, { sha: headSha });
    } catch (err) {
      return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
    }
    if (!queued.ok) return refused(`GitHub refused to enqueue ${where}: ${queued.reason}`);
    log(
      `[coordinator] ${instance.id} ${row.unit}: enqueued ${where} at ${headSha.slice(0, 7)} — the base takes changes through a merge queue`,
    );
    return json(200, { ok: true, outcome: "enqueued", reason: `enqueued at \`${headSha.slice(0, 7)}\``, at });
  };
  const queueRuled =
    deps.branchHasMergeQueue !== undefined && facts.baseRef !== undefined
      ? await deps.branchHasMergeQueue(instance.repo, facts.baseRef).catch(() => undefined)
      : undefined;
  if (queueRuled === true) return enqueue();
  let merged: MergeResult;
  try {
    merged = await deps.mergePullRequest(pr, {
      sha: headSha,
      title: facts.title ?? `Merge pull request #${pr.number}`,
    });
  } catch (err) {
    return json(502, { ok: false, error: "github_unavailable", message: describe(err), at });
  }
  if (!merged.ok) {
    // The rules read missed the queue (or could not run): GitHub's own 405
    // wording says the base merges through the queue, so enqueue (issue 2011).
    if (merged.status === 405 && MERGE_QUEUE_405.test(merged.reason)) return enqueue();
    log(
      `[coordinator] ${instance.id} ${row.unit}: GitHub refused the merge of ${where} (HTTP ${merged.status}): ${merged.reason}`,
    );
    return refused(`GitHub refused the merge of ${where} (HTTP ${merged.status}): ${merged.reason}`);
  }
  log(
    `[coordinator] ${instance.id} ${row.unit}: merged ${where} at ${headSha.slice(0, 7)} → ${merged.sha.slice(0, 7)}`,
  );
  return json(200, { ok: true, outcome: "merged", sha: merged.sha, at });
}

/** The round's checks step (record 0055, agent-ship item 9): the check runs
 *  at the reviewed head, read with the merge door's own reading and classified
 *  for the flake rule — or performs one requested recovery effect: the named
 *  failed checks' re-run, or the empty required-check launch's close/reopen.
 *  A pending or unreported head registers the instance in
 *  the merge-wait book so the intake's `checks-settled-<head>` event wakes the
 *  machine's bounded wait; an unreadable GitHub leaves `checks` out, which the
 *  machine treats as pending. The machine — never this route — decides what a
 *  failure becomes: a check finding, a spent re-run, or a wait. */
async function checksStep(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.unit !== "string" || !UNIT_ID.test(body.unit))
    return json(400, { ok: false, error: "unit must be a unit id" });
  if (typeof body.prNumber !== "number" || !Number.isInteger(body.prNumber) || body.prNumber < 1)
    return json(400, { ok: false, error: "prNumber must be a pull request number" });
  const headSha = normalizeHead(body.headSha);
  if (headSha === undefined) return json(400, { ok: false, error: "headSha must be the reviewed head (7 to 40 hex)" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const unit = await unitRowOf(deps, instance, body.unit);
  if (!unit.ok) return unit.response;
  const log = deps.log ?? console.log;
  // State, head and branch existence are read before even a recovery effect:
  // checks on a terminal, moved or deleted head are no longer this unit's act.
  const facts = await deps.fetchPrFacts({ repo: instance.repo, number: body.prNumber }).catch(() => undefined);
  if (facts === undefined) return json(502, { ok: false, error: "github_unavailable", at });
  if (headBranchStateUnknown(facts))
    return json(502, {
      ok: false,
      error: "github_unavailable",
      message: headBranchStateError(instance.repo, body.prNumber),
      at,
    });
  const pullRequest = pullRequestState(
    body.prNumber,
    unit.row?.pr?.url ?? `https://github.com/${instance.repo}/pull/${body.prNumber}`,
    facts,
  );
  if (
    pullRequest !== undefined &&
    (pullRequest.state !== "open" ||
      pullRequest.headBranchExists === false ||
      (typeof pullRequest.headSha === "string" && !sameCommit(pullRequest.headSha, headSha)))
  )
    return json(200, { ok: true, pullRequest, at });
  if (body.retry !== undefined && body.refire !== undefined)
    return json(400, { ok: false, error: "checks recovery must be retry or refire, not both" });
  if (body.retry !== undefined) {
    if (!Array.isArray(body.retry) || body.retry.length === 0 || !body.retry.every((n) => typeof n === "string"))
      return json(400, { ok: false, error: "retry must name the failed checks" });
    const retried = (await deps.rerunFailedChecks?.(instance.repo, headSha, body.retry as string[])) ?? false;
    log(
      `[coordinator] ${instance.id} ${body.unit}: flake re-run ${retried ? "dispatched" : "not dispatched"} for ${(body.retry as string[]).join(", ")} at ${headSha.slice(0, 7)}`,
    );
    return json(200, { ok: true, retried, at });
  }
  if (body.refire !== undefined) {
    if (body.refire !== true) return json(400, { ok: false, error: "refire must be true" });
    const refired = (await deps.refirePullRequest?.(instance.repo, body.prNumber)) ?? false;
    log(
      `[coordinator] ${instance.id} ${body.unit}: pull_request event ${refired ? "re-fired" : "not re-fired"} for ${instance.repo}#${body.prNumber} at ${headSha.slice(0, 7)}`,
    );
    return json(200, { ok: true, refired, at });
  }
  // The pull request's own facts beside the runs (issue 2063): a draft head
  // is the machine's to hold — never to merge — and the base names the branch
  // whose required checks say what the head must still gain.
  let checks: RoundChecks | undefined;
  if (deps.fetchRoundChecks !== undefined) {
    checks = await deps.fetchRoundChecks(instance.repo, headSha, body.prNumber, facts?.baseRef).catch(() => undefined);
  } else {
    // The fallback reading: the merge door's own, every failure a real one.
    const plain = await deps.fetchCommitChecks(instance.repo, headSha).catch(() => undefined);
    checks =
      plain === undefined
        ? undefined
        : {
            total: plain.total,
            pending: plain.pending,
            failed: plain.failed.map((name) => ({ name, conclusion: "failure" })),
          };
  }
  // A head still pending — a run not completed, a required check whose run
  // does not exist yet, no check reported, or a draft waiting on its ready
  // event — is what the machine's checks wait rides: register it so the
  // intake's settled event wakes it (http-ingress item 12), exactly as the
  // merge step's pending answer does.
  if (
    checks === undefined ||
    checks.pending.length > 0 ||
    (checks.expected?.length ?? 0) > 0 ||
    checks.total === 0 ||
    facts?.draft === true
  )
    deps.noteMergeWait?.(headSha, unit.row?.recovery?.workflowId ?? id.value, at);
  if (checks !== undefined && checks.failed.length > 0)
    log(
      `[coordinator] ${instance.id} ${body.unit}: CI red at ${headSha.slice(0, 7)} — ${checks.failed
        .map((f) => `${f.name} (${f.conclusion}${f.flakeSuspect === true ? ", suspected flake" : ""})`)
        .join(", ")}`,
    );
  return json(200, {
    ok: true,
    ...(checks !== undefined ? { checks } : {}),
    ...(pullRequest !== undefined ? { pullRequest } : {}),
    ...(facts.draft === true ? { draft: true } : {}),
    at,
  });
}

const ENDING_ICON: Readonly<Record<string, string>> = {
  merged: "✅",
  merge_ready: "✅",
  already_landed: "✅",
  done: "✅",
};

/** The plan's summary — one line per unit with how it ended, in the user's
 *  words (record 0066), and its pull request; the task wording (no unit id)
 *  for a generated plan's one unit. */
export function planSummary(units: readonly CoordinatorUnit[], generated = false): string {
  const lines = units.map((u) => {
    // A unit with a thread and no ending is the machine's word for "no ending
    // was chosen" — never a word a person can act on, so the line names the
    // cause and the next step instead (issue 2063).
    const kind = u.ending ? u.ending.kind : u.threadKey ? "unfinished" : "not started";
    const how = u.ending
      ? endingWordOf(u.ending.kind)
      : u.threadKey
        ? "no ending was recorded — the next reply in its thread continues the unit"
        : kind;
    const pr = u.pr ? ` — ${u.pr.url}` : "";
    return generated
      ? `${ENDING_ICON[kind] ?? "•"} ${how}${pr}`
      : `${ENDING_ICON[kind] ?? "•"} ${u.unit} — ${how}${pr}`;
  });
  return lines.join("\n");
}

/** The instance ended (record 0060): the hosted parent gets the summary as
 *  its `answer`, its registry row finishes and its ONE record — the run's own
 *  events, in seq order — seals through the ledger sink under the metadata's
 *  thread, releasing the host key with the row; the card closes and a plan's
 *  requesting thread gets the summary (a task's thread already has its unit's
 *  report). On a run another generation hosts: `409 not_host`, nothing
 *  written. On an untracked pipeline: no record — the parent finished at
 *  the hand-off and its record already exists — the card and the summary as
 *  before. */
async function finish(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (body.outcome !== "completed" && body.outcome !== "failed")
    return json(400, { ok: false, error: "outcome must be completed or failed" });
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  if (namesForeignRun(instance, body)) return json(404, { ok: false, error: "not_found" });
  const host = await hostRunOf(deps, instance);
  if (host.kind === "not_host") return json(409, { ok: false, error: "not_host", at });
  const units = await deps.instances.listUnits(instance.id);
  if (!deps.reportLedger) return json(503, { ok: false, error: "report_context_unavailable", at });
  let summaryText: string;
  let summaryReply: string;
  try {
    const saved = await freezeCoordinatorReport(
      deps.reportLedger,
      {
        instanceId: instance.id,
        unit: "@plan",
        attempt: instance.attempt ?? 0,
        requester: instance.userId,
        channelId: instance.channelId,
        threadKey: instance.threadKey,
        deliveryId: `finish:${body.outcome}`,
      },
      {
        text: planSummary(units, isGenerated(instance)),
        threadText: `Plan ${instance.plan?.id ?? ""} ended (${body.outcome}):\n${planSummary(units)}`,
      },
    );
    summaryText = saved.text;
    summaryReply = saved.threadText;
  } catch {
    return json(503, { ok: false, error: "report_context_unavailable", at });
  }
  if (host.kind === "host") {
    const ledgerRun = deps.ledgerRuns().find((run) => run.runId === host.runId);
    let summary = deps.registry.getById(host.runId);
    if (ledgerRun && summary) {
      if (summary.liveState === undefined) {
        await hostPublish(deps, instance, host.runId, [], at);
        summary = deps.registry.getById(host.runId);
        if (!summary) throw new Error("hosted run disappeared during finish backfill");
      }
      const bound = summary.liveState?.bound ?? at + minutesToMs(HOSTED_DEADLINE_MARGIN_MINUTES);
      const wrapping = await ledgerRun.assignLiveState({
        expectedSeq: summary.liveStateSeq ?? 0,
        eventSeq: summary.eventCount + 1,
        at,
        state: "wrapping_up",
        bound,
        detail: "writing the pipeline summary",
      });
      if (!wrapping.ok || !deps.registry.commitLiveState(host.runId, wrapping))
        throw new Error(`hosted wrap-up was not committed (${wrapping.ok ? "registry sequence" : wrapping.reason})`);
      summary = deps.registry.getById(host.runId);
      if (!summary) throw new Error("hosted run disappeared during wrap-up");
      const answer: RunEvent = { type: "answer", text: summaryText, at };
      const answerSeq = summary.eventCount + 1;
      const refreshed = await ledgerRun.assignLiveState({
        expectedSeq: summary.liveStateSeq ?? 0,
        at,
        state: "wrapping_up",
        bound,
        detail: "writing the pipeline summary",
        sourceEvents: [{ ...answer, seq: answerSeq }],
      });
      if (!refreshed.ok || !deps.registry.commitLiveState(host.runId, refreshed))
        throw new Error(`hosted summary was not committed (${refreshed.ok ? "registry sequence" : refreshed.reason})`);
      deps.registry.publish(host.runId, answer);
      summary = deps.registry.getById(host.runId);
      if (!summary) throw new Error("hosted run disappeared before ending");
      const ended = await ledgerRun.assignLiveState({
        expectedSeq: summary.liveStateSeq ?? 0,
        eventSeq: summary.eventCount + 1,
        at,
        state: "ended",
        cause: body.outcome === "completed" ? "completed" : "failed",
      });
      if (!ended.ok || !deps.registry.commitLiveState(host.runId, ended))
        throw new Error(`hosted ending was not committed (${ended.ok ? "registry sequence" : ended.reason})`);
    } else {
      deps.registry.publish(host.runId, { type: "answer", text: summaryText, at });
    }
    deps.registry.finish(host.runId, body.outcome);
  }
  await drawCard(deps, instance, units, { icon: body.outcome === "completed" ? "✅" : "⚠️" }).catch(() => {});
  // A one-unit plan's unit ran in the requesting thread, so its report is
  // already there — only a plan of two or more units posts the summary back
  // (record 0055 item 3: the count decides, not the source).
  if (units.length >= 2 && !units.some((row) => row.workBrief !== undefined)) {
    const io = deps.ioFor({ threadKey: instance.threadKey, userId: instance.userId });
    await io?.reply(summaryReply).catch(() => {});
  }
  const runId = instance.runId ?? instance.id.slice(0, 64);
  if (host.kind === "host") {
    // The one record: the run's own stream (snapshot BEFORE the seal, so the
    // seal's span records are not counted twice), filed under the metadata's
    // thread and written through the ledger sink — the one-transaction finish
    // that also closes the row and releases the host key. Without the handle
    // (a detached row) the writer's default sink keeps the record.
    const snap = deps.registry.snapshotById(host.runId);
    const seal = deps.registry.seal(host.runId);
    const summary = deps.registry.getById(host.runId);
    const visibility = await deps.channelVisibilityOf(instance.channelId);
    const finishedAt = snap?.finishedAt ?? at;
    const record = assembleRunRecord({
      run: { id: host.runId, ...(summary?.label !== undefined ? { label: summary.label } : {}) },
      snap,
      agent: "ship",
      ...(summary?.model !== undefined ? { model: summary.model } : {}),
      msg: {
        channelId: instance.channelId,
        userId: instance.userId,
        threadKey: instance.threadKey,
        ...(instance.sourceUrl !== undefined ? { sourceUrl: instance.sourceUrl } : {}),
        ...(instance.userName !== undefined ? { userName: instance.userName } : {}),
        ...(instance.authenticatedAs !== undefined ? { authenticatedAs: instance.authenticatedAs } : {}),
      },
      channelVisibility: visibility,
      repo: instance.repo,
      hosted: true, // the host run is the pipeline's parent (record 0060)
      // The registry's whole-list standing (record 0065): the snapshot is the
      // trimmed backlog, which may have dropped a ship event.
      ...(summary?.pipeline !== undefined ? { pipeline: summary.pipeline } : {}),
      finishedAt,
      status: body.outcome,
      diagnosis: analyzeRunFriction(snap?.events ?? [], {
        finished: true,
        truncated: snap?.truncated ?? false,
        window: { start: snap?.receivedAt ?? snap?.startedAt ?? instance.createdAt, end: finishedAt },
      }),
      seal,
    });
    const handle = deps.ledgerRuns().find((run) => run.runId === host.runId);
    deps.runHistoryWriter.write(record, handle !== undefined ? { via: handle.sink } : undefined);
  }
  (deps.log ?? console.log)(`[coordinator] ${instance.id}: finished ${body.outcome} — record ${runId}`);
  return json(200, { ok: true, runId, at });
}

/** What the brief composer reads through the bot: the target repository at the
 *  base ref, a child's record, and the ship request the run's record carried. */
function briefReaders(deps: AdminCoordinatorDeps, instance: CoordinatorInstance): BriefReaders {
  const ref = instance.base ?? "main";
  return {
    readRepoFile: async (path, opts) => {
      try {
        const file = await deps.github.readFile(instance.repo, path, ref, opts);
        return { content: file.content, truncated: file.truncated };
      } catch {
        return undefined;
      }
    },
    readRunFacts: async (runId) => {
      const res = await deps.runs.getRun(runId, {
        include: "messages",
        privateWorkerAccess: PRIVATE_WORKER_INTERNAL_READ,
      });
      if (!res.ok || res.value.parentInstanceId !== instance.id) return undefined;
      const r = res.value;
      return {
        ...(r.verdict?.findings !== undefined ? { findings: r.verdict.findings } : {}),
        ...(r.dispositions !== undefined ? { dispositions: r.dispositions } : {}),
        ...(finalReplyOf(r.events) !== undefined ? { finalReply: finalReplyOf(r.events) } : {}),
        ...(r.handoff !== undefined ? { handoff: r.handoff } : {}),
      };
    },
  };
}

type Step =
  | "authorize"
  | "plan"
  | "unit-start"
  | "branch"
  | "spawn"
  | "read-record"
  | "steer"
  | "pr-check"
  | "recover-unit"
  | "round"
  | "unit-end"
  | "unit-wake"
  | "checks"
  | "merge"
  | "rebase"
  | "finish";
const STEPS: readonly Step[] = [
  "authorize",
  "plan",
  "unit-start",
  "branch",
  "spawn",
  "read-record",
  "steer",
  "pr-check",
  "recover-unit",
  "round",
  "unit-end",
  "unit-wake",
  "checks",
  "merge",
  "rebase",
  "finish",
];

/** The step a path names — one of the literals above, never the path's own
 *  text, so what reaches a log line is a constant of this module. */
function stepOf(path: string): Step | undefined {
  const tail = path.slice(COORDINATOR_ADMIN_PREFIX.length);
  return STEPS.find((s) => s === tail);
}

/** What the headers alone decide, in this order: the step (404), the method
 *  (405), the bearer and its grant (401/403/503). Everything a refused caller
 *  is told, before a body is buffered — the ingress's own rule (http-ingress
 *  item 6) — and the one place the bearer is looked at per request. */
export function decideCoordinatorDoor(
  req: Pick<CoordinatorRouteRequest, "method" | "path" | "headers">,
  deps: AdminCoordinatorDeps,
): { kind: "refused"; response: IngressResponse } | { kind: "admitted"; step: Step; subject: string } {
  const step = stepOf(req.path);
  if (step === undefined) return { kind: "refused", response: json(404, { ok: false, error: "not found" }) };
  if ((req.method ?? "GET").toUpperCase() !== "POST")
    return { kind: "refused", response: json(405, { ok: false, error: `method not allowed: POST ${req.path}` }) };
  const auth = authorizeStep(req.headers, step, deps);
  if (!auth.ok) {
    (deps.log ?? console.warn)(`[coordinator] ${step} ${auth.response.status} — ${auth.reason}`);
    return { kind: "refused", response: auth.response };
  }
  return { kind: "admitted", step, subject: auth.subject };
}

/** The admitted step's own answer over its body. */
export async function answerCoordinatorStep(
  door: { step: Step; subject: string },
  body: string,
  deps: AdminCoordinatorDeps,
): Promise<IngressResponse> {
  if (door.step === "authorize") return json(200, { ok: true, subject: door.subject });
  const parsed = parseObject(body);
  if (!parsed.ok) return json(400, { ok: false, error: parsed.error });
  const answer = async (): Promise<IngressResponse> => {
    switch (door.step) {
      case "plan":
        return plan(parsed.value, deps);
      case "unit-start":
        return unitStart(parsed.value, deps);
      case "branch":
        return branch(parsed.value, deps);
      case "spawn":
        return spawn(parsed.value, deps);
      case "read-record":
        return readRecord(parsed.value, deps);
      case "steer":
        return steerChild(parsed.value, deps);
      case "pr-check":
        return prCheck(parsed.value, deps);
      case "recover-unit":
        return recoverOriginalUnit(parsed.value, deps);
      case "round":
        return round(parsed.value, deps);
      case "unit-end":
        return unitEnd(parsed.value, deps);
      case "unit-wake":
        return unitWake(parsed.value, deps);
      case "checks":
        return checksStep(parsed.value, deps);
      case "merge":
        return merge(parsed.value, deps, door.subject);
      case "rebase":
        return rebaseStep(parsed.value, deps);
      default:
        return finish(parsed.value, deps);
    }
  };
  try {
    return await answer();
  } catch (error) {
    if (error instanceof CoordinatorUnitWriteConflict) return json(409, { ok: false, error: "settlement_conflict" });
    throw error;
  }
}

/** The routes, pure over a parsed request: the door, then the step. */
export async function handleCoordinatorRequest(
  req: CoordinatorRouteRequest,
  deps: AdminCoordinatorDeps,
): Promise<IngressResponse> {
  const door = decideCoordinatorDoor(req, deps);
  if (door.kind === "refused") return door.response;
  return answerCoordinatorStep(door, req.body, deps);
}

/** The node:http adapter: the door from the headers first — a refused caller,
 *  an unknown step or a wrong method never buffers a body — then the body, then
 *  the step's answer. */
export function createAdminCoordinatorHandler(
  deps: AdminCoordinatorDeps,
): (req: HttpRequest, res: ServerResponse) => void {
  const write = (res: ServerResponse, out: IngressResponse) => {
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  };
  return (req, res) => {
    void (async () => {
      try {
        const path = (req.url ?? "/").split("?")[0]!;
        const door = decideCoordinatorDoor({ method: req.method, path, headers: req.headers }, deps);
        if (door.kind === "refused") {
          write(res, door.response);
          req.destroy();
          return;
        }
        const read = await readBody(req, MAX_ADMIN_BODY_BYTES);
        if (!read.ok) {
          write(res, json(413, { ok: false, error: "request body too large" }));
          req.destroy();
          return;
        }
        write(res, await answerCoordinatorStep(door, read.body, deps));
      } catch (err) {
        (deps.log ?? console.error)(`[coordinator] ${describe(err)}`);
        write(res, json(500, { ok: false, error: "internal error" }));
      }
    })();
  };
}
