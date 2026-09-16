// The list-shaped evaluator: the SAME rules `authorize`
// decides with, compiled into a store predicate for one actor.
//
// Per row: every condition becomes a predicate — a grant the actor lacks is
// `none`, a grant it holds is no constraint (`all`), `member-of` is
// `or(channels-in, visibility-in(["public"]))` — the same two-sided definition
// `authorize` evaluates (an all-channels actor: `all`; no channel grants: the
// public half alone) — `is-self` is `user-is`, `owner-of` is `repos-in`. A row
// ANDs its conditions (a `none` sinks the row; `all`s drop out; one relation
// left is the row's predicate, several are an `and`). Rows OR, flattened: an
// `or` inside an `or` is one disjunction. A row with an `originVisibility`
// selector cannot be seen by a store predicate and compiles to `none`.
//
// `matchesPredicate` is the reference evaluator over one record — what an
// in-memory store runs, and what the differential test checks against
// `authorize`.

import { actsAsPerson, effectiveGrants, hasAction, holds, isKnownActorKind, selfIdsOf } from "./authorize.js";
import { POLICY, resolveGrant, ruleTarget } from "./policy.js";
import { RESOURCE_KINDS, targetOf, type ResourceAttributes } from "./resource.js";
import type {
  Action,
  Actor,
  ChannelVisibility,
  Condition,
  Grants,
  Predicate,
  ResourceKind,
  ResourceType,
  Rule,
} from "./types.js";

const NONE: Predicate = Object.freeze({ kind: "none" });
const ALL: Predicate = Object.freeze({ kind: "all" });
/** `member-of`'s public half: every actor is a member of a public channel. */
const PUBLIC: Predicate = Object.freeze({
  kind: "visibility-in",
  visibilities: new Set<ChannelVisibility>(["public"]),
});

/** OR alternatives with nested `or`s flattened; `none`s dropped, one `all` wins. */
function anyOf(alternatives: readonly Predicate[]): Predicate {
  const flat: Predicate[] = [];
  for (const p of alternatives) {
    if (p.kind === "all") return ALL;
    if (p.kind === "none") continue;
    if (p.kind === "or") flat.push(...p.of);
    else flat.push(p);
  }
  if (flat.length === 0) return NONE;
  if (flat.length === 1) return flat[0]!;
  return { kind: "or", of: flat };
}

function compileCondition(condition: Condition, grants: Grants, selfIds: readonly string[]): Predicate {
  switch (condition.kind) {
    case "has-grant": {
      if (grants.actions === "all") return ALL;
      // A placeholder grant depends on the record; without the record it is unknowable → none.
      const grant = resolveGrant(condition.grant, {});
      return grant !== undefined && hasAction(grants.actions, grant) ? ALL : NONE;
    }
    case "member-of":
      if (grants.channels === "all") return ALL;
      return anyOf([grants.channels.size === 0 ? NONE : { kind: "channels-in", channelIds: grants.channels }, PUBLIC]);
    case "is-self":
      // One `user-is` per self id, ORed (record 0042): an unlinked actor
      // compiles to the single equality it always did, a linked dashboard
      // session to its own id or its person's — the store predicate vocabulary
      // is unchanged, so every translator (file store, state Worker) runs it as is.
      return anyOf(selfIds.map((userId): Predicate => ({ kind: "user-is", userId })));
    case "acts-as-person":
      return actsAsPerson(selfIds) ? ALL : NONE;
    case "owner-of":
      if (grants.repos === "all") return ALL;
      return grants.repos.size === 0 ? NONE : { kind: "repos-in", repos: grants.repos };
    case "all-channels":
      return grants.channels === "all" ? ALL : NONE;
  }
  return NONE;
}

function compileRule(rule: Rule, grants: Grants, selfIds: readonly string[]): Predicate {
  if (rule.originVisibility) return NONE;
  const parts: Predicate[] = [];
  for (const condition of rule.when) {
    const part = compileCondition(condition, grants, selfIds);
    if (part.kind === "none") return NONE;
    if (part.kind !== "all") parts.push(part);
  }
  if (parts.length === 0) return ALL;
  if (parts.length === 1) return parts[0]!;
  return { kind: "and", of: parts };
}

/** `predicateFor` over an explicit (validated) table; production code calls `predicateFor`. */
export function predicateWith(
  rules: readonly Rule[],
  actor: Actor,
  action: Action,
  resourceType: ResourceType,
  kind?: ResourceKind,
): Predicate {
  if (RESOURCE_KINDS[resourceType] && kind === undefined) {
    throw new TypeError(`authz predicate: ${resourceType} is kinded — pass the kind`);
  }
  const target = targetOf(resourceType, kind);
  if (!target) throw new TypeError(`authz predicate: no target for ${resourceType}${kind ? `/${kind}` : ""}`);
  if (!isKnownActorKind(actor.kind)) return NONE;
  const grants = effectiveGrants(actor);
  const selfIds = selfIdsOf(actor);
  const alternatives: Predicate[] = [];
  for (const rule of rules) {
    if (rule.action !== action || ruleTarget(rule) !== target) continue;
    if (rule.actorKinds && !rule.actorKinds.includes(actor.kind)) continue;
    alternatives.push(compileRule(rule, grants, selfIds));
  }
  return anyOf(alternatives);
}

/** What a list-shaped read of `resourceType` may return to this actor.
 *  Kinded types (`memory-scope`, `config-scope`) need the kind. */
export function predicateFor(actor: Actor, action: Action, resourceType: ResourceType, kind?: ResourceKind): Predicate {
  return predicateWith(POLICY, actor, action, resourceType, kind);
}

/** What `matchesPredicate` reads off one record: a `RunListItem`, a `RunView`,
 *  or `attributesOf(resource)` all qualify. A missing `channelVisibility` is
 *  `unknown` — never public. */
export type PredicateRecord = Pick<ResourceAttributes, "channelId" | "userId" | "repo" | "channelVisibility">;

/** The reference evaluation of a predicate over one record's attributes. */
export function matchesPredicate(predicate: Predicate, record: PredicateRecord): boolean {
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
    case "visibility-in":
      return predicate.visibilities.has(record.channelVisibility ?? "unknown");
    case "or":
      return predicate.of.some((p) => matchesPredicate(p, record));
    case "and":
      return predicate.of.length > 0 && predicate.of.every((p) => matchesPredicate(p, record));
  }
  return false;
}
