// The plan runner's driver (docs/reference/specs/http-ingress.md item 9;
// docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md): the
// `ShipCoordinator` Workflow's `run()` body, written over a structural step
// runner and a bot client so plain Node proves what the platform replays. The
// driver owns three things and nothing else — which step is taken next and
// under which name (the machine's own, so a replay meets the same step), how a
// bot answer becomes the machine's return, and what is left to the platform's
// retry: a call that throws inside a step is the platform's to ask again under
// the one policy (twelve times, two minutes apart, constant — long enough for a
// bot deploy and its rollover), and the driver never catches it.
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

import { DEFAULT_GRANT, GRANT_RENEWALS_MAX, IDLE_DAYS_MAX, type Grant, type GrantSource } from "../budgets.js";
import { DEFAULT_VERBOSITY, isVerbosity, type Verbosity } from "../verbosity.js";
import {
  applyReturn,
  cursorFinished,
  nextAction,
  openPlanCursor,
  openUnitPipeline,
  readyUnits,
  type PlanCursor,
  type UnitStatus,
  renderUnitReport,
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
  type UnitPipelineState,
  stepPrefixOf,
  type UnitSession,
} from "../ship/coordinator.js";
import {
  checksSettledEventType,
  childInterruptedEventType,
  childResumedEventType,
  isCoordinatorUnit,
  runFinishedEventType,
  type CoordinatorUnit,
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
  if (!run.finished) return { type: "read-record", step, run: { finished: false }, at: a.body.at };
  if (typeof run.status !== "string") throw new UnreadableAnswer("read-record", a, "status");
  // The typed artifacts as the bot's record carries them — shape-checked where
  // they were written (the run record's validator), read here as they are.
  const facts = run as unknown as Omit<Extract<ChildFacts, { finished: true }>, "finished" | "status">;
  const {
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
  } = facts;
  return {
    type: "read-record",
    step,
    run: {
      finished: true,
      status: run.status as Extract<ChildFacts, { finished: true }>["status"],
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

function prCheckReturn(step: string, a: BotAnswer): StepReturn {
  const { ok, state, prNumber, url, headSha, sha, mergedAt, at } = a.body;
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
      },
      at,
    };
  // A merged pull request is read whole or not at all: the merge commit and
  // the time are what the unit's ending and its report carry.
  if (
    ok === true &&
    state === "merged" &&
    typeof prNumber === "number" &&
    typeof url === "string" &&
    typeof sha === "string" &&
    typeof mergedAt === "string"
  )
    return { type: "pr-check", step, pr: { state: "merged", prNumber, url, sha, mergedAt }, at };
  throw new UnreadableAnswer("pr-check", a, "state");
}

/** The round's checks read as the bot answered it (record 0055): the runs at
 *  the reviewed head, or none when GitHub could not be read — the machine
 *  treats an absent read as pending and asks again at the chunk's end. A retry
 *  ask's answer carries `retried` instead: whether the re-run was dispatched,
 *  so the machine never waits on a head an undispatched re-run left unchanged. */
function checksReturn(step: string, a: BotAnswer): StepReturn {
  const { ok, checks, retried, at } = a.body;
  if (ok !== true) throw new UnreadableAnswer("checks", a, "ok");
  return {
    type: "checks",
    step,
    ...(isRoundChecks(checks) ? { checks } : {}),
    ...(typeof retried === "boolean" ? { retried } : {}),
    at,
  };
}

const isRoundChecks = (v: unknown): v is RoundChecks =>
  isRecord(v) &&
  typeof v.total === "number" &&
  Array.isArray(v.pending) &&
  v.pending.every((n: unknown) => typeof n === "string") &&
  Array.isArray(v.failed) &&
  v.failed.every((f: unknown) => isRecord(f) && typeof f.name === "string" && typeof f.conclusion === "string");

function mergeReturn(step: string, a: BotAnswer): StepReturn {
  const { ok, outcome, by, sha, mergedAt, reason, at } = a.body;
  // The door found the pull request already merged after the approval: the
  // merge commit and the time ride the answer, and the unit ends `by: other`.
  if (ok === true && outcome === "merged" && by === "other" && typeof sha === "string" && typeof mergedAt === "string")
    return { type: "merge", step, outcome: "merged", by: "other", sha, mergedAt, at };
  if (ok === true && outcome === "merged" && typeof sha === "string")
    return { type: "merge", step, outcome: "merged", sha, at };
  if (ok === true && (outcome === "pending" || outcome === "refused") && typeof reason === "string")
    return { type: "merge", step, outcome, reason, at };
  throw new UnreadableAnswer("merge", a, "outcome");
}

// ---- the steps ----------------------------------------------------------------------------------------

/** One bot call inside a step: a reply that is not the bot's answer and a
 *  passing refusal are throws, so the platform asks again; the reply is stored. */
async function call(
  bot: CoordinatorBot,
  route: CoordinatorStepRoute,
  body: Record<string, unknown>,
): Promise<BotReply> {
  const reply = await bot.step(route, body);
  const read = readBotAnswer(reply.status, reply.text);
  if (!read.ok) throw new Error(`the bot did not answer ${route}: ${read.reason}`);
  const transient = transientRefusal(read.answer);
  if (transient !== undefined) throw new Error(transient);
  return reply;
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
        answerOf(
          "read-record",
          await step.do(action.step, STEP_CONFIG, () => call(bot, "read-record", { ...tag, runId: action.runId })),
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
      // the reviewed head with the merge door's own reading — or, on a retry
      // ask, re-runs the named failed checks' jobs first.
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
            call(bot, "merge", { ...tag, prNumber: action.prNumber, headSha: action.headSha }),
          ),
        ),
      );
  }
}

/** One unit's pipeline: its start, then the machine's steps until it ends;
 *  every round boundary and the ending told to the bot as they happen. */
async function runUnit(
  step: StepRunner,
  bot: CoordinatorBot,
  instanceId: string,
  node: PlanUnitNode,
  plan: PlanFacts,
  session?: UnitSession,
): Promise<UnitEnding> {
  const unit = node.id;
  // A renewal's segment names its steps under the segment (`U10/s2/…`), so
  // the Workflow's durable step cache never answers segment two with segment
  // one's results (decision 0046).
  const prefix = stepPrefixOf(unit, session);
  const tag = { parentInstanceId: instanceId, unit };
  const start = readUnitStart(
    answerOf("unit-start", await step.do(`${prefix}/start`, STEP_CONFIG, () => call(bot, "unit-start", tag))),
  );
  // A resume at review (agent-ship item 10) rides the unit's row: the pull
  // request of ship's own the requester named opens the pipeline at its first
  // review round, with no pre-check, no branch and no round 0.
  const row = plan.units.find((u) => u.unit === unit);
  const resume = row?.resume;
  // A previous attempt's `review_pending` head: the machine's pre-check starts
  // at the review round when the open pull request still heads exactly there.
  const lastPush = row?.lastPush;
  let state: UnitPipelineState = openUnitPipeline(
    {
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
      grant: plan.grant,
      grantSource: plan.grantSource,
      verbosity: plan.verbosity,
      idleDays: plan.idleDays,
      generated: plan.generated,
      ...(plan.runPageBase !== undefined ? { runPageBase: plan.runPageBase } : {}),
      ...(resume !== undefined ? { resume } : {}),
      ...(lastPush !== undefined ? { lastPush } : {}),
      ...(session !== undefined ? { session } : {}),
    },
    start.at,
  );
  let notes = 0;
  for (;;) {
    const action = nextAction(state);
    if (action.type === "end") return action.ending;
    const transition = applyReturn(state, await perform(step, bot, instanceId, unit, action));
    state = transition.state;
    for (const note of transition.notes) {
      if (note.type === "round") {
        const body = {
          ...tag,
          index: note.index,
          agent: note.agent,
          outcome: note.outcome,
          ...(note.gate !== undefined ? { gate: note.gate } : {}),
        };
        await step.do(`${prefix}/note/${++notes}`, STEP_CONFIG, () => call(bot, "round", body));
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
            const check = prCheckReturn(
              `${prefix}/end/pr-facts`,
              answerOf(
                "pr-check",
                await step.do(`${prefix}/end/pr-facts`, STEP_CONFIG, () =>
                  call(bot, "pr-check", { ...tag, checks: true }),
                ),
              ),
            );
            if (check.type === "pr-check" && check.pr.state === "merged")
              endFacts = { merged: { sha: check.pr.sha, mergedAt: check.pr.mergedAt } };
            else if (check.type === "pr-check" && check.pr.state === "open")
              endFacts = {
                ...(check.pr.autoMergeEnabled !== undefined ? { autoMergeEnabled: check.pr.autoMergeEnabled } : {}),
                // The checks at the approved head (record 0055): the report's
                // headline is a claim about them, never "merge-ready" over a red one.
                ...(check.pr.checks !== undefined ? { checks: check.pr.checks } : {}),
                // The ready state beside them (agent-ship item 9): a conflicting
                // head, or one carrying an unsquashed fix-up commit, is reported
                // approved-but-not-merge-ready, never "merge-ready".
                ...(check.pr.mergeableState !== undefined ? { mergeableState: check.pr.mergeableState } : {}),
                ...(check.pr.fixupCommits !== undefined ? { fixupCommits: check.pr.fixupCommits } : {}),
              };
          } catch {
            // the report simply omits the fact
          }
        }
        // The last coding child's run is named so the bot can put its handoff
        // — the deviations it recorded — on the unit's board issue beside the
        // ending (agent-ship item 14).
        const body = {
          ...tag,
          // Two copies (routing-and-config item 28): the full report for the
          // row and the board, and the thread's at the request's verbosity.
          ending: {
            kind: note.ending.kind,
            report: renderUnitReport(state, endFacts),
            threadReport: renderUnitReport(state, endFacts, state.input.verbosity ?? DEFAULT_VERBOSITY),
            // An idle ending carries its continuation facts (record 0051): the
            // bot writes them on the row's `idle` in place of an ending, with
            // the coding run id it already receives below.
            ...(note.ending.kind === "idle"
              ? {
                  why: note.ending.why,
                  renewalsLeft: note.ending.renewalsLeft,
                  ...(note.ending.from !== undefined ? { from: note.ending.from } : {}),
                  spendUsd: note.ending.spendUsd,
                  ...(note.ending.handoff !== undefined ? { handoff: note.ending.handoff } : {}),
                }
              : {}),
          },
          ...(state.pr !== undefined ? { pr: state.pr } : {}),
          // A review_pending ending names the child's own last push so the next
          // attempt's pre-check can start at the review round (the row's lastPush)
          // — an idled one the same, off the idle's `from` (record 0051).
          ...(note.ending.kind === "review_pending" && note.ending.headSha !== undefined
            ? { headSha: note.ending.headSha }
            : note.ending.kind === "idle" && note.ending.why === "review_pending" && note.ending.from !== undefined
              ? { headSha: note.ending.from }
              : {}),
          ...(state.lastCodingRunId !== undefined ? { codingRunId: state.lastCodingRunId } : {}),
          // A continued ending is a segment's end, not the unit's: the bot
          // writes the renewal as a row keyed by the next segment's index
          // (decision 0046), so a runner reclaimed here never renews twice.
          ...(note.ending.kind === "continued"
            ? {
                segment: {
                  index: note.ending.segment,
                  ...(note.ending.from !== undefined ? { from: note.ending.from } : {}),
                  runId: note.ending.runId,
                },
              }
            : {}),
        };
        await step.do(`${prefix}/end`, STEP_CONFIG, () => call(bot, "unit-end", body));
      }
    }
  }
}

function blockedReport(unit: string, dep: string, depEnding: string): string {
  if (depEnding === "blocked")
    return `⛔ Blocked: ${unit} waits on ${dep}, which is blocked itself. Re-issue the plan naming the remaining units once it is resolved.`;
  const person = depEnding === "merge_ready";
  return `⛔ Blocked: ${unit} waits on ${dep}, which ended ${depEnding}${person ? " — a person's merge" : ""}. Re-issue the plan naming the remaining units once it is ${person ? "merged" : "resolved"}.`;
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
    const [next] = readyUnits(graph, cursor);
    if (next === undefined) break;
    cursor = startUnit(graph, cursor, next);
    const node = graph.units.find((u) => u.id === next)!;
    let ending = await runUnit(step, bot, instanceId, node, plan);
    // The lease continues while the grant renews (decision 0046): each
    // `continued` ending opens the next segment of the same unit — a fresh
    // pipeline under a fresh lease, from the recorded sha, briefed with the
    // previous segment's write-up — until the unit ends some other way.
    while (ending.kind === "continued") {
      const c = ending;
      ending = await runUnit(step, bot, instanceId, node, plan, {
        segment: c.segment,
        renewalsSpent: c.segment - 1,
        spendUsd: c.spendUsd,
        ...(c.from !== undefined ? { continueFrom: c.from } : {}),
        previousRunId: c.runId,
        ...(c.handoff !== undefined ? { previousHandoff: c.handoff } : {}),
      });
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
  // dependency that blocks it.
  const blocked = cursor.order.filter((id) => cursor.status[id] === "blocked");
  for (const id of blocked) endings[id] = "blocked";
  for (const id of blocked) {
    const node = graph.units.find((u) => u.id === id)!;
    const dep = node.dependsOn.find((d) => cursor.status[d] === "failed" || cursor.status[d] === "blocked")!;
    const body = {
      parentInstanceId: instanceId,
      unit: id,
      ending: { kind: "blocked", report: blockedReport(id, dep, endings[dep]!) },
    };
    await step.do(`${id}/end`, STEP_CONFIG, () => call(bot, "unit-end", body));
  }
  if (!cursorFinished(cursor)) throw new Error(`the plan's cursor did not finish: ${JSON.stringify(cursor.status)}`);
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
