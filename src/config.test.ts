import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ConfigStore,
  FileOverridesBacking,
  InMemoryOverridesBacking,
  MAX_INSTRUCTIONS_LENGTH,
  openConfigStore,
  OverridesConflictError,
  overridesBackingFor,
  WorkerOverridesBacking,
  type AppConfig,
  type ConfigStoreOptions,
  type Overrides,
} from "./config.js";
import { hasAction } from "./core/authz/authorize.js";
import { ALL_GRANTS } from "./core/authz/grants.js";
import { NO_GRANTS } from "./core/authz/types.js";
import { resolveShipCaps, SHIP_DEFAULT_MAX_MINUTES, SHIP_DEFAULT_MAX_ROUNDS } from "./core/shipPipeline.js";

// Feature: features/routing-and-config.md — layered resolution & permission gates.

const YAML_FIXTURE = `
providers:
  anthropic:
    type: anthropic
    apiKeyEnv: ANTHROPIC_API_KEY
defaults:
  agent: general
  models:
    general: anthropic/general-model
    review: anthropic/review-model
    coding: anthropic/coding-model
channels:
  "slack:CREVIEW":
    agent: review
  "slack:CMODEL":
    models:
      review: anthropic/channel-review-model
users:
  "slack:UFORCED":
    model: anthropic/user-forced-model
  "slack:UPERAGENT":
    models:
      review: anthropic/user-review-model
permissions:
  admins: ["slack:UADMIN"]
  agents:
    coding: ["slack:UDEV"]
  channelConfig: []
`;

function store(yaml: string = YAML_FIXTURE): ConfigStore {
  const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, yaml);
  return new ConfigStore(cfg, join(dir, "overrides.json"));
}

describe("layered resolution", () => {
  let s: ConfigStore;
  beforeEach(() => {
    s = store();
  });

  it("falls through to defaults when nothing is scoped", async () => {
    const r = s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} });
    expect(r).toEqual({ agentName: "general", modelRef: "anthropic/general-model" });
  });

  it("channel scope sets the agent, and the agent picks its default model", async () => {
    const r = s.resolve({ channelId: "slack:CREVIEW", userId: "slack:UX", request: {} });
    expect(r).toEqual({ agentName: "review", modelRef: "anthropic/review-model" });
  });

  it("request directives beat every other layer", async () => {
    const r = s.resolve({
      channelId: "slack:CREVIEW",
      userId: "slack:UFORCED",
      request: { agent: "coding", model: "anthropic/explicit" },
    });
    expect(r).toEqual({ agentName: "coding", modelRef: "anthropic/explicit" });
  });

  it("a user's forced model beats per-agent models", async () => {
    const r = s.resolve({ channelId: "slack:CREVIEW", userId: "slack:UFORCED", request: {} });
    expect(r.modelRef).toBe("anthropic/user-forced-model");
  });

  it("per-agent model precedence: user scope > channel scope > defaults", async () => {
    const user = s.resolve({ channelId: "slack:CMODEL", userId: "slack:UPERAGENT", request: { agent: "review" } });
    expect(user.modelRef).toBe("anthropic/user-review-model");
    const channel = s.resolve({ channelId: "slack:CMODEL", userId: "slack:UX", request: { agent: "review" } });
    expect(channel.modelRef).toBe("anthropic/channel-review-model");
    const dflt = s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: { agent: "review" } });
    expect(dflt.modelRef).toBe("anthropic/review-model");
  });

  it("runtime overrides win over static config for the same scope and persist through the store", async () => {
    await s.setChannelOverride("slack:CREVIEW", { agent: "coding" });
    const r = s.resolve({ channelId: "slack:CREVIEW", userId: "slack:UX", request: {} });
    expect(r.agentName).toBe("coding");
    await s.clearChannelOverride("slack:CREVIEW");
    const back = s.resolve({ channelId: "slack:CREVIEW", userId: "slack:UX", request: {} });
    expect(back.agentName).toBe("review");
  });
});

describe("effort resolution (the same layers as model)", () => {
  const EFFORT_YAML = `
providers:
  anthropic:
    type: anthropic
defaults:
  agent: general
  models:
    general: anthropic/general-model
    coding: anthropic/coding-model
    review: anthropic/review-model
  efforts:
    coding: medium
channels:
  "slack:CLOW":
    effort: low
  "slack:CPERAGENT":
    efforts:
      coding: high
users:
  "slack:UHIGH":
    effort: high
  "slack:UPERAGENT":
    efforts:
      coding: low
`;
  let s: ConfigStore;
  beforeEach(() => {
    s = store(EFFORT_YAML);
  });

  it("unset everywhere → undefined (the agent definition / provider default decides)", async () => {
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: { agent: "review" } }).effort).toBeUndefined();
  });

  it("defaults.efforts.<agent> is the floor layer", async () => {
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: { agent: "coding" } }).effort).toBe("medium");
  });

  it("per-agent precedence: user efforts > channel efforts > defaults", async () => {
    expect(s.resolve({ channelId: "slack:CPERAGENT", userId: "slack:UX", request: { agent: "coding" } }).effort).toBe("high");
    expect(s.resolve({ channelId: "slack:CPERAGENT", userId: "slack:UPERAGENT", request: { agent: "coding" } }).effort).toBe("low");
  });

  it("a forced effort (user > channel) beats per-agent efforts, and the request directive beats everything", async () => {
    expect(s.resolve({ channelId: "slack:CLOW", userId: "slack:UPERAGENT", request: { agent: "coding" } }).effort).toBe("low");
    expect(s.resolve({ channelId: "slack:CLOW", userId: "slack:UHIGH", request: { agent: "coding" } }).effort).toBe("high");
    expect(s.resolve({ channelId: "slack:CLOW", userId: "slack:UHIGH", request: { agent: "coding", effort: "medium" } }).effort).toBe("medium");
  });

  it("runtime overrides set effort per scope and per agent, persist through the store, and clear", async () => {
    await s.setUserOverride("slack:UX", { effort: "low" });
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).effort).toBe("low");
    await s.setChannelOverride("slack:CX", { efforts: { review: "high" } });
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UY", request: { agent: "review" } }).effort).toBe("high");
    await s.clearUserOverride("slack:UX");
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).effort).toBeUndefined();
  });

  it("an invalid effort level in static config is rejected at load, naming the valid ones", async () => {
    expect(() => store(EFFORT_YAML.replace("effort: low", "effort: turbo"))).toThrow(/channels\.slack:CLOW\.effort.*turbo.*low, medium, high, xhigh, max/);
    expect(() => store(EFFORT_YAML.replace("    coding: medium", "    coding: turbo"))).toThrow(/defaults\.efforts\.coding.*turbo/);
  });

  it("config show renders effort where it is set: effective, defaults, and scopes", async () => {
    const text = s.describe("slack:CLOW", "slack:UPERAGENT");
    expect(text).toMatch(/\*Effective for you in this channel:\*.*effort `low`/);
    expect(text).toMatch(/\*Defaults:\*.*efforts `coding=medium`/);
    expect(text).toMatch(/\*Channel scope:\*.*effort `low`/);
    expect(text).toMatch(/\*Your scope:\*.*efforts `coding=low`/);
  });
});

describe("permission gates", () => {
  const s = store();

  it("unrestricted agents are open to everyone", async () => {
    expect(s.canRunAgent("slack:URANDOM", "review")).toBe(true);
    expect(s.canRunAgent("slack:URANDOM", "general")).toBe(true);
  });

  it("allowlisted agents admit only listed users and admins", async () => {
    expect(s.canRunAgent("slack:URANDOM", "coding")).toBe(false);
    expect(s.canRunAgent("slack:UDEV", "coding")).toBe(true);
    expect(s.canRunAgent("slack:UADMIN", "coding")).toBe(true);
  });

  it("empty channelConfig list means admins only", async () => {
    expect(s.canEditChannelConfig("slack:URANDOM")).toBe(false);
    expect(s.canEditChannelConfig("slack:UADMIN")).toBe(true);
  });
});

// Feature: features/resident-repos.md — per-repo access is open-when-absent
// (KD7): no permissions.repos config → every allowed coding-agent user may
// use every onboarded repo; a configured allowlist refuses non-listed users.
describe("per-repo access (canUseRepo)", () => {
  it("absent permissions.repos map → every repo is open (KD7 open-when-absent)", async () => {
    const s = store(); // YAML_FIXTURE has no repos map
    expect(s.canUseRepo("slack:URANDOM", "acme/api")).toBe(true);
  });

  const REPOS_FIXTURE = YAML_FIXTURE + `  repos:\n    "acme/api": ["slack:UDEV"]\n`;

  it("a repo absent from a configured map stays open", async () => {
    const s = store(REPOS_FIXTURE);
    expect(s.canUseRepo("slack:URANDOM", "acme/other")).toBe(true);
  });

  it("a listed repo admits members and admins, refuses everyone else", async () => {
    const s = store(REPOS_FIXTURE);
    expect(s.canUseRepo("slack:UDEV", "acme/api")).toBe(true);
    expect(s.canUseRepo("slack:UADMIN", "acme/api")).toBe(true);
    expect(s.canUseRepo("slack:URANDOM", "acme/api")).toBe(false);
  });

  // validateConfig lowercases every permissions.repos key at load: every
  // caller looks the repo up by a lowercased slug (parseSlug/slugOf/
  // repoResourceId), so a mixed-case allowlist key must still match — otherwise
  // it would silently grant OPEN access instead of restricting.
  it("mixed-case repos keys are lowercased at load so a lowercased-slug lookup still restricts (case-insensitive)", async () => {
    const MIXED = YAML_FIXTURE + `  repos:\n    "Acme/API": ["slack:UDEV"]\n`;
    const s = store(MIXED);
    expect(s.canUseRepo("slack:UDEV", "acme/api")).toBe(true);
    expect(s.canUseRepo("slack:UADMIN", "acme/api")).toBe(true);
    // The key would have failed to match (silently opening access) without the
    // load-time lowercasing — a refused user proves it restricts.
    expect(s.canUseRepo("slack:URANDOM", "acme/api")).toBe(false);
  });
});

// Feature: features/resident-repos.md — repo management is FAIL-CLOSED (KTD9):
// no permissions.repoManagement configured → ADMINS ONLY, deliberately
// diverging from canEditChannelConfig's open-when-absent, because onboarding
// provisions billable always-on compute and binds GitHub credentials.
describe("repo management gate (canManageRepos)", () => {
  it("absent repoManagement key → non-admins refused, admins allowed (fail-closed)", async () => {
    const s = store(); // YAML_FIXTURE has no repoManagement key
    expect(s.canManageRepos("slack:URANDOM")).toBe(false);
    expect(s.canManageRepos("slack:UDEV")).toBe(false);
    expect(s.canManageRepos("slack:UADMIN")).toBe(true);
  });

  it("a configured allowlist admits listed users and admins only", async () => {
    const s = store(YAML_FIXTURE + `  repoManagement: ["slack:UDEV"]\n`);
    expect(s.canManageRepos("slack:UDEV")).toBe(true);
    expect(s.canManageRepos("slack:UADMIN")).toBe(true);
    expect(s.canManageRepos("slack:URANDOM")).toBe(false);
  });

  it("an empty allowlist stays admins-only", async () => {
    const s = store(YAML_FIXTURE + `  repoManagement: []\n`);
    expect(s.canManageRepos("slack:UDEV")).toBe(false);
    expect(s.canManageRepos("slack:UADMIN")).toBe(true);
  });
});

// Feature: features/authorization.md item 9 — `grantsFor` is the ONE lookup the
// command registry's policy table decides on; the legacy `permissions.*` keys
// translate to grants at load. FAIL-CLOSED: only `permissions.admins` hold
// everything, and no admins means nobody does.
describe("grantsFor — the legacy keys as the grants the policy table decides on", () => {
  const holds = (s: ConfigStore, id: string, action: string) => hasAction(s.grantsFor(id).actions, action);
  const storeWith = (yaml: string, options: ConfigStoreOptions) => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, yaml);
    return new ConfigStore(cfg, join(dir, "overrides.json"), () => {}, options);
  };

  it("admins hold every action, channel, and repo; a plain user holds the open chat commands (runs:read is an operator command — admins only)", async () => {
    const s = store();
    expect(s.grantsFor("slack:UADMIN")).toEqual(ALL_GRANTS);
    for (const id of ["slack:UDEV", "slack:URANDOM"]) {
      expect(holds(s, id, "runs:read"), id).toBe(false);
      expect(holds(s, id, "help:read"), id).toBe(true);
      expect(s.grantsFor(id).channels, id).toEqual(new Set());
    }
  });

  it("no admins configured → nobody holds everything (fail-closed)", async () => {
    const s = store(YAML_FIXTURE.replace(/permissions:[\s\S]*$/, ""));
    expect(s.grantsFor("slack:UADMIN")).not.toEqual(ALL_GRANTS);
    expect(holds(s, "slack:UADMIN", "runs:read")).toBe(false);
    expect(holds(s, "slack:URANDOM", "runs:read")).toBe(false);
  });

  it("repoManagement → repo:write + friction:write for the listed (admins hold them through `all`), nothing for the rest", async () => {
    const s = store(YAML_FIXTURE + `  repoManagement: ["slack:UDEV"]\n`);
    expect([holds(s, "slack:UADMIN", "repo:write"), holds(s, "slack:UDEV", "repo:write"), holds(s, "slack:URANDOM", "repo:write")]).toEqual([true, true, false]);
    expect(holds(s, "slack:UDEV", "friction:write")).toBe(true);
  });

  it("channelConfig → config:write: absent → every Slack user; present → admins and the listed; agents.coding → agent:run:coding for UDEV and admins, every agent when unrestricted", async () => {
    const open = store(YAML_FIXTURE.replace("  channelConfig: []\n", ""));
    expect([holds(open, "slack:UADMIN", "config:write"), holds(open, "slack:URANDOM", "config:write")]).toEqual([true, true]);
    const closed = store(YAML_FIXTURE.replace("  channelConfig: []\n", `  channelConfig: ["slack:UDEV"]\n`));
    expect([holds(closed, "slack:UADMIN", "config:write"), holds(closed, "slack:UDEV", "config:write"), holds(closed, "slack:URANDOM", "config:write")]).toEqual([true, true, false]);
    expect(holds(store(), "slack:URANDOM", "config:write")).toBe(false); // the fixture's `channelConfig: []`
    // the fixture restricts `coding` to UDEV (admins always pass)
    expect([holds(open, "slack:UADMIN", "agent:run:coding"), holds(open, "slack:UDEV", "agent:run:coding"), holds(open, "slack:URANDOM", "agent:run:coding")]).toEqual([true, true, false]);
    const unrestricted = store(YAML_FIXTURE.replace(`  agents:\n    coding: ["slack:UDEV"]\n`, ""));
    expect(holds(unrestricted, "slack:URANDOM", "agent:run:coding")).toBe(true); // no allowlist → the agent is open
  });

  it("permissions.operators → every registered group's read + write over every channel; an unlisted Access browser session holds the reads; a service token exactly its scopes", async () => {
    const s = storeWith(YAML_FIXTURE + `  operators: ["access:alice@example.com"]\n  serviceTokens:\n    reader-bot: [runs:read]\n`, { commandGroups: ["runs", "friction"] });
    expect(s.grantsFor("access:alice@example.com")).toEqual({ actions: new Set(["runs:read", "runs:write", "friction:read", "friction:write"]), channels: "all", repos: new Set() });
    expect(s.grantsFor("access:stranger")).toEqual({ actions: new Set(["runs:read", "friction:read"]), channels: new Set(), repos: new Set() });
    expect(s.grantsFor("access:svc:reader-bot")).toEqual({ actions: new Set(["runs:read"]), channels: "all", repos: new Set() });
    expect(s.grantsFor("access:svc:stranger")).toBe(NO_GRANTS);
    // Without the catalogue's groups the store cannot spell a group read: an operator holds channels only, a browser nothing.
    expect(store(YAML_FIXTURE + `  operators: ["access:alice@example.com"]\n`).grantsFor("access:alice@example.com")).toEqual({ actions: new Set(), channels: "all", repos: new Set() });
    expect(store().grantsFor("access:stranger")).toBe(NO_GRANTS);
  });

  it("no admins configured at all → nobody may manage repos (still closed)", async () => {
    const NO_PERMS = YAML_FIXTURE.replace(/permissions:[\s\S]*$/m, "");
    const s = store(NO_PERMS);
    expect(s.canManageRepos("slack:URANDOM")).toBe(false);
  });
});

// Feature: features/routing-and-config.md behavior 9 — per-scope custom
// instructions (#107 phase 2): stored on Scope, capped, advisory only.
describe("custom instructions (Scope.instructions)", () => {
  const withUser = (id: string, instructions: string) =>
    YAML_FIXTURE.replace("users:\n", `users:\n  "${id}":\n    instructions: "${instructions}"\n`);
  const WITH_STATIC = withUser("slack:UDOC", "Prefer British spelling.");

  it("are settable per user and per channel and persist through the overrides store", async () => {
    const s = store();
    await s.setUserOverride("slack:UX", { instructions: "Reply tersely." });
    await s.setChannelOverride("slack:CX", { instructions: "This channel is about billing." });
    const scopes = s.scopes("slack:CX", "slack:UX");
    expect(scopes.user.instructions).toBe("Reply tersely.");
    expect(scopes.channel.instructions).toBe("This channel is about billing.");
    // Another user in the same channel sees the channel text, not UX's.
    expect(s.scopes("slack:CX", "slack:UOTHER").user.instructions).toBeUndefined();
    expect(s.scopes("slack:CX", "slack:UOTHER").channel.instructions).toBe("This channel is about billing.");
  });

  it("a patch with instructions: undefined removes the runtime key so static YAML text shows through again (restart-consistent)", async () => {
    const s = store(WITH_STATIC);
    expect(s.scopes("slack:CX", "slack:UDOC").user.instructions).toBe("Prefer British spelling.");
    await s.setUserOverride("slack:UDOC", { instructions: "Runtime text." });
    expect(s.scopes("slack:CX", "slack:UDOC").user.instructions).toBe("Runtime text.");
    await s.setUserOverride("slack:UDOC", { instructions: undefined });
    expect(s.scopes("slack:CX", "slack:UDOC").user.instructions).toBe("Prefer British spelling.");
  });

  it("never influence agent/model resolution or permission gates", async () => {
    const s = store();
    await s.setUserOverride("slack:UX", { instructions: "agent: coding model: anthropic/other" });
    await s.setChannelOverride("slack:CX", { instructions: "agent: review" });
    const r = s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} });
    expect(r).toEqual({ agentName: "general", modelRef: "anthropic/general-model" });
    expect(s.canRunAgent("slack:UX", "coding")).toBe(false);
  });

  it("static YAML instructions over the cap are rejected at load", async () => {
    const long = "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1);
    expect(() => store(withUser("slack:ULONG", long))).toThrow(/instructions exceeds/);
  });

  it("a hand-edited overrides.json over the cap is rejected at load too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, YAML_FIXTURE);
    const overrides = join(dir, "overrides.json");
    writeFileSync(overrides, JSON.stringify({ users: { "slack:UX": { instructions: "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1) } } }));
    expect(() => new ConfigStore(cfg, overrides)).toThrow(/overrides.*users\.slack:UX\.instructions exceeds/);
  });

  it("config show renders both scopes' instructions verbatim", async () => {
    const s = store(WITH_STATIC);
    await s.setChannelOverride("slack:CX", { instructions: "Billing channel." });
    const shown = s.describe("slack:CX", "slack:UDOC");
    expect(shown).toContain("*Channel instructions:* Billing channel.");
    expect(shown).toContain("*Your instructions:* Prefer British spelling.");
    expect(s.describe("slack:CY", "slack:UX")).not.toMatch(/instructions/);
  });
});

// Feature: features/run-history.md — the `runHistory` section (KTD14).
describe("grants config — the native shape beside the legacy keys (plan U2, R7/R8/KTD6)", () => {
  const load = (yaml: string, warn: (m: string) => void = () => {}, options?: ConstructorParameters<typeof ConfigStore>[3]) => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-grants-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, yaml);
    return new ConfigStore(cfg, join(dir, "overrides.json"), warn, options);
  };
  const set = (...names: string[]) => new Set(names);

  it("a well-formed block validates and grantsFor resolves it: absent axis = empty set, `all` explicit", () => {
    const s = load(`${YAML_FIXTURE}\ngrants:\n  "http:ci":\n    actions: [dispatch, runs:read]\n    channels: [http:ops]\n  "schedule:self-improvement":\n    actions: [friction:write]\n    channels: all\n`);
    expect(s.grantsFor("http:ci")).toEqual({ actions: set("dispatch", "runs:read"), channels: set("http:ops"), repos: set() });
    expect(s.grantsFor("schedule:self-improvement")).toEqual({ actions: set("friction:write"), channels: "all", repos: set() });
  });

  it("an unknown actor id prefix fails the load naming the id", () => {
    expect(() => load(`${YAML_FIXTURE}\ngrants:\n  "discord:123":\n    actions: all\n`)).toThrow(/config\.yaml: grants\["discord:123"\].*slack:, http:, mcp:, access:, schedule:/);
  });

  it("a misspelled `all`, an unknown axis, and a non-mapping block fail the load naming the id and field", () => {
    expect(() => load(`${YAML_FIXTURE}\ngrants:\n  "slack:U1":\n    actions: ALL\n`)).toThrow(/grants\["slack:U1"\]\.actions: expected "all" or a list/);
    expect(() => load(`${YAML_FIXTURE}\ngrants:\n  "slack:U1":\n    agents: [coding]\n`)).toThrow(/grants\["slack:U1"\]: unknown field agents/);
    expect(() => load(`${YAML_FIXTURE}\ngrants: [a]\n`)).toThrow(/grants must be a mapping/);
  });

  it("the legacy keys translate through the same lookup: admins → everything; an agents-listed user → agent:run:<name> (+ every repo, repos absent); a plain user → the unrestricted agents; ingress tokens and command groups come from the store options", () => {
    const s = load(YAML_FIXTURE, undefined, { ingressTokens: { tok: { subject: "ci", channel: "ops", scopes: ["dispatch", "runs:read"] } }, commandGroups: ["runs", "friction"] });
    expect(s.grantsFor("slack:UADMIN")).toEqual({ actions: "all", channels: "all", repos: "all" });
    const dev = s.grantsFor("slack:UDEV");
    expect(dev.repos).toBe("all");
    expect(dev.actions).toContain("agent:run:coding");
    expect(dev.actions).toContain("agent:run:general");
    const plain = s.grantsFor("slack:UNOBODY");
    expect(plain.actions).not.toContain("agent:run:coding");
    expect(plain.actions).toContain("agent:run:general");
    // Credentials hold exactly what names them — no everyone baseline.
    expect(s.grantsFor("http:ci")).toEqual({ actions: set("dispatch", "runs:read"), channels: set("http:ops"), repos: set() });
    expect(s.grantsFor("schedule:unlisted")).toEqual({ actions: set(), channels: set(), repos: set() });
    expect(s.grantsFor("mcp:ci").channels).toEqual(set("mcp:ops"));
    const ops = load(`${YAML_FIXTURE}  operators: ["access:op-1"]\n`, undefined, { commandGroups: ["runs", "friction"] }).grantsFor("access:op-1");
    expect(ops.channels).toBe("all");
    for (const a of ["runs:read", "runs:write", "friction:read", "friction:write"]) expect(ops.actions).toContain(a);
  });

  it("an identity named by BOTH shapes takes the grants entry and is warned about by id", () => {
    const warnings: string[] = [];
    const s = load(`${YAML_FIXTURE}\ngrants:\n  "slack:UADMIN":\n    actions: [runs:read]\n`, (m) => warnings.push(m));
    expect(warnings).toEqual([expect.stringMatching(/config\.yaml: grants and permissions both name "slack:UADMIN" — the grants entry wins/)]);
    expect(s.grantsFor("slack:UADMIN")).toEqual({ actions: set("runs:read"), channels: set(), repos: set() });
    // No overlap → no warning.
    warnings.length = 0;
    load(`${YAML_FIXTURE}\ngrants:\n  "http:ci":\n    actions: [dispatch]\n`, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});

describe("runHistory config", () => {
  const withRunHistory = (block: string, extra = "") => `${YAML_FIXTURE}\n${extra}\nrunHistory:\n${block}\n`;
  const load = (yaml: string, warn?: (m: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, yaml);
    return new ConfigStore(cfg, join(dir, "overrides.json"), warn);
  };

  it("accepts a well-formed section and exposes it", async () => {
    const s = load(withRunHistory("  retentionDays: 14\n  maxRuns: 100\n  worker:\n    baseUrl: https://state.example\n"));
    expect(s.config.runHistory).toEqual({ retentionDays: 14, maxRuns: 100, worker: { baseUrl: "https://state.example" } });
  });

  it("rejects retentionDays 0 and maxRuns 0", async () => {
    expect(() => load(withRunHistory("  retentionDays: 0\n"))).toThrow(/runHistory\.retentionDays must be an integer >= 1/);
    expect(() => load(withRunHistory("  maxRuns: 0\n"))).toThrow(/runHistory\.maxRuns must be an integer >= 1/);
  });

  it("rejects an http:// worker baseUrl and an unknown store", async () => {
    expect(() => load(withRunHistory("  worker:\n    baseUrl: http://state.example\n"))).toThrow(/runHistory\.worker\.baseUrl must be an https: URL/);
    expect(() => load(withRunHistory("  store: disk\n"))).toThrow(/runHistory\.store must be "worker" or "file"/);
  });

  it("warns when selfImprovement.ledgerMax is set alongside runHistory (the ledger is served from the run store)", async () => {
    const warnings: string[] = [];
    load(withRunHistory("  retentionDays: 30\n", "selfImprovement:\n  repo: o/r\n  ledgerMax: 500\n"), (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/selfImprovement\.ledgerMax.*runHistory/);
    warnings.length = 0;
    load(`${YAML_FIXTURE}\nselfImprovement:\n  repo: o/r\n  ledgerMax: 500\n`, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});

// Feature: features/agent-ship.md item 8 — the `ship` caps block: pipeline
// wall clock + review-round cap, deployment-level like the sibling `review`
// block, validated at load so a typo cannot silently become "no cap".
describe("ship caps block (agent:ship pipeline)", () => {
  it("parses maxRounds/maxMinutes; absent block leaves the field unset", async () => {
    const s = store(YAML_FIXTURE + "ship:\n  maxRounds: 2\n  maxMinutes: 30\n");
    expect(s.config.ship).toEqual({ maxRounds: 2, maxMinutes: 30 });
    expect(store().config.ship).toBeUndefined();
  });

  it("rejects non-integers and values < 1 at load, naming the key", async () => {
    expect(() => store(YAML_FIXTURE + "ship:\n  maxRounds: 0\n")).toThrow(/ship\.maxRounds must be an integer >= 1/);
    expect(() => store(YAML_FIXTURE + "ship:\n  maxMinutes: 1.5\n")).toThrow(/ship\.maxMinutes must be an integer >= 1/);
    expect(() => store(YAML_FIXTURE + 'ship: "nope"\n')).toThrow(/ship must be a mapping/);
  });

  it("resolveShipCaps: defaults 3 rounds / 120 minutes; configured values win", async () => {
    expect(resolveShipCaps(undefined)).toEqual({ maxRounds: SHIP_DEFAULT_MAX_ROUNDS, maxMinutes: SHIP_DEFAULT_MAX_MINUTES });
    expect(resolveShipCaps({})).toEqual({ maxRounds: 3, maxMinutes: 120 });
    expect(resolveShipCaps({ maxRounds: 1 })).toEqual({ maxRounds: 1, maxMinutes: 120 });
    expect(resolveShipCaps({ maxRounds: 5, maxMinutes: 45 })).toEqual({ maxRounds: 5, maxMinutes: 45 });
  });

  it("the example config (config/config.example.yaml) still loads through ConfigStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-example-"));
    expect(() => new ConfigStore(join(process.cwd(), "config/config.example.yaml"), join(dir, "overrides.json"))).not.toThrow();
  });
});

// Feature: features/routing-and-config.md item 12 — where runtime overrides persist.
describe("overrides backing (item 12: durable runtime overrides)", () => {
  const cfgFile = (yaml: string = YAML_FIXTURE) => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, yaml);
    return { dir, cfg };
  };

  it("a store opened over a preloaded backing reads it, and every write saves the WHOLE document once", async () => {
    const { cfg } = cfgFile();
    const backing = new InMemoryOverridesBacking({ channels: { "slack:CX": { agent: "review" } }, users: {} });
    const s = new ConfigStore(cfg, { backing, initial: await backing.load() });
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).agentName).toBe("review");
    await s.setUserOverride("slack:UX", { effort: "low" });
    expect(backing.saves).toBe(1);
    expect(backing.document).toEqual({ channels: { "slack:CX": { agent: "review" } }, users: { "slack:UX": { effort: "low" } } });
    await s.clearChannelOverride("slack:CX");
    expect(backing.saves).toBe(2);
    expect(backing.document).toEqual({ channels: {}, users: { "slack:UX": { effort: "low" } } });
    expect(s.overridesLocation()).toBe("in-memory");
  });

  it("a failed save rolls the in-memory document back and surfaces the error — what the bot runs on is always what the store holds", async () => {
    const { cfg } = cfgFile();
    const backing = new InMemoryOverridesBacking();
    const s = new ConfigStore(cfg, { backing, initial: undefined });
    backing.failNextSaveWith = "config store unreachable: ECONNREFUSED";
    await expect(s.setChannelOverride("slack:CX", { agent: "coding" })).rejects.toThrow(/unreachable/);
    expect(s.scopes("slack:CX", "slack:UX").channel).toEqual({});
    expect(backing.document).toBeUndefined();
    await s.setChannelOverride("slack:CX", { agent: "coding" }); // the next write goes through
    expect(s.scopes("slack:CX", "slack:UX").channel).toEqual({ agent: "coding" });
  });

  it("a save refused as stale rebases: the store reloads the other writer's document, re-applies THIS change on top, saves again — nothing of either writer is lost", async () => {
    const { cfg } = cfgFile();
    const backing = new InMemoryOverridesBacking({ channels: {}, users: {} });
    const s = new ConfigStore(cfg, { backing, initial: await backing.load() });
    // The CLI saved first: user X's override landed while this process held the empty document.
    backing.conflictNextSaveWith = { channels: {}, users: { "slack:UX": { effort: "low" } } };
    const effective = await s.setUserOverride("slack:UY", { agent: "review" });
    expect(effective.agent).toBe("review");
    expect(backing.document).toEqual({ channels: {}, users: { "slack:UX": { effort: "low" }, "slack:UY": { agent: "review" } } });
    expect(s.scopes("slack:CX", "slack:UX").user).toEqual({ effort: "low" });
    expect(s.scopes("slack:CX", "slack:UY").user).toEqual({ agent: "review" });
    expect(backing.saves).toBe(1);
  });

  it("a second stale refusal in a row surfaces the retry error, and the store now holds the other writer's document — a retry rebases on it, never on the stale snapshot", async () => {
    const { cfg } = cfgFile();
    const backing = new InMemoryOverridesBacking({ channels: {}, users: {} });
    const s = new ConfigStore(cfg, { backing, initial: await backing.load() });
    backing.conflictNextSaveWith = { channels: {}, users: { "slack:UX": { effort: "low" } } };
    backing.conflictAfterNextSaveWith = { channels: { "slack:CX": { agent: "coding" } }, users: { "slack:UX": { effort: "low" } } };
    await expect(s.setUserOverride("slack:UY", { agent: "review" })).rejects.toThrow(OverridesConflictError);
    expect(backing.saves).toBe(0);
    expect(s.scopes("slack:CX", "slack:UX")).toMatchObject({ channel: { agent: "coding" }, user: { effort: "low" } });
    expect(s.scopes("slack:CX", "slack:UY").user).toEqual({});
    // The retry the error asks for now carries every writer's change.
    await s.setUserOverride("slack:UY", { agent: "review" });
    expect(backing.document).toEqual({ channels: { "slack:CX": { agent: "coding" } }, users: { "slack:UX": { effort: "low" }, "slack:UY": { agent: "review" } } });
  });

  it("concurrent writes in one process are serialized: neither loses the other's change", async () => {
    const { cfg } = cfgFile();
    const backing = new InMemoryOverridesBacking();
    const s = new ConfigStore(cfg, { backing, initial: undefined });
    await Promise.all([s.setUserOverride("slack:UX", { effort: "low" }), s.setChannelOverride("slack:CX", { agent: "review" }), s.setUserOverride("slack:UY", { agent: "coding" })]);
    expect(backing.saves).toBe(3);
    expect(backing.document).toEqual({ channels: { "slack:CX": { agent: "review" } }, users: { "slack:UX": { effort: "low" }, "slack:UY": { agent: "coding" } } });
    expect(s.scopes("slack:CX", "slack:UX")).toMatchObject({ channel: { agent: "review" }, user: { effort: "low" } });
  });

  it("a failed write does not block the writes queued behind it", async () => {
    const { cfg } = cfgFile();
    const backing = new InMemoryOverridesBacking();
    const s = new ConfigStore(cfg, { backing, initial: undefined });
    backing.failNextSaveWith = "config store unreachable: ECONNREFUSED";
    const failed = s.setUserOverride("slack:UX", { effort: "low" });
    const queued = s.setUserOverride("slack:UY", { effort: "high" });
    await expect(failed).rejects.toThrow(/unreachable/);
    await queued;
    expect(backing.document).toEqual({ channels: {}, users: { "slack:UY": { effort: "high" } } });
  });

  it("a preloaded document over the instructions cap is refused at construction, naming the backing", async () => {
    const { cfg } = cfgFile();
    const backing = new InMemoryOverridesBacking({ channels: {}, users: { "slack:UX": { instructions: "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1) } } });
    expect(() => new ConfigStore(cfg, { backing, initial: backing.document })).toThrow(/overrides \(in-memory\).*instructions exceeds/);
  });

  it("overridesBackingFor: no `runtimeOverrides` → the file; a worker → WorkerOverridesBacking; a worker without its bearer → a startup error naming the env var", () => {
    const base = { providers: {}, defaults: { agent: "general", models: {} } } as unknown as AppConfig;
    expect(overridesBackingFor(base, { overridesPath: "/tmp/o.json", env: {} })).toBeInstanceOf(FileOverridesBacking);
    const withWorker = { ...base, runtimeOverrides: { worker: { baseUrl: "https://state.example" } } } as AppConfig;
    expect(overridesBackingFor(withWorker, { overridesPath: "/tmp/o.json", env: { MEMORY_TOKEN: "t" } })).toBeInstanceOf(WorkerOverridesBacking);
    expect(() => overridesBackingFor(withWorker, { overridesPath: "/tmp/o.json", env: {} })).toThrow(/runtimeOverrides.worker is configured but MEMORY_TOKEN is not set/);
    const customEnv = { ...base, runtimeOverrides: { worker: { baseUrl: "https://state.example", tokenEnv: "STATE_TOKEN" } } } as AppConfig;
    expect(() => overridesBackingFor(customEnv, { overridesPath: "/tmp/o.json", env: {} })).toThrow(/STATE_TOKEN is not set/);
  });

  it("config.yaml validation: runtimeOverrides.worker.baseUrl must be https; tokenEnv a name", () => {
    expect(() => store(`${YAML_FIXTURE}\nruntimeOverrides:\n  worker:\n    baseUrl: http://state.example\n`)).toThrow(/runtimeOverrides\.worker\.baseUrl must be an https: URL/);
    expect(() => store(`${YAML_FIXTURE}\nruntimeOverrides:\n  worker:\n    baseUrl: https://state.example\n    tokenEnv: ""\n`)).toThrow(/runtimeOverrides\.worker\.tokenEnv/);
    expect(() => store(`${YAML_FIXTURE}\nruntimeOverrides: []\n`)).toThrow(/runtimeOverrides must be a mapping/);
    expect(store(`${YAML_FIXTURE}\nruntimeOverrides:\n  worker:\n    baseUrl: https://state.example\n`).config.runtimeOverrides).toEqual({ worker: { baseUrl: "https://state.example" } });
  });

  it("openConfigStore picks the backing from config.yaml and loads the document (file backing here)", async () => {
    const { dir, cfg } = cfgFile();
    const path = join(dir, "overrides.json");
    writeFileSync(path, JSON.stringify({ channels: {}, users: { "slack:UX": { agent: "review" } } }));
    const s = await openConfigStore(cfg, { overridesPath: path, env: {} });
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).agentName).toBe("review");
    expect(s.overridesLocation()).toBe(`file ${path}`);
  });

  it("openConfigStore parses and validates config.yaml ONCE — a load-time warning is reported once, not again by the constructor", async () => {
    const { dir, cfg } = cfgFile(`${YAML_FIXTURE}\nrunHistory: {}\nselfImprovement:\n  ledgerMax: 5\n`);
    const warnings: string[] = [];
    await openConfigStore(cfg, { overridesPath: join(dir, "overrides.json"), env: {}, warn: (m) => warnings.push(m) });
    expect(warnings.filter((w) => w.includes("ledgerMax"))).toHaveLength(1);
  });
});

describe("WorkerOverridesBacking (the ConfigDO client)", () => {
  function fake(state: { document: Overrides | null; version: number }, opts: { failStatus?: number; down?: boolean } = {}) {
    const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (opts.down) throw new Error("ECONNREFUSED");
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
      if (opts.failStatus) return new Response("{}", { status: opts.failStatus });
      if (url.pathname === "/config/get") return Response.json({ document: state.document, version: state.version });
      if (url.pathname === "/config/put") {
        if (body.expectedVersion !== state.version) return Response.json({ error: "version conflict", version: state.version }, { status: 409 });
        state.version += 1;
        state.document = body.document as Overrides;
        return Response.json({ ok: true, version: state.version });
      }
      return new Response("{}", { status: 404 });
    };
    return { calls, backing: new WorkerOverridesBacking({ baseUrl: "https://state.example/", token: "tok", fetch: fetchImpl }) };
  }

  it("loads the document with its version, saves with expectedVersion, tracks the new version, sends the bearer", async () => {
    const state = { document: { channels: {}, users: { "slack:UX": { agent: "review" } } } as Overrides | null, version: 3 };
    const { calls, backing } = fake(state);
    expect(await backing.load()).toEqual(state.document);
    await backing.save({ channels: {}, users: {} });
    expect(calls.map((c) => c.path)).toEqual(["/config/get", "/config/put"]);
    expect(calls[1].body).toEqual({ key: "overrides", document: { channels: {}, users: {} }, expectedVersion: 3 });
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    await backing.save({ channels: { a: {} }, users: {} });
    expect(calls[2].body.expectedVersion).toBe(4);
    expect(backing.describe()).toBe("state Worker https://state.example (ConfigDO)");
  });

  it("an empty store loads as undefined at version 0; the first save expects 0", async () => {
    const state = { document: null as Overrides | null, version: 0 };
    const { calls, backing } = fake(state);
    expect(await backing.load()).toBeUndefined();
    await backing.save({ channels: {}, users: {} });
    expect(calls[1].body.expectedVersion).toBe(0);
    expect(state.version).toBe(1);
  });

  it("a stale save is refused with an OverridesConflictError (retry message) and adopts the current version so the next save can go through", async () => {
    const state = { document: { channels: {}, users: {} } as Overrides | null, version: 1 };
    const { backing } = fake(state);
    await backing.load();
    state.version = 5; // someone else (the CLI) saved four times
    const err = await backing.save({ channels: {}, users: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OverridesConflictError);
    expect((err as Error).message).toMatch(/changed elsewhere.*retry/);
    await backing.save({ channels: {}, users: {} });
    expect(state.version).toBe(6);
  });

  it("non-2xx and transport failures throw naming the config store", async () => {
    await expect(fake({ document: null, version: 0 }, { failStatus: 500 }).backing.load()).rejects.toThrow(/config store answered HTTP 500/);
    await expect(fake({ document: null, version: 0 }, { down: true }).backing.load()).rejects.toThrow(/config store unreachable: ECONNREFUSED/);
  });
});

// Feature: features/mcp-tools.md items 11 + 14 + 17 — MCP servers as a Scope setting.
describe("Scope.mcpServers (MCP servers layered through config)", () => {
  const MCP_YAML = `${YAML_FIXTURE}
  "slack:CMCP":
    mcpServers:
      notion: { url: "https://mcp.notion.so/mcp", auth: none }
`.replace("channels:\n", "channels:\n");
  const withDefaults = `
providers:
  anthropic:
    type: anthropic
defaults:
  agent: general
  models:
    general: anthropic/general-model
  mcpServers:
    linear: { url: "https://mcp.linear.app/mcp", auth: bearer, tokenEnv: MCP_LINEAR_TOKEN, agents: [general, coding] }
channels:
  "slack:CMCP":
    mcpServers:
      notion: { url: "https://mcp.notion.so/mcp", auth: none }
users:
  "slack:UX":
    mcpServers:
      vanta: { url: "https://mcp.vanta.com/mcp", auth: bearer }
      linear: { url: "https://evil.example/mcp", auth: none }
`;
  void MCP_YAML;

  it("mcpServersFor unions the three tiers, org first, and marks a lower-tier name clash as shadowed", () => {
    const s = store(withDefaults);
    const resolved = s.mcpServersFor("slack:CMCP", "slack:UX");
    expect(resolved.map((r) => [r.kind, r.name, r.source, r.shadowedBy ?? null])).toEqual([
      ["org", "linear", "config", null],
      ["channel", "notion", "config", null],
      ["user", "vanta", "config", null],
      ["user", "linear", "config", "org"],
    ]);
    expect(resolved[0].scopeKey).toBe("org");
    expect(resolved[1].scopeKey).toBe("channel:slack:CMCP");
    expect(resolved[2].scopeKey).toBe("user:slack:UX");
    // Another channel / user sees only the org tier.
    expect(s.mcpServersFor("slack:COTHER", "slack:UY").map((r) => r.name)).toEqual(["linear"]);
  });

  it("a runtime `mcp add` into a channel or user that already has STATIC servers layers over them — the pinned entries keep serving", async () => {
    const s = store(withDefaults);
    await s.setChannelOverride("slack:CMCP", { mcpServers: { hubspot: { url: "https://mcp.hubspot.com/mcp", auth: "none", addedBy: "slack:UX", addedAt: 1 } } });
    await s.setUserOverride("slack:UX", { mcpServers: { asana: { url: "https://mcp.asana.com/mcp", auth: "none", addedBy: "slack:UX", addedAt: 2 } } });
    const resolved = s.mcpServersFor("slack:CMCP", "slack:UX");
    expect(resolved.map((r) => [r.kind, r.name, r.source])).toEqual([
      ["org", "linear", "config"],
      ["channel", "notion", "config"],
      ["channel", "hubspot", "runtime"],
      ["user", "vanta", "config"],
      ["user", "linear", "config"],
      ["user", "asana", "runtime"],
    ]);
    // The runtime half is still only what `mcp add` wrote — the static entries were never copied into the document.
    expect(s.runtimeScope("channel", "slack:CMCP").mcpServers).toEqual({ hubspot: expect.anything() });
    expect(s.runtimeScope("user", "slack:UX").mcpServers).toEqual({ asana: expect.anything() });
    // The effective scopes (`config show`, the dispatcher's config block) name both halves.
    const shown = s.describe("slack:CMCP", "slack:UX");
    expect(shown).toMatch(/\*Channel scope:\*.*mcp `notion` `hubspot`/);
    expect(shown).toMatch(/\*Your scope:\*.*mcp `vanta` `linear` `asana`/);
    // Removing the runtime entry again leaves the static ones exactly as before.
    await s.setChannelOverride("slack:CMCP", { mcpServers: undefined });
    expect(s.mcpServersFor("slack:CMCP", "slack:UX").filter((r) => r.kind === "channel").map((r) => r.name)).toEqual(["notion"]);
  });

  it("runtime entries layer over static ones per tier; `runtimeScope` is the runtime half only; the org tier is `defaults` + the `org` override", async () => {
    const s = store(withDefaults);
    await s.setUserOverride("slack:UY", { mcpServers: { hubspot: { url: "https://mcp.hubspot.com/mcp", auth: "none", addedBy: "slack:UY", addedAt: 1 } } });
    await s.setOrgOverride({ mcpServers: { github: { url: "https://api.githubcopilot.com/mcp/", auth: "bearer", addedBy: "slack:UADMIN", addedAt: 2 } } });
    const resolved = s.mcpServersFor("slack:CX", "slack:UY");
    expect(resolved.map((r) => [r.kind, r.name, r.source])).toEqual([
      ["org", "linear", "config"],
      ["org", "github", "runtime"],
      ["user", "hubspot", "runtime"],
    ]);
    expect(s.runtimeScope("org").mcpServers).toEqual({ github: expect.objectContaining({ url: "https://api.githubcopilot.com/mcp/" }) });
    expect(s.runtimeScope("user", "slack:UX").mcpServers).toBeUndefined(); // static only
    expect(s.isStaticMcpServer("org", undefined, "linear")).toBe(true);
    expect(s.isStaticMcpServer("org", undefined, "github")).toBe(false);
    expect(s.isStaticMcpServer("user", "slack:UX", "vanta")).toBe(true);
    // `config show` names the servers per tier, never their URLs' query strings.
    const shown = s.describe("slack:CMCP", "slack:UX");
    expect(shown).toMatch(/\*Defaults:\*.*mcp `linear` `github`/);
    expect(shown).toMatch(/\*Channel scope:\*.*mcp `notion`/);
    expect(shown).toMatch(/\*Your scope:\*.*mcp `vanta` `linear`/);
  });

  it("validates every tier at load: slug names, http(s) + SSRF-safe URLs, known agents, auth kind, tokenEnv only with bearer, and self-serve agents only outside org", () => {
    const bad = (yaml: string) => () => store(yaml);
    expect(bad(withDefaults.replace("notion:", "Bad Name:"))).toThrow(/channels\.slack:CMCP\.mcpServers\.Bad Name: server names are slugs/);
    expect(bad(withDefaults.replace("https://mcp.notion.so/mcp", "http://169.254.169.254/"))).toThrow(/mcpServers\.notion\.url: .*169\.254/);
    expect(bad(withDefaults.replace("https://mcp.notion.so/mcp", "ftp://x.example"))).toThrow(/mcpServers\.notion\.url:/);
    expect(bad(withDefaults.replace('notion: { url: "https://mcp.notion.so/mcp", auth: none }', 'notion: { url: "https://mcp.notion.so/mcp", auth: none, agents: [wizard] }'))).toThrow(/unknown agent "wizard"/);
    expect(bad(withDefaults.replace('vanta: { url: "https://mcp.vanta.com/mcp", auth: bearer }', 'vanta: { url: "https://mcp.vanta.com/mcp", auth: bearer, agents: [coding] }'))).toThrow(
      /users\.slack:UX\.mcpServers\.vanta\.agents: a user-scoped server may name general\/research only/,
    );
    expect(bad(withDefaults.replace('notion: { url: "https://mcp.notion.so/mcp", auth: none }', 'notion: { url: "https://mcp.notion.so/mcp", auth: none, agents: [review] }'))).toThrow(/a channel-scoped server may name general\/research only/);
    expect(bad(withDefaults.replace("auth: none }", "auth: magic }"))).toThrow(/must be \{ url, auth: none\|bearer\|oauth/);
    // oauth is a valid static kind (item 18): the credential is the connect page's, so no tokenEnv.
    expect(bad(withDefaults.replace("auth: none }", "auth: oauth }"))).not.toThrow();
    expect(bad(withDefaults.replace("auth: none }", "auth: oauth, tokenEnv: X }"))).toThrow(/tokenEnv only applies to auth: bearer/);
    expect(bad(withDefaults.replace("auth: none }", "auth: none, tokenEnv: X }"))).toThrow(/tokenEnv only applies to auth: bearer/);
    // The org tier may name any agent (coding above) — it loads.
    expect(store(withDefaults).config.defaults.mcpServers?.linear.agents).toEqual(["general", "coding"]);
  });

  it("a stored overrides document is held to the same rules, naming the backing", () => {
    const { cfg } = (() => {
      const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
      const cfg = join(dir, "config.yaml");
      writeFileSync(cfg, YAML_FIXTURE);
      return { cfg };
    })();
    const backing = new InMemoryOverridesBacking({ channels: {}, users: { "slack:UX": { mcpServers: { vanta: { url: "http://localhost:1/mcp", auth: "none" } } } } });
    expect(() => new ConfigStore(cfg, { backing, initial: backing.document })).toThrow(/overrides \(in-memory\): users\.slack:UX\.mcpServers\.vanta\.url/);
  });
});
