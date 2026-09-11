// THE policy table (docs/decisions/0007-authorization-policy-table.md). Data, not code.
//
// Every gate Switchboard had — command chat gates, machine token scopes, the
// machine-caller channel pin, `canRunAgent` / `canUseRepo` / `canManageRepos`
// / `canEditChannelConfig` — is a row here, written in the closed condition
// vocabulary of `types.ts`. Rows for one (action, target) OR; conditions
// inside a row AND; no row → deny. `validatePolicy` runs at module load so a
// row that reads an attribute its resource cannot carry, or names a condition
// outside the vocabulary, fails the import — the table is closed by
// construction, not by review.
//
// COMMANDS. `CommandRegistry.invoke` asks `authorize(caller.actor,
// cmd.action, resource)` for every command on every surface, where the
// resource is `command { id }` unless the definition resolves one from the
// input (`repo.test|build` → `agent { coding }`). One rule shape covers what
// three mechanisms used to decide: the grant admits the command — a Slack user
// holds the grants of the commands the `open` chat gate admitted
// (`CHAT_OPEN_ACTIONS` in grants.ts), an Access browser session every
// `<group>:read`, an admin everything, a token or service token exactly its
// scopes — so a `dispatch`-only token is refused on every registry command and
// a `runs:write` token on `friction:write` by the same row that lets an
// operator through. Where a handler's refusal depends on the DATA (the
// `channel` scope of `config set`, the tier of `mcp add`), the handler asks the
// table about that resource (`config-scope`) and keeps its own reply text.
//
// Grant placeholders: a `has-grant` grant may name a resource attribute in
// braces (`agent:run:{name}`); it is filled from the resource before the
// lookup, and the validator checks the attribute exists on that target.

import {
  CHANNEL_VISIBILITIES,
  RESOURCE_KINDS,
  RESOURCE_TYPES,
  TARGET_ATTRIBUTES,
  targetOf,
  type AttributeName,
  type Target,
} from "./resource.js";
import type { ActorKind, Condition, Rule } from "./types.js";

const grant = (g: string): Condition => ({ kind: "has-grant", grant: g });
const MEMBER_OF: Condition = { kind: "member-of" };
const IS_SELF: Condition = { kind: "is-self" };
const OWNER_OF: Condition = { kind: "owner-of" };
const ALL_CHANNELS: Condition = { kind: "all-channels" };

export const POLICY: readonly Rule[] = [
  // ── runs ─────────────────────────────────────────────────────────────────
  // A run is readable by a member of its channel, by anyone who sees every
  // channel, or by the user it belongs to.
  { action: "runs:read", resource: "run", when: [MEMBER_OF] },
  { action: "runs:read", resource: "run", when: [ALL_CHANNELS] },
  { action: "runs:read", resource: "run", when: [IS_SELF] },
  // Stopping a run needs the write grant AND visibility of the run.
  { action: "runs:write", resource: "run", when: [grant("runs:write"), MEMBER_OF] },
  { action: "runs:write", resource: "run", when: [grant("runs:write"), ALL_CHANNELS] },
  // List-shaped `runs.*`: the grant admits the command; the store predicate narrows the rows.
  { action: "runs:read", resource: "command", when: [grant("runs:read")] },
  { action: "runs:write", resource: "command", when: [grant("runs:write")] },

  // ── review ───────────────────────────────────────────────────────────────
  // `review abridge` spends one Opus-class call and rewrites a stored record:
  // the grant admits the command (admins through `all`, operators by name;
  // never a baseline). Which run it may touch is the `runs:read` point read
  // the handler makes, like every `runs.*` command.
  { action: "review:write", resource: "command", when: [grant("review:write")] },

  // ── friction ─────────────────────────────────────────────────────────────
  // `friction report` is what every Slack user holds (CHAT_OPEN_ACTIONS); what
  // it reports is the store predicate's job. A token needs the grant.
  { action: "friction:read", resource: "command", when: [grant("friction:read")] },
  // `friction propose` files issues: the repo-management gate, now the `friction:write` grant.
  { action: "friction:write", resource: "command", when: [grant("friction:write")] },

  // ── repos ────────────────────────────────────────────────────────────────
  { action: "repo:read", resource: "command", when: [grant("repo:read")] },
  { action: "repo:write", resource: "repo", when: [grant("repo:write")] },
  { action: "repo:write", resource: "command", when: [grant("repo:write")] },
  // `repo test|build` run the repo's onboarded command as the coding agent with
  // zero model turns: admitted by the right to run that agent (the `agentRun`
  // chat gate) or by the exec grant a token was minted with; `write` never
  // implies `exec`. The per-repo allowlist is the handler's own check.
  { action: "repo:exec", resource: "agent", when: [grant("agent:run:{name}")] },
  { action: "repo:exec", resource: "agent", when: [grant("repo:exec")] },
  // The exec grant on a repo the actor may use (not yet asked by a command).
  { action: "repo:exec", resource: "repo", when: [grant("repo:exec"), OWNER_OF] },
  // Binding a run to a repo; open-when-absent today → grants.repos = "all".
  { action: "repo:use", resource: "repo", when: [OWNER_OF] },

  // ── config ───────────────────────────────────────────────────────────────
  // `config show`: the read grant.
  { action: "config:read", resource: "command", when: [grant("config:read")] },
  // `config set|clear|instructions`: a person always has their own scope to
  // write (`me`), whichever list names them; a credential needs the grant. The
  // `channel` scope is the handler's question about `config-scope/channel`.
  { action: "config:write", resource: "command", actorKinds: ["user"], when: [] },
  { action: "config:write", resource: "command", when: [grant("config:write")] },
  // Channel config: the `config:write` grant (held only where `grants` say so:
  // admins through `all`, anyone granted it by name; never a baseline). Membership
  // is NOT a condition
  // here: a chat user may target another channel with `--channel`, and no
  // adapter proves channel membership yet (the channel directory's `isMember`
  // is where that fact will come from).
  { action: "config:write", resource: "config-scope", resourceKind: "channel", when: [grant("config:write")] },
  // A user edits only their own scope.
  { action: "config:write", resource: "config-scope", resourceKind: "user", when: [IS_SELF] },

  // ── agents ───────────────────────────────────────────────────────────────
  // `agent:run:*` covers every agent through wildcard coverage (grants.ts).
  { action: "agent:run", resource: "agent", when: [grant("agent:run:{name}")] },

  // ── help / schedules / deploy / env / setup ──────────────────────────────────────
  { action: "help:read", resource: "command", when: [grant("help:read")] },
  { action: "status:read", resource: "command", when: [grant("status:read")] },
  { action: "schedule:read", resource: "command", when: [grant("schedule:read")] },
  { action: "deploy:read", resource: "command", when: [grant("deploy:read")] },
  { action: "deploy:write", resource: "command", when: [grant("deploy:write")] },
  { action: "env:write", resource: "command", when: [grant("env:write")] },
  { action: "setup:write", resource: "command", when: [grant("setup:write")] },
  // `contract render` reads host paths the caller names: CLI-only, the read
  // grant by name — no chat baseline holds it.
  { action: "contract:read", resource: "command", when: [grant("contract:read")] },

  // ── mcp (external MCP servers live in the three config tiers) ────────────
  { action: "mcp:read", resource: "command", when: [grant("mcp:read")] },
  { action: "mcp:write", resource: "command", when: [grant("mcp:write")] },
  // A CHANNEL's servers: the channel-config right for a person; a credential
  // an admin minted with `mcp:write` manages any tier it can name.
  { action: "mcp:write", resource: "config-scope", resourceKind: "channel", when: [grant("config:write")] },
  {
    action: "mcp:write",
    resource: "config-scope",
    resourceKind: "channel",
    actorKinds: ["service"],
    when: [grant("mcp:write")],
  },
  // ORG-wide servers reach the coding/review agents: the repo-management right
  // (`repo:write`, fail-closed) for a person; `mcp:write` for a credential.
  { action: "mcp:write", resource: "config-scope", resourceKind: "org", when: [grant("repo:write")] },
  {
    action: "mcp:write",
    resource: "config-scope",
    resourceKind: "org",
    actorKinds: ["service"],
    when: [grant("mcp:write")],
  },

  // ── memory ───────────────────────────────────────────────────────────────
  // `memory list` / `memory forget`: the grant admits the command; which
  // records a caller may reach is the handler's scope-key check (invariant 4),
  // and forgetting a SHARED record is the repo-management right (`repo:write`).
  { action: "memory:read", resource: "command", when: [grant("memory:read")] },
  { action: "memory:write", resource: "command", when: [grant("memory:write")] },
  // Reads are unchanged: org is shared; the rest are relations.
  { action: "memory:read", resource: "memory-scope", resourceKind: "org", when: [] },
  { action: "memory:read", resource: "memory-scope", resourceKind: "user", when: [IS_SELF] },
  { action: "memory:read", resource: "memory-scope", resourceKind: "channel", when: [MEMBER_OF] },
  { action: "memory:read", resource: "memory-scope", resourceKind: "repo", when: [OWNER_OF] },
  // Writes: a fact from a private/dm/unknown origin has NO org row.
  {
    action: "memory:write",
    resource: "memory-scope",
    resourceKind: "org",
    originVisibility: ["public", "machine"],
    when: [],
  },
  { action: "memory:write", resource: "memory-scope", resourceKind: "user", when: [IS_SELF] },
  { action: "memory:write", resource: "memory-scope", resourceKind: "channel", when: [MEMBER_OF] },
  { action: "memory:write", resource: "memory-scope", resourceKind: "repo", when: [OWNER_OF] },

  // ── schedules ────────────────────────────────────────────────────────────
  // Only the schedule shim's actor fires a schedule.
  { action: "schedule:fire", resource: "command", actorKinds: ["schedule"], when: [] },
];

export const ACTOR_KINDS: readonly ActorKind[] = ["user", "service", "schedule", "agent"];

export const CONDITION_KINDS: readonly Condition["kind"][] = [
  "has-grant",
  "member-of",
  "is-self",
  "owner-of",
  "all-channels",
];

const REQUIRED_ATTRIBUTE: Readonly<Partial<Record<Condition["kind"], AttributeName>>> = {
  "member-of": "channelId",
  "is-self": "userId",
  "owner-of": "repo",
};

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Attribute names a grant string references (`agent:run:{name}` → `["name"]`). */
export function grantPlaceholders(grantName: string): string[] {
  return [...grantName.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** Fill a grant's placeholders from the resource; `undefined` when an attribute is missing. */
export function resolveGrant(
  grantName: string,
  attributes: Readonly<Partial<Record<AttributeName, string>>>,
): string | undefined {
  let missing = false;
  const resolved = grantName.replace(PLACEHOLDER, (_m, key: string) => {
    const value = attributes[key as AttributeName];
    if (value === undefined) missing = true;
    return value ?? "";
  });
  return missing ? undefined : resolved;
}

export function ruleTarget(rule: Rule): Target | undefined {
  return targetOf(rule.resource, rule.resourceKind);
}

class PolicyError extends Error {
  constructor(message: string, rule: unknown) {
    super(`authz policy: ${message} (rule ${describeRule(rule)})`);
    this.name = "PolicyError";
  }
}

function describeRule(rule: unknown): string {
  if (typeof rule !== "object" || rule === null) return String(rule);
  const r = rule as Partial<Rule>;
  return `${String(r.action)} on ${String(r.resource)}${r.resourceKind ? `/${String(r.resourceKind)}` : ""}`;
}

/** Refuse a table the evaluators could not both decide and compile.
 *  Called on `POLICY` at module load; exported so a test can feed it a bad table. */
export function validatePolicy(rules: readonly Rule[]): void {
  if (!Array.isArray(rules)) throw new PolicyError("table is not an array", rules);
  for (const rule of rules as readonly unknown[]) {
    if (typeof rule !== "object" || rule === null) throw new PolicyError("row is not an object", rule);
    const r = rule as Rule;
    if (typeof r.action !== "string" || r.action.length === 0)
      throw new PolicyError("action must be a non-empty string", rule);
    if (!RESOURCE_TYPES.includes(r.resource))
      throw new PolicyError(`unknown resource type ${String(r.resource)}`, rule);
    // The distributed `Rule` type already ties `resourceKind` to its resource; these
    // runtime checks stay because a table may arrive untyped (config, a test, a future loader).
    const kinds: readonly string[] | undefined = RESOURCE_KINDS[r.resource];
    if (kinds && r.resourceKind === undefined)
      throw new PolicyError(`${r.resource} rows must name a resourceKind (${kinds.join("|")})`, rule);
    if (!kinds && r.resourceKind !== undefined)
      throw new PolicyError(`${r.resource} is not kinded; resourceKind is not allowed`, rule);
    const target = ruleTarget(r);
    if (!target) throw new PolicyError(`unknown resourceKind ${String(r.resourceKind)}`, rule);
    if (r.actorKinds !== undefined) {
      if (!Array.isArray(r.actorKinds) || r.actorKinds.length === 0)
        throw new PolicyError("actorKinds must be a non-empty array", rule);
      for (const kind of r.actorKinds)
        if (!ACTOR_KINDS.includes(kind)) throw new PolicyError(`unknown actor kind ${String(kind)}`, rule);
    }
    if (r.originVisibility !== undefined) {
      if (!Array.isArray(r.originVisibility) || r.originVisibility.length === 0)
        throw new PolicyError("originVisibility must be a non-empty array", rule);
      for (const v of r.originVisibility)
        if (!CHANNEL_VISIBILITIES.includes(v)) throw new PolicyError(`unknown visibility ${String(v)}`, rule);
    }
    if (!Array.isArray(r.when)) throw new PolicyError("when must be an array", rule);
    const carried = TARGET_ATTRIBUTES[target];
    for (const condition of r.when as readonly unknown[]) {
      if (typeof condition !== "object" || condition === null)
        throw new PolicyError("condition is not an object", rule);
      const c = condition as Condition;
      if (!CONDITION_KINDS.includes(c.kind)) throw new PolicyError(`unknown condition ${String(c.kind)}`, rule);
      const needs = REQUIRED_ATTRIBUTE[c.kind];
      if (needs && !carried.includes(needs))
        throw new PolicyError(`${c.kind} needs ${needs}, which ${target} cannot carry`, rule);
      if (c.kind === "has-grant") {
        if (typeof c.grant !== "string" || c.grant.length === 0)
          throw new PolicyError("has-grant needs a grant name", rule);
        for (const attribute of grantPlaceholders(c.grant)) {
          if (!carried.includes(attribute as AttributeName))
            throw new PolicyError(`grant placeholder {${attribute}} is not an attribute of ${target}`, rule);
        }
      }
    }
  }
}

validatePolicy(POLICY);
