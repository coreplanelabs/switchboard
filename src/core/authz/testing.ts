// Shared fixtures for the authz tests: actors of every kind and grant shape,
// and a run corpus spanning every channel visibility and several users.
// Test-only; not re-exported by index.ts.

import { browserReadActions, CHAT_OPEN_ACTIONS } from "./grants.js";
import type { Actor, ActorKind, ChannelVisibility, Grants, Resource } from "./types.js";

/** The command groups the fixture's operator and browser translate over (a subset of the catalogue's). */
export const COMMAND_GROUPS = [
  "runs",
  "friction",
  "repo",
  "config",
  "memory",
  "mcp",
  "schedule",
  "deploy",
  "help",
  "status",
  "env",
  "setup",
  "contract",
  "delivery",
] as const;

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

export const USERS = ["slack:UALICE", "slack:UBOB", "slack:UCAROL", "slack:UDAVE", "slack:UERIN"] as const;

export const REPOS = ["acme/api", "acme/web"] as const;

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

export function scope(
  kind: ScopeResource["kind"],
  key: string,
  originChannelVisibility?: ChannelVisibility,
): ScopeResource {
  return originChannelVisibility
    ? { type: "memory-scope", kind, key, originChannelVisibility }
    : { type: "memory-scope", kind, key };
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
  for (const visibility of ["public", "private", "dm", "machine", "unknown"] as const)
    scopes.push(scope("org", "org:acme", visibility));
  scopes.push(scope("org", "org:acme"));
  for (const userId of USERS) scopes.push(scope("user", `user:${userId}`));
  for (const channel of Object.values(CHANNELS)) scopes.push(scope("channel", `channel:${channel.id}`));
  for (const repo of REPOS) scopes.push(scope("repo", `repo:${repo}`));
  scopes.push(scope("user", "malformed-key"));
  return scopes;
}

const nonMember = actor("user", "slack:UCAROL", {
  actions: new Set(["runs:read"]),
  channels: new Set([CHANNELS.pub2.id]),
});

export const ACTORS = {
  /** Fleet admin: every action, every channel, every repo. */
  admin: actor("user", "slack:UALICE", { actions: "all", channels: "all", repos: "all" }),
  /** A channel member with run + config grants in pub1 and the private channel. */
  member: actor("user", "slack:UBOB", {
    actions: new Set(["runs:read", "runs:write", "config:write"]),
    channels: new Set([CHANNELS.pub1.id, CHANNELS.priv.id]),
  }),
  /** A user who is a member of pub2 only. */
  nonMember,
  /** A user with the read grant only, in pub1 only. */
  reader: actor("user", "slack:UDAVE", { actions: new Set(["runs:read"]), channels: new Set([CHANNELS.pub1.id]) }),
  /** A user with no grants at all. */
  noGrants: actor("user", "slack:UERIN"),
  /** Repo manager: repo grants over one repo. */
  manager: actor("user", "slack:UALICE", {
    actions: new Set(["repo:write", "repo:exec", "friction:write"]),
    repos: new Set([REPOS[0]]),
  }),
  /** A user allowed to run one agent by name. */
  agentUser: actor("user", "slack:UDAVE", { actions: new Set(["agent:run:coding"]) }),
  /** A user allowed to run every agent through the wildcard. */
  allAgents: actor("user", "slack:UDAVE", { actions: new Set(["agent:run:*"]) }),
  /** A Slack user granted `config:write` on top of the `open` chat commands. */
  chatUser: actor("user", "slack:UFAY", { actions: new Set([...CHAT_OPEN_ACTIONS, "config:write"]) }),
  /** A plain Slack user: the `open` chat commands alone (`config:write` is never a baseline). */
  chatUserGated: actor("user", "slack:UGUS", { actions: new Set(CHAT_OPEN_ACTIONS) }),
  /** An unlisted Access browser session: every group's read, nothing else. */
  browser: actor("user", "access:viewer", { actions: browserReadActions(COMMAND_GROUPS) }),
  /** An Access operator (granted every read + write with `channels: all`): fleet-wide, never exec. */
  operator: actor("user", "access:op", {
    actions: new Set(COMMAND_GROUPS.flatMap((g) => [`${g}:read`, `${g}:write`])),
    channels: "all",
  }),
  /** A default ingress token: the `dispatch` scope alone (no registry command). */
  dispatchOnly: actor("service", "mcp:agent", { actions: new Set(["dispatch"]), channels: "all" }),
  /** A token an admin minted with `mcp:write` (manages MCP servers in any tier). */
  mcpWriter: actor("service", "mcp:tools", { actions: new Set(["mcp:write"]), channels: "all" }),
  /** Ingress token pinned to its machine channel (the `channel` config key). */
  token: actor("service", "http:ops", {
    actions: new Set(["runs:read", "runs:write"]),
    channels: new Set([CHANNELS.http.id]),
  }),
  /** The self-improvement cron: fleet-wide reads — it analyzes the fleet, not its own firings. */
  schedule: actor("schedule", "schedule:self-improvement", {
    actions: new Set(["runs:read", "friction:write"]),
    channels: "all",
  }),
  /** The ship coordinator's bearer: the one step grant, nothing else. */
  coordinator: actor("service", "http:coordinator", { actions: new Set(["coordinator:step"]) }),
  /** An agent holding everything, acting for the non-member (never exceeds the principal). */
  agentForNonMember: actor(
    "agent",
    "agent:coding",
    { actions: "all", channels: "all", repos: "all" },
    { onBehalfOf: nonMember },
  ),
  /** An actor whose kind is outside the vocabulary. */
  bogus: {
    kind: "bogus" as ActorKind,
    id: "bogus:1",
    grants: grants({ actions: "all", channels: "all", repos: "all" }),
  } as Actor,
} as const;
