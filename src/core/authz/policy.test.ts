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

const A = ACTORS;
const foreignPrivRun = run({ channel: "priv", userId: "slack:U5" });

const CASES: Record<string, { allow: readonly Case[]; deny: readonly Case[] }> = {
  "runs:read run [member-of]": {
    allow: [[A.member, run({ channel: "pub1", userId: "slack:U5" })], [A.token, run({ channel: "http", userId: "http:other" })]],
    deny: [[A.nonMember, foreignPrivRun], [A.token, run({ channel: "mcp", userId: "mcp:other" })]],
  },
  "runs:read run [all-channels]": {
    allow: [[A.admin, foreignPrivRun], [A.schedule, run({ channel: "dm", userId: "slack:U5" })]],
    deny: [[A.nonMember, foreignPrivRun], [A.reader, run({ channel: "dm", userId: "slack:U5" })]],
  },
  "runs:read run [is-self]": {
    allow: [[A.nonMember, run({ channel: "priv", userId: A.nonMember.id })], [A.noGrants, run({ channel: "dm", userId: A.noGrants.id })]],
    deny: [[A.nonMember, foreignPrivRun], [A.noGrants, run({ channel: "dm", userId: "slack:U1" })]],
  },
  "runs:write run [has-grant(runs:write) & member-of]": {
    // pub2 is PUBLIC: every actor is a member of it (item 4), so the non-member case is the dm run.
    allow: [[A.member, run({ channel: "pub2", userId: "slack:U5" })], [A.token, run({ channel: "http", userId: "http:other" })]],
    deny: [[A.reader, run({ channel: "pub1", userId: "slack:U5" })], [A.member, run({ channel: "dm", userId: "slack:U5" })]],
  },
  "runs:write run [has-grant(runs:write) & all-channels]": {
    allow: [[A.admin, foreignPrivRun]],
    deny: [[A.schedule, foreignPrivRun], [A.reader, run({ channel: "pub1", userId: "slack:U5" })]],
  },
  "runs:read command [has-grant(runs:read)]": {
    allow: [[A.member, command("runs.list")], [A.schedule, command("runs.list")]],
    deny: [[A.noGrants, command("runs.list")], [A.manager, command("runs.list")]],
  },
  "runs:write command [has-grant(runs:write)]": {
    allow: [[A.member, command("runs.stop")], [A.admin, command("runs.stop")]],
    deny: [[A.reader, command("runs.stop")], [A.noGrants, command("runs.stop")]],
  },
  "friction:read command []": {
    allow: [[A.noGrants, command("friction.report")], [A.token, command("friction.report")]],
    deny: [[A.bogus, command("friction.report")]],
  },
  "friction:write command [has-grant(friction:write)]": {
    allow: [[A.schedule, command("friction.propose")], [A.manager, command("friction.propose")]],
    deny: [[A.member, command("friction.propose")], [A.noGrants, command("friction.propose")]],
  },
  "repo:read command []": {
    allow: [[A.noGrants, command("repo.list")], [A.token, command("repo.list")]],
    deny: [[A.bogus, command("repo.list")]],
  },
  "repo:write repo [has-grant(repo:write)]": {
    allow: [[A.manager, repo(REPOS[0])], [A.admin, repo(REPOS[1])]],
    deny: [[A.member, repo(REPOS[0])], [A.noGrants, repo(REPOS[0])]],
  },
  "repo:write command [has-grant(repo:write)]": {
    allow: [[A.manager, command("repo.onboard")]],
    deny: [[A.member, command("repo.onboard")], [A.schedule, command("repo.onboard")]],
  },
  "repo:exec repo [has-grant(repo:exec) & owner-of]": {
    allow: [[A.manager, repo(REPOS[0])], [A.admin, repo(REPOS[1])]],
    deny: [[A.manager, repo(REPOS[1])], [A.member, repo(REPOS[0])]],
  },
  "repo:use repo [owner-of]": {
    allow: [[A.manager, repo(REPOS[0])], [A.admin, repo(REPOS[1])]],
    deny: [[A.manager, repo(REPOS[1])], [A.noGrants, repo(REPOS[0])]],
  },
  "config:write config-scope/channel [has-grant(config:write) & member-of]": {
    allow: [[A.member, channelConfig("slack:C_PUB1")], [A.admin, channelConfig("slack:C_PRIV")]],
    deny: [[A.member, channelConfig("slack:C_PUB2")], [A.reader, channelConfig("slack:C_PUB1")]],
  },
  "config:write config-scope/user [is-self]": {
    allow: [[A.member, userConfig(A.member.id)], [A.noGrants, userConfig(A.noGrants.id)]],
    deny: [[A.member, userConfig("slack:U5")], [A.admin, userConfig("slack:U5")]],
  },
  "agent:run agent [has-grant(agent:run:{name})]": {
    allow: [[A.agentUser, agent("coding")], [A.allAgents, agent("review")], [A.admin, agent("ship")]],
    deny: [[A.agentUser, agent("review")], [A.noGrants, agent("coding")]],
  },
  "memory:read memory-scope/org []": {
    allow: [[A.noGrants, scope("org", "org:coreplanelabs")]],
    deny: [[A.bogus, scope("org", "org:coreplanelabs")]],
  },
  "memory:read memory-scope/user [is-self]": {
    allow: [[A.member, scope("user", `user:${A.member.id}`)]],
    deny: [[A.member, scope("user", "user:slack:U5")], [A.admin, scope("user", "user:slack:U5")]],
  },
  "memory:read memory-scope/channel [member-of]": {
    allow: [[A.member, scope("channel", "channel:slack:C_PUB1")], [A.admin, scope("channel", "channel:slack:C_PRIV")]],
    deny: [[A.member, scope("channel", "channel:slack:C_PUB2")], [A.noGrants, scope("channel", "channel:slack:C_PUB1")]],
  },
  "memory:read memory-scope/repo [owner-of]": {
    allow: [[A.manager, scope("repo", `repo:${REPOS[0]}`)]],
    deny: [[A.manager, scope("repo", `repo:${REPOS[1]}`)], [A.noGrants, scope("repo", `repo:${REPOS[0]}`)]],
  },
  "memory:write memory-scope/org [] origin=public|machine": {
    allow: [[A.noGrants, scope("org", "org:coreplanelabs", "public")], [A.token, scope("org", "org:coreplanelabs", "machine")]],
    deny: [
      [A.admin, scope("org", "org:coreplanelabs", "private")],
      [A.admin, scope("org", "org:coreplanelabs", "dm")],
      [A.admin, scope("org", "org:coreplanelabs", "unknown")],
      [A.admin, scope("org", "org:coreplanelabs")],
    ],
  },
  "memory:write memory-scope/user [is-self]": {
    allow: [[A.member, scope("user", `user:${A.member.id}`, "dm")]],
    deny: [[A.member, scope("user", "user:slack:U5", "dm")]],
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
    deny: [[A.admin, command("friction.propose")], [A.token, command("friction.propose")]],
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
    expect(bad({ action: "runs:read", resource: "run", when: [{ kind: "is-tuesday" }] })).toThrow(/unknown condition is-tuesday/);
  });
  it("refuses a condition whose attribute the resource cannot carry", () => {
    expect(bad({ action: "friction:read", resource: "command", when: [{ kind: "member-of" }] })).toThrow(/member-of needs channelId, which command cannot carry/);
    expect(bad({ action: "agent:run", resource: "agent", when: [{ kind: "is-self" }] })).toThrow(/is-self needs userId/);
    expect(bad({ action: "memory:read", resource: "memory-scope", resourceKind: "org", when: [{ kind: "owner-of" }] })).toThrow(/owner-of needs repo, which memory-scope\/org cannot carry/);
    expect(bad({ action: "config:write", resource: "config-scope", resourceKind: "user", when: [{ kind: "member-of" }] })).toThrow(/config-scope\/user cannot carry/);
  });
  it("refuses a grant placeholder that is not an attribute of the target", () => {
    expect(bad({ action: "runs:read", resource: "run", when: [{ kind: "has-grant", grant: "agent:run:{name}" }] })).toThrow(/placeholder \{name\}/);
    expect(bad({ action: "agent:run", resource: "agent", when: [{ kind: "has-grant", grant: "" }] })).toThrow(/has-grant needs a grant name/);
  });
  it("the distributed Rule type refuses a wrong, missing, or misplaced kind at compile time; the runtime check agrees", () => {
    // @ts-expect-error — `org` is a memory-scope kind, not a config-scope kind
    const crossed: Rule = { action: "config:write", resource: "config-scope", resourceKind: "org", when: [] };
    expect(() => validatePolicy([crossed])).toThrow(/unknown resourceKind org/);
    // @ts-expect-error — kinded resources REQUIRE resourceKind
    const missing: Rule = { action: "memory:read", resource: "memory-scope", when: [] };
    expect(() => validatePolicy([missing])).toThrow(/must name a resourceKind/);
    // @ts-expect-error — plain resources take no resourceKind
    const misplaced: Rule = { action: "runs:read", resource: "run", resourceKind: "org", when: [] };
    expect(() => validatePolicy([misplaced])).toThrow(/not kinded/);
  });
  it("refuses a kinded type without a kind, an unknown kind, and a kind on a plain type", () => {
    expect(bad({ action: "memory:read", resource: "memory-scope", when: [] })).toThrow(/must name a resourceKind/);
    expect(bad({ action: "memory:read", resource: "memory-scope", resourceKind: "team", when: [] })).toThrow(/unknown resourceKind team/);
    expect(bad({ action: "runs:read", resource: "run", resourceKind: "org", when: [] })).toThrow(/not kinded/);
  });
  it("refuses an unknown resource type, actor kind, or visibility", () => {
    expect(bad({ action: "x:read", resource: "widget", when: [] })).toThrow(/unknown resource type widget/);
    expect(bad({ action: "x:read", resource: "command", actorKinds: ["robot"], when: [] })).toThrow(/unknown actor kind robot/);
    expect(bad({ action: "x:read", resource: "command", actorKinds: [], when: [] })).toThrow(/actorKinds must be a non-empty array/);
    expect(bad({ action: "memory:write", resource: "memory-scope", resourceKind: "org", originVisibility: ["secret"], when: [] })).toThrow(/unknown visibility secret/);
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
        { action: "runs:read", resource: "run", when: [{ kind: "member-of" }, { kind: "all-channels" }, { kind: "has-grant", grant: "runs:read" }] },
        { action: "agent:run", resource: "agent", when: [{ kind: "has-grant", grant: "agent:run:{name}" }] },
        { action: "runs:read", resource: "run", when: [{ kind: "member-of" }, { kind: "is-self" }] },
        { action: "memory:write", resource: "memory-scope", resourceKind: "org", originVisibility: ["public"], actorKinds: ["user", "agent"], when: [] },
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
