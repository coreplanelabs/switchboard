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
  type Overrides,
} from "./config.js";
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

// Feature: features/command-registry.md — the chat gate the command registry
// resolves a `slack:U…` caller against. `isOperator` is FAIL-CLOSED: only
// `permissions.admins` qualify, and no admins means no operators.
describe("operator gate (isOperator, chatGateFor)", () => {
  it("isOperator is true only for admins", async () => {
    const s = store();
    expect(s.isOperator("slack:UADMIN")).toBe(true);
    expect(s.isOperator("slack:UDEV")).toBe(false);
    expect(s.isOperator("slack:URANDOM")).toBe(false);
  });

  it("isOperator is false for everyone when permissions.admins is absent", async () => {
    const s = store(YAML_FIXTURE.replace(/permissions:[\s\S]*$/, ""));
    expect(s.isOperator("slack:UADMIN")).toBe(false);
    expect(s.isOperator("slack:URANDOM")).toBe(false);
  });

  it("chatGateFor resolves open → everyone, operator → admins, repoManager → canManageRepos", async () => {
    const s = store(YAML_FIXTURE + `  repoManagement: ["slack:UDEV"]\n`);
    const admin = s.chatGateFor("slack:UADMIN");
    const dev = s.chatGateFor("slack:UDEV");
    const rando = s.chatGateFor("slack:URANDOM");
    expect([admin("open"), dev("open"), rando("open")]).toEqual([true, true, true]);
    expect([admin("operator"), dev("operator"), rando("operator")]).toEqual([true, false, false]);
    expect([admin("repoManager"), dev("repoManager"), rando("repoManager")]).toEqual([true, true, false]);
  });

  it("chatGateFor resolves channelConfig → canEditChannelConfig (open when unconfigured) and agentRun → canRunAgent(user, coding)", async () => {
    const open = store(YAML_FIXTURE.replace("  channelConfig: []\n", ""));
    expect([open.chatGateFor("slack:UADMIN")("channelConfig"), open.chatGateFor("slack:URANDOM")("channelConfig")]).toEqual([true, true]);
    const closed = store(YAML_FIXTURE.replace("  channelConfig: []\n", `  channelConfig: ["slack:UDEV"]\n`));
    expect([closed.chatGateFor("slack:UADMIN")("channelConfig"), closed.chatGateFor("slack:UDEV")("channelConfig"), closed.chatGateFor("slack:URANDOM")("channelConfig")]).toEqual([true, true, false]);
    // the fixture restricts `coding` to UDEV (admins always pass)
    expect([open.chatGateFor("slack:UADMIN")("agentRun"), open.chatGateFor("slack:UDEV")("agentRun"), open.chatGateFor("slack:URANDOM")("agentRun")]).toEqual([true, true, false]);
    const unrestricted = store(YAML_FIXTURE.replace(`  agents:\n    coding: ["slack:UDEV"]\n`, ""));
    expect(unrestricted.chatGateFor("slack:URANDOM")("agentRun")).toBe(true); // no allowlist → the agent is open
  });

  it("permissions.operators is parsed as the Access-identity write allowlist", async () => {
    const s = store(YAML_FIXTURE + `  operators: ["access:alice@example.com"]\n`);
    expect(s.operatorIdentities()).toEqual(["access:alice@example.com"]);
    expect(store().operatorIdentities()).toEqual([]);
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
