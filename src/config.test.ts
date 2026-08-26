import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "./config.js";

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
