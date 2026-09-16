// What every ship surface shares (docs/reference/specs/agent-ship.md items 8
// and 12): the `ship` config block a deployment declares, the caps resolved
// from it, the ship preset as this deployment declares it, and the card's round
// header. The pipeline itself — coding → review → fix to LGTM — is the plan
// runner's (ship/coordinator.ts, driven from the bot's shim Worker; the hand-off
// in dispatch/ship.ts and coordinator/handOff.ts): every `agent:ship` request
// becomes a runner instance whose rounds are child `dispatch()` runs, so no
// round loop lives in this process. The caps' shape and the interrupted note
// live with the runner's machine (Worker-importable) and are re-exported here
// for the bot-side callers — the reclaim at boot, the coordinator routes.

import { AGENTS, type AgentDef } from "../agents/registry.js";

// ---- config (`ship` block, docs/reference/specs/agent-ship.md item 8) -------------------

/** The `ship` config block: pipeline caps, resolved at deployment level like
 *  the sibling `review` block. `maxRounds` is the pipeline's own; `maxMinutes`
 *  is the ship preset's declared budget in this deployment — a profile field
 *  (docs/decisions/0026-capability-profiles-and-request-routing.md), so a
 *  channel or user boundary and a `budget:` directive clip it per run like any
 *  preset's, which is the per-scope layering these caps have. Validated at
 *  load (`validateShip`): any other key is refused by name. */
export interface ShipConfig {
  /** Review rounds per pipeline (>= 1). Default 3. */
  maxRounds?: number;
  /** The ship preset's declared wall-clock budget in minutes (>= 1). Default:
   *  the registry's `AGENTS.ship.maxMinutes` (120). */
  maxMinutes?: number;
}

import { SHIP_LOOP_RESERVE_MS, SHIP_MIN_MAX_MINUTES, shipInterruptedNote, type ShipCaps } from "./ship/coordinator.js";
// The pipeline is budgeted for the loop, not one round (agent-ship item 8): the
// coding child's directive is clipped to leave `SHIP_LOOP_RESERVE_MS` (two
// review rounds and one merge poll) on the pipeline's clock, and `validateShip`
// holds `ship.maxMinutes` to at least `SHIP_MIN_MAX_MINUTES` so the clip can hold.
export { SHIP_LOOP_RESERVE_MS, SHIP_MIN_MAX_MINUTES, shipInterruptedNote, type ShipCaps };

export const SHIP_DEFAULT_MAX_ROUNDS = 3;
/** One number: the ship preset's own declared budget is the default the knob replaces. */
export const SHIP_DEFAULT_MAX_MINUTES = AGENTS.ship.maxMinutes;

export function resolveShipCaps(cfg: ShipConfig | undefined): ShipCaps {
  return {
    maxRounds: cfg?.maxRounds ?? SHIP_DEFAULT_MAX_ROUNDS,
    maxMinutes: cfg?.maxMinutes ?? SHIP_DEFAULT_MAX_MINUTES,
  };
}

/** The ship preset as this deployment declares it (docs/reference/specs/agent-ship.md
 *  item 8): the registry's def with the `ship.maxMinutes` knob as its budget —
 *  the one number the run's profile is resolved from, so a boundary clips it,
 *  a `budget:` directive narrows it, and the pipeline's wall clock is the
 *  effective profile's minutes. Always a copy; `AGENTS.ship` is never mutated. */
export function shipPresetFor(cfg: ShipConfig | undefined): AgentDef {
  return { ...AGENTS.ship, maxMinutes: resolveShipCaps(cfg).maxMinutes };
}

// ---- round visibility (spec item 12) ------------------------------------------

/** The card's orchestrator-owned round header for a `ship_round` boundary:
 *  `Round 0 — coding` / `Round 1 — review` / `Round 1 — fix` (a fix round
 *  shares its review round's index; a coding round above index 0 IS a fix
 *  round). The runner's `round` route draws it on the parent's card from the
 *  boundaries the machine reports. */
export function shipRoundHeader(round: { index: number; agent: string }): string {
  const phase = round.agent === "review" ? "review" : round.index === 0 ? "coding" : "fix";
  return `Round ${round.index} — ${phase}`;
}
