import { NO_GRANTS, type Actor, type Grants } from "../authz/types.js";
import type { Caller } from "../commandRegistry.js";

// Hand-built `Caller`s for tests (plan U4): the surface kind, the namespaced
// id, and an `Actor` holding exactly the grants given — what an adapter would
// have resolved from config. No production code imports this module.

/** `"all"`, a list of action names, or the full three axes. */
export type CallerGrants = "all" | readonly string[] | Partial<Grants>;

function toGrants(g: CallerGrants): Grants {
  if (g === "all") return { actions: "all", channels: "all", repos: "all" };
  if (Array.isArray(g)) return { ...NO_GRANTS, actions: new Set(g as readonly string[]), channels: "all" };
  const over = g as Partial<Grants>;
  return { actions: over.actions ?? new Set(), channels: over.channels ?? new Set(), repos: over.repos ?? new Set() };
}

/** A credential (`mcp:`, `http:`, `access:svc:`) is a `service`; everything else a `user`. */
export function actorKindOf(id: string): Actor["kind"] {
  return id.startsWith("mcp:") || id.startsWith("http:") || id.startsWith("access:svc:") ? "service" : "user";
}

/** A `Caller` whose actor holds exactly `grants`. A list of actions means "over
 *  every channel" (an ops token granted `channels: all`); `Partial<Grants>` is
 *  taken as given (an absent axis is the empty set, R7). `extra` adds a chat `origin`. */
export function callerWith(
  kind: Caller["kind"],
  id: string,
  grants: CallerGrants = [],
  extra: Partial<Pick<Caller, "origin">> = {},
): Caller {
  const origin = extra.origin ? { channelId: extra.origin.channelId, threadKey: extra.origin.threadKey } : undefined;
  const actor: Actor = { kind: actorKindOf(id), id, grants: toGrants(grants), ...(origin ? { origin } : {}) };
  return { kind, id, actor, ...extra };
}
