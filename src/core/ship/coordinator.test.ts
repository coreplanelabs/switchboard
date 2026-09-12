import { describe, expect, it } from "vitest";
import { AGENTS } from "../../agents/registry.js";
import { SHIP_ROUND_RESERVE_MS, shipInterruptedNote, shipRoundHeader } from "../shipPipeline.js";
import type { Finding, FindingDisposition } from "../reviewVerdict.js";
import {
  applyReturn,
  cursorFinished,
  MERGE_POLL_MS,
  MERGE_WAIT_MAX_MS,
  nextAction,
  openPlanCursor,
  openUnitPipeline,
  parsePlanBranch,
  parsePlanGraph,
  parseShipPlanRequest,
  planIdOf,
  planInstanceId,
  readyUnits,
  renderUnitReport,
  settleUnit,
  startUnit,
  unitBranch,
  unitSlug,
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
// is a pure function over the step returns, so every ending the in-process
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
    caps: { maxRounds: 3, maxMinutes: 120 },
    merge: "runner",
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

  it("planInstanceId names the plan, so a second runner for one plan meets the engine's duplicate-id refusal", () => {
    expect(planInstanceId(PLAN_ID)).toBe(`plan-${PLAN_ID}`);
    expect(planInstanceId("x".repeat(200))).toHaveLength(100);
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

describe("the unit pipeline — every ending the in-process loop has today, on step returns", () => {
  it("merge-ready in one round on a plan branch: branch → coding → pr-check → review → approve → merge, the round boundaries as the card draws them", () => {
    const d = new Driver(openUnitPipeline(input(), T0));
    expect(d.action).toMatchObject({ type: "branch", step: "U10/branch", branch: input().unit.branch, from: "main" });
    d.answer({ type: "branch", ok: true, at: T0 });
    // The spawn carries the key's step, the preset, its clipped budget and the brief (ids only).
    expect(d.action).toMatchObject({
      type: "spawn",
      step: "U10/0/coding",
      preset: "coding",
      round: { index: 0, kind: "coding" },
      budgetMinutes: AGENTS.coding.maxMinutes,
      brief: { kind: "contract", unit: "U10", rebase: { branch: input().unit.branch, onto: "main" } },
    });
    d.answer({ type: "spawn", outcome: "spawned", runId: "run-c0", at: T0 });
    // The wait is the child's budget plus the margin, under the child's event type.
    expect(d.action).toMatchObject({
      type: "wait",
      step: "U10/0/coding/wait/1",
      runId: "run-c0",
      timeoutMs: AGENTS.coding.maxMinutes * MIN + WAIT_MARGIN_MS,
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
      budgetMinutes: AGENTS.review.maxMinutes,
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
    // The card's header for each boundary is the one the in-process pipeline draws.
    expect(shipRoundHeader({ index: 0, agent: "coding" })).toBe("Round 0 — coding");
    expect(shipRoundHeader({ index: 1, agent: "review" })).toBe("Round 1 — review");
    expect(d.notes.at(-1)).toMatchObject({ type: "ended", ending: { kind: "merged" } });
    expect(d.state.lastCodingRunId).toBe("run-c0");
    const report = renderUnitReport(d.state);
    expect(report).toContain("✅ Merged after 1 review round");
    expect(report).toContain(PR_URL);
    expect(report).toContain("plan:merge");
  });

  it("merge-ready off a plan branch waits for a person: the machine ends merge_ready and never asks for a merge", () => {
    const d = new Driver(
      openUnitPipeline(input({ unit: { id: "task", branch: "ship/fix-abc123" }, merge: "person" }), T0),
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
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "merge_ready", pr: { number: 7 } } });
    const report = renderUnitReport(d.state);
    expect(report).toContain("✅ Merge-ready after 1 review round");
    expect(report).toContain("Verdict: LGTM — clean");
    expect(report).toContain("Declined findings: none");
    expect(report).toContain("a person's merge");
  });

  it("findings round trip: request_changes → a fix round with the review's run as its brief → re-review with the prior round's ids → approve; the declined disposition rides the report", () => {
    const d = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
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
    expect(d.action).toMatchObject({
      type: "spawn",
      step: "U10/1/fix",
      preset: "coding",
      round: { index: 1, kind: "fix" },
      brief: { kind: "fix", pr: 7, reviewRunId: "run-r1", unit: "U10" },
    });
    runChild(d, "run-f1", finished({ status: "completed", dispositions: [DECLINED], headSha: HEAD_B }), T0 + 40 * MIN);
    expect(d.action.type).toBe("pr-check");
    d.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_B }, at: T0 + 40 * MIN });
    expect(d.action).toMatchObject({
      type: "spawn",
      step: "U10/2/review",
      round: { index: 2, kind: "review" },
      brief: { kind: "review", pr: 7, headSha: HEAD_B, round: 2, prior: { reviewRunId: "run-r1", fixRunId: "run-f1" } },
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

  it("the round cap: request_changes at the last allowed round ends the unit with the declined/unaddressed split over the last review's findings", () => {
    const d = new Driver(openUnitPipeline(input({ caps: { maxRounds: 1, maxMinutes: 120 }, merge: "person" }), T0));
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

  it("the wall-clock cap: a round starts only when the reservation holds, and the child's budget is clipped to what remains", () => {
    const d = new Driver(openUnitPipeline(input({ caps: { maxRounds: 3, maxMinutes: 30 }, merge: "person" }), T0));
    // Round 0 spawned with the coding preset's own budget clipped to the 30-minute pipeline.
    d.answer({ type: "branch", ok: true, at: T0 });
    expect(d.action).toMatchObject({ type: "spawn", budgetMinutes: 30 });
    d.answer({ type: "spawn", outcome: "spawned", runId: "run-c0", at: T0 });
    expect(d.action).toMatchObject({ type: "wait", timeoutMs: 30 * MIN + WAIT_MARGIN_MS });
    d.answer({ type: "wait", outcome: "event" });
    // The coding child ended with 20 minutes left: the review round is clipped to 20 of its 25.
    d.answer({
      type: "read-record",
      run: finished({ status: "completed", pr: { number: 7, url: PR_URL, created: true } }),
      at: T0 + 10 * MIN,
    });
    d.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A }, at: T0 + 10 * MIN });
    expect(d.action).toMatchObject({ type: "spawn", preset: "review", budgetMinutes: 20 });
    // The review asked for changes with less than the reserve left: no fix round starts.
    runChild(
      d,
      "run-r1",
      finished({
        status: "completed",
        verdict: { verdict: "request_changes", summary: "x", findings: [FINDING] },
        reviewPosted: true,
        reviewHead: HEAD_A,
      }),
      T0 + 30 * MIN - SHIP_ROUND_RESERVE_MS + 1,
    );
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "wall_clock_cap" } });
    expect(renderUnitReport(d.state)).toContain("cannot hold another round");
  });

  it("a stop: a child that ended stopped_soft or stopped_hard ends the unit as an operator stop naming the mode", () => {
    const soft = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
    soft.answer({ type: "branch", ok: true, at: T0 });
    runChild(soft, "run-c0", finished({ status: "stopped_soft", finalReply: "stopping" }), T0 + 5 * MIN);
    expect(soft.action).toMatchObject({ type: "end", ending: { kind: "stopped", mode: "soft" } });
    expect(soft.rounds()).toEqual(["0 coding started", "0 coding stopped"]);
    expect(renderUnitReport(soft.state)).toContain("⏹ Ship stopped by operator (soft stop) after 0 review rounds.");

    const hard = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
    throughRoundZero(hard);
    runChild(hard, "run-r1", finished({ status: "stopped_hard" }), T0 + 20 * MIN);
    expect(hard.action).toMatchObject({ type: "end", ending: { kind: "stopped", mode: "hard" } });
    expect(hard.rounds().at(-1)).toBe("1 review stopped");
    expect(renderUnitReport(hard.state)).toContain(
      `⛔ Ship stopped by operator (hard stop) after 1 review round. PR: ${PR_URL}`,
    );
  });

  it("a stop is honored around a posted verdict, never over it: an approve that posted is merge-ready stop or no stop; a changes-requested review that posted is a stopped report naming it", () => {
    const approved = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
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

    const changes = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
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

  it("aborts: a round 0 that opened no pull request, a branch that could not be created, a coding child that failed, a fix round that repushed nothing (unless every finding was declined)", () => {
    const noPr = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
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

    const noBranch = new Driver(openUnitPipeline(input(), T0));
    noBranch.answer({ type: "branch", ok: false, reason: "HTTP 403", at: T0 });
    expect(noBranch.action).toMatchObject({ type: "end", ending: { kind: "aborted" } });
    expect(renderUnitReport(noBranch.state)).toContain("Could not create the pipeline branch");
    expect(noBranch.rounds()).toEqual([]);

    const failed = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
    failed.answer({ type: "branch", ok: true, at: T0 });
    runChild(failed, "run-c0", finished({ status: "failed" }), T0 + 5 * MIN);
    expect(failed.action).toMatchObject({ type: "end", ending: { kind: "aborted" } });
    expect(renderUnitReport(failed.state)).toContain("ended `failed`");

    const stale = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
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
    expect(stale.action).toMatchObject({ type: "end", ending: { kind: "aborted", round: { index: 1, kind: "fix" } } });
    expect(renderUnitReport(stale.state)).toContain("produced no new head");
    expect(stale.rounds().at(-1)).toBe("1 coding aborted");

    const declinedAll = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
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

  it("no verdict: a review child that ended without one aborts the unit naming the terminal, and no fix round starts", () => {
    const d = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
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

  it("an approve whose post did not land is an honest abort, never merge-ready", () => {
    const d = new Driver(openUnitPipeline(input(), T0));
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
    expect(renderUnitReport(d.state)).toContain("the approval could not be posted");
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
    const d = new Driver(openUnitPipeline(input(), T0));
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

  it("a read-record that says `interrupted` ends the unit with the ship-restart note, naming the pull request when one was opened", () => {
    const noPr = atWait();
    noPr.answer({ type: "wait", outcome: "event" });
    noPr.answer({ type: "read-record", run: finished({ status: "interrupted" }), at: T0 + 5 * MIN });
    expect(noPr.action).toMatchObject({ type: "end", ending: { kind: "interrupted", runId: "run-c0" } });
    expect(renderUnitReport(noPr.state)).toBe(shipInterruptedNote());
    expect(noPr.rounds()).toEqual(["0 coding started", "0 coding aborted"]);

    const withPr = new Driver(openUnitPipeline(input(), T0));
    throughRoundZero(withPr);
    runChild(withPr, "run-r1", finished({ status: "interrupted" }), T0 + 20 * MIN);
    expect(withPr.action).toMatchObject({ type: "end", ending: { kind: "interrupted", runId: "run-r1" } });
    expect(renderUnitReport(withPr.state)).toBe(shipInterruptedNote(PR_URL));
  });

  it("a spawn answering `alreadySpawned` proceeds to the wait on that run without a second child", () => {
    const d = new Driver(openUnitPipeline(input(), T0));
    d.answer({ type: "branch", ok: true, at: T0 });
    d.answer({ type: "spawn", outcome: "alreadySpawned", runId: "run-c0", at: T0 });
    expect(d.action).toMatchObject({ type: "wait", runId: "run-c0", step: "U10/0/coding/wait/1" });
    expect(d.rounds()).toEqual(["0 coding started"]);
  });

  it("a spawn answering `busy` waits for the live run's end, then spawns the same step again; a second `busy` waits again under a new name", () => {
    const d = new Driver(openUnitPipeline(input(), T0));
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
    const refused = new Driver(openUnitPipeline(input(), T0));
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

    const failed = new Driver(openUnitPipeline(input(), T0));
    failed.answer({ type: "branch", ok: true, at: T0 });
    failed.answer({ type: "spawn", outcome: "failed", reason: "HTTP 503", at: T0 });
    expect(failed.action).toMatchObject({ type: "end", ending: { kind: "aborted" } });
    expect(renderUnitReport(failed.state)).toContain("HTTP 503");
  });

  it("the merge: `pending` polls under a bounded wait, `refused` ends the unit naming the reason, and the poll's budget is its own — never the pipeline's", () => {
    const d = new Driver(openUnitPipeline(input(), T0));
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
    expect(d.action).toMatchObject({ type: "sleep", step: "U10/merge/sleep/1", ms: MERGE_POLL_MS });
    d.answer({ type: "sleep" });
    expect(d.action).toMatchObject({ type: "merge", step: "U10/merge/2" });
    // Every poll answers pending: the wait is bounded by MERGE_WAIT_MAX_MS from the first ask.
    let polls = 2;
    for (;;) {
      const at = T0 + 20 * MIN + (polls - 1) * MERGE_POLL_MS;
      const next = d.answer({ type: "merge", outcome: "pending", reason: "checks running", at });
      if (next.type === "end") break;
      expect(next).toMatchObject({ type: "sleep" });
      d.answer({ type: "sleep" });
      polls += 1;
      expect(polls).toBeLessThan(100);
    }
    expect(d.action).toMatchObject({ type: "end", ending: { kind: "merge_refused" } });
    expect((polls - 1) * MERGE_POLL_MS).toBeGreaterThanOrEqual(MERGE_WAIT_MAX_MS);
    expect(renderUnitReport(d.state)).toContain("checks running");

    const refused = new Driver(openUnitPipeline(input(), T0));
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
    expect(renderUnitReport(refused.state)).toContain("head moved");
  });

  it("an approve on a plan branch with no known head to merge at is a refused merge, never a person's merge-ready", () => {
    const d = new Driver(openUnitPipeline(input(), T0));
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

  it("a fix round whose pull request was closed out from under it and reopened adopts the open pull request on the branch; one with no open pull request aborts", () => {
    const adopt = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
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

    const gone = new Driver(openUnitPipeline(input({ merge: "person" }), T0));
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
    d.answer({ type: "branch", ok: true, at: T0 });
    seen.push(d.action.step);
    runChild(d, "run-c0", finished({ status: "completed", pr: { number: 7, url: PR_URL, created: true } }), T0 + MIN);
    seen.push(d.action.step);
    d.answer({ type: "pr-check", pr: { state: "open", prNumber: 7, url: PR_URL, headSha: HEAD_A }, at: T0 + MIN });
    seen.push(d.action.step);
    expect(seen).toEqual(["U12/branch", "U12/0/coding", "U12/0/coding/pr-check", "U12/1/review"]);
    for (const s of seen) expect(s).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/);
  });
});
