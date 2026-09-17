// Every wall clock in Switchboard as one table (docs/decisions/0046; docs/reference/specs/harness-pi.md
// item 15; docs/reference/specs/agent-ship.md item 8). A budget is a LEASE a
// parent carves from its own remainder, never a constant a file holds on its
// own: a preset ASKS for a lease and does useful work above a FLOOR; a parent
// that runs a loop holds back a RESERVE, derived from the floors and the
// provisioning of every round that must still follow, plus the merge wait's
// floor; and the lease covers everything the run does, the loop, the write-up
// and the post-step, each an ALLOWANCE named here. The registry reads its
// `maxMinutes` and `maxTurns` from this module, the ship coordinator, the fork
// and the conductor's spawn call `carve`, and `budgets.check.test.ts` asserts
// the fits, so a number that breaks another's assumption is a red build.
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
