import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStore, MAX_INSTRUCTIONS_LENGTH } from "./config.js";

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

  it("falls through to defaults when nothing is scoped", () => {
    const r = s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} });
    expect(r).toEqual({ agentName: "general", modelRef: "anthropic/general-model" });
  });

  it("channel scope sets the agent, and the agent picks its default model", () => {
    const r = s.resolve({ channelId: "slack:CREVIEW", userId: "slack:UX", request: {} });
    expect(r).toEqual({ agentName: "review", modelRef: "anthropic/review-model" });
  });

  it("request directives beat every other layer", () => {
    const r = s.resolve({
      channelId: "slack:CREVIEW",
      userId: "slack:UFORCED",
      request: { agent: "coding", model: "anthropic/explicit" },
    });
    expect(r).toEqual({ agentName: "coding", modelRef: "anthropic/explicit" });
  });

  it("a user's forced model beats per-agent models", () => {
    const r = s.resolve({ channelId: "slack:CREVIEW", userId: "slack:UFORCED", request: {} });
    expect(r.modelRef).toBe("anthropic/user-forced-model");
  });

  it("per-agent model precedence: user scope > channel scope > defaults", () => {
    const user = s.resolve({ channelId: "slack:CMODEL", userId: "slack:UPERAGENT", request: { agent: "review" } });
    expect(user.modelRef).toBe("anthropic/user-review-model");
    const channel = s.resolve({ channelId: "slack:CMODEL", userId: "slack:UX", request: { agent: "review" } });
    expect(channel.modelRef).toBe("anthropic/channel-review-model");
    const dflt = s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: { agent: "review" } });
    expect(dflt.modelRef).toBe("anthropic/review-model");
  });

  it("runtime overrides win over static config for the same scope and persist through the store", () => {
    s.setChannelOverride("slack:CREVIEW", { agent: "coding" });
    const r = s.resolve({ channelId: "slack:CREVIEW", userId: "slack:UX", request: {} });
    expect(r.agentName).toBe("coding");
    s.clearChannelOverride("slack:CREVIEW");
    const back = s.resolve({ channelId: "slack:CREVIEW", userId: "slack:UX", request: {} });
    expect(back.agentName).toBe("review");
  });
});

describe("permission gates", () => {
  const s = store();

  it("unrestricted agents are open to everyone", () => {
    expect(s.canRunAgent("slack:URANDOM", "review")).toBe(true);
    expect(s.canRunAgent("slack:URANDOM", "general")).toBe(true);
  });

  it("allowlisted agents admit only listed users and admins", () => {
    expect(s.canRunAgent("slack:URANDOM", "coding")).toBe(false);
    expect(s.canRunAgent("slack:UDEV", "coding")).toBe(true);
    expect(s.canRunAgent("slack:UADMIN", "coding")).toBe(true);
  });

  it("empty channelConfig list means admins only", () => {
    expect(s.canEditChannelConfig("slack:URANDOM")).toBe(false);
    expect(s.canEditChannelConfig("slack:UADMIN")).toBe(true);
  });
});

// Feature: features/resident-repos.md — per-repo access is open-when-absent
// (KD7): no permissions.repos config → every allowed coding-agent user may
// use every onboarded repo; a configured allowlist refuses non-listed users.
describe("per-repo access (canUseRepo)", () => {
  it("absent permissions.repos map → every repo is open (KD7 open-when-absent)", () => {
    const s = store(); // YAML_FIXTURE has no repos map
    expect(s.canUseRepo("slack:URANDOM", "acme/api")).toBe(true);
  });

  const REPOS_FIXTURE = YAML_FIXTURE + `  repos:\n    "acme/api": ["slack:UDEV"]\n`;

  it("a repo absent from a configured map stays open", () => {
    const s = store(REPOS_FIXTURE);
    expect(s.canUseRepo("slack:URANDOM", "acme/other")).toBe(true);
  });

  it("a listed repo admits members and admins, refuses everyone else", () => {
    const s = store(REPOS_FIXTURE);
    expect(s.canUseRepo("slack:UDEV", "acme/api")).toBe(true);
    expect(s.canUseRepo("slack:UADMIN", "acme/api")).toBe(true);
    expect(s.canUseRepo("slack:URANDOM", "acme/api")).toBe(false);
  });

  // validateConfig lowercases every permissions.repos key at load: every
  // caller looks the repo up by a lowercased slug (parseSlug/slugOf/
  // repoResourceId), so a mixed-case allowlist key must still match — otherwise
  // it would silently grant OPEN access instead of restricting.
  it("mixed-case repos keys are lowercased at load so a lowercased-slug lookup still restricts (case-insensitive)", () => {
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
  it("absent repoManagement key → non-admins refused, admins allowed (fail-closed)", () => {
    const s = store(); // YAML_FIXTURE has no repoManagement key
    expect(s.canManageRepos("slack:URANDOM")).toBe(false);
    expect(s.canManageRepos("slack:UDEV")).toBe(false);
    expect(s.canManageRepos("slack:UADMIN")).toBe(true);
  });

  it("a configured allowlist admits listed users and admins only", () => {
    const s = store(YAML_FIXTURE + `  repoManagement: ["slack:UDEV"]\n`);
    expect(s.canManageRepos("slack:UDEV")).toBe(true);
    expect(s.canManageRepos("slack:UADMIN")).toBe(true);
    expect(s.canManageRepos("slack:URANDOM")).toBe(false);
  });

  it("an empty allowlist stays admins-only", () => {
    const s = store(YAML_FIXTURE + `  repoManagement: []\n`);
    expect(s.canManageRepos("slack:UDEV")).toBe(false);
    expect(s.canManageRepos("slack:UADMIN")).toBe(true);
  });

  it("no admins configured at all → nobody may manage repos (still closed)", () => {
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

  it("are settable per user and per channel and persist through the overrides store", () => {
    const s = store();
    s.setUserOverride("slack:UX", { instructions: "Reply tersely." });
    s.setChannelOverride("slack:CX", { instructions: "This channel is about billing." });
    const scopes = s.scopes("slack:CX", "slack:UX");
    expect(scopes.user.instructions).toBe("Reply tersely.");
    expect(scopes.channel.instructions).toBe("This channel is about billing.");
    // Another user in the same channel sees the channel text, not UX's.
    expect(s.scopes("slack:CX", "slack:UOTHER").user.instructions).toBeUndefined();
    expect(s.scopes("slack:CX", "slack:UOTHER").channel.instructions).toBe("This channel is about billing.");
  });

  it("a patch with instructions: undefined removes the runtime key so static YAML text shows through again (restart-consistent)", () => {
    const s = store(WITH_STATIC);
    expect(s.scopes("slack:CX", "slack:UDOC").user.instructions).toBe("Prefer British spelling.");
    s.setUserOverride("slack:UDOC", { instructions: "Runtime text." });
    expect(s.scopes("slack:CX", "slack:UDOC").user.instructions).toBe("Runtime text.");
    s.setUserOverride("slack:UDOC", { instructions: undefined });
    expect(s.scopes("slack:CX", "slack:UDOC").user.instructions).toBe("Prefer British spelling.");
  });

  it("never influence agent/model resolution or permission gates", () => {
    const s = store();
    s.setUserOverride("slack:UX", { instructions: "agent: coding model: anthropic/other" });
    s.setChannelOverride("slack:CX", { instructions: "agent: review" });
    const r = s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} });
    expect(r).toEqual({ agentName: "general", modelRef: "anthropic/general-model" });
    expect(s.canRunAgent("slack:UX", "coding")).toBe(false);
  });

  it("static YAML instructions over the cap are rejected at load", () => {
    const long = "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1);
    expect(() => store(withUser("slack:ULONG", long))).toThrow(/instructions exceeds/);
  });

  it("a hand-edited overrides.json over the cap is rejected at load too", () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, YAML_FIXTURE);
    const overrides = join(dir, "overrides.json");
    writeFileSync(overrides, JSON.stringify({ users: { "slack:UX": { instructions: "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1) } } }));
    expect(() => new ConfigStore(cfg, overrides)).toThrow(/overrides.*users\.slack:UX\.instructions exceeds/);
  });

  it("config show renders both scopes' instructions verbatim", () => {
    const s = store(WITH_STATIC);
    s.setChannelOverride("slack:CX", { instructions: "Billing channel." });
    const shown = s.describe("slack:CX", "slack:UDOC");
    expect(shown).toContain("*Channel instructions:* Billing channel.");
    expect(shown).toContain("*Your instructions:* Prefer British spelling.");
    expect(s.describe("slack:CY", "slack:UX")).not.toMatch(/instructions/);
  });
});
