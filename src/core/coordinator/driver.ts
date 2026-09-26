// The plan runner's driver (docs/reference/specs/http-ingress.md item 9;
// docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md): the
// `ShipCoordinator` Workflow's `run()` body, written over a structural step
// runner and a bot client so plain Node proves what the platform replays. The
// driver owns three things and nothing else — which step is taken next and
// under which name (the machine's own, so a replay meets the same step), how a
// bot answer becomes the machine's return, and what is left to the platform's
// retry: a call that throws inside a step is the platform's to ask again under
// the one policy (twelve times, two minutes apart, constant — long enough for a
// bot deploy and its rollover), and the driver never catches it mid-step. A
// throw that escapes a unit's pipeline anyway — a stored answer the mappers
// cannot read, retries exhausted, the platform's own refusal — is told once as
// the unit's ending (kind `failed`, cause `step_threw`, the step and round and
// the throw's one line, issue 2100) before it is rethrown to fail the
// instance, so the unit's row never reads as the bare "no ending was
// recorded" seal.
//
// Every step's stored output is the bot's reply as the wire carried it — the
// status and the text of a JSON object the bot stamped with its clock (`at`) —
// so the mapping onto the machine is pure and runs identically on replay; an
// answer the runner cannot read fails the instance at once rather than twelve
// times over. Every wait is a `waitForEvent` typed `run-finished-<runId>` for
// one chunk of the child's budget (the machine slices the budget plus the
// margin, `WAIT_CHUNK_MS`, and asks `read-record` between the slices), and
// every wait — event or timeout alike — is confirmed by a `read-record` before
// the machine acts on it, so an event the engine never delivered costs a
// chunk, not the budget.
//
// Units run one at a time in the plan's order, each once its in-play
// dependencies are done. `done` is merged: a plan branch's pull request is the
// runner's to squash (the `merge` step, under `plan:merge`) once the review
// approved at its head and the checks are green, so its dependents start on a
// base that carries it — or was found merged already by the machine's first
// `pr-check` (a re-issued plan whose unit a person, or an earlier attempt,
// merged), which ends the unit with no branch and no child; a unit that ended
// any other way — a refused merge, a
// cap, a stop — blocks its dependents, each told so as its own ending, and the
// plan finishes `failed` so the summary says which units are left for the
// plan's re-issue. A task string's ship branch waits for a person. Node-free:
// the shim Worker imports this by relative path.

import {
  DAY_MS,
  DEFAULT_GRANT,
  GRANT_RENEWALS_MAX,
  IDLE_DAYS_MAX,
  SHIP_RECORD_VISIBILITY,
  type Grant,
  type GrantSource,
} from "../budgets.js";
import { isFindingShape, type Finding } from "../reviewVerdict.js";
import { DEFAULT_VERBOSITY, isVerbosity, type Verbosity } from "../verbosity.js";
import {
  applyReturn,
  cursorFinished,
  nextAction,
  openPlanCursor,
  openRecoveredUnitPipeline,
  openUnitPipeline,
  readyUnits,
  type PlanCursor,
  type UnitStatus,
  renderUnitReport,
  reenterApprovedRebase,
  reconcileTerminalPr,
  settleUnit,
  startUnit,
  type ChildFacts,
  type MergeReadyFacts,
  type CoordinatorAction,
  isAddressSeverity,
  type AddressSeverity,
  type AddressSeveritySource,
  type PlanGraph,
  type PlanUnitNode,
  type RoundChecks,
  type ShipCaps,
  type StepReturn,
  type UnitEnding,
  type UnitPipelineInput,
  type UnitPipelineState,
  stepPrefixOf,
  type LeaseSegmentProgress,
} from "../ship/coordinator.js";
import {
  checksSettledEventType,
  childInterruptedEventType,
  childResumedEventType,
  isCoordinatorUnit,
  isUnitWakeAnswer,
  runFinishedEventType,
  unitNudgeEventType,
  type CoordinatorUnit,
  type UnitWakeAnswer,
} from "./contract.js";

const MIN = 60_000;

/** The one retry policy every step runs under: a bot deploy plus its rollover fits inside it. */
export const STEP_RETRIES = { limit: 12, delay: 2 * MIN, backoff: "constant" } as const;
export interface StepConfig {
  retries: { limit: number; delay: number; backoff: "constant" | "linear" | "exponential" };
  /** The step's own wall clock, in ms; the platform's default when absent. */
  timeout?: number;
}
export const STEP_CONFIG: StepConfig = { retries: STEP_RETRIES };
/** A spawn answers when the child registers, which waits on an attach — minutes on a cold sandbox. */
export const SPAWN_STEP_CONFIG: StepConfig = { retries: STEP_RETRIES, timeout: 15 * MIN };

/** The platform's step primitives as the driver uses them — `WorkflowStep`
 *  fits; so does a test's recorder. Every `do` stores a bot reply. */
export interface StepRunner {
  do(name: string, config: StepConfig, callback: () => Promise<BotReply>): Promise<BotReply>;
  sleep(name: string, ms: number): Promise<void>;
  waitForEvent(name: string, options: { type: string; timeout?: number }): Promise<unknown>;
}

export type CoordinatorStepRoute =
  | "recover-unit"
  | "plan"
  | "unit-start"
  | "branch"
  | "spawn"
  | "read-record"
  | "steer"
  | "pr-check"
  | "round"
  | "unit-end"
  | "unit-wake"
  | "checks"
  | "merge"
  | "rebase"
  | "finish";

/** What a step stores: the bot's reply as the wire carried it — its status and
 *  its text, read the same way on replay. Two numbers and a string, so the
 *  platform's serializable bound holds without a shape decided at storage time. */
export interface BotReply {
  status: number;
  text: string;
}

/** A bot answer read from a reply: the status and the JSON object the bot stamped with its clock. */
export interface BotAnswer {
  status: number;
  body: { at: number; [key: string]: unknown };
}

/** The bot as the driver calls it: `step` resolves with what the bot's HTTP
 *  answered and throws for the transport (a container mid-restart, a bot
 *  mid-deploy) so the platform asks again; the Worker's client also throws as
 *  final for the door's own refusal, since no retry changes a token map. */
export interface CoordinatorBot {
  step(route: CoordinatorStepRoute, body: Record<string, unknown>): Promise<BotReply>;
}

export interface PlanRunSummary {
  instance: string;
  planId?: string;
  /** Each unit's ending kind, or `blocked`. */
  units: Record<string, string>;
  outcome: "completed" | "failed";
}

export interface OriginalUnitRecoveryParams {
  kind: "recover-original-unit";
  parentInstanceId: string;
  unit: string;
}

// ---- reading the bot ---------------------------------------------------------------------------------

const REASON_MAX = 200;

/** A bot answer is a JSON object stamped `at`, at any status — a gate's 403
 *  and a busy 409 are answers. Anything else is not the bot's: the door's
 *  refusal (no `at`), the shim's own error page, a container mid-restart. */
export function readBotAnswer(
  status: number,
  text: string,
): { ok: true; answer: BotAnswer } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const body =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  if (body !== undefined && typeof body.at === "number")
    return { ok: true, answer: { status, body: body as BotAnswer["body"] } };
  const detail =
    typeof body?.error === "string" ? body.error : text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
  return { ok: false, reason: `HTTP ${status} — ${detail}` };
}

/** The answers the bot itself calls a passing condition — the step is asked
 *  again, under the policy. Everything else, refusals included, is the machine's.
 *  `queued` is the plane's hold on a spawn (record 0064, "The queue"): a `409`
 *  saying the child's admission waits on an event — the step re-asks until the
 *  child is admitted, and the instance is never failed over a full plane. */
const TRANSIENT = new Set([
  "github_unavailable",
  "no_channel",
  "thread_failed",
  "unit_not_started",
  "not_host",
  "queued",
  "publication_ownership_unknown",
]);
export function transientRefusal(answer: BotAnswer): string | undefined {
  const { ok, error, message } = answer.body;
  if (ok !== false || typeof error !== "string" || !TRANSIENT.has(error)) return undefined;
  return `the bot answered ${error}${typeof message === "string" ? `: ${message}` : ""}`;
}

class UnreadableAnswer extends Error {
  constructor(route: CoordinatorStepRoute, answer: BotAnswer, what: string) {
    super(
      `the bot's ${route} answer could not be read (${what}): HTTP ${answer.status} ${JSON.stringify(answer.body).slice(0, REASON_MAX)}`,
    );
  }
}

interface PlanFacts {
  planId?: string;
  /** Who merges, as the instance's field has it: the plan route answers it, `person` when absent. */
  merge: "runner" | "person";
  /** The severity to address, beside `merge`: the level an approve's findings are held to, and which layer set it. */
  addressSeverity: AddressSeverity;
  addressSeveritySource: AddressSeveritySource;
  /** The grant beside them (decision 0046): what a renewal could spend, and which layer granted it. */
  grant: Grant;
  grantSource: GrantSource;
  /** The request's verbosity as the plan route answers it (routing-and-config item 28): what the unit threads hear. */
  verbosity: Verbosity;
  /** The idle flag beside the grant (record 0051): above zero, an idling ending becomes `idle`. */
  idleDays: number;
  /** The instance's mark as the plan route answers it: a generated one-unit plan (a `plan` with no `path`). */
  generated: boolean;
  /** The runs page base the bot answered: the report links a child's write-up to its run page with it. */
  runPageBase?: string;
  /** The hard stop's mark (record 0060; issue 1924): the hosted parent was
   *  sealed, so the walk ends the remaining units stopped and runs nothing more. */
  stopped: boolean;
  repo: string;
  base: string;
  caps: ShipCaps;
  units: CoordinatorUnit[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isMinutes = (v: unknown): v is Record<string, number> =>
  isRecord(v) && Object.values(v).every((n) => typeof n === "number" && Number.isFinite(n));

/** The grant as the plan route answers it; anything unreadable — a count
 *  outside the module's ceiling included — is the default: nothing renews on a guess. */
function readGrant(raw: unknown): Grant {
  if (
    !isRecord(raw) ||
    typeof raw.renewals !== "number" ||
    !Number.isInteger(raw.renewals) ||
    raw.renewals < 0 ||
    raw.renewals > GRANT_RENEWALS_MAX
  )
    return DEFAULT_GRANT;
  const cap = raw.costCapUsd;
  return { renewals: raw.renewals, ...(typeof cap === "number" && cap > 0 ? { costCapUsd: cap } : {}) };
}

/** The idle flag as the plan route answers it (record 0051): an integer from 0
 *  to the module's cap; anything unreadable is 0 — nothing idles on a guess. */
function readIdleDays(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= IDLE_DAYS_MAX ? raw : 0;
}

function readPlan(a: BotAnswer): PlanFacts {
  const b = a.body;
  if (b.ok !== true) throw new UnreadableAnswer("plan", a, "not ok");
  if (typeof b.repo !== "string" || typeof b.base !== "string") throw new UnreadableAnswer("plan", a, "repo and base");
  if (!isMinutes(b.caps) || typeof b.caps.maxRounds !== "number" || typeof b.caps.maxMinutes !== "number")
    throw new UnreadableAnswer("plan", a, "caps");
  const units: unknown = b.units;
  if (!Array.isArray(units) || !units.every(isCoordinatorUnit)) throw new UnreadableAnswer("plan", a, "units");
  return {
    ...(typeof b.planId === "string" ? { planId: b.planId } : {}),
    merge: b.merge === "runner" ? "runner" : "person",
    addressSeverity: isAddressSeverity(b.addressSeverity) ? b.addressSeverity : "minor",
    addressSeveritySource:
      b.addressSeveritySource === "run" || b.addressSeveritySource === "user" || b.addressSeveritySource === "channel"
        ? b.addressSeveritySource
        : "org",
    grant: readGrant(b.grant),
    grantSource:
      b.grantSource === "run" || b.grantSource === "user" || b.grantSource === "channel" ? b.grantSource : "org",
    verbosity: isVerbosity(b.verbosity) ? b.verbosity : DEFAULT_VERBOSITY,
    idleDays: readIdleDays(b.idleDays),
    generated: b.generated === true,
    ...(typeof b.runPageBase === "string" && b.runPageBase.length > 0 ? { runPageBase: b.runPageBase } : {}),
    stopped: b.stopped === true,
    repo: b.repo,
    base: b.base,
    caps: { maxRounds: b.caps.maxRounds, maxMinutes: b.caps.maxMinutes },
    units,
  };
}

function readUnitStart(a: BotAnswer): { at: number } {
  if (a.body.ok !== true || typeof a.body.threadKey !== "string") throw new UnreadableAnswer("unit-start", a, "thread");
  return { at: a.body.at };
}

function readWakeAnswer(a: BotAnswer): { answer: UnitWakeAnswer; at: number } {
  if (a.body.ok !== true || !isUnitWakeAnswer(a.body.answer)) throw new UnreadableAnswer("unit-wake", a, "wake answer");
  return { answer: a.body.answer, at: a.body.at };
}

function branchReturn(step: string, a: BotAnswer): StepReturn {
  const { ok, reason, at } = a.body;
  if (ok === true) return { type: "branch", step, ok: true, at };
  if (ok === false && typeof reason === "string") return { type: "branch", step, ok: false, reason, at };
  throw new UnreadableAnswer("branch", a, "ok or reason");
}

function spawnReturn(step: string, a: BotAnswer): StepReturn {
  const { ok, runId, alreadySpawned, error, message, at } = a.body;
  if (ok === true && typeof runId === "string")
    return { type: "spawn", step, outcome: alreadySpawned === true ? "alreadySpawned" : "spawned", runId, at };
  if (a.status === 409 && error === "busy")
    return { type: "spawn", step, outcome: "busy", ...(typeof runId === "string" ? { runId } : {}), at };
  // The hosted parent's hard stop (record 0060; issue 1924): the spawn is
  // refused over the instance row's stop mark, and the unit ends stopped.
  if (a.status === 409 && error === "stopped") return { type: "spawn", step, outcome: "stopped", at };
  if (a.status === 403 && typeof error === "string")
    return {
      type: "spawn",
      step,
      outcome: "refused",
      refusal: error,
      ...(typeof message === "string" ? { message } : {}),
      at,
    };
  if (a.status === 502 && typeof error === "string")
    return { type: "spawn", step, outcome: "failed", reason: typeof message === "string" ? message : error, at };
  throw new UnreadableAnswer("spawn", a, "outcome");
}

function readRecordReturn(step: string, a: BotAnswer): StepReturn {
  const run = a.body.run;
  if (a.body.ok !== true || !isRecord(run) || typeof run.finished !== "boolean")
    throw new UnreadableAnswer("read-record", a, "run");
  // The hard stop's mark, as the bot's answer carries it (record 0060; issue
  // 1924): a finished child's unit ends stopped on it.
  const stopped = a.body.stopped === true ? { stopped: true as const } : {};
  const pullRequest = isRecord(a.body.pullRequest)
    ? prCheckReturn(step, {
        status: a.status,
        body: { ok: true, ...a.body.pullRequest, at: a.body.at },
      }).pr
    : undefined;
  // The interrupted child restarted from its request (issue 1903): the bot
  // answers the live successor's id, and the machine keeps the wait on it.
  const restarted = typeof a.body.restartedAs === "string" ? { restartedAs: a.body.restartedAs } : {};
  if (!run.finished)
    return {
      type: "read-record",
      step,
      run: { finished: false },
      ...(pullRequest !== undefined ? { pullRequest } : {}),
      ...stopped,
      ...restarted,
      at: a.body.at,
    };
  if (typeof run.status !== "string") throw new UnreadableAnswer("read-record", a, "status");
  // The typed artifacts as the bot's record carries them — shape-checked where
  // they were written (the run record's validator), read here as they are.
  const facts = run as unknown as Omit<Extract<ChildFacts, { finished: true }>, "finished" | "status">;
  const {
    finishedAt,
    reviewAskedAt,
    finalReply,
    pr,
    headSha,
    description,
    verdict,
    reviewPosted,
    reviewPostReason,
    reviewHead,
    dispositions,
    handoff,
    pushed,
    leaseStartedAt,
    costUsd,
    handoffLists,
    failure,
    interruption,
  } = facts;
  return {
    type: "read-record",
    step,
    ...stopped,
    ...(pullRequest !== undefined ? { pullRequest } : {}),
    run: {
      finished: true,
      status: run.status as Extract<ChildFacts, { finished: true }>["status"],
      ...(typeof finishedAt === "number" ? { finishedAt } : {}),
      ...(typeof reviewAskedAt === "number" ? { reviewAskedAt } : {}),
      ...(finalReply !== undefined ? { finalReply } : {}),
      ...(pr !== undefined ? { pr } : {}),
      ...(headSha !== undefined ? { headSha } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(verdict !== undefined ? { verdict } : {}),
      ...(reviewPosted !== undefined ? { reviewPosted } : {}),
      ...(reviewPostReason !== undefined ? { reviewPostReason } : {}),
      ...(reviewHead !== undefined ? { reviewHead } : {}),
      ...(dispositions !== undefined ? { dispositions } : {}),
      ...(handoff !== undefined ? { handoff } : {}),
      // The renewal's facts (decision 0046), as the record carries them.
      ...(Array.isArray(pushed) ? { pushed } : {}),
      ...(typeof leaseStartedAt === "number" ? { leaseStartedAt } : {}),
      ...(typeof costUsd === "number" || costUsd === null ? { costUsd } : {}),
      ...(handoffLists !== undefined ? { handoffLists } : {}),
      // The failure by name (run-history item 57), shape-checked: a
      // `provider_transient` drives the round-0 re-run (agent-ship item 9).
      ...(isRecord(failure) && typeof failure.kind === "string" ? { failure: { kind: failure.kind } } : {}),
      // What ended an interrupted child (issue 1876): the ending's sentence
      // names the cause instead of claiming a bot restart for every one.
      ...(interruption === "bot_restart" || interruption === "container_replaced" || interruption === "sandbox_fault"
        ? { interruption }
        : {}),
    },
    at: a.body.at,
  };
}

/** The check runs a pr-check answer carries at the head (agent-ship item 9), shape-checked. */
function isCommitChecks(v: unknown): v is { total: number; pending: string[]; failed: string[] } {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  const names = (x: unknown) => Array.isArray(x) && x.every((n) => typeof n === "string");
  return typeof c.total === "number" && names(c.pending) && names(c.failed);
}

function entryHumanGate(v: unknown):
  | {
      round: number;
      findings: Finding[];
      verdict: "approve" | "request_changes";
      answer: string;
      author: string;
      commentId: string;
    }
  | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const row = v as Record<string, unknown>;
  if (typeof row.round !== "number" || !Number.isInteger(row.round) || row.round < 1) return undefined;
  if (!Array.isArray(row.findings) || !row.findings.every(isFindingShape)) return undefined;
  if (row.verdict !== "approve" && row.verdict !== "request_changes") return undefined;
  if (typeof row.answer !== "string" || typeof row.author !== "string" || typeof row.commentId !== "string")
    return undefined;
  return {
    round: row.round,
    findings: row.findings,
    verdict: row.verdict,
    answer: row.answer,
    author: row.author,
    commentId: row.commentId,
  };
}

function prCheckReturn(step: string, a: BotAnswer): Extract<StepReturn, { type: "pr-check" }> {
  const { ok, state, prNumber, url, headSha, sha, mergedAt, mergedBy, closedBy, at } = a.body;
  if (ok === true && state === "none") {
    const { unrecovered, aheadOfBase, prClosed } = a.body;
    return {
      type: "pr-check",
      step,
      pr: {
        state: "none",
        ...(unrecovered === "no_commits" || unrecovered === "no_base" ? { unrecovered } : {}),
        // The branch's commits over the base, when the bot could read them
        // (agent-ship item 12): zero is the `already_landed` ending's fact.
        ...(typeof aheadOfBase === "number" ? { aheadOfBase } : {}),
        // The followed pull request verified closed unmerged (issue 1799):
        // the machine must not brief a review round on it.
        ...(prClosed === true ? { prClosed: true } : {}),
      },
      at,
    };
  }
  if (ok === true && state === "open" && typeof prNumber === "number" && typeof url === "string")
    return {
      type: "pr-check",
      step,
      pr: {
        state: "open",
        prNumber,
        url,
        ...(typeof headSha === "string" ? { headSha } : {}),
        ...(typeof a.body.headBranchExists === "boolean" ? { headBranchExists: a.body.headBranchExists } : {}),
        // The entry facts (issue 1689): the branch's own tip and whether the
        // bot's approval stands at the head, read at the unit-start's pre-check
        // so a re-issued plan resumes at review or at the merge decision.
        ...(typeof a.body.branchHead === "string" ? { branchHead: a.body.branchHead } : {}),
        ...(typeof a.body.approved === "boolean" ? { approved: a.body.approved } : {}),
        ...(typeof a.body.autoMergeEnabled === "boolean" ? { autoMergeEnabled: a.body.autoMergeEnabled } : {}),
        ...(isCommitChecks(a.body.checks) ? { checks: a.body.checks } : {}),
        // The ready-state facts beside the checks (agent-ship item 9): the
        // pull request's mergeable state and its self-declared fix-up commits.
        ...(typeof a.body.mergeableState === "string" ? { mergeableState: a.body.mergeableState } : {}),
        ...(Array.isArray(a.body.fixupCommits) && a.body.fixupCommits.every((s: unknown) => typeof s === "string")
          ? { fixupCommits: a.body.fixupCommits as string[] }
          : {}),
        // The base's merge-queue rule beside the checks (issue 2011): the
        // merge:person report says the person's merge is queued.
        ...(typeof a.body.baseHasMergeQueue === "boolean" ? { baseHasMergeQueue: a.body.baseHasMergeQueue } : {}),
        ...(entryHumanGate(a.body.humanGate) !== undefined ? { humanGate: entryHumanGate(a.body.humanGate)! } : {}),
      },
      at,
    };
  // A merged pull request is read whole or not at all: its source head is
  // retained for findings reconciliation, while the merge commit and time
  // are what the unit's ending and report carry.
  if (
    ok === true &&
    state === "merged" &&
    typeof prNumber === "number" &&
    typeof url === "string" &&
    typeof sha === "string" &&
    typeof mergedAt === "string"
  )
    return {
      type: "pr-check",
      step,
      pr: {
        state: "merged",
        prNumber,
        url,
        ...(typeof headSha === "string" ? { headSha } : {}),
        sha,
        mergedAt,
        ...(typeof mergedBy === "string" ? { mergedBy } : {}),
      },
      at,
    };
  if (
    ok === true &&
    state === "closed" &&
    typeof prNumber === "number" &&
    typeof url === "string" &&
    typeof closedBy === "string"
  )
    return { type: "pr-check", step, pr: { state: "closed", prNumber, url, closedBy }, at };
  throw new UnreadableAnswer("pr-check", a, "state");
}

function steerReturn(step: string, a: BotAnswer): Extract<StepReturn, { type: "steer" }> {
  if (a.body.ok === true && (a.body.outcome === "steered" || a.body.outcome === "not_live"))
    return { type: "steer", step, outcome: a.body.outcome, at: a.body.at };
  throw new UnreadableAnswer("steer", a, "outcome");
}

/** The round's checks read as the bot answered it (record 0055): the runs at
 *  the reviewed head, or none when GitHub could not be read — the machine
 *  treats an absent read as pending and asks again at the chunk's end. A retry
 *  ask's answer carries `retried` instead: whether the re-run was dispatched,
 *  so the machine never waits on a head an undispatched re-run left unchanged. */
function checksReturn(step: string, a: BotAnswer): StepReturn {
  const { ok, checks, draft, retried, refired, at } = a.body;
  if (ok !== true) throw new UnreadableAnswer("checks", a, "ok");
  return {
    type: "checks",
    step,
    ...(isRoundChecks(checks) ? { checks } : {}),
    ...(isRecord(a.body.pullRequest)
      ? {
          pullRequest: prCheckReturn(step, {
            status: a.status,
            body: { ok: true, ...a.body.pullRequest, at },
          }).pr,
        }
      : {}),
    // The pull request is a draft (issue 2063): the machine's table holds the
    // unit for the ready event instead of merging or ending without a cause.
    ...(draft === true ? { draft: true } : {}),
    ...(typeof retried === "boolean" ? { retried } : {}),
    ...(typeof refired === "boolean" ? { refired } : {}),
    at,
  };
}

const isRoundChecks = (v: unknown): v is RoundChecks =>
  isRecord(v) &&
  typeof v.total === "number" &&
  Array.isArray(v.pending) &&
  v.pending.every((n: unknown) => typeof n === "string") &&
  Array.isArray(v.failed) &&
  v.failed.every((f: unknown) => isRecord(f) && typeof f.name === "string" && typeof f.conclusion === "string") &&
  (v.required === undefined ||
    (Array.isArray(v.required) && v.required.every((n: unknown) => typeof n === "string"))) &&
  (v.expected === undefined || (Array.isArray(v.expected) && v.expected.every((n: unknown) => typeof n === "string")));

function mergeReturn(step: string, a: BotAnswer): StepReturn {
  const { ok, outcome, by, sha, mergedAt, mergedBy, reason, at } = a.body;
  // The door found the pull request already merged after the approval: the
  // merge commit and the time ride the answer, and the unit ends `by: other`.
  if (ok === true && outcome === "merged" && by === "other" && typeof sha === "string" && typeof mergedAt === "string")
    return {
      type: "merge",
      step,
      outcome: "merged",
      by: "other",
      sha,
      mergedAt,
      ...(typeof mergedBy === "string" ? { mergedBy } : {}),
      at,
    };
  if (ok === true && outcome === "recheck" && isRecord(a.body.pullRequest))
    return {
      type: "merge",
      step,
      outcome: "recheck",
      pullRequest: prCheckReturn(step, {
        status: a.status,
        body: { ok: true, ...a.body.pullRequest, at },
      }).pr,
      at,
    };
  if (ok === true && outcome === "merged" && typeof sha === "string")
    return { type: "merge", step, outcome: "merged", sha, at };
  if (
    ok === true &&
    (outcome === "pending" ||
      outcome === "refused" ||
      outcome === "conflict" ||
      outcome === "enqueued" ||
      outcome === "removed") &&
    typeof reason === "string"
  )
    return { type: "merge", step, outcome, reason, at };
  throw new UnreadableAnswer("merge", a, "outcome");
}

function rebaseReturn(step: string, a: BotAnswer): StepReturn {
  const { ok, outcome, headSha, reason, at } = a.body;
  if (ok === true && (outcome === "carried" || outcome === "changed") && typeof headSha === "string")
    return { type: "rebase", step, outcome, headSha, at };
  if (ok === true && (outcome === "conflict" || outcome === "refused") && typeof reason === "string")
    return { type: "rebase", step, outcome, reason, at };
  throw new UnreadableAnswer("rebase", a, "outcome");
}

// ---- the steps ----------------------------------------------------------------------------------------

/** One bot call inside a step: a reply that is not the bot's answer and a
 *  passing refusal are throws, so the platform asks again; the reply is stored. */
async function call(
  bot: CoordinatorBot,
  route: CoordinatorStepRoute,
  body: Record<string, unknown>,
  acceptOpaqueNotFound = false,
): Promise<BotReply> {
  const reply = await bot.step(route, body);
  const read = readBotAnswer(reply.status, reply.text);
  if (!read.ok) {
    if (acceptOpaqueNotFound && isOpaqueNotFound(reply)) return reply;
    throw new Error(`the bot did not answer ${route}: ${read.reason}`);
  }
  const transient = transientRefusal(read.answer);
  if (transient !== undefined) throw new Error(transient);
  return reply;
}

/** The read door's authorization mask: absent and denied are deliberately the
 *  same reply. The runner may pace that reply only from its own addressed
 *  finish event; parsing it here never changes what another caller sees. */
function isOpaqueNotFound(reply: BotReply): boolean {
  if (reply.status !== 404) return false;
  try {
    const body = JSON.parse(reply.text) as { ok?: unknown; error?: unknown };
    return body?.ok === false && body.error === "not_found";
  } catch {
    return false;
  }
}

async function readRecordStep(
  step: StepRunner,
  bot: CoordinatorBot,
  action: Extract<CoordinatorAction, { type: "read-record" }>,
  body: Record<string, unknown>,
): Promise<BotReply> {
  for (let retry = 0; ; retry++) {
    const name = retry === 0 ? action.step : `${action.step}/record-read/${retry}`;
    const reply = await step.do(name, STEP_CONFIG, () => call(bot, "read-record", body, true));
    if (!isOpaqueNotFound(reply) || action.finishedObserved !== true || retry >= SHIP_RECORD_VISIBILITY.retries)
      return reply;
    await step.sleep(`${action.step}/record-visible/${retry + 1}`, SHIP_RECORD_VISIBILITY.retryMs);
  }
}

/** The answer a stored reply carries — the reply passed `call` once, so it reads the same on replay. */
function answerOf(route: CoordinatorStepRoute, reply: BotReply): BotAnswer {
  const read = readBotAnswer(reply.status, reply.text);
  if (!read.ok) throw new Error(`the stored ${route} reply is not the bot's answer: ${read.reason}`);
  return read.answer;
}

/** A wait's outcome: the event, or anything else — the machine confirms either by `read-record`.
 *
 *  Three waits under one chunk (run-history item 47a): the child's finish
 *  (`run-finished-<runId>`), its deploy-roll interruption
 *  (`child-interrupted-<runId>`, the reattach path's word that the child
 *  closed `interrupted` — settled as the finish is, so the round ends at once
 *  with the child's own reason once `read-record` confirms it) and its resume
 *  (`child-resumed-<runId>`, the same run carrying on after a roll — consumed
 *  and re-armed, never a settlement: a resumed child keeps the wait). The
 *  chunk times out only once the finish AND the interruption waits both have;
 *  a resumed wait's own timeout decides nothing. */
async function waitForRun(
  step: StepRunner,
  action: Extract<CoordinatorAction, { type: "wait" }>,
): Promise<"event" | "timeout"> {
  return await new Promise((resolve) => {
    let settled = false;
    let timeouts = 0;
    const settle = (outcome: "event" | "timeout") => {
      settled = true;
      resolve(outcome);
    };
    const settling = (name: string, type: string) =>
      step.waitForEvent(name, { type, timeout: action.timeoutMs }).then(
        () => settle("event"),
        () => {
          timeouts += 1;
          // Deferred a microtask so a resume that lands with the chunk's own
          // end is still consumed (re-armed) before the timeout settles.
          if (timeouts === 2) queueMicrotask(() => settle("timeout"));
        },
      );
    void settling(action.step, runFinishedEventType(action.runId));
    void settling(`${action.step}/interrupted`, childInterruptedEventType(action.runId));
    // Each resumed event re-arms under the next durable name, so a second roll
    // in the same chunk is still heard; a timeout here ends nothing, and a
    // settled wait arms no further step.
    const armResumed = (n: number): void => {
      void step
        .waitForEvent(n === 1 ? `${action.step}/resumed` : `${action.step}/resumed/${n}`, {
          type: childResumedEventType(action.runId),
          timeout: action.timeoutMs,
        })
        .then(
          () => {
            if (!settled) armResumed(n + 1);
          },
          () => {},
        );
    };
    armResumed(1);
  });
}

async function perform(
  step: StepRunner,
  bot: CoordinatorBot,
  instanceId: string,
  unit: string,
  action: Exclude<CoordinatorAction, { type: "end" }>,
): Promise<StepReturn> {
  const tag = { parentInstanceId: instanceId, unit };
  switch (action.type) {
    case "branch":
      return branchReturn(
        action.step,
        answerOf("branch", await step.do(action.step, STEP_CONFIG, () => call(bot, "branch", tag))),
      );
    case "spawn":
      return spawnReturn(
        action.step,
        answerOf(
          "spawn",
          await step.do(action.step, SPAWN_STEP_CONFIG, () =>
            call(bot, "spawn", {
              ...tag,
              step: action.step,
              preset: action.preset,
              budget: action.budgetMinutes,
              brief: action.brief,
            }),
          ),
        ),
      );
    case "wait":
      return { type: "wait", step: action.step, outcome: await waitForRun(step, action) };
    case "read-record":
      return readRecordReturn(
        action.step,
        answerOf("read-record", await readRecordStep(step, bot, action, { ...tag, runId: action.runId })),
      );
    case "steer":
      return steerReturn(
        action.step,
        answerOf(
          "steer",
          await step.do(action.step, STEP_CONFIG, () =>
            call(bot, "steer", { ...tag, runId: action.runId, reason: action.reason }),
          ),
        ),
      );
    case "pr-check":
      // `recover` rides only after a dead coding child: the bot opens the pull
      // request from the pushed branch itself instead of answering `none`.
      // `pr` is the machine's adopted pull request (issue 1799): the bot
      // follows it when nothing heads the unit's branch and answers its live
      // state instead of `none` over a minutes-old record fact.
      return prCheckReturn(
        action.step,
        answerOf(
          "pr-check",
          await step.do(action.step, STEP_CONFIG, () =>
            call(bot, "pr-check", {
              ...tag,
              // `entry` is the unit-start's pre-check (issue 1689): the bot
              // reads the branch's tip, the approval and the checks beside the
              // listing, so a re-issued plan's unit resumes instead of recoding.
              ...(action.entry === true ? { entry: true } : {}),
              ...(action.recover !== undefined ? { recover: action.recover } : {}),
              ...(action.pr !== undefined ? { pr: action.pr } : {}),
            }),
          ),
        ),
      );
    case "sleep":
      await step.sleep(action.step, action.ms);
      return { type: "sleep", step: action.step };
    case "wait-checks": {
      // The intake's checks-settled event at the approved head (http-ingress.md
      // item 12), with the machine's bounded timeout as the fallback: either
      // way the machine re-asks the merge door, which is the guard.
      let outcome: "event" | "timeout";
      try {
        await step.waitForEvent(action.step, {
          type: checksSettledEventType(action.headSha),
          timeout: action.timeoutMs,
        });
        outcome = "event";
      } catch {
        outcome = "timeout";
      }
      return { type: "wait-checks", step: action.step, outcome };
    }
    case "checks":
      // The round's checks step (record 0055): the bot reads the check runs at
      // the reviewed head with the merge door's own reading — or performs one
      // of the step's bounded recovery effects first.
      return checksReturn(
        action.step,
        answerOf(
          "checks",
          await step.do(action.step, STEP_CONFIG, () =>
            call(bot, "checks", {
              ...tag,
              prNumber: action.prNumber,
              headSha: action.headSha,
              ...(action.retry !== undefined ? { retry: action.retry } : {}),
              ...(action.refire === true ? { refire: true } : {}),
            }),
          ),
        ),
      );
    case "merge":
      return mergeReturn(
        action.step,
        answerOf(
          "merge",
          await step.do(action.step, STEP_CONFIG, () =>
            call(bot, "merge", {
              ...tag,
              prNumber: action.prNumber,
              headSha: action.headSha,
              ...(action.queued === true ? { queued: true } : {}),
            }),
          ),
        ),
      );
    case "rebase":
      return rebaseReturn(
        action.step,
        answerOf(
          "rebase",
          await step.do(action.step, STEP_CONFIG, () =>
            call(bot, "rebase", { ...tag, prNumber: action.prNumber, headSha: action.headSha }),
          ),
        ),
      );
  }
}

/** The throw's one line, for the step-threw ending's report (issue 2100). */
function oneLineOf(err: unknown): string {
  const line = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.trim();
  if (line.length === 0) return "an error with no message";
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX)}…` : line;
}

/** Where the machine was when a step threw: the step's own name and, inside a
 *  round, the round it belonged to. */
interface StepAt {
  step: string;
  round?: { index: number; kind: string };
}

/** A step that throws inside the walk becomes the unit's ending (issue 2100):
 *  kind `failed`, cause `step_threw`, the step and round it was in and the
 *  throw's one line, posted in the user's words — best effort, before the
 *  throw is rethrown to fail the instance — so the unit's row carries a cause
 *  a person can read instead of the bare "no ending was recorded" seal (the
 *  walk-dies-before-unit-end path behind issues 2063 and 2100: run 21c50656
 *  died between round 2's review verdict and its outcome write). */
async function tellStepThrew(
  step: StepRunner,
  bot: CoordinatorBot,
  prefix: string,
  tag: { parentInstanceId: string; unit: string },
  pr: { number: number; url: string } | undefined,
  at: StepAt,
  err: unknown,
  recoveryUnitKey?: string,
  recoveryWorkflowId?: string,
): Promise<void> {
  const line = oneLineOf(err);
  const where =
    at.round === undefined
      ? `at \`${at.step}\``
      : at.round.kind === "review" && /\/review\/(read|checks)\b/.test(at.step)
        ? `after round ${at.round.index}'s review verdict (\`${at.step}\`)`
        : `in round ${at.round.index} (\`${at.step}\`)`;
  const findingsReconcile = at.round?.kind === "findings" && /\/findings(?:\/a\d+)?\/pr-check$/.test(at.step);
  const report = findingsReconcile
    ? [
        `⚠️ Review did not restart because Switchboard could not read the pull request after the completed findings work: ${line}`,
        pr !== undefined
          ? `Saved-work fact: the existing pull request is ${pr.url}, but its current branch and exact head were not verified.`
          : "Saved-work fact: no open pull request or exact remote head was verified.",
        recoveryUnitKey !== undefined
          ? `No review was started. The recovery attempt for \`${recoveryUnitKey}\` is terminal; a replacement pipeline is not available.`
          : "No review was started. Next action: retry ship when the pull request is readable so Switchboard can verify the exact head first.",
      ].join("\n\n")
    : [
        `⚠️ Switchboard failed ${where}: ${line}`,
        recoveryUnitKey !== undefined
          ? `The recovery attempt for \`${recoveryUnitKey}\` is terminal. No continuation or replacement pipeline was scheduled.`
          : "The unit remains resumable from its recorded branch and pull request facts. No continuation action was scheduled. Next action: start ship again after the failing operation is available.",
      ].join("\n\n");
  const body = {
    ...tag,
    ...(recoveryWorkflowId !== undefined ? { recoveryWorkflowId } : {}),
    ending: {
      kind: "failed",
      cause: "step_threw",
      step: at.step,
      ...(at.round !== undefined ? { round: at.round.index } : {}),
      report,
      threadReport: report,
    },
    ...(pr !== undefined ? { pr } : {}),
  };
  try {
    await step.do(`${prefix}/end/threw`, STEP_CONFIG, () => call(bot, "unit-end", body));
  } catch {
    // Best effort: the rethrow still fails the instance, and a bot that could
    // not record the ending leaves the seal's line as before.
  }
}

/** One unit's pipeline: its start, then the machine's steps until it ends;
 *  every round boundary and the ending told to the bot as they happen. */
type DrivenEnding = UnitEnding & { endedAt?: number };

async function runUnit(
  step: StepRunner,
  bot: CoordinatorBot,
  instanceId: string,
  node: PlanUnitNode,
  plan: PlanFacts,
  session?: LeaseSegmentProgress,
): Promise<DrivenEnding> {
  const unit = node.id;
  // A renewal's segment names its steps under the segment (`U10/s2/…`), so
  // the Workflow's durable step cache never answers segment two with segment
  // one's results (decision 0046).
  const row = plan.units.find((u) => u.unit === unit);
  const prefix = row?.recovery !== undefined ? `${unit}/recovery` : stepPrefixOf(unit, session);
  const tag = { parentInstanceId: instanceId, unit };
  // Where the machine is, tracked for the step-threw ending (issue 2100). The
  // start belongs in the same net as the rest of the unit even though no
  // pipeline state (and therefore no round) exists yet.
  let last: StepAt = { step: `${prefix}/start` };
  let start: ReturnType<typeof readUnitStart>;
  try {
    if (row?.recovery !== undefined) start = { at: row.recovery.claimedAt };
    else {
      const startStep = `${prefix}/start`;
      last = { step: startStep };
      start = readUnitStart(
        answerOf("unit-start", await step.do(startStep, STEP_CONFIG, () => call(bot, "unit-start", tag))),
      );
    }
  } catch (err) {
    await tellStepThrew(
      step,
      bot,
      prefix,
      tag,
      undefined,
      last,
      err,
      row?.recovery !== undefined ? `${instanceId}:${unit}` : undefined,
      row?.recovery?.workflowId,
    );
    throw err;
  }
  // A resume at review (agent-ship item 10) rides the unit's row: the pull
  // request of ship's own the requester named opens the pipeline at its first
  // review round, with no pre-check, no branch and no round 0.
  const resume = row?.resume;
  // A previous attempt's `review_pending` head: the machine's pre-check starts
  // at the review round when the open pull request still heads exactly there.
  const lastPush = row?.lastPush;
  const input: UnitPipelineInput = {
    unit: { id: unit, branch: node.branch },
    repo: plan.repo,
    base: plan.base,
    caps: plan.caps,
    // The instance's field decides who merges (record 0031's merge grant),
    // carried here by the plan route: the hand-off wrote `runner` on a
    // seeded plan and `person` on a task, and the door re-checks it — the
    // branch's name never decides.
    merge: plan.merge,
    addressSeverity: plan.addressSeverity,
    addressSeveritySource: plan.addressSeveritySource,
    // Recovery spends only the lease already carried by the claim. It never
    // opens another segment or idles for a renewal in this checkpoint.
    grant: row?.recovery !== undefined ? (row.recovery.accounting?.grant ?? { renewals: 0 }) : plan.grant,
    grantSource: plan.grantSource,
    verbosity: plan.verbosity,
    idleDays: row?.recovery !== undefined ? 0 : plan.idleDays,
    generated: plan.generated,
    ...(plan.runPageBase !== undefined ? { runPageBase: plan.runPageBase } : {}),
    ...(resume !== undefined ? { resume } : {}),
    ...(row?.publication !== undefined && resume === undefined && lastPush === undefined ? { freshAdopt: true } : {}),
    ...(lastPush !== undefined ? { lastPush } : {}),
    ...(session !== undefined ? { session } : {}),
    ...(row?.recovery !== undefined
      ? { recovery: { remainingMs: row.recovery.remainingMs, unitKey: `${instanceId}:${unit}` } }
      : {}),
  };
  let state: UnitPipelineState =
    row?.recovery !== undefined
      ? openRecoveredUnitPipeline(input, start.at, {
          kind: row.recovery.kind,
          round: row.recovery.round,
          pr: row.pr!,
          expectedHeadSha: row.recovery.expectedHeadSha,
          reviewRunId: row.recovery.reviewRunId,
          ...(row.recovery.accounting !== undefined ? { spendUsd: row.recovery.accounting.spendUsd } : {}),
          ...(row.recovery.findingsRunId !== undefined ? { findingsRunId: row.recovery.findingsRunId } : {}),
          ...(row.recovery.findings !== undefined ? { findings: row.recovery.findings } : {}),
        })
      : openUnitPipeline(input, start.at);
  let notes = 0;
  let endedAt: number | undefined;
  try {
    pipeline: for (;;) {
      const action = nextAction(state);
      if (action.type === "end") {
        if (row?.recovery !== undefined && endedAt === undefined) {
          const endStep = `${prefix}/end`;
          const ending = action.ending;
          const body = {
            ...tag,
            recoveryWorkflowId: row.recovery.workflowId,
            ending: {
              kind: ending.kind === "idle" && ending.humanGate !== undefined ? "held" : ending.kind,
              ...(ending.kind === "held" && ending.cause !== undefined ? { holdCause: ending.cause } : {}),
              report: renderUnitReport(state),
              threadReport: renderUnitReport(state, undefined, state.input.verbosity ?? DEFAULT_VERBOSITY),
              ...(ending.kind === "idle" && ending.humanGate !== undefined ? { humanGate: ending.humanGate } : {}),
            },
            ...(state.pr !== undefined ? { pr: state.pr } : {}),
          };
          const reply = await step.do(endStep, STEP_CONFIG, async () => {
            const candidate = await call(bot, "unit-end", body);
            const answer = answerOf("unit-end", candidate);
            if (answer.status !== 200 || answer.body.ok !== true)
              throw new UnreadableAnswer("unit-end", answer, "successful settlement");
            return candidate;
          });
          endedAt = answerOf("unit-end", reply).body.at;
        }
        return { ...action.ending, ...(endedAt !== undefined ? { endedAt } : {}) };
      }
      // Keep the current round across its non-round phases (for example merge)
      // while replacing it whenever the pipeline names a new one.
      last = {
        step: action.step,
        ...("round" in state.phase
          ? { round: state.phase.round }
          : last.round !== undefined
            ? { round: last.round }
            : {}),
      };
      const transition = applyReturn(state, await perform(step, bot, instanceId, unit, action));
      state = transition.state;
      for (const note of transition.notes) {
        if (note.type === "round") {
          const body = {
            ...tag,
            ...(row?.recovery !== undefined ? { recoveryWorkflowId: row.recovery.workflowId } : {}),
            index: note.index,
            agent: note.agent,
            outcome: note.outcome,
            ...(note.gate !== undefined ? { gate: note.gate } : {}),
          };
          const noteStep = `${prefix}/note/${++notes}`;
          last = { step: noteStep, round: { index: note.index, kind: note.agent } };
          await step.do(noteStep, STEP_CONFIG, async () => {
            const reply = await call(bot, "round", body);
            const answer = answerOf("round", reply);
            if (answer.status !== 200 || answer.body.ok !== true)
              throw new UnreadableAnswer("round", answer, "successful round persistence");
            return reply;
          });
        } else {
          // A merge_ready ending names the pull request as it is at the APPROVED
          // head (agent-ship item 9): one more pr-check reads the facts fresh —
          // auto-merge may have been switched on since the round's check, or it
          // may already have fired, in which case the answer is `merged` and the
          // report says so rather than naming a gate that has passed. An
          // unreadable answer just leaves the facts out.
          let endFacts: MergeReadyFacts | undefined;
          if (note.ending.kind === "merge_ready") {
            try {
              const factsStep = `${prefix}/end/pr-facts`;
              last = { step: factsStep, ...(last.round !== undefined ? { round: last.round } : {}) };
              const check = prCheckReturn(
                factsStep,
                answerOf(
                  "pr-check",
                  await step.do(factsStep, STEP_CONFIG, () =>
                    call(bot, "pr-check", {
                      ...tag,
                      checks: true,
                      ...(state.pr !== undefined ? { pr: state.pr.number } : {}),
                    }),
                  ),
                ),
              );
              if (check.type === "pr-check" && (check.pr.state === "merged" || check.pr.state === "closed"))
                state = reconcileTerminalPr(state, check.pr);
              else if (check.type === "pr-check" && check.pr.state === "open")
                endFacts = {
                  ...(check.pr.autoMergeEnabled !== undefined ? { autoMergeEnabled: check.pr.autoMergeEnabled } : {}),
                  // The checks at the approved head (record 0055): the report's
                  // headline is a claim about them, never "merge-ready" over a red one.
                  ...(check.pr.checks !== undefined ? { checks: check.pr.checks } : {}),
                  // The ready state beside them (agent-ship item 9): a conflict
                  // feeds the runner re-entry below, while an unsquashed fix-up
                  // commit remains an approved-but-not-merge-ready report.
                  ...(check.pr.mergeableState !== undefined ? { mergeableState: check.pr.mergeableState } : {}),
                  ...(check.pr.fixupCommits !== undefined ? { fixupCommits: check.pr.fixupCommits } : {}),
                  // The base's merge-queue rule (issue 2011): the merge:person
                  // path names "queued" in its remaining-gate line.
                  ...(check.pr.baseHasMergeQueue !== undefined
                    ? { baseHasMergeQueue: check.pr.baseHasMergeQueue }
                    : {}),
                };
            } catch {
              // the report simply omits the fact
            }
          }
          // A person-merge pipeline used to publish this dirty state as its
          // ending and hand the pull request to the sweep. It remains the
          // owner instead: rung one runs now, and only a conflict buys a coding
          // child under this run's remaining lease.
          if (note.ending.kind === "merge_ready" && endFacts?.mergeableState === "dirty") {
            state = reenterApprovedRebase(state);
            continue pipeline;
          }
          const ending = state.ending ?? note.ending;
          // The last coding child's run is named so the bot can put its handoff
          // — the deviations it recorded — on the unit's board issue beside the
          // ending (agent-ship item 14).
          const body = {
            ...tag,
            ...(row?.recovery !== undefined ? { recoveryWorkflowId: row.recovery.workflowId } : {}),
            // Two copies (routing-and-config item 28): the full report for the
            // row and the board, and the thread's at the request's verbosity.
            ending: {
              kind:
                row?.recovery !== undefined && ending.kind === "idle" && ending.humanGate !== undefined
                  ? "held"
                  : ending.kind,
              ...(ending.kind === "held" && ending.cause !== undefined ? { holdCause: ending.cause } : {}),
              report: renderUnitReport(state, endFacts),
              threadReport: renderUnitReport(state, endFacts, state.input.verbosity ?? DEFAULT_VERBOSITY),
              // An idle ending carries its continuation facts (record 0051): the
              // bot writes them on the row's `idle` in place of an ending, with
              // the coding run id it already receives below.
              ...(ending.kind === "idle"
                ? {
                    why: ending.why,
                    renewalsLeft: ending.renewalsLeft,
                    ...(ending.from !== undefined ? { from: ending.from } : {}),
                    spendUsd: ending.spendUsd,
                    ...(ending.handoff !== undefined ? { handoff: ending.handoff } : {}),
                    ...(ending.humanGate !== undefined ? { humanGate: ending.humanGate } : {}),
                  }
                : {}),
              ...(row?.recovery !== undefined && ending.kind === "idle" && ending.humanGate !== undefined
                ? { humanGate: ending.humanGate }
                : {}),
            },
            ...(state.pr !== undefined ? { pr: state.pr } : {}),
            // A merge_ready ending retains the exact head its final approval
            // reviewed. Review-pending endings retain the coding child's push;
            // both become the row's durable lastPush for a later attempt.
            ...(ending.kind === "merge_ready" && state.lastReviewHead !== undefined
              ? { headSha: state.lastReviewHead }
              : ending.kind === "review_pending" && ending.headSha !== undefined
                ? { headSha: ending.headSha }
                : ending.kind === "idle" && ending.why === "review_pending" && ending.from !== undefined
                  ? { headSha: ending.from }
                  : {}),
            ...(state.lastCodingRunId !== undefined ? { codingRunId: state.lastCodingRunId } : {}),
            // A continued ending is a segment's end, not the unit's: the bot
            // writes the renewal as a row keyed by the next segment's index
            // (decision 0046), so a runner reclaimed here never renews twice.
            ...(ending.kind === "continued"
              ? {
                  segment: {
                    index: ending.segment,
                    ...(ending.from !== undefined ? { from: ending.from } : {}),
                    runId: ending.runId,
                  },
                }
              : {}),
          };
          const endStep = `${prefix}/end`;
          last = { step: endStep, ...(last.round !== undefined ? { round: last.round } : {}) };
          const endAnswer = answerOf(
            "unit-end",
            await step.do(endStep, STEP_CONFIG, async () => {
              const reply = await call(bot, "unit-end", body);
              const answer = answerOf("unit-end", reply);
              if (answer.status !== 200 || answer.body.ok !== true)
                throw new UnreadableAnswer("unit-end", answer, "successful settlement");
              return reply;
            }),
          );
          endedAt = endAnswer.body.at;
        }
      }
    }
  } catch (err) {
    // The walk-dies-before-unit-end path (issue 2100): the throw becomes the
    // unit's ending before it fails the instance, never the bare seal.
    await tellStepThrew(
      step,
      bot,
      prefix,
      tag,
      state.pr,
      last,
      err,
      row?.recovery !== undefined ? `${instanceId}:${unit}` : undefined,
      row?.recovery?.workflowId,
    );
    throw err;
  }
}

/** The report of a unit the hard stop ended before it ran (record 0060; issue 1924). */
function stoppedReport(unit: string): string {
  return `⏹ Stopped: the pipeline's hosted parent was hard-stopped, so ${unit} was ended without running. The original plan remains the durable task for any later pipeline.`;
}

function blockedReport(unit: string, dep: string, depEnding: string): string {
  if (depEnding === "blocked")
    return `⛔ Blocked: ${unit} waits on ${dep}, which is blocked itself. A later pipeline recognizes both units once the dependency is resolved.`;
  const person = depEnding === "merge_ready";
  return `⛔ Blocked: ${unit} waits on ${dep}, which ended ${depEnding}${person ? " — a person's merge" : ""}. A later pipeline recognizes the dependency once it is ${person ? "merged" : "resolved"}.`;
}

/** End a unit that never entered `runUnit` under the same failure net. */
async function endUnrunUnit(
  step: StepRunner,
  bot: CoordinatorBot,
  instanceId: string,
  unit: string,
  ending: { kind: "stopped" | "blocked"; report: string },
): Promise<void> {
  const tag = { parentInstanceId: instanceId, unit };
  const endStep = `${unit}/end`;
  try {
    await step.do(endStep, STEP_CONFIG, () => call(bot, "unit-end", { ...tag, ending }));
  } catch (err) {
    await tellStepThrew(step, bot, unit, tag, undefined, { step: endStep }, err);
    throw err;
  }
}

/** The graph as one plan answer carries it: the instance's unit rows, in the plan's order. */
function graphOf(plan: PlanFacts, instanceId: string): PlanGraph {
  return {
    planId: plan.planId ?? instanceId,
    units: plan.units.map((u) => ({
      id: u.unit,
      title: u.title ?? u.unit,
      slug: u.slug,
      branch: u.branch,
      dependsOn: u.dependsOn,
    })),
  };
}

/** The cursor over a freshly read selection (the orchestration-plane plan's
 *  re-read requirement): a surviving unit keeps its standing, a row appended
 *  mid-walk joins pending — walked after the current unit — and a row gone from the selection
 *  was merged by hand: it is walked as merged with nothing run and nothing
 *  told (`gone`), a dependency on it counted satisfied like any dependency
 *  outside the selection. `blocked` is derived state, so it is recomputed over
 *  the fresh graph rather than carried — a blocked unit whose failing
 *  dependency left the selection is in play again. */
function rereadCursor(cursor: PlanCursor, fresh: PlanGraph): { cursor: PlanCursor; gone: string[] } {
  const gone = cursor.order.filter((id) => !fresh.units.some((u) => u.id === id));
  const order = fresh.units.map((u) => u.id);
  const status: Record<string, UnitStatus> = {};
  for (const id of order) {
    const prior = cursor.status[id];
    status[id] = prior === undefined || prior === "blocked" ? "pending" : prior;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const u of fresh.units) {
      if (status[u.id] !== "pending") continue;
      if (u.dependsOn.some((d) => d in status && (status[d] === "failed" || status[d] === "blocked"))) {
        status[u.id] = "blocked";
        changed = true;
      }
    }
  }
  return { cursor: { order, status }, gone };
}

type IdleResult =
  | { kind: "segment"; session: LeaseSegmentProgress }
  | { kind: "ending"; ending: Extract<UnitEnding, { kind: "idle_expired" }> | { kind: "stopped" } };

/** Park one unit behind its indexed wait. A timeout closes the idle; a wake
 * answer is durable at the bot, so this loop may safely move to the next index
 * after a transport failure without deciding the same event twice. */
async function waitOnIdle(
  step: StepRunner,
  bot: CoordinatorBot,
  instanceId: string,
  unit: string,
  prefix: string,
  idle: Extract<DrivenEnding, { kind: "idle" }>,
  idleDays: number,
  currentSession: LeaseSegmentProgress | undefined,
): Promise<IdleResult> {
  const deadline = (idle.endedAt ?? 0) + idleDays * DAY_MS;
  let now = idle.endedAt ?? 0;
  for (let index = 1; ; index += 1) {
    const waitId = `${prefix}/idle/${index}`;
    const timeout = Math.max(1, deadline - now);
    try {
      await step.waitForEvent(waitId, { type: unitNudgeEventType({ instanceId, unit }), timeout });
    } catch {
      const ending = { kind: "idle_expired" as const, reviewRounds: idle.reviewRounds };
      const endStep = `${waitId}/end`;
      await step.do(endStep, STEP_CONFIG, () =>
        call(bot, "unit-end", {
          parentInstanceId: instanceId,
          unit,
          ending: {
            kind: ending.kind,
            report: "⌛ Idle expired: no reply continued this unit before its idle window closed.",
          },
        }),
      );
      return { kind: "ending", ending };
    }
    let wake: { answer: UnitWakeAnswer; at: number };
    try {
      wake = readWakeAnswer(
        answerOf(
          "unit-wake",
          await step.do(`${waitId}/wake`, STEP_CONFIG, () =>
            call(bot, "unit-wake", { parentInstanceId: instanceId, unit, waitId }),
          ),
        ),
      );
    } catch {
      // The event remains unconsumed when the wake could not store an answer.
      // A stored answer is replayed by the next identity, so either way the
      // next indexed wait is the safe place to listen again.
      continue;
    }
    now = wake.at;
    const answer = wake.answer;
    if (answer.kind === "answered") continue;
    if (answer.kind === "expired") {
      const ending = { kind: "idle_expired" as const, reviewRounds: idle.reviewRounds };
      await step.do(`${waitId}/end`, STEP_CONFIG, () =>
        call(bot, "unit-end", {
          parentInstanceId: instanceId,
          unit,
          ending: {
            kind: ending.kind,
            report: "⌛ Idle expired: the unit reached its indexed wake limit.",
          },
        }),
      );
      return { kind: "ending", ending };
    }
    if (answer.kind === "stopped") {
      await step.do(`${waitId}/end`, STEP_CONFIG, () =>
        call(bot, "unit-end", {
          parentInstanceId: instanceId,
          unit,
          ending: { kind: "stopped", report: "⏹ Stopped: the idle unit was ended by an operator." },
        }),
      );
      return { kind: "ending", ending: { kind: "stopped" } };
    }
    return {
      kind: "segment",
      session: {
        segment: answer.index,
        renewalsSpent: answer.leaseMs !== undefined ? (currentSession?.renewalsSpent ?? 0) : answer.index - 1,
        spendUsd: answer.spendUsd,
        ...(answer.from !== undefined ? { continueFrom: answer.from } : {}),
        ...(answer.runId !== undefined ? { previousRunId: answer.runId } : {}),
        ...(answer.handoff !== undefined ? { previousHandoff: answer.handoff } : {}),
        ...(answer.texts.length > 0 ? { texts: answer.texts } : {}),
        ...(answer.humanGate !== undefined ? { humanGate: answer.humanGate } : {}),
        ...(answer.leaseMs !== undefined
          ? { resume: { leaseMs: answer.leaseMs, attempt: (currentSession?.resume?.attempt ?? 0) + 1 } }
          : {}),
      },
    };
  }
}

/** The plan: its units one at a time in dependency order, then the endings of the units it never reached. */
async function walk(step: StepRunner, bot: CoordinatorBot, instanceId: string): Promise<PlanRunSummary> {
  // The selection is read at every unit boundary (the orchestration-plane plan): the first read opens
  // the cursor, and each boundary's — its own durable step, `plan/<n>`, so a
  // replay meets the same read — rebuilds it, so a later bot can append a unit
  // to a live instance or drop one merged by hand without killing it.
  let reads = 0;
  const readSelection = async (): Promise<PlanFacts> => {
    reads += 1;
    const name = reads === 1 ? "plan" : `plan/${reads}`;
    return readPlan(
      answerOf("plan", await step.do(name, STEP_CONFIG, () => call(bot, "plan", { parentInstanceId: instanceId }))),
    );
  };
  let plan = await readSelection();
  let graph = graphOf(plan, instanceId);
  let cursor = openPlanCursor(graph);
  const endings: Record<string, string> = {};
  for (;;) {
    // The hard stop's mark (record 0060; issue 1924), read before every unit
    // start: the walk ends every unit not yet ended `stopped` — the rows say
    // why they never ran — and starts nothing more. A stop that lands once
    // every unit has ended changes nothing: there is nothing left to end.
    if (plan.stopped) {
      for (const id of cursor.order.filter((u) => endings[u] === undefined)) {
        endings[id] = "stopped";
        await endUnrunUnit(step, bot, instanceId, id, { kind: "stopped", report: stoppedReport(id) });
      }
      break;
    }
    const [next] = readyUnits(graph, cursor);
    if (next === undefined) break;
    cursor = startUnit(graph, cursor, next);
    const node = graph.units.find((u) => u.id === next)!;
    let session: LeaseSegmentProgress | undefined;
    let ending: DrivenEnding | { kind: "stopped" } = await runUnit(step, bot, instanceId, node, plan);
    // A machine-renewed continuation opens at once. An idle continuation parks
    // the whole walk and opens only when the durable wake answer names the
    // segment (or settles as stopped/expired).
    for (;;) {
      if (ending.kind === "continued") {
        const c = ending;
        session = {
          segment: c.segment,
          renewalsSpent: c.segment - 1,
          spendUsd: c.spendUsd,
          ...(c.from !== undefined ? { continueFrom: c.from } : {}),
          previousRunId: c.runId,
          ...(c.handoff !== undefined ? { previousHandoff: c.handoff } : {}),
        };
        ending = await runUnit(step, bot, instanceId, node, plan, session);
        continue;
      }
      if (ending.kind === "idle") {
        const parked = await waitOnIdle(
          step,
          bot,
          instanceId,
          next,
          stepPrefixOf(next, session),
          ending,
          ending.parkDays ?? plan.idleDays,
          session,
        );
        if (parked.kind === "ending") {
          ending = parked.ending;
          break;
        }
        session = parked.session;
        ending = await runUnit(step, bot, instanceId, node, plan, session);
        continue;
      }
      break;
    }
    endings[next] = ending.kind;
    // A unit is done for its dependents when the base carries its scope: the
    // runner's merge, or a scope that had already landed before the attempt.
    // An `idle` ending settles the unit `failed` for now: nothing waits yet —
    // the indexed wait and the wake land with the fifth unit of record 0051's
    // plan — so the walk is unchanged until then and the flag ships at zero.
    cursor = settleUnit(graph, cursor, next, isSettledDone(ending.kind) ? "done" : "failed");
    // The unit boundary's re-read (the orchestration-plane plan): the fresh rows are the selection now.
    plan = await readSelection();
    graph = graphOf(plan, instanceId);
    const reread = rereadCursor(cursor, graph);
    cursor = reread.cursor;
    for (const id of reread.gone) endings[id] ??= "merged";
  }
  // Blocked units, in the plan's order: each told its own ending, so the rows
  // and the summary say why it never ran. Every blocked unit's ending is known
  // before any report is rendered — a plan may list a dependent before the
  // dependency that blocks it. A stopped walk skips this: every unended unit
  // was already ended `stopped` above, and its cursor never finishes.
  const blocked = plan.stopped ? [] : cursor.order.filter((id) => cursor.status[id] === "blocked");
  for (const id of blocked) endings[id] = "blocked";
  for (const id of blocked) {
    const node = graph.units.find((u) => u.id === id)!;
    const dep = node.dependsOn.find((d) => cursor.status[d] === "failed" || cursor.status[d] === "blocked")!;
    await endUnrunUnit(step, bot, instanceId, id, {
      kind: "blocked",
      report: blockedReport(id, dep, endings[dep]!),
    });
  }
  if (!plan.stopped && !cursorFinished(cursor))
    throw new Error(`the plan's cursor did not finish: ${JSON.stringify(cursor.status)}`);
  return {
    instance: instanceId,
    ...(plan.planId !== undefined ? { planId: plan.planId } : {}),
    units: endings,
    outcome: cursor.order.every((id) => isSettledOutcome(endings[id] ?? "")) ? "completed" : "failed",
  };
}

/** The endings whose unit's scope is on the base, so its dependents run on a
 *  base that carries it (agent-ship item 12): the runner's merge, a merge found
 *  already made, or a scope that had landed before the attempt. */
function isSettledDone(kind: string): boolean {
  return kind === "merged" || kind === "already_landed";
}

/** The endings a plan closes ✅ over: every `isSettledDone` one, plus
 *  merge-ready — the work stands and a person's merge is the only gate left. */
function isSettledOutcome(kind: string): boolean {
  return isSettledDone(kind) || kind === "merge_ready";
}

/** The Workflow's body. The finish is asked on every path — as `failed`, best
 *  effort, when the walk threw — and the cause is rethrown, so the instance's
 *  own status says what happened and the parent's record exists either way. */
export async function runPlan(step: StepRunner, bot: CoordinatorBot, instanceId: string): Promise<PlanRunSummary> {
  const finish = (outcome: PlanRunSummary["outcome"]) =>
    step.do("finish", STEP_CONFIG, () => call(bot, "finish", { parentInstanceId: instanceId, outcome }));
  let summary: PlanRunSummary;
  try {
    summary = await walk(step, bot, instanceId);
  } catch (err) {
    await finish("failed").catch(() => {});
    throw err;
  }
  await finish(summary.outcome);
  return summary;
}

/** A separate Workflow execution checkpoint that drives exactly one claimed
 * original unit. Its platform instance id is transport only: every bot call,
 * child tag and idempotency key continues to name `parentInstanceId + unit`. */
export async function runOriginalUnitRecovery(
  step: StepRunner,
  bot: CoordinatorBot,
  workflowId: string,
  params: OriginalUnitRecoveryParams,
): Promise<PlanRunSummary> {
  const claim = answerOf(
    "recover-unit",
    await step.do("recovery-claim", STEP_CONFIG, async () => {
      const reply = await call(bot, "recover-unit", {
        parentInstanceId: params.parentInstanceId,
        unit: params.unit,
        workflowId,
      });
      const answer = answerOf("recover-unit", reply);
      if (answer.status !== 200 || answer.body.ok !== true)
        throw new UnreadableAnswer("recover-unit", answer, "successful recovery claim");
      return reply;
    }),
  );
  if (claim.body.ok !== true) throw new UnreadableAnswer("recover-unit", claim, "not ok");
  const plan = readPlan(
    answerOf(
      "plan",
      await step.do("recovery-plan", STEP_CONFIG, () =>
        call(bot, "plan", { parentInstanceId: params.parentInstanceId }),
      ),
    ),
  );
  const row = plan.units.filter((candidate) => candidate.unit === params.unit);
  if (row.length !== 1 || row[0]!.recovery?.workflowId !== workflowId)
    throw new Error("the original unit's durable recovery claim no longer names this Workflow");
  const unit = row[0]!;
  const ending = await runUnit(
    step,
    bot,
    params.parentInstanceId,
    { id: unit.unit, title: unit.title ?? unit.unit, slug: unit.slug, branch: unit.branch, dependsOn: unit.dependsOn },
    plan,
  );
  return {
    instance: params.parentInstanceId,
    ...(plan.planId !== undefined ? { planId: plan.planId } : {}),
    units: { [params.unit]: ending.kind },
    outcome: isSettledOutcome(ending.kind) ? "completed" : "failed",
  };
}
