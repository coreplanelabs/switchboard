// Every wall clock in Switchboard as one table (docs/decisions/0046; docs/reference/specs/harness-pi.md
// item 15; docs/reference/specs/agent-ship.md item 8). A budget is a LEASE a
// parent carves from its own remainder, never a constant a file holds on its
// own: a preset ASKS for a lease and does useful work above a FLOOR; a parent
// that runs a loop holds back a RESERVE, derived from the floors and the
// provisioning of every round that must still follow, plus the merge wait's
// floor; and the lease covers everything the run does, the loop, the write-up
// and the post-step, each an ALLOWANCE named here. The registry reads its
// `maxMinutes` and `maxTurns` from this module and `budgets.check.test.ts`
// asserts the fits, so a number that breaks another's assumption is a red
// build. `carve` and `fit` have no production caller yet: the ship coordinator
// (which still carves with its own reserves, agent-ship item 8), the config
// validator, the fork and the conductor's spawn move onto them in the plan's
// unit two (the plan that executes decision 0046).
//
// Deliberately free of node: imports and of the agent registry, so the
// Workflow-driven coordinator and the deploy Workers can bundle it — the
// dependency runs registry → budgets, never the reverse.

export const MINUTE_MS = 60_000;

/** The presets that run the tool loop, and the one pipeline preset. */
export const LOOP_PRESETS = ["general", "coding", "review", "research", "explore", "conductor"] as const;
export type LoopPreset = (typeof LOOP_PRESETS)[number];
export type Preset = LoopPreset | "ship";

/** What each preset asks for when nothing above it is tighter, in minutes. The
 *  pipeline's (`ship`) is the wall clock one segment of its loop runs under;
 *  a deployment's `ship.maxMinutes` replaces it, held to `fit` below. */
export const ASKS: Readonly<Record<Preset, number>> = {
  general: 5,
  coding: 45,
  review: 25,
  ship: 120,
  research: 8,
  explore: 120,
  conductor: 120,
};

/** The rounds a ship loop is made of. `fix` is a coding child handed the
 *  review's findings; `merge` is the runner's wait on the guards. */
export type RoundKind = "coding" | "review" | "fix" | "merge";

/** The least lease in which a round does useful work, in minutes. A carve that
 *  falls under the floor is refused rather than dispatched: a two-minute
 *  review or fix costs an attach and a model turn and finishes nothing.
 *  Review's is the ledger's 90th percentile of completed reviews (5.1 min over
 *  181); coding's and the merge wait's are guesses until the ledger says. */
export const FLOORS: Readonly<Record<RoundKind, number>> = {
  coding: 10,
  fix: 10,
  review: 5,
  merge: 10,
};

/** The merge wait's own ask: how long the runner waits on the guards at most
 *  when the remainder allows it. */
export const MERGE_WAIT_ASK_MINUTES = 60;

/** The named amounts a lease holds back, in minutes. Each stands for a step
 *  every run or round pays: `provision` is attach and restore before the
 *  harness's clock starts; `writeUp` is the final answer after the loop ends;
 *  `commandWriteUp` is what the last command leaves for that answer; `execCall`
 *  is the exec client's wait past a command's own budget; `bearerGrace` is how
 *  far past the lease the model bearer stays valid for the last call's tail. */
export const ALLOWANCES = {
  provision: 3,
  writeUp: 3,
  commandWriteUp: 1,
  execCall: 0.5,
  bearerGrace: 1,
} as const;

/** The post-step turn a preset runs after its loop, in minutes: the coding
 *  run's description turn, the review's verdict turn, none for the rest. */
export const POST_STEP_MINUTES: Readonly<Record<Preset, number>> = {
  coding: 5,
  review: 3,
  general: 0,
  research: 0,
  explore: 0,
  conductor: 0,
  ship: 0,
};

/** The per-command bash budget's rows: the default when a call names none, the
 *  ceiling a call may raise it to, and the floor under which a number is a
 *  typo (docs/reference/specs/execution.md item 11). */
export const BASH_COMMAND = { defaultMinutes: 5, maxMinutes: 20, minMs: 1_000 } as const;

/** The pace that marks a run as looping rather than working: a model turn
 *  every ten seconds, sustained for the whole wall clock. A busy run takes
 *  20–40 s a turn (a model think plus a tool call), so a run that averages six
 *  a minute from start to end is re-issuing calls, not making progress — and
 *  its turn cap ends it before the wall clock would, with a write-up that
 *  says so (docs/reference/specs/harness-pi.md item 15). */
export const RUNAWAY_TURNS_PER_MINUTE = 6;

/** The turn cap a wall clock implies: `maxMinutes × RUNAWAY_TURNS_PER_MINUTE`.
 *  Every preset that runs the loop derives its `maxTurns` from this, so the
 *  cap is never a number a good run reaches — the minutes are the budget. */
export function runawayTurnCap(maxMinutes: number): number {
  return maxMinutes * RUNAWAY_TURNS_PER_MINUTE;
}

/** A pipeline's loop as the config allows it: `maxRounds` counts review rounds. */
export interface Loop {
  maxRounds: number;
}

/** A round's position in its loop: its kind and its index, so the reserve is
 *  the rounds after that index, never a table keyed by kind alone. */
export interface RoundPosition {
  kind: RoundKind;
  index: number;
}

/** The rounds of a loop in order: the coding round, then a review and, after
 *  every review but the last, a fix, then the merge wait. */
export function loopRounds(loop: Loop): RoundKind[] {
  const rounds: RoundKind[] = ["coding"];
  for (let i = 0; i < loop.maxRounds; i++) {
    rounds.push("review");
    if (i < loop.maxRounds - 1) rounds.push("fix");
  }
  rounds.push("merge");
  return rounds;
}

/** The minutes a round holds back for what must follow it in the loop: the
 *  floor plus provisioning of every later review and fix, and the merge
 *  wait's floor. A merge holds nothing back; a round with no loop (a
 *  conductor's child) holds nothing back either. */
export function reserveMinutes(
  round: RoundPosition,
  loop: Loop | undefined,
  floors: Readonly<Record<RoundKind, number>> = FLOORS,
): number {
  if (!loop) return 0;
  let reserve = 0;
  for (const kind of loopRounds(loop).slice(round.index + 1)) {
    reserve += kind === "merge" ? floors.merge : floors[kind] + ALLOWANCES.provision;
  }
  return reserve;
}

/** What a round asks for: the preset's ask for a coding or fix round, the
 *  review's for a review, the merge wait's own for the merge. */
export function roundAskMinutes(kind: RoundKind): number {
  switch (kind) {
    case "coding":
    case "fix":
      return ASKS.coding;
    case "review":
      return ASKS.review;
    case "merge":
      return MERGE_WAIT_ASK_MINUTES;
  }
}

/** A carve's result: the minutes with what bounded them (`ask` when the round
 *  got its whole ask, `parent` when the remainder minus the reserve was
 *  tighter) and what the parent holds back, or a refusal when the minutes the
 *  remainder leaves fall under the round's floor. */
export type Carve =
  | { kind: "carved"; minutes: number; boundedBy: "ask" | "parent"; holds: number }
  | { kind: "refused"; reason: "under floor"; minutes: number; floor: number; holds: number };

/** The only place a round's minutes are computed: the parent's remainder in
 *  whole minutes minus the round's reserve, capped at the round's ask, refused
 *  under the round's floor. `loop` is undefined for a child outside any loop. */
export function carve(remainingMs: number, round: RoundPosition, loop: Loop | undefined): Carve {
  const holds = reserveMinutes(round, loop);
  const ask = roundAskMinutes(round.kind);
  const headroom = Math.floor(remainingMs / MINUTE_MS) - holds;
  const minutes = Math.min(ask, headroom);
  const floor = FLOORS[round.kind];
  // A refusal reports what the remainder left, never a negative number.
  if (minutes < floor) return { kind: "refused", reason: "under floor", minutes: Math.max(0, minutes), floor, holds };
  return { kind: "carved", minutes, boundedBy: minutes === ask ? "ask" : "parent", holds };
}

/** A pipeline's wall clock and its loop: what `fit` judges. */
export interface Pipeline extends Loop {
  maxMinutes: number;
}

/** The fit: a pipeline holds its first child at its ask and every later round
 *  at its floor — `provision + ask(coding) + reserve(coding, loop) ≤
 *  maxMinutes`. Asserted at verify over the registry today; the config
 *  validator and the fork adopt it in the plan's unit two. `need` is the sum a
 *  refusal names. */
export function fit(pipeline: Pipeline): { ok: boolean; need: number; have: number } {
  const need = ALLOWANCES.provision + ASKS.coding + reserveMinutes({ kind: "coding", index: 0 }, pipeline);
  return { ok: pipeline.maxMinutes >= need, need, have: pipeline.maxMinutes };
}
