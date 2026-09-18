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
import { DEFAULT_GRANT, IDLE_DAYS_DEFAULT, type Grant, type GrantSource } from "./budgets.js";

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
  /** The grant a ship request carries by default in this deployment (decision
   *  0046, the renewable lease): renewals and a cost cap; overridable per
   *  channel and per user (`ship.grant` on the scope) and, for the count alone,
   *  per run by a `renewals:<count>` directive. Absent: zero renewals, no cap. */
  grant?: Grant;
  /** The idle flag (record 0051; agent-ship item 8): an integer count of days,
   *  0 to `IDLE_DAYS_MAX` — above zero, a unit whose pipeline ends in an
   *  idling kind idles for that many days instead of ending; 0 (the default)
   *  is today's behavior. Overridable per channel and per user
   *  (`ship.idleDays` on the scope), user over channel over org. */
  idleDays?: number;
}

import { shipInterruptedNote, type ShipCaps } from "./ship/coordinator.js";
// The pipeline is budgeted for the loop, not one round (agent-ship item 8): every
// round's minutes are carved in `src/core/budgets.ts` from what remains minus the
// reserve for the rounds after it, and `validateShip` holds `ship.maxMinutes` to
// the module's `fit` so the loop the config allows can run.
export { shipInterruptedNote, type ShipCaps };
import {
  ADDRESS_SEVERITIES,
  DEFAULT_ADDRESS_SEVERITY,
  isAddressSeverity,
  resolveAddressSeverity,
  type AddressSeverity,
  type AddressSeveritySource,
} from "./reviewVerdict.js";
// The ladder and its resolution live with the verdict parser (agent-review.md
// item 5a); ship reads the same lever, so its callers import them from here.
export {
  ADDRESS_SEVERITIES,
  DEFAULT_ADDRESS_SEVERITY,
  isAddressSeverity,
  resolveAddressSeverity,
  type AddressSeverity,
  type AddressSeveritySource,
};

/** The grant in force and the layer that set it (decision 0046): the user's
 *  scope wins over the channel's over the org's `ship.grant`, the default (zero
 *  renewals, no cap) counting as the org's; a `renewals:` directive on the
 *  request sets the count and keeps the cap the winning scope set — a person
 *  spends renewals by hand, never widens the dollars from prose. Resolved once
 *  by the ship fork and written on the instance beside `merge`. */
export function resolveGrant(layers: { org?: Grant; channel?: Grant; user?: Grant; run?: number }): {
  grant: Grant;
  source: GrantSource;
} {
  const scoped: { grant: Grant; source: GrantSource } =
    layers.user !== undefined
      ? { grant: layers.user, source: "user" }
      : layers.channel !== undefined
        ? { grant: layers.channel, source: "channel" }
        : { grant: layers.org ?? DEFAULT_GRANT, source: "org" };
  if (layers.run === undefined) return scoped;
  const cap = scoped.grant.costCapUsd;
  return { grant: { renewals: layers.run, ...(cap !== undefined ? { costCapUsd: cap } : {}) }, source: "run" };
}

/** The idle flag in force (record 0051): the user's scope wins over the
 *  channel's over the org's `ship.idleDays`, the default zero — nothing idles
 *  until someone says so. Resolved once by the ship fork and written on the
 *  instance beside the grant, so the machine reads one value. */
export function resolveIdleDays(layers: { org?: number; channel?: number; user?: number }): number {
  return layers.user ?? layers.channel ?? layers.org ?? IDLE_DAYS_DEFAULT;
}

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
export function shipRoundHeader(
  round: { index: number; agent: string },
  severity?: { level: AddressSeverity; source: AddressSeveritySource },
): string {
  const phase = round.agent === "review" ? "review" : round.index === 0 ? "coding" : "fix";
  const gate = severity ? ` · addressing ${severity.level}+ (${severity.source})` : "";
  return `Round ${round.index} — ${phase}${gate}`;
}
