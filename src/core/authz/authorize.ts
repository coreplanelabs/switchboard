// The ONE decision (plan U1, R1, R2, KTD2): `authorize(actor, action, resource)`.
//
// Rows for the (action, target) OR; a row's conditions AND; no row → deny.
// Deny reasons are short machine-readable tokens carrying no resource id or
// attribute — an audit line may log them, a reply never renders them (KTD8).
//
// Grant arithmetic lives here too. Action grants may be wildcards: `<prefix>:*`
// covers every action under the prefix (`agent:run:*` ⊇ `agent:run:coding`).
// Channel and repo sets are literal ids — never wildcarded — so a
// `channels-in` predicate is always a plain `IN (...)` a store can run.

import { ACTOR_KINDS, POLICY, resolveGrant, ruleTarget } from "./policy.js";
import { attributesOf, targetOfResource, type ResourceAttributes } from "./resource.js";
import type { Action, Actor, Condition, Decision, Grants, GrantSet, Resource, Rule } from "./types.js";

// ── grants ───────────────────────────────────────────────────────────────────

/** Does an action grant set hold `action`, literally or through a `<prefix>:*` wildcard? */
export function hasAction(actions: GrantSet, action: string): boolean {
  if (actions === "all") return true;
  if (actions.has(action)) return true;
  for (let i = action.lastIndexOf(":"); i > 0; i = action.lastIndexOf(":", i - 1)) {
    if (actions.has(`${action.slice(0, i)}:*`)) return true;
  }
  return false;
}

/** Does a literal id set (channels, repos) hold `id`? */
export function holds(set: GrantSet, id: string): boolean {
  return set === "all" || set.has(id);
}

function intersectSets(a: GrantSet, b: GrantSet, covers: (set: GrantSet, member: string) => boolean): GrantSet {
  if (a === "all") return b;
  if (b === "all") return a;
  const out = new Set<string>();
  for (const member of a) if (covers(b, member)) out.add(member);
  for (const member of b) if (covers(a, member)) out.add(member);
  return out;
}

/** `a ∩ b`, never a superset of either side. Wildcards intersect by coverage:
 *  `{agent:run:*} ∩ {agent:run:coding}` is `{agent:run:coding}`. */
export function intersectGrants(a: Grants, b: Grants): Grants {
  return {
    actions: intersectSets(a.actions, b.actions, hasAction),
    channels: intersectSets(a.channels, b.channels, holds),
    repos: intersectSets(a.repos, b.repos, holds),
  };
}

/** The grants a decision is made against: an actor acting on behalf of a
 *  principal gets the intersection with that principal's effective grants (R2). */
export function effectiveGrants(actor: Actor): Grants {
  return actor.onBehalfOf ? intersectGrants(actor.grants, effectiveGrants(actor.onBehalfOf)) : actor.grants;
}

/** The identity `is-self` compares against: the root principal of an on-behalf-of chain. */
export function principalOf(actor: Actor): Actor {
  let current = actor;
  while (current.onBehalfOf) current = current.onBehalfOf;
  return current;
}

// ── decision ─────────────────────────────────────────────────────────────────

const ALLOW: Decision = Object.freeze({ allow: true });

/** Every deny reason `authorize` can return. */
export type DenyReason =
  | "unknown-actor-kind" // actor.kind is outside the vocabulary
  | "no-rule" // nothing in the table names this action on this resource
  | "actor-kind" // rows exist, none admits this actor kind
  | "origin-visibility" // rows exist, none admits the resource's origin visibility (R11)
  | "missing-grant"
  | "not-member"
  | "not-self"
  | "not-owner"
  | "not-all-channels";

const FAILURE_REASON: Readonly<Record<Condition["kind"], DenyReason>> = {
  "has-grant": "missing-grant",
  "member-of": "not-member",
  "is-self": "not-self",
  "owner-of": "not-owner",
  "all-channels": "not-all-channels",
};

function deny(reason: DenyReason): Decision {
  return { allow: false, reason };
}

export function isKnownActorKind(kind: string): boolean {
  return (ACTOR_KINDS as readonly string[]).includes(kind);
}

export function evaluateCondition(condition: Condition, grants: Grants, selfId: string, attributes: ResourceAttributes): boolean {
  switch (condition.kind) {
    case "has-grant": {
      const grant = resolveGrant(condition.grant, attributes);
      return grant !== undefined && hasAction(grants.actions, grant);
    }
    case "member-of":
      // Granted the channel, or the channel is public (a run's stamped
      // visibility, KTD7). `unknown` — no stamp, a directory failure — is
      // never public (R7).
      return (attributes.channelId !== undefined && holds(grants.channels, attributes.channelId)) || attributes.channelVisibility === "public";
    case "is-self":
      return attributes.userId !== undefined && attributes.userId === selfId;
    case "owner-of":
      return attributes.repo !== undefined && holds(grants.repos, attributes.repo);
    case "all-channels":
      return grants.channels === "all";
  }
  return false;
}

/** Does ONE row allow this actor on this resource? Selectors (`actorKinds`,
 *  `originVisibility`) are checked as well as the conditions, so a row is
 *  evaluated exactly as `authorize` would. Exported for the per-row table tests. */
export function evaluateRule(rule: Rule, actor: Actor, resource: Resource): boolean {
  if (!isKnownActorKind(actor.kind)) return false;
  if (ruleTarget(rule) !== targetOfResource(resource)) return false;
  if (rule.actorKinds && !rule.actorKinds.includes(actor.kind)) return false;
  const attributes = attributesOf(resource);
  if (rule.originVisibility && !rule.originVisibility.includes(attributes.visibility)) return false;
  const grants = effectiveGrants(actor);
  const selfId = principalOf(actor).id;
  return rule.when.every((condition) => evaluateCondition(condition, grants, selfId, attributes));
}

/** `authorize` over an explicit (validated) table. Tests use it to drive
 *  alternative tables; production code calls `authorize`. */
export function authorizeWith(rules: readonly Rule[], actor: Actor, action: Action, resource: Resource): Decision {
  if (!isKnownActorKind(actor.kind)) return deny("unknown-actor-kind");
  const target = targetOfResource(resource);
  const named = rules.filter((rule) => rule.action === action && ruleTarget(rule) === target);
  if (named.length === 0) return deny("no-rule");
  const forKind = named.filter((rule) => !rule.actorKinds || rule.actorKinds.includes(actor.kind));
  if (forKind.length === 0) return deny("actor-kind");
  const attributes = attributesOf(resource);
  const forOrigin = forKind.filter((rule) => !rule.originVisibility || rule.originVisibility.includes(attributes.visibility));
  if (forOrigin.length === 0) return deny("origin-visibility");
  const grants = effectiveGrants(actor);
  const selfId = principalOf(actor).id;
  let reason: DenyReason | undefined;
  for (const rule of forOrigin) {
    const failed = rule.when.find((condition) => !evaluateCondition(condition, grants, selfId, attributes));
    if (!failed) return ALLOW;
    reason ??= FAILURE_REASON[failed.kind];
  }
  // Unreachable: a row with no failing condition returned above, and every row here has conditions.
  return deny(reason ?? "no-rule");
}

export function authorize(actor: Actor, action: Action, resource: Resource): Decision {
  return authorizeWith(POLICY, actor, action, resource);
}
