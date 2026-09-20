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

import { DEFAULT_GRANT, HOSTED_DEADLINE_MARGIN_MINUTES, IDLE_DAYS_DEFAULT, minutesToMs } from "../core/budgets.js";
import { DEFAULT_VERBOSITY, shows } from "../core/verbosity.js";
import type { IncomingHttpHeaders, IncomingMessage as HttpRequest, ServerResponse } from "node:http";
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
  INSTANCE_ID_PATTERN,
  STEP_NAME_PATTERN,
  type CoordinatorInstance,
  type CoordinatorTag,
  type CoordinatorUnit,
  type ThreadEvent,
  type UnitIdle,
} from "../core/coordinator/contract.js";
import { foldThreadAttachments } from "../core/dispatch/admission.js";
import { foldThreadEvents } from "../core/threadEvents.js";
import { assembleRunRecord } from "../core/dispatch/record.js";
import type { CoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { DispatchOptions } from "../core/dispatcher.js";
import type { DispatchOutcome } from "../core/dispatch/outcome.js";
import { childRequestText, spawnTierRefusal } from "../core/dispatch/spawn.js";
import { EFFORT_LEVELS_HINT, isEffort, type Effort } from "../effort.js";
import {
  CHANGES_TOKEN,
  isAddressSeverity,
  LGTM_TOKEN,
  type Finding,
  type ReviewVerdictKind,
} from "../core/reviewVerdict.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunEvent, ShipRoundOutcome } from "../core/runEvents.js";
import type { RunHistoryWriter } from "../core/runHistoryWriter.js";
import { RUN_ID_PATTERN, RUN_LIST_MAX_LIMIT } from "../core/runRecord.js";
import type { RunRegistry } from "../core/runRegistry.js";
import type { LedgerRun } from "../core/runLedger/writeThrough.js";
import type { HostingState } from "../core/runLedger/types.js";
import type { RunsService, RunView } from "../core/runsService.js";
import {
  interruptionCauseOfWords,
  parsePlanBranch,
  type Brief,
  type InterruptionCause,
  type RoundChecks,
} from "../core/ship/coordinator.js";
import { BOT_SCOPES, checkPrTitle, TITLE_MAX_LENGTH } from "../core/prTitle.mjs";
import PR_TITLE_VOCABULARY from "../core/prTitleVocabulary.json" with { type: "json" };
import { isHandoffShape, renderHandoffComment, type Handoff } from "../core/ship/handoff.js";
import { normalizeHead, sameCommit } from "../core/reviewedHead.js";
import { endingWordOf, roundOutcomeWordOf } from "../core/pipelineStanding.js";
import {
  DEFAULT_ADDRESS_SEVERITY,
  resolveShipCaps,
  shipRoundHeader,
  type AddressSeverity,
  type AddressSeveritySource,
} from "../core/shipPipeline.js";
import { createCardShell } from "../core/statusCardFrame.js";
import { systemClock } from "../core/trace/clock.js";
import type { ChannelIO, IncomingMessage } from "../core/types.js";
import { authenticateIngressBearer } from "../deploy/restart.js";
import type { GithubApi } from "../execution/githubApi.js";
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

export interface AdminCoordinatorDeps {
  /** The `SWITCHBOARD_INGRESS_TOKENS` secret as the process sees it. */
  tokens: Secret | undefined;
  /** Grants by actor id (`ConfigStore.grantsFor`): the bearer's `http:<subject>` must hold `coordinator:step`. */
  grantsFor: GrantsLookup;
  /** The parent ship records (run-history item 49). */
  instances: CoordinatorInstanceStore;
  /** The app config the spawn's tier gate reads (`spawnTierRefusal`): which
   *  model is the fast tier (`routing.model`). Absent — a test harness — no
   *  ref reads `fast` and every model passes as `strong`. */
  appConfig?: () => { routing?: { model?: string } };
  /** The runs page base (`<PUBLIC_BASE_URL>/runs`), answered to the plan
   *  runner so a unit-end report can link a child's write-up to its run page
   *  (agent-ship item 12); absent without PUBLIC_BASE_URL — the report names
   *  the run id instead. */
  runPageBase?: string;
  /** Watch until merge, resolved for one repository (`ConfigStore.mergeWatchOf`,
   *  record 0071 mechanism three): read by the merge door's conflict refusal so
   *  the remedy it names is the one that exists — the watching unit's own round
   *  where the setting is on, the sweep a person runs otherwise. Absent — a
   *  test of the other paths — the watch reads as off. */
  mergeWatchOf?: (repo: string) => { watch: boolean };
  /** The one runs service every surface reads: the live and finished runs of the instance's thread. */
  runs: RunsService;
  /** The registry the hosted parent run lives in (record 0060): the four
   *  runner routes write the pipeline's facts to it through `hostPublish`,
   *  and `finish` ends and seals the row. */
  registry: Pick<RunRegistry, "publish" | "finish" | "getById" | "snapshotById" | "seal">;
  /** The ledger runs this generation drives (`LedgerWriteThrough.liveRuns`):
   *  the hosted parent's handle, whose state carries the deadline every runner
   *  write renews (`hosting.until`) and whose sink `finish` seals the record
   *  through the ledger — releasing the host key with the row. */
  ledgerRuns: () => LedgerRun[];
  /** `dispatch()` bound over the process's deps: the child as the requesting
   *  user, tagged, with the unit's contract for a round-0 child. */
  dispatch: (
    msg: IncomingMessage,
    io: ChannelIO,
    opts?: Pick<DispatchOptions, "coordinator" | "contract"> & { coordinator: CoordinatorTag },
  ) => Promise<DispatchOutcome>;
  /** The channel handle for a thread (the resume's `resumeSlackIO` from the
   *  row's parts — the card's ts when the handle must redraw it); undefined for
   *  a platform no thread can be rebuilt on. */
  ioFor: (thread: { threadKey: string; userId: string; cardTs?: string }) => ChannelIO | undefined;
  /** The open pull request heading a branch (githubPulls.findOpenPrByHead), and
   *  — asked only when there is none — the merged one (githubPulls.findMergedPrByHead):
   *  a unit whose pull request merged before the runner reached it is done, not aborted. */
  findOpenPrByHead: (repo: string, branch: string) => Promise<OpenPrRef | null>;
  findMergedPrByHead: (repo: string, branch: string) => Promise<MergedPrRef | null>;
  /** The recover path's one write (githubPulls.openPullRequest, open-or-edit by
   *  head branch): a coding child that pushed and then died leaves its work on
   *  the branch — the pr-check opens the pull request from the branch itself
   *  instead of answering `none` over stranded work (agent-ship item 15). */
  openPullRequest: (target: PullRequestTarget) => Promise<OpenedPullRequest>;
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
  enqueuePullRequest?: (pr: { repo: string; number: number }) => Promise<EnqueueResult>;
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
      return { ok: true, value: { kind: "contract", unit: b.unit, rebase: { branch: r.branch, onto: r.onto } } };
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
      return {
        ok: true,
        value: {
          kind: "findings",
          unit: b.unit,
          pr: n.value,
          reviewRunId: review.value,
          ...(checks.value !== undefined ? { checks: checks.value } : {}),
        },
      };
    }
    default:
      return invalid("brief.kind must be contract, review or findings");
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
  const threadKey = row?.threadKey ?? (row === undefined || unitCount === 1 ? instance.threadKey : undefined);
  const sourceUrl = row?.sourceUrl ?? (threadKey === instance.threadKey ? instance.sourceUrl : undefined);
  return { threadKey, sourceUrl };
}

type OpenedThreadRef = { threadKey: string; sourceUrl?: string };

/** A thread opened top-level in the requesting thread's channel with `lead`
 *  (`ChannelIO.openThread`): `503 no_channel` without a channel that can,
 *  `502 thread_failed` on a failed open, both passing conditions the runner
 *  asks again on. */
async function openThreadFromRequester(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  lead: string,
  at: number,
): Promise<{ ok: true; thread: OpenedThreadRef } | { ok: false; response: IngressResponse }> {
  const parent = deps.ioFor({ threadKey: instance.threadKey, userId: instance.userId });
  if (!parent?.openThread) return { ok: false, response: json(503, { ok: false, error: "no_channel", at }) };
  try {
    const opened = await parent.openThread(lead);
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
    status: (initial) => io.status(initial),
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
  if (io.openThread) out.openThread = (lead) => io.openThread!(lead);
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
  const log = deps.log ?? console.log;
  const instance = await deps.instances.get(req.parentInstanceId);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  const at = (deps.clock ?? systemClock)();
  // The hard stop's mark (record 0060; issue 1924): a sealed parent's runner
  // spawns nothing more — the refusal is terminal, and the machine ends the
  // unit stopped on it.
  if (instance.stop !== undefined) return json(409, { ok: false, error: "stopped", at });
  const unit = await unitRowOf(deps, instance, req.unit);
  if (!unit.ok) return unit.response;
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
  const io = deps.ioFor({ threadKey, userId: instance.userId });
  if (!io) return json(503, { ok: false, error: "no_channel", at });
  // The child's turn: the caller's prompt, or the brief composed from what the
  // bot holds — the plan at the base ref, the prior rounds' records.
  let turn: { prompt: string; ref?: string; contract?: DispatchOptions["contract"] };
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
  // The child's message is the one the requester would have typed, in the
  // child's thread, as the requester the parent record names. The directive is
  // the message's own (`childRequestText`), so the findings step's `agent:coding`
  // resolves the coding preset whatever a person's detour in the thread or a
  // lost store would have made sticky.
  const msg: IncomingMessage = {
    channelId: instance.channelId,
    userId: instance.userId,
    ...(instance.userName !== undefined ? { userName: instance.userName } : {}),
    ...(instance.authenticatedAs !== undefined ? { authenticatedAs: instance.authenticatedAs } : {}),
    ...(instance.postedBy !== undefined ? { postedBy: instance.postedBy } : {}),
    ...(instance.channelName !== undefined ? { channelName: instance.channelName } : {}),
    threadKey,
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
  let startedId: string | undefined;
  let lastReply: string | undefined;
  let resolveStarted!: (id: string) => void;
  const started = new Promise<string>((resolve) => {
    resolveStarted = resolve;
  });
  const child = watched(io, {
    started: (id) => {
      startedId = id;
      resolveStarted(id);
    },
    replied: (text) => {
      lastReply = text;
    },
  });
  // The child is dispatched at its unit branch (the resident attaches there),
  // so the thread cannot tell the post-step which branch the pull request
  // targets: the tag says it — the plan's base — when the instance knows one.
  const tag: CoordinatorTag = {
    parentInstanceId: instance.id,
    idempotencyKey: key,
    ...(instance.base !== undefined ? { base: instance.base } : {}),
  };
  const settled = deps
    .dispatch(msg, child, {
      coordinator: tag,
      ...(turn.contract !== undefined ? { contract: turn.contract } : {}),
    })
    .then(
      (outcome) => ({ kind: "ended" as const, outcome }),
      (err: unknown) => ({ kind: "threw" as const, err }),
    );
  // The dispatch runs on in the process (counted in flight like any run); the
  // route answers at registration, and a throw after that is a log line.
  void settled.then((end) => {
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
  };
}

/** The pull request a finished coding child opened or edited (`pr_opened`), from its events. */
function prOpenedOf(
  events: readonly RunEvent[] | undefined,
): { number: number; url: string; created: boolean } | undefined {
  const last = [...(events ?? [])].reverse().find((e) => e.type === "pr_opened");
  return last && last.type === "pr_opened" ? { number: last.number, url: last.url, created: last.created } : undefined;
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

async function readRecord(body: Record<string, unknown>, deps: AdminCoordinatorDeps): Promise<IngressResponse> {
  const id = parseInstanceId(body.parentInstanceId);
  if (!id.ok) return json(400, { ok: false, error: id.error });
  if (typeof body.runId !== "string" || !RUN_ID_PATTERN.test(body.runId))
    return json(400, { ok: false, error: "runId must be a run id" });
  if (body.unit !== undefined && (typeof body.unit !== "string" || !UNIT_ID.test(body.unit)))
    return json(400, { ok: false, error: "unit must be a unit id" });
  const at = (deps.clock ?? systemClock)();
  // A run outside the instance is `not_found`, byte-identical to a missing one
  // (authorization.md: a denied read reveals nothing).
  const res = await deps.runs.getRun(body.runId);
  if (!res.ok || res.value.parentInstanceId !== id.value) return json(404, { ok: false, error: "not_found" });
  const view = res.value;
  if (!view.finished) return json(200, { ok: true, run: coordinatorRunView(view, id.value, undefined), at });
  // Finished: the final reply and the typed artifacts the record carries — the
  // coding child's pull request, the review child's verdict and whether it
  // stands on the pull request, the coding run's dispositions.
  const full = await deps.runs.getRun(body.runId, { include: "messages" });
  const record = full.ok ? full.value : view;
  const finalReply = finalReplyOf(record.events);
  const pr = prOpenedOf(record.events);
  // The hard stop's mark (record 0060; issue 1924): a finished child's unit
  // ends stopped on it, whatever the child's own status.
  const instanceRow = await deps.instances.get(id.value);
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
        restartedAs: successor,
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
    const row = instance ? (await deps.instances.listUnits(instance.id)).find((u) => u.unit === body.unit) : undefined;
    if (instance && row?.pr !== undefined) {
      const unitPr = { repo: instance.repo, number: row.pr.number };
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
    run: {
      ...coordinatorRunView(view, id.value, finalReply),
      ...(pr !== undefined ? { pr } : {}),
      ...(record.verdict !== undefined ? { verdict: record.verdict } : {}),
      ...(record.reviewHead !== undefined ? { reviewHead: record.reviewHead } : {}),
      ...(posted !== undefined ? { reviewPosted: posted.reviewPosted } : {}),
      ...(posted?.reviewPostReason !== undefined ? { reviewPostReason: posted.reviewPostReason } : {}),
      ...(record.dispositions !== undefined ? { dispositions: record.dispositions } : {}),
      ...(record.handoff !== undefined ? { handoff: true } : {}),
      // The renewal's facts (decision 0046): progress is read off these.
      ...(record.pushed !== undefined ? { pushed: record.pushed } : {}),
      ...(record.lease !== undefined ? { leaseStartedAt: record.lease.startedAt } : {}),
      // What the child cost, as the runs service prices it (costs.md item 4c):
      // null when unknown — no usage on the record, or a model without a price
      // — so a capped grant never renews on an understated total.
      costUsd: record.cost?.usd ?? null,
      ...(record.handoff !== undefined ? { handoffLists: record.handoff } : {}),
      // The failure by name (run-history item 57): a `provider_transient` lets
      // the machine re-run a round-0 child that pushed nothing (issue 1932).
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
 *  the submit tool's gate already judged it), else the unit's title as the
 *  conventional fallback above (issue 1877); the body from the description,
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
  let title = recoveredFallbackTitle(row, branch, instance.plan?.id ?? parsePlanBranch(branch)?.planId);
  let prBody = `Opened by the plan runner from the pushed branch \`${branch}\`: the coding run ${runId} of ${unitName} ended before it could open the pull request or submit its description. The review round asks for the description.`;
  try {
    const full = await deps.runs.getRun(runId, { include: "messages" });
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
  // The pull request the machine has adopted (issue 1799): followed by number
  // when nothing heads the unit's branch, so the answer is the pull request's
  // live state, never `none` over a record fact written minutes earlier.
  if (body.pr !== undefined && (typeof body.pr !== "number" || !Number.isInteger(body.pr) || body.pr <= 0))
    return json(400, { ok: false, error: "pr must be a pull request number" });
  const follow = typeof body.pr === "number" ? body.pr : undefined;
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
  // The unit's row remembers its pull request, so a person reads it there.
  const remember = async (pr: { number: number; url: string }) => {
    if (unit.row && (unit.row.pr?.number !== pr.number || unit.row.pr.url !== pr.url))
      await deps.instances.putUnits([{ ...unit.row, pr }]);
  };
  try {
    const open = await deps.findOpenPrByHead(instance.repo, branch);
    if (open) {
      await remember({ number: open.number, url: open.htmlUrl });
      // The entry facts (issue 1689). The branch's tip comes from the pull
      // request's own facts read, which prefers the head ref's tip over the
      // possibly-stale listing sha; the approval and the checks are read at
      // that tip. Each fact GitHub would not answer is left out, never guessed.
      const entryFacts = entry
        ? await deps.fetchPrFacts({ repo: instance.repo, number: open.number }).catch(() => undefined)
        : undefined;
      const branchHead = entryFacts?.headSha;
      const entryHead = branchHead ?? open.headSha;
      const approved =
        entry && entryHead !== undefined
          ? await reviewPostedAt(deps, { repo: instance.repo, number: open.number }, "approve", entryHead)
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
      const facts = body.checks === true ? await deps.fetchPrFacts(prRef).catch(() => undefined) : undefined;
      const fixups = body.checks === true ? await deps.fixupCommitSubjects(prRef).catch(() => undefined) : undefined;
      return json(200, {
        ok: true,
        state: "open",
        prNumber: open.number,
        url: open.htmlUrl,
        ...(open.headSha !== undefined ? { headSha: open.headSha } : {}),
        ...(branchHead !== undefined ? { branchHead } : {}),
        ...(approved !== undefined ? { approved } : {}),
        // The pull request's own auto-merge fact (agent-ship item 9), so a
        // merge_ready ending can name it at the approved head.
        ...(open.autoMergeEnabled !== undefined ? { autoMergeEnabled: open.autoMergeEnabled } : {}),
        ...(checks !== undefined ? { checks } : {}),
        ...(facts?.mergeableState !== undefined ? { mergeableState: facts.mergeableState } : {}),
        ...(fixups !== undefined ? { fixupCommits: fixups } : {}),
        at,
      });
    }
    // No open pull request heads the branch: one already merged — by a person,
    // or by an earlier attempt that died after its merge — makes the unit done
    // rather than aborted (record 0031's `merged` ending, reached without the
    // runner's merge). Asked only now: an open pull request is the round's.
    const merged = await deps.findMergedPrByHead(instance.repo, branch);
    if (!merged) {
      // The machine's adopted pull request heads another branch (issue 1799:
      // the child worked the thread's own pull request, not the unit's branch),
      // so before answering `none` the check follows it and answers what GitHub
      // says NOW: open at a fresh head, merged, or verified closed (`prClosed`
      // — the machine must not brief a review on it). An unreadable follow
      // falls through to the plain answer, claiming nothing.
      if (follow !== undefined && recover === undefined) {
        const facts = await deps.fetchPrFacts({ repo: instance.repo, number: follow });
        if (facts !== undefined) {
          const url = facts.htmlUrl ?? `https://github.com/${instance.repo}/pull/${follow}`;
          if (facts.mergedAt !== undefined && facts.mergeCommitSha !== undefined) {
            await remember({ number: follow, url });
            return json(200, {
              ok: true,
              state: "merged",
              prNumber: follow,
              url,
              sha: facts.mergeCommitSha,
              mergedAt: facts.mergedAt,
              at,
            });
          }
          if (facts.state === "open") {
            await remember({ number: follow, url });
            const checks =
              body.checks === true && facts.headSha !== undefined
                ? await deps.fetchCommitChecks(instance.repo, facts.headSha).catch(() => undefined)
                : undefined;
            return json(200, {
              ok: true,
              state: "open",
              prNumber: follow,
              url,
              ...(facts.headSha !== undefined ? { headSha: facts.headSha } : {}),
              ...(facts.autoMergeEnabled !== undefined ? { autoMergeEnabled: facts.autoMergeEnabled } : {}),
              ...(checks !== undefined ? { checks } : {}),
              at,
            });
          }
          // Closed unmerged: said so, so the machine's endings are truthful.
          return json(200, { ok: true, state: "none", prClosed: true, at });
        }
      }
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
        await remember({ number: recovered.pr.number, url: recovered.pr.htmlUrl });
        return json(200, { ok: true, state: "open", prNumber: recovered.pr.number, url: recovered.pr.htmlUrl, at });
      }
      return json(200, { ok: true, state: "none", unrecovered: recovered.why, at });
    }
    await remember({ number: merged.number, url: merged.htmlUrl });
    return json(200, {
      ok: true,
      state: "merged",
      prNumber: merged.number,
      url: merged.htmlUrl,
      sha: merged.sha,
      mergedAt: merged.mergedAt,
      at,
    });
  } catch (err) {
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
  const res = await deps.runs.getRun(runId).catch(() => undefined);
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
function hostPublish(
  deps: AdminCoordinatorDeps,
  instance: CoordinatorInstance,
  runId: string,
  events: RunEvent[],
  at: number,
): void {
  for (const event of events) deps.registry.publish(runId, event);
  const caps = instance.caps ?? resolveShipCaps(undefined);
  const hosting: HostingState = {
    instanceId: instance.id,
    until: at + minutesToMs(caps.maxMinutes + HOSTED_DEADLINE_MARGIN_MINUTES),
  };
  deps
    .ledgerRuns()
    .find((run) => run.runId === runId)
    ?.setState({ hosting });
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
  return json(200, {
    ok: true,
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
      const opened = await openThreadFromRequester(deps, instance, unitLead(instance, row), at);
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
    hostPublish(
      deps,
      instance,
      host.runId,
      [
        {
          type: "ship_unit",
          unit: row.unit,
          state: "started",
          ...(row.threadKey !== undefined ? { threadKey: row.threadKey } : {}),
          lead: unitLead(instance, row),
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
  "transient",
  "enqueued",
  "dequeued",
  "aborted",
  "stopped",
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
              last.gate ? ` · ⚠️ gate fired: ${last.gate.findings.join(", ")} at or above ${last.gate.level}` : ""
            }`
          : u.threadKey
            ? "starting"
            : "waiting";
    // A renewed unit names its segment (decision 0046): `segment 2 · …`.
    const seg =
      u.ending === undefined && u.segments !== undefined && u.segments.length > 0
        ? `segment ${u.segments[u.segments.length - 1]!.index} · `
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
  if (!close) {
    await io.status(shell.live({ detail }));
    return;
  }
  shell.freeze(clock());
  const handle = await io.status(shell.live({ detail }));
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
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  if (namesForeignRun(instance, body)) return json(404, { ok: false, error: "not_found" });
  const host = await hostRunOf(deps, instance);
  if (host.kind === "not_host") return json(409, { ok: false, error: "not_host", at });
  const units = await deps.instances.listUnits(instance.id);
  const row = units.find((u) => u.unit === body.unit);
  if (!row) return json(404, { ok: false, error: "unit_not_found", unit: body.unit });
  const updated: CoordinatorUnit = {
    ...row,
    rounds: [
      ...row.rounds,
      { index: body.index, agent: body.agent, outcome: body.outcome as string, at, ...(gate ? { gate } : {}) },
    ],
  };
  await deps.instances.putUnits([updated]);
  if (host.kind === "host") {
    const thread = unitThread(instance, updated, units.length);
    hostPublish(
      deps,
      instance,
      host.runId,
      [
        {
          type: "ship_round",
          index: body.index,
          agent: body.agent,
          outcome: body.outcome as ShipRoundOutcome,
          ...(gate ? { gate } : {}),
          at,
        },
        {
          type: "ship_unit",
          unit: updated.unit,
          state: body.outcome as string,
          ...(thread.threadKey !== undefined ? { threadKey: thread.threadKey } : {}),
          ...(updated.pr !== undefined ? { pr: updated.pr.number } : {}),
          at,
        },
      ],
      at,
    );
  }
  if (gate)
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
  // The thread's copy of the report (routing-and-config item 28): the driver
  // renders it at the request's verbosity beside the full report the row and
  // the board keep; absent (an older driver), the full report is the thread's.
  // Empty means the level says nothing here — a quiet segment boundary.
  const threadReport = typeof ending.threadReport === "string" ? ending.threadReport : ending.report;
  const at = (deps.clock ?? systemClock)();
  const instance = await deps.instances.get(id.value);
  if (!instance) return json(404, { ok: false, error: "unknown_instance" });
  if (namesForeignRun(instance, body)) return json(404, { ok: false, error: "not_found" });
  const host = await hostRunOf(deps, instance);
  if (host.kind === "not_host") return json(409, { ok: false, error: "not_host", at });
  const units = await deps.instances.listUnits(instance.id);
  const row = units.find((u) => u.unit === body.unit);
  if (!row) return json(404, { ok: false, error: "unit_not_found", unit: body.unit });
  const pr = body.pr as { number?: unknown; url?: unknown } | undefined;
  // A review_pending ending names the coding child's own last push (the
  // driver's `headSha`): persisted on the row as `lastPush`, so the next
  // attempt's rows carry it and its pre-check starts at the review round.
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
  // A real ending is the unit's end: an idle the row carried from an earlier
  // stop is dropped with it, so the row says one thing about how the unit stands.
  const { idle: _idle, ...rowWithoutIdle } = row;
  const updated: CoordinatorUnit = {
    ...(idle !== undefined || segment !== undefined ? row : rowWithoutIdle),
    ...(pr && typeof pr.number === "number" && typeof pr.url === "string"
      ? { pr: { number: pr.number, url: pr.url } }
      : {}),
    ...(lastPush !== undefined ? { lastPush } : {}),
    ...(idle !== undefined
      ? { idle }
      : segment !== undefined
        ? { segments: segments.some((s) => s.index === segment.index) ? segments : [...segments, { ...segment, at }] }
        : { ending: { kind: ending.kind, report: ending.report, at } }),
  };
  await deps.instances.putUnits([updated]);
  const thread = unitThread(instance, updated, units.length);
  if (host.kind === "host")
    hostPublish(
      deps,
      instance,
      host.runId,
      [
        {
          type: "ship_unit",
          unit: updated.unit,
          state: ending.kind,
          ...(thread.threadKey !== undefined ? { threadKey: thread.threadKey } : {}),
          report: ending.report,
          ...(updated.pr !== undefined ? { pr: updated.pr.number } : {}),
          at,
        },
      ],
      at,
    );
  const io =
    thread.threadKey !== undefined ? deps.ioFor({ threadKey: thread.threadKey, userId: instance.userId }) : undefined;
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
  if (segment === undefined && idle === undefined) {
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
  let told = false;
  if (io && threadReport.length === 0)
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
  if (row.issue !== undefined) {
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
  // A held ending's next step is a person's, at the pull request (issue 1990;
  // agent-ship item 9): the report — the human-gated rows and the exact next
  // step — lands there too, where the receipt's producer reads it beside the
  // review that named them. Best effort, like the board's and the thread's.
  if (ending.kind === "held" && updated.pr !== undefined) {
    await deps.github
      .commentIssue(instance.repo, updated.pr.number, `**Plan runner — ${row.unit} held**\n\n${ending.report}`)
      .catch((err) =>
        (deps.log ?? console.warn)(
          `[coordinator] ${instance.id} ${row.unit}: the held report could not be posted on the pull request: ${describe(err)}`,
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
  const res = await deps.runs.getRun(runId).catch(() => undefined);
  if (res === undefined || !res.ok || res.value.parentInstanceId !== instance.id) return undefined;
  return isHandoffShape(res.value.handoff) ? res.value.handoff : undefined;
}

// ---- the merge (docs/reference/specs/http-ingress.md item 9; record 0031's merge grant) ------------

/** The release pull request — release-please's, which deploys — is always a person's merge. */
function isReleasePullRequest(facts: PullRequestFacts): boolean {
  return (
    (facts.headRef?.startsWith("release-please--") ?? false) || /^chore\(main\): release\b/.test(facts.title ?? "")
  );
}

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
        at,
      });
    return refused(`${where} is ${facts.state}`);
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
  if (facts.headSha === undefined || !sameCommit(facts.headSha, headSha))
    return refused(
      `the head of ${where} moved: \`${facts.headSha?.slice(0, 7) ?? "?"}\` is not the approved \`${headSha.slice(0, 7)}\``,
    );
  // A conflicting pull request is refused at once, BEFORE the checks are read
  // (spec item 9): zero checks stays pending only on a mergeable pull request.
  // The refusal names the pull request's own base — a stacked unit rebases
  // onto its parent, not onto the default branch — and the remedy it offers
  // is the sweep (record 0071, mechanism two): `pulls rebase` runs the
  // two-rung resolver and an unchanged patch carries the approval. It never
  // says "re-issue", because a re-issue reads as "run the unit again" and the
  // approved work is already on the branch.
  if (facts.mergeableState === "dirty") {
    const base = facts.baseRef ?? "its base";
    // The remedy named is the one that exists (record 0071, criterion 5): with
    // the watch on for this repository, the watching unit's own round rebases
    // it on the next push to the base; otherwise the sweep a person runs.
    if (deps.mergeWatchOf?.(instance.repo).watch === true)
      return refused(
        `${where} conflicts with \`${base}\` at \`${headSha.slice(0, 7)}\` — the watch is on for \`${instance.repo}\`: the waiting unit's own round rebases it on the next push to \`${base}\` (an unchanged patch carries the approval). The approved work stands`,
      );
    return refused(
      `${where} conflicts with \`${base}\` at \`${headSha.slice(0, 7)}\` — \`pulls rebase ${where}\` rebases it onto \`${base}\` (an unchanged patch carries the approval); merge it by hand once the checks are green. The approved work stands`,
    );
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
    deps.noteMergeWait?.(headSha, id.value, at);
    return json(200, {
      ok: true,
      outcome: "pending",
      reason: `no check has reported at \`${headSha.slice(0, 7)}\` yet`,
      at,
    });
  }
  if (checks.pending.length > 0) {
    deps.noteMergeWait?.(headSha, id.value, at);
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
        `\`${facts.baseRef ?? "the base"}\` takes changes only through a merge queue and the door cannot enqueue — enqueue ${where} by hand (\`gh pr merge --auto\`); the approved work stands`,
      );
    let queued: EnqueueResult;
    try {
      queued = await deps.enqueuePullRequest(pr);
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
 *  for the flake rule — or, on a `retry` ask, the one re-run of the named
 *  failed checks' jobs. A pending or unreported head registers the instance in
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
  if (body.retry !== undefined) {
    if (!Array.isArray(body.retry) || body.retry.length === 0 || !body.retry.every((n) => typeof n === "string"))
      return json(400, { ok: false, error: "retry must name the failed checks" });
    const retried = (await deps.rerunFailedChecks?.(instance.repo, headSha, body.retry as string[])) ?? false;
    log(
      `[coordinator] ${instance.id} ${body.unit}: flake re-run ${retried ? "dispatched" : "not dispatched"} for ${(body.retry as string[]).join(", ")} at ${headSha.slice(0, 7)}`,
    );
    return json(200, { ok: true, retried, at });
  }
  // The pull request's own facts beside the runs (issue 2063): a draft head
  // is the machine's to hold — never to merge — and the base names the branch
  // whose required checks say what the head must still gain. An unreadable
  // answer leaves both out: the checks alone decide, as before.
  const facts = await deps.fetchPrFacts({ repo: instance.repo, number: body.prNumber }).catch(() => undefined);
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
    deps.noteMergeWait?.(headSha, id.value, at);
  if (checks !== undefined && checks.failed.length > 0)
    log(
      `[coordinator] ${instance.id} ${body.unit}: CI red at ${headSha.slice(0, 7)} — ${checks.failed
        .map((f) => `${f.name} (${f.conclusion}${f.flakeSuspect === true ? ", suspected flake" : ""})`)
        .join(", ")}`,
    );
  return json(200, {
    ok: true,
    ...(checks !== undefined ? { checks } : {}),
    ...(facts?.draft === true ? { draft: true } : {}),
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
        ? "no ending was recorded — re-issue `agent:ship` in its thread to continue"
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
  if (host.kind === "host") {
    // The answer enters the stream before finish() — a publish on a finished
    // run is a no-op — so the record's last content event is the summary.
    hostPublish(
      deps,
      instance,
      host.runId,
      [{ type: "answer", text: planSummary(units, isGenerated(instance)), at }],
      at,
    );
    deps.registry.finish(host.runId, body.outcome);
  }
  await drawCard(deps, instance, units, { icon: body.outcome === "completed" ? "✅" : "⚠️" }).catch(() => {});
  // A one-unit plan's unit ran in the requesting thread, so its report is
  // already there — only a plan of two or more units posts the summary back
  // (record 0055 item 3: the count decides, not the source).
  if (units.length >= 2) {
    const io = deps.ioFor({ threadKey: instance.threadKey, userId: instance.userId });
    await io?.reply(`Plan ${instance.plan?.id ?? ""} ended (${body.outcome}):\n${planSummary(units)}`).catch(() => {});
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
      const res = await deps.runs.getRun(runId, { include: "messages" });
      if (!res.ok || res.value.parentInstanceId !== instance.id) return undefined;
      const r = res.value;
      return {
        ...(r.verdict?.findings !== undefined ? { findings: r.verdict.findings } : {}),
        ...(r.dispositions !== undefined ? { dispositions: r.dispositions } : {}),
        ...(finalReplyOf(r.events) !== undefined ? { finalReply: finalReplyOf(r.events) } : {}),
        ...(r.handoff !== undefined ? { handoff: r.handoff } : {}),
      };
    },
    // The generated plan's request text: the ship run's own record
    // (`instance.runId`, its `input` event) — never a scan of the thread, so a
    // routed request with no `agent:ship` turn anywhere still reads back the
    // words the person typed (agent-ship item 13).
    readShipRequest: async () => {
      if (instance.runId === undefined) return undefined;
      const res = await deps.runs.getRun(instance.runId, { include: "messages" }).catch(() => undefined);
      if (res === undefined || !res.ok) return undefined;
      const input = (res.value.events ?? []).find((e) => e.type === "input");
      return input?.type === "input" ? input.text : undefined;
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
  | "pr-check"
  | "round"
  | "unit-end"
  | "checks"
  | "merge"
  | "finish";
const STEPS: readonly Step[] = [
  "authorize",
  "plan",
  "unit-start",
  "branch",
  "spawn",
  "read-record",
  "pr-check",
  "round",
  "unit-end",
  "checks",
  "merge",
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
    case "pr-check":
      return prCheck(parsed.value, deps);
    case "round":
      return round(parsed.value, deps);
    case "unit-end":
      return unitEnd(parsed.value, deps);
    case "checks":
      return checksStep(parsed.value, deps);
    case "merge":
      return merge(parsed.value, deps, door.subject);
    default:
      return finish(parsed.value, deps);
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
