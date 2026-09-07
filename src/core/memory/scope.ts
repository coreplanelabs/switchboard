import type { MemoryScope } from "./types.js";

// Scope derivation: pure functions from request identity → opaque scope keys,
// namespaced exactly like switchboard's existing IDs (AGENTS.md invariant 4).
// The store partitions rows by key and is otherwise scope-agnostic, so adding
// the user scope (#107 PR B) and the repo/channel scopes (#253) were deriver
// changes, not schema changes — the Memory Worker's per-scope Durable Object
// needed nothing new.

/** The org resource — the whole org is the shared memory resource. */
export const ORG_RESOURCE = "coreplanelabs";

/** Request identity the derivers may need. `userId` and `channelId` are the
 *  channel adapter's already-namespaced keys (`slack:U0123`, `slack:C0123`,
 *  AGENTS.md invariant 4); `repo` is the resolved `owner/name` slug. */
export interface ScopeContext {
  userId?: string;
  repo?: string;
  channelId?: string;
}

/** Derive one scope key: `org` → `org:coreplanelabs`; `user` → `user:<userId>`;
 *  `repo` → `repo:<owner/name>`; `channel` → `channel:<channelId>`. A scope
 *  without its input is a programmer error — never a shared anonymous bucket
 *  that would leak across people, repos, or channels. */
export function deriveScopeKey(scope: MemoryScope, ctx: ScopeContext = {}): string {
  switch (scope) {
    case "org":
      return `org:${ORG_RESOURCE}`;
    case "user":
      if (!ctx.userId) throw new Error("memory: the user scope requires a userId");
      return `user:${ctx.userId}`;
    case "repo":
      if (!ctx.repo) throw new Error("memory: the repo scope requires a repo slug");
      return `repo:${ctx.repo}`;
    case "channel":
      if (!ctx.channelId) throw new Error("memory: the channel scope requires a channelId");
      return `channel:${ctx.channelId}`;
  }
}

/** The scopes one request reads and writes: the shared org scope always; the
 *  repo scope when the run is bound to a repo and the channel scope when the
 *  message came from a channel (both shared by everyone who runs there); the
 *  requesting user's own scope when the request carries a user identity.
 *  Another user's scope is never derivable from here — isolation is by
 *  construction, not by filtering. */
export interface RequestScopeKeys {
  org: string;
  user?: string;
  repo?: string;
  channel?: string;
}

export function requestScopeKeys(
  userId: string | undefined,
  ctx: Pick<ScopeContext, "repo" | "channelId"> = {},
): RequestScopeKeys {
  const keys: RequestScopeKeys = { org: deriveScopeKey("org") };
  if (userId) keys.user = deriveScopeKey("user", { userId });
  if (ctx.repo) keys.repo = deriveScopeKey("repo", { repo: ctx.repo });
  if (ctx.channelId) keys.channel = deriveScopeKey("channel", { channelId: ctx.channelId });
  return keys;
}

/** The keys of a `RequestScopeKeys` in render/rank order: org, repo, channel,
 *  user — widest shared scope first, the person's own scope last. */
export function listScopeKeys(keys: RequestScopeKeys): string[] {
  return [keys.org, keys.repo, keys.channel, keys.user].filter((k): k is string => k !== undefined);
}
