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
