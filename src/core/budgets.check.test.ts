// Feature: docs/reference/specs/harness-pi.md item 15 and docs/reference/specs/agent-ship.md
// item 8 — every wall clock is a lease carved from its parent, and the numbers
// that must hold each other are asserted here, so a change to one that breaks
// another's assumption is a red build (docs/decisions/0046).
import { describe, expect, it } from "vitest";

import { AGENTS } from "../agents/registry.js";
import {
  DEFAULT_GRANT,
  leaseMinimum,
  GRANT_RENEWALS_MAX,
  ALLOWANCES,
  ASKS,
  BASH_COMMAND,
  bearerExpiresAt,
  carve,
  carveChildOfParent,
  FLOORS,
  fit,
  LOOP_PRESETS,
  loopClock,
  loopPosition,
  loopRounds,
  MERGE_WAIT_ASK_MINUTES,
  MINUTE_MS,
  POST_STEP_MINUTES,
  postStepLease,
  postStepMinutes,
  PRESET_FLOORS,
  provisionalBearerExpiresAt,
  reserveMinutes,
  SHIP_WAIT,
  RUNAWAY_TURNS_PER_MINUTE,
  runawayTurnCap,
  turnLeaseMs,
  WRAP_UP_WARNING,
} from "./budgets.js";

const SHIP_DEFAULT = { maxMinutes: ASKS.ship, maxRounds: 3 };

describe("the budgets module — one table every wall clock derives from (docs/decisions/0046)", () => {
  it("the asks: coding 90, review 25, research 8, general 5, explore 120, conductor 120, orchestrator 10, ship 240", () => {
    expect(ASKS).toEqual({
      general: 5,
      coding: 90,
      review: 25,
      ship: 240,
      research: 8,
      explore: 120,
      conductor: 120,
      orchestrator: 10,
    });
  });

  it("every floor is at most its round's ask, and the merge wait has an ask and a floor of its own", () => {
    expect(FLOORS.coding).toBeLessThanOrEqual(ASKS.coding);
    expect(FLOORS.findings).toBeLessThanOrEqual(ASKS.coding);
    expect(FLOORS.review).toBeLessThanOrEqual(ASKS.review);
    expect(FLOORS.merge).toBeLessThanOrEqual(MERGE_WAIT_ASK_MINUTES);
    expect(MERGE_WAIT_ASK_MINUTES).toBe(60);
  });

  it("the loop at 3 review rounds is coding, review, findings, review, findings, review, merge", () => {
    expect(loopRounds({ maxRounds: 3 })).toEqual([
      "coding",
      "review",
      "findings",
      "review",
      "findings",
      "review",
      "merge",
    ]);
    expect(loopRounds({ maxRounds: 1 })).toEqual(["coding", "review", "merge"]);
  });

  it("the coordinator's round numbers map onto the loop's positions: coding 0; review n and its findings round at 2n − 1 and 2n; the merge last", () => {
    const loop = { maxRounds: 3 };
    expect(loopPosition(loop, "coding")).toBe(0);
    expect(loopPosition(loop, "review", 1)).toBe(1);
    expect(loopPosition(loop, "findings", 1)).toBe(2);
    expect(loopPosition(loop, "review", 3)).toBe(5);
    expect(loopPosition(loop, "merge")).toBe(6);
    expect(loopRounds(loop)[loopPosition(loop, "merge")]).toBe("merge");
  });

  it("the floors are the presets': coding 15, review 5, research 3, general and the orchestrator 2, explore and conductor 15 — the round floors derive from them (a findings round under 15 cannot run the suite its contract requires), and the ship waits are rows", () => {
    expect(PRESET_FLOORS).toEqual({
      general: 2,
      coding: 15,
      review: 5,
      research: 3,
      explore: 15,
      conductor: 15,
      orchestrator: 2,
    });
    expect(FLOORS).toEqual({ coding: 15, findings: 15, review: 5, merge: 10 });
    expect(SHIP_WAIT).toEqual({ marginMinutes: 5, chunkMinutes: 5, mergeChunkMinutes: 5, busyRetryMinutes: 2 });
  });
});

describe("the reserve — derived over the rounds that must follow, never tabled", () => {
  it("before the coding round at 3 rounds: three reviews and two findings rounds with their provisioning, plus the merge floor", () => {
    const expected =
      3 * (FLOORS.review + ALLOWANCES.provision) + 2 * (FLOORS.findings + ALLOWANCES.provision) + FLOORS.merge;
    expect(reserveMinutes({ kind: "coding", index: 0 }, SHIP_DEFAULT)).toBe(expected);
    expect(expected).toBe(70);
  });

  it("before the coding round at 4 rounds: four reviews and three findings rounds with their provisioning, plus the merge floor, 96", () => {
    const expected =
      4 * (FLOORS.review + ALLOWANCES.provision) + 3 * (FLOORS.findings + ALLOWANCES.provision) + FLOORS.merge;
    expect(reserveMinutes({ kind: "coding", index: 0 }, { maxRounds: 4 })).toBe(expected);
    expect(expected).toBe(96);
  });

  it("before each later round the reserve is what follows it: 62 before the first review, 44 before the first findings round, 36, 18, 10, then 0 before the merge", () => {
    const loop = SHIP_DEFAULT;
    expect(reserveMinutes({ kind: "review", index: 1 }, loop)).toBe(62);
    expect(reserveMinutes({ kind: "findings", index: 2 }, loop)).toBe(44);
    expect(reserveMinutes({ kind: "review", index: 3 }, loop)).toBe(36);
    expect(reserveMinutes({ kind: "findings", index: 4 }, loop)).toBe(18);
    expect(reserveMinutes({ kind: "review", index: 5 }, loop)).toBe(10);
    expect(reserveMinutes({ kind: "merge", index: 6 }, loop)).toBe(0);
  });

  it("the reserve moves with a floor: a review floor one minute higher adds three minutes before the coding round", () => {
    const base = reserveMinutes({ kind: "coding", index: 0 }, SHIP_DEFAULT);
    const moved = reserveMinutes({ kind: "coding", index: 0 }, SHIP_DEFAULT, { ...FLOORS, review: FLOORS.review + 1 });
    expect(moved - base).toBe(3);
  });
});

describe("carve — a round's minutes from the parent's remainder, refused under the floor", () => {
  it("the coding round from 238 minutes at 3 rounds is 90, bounded by its ask, holding 70", () => {
    expect(carve(238 * MINUTE_MS, { kind: "coding", index: 0 }, SHIP_DEFAULT)).toEqual({
      kind: "carved",
      minutes: 90,
      boundedBy: "ask",
      holds: 70,
    });
  });

  it("a findings round from 50 minutes is refused under its floor of 15: 50 − 44 leaves 6", () => {
    expect(carve(50 * MINUTE_MS, { kind: "findings", index: 2 }, SHIP_DEFAULT)).toEqual({
      kind: "refused",
      reason: "under floor",
      minutes: 6,
      floor: 15,
      holds: 44,
    });
  });

  it("the last review from 35 minutes is 25 holding 10; the first review from 35 is refused, since 35 − 62 is under its floor", () => {
    expect(carve(35 * MINUTE_MS, { kind: "review", index: 5 }, SHIP_DEFAULT)).toEqual({
      kind: "carved",
      minutes: 25,
      boundedBy: "ask",
      holds: 10,
    });
    expect(carve(35 * MINUTE_MS, { kind: "review", index: 1 }, SHIP_DEFAULT)).toMatchObject({
      kind: "refused",
      reason: "under floor",
      floor: 5,
    });
  });

  it("a round bounded by the parent says so: a findings round from 30 minutes is refused reporting 0, not −14; from 60 it gets 16 bounded by the parent", () => {
    expect(carve(30 * MINUTE_MS, { kind: "findings", index: 2 }, SHIP_DEFAULT)).toEqual({
      kind: "refused",
      reason: "under floor",
      minutes: 0,
      floor: 15,
      holds: 44,
    });
    expect(carve(60 * MINUTE_MS, { kind: "findings", index: 2 }, SHIP_DEFAULT)).toEqual({
      kind: "carved",
      minutes: 16,
      boundedBy: "parent",
      holds: 44,
    });
  });

  it("the merge wait is carved like any round: 60 from a wide remainder, the remainder itself when narrower, refused under 10", () => {
    expect(carve(100 * MINUTE_MS, { kind: "merge", index: 6 }, SHIP_DEFAULT)).toMatchObject({
      kind: "carved",
      minutes: 60,
    });
    expect(carve(20 * MINUTE_MS, { kind: "merge", index: 6 }, SHIP_DEFAULT)).toMatchObject({
      kind: "carved",
      minutes: 20,
      boundedBy: "parent",
    });
    expect(carve(9 * MINUTE_MS, { kind: "merge", index: 6 }, SHIP_DEFAULT)).toMatchObject({ kind: "refused" });
  });

  it("a conductor's child takes the parent's whole remainder, refused under its preset's floor: a research child with 2.5 minutes left is refused (floor 3), a general child with 2 is carved 2", () => {
    expect(carveChildOfParent(2.5 * MINUTE_MS, "research")).toEqual({
      kind: "refused",
      reason: "under floor",
      minutes: 2,
      floor: 3,
    });
    expect(carveChildOfParent(2 * MINUTE_MS, "general")).toEqual({ kind: "carved", minutes: 2 });
    expect(carveChildOfParent(0, "explore")).toEqual({ kind: "refused", reason: "under floor", minutes: 0, floor: 15 });
  });

  it("a child with no loop (a conductor's) takes only the floor and the parent: 30 minutes carve 30, 14 are refused", () => {
    expect(carve(30 * MINUTE_MS, { kind: "coding", index: 0 }, undefined)).toEqual({
      kind: "carved",
      minutes: 30,
      boundedBy: "parent",
      holds: 0,
    });
    expect(carve(14 * MINUTE_MS, { kind: "coding", index: 0 }, undefined)).toMatchObject({
      kind: "refused",
      floor: 15,
    });
  });
});

describe("the fit — a pipeline holds its first child at its ask and every later round at its floor", () => {
  it("the loop the config allows by default fits inside the pipeline's ask with room for findings rounds at their ask: ship at 3 rounds needs 163 of 240", () => {
    expect(fit(SHIP_DEFAULT)).toEqual({ ok: true, need: 163, have: 240 });
    expect(fit(SHIP_DEFAULT).need).toBe(ALLOWANCES.provision + ASKS.coding + 70);
  });

  it("a fourth round needs 189: it fits the ask's 240, and a deployment at 180 is refused naming the sum", () => {
    expect(fit({ maxMinutes: 240, maxRounds: 4 })).toEqual({ ok: true, need: 189, have: 240 });
    expect(fit({ maxMinutes: 180, maxRounds: 4 })).toEqual({ ok: false, need: 189, have: 180 });
  });

  it("the deployment that lost twelve children in a day fails the fit: 40 against 163", () => {
    expect(fit({ maxMinutes: 40, maxRounds: 3 })).toEqual({ ok: false, need: 163, have: 40 });
  });

  it("the conductor runs no fixed loop; its ask holds a provisioned coding child: 3 + 90 = 93 of 120", () => {
    expect(ALLOWANCES.provision + ASKS.coding).toBe(93);
    expect(ASKS.conductor).toBeGreaterThanOrEqual(ALLOWANCES.provision + ASKS.coding);
  });
});

describe("the stack — the write-up, the post-step and the exec margin fit inside every loop-running preset's ask", () => {
  it("writeUp + postStep(preset) + execCall ≤ ask(preset) for every preset, a post-step of 0 where the preset runs none", () => {
    for (const preset of LOOP_PRESETS) {
      const stack = ALLOWANCES.writeUp + POST_STEP_MINUTES[preset] + ALLOWANCES.execCall;
      expect(stack, preset).toBeLessThanOrEqual(ASKS[preset]);
    }
    expect(POST_STEP_MINUTES).toEqual({
      coding: 5,
      review: 3,
      general: 0,
      research: 0,
      explore: 0,
      conductor: 0,
      orchestrator: 0,
      ship: 0,
    });
  });

  it("a command is refused before the write-up begins: commandWriteUp ≤ writeUp; and the bash caps are module rows", () => {
    expect(ALLOWANCES.commandWriteUp).toBeLessThanOrEqual(ALLOWANCES.writeUp);
    expect(BASH_COMMAND).toEqual({ defaultMinutes: 5, maxMinutes: 20, minMs: 1_000 });
  });
});

describe("the lease minimum — the least lease whose loop has a minute after the write-up and the post-step", () => {
  it("is the write-up, the preset's post-step and one minute: 4 for a preset without a post-step, 9 for coding, 7 for review; an unknown preset reads as one without a post-step", () => {
    expect(leaseMinimum("general")).toBe(4);
    expect(leaseMinimum("research")).toBe(4);
    expect(leaseMinimum("explore")).toBe(4);
    expect(leaseMinimum("conductor")).toBe(4);
    expect(leaseMinimum("coding")).toBe(9);
    expect(leaseMinimum("review")).toBe(7);
    expect(leaseMinimum("not-a-preset")).toBe(4);
  });

  it("every loop-running preset's ask holds its minimum, so a declared profile is never refused on its own", () => {
    for (const preset of LOOP_PRESETS) expect(ASKS[preset], preset).toBeGreaterThanOrEqual(leaseMinimum(preset));
  });

  it("a lease at the minimum leaves its loop exactly one minute; one under it leaves none", () => {
    const T0 = 1_700_000_000_000;
    expect(loopClock(T0, leaseMinimum("explore") * MINUTE_MS, "explore").loopEnd - T0).toBe(MINUTE_MS);
    expect(loopClock(T0, 3 * MINUTE_MS, "explore").loopEnd - T0).toBe(0);
  });
});

describe("the derivations the registry reads from the module", () => {
  it("every loop-running preset's maxMinutes is its ask and its maxTurns is runawayTurnCap(ask); ship keeps its structural 1", () => {
    for (const preset of LOOP_PRESETS) {
      expect(AGENTS[preset].maxMinutes, preset).toBe(ASKS[preset]);
      expect(AGENTS[preset].maxTurns, preset).toBe(runawayTurnCap(ASKS[preset]));
    }
    expect(AGENTS.ship.maxMinutes).toBe(ASKS.ship);
    expect(AGENTS.ship.maxTurns).toBe(1);
    expect(RUNAWAY_TURNS_PER_MINUTE).toBe(6);
  });
});

describe("the loop's clocks — the loop ends inside the lease, so the write-up and the post-step fit", () => {
  const T0 = 1_700_000_000_000;
  it("a coding lease of 90 minutes ends its loop at 82: the write-up's 3 and the post-step's 5 are held back; the warning lands 3 minutes before the loop's end; the write-up is bounded by its allowance", () => {
    const c = loopClock(T0, 90 * MINUTE_MS, "coding");
    expect(c).toEqual({
      startedAt: T0,
      deadline: T0 + 90 * MINUTE_MS,
      loopEnd: T0 + 82 * MINUTE_MS,
      warnAt: T0 + 79 * MINUTE_MS,
      finaleMs: ALLOWANCES.writeUp * MINUTE_MS,
    });
    expect(c.deadline - c.loopEnd).toBe((ALLOWANCES.writeUp + POST_STEP_MINUTES.coding) * MINUTE_MS);
  });
  it("a preset without a post-step holds back the write-up alone: a general lease of 5 ends its loop at 2, and its warning is a quarter of the loop before that", () => {
    const c = loopClock(T0, 5 * MINUTE_MS, "general");
    expect(c.loopEnd).toBe(T0 + 2 * MINUTE_MS);
    expect(c.warnAt).toBe(T0 + 1.5 * MINUTE_MS);
    expect(WRAP_UP_WARNING).toEqual({ minutes: 3, fraction: 0.25 });
  });
  it("a lease shorter than its hold-back has no loop time: the loop ends at its start, never before it", () => {
    const c = loopClock(T0, 3 * MINUTE_MS, "coding");
    expect(c.loopEnd).toBe(T0);
    expect(c.warnAt).toBe(T0);
    expect(c.deadline).toBe(T0 + 3 * MINUTE_MS);
  });
  it("a follow-up turn on the session holds nothing back — its deliverable is a tool call, not a write-up — and is still bounded by the write-up allowance past its deadline", () => {
    const c = loopClock(T0, 5 * MINUTE_MS, "coding", "turn");
    expect(c.loopEnd).toBe(c.deadline);
    expect(c.finaleMs).toBe(ALLOWANCES.writeUp * MINUTE_MS);
  });
  it("a preset name outside the table has no post-step; the post-step of a run is carved from the lease's remainder with a floor of one minute: 20 minutes left give coding 5 and review 3, one minute left gives 1, none left still gives 1", () => {
    expect(postStepMinutes("coding")).toBe(5);
    expect(postStepMinutes("conformance")).toBe(0);
    expect(postStepLease("coding", 20 * MINUTE_MS)).toBe(5);
    expect(postStepLease("review", 20 * MINUTE_MS)).toBe(3);
    expect(postStepLease("coding", 1 * MINUTE_MS)).toBe(1);
    expect(postStepLease("coding", 0)).toBe(1);
    expect(postStepLease("coding", undefined)).toBe(5);
    expect(postStepLease("general", 20 * MINUTE_MS)).toBe(0);
  });
  it("a follow-up turn's lease is the lesser of its ask and the lease's remainder, never under a minute", () => {
    expect(turnLeaseMs(5, 20 * MINUTE_MS)).toBe(5 * MINUTE_MS);
    expect(turnLeaseMs(5, 2.5 * MINUTE_MS)).toBe(2.5 * MINUTE_MS);
    expect(turnLeaseMs(5, 0)).toBe(MINUTE_MS);
    expect(turnLeaseMs(25, -MINUTE_MS)).toBe(MINUTE_MS);
  });
  it("the bearer outlives the lease by its grace of one minute; the mint at provisioning is provisional — the provisioning allowance, the lease and the grace — until the lease starts", () => {
    expect(bearerExpiresAt(T0 + 90 * MINUTE_MS)).toBe(T0 + 91 * MINUTE_MS);
    expect(provisionalBearerExpiresAt(T0, 90)).toBe(T0 + (3 + 90 + 1) * MINUTE_MS);
    expect(ALLOWANCES.bearerGrace).toBe(1);
  });
});

describe("the grant — what the request authorizes beyond one lease, sized by the person", () => {
  it("defaults to zero renewals and no cost cap, so nothing renews until a scope or a directive says so", () => {
    expect(DEFAULT_GRANT).toEqual({ renewals: 0 });
    expect(DEFAULT_GRANT.costCapUsd).toBeUndefined();
  });

  it("bounds the renewals one request may carry: with the ship lease at its ask, thirteen segments are two days", () => {
    expect(GRANT_RENEWALS_MAX).toBe(12);
    expect((GRANT_RENEWALS_MAX + 1) * ASKS.ship).toBe(2 * 24 * 60 + 240);
  });
});
