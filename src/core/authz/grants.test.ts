import { describe, expect, it } from "vitest";
import { ALL_GRANTS, grantsFor, grantsIn, grantsTable, mergeGrants, parseGrantsConfig, translateLegacyConfig, type GrantsConfig, type LegacyVocabulary } from "./grants.js";
import { NO_GRANTS, type Grants } from "./types.js";

// Feature: docs/plans/2026-09-03-001-feat-authorization-model-plan.md — U2 (R7, R8, KTD6).
// The legacy `permissions.*` / token keys translate to `Grants` by ONE table;
// the native `grants` block resolves to the same shape; native wins on conflict.

const set = (...names: string[]) => new Set(names);
const grants = (g: Partial<Grants>): Grants => ({ actions: set(), channels: set(), repos: set(), ...g });
/** Every agent restricted, no command groups: the table with no "everyone" baseline. */
const NONE: LegacyVocabulary = { agentNames: [], commandGroups: [] };
const VOCAB: LegacyVocabulary = { agentNames: ["general", "coding", "review"], commandGroups: ["runs", "friction", "repo", "config"] };
const translate = (p: Parameters<typeof translateLegacyConfig>[0], tokens?: Parameters<typeof translateLegacyConfig>[1], svc?: Parameters<typeof translateLegacyConfig>[2], vocab = NONE) => translateLegacyConfig(p, tokens, svc, vocab);

describe("translateLegacyConfig — the KTD6 table, key by key", () => {
  it("permissions.admins → every action, every channel, every repo", () => {
    const { grants: t } = translate({ admins: ["slack:UADMIN"] });
    expect(t.get("slack:UADMIN")).toEqual(ALL_GRANTS);
    expect(ALL_GRANTS).toEqual({ actions: "all", channels: "all", repos: "all" });
  });

  it("permissions.operators → every <group>:read and <group>:write of every registered group (never :exec), over every channel (OQ1: fleet-wide today)", () => {
    const { grants: t } = translate({ operators: ["access:op-1"] }, undefined, undefined, VOCAB);
    expect(t.get("access:op-1")).toEqual(grants({ actions: set("runs:read", "runs:write", "friction:read", "friction:write", "repo:read", "repo:write", "config:read", "config:write"), channels: "all" }));
    expect([...(t.get("access:op-1")!.actions as Set<string>)].some((a) => a.endsWith(":exec"))).toBe(false);
    // No groups known → no actions (fail-closed), still fleet-wide.
    expect(translate({ operators: ["access:op-1"] }).grants.get("access:op-1")).toEqual(grants({ channels: "all" }));
  });

  it("permissions.repoManagement → repo:write + friction:write; ABSENT or empty → nothing (fail-closed, KTD9)", () => {
    const listed = translate({ repoManagement: ["slack:UMGR"] });
    expect(listed.grants.get("slack:UMGR")).toEqual(grants({ actions: set("repo:write", "friction:write") }));
    expect(translate({}).grants.size).toBe(0);
    expect(translate({ repoManagement: [] }).grants.size).toBe(0);
  });

  it("permissions.channelConfig → config:write; ABSENT → the gate is reported open, no grant is invented; empty → closed, no grant", () => {
    const listed = translate({ channelConfig: ["slack:UCFG"] });
    expect(listed.grants.get("slack:UCFG")).toEqual(grants({ actions: set("config:write") }));
    expect(listed.channelConfigOpen).toBe(false);
    const absent = translate({});
    expect(absent.channelConfigOpen).toBe(true);
    expect(absent.grants.size).toBe(0);
    const empty = translate({ channelConfig: [] });
    expect(empty.channelConfigOpen).toBe(false);
    expect(empty.grants.size).toBe(0);
  });

  it("the open-when-absent / fail-closed asymmetry: channelConfig absent = open flag, repoManagement absent = nothing at all", () => {
    const t = translate({ admins: ["slack:UADMIN"] });
    expect(t.channelConfigOpen).toBe(true);
    expect([...t.grants.keys()]).toEqual(["slack:UADMIN"]);
  });

  it("permissions.agents.<name>: [users] → agent:run:<name> for those users only", () => {
    const { grants: t, everyone } = translate({ agents: { coding: ["slack:UDEV"], review: ["slack:UDEV", "slack:UREV"] } }, undefined, undefined, VOCAB);
    // (repos absent → the coding user also gets every repo, see the KD7 case below)
    expect(t.get("slack:UDEV")).toEqual(grants({ actions: set("agent:run:coding", "agent:run:review"), repos: "all" }));
    expect(t.get("slack:UREV")).toEqual(grants({ actions: set("agent:run:review") }));
    // `general` has no allowlist → it is what everyone holds, not a per-user entry.
    expect(everyone).toEqual(grants({ actions: set("agent:run:general") }));
  });

  it("an agent with NO allowlist → agent:run:<name> for everyone (canRunAgent is true for anyone); every agent restricted → everyone holds nothing", () => {
    expect(translate({}, undefined, undefined, VOCAB).everyone).toEqual(grants({ actions: set("agent:run:general", "agent:run:coding", "agent:run:review") }));
    expect(translate({ agents: { general: [], coding: [], review: [] } }, undefined, undefined, VOCAB).everyone).toEqual(NO_GRANTS);
    expect(translate({}).everyone).toEqual(NO_GRANTS);
  });

  it("permissions.repos → repos per listed user (slugs as given — validateConfig lowercases them at load)", () => {
    const { grants: t, reposOpen } = translate({ repos: { "acme/api": ["slack:UDEV"], "acme/web": ["slack:UDEV", "slack:UWEB"] } });
    expect(reposOpen).toBe(false);
    expect(t.get("slack:UDEV")).toEqual(grants({ repos: set("acme/api", "acme/web") }));
    expect(t.get("slack:UWEB")).toEqual(grants({ repos: set("acme/web") }));
  });

  it("permissions.repos ABSENT → open-when-absent (KD7): every allowed coding-agent user gets every repo, and the open state is reported", () => {
    const t = translate({ agents: { coding: ["slack:UDEV"] } });
    expect(t.reposOpen).toBe(true);
    expect(t.grants.get("slack:UDEV")).toEqual(grants({ actions: set("agent:run:coding"), repos: "all" }));
  });

  it("ingress token scopes → actions of the same names, for BOTH the http: and the mcp: actor the token can become", () => {
    const { grants: t } = translate(undefined, { tok: { subject: "ci", scopes: ["dispatch", "runs:read"] } });
    expect(t.get("http:ci")).toEqual(grants({ actions: set("dispatch", "runs:read"), channels: "all" }));
    expect(t.get("mcp:ci")).toEqual(grants({ actions: set("dispatch", "runs:read"), channels: "all" }));
  });

  it("ingress token `channel` → the pinned channel in the actor's own namespace (http:<channel> / mcp:<channel>); no pin → every channel (PROVISIONAL: today's per-request machine-channel pin has no grants spelling — OQ4)", () => {
    const { grants: t } = translate(undefined, { tok: { subject: "alice", channel: "ops", scopes: ["dispatch"] } });
    expect(t.get("http:alice")?.channels).toEqual(set("http:ops"));
    expect(t.get("mcp:alice")?.channels).toEqual(set("mcp:ops"));
    const unpinned = translate(undefined, { tok: { subject: "alice", scopes: ["dispatch"] } });
    expect(unpinned.grants.get("http:alice")?.channels).toBe("all");
  });

  it("two tokens for one subject union their scopes and pins", () => {
    const { grants: t } = translate(undefined, { a: { subject: "ci", channel: "ops", scopes: ["dispatch"] }, b: { subject: "ci", channel: "dev", scopes: ["runs:read"] } });
    expect(t.get("http:ci")).toEqual(grants({ actions: set("dispatch", "runs:read"), channels: set("http:ops", "http:dev") }));
  });

  it("Access service tokens (common_name → scopes) → access:svc:<cn> with those actions over every channel; malformed scope lists yield nothing", () => {
    const { grants: t } = translate(undefined, undefined, { "reader-bot": ["runs:read"], "ops-bot": ["runs:read", "runs:write", "friction:read"] });
    expect(t.get("access:svc:reader-bot")).toEqual(grants({ actions: set("runs:read"), channels: "all" }));
    expect(t.get("access:svc:ops-bot")).toEqual(grants({ actions: set("runs:read", "runs:write", "friction:read"), channels: "all" }));
    const bad = translate(undefined, undefined, { junk: 42 as unknown as string[] });
    expect(bad.grants.has("access:svc:junk")).toBe(false);
  });

  it("an actor named by several keys gets the UNION of its grants; `all` absorbs a list", () => {
    const { grants: t } = translate({ repoManagement: ["slack:U1"], channelConfig: ["slack:U1"], agents: { coding: ["slack:U1"] }, repos: { "acme/api": ["slack:U1"] } });
    expect(t.get("slack:U1")).toEqual(grants({ actions: set("repo:write", "friction:write", "config:write", "agent:run:coding"), repos: set("acme/api") }));
    const admin = translate({ admins: ["slack:U1"], repoManagement: ["slack:U1"] });
    expect(admin.grants.get("slack:U1")).toEqual(ALL_GRANTS);
  });

  it("nothing configured → an empty table, nothing for everyone, the channelConfig gate open and repos open", () => {
    expect(translate(undefined)).toEqual({ grants: new Map(), everyone: NO_GRANTS, channelConfigOpen: true, reposOpen: true });
  });
});

describe("parseGrantsConfig — the native `grants` block", () => {
  it("absent field = empty set (fail-closed, R7); \"all\" is explicit", () => {
    const parsed = parseGrantsConfig({ "slack:U1": { actions: ["runs:read"] }, "http:ci": { actions: "all", channels: ["http:ops"] } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.grants.get("slack:U1")).toEqual(grants({ actions: set("runs:read") }));
    expect(parsed.grants.get("http:ci")).toEqual(grants({ actions: "all", channels: set("http:ops") }));
  });

  it("an unknown actor id prefix is an error naming the id", () => {
    const parsed = parseGrantsConfig({ "discord:123": { actions: "all" }, U0123: {} });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([expect.stringContaining('grants["discord:123"]'), expect.stringContaining('grants["U0123"]')]);
    expect(parsed.errors[0]).toMatch(/slack:|http:|mcp:|access:|schedule:/);
  });

  it("a misspelled \"all\" (or any bare string) is an error naming the id and the field", () => {
    const parsed = parseGrantsConfig({ "slack:U1": { actions: "ALL" }, "slack:U2": { channels: "*" } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([expect.stringMatching(/grants\["slack:U1"\]\.actions.*"all"/), expect.stringMatching(/grants\["slack:U2"\]\.channels.*"all"/)]);
  });

  it("an unknown field (the removed `agents` axis included), a non-mapping block, and an empty name are errors", () => {
    expect(parseGrantsConfig({ "slack:U1": { agents: ["coding"] } })).toMatchObject({ ok: false, errors: [expect.stringContaining('grants["slack:U1"]: unknown field agents')] });
    expect(parseGrantsConfig([])).toMatchObject({ ok: false, errors: [expect.stringContaining("mapping")] });
    expect(parseGrantsConfig({ "slack:U1": { actions: [""] } })).toMatchObject({ ok: false });
  });
});

describe("mergeGrants — native wins, and the overlap is reported", () => {
  it("an id in both shapes takes the native grants; the id is returned so validateConfig can warn", () => {
    const native = new Map([["slack:U1", grants({ actions: set("runs:read") })]]);
    const legacy = new Map([
      ["slack:U1", ALL_GRANTS],
      ["slack:U2", grants({ actions: set("config:write") })],
    ]);
    const merged = mergeGrants(native, legacy);
    expect(merged.overlapping).toEqual(["slack:U1"]);
    expect(merged.grants.get("slack:U1")).toEqual(grants({ actions: set("runs:read") }));
    expect(merged.grants.get("slack:U2")).toEqual(grants({ actions: set("config:write") }));
  });

  it("no overlap → both tables side by side, nothing reported", () => {
    const merged = mergeGrants(new Map([["slack:U1", ALL_GRANTS]]), new Map([["slack:U2", ALL_GRANTS]]));
    expect(merged.overlapping).toEqual([]);
    expect([...merged.grants.keys()].sort()).toEqual(["slack:U1", "slack:U2"]);
  });
});

describe("the native/legacy DIFFERENTIAL — one deployment written both ways resolves to identical Grants for every actor", () => {
  const legacy = {
    permissions: {
      admins: ["slack:UADMIN"],
      operators: ["access:op-1"],
      repoManagement: ["slack:UMGR"],
      channelConfig: ["slack:UCFG"],
      agents: { coding: ["slack:UDEV"], review: [] },
      repos: { "acme/api": ["slack:UDEV"] },
      serviceTokens: { "reader-bot": ["runs:read"] },
    },
    ingressTokens: { tok: { subject: "ci", channel: "ops", scopes: ["dispatch", "runs:read"] } },
    agentNames: ["general", "coding", "review"],
    commandGroups: ["runs", "friction"],
  };
  // `general` is unrestricted, so every legacy `slack:` user holds agent:run:general — the native block must say so per user; credentials and jobs do not inherit it.
  const native: GrantsConfig = {
    "slack:UADMIN": { actions: "all", channels: "all", repos: "all" },
    "access:op-1": { actions: ["runs:read", "runs:write", "friction:read", "friction:write"], channels: "all" },
    "slack:UMGR": { actions: ["repo:write", "friction:write", "agent:run:general"] },
    "slack:UCFG": { actions: ["config:write", "agent:run:general"] },
    "slack:UDEV": { actions: ["agent:run:coding", "agent:run:general"], repos: ["acme/api"] },
    "access:svc:reader-bot": { actions: ["runs:read"], channels: "all" },
    "http:ci": { actions: ["dispatch", "runs:read"], channels: ["http:ops"] },
    "mcp:ci": { actions: ["dispatch", "runs:read"], channels: ["mcp:ops"] },
  };

  it("grantsFor agrees actor by actor", () => {
    const parsed = parseGrantsConfig(native);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fromLegacy = grantsTable(legacy).grants;
    expect([...parsed.grants.keys()].sort()).toEqual([...fromLegacy.keys()].sort());
    for (const id of parsed.grants.keys()) expect(grantsFor(id, { grants: parsed.grants }), id).toEqual(grantsFor(id, legacy));
  });

  it("an actor neither shape names: an unlisted slack: user gets what everyone holds (the unrestricted agents); the native block, being explicit, gives nothing", () => {
    expect(grantsFor("slack:UNOBODY", legacy)).toEqual(grants({ actions: set("agent:run:general") }));
    expect(grantsFor("slack:UNOBODY", { grants: new Map() })).toBe(NO_GRANTS);
    expect(grantsFor("slack:UNOBODY", { ...legacy, permissions: { ...legacy.permissions, agents: { general: [], coding: [], review: [] } } })).toBe(NO_GRANTS);
  });

  it("the everyone baseline is for slack: users only — an unlisted schedule, Access identity, service token, or ingress subject is NO_GRANTS (fail-closed)", () => {
    for (const id of ["schedule:x", "access:svc:x", "access:stranger", "http:stranger", "mcp:stranger"]) expect(grantsFor(id, legacy), id).toBe(NO_GRANTS);
    // …and a listed credential does not have it unioned in either.
    expect(grantsFor("http:ci", legacy).actions).toEqual(set("dispatch", "runs:read"));
    expect(grantsFor("slack:UMGR", legacy).actions).toEqual(set("repo:write", "friction:write", "agent:run:general"));
  });
});

describe("grantsTable / grantsIn / grantsFor — the merged lookup", () => {
  it("native wins for an id both shapes name and the id is reported; an absent actor is NO_GRANTS", () => {
    const parsed = parseGrantsConfig({ "slack:UADMIN": { actions: ["runs:read"] } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const source = { grants: parsed.grants, permissions: { admins: ["slack:UADMIN"], repoManagement: ["slack:UMGR"] } };
    const table = grantsTable(source);
    expect(table.overlapping).toEqual(["slack:UADMIN"]);
    expect(grantsIn(table, "slack:UADMIN")).toEqual(grants({ actions: set("runs:read") }));
    expect(grantsFor("slack:UMGR", source)).toEqual(grants({ actions: set("repo:write", "friction:write") }));
    expect(grantsFor("slack:UNKNOWN", source)).toBe(NO_GRANTS);
    expect(grantsFor("slack:UNKNOWN", {})).toBe(NO_GRANTS);
  });

  it("a schedule actor's grants come from the native block only (no legacy key names schedules)", () => {
    const parsed = parseGrantsConfig({ "schedule:self-improvement": { actions: ["friction:write"], channels: "all" } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(grantsFor("schedule:self-improvement", { grants: parsed.grants })).toEqual(grants({ actions: set("friction:write"), channels: "all" }));
    expect(grantsFor("schedule:self-improvement", { permissions: { admins: ["slack:U1"] } })).toBe(NO_GRANTS);
  });
});
