// The capability profile a run carries (docs/decisions/0026-capability-profiles-and-request-routing.md):
// the machine class its tools execute on, the identity it acts as, and the
// minutes it may run. A preset declares one; the run's EFFECTIVE profile is
// what the pipeline hands the factory, the ledger and the runner — never the
// preset's fields read again downstream. Pure and leaf: type-only imports, so
// the node-free record contract and the state Worker can name the shape.
import type { AgentDef, Identity, MachineClass } from "../agents/registry.js";

export type { Identity, MachineClass };

/** Where a cap on the profile came from — named on a clip and on a refusal. */
export type BoundaryScope = "defaults" | "channel" | "user" | "directive";
export const BOUNDARY_SCOPES: readonly BoundaryScope[] = ["defaults", "channel", "user", "directive"];

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
 *  rounds). Always a copy: the shared `AgentDef` is never mutated. */
export function budgetedAgent(agent: AgentDef, profile: RunProfile): AgentDef {
  return { ...agent, maxMinutes: profile.minutes };
}

// ---- boundaries: a scope caps, never grants -----------------------------------

/** A cap on the three axes that any scope may set (`defaults`, `channels.<id>`,
 *  `users.<id>`; docs/reference/specs/routing-and-config.md item 2). An absent
 *  axis caps nothing. A boundary never grants: it is not a fourth grants axis,
 *  and the policy table's one question (who may run a preset) is unchanged. */
export interface Boundary {
  /** The most a run may have, in minutes; at least 2 (the bash tool keeps a 60 s reserve). */
  maxMinutes?: number;
  /** The highest identity a run may act as, on `none < read < write`. */
  maxIdentity?: Identity;
  /** The machine classes a run may execute on; a preset's class must be in every layer's set. */
  machines?: MachineClass[];
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

/** Why a profile was refused: the axis, what the preset needs, what the
 *  boundary allows, and the scope(s) that set it — everything the refusal
 *  reply names. */
export type ProfileRefusal =
  | { axis: "identity"; needs: Identity; cap: Identity; scope: BoundaryScope }
  | { axis: "machine"; needs: MachineClass; allowed: MachineClass[]; scopes: BoundaryScope[] };

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
