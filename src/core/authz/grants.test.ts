import { describe, expect, it } from "vitest";
import { ALL_GRANTS, browserReadActions, CHAT_OPEN_ACTIONS, grantsFor, grantsIn, grantsTable, legacyBaseline, mergeGrants, parseGrantsConfig, translateLegacyConfig, type GrantsConfig, type LegacyVocabulary } from "./grants.js";
import { NO_GRANTS, type Grants } from "./types.js";

// Feature: docs/plans/2026-09-03-001-feat-authorization-model-plan.md — U2 (R7, R8, KTD6),
// U4 (KTD5: the `open` chat gate and a browser session's implicit reads are
// translation baselines). The legacy `permissions.*` / token keys translate to
// `Grants` by ONE table; the native `grants` block resolves to the same shape;
// native wins on conflict.

const set = (...names: string[]) => new Set(names);
const grants = (g: Partial<Grants>): Grants => ({ actions: set(), channels: set(), repos: set(), ...g });
/** What every Slack user holds with no `channelConfig` key: the open chat commands + `config:write`. */
const OPEN = [...CHAT_OPEN_ACTIONS, "config:write"];
/** Every agent restricted, no command groups: the table with no agent in the "everyone" baseline. */
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

  it("permissions.channelConfig → config:write for the listed; ABSENT → every Slack user holds config:write (open-when-absent); present and empty → nobody but admins", () => {
    const listed = translate({ channelConfig: ["slack:UCFG"] });
    expect(listed.grants.get("slack:UCFG")).toEqual(grants({ actions: set("config:write") }));
    expect(listed.everyone.actions).not.toContain("config:write");
    const absent = translate({});
    expect(absent.everyone.actions).toContain("config:write");
    expect(absent.grants.size).toBe(0);
    const empty = translate({ channelConfig: [] });
    expect(empty.everyone.actions).not.toContain("config:write");
    expect(empty.grants.size).toBe(0);
  });

  it("the `open` chat gate → CHAT_OPEN_ACTIONS for everyone: the reads every Slack user had, plus memory:write and mcp:write; never runs, deploy, env, repo:write, friction:write, or an exec", () => {
    const { everyone } = translate({ channelConfig: [] });
    expect(everyone).toEqual(grants({ actions: set(...CHAT_OPEN_ACTIONS) }));
    expect(CHAT_OPEN_ACTIONS).toEqual(["help:read", "config:read", "repo:read", "friction:read", "memory:read", "mcp:read", "schedule:read", "memory:write", "mcp:write"]);
    for (const closed of ["runs:read", "runs:write", "deploy:read", "deploy:write", "env:write", "repo:write", "repo:exec", "friction:write"]) expect(everyone.actions, closed).not.toContain(closed);
  });

  it("the open-when-absent / fail-closed asymmetry: channelConfig absent = config:write for everyone, repoManagement absent = nothing at all", () => {
    const t = translate({ admins: ["slack:UADMIN"] });
    expect(t.everyone.actions).toContain("config:write");
    expect(t.everyone.actions).not.toContain("repo:write");
    expect([...t.grants.keys()]).toEqual(["slack:UADMIN"]);
  });

  it("permissions.agents.<name>: [users] → agent:run:<name> for those users only", () => {
    const { grants: t, everyone } = translate({ agents: { coding: ["slack:UDEV"], review: ["slack:UDEV", "slack:UREV"] } }, undefined, undefined, VOCAB);
    // (repos absent → the coding user also gets every repo, see the KD7 case below)
    expect(t.get("slack:UDEV")).toEqual(grants({ actions: set("agent:run:coding", "agent:run:review"), repos: "all" }));
    expect(t.get("slack:UREV")).toEqual(grants({ actions: set("agent:run:review") }));
    // `general` has no allowlist → it is what everyone holds (with the open commands), not a per-user entry.
    expect(everyone).toEqual(grants({ actions: set(...OPEN, "agent:run:general") }));
  });

  it("an agent with NO allowlist → agent:run:<name> for everyone (canRunAgent is true for anyone); every agent restricted → everyone holds the open commands only", () => {
    expect(translate({}, undefined, undefined, VOCAB).everyone).toEqual(grants({ actions: set(...OPEN, "agent:run:general", "agent:run:coding", "agent:run:review") }));
    expect(translate({ agents: { general: [], coding: [], review: [] } }, undefined, undefined, VOCAB).everyone).toEqual(grants({ actions: set(...OPEN) }));
    expect(translate({}).everyone).toEqual(grants({ actions: set(...OPEN) }));
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
    expect(t.get("http:ci")).toEqual(grants({ actions: set("dispatch", "runs:read") }));
    expect(t.get("mcp:ci")).toEqual(grants({ actions: set("dispatch", "runs:read") }));
  });

  it("ingress token `channel` → the pinned channel in the actor's own namespace (http:<channel> / mcp:<channel>); no `channel` → NO channels (OQ4 a, fail-closed: an unpinned token sees no run until config grants it channels)", () => {
    const { grants: t } = translate(undefined, { tok: { subject: "alice", channel: "ops", scopes: ["dispatch"] } });
    expect(t.get("http:alice")?.channels).toEqual(set("http:ops"));
    expect(t.get("mcp:alice")?.channels).toEqual(set("mcp:ops"));
    const unpinned = translate(undefined, { tok: { subject: "alice", scopes: ["dispatch"] } });
    expect(unpinned.grants.get("http:alice")?.channels).toEqual(set());
    expect(unpinned.grants.get("mcp:alice")?.channels).toEqual(set());
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

  it("no `permissions` block at all → an empty table, the open baseline WITHOUT config:write (no legacy block, no open-when-absent rule), repos open; an EMPTY block still opens it", () => {
    expect(translate(undefined)).toEqual({ grants: new Map(), everyone: grants({ actions: set(...CHAT_OPEN_ACTIONS) }), reposOpen: true, fromPermissions: new Set() });
    expect(translate({}).everyone).toEqual(grants({ actions: set(...OPEN) }));
  });

  it("fromPermissions names the ids the `permissions.*` keys (serviceTokens included) grant — never an ingress token's, whose entry is its credential", () => {
    const t = translate({ admins: ["slack:UADMIN"], repoManagement: ["http:cron"] }, { tok: { subject: "ci", scopes: ["dispatch"] } }, { "reader-bot": ["runs:read"] });
    expect([...t.fromPermissions].sort()).toEqual(["access:svc:reader-bot", "http:cron", "slack:UADMIN"]);
    expect(t.grants.has("http:ci")).toBe(true);
  });
});

describe("the legacy baselines — what an id inherits by its namespace (KTD5/KTD6/KTD10)", () => {
  const table = { everyone: grants({ actions: set(...OPEN) }), browserReads: grants({ actions: browserReadActions(["runs", "friction"]) }) };

  it("slack: → everyone; access:<sub> → every group's read; access:svc:, http:, mcp:, schedule: → nothing", () => {
    expect(legacyBaseline("slack:U1", table)).toBe(table.everyone);
    expect(legacyBaseline("access:alice", table)).toBe(table.browserReads);
    for (const id of ["access:svc:ci", "http:ci", "mcp:ci", "schedule:x", "cli:local"]) expect(legacyBaseline(id, table), id).toBe(NO_GRANTS);
  });

  it("browserReadActions is every `<group>:read`, never a write or an exec; no groups → nothing", () => {
    expect(browserReadActions(["runs", "repo"])).toEqual(set("runs:read", "repo:read"));
    expect(browserReadActions([])).toEqual(set());
  });

  it("a legacy-listed Access identity has its reads unioned in; an unlisted one holds the reads alone; a service token never inherits them", () => {
    const source = { permissions: { repoManagement: ["access:bob"], serviceTokens: { bot: ["runs:write"] } }, commandGroups: ["runs", "repo"] };
    expect(grantsFor("access:bob", source)).toEqual(grants({ actions: set("repo:write", "friction:write", "runs:read", "repo:read") }));
    expect(grantsFor("access:stranger", source)).toEqual(grants({ actions: set("runs:read", "repo:read") }));
    expect(grantsFor("access:svc:bot", source)).toEqual(grants({ actions: set("runs:write"), channels: "all" }));
    expect(grantsFor("access:svc:stranger", source)).toBe(NO_GRANTS);
    // No command groups known → a browser session holds nothing (fail-closed).
    expect(grantsFor("access:stranger", {})).toBe(NO_GRANTS);
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
  // Every legacy `slack:` user holds the open chat commands and, `general` being unrestricted, agent:run:general — the native block must say so per user; credentials and jobs do not inherit it. `channelConfig` is present, so `config:write` is per-user.
  const native: GrantsConfig = {
    "slack:UADMIN": { actions: "all", channels: "all", repos: "all" },
    "access:op-1": { actions: ["runs:read", "runs:write", "friction:read", "friction:write"], channels: "all" },
    "slack:UMGR": { actions: [...CHAT_OPEN_ACTIONS, "repo:write", "friction:write", "agent:run:general"] },
    "slack:UCFG": { actions: [...CHAT_OPEN_ACTIONS, "config:write", "agent:run:general"] },
    "slack:UDEV": { actions: [...CHAT_OPEN_ACTIONS, "agent:run:coding", "agent:run:general"], repos: ["acme/api"] },
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

  it("an actor neither shape names: an unlisted slack: user gets what everyone holds (the open commands, the unrestricted agents); a native-only deployment, being explicit, adds nothing — not even config:write", () => {
    expect(grantsFor("slack:UNOBODY", legacy)).toEqual(grants({ actions: set(...CHAT_OPEN_ACTIONS, "agent:run:general") }));
    expect(grantsFor("slack:UNOBODY", { grants: new Map() })).toEqual(grants({ actions: set(...CHAT_OPEN_ACTIONS) }));
    expect(grantsFor("slack:UNOBODY", { ...legacy, permissions: { ...legacy.permissions, agents: { general: [], coding: [], review: [] } } })).toEqual(grants({ actions: set(...CHAT_OPEN_ACTIONS) }));
  });

  it("the everyone baseline is for slack: users; a browser session inherits the reads; an unlisted schedule, service token, or ingress subject is NO_GRANTS (fail-closed)", () => {
    for (const id of ["schedule:x", "access:svc:x", "http:stranger", "mcp:stranger"]) expect(grantsFor(id, legacy), id).toBe(NO_GRANTS);
    expect(grantsFor("access:stranger", legacy)).toEqual(grants({ actions: set("runs:read", "friction:read") }));
    // …and a listed credential does not have a baseline unioned in either.
    expect(grantsFor("http:ci", legacy).actions).toEqual(set("dispatch", "runs:read"));
    expect(grantsFor("slack:UMGR", legacy).actions).toEqual(set(...CHAT_OPEN_ACTIONS, "repo:write", "friction:write", "agent:run:general"));
  });
});

describe("grantsTable / grantsIn / grantsFor — the merged lookup", () => {
  it("native wins for an id both shapes name and the id is reported; an unlisted slack: user holds the baseline, an unlisted credential nothing", () => {
    const parsed = parseGrantsConfig({ "slack:UADMIN": { actions: ["runs:read"] } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const source = { grants: parsed.grants, permissions: { admins: ["slack:UADMIN"], repoManagement: ["slack:UMGR"] } };
    const table = grantsTable(source);
    expect(table.overlapping).toEqual(["slack:UADMIN"]);
    expect(grantsIn(table, "slack:UADMIN")).toEqual(grants({ actions: set("runs:read") }));
    expect(grantsFor("slack:UMGR", source)).toEqual(grants({ actions: set(...OPEN, "repo:write", "friction:write") }));
    expect(grantsFor("slack:UNKNOWN", source)).toEqual(grants({ actions: set(...OPEN) }));
    expect(grantsFor("mcp:unknown", source)).toBe(NO_GRANTS);
  });

  it("the overlap reported is what config can delete: a serviceTokens entry beside a native one is; an ingress token's id beside its native entry (#453) is not, though native still wins", () => {
    const parsed = parseGrantsConfig({ "http:ci": { actions: ["dispatch", "runs:read"], channels: "all" }, "access:svc:ops": { actions: ["runs:read"], channels: "all" } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const table = grantsTable({ grants: parsed.grants, ingressTokens: { tok: { subject: "ci", channel: "ops", scopes: ["dispatch"] } }, permissions: { serviceTokens: { ops: ["runs:read", "runs:write"] } } });
    expect(table.overlapping).toEqual(["access:svc:ops"]);
    expect(grantsIn(table, "http:ci")).toEqual(grants({ actions: set("dispatch", "runs:read"), channels: "all" }));
    expect(grantsIn(table, "mcp:ci")).toEqual(grants({ actions: set("dispatch"), channels: set("mcp:ops") })); // the token's own translation, no native entry
    expect(grantsIn(table, "access:svc:ops")).toEqual(grants({ actions: set("runs:read"), channels: "all" }));
  });

  it("a schedule actor's grants are the registry's declared ones (R9) unless the native block names the id — then config wins, without an overlap warning; no legacy key names schedules", () => {
    const declared = grants({ actions: set("friction:read", "friction:write"), channels: "all" });
    const schedules = [{ id: "schedule:self-improvement", grants: declared }];
    expect(grantsFor("schedule:self-improvement", { schedules })).toEqual(declared);
    expect(grantsFor("schedule:self-improvement", { schedules, permissions: { admins: ["slack:U1"], repoManagement: ["http:cron"] } })).toEqual(declared);
    // A legacy key naming the schedule (the chat gate needs `repoManagement` until U4) ADDS to the declared floor, never narrows it.
    expect(grantsFor("schedule:self-improvement", { schedules, permissions: { repoManagement: ["schedule:self-improvement"] } })).toEqual(grants({ actions: set("friction:read", "friction:write", "repo:write"), channels: "all" }));
    const parsed = parseGrantsConfig({ "schedule:self-improvement": { actions: ["friction:write"], channels: ["slack:C1"] } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const table = grantsTable({ grants: parsed.grants, schedules });
    expect(grantsIn(table, "schedule:self-improvement")).toEqual(grants({ actions: set("friction:write"), channels: set("slack:C1") }));
    expect(table.overlapping).toEqual([]);
    expect(grantsFor("schedule:self-improvement", { permissions: { admins: ["slack:U1"] } })).toBe(NO_GRANTS);
    expect(grantsFor("schedule:other", { schedules })).toBe(NO_GRANTS);
  });
});
