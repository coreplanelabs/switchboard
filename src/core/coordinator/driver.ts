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

import { DEFAULT_GRANT, GRANT_RENEWALS_MAX, type Grant, type GrantSource } from "../budgets.js";
import {
  applyReturn,
  cursorFinished,
  nextAction,
  openPlanCursor,
  openUnitPipeline,
  readyUnits,
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
  type ShipCaps,
  type StepReturn,
  type UnitEnding,
  type UnitPipelineState,
  stepPrefixOf,
  type UnitSession,
} from "../ship/coordinator.js";
import { checksSettledEventType, isCoordinatorUnit, runFinishedEventType, type CoordinatorUnit } from "./contract.js";

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
  "plan" | "unit-start" | "branch" | "spawn" | "read-record" | "pr-check" | "round" | "unit-end" | "merge" | "finish";

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
 *  again, under the policy. Everything else, refusals included, is the machine's. */
const TRANSIENT = new Set(["github_unavailable", "no_channel", "thread_failed", "unit_not_started"]);
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
  /** The instance's mark as the plan route answers it: a generated one-unit plan (a `plan` with no `path`). */
  generated: boolean;
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
    generated: b.generated === true,
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
  const identity = typeof run.id === "string" ? { runId: run.id } : {};
  if (!run.finished) return { type: "read-record", step, run: { finished: false, ...identity }, at: a.body.at };
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
  } = facts;
  return {
    type: "read-record",
    step,
    run: {
      finished: true,
      ...identity,
      status: run.status as Extract<ChildFacts, { finished: true }>["status"],
      ...(run.awaitingInput === true ? { awaitingInput: true as const } : {}),
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
    },
    at: a.body.at,
  };
}

function prCheckReturn(step: string, a: BotAnswer): StepReturn {
  const { ok, state, prNumber, url, headSha, sha, mergedAt, at } = a.body;
  if (ok === true && state === "none") {
    const { unrecovered } = a.body;
    return {
      type: "pr-check",
      step,
      pr: {
        state: "none",
        ...(unrecovered === "no_commits" || unrecovered === "no_base" ? { unrecovered } : {}),
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
        ...(typeof a.body.autoMergeEnabled === "boolean" ? { autoMergeEnabled: a.body.autoMergeEnabled } : {}),
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

/** A wait's outcome: the event, or anything else — the machine confirms either by `read-record`. */
async function waitForRun(
  step: StepRunner,
  action: Extract<CoordinatorAction, { type: "wait" }>,
): Promise<"event" | "timeout"> {
  try {
    await step.waitForEvent(action.step, { type: runFinishedEventType(action.runId), timeout: action.timeoutMs });
    return "event";
  } catch {
    return "timeout";
  }
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
      return prCheckReturn(
        action.step,
        answerOf(
          "pr-check",
          await step.do(action.step, STEP_CONFIG, () =>
            call(bot, "pr-check", { ...tag, ...(action.recover !== undefined ? { recover: action.recover } : {}) }),
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
      generated: plan.generated,
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
                await step.do(`${prefix}/end/pr-facts`, STEP_CONFIG, () => call(bot, "pr-check", tag)),
              ),
            );
            if (check.type === "pr-check" && check.pr.state === "merged")
              endFacts = { merged: { sha: check.pr.sha, mergedAt: check.pr.mergedAt } };
            else if (check.type === "pr-check" && check.pr.state === "open" && check.pr.autoMergeEnabled !== undefined)
              endFacts = { autoMergeEnabled: check.pr.autoMergeEnabled };
          } catch {
            // the report simply omits the fact
          }
        }
        // The last coding child's run is named so the bot can put its handoff
        // — the deviations it recorded — on the unit's board issue beside the
        // ending (agent-ship item 14).
        const body = {
          ...tag,
          ending: { kind: note.ending.kind, report: renderUnitReport(state, endFacts) },
          ...(state.pr !== undefined ? { pr: state.pr } : {}),
          // A review_pending ending names the child's own last push so the next
          // attempt's pre-check can start at the review round (the row's lastPush).
          ...(note.ending.kind === "review_pending" && note.ending.headSha !== undefined
            ? { headSha: note.ending.headSha }
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

/** The plan: its units one at a time in dependency order, then the endings of the units it never reached. */
async function walk(step: StepRunner, bot: CoordinatorBot, instanceId: string): Promise<PlanRunSummary> {
  const plan = readPlan(
    answerOf("plan", await step.do("plan", STEP_CONFIG, () => call(bot, "plan", { parentInstanceId: instanceId }))),
  );
  const graph: PlanGraph = {
    planId: plan.planId ?? instanceId,
    units: plan.units.map((u) => ({
      id: u.unit,
      title: u.title ?? u.unit,
      slug: u.slug,
      branch: u.branch,
      dependsOn: u.dependsOn,
    })),
  };
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
    cursor = settleUnit(graph, cursor, next, ending.kind === "merged" ? "done" : "failed");
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
  const settled = (kind: string) => kind === "merged" || kind === "merge_ready";
  return {
    instance: instanceId,
    ...(plan.planId !== undefined ? { planId: plan.planId } : {}),
    units: endings,
    outcome: cursor.order.every((id) => settled(endings[id] ?? "")) ? "completed" : "failed",
  };
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
