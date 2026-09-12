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
// times over. Every wait is a `waitForEvent` typed `run finished:<runId>` for
// the child's clipped budget plus the margin, and every wait — event or
// timeout alike — is confirmed by a `read-record` before the machine acts on it.
//
// Units run one at a time in the plan's order, each once its in-play
// dependencies are done. `done` is merged, and under the merge policy of every
// branch today (`person`) nothing is: a dependent of a merge-ready unit is
// blocked, told so as its own ending, and the plan finishes `failed` so the
// summary says which units are left for the plan's re-issue. Node-free: the
// shim Worker imports this by relative path.

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
  type CoordinatorAction,
  type PlanGraph,
  type PlanUnitNode,
  type ShipCaps,
  type StepReturn,
  type UnitEnding,
  type UnitPipelineInput,
  type UnitPipelineState,
} from "../ship/coordinator.js";
import { isCoordinatorUnit, runFinishedEventType, type CoordinatorUnit } from "./contract.js";

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
  "plan" | "unit-start" | "branch" | "spawn" | "read-record" | "pr-check" | "round" | "unit-end" | "finish";

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
  repo: string;
  base: string;
  caps: ShipCaps;
  childMinutes: UnitPipelineInput["childMinutes"];
  units: CoordinatorUnit[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isMinutes = (v: unknown): v is Record<string, number> =>
  isRecord(v) && Object.values(v).every((n) => typeof n === "number" && Number.isFinite(n));

function readPlan(a: BotAnswer): PlanFacts {
  const b = a.body;
  if (b.ok !== true) throw new UnreadableAnswer("plan", a, "not ok");
  if (typeof b.repo !== "string" || typeof b.base !== "string") throw new UnreadableAnswer("plan", a, "repo and base");
  if (!isMinutes(b.caps) || typeof b.caps.maxRounds !== "number" || typeof b.caps.maxMinutes !== "number")
    throw new UnreadableAnswer("plan", a, "caps");
  if (
    !isMinutes(b.childMinutes) ||
    typeof b.childMinutes.coding !== "number" ||
    typeof b.childMinutes.review !== "number"
  )
    throw new UnreadableAnswer("plan", a, "childMinutes");
  const units: unknown = b.units;
  if (!Array.isArray(units) || !units.every(isCoordinatorUnit)) throw new UnreadableAnswer("plan", a, "units");
  return {
    ...(typeof b.planId === "string" ? { planId: b.planId } : {}),
    repo: b.repo,
    base: b.base,
    caps: { maxRounds: b.caps.maxRounds, maxMinutes: b.caps.maxMinutes },
    childMinutes: { coding: b.childMinutes.coding, review: b.childMinutes.review },
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
  const { finalReply, pr, headSha, description, verdict, reviewPosted, reviewHead, dispositions, handoff } = facts;
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
      ...(reviewHead !== undefined ? { reviewHead } : {}),
      ...(dispositions !== undefined ? { dispositions } : {}),
      ...(handoff !== undefined ? { handoff } : {}),
    },
    at: a.body.at,
  };
}

function prCheckReturn(step: string, a: BotAnswer): StepReturn {
  const { ok, state, prNumber, url, headSha, at } = a.body;
  if (ok === true && state === "none") return { type: "pr-check", step, pr: { state: "none" }, at };
  if (ok === true && state === "open" && typeof prNumber === "number" && typeof url === "string")
    return {
      type: "pr-check",
      step,
      pr: { state: "open", prNumber, url, ...(typeof headSha === "string" ? { headSha } : {}) },
      at,
    };
  throw new UnreadableAnswer("pr-check", a, "state");
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
      return prCheckReturn(
        action.step,
        answerOf("pr-check", await step.do(action.step, STEP_CONFIG, () => call(bot, "pr-check", tag))),
      );
    case "sleep":
      await step.sleep(action.step, action.ms);
      return { type: "sleep", step: action.step };
    case "merge":
      // Unreachable while every branch's merge is a person's: the machine asks
      // for a merge only under `merge: "runner"`.
      throw new Error(`the runner does not merge (${action.step}): every branch waits for a person's merge`);
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
): Promise<UnitEnding> {
  const unit = node.id;
  const tag = { parentInstanceId: instanceId, unit };
  const start = readUnitStart(
    answerOf("unit-start", await step.do(`${unit}/start`, STEP_CONFIG, () => call(bot, "unit-start", tag))),
  );
  let state: UnitPipelineState = openUnitPipeline(
    {
      unit: { id: unit, branch: node.branch },
      repo: plan.repo,
      base: plan.base,
      caps: plan.caps,
      childMinutes: plan.childMinutes,
      merge: "person",
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
        const body = { ...tag, index: note.index, agent: note.agent, outcome: note.outcome };
        await step.do(`${unit}/note/${++notes}`, STEP_CONFIG, () => call(bot, "round", body));
      } else {
        const body = {
          ...tag,
          ending: { kind: note.ending.kind, report: renderUnitReport(state) },
          ...(state.pr !== undefined ? { pr: state.pr } : {}),
        };
        await step.do(`${unit}/end`, STEP_CONFIG, () => call(bot, "unit-end", body));
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
    const ending = await runUnit(
      step,
      bot,
      instanceId,
      graph.units.find((u) => u.id === next)!,
      plan,
    );
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
