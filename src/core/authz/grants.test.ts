import { describe, expect, it } from "vitest";
import {
  ALL_GRANTS,
  browserReadActions,
  CHAT_OPEN_ACTIONS,
  covers,
  grantsFor,
  grantsIn,
  grantsTable,
  mayRunAgent,
  mayUseRepo,
  namespaceBaseline,
  NO_RESTRICTION,
  parseGrantsConfig,
  parseRestrictConfig,
  type GrantsConfig,
  type Restriction,
} from "./grants.js";
import { NO_GRANTS, type Grants } from "./types.js";

// Feature: features/authorization.md item 9 — one authorization shape: the
// native `grants` block (what an actor holds) and `restrict` (which agents and
// repos are closed unless granted). Baselines are what a namespace holds
// unlisted: a Slack user the open chat commands and every unrestricted agent, a
// browser session every group's read; a credential holds exactly its entry.

const set = (...names: string[]) => new Set(names);
const grants = (g: Partial<Grants>): Grants => ({ actions: set(), channels: set(), repos: set(), ...g });
const AGENTS = ["general", "coding", "review"];
const parsed = (raw: GrantsConfig) => {
  const p = parseGrantsConfig(raw);
  if (!p.ok) throw new Error(p.errors.join("; "));
  return p.grants;
};
const restriction = (r: { agents?: string[]; repos?: string[] }): Restriction => {
  const p = parseRestrictConfig(r, AGENTS);
  if (!p.ok) throw new Error(p.errors.join("; "));
  return p.restrict;
};

describe("parseGrantsConfig — the native `grants` block", () => {
  it('absent field = empty set (fail-closed, R7); "all" is explicit', () => {
    const parsed = parseGrantsConfig({
      "slack:UALICE": { actions: ["runs:read"] },
      "http:ci": { actions: "all", channels: ["http:ops"] },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.grants.get("slack:UALICE")).toEqual(grants({ actions: set("runs:read") }));
    expect(parsed.grants.get("http:ci")).toEqual(grants({ actions: "all", channels: set("http:ops") }));
  });

  it("an unknown actor id prefix is an error naming the id", () => {
    const parsed = parseGrantsConfig({ "discord:123": { actions: "all" }, U0123: {} });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      expect.stringContaining('grants["discord:123"]'),
      expect.stringContaining('grants["U0123"]'),
    ]);
    expect(parsed.errors[0]).toMatch(/slack:|http:|mcp:|access:|schedule:/);
  });

  it('a misspelled "all" (or any bare string) is an error naming the id and the field', () => {
    const parsed = parseGrantsConfig({ "slack:UALICE": { actions: "ALL" }, "slack:UBOB": { channels: "*" } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      expect.stringMatching(/grants\["slack:UALICE"\]\.actions.*"all"/),
      expect.stringMatching(/grants\["slack:UBOB"\]\.channels.*"all"/),
    ]);
  });

  it("an unknown field (the removed `agents` axis included), a non-mapping block, and an empty name are errors", () => {
    expect(parseGrantsConfig({ "slack:UALICE": { agents: ["coding"] } })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('grants["slack:UALICE"]: unknown field agents')],
    });
    expect(parseGrantsConfig([])).toMatchObject({ ok: false, errors: [expect.stringContaining("mapping")] });
    expect(parseGrantsConfig({ "slack:UALICE": { actions: [""] } })).toMatchObject({ ok: false });
  });
});

describe("parseRestrictConfig — what is closed unless granted", () => {
  it("absent → nothing restricted; agents and repos parse, repos lowercased (slugs are case-insensitive on GitHub)", () => {
    expect(parseRestrictConfig(undefined, AGENTS)).toEqual({ ok: true, restrict: NO_RESTRICTION });
    const p = parseRestrictConfig({ agents: ["coding"], repos: ["Acme/API", "acme/web"] }, AGENTS);
    expect(p).toEqual({ ok: true, restrict: { agents: set("coding"), repos: set("acme/api", "acme/web") } });
  });

  it("an unregistered agent is an error naming it and the registry (a typo must not restrict nothing, silently)", () => {
    const p = parseRestrictConfig({ agents: ["codng"] }, AGENTS);
    expect(p).toEqual({
      ok: false,
      errors: ['restrict.agents: "codng" is not a registered agent (general, coding, review)'],
    });
  });

  it("a repo that is not an owner/name slug, an unknown field, and a non-list are errors naming the field", () => {
    expect(parseRestrictConfig({ repos: ["not a slug"] }, AGENTS)).toEqual({
      ok: false,
      errors: ['restrict.repos: "not a slug" is not an owner/name slug'],
    });
    expect(parseRestrictConfig({ channels: ["x"] }, AGENTS)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("restrict: unknown field channels")],
    });
    expect(parseRestrictConfig({ agents: "coding" }, AGENTS)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("restrict.agents: expected a list")],
    });
  });
});

describe("the baselines — what an id holds by its namespace, listed or not (KTD5/KTD10)", () => {
  const table = {
    everyone: grants({ actions: set(...CHAT_OPEN_ACTIONS) }),
    browserReads: grants({ actions: browserReadActions(["runs", "friction"]) }),
  };

  it("slack: → everyone; access:<sub> → every group's read; access:svc:, http:, mcp:, schedule:, cli: → nothing", () => {
    expect(namespaceBaseline("slack:UALICE", table)).toBe(table.everyone);
    expect(namespaceBaseline("access:alice", table)).toBe(table.browserReads);
    for (const id of ["access:svc:ci", "http:ci", "mcp:ci", "schedule:x", "cli:local"])
      expect(namespaceBaseline(id, table), id).toBe(NO_GRANTS);
  });

  it("browserReadActions is every `<group>:read`, never a write or an exec; no groups → nothing", () => {
    expect(browserReadActions(["runs", "repo"])).toEqual(set("runs:read", "repo:read"));
    expect(browserReadActions([])).toEqual(set());
  });

  it("everyone = the open chat commands + agent:run for every UNRESTRICTED agent; config:write is never a baseline", () => {
    const open = grantsTable({ agentNames: AGENTS });
    expect(open.everyone).toEqual(
      grants({ actions: set(...CHAT_OPEN_ACTIONS, "agent:run:general", "agent:run:coding", "agent:run:review") }),
    );
    expect(open.everyone.actions).not.toContain("config:write");
    const locked = grantsTable({ agentNames: AGENTS, restrict: restriction({ agents: ["coding"] }) });
    expect(locked.everyone.actions).toContain("agent:run:general");
    expect(locked.everyone.actions).not.toContain("agent:run:coding");
    // No agents registered → no agent is open to everyone.
    expect(grantsTable({}).everyone).toEqual(grants({ actions: set(...CHAT_OPEN_ACTIONS) }));
  });
});

describe("grantsTable / grantsIn / grantsFor — the lookup", () => {
  it("a slack: entry ADDS to the everyone baseline (a grant never takes the open commands away); a browser entry adds to its reads; a credential holds exactly its entry; an unlisted credential NO_GRANTS", () => {
    const source = {
      grants: parsed({
        "slack:UMGR": { actions: ["repo:write"] },
        "access:bob": { actions: ["runs:write"], channels: ["slack:G1"] },
        "access:svc:ops": { actions: ["runs:read"], channels: "all" },
        "http:ci": { actions: ["dispatch"] },
      }),
      agentNames: ["general"],
      commandGroups: ["runs", "repo"],
    };
    expect(grantsFor("slack:UMGR", source)).toEqual(
      grants({ actions: set(...CHAT_OPEN_ACTIONS, "agent:run:general", "repo:write") }),
    );
    expect(grantsFor("slack:UNKNOWN", source)).toEqual(
      grants({ actions: set(...CHAT_OPEN_ACTIONS, "agent:run:general") }),
    );
    expect(grantsFor("access:bob", source)).toEqual(
      grants({ actions: set("runs:write", "runs:read", "repo:read"), channels: set("slack:G1") }),
    );
    expect(grantsFor("access:stranger", source)).toEqual(grants({ actions: set("runs:read", "repo:read") }));
    expect(grantsFor("access:svc:ops", source)).toEqual(grants({ actions: set("runs:read"), channels: "all" }));
    expect(grantsFor("http:ci", source)).toEqual(grants({ actions: set("dispatch") }));
    for (const id of ["http:stranger", "mcp:ci", "access:svc:stranger", "schedule:x"])
      expect(grantsFor(id, source), id).toBe(NO_GRANTS);
    // No command groups known → a browser session holds nothing (fail-closed).
    expect(grantsFor("access:stranger", {})).toBe(NO_GRANTS);
  });

  it("`all` on an axis absorbs the baseline; an admin entry resolves to ALL_GRANTS", () => {
    const source = {
      grants: parsed({ "slack:UADMIN": { actions: "all", channels: "all", repos: "all" } }),
      agentNames: AGENTS,
    };
    expect(grantsFor("slack:UADMIN", source)).toEqual(ALL_GRANTS);
  });

  it("a schedule actor's grants are the registry's declared ones (R9) unless the native block names the id — then config wins whole", () => {
    const declared = grants({ actions: set("friction:read", "friction:write"), channels: "all" });
    const schedules = [{ id: "schedule:self-improvement", grants: declared }];
    expect(grantsFor("schedule:self-improvement", { schedules })).toEqual(declared);
    const table = grantsTable({
      grants: parsed({ "schedule:self-improvement": { actions: ["friction:write"], channels: ["slack:C1"] } }),
      schedules,
    });
    expect(grantsIn(table, "schedule:self-improvement")).toEqual(
      grants({ actions: set("friction:write"), channels: set("slack:C1") }),
    );
    expect(grantsFor("schedule:other", { schedules })).toBe(NO_GRANTS);
  });
});

describe("mayRunAgent / mayUseRepo — open unless restricted, then only for a holder", () => {
  const table = { restrict: restriction({ agents: ["coding"], repos: ["Acme/API"] }) };

  it("an unrestricted agent runs for anyone, a restricted one only for a holder of agent:run:<name>, the agent:run:* wildcard, or `all`", () => {
    expect(mayRunAgent(table, NO_GRANTS, "general")).toBe(true);
    expect(mayRunAgent(table, NO_GRANTS, "coding")).toBe(false);
    expect(mayRunAgent(table, grants({ actions: set("agent:run:coding") }), "coding")).toBe(true);
    // The `agent:run:*` wildcard the policy table honours unlocks a restricted agent here too; another agent's grant does not.
    expect(mayRunAgent(table, grants({ actions: set("agent:run:*") }), "coding")).toBe(true);
    expect(mayRunAgent(table, grants({ actions: set("agent:run:general") }), "coding")).toBe(false);
    expect(mayRunAgent(table, ALL_GRANTS, "coding")).toBe(true);
    expect(mayRunAgent({ restrict: NO_RESTRICTION }, NO_GRANTS, "coding")).toBe(true);
  });

  it("an unrestricted repo is open to anyone, a restricted one only for a holder whose repos name it (case-insensitively) or `all`", () => {
    expect(mayUseRepo(table, NO_GRANTS, "acme/other")).toBe(true);
    expect(mayUseRepo(table, NO_GRANTS, "acme/api")).toBe(false);
    expect(mayUseRepo(table, NO_GRANTS, "Acme/API")).toBe(false);
    expect(mayUseRepo(table, grants({ repos: set("acme/api") }), "ACME/api")).toBe(true);
    expect(mayUseRepo(table, grants({ repos: set("Acme/API") }), "acme/api")).toBe(true);
    expect(mayUseRepo(table, ALL_GRANTS, "acme/api")).toBe(true);
  });

  it("covers: `all` or the name itself", () => {
    expect(covers("all", "anything")).toBe(true);
    expect(covers(set("a"), "a")).toBe(true);
    expect(covers(set("a"), "b")).toBe(false);
  });
});
