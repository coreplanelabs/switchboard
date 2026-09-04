import { describe, expect, it } from "vitest";
import { authorize, authorizeWith, effectiveGrants, hasAction, holds, intersectGrants, principalOf } from "./authorize.js";
import { POLICY, ruleTarget } from "./policy.js";
import { ACTORS, CHANNELS, REPOS, USERS, actor, grants, run, runFixture, scope, scopeFixture } from "./testing.js";
import type { Actor, GrantSet, Resource, Rule } from "./types.js";

// Plan U1 / R1, R2, R7, R11, KTD8: the one decision — grant arithmetic (wildcard
// coverage on actions, literal ids elsewhere, the on-behalf-of intersection
// that is never a superset), fail-closed defaults, and reasons that carry no
// resource id.

const A = ACTORS;
const members = (set: GrantSet): string[] => (set === "all" ? ["all"] : [...set].sort());

describe("hasAction", () => {
  it("holds a literal grant and everything under a `<prefix>:*` wildcard", () => {
    expect(hasAction(new Set(["runs:read"]), "runs:read")).toBe(true);
    expect(hasAction(new Set(["runs:*"]), "runs:read")).toBe(true);
    expect(hasAction(new Set(["agent:run:*"]), "agent:run:coding")).toBe(true);
    expect(hasAction(new Set(["agent:*"]), "agent:run:coding")).toBe(true);
    expect(hasAction("all", "anything:at:all")).toBe(true);
  });
  it("does not hold a sibling, a prefix, or a grant with no namespace", () => {
    expect(hasAction(new Set(["runs:read"]), "runs:write")).toBe(false);
    expect(hasAction(new Set(["runs:*"]), "friction:read")).toBe(false);
    expect(hasAction(new Set(["runs:read"]), "runs")).toBe(false);
    expect(hasAction(new Set(["*"]), "runs:read")).toBe(false);
    expect(hasAction(new Set(), "runs:read")).toBe(false);
  });
});

describe("holds", () => {
  it("is literal: no wildcard on channel or repo ids", () => {
    expect(holds(new Set(["slack:C1"]), "slack:C1")).toBe(true);
    expect(holds(new Set(["slack:*"]), "slack:C1")).toBe(false);
    expect(holds("all", "slack:C1")).toBe(true);
    expect(holds(new Set(), "slack:C1")).toBe(false);
  });
});

describe("intersectGrants", () => {
  it("`all` is the identity; sets intersect", () => {
    const a = grants({ actions: "all", channels: new Set(["slack:C1", "slack:C2"]), repos: new Set(["o/r"]) });
    const b = grants({ actions: new Set(["runs:read"]), channels: new Set(["slack:C2", "slack:C3"]), repos: "all" });
    const out = intersectGrants(a, b);
    expect(members(out.actions)).toEqual(["runs:read"]);
    expect(members(out.channels)).toEqual(["slack:C2"]);
    expect(members(out.repos)).toEqual(["o/r"]);
  });
  it("intersects wildcards by coverage, keeping the narrower name", () => {
    const out = intersectGrants(grants({ actions: new Set(["agent:run:*", "friction:write"]) }), grants({ actions: new Set(["agent:run:coding", "repo:write"]) }));
    expect(members(out.actions)).toEqual(["agent:run:coding"]);
    const both = intersectGrants(grants({ actions: new Set(["runs:*"]) }), grants({ actions: new Set(["runs:*"]) }));
    expect(members(both.actions)).toEqual(["runs:*"]);
  });
  it("disjoint sets intersect to nothing", () => {
    const out = intersectGrants(grants({ channels: new Set(["slack:C1"]) }), grants({ channels: new Set(["slack:C2"]) }));
    expect(members(out.channels)).toEqual([]);
  });
});

describe("effectiveGrants", () => {
  it("is the actor's own grants when nobody is acted for", () => {
    expect(effectiveGrants(A.member)).toBe(A.member.grants);
  });
  it("an agent with `all` on behalf of a member gets exactly the member's grants", () => {
    const agent = actor("agent", "agent:coding", { actions: "all", channels: "all", repos: "all" }, { onBehalfOf: A.member });
    const out = effectiveGrants(agent);
    expect(members(out.actions)).toEqual(members(A.member.grants.actions));
    expect(members(out.channels)).toEqual(members(A.member.grants.channels));
  });
  it("an agent with narrow grants on behalf of the admin does not widen to the admin's", () => {
    const agent = actor("agent", "agent:coding", { actions: new Set(["runs:read"]), channels: new Set(["slack:C_PUB1"]) }, { onBehalfOf: A.admin });
    const out = effectiveGrants(agent);
    expect(members(out.actions)).toEqual(["runs:read"]);
    expect(members(out.channels)).toEqual(["slack:C_PUB1"]);
    expect(members(out.repos)).toEqual([]);
  });
  it("chains: an agent acting for an agent acting for a user intersects all three", () => {
    const inner = actor("agent", "agent:review", { actions: "all", channels: new Set(["slack:C_PUB1", "slack:C_PRIV"]) }, { onBehalfOf: A.member });
    const outer = actor("agent", "agent:ship", { actions: new Set(["runs:read", "runs:write"]), channels: "all" }, { onBehalfOf: inner });
    const out = effectiveGrants(outer);
    expect(members(out.actions)).toEqual(["runs:read", "runs:write"]);
    expect(members(out.channels)).toEqual(["slack:C_PRIV", "slack:C_PUB1"]);
  });
  it("is never a superset of either side (property over every fixture pair)", () => {
    const all = Object.values(A).filter((a) => a.kind !== ("bogus" as string));
    for (const own of all) {
      for (const principal of all) {
        const out = effectiveGrants({ ...own, kind: "agent", onBehalfOf: principal });
        for (const key of ["actions", "channels", "repos"] as const) {
          const set = out[key];
          const covers = key === "actions" ? hasAction : holds;
          if (set === "all") {
            expect(own.grants[key]).toBe("all");
            expect(effectiveGrants(principal)[key]).toBe("all");
          } else {
            for (const member of set) {
              expect(covers(own.grants[key], member)).toBe(true);
              expect(covers(effectiveGrants(principal)[key], member)).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe("principalOf", () => {
  it("is the actor itself without a chain, else the root of the on-behalf-of chain", () => {
    expect(principalOf(A.member)).toBe(A.member);
    const inner = actor("agent", "agent:review", {}, { onBehalfOf: A.nonMember });
    const outer = actor("agent", "agent:ship", {}, { onBehalfOf: inner });
    expect(principalOf(outer)).toBe(A.nonMember);
  });
});

describe("authorize: table shape", () => {
  it("no row for the (action, resource) → deny no-rule", () => {
    expect(authorize(A.admin, "runs:read", { type: "channel", id: CHANNELS.pub1.id, visibility: "public" })).toEqual({ allow: false, reason: "no-rule" });
    expect(authorize(A.admin, "runs:delete", run())).toEqual({ allow: false, reason: "no-rule" });
    expect(authorize(A.admin, "agent:run", { type: "command", id: "x" })).toEqual({ allow: false, reason: "no-rule" });
  });
  it("an empty table denies everything with no-rule", () => {
    expect(authorizeWith([], A.admin, "runs:read", run())).toEqual({ allow: false, reason: "no-rule" });
  });
  it("unknown actor kind → deny before anything else, even with every grant", () => {
    expect(authorize(A.bogus, "friction:read", { type: "command", id: "friction.report" })).toEqual({ allow: false, reason: "unknown-actor-kind" });
    expect(authorize(A.bogus, "runs:read", run())).toEqual({ allow: false, reason: "unknown-actor-kind" });
  });
  it("rows exist but none admits the actor kind → actor-kind", () => {
    expect(authorize(A.admin, "schedule:fire", { type: "command", id: "friction.propose" })).toEqual({ allow: false, reason: "actor-kind" });
    expect(authorize(A.schedule, "schedule:fire", { type: "command", id: "friction.propose" })).toEqual({ allow: true });
  });
  it("rows OR: any one satisfied row allows", () => {
    // The non-member is not in the private channel (row 1 fails) and holds no all-channels (row 2 fails) but owns the run (row 3).
    expect(authorize(A.nonMember, "runs:read", run({ channel: "priv", userId: A.nonMember.id }))).toEqual({ allow: true });
  });
  it("conditions AND: a held grant without membership denies", () => {
    expect(authorize(A.member, "runs:write", run({ channel: "dm" }))).toEqual({ allow: false, reason: "not-member" });
    expect(authorize(A.reader, "runs:write", run({ channel: "pub1" }))).toEqual({ allow: false, reason: "missing-grant" });
  });
  it("an allow carries no reason", () => {
    const decision = authorize(A.admin, "runs:read", run());
    expect(decision).toEqual({ allow: true });
    expect("reason" in decision).toBe(false);
  });
});

describe("authorize: fail-closed (R7)", () => {
  /** A row with no condition whose selectors admit a plain `user` (the only way a grant-less user gets in). */
  const openRows = (action: string, target: string) =>
    POLICY.some((r) => r.action === action && ruleTarget(r) === target && r.when.length === 0 && (!r.actorKinds || r.actorKinds.includes("user")) && !r.originVisibility);

  /** A resource of the row's target that belongs to someone else, in a channel the actor is not in. */
  function foreign(rule: Rule): Resource {
    switch (ruleTarget(rule)) {
      case "run":
        return run({ channel: "priv", userId: "slack:U1" });
      case "channel":
        return { type: "channel", id: CHANNELS.priv.id, visibility: "private" };
      case "memory-scope/org":
        return scope("org", "org:coreplanelabs");
      case "memory-scope/user":
        return scope("user", "user:slack:U1");
      case "memory-scope/channel":
        return scope("channel", `channel:${CHANNELS.priv.id}`);
      case "memory-scope/repo":
        return scope("repo", `repo:${REPOS[0]}`);
      case "repo":
        return { type: "repo", owner: "coreplanelabs", name: "switchboard" };
      case "config-scope/channel":
        return { type: "config-scope", kind: "channel", id: CHANNELS.priv.id };
      case "config-scope/user":
        return { type: "config-scope", kind: "user", id: "slack:U1" };
      case "config-scope/org":
        return { type: "config-scope", kind: "org" };
      case "agent":
        return { type: "agent", name: "coding" };
      case "command":
        return { type: "command", id: "x" };
    }
    throw new Error(`no fixture for ${String(ruleTarget(rule))}`);
  }

  it("NO_GRANTS user: denied on every row except the open ones a user may pass — the shared org memory read, and the config write commands (a person's own scope is theirs; the channel scope is a separate row)", () => {
    const seen: string[] = [];
    for (const rule of POLICY) {
      const target = ruleTarget(rule)!;
      const decision = authorize(A.noGrants, rule.action, foreign(rule));
      expect(decision.allow, `${rule.action} on ${target}`).toBe(openRows(rule.action, target));
      if (decision.allow) seen.push(`${rule.action} ${target}`);
    }
    expect([...new Set(seen)].sort()).toEqual(["config:write command", "memory:read memory-scope/org"]);
  });
  it("a NO_GRANTS credential (service) is denied on every command row — the user-only open row does not admit it", () => {
    const credential = actor("service", "mcp:nothing");
    for (const rule of POLICY.filter((r) => r.resource === "command")) {
      expect(authorize(credential, rule.action, { type: "command", id: "x" }).allow, `${rule.action} on command`).toBe(false);
    }
  });
  it("NO_GRANTS user still reads and writes its OWN scopes (is-self is a relation, not a grant)", () => {
    expect(authorize(A.noGrants, "runs:read", run({ channel: "priv", userId: A.noGrants.id }))).toEqual({ allow: true });
    expect(authorize(A.noGrants, "memory:write", scope("user", `user:${A.noGrants.id}`, "dm"))).toEqual({ allow: true });
    expect(authorize(A.noGrants, "config:write", { type: "config-scope", kind: "user", id: A.noGrants.id })).toEqual({ allow: true });
  });
  it("unknown membership is not membership: an unlisted channel denies", () => {
    expect(authorize(A.member, "runs:read", run({ channel: "dm", userId: "slack:U5" }))).toEqual({ allow: false, reason: "not-member" });
  });
  it("member-of's public half (item 4, U3): a run stamped `public` is readable by every actor without a channel grant; `unknown`, `private`, `dm` and `machine` are not", () => {
    // Every fixture actor NOT granted pub2 (the non-member is — pub2 is its one channel); the run belongs to someone else (U2).
    for (const a of [A.reader, A.noGrants, A.token, A.manager]) {
      expect(authorize(a, "runs:read", run({ channel: "pub2", userId: "slack:U2" })), a.id).toEqual({ allow: true });
      expect(authorize(a, "runs:read", { ...run({ channel: "pub2", userId: "slack:U2" }), channelVisibility: "unknown" }), a.id).toEqual({ allow: false, reason: "not-member" });
      expect(authorize(a, "runs:read", { ...run({ channel: "pub2", userId: "slack:U2" }), channelVisibility: undefined }), a.id).toEqual({ allow: false, reason: "not-member" });
    }
    expect(authorize(A.noGrants, "runs:read", run({ channel: "priv", userId: "slack:U1" })).allow).toBe(false);
    expect(authorize(A.noGrants, "runs:read", run({ channel: "dm", userId: "slack:U1" })).allow).toBe(false);
    expect(authorize(A.noGrants, "runs:read", run({ channel: "http", userId: "http:x" })).allow).toBe(false);
    // The public half is a RUN's stamp: a public origin never makes a memory scope's channel public.
    expect(authorize(A.noGrants, "memory:write", { ...scope("channel", `channel:${CHANNELS.priv.id}`, "public") }).allow).toBe(false);
    // …and it needs the write grant too: public makes the member, not the writer.
    expect(authorize(A.reader, "runs:write", run({ channel: "pub2", userId: "slack:U2" }))).toEqual({ allow: false, reason: "missing-grant" });
  });
  it("a malformed scope key never widens: the relation attribute is missing → deny", () => {
    expect(authorize(A.admin, "memory:read", scope("user", "slack:U1")).allow).toBe(false);
    expect(authorize(A.admin, "memory:read", scope("channel", "slack:C_PUB1")).allow).toBe(false);
  });
});

describe("authorize: org memory writes (R11)", () => {
  const org = (v?: Parameters<typeof scope>[2]) => scope("org", "org:coreplanelabs", v);
  it("public and machine origins may write org; private, dm, unknown, and absent never do — for any actor", () => {
    for (const a of [A.admin, A.member, A.noGrants, A.token, A.schedule]) {
      expect(authorize(a, "memory:write", org("public")), a.id).toEqual({ allow: true });
      expect(authorize(a, "memory:write", org("machine")), a.id).toEqual({ allow: true });
      for (const v of ["private", "dm", "unknown", undefined] as const) {
        expect(authorize(a, "memory:write", org(v)), `${a.id} ${String(v)}`).toEqual({ allow: false, reason: "origin-visibility" });
      }
    }
  });
  it("the narrower scopes stay writable from a private origin", () => {
    expect(authorize(A.member, "memory:write", scope("user", `user:${A.member.id}`, "private"))).toEqual({ allow: true });
    expect(authorize(A.member, "memory:write", scope("channel", `channel:${CHANNELS.priv.id}`, "private"))).toEqual({ allow: true });
  });
});

describe("authorize: agents act on behalf of a principal (R2)", () => {
  const foreignPriv = run({ channel: "priv", userId: "slack:U5" });
  it("an agent with `all` on behalf of a non-member cannot read the non-member's inaccessible run", () => {
    expect(authorize(A.nonMember, "runs:read", foreignPriv).allow).toBe(false);
    expect(authorize(A.agentForNonMember, "runs:read", foreignPriv)).toEqual({ allow: false, reason: "not-member" });
  });
  it("…but reads what the principal can read, and is-self resolves to the principal", () => {
    expect(authorize(A.agentForNonMember, "runs:read", run({ channel: "pub2", userId: "slack:U5" }))).toEqual({ allow: true });
    expect(authorize(A.agentForNonMember, "runs:read", run({ channel: "priv", userId: A.nonMember.id }))).toEqual({ allow: true });
    expect(authorize(A.agentForNonMember, "memory:read", scope("user", `user:${A.nonMember.id}`))).toEqual({ allow: true });
    expect(authorize(A.agentForNonMember, "memory:read", scope("user", "user:agent:coding"))).toEqual({ allow: false, reason: "not-self" });
  });
  it("a narrow agent on behalf of the admin does not inherit the admin's reach", () => {
    const narrow = actor("agent", "agent:coding", { actions: new Set(["runs:read"]), channels: new Set([CHANNELS.pub1.id]) }, { onBehalfOf: A.admin });
    expect(authorize(narrow, "runs:read", run({ channel: "pub1", userId: "slack:U5" }))).toEqual({ allow: true });
    expect(authorize(narrow, "runs:read", foreignPriv)).toEqual({ allow: false, reason: "not-member" });
    expect(authorize(narrow, "friction:write", { type: "command", id: "friction.propose" })).toEqual({ allow: false, reason: "missing-grant" });
  });
  it("never a superset: over the fixture, an agent's allow set ⊆ its own ∩ its principal's", () => {
    const own = actor("agent", "agent:x", { actions: new Set(["runs:read"]), channels: new Set([CHANNELS.pub1.id, CHANNELS.priv.id]) });
    const asAgent: Actor = { ...own, onBehalfOf: A.member };
    for (const r of runFixture()) {
      const agentAllows = authorize(asAgent, "runs:read", r).allow;
      if (agentAllows) {
        expect(authorize({ ...own, id: A.member.id }, "runs:read", r).allow, r.id).toBe(true);
        expect(authorize(A.member, "runs:read", r).allow, r.id).toBe(true);
      }
    }
  });
});

describe("authorize: deny reasons are machine tokens without resource ids (KTD8)", () => {
  const REASONS = new Set(["unknown-actor-kind", "no-rule", "actor-kind", "origin-visibility", "missing-grant", "not-member", "not-self", "not-owner", "not-all-channels"]);
  it("every deny over the fixtures uses a known reason that names no id", () => {
    const ids = [...USERS, ...Object.values(CHANNELS).map((c) => c.id), ...REPOS, "coding"];
    const actors = Object.values(A);
    const resources: Resource[] = [...runFixture(), ...scopeFixture(), { type: "agent", name: "coding" }, { type: "repo", owner: "coreplanelabs", name: "switchboard" }];
    let denies = 0;
    for (const a of actors) {
      for (const action of ["runs:read", "runs:write", "memory:read", "memory:write", "agent:run", "repo:exec", "schedule:fire"]) {
        for (const resource of resources) {
          const d = authorize(a, action, resource);
          if (d.allow) continue;
          denies += 1;
          expect(REASONS.has(d.reason), d.reason).toBe(true);
          for (const id of ids) expect(d.reason.includes(id), `${d.reason} leaks ${id}`).toBe(false);
        }
      }
    }
    expect(denies).toBeGreaterThan(100);
  });
});
