import { describe, expect, it } from "vitest";
import { ConfigStore, InMemoryOverridesBacking, parseAppConfigText } from "../../config.js";
import { chatActorOf, resolveActor } from "./actor.js";
import { authorize, effectiveGrants } from "./authorize.js";
import { predicateFor, matchesPredicate } from "./predicate.js";
import { attributesOf } from "./resource.js";
import { isRunVisibilityFilter, matchesVisibility, toVisibilityFilter } from "../runRecord.js";
import { ALL_GRANTS, grantsFor } from "./grants.js";
import { holdsAll } from "./viewAs.js";
import type { Actor, Grants, RepoAccess, Resource } from "./types.js";

// Feature: docs/reference/specs/authorization.md — Credential scope proof.
function config(restricted = false, extraGrants = ""): ConfigStore {
  const validated = parseAppConfigText(`
organization: acme
providers:
  openai: { wire: openai-responses, apiKeyEnv: OPENAI_API_KEY }
defaults:
  agent: general
  models:
    general: openai/general-model
    explore: openai/explore-model
    review: openai/review-model
    coding: openai/coding-model
grants:
  "http:fixture":
    actions: [dispatch, agent:run:general, agent:run:explore, agent:run:review]
    channels: ["http:fixture"]
    codeRepos: ["Acme/Fixture"]
  "slack:UADMIN": { actions: all, channels: all, repos: all }
  "slack:UDEV": { actions: [agent:run:coding], repos: ["Acme/Closed"] }
${extraGrants}
${restricted ? 'restrict:\n  agents: [coding]\n  repos: ["Acme/Closed"]' : ""}
`);
  return new ConfigStore({ validated }, { backing: new InMemoryOverridesBacking(), initial: undefined });
}
function actor(store: ConfigStore, surface: "http" | "slack" | "access-browser", subjectId: string): Actor {
  return resolveActor({ surface, subjectId }, (id) => store.grantsFor(id));
}
const repo = (slug: string): Resource => {
  const [owner, name] = slug.split("/");
  return { type: "repo", owner: owner!, name: name! };
};
const memory = (slug: string): Resource => ({ type: "memory-scope", kind: "repo", key: `repo:${slug}` });

describe("compiled credential authority", () => {
  it("the resolved service runs only its three granted agents and fixture repo on an unrestricted deployment", () => {
    const s = config();
    const service = actor(s, "http", "fixture");
    expect(service.kind).toBe("service");
    expect(s.canRunAgent(service, "coding")).toBe(false);
    for (const name of ["general", "explore", "review"]) {
      expect(s.canRunAgent(service, name)).toBe(true);
      expect(authorize(service, "agent:run", { type: "agent", name }).allow).toBe(true);
    }
    expect(s.canUseRepo(service, "acme/customer")).toBe(false);
    expect(s.canUseRepo(service, "ACME/FIXTURE")).toBe(true);
    for (const action of ["memory:read", "memory:write"]) {
      expect(authorize(service, action, memory("acme/customer")).allow).toBe(false);
      expect(authorize(service, action, memory("acme/fixture")).allow).toBe(false);
    }
    expect(s.canRunAgent("http:unlisted", "general")).toBe(false);
    expect(s.canUseRepo("http:unlisted", "acme/fixture")).toBe(false);
  });

  it("explicit codeRepos grants code without repo memory, supports empty ceilings and rejects config complements", () => {
    const s = config(
      false,
      `
  "http:operator": { actions: [agent:run:general, agent:run:coding], codeRepos: all }
  "mcp:operator": { actions: [agent:run:review, repo:exec], codeRepos: ["Acme/Code"], repos: ["Acme/Memory"] }
  "http:memory-owner": { actions: all, channels: all, repos: all, codeRepos: [] }
`,
    );
    const operator = actor(s, "http", "operator");
    expect(s.canRunAgent(operator, "coding")).toBe(true);
    expect(s.canUseRepo(operator, "acme/customer")).toBe(true);
    for (const action of ["memory:read", "memory:write"]) {
      expect(authorize(operator, action, memory("acme/customer")).allow).toBe(false);
    }
    const scoped = resolveActor({ surface: "mcp", subjectId: "operator" }, (id) => s.grantsFor(id));
    expect(s.canUseRepo(scoped, "ACME/CODE")).toBe(true);
    expect(s.canUseRepo(scoped, "acme/memory")).toBe(false);
    expect(s.canUseRepo(scoped, "acme/customer")).toBe(false);
    expect(authorize(scoped, "repo:exec", repo("acme/code")).allow).toBe(true);
    expect(authorize(scoped, "repo:exec", repo("acme/memory")).allow).toBe(false);
    expect(authorize(scoped, "memory:read", memory("acme/memory")).allow).toBe(true);
    expect(authorize(scoped, "memory:write", memory("acme/code")).allow).toBe(false);
    const owner = actor(s, "http", "memory-owner");
    expect(s.canUseRepo(owner, "acme/customer")).toBe(false);
    expect(authorize(owner, "repo:exec", repo("acme/customer")).allow).toBe(false);
    expect(holdsAll(owner)).toBe(false);
    expect(authorize(owner, "memory:read", memory("acme/customer")).allow).toBe(true);
    const bound = chatActorOf(s, {
      userId: "slack:UADMIN",
      authenticatedAs: scoped.id,
      channelId: "mcp:operator",
      threadKey: "mcp:operator:1",
    });
    const delegated: Actor = { ...operator, kind: "agent", onBehalfOf: scoped };
    for (const caller of [bound, delegated]) {
      expect(s.canUseRepo(caller, "acme/customer")).toBe(false);
      expect(s.canUseRepo(caller, "acme/code")).toBe(true);
      expect(authorize(caller, "memory:read", memory("acme/customer")).allow).toBe(false);
    }
    expect(() => config(false, '  "http:bad": { codeRepos: { except: ["acme/customer"] } }')).toThrow(/codeRepos/);
    expect(() => config(false, '  "http:bad": { codeRepos: ["not-a-slug"] }')).toThrow(/codeRepos/);
  });

  it("human open and restricted defaults preserve memory ownership and admin and CLI authority", () => {
    for (const restricted of [false, true]) {
      const s = config(restricted);
      for (const person of [actor(s, "slack", "UOTHER"), actor(s, "access-browser", "browser")]) {
        expect(s.canRunAgent(person, "coding")).toBe(!restricted);
        expect(s.canUseRepo(person, "acme/closed")).toBe(!restricted);
        expect(s.canUseRepo(person, "acme/open")).toBe(true);
        for (const action of ["memory:read", "memory:write"]) {
          expect(authorize(person, action, memory("acme/open")).allow).toBe(false);
        }
      }
      const dev = actor(s, "slack", "UDEV");
      expect(s.canUseRepo(dev, "ACME/CLOSED")).toBe(true);
      expect(authorize(dev, "memory:read", memory("acme/closed")).allow).toBe(true);
      expect(s.canRunAgent(actor(s, "slack", "UADMIN"), "coding")).toBe(true);
      const cli = resolveActor({ surface: "cli", subjectId: "local" }, () => {
        throw new Error("unexpected lookup");
      });
      expect(s.canUseRepo(cli, "acme/customer")).toBe(true);
    }
  });

  it("a credential bound to an admin and mixed nested delegation stay within the credential ceiling", () => {
    const s = config();
    const service = actor(s, "http", "fixture");
    const person = actor(s, "slack", "UADMIN");
    const bound = chatActorOf(s, {
      userId: person.id,
      authenticatedAs: service.id,
      channelId: "http:fixture",
      threadKey: "http:fixture:1",
    });
    const relay = chatActorOf(s, {
      userId: person.id,
      postedBy: service.id,
      channelId: "http:fixture",
      threadKey: "http:fixture:1",
    });
    const nested: Actor = { kind: "agent", id: "agent:review", grants: ALL_GRANTS, onBehalfOf: relay };
    const reversed: Actor = { ...person, kind: "agent", onBehalfOf: service };
    for (const a of [bound, relay, nested, reversed]) {
      expect(s.canRunAgent(a, "coding")).toBe(false);
      expect(s.canUseRepo(a, "acme/customer")).toBe(false);
      expect(s.canRunAgent(a, "review")).toBe(true);
      expect(s.canUseRepo(a, "acme/fixture")).toBe(true);
      expect(authorize(a, "memory:write", memory("acme/customer")).allow).toBe(false);
    }
  });

  it("finite and complementary delegation intersects code access without lending memory ownership", () => {
    const domains: RepoAccess[] = [
      "all",
      new Set(),
      new Set(["Acme/A"]),
      new Set(["acme/b", "acme/c"]),
      { except: new Set() },
      { except: new Set(["Acme/A"]) },
      { except: new Set(["acme/b", "acme/c"]) },
    ];
    const make = (access: RepoAccess, id: string): Actor => ({
      kind: "agent",
      id,
      grants: { actions: "all", channels: "all", repos: new Set(["acme/owned"]), repoAccess: access },
    });
    for (const left of domains)
      for (const right of domains) {
        const a = make(left, "agent:a");
        const b = make(right, "agent:b");
        const delegated = { ...a, onBehalfOf: b };
        expect(effectiveGrants(delegated).repos).toEqual(new Set(["acme/owned"]));
        for (const slug of ["acme/a", "ACME/B", "acme/c", "acme/owned", "acme/foreign"]) {
          const target = repo(slug);
          const expected = authorize(a, "repo:use", target).allow && authorize(b, "repo:use", target).allow;
          expect(authorize(delegated, "repo:use", target).allow).toBe(expected);
          expect(matchesPredicate(predicateFor(delegated, "repo:use", "repo"), attributesOf(target))).toBe(expected);
          expect(authorize(delegated, "memory:read", memory(slug)).allow).toBe(slug === "acme/owned");
        }
      }
    // Union of two human floors and explicit grants removes only explicitly covered exclusions.
    const grants = grantsFor("slack:U", {
      restrict: { agents: new Set(), repos: new Set(["acme/a", "acme/b"]) },
      grants: new Map<string, Grants>([
        ["slack:U", { actions: new Set(), channels: new Set(), repos: new Set(["Acme/A"]) }],
      ]),
    });
    const human: Actor = { kind: "user", id: "slack:U", grants };
    expect(authorize(human, "repo:use", repo("acme/a")).allow).toBe(true);
    expect(authorize(human, "repo:use", repo("acme/b")).allow).toBe(false);
    expect(authorize(human, "repo:use", repo("acme/c")).allow).toBe(true);
    expect(authorize(human, "memory:read", memory("acme/c")).allow).toBe(false);
  });

  it("point, predicate and serialized filters agree on complements, intersections, case and missing repos", () => {
    const s = config(true);
    const person = actor(s, "slack", "UOTHER");
    const service = actor(s, "http", "fixture");
    const delegated: Actor = { ...service, kind: "agent", onBehalfOf: person };
    for (const a of [person, service, delegated]) {
      const predicate = predicateFor(a, "repo:use", "repo");
      const wire = toVisibilityFilter(predicate);
      expect(isRunVisibilityFilter(wire)).toBe(true);
      for (const slug of ["acme/open", "acme/closed", "acme/fixture", "ACME/FIXTURE"]) {
        const target = repo(slug);
        const point = authorize(a, "repo:use", target).allow;
        expect(matchesPredicate(predicate, attributesOf(target))).toBe(point);
        expect(matchesVisibility(wire, { channelId: "http:fixture", userId: a.id, repo: slug })).toBe(point);
        expect(s.canUseRepo(a, slug)).toBe(point);
      }
      expect(matchesPredicate(predicate, {})).toBe(false);
      expect(matchesVisibility(wire, { channelId: "http:fixture", userId: a.id })).toBe(false);
    }
    expect(isRunVisibilityFilter({ kind: "repos-not-in", repos: "all" })).toBe(false);
    expect(isRunVisibilityFilter({ kind: "not", of: [{ kind: "all" }] })).toBe(false);
  });
});
