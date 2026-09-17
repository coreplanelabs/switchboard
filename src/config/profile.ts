// The capability profile a run carries (docs/decisions/0026-capability-profiles-and-request-routing.md):
// the machine class its tools execute on, the identity it acts as, and the
// minutes it may run. A preset declares one; the run's EFFECTIVE profile is
// what the pipeline hands the factory, the ledger and the runner — never the
// preset's fields read again downstream. Pure and near-leaf: the only value
// import is the registry's `runawayTurnCap`, itself pure.
import { runawayTurnCap, type AgentDef, type Identity, type MachineClass } from "../agents/registry.js";

export type { Identity, MachineClass };

/** Where a cap on the profile came from — named on a clip and on a refusal.
 *  `parent` is the wall clock a spawning run had left when it started a child
 *  (docs/reference/specs/routing-and-config.md item 20): a boundary on the
 *  minutes axis alone, never on the identity or the class. */
export type BoundaryScope = "defaults" | "channel" | "user" | "directive" | "parent";
export const BOUNDARY_SCOPES: readonly BoundaryScope[] = ["defaults", "channel", "user", "directive", "parent"];

/** The clip's source as the card and the config block name it: a scope's cap
 *  is `<scope> boundary`, the caller's own `budget:` directive is `budget
 *  directive`, a spawning run's remaining wall clock is `parent run's budget`
 *  — one wording for every surface that says what clipped a run. */
export function clipSourceLabel(scope: BoundaryScope): string {
  switch (scope) {
    case "directive":
      return "budget directive";
    case "parent":
      return "parent run's budget";
    default:
      return `${scope} boundary`;
  }
}

/** What one run may have: the three axes, and — when a boundary clipped the
 *  budget — the scope that did. Identity and class are never clipped: a
 *  profile above a cap on those axes is refused before any executor exists. */
export interface RunProfile {
  machine: MachineClass;
  identity: Identity;
  /** The wall-clock budget in minutes: the preset's, or the tightest cap. */
  minutes: number;
  /** The scope whose boundary clipped `minutes` below the preset's own; absent
   *  when the preset's declared budget stands. */
  boundedBy?: BoundaryScope;
}

/** The identity order `none < read < write`: a boundary's `maxIdentity` admits
 *  every identity at or below it. Typed against the union, so a new identity
 *  fails to compile until it has a rung. */
export const IDENTITY_ORDER: Record<Identity, number> = { none: 0, read: 1, write: 2 };

/** Whether `identity` is at or under `cap` on the order. */
export function identityWithin(identity: Identity, cap: Identity): boolean {
  return IDENTITY_ORDER[identity] <= IDENTITY_ORDER[cap];
}

/** The profile a preset declares — what an effective profile is when no
 *  boundary on the path caps anything (record 0026's invariant: a
 *  configuration with no boundaries runs exactly the preset's declared profile). */
export function declaredProfile(preset: Pick<AgentDef, "machine" | "identity" | "maxMinutes">): RunProfile {
  return { machine: preset.machine, identity: preset.identity, minutes: preset.maxMinutes };
}

/** The preset with its budget replaced by the effective profile's — the def
 *  the runner is handed, since its deadline, wrap-up warning and budget label
 *  read `maxMinutes` (the same clipped copy the ship pipeline hands its child
 *  rounds). `maxTurns` is re-derived from the clipped minutes with the
 *  registry's own `runawayTurnCap`, so the six-per-minute runaway guard holds
 *  for the budget the run actually has, not the preset's declared one.
 *  Always a copy: the shared `AgentDef` is never mutated. */
export function budgetedAgent(agent: AgentDef, profile: RunProfile): AgentDef {
  return { ...agent, maxMinutes: profile.minutes, maxTurns: runawayTurnCap(profile.minutes) };
}

// ---- boundaries: a scope caps, never grants -----------------------------------

/** The blast-radius classes a scope may name as its `confirm`
 *  (docs/decisions/0044-a-routed-write-is-confirmed-in-proportion-to-its-blast-radius.md):
 *  the first class on the ladder the door hands back instead of running.
 *  `exec` is on the ladder for the comparison but not settable — a test or
 *  build never asks — and `never` is refused until the door's write misbind
 *  rate has been measured; the validator names both reasons. */
export type ConfirmClass = "write" | "destructive";
export const CONFIRM_CLASSES: readonly ConfirmClass[] = ["write", "destructive"];

/** The classes on the door's ladder — the command registry's `BlastRadius`,
 *  spelled here rather than imported: a type import still drags the registry's
 *  whole graph into every program that compiles this near-leaf module, the
 *  Workers included. The door indexes the ladder with the registry's type
 *  (`routedRunsAtOnce`), so a class added there without a rung here fails to
 *  compile at the one place the two vocabularies meet. */
export type ConfirmLadderClass = "read" | "exec" | "write" | "destructive";

/** The ladder the door compares on, `read < exec < write < destructive`: among
 *  the last three, from asking most to asking least — a `confirm` of `write`
 *  hands back every write and every destructive write, `destructive` only the
 *  destructive ones. A read is on the order so the comparison is total, but the
 *  door never asks for one. */
export const CONFIRM_ORDER: Record<ConfirmLadderClass, number> = { read: 0, exec: 1, write: 2, destructive: 3 };

/** The door's confirm class when no scope sets one: every routed write is
 *  handed back, a read or a test run at once — the door as it was before the
 *  axis existed. Attributed to `built-in`, a word that appears in no config. */
export const BUILT_IN_CONFIRM: ConfirmClass = "write";

/** A cap on the three axes that any scope may set (`defaults`, `channels.<id>`,
 *  `users.<id>`; docs/reference/specs/routing-and-config.md item 2), and the
 *  door's `confirm` beside them. An absent axis caps nothing. A boundary never
 *  grants: it is not a fourth grants axis, and the policy table's one question
 *  (who may run a preset) is unchanged. */
export interface Boundary {
  /** The most a run may have, in minutes; at least 2 (the bash tool keeps a 60 s reserve). */
  maxMinutes?: number;
  /** The highest identity a run may act as, on `none < read < write`. */
  maxIdentity?: Identity;
  /** The machine classes a run may execute on; a preset's class must be in every layer's set. */
  machines?: MachineClass[];
  /** The first blast-radius class a command the router bound is handed back
   *  at instead of run (record 0044). Not a run cap: it rides the boundary for
   *  its scopes and its intersection-toward-caution, is read by the door alone
   *  (`effectiveConfirm`), and never enters `intersectBoundaries` or a profile. */
  confirm?: ConfirmClass;
}

/** One layer's boundary with the scope it came from, in resolution order:
 *  `defaults`, then `channel`, then `user`. */
export interface ScopedBoundary {
  scope: BoundaryScope;
  boundary: Boundary;
}

/** The intersection of every boundary on a request's path, each axis with
 *  the scope that set the value that won — so a clip or a refusal can name
 *  it. Unlike every other scope setting, which the most specific layer
 *  replaces whole, boundaries intersect: the smallest budget, the lowest
 *  identity, the classes every layer allows. */
export interface EffectiveBoundary {
  maxMinutes?: { value: number; scope: BoundaryScope };
  maxIdentity?: { value: Identity; scope: BoundaryScope };
  machines?: {
    /** The classes every layer allows, in canonical class order. */
    value: MachineClass[];
    /** Each layer's own list, so a refusal can name the scopes that exclude a class. */
    by: Array<{ scope: BoundaryScope; machines: MachineClass[] }>;
  };
}

/** Canonical class order for the intersected list (typed against the union
 *  like the identity order, so a new class fails to compile until placed). */
const MACHINE_ORDER: Record<MachineClass, number> = { none: 0, blank: 1, "repo-cold": 2, "repo-resident": 3 };

/**
 * Intersect the boundaries on a request's path. On a tie the first layer
 * named keeps the attribution (the least specific scope, in the order the
 * caller passes). Undefined when no layer caps any axis: the absence of a
 * boundary is today's behaviour, and the caller can tell it apart from an
 * empty cap.
 */
export function intersectBoundaries(layers: readonly ScopedBoundary[]): EffectiveBoundary | undefined {
  const out: EffectiveBoundary = {};
  for (const { scope, boundary } of layers) {
    if (boundary.maxMinutes !== undefined && (!out.maxMinutes || boundary.maxMinutes < out.maxMinutes.value)) {
      out.maxMinutes = { value: boundary.maxMinutes, scope };
    }
    if (
      boundary.maxIdentity !== undefined &&
      (!out.maxIdentity || !identityWithin(out.maxIdentity.value, boundary.maxIdentity))
    ) {
      out.maxIdentity = { value: boundary.maxIdentity, scope };
    }
    if (boundary.machines !== undefined) {
      const allowed = boundary.machines;
      const value = (out.machines ? out.machines.value : allowed)
        .filter((m) => allowed.includes(m))
        .sort((a, b) => MACHINE_ORDER[a] - MACHINE_ORDER[b]);
      out.machines = { value, by: [...(out.machines?.by ?? []), { scope, machines: [...allowed] }] };
    }
  }
  return out.maxMinutes || out.maxIdentity || out.machines ? out : undefined;
}

/** Where the door's confirm class came from: a scope that set it, or the
 *  built-in default when none did. Local to the confirm axis — `BoundaryScope`
 *  itself is unchanged, since no run cap is ever attributed to `built-in`. */
export type ConfirmScope = BoundaryScope | "built-in";

/** The door's decision on the confirm axis: the class and the scope it names. */
export interface EffectiveConfirm {
  value: ConfirmClass;
  scope: ConfirmScope;
}

/**
 * The confirm axis intersected over a request's path, apart from the run caps:
 * the earliest class on `CONFIRM_ORDER` any layer named — the most cautious,
 * since a scope's value is the most permissive answer it allows and the org's
 * is therefore a floor no layer below it can loosen — attributed to the layer
 * that set it (on a tie the first layer named keeps it, the least specific
 * scope, as `intersectBoundaries` does). No layer set one: the built-in
 * `write`, attributed to `built-in`. Pure over the same layers `intersectBoundaries` takes.
 */
export function effectiveConfirm(layers: readonly ScopedBoundary[]): EffectiveConfirm {
  let out: EffectiveConfirm | undefined;
  for (const { scope, boundary } of layers) {
    if (boundary.confirm !== undefined && (!out || CONFIRM_ORDER[boundary.confirm] < CONFIRM_ORDER[out.value])) {
      out = { value: boundary.confirm, scope };
    }
  }
  return out ?? { value: BUILT_IN_CONFIRM, scope: "built-in" };
}

/**
 * The boundaries on a child's path with its parent's remaining wall clock as
 * one more layer (docs/reference/specs/routing-and-config.md item 20): the
 * whole minutes the parent has left cap the child's minutes, attributed to
 * `parent`, when that is tighter than every cap already on the path. The
 * identity and the class are untouched — a parent hands a child time, never a
 * credential or a machine. The same object comes back when the parent's clock
 * is not the tightest cap, so a caller can tell "nothing changed" apart.
 */
export function boundedByParent(
  boundary: EffectiveBoundary | undefined,
  parentRemainingMs: number,
): EffectiveBoundary | undefined {
  const minutes = Math.floor(parentRemainingMs / 60_000);
  if (boundary?.maxMinutes && boundary.maxMinutes.value <= minutes) return boundary;
  return { ...boundary, maxMinutes: { value: minutes, scope: "parent" } };
}

/** Why a profile was refused: the axis, what the preset needs, what the
 *  boundary allows, and the scope(s) that set it — everything the refusal
 *  reply names. */
export type ProfileRefusal =
  | { axis: "identity"; needs: Identity; cap: Identity; scope: BoundaryScope }
  | { axis: "machine"; needs: MachineClass; allowed: MachineClass[]; scopes: BoundaryScope[] }
  /** The minutes axis refuses only under a minimum the caller names (the
   *  preset's lease minimum, `leaseMinimum` in `src/core/budgets.ts`): a lease
   *  clipped below it would leave the loop no time at all. */
  | { axis: "minutes"; needs: number; have: number; scope: BoundaryScope };

/** The effective profile, or the refusal the authorize stage turns into a
 *  named reply. Resolution is pure; the gate judges. */
export type ProfileResolution = { kind: "profile"; profile: RunProfile } | { kind: "refused"; refusal: ProfileRefusal };

/**
 * The effective profile: preset ∩ directives ∩ boundary, with the rule per
 * axis (docs/decisions/0026-capability-profiles-and-request-routing.md). The
 * budget CLIPS — the smallest of the preset's minutes, the caller's own
 * `budget` directive and the boundary's cap, `boundedBy` naming whichever
 * narrowed it (a directive at or above the preset changes nothing) — because a
 * shorter run still ends in the runner's forced write-up. Identity and machine
 * class REFUSE when the preset's is above the cap or outside the set, because
 * a preset that needs to push cannot do its job with a read token. Identity is
 * judged before the class. A directive never widens anything.
 */
export function effectiveProfile(
  preset: Pick<AgentDef, "machine" | "identity" | "maxMinutes">,
  directives: { budget?: number },
  boundary: EffectiveBoundary | undefined,
  /** The least lease the preset does anything under; absent, the minutes only clip. */
  minimum?: number,
): ProfileResolution {
  if (boundary?.maxIdentity && !identityWithin(preset.identity, boundary.maxIdentity.value)) {
    return {
      kind: "refused",
      refusal: {
        axis: "identity",
        needs: preset.identity,
        cap: boundary.maxIdentity.value,
        scope: boundary.maxIdentity.scope,
      },
    };
  }
  if (boundary?.machines && !boundary.machines.value.includes(preset.machine)) {
    return {
      kind: "refused",
      refusal: {
        axis: "machine",
        needs: preset.machine,
        allowed: boundary.machines.value,
        scopes: boundary.machines.by.filter((b) => !b.machines.includes(preset.machine)).map((b) => b.scope),
      },
    };
  }
  let minutes = preset.maxMinutes;
  let boundedBy: BoundaryScope | undefined;
  if (directives.budget !== undefined && directives.budget < minutes) {
    minutes = directives.budget;
    boundedBy = "directive";
  }
  if (boundary?.maxMinutes && boundary.maxMinutes.value < minutes) {
    minutes = boundary.maxMinutes.value;
    boundedBy = boundary.maxMinutes.scope;
  }
  // Under the minimum the clip is a refusal, not a run: the write-up and the
  // post-step take the whole lease and the loop never turns. Attributed to
  // whatever clipped; a declared ask under its own minimum is the module's
  // invariant to catch, named as the defaults' here so the switch is total.
  if (minimum !== undefined && minutes < minimum) {
    return {
      kind: "refused",
      refusal: { axis: "minutes", needs: minimum, have: minutes, scope: boundedBy ?? "defaults" },
    };
  }
  return {
    kind: "profile",
    profile: {
      machine: preset.machine,
      identity: preset.identity,
      minutes,
      ...(boundedBy !== undefined ? { boundedBy } : {}),
    },
  };
}
