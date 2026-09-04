import { describe, expect, it } from "vitest";
import { authorize, authorizeWith } from "./authorize.js";
import { matchesPredicate, predicateFor, predicateWith } from "./predicate.js";
import { attributesOf } from "./resource.js";
import { ACTORS, CHANNELS, REPOS, actor, runFixture, scopeFixture, type RunResource, type ScopeResource } from "./testing.js";
import type { Actor, Predicate, Resource, ResourceKind, Rule } from "./types.js";

// Plan U1 / R6, KTD2 — THE load-bearing test: the predicate a store runs for
// a list-shaped read admits EXACTLY the records `authorize` allows one at a
// time, for every actor shape, over a corpus spanning every channel visibility.

const A = ACTORS;

function filterByPredicate<R extends Resource>(records: readonly R[], predicate: Predicate): Set<string> {
  return new Set(records.filter((r) => matchesPredicate(predicate, attributesOf(r))).map(idOf));
}
function filterByAuthorize<R extends Resource>(records: readonly R[], a: Actor, action: string): Set<string> {
  return new Set(records.filter((r) => authorize(a, action, r).allow).map(idOf));
}
function idOf(r: Resource): string {
  return "id" in r ? r.id : "key" in r ? `${r.kind}:${r.key}:${r.originChannelVisibility ?? "-"}` : JSON.stringify(r);
}

const DIFFERENTIAL_ACTORS: readonly [string, Actor][] = [
  ["admin (all-channels)", A.admin],
  ["channel-member user", A.member],
  ["non-member user", A.nonMember],
  ["read-only user in one channel", A.reader],
  ["user with no grants", A.noGrants],
  ["repo manager", A.manager],
  ["pinned service token", A.token],
  ["schedule with all-channels", A.schedule],
  ["agent on behalf of a non-member", A.agentForNonMember],
  ["narrow agent on behalf of the admin", actor("agent", "agent:coding", { actions: new Set(["runs:read"]), channels: new Set([CHANNELS.pub1.id]) }, { onBehalfOf: A.admin })],
  ["unknown actor kind", A.bogus],
];

describe("predicateFor ⇔ authorize differential over runs", () => {
  const runs: RunResource[] = runFixture();
  it("the fixture spans ≥50 runs across public, private, dm, and machine channels and several users", () => {
    expect(runs.length).toBeGreaterThanOrEqual(50);
    expect(new Set(runs.map((r) => r.channelVisibility))).toEqual(new Set(["public", "private", "dm", "machine"]));
    expect(new Set(runs.map((r) => r.userId)).size).toBeGreaterThanOrEqual(5);
  });
  for (const action of ["runs:read", "runs:write"]) {
    describe(action, () => {
      for (const [label, a] of DIFFERENTIAL_ACTORS) {
        it(`${label}: predicate filter == point authorize`, () => {
          expect(filterByPredicate(runs, predicateFor(a, action, "run"))).toEqual(filterByAuthorize(runs, a, action));
        });
      }
    });
  }
  describe("a row with two relations compiles to `and` (no such row in POLICY today; alternate table)", () => {
    const table: Rule[] = [
      { action: "runs:read", resource: "run", when: [{ kind: "member-of" }, { kind: "is-self" }] },
      { action: "runs:read", resource: "run", when: [{ kind: "all-channels" }] },
    ];
    it("emits and(channels-in, user-is) for a channel-bound actor", () => {
      expect(predicateWith(table, A.member, "runs:read", "run")).toEqual({
        kind: "and",
        of: [{ kind: "channels-in", channelIds: A.member.grants.channels }, { kind: "user-is", userId: A.member.id }],
      });
      expect(predicateWith(table, A.admin, "runs:read", "run")).toEqual({ kind: "all" });
    });
    for (const [label, a] of DIFFERENTIAL_ACTORS) {
      it(`${label}: predicate filter == point authorize`, () => {
        const byPredicate = filterByPredicate(runs, predicateWith(table, a, "runs:read", "run"));
        const byPoint = new Set(runs.filter((r) => authorizeWith(table, a, "runs:read", r).allow).map(idOf));
        expect(byPredicate).toEqual(byPoint);
      });
    }
    it("is not vacuous: the member sees exactly its own runs in its channels", () => {
      const seen = filterByPredicate(runs, predicateWith(table, A.member, "runs:read", "run"));
      expect(seen.size).toBe(2 * 2); // 2 member channels × 2 repos, userId = member
    });
  });
  it("the differential is not vacuous: the member sees some runs and not others", () => {
    const seen = filterByAuthorize(runs, A.member, "runs:read");
    expect(seen.size).toBeGreaterThan(0);
    expect(seen.size).toBeLessThan(runs.length);
    expect(filterByAuthorize(runs, A.admin, "runs:read").size).toBe(runs.length);
    expect(filterByAuthorize(runs, A.schedule, "runs:read").size).toBe(runs.length);
    expect(filterByAuthorize(runs, A.token, "runs:read")).toEqual(new Set(runs.filter((r) => r.channelId === CHANNELS.http.id).map((r) => r.id)));
  });
});

describe("predicateFor ⇔ authorize differential over memory scopes", () => {
  const scopes: ScopeResource[] = scopeFixture();
  const kinds: ResourceKind[] = ["org", "user", "channel", "repo"];
  for (const kind of kinds) {
    describe(`memory:read / ${kind}`, () => {
      const ofKind = scopes.filter((s) => s.kind === kind);
      for (const [label, a] of DIFFERENTIAL_ACTORS) {
        it(`${label}: predicate filter == point authorize`, () => {
          expect(filterByPredicate(ofKind, predicateFor(a, "memory:read", "memory-scope", kind))).toEqual(filterByAuthorize(ofKind, a, "memory:read"));
        });
      }
    });
  }
  for (const kind of kinds.filter((k) => k !== "org")) {
    describe(`memory:write / ${kind}`, () => {
      const ofKind = scopes.filter((s) => s.kind === kind);
      for (const [label, a] of DIFFERENTIAL_ACTORS) {
        it(`${label}: predicate filter == point authorize`, () => {
          expect(filterByPredicate(ofKind, predicateFor(a, "memory:write", "memory-scope", kind))).toEqual(filterByAuthorize(ofKind, a, "memory:write"));
        });
      }
    });
  }
  it("memory:write / org compiles to none for every actor (origin visibility is a point-check selector), ⊆ authorize", () => {
    const org = scopes.filter((s) => s.kind === "org");
    for (const [label, a] of DIFFERENTIAL_ACTORS) {
      const predicate = predicateFor(a, "memory:write", "memory-scope", "org");
      expect(predicate, label).toEqual({ kind: "none" });
      expect(filterByPredicate(org, predicate).size, label).toBe(0);
    }
    expect(filterByAuthorize(org, A.noGrants, "memory:write").size).toBe(2); // public + machine
  });
});

describe("predicateFor: derivation", () => {
  it("all-channels actor → all", () => {
    expect(predicateFor(A.admin, "runs:read", "run")).toEqual({ kind: "all" });
    expect(predicateFor(A.schedule, "runs:read", "run")).toEqual({ kind: "all" });
  });
  it("member-of → channels-in over the actor's channel set; is-self → user-is; rows OR", () => {
    expect(predicateFor(A.member, "runs:read", "run")).toEqual({
      kind: "or",
      of: [{ kind: "channels-in", channelIds: A.member.grants.channels }, { kind: "user-is", userId: A.member.id }],
    });
  });
  it("a missing grant sinks its row; a held grant is no constraint", () => {
    expect(predicateFor(A.member, "runs:write", "run")).toEqual({ kind: "channels-in", channelIds: A.member.grants.channels });
    expect(predicateFor(A.reader, "runs:write", "run")).toEqual({ kind: "none" });
    expect(predicateFor(A.member, "runs:read", "command")).toEqual({ kind: "all" });
    expect(predicateFor(A.noGrants, "runs:read", "command")).toEqual({ kind: "none" });
  });
  it("an actor with no channels and no grants keeps only its own runs", () => {
    expect(predicateFor(A.noGrants, "runs:read", "run")).toEqual({ kind: "user-is", userId: A.noGrants.id });
  });
  it("owner-of → repos-in (or all)", () => {
    expect(predicateFor(A.manager, "memory:read", "memory-scope", "repo")).toEqual({ kind: "repos-in", repos: A.manager.grants.repos });
    expect(predicateFor(A.admin, "memory:read", "memory-scope", "repo")).toEqual({ kind: "all" });
    expect(predicateFor(A.member, "memory:read", "memory-scope", "repo")).toEqual({ kind: "none" });
  });
  it("an open row → all; an actor-kind-selected row is skipped for other kinds", () => {
    expect(predicateFor(A.noGrants, "friction:read", "command")).toEqual({ kind: "all" });
    expect(predicateFor(A.schedule, "schedule:fire", "command")).toEqual({ kind: "all" });
    expect(predicateFor(A.admin, "schedule:fire", "command")).toEqual({ kind: "none" });
  });
  it("agent actors compile against the intersection and the principal's identity", () => {
    expect(predicateFor(A.agentForNonMember, "runs:read", "run")).toEqual({
      kind: "or",
      of: [{ kind: "channels-in", channelIds: A.nonMember.grants.channels }, { kind: "user-is", userId: A.nonMember.id }],
    });
  });
  it("a placeholder grant cannot be compiled without the record → none", () => {
    expect(predicateFor(A.admin, "agent:run", "agent")).toEqual({ kind: "all" }); // `all` actions need no lookup
    expect(predicateFor(A.allAgents, "agent:run", "agent")).toEqual({ kind: "none" });
  });
  it("nothing applicable → none; unknown actor kind → none", () => {
    expect(predicateFor(A.admin, "runs:delete", "run")).toEqual({ kind: "none" });
    expect(predicateFor(A.bogus, "friction:read", "command")).toEqual({ kind: "none" });
    expect(predicateWith([], A.admin, "runs:read", "run")).toEqual({ kind: "none" });
  });
  it("a kinded type without its kind, or an invalid kind, is a programming error", () => {
    expect(() => predicateFor(A.admin, "memory:read", "memory-scope")).toThrow(/kinded/);
    expect(() => predicateFor(A.admin, "runs:read", "run", "org")).toThrow(/no target/);
  });
});

describe("matchesPredicate", () => {
  const rec = { channelId: CHANNELS.pub1.id, userId: "slack:U2", repo: REPOS[0] };
  it("evaluates each shape against a record's attributes", () => {
    expect(matchesPredicate({ kind: "none" }, rec)).toBe(false);
    expect(matchesPredicate({ kind: "all" }, rec)).toBe(true);
    expect(matchesPredicate({ kind: "channels-in", channelIds: new Set([CHANNELS.pub1.id]) }, rec)).toBe(true);
    expect(matchesPredicate({ kind: "channels-in", channelIds: new Set([CHANNELS.pub2.id]) }, rec)).toBe(false);
    expect(matchesPredicate({ kind: "user-is", userId: "slack:U2" }, rec)).toBe(true);
    expect(matchesPredicate({ kind: "user-is", userId: "slack:U3" }, rec)).toBe(false);
    expect(matchesPredicate({ kind: "repos-in", repos: new Set([REPOS[0]]) }, rec)).toBe(true);
    expect(matchesPredicate({ kind: "repos-in", repos: new Set([REPOS[1]]) }, rec)).toBe(false);
    expect(matchesPredicate({ kind: "or", of: [{ kind: "none" }, { kind: "user-is", userId: "slack:U2" }] }, rec)).toBe(true);
    expect(matchesPredicate({ kind: "or", of: [] }, rec)).toBe(false);
    expect(matchesPredicate({ kind: "and", of: [{ kind: "all" }, { kind: "user-is", userId: "slack:U2" }] }, rec)).toBe(true);
    expect(matchesPredicate({ kind: "and", of: [{ kind: "none" }, { kind: "user-is", userId: "slack:U2" }] }, rec)).toBe(false);
    expect(matchesPredicate({ kind: "and", of: [] }, rec)).toBe(false);
  });
  it("a record missing the attribute never matches a relation", () => {
    expect(matchesPredicate({ kind: "channels-in", channelIds: new Set([CHANNELS.pub1.id]) }, {})).toBe(false);
    expect(matchesPredicate({ kind: "user-is", userId: "slack:U2" }, {})).toBe(false);
    expect(matchesPredicate({ kind: "repos-in", repos: new Set([REPOS[0]]) }, {})).toBe(false);
  });
});
