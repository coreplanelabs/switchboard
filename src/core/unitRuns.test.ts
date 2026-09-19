import { describe, expect, it } from "vitest";
import type { CoordinatorUnit } from "./coordinator/contract.js";
import type { RunView } from "./runsService.js";
import { roundBoundaries, unitFactsOf, unitRunsOf, unitSessionKeys } from "./unitRuns.js";

// Feature: docs/reference/specs/agent-ship.md item 17 — the unit is the
// reading unit. The pure half: how a unit's two threads' runs are cut at the
// round boundaries its row records and laid out in time order, each run with
// the round and the thread it belongs to.

const T0 = 1_700_000_000_000;

function run(id: string, startedAt: number, over: Partial<RunView> = {}): RunView {
  return {
    id,
    agent: "coding",
    channelId: "slack:C1",
    userId: "slack:UALICE",
    threadKey: "slack:C1:unit",
    startedAt,
    finishedAt: startedAt + 5_000,
    finished: true,
    eventCount: 3,
    ...over,
  };
}

/** A unit through two review rounds, the round vocabulary as the runner
 *  reports it: round 0 is the coding round; review round n and its findings
 *  step share n. Every boundary is stamped when the runner reports it, so the
 *  `started` of a round precedes its child's start. */
const unit: CoordinatorUnit = {
  instanceId: "plan-p-1",
  unit: "U16",
  slug: "u1",
  branch: "plan/p/u1",
  dependsOn: [],
  threadKey: "slack:C1:unit",
  reviewThread: { threadKey: "slack:C1:review" },
  rounds: [
    { index: 0, agent: "coding", outcome: "started", at: T0 },
    { index: 0, agent: "coding", outcome: "pr_opened", at: T0 + 10_000 },
    { index: 1, agent: "review", outcome: "started", at: T0 + 11_000 },
    { index: 1, agent: "review", outcome: "request_changes", at: T0 + 20_000 },
    { index: 1, agent: "coding", outcome: "started", at: T0 + 21_000 },
    { index: 1, agent: "coding", outcome: "completed", at: T0 + 30_000 },
    { index: 2, agent: "review", outcome: "started", at: T0 + 31_000 },
    { index: 2, agent: "review", outcome: "approve", at: T0 + 40_000 },
  ],
};

describe("roundBoundaries — where each round of one thread begins", () => {
  it("one boundary per round index of the agent, at the earliest entry the row records for it, in time order", () => {
    expect(roundBoundaries(unit.rounds, "coding")).toEqual([
      { index: 0, at: T0 },
      { index: 1, at: T0 + 21_000 },
    ]);
    expect(roundBoundaries(unit.rounds, "review")).toEqual([
      { index: 1, at: T0 + 11_000 },
      { index: 2, at: T0 + 31_000 },
    ]);
    // a row whose first entry for a round is not `started` (a note lost, a row rewritten) still marks the round at its earliest entry
    expect(roundBoundaries([{ index: 3, agent: "review", outcome: "approve", at: T0 + 50 }], "review")).toEqual([
      { index: 3, at: T0 + 50 },
    ]);
    expect(roundBoundaries([], "coding")).toEqual([]);
  });
});

describe("unitRunsOf — a unit's runs cut at its round boundaries, in time order", () => {
  const coding = [run("c0", T0 + 1_000), run("c1", T0 + 22_000, { id: "c1" })];
  const review = [
    run("r1", T0 + 12_000, { agent: "review", threadKey: "slack:C1:review" }),
    run("r2", T0 + 32_000, { agent: "review", threadKey: "slack:C1:review" }),
  ];

  it("a unit with two rounds lists coding 0, review 1, coding 1 (the findings step), review 2 — each run with its round and thread", () => {
    expect(unitRunsOf(unit, { coding, review }).map((r) => [r.id, r.round, r.thread])).toEqual([
      ["c0", 0, "coding"],
      ["r1", 1, "review"],
      ["c1", 1, "coding"],
      ["r2", 2, "review"],
    ]);
    // every field of the run's view rides along
    expect(unitRunsOf(unit, { coding, review })[0]).toMatchObject({ ...coding[0], round: 0, thread: "coding" });
  });

  it("a unit whose review thread does not exist yet lists the coding thread alone", () => {
    const fresh: CoordinatorUnit = { ...unit, reviewThread: undefined, rounds: unit.rounds.slice(0, 2) };
    expect(unitRunsOf(fresh, { coding: [coding[0]], review: [] }).map((r) => [r.id, r.round, r.thread])).toEqual([
      ["c0", 0, "coding"],
    ]);
  });

  it("a unit with one thread (record 0055) cuts the thread's runs by agent: review runs at the review rounds, the rest at the coding rounds", () => {
    const one: CoordinatorUnit = { ...unit, reviewThread: undefined };
    const inOneThread = [
      coding[0],
      run("r1", T0 + 12_000, { agent: "review" }),
      coding[1],
      run("r2", T0 + 32_000, { agent: "review" }),
    ];
    expect(unitRunsOf(one, { coding: inOneThread, review: [] }).map((r) => [r.id, r.round, r.thread])).toEqual([
      ["c0", 0, "coding"],
      ["r1", 1, "review"],
      ["c1", 1, "coding"],
      ["r2", 2, "review"],
    ]);
    // Runs handed as the review thread's contribute nothing when the row names no such thread.
    expect(unitRunsOf(one, { coding: [coding[0]], review }).map((r) => r.id)).toEqual(["c0"]);
  });

  it("a person's run in a unit thread belongs to the round in flight when it started; a run from before the unit's first round is not the unit's", () => {
    const detour = run("d", T0 + 15_000, { agent: "explore" }); // during review round 1, in the coding thread
    const earlier = run("old", T0 - 60_000, { agent: "general" }); // the requesting thread's past, before round 0
    expect(unitRunsOf(unit, { coding: [earlier, detour, ...coding], review }).map((r) => [r.id, r.round])).toEqual([
      ["c0", 0],
      ["r1", 1],
      ["d", 0],
      ["c1", 1],
      ["r2", 2],
    ]);
  });

  it("the pipeline's own record is never a round's run, and a live run in flight lists with its round", () => {
    const ship = run("ship", T0 + 45_000, { agent: "ship" });
    const live = run("c2", T0 + 41_000, { finished: false, finishedAt: undefined });
    const listed = unitRunsOf(unit, { coding: [...coding, ship, live], review });
    expect(listed.map((r) => r.id)).toEqual(["c0", "r1", "c1", "r2", "c2"]);
    expect(listed.at(-1)).toMatchObject({ id: "c2", round: 1, thread: "coding", finished: false });
  });

  it("a unit with no thread yet, or no rounds yet, lists nothing", () => {
    expect(
      unitRunsOf({ ...unit, threadKey: undefined, reviewThread: undefined, rounds: [] }, { coding, review }),
    ).toEqual([]);
    expect(unitRunsOf({ ...unit, rounds: [] }, { coding, review })).toEqual([]);
  });

  it("two runs that started in the same millisecond order coding before review, then by id", () => {
    const c = run("b", T0 + 12_000);
    const r = run("a", T0 + 12_000, { agent: "review", threadKey: "slack:C1:review" });
    expect(unitRunsOf(unit, { coding: [c], review: [r] }).map((x) => x.id)).toEqual(["b", "a"]);
    expect(unitRunsOf(unit, { coding: [run("z", T0 + 1), run("y", T0 + 1)], review: [] }).map((x) => x.id)).toEqual([
      "y",
      "z",
    ]);
  });
});

// record 0051; run-history item 50: the row's idle is projected onto the
// unit's readable facts — the page's `idle · <why>` — without the machine
// fields a continuation reads (`from`, `runId`, the handoff).
describe("unitFactsOf — the idle on the facts", () => {
  it("a row with an idle carries {why, at, renewalsLeft, wakes} on the facts; a row without one carries none", () => {
    const idle = {
      why: "wall_clock_cap",
      at: T0 + 50_000,
      renewalsLeft: 2,
      from: "a".repeat(40),
      runId: "run-c0",
      spendUsd: 12.5,
      handoff: { deviations: [], followUps: [], unproven: [] },
      wakes: 0,
    };
    const facts = unitFactsOf({ ...unit, idle });
    expect(facts.idle).toEqual({ why: "wall_clock_cap", at: T0 + 50_000, renewalsLeft: 2, wakes: 0 });
    expect(facts.idle).not.toHaveProperty("from");
    expect(facts.idle).not.toHaveProperty("runId");
    expect(facts.idle).not.toHaveProperty("handoff");
    expect(unitFactsOf(unit).idle).toBeUndefined();
    expect(unitFactsOf(unit)).not.toHaveProperty("idle");
  });
});

describe("unitSessionKeys — the unit page's working-session keys (session-log item 13)", () => {
  it("derives <instance>:<unit>:coding and <instance>:<unit>:review, and a re-issue's attempt suffix is stripped so it searches the lanes it continued", () => {
    expect(unitSessionKeys({ instanceId: "plan-p", id: "U16" })).toEqual({
      coding: "plan-p:U16:coding",
      review: "plan-p:U16:review",
    });
    expect(unitSessionKeys({ instanceId: "plan-p-2", id: "U16", instance: { attempt: 2 } })).toEqual({
      coding: "plan-p:U16:coding",
      review: "plan-p:U16:review",
    });
  });
});
