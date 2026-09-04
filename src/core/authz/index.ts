// Public surface of the authorization core (plan U1). Command code uses
// `authorize`; store adapters use `predicateFor` (+ `matchesPredicate` for
// in-memory stores); nothing else here is meant to leave the module.

export { authorize, effectiveGrants, principalOf } from "./authorize.js";
export type { DenyReason } from "./authorize.js";
export { matchesPredicate, predicateFor } from "./predicate.js";
export { POLICY, validatePolicy } from "./policy.js";
export { attributesOf } from "./resource.js";
export type { ResourceAttributes } from "./resource.js";
export type {
  Action,
  Actor,
  ActorKind,
  ChannelDirectory,
  ChannelVisibility,
  Condition,
  Decision,
  Grants,
  GrantSet,
  Predicate,
  Resource,
  ResourceKind,
  ResourceType,
  Rule,
} from "./types.js";
export { NO_GRANTS } from "./types.js";
