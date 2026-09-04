// Shared fixtures for the authz tests: actors of every kind and grant shape,
// and a run corpus spanning every channel visibility and several users.
// Test-only; not re-exported by index.ts.

import type { Actor, ActorKind, ChannelVisibility, Grants, Resource } from "./types.js";

export function grants(over: Partial<Grants> = {}): Grants {
  return {
    actions: over.actions ?? new Set<string>(),
    channels: over.channels ?? new Set<string>(),
    repos: over.repos ?? new Set<string>(),
  };
}

export function actor(kind: ActorKind, id: string, g: Partial<Grants> = {}, extra: Partial<Actor> = {}): Actor {
  return { kind, id, grants: grants(g), ...extra };
}

export const CHANNELS = {
  pub1: { id: "slack:C_PUB1", visibility: "public" as ChannelVisibility },
  pub2: { id: "slack:C_PUB2", visibility: "public" as ChannelVisibility },
  priv: { id: "slack:C_PRIV", visibility: "private" as ChannelVisibility },
  dm: { id: "slack:D_DM1", visibility: "dm" as ChannelVisibility },
  http: { id: "http:ops", visibility: "machine" as ChannelVisibility },
  mcp: { id: "mcp:ops", visibility: "machine" as ChannelVisibility },
} as const;

export const USERS = ["slack:U1", "slack:U2", "slack:U3", "slack:U4", "slack:U5"] as const;

export const REPOS = ["coreplanelabs/switchboard", "coreplanelabs/nominal"] as const;

export type RunResource = Extract<Resource, { type: "run" }>;
export type ScopeResource = Extract<Resource, { type: "memory-scope" }>;

export function run(over: Partial<RunResource> & { channel?: keyof typeof CHANNELS } = {}): RunResource {
  const channel = CHANNELS[over.channel ?? "pub1"];
  const { channel: _c, ...rest } = over;
  return {
    type: "run",
    id: rest.id ?? `run-${channel.id}-${rest.userId ?? USERS[0]}`,
    channelId: channel.id,
    userId: USERS[0],
    channelVisibility: channel.visibility,
    ...rest,
  };
}

export function scope(kind: ScopeResource["kind"], key: string, originChannelVisibility?: ChannelVisibility): ScopeResource {
  return originChannelVisibility ? { type: "memory-scope", kind, key, originChannelVisibility } : { type: "memory-scope", kind, key };
}

/** 6 channels × 5 users × 2 repos = 60 runs, deterministic. */
export function runFixture(): RunResource[] {
  const runs: RunResource[] = [];
  for (const channel of Object.keys(CHANNELS) as (keyof typeof CHANNELS)[]) {
    for (const userId of USERS) {
      for (const repo of REPOS) {
        runs.push(run({ channel, userId, repo, id: `run-${channel}-${userId}-${repo}` }));
      }
    }
  }
  return runs;
}

/** Every memory scope the fixture can name, org in each origin visibility. */
export function scopeFixture(): ScopeResource[] {
  const scopes: ScopeResource[] = [];
  for (const visibility of ["public", "private", "dm", "machine", "unknown"] as const) scopes.push(scope("org", "org:coreplanelabs", visibility));
  scopes.push(scope("org", "org:coreplanelabs"));
  for (const userId of USERS) scopes.push(scope("user", `user:${userId}`));
  for (const channel of Object.values(CHANNELS)) scopes.push(scope("channel", `channel:${channel.id}`));
  for (const repo of REPOS) scopes.push(scope("repo", `repo:${repo}`));
  scopes.push(scope("user", "malformed-key"));
  return scopes;
}

const nonMember = actor("user", "slack:U3", { actions: new Set(["runs:read"]), channels: new Set([CHANNELS.pub2.id]) });

export const ACTORS = {
  /** Fleet admin: every action, every channel, every repo. */
  admin: actor("user", "slack:U1", { actions: "all", channels: "all", repos: "all" }),
  /** A channel member with run + config grants in pub1 and the private channel. */
  member: actor("user", "slack:U2", {
    actions: new Set(["runs:read", "runs:write", "config:write"]),
    channels: new Set([CHANNELS.pub1.id, CHANNELS.priv.id]),
  }),
  /** A user who is a member of pub2 only. */
  nonMember,
  /** A user with the read grant only, in pub1 only. */
  reader: actor("user", "slack:U4", { actions: new Set(["runs:read"]), channels: new Set([CHANNELS.pub1.id]) }),
  /** A user with no grants at all. */
  noGrants: actor("user", "slack:U5"),
  /** Repo manager: repo grants over one repo. */
  manager: actor("user", "slack:U1", {
    actions: new Set(["repo:write", "repo:exec", "friction:write"]),
    repos: new Set([REPOS[0]]),
  }),
  /** A user allowed to run one agent by name. */
  agentUser: actor("user", "slack:U4", { actions: new Set(["agent:run:coding"]) }),
  /** A user allowed to run every agent through the wildcard. */
  allAgents: actor("user", "slack:U4", { actions: new Set(["agent:run:*"]) }),
  /** Ingress token pinned to its machine channel (the `channel` config key). */
  token: actor("service", "http:ops", { actions: new Set(["runs:read", "runs:write"]), channels: new Set([CHANNELS.http.id]) }),
  /** The self-improvement cron: fleet-wide reads (the #395 fix). */
  schedule: actor("schedule", "schedule:self-improvement", { actions: new Set(["runs:read", "friction:write"]), channels: "all" }),
  /** An agent holding everything, acting for the non-member (R2: never exceeds the principal). */
  agentForNonMember: actor("agent", "agent:coding", { actions: "all", channels: "all", repos: "all" }, { onBehalfOf: nonMember }),
  /** An actor whose kind is outside the vocabulary. */
  bogus: { kind: "bogus" as ActorKind, id: "bogus:1", grants: grants({ actions: "all", channels: "all", repos: "all" }) } as Actor,
} as const;
