// The list-shaped evaluator (plan U1, R6, KTD2): the SAME rules `authorize`
// decides with, compiled into a store predicate for one actor.
//
// Per row: every condition becomes a predicate — a grant the actor lacks is
// `none`, a grant it holds is no constraint (`all`), `member-of` is
// `channels-in` (or `all` for an all-channels actor), `is-self` is `user-is`,
// `owner-of` is `repos-in`. A row ANDs its conditions (a `none` sinks the row;
// `all`s drop out; one relation left is the row's predicate, several are an
// `and`). Rows OR. A row with an `originVisibility` selector cannot be seen by
// a store predicate and compiles to `none`.
//
// `matchesPredicate` is the reference evaluator over one record — what an
// in-memory store runs, and what the differential test checks against
// `authorize`.

import { effectiveGrants, hasAction, holds, isKnownActorKind, principalOf } from "./authorize.js";
import { POLICY, resolveGrant, ruleTarget } from "./policy.js";
import { RESOURCE_KINDS, targetOf, type ResourceAttributes } from "./resource.js";
import type { Action, Actor, Condition, Grants, Predicate, ResourceKind, ResourceType, Rule } from "./types.js";

const NONE: Predicate = Object.freeze({ kind: "none" });
const ALL: Predicate = Object.freeze({ kind: "all" });

function compileCondition(condition: Condition, grants: Grants, selfId: string): Predicate {
  switch (condition.kind) {
    case "has-grant": {
      if (grants.actions === "all") return ALL;
      // A placeholder grant depends on the record; without the record it is unknowable → none.
      const grant = resolveGrant(condition.grant, {});
      return grant !== undefined && hasAction(grants.actions, grant) ? ALL : NONE;
    }
    case "member-of":
      if (grants.channels === "all") return ALL;
      return grants.channels.size === 0 ? NONE : { kind: "channels-in", channelIds: grants.channels };
    case "is-self":
      return { kind: "user-is", userId: selfId };
    case "owner-of":
      if (grants.repos === "all") return ALL;
      return grants.repos.size === 0 ? NONE : { kind: "repos-in", repos: grants.repos };
    case "all-channels":
      return grants.channels === "all" ? ALL : NONE;
  }
  return NONE;
}

function compileRule(rule: Rule, grants: Grants, selfId: string): Predicate {
  if (rule.originVisibility) return NONE;
  const parts: Predicate[] = [];
  for (const condition of rule.when) {
    const part = compileCondition(condition, grants, selfId);
    if (part.kind === "none") return NONE;
    if (part.kind !== "all") parts.push(part);
  }
  if (parts.length === 0) return ALL;
  if (parts.length === 1) return parts[0]!;
  return { kind: "and", of: parts };
}

/** `predicateFor` over an explicit (validated) table; production code calls `predicateFor`. */
export function predicateWith(rules: readonly Rule[], actor: Actor, action: Action, resourceType: ResourceType, kind?: ResourceKind): Predicate {
  if (RESOURCE_KINDS[resourceType] && kind === undefined) {
    throw new TypeError(`authz predicate: ${resourceType} is kinded — pass the kind`);
  }
  const target = targetOf(resourceType, kind);
  if (!target) throw new TypeError(`authz predicate: no target for ${resourceType}${kind ? `/${kind}` : ""}`);
  if (!isKnownActorKind(actor.kind)) return NONE;
  const grants = effectiveGrants(actor);
  const selfId = principalOf(actor).id;
  const alternatives: Predicate[] = [];
  for (const rule of rules) {
    if (rule.action !== action || ruleTarget(rule) !== target) continue;
    if (rule.actorKinds && !rule.actorKinds.includes(actor.kind)) continue;
    const compiled = compileRule(rule, grants, selfId);
    if (compiled.kind === "all") return ALL;
    if (compiled.kind !== "none") alternatives.push(compiled);
  }
  if (alternatives.length === 0) return NONE;
  if (alternatives.length === 1) return alternatives[0]!;
  return { kind: "or", of: alternatives };
}

/** What a list-shaped read of `resourceType` may return to this actor.
 *  Kinded types (`memory-scope`, `config-scope`) need the kind. */
export function predicateFor(actor: Actor, action: Action, resourceType: ResourceType, kind?: ResourceKind): Predicate {
  return predicateWith(POLICY, actor, action, resourceType, kind);
}

/** The reference evaluation of a predicate over one record's attributes. */
export function matchesPredicate(predicate: Predicate, record: Pick<ResourceAttributes, "channelId" | "userId" | "repo">): boolean {
  switch (predicate.kind) {
    case "none":
      return false;
    case "all":
      return true;
    case "channels-in":
      return record.channelId !== undefined && holds(predicate.channelIds, record.channelId);
    case "user-is":
      return record.userId !== undefined && record.userId === predicate.userId;
    case "repos-in":
      return record.repo !== undefined && holds(predicate.repos, record.repo);
    case "or":
      return predicate.of.some((p) => matchesPredicate(p, record));
    case "and":
      return predicate.of.length > 0 && predicate.of.every((p) => matchesPredicate(p, record));
  }
  return false;
}
