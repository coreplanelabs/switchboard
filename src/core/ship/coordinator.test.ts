import { describe, expect, it } from "vitest";
import { shipRoundHeader } from "../shipPipeline.js";
import { ASKS } from "../budgets.js";
import type { Finding, FindingDisposition } from "../reviewVerdict.js";
import {
  applyReturn,
  cursorFinished,
  generatedPlanId,
  matchDispositions,
  MERGE_WAIT_CHUNK_MS,
  nextAction,
  openPlanCursor,
  openUnitPipeline,
  parsePlanBranch,
  parsePlanGraph,
  PLAN_ID_PATTERN,
  parseShipPlanRequest,
  planIdOf,
  planInstanceId,
  readyUnits,
  renderUnitReport,
  shipInterruptedNote,
  settleUnit,
  startUnit,
  unitBranch,
  unitSlug,
  WAIT_CHUNK_MS,
  WAIT_MARGIN_MS,
  type ChildFacts,
  type CoordinatorAction,
  type CoordinatorNote,
  type StepReturn,
  type UnitPipelineInput,
  type UnitPipelineState,
} from "./coordinator.js";

// Feature: docs/reference/specs/agent-ship.md item 15 — the plan runner's pure
// state machine. The coordinator (a Workflow instance in the bot's shim Worker)
// has no model turn and holds no credential: it asks the bot for one step at a
// time and feeds the answer back. Everything it decides — which step is next,
// what a child's end means, when a round starts and when the pipeline ends —
// is a pure function over the step returns, so every ending the ship
// pipeline has today is reproduced here on a scripted sequence of answers,
// with no clock read and no I/O.

const PLAN = `---
title: Fixture program - Plan
status: proposed
---

# Fixture program - Plan

## Implementation Units

### U10. Warm the cache on wake

- **Goal**: A wake never starts cold.
- **Dependencies**: none.
- **Files**: \`src/execution/wake.ts\`.

### U11. Retire the alarm

- **Goal**: No lifecycle timer exists.
- **Dependencies**: U10.
- **Files**: \`src/execution/alarm.ts\`.

### U12. Measure the disk

- **Goal**: Every resident reports its disk.
- **Dependencies**: U10; U20 to U22 (the profile a child is dispatched with).
- **Files**: \`src/execution/disk.ts\`.

### U13. The dashboard row

- **Goal**: The dashboard shows the disk.
- **Dependencies**: U11, U12.
- **Files**: \`web/src/pages/residents.ts\`.

### U20. The machine class

- **Goal**: Every preset names its machine.
- **Dependencies**: none (a baseline item).

### U21. The identity axis

- **Goal**: Every preset names its identity.
- **Dependencies**: U20 (the class a boundary caps).

### U22. The budget field

- **Goal**: A budget is a profile field.
- **Dependencies**: U21.

---

## Verification Contract
`;

const PLAN_ID = "feat-fixture-program-plan";
const REPO = "acme/api";
const PR_URL = "https://github.com/acme/api/pull/7";
const HEAD_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const HEAD_B = "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1";
const HEAD_C = "c3d4e5f60718293a4b5c6d7e8f9012345678a1b2";
const T0 = 1_700_000_000_000;
const MIN = 60_000;

const FINDING: Finding = { id: "F1", severity: "minor", file: "src/a.ts", line: 3, title: "off by one" };
const FIXED: FindingDisposition = { findingId: "F1", disposition: "fixed", note: "counted from zero" };
const DECLINED: FindingDisposition = { findingId: "F1", disposition: "declined", note: "the loop is exclusive" };

function input(over: Partial<UnitPipelineInput> = {}): UnitPipelineInput {
  return {
    unit: { id: "U10", branch: unitBranch(PLAN_ID, unitSlug({ id: "U10", title: "Warm the cache on wake" })) },
    repo: REPO,
    base: "main",
    caps: { maxRounds: 3, maxMinutes: 240 },
    merge: "runner",
    generated: false,
    ...over,
  };
}

/** A step's answer without its step name — `Omit` over each member of the union, not over their intersection. */
type Answer = StepReturn extends infer R ? (R extends StepReturn ? Omit<R, "step"> & { step?: string } : never) : never;

/** The scripted driver: feeds each return to the machine and collects the notes. */
class Driver {
  state: UnitPipelineState;
  readonly notes: CoordinatorNote[] = [];
  constructor(state: UnitPipelineState) {
    this.state = state;
  }
  get action(): CoordinatorAction {
    return nextAction(this.state);
  }
  /** Answer the current action with `ret` (its step filled in from the action). */
  answer(ret: Answer): CoordinatorAction {
    const step = ret.step ?? this.action.step;
    const out = applyReturn(this.state, { ...ret, step } as StepReturn);
    this.state = out.state;
    this.notes.push(...out.notes);
    return this.action;
  }
  rounds(): string[] {
    return this.notes
      .filter((n): n is Extract<CoordinatorNote, { type: "round" }> => n.type === "round")
      .map((n) => `${n.index} ${n.agent} ${n.outcome}`);
  }
}

const finished = (facts: Omit<Extract<ChildFacts, { finished: true }>, "finished">): ChildFacts => ({
  finished: true,
  ...facts,
});

/** Run a child round to its confirmed end: the spawn, the wait (an event) and the read-record. */
function runChild(d: Driver, runId: string, facts: ChildFacts, at: number): CoordinatorAction {
  expect(d.action.type).toBe("spawn");
  d.answer({ type: "spawn", outcome: "spawned", runId, at });
  expect(d.action).toMatchObject({ type: "wait", runId });
  d.answer({ type: "wait", outcome: "event" });
  expect(d.action).toMatchObject({ type: "read-record", runId });
  return d.answer({ type: "read-record", run: facts, at });
}

/** A unit at its branch step: the pipeline opened and the pre-check answered `none` — no pull request heads the branch yet. */
function fresh(inp: UnitPipelineInput, at = T0): Driver {
  const d = new Driver(openUnitPipeline(inp, at));
  expect(d.action).toEqual({ type: "pr-check", step: `${inp.unit.id}/pr-check` });
  d.answer({ type: "pr-check", pr: { state: "none" }, at });
  return d;
}

/** Round 0 through its open pull request: the machine is then about to spawn review round 1. */
function throughRoundZero(d: Driver, at = T0 + 10 * MIN): CoordinatorAction {
  expect(d.action.type).toBe("branch");
  d.answer({ type: "branch", ok: true, at: T0 });
  runChild(d, "run-c0", finished({ status: "completed", pr: { number: 7, url: PR_URL, created: true } }), at);
  expect(d.action.type).toBe("pr-check");
  return d.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A }, at });
}

describe("the plan graph — units, their dependencies, their branches", () => {
  it("parsePlanGraph: every `### U<n>.` heading in order, its dependencies from the Dependencies bullet (lists, `to` ranges, `none`), each unit's slug and branch", () => {
    const graph = parsePlanGraph(PLAN, PLAN_ID);
    expect(graph.planId).toBe(PLAN_ID);
    expect(graph.units.map((u) => u.id)).toEqual(["U10", "U11", "U12", "U13", "U20", "U21", "U22"]);
    const by = Object.fromEntries(graph.units.map((u) => [u.id, u]));
    expect(by.U10!.dependsOn).toEqual([]);
    expect(by.U11!.dependsOn).toEqual(["U10"]);
    expect(by.U12!.dependsOn).toEqual(["U10", "U20", "U21", "U22"]);
    expect(by.U13!.dependsOn).toEqual(["U11", "U12"]);
    expect(by.U20!.dependsOn).toEqual([]);
    expect(by.U21!.dependsOn).toEqual(["U20"]);
    expect(by.U10!.slug).toBe("u10-warm-the-cache-on-wake");
    expect(by.U10!.branch).toBe(`plan/${PLAN_ID}/u10-warm-the-cache-on-wake`);
  });

  it("unitSlug is the lowercase id and a bounded title slug; unitBranch is `plan/<plan-id>/<unit-slug>`; parsePlanBranch reads it back and refuses every other shape", () => {
    expect(unitSlug({ id: "U13", title: "The ship Workflow in the shim Worker" })).toBe("u13-the-ship-workflow-in-the");
    expect(unitSlug({ id: "U10", title: "!!!" })).toBe("u10");
    expect(unitBranch("p-1", "u13-x")).toBe("plan/p-1/u13-x");
    expect(parsePlanBranch("plan/p-1/u13-x")).toEqual({ planId: "p-1", unitSlug: "u13-x" });
    for (const bad of ["ship/fix-abc123", "plan/p-1", "plan/p-1/u13/extra", "main", "plan//u13", "plans/p-1/u13"])
      expect(parsePlanBranch(bad), bad).toBeUndefined();
  });

  it("planIdOf is the plan file's name without its extension, lowercase, in the branch alphabet; anything else throws naming the path", () => {
    expect(planIdOf("docs/plans/feat-orchestration-program-plan.md")).toBe("feat-orchestration-program-plan");
    expect(planIdOf("Fixture-Plan.md")).toBe("fixture-plan");
    expect(() => planIdOf("docs/plans/a plan.md")).toThrow(/a plan\.md/);
    expect(() => planIdOf("docs/plans/")).toThrow();
  });

  it("planInstanceId names the plan and, from the second, its attempt, so a second runner for one attempt meets the engine's duplicate-id refusal and a re-issue gets the next id", () => {
    expect(planInstanceId(PLAN_ID)).toBe(`plan-${PLAN_ID}`);
    expect(planInstanceId(PLAN_ID, 1)).toBe(`plan-${PLAN_ID}`);
    expect(planInstanceId(PLAN_ID, 2)).toBe(`plan-${PLAN_ID}-2`);
    expect(planInstanceId(PLAN_ID, 12)).toBe(`plan-${PLAN_ID}-12`);
    expect(planInstanceId("x".repeat(200))).toHaveLength(100);
    expect(planInstanceId("x".repeat(200), 3)).toHaveLength(100);
    expect(planInstanceId("x".repeat(200), 3).endsWith("-3")).toBe(true);
  });

  it("generatedPlanId is deterministic per (thread, text): the same for identical text and thread, different across threads, different for two texts sharing a 24-character prefix, and a plan id for a long or punctuated request", () => {
    const text = "warm the cache on wake";
    expect(generatedPlanId(text, "slack:C1:1.0")).toBe(generatedPlanId(text, "slack:C1:1.0"));
    expect(generatedPlanId(text, "slack:C1:1.0")).not.toBe(generatedPlanId(text, "slack:C2:9.9"));
    // Two requests sharing their first 24 normalised characters: the slug is
    // the same, the hash of the text tells them apart.
    const a = generatedPlanId("warm the cache on wake, then trim the log", "slack:C1:1.0");
    const b = generatedPlanId("warm the cache on wake, then retire the alarm", "slack:C1:1.0");
    expect(a).not.toBe(b);
    expect(a.slice(0, 24)).toBe(b.slice(0, 24));
    const long = generatedPlanId(`please ${"really ".repeat(40)}fix it`, "slack:C1:1.0");
    expect(long).toMatch(PLAN_ID_PATTERN);
    expect(generatedPlanId("🚀!!! — ??", "slack:C1:1.0")).toMatch(PLAN_ID_PATTERN);
    expect(planInstanceId(generatedPlanId(text, "slack:C1:1.0")).length).toBeLessThanOrEqual(100);
  });

  it("parseShipPlanRequest reads `plan <path> [units U<n>, U<m>]` and nothing else", () => {
    expect(parseShipPlanRequest("plan docs/plans/x.md")).toEqual({ planPath: "docs/plans/x.md" });
    expect(parseShipPlanRequest("plan docs/plans/x.md units U13, U14 U15")).toEqual({
      planPath: "docs/plans/x.md",
      units: ["U13", "U14", "U15"],
    });
    expect(parseShipPlanRequest("plan docs/plans/x.md unit U13")).toEqual({
      planPath: "docs/plans/x.md",
      units: ["U13"],
    });
    expect(parseShipPlanRequest("fix the login redirect")).toBeUndefined();
    expect(parseShipPlanRequest("plan the release")).toBeUndefined();
    expect(parseShipPlanRequest("plan docs/plans/x.md and then deploy")).toBeUndefined();
  });
});

describe("the plan cursor — ready units in dependency order, a failure blocking its dependents", () => {
  const graph = parsePlanGraph(PLAN, PLAN_ID);

  it("with no selection every unit is in play and the ready ones are those whose dependencies are done, in plan order", () => {
    let cursor = openPlanCursor(graph);
    expect(cursor.order).toEqual(["U10", "U11", "U12", "U13", "U20", "U21", "U22"]);
    expect(readyUnits(graph, cursor)).toEqual(["U10", "U20"]);
    cursor = startUnit(graph, cursor, "U10");
    expect(readyUnits(graph, cursor)).toEqual(["U20"]);
    cursor = settleUnit(graph, cursor, "U10", "done");
    expect(readyUnits(graph, cursor)).toEqual(["U11", "U20"]);
    cursor = settleUnit(graph, startUnit(graph, cursor, "U20"), "U20", "done");
    cursor = settleUnit(graph, startUnit(graph, cursor, "U21"), "U21", "done");
    cursor = settleUnit(graph, startUnit(graph, cursor, "U22"), "U22", "done");
    expect(readyUnits(graph, cursor)).toEqual(["U11", "U12"]);
    expect(cursorFinished(cursor)).toBe(false);
  });

  it("a selection narrows the plan to those units; a dependency outside the selection counts as satisfied (the requester's assertion), one inside must be done", () => {
    let cursor = openPlanCursor(graph, ["U13", "U12", "U11"]);
    expect(cursor.order).toEqual(["U11", "U12", "U13"]);
    // U10 and U20–U22 are outside the selection: U11 and U12 are ready at once; U13 waits on both.
    expect(readyUnits(graph, cursor)).toEqual(["U11", "U12"]);
    cursor = settleUnit(graph, startUnit(graph, cursor, "U11"), "U11", "done");
    expect(readyUnits(graph, cursor)).toEqual(["U12"]);
    cursor = settleUnit(graph, startUnit(graph, cursor, "U12"), "U12", "done");
    expect(readyUnits(graph, cursor)).toEqual(["U13"]);
    cursor = settleUnit(graph, startUnit(graph, cursor, "U13"), "U13", "done");
    expect(readyUnits(graph, cursor)).toEqual([]);
    expect(cursorFinished(cursor)).toBe(true);
  });

  it("a unit that ends unmerged blocks its dependents transitively and leaves every other ready unit in play", () => {
    let cursor = openPlanCursor(graph, ["U10", "U11", "U12", "U13", "U20"]);
    cursor = settleUnit(graph, startUnit(graph, cursor, "U10"), "U10", "done");
    cursor = settleUnit(graph, startUnit(graph, cursor, "U11"), "U11", "failed");
    expect(cursor.status.U11).toBe("failed");
    expect(cursor.status.U13).toBe("blocked");
    expect(cursor.status.U12).toBe("pending");
    // U12 still waits on U20 (selected, pending); U21 and U22 are outside the selection.
    expect(readyUnits(graph, cursor)).toEqual(["U20"]);
    cursor = settleUnit(graph, startUnit(graph, cursor, "U20"), "U20", "done");
    expect(readyUnits(graph, cursor)).toEqual(["U12"]);
    cursor = settleUnit(graph, startUnit(graph, cursor, "U12"), "U12", "done");
    expect(readyUnits(graph, cursor)).toEqual([]);
    expect(cursorFinished(cursor)).toBe(true);
  });

  it("refuses an unknown unit naming the plan's units, a unit started twice, and a cycle", () => {
    expect(() => openPlanCursor(graph, ["U99"])).toThrow(/U99.*U10, U11, U12, U13, U20, U21, U22/);
    const cursor = startUnit(graph, openPlanCursor(graph), "U10");
    expect(() => startUnit(graph, cursor, "U10")).toThrow(/U10/);
    expect(() => startUnit(graph, cursor, "U11")).toThrow(/U11.*not ready/);
    const cyclic = parsePlanGraph(
      `### U10. A\n\n- **Dependencies**: U11.\n\n### U11. B\n\n- **Dependencies**: U10.\n`,
      "cyclic",
    );
    expect(() => openPlanCursor(cyclic)).toThrow(/cycle/);
  });
});

describe("the unit pipeline — every ending the ship pipeline has, on step returns", () => {
  it("merge-ready in one round on a plan branch: branch → coding → pr-check → review → approve → merge, the round boundaries as the card draws them", () => {
    const d = fresh(input());
    expect(d.action).toMatchObject({ type: "branch", step: "U10/branch", branch: input().unit.branch, from: "main" });
    d.answer({ type: "branch", ok: true, at: T0 });
    // The spawn carries the key's step, the preset, its clipped budget and the brief (ids only).
    expect(d.action).toMatchObject({
      type: "spawn",
      step: "U10/0/coding",
      preset: "coding",
      round: { index: 0, kind: "coding" },
      budgetMinutes: ASKS.coding,
      brief: { kind: "contract", unit: "U10", rebase: { branch: input().unit.branch, onto: "main" } },
    });
    d.answer({ type: "spawn", outcome: "spawned", runId: "run-c0", at: T0 });
    // The wait is one chunk of the child's budget, under the child's run — the durable half walks the rest.
    expect(d.action).toMatchObject({
      type: "wait",
      step: "U10/0/coding/wait/1",
      runId: "run-c0",
      timeoutMs: WAIT_CHUNK_MS,
    });
    d.answer({ type: "wait", outcome: "event" });
    expect(d.action).toMatchObject({ type: "read-record", step: "U10/0/coding/read/1", runId: "run-c0" });
    d.answer({
      type: "read-record",
      run: finished({ status: "completed", pr: { number: 7, url: PR_URL, created: true }, handoff: true }),
      at: T0 + 10 * MIN,
    });
    expect(d.action).toMatchObject({ type: "pr-check", step: "U10/0/coding/pr-check" });
    d.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A }, at: T0 + 10 * MIN });
    expect(d.action).toMatchObject({
      type: "spawn",
      step: "U10/1/review",
      preset: "review",
      round: { index: 1, kind: "review" },
      budgetMinutes: ASKS.review,
      brief: { kind: "review", pr: 7, headSha: HEAD_A, round: 1, unit: "U10" },
    });
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "approve", summary: "clean", findings: [] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(d.action).toMatchObject({ type: "merge", step: "U10/merge/1", prNumber: 7, headSha: HEAD_A });
    d.answer({ type: "merge", outcome: "merged", sha: HEAD_B, at: T0 + 21 * MIN });
    expect(d.action).toMatchObject({
      type: "end",
      ending: { kind: "merged", pr: { number: 7, url: PR_URL }, sha: HEAD_B },
    });
    expect(d.rounds()).toEqual(["0 coding started", "0 coding pr_opened", "1 review started", "1 review approve"]);
    // The card's header for each boundary is the one `shipRoundHeader` draws.
    expect(shipRoundHeader({ index: 0, agent: "coding" })).toBe("Round 0 — coding");
    expect(shipRoundHeader({ index: 1, agent: "review" })).toBe("Round 1 — review");
    expect(d.notes.at(-1)).toMatchObject({ type: "ended", ending: { kind: "merged" } });
    expect(d.state.lastCodingRunId).toBe("run-c0");
    const report = renderUnitReport(d.state);
    expect(report).toContain("✅ Merged after 1 review round");
    expect(report).toContain(PR_URL);
    expect(report).toContain("plan:merge");
  });

  it("merge-ready under `merge: person` waits for a person: the machine ends merge_ready, never asks for a merge, and the remaining-gate line names the instance's field, not the branch's shape", () => {
    const d = fresh(input({ merge: "person", generated: true }));
    throughRoundZero(d);
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "approve", summary: "clean", findings: [] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "merge_ready", pr: { number: 7 } } });
    const report = renderUnitReport(d.state);
    expect(report).toContain("✅ Merge-ready after 1 review round");
    expect(report).toContain("Verdict: LGTM — clean");
    expect(report).toContain("Declined findings: none");
    expect(report).toContain("a person's merge");
    // The gate is the instance's field, not a branch-name derivation.
    expect(report).toContain("the runner merges only when the instance's `merge` field says runner");
    // The pull request's own auto-merge fact at the approved head (agent-ship
    // item 9): when the facts carry it, the report names it in place of the
    // pending-person gate; without it (or with it off) the report is unchanged.
    const withAutoMerge = renderUnitReport(d.state, { autoMergeEnabled: true });
    expect(withAutoMerge).toContain("Auto-merge is on for this pull request: the approval merges it once checks pass.");
    expect(withAutoMerge).not.toContain("Remaining gate");
    expect(renderUnitReport(d.state, { autoMergeEnabled: false })).toBe(report);
    expect(renderUnitReport(d.state, {})).toBe(report);
    // Auto-merge (or a person) can fire between the approval and the ending:
    // the facts then say `merged`, and the report names the merge instead of a
    // gate that has already passed — whatever the auto-merge flag said.
    const merged = renderUnitReport(d.state, {
      merged: { sha: "abcdef0123456789abcdef0123456789abcdef01", mergedAt: "2026-09-16T00:46:19Z" },
    });
    expect(merged).toContain("✅ Merge-ready after 1 review round");
    expect(merged).toContain(
      "Already merged: https://github.com/acme/api/pull/7 (merge commit `abcdef0`, merged 2026-09-16T00:46:19Z) — auto-merge or a person merged it after the approval; the runner merged nothing.",
    );
    expect(merged).not.toContain("Remaining gate");
    expect(merged).not.toContain("Auto-merge is on");
    expect(report).not.toContain("only a plan branch");
    // The checks at the approved head decide the headline (record 0055):
    // a failed check is never called merge-ready, a pending one is named, and
    // green is said in so many words; without the fact the report is unchanged.
    const red = renderUnitReport(d.state, { checks: { total: 3, pending: [], failed: ["ci / package"] } });
    expect(red).toContain("⚠️ Approved but not merge-ready after 1 review round: https://github.com/acme/api/pull/7");
    expect(red).toContain("CI is red at the approved head: ci / package");
    expect(red).not.toContain("✅ Merge-ready");
    expect(red).toContain("Verdict: LGTM — clean");
    const pending = renderUnitReport(d.state, { checks: { total: 3, pending: ["ci / bot", "ci / web"], failed: [] } });
    expect(pending).toContain("✅ Approved after 1 review round: https://github.com/acme/api/pull/7");
    expect(pending).toContain("checks pending at the approved head: ci / bot, ci / web");
    expect(pending).not.toContain("Merge-ready");
    const green = renderUnitReport(d.state, { checks: { total: 3, pending: [], failed: [] } });
    expect(green).toContain("✅ Merge-ready after 1 review round: https://github.com/acme/api/pull/7");
    expect(green).toContain("3 checks green at the approved head");
    expect(renderUnitReport(d.state, { checks: { total: 0, pending: [], failed: [] } })).toContain(
      "no check reported at the approved head",
    );
    // A pending check and a failed one at once: red wins, both are named.
    const both = renderUnitReport(d.state, { checks: { total: 3, pending: ["ci / web"], failed: ["ci / package"] } });
    expect(both).toContain("⚠️ Approved but not merge-ready");
    expect(both).toContain("CI is red at the approved head: ci / package");
    expect(both).toContain("pending: ci / web");
  });

  it("findings round trip: request_changes → the findings step, a coding child briefed with the review's run, never a `fix` round → re-review with the prior review run and the coding run that answered it → approve; the declined disposition rides the report", () => {
    const d = fresh(input({ merge: "person" }));
    throughRoundZero(d);
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "one nit", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    // The findings step is a spawn of the coding preset under the review round's index: the bot dispatches the
    // review's findings into the unit thread as `agent:coding`, so the coding session there continues.
    expect(d.action).toEqual({
      type: "spawn",
      step: "U10/1/findings",
      preset: "coding",
      round: { index: 1, kind: "findings" },
      budgetMinutes: ASKS.coding,
      brief: { kind: "findings", pr: 7, reviewRunId: "run-r1", unit: "U10" },
    });
    expect(JSON.stringify(d.action)).not.toContain('"fix"');
    runChild(d, "run-f1", finished({ status: "completed", dispositions: [DECLINED], headSha: HEAD_B }), T0 + 40 * MIN);
    expect(d.state.findingsRunByRound).toEqual({ 1: "run-f1" });
    expect(d.state.lastCodingRunId).toBe("run-f1");
    expect(d.action).toMatchObject({ type: "pr-check", step: "U10/1/findings/pr-check" });
    d.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_B }, at: T0 + 40 * MIN });
    expect(d.action).toMatchObject({
      type: "spawn",
      step: "U10/2/review",
      round: { index: 2, kind: "review" },
      brief: {
        kind: "review",
        pr: 7,
        headSha: HEAD_B,
        round: 2,
        prior: { reviewRunId: "run-r1", codingRunId: "run-f1" },
      },
    });
    runChild(
      d,
      "run-r2",
      finished({
        status: "completed",
        verdict: { verdict: "approve", summary: "conceded", findings: [] },
        reviewPosted: true,
        reviewHead: HEAD_B,
      }),
      T0 + 50 * MIN,
    );
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "merge_ready" } });
    expect(d.rounds()).toEqual([
      "0 coding started",
      "0 coding pr_opened",
      "1 review started",
      "1 review request_changes",
      "1 coding started",
      "1 coding pr_opened",
      "2 review started",
      "2 review approve",
    ]);
    expect(renderUnitReport(d.state)).toContain("Declined findings: F1 — the loop is exclusive");
  });

  it("the findings step waits out a person's run: a busy answer waits a chunk under the unit's clock and asks the same step again; a busy answer with less than the reserve left ends the unit wall_clock_cap with no coding run started and the finding unaddressed in the report", () => {
    const d = fresh(input({ merge: "person" }));
    throughRoundZero(d);
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "one nit", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(d.action).toMatchObject({ type: "spawn", step: "U10/1/findings" });
    // A run live in the unit thread is a person's: the spawn answers busy naming it, and the step waits on it.
    d.answer({ type: "spawn", outcome: "busy", runId: "run-person", at: T0 + 20 * MIN });
    expect(d.action).toMatchObject({
      type: "wait",
      step: "U10/1/findings/busy/1",
      runId: "run-person",
      timeoutMs: WAIT_CHUNK_MS,
    });
    d.answer({ type: "wait", outcome: "event" });
    expect(d.action).toMatchObject({ type: "spawn", step: "U10/1/findings", brief: { kind: "findings" } });
    expect(d.state.findingsRunByRound).toEqual({});
    d.answer({ type: "spawn", outcome: "spawned", runId: "run-f1", at: T0 + 25 * MIN });
    expect(d.action).toMatchObject({ type: "wait", step: "U10/1/findings/wait/1", runId: "run-f1" });
    expect(d.rounds().at(-1)).toBe("1 coding started");

    // The person's run spends the unit's clock: a busy answer that leaves the
    // findings child under its floor (the remainder minus the 44 it holds for
    // the rounds after it falls under 15) ends the unit at the cap.
    const capped = fresh(input({ merge: "person" }));
    throughRoundZero(capped);
    runChild(
      capped,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "one nit", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(capped.action).toMatchObject({ type: "spawn", step: "U10/1/findings" });
    capped.answer({
      type: "spawn",
      outcome: "busy",
      runId: "run-person",
      at: T0 + 190 * MIN,
    });
    expect(capped.action).toMatchObject({
      type: "end",
      ending: { kind: "wall_clock_cap", reviewRounds: 1, refused: { round: "findings", minutes: 6, floor: 15 } },
    });
    expect(capped.state.findingsRunByRound).toEqual({});
    expect(capped.state.lastCodingRunId).toBe("run-c0");
    expect(capped.rounds()).not.toContain("1 coding started");
    const report = renderUnitReport(capped.state);
    expect(report).toContain("cannot hold another round");
    expect(report).toContain("Unaddressed (no disposition):\n  - [minor] F1 src/a.ts:3 — off by one");
  });

  it("the dispositions a coding run recorded are matched to the round's finding ids: an id the review never issued is dropped, so it reaches neither the state nor the report, and `matchDispositions` names it for the re-review's note", () => {
    const F2: Finding = { id: "F2", severity: "nit", file: "src/b.ts", title: "rename" };
    const stray: FindingDisposition = { findingId: "F9", disposition: "fixed", note: "no such finding" };
    expect(matchDispositions([FINDING, F2], [DECLINED, stray, { ...FIXED, findingId: "F2" }, stray])).toEqual({
      matched: [DECLINED, { ...FIXED, findingId: "F2" }],
      dropped: ["F9"],
    });
    expect(matchDispositions([], [stray])).toEqual({ matched: [], dropped: ["F9"] });
    expect(matchDispositions([FINDING], [])).toEqual({ matched: [], dropped: [] });

    const wide = fresh(input({ caps: { maxRounds: 2, maxMinutes: 120 }, merge: "person" }));
    throughRoundZero(wide);
    runChild(
      wide,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "one nit", findings: [FINDING, F2] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    runChild(
      wide,
      "run-f1",
      finished({ status: "completed", dispositions: [DECLINED, stray], headSha: HEAD_B }),
      T0 + 40 * MIN,
    );
    expect(wide.state.dispositionsByRound).toEqual({ 1: [DECLINED] });
    wide.answer({
      type: "pr-check",
      pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_B },
      at: T0 + 40 * MIN,
    });
    runChild(
      wide,
      "run-r2",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "still", findings: [FINDING, F2] },
        reviewPosted: true,
        reviewHead: HEAD_B,
      }),
      T0 + 50 * MIN,
    );
    expect(wide.action).toMatchObject({ type: "end", ending: { kind: "round_cap", maxRounds: 2 } });
    const report = renderUnitReport(wide.state);
    expect(report).toContain(
      "Declined (disposition recorded):\n  - [minor] F1 src/a.ts:3 — off by one — the loop is exclusive",
    );
    expect(report).toContain("Unaddressed (no disposition):\n  - [nit] F2 src/b.ts — rename");
    expect(report).not.toContain("F9");
  });

  it("the round cap: request_changes at the last allowed round ends the unit with the declined/unaddressed split over the last review's findings", () => {
    const d = fresh(input({ caps: { maxRounds: 1, maxMinutes: 120 }, merge: "person" }));
    throughRoundZero(d);
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "one nit", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "round_cap", maxRounds: 1 } });
    const report = renderUnitReport(d.state);
    expect(report).toContain("🧢 Ship stopped at a cap: the 1-round cap — no approval after 1 review round.");
    expect(report).toContain("Open findings from the last review (1):");
    expect(report).toContain("Unaddressed (no disposition):\n  - [minor] F1 src/a.ts:3 — off by one");
  });

  it("the wall-clock cap: every round is carved from what remains minus the reserve for the rounds after it, and a round under its floor is not dispatched — the unit ends at the cap naming the round, the minutes and the floor", () => {
    const d = fresh(input({ merge: "person" }));
    // Round 0: the coding child's whole ask, holding 70 for three reviews, two fixes and the merge.
    d.answer({ type: "branch", ok: true, at: T0 });
    expect(d.action).toMatchObject({ type: "spawn", preset: "coding", budgetMinutes: 90 });
    d.answer({ type: "spawn", outcome: "spawned", runId: "run-c0", at: T0 });
    expect(d.action).toMatchObject({ type: "wait", timeoutMs: WAIT_CHUNK_MS });
    d.answer({ type: "wait", outcome: "event" });
    // The coding child ended with 200 minutes left: the first review holds 62 and gets its whole 25.
    d.answer({
      type: "read-record",
      run: finished({ status: "completed", pr: { number: 7, url: PR_URL, created: true } }),
      at: T0 + 40 * MIN,
    });
    d.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A }, at: T0 + 40 * MIN });
    expect(d.action).toMatchObject({ type: "spawn", preset: "review", budgetMinutes: 25 });
    // The review asked for changes with 50 minutes left: the fix would get 50 − 44 = 6, under its floor of 15.
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 190 * MIN,
    );
    expect(d.action).toMatchObject({
      type: "end",
      ending: { kind: "wall_clock_cap", refused: { round: "findings", minutes: 6, floor: 15 } },
    });
    const report = renderUnitReport(d.state);
    expect(report).toContain("cannot hold another round");
    expect(report).toContain("the findings round would get 6 min, under its floor of 15");
  });

  it("the coding child's carve leaves the reserve for the whole loop the config allows: a 100-minute pipeline at three rounds hands the child 30 (100 − 70), a 240-minute one its whole 90, a 60-minute one at one round 42", () => {
    const short = fresh(input({ caps: { maxRounds: 3, maxMinutes: 100 }, merge: "person" }));
    short.answer({ type: "branch", ok: true, at: T0 });
    expect(short.action).toMatchObject({ type: "spawn", preset: "coding", budgetMinutes: 30 });
    const full = fresh(input({ merge: "person" }));
    full.answer({ type: "branch", ok: true, at: T0 });
    expect(full.action).toMatchObject({ type: "spawn", preset: "coding", budgetMinutes: 90 });
    // Fewer review rounds hold less back: at one round the reserve is a review, its provisioning and the merge floor.
    const one = fresh(input({ caps: { maxRounds: 1, maxMinutes: 60 }, merge: "person" }));
    one.answer({ type: "branch", ok: true, at: T0 });
    expect(one.action).toMatchObject({ type: "spawn", preset: "coding", budgetMinutes: 42 });
  });

  it("a findings child's carve leaves the rounds after it — the re-review, a second fix, the last review and the merge — never the whole loop's reserve: with 225 minutes left it gets its whole 90, with 60 left it gets 16", () => {
    const d = fresh(input({ merge: "person" }));
    throughRoundZero(d);
    expect(d.action).toMatchObject({ type: "spawn", preset: "review", round: { index: 1, kind: "review" } });
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 15 * MIN,
    );
    expect(d.action).toMatchObject({
      type: "spawn",
      preset: "coding",
      round: { index: 1, kind: "findings" },
      budgetMinutes: 90,
    });

    const late = fresh(input({ caps: { maxRounds: 3, maxMinutes: 100 }, merge: "person" }));
    throughRoundZero(late);
    runChild(
      late,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 40 * MIN,
    );
    expect(late.action).toMatchObject({
      type: "spawn",
      preset: "coding",
      round: { index: 1, kind: "findings" },
      budgetMinutes: 16,
    });
  });

  it("a wall-clock cap after the child opened or updated the pull request ends the unit review_pending: the pull request and the child's head are named, the report says review pending and how the budget went (coding, review, waiting)", () => {
    const d = fresh(input({ merge: "person" }));
    d.answer({ type: "branch", ok: true, at: T0 });
    // The coding child ships its pull request with 60 minutes left on the pipeline:
    // the review holds 62 for the rounds after it, so it falls under its floor of 5.
    runChild(
      d,
      "run-c0",
      finished({ status: "completed", pr: { number: 7, url: PR_URL, created: true } }),
      T0 + 180 * MIN,
    );
    expect(d.action.type).toBe("pr-check");
    d.answer({
      type: "pr-check",
      pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A },
      at: T0 + 180 * MIN,
    });
    expect(d.action).toMatchObject({
      type: "end",
      ending: {
        kind: "review_pending",
        pr: { number: 7, url: PR_URL },
        headSha: HEAD_A,
        reviewRounds: 0,
        spent: { coding: 180 * MIN, review: 0, waiting: 0 },
      },
    });
    const report = renderUnitReport(d.state);
    expect(report).toContain(`⏳ Review pending: the coding child shipped ${PR_URL}`);
    expect(report).toContain("cannot hold the review round");
    expect(report).toContain("The next attempt starts at the review round");
    expect(report).toContain("Budget split (240 min): coding 180 min, review 0 min, waiting 0 min.");
  });

  it("the wall-clock cap's report carries the budget split too, so a person can see whether the cap or the child is the problem", () => {
    const d = fresh(input({ merge: "person" }));
    d.answer({ type: "branch", ok: true, at: T0 });
    runChild(
      d,
      "run-c0",
      finished({ status: "completed", pr: { number: 7, url: PR_URL, created: true } }),
      T0 + 150 * MIN,
    );
    d.answer({
      type: "pr-check",
      pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A },
      at: T0 + 150 * MIN,
    });
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 190 * MIN,
    );
    // The findings step cannot start (50 left, 44 held, 6 under the floor of 15): not a review round, so the honest wall-clock cap — with the split.
    expect(d.action).toMatchObject({
      type: "end",
      ending: { kind: "wall_clock_cap", spent: { coding: 150 * MIN, review: 40 * MIN, waiting: 0 } },
    });
    expect(renderUnitReport(d.state)).toContain(
      "Budget split (240 min): coding 150 min, review 40 min, waiting 0 min.",
    );
  });

  it("a lastPush on the input starts the attempt at the review round when the open pull request still heads at the child's own last push — and at round 0 when the head moved or none is known", () => {
    // The head is exactly the child's last push: adopt the pull request, skip the branch and round 0.
    const same = new Driver(openUnitPipeline(input({ lastPush: HEAD_A, merge: "person" }), T0));
    same.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A }, at: T0 });
    expect(same.action).toMatchObject({ type: "spawn", preset: "review", step: "U10/1/review" });
    expect((nextAction(same.state) as Extract<CoordinatorAction, { type: "spawn" }>).brief).toMatchObject({
      kind: "review",
      pr: 7,
      headSha: HEAD_A,
    });
    // The head moved since — someone pushed — so round 0 rebases and re-describes as before.
    const moved = new Driver(openUnitPipeline(input({ lastPush: HEAD_A, merge: "person" }), T0));
    moved.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_B }, at: T0 });
    expect(moved.action.type).toBe("branch");
    // No lastPush: an open pull request is round 0's to work on, as before.
    const fresh0 = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
    fresh0.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A }, at: T0 });
    expect(fresh0.action.type).toBe("branch");
  });

  it("a stop: a child that ended stopped_soft or stopped_hard ends the unit as an operator stop naming the mode", () => {
    const soft = fresh(input({ merge: "person" }));
    soft.answer({ type: "branch", ok: true, at: T0 });
    runChild(soft, "run-c0", finished({ status: "stopped_soft", finalReply: "stopping" }), T0 + 5 * MIN);
    expect(soft.action).toMatchObject({ type: "end", ending: { kind: "stopped", mode: "soft" } });
    expect(soft.rounds()).toEqual(["0 coding started", "0 coding stopped"]);
    expect(renderUnitReport(soft.state)).toContain("⏹ Ship stopped by operator (soft stop) after 0 review rounds.");

    const hard = fresh(input({ merge: "person" }));
    throughRoundZero(hard);
    runChild(hard, "run-r1", finished({ status: "stopped_hard" }), T0 + 20 * MIN);
    expect(hard.action).toMatchObject({ type: "end", ending: { kind: "stopped", mode: "hard" } });
    expect(hard.rounds().at(-1)).toBe("1 review stopped");
    expect(renderUnitReport(hard.state)).toContain(
      `⛔ Ship stopped by operator (hard stop) after 1 review round. PR: ${PR_URL}`,
    );
  });

  it("a stop is honored around a posted verdict, never over it: an approve that posted is merge-ready stop or no stop; a changes-requested review that posted is a stopped report naming it", () => {
    const approved = fresh(input({ merge: "person" }));
    throughRoundZero(approved);
    runChild(
      approved,
      "run-r1",
      finished({
        status: "stopped_soft",
        verdict: { verdict: "approve", summary: "fine", findings: [] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(approved.action).toMatchObject({ type: "end", ending: { kind: "merge_ready" } });

    const changes = fresh(input({ merge: "person" }));
    throughRoundZero(changes);
    runChild(
      changes,
      "run-r1",
      finished({
        status: "stopped_soft",
        verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(changes.action).toMatchObject({ type: "end", ending: { kind: "stopped", mode: "soft" } });
    expect(renderUnitReport(changes.state)).toContain(
      "A changes-requested review was posted this round before the stop",
    );
  });

  // Decision 0046, Renewal: a round 0 that ends at its lease without a pull
  // request is a segment over with the unit unfinished — the grant decides
  // whether the next opens, off progress the row records.
  it("a round 0 without a pull request whose child pushed a head under a grant with renewals ends `continued`: the next segment, the sha it continues from, the renewals left and the spend so far, the round noted `continued`, the report naming the renewal", () => {
    const d = fresh(
      input({ merge: "person", generated: true, grant: { renewals: 6, costCapUsd: 50 }, grantSource: "channel" }),
    );
    d.answer({ type: "branch", ok: true, at: T0 });
    const branch = d.state.input.unit.branch;
    runChild(
      d,
      "run-c0",
      finished({
        status: "completed",
        finalReply: "Budget reached: pushed the parser, the tests are next.",
        pushed: [{ ref: branch, sha: HEAD_A, at: T0 + 40 * MIN }],
        leaseStartedAt: T0,
        costUsd: 12.5,
        handoffLists: { deviations: [], followUps: [{ what: "tests", where: "src" }], unproven: [] },
      }),
      T0 + 45 * MIN,
    );
    d.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 45 * MIN });
    expect(d.action).toMatchObject({
      type: "end",
      ending: {
        kind: "continued",
        round: { index: 0, kind: "coding" },
        runId: "run-c0",
        segment: 2,
        from: HEAD_A,
        renewalsLeft: 5,
        spendUsd: 12.5,
        handoff: { followUps: [{ what: "tests", where: "src" }] },
        finalReply: "Budget reached: pushed the parser, the tests are next.",
        line: `renewal 1 of 6, continues ${HEAD_A.slice(0, 7)}`,
      },
    });
    expect(d.rounds()).toEqual(["0 coding started", "0 coding continued"]);
    const report = renderUnitReport(d.state);
    expect(report).toContain(
      `🔁 Segment 1 ended at its lease with the unit unfinished — renewal 1 of 6, continues ${HEAD_A.slice(0, 7)}. Segment 2 opens in this thread from \`${HEAD_A.slice(0, 7)}\` under a fresh 240-minute lease`,
    );
    expect(report).toContain("5 renewals remain, $12.50 spent so far.");
  });

  it("a later segment reads progress against the sha it continued from and the previous handoff, prefixes every step with the segment, and carries the session's spend into the decision", () => {
    const branch = input().unit.branch;
    const session = {
      segment: 2,
      renewalsSpent: 1,
      spendUsd: 30,
      continueFrom: HEAD_A,
      previousHandoff: {
        deviations: [],
        followUps: [
          { what: "tests", where: "src" },
          { what: "docs", where: "spec" },
        ],
        unproven: [],
      },
    };
    const d = new Driver(
      openUnitPipeline(
        input({ merge: "person", generated: true, grant: { renewals: 6, costCapUsd: 50 }, session }),
        T0,
      ),
    );
    expect(d.action).toEqual({ type: "pr-check", step: "U10/s2/pr-check" });
    d.answer({ type: "pr-check", pr: { state: "none" }, at: T0 });
    expect(d.action).toMatchObject({ type: "branch", step: "U10/s2/branch" });
    d.answer({ type: "branch", ok: true, at: T0 });
    expect(d.action).toMatchObject({ type: "spawn", step: "U10/s2/0/coding" });
    // The same head pushed again is not progress; a shrunk handoff is.
    runChild(
      d,
      "run-c1",
      finished({
        status: "completed",
        pushed: [{ ref: branch, sha: HEAD_A, at: T0 + 10 * MIN }],
        leaseStartedAt: T0,
        costUsd: 15,
        handoffLists: { deviations: [], followUps: [{ what: "docs", where: "spec" }], unproven: [] },
      }),
      T0 + 45 * MIN,
    );
    d.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 45 * MIN });
    expect(d.action).toMatchObject({
      type: "end",
      step: "U10/s2/end",
      ending: {
        kind: "continued",
        segment: 3,
        renewalsLeft: 4,
        spendUsd: 45,
        line: "renewal 2 of 6, continues the branch's head",
      },
    });
    expect((d.action as { ending: { from?: string } }).ending.from).toBeUndefined();
  });

  it("a refusal names its clause on the abort: no progress under a grant with renewals says how to spend one by hand; spend at the cap stops even with progress; a grant of zero with nothing pushed keeps the plain abort", () => {
    const branch = input().unit.branch;
    // No progress: the child pushed nothing and there is no previous handoff.
    const stuck = fresh(input({ merge: "person", generated: true, grant: { renewals: 6 } }));
    stuck.answer({ type: "branch", ok: true, at: T0 });
    runChild(
      stuck,
      "run-c0",
      finished({ status: "completed", finalReply: "Budget reached, nothing pushed.", pushed: [] }),
      T0 + 45 * MIN,
    );
    stuck.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 45 * MIN });
    expect(stuck.action).toMatchObject({
      type: "end",
      ending: {
        kind: "aborted",
        renewal: {
          decision: { renew: false, why: "no_progress", renewalsLeft: 6 },
          line: "no progress in the last lease; grant holds 6 renewals; reply continue to spend one",
        },
      },
    });
    expect(stuck.rounds()).toEqual(["0 coding started", "0 coding aborted"]);
    expect(renderUnitReport(stuck.state)).toContain(
      "🔁 Not renewed: no progress in the last lease; grant holds 6 renewals; reply continue to spend one.",
    );

    // The cap: progress, but the session's spend reached it.
    const capped = fresh(input({ merge: "person", generated: true, grant: { renewals: 6, costCapUsd: 20 } }));
    capped.answer({ type: "branch", ok: true, at: T0 });
    runChild(
      capped,
      "run-c0",
      finished({ status: "completed", pushed: [{ ref: branch, sha: HEAD_A }], costUsd: 20 }),
      T0 + 45 * MIN,
    );
    capped.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 45 * MIN });
    expect(capped.action).toMatchObject({
      type: "end",
      ending: {
        kind: "aborted",
        renewal: {
          decision: { why: "cost_cap" },
          line: "spend $20.00 reached the grant's cap of $20; grant holds 6 renewals unspent",
        },
      },
    });

    // A cost the record does not know is unknown spend, which a cap refuses.
    const unknown = fresh(input({ merge: "person", generated: true, grant: { renewals: 6, costCapUsd: 20 } }));
    unknown.answer({ type: "branch", ok: true, at: T0 });
    runChild(
      unknown,
      "run-c0",
      finished({ status: "completed", pushed: [{ ref: branch, sha: HEAD_A }] }),
      T0 + 45 * MIN,
    );
    unknown.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 45 * MIN });
    expect(unknown.action).toMatchObject({
      type: "end",
      ending: { kind: "aborted", renewal: { decision: { why: "cost_cap" } } },
    });
    expect((unknown.state.ending as { spendUsd?: unknown }).spendUsd).toBeUndefined();

    // Progress under the default grant of zero: judged, refused as exhausted, said so.
    const zero = fresh(input({ merge: "person", generated: true }));
    zero.answer({ type: "branch", ok: true, at: T0 });
    runChild(zero, "run-c0", finished({ status: "completed", pushed: [{ ref: branch, sha: HEAD_A }] }), T0 + 45 * MIN);
    zero.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 45 * MIN });
    expect(zero.action).toMatchObject({
      type: "end",
      ending: {
        kind: "aborted",
        renewal: { decision: { why: "grant_exhausted" }, line: "the grant holds no renewals" },
      },
    });

    // Nothing pushed under a grant of zero: the plain abort, no renewal to explain.
    const plain = fresh(input({ merge: "person", generated: true }));
    plain.answer({ type: "branch", ok: true, at: T0 });
    runChild(plain, "run-c0", finished({ status: "completed", finalReply: "Which login flow?" }), T0 + 5 * MIN);
    plain.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 5 * MIN });
    expect((plain.state.ending as { renewal?: unknown }).renewal).toBeUndefined();
    expect(renderUnitReport(plain.state)).not.toContain("Not renewed");
  });

  it("aborts: a round 0 that opened no pull request, a branch that could not be created, a coding child that failed, a findings step that repushed nothing (unless every finding was declined)", () => {
    const noPr = fresh(input({ merge: "person" }));
    noPr.answer({ type: "branch", ok: true, at: T0 });
    runChild(noPr, "run-c0", finished({ status: "completed", finalReply: "Which login flow?" }), T0 + 5 * MIN);
    noPr.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 5 * MIN });
    expect(noPr.action).toMatchObject({
      type: "end",
      ending: { kind: "aborted", round: { index: 0, kind: "coding" } },
    });
    expect(noPr.rounds()).toEqual(["0 coding started", "0 coding aborted"]);
    const noPrReport = renderUnitReport(noPr.state);
    expect(noPrReport).toContain("Which login flow?");
    expect(noPrReport).toContain("⚠️ Ship ended at round 0: the coding round ended without opening a pull request");

    const noBranch = fresh(input());
    noBranch.answer({ type: "branch", ok: false, reason: "HTTP 403", at: T0 });
    expect(noBranch.action).toMatchObject({ type: "end", ending: { kind: "aborted" } });
    expect(renderUnitReport(noBranch.state)).toContain("Could not create the pipeline branch");
    expect(noBranch.rounds()).toEqual([]);

    // A failed coding child is given the recover pr-check first (issue 1276):
    // with nothing on the branch the unit still aborts with the child's reason.
    const failed = fresh(input({ merge: "person" }));
    failed.answer({ type: "branch", ok: true, at: T0 });
    runChild(failed, "run-c0", finished({ status: "failed" }), T0 + 5 * MIN);
    expect(failed.action).toMatchObject({ type: "pr-check", recover: { runId: "run-c0" } });
    failed.answer({ type: "pr-check", pr: { state: "none", unrecovered: "no_commits" }, at: T0 + 6 * MIN });
    expect(failed.action).toMatchObject({ type: "end", ending: { kind: "aborted" } });
    expect(renderUnitReport(failed.state)).toContain("ended `failed`");
    expect(renderUnitReport(failed.state)).toContain("no commits were pushed, so there was no work to recover");

    // The bot says WHY it recovered nothing, and the abort repeats it: an
    // instance with no base branch never claims nothing was pushed.
    const noBase = fresh(input({ merge: "person" }));
    noBase.answer({ type: "branch", ok: true, at: T0 });
    runChild(noBase, "run-c0", finished({ status: "failed" }), T0 + 5 * MIN);
    noBase.answer({ type: "pr-check", pr: { state: "none", unrecovered: "no_base" }, at: T0 + 6 * MIN });
    expect(noBase.action).toMatchObject({ type: "end", ending: { kind: "aborted" } });
    expect(renderUnitReport(noBase.state)).toContain("names no base branch");
    expect(renderUnitReport(noBase.state)).not.toContain("no work to recover");

    // A bare `none` (a bot from before the reason rode the answer) claims neither.
    const bare = fresh(input({ merge: "person" }));
    bare.answer({ type: "branch", ok: true, at: T0 });
    runChild(bare, "run-c0", finished({ status: "failed" }), T0 + 5 * MIN);
    bare.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 6 * MIN });
    expect(renderUnitReport(bare.state)).toContain("nothing was recovered");
    expect(renderUnitReport(bare.state)).not.toContain("no work to recover");

    // The child pushed before it died: the recover pr-check answers the pull
    // request opened from the branch itself, and the round continues to review
    // — the pushed work is never stranded and the ending is never the budget clip.
    const pushed = fresh(input({ merge: "person" }));
    pushed.answer({ type: "branch", ok: true, at: T0 });
    runChild(pushed, "run-c0", finished({ status: "failed" }), T0 + 5 * MIN);
    expect(pushed.action).toMatchObject({ type: "pr-check", recover: { runId: "run-c0" } });
    pushed.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL }, at: T0 + 6 * MIN });
    expect(pushed.action).toMatchObject({ type: "spawn", preset: "review" });
    expect(pushed.rounds()).toEqual(["0 coding started", "0 coding pr_opened"]);

    const stale = fresh(input({ merge: "person" }));
    throughRoundZero(stale);
    runChild(
      stale,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    runChild(stale, "run-f1", finished({ status: "completed", dispositions: [FIXED] }), T0 + 30 * MIN);
    stale.answer({
      type: "pr-check",
      pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A },
      at: T0 + 30 * MIN,
    });
    expect(stale.action).toMatchObject({
      type: "end",
      ending: { kind: "aborted", round: { index: 1, kind: "findings" } },
    });
    expect(renderUnitReport(stale.state)).toContain("produced no new head");
    expect(stale.rounds().at(-1)).toBe("1 coding aborted");

    const declinedAll = fresh(input({ merge: "person" }));
    throughRoundZero(declinedAll);
    runChild(
      declinedAll,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    runChild(declinedAll, "run-f1", finished({ status: "completed", dispositions: [DECLINED] }), T0 + 30 * MIN);
    declinedAll.answer({
      type: "pr-check",
      pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A },
      at: T0 + 30 * MIN,
    });
    expect(declinedAll.action).toMatchObject({ type: "spawn", step: "U10/2/review" });
  });

  it("a unit whose scope already landed: round 0 with a handoff naming where it landed and a branch with no commits over the base ends already_landed — the report names the landing and carries no compare link, no renewal line and no re-issue prompt; without the handoff's say-so, with commits over the base or with the fact unread the round-0 abort stands", () => {
    const branch = input().unit.branch;
    const LANDED = { what: "the topology page's empty state", where: "https://github.com/acme/api/pull/3377" };
    const landedHandoff = { deviations: [], followUps: [], unproven: [], landed: [LANDED] };
    const child = (over: Partial<Extract<ChildFacts, { finished: true }>> = {}) =>
      finished({
        status: "completed",
        finalReply: "Already on main via pull request 3377 — verified at head, nothing to push.",
        pushed: [{ ref: branch, sha: HEAD_A }],
        handoff: true,
        handoffLists: landedHandoff,
        ...over,
      });

    // The incident's shape: the child pushed the branch at the base's head and
    // handed off where the scope landed; the pr-check read no commits over the
    // base. Under a grant of zero the old ending judged a renewal; this one
    // never asks.
    const done = fresh(input({ merge: "person", generated: true }));
    done.answer({ type: "branch", ok: true, at: T0 });
    runChild(done, "run-c0", child(), T0 + 8 * MIN);
    expect(done.action).toMatchObject({ type: "pr-check" });
    done.answer({ type: "pr-check", pr: { state: "none", aheadOfBase: 0 }, at: T0 + 8 * MIN });
    expect(done.action).toEqual({
      type: "end",
      step: "U10/end",
      ending: {
        kind: "already_landed",
        landed: [LANDED],
        round: { index: 0, kind: "coding" },
        runId: "run-c0",
        reviewRounds: 0,
      },
    });
    expect(done.rounds()).toEqual(["0 coding started", "0 coding completed"]);
    const report = renderUnitReport(done.state);
    expect(report).toMatch(/^✅ Already on `main`/);
    expect(report).toContain(LANDED.what);
    expect(report).toContain(LANDED.where);
    expect(report).toContain("run-c0");
    expect(report).toContain(`\`${branch}\` has no commits over \`main\``);
    expect(report).not.toContain("compare");
    expect(report).not.toContain("Not renewed");
    expect(report).not.toContain("re-issue");
    expect(report).not.toContain("⚠️");

    // A grant with renewals: the same ending, and no renewal is judged or named.
    const granted = fresh(input({ merge: "person", generated: true, grant: { renewals: 6 } }));
    granted.answer({ type: "branch", ok: true, at: T0 });
    runChild(granted, "run-c0", child(), T0 + 8 * MIN);
    granted.answer({ type: "pr-check", pr: { state: "none", aheadOfBase: 0 }, at: T0 + 8 * MIN });
    expect(granted.action).toMatchObject({ type: "end", ending: { kind: "already_landed" } });
    expect(renderUnitReport(granted.state)).not.toMatch(/renew/i);

    // Two landings are both named, in the handoff's order.
    const two = fresh(input({ merge: "person" }));
    two.answer({ type: "branch", ok: true, at: T0 });
    const SECOND = { what: "the topology page's loading state", where: "https://github.com/acme/api/pull/3380" };
    runChild(two, "run-c0", child({ handoffLists: { ...landedHandoff, landed: [LANDED, SECOND] } }), T0 + 8 * MIN);
    two.answer({ type: "pr-check", pr: { state: "none", aheadOfBase: 0 }, at: T0 + 8 * MIN });
    expect(two.action).toMatchObject({ type: "end", ending: { kind: "already_landed", landed: [LANDED, SECOND] } });
    const twoReport = renderUnitReport(two.state);
    expect(twoReport.indexOf(LANDED.where)).toBeLessThan(twoReport.indexOf(SECOND.where));
    expect(twoReport).toContain("The unit is done and its dependents start on a base that carries it.");

    // No commits over the base, but the handoff does not say the scope landed
    // (a question, a give-up): the round-0 ending as before.
    const silent = fresh(input({ merge: "person", generated: true }));
    silent.answer({ type: "branch", ok: true, at: T0 });
    runChild(silent, "run-c0", child({ handoffLists: { deviations: [], followUps: [], unproven: [] } }), T0 + 8 * MIN);
    silent.answer({ type: "pr-check", pr: { state: "none", aheadOfBase: 0 }, at: T0 + 8 * MIN });
    expect(silent.action).toMatchObject({ type: "end", ending: { kind: "aborted", round: { index: 0 } } });
    expect(renderUnitReport(silent.state)).toContain("⚠️ Ship ended at round 0");

    // The handoff says landed but the branch carries commits: a description-less
    // push, not this ending — the round-0 abort stands.
    const pushed = fresh(input({ merge: "person", generated: true }));
    pushed.answer({ type: "branch", ok: true, at: T0 });
    runChild(pushed, "run-c0", child(), T0 + 8 * MIN);
    pushed.answer({ type: "pr-check", pr: { state: "none", aheadOfBase: 2 }, at: T0 + 8 * MIN });
    expect(pushed.action).toMatchObject({ type: "end", ending: { kind: "aborted", round: { index: 0 } } });

    // The fact unread (a bot from before it rode the answer, a compare that
    // failed): never claimed — the abort stands.
    const unread = fresh(input({ merge: "person", generated: true }));
    unread.answer({ type: "branch", ok: true, at: T0 });
    runChild(unread, "run-c0", child(), T0 + 8 * MIN);
    unread.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 8 * MIN });
    expect(unread.action).toMatchObject({ type: "end", ending: { kind: "aborted", round: { index: 0 } } });

    // The same return applied twice changes nothing (the durable half).
    const again = applyReturn(done.state, {
      type: "pr-check",
      step: "U10/0/coding/pr-check",
      pr: { state: "none", aheadOfBase: 0 },
      at: T0 + 9 * MIN,
    });
    expect(again.state).toBe(done.state);
    expect(again.notes).toEqual([]);
  });

  it("no verdict: a review child that ended without one aborts the unit naming the terminal, and no findings step starts", () => {
    const d = fresh(input({ merge: "person" }));
    throughRoundZero(d);
    runChild(d, "run-r1", finished({ status: "completed", finalReply: "ran out of budget" }), T0 + 20 * MIN);
    expect(d.action).toMatchObject({
      type: "end",
      ending: { kind: "no_verdict", round: { index: 1, kind: "review" } },
    });
    expect(d.rounds().at(-1)).toBe("1 review no_verdict");
    const report = renderUnitReport(d.state);
    expect(report).toContain("Review round 1 ended without a submitted verdict");
    expect(report).toContain("ran out of budget");
  });

  it("an approve whose post did not land is an honest abort, never merge-ready — the report carries the child's recorded reason and says how to continue in the runner's words", () => {
    const d = fresh(input());
    throughRoundZero(d);
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "approve", summary: "x", findings: [] },
        reviewPosted: false,
        reviewPostReason: "digest covered 3 of 5 files",
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "aborted" } });
    const report = renderUnitReport(d.state);
    expect(report).toContain("the approval could not be posted");
    expect(report).toContain("digest covered 3 of 5 files");
    expect(report).toContain("the unit runs again when the plan is re-issued");
    expect(report).not.toMatch(/Re-run ship/);
  });

  it("an approve GitHub shows no post for — with no recorded reason — aborts naming the pull request's silence, and a generated unit is told to re-issue ship with the PR URL", () => {
    const d = fresh(input({ merge: "person", generated: true }));
    throughRoundZero(d);
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "approve", summary: "x", findings: [] },
        reviewPosted: false,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "aborted" } });
    const report = renderUnitReport(d.state);
    expect(report).toContain("the pull request carries no approving review");
    expect(report).toContain("re-issue `agent:ship` in this thread with the same text and include the PR URL");
    // The re-issue line for a generated instance names the same text, never a plan path.
    expect(report).not.toContain(".md");
  });

  it("the re-issue line keys on the instance's mark, not on who merges: a seeded plan under `merge: person` is told the plan is re-issued, the same ending on a generated unit names the request's text", () => {
    const silent = (generated: boolean) => {
      const d = fresh(input({ merge: "person", generated }));
      throughRoundZero(d);
      runChild(
        d,
        "run-r1",
        finished({
          status: "completed",
          verdict: { verdict: "approve", summary: "x", findings: [] },
          reviewPosted: false,
          reviewHead: HEAD_A,
        }),
        T0 + 20 * MIN,
      );
      expect(d.action).toMatchObject({ type: "end", ending: { kind: "aborted" } });
      return renderUnitReport(d.state);
    };
    const seeded = silent(false);
    expect(seeded).toContain("the unit runs again when the plan is re-issued");
    expect(seeded).not.toContain("with the same text");
    const generated = silent(true);
    expect(generated).toContain("re-issue `agent:ship` in this thread with the same text");
    expect(generated).not.toContain("when the plan is re-issued");
  });

  it("a resume at review (an open pull request of ship's own named by the requester) skips the branch and round 0", () => {
    const d = new Driver(
      openUnitPipeline(
        input({
          unit: { id: "task", branch: "ship/fix-abc123" },
          merge: "person",
          resume: { pr: 7, headSha: HEAD_A, url: PR_URL },
        }),
        T0,
      ),
    );
    expect(d.action).toMatchObject({
      type: "spawn",
      step: "task/1/review",
      brief: { kind: "review", pr: 7, headSha: HEAD_A },
    });
  });
});

describe("the unit pipeline — the event, the timeout and the confirmation (the durable half)", () => {
  function atWait(): Driver {
    const d = fresh(input());
    d.answer({ type: "branch", ok: true, at: T0 });
    d.answer({ type: "spawn", outcome: "spawned", runId: "run-c0", at: T0 });
    expect(d.action).toMatchObject({ type: "wait", step: "U10/0/coding/wait/1" });
    return d;
  }

  it("a duplicate `run finished` for the same run advances the state once: the second return names a step the machine has left and changes nothing", () => {
    const d = atWait();
    d.answer({ type: "wait", outcome: "event" });
    const confirming = d.state;
    expect(d.action).toMatchObject({ type: "read-record", step: "U10/0/coding/read/1" });
    const again = applyReturn(d.state, { type: "wait", outcome: "event", step: "U10/0/coding/wait/1" });
    expect(again.state).toBe(confirming);
    expect(again.notes).toEqual([]);
    // Nor does a return for any other step the machine is not at.
    const stray = applyReturn(d.state, {
      type: "spawn",
      outcome: "spawned",
      runId: "run-x",
      step: "U10/0/coding",
      at: T0,
    });
    expect(stray.state).toBe(confirming);
  });

  it("a timeout is followed by read-record like an event is: `finished` advances", () => {
    const d = atWait();
    d.answer({ type: "wait", outcome: "timeout" });
    expect(d.action).toMatchObject({ type: "read-record", runId: "run-c0" });
    d.answer({
      type: "read-record",
      run: finished({ status: "completed", pr: { number: 7, url: PR_URL, created: true } }),
      at: T0 + 50 * MIN,
    });
    expect(d.action).toMatchObject({ type: "pr-check" });
  });

  it("a read-record that still says `live` — after a timeout or after an event — does not advance the round: the machine waits again under a new step name", () => {
    const d = atWait();
    d.answer({ type: "wait", outcome: "timeout" });
    d.answer({ type: "read-record", run: { finished: false }, at: T0 + 50 * MIN });
    expect(d.action).toMatchObject({ type: "wait", step: "U10/0/coding/wait/2", runId: "run-c0" });
    d.answer({ type: "wait", outcome: "event" });
    expect(d.action).toMatchObject({ type: "read-record", step: "U10/0/coding/read/2" });
    d.answer({ type: "read-record", run: { finished: false }, at: T0 + 51 * MIN });
    expect(d.action).toMatchObject({ type: "wait", step: "U10/0/coding/wait/3" });
    expect(d.rounds()).toEqual(["0 coding started"]);
  });

  it("the wait is sliced: every wait is a chunk, never the child's whole budget, and a live answer waits the next chunk; the slices before the budget plus the margin sum to exactly that, the last one the remainder; past it an overdue child is asked about every chunk, never in a zero-length wait; a finished record ends the wait exactly as the event would; a busy wait is a chunk too", () => {
    const until = T0 + ASKS.coding * MIN + WAIT_MARGIN_MS;
    expect(WAIT_CHUNK_MS).toBeLessThan(ASKS.coding * MIN);
    const d = atWait();
    expect(d.action).toMatchObject({ type: "wait", step: "U10/0/coding/wait/1", timeoutMs: WAIT_CHUNK_MS });
    // A chunk the engine never answered; the bot says live: the next slice is a chunk again.
    d.answer({ type: "wait", outcome: "timeout" });
    d.answer({ type: "read-record", run: { finished: false }, at: T0 + WAIT_CHUNK_MS });
    expect(d.action).toMatchObject({ type: "wait", step: "U10/0/coding/wait/2", timeoutMs: WAIT_CHUNK_MS });
    // Three minutes before the budget plus the margin: the slice is the remainder, never past it.
    d.answer({ type: "wait", outcome: "timeout" });
    d.answer({ type: "read-record", run: { finished: false }, at: until - 3 * MIN });
    expect(d.action).toMatchObject({ type: "wait", step: "U10/0/coding/wait/3", timeoutMs: 3 * MIN });
    // At and past it — an overdue child, its own budget's to end — a chunk again, never zero.
    d.answer({ type: "wait", outcome: "timeout" });
    d.answer({ type: "read-record", run: { finished: false }, at: until });
    expect(d.action).toMatchObject({ type: "wait", step: "U10/0/coding/wait/4", timeoutMs: WAIT_CHUNK_MS });
    d.answer({ type: "wait", outcome: "timeout" });
    d.answer({ type: "read-record", run: { finished: false }, at: until + 20 * MIN });
    expect(d.action).toMatchObject({ type: "wait", step: "U10/0/coding/wait/5", timeoutMs: WAIT_CHUNK_MS });
    // The finished record ends the wait as the event would have: the round advances to pr-check.
    d.answer({ type: "wait", outcome: "timeout" });
    d.answer({
      type: "read-record",
      run: finished({ status: "completed", pr: { number: 7, url: PR_URL, created: true } }),
      at: until + 21 * MIN,
    });
    expect(d.action).toMatchObject({ type: "pr-check" });
    expect(d.rounds()).toEqual(["0 coding started"]);

    // The slices before the deadline sum to exactly the child's budget plus the margin — what the one wait was.
    const sum = atWait();
    let clock = T0;
    let total = 0;
    while (clock < until) {
      const a = sum.action as Extract<CoordinatorAction, { type: "wait" }>;
      expect(a.type).toBe("wait");
      total += a.timeoutMs;
      clock += a.timeoutMs;
      sum.answer({ type: "wait", outcome: "timeout" });
      sum.answer({ type: "read-record", run: { finished: false }, at: clock });
    }
    expect(total).toBe(ASKS.coding * MIN + WAIT_MARGIN_MS);

    // A busy wait — another run holding the thread — is a chunk too, then the spawn is asked again.
    const b = fresh(input());
    b.answer({ type: "branch", ok: true, at: T0 });
    b.answer({ type: "spawn", outcome: "busy", runId: "run-other", at: T0 });
    expect(b.action).toMatchObject({ type: "wait", step: "U10/0/coding/busy/1", timeoutMs: WAIT_CHUNK_MS });
  });

  it("a read-record that says `interrupted` ends the unit with the ship-restart note, naming the pull request when one was opened — after the recover pr-check found nothing pushed for a coding child", () => {
    const noPr = atWait();
    noPr.answer({ type: "wait", outcome: "event" });
    noPr.answer({ type: "read-record", run: finished({ status: "interrupted" }), at: T0 + 5 * MIN });
    // A dead coding child may have pushed first: the pr-check looks, with the
    // run named so the bot can recover the branch as a pull request.
    expect(noPr.action).toMatchObject({ type: "pr-check", recover: { runId: "run-c0" } });
    noPr.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 6 * MIN });
    expect(noPr.action).toMatchObject({ type: "end", ending: { kind: "interrupted", runId: "run-c0" } });
    expect(renderUnitReport(noPr.state)).toBe(shipInterruptedNote());
    expect(noPr.rounds()).toEqual(["0 coding started", "0 coding aborted"]);

    const withPr = fresh(input());
    throughRoundZero(withPr);
    runChild(withPr, "run-r1", finished({ status: "interrupted" }), T0 + 20 * MIN);
    expect(withPr.action).toMatchObject({ type: "end", ending: { kind: "interrupted", runId: "run-r1" } });
    expect(renderUnitReport(withPr.state)).toBe(shipInterruptedNote(PR_URL));
  });

  it("a findings child that died at an unchanged head ends with the child's own reason — interrupted with the ship-restart note naming the pull request, failed as an abort naming the failure — never as the round's inaction", () => {
    const reviewed = (d: ReturnType<typeof fresh>) => {
      throughRoundZero(d);
      runChild(
        d,
        "run-r1",
        finished({
          status: "completed",
          verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
          reviewPosted: true,
          reviewHead: HEAD_A,
        }),
        T0 + 20 * MIN,
      );
    };
    // The bot rolled under the findings child before it pushed: the recover
    // pr-check finds the round's own pull request still at the reviewed head.
    const interrupted = fresh(input({ merge: "person" }));
    reviewed(interrupted);
    runChild(interrupted, "run-f1", finished({ status: "interrupted" }), T0 + 30 * MIN);
    expect(interrupted.action).toMatchObject({ type: "pr-check", recover: { runId: "run-f1" } });
    interrupted.answer({
      type: "pr-check",
      pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A },
      at: T0 + 30 * MIN,
    });
    expect(interrupted.action).toMatchObject({
      type: "end",
      ending: { kind: "interrupted", runId: "run-f1", round: { index: 1, kind: "findings" } },
    });
    expect(renderUnitReport(interrupted.state)).toBe(shipInterruptedNote(PR_URL));
    expect(interrupted.rounds().at(-1)).toBe("1 coding aborted");

    const failed = fresh(input({ merge: "person" }));
    reviewed(failed);
    runChild(failed, "run-f1", finished({ status: "failed" }), T0 + 30 * MIN);
    failed.answer({
      type: "pr-check",
      pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A },
      at: T0 + 30 * MIN,
    });
    expect(failed.action).toMatchObject({
      type: "end",
      ending: { kind: "aborted", round: { index: 1, kind: "findings" } },
    });
    const report = renderUnitReport(failed.state);
    expect(report).toContain("ended `failed`");
    expect(report).toContain("still sits at");
    expect(report).not.toContain("produced no new head");

    // A dead child that DID push carries the round on to review as before.
    const pushed = fresh(input({ merge: "person" }));
    reviewed(pushed);
    runChild(pushed, "run-f1", finished({ status: "interrupted" }), T0 + 30 * MIN);
    pushed.answer({
      type: "pr-check",
      pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_B },
      at: T0 + 30 * MIN,
    });
    expect(pushed.action).toMatchObject({ type: "spawn", preset: "review" });
  });

  it("a spawn answering `alreadySpawned` proceeds to the wait on that run without a second child", () => {
    const d = fresh(input());
    d.answer({ type: "branch", ok: true, at: T0 });
    d.answer({ type: "spawn", outcome: "alreadySpawned", runId: "run-c0", at: T0 });
    expect(d.action).toMatchObject({ type: "wait", runId: "run-c0", step: "U10/0/coding/wait/1" });
    expect(d.rounds()).toEqual(["0 coding started"]);
  });

  it("a spawn answering `busy` waits for the live run's end, then spawns the same step again; a second `busy` waits again under a new name", () => {
    const d = fresh(input());
    d.answer({ type: "branch", ok: true, at: T0 });
    d.answer({ type: "spawn", outcome: "busy", runId: "run-other", at: T0 });
    expect(d.action).toMatchObject({ type: "wait", step: "U10/0/coding/busy/1", runId: "run-other" });
    d.answer({ type: "wait", outcome: "event" });
    expect(d.action).toMatchObject({ type: "spawn", step: "U10/0/coding" });
    d.answer({ type: "spawn", outcome: "busy", runId: "run-other", at: T0 + MIN });
    expect(d.action).toMatchObject({ type: "wait", step: "U10/0/coding/busy/2" });
    d.answer({ type: "wait", outcome: "timeout" });
    expect(d.action).toMatchObject({ type: "spawn", step: "U10/0/coding" });
    d.answer({ type: "spawn", outcome: "spawned", runId: "run-c0", at: T0 + 2 * MIN });
    expect(d.action).toMatchObject({ type: "wait", runId: "run-c0" });
    expect(d.rounds()).toEqual(["0 coding started"]);
  });

  it("a spawn the authorize stage refused ends the unit with the gate's own name; a spawn that failed ends it as an abort", () => {
    const refused = fresh(input());
    refused.answer({ type: "branch", ok: true, at: T0 });
    refused.answer({
      type: "spawn",
      outcome: "refused",
      refusal: "agent_allowlist",
      message: "🚫 you're not on the allowlist for `coding`",
      at: T0,
    });
    expect(refused.action).toMatchObject({ type: "end", ending: { kind: "refused", refusal: "agent_allowlist" } });
    expect(renderUnitReport(refused.state)).toContain("agent_allowlist");
    expect(renderUnitReport(refused.state)).toContain("not on the allowlist");

    const failed = fresh(input());
    failed.answer({ type: "branch", ok: true, at: T0 });
    failed.answer({ type: "spawn", outcome: "failed", reason: "HTTP 503", at: T0 });
    expect(failed.action).toMatchObject({ type: "end", ending: { kind: "aborted" } });
    expect(renderUnitReport(failed.state)).toContain("HTTP 503");
  });

  it("the merge: `pending` waits on the checks-settled event at the approved head under a bounded fallback, `refused` ends the unit naming the reason, and the wait's budget is its own — never the pipeline's", () => {
    const d = fresh(input());
    throughRoundZero(d);
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "approve", summary: "x", findings: [] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(d.action).toMatchObject({ type: "merge", step: "U10/merge/1" });
    d.answer({ type: "merge", outcome: "pending", reason: "checks running", at: T0 + 20 * MIN });
    // The wait is on the intake's typed event at the approved head, with the
    // old poll cadence as the fallback timeout: without the event the door is
    // still re-asked every chunk, never slower than the poll it replaced.
    expect(d.action).toMatchObject({
      type: "wait-checks",
      step: "U10/merge/wait/1",
      headSha: HEAD_A,
      timeoutMs: MERGE_WAIT_CHUNK_MS,
    });
    d.answer({ type: "wait-checks", outcome: "event" });
    expect(d.action).toMatchObject({ type: "merge", step: "U10/merge/2" });
    // Still pending 58 minutes in: the fallback timeout shrinks to the remainder
    // once it is under a chunk (never below the one-minute floor).
    d.answer({ type: "merge", outcome: "pending", reason: "checks running", at: T0 + 20 * MIN + 58 * MIN });
    expect(d.action).toMatchObject({
      type: "wait-checks",
      step: "U10/merge/wait/2",
      timeoutMs: 2 * MIN,
    });
    // The event never arrives: the bounded fallback times out, the door is
    // asked once more, and a pending past the cap ends the unit.
    d.answer({ type: "wait-checks", outcome: "timeout" });
    expect(d.action).toMatchObject({ type: "merge", step: "U10/merge/3" });
    d.answer({ type: "merge", outcome: "pending", reason: "checks running", at: T0 + 20 * MIN + 60 * MIN });
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "merge_refused" } });
    expect(renderUnitReport(d.state)).toContain("checks running");

    const refused = fresh(input());
    throughRoundZero(refused);
    runChild(
      refused,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "approve", summary: "x", findings: [] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    refused.answer({ type: "merge", outcome: "refused", reason: "head moved", at: T0 + 21 * MIN });
    expect(refused.action).toMatchObject({ type: "end", ending: { kind: "merge_refused", reason: "head moved" } });
    const refusedReport = renderUnitReport(refused.state);
    expect(refusedReport).toContain("head moved");
    // The approved work is on the branch: the remedy is a person's rebase or
    // fix and a hand merge, after which a re-issue finds the merge and does
    // not run the unit again — never a re-run of the unit from scratch.
    expect(refusedReport).toContain("merge it by hand");
    expect(refusedReport).toContain("not run again");
    expect(refusedReport).not.toContain("the unit runs again when the plan is re-issued");
  });

  it("a merge answered merged with by other — the door found the pull request already merged after the approval — ends the unit merged by other with the merge commit and the time, and the report reads the Already-merged sentence", () => {
    const d = fresh(input());
    throughRoundZero(d);
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "approve", summary: "x", findings: [] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(d.action).toMatchObject({ type: "merge", step: "U10/merge/1" });
    d.answer({
      type: "merge",
      outcome: "merged",
      by: "other",
      sha: HEAD_B,
      mergedAt: "2026-09-13T23:55:59Z",
      at: T0 + 21 * MIN,
    });
    expect(d.action).toMatchObject({
      type: "end",
      ending: { kind: "merged", by: "other", sha: HEAD_B, mergedAt: "2026-09-13T23:55:59Z", reviewRounds: 1 },
    });
    expect(renderUnitReport(d.state)).toContain("✅ Already merged");
    expect(renderUnitReport(d.state)).toContain(`merge commit \`${HEAD_B.slice(0, 7)}\``);
  });

  it("an approve on a plan branch with no known head to merge at is a refused merge, never a person's merge-ready", () => {
    const d = fresh(input());
    d.answer({ type: "branch", ok: true, at: T0 });
    runChild(d, "run-c0", finished({ status: "completed", pr: { number: 7, url: PR_URL, created: true } }), T0 + MIN);
    // The pull request is open but GitHub reported no head, and the review child settled none either.
    d.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL }, at: T0 + MIN });
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "approve", summary: "x", findings: [] },
        reviewPosted: true,
      }),
      T0 + 2 * MIN,
    );
    expect(d.action).toMatchObject({
      type: "end",
      ending: { kind: "merge_refused", reason: "no approved head is known to merge at" },
    });
  });

  it("a findings step whose pull request was closed out from under it and reopened adopts the open pull request on the branch; one with no open pull request aborts", () => {
    const adopt = fresh(input({ merge: "person" }));
    throughRoundZero(adopt);
    runChild(
      adopt,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    runChild(adopt, "run-f1", finished({ status: "completed", dispositions: [FIXED], headSha: HEAD_C }), T0 + 30 * MIN);
    adopt.answer({
      type: "pr-check",
      pr: { state: "open", prNumber: 9, url: "https://github.com/acme/api/pull/9", headSha: HEAD_C },
      at: T0 + 30 * MIN,
    });
    expect(adopt.action).toMatchObject({ type: "spawn", step: "U10/2/review", brief: { pr: 9, headSha: HEAD_C } });

    const gone = fresh(input({ merge: "person" }));
    throughRoundZero(gone);
    runChild(
      gone,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    runChild(gone, "run-f1", finished({ status: "completed", dispositions: [FIXED], headSha: HEAD_C }), T0 + 30 * MIN);
    gone.answer({ type: "pr-check", pr: { state: "none" }, at: T0 + 30 * MIN });
    expect(gone.action).toMatchObject({ type: "end", ending: { kind: "aborted" } });
    expect(renderUnitReport(gone.state)).toContain("no open pull request");
  });

  it("every step name is the unit, the round and the kind, so the spawn's key is unique across a plan's units and never carries a colon", () => {
    const d = new Driver(openUnitPipeline(input({ unit: { id: "U12", branch: "plan/p/u12-x" }, merge: "person" }), T0));
    const seen: string[] = [];
    seen.push(d.action.step);
    d.answer({ type: "pr-check", pr: { state: "none" }, at: T0 });
    seen.push(d.action.step);
    d.answer({ type: "branch", ok: true, at: T0 });
    seen.push(d.action.step);
    runChild(d, "run-c0", finished({ status: "completed", pr: { number: 7, url: PR_URL, created: true } }), T0 + MIN);
    seen.push(d.action.step);
    d.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A }, at: T0 + MIN });
    seen.push(d.action.step);
    expect(seen).toEqual(["U12/pr-check", "U12/branch", "U12/0/coding", "U12/0/coding/pr-check", "U12/1/review"]);
    for (const s of seen) expect(s).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/);
  });
});

describe("the unit pipeline — a pull request already merged: a re-issued plan, or a merge that lands during a round", () => {
  const MERGED_AT = "2026-09-13T23:55:59Z";
  const graph = parsePlanGraph(PLAN, PLAN_ID);
  const merged = (sha: string, mergedAt = MERGED_AT) =>
    ({ state: "merged", prNumber: 7, url: PR_URL, sha, mergedAt }) as const;

  it("a unit whose pull request merged before the attempt — a person's merge, or an earlier attempt's — ends merged at the pre-check under `<unit>/pr-check`: no branch, no child, no round; the report says it was already merged and when, never that the runner merged it; the cursor marks it done and its dependents become ready; the same return applied twice changes nothing", () => {
    const d = new Driver(openUnitPipeline(input(), T0));
    expect(d.action).toEqual({ type: "pr-check", step: "U10/pr-check" });
    d.answer({ type: "pr-check", pr: merged(HEAD_B, MERGED_AT), at: T0 + MIN });
    expect(d.action).toEqual({
      type: "end",
      step: "U10/end",
      ending: {
        kind: "merged",
        by: "other",
        pr: { number: 7, url: PR_URL },
        sha: HEAD_B,
        mergedAt: MERGED_AT,
        reviewRounds: 0,
      },
    });
    expect(d.rounds()).toEqual([]);
    expect(d.notes).toEqual([{ type: "ended", ending: d.state.ending }]);
    expect(d.state.pr).toEqual({ number: 7, url: PR_URL });
    expect(d.state.clock).toBe(T0 + MIN);
    const report = renderUnitReport(d.state);
    expect(report).toContain(
      `✅ Already merged: ${PR_URL} (merge commit \`${HEAD_B.slice(0, 7)}\`, merged ${MERGED_AT})`,
    );
    expect(report).toContain("before this attempt reached it");
    expect(report).toContain("its dependents start on a base that carries it");
    expect(report).not.toContain("plan:merge");
    expect(report).not.toContain("merged by the plan runner");
    // The same return again: the machine has left the step, and nothing changes.
    const ended = d.state;
    const again = applyReturn(ended, { type: "pr-check", step: "U10/pr-check", pr: merged(HEAD_B), at: T0 + 2 * MIN });
    expect(again.state).toBe(ended);
    expect(again.notes).toEqual([]);
    // The cursor: a `merged` ending is `done`, so U11 — which depends on U10 — becomes ready.
    let cursor = openPlanCursor(graph, ["U10", "U11"]);
    cursor = startUnit(graph, cursor, "U10");
    expect(readyUnits(graph, cursor)).toEqual([]);
    cursor = settleUnit(graph, cursor, "U10", d.state.ending!.kind === "merged" ? "done" : "failed");
    expect(cursor.status).toEqual({ U10: "done", U11: "pending" });
    expect(readyUnits(graph, cursor)).toEqual(["U11"]);
  });

  it("the pre-check answering none or open proceeds to the branch and round 0 as before: an open pull request is round 0's to rebase and re-describe, and is adopted at the round's own pr-check, not here", () => {
    const none = new Driver(openUnitPipeline(input(), T0));
    expect(none.action).toEqual({ type: "pr-check", step: "U10/pr-check" });
    none.answer({ type: "pr-check", pr: { state: "none" }, at: T0 });
    expect(none.action).toMatchObject({ type: "branch", step: "U10/branch" });
    expect(none.rounds()).toEqual([]);
    const open = new Driver(openUnitPipeline(input(), T0));
    expect(open.action).toEqual({ type: "pr-check", step: "U10/pr-check" });
    open.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A }, at: T0 });
    expect(open.action).toMatchObject({ type: "branch", step: "U10/branch" });
    expect(open.state.pr).toBeUndefined();
    expect(open.state.lastReviewHead).toBeUndefined();
  });

  it("a merge that lands during a round — the pr-check after the coding child answers merged — ends the unit merged the same way, the round noted completed and no review spawned; after a findings step the same, with the review rounds counted", () => {
    const d = fresh(input());
    d.answer({ type: "branch", ok: true, at: T0 });
    runChild(
      d,
      "run-c0",
      finished({
        status: "completed",
        handoff: true,
        finalReply: "Unit U10 is already done — nothing to ship this run.",
      }),
      T0 + 5 * MIN,
    );
    expect(d.action).toMatchObject({ type: "pr-check", step: "U10/0/coding/pr-check" });
    d.answer({ type: "pr-check", pr: merged(HEAD_B), at: T0 + 5 * MIN });
    expect(d.action).toMatchObject({
      type: "end",
      ending: {
        kind: "merged",
        by: "other",
        pr: { number: 7, url: PR_URL },
        sha: HEAD_B,
        mergedAt: MERGED_AT,
        reviewRounds: 0,
      },
    });
    expect(d.rounds()).toEqual(["0 coding started", "0 coding completed"]);
    const report = renderUnitReport(d.state);
    expect(report).toContain(
      `✅ Already merged: ${PR_URL} (merge commit \`${HEAD_B.slice(0, 7)}\`, merged ${MERGED_AT})`,
    );
    expect(report).not.toContain("plan:merge");

    const fix = fresh(input({ merge: "person" }));
    throughRoundZero(fix);
    runChild(
      fix,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    runChild(fix, "run-f1", finished({ status: "completed", dispositions: [FIXED], headSha: HEAD_B }), T0 + 30 * MIN);
    expect(fix.action).toMatchObject({ type: "pr-check", step: "U10/1/findings/pr-check" });
    fix.answer({ type: "pr-check", pr: merged(HEAD_C), at: T0 + 30 * MIN });
    expect(fix.action).toMatchObject({
      type: "end",
      ending: { kind: "merged", by: "other", sha: HEAD_C, reviewRounds: 1 },
    });
    expect(fix.rounds().at(-1)).toBe("1 coding completed");
  });
});

describe("the severity gate — an approve's findings held to the level in force", () => {
  const F = (id: string, severity: "blocking" | "major" | "minor" | "nit", title = "t") => ({
    id,
    severity,
    file: "src/a.ts",
    title,
  });

  it("an approve carrying a finding at the level (default minor) opens the gate: the round continues into the findings step exactly as request_changes does", () => {
    const d = fresh(input({ merge: "person", generated: true }));
    throughRoundZero(d);
    const a = runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "approve", summary: "minor nits remain", findings: [F("F1", "minor")] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(a).toMatchObject({ type: "spawn", round: { index: 1, kind: "findings" }, preset: "coding" });
    // The gate firing is a detector, not a routine branch: the child's own
    // verdict parser holds an approve to the same level (agent-review item 5a),
    // so an approve that still carries a gated finding was parsed at another
    // level — the round note says what it caught, for the row, the card and
    // the run stream.
    expect(d.notes.filter((n) => n.type === "round" && n.outcome === "approve")).toEqual([
      {
        type: "round",
        index: 1,
        agent: "review",
        outcome: "approve",
        gate: { level: "minor", findings: ["F1 (minor)"] },
      },
    ]);
  });

  it("an approve whose findings all sit below the level ends merge_ready, and the report names the level, its source and the skipped findings", () => {
    const d = fresh(
      input({ merge: "person", generated: true, addressSeverity: "major", addressSeveritySource: "user" }),
    );
    throughRoundZero(d);
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: {
          verdict: "approve",
          summary: "clean enough",
          findings: [F("F1", "minor", "naming"), F("F2", "nit")],
        },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "merge_ready" } });
    const report = renderUnitReport(d.state);
    // Below the level nothing fired: the approve's round note carries no gate.
    expect(d.notes.find((n) => n.type === "round" && n.outcome === "approve")).not.toHaveProperty("gate");
    expect(report).toContain("Severity addressed: major and above (set by user).");
    expect(report).toContain("Findings below major, left as-is: F1 (minor) — naming; F2 (nit) — t");
    // The grant, as the instance carries it: absent reads as the org's zero.
    expect(report).toContain("Renewals: 0 of 0 spent (granted by org).");
  });

  it("the report names the grant the instance carries — renewals spent of granted, the cap and who granted it — while nothing renews yet", () => {
    const d = fresh(
      input({
        merge: "person",
        generated: true,
        grant: { renewals: 6, costCapUsd: 50 },
        grantSource: "channel",
      }),
    );
    throughRoundZero(d);
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "approve", summary: "clean", findings: [] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "merge_ready" } });
    expect(renderUnitReport(d.state)).toContain("Renewals: 0 of 6 spent, cost cap $50 (granted by channel).");
  });

  it("maxRounds still caps the loop: an approve at the round cap carrying a gated finding ends round_cap, never a silent merge_ready", () => {
    const d = fresh(input({ merge: "person", generated: true, caps: { maxRounds: 1, maxMinutes: 120 } }));
    throughRoundZero(d);
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "approve", findings: [F("F1", "blocking")] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 20 * MIN,
    );
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "round_cap", maxRounds: 1 } });
  });
});
