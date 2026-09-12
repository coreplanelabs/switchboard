// The plan runner's state machine (docs/decisions/0029-durable-objects-store-workflows-schedule.md,
// docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md;
// docs/reference/specs/agent-ship.md item 15): what the ship coordinator — a
// Workflow instance in the bot's shim Worker with no model turn and no
// credential — decides between the steps it asks the bot for. The Workflow
// asks `nextAction`, performs it (a bot route, a `waitForEvent`, a sleep) and
// feeds the answer to `applyReturn`; everything the in-process round loop
// decides today (`runShipPipeline`: which round is next, what a child's end
// means, when a cap ends the pipeline, when the pull request is merge-ready)
// is decided here over the step returns instead, so the same endings hold
// with the loop's process gone.
//
// Two machines, both pure. The plan cursor walks a plan record's unit graph:
// which units are ready (their dependencies merged), which one a failure
// blocks. The unit pipeline runs one unit's coding → review → fix loop to
// approve and the merge: one thread and one head branch per unit
// (`plan/<plan-id>/<unit-slug>`), every child a `dispatch()` run the bot
// starts as the requesting user, every step retry-safe under the key
// `<instance>:<unit>/<round>/<kind>`. Nothing here reads a clock: the bot
// answers every step with its own `at`, and that is the machine's time. Nothing
// here carries a task's text or a thread's contents: a spawn's brief names the
// unit and the runs whose records the bot reads to compose the child's turn.
//
// Worker-importable: the shim Worker's Workflow drives this machine, so the
// module reaches nothing but node-free modules — the child presets' budgets
// arrive in the input rather than from the agent registry.

import type { ShipRoundOutcome } from "../runEvents.js";
import type { RunStatus } from "../runRecord.js";
import { normalizeHead, sameCommit } from "../reviewedHead.js";
import { formatFinding, type Finding, type FindingDisposition, type ReviewVerdictKind } from "../reviewVerdict.js";
import { parsePlanUnit, planUnitIds } from "./contract.js";

const MIN = 60_000;

/** What a pipeline runs under: the rounds cap from the `ship` config block, and
 *  the wall clock from the parent's EFFECTIVE profile — the ship preset's
 *  declared budget as the profile gate clipped it, never the block read again. */
export interface ShipCaps {
  maxRounds: number;
  maxMinutes: number;
}

/** A round is dispatched only when at least this much of the pipeline budget
 *  remains (the reservation check, agent-ship item 8): a child clipped below
 *  this cannot do useful work, so the pipeline reports the cap instead of
 *  burning an attach and a model turn on a doomed round. */
export const SHIP_ROUND_RESERVE_MS = 3 * MIN;

/** What a ship pipeline's thread and card say when the bot died under it (run-
 *  history item 36): the work it did stands on GitHub with nobody driving it,
 *  so the note names the PR when one was opened and the exact re-issue that
 *  continues the loop — the same entry the preflight's resume-at-review takes
 *  (agent-ship item 10). Without a PR the task itself is the re-issue: round 0
 *  runs again on the pipeline's own deterministic branch. The coordinator says
 *  the same when a child of its closed `interrupted`. */
export function shipInterruptedNote(prUrl?: string): string {
  const stands = prUrl
    ? `Its work stands on GitHub: ${prUrl}.`
    : "Whatever it pushed stands on its pipeline branch; no PR was opened yet.";
  const reissue = prUrl
    ? `To continue the review loop, re-issue \`agent:ship\` in this thread with only the PR URL (${prUrl}).`
    : "To continue, re-issue `agent:ship` in this thread with the task — round 0 runs again on the same branch.";
  return `⚠️ The bot restarted while this ship pipeline was running, so the pipeline stopped. ${stands} ${reissue}`;
}

// ---- the plan graph --------------------------------------------------------------------------------

/** One unit of a plan as the runner sees it: its heading, the units it waits on, its branch. */
export interface PlanUnitNode {
  /** `U<n>` as the plan's heading spells it. */
  id: string;
  title: string;
  /** `u<n>-<title slug>`, the branch's last segment. */
  slug: string;
  /** `plan/<plan-id>/<unit-slug>` — one head branch per unit, so two plans sharing a unit name never share one. */
  branch: string;
  /** The unit ids its Dependencies bullet names, in order, itself excluded. */
  dependsOn: string[];
}

export interface PlanGraph {
  planId: string;
  /** In the plan's order. */
  units: PlanUnitNode[];
}

/** A plan id: the plan file's name without its extension, lowercase, in the branch alphabet. */
export const PLAN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PLAN_BRANCH = /^plan\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;
/** A unit id in a Dependencies bullet, or a `U20 to U22` range naming every unit between, in the bullet's order. */
const UNIT_REF = /\bU(\d+)\s+to\s+U(\d+)\b|\bU\d+\b/g;
const SLUG_MAX = 24;
const INSTANCE_ID_MAX = 100;

/** `docs/plans/<date>-<n>-feat-x-plan.md` → `<date>-<n>-feat-x-plan`. Throws naming the path when the name is not a plan id. */
export function planIdOf(planPath: string): string {
  const base = planPath.split("/").pop() ?? "";
  const id = base.replace(/\.md$/i, "").toLowerCase();
  if (!PLAN_ID_PATTERN.test(id))
    throw new Error(`the plan's file name is not a plan id (lowercase letters, digits and hyphens): ${planPath}`);
  return id;
}

/** The unit's slug: its lowercase id, then a bounded slug of its title. */
export function unitSlug(unit: { id: string; title: string }): string {
  const title = unit.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  const id = unit.id.toLowerCase();
  return title ? `${id}-${title}` : id;
}

export function unitBranch(planId: string, slug: string): string {
  return `plan/${planId}/${slug}`;
}

/** The plan and unit a head branch names, or undefined for any other branch — the merge grant's line. */
export function parsePlanBranch(branch: string): { planId: string; unitSlug: string } | undefined {
  const m = PLAN_BRANCH.exec(branch);
  return m ? { planId: m[1]!, unitSlug: m[2]! } : undefined;
}

/** The instance id for a plan: it names the plan, so a second runner for the
 *  same plan meets the engine's duplicate-id refusal. */
export function planInstanceId(planId: string, attempt = 1): string {
  const base = `plan-${planId}`;
  if (attempt <= 1) return base.slice(0, INSTANCE_ID_MAX);
  // A re-issue after an earlier attempt ended: the attempt suffix keeps the
  // plan's name and never trims into it.
  const suffix = `-${attempt}`;
  return `${base.slice(0, INSTANCE_ID_MAX - suffix.length)}${suffix}`;
}

/** The Dependencies bullet's unit ids — lists, `to` ranges — the unit itself excluded. */
function dependenciesOf(text: string, self: string): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    if (id !== self && !out.includes(id)) out.push(id);
  };
  for (const m of text.matchAll(UNIT_REF)) {
    if (m[1] === undefined) {
      add(m[0]);
      continue;
    }
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (to >= from && to - from <= 100) for (let n = from; n <= to; n++) add(`U${n}`);
  }
  return out;
}

/** Every `### U<n>.` unit of the plan with its dependencies, slug and branch. */
export function parsePlanGraph(planMarkdown: string, planId: string): PlanGraph {
  const units = planUnitIds(planMarkdown).map((id): PlanUnitNode => {
    const unit = parsePlanUnit(planMarkdown, id)!;
    const slug = unitSlug(unit);
    return {
      id,
      title: unit.title,
      slug,
      branch: unitBranch(planId, slug),
      dependsOn: dependenciesOf(unit.bullets.Dependencies ?? "", id),
    };
  });
  return { planId, units };
}

/** `plan <path>.md [units U<n>, U<m>]` — the ship request that names a plan
 *  instead of a task; anything else is a task string. */
export function parseShipPlanRequest(task: string): { planPath: string; units?: string[] } | undefined {
  const m = /^plan\s+(\S+\.md)(?:\s+units?\s+((?:U\d+[\s,]*)+))?\s*$/i.exec(task.trim());
  if (!m) return undefined;
  const units = m[2] ? [...m[2].matchAll(/U\d+/gi)].map((u) => u[0].toUpperCase()) : undefined;
  return { planPath: m[1]!, ...(units && units.length > 0 ? { units } : {}) };
}

// ---- the plan cursor -------------------------------------------------------------------------------

export type UnitStatus = "pending" | "running" | "done" | "failed" | "blocked";

/** The outer state: which of the plan's units are in play and where each stands. */
export interface PlanCursor {
  /** The selected units in the plan's order. */
  order: string[];
  status: Readonly<Record<string, UnitStatus>>;
}

function nodeOf(graph: PlanGraph, id: string): PlanUnitNode {
  const node = graph.units.find((u) => u.id === id);
  if (!node) throw new Error(`the plan has no unit ${id} (its units: ${graph.units.map((u) => u.id).join(", ")})`);
  return node;
}

/** The dependencies of `id` that are in play: one outside the selection is the
 *  requester's assertion that it is done. */
function selectedDependencies(graph: PlanGraph, cursor: PlanCursor, id: string): string[] {
  return nodeOf(graph, id).dependsOn.filter((d) => d in cursor.status);
}

/** Open the cursor over the selected units (every unit when none are named).
 *  Throws on a unit the plan lacks and on a dependency cycle inside the selection. */
export function openPlanCursor(graph: PlanGraph, selected?: readonly string[]): PlanCursor {
  const chosen = new Set(selected ?? graph.units.map((u) => u.id));
  for (const id of chosen) nodeOf(graph, id);
  const order = graph.units.map((u) => u.id).filter((id) => chosen.has(id));
  const status: Record<string, UnitStatus> = {};
  for (const id of order) status[id] = "pending";
  const cursor: PlanCursor = { order, status };
  // A cycle among the selected units would leave them pending forever.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, path: string[]) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`the plan's units form a dependency cycle: ${[...path, id].join(" → ")}`);
    visiting.add(id);
    for (const dep of selectedDependencies(graph, cursor, id)) visit(dep, [...path, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of order) visit(id, []);
  return cursor;
}

/** The pending units whose in-play dependencies are all done, in the plan's order. */
export function readyUnits(graph: PlanGraph, cursor: PlanCursor): string[] {
  return cursor.order.filter(
    (id) =>
      cursor.status[id] === "pending" &&
      selectedDependencies(graph, cursor, id).every((dep) => cursor.status[dep] === "done"),
  );
}

/** Start a ready unit; anything else — a unit outside the selection, one already
 *  started or settled, one whose dependencies are not done — throws by name. */
export function startUnit(graph: PlanGraph, cursor: PlanCursor, id: string): PlanCursor {
  const status = cursor.status[id];
  if (status === undefined) throw new Error(`unit ${id} is not in the plan's selection`);
  if (status !== "pending") throw new Error(`unit ${id} is ${status}, not pending`);
  if (!readyUnits(graph, cursor).includes(id)) {
    const waiting = selectedDependencies(graph, cursor, id).filter((d) => cursor.status[d] !== "done");
    throw new Error(`unit ${id} is not ready: it waits on ${waiting.join(", ")}`);
  }
  return { ...cursor, status: { ...cursor.status, [id]: "running" } };
}

/** A unit's end: `done` (merged) frees its dependents; `failed` (anything
 *  else — a conflict, a cap, a stop, a refused merge) blocks them, transitively,
 *  and leaves every other ready unit in play. */
export function settleUnit(graph: PlanGraph, cursor: PlanCursor, id: string, ending: "done" | "failed"): PlanCursor {
  if (cursor.status[id] !== "running")
    throw new Error(`unit ${id} is ${cursor.status[id] ?? "not selected"}, not running`);
  const status: Record<string, UnitStatus> = { ...cursor.status, [id]: ending };
  if (ending === "failed") {
    let changed = true;
    while (changed) {
      changed = false;
      for (const unit of cursor.order) {
        if (status[unit] !== "pending") continue;
        const blocked = nodeOf(graph, unit).dependsOn.some(
          (dep) => dep in status && (status[dep] === "failed" || status[dep] === "blocked"),
        );
        if (blocked) {
          status[unit] = "blocked";
          changed = true;
        }
      }
    }
  }
  return { ...cursor, status };
}

export function cursorFinished(cursor: PlanCursor): boolean {
  return cursor.order.every((id) => cursor.status[id] !== "pending" && cursor.status[id] !== "running");
}

// ---- the unit pipeline: shapes --------------------------------------------------------------------

export type RoundKind = "coding" | "review" | "fix";
export interface RoundRef {
  /** Round 0 is the coding round; review round n and its fix round share n. */
  index: number;
  kind: RoundKind;
}
export type ChildPreset = "coding" | "review";

/** The preset a round's child runs as: a fix round is a coding child. */
export function presetOf(kind: RoundKind): ChildPreset {
  return kind === "review" ? "review" : "coding";
}

/** How a spawn's child is briefed — ids only, never text. The bot composes the
 *  turn: the unit's contract, or the review turn from the pull request and the
 *  prior rounds' records, or the fix turn from the review run's verdict. */
export type Brief =
  | { kind: "contract"; unit: string; rebase: { branch: string; onto: string } }
  | {
      kind: "review";
      unit: string;
      pr: number;
      headSha?: string;
      round: number;
      /** The previous review round's run and the fix round that answered it, for a re-review. */
      prior?: { reviewRunId: string; fixRunId?: string };
    }
  | { kind: "fix"; unit: string; pr: number; reviewRunId: string };

export interface PrRef {
  number: number;
  url: string;
}

/** What the coordinator asks for next. `step` is the Workflow step's name, and
 *  for a spawn the second half of the child's idempotency key. */
export type CoordinatorAction =
  | { type: "branch"; step: string; branch: string; from: string }
  | { type: "spawn"; step: string; preset: ChildPreset; round: RoundRef; budgetMinutes: number; brief: Brief }
  | { type: "wait"; step: string; runId: string; timeoutMs: number }
  | { type: "read-record"; step: string; runId: string }
  | { type: "pr-check"; step: string }
  | { type: "merge"; step: string; prNumber: number; headSha: string }
  | { type: "sleep"; step: string; ms: number }
  | { type: "end"; step: string; ending: UnitEnding };

/** A child's facts as `read-record` answers them: live, or finished with the
 *  typed artifacts its run recorded. */
export type ChildFacts =
  | { finished: false }
  | {
      finished: true;
      status: RunStatus;
      finalReply?: string;
      /** A coding child's `pr_opened`. */
      pr?: { number: number; url: string; created: boolean };
      /** The head the coding child left the branch at, when its run observed one. */
      headSha?: string;
      description?: boolean;
      /** A review child's verdict. */
      verdict?: { verdict: ReviewVerdictKind; summary?: string; findings: Finding[] };
      /** Whether the review child's verdict landed on the pull request. */
      reviewPosted?: boolean;
      reviewHead?: string;
      /** A fix child's dispositions. */
      dispositions?: FindingDisposition[];
      handoff?: boolean;
    };

export type PrCheck = { state: "none" } | { state: "open"; prNumber: number; url: string; headSha?: string };

/** What a step answered. Every bot answer carries `at`, the bot's clock — the machine's time. */
export type StepReturn =
  | { type: "branch"; step: string; ok: true; at: number }
  | { type: "branch"; step: string; ok: false; reason: string; at: number }
  | { type: "spawn"; step: string; outcome: "spawned" | "alreadySpawned"; runId: string; at: number }
  | { type: "spawn"; step: string; outcome: "busy"; runId?: string; at: number }
  | { type: "spawn"; step: string; outcome: "refused"; refusal: string; message?: string; at: number }
  | { type: "spawn"; step: string; outcome: "failed"; reason: string; at: number }
  | { type: "wait"; step: string; outcome: "event" | "timeout" }
  | { type: "read-record"; step: string; run: ChildFacts; at: number }
  | { type: "pr-check"; step: string; pr: PrCheck; at: number }
  | { type: "merge"; step: string; outcome: "merged"; sha: string; at: number }
  | { type: "merge"; step: string; outcome: "pending" | "refused"; reason: string; at: number }
  | { type: "sleep"; step: string };

/** How one unit's pipeline ended — the truthful vocabulary the in-process loop
 *  has, plus the merge's own: `merged` by the runner, `merge_ready` for a
 *  person, `merge_refused` by the guards; `interrupted` a child the ledger
 *  closed; `refused` a child the authorize stage never started. */
export type UnitEnding =
  | { kind: "merged"; pr: PrRef; sha: string; reviewRounds: number }
  | { kind: "merge_ready"; pr: PrRef; reviewRounds: number }
  | { kind: "merge_refused"; pr: PrRef; reason: string; reviewRounds: number }
  | { kind: "round_cap"; maxRounds: number; reviewRounds: number }
  | { kind: "wall_clock_cap"; remainingMs: number; reviewRounds: number }
  | {
      kind: "stopped";
      mode: "soft" | "hard";
      round: RoundRef;
      reviewRounds: number;
      finalReply?: string;
      /** A changes-requested review posted this round before the stop. */
      postedReview?: boolean;
    }
  | { kind: "aborted"; reason: string; round?: RoundRef; reviewRounds: number; finalReply?: string }
  | { kind: "no_verdict"; round: RoundRef; reviewRounds: number; finalReply?: string }
  | { kind: "interrupted"; round: RoundRef; runId: string; reviewRounds: number }
  | { kind: "refused"; refusal: string; message?: string; round: RoundRef; reviewRounds: number };

/** What a transition tells the driver beyond the next action: a round boundary
 *  the card draws (`shipRoundHeader`) and the run stream records, and the end. */
export type CoordinatorNote =
  | { type: "round"; index: number; agent: ChildPreset; outcome: ShipRoundOutcome }
  | { type: "ended"; ending: UnitEnding };

export interface UnitPipelineInput {
  unit: { id: string; branch: string };
  repo: string;
  /** The pull request's base — the branch the unit is created from and rebased onto. */
  base: string;
  caps: ShipCaps;
  /** Each child preset's own wall-clock budget (its `maxMinutes`), the number a
   *  round's budget is clipped from — supplied by the bot, which holds the registry. */
  childMinutes: Readonly<Record<ChildPreset, number>>;
  /** Who merges: the runner (a plan branch, under its grant) or a person (any other branch). */
  merge: "runner" | "person";
  /** Resume at review: an open pull request of ship's own the requester named. */
  resume?: { pr: number; headSha?: string; url?: string };
}

type Phase =
  | { at: "branch" }
  | { at: "spawn"; round: RoundRef; busy: number }
  | { at: "busy-wait"; round: RoundRef; runId?: string; n: number }
  | { at: "wait"; round: RoundRef; runId: string; n: number; budgetMinutes: number }
  | { at: "read"; round: RoundRef; runId: string; n: number; budgetMinutes: number }
  | { at: "pr-check"; round: RoundRef; runId: string; childHead?: string; finalReply?: string }
  | { at: "merge"; pr: PrRef; headSha: string; n: number; since: number }
  | { at: "merge-sleep"; pr: PrRef; headSha: string; n: number; since: number }
  | { at: "ended" };

export interface UnitPipelineState {
  readonly input: UnitPipelineInput;
  readonly startedAt: number;
  /** The last `at` a step answered with. */
  readonly clock: number;
  readonly phase: Phase;
  /** Review rounds started so far. */
  readonly reviewRounds: number;
  readonly pr?: PrRef;
  readonly lastReviewHead?: string;
  readonly lastVerdictSummary?: string;
  /** Findings per review round and dispositions per fix round, keyed by the
   *  review round they belong to — finding ids are unique within one round only. */
  readonly findingsByRound: Readonly<Record<number, Finding[]>>;
  readonly dispositionsByRound: Readonly<Record<number, FindingDisposition[]>>;
  readonly reviewRunByRound: Readonly<Record<number, string>>;
  readonly fixRunByRound: Readonly<Record<number, string>>;
  /** The last coding child (round 0 or a fix round): its record carries the unit's handoff. */
  readonly lastCodingRunId?: string;
  readonly ending?: UnitEnding;
}

/** Past a child's budget, the parent asks the bot instead of waiting on. */
export const WAIT_MARGIN_MS = 5 * MIN;
/** How often the runner asks for the merge while the guards are still pending, and for how long at most. */
export const MERGE_POLL_MS = 5 * MIN;
export const MERGE_WAIT_MAX_MS = 60 * MIN;
/** A `busy` without the live run's id: nothing to wait on, so a short sleep before the spawn is asked again. */
export const BUSY_RETRY_MS = 2 * MIN;

// ---- the unit pipeline: opening and the next action -----------------------------------------------

export function openUnitPipeline(input: UnitPipelineInput, at: number): UnitPipelineState {
  const base: UnitPipelineState = {
    input,
    startedAt: at,
    clock: at,
    phase: { at: "branch" },
    reviewRounds: 0,
    findingsByRound: {},
    dispositionsByRound: {},
    reviewRunByRound: {},
    fixRunByRound: {},
  };
  if (!input.resume) return base;
  const url = input.resume.url ?? `https://github.com/${input.repo}/pull/${input.resume.pr}`;
  const resumed: UnitPipelineState = {
    ...base,
    pr: { number: input.resume.pr, url },
    ...(input.resume.headSha !== undefined ? { lastReviewHead: input.resume.headSha } : {}),
  };
  return nextReview(resumed).state;
}

const deadlineAt = (s: UnitPipelineState) => s.startedAt + s.input.caps.maxMinutes * MIN;
const remainingMs = (s: UnitPipelineState) => deadlineAt(s) - s.clock;

/** The child's budget: its preset's own, clipped to the pipeline's remaining
 *  wall clock (the in-process loop's `clip`), never under the two minutes a
 *  spawn accepts. */
function budgetMinutesFor(s: UnitPipelineState, preset: ChildPreset): number {
  return Math.max(2, Math.min(s.input.childMinutes[preset], Math.floor(remainingMs(s) / MIN)));
}

const roundStep = (s: UnitPipelineState, round: RoundRef) => `${s.input.unit.id}/${round.index}/${round.kind}`;

function briefFor(s: UnitPipelineState, round: RoundRef): Brief {
  const unit = s.input.unit.id;
  if (round.kind === "coding")
    return { kind: "contract", unit, rebase: { branch: s.input.unit.branch, onto: s.input.base } };
  const pr = s.pr!.number;
  if (round.kind === "fix") return { kind: "fix", unit, pr, reviewRunId: s.reviewRunByRound[round.index]! };
  const priorReview = s.reviewRunByRound[round.index - 1];
  const priorFix = s.fixRunByRound[round.index - 1];
  return {
    kind: "review",
    unit,
    pr,
    ...(s.lastReviewHead !== undefined ? { headSha: s.lastReviewHead } : {}),
    round: round.index,
    ...(priorReview !== undefined
      ? { prior: { reviewRunId: priorReview, ...(priorFix !== undefined ? { fixRunId: priorFix } : {}) } }
      : {}),
  };
}

/** The step the machine is at. Pure over the state: asked before every step
 *  and again after a replay, it names the same step for the same state. */
export function nextAction(s: UnitPipelineState): CoordinatorAction {
  const unit = s.input.unit.id;
  const p = s.phase;
  switch (p.at) {
    case "branch":
      return { type: "branch", step: `${unit}/branch`, branch: s.input.unit.branch, from: s.input.base };
    case "spawn": {
      const preset = presetOf(p.round.kind);
      return {
        type: "spawn",
        step: roundStep(s, p.round),
        preset,
        round: p.round,
        budgetMinutes: budgetMinutesFor(s, preset),
        brief: briefFor(s, p.round),
      };
    }
    case "busy-wait": {
      const step = `${roundStep(s, p.round)}/busy/${p.n}`;
      if (p.runId === undefined) return { type: "sleep", step, ms: BUSY_RETRY_MS };
      return { type: "wait", step, runId: p.runId, timeoutMs: Math.max(0, remainingMs(s)) + WAIT_MARGIN_MS };
    }
    case "wait":
      return {
        type: "wait",
        step: `${roundStep(s, p.round)}/wait/${p.n}`,
        runId: p.runId,
        timeoutMs: p.budgetMinutes * MIN + WAIT_MARGIN_MS,
      };
    case "read":
      return { type: "read-record", step: `${roundStep(s, p.round)}/read/${p.n}`, runId: p.runId };
    case "pr-check":
      return { type: "pr-check", step: `${roundStep(s, p.round)}/pr-check` };
    case "merge":
      return { type: "merge", step: `${unit}/merge/${p.n}`, prNumber: p.pr.number, headSha: p.headSha };
    case "merge-sleep":
      return { type: "sleep", step: `${unit}/merge/sleep/${p.n}`, ms: MERGE_POLL_MS };
    case "ended":
      return { type: "end", step: `${unit}/end`, ending: s.ending! };
  }
}

// ---- the unit pipeline: transitions -----------------------------------------------------------------

interface Transition {
  state: UnitPipelineState;
  notes: CoordinatorNote[];
}

const ENDED: Phase = { at: "ended" };

function end(s: UnitPipelineState, ending: UnitEnding, notes: CoordinatorNote[] = []): Transition {
  return { state: { ...s, phase: ENDED, ending }, notes: [...notes, { type: "ended", ending }] };
}

const roundNote = (round: RoundRef, outcome: ShipRoundOutcome): CoordinatorNote => ({
  type: "round",
  index: round.index,
  agent: presetOf(round.kind),
  outcome,
});

/** Start a round if the reservation holds (the in-process loop's check: a
 *  child clipped under the reserve cannot do useful work). */
function enterRound(s: UnitPipelineState, round: RoundRef, notes: CoordinatorNote[] = []): Transition {
  const remaining = remainingMs(s);
  if (remaining < SHIP_ROUND_RESERVE_MS)
    return end(s, { kind: "wall_clock_cap", remainingMs: remaining, reviewRounds: s.reviewRounds }, notes);
  const reviewRounds = round.kind === "review" ? round.index : s.reviewRounds;
  return { state: { ...s, reviewRounds, phase: { at: "spawn", round, busy: 0 } }, notes };
}

/** The next review round, or the round cap. */
function nextReview(s: UnitPipelineState, notes: CoordinatorNote[] = []): Transition {
  if (s.reviewRounds >= s.input.caps.maxRounds)
    return end(s, { kind: "round_cap", maxRounds: s.input.caps.maxRounds, reviewRounds: s.reviewRounds }, notes);
  return enterRound(s, { index: s.reviewRounds + 1, kind: "review" }, notes);
}

const stopMode = (status: RunStatus): "soft" | "hard" | undefined =>
  status === "stopped_soft" ? "soft" : status === "stopped_hard" ? "hard" : undefined;

/** A coding or fix child's confirmed end. */
function settleCoding(
  s: UnitPipelineState,
  round: RoundRef,
  runId: string,
  facts: Extract<ChildFacts, { finished: true }>,
): Transition {
  // Recorded before the checks below: a pull request is a fact a stop must
  // still report, and submitted dispositions are a fact no ending erases.
  let next: UnitPipelineState = {
    ...s,
    ...(facts.pr !== undefined ? { pr: { number: facts.pr.number, url: facts.pr.url } } : {}),
    ...(round.kind === "fix" && facts.dispositions !== undefined
      ? { dispositionsByRound: { ...s.dispositionsByRound, [round.index]: facts.dispositions } }
      : {}),
  };
  const mode = stopMode(facts.status);
  if (mode !== undefined)
    return end(
      next,
      {
        kind: "stopped",
        mode,
        round,
        reviewRounds: next.reviewRounds,
        ...(facts.finalReply !== undefined ? { finalReply: facts.finalReply } : {}),
      },
      [roundNote(round, "stopped")],
    );
  if (facts.status === "failed")
    return end(
      next,
      {
        kind: "aborted",
        reason: `⚠️ The coding child of round ${round.index} (run ${runId}) ended \`failed\` — its run page has the error; nothing was opened or edited from it.`,
        round,
        reviewRounds: next.reviewRounds,
      },
      [roundNote(round, "aborted")],
    );
  next = {
    ...next,
    phase: {
      at: "pr-check",
      round,
      runId,
      ...(facts.headSha !== undefined ? { childHead: facts.headSha } : {}),
      ...(facts.finalReply !== undefined ? { finalReply: facts.finalReply } : {}),
    },
  };
  return { state: next, notes: [] };
}

/** A review child's confirmed end. */
function settleReview(
  s: UnitPipelineState,
  round: RoundRef,
  facts: Extract<ChildFacts, { finished: true }>,
): Transition {
  const mode = stopMode(facts.status);
  if (!facts.verdict) {
    if (mode !== undefined)
      return end(
        s,
        {
          kind: "stopped",
          mode,
          round,
          reviewRounds: s.reviewRounds,
          ...(facts.finalReply !== undefined ? { finalReply: facts.finalReply } : {}),
        },
        [roundNote(round, "stopped")],
      );
    return end(
      s,
      {
        kind: "no_verdict",
        round,
        reviewRounds: s.reviewRounds,
        ...(facts.finalReply !== undefined ? { finalReply: facts.finalReply } : {}),
      },
      [roundNote(round, "no_verdict")],
    );
  }
  const verdict = facts.verdict;
  const next: UnitPipelineState = {
    ...s,
    findingsByRound: { ...s.findingsByRound, [round.index]: verdict.findings },
    ...(facts.reviewHead !== undefined ? { lastReviewHead: facts.reviewHead } : {}),
    ...(verdict.summary !== undefined ? { lastVerdictSummary: verdict.summary } : {}),
  };
  const notes = [roundNote(round, verdict.verdict)];
  if (verdict.verdict === "approve") {
    // Merge-ready stands on the POSTED approval: an approve whose post did
    // not land left no approving review on the pull request.
    if (facts.reviewPosted === false)
      return end(
        next,
        {
          kind: "aborted",
          reason: `⚠️ The review approved, but the approval could not be posted — the pull request carries no approving review. Re-run ship with the pull request URL to retry the approval.`,
          round,
          reviewRounds: next.reviewRounds,
        },
        notes,
      );
    const pr = next.pr!;
    if (next.input.merge !== "runner")
      return end(next, { kind: "merge_ready", pr, reviewRounds: next.reviewRounds }, notes);
    // The runner merges only at the head the review approved; with none known
    // there is nothing to pin the merge to, and a person decides.
    const headSha = next.lastReviewHead;
    if (headSha === undefined)
      return end(
        next,
        { kind: "merge_refused", pr, reason: "no approved head is known to merge at", reviewRounds: next.reviewRounds },
        notes,
      );
    return { state: { ...next, phase: { at: "merge", pr, headSha, n: 1, since: next.clock } }, notes };
  }
  // request_changes: the verdict settled (and posted) — now a stop
  // short-circuits the fix round, naming the review standing on the pull request.
  if (mode !== undefined)
    return end(
      next,
      {
        kind: "stopped",
        mode,
        round,
        reviewRounds: next.reviewRounds,
        ...(facts.finalReply !== undefined ? { finalReply: facts.finalReply } : {}),
        ...(facts.reviewPosted === true ? { postedReview: true } : {}),
      },
      notes,
    );
  if (next.reviewRounds >= next.input.caps.maxRounds)
    return end(
      next,
      { kind: "round_cap", maxRounds: next.input.caps.maxRounds, reviewRounds: next.reviewRounds },
      notes,
    );
  return enterRound(next, { index: round.index, kind: "fix" }, notes);
}

/** The pull request heading the branch after a coding or fix round. */
function settlePrCheck(s: UnitPipelineState, phase: Extract<Phase, { at: "pr-check" }>, pr: PrCheck): Transition {
  const { round } = phase;
  if (pr.state === "none") {
    const reason =
      round.index === 0
        ? `⚠️ Ship ended at round 0: the coding round ended without opening a pull request (a clarifying question, a budget write-up, an unproven push or a description-less push ends the pipeline here). No review round ran.`
        : `⚠️ Fix round ${round.index} left no open pull request heading \`${s.input.unit.branch}\` — the pull request was closed out from under the pipeline and none was reopened, so there is nothing to re-review.`;
    return end(
      s,
      {
        kind: "aborted",
        reason,
        round,
        reviewRounds: s.reviewRounds,
        ...(phase.finalReply !== undefined ? { finalReply: phase.finalReply } : {}),
      },
      [roundNote(round, "aborted")],
    );
  }
  const head = pr.headSha ?? phase.childHead;
  const next: UnitPipelineState = { ...s, pr: { number: pr.prNumber, url: pr.url } };
  if (round.kind === "fix") {
    // Nothing repushed → nothing to re-review, unless every finding of the
    // last review was declined on the record: that re-review verifies the
    // arguments and may concede.
    const fixHead = normalizeHead(head);
    const reviewedAt = normalizeHead(s.lastReviewHead);
    if (fixHead !== undefined && reviewedAt !== undefined && sameCommit(fixHead, reviewedAt)) {
      const findings = s.findingsByRound[round.index] ?? [];
      const dispositions = s.dispositionsByRound[round.index] ?? [];
      const allDeclined =
        findings.length > 0 &&
        findings.every((f) => dispositions.find((d) => d.findingId === f.id)?.disposition === "declined");
      if (!allDeclined)
        return end(
          next,
          {
            kind: "aborted",
            reason: `⚠️ Fix round ${round.index} produced no new head — the branch still sits at \`${fixHead.slice(0, 7)}\`, the commit the review already read, and not every finding was declined on the record, so there is nothing new to re-review.`,
            round,
            reviewRounds: next.reviewRounds,
          },
          [roundNote(round, "aborted")],
        );
    }
  }
  return nextReview({ ...next, ...(head !== undefined ? { lastReviewHead: head } : {}) }, [
    roundNote(round, "pr_opened"),
  ]);
}

/**
 * Feed a step's answer to the machine. An answer for any step but the one the
 * machine is at — a duplicate `run finished`, a replayed spawn — changes
 * nothing, so every return is safe to apply twice.
 */
export function applyReturn(s: UnitPipelineState, ret: StepReturn): Transition {
  const expected = nextAction(s);
  if (expected.type === "end" || ret.step !== expected.step || ret.type !== expected.type)
    return { state: s, notes: [] };
  const clocked: UnitPipelineState = "at" in ret ? { ...s, clock: ret.at } : s;
  const p = s.phase;
  switch (p.at) {
    case "branch": {
      const r = ret as Extract<StepReturn, { type: "branch" }>;
      if (r.ok) return enterRound(clocked, { index: 0, kind: "coding" });
      return end(clocked, {
        kind: "aborted",
        reason: `⚠️ Could not create the pipeline branch \`${s.input.unit.branch}\` from \`${s.input.base}\` on \`${s.input.repo}\`: ${r.reason} — round 0 never started.`,
        reviewRounds: s.reviewRounds,
      });
    }
    case "spawn": {
      const r = ret as Extract<StepReturn, { type: "spawn" }>;
      switch (r.outcome) {
        case "spawned":
        case "alreadySpawned": {
          const budgetMinutes = budgetMinutesFor(s, presetOf(p.round.kind));
          const runs =
            p.round.kind === "review"
              ? { reviewRunByRound: { ...s.reviewRunByRound, [p.round.index]: r.runId } }
              : p.round.kind === "fix"
                ? { fixRunByRound: { ...s.fixRunByRound, [p.round.index]: r.runId }, lastCodingRunId: r.runId }
                : { lastCodingRunId: r.runId };
          return {
            state: { ...clocked, ...runs, phase: { at: "wait", round: p.round, runId: r.runId, n: 1, budgetMinutes } },
            notes: [roundNote(p.round, "started")],
          };
        }
        case "busy": {
          // Another run holds the unit's thread: wait for its end, then ask
          // again — unless the pipeline's wall clock ran out meanwhile.
          if (remainingMs(clocked) < SHIP_ROUND_RESERVE_MS)
            return end(clocked, {
              kind: "wall_clock_cap",
              remainingMs: remainingMs(clocked),
              reviewRounds: s.reviewRounds,
            });
          return {
            state: {
              ...clocked,
              phase: {
                at: "busy-wait",
                round: p.round,
                ...(r.runId !== undefined ? { runId: r.runId } : {}),
                n: p.busy + 1,
              },
            },
            notes: [],
          };
        }
        case "refused":
          return end(clocked, {
            kind: "refused",
            refusal: r.refusal,
            ...(r.message !== undefined ? { message: r.message } : {}),
            round: p.round,
            reviewRounds: s.reviewRounds,
          });
        case "failed":
          return end(clocked, {
            kind: "aborted",
            reason: `⚠️ The ${presetOf(p.round.kind)} child of round ${p.round.index} could not be started: ${r.reason}.`,
            round: p.round,
            reviewRounds: s.reviewRounds,
          });
      }
      break;
    }
    case "busy-wait":
      return { state: { ...s, phase: { at: "spawn", round: p.round, busy: p.n } }, notes: [] };
    case "wait":
      return {
        state: { ...s, phase: { at: "read", round: p.round, runId: p.runId, n: p.n, budgetMinutes: p.budgetMinutes } },
        notes: [],
      };
    case "read": {
      const r = ret as Extract<StepReturn, { type: "read-record" }>;
      if (!r.run.finished)
        return {
          state: {
            ...clocked,
            phase: { at: "wait", round: p.round, runId: p.runId, n: p.n + 1, budgetMinutes: p.budgetMinutes },
          },
          notes: [],
        };
      if (r.run.status === "interrupted")
        return end(clocked, { kind: "interrupted", round: p.round, runId: p.runId, reviewRounds: s.reviewRounds }, [
          roundNote(p.round, "aborted"),
        ]);
      return p.round.kind === "review"
        ? settleReview(clocked, p.round, r.run)
        : settleCoding(clocked, p.round, p.runId, r.run);
    }
    case "pr-check":
      return settlePrCheck(clocked, p, (ret as Extract<StepReturn, { type: "pr-check" }>).pr);
    case "merge": {
      const r = ret as Extract<StepReturn, { type: "merge" }>;
      if (r.outcome === "merged")
        return end(clocked, { kind: "merged", pr: p.pr, sha: r.sha, reviewRounds: s.reviewRounds });
      if (r.outcome === "refused")
        return end(clocked, { kind: "merge_refused", pr: p.pr, reason: r.reason, reviewRounds: s.reviewRounds });
      const waited = r.at - p.since;
      if (waited >= MERGE_WAIT_MAX_MS)
        return end(clocked, {
          kind: "merge_refused",
          pr: p.pr,
          reason: `still pending after ${Math.round(waited / MIN)} minutes (${r.reason})`,
          reviewRounds: s.reviewRounds,
        });
      return {
        state: { ...clocked, phase: { at: "merge-sleep", pr: p.pr, headSha: p.headSha, n: p.n, since: p.since } },
        notes: [],
      };
    }
    case "merge-sleep":
      return {
        state: { ...s, phase: { at: "merge", pr: p.pr, headSha: p.headSha, n: p.n + 1, since: p.since } },
        notes: [],
      };
    case "ended":
      break;
  }
  return { state: s, notes: [] };
}

// ---- the report --------------------------------------------------------------------------------------

const sameFinding = (a: Finding, b: Finding) => a.severity === b.severity && a.file === b.file && a.title === b.title;

/** The disposition that answers `finding` as review round `round` listed it:
 *  that round's own fix round's, else one carried forward unchanged from an
 *  earlier round — never across a reused id, which inherits nothing. */
function dispositionFor(s: UnitPipelineState, finding: Finding, round: number): FindingDisposition | undefined {
  let cur = finding;
  for (let r = round; r >= 1; r--) {
    const d = s.dispositionsByRound[r]?.find((x) => x.findingId === cur.id);
    if (d) return d;
    const carriedFrom = s.findingsByRound[r - 1]?.find((p) => p.id === cur.id && sameFinding(p, cur));
    if (!carriedFrom) return undefined;
    cur = carriedFrom;
  }
  return undefined;
}

/** The cap report's declined-vs-unaddressed split over the last review round's findings. */
function splitReport(s: UnitPipelineState): string {
  if (s.reviewRounds === 0) return "No review round ran before the cap — there are no findings to report.";
  const last = s.findingsByRound[s.reviewRounds] ?? [];
  const withDisposition = (f: Finding) => dispositionFor(s, f, s.reviewRounds);
  const declined = last.filter((f) => withDisposition(f)?.disposition === "declined");
  const unaddressed = last.filter((f) => !withDisposition(f));
  const claimedFixed = last.filter((f) => withDisposition(f)?.disposition === "fixed");
  const list = (items: Finding[], note?: (f: Finding) => string) =>
    items.length > 0
      ? items.map((f) => `  - ${formatFinding(f)}${note ? ` — ${note(f)}` : ""}`).join("\n")
      : "  - none";
  const lines = [
    `Open findings from the last review (${last.length}):`,
    `Declined (disposition recorded):\n${list(declined, (f) => withDisposition(f)?.note || "no note")}`,
    `Unaddressed (no disposition):\n${list(unaddressed)}`,
  ];
  if (claimedFixed.length > 0)
    lines.push(`Claimed fixed but still flagged:\n${list(claimedFixed, (f) => withDisposition(f)?.note || "no note")}`);
  return lines.join("\n");
}

/** The thread's report for a unit's ending — the in-process loop's own words
 *  for the endings it has, and the merge's for the ones it gains. */
export function renderUnitReport(s: UnitPipelineState): string {
  const e = s.ending;
  if (!e) return "";
  const rounds = `${e.reviewRounds} review round${e.reviewRounds === 1 ? "" : "s"}`;
  const prUrl = s.pr?.url;
  const prLine = prUrl ? ` PR: ${prUrl}` : "";
  const reissue =
    s.input.unit.id === "task"
      ? `To continue, re-issue \`agent:ship\` in this thread${prUrl ? ` and include the PR URL (${prUrl})` : " — include the PR URL if a PR exists"}.`
      : `The unit's dependents in this plan stay blocked; the unit runs again when the plan is re-issued.`;
  const declined = [...(s.dispositionsByRound[e.reviewRounds - 1] ?? [])].filter((d) => d.disposition === "declined");
  const declinedLine = `Declined findings: ${declined.length > 0 ? declined.map((d) => `${d.findingId}${d.note ? ` — ${d.note}` : ""}`).join("; ") : "none"}`;
  const verdictLine = `Verdict: LGTM${s.lastVerdictSummary ? ` — ${s.lastVerdictSummary}` : ""}`;
  const join = (parts: Array<string | undefined>) => parts.filter(Boolean).join("\n\n");
  switch (e.kind) {
    case "merged":
      return [
        `✅ Merged after ${rounds}: ${e.pr.url} (squash \`${e.sha.slice(0, 7)}\`) — merged by the plan runner under \`plan:merge\`: the review approved at this head and the guards were green.`,
        verdictLine,
        declinedLine,
      ].join("\n");
    case "merge_ready":
      return [
        `✅ Merge-ready after ${rounds}: ${e.pr.url}`,
        verdictLine,
        declinedLine,
        "Remaining gate: a person's merge — the runner merges only a plan branch's pull request, and ship never approves.",
      ].join("\n");
    case "merge_refused":
      return join([
        `⚠️ The review approved ${e.pr.url} but the runner did not merge it: ${e.reason}. A person decides what becomes of the pull request.`,
        reissue,
      ]);
    case "round_cap":
      return join([
        `🧢 Ship stopped at a cap: the ${e.maxRounds}-round cap — no approval after ${rounds}.${prLine}`,
        splitReport(s),
        reissue,
      ]);
    case "wall_clock_cap":
      return join([
        `🧢 Ship stopped at a cap: the remaining pipeline time (~${Math.max(0, Math.round(e.remainingMs / MIN))} min of the ${s.input.caps.maxMinutes}-minute budget) cannot hold another round — no approval after ${rounds}.${prLine}`,
        splitReport(s),
        reissue,
      ]);
    case "stopped":
      return join([
        `${e.mode === "hard" ? "⛔" : "⏹"} Ship stopped by operator (${e.mode} stop) after ${rounds}.${prLine}`,
        e.finalReply,
        e.postedReview
          ? "ℹ️ A changes-requested review was posted this round before the stop — its findings stand on the PR."
          : undefined,
        reissue,
      ]);
    case "aborted":
      return join([e.finalReply, e.reason, `⚠️ Ship aborted after ${rounds}.`, reissue]);
    case "no_verdict":
      return join([
        `⚠️ Review round ${e.round.index} ended without a submitted verdict (budget, refusal, or stop) — ship never converts that into a request for changes, so no fix round ran.`,
        e.finalReply ? `Review round's final message:\n\n${e.finalReply}` : undefined,
        `⚠️ Ship aborted after ${rounds}.`,
        reissue,
      ]);
    case "interrupted":
      return shipInterruptedNote(prUrl);
    case "refused":
      return join([
        `🚫 The ${presetOf(e.round.kind)} child of round ${e.round.index} was refused by the authorize stage (${e.refusal})${e.message ? `: ${e.message}` : ""} — every child is authorized as the requesting user, so the pipeline ends here.`,
        reissue,
      ]);
  }
}
