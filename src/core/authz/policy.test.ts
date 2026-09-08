import { describe, expect, it } from "vitest";
import { authorize, evaluateRule } from "./authorize.js";
import { POLICY, grantPlaceholders, resolveGrant, validatePolicy } from "./policy.js";
import { ACTORS, REPOS, run, scope } from "./testing.js";
import type { Actor, Condition, Resource, Rule } from "./types.js";

// Plan U1: every row of the POLICY table has at least one allow and one deny
// case, keyed by the row's shape — a new row without cases fails `coverage`,
// and a case for a row that no longer exists fails it too. The allow case must
// pass THAT row (evaluateRule) and the table (authorize); the deny case must
// fail that row and be denied by the whole table.

function describeCondition(c: Condition): string {
  return c.kind === "has-grant" ? `has-grant(${c.grant})` : c.kind;
}

export function ruleKey(rule: Rule): string {
  const target = rule.resourceKind ? `${rule.resource}/${rule.resourceKind}` : rule.resource;
  const when = `[${rule.when.map(describeCondition).join(" & ")}]`;
  const kinds = rule.actorKinds ? ` kinds=${rule.actorKinds.join("|")}` : "";
  const origin = rule.originVisibility ? ` origin=${rule.originVisibility.join("|")}` : "";
  return `${rule.action} ${target} ${when}${kinds}${origin}`;
}

type Case = readonly [Actor, Resource];
const command = (id: string): Resource => ({ type: "command", id });
const repo = (slug: string): Resource => {
  const [owner, name] = slug.split("/") as [string, string];
  return { type: "repo", owner, name };
};
const agent = (name: string): Resource => ({ type: "agent", name });
const channelConfig = (id: string): Resource => ({ type: "config-scope", kind: "channel", id });
const userConfig = (id: string): Resource => ({ type: "config-scope", kind: "user", id });
const orgConfig: Resource = { type: "config-scope", kind: "org" };

const A = ACTORS;
const foreignPrivRun = run({ channel: "priv", userId: "slack:UERIN" });

/** The `<action> command [has-grant(<action>)]` shape every command row has (plan U4). */
const commandRow = (action: string, commandId: string, allow: readonly Actor[], deny: readonly Actor[]) => ({
  [`${action} command [has-grant(${action})]`]: {
    allow: allow.map((a): Case => [a, command(commandId)]),
    deny: deny.map((a): Case => [a, command(commandId)]),
  },
});

const CASES: Record<string, { allow: readonly Case[]; deny: readonly Case[] }> = {
  "runs:read run [member-of]": {
    allow: [
      [A.member, run({ channel: "pub1", userId: "slack:UERIN" })],
      [A.token, run({ channel: "http", userId: "http:other" })],
    ],
    deny: [
      [A.nonMember, foreignPrivRun],
      [A.token, run({ channel: "mcp", userId: "mcp:other" })],
    ],
  },
  "runs:read run [all-channels]": {
    allow: [
      [A.admin, foreignPrivRun],
      [A.schedule, run({ channel: "dm", userId: "slack:UERIN" })],
    ],
    deny: [
      [A.nonMember, foreignPrivRun],
      [A.reader, run({ channel: "dm", userId: "slack:UERIN" })],
    ],
  },
  "runs:read run [is-self]": {
    allow: [
      [A.nonMember, run({ channel: "priv", userId: A.nonMember.id })],
      [A.noGrants, run({ channel: "dm", userId: A.noGrants.id })],
    ],
    deny: [
      [A.nonMember, foreignPrivRun],
      [A.noGrants, run({ channel: "dm", userId: "slack:UALICE" })],
    ],
  },
  "runs:write run [has-grant(runs:write) & member-of]": {
    // pub2 is PUBLIC: every actor is a member of it (item 4), so the non-member case is the dm run.
    allow: [
      [A.member, run({ channel: "pub2", userId: "slack:UERIN" })],
      [A.token, run({ channel: "http", userId: "http:other" })],
    ],
    deny: [
      [A.reader, run({ channel: "pub1", userId: "slack:UERIN" })],
      [A.member, run({ channel: "dm", userId: "slack:UERIN" })],
    ],
  },
  "runs:write run [has-grant(runs:write) & all-channels]": {
    allow: [[A.admin, foreignPrivRun]],
    deny: [
      [A.schedule, foreignPrivRun],
      [A.reader, run({ channel: "pub1", userId: "slack:UERIN" })],
    ],
  },
  "runs:read command [has-grant(runs:read)]": {
    allow: [
      [A.member, command("runs.list")],
      [A.schedule, command("runs.list")],
    ],
    deny: [
      [A.noGrants, command("runs.list")],
      [A.manager, command("runs.list")],
    ],
  },
  "runs:write command [has-grant(runs:write)]": {
    allow: [
      [A.member, command("runs.stop")],
      [A.admin, command("runs.stop")],
    ],
    deny: [
      [A.reader, command("runs.stop")],
      [A.noGrants, command("runs.stop")],
    ],
  },
  // `friction report` is what every Slack user holds; a token holding only run scopes is not admitted.
  ...commandRow(
    "friction:read",
    "friction.report",
    [A.chatUser, A.browser, A.operator],
    [A.token, A.noGrants, A.dispatchOnly],
  ),
  "friction:write command [has-grant(friction:write)]": {
    allow: [
      [A.schedule, command("friction.propose")],
      [A.manager, command("friction.propose")],
    ],
    deny: [
      [A.member, command("friction.propose")],
      [A.noGrants, command("friction.propose")],
      [A.chatUser, command("friction.propose")],
    ],
  },
  ...commandRow("repo:read", "repo.list", [A.chatUser, A.browser, A.admin], [A.token, A.noGrants, A.dispatchOnly]),
  "repo:write repo [has-grant(repo:write)]": {
    allow: [
      [A.manager, repo(REPOS[0])],
      [A.admin, repo(REPOS[1])],
    ],
    deny: [
      [A.member, repo(REPOS[0])],
      [A.noGrants, repo(REPOS[0])],
    ],
  },
  "repo:write command [has-grant(repo:write)]": {
    allow: [
      [A.manager, command("repo.onboard")],
      [A.operator, command("repo.onboard")],
    ],
    deny: [
      [A.member, command("repo.onboard")],
      [A.schedule, command("repo.onboard")],
      [A.chatUser, command("repo.onboard")],
      [A.browser, command("repo.onboard")],
    ],
  },
  // `repo test|build`: the right to run the coding agent (the `agentRun` chat gate)…
  "repo:exec agent [has-grant(agent:run:{name})]": {
    allow: [
      [A.agentUser, agent("coding")],
      [A.allAgents, agent("coding")],
      [A.admin, agent("coding")],
    ],
    deny: [
      [A.agentUser, agent("review")],
      [A.chatUser, agent("coding")],
      [A.operator, agent("coding")],
      [A.browser, agent("coding")],
    ],
  },
  // …or the exec grant a token was minted with; `write` never implies `exec`.
  "repo:exec agent [has-grant(repo:exec)]": {
    allow: [
      [A.manager, agent("coding")],
      [A.admin, agent("coding")],
    ],
    deny: [
      [A.operator, agent("coding")],
      [A.dispatchOnly, agent("coding")],
      [A.browser, agent("coding")],
    ],
  },
  "repo:exec repo [has-grant(repo:exec) & owner-of]": {
    allow: [
      [A.manager, repo(REPOS[0])],
      [A.admin, repo(REPOS[1])],
    ],
    deny: [
      [A.manager, repo(REPOS[1])],
      [A.member, repo(REPOS[0])],
    ],
  },
  "repo:use repo [owner-of]": {
    allow: [
      [A.manager, repo(REPOS[0])],
      [A.admin, repo(REPOS[1])],
    ],
    deny: [
      [A.manager, repo(REPOS[1])],
      [A.noGrants, repo(REPOS[0])],
    ],
  },
  ...commandRow(
    "config:read",
    "config.show",
    [A.chatUser, A.browser, A.operator],
    [A.dispatchOnly, A.noGrants, A.token],
  ),
  // `config set|clear|instructions`: a person always has their own scope to write…
  "config:write command [] kinds=user": {
    allow: [
      [A.chatUserGated, command("config.set")],
      [A.browser, command("config.set")],
      [A.noGrants, command("config.set")],
    ],
    deny: [
      [A.dispatchOnly, command("config.set")],
      [A.token, command("config.set")],
      [A.schedule, command("config.set")],
    ],
  },
  // …a credential needs the grant.
  "config:write command [has-grant(config:write)]": {
    allow: [
      [A.operator, command("config.set")],
      [A.member, command("config.set")],
    ],
    deny: [
      [A.dispatchOnly, command("config.set")],
      [A.token, command("config.set")],
      [A.mcpWriter, command("config.set")],
    ],
  },
  // The channel-config right: the `config:write` grant (never a baseline) — its holders, admins, operators, tokens minted with it.
  "config:write config-scope/channel [has-grant(config:write)]": {
    allow: [
      [A.member, channelConfig("slack:C_PUB1")],
      [A.chatUser, channelConfig("slack:C_PUB2")],
      [A.admin, channelConfig("slack:C_PRIV")],
      [A.operator, channelConfig("slack:C_PRIV")],
    ],
    deny: [
      [A.chatUserGated, channelConfig("slack:C_PUB1")],
      [A.reader, channelConfig("slack:C_PUB1")],
      [A.browser, channelConfig("slack:C_PUB1")],
      [A.mcpWriter, channelConfig("slack:C_PUB1")],
    ],
  },
  "config:write config-scope/user [is-self]": {
    allow: [
      [A.member, userConfig(A.member.id)],
      [A.noGrants, userConfig(A.noGrants.id)],
    ],
    deny: [
      [A.member, userConfig("slack:UERIN")],
      [A.admin, userConfig("slack:UERIN")],
    ],
  },
  "agent:run agent [has-grant(agent:run:{name})]": {
    allow: [
      [A.agentUser, agent("coding")],
      [A.allAgents, agent("review")],
      [A.admin, agent("ship")],
    ],
    deny: [
      [A.agentUser, agent("review")],
      [A.noGrants, agent("coding")],
    ],
  },
  ...commandRow("help:read", "help.show", [A.chatUser, A.browser, A.admin], [A.dispatchOnly, A.noGrants, A.token]),
  ...commandRow(
    "schedule:read",
    "schedule.list",
    [A.chatUser, A.browser, A.operator],
    [A.dispatchOnly, A.noGrants, A.token],
  ),
  ...commandRow("deploy:read", "deploy.plan", [A.admin, A.browser, A.operator], [A.chatUser, A.dispatchOnly, A.token]),
  ...commandRow("deploy:write", "deploy.all", [A.admin, A.operator], [A.chatUser, A.browser, A.dispatchOnly]),
  ...commandRow("env:write", "env.bootstrap", [A.admin, A.operator], [A.chatUser, A.browser, A.dispatchOnly]),
  ...commandRow("mcp:read", "mcp.list", [A.chatUser, A.browser, A.operator], [A.dispatchOnly, A.noGrants, A.token]),
  ...commandRow("mcp:write", "mcp.add", [A.chatUser, A.mcpWriter, A.operator], [A.browser, A.dispatchOnly, A.noGrants]),
  // A CHANNEL's MCP servers: the channel-config right for a person…
  "mcp:write config-scope/channel [has-grant(config:write)]": {
    allow: [
      [A.chatUser, channelConfig("slack:C_PUB1")],
      [A.admin, channelConfig("slack:C_PUB1")],
      [A.operator, channelConfig("slack:C_PUB1")],
    ],
    deny: [
      [A.chatUserGated, channelConfig("slack:C_PUB1")],
      [A.browser, channelConfig("slack:C_PUB1")],
      [A.dispatchOnly, channelConfig("slack:C_PUB1")],
    ],
  },
  // …`mcp:write` itself for a credential (a person holding mcp:write is not admitted by this row).
  "mcp:write config-scope/channel [has-grant(mcp:write)] kinds=service": {
    allow: [[A.mcpWriter, channelConfig("slack:C_PUB1")]],
    deny: [
      [A.chatUserGated, channelConfig("slack:C_PUB1")],
      [A.dispatchOnly, channelConfig("slack:C_PUB1")],
      [A.token, channelConfig("slack:C_PUB1")],
    ],
  },
  // ORG-wide MCP servers: the repo-management right for a person…
  "mcp:write config-scope/org [has-grant(repo:write)]": {
    allow: [
      [A.manager, orgConfig],
      [A.admin, orgConfig],
      [A.operator, orgConfig],
    ],
    deny: [
      [A.chatUser, orgConfig],
      [A.browser, orgConfig],
      [A.dispatchOnly, orgConfig],
    ],
  },
  // …`mcp:write` itself for a credential (a chat user holds mcp:write for the command, never the org tier).
  "mcp:write config-scope/org [has-grant(mcp:write)] kinds=service": {
    allow: [[A.mcpWriter, orgConfig]],
    deny: [
      [A.chatUser, orgConfig],
      [A.dispatchOnly, orgConfig],
      [A.token, orgConfig],
    ],
  },
  ...commandRow(
    "memory:read",
    "memory.list",
    [A.chatUser, A.browser, A.operator],
    [A.dispatchOnly, A.noGrants, A.token],
  ),
  ...commandRow(
    "memory:write",
    "memory.forget",
    [A.chatUser, A.operator, A.admin],
    [A.browser, A.dispatchOnly, A.noGrants],
  ),
  "memory:read memory-scope/org []": {
    allow: [[A.noGrants, scope("org", "org:acme")]],
    deny: [[A.bogus, scope("org", "org:acme")]],
  },
  "memory:read memory-scope/user [is-self]": {
    allow: [[A.member, scope("user", `user:${A.member.id}`)]],
    deny: [
      [A.member, scope("user", "user:slack:UERIN")],
      [A.admin, scope("user", "user:slack:UERIN")],
    ],
  },
  "memory:read memory-scope/channel [member-of]": {
    allow: [
      [A.member, scope("channel", "channel:slack:C_PUB1")],
      [A.admin, scope("channel", "channel:slack:C_PRIV")],
    ],
    deny: [
      [A.member, scope("channel", "channel:slack:C_PUB2")],
      [A.noGrants, scope("channel", "channel:slack:C_PUB1")],
    ],
  },
  "memory:read memory-scope/repo [owner-of]": {
    allow: [[A.manager, scope("repo", `repo:${REPOS[0]}`)]],
    deny: [
      [A.manager, scope("repo", `repo:${REPOS[1]}`)],
      [A.noGrants, scope("repo", `repo:${REPOS[0]}`)],
    ],
  },
  "memory:write memory-scope/org [] origin=public|machine": {
    allow: [
      [A.noGrants, scope("org", "org:acme", "public")],
      [A.token, scope("org", "org:acme", "machine")],
    ],
    deny: [
      [A.admin, scope("org", "org:acme", "private")],
      [A.admin, scope("org", "org:acme", "dm")],
      [A.admin, scope("org", "org:acme", "unknown")],
      [A.admin, scope("org", "org:acme")],
    ],
  },
  "memory:write memory-scope/user [is-self]": {
    allow: [[A.member, scope("user", `user:${A.member.id}`, "dm")]],
    deny: [[A.member, scope("user", "user:slack:UERIN", "dm")]],
  },
  "memory:write memory-scope/channel [member-of]": {
    allow: [[A.member, scope("channel", "channel:slack:C_PRIV", "private")]],
    deny: [[A.member, scope("channel", "channel:slack:C_PUB2", "public")]],
  },
  "memory:write memory-scope/repo [owner-of]": {
    allow: [[A.manager, scope("repo", `repo:${REPOS[0]}`, "private")]],
    deny: [[A.manager, scope("repo", `repo:${REPOS[1]}`, "public")]],
  },
  "schedule:fire command [] kinds=schedule": {
    allow: [[A.schedule, command("friction.propose")]],
    deny: [
      [A.admin, command("friction.propose")],
      [A.token, command("friction.propose")],
    ],
  },
};

describe("POLICY coverage", () => {
  it("every row has a case and every case names a row (no duplicate rows)", () => {
    const keys = POLICY.map(ruleKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(CASES).sort());
  });
  it("the table validates at load", () => {
    expect(() => validatePolicy(POLICY)).not.toThrow();
  });
  for (const rule of POLICY) {
    const key = ruleKey(rule);
    const cases = CASES[key];
    if (!cases) continue; // reported by the coverage test above
    describe(key, () => {
      it("allows its allow cases through this row and through the table", () => {
        expect(cases.allow.length).toBeGreaterThan(0);
        for (const [actor, resource] of cases.allow) {
          expect(evaluateRule(rule, actor, resource), `${actor.id} row`).toBe(true);
          expect(authorize(actor, rule.action, resource), `${actor.id} table`).toEqual({ allow: true });
        }
      });
      it("denies its deny cases in this row and across the table", () => {
        expect(cases.deny.length).toBeGreaterThan(0);
        for (const [actor, resource] of cases.deny) {
          expect(evaluateRule(rule, actor, resource), `${actor.id} row`).toBe(false);
          expect(authorize(actor, rule.action, resource).allow, `${actor.id} table`).toBe(false);
        }
      });
    });
  }
});

describe("validatePolicy (closed vocabulary, KTD1)", () => {
  const bad = (rule: Record<string, unknown>) => () => validatePolicy([rule as unknown as Rule]);

  it("refuses a condition outside the vocabulary", () => {
    expect(bad({ action: "runs:read", resource: "run", when: [{ kind: "is-tuesday" }] })).toThrow(
      /unknown condition is-tuesday/,
    );
  });
  it("refuses a condition whose attribute the resource cannot carry", () => {
    expect(bad({ action: "friction:read", resource: "command", when: [{ kind: "member-of" }] })).toThrow(
      /member-of needs channelId, which command cannot carry/,
    );
    expect(bad({ action: "agent:run", resource: "agent", when: [{ kind: "is-self" }] })).toThrow(
      /is-self needs userId/,
    );
    expect(
      bad({ action: "memory:read", resource: "memory-scope", resourceKind: "org", when: [{ kind: "owner-of" }] }),
    ).toThrow(/owner-of needs repo, which memory-scope\/org cannot carry/);
    expect(
      bad({ action: "config:write", resource: "config-scope", resourceKind: "user", when: [{ kind: "member-of" }] }),
    ).toThrow(/config-scope\/user cannot carry/);
  });
  it("refuses a grant placeholder that is not an attribute of the target", () => {
    expect(
      bad({ action: "runs:read", resource: "run", when: [{ kind: "has-grant", grant: "agent:run:{name}" }] }),
    ).toThrow(/placeholder \{name\}/);
    expect(bad({ action: "agent:run", resource: "agent", when: [{ kind: "has-grant", grant: "" }] })).toThrow(
      /has-grant needs a grant name/,
    );
  });
  it("the distributed Rule type refuses a wrong, missing, or misplaced kind at compile time; the runtime check agrees", () => {
    // @ts-expect-error — `repo` is a memory-scope kind, not a config-scope kind
    const crossed: Rule = { action: "config:write", resource: "config-scope", resourceKind: "repo", when: [] };
    expect(() => validatePolicy([crossed])).toThrow(/unknown resourceKind repo/);
    // @ts-expect-error — kinded resources REQUIRE resourceKind
    const missing: Rule = { action: "memory:read", resource: "memory-scope", when: [] };
    expect(() => validatePolicy([missing])).toThrow(/must name a resourceKind/);
    // @ts-expect-error — plain resources take no resourceKind
    const misplaced: Rule = { action: "runs:read", resource: "run", resourceKind: "org", when: [] };
    expect(() => validatePolicy([misplaced])).toThrow(/not kinded/);
  });
  it("refuses a kinded type without a kind, an unknown kind, and a kind on a plain type", () => {
    expect(bad({ action: "memory:read", resource: "memory-scope", when: [] })).toThrow(/must name a resourceKind/);
    expect(bad({ action: "memory:read", resource: "memory-scope", resourceKind: "team", when: [] })).toThrow(
      /unknown resourceKind team/,
    );
    expect(bad({ action: "runs:read", resource: "run", resourceKind: "org", when: [] })).toThrow(/not kinded/);
  });
  it("refuses an unknown resource type, actor kind, or visibility", () => {
    expect(bad({ action: "x:read", resource: "widget", when: [] })).toThrow(/unknown resource type widget/);
    expect(bad({ action: "x:read", resource: "command", actorKinds: ["robot"], when: [] })).toThrow(
      /unknown actor kind robot/,
    );
    expect(bad({ action: "x:read", resource: "command", actorKinds: [], when: [] })).toThrow(
      /actorKinds must be a non-empty array/,
    );
    expect(
      bad({
        action: "memory:write",
        resource: "memory-scope",
        resourceKind: "org",
        originVisibility: ["secret"],
        when: [],
      }),
    ).toThrow(/unknown visibility secret/);
  });
  it("refuses malformed rows", () => {
    expect(bad({ resource: "run", when: [] })).toThrow(/action must be a non-empty string/);
    expect(bad({ action: "runs:read", resource: "run" })).toThrow(/when must be an array/);
    expect(() => validatePolicy([null as unknown as Rule])).toThrow(/row is not an object/);
    expect(() => validatePolicy("nope" as unknown as Rule[])).toThrow(/not an array/);
  });
  it("accepts a well-formed row of every shape", () => {
    expect(() =>
      validatePolicy([
        {
          action: "runs:read",
          resource: "run",
          when: [{ kind: "member-of" }, { kind: "all-channels" }, { kind: "has-grant", grant: "runs:read" }],
        },
        { action: "agent:run", resource: "agent", when: [{ kind: "has-grant", grant: "agent:run:{name}" }] },
        { action: "runs:read", resource: "run", when: [{ kind: "member-of" }, { kind: "is-self" }] },
        {
          action: "memory:write",
          resource: "memory-scope",
          resourceKind: "org",
          originVisibility: ["public"],
          actorKinds: ["user", "agent"],
          when: [],
        },
      ]),
    ).not.toThrow();
  });
});

describe("grant placeholders", () => {
  it("lists the attributes a grant names and fills them from the resource", () => {
    expect(grantPlaceholders("agent:run:{name}")).toEqual(["name"]);
    expect(grantPlaceholders("runs:read")).toEqual([]);
    expect(resolveGrant("agent:run:{name}", { name: "coding" })).toBe("agent:run:coding");
    expect(resolveGrant("agent:run:{name}", {})).toBeUndefined();
    expect(resolveGrant("runs:read", {})).toBe("runs:read");
  });
});
