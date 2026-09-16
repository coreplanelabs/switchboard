// The plan runner's state machine (docs/decisions/0029-durable-objects-store-workflows-schedule.md,
// docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md;
// docs/reference/specs/agent-ship.md item 15): what the ship coordinator — a
// Workflow instance in the bot's shim Worker with no model turn and no
// credential — decides between the steps it asks the bot for. The Workflow
// asks `nextAction`, performs it (a bot route, a `waitForEvent`, a sleep) and
// feeds the answer to `applyReturn`; everything the pipeline decides — which
// round is next, what a child's end means, when a cap ends the pipeline, when
// the pull request is merge-ready — is decided here over the step returns, so
// the endings hold with no process of the pipeline's own to die.
//
// Two machines, both pure. The plan cursor walks a plan record's unit graph:
// which units are ready (their dependencies merged), which one a failure
// blocks. The unit pipeline runs one unit's coding → review → fix loop to
// approve and the merge: one thread and one head branch per unit
// (`plan/<plan-id>/<unit-slug>`), every child a `dispatch()` run the bot
// starts as the requesting user, every step retry-safe under the key
// `<instance>:<unit>/<round>/<kind>`. Its first step asks what already heads
// the branch: a pull request merged before the attempt reached the unit — a
// person's merge, or an earlier attempt's — ends the unit `merged` with no
// branch and no child, so a re-issued plan walks past its done units instead
// of aborting them; the same answer after a round ends it the same way, since
// a merge can land while a child runs. Nothing here reads a clock: the bot
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

/** What a round-0 coding child must leave on the pipeline's clock: two review
 *  rounds (a review and, after a fix, its re-review) and one merge poll — the
 *  loop the pipeline exists to run. The coding child's budget is clipped to
 *  the remaining wall clock MINUS this reserve (never under the two minutes a
 *  spawn accepts), so a child that uses its whole directive still hands the
 *  pipeline a clock that holds the review; without the clip a 40-minute
 *  pipeline hands 39 minutes to the child and caps out with the pull request
 *  shipped and unreviewed. */
export const SHIP_LOOP_RESERVE_MS = 2 * SHIP_ROUND_RESERVE_MS + 5 * MIN;

/** What a findings child (the fix after a review asked for changes) must leave
 *  on the clock: the re-review and one merge poll — one round's reserve and
 *  five minutes. Never the whole loop's: by the time a fix round runs, the
 *  first review has already happened, and holding two rounds back from a late
 *  fix would cap a pipeline that still has the time. */
export const SHIP_FIX_RESERVE_MS = SHIP_ROUND_RESERVE_MS + 5 * MIN;

/** The floor `validateShip` holds `ship.maxMinutes` to: the loop's reserve
 *  plus one round's — under it no coding child can both work and leave the
 *  review its time, so the config is refused at load rather than left to cap
 *  out on every unit. */
export const SHIP_MIN_MAX_MINUTES = (SHIP_LOOP_RESERVE_MS + SHIP_ROUND_RESERVE_MS) / MIN;

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

/** Whether `ref` is a unit branch of ship's own — `plan/<plan-id>/<unit-slug>`.
 *  A thread keeps the binding its last run opened a pull request on, so after
 *  a plan's unit it sits at that unit branch; a fresh task there must not take
 *  it as the base (the pull request would target the earlier unit). */
export function isUnitBranch(ref: string): boolean {
  return /^plan\/[^/]+\/[^/]+$/.test(ref);
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

// A compact sha-256 (FIPS 180-4) in plain TypeScript: this module is imported
// by the shim Worker, whose runtime has no `node:crypto`, so the generated
// plan id's hash cannot come from the Node API the preflight once used.
function sha256Hex(text: string): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
  ]);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array((((bytes.length + 8) >> 6) << 6) + 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  new DataView(padded.buffer).setBigUint64(padded.length - 8, BigInt(bytes.length) * 8n);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const view = new DataView(padded.buffer);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
      const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t]! + w[t]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** The generated plan's id (agent-ship item 16): `<slug>-<hash>` — the slug
 *  from the request text (24 characters in the branch alphabet, the bound the
 *  ship branch namer used), the hash the first six hex of the sha256 of the
 *  thread key, a newline and the normalised request text. Byte-identical text
 *  in the same thread is the same plan; a rephrase, however it starts, is a
 *  new one; two threads never share an id. Always fits `PLAN_ID_PATTERN`. */
export function generatedPlanId(text: string, threadKey: string): string {
  const normalised = text.toLowerCase().replace(/\s+/g, " ").trim();
  const slug =
    normalised
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX)
      .replace(/-+$/, "") || "task";
  const hash = sha256Hex(`${threadKey}\n${normalised}`).slice(0, 6);
  return `${slug}-${hash}`;
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

/** `findings` is the step after a verdict that requests changes: the review's
 *  findings dispatched into the unit thread as `agent:coding`, so the coding
 *  session there continues with them (record 0034). Never a `fix` child briefed
 *  from the review. */
export type RoundKind = "coding" | "review" | "findings";
export interface RoundRef {
  /** Round 0 is the coding round; review round n and its findings step share n. */
  index: number;
  kind: RoundKind;
}
export type ChildPreset = "coding" | "review";

/** The preset a round's child runs as: the findings step's run is a coding run. */
export function presetOf(kind: RoundKind): ChildPreset {
  return kind === "review" ? "review" : "coding";
}

/** How a spawn's child is briefed — ids only, never text. The bot composes the
 *  turn: the unit's contract, or the review turn from the pull request and the
 *  prior rounds' records, or the findings message from the review run's verdict. */
export type Brief =
  | { kind: "contract"; unit: string; rebase: { branch: string; onto: string } }
  | {
      kind: "review";
      unit: string;
      pr: number;
      headSha?: string;
      round: number;
      /** The previous review round's run and the coding run that answered its findings, for a re-review. */
      prior?: { reviewRunId: string; codingRunId?: string };
    }
  | { kind: "findings"; unit: string; pr: number; reviewRunId: string };

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
  | {
      type: "pr-check";
      step: string;
      /** Set after a coding child died: the bot opens the pull request from the
       *  pushed branch itself (title from the unit, body from this run's
       *  submitted description when the record holds one) instead of answering
       *  `none` over stranded work. */
      recover?: { runId: string };
    }
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
      /** Whether the review child's verdict landed on the pull request — the
       *  child's own record of its post, or GitHub's review list when the
       *  record is silent (http-ingress.md item 9). */
      reviewPosted?: boolean;
      /** Why the child recorded no post, when it recorded one it chose or failed. */
      reviewPostReason?: string;
      reviewHead?: string;
      /** The dispositions a coding run recorded, as it submitted them: the machine matches them to the round's findings. */
      dispositions?: FindingDisposition[];
      handoff?: boolean;
    };

/** What heads the unit's branch on GitHub: nothing, an open pull request, or —
 *  with no open one — a merged one, `sha` the merge commit on the base. */
export type PrCheck =
  | {
      state: "none";
      /** After a recover pr-check (a dead coding child): why nothing was
       *  recovered — `no_commits` (GitHub refused the create: nothing between
       *  the base and the head) or `no_base` (the instance names no base to
       *  open against, so no create was tried). Absent on a plain check. */
      unrecovered?: "no_commits" | "no_base";
    }
  | { state: "open"; prNumber: number; url: string; headSha?: string; autoMergeEnabled?: boolean }
  | { state: "merged"; prNumber: number; url: string; sha: string; mergedAt: string };

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

/** How one unit's pipeline ended — the truthful vocabulary the ship pipeline
 *  has, plus the merge's own: `merged` by the runner, or found merged (`by:
 *  other` — a person's merge, or an earlier attempt's that died after it, so
 *  the runner merged nothing), `merge_ready` for a person, `merge_refused` by
 *  the guards; `interrupted` a child the ledger closed; `refused` a child the
 *  authorize stage never started. */
export type UnitEnding =
  | { kind: "merged"; by: "runner"; pr: PrRef; sha: string; reviewRounds: number }
  | { kind: "merged"; by: "other"; pr: PrRef; sha: string; mergedAt: string; reviewRounds: number }
  | { kind: "merge_ready"; pr: PrRef; reviewRounds: number }
  | { kind: "merge_refused"; pr: PrRef; reason: string; reviewRounds: number }
  | { kind: "round_cap"; maxRounds: number; reviewRounds: number }
  | { kind: "wall_clock_cap"; remainingMs: number; reviewRounds: number; spent: ShipBudgetSpent }
  /** The wall clock capped AFTER the coding child opened or updated the pull
   *  request: the work stands and only the review is missing, so the ending
   *  names the pull request and "review pending" instead of calling the unit a
   *  failure — the re-issued attempt starts at the review round (`lastPush`). */
  | { kind: "review_pending"; pr: PrRef; headSha?: string; reviewRounds: number; spent: ShipBudgetSpent }
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

/** How the pipeline's budget went, in ms: the coding rounds' (round 0 and the
 *  findings steps), the review rounds', and everything else (branching,
 *  pr-checks, busy waits, merge polls) — reported on the cap endings so a
 *  person can see whether the cap or the child is the problem. */
export type ShipBudgetSpent = Readonly<Record<"coding" | "review" | "waiting", number>>;

export interface UnitPipelineInput {
  unit: { id: string; branch: string };
  repo: string;
  /** The pull request's base — the branch the unit is created from and rebased onto. */
  base: string;
  caps: ShipCaps;
  /** Each child preset's own wall-clock budget (its `maxMinutes`), the number a
   *  round's budget is clipped from — supplied by the bot, which holds the registry. */
  childMinutes: Readonly<Record<ChildPreset, number>>;
  /** Who merges: the instance's `merge` field as the plan route answers it —
   *  `runner` (a seeded plan, under its grant) or `person` (a task, or a
   *  record without the field). */
  merge: "runner" | "person";
  /** The instance's mark (agent-ship item 16): a generated one-unit plan — a
   *  `plan` with an id and no `path` — whose unit runs in the requesting
   *  thread and is re-issued with the request's own text, never a plan path. */
  generated: boolean;
  /** Resume at review: an open pull request of ship's own the requester named. */
  resume?: { pr: number; headSha?: string; url?: string };
  /** The head the previous attempt's coding child last pushed (a
   *  `review_pending` ending's `headSha`, carried on the unit's row): when the
   *  pre-check finds the open pull request still at exactly this head, there is
   *  nothing to code and the attempt starts at the review round. */
  lastPush?: string;
}

type Phase =
  /** Before anything is created: what already heads the branch — a merged pull request ends the unit here. */
  | { at: "pre-check" }
  | { at: "branch" }
  | { at: "spawn"; round: RoundRef; busy: number }
  | { at: "busy-wait"; round: RoundRef; runId?: string; n: number }
  /** `until`: when the child's budget plus the margin runs out, counted from the spawn's answer — the wait's last slice ends there. */
  | { at: "wait"; round: RoundRef; runId: string; n: number; until: number }
  | { at: "read"; round: RoundRef; runId: string; n: number; until: number }
  | {
      at: "pr-check";
      round: RoundRef;
      runId: string;
      childHead?: string;
      finalReply?: string;
      /** The coding child died (`failed` or `interrupted`) after it may have
       *  pushed: the pr-check recovers a pushed branch by opening its pull
       *  request; with nothing pushed the unit ends with the child's own reason. */
      dead?: "failed" | "interrupted";
    }
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
  /** Findings per review round and the dispositions the round's findings step
   *  recorded against them, keyed by the review round they belong to — finding
   *  ids are unique within one round only. A disposition naming an id the review
   *  never issued is dropped at the match (`matchDispositions`). */
  readonly findingsByRound: Readonly<Record<number, Finding[]>>;
  readonly dispositionsByRound: Readonly<Record<number, FindingDisposition[]>>;
  readonly reviewRunByRound: Readonly<Record<number, string>>;
  /** The coding run each round's findings step dispatched. */
  readonly findingsRunByRound: Readonly<Record<number, string>>;
  /** The last coding run (round 0's child or a findings step's): its record carries the unit's handoff. */
  readonly lastCodingRunId?: string;
  /** How the budget went so far, accrued as each answer moves the clock. */
  readonly spentMs: ShipBudgetSpent;
  readonly ending?: UnitEnding;
}

/** Past a child's budget, the parent asks the bot instead of waiting on. */
export const WAIT_MARGIN_MS = 5 * MIN;
/** One slice of a wait on a child. The child's budget plus the margin is
 *  walked in chunks with a `read-record` between them, so an event the engine
 *  never delivered — refused, lost, sent to an instance that had ended — costs
 *  one chunk of the runner's time, not the child's whole budget. Five minutes
 *  is the machine's one cadence for asking the bot what it cannot be told (the
 *  margin and the merge poll are the same number), and it keeps a round to a
 *  few steps: a coding child's 45 minutes are ten waits and ten reads. */
export const WAIT_CHUNK_MS = 5 * MIN;
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
    phase: { at: "pre-check" },
    reviewRounds: 0,
    spentMs: { coding: 0, review: 0, waiting: 0 },
    findingsByRound: {},
    dispositionsByRound: {},
    reviewRunByRound: {},
    findingsRunByRound: {},
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

/** The next slice of a wait: a chunk; the remainder when less is left before
 *  `until`, so the slices sum to exactly the budget plus the margin; and a
 *  chunk again once `until` has passed — an overdue child is its own budget's
 *  to end, and the runner asks about it every chunk, never in a zero-length wait. */
function waitSliceMs(clock: number, until: number): number {
  const remaining = until - clock;
  return remaining > 0 ? Math.min(WAIT_CHUNK_MS, remaining) : WAIT_CHUNK_MS;
}

/** The child's budget: its preset's own, clipped to the pipeline's remaining
 *  wall clock (agent-ship item 8's clip), never under the two minutes a
 *  spawn accepts. */
function budgetMinutesFor(s: UnitPipelineState, round: RoundRef): number {
  const headroom = remainingMs(s) - reserveFor(round.kind);
  return Math.max(2, Math.min(s.input.childMinutes[presetOf(round.kind)], Math.floor(headroom / MIN)));
}

/** What a child of each round kind leaves on the pipeline's clock: round 0's
 *  coding child the whole loop (two reviews and the merge poll,
 *  SHIP_LOOP_RESERVE_MS), a findings child the re-review and the merge poll
 *  (SHIP_FIX_RESERVE_MS), a review child nothing — the review is what the
 *  reserve was held for. */
function reserveFor(kind: RoundKind): number {
  switch (kind) {
    case "coding":
      return SHIP_LOOP_RESERVE_MS;
    case "findings":
      return SHIP_FIX_RESERVE_MS;
    case "review":
      return 0;
  }
}

const roundStep = (s: UnitPipelineState, round: RoundRef) => `${s.input.unit.id}/${round.index}/${round.kind}`;

function briefFor(s: UnitPipelineState, round: RoundRef): Brief {
  const unit = s.input.unit.id;
  if (round.kind === "coding")
    return { kind: "contract", unit, rebase: { branch: s.input.unit.branch, onto: s.input.base } };
  const pr = s.pr!.number;
  if (round.kind === "findings") return { kind: "findings", unit, pr, reviewRunId: s.reviewRunByRound[round.index]! };
  const priorReview = s.reviewRunByRound[round.index - 1];
  const priorCoding = s.findingsRunByRound[round.index - 1];
  return {
    kind: "review",
    unit,
    pr,
    ...(s.lastReviewHead !== undefined ? { headSha: s.lastReviewHead } : {}),
    round: round.index,
    ...(priorReview !== undefined
      ? { prior: { reviewRunId: priorReview, ...(priorCoding !== undefined ? { codingRunId: priorCoding } : {}) } }
      : {}),
  };
}

/** The dispositions a coding run recorded that answer `findings`, and the ids
 *  it named that the review never issued (agent-ship item 6). The tool records
 *  whatever the run submits, so the match is the runner's: `matched` is what the
 *  state, the report and the re-review carry, `dropped` what the re-review's
 *  note names. Pure and node-free, so the spawn route composing the re-review
 *  turn and this machine agree by construction. */
export function matchDispositions(
  findings: readonly Finding[],
  dispositions: readonly FindingDisposition[],
): { matched: FindingDisposition[]; dropped: string[] } {
  const issued = new Set(findings.map((f) => f.id));
  const matched = dispositions.filter((d) => issued.has(d.findingId));
  const dropped = [...new Set(dispositions.filter((d) => !issued.has(d.findingId)).map((d) => d.findingId))];
  return { matched, dropped };
}

/** The step the machine is at. Pure over the state: asked before every step
 *  and again after a replay, it names the same step for the same state. */
export function nextAction(s: UnitPipelineState): CoordinatorAction {
  const unit = s.input.unit.id;
  const p = s.phase;
  switch (p.at) {
    case "pre-check":
      return { type: "pr-check", step: `${unit}/pr-check` };
    case "branch":
      return { type: "branch", step: `${unit}/branch`, branch: s.input.unit.branch, from: s.input.base };
    case "spawn": {
      const preset = presetOf(p.round.kind);
      return {
        type: "spawn",
        step: roundStep(s, p.round),
        preset,
        round: p.round,
        budgetMinutes: budgetMinutesFor(s, p.round),
        brief: briefFor(s, p.round),
      };
    }
    case "busy-wait": {
      const step = `${roundStep(s, p.round)}/busy/${p.n}`;
      if (p.runId === undefined) return { type: "sleep", step, ms: BUSY_RETRY_MS };
      return { type: "wait", step, runId: p.runId, timeoutMs: waitSliceMs(s.clock, deadlineAt(s) + WAIT_MARGIN_MS) };
    }
    case "wait":
      return {
        type: "wait",
        step: `${roundStep(s, p.round)}/wait/${p.n}`,
        runId: p.runId,
        timeoutMs: waitSliceMs(s.clock, p.until),
      };
    case "read":
      return { type: "read-record", step: `${roundStep(s, p.round)}/read/${p.n}`, runId: p.runId };
    case "pr-check":
      return {
        type: "pr-check",
        step: `${roundStep(s, p.round)}/pr-check`,
        ...(p.dead !== undefined ? { recover: { runId: p.runId } } : {}),
      };
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

/** The cap's ending: `review_pending` when the clock ran out entering a
 *  review round with the child's pull request standing — the work shipped and
 *  only the review is missing — else the wall-clock cap. Both carry the split. */
function capEnding(s: UnitPipelineState, round?: RoundRef): UnitEnding {
  if (round?.kind === "review" && s.pr !== undefined)
    return {
      kind: "review_pending",
      pr: s.pr,
      ...(s.lastReviewHead !== undefined ? { headSha: s.lastReviewHead } : {}),
      reviewRounds: s.reviewRounds,
      spent: s.spentMs,
    };
  return { kind: "wall_clock_cap", remainingMs: remainingMs(s), reviewRounds: s.reviewRounds, spent: s.spentMs };
}

/** Start a round if the reservation holds (agent-ship item 8's check: a
 *  child clipped under the reserve cannot do useful work). */
function enterRound(s: UnitPipelineState, round: RoundRef, notes: CoordinatorNote[] = []): Transition {
  const remaining = remainingMs(s);
  if (remaining < SHIP_ROUND_RESERVE_MS) return end(s, capEnding(s, round), notes);
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

/** A coding run's confirmed end: round 0's child, or the run a findings step dispatched. */
function settleCoding(
  s: UnitPipelineState,
  round: RoundRef,
  runId: string,
  facts: Extract<ChildFacts, { finished: true }>,
): Transition {
  // Recorded before the checks below: a pull request is a fact a stop must
  // still report, and submitted dispositions are a fact no ending erases. The
  // run records whatever it submitted; only the dispositions that answer this
  // round's findings enter the state (agent-ship item 6).
  let next: UnitPipelineState = {
    ...s,
    ...(facts.pr !== undefined ? { pr: { number: facts.pr.number, url: facts.pr.url } } : {}),
    ...(round.kind === "findings" && facts.dispositions !== undefined
      ? {
          dispositionsByRound: {
            ...s.dispositionsByRound,
            [round.index]: matchDispositions(s.findingsByRound[round.index] ?? [], facts.dispositions).matched,
          },
        }
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
  // A failed coding child no longer aborts outright: the pr-check looks at the
  // branch first — a push before the death is recovered as the round's pull
  // request (agent-ship items 10 and 15), and only a branch with
  // nothing on it ends the unit with the child's own reason.
  if (facts.status === "failed")
    return { state: { ...next, phase: { at: "pr-check", round, runId, dead: "failed" } }, notes: [] };
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
    // not land left no approving review on the pull request. The reason is
    // the child's own when it recorded one; how to continue is the report's
    // re-issue line, in the runner's words (`renderUnitReport`).
    if (facts.reviewPosted === false)
      return end(
        next,
        {
          kind: "aborted",
          reason: `⚠️ The review approved, but the approval could not be posted${facts.reviewPostReason !== undefined ? ` (${facts.reviewPostReason})` : ""} — the pull request carries no approving review.`,
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
  // short-circuits the findings step, naming the review standing on the pull request.
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
  // The findings step (agent-ship item 7): the review's findings dispatched into
  // the unit thread as a coding run, under the review round's index. A run live
  // there is a person's (this machine awaited its own child's end), so the
  // spawn answers busy and the step waits under the unit's clock like any round.
  return enterRound(next, { index: round.index, kind: "findings" }, notes);
}

/** The unit's ending when its pull request is found merged — by a person, or
 *  by an earlier attempt of the plan that died after its merge: the unit is
 *  done and its dependents run on a base that carries it, and the runner
 *  merged nothing, so the ending says so (`by: other`). */
function foundMerged(
  s: UnitPipelineState,
  pr: Extract<PrCheck, { state: "merged" }>,
  notes: CoordinatorNote[] = [],
): Transition {
  const ref: PrRef = { number: pr.prNumber, url: pr.url };
  return end(
    { ...s, pr: ref },
    { kind: "merged", by: "other", pr: ref, sha: pr.sha, mergedAt: pr.mergedAt, reviewRounds: s.reviewRounds },
    notes,
  );
}

/** The pull request heading the branch after round 0 or a findings step. */
function settlePrCheck(s: UnitPipelineState, phase: Extract<Phase, { at: "pr-check" }>, pr: PrCheck): Transition {
  const { round } = phase;
  // The merge landed during the round: the child found nothing left to ship
  // (or shipped into a pull request a person merged under it). The round
  // completed without a pull request of its own, and the unit is done.
  if (pr.state === "merged") return foundMerged(s, pr, [roundNote(round, "completed")]);
  if (pr.state === "none") {
    // A dead child left nothing on the branch to recover: the unit ends with
    // the child's own reason — never the budget clip.
    if (phase.dead === "interrupted")
      return end(s, { kind: "interrupted", round, runId: phase.runId, reviewRounds: s.reviewRounds }, [
        roundNote(round, "aborted"),
      ]);
    if (phase.dead === "failed") {
      // The abort repeats the bot's reason for recovering nothing, and claims
      // no more than the answer carried.
      const why =
        pr.unrecovered === "no_commits"
          ? `nothing heads \`${s.input.unit.branch}\`: no commits were pushed, so there was no work to recover`
          : pr.unrecovered === "no_base"
            ? `\`${s.input.unit.branch}\` could not be given a pull request: the instance names no base branch to open it against, so whatever was pushed stays on the branch`
            : `the pr-check found no pull request heading \`${s.input.unit.branch}\`, so nothing was recovered`;
      return end(
        s,
        {
          kind: "aborted",
          reason: `⚠️ The coding child of round ${round.index} (run ${phase.runId}) ended \`failed\` — its run page has the error — and ${why}.`,
          round,
          reviewRounds: s.reviewRounds,
        },
        [roundNote(round, "aborted")],
      );
    }
    const reason =
      round.index === 0
        ? `⚠️ Ship ended at round 0: the coding round ended without opening a pull request (a clarifying question, a budget write-up, an unproven push or a description-less push ends the pipeline here). No review round ran.`
        : `⚠️ Round ${round.index}'s findings step left no open pull request heading \`${s.input.unit.branch}\` — the pull request was closed out from under the pipeline and none was reopened, so there is nothing to re-review.`;
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
  if (round.kind === "findings") {
    // Nothing repushed → nothing to re-review, unless every finding of the
    // last review was declined on the record: that re-review verifies the
    // arguments and may concede.
    const codingHead = normalizeHead(head);
    const reviewedAt = normalizeHead(s.lastReviewHead);
    if (codingHead !== undefined && reviewedAt !== undefined && sameCommit(codingHead, reviewedAt)) {
      // A findings child that died before it pushed: the recover pr-check found
      // the round's own pull request, still at the reviewed head. The unit
      // ends with the child's own reason — the ship-restart note for a bot
      // roll, the failure for a failed run — never as the round's inaction.
      if (phase.dead === "interrupted")
        return end(next, { kind: "interrupted", round, runId: phase.runId, reviewRounds: next.reviewRounds }, [
          roundNote(round, "aborted"),
        ]);
      if (phase.dead === "failed")
        return end(
          next,
          {
            kind: "aborted",
            reason: `⚠️ The findings child of round ${round.index} (run ${phase.runId}) ended \`failed\` — its run page has the error — and the branch still sits at \`${codingHead.slice(0, 7)}\`, the commit the review already read, so nothing new was pushed to re-review.`,
            round,
            reviewRounds: next.reviewRounds,
          },
          [roundNote(round, "aborted")],
        );
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
            reason: `⚠️ Round ${round.index}'s findings step produced no new head — the branch still sits at \`${codingHead.slice(0, 7)}\`, the commit the review already read, and not every finding was declined on the record, so there is nothing new to re-review.`,
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

/** Move the clock and charge the elapsed time to the budget's bucket: a phase
 *  inside a coding or findings round is the coding child's time, a review
 *  round's is the review's, everything else — the pre-check, the branch, busy
 *  waits, the merge polls — is waiting. The split rides the cap endings. */
function withClock(s: UnitPipelineState, at: number): UnitPipelineState {
  const delta = Math.max(0, at - s.clock);
  const round = "round" in s.phase ? s.phase.round : undefined;
  const bucket = round === undefined ? "waiting" : round.kind === "review" ? "review" : "coding";
  return { ...s, clock: at, spentMs: { ...s.spentMs, [bucket]: s.spentMs[bucket] + delta } };
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
  const clocked: UnitPipelineState = "at" in ret ? withClock(s, ret.at) : s;
  const p = s.phase;
  switch (p.at) {
    case "pre-check": {
      // A pull request merged before this attempt reached the unit — a
      // person's merge, or an earlier attempt's that died after it — makes the
      // unit done before a branch or a child: nothing to run. Anything else is
      // round 0's to work on: an open pull request is rebased and re-described
      // by the coding child and adopted at the round's own pr-check.
      const r = ret as Extract<StepReturn, { type: "pr-check" }>;
      if (r.pr.state === "merged") return foundMerged(clocked, r.pr);
      // The open pull request still heads at the child's own last push (the
      // previous attempt ended `review_pending`): nothing to code, so the
      // attempt adopts it and starts at the review round — never a fresh
      // coding round on an already-shipped pull request.
      if (r.pr.state === "open") {
        const head = normalizeHead(r.pr.headSha);
        const lastPush = normalizeHead(s.input.lastPush);
        if (head !== undefined && lastPush !== undefined && sameCommit(head, lastPush))
          return nextReview({
            ...clocked,
            pr: { number: r.pr.prNumber, url: r.pr.url },
            lastReviewHead: head,
          });
      }
      return { state: { ...clocked, phase: { at: "branch" } }, notes: [] };
    }
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
          // The child's budget runs from the spawn's answer; the wait walks it, plus the margin, in chunks.
          const until = clocked.clock + budgetMinutesFor(s, p.round) * MIN + WAIT_MARGIN_MS;
          const runs =
            p.round.kind === "review"
              ? { reviewRunByRound: { ...s.reviewRunByRound, [p.round.index]: r.runId } }
              : p.round.kind === "findings"
                ? {
                    findingsRunByRound: { ...s.findingsRunByRound, [p.round.index]: r.runId },
                    lastCodingRunId: r.runId,
                  }
                : { lastCodingRunId: r.runId };
          return {
            state: { ...clocked, ...runs, phase: { at: "wait", round: p.round, runId: r.runId, n: 1, until } },
            notes: [roundNote(p.round, "started")],
          };
        }
        case "busy": {
          // Another run holds the unit's thread: wait for its end, then ask
          // again — unless the pipeline's wall clock ran out meanwhile.
          if (remainingMs(clocked) < SHIP_ROUND_RESERVE_MS) return end(clocked, capEnding(clocked, p.round));
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
        state: { ...s, phase: { at: "read", round: p.round, runId: p.runId, n: p.n, until: p.until } },
        notes: [],
      };
    case "read": {
      const r = ret as Extract<StepReturn, { type: "read-record" }>;
      if (!r.run.finished)
        return {
          state: {
            ...clocked,
            phase: { at: "wait", round: p.round, runId: p.runId, n: p.n + 1, until: p.until },
          },
          notes: [],
        };
      if (r.run.status === "interrupted") {
        // A dead CODING child may have pushed before the ledger closed it: the
        // pr-check recovers the branch. A review child has nothing on the
        // branch to recover, so its interruption still ends the unit at once.
        if (p.round.kind !== "review")
          return {
            state: { ...clocked, phase: { at: "pr-check", round: p.round, runId: p.runId, dead: "interrupted" } },
            notes: [],
          };
        return end(clocked, { kind: "interrupted", round: p.round, runId: p.runId, reviewRounds: s.reviewRounds }, [
          roundNote(p.round, "aborted"),
        ]);
      }
      return p.round.kind === "review"
        ? settleReview(clocked, p.round, r.run)
        : settleCoding(clocked, p.round, p.runId, r.run);
    }
    case "pr-check":
      return settlePrCheck(clocked, p, (ret as Extract<StepReturn, { type: "pr-check" }>).pr);
    case "merge": {
      const r = ret as Extract<StepReturn, { type: "merge" }>;
      if (r.outcome === "merged")
        return end(clocked, { kind: "merged", by: "runner", pr: p.pr, sha: r.sha, reviewRounds: s.reviewRounds });
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
 *  the one that round's findings step recorded, else one carried forward
 *  unchanged from an earlier round — never across a reused id, which inherits nothing. */
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

/** How the budget went, in the card's words: coding, review, waiting minutes. */
function budgetSplitLine(spent: ShipBudgetSpent, maxMinutes: number): string {
  const min = (ms: number) => Math.round(ms / MIN);
  return `Budget split (${maxMinutes} min): coding ${min(spent.coding)} min, review ${min(spent.review)} min, waiting ${min(spent.waiting)} min.`;
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

/** The thread's report for a unit's ending — the ship pipeline's own words
 *  for the endings it has, and the merge's for the ones it gains. */
/** What the driver read at the approved head when it composed a `merge_ready`
 *  ending (agent-ship item 9): the pull request's own auto-merge fact, or the
 *  merge that already happened — auto-merge or a person can merge between the
 *  approval and the ending, and the report must describe the pull request as
 *  it is, never a gate that has already passed. */
export interface MergeReadyFacts {
  autoMergeEnabled?: boolean;
  merged?: { sha: string; mergedAt: string };
}

export function renderUnitReport(s: UnitPipelineState, facts?: MergeReadyFacts): string {
  const e = s.ending;
  if (!e) return "";
  const rounds = `${e.reviewRounds} review round${e.reviewRounds === 1 ? "" : "s"}`;
  const prUrl = s.pr?.url;
  const prLine = prUrl ? ` PR: ${prUrl}` : "";
  // The re-issue line keys on the instance's mark, never on who merges: a
  // generated plan is re-issued with the request's own text, a seeded one by
  // its plan path — and a seeded plan can be a person's merge too.
  const reissue = s.input.generated
    ? `To continue, re-issue \`agent:ship\` in this thread with the same text${prUrl ? ` and include the PR URL (${prUrl})` : " — include the PR URL if a PR exists"}.`
    : `The unit's dependents in this plan stay blocked; the unit runs again when the plan is re-issued.`;
  const declined = [...(s.dispositionsByRound[e.reviewRounds - 1] ?? [])].filter((d) => d.disposition === "declined");
  const declinedLine = `Declined findings: ${declined.length > 0 ? declined.map((d) => `${d.findingId}${d.note ? ` — ${d.note}` : ""}`).join("; ") : "none"}`;
  const verdictLine = `Verdict: LGTM${s.lastVerdictSummary ? ` — ${s.lastVerdictSummary}` : ""}`;
  const join = (parts: Array<string | undefined>) => parts.filter(Boolean).join("\n\n");
  switch (e.kind) {
    case "merged":
      if (e.by === "other")
        return `✅ Already merged: ${e.pr.url} (merge commit \`${e.sha.slice(0, 7)}\`, merged ${e.mergedAt}) — the pull request heading \`${s.input.unit.branch}\` was merged before this attempt reached it, by a person or by an earlier attempt of this plan; the runner merged nothing. The unit is done and its dependents start on a base that carries it.`;
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
        // What the driver read at the approved head when it composed this
        // ending (agent-ship item 9): a merge that already happened is named
        // as such, else the pull request's own auto-merge fact, else the gate.
        facts?.merged
          ? `Already merged: ${e.pr.url} (merge commit \`${facts.merged.sha.slice(0, 7)}\`, merged ${facts.merged.mergedAt}) — auto-merge or a person merged it after the approval; the runner merged nothing.`
          : facts?.autoMergeEnabled
            ? "Auto-merge is on for this pull request: the approval merges it once checks pass."
            : "Remaining gate: a person's merge — the runner merges only when the instance's `merge` field says runner, and ship never approves.",
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
        budgetSplitLine(e.spent, s.input.caps.maxMinutes),
        splitReport(s),
        reissue,
      ]);
    case "review_pending":
      return join([
        `⏳ Review pending: the coding child shipped ${e.pr.url}${e.headSha !== undefined ? ` (head \`${e.headSha.slice(0, 7)}\`)` : ""} but the remaining pipeline time cannot hold the review round — the work stands, only the review is missing. The next attempt starts at the review round while the pull request still heads at the child's own last push.`,
        budgetSplitLine(e.spent, s.input.caps.maxMinutes),
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
        `⚠️ Review round ${e.round.index} ended without a submitted verdict (budget, refusal, or stop) — ship never converts that into a request for changes, so no findings step ran.`,
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
