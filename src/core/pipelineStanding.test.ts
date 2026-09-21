import { describe, expect, it } from "vitest";
import {
  ENDING_STAGE,
  endingWordOf,
  pipelineOfEvents,
  pipelineStandingOf,
  ROUND_STAGE,
  roundOutcomeWordOf,
  STAGES,
  summaryOfStanding,
  isPipelineSummaryShape,
  type Stage,
} from "./pipelineStanding.js";
import type { RunEvent, ShipRoundOutcome } from "./runEvents.js";
import type { UnitEnding } from "./ship/coordinator.js";

// ---- the union pins (record 0065): a word added to either union must fail here ----

/** Compile-time exhaustive switch over `ShipRoundOutcome`: a new outcome makes
 *  this function fail to type-check until the fold's mapping decides it. */
function roundStageDecided(o: ShipRoundOutcome): string {
  switch (o) {
    case "started":
    case "pr_opened":
    case "completed":
    case "approve":
    case "request_changes":
    case "no_verdict":
    case "checks_failed":
    case "checks_restarted":
    case "transient":
    case "enqueued":
    case "dequeued":
    case "aborted":
    case "stopped":
    case "held":
    case "continued":
    case "idle":
      return ROUND_STAGE[o];
  }
}

/** Compile-time exhaustive switch over `UnitEnding["kind"]`: a new ending kind
 *  fails here until the fold's mapping decides it. */
function endingStageDecided(k: UnitEnding["kind"]): string {
  switch (k) {
    case "merged":
    case "already_landed":
    case "merge_ready":
    case "held":
    case "merge_refused":
    case "round_cap":
    case "wall_clock_cap":
    case "review_pending":
    case "stopped":
    case "aborted":
    case "transient":
    case "continued":
    case "no_verdict":
    case "interrupted":
    case "refused":
    case "idle":
    case "idle_expired":
      return ENDING_STAGE[k];
  }
}

const ROUND_OUTCOME_WORDS = [
  "started",
  "pr_opened",
  "completed",
  "approve",
  "request_changes",
  "no_verdict",
  "checks_failed",
  "checks_restarted",
  "transient",
  "enqueued",
  "dequeued",
  "aborted",
  "stopped",
  "held",
  "continued",
  "idle",
] as const satisfies readonly ShipRoundOutcome[];

const UNIT_ENDING_WORDS = [
  "merged",
  "already_landed",
  "merge_ready",
  "held",
  "merge_refused",
  "round_cap",
  "wall_clock_cap",
  "review_pending",
  "stopped",
  "aborted",
  "transient",
  "continued",
  "no_verdict",
  "interrupted",
  "refused",
  "idle",
  "idle_expired",
] as const satisfies readonly UnitEnding["kind"][];

// ---- event builders --------------------------------------------------------

function round(index: number, agent: string, outcome: string, at: number): RunEvent {
  return { type: "ship_round", index, agent, outcome: outcome as ShipRoundOutcome, at };
}

function unit(name: string, state: string, at: number, extra: { pr?: number; threadKey?: string } = {}): RunEvent {
  return { type: "ship_unit", unit: name, state, at, ...extra };
}

describe("the fold binds rounds by adjacency, ignores a companion's state and is total over the unions", () => {
  it("the runtime tables cover every member of both unions and nothing else", () => {
    expect(Object.keys(ROUND_STAGE).sort()).toEqual([...ROUND_OUTCOME_WORDS].sort());
    // `blocked` and `failed` are unit statuses the driver posts to `unit-end`
    // beyond the machine's ending union: `blocked` for a unit that never
    // started, `failed` for a step that threw inside the walk (issue 2100).
    expect(Object.keys(ENDING_STAGE).sort()).toEqual([...UNIT_ENDING_WORDS, "blocked", "failed"].sort());
    for (const o of ROUND_OUTCOME_WORDS) expect(typeof roundStageDecided(o)).toBe("string");
    for (const k of UNIT_ENDING_WORDS) expect(typeof endingStageDecided(k)).toBe("string");
  });

  it("binds each round to the ship_unit published next at the same stamp, two units interleaved", () => {
    const standing = pipelineStandingOf([
      unit("U14", "started", 100),
      round(0, "coding", "started", 110),
      unit("U14", "started", 110),
      unit("U25", "started", 120),
      round(0, "coding", "started", 130),
      unit("U25", "started", 130),
      round(0, "coding", "pr_opened", 200),
      unit("U14", "pr_opened", 200, { pr: 412 }),
      round(1, "review", "approve", 300),
      unit("U25", "approve", 300, { pr: 500 }),
    ]);
    expect(standing.unnamedRounds).toEqual([]);
    const [u1, u2] = standing.units;
    expect(u1).toMatchObject({ unit: "U14", stage: "review", round: 0, pr: 412 });
    expect(u2).toMatchObject({ unit: "U25", stage: "approved", round: 1, pr: 500 });
  });

  it("a companion whose state is an ending word (aborted, continued) contributes its facts and never a stage", () => {
    const standing = pipelineStandingOf([
      unit("U14", "started", 100),
      // The round route publishes the outcome as the companion's state: the
      // fold must take the stage from the ROUND, never the companion.
      round(1, "review", "request_changes", 200),
      unit("U14", "aborted", 200, { pr: 7, threadKey: "slack:C1:1.2" }),
      round(1, "coding", "started", 210),
      unit("U14", "continued", 210),
    ]);
    const u1 = standing.units[0]!;
    expect(u1.stage).toBe("fix");
    expect(u1.pr).toBe(7);
    expect(u1.threadKey).toBe("slack:C1:1.2");
    expect(u1.detail).toBeUndefined();
  });

  it("an idle unit reopens at its next started as the next segment; a continued round raises the segment and keeps coding", () => {
    const idled = pipelineStandingOf([
      unit("U14", "started", 100),
      unit("U14", "idle", 200),
      unit("U14", "started", 300),
    ]);
    expect(idled.units[0]).toMatchObject({ stage: "coding", segment: 2, since: 300 });

    const continued = pipelineStandingOf([
      unit("U14", "started", 100),
      round(0, "coding", "continued", 200),
      unit("U14", "continued", 200),
      unit("U14", "started", 300),
    ]);
    // The continued round opens segment 2; the republished `started` of the
    // next segment holds coding and raises nothing further.
    expect(continued.units[0]).toMatchObject({ stage: "coding", segment: 2 });
    // An unbound `continued` ship_unit (a unit-end without its round) is not
    // an ending: the unit holds coding, open.
    const unbound = pipelineStandingOf([unit("U14", "started", 100), unit("U14", "continued", 200)]);
    expect(unbound.units[0]).toMatchObject({ stage: "coding", since: 100 });
  });

  it("an older record's rounds name no unit and list as unnamed rounds", () => {
    const standing = pipelineStandingOf([
      round(0, "coding", "started", 100),
      round(0, "coding", "pr_opened", 200),
      round(1, "review", "approve", 300),
    ]);
    expect(standing.units).toEqual([]);
    expect(standing.unnamedRounds).toEqual([
      { index: 0, agent: "coding", outcome: "started", at: 100 },
      { index: 0, agent: "coding", outcome: "pr_opened", at: 200 },
      { index: 1, agent: "review", outcome: "approve", at: 300 },
    ]);
    const summary = summaryOfStanding(standing);
    expect(summary.total).toBe(0);
    expect(summary.lastRound).toEqual({ index: 1, agent: "review", outcome: "approve", at: 300 });
  });

  it("a unit adopted at review enters with no round 0: its first bound round says review", () => {
    const standing = pipelineStandingOf([round(1, "review", "started", 100), unit("U14", "started", 100, { pr: 9 })]);
    expect(standing.units[0]).toMatchObject({ unit: "U14", stage: "review", round: 1, pr: 9, segment: 1 });
  });

  it("since is the stamp that set the stage and holds while the stage does", () => {
    const standing = pipelineStandingOf([
      unit("U14", "started", 100),
      round(0, "coding", "started", 110),
      unit("U14", "started", 110), // no stage change: since holds at 100
      round(0, "coding", "pr_opened", 200),
      unit("U14", "pr_opened", 200, { pr: 3 }),
      round(1, "review", "started", 205),
      unit("U14", "started", 205), // review already: since holds at 200
      round(1, "review", "aborted", 300), // hold: stage and since untouched
      unit("U14", "aborted", 300),
    ]);
    expect(standing.units[0]).toMatchObject({ stage: "review", since: 200 });
    expect(standing.changes.map((c) => ({ at: c.at, stage: c.stage }))).toEqual([
      { at: 100, stage: "coding" },
      { at: 200, stage: "review" },
    ]);
  });

  it("endings map: merged and already_landed to merged, merge_ready to merge-ready, blocked and the rest to ended with the kind as detail", () => {
    const fold = (state: string): { stage: Stage; detail?: string } => {
      const u = pipelineStandingOf([unit("U14", "started", 100), unit("U14", state, 200)]).units[0]!;
      return { stage: u.stage, ...(u.detail !== undefined ? { detail: u.detail } : {}) };
    };
    expect(fold("merged")).toEqual({ stage: "merged" });
    expect(fold("already_landed")).toEqual({ stage: "merged" });
    expect(fold("merge_ready")).toEqual({ stage: "merge-ready" });
    expect(fold("idle")).toEqual({ stage: "idle" });
    expect(fold("wall_clock_cap")).toEqual({ stage: "ended", detail: "wall_clock_cap" });
    expect(fold("refused")).toEqual({ stage: "ended", detail: "refused" });
    // `blocked` with no prior enters closed.
    const blocked = pipelineStandingOf([unit("U25", "blocked", 100)]).units[0]!;
    expect(blocked).toMatchObject({ stage: "ended", detail: "blocked" });
  });

  it("is total: an unknown word holds the stage, a round-outcome word on an unbound ship_unit holds, and the fold never throws", () => {
    const standing = pipelineStandingOf([
      unit("U14", "started", 100),
      unit("U14", "some_future_word", 200),
      unit("U14", "pr_opened", 300), // a route that skipped its round: holds
      round(9, "gardening", "some_future_outcome", 400),
      unit("U14", "some_future_outcome", 400),
    ]);
    expect(standing.units[0]).toMatchObject({ stage: "coding", since: 100 });
    expect(pipelineStandingOf([])).toEqual({ units: [], unnamedRounds: [], changes: [] });
  });

  it("the summary lists the open units, zero-filled counts and the units seen; pipelineOfEvents is nothing without ship facts", () => {
    const summary = summaryOfStanding(
      pipelineStandingOf([
        unit("U14", "started", 100),
        unit("U14", "merged", 200),
        unit("U25", "started", 300),
        round(1, "review", "started", 400),
        unit("U25", "started", 400),
      ]),
    );
    expect(summary.total).toBe(2);
    expect(summary.current.map((u) => u.unit)).toEqual(["U25"]);
    expect(summary.counts).toMatchObject({ merged: 1, review: 1, coding: 0 });
    expect(Object.keys(summary.counts).sort()).toEqual([...STAGES].sort());
    expect(isPipelineSummaryShape(summary)).toBe(true);
    expect(pipelineOfEvents([{ type: "answer", text: "hi", at: 1 }])).toBeUndefined();
    expect(pipelineOfEvents([round(0, "coding", "started", 1)])).toMatchObject({ total: 0 });
  });
});

describe("the user's words for endings and round outcomes (record 0066)", () => {
  it("every ending kind has a word without an internal token — merge_ready reads merge-ready, round_cap reads round cap reached — and the maps carry no underscores", () => {
    expect(endingWordOf("merge_ready")).toBe("merge-ready");
    expect(endingWordOf("round_cap")).toBe("round cap reached");
    expect(endingWordOf("wall_clock_cap")).toBe("out of budget");
    expect(endingWordOf("held")).toBe("held");
    expect(endingWordOf("stopped")).toBe("stopped");
    expect(endingWordOf("already_landed")).toBe("merged");
    for (const kind of [...UNIT_ENDING_WORDS, "blocked", "failed"]) expect(endingWordOf(kind)).not.toMatch(/_/);
    for (const outcome of ROUND_OUTCOME_WORDS) expect(roundOutcomeWordOf(outcome)).not.toMatch(/_/);
  });

  it("round outcomes read in plain words — checks_failed reads checks failed — and an unknown token prints as itself, total over stored rows", () => {
    expect(roundOutcomeWordOf("checks_failed")).toBe("checks failed");
    expect(roundOutcomeWordOf("request_changes")).toBe("changes requested");
    expect(roundOutcomeWordOf("pr_opened")).toBe("pull request opened");
    expect(endingWordOf("some_future_kind")).toBe("some_future_kind");
    expect(roundOutcomeWordOf("some_future_outcome")).toBe("some_future_outcome");
  });
});
