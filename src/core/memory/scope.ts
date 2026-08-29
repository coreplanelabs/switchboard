import type { MemoryScope } from "./types.js";

// Scope derivation: pure functions from request identity → opaque scope keys,
// namespaced exactly like switchboard's existing IDs (AGENTS.md invariant 4).
// The store partitions rows by key and is otherwise scope-agnostic, so adding
// the user scope (#107 PR B) was a deriver change, not a schema change — the
// Memory Worker's per-scope Durable Object needed nothing new.

/** The org resource — the whole org is the shared memory resource. */
export const ORG_RESOURCE = "coreplanelabs";

/** Request identity the derivers may need. `userId` is the channel adapter's
 *  already-namespaced user scope key (`slack:U0123`, AGENTS.md invariant 4). */
export interface ScopeContext {
  userId?: string;
}

/** Derive one scope key. `org` → `org:coreplanelabs`; `user` → `user:<userId>`
 *  (e.g. `user:slack:U0123`). A user scope without a user id is a programmer
 *  error — never a shared anonymous bucket that would leak across people. */
export function deriveScopeKey(scope: MemoryScope, ctx: ScopeContext = {}): string {
  switch (scope) {
    case "org":
      return `org:${ORG_RESOURCE}`;
    case "user":
      if (!ctx.userId) throw new Error("memory: the user scope requires a userId");
      return `user:${ctx.userId}`;
  }
}

/** The scopes one request reads and writes: the shared org scope always, plus
 *  the requesting user's own scope when the request carries a user identity.
 *  Another user's scope is never derivable from here — isolation is by
 *  construction, not by filtering. */
export interface RequestScopeKeys {
  org: string;
  user?: string;
}

export function requestScopeKeys(userId: string | undefined): RequestScopeKeys {
  const org = deriveScopeKey("org");
  return userId ? { org, user: deriveScopeKey("user", { userId }) } : { org };
}

/** The keys of a `RequestScopeKeys`, org first (the render/rank order). */
export function listScopeKeys(keys: RequestScopeKeys): string[] {
  return keys.user ? [keys.org, keys.user] : [keys.org];
}
