import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage as PiAssistantMessage, ProviderStreams } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { secretsFrom, type Secrets } from "./secrets.js";
import {
  ConfigStore,
  defaultIntakeMode,
  FileOverridesBacking,
  InMemoryOverridesBacking,
  intakeModelRef,
  loadAppConfigFrom,
  openConfigStore,
  OverridesConflictError,
  overridesBackingFor,
  referencesOn,
  routingOn,
  WorkerOverridesBacking,
  type AppConfig,
  type ConfigStoreOptions,
  type Overrides,
  type Scope,
} from "./config.js";
import { MAX_INSTRUCTIONS_LENGTH, validateHarnessWords } from "./config/validate.js";
import { declaredProfile, effectiveConfirm, effectiveProfile } from "./config/profile.js";
import { AGENTS } from "./agents/registry.js";
import { hasAction } from "./core/authz/authorize.js";
import { resolveChatActor } from "./core/authz/actor.js";
import { ALL_GRANTS } from "./core/authz/grants.js";
import { NO_GRANTS } from "./core/authz/types.js";
import {
  resolveAddressSeverity,
  resolveGrant,
  resolveIdleDays,
  resolveShipCaps,
  SHIP_DEFAULT_MAX_MINUTES,
  shipPresetFor,
} from "./core/shipPipeline.js";
import { DEFAULT_MAX_CHILDREN, maxChildrenOf } from "./core/dispatch/spawn.js";
import { PiAiProviders } from "./core/harness/piAi.js";
import { parseModelRef, type CompletionRequest } from "./core/provider.js";
import { upstreamFor } from "./channels/modelProxy.js";

// Feature: docs/reference/specs/routing-and-config.md — layered resolution & permission gates.

const YAML_FIXTURE = `
organization: acme
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
grants:
  "slack:UADMIN": { actions: all, channels: all, repos: all }
  "slack:UDEV": { actions: [agent:run:coding] }
restrict:
  agents: [coding]
`;

/** The fixture with more `grants` entries (each line indented under the block). */
const withGrants = (entries: string) => YAML_FIXTURE.replace("restrict:\n", `${entries}restrict:\n`);
/** The fixture with UDEV's entry replaced. */
const devGranted = (entry: string) =>
  YAML_FIXTURE.replace('"slack:UDEV": { actions: [agent:run:coding] }', `"slack:UDEV": ${entry}`);

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
    expect(r).toEqual({
      agentName: "general",
      agentLayer: "default",
      modelRef: "anthropic/general-model",
      verbosity: "quiet",
    });
  });

  it("channel scope sets the agent, and the agent picks its default model", async () => {
    const r = s.resolve({ channelId: "slack:CREVIEW", userId: "slack:UX", request: {} });
    expect(r).toEqual({
      agentName: "review",
      agentLayer: "channel",
      modelRef: "anthropic/review-model",
      verbosity: "quiet",
    });
  });

  it("names the layer that set the agent: request > user > channel > default (routing-and-config item 21 reads it)", async () => {
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: { agent: "review" } }).agentLayer).toBe(
      "request",
    );
    expect(s.resolve({ channelId: "slack:CREVIEW", userId: "slack:UX", request: {} }).agentLayer).toBe("channel");
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).agentLayer).toBe("default");
    await s.setUserOverride("slack:UAGENT", { agent: "coding" });
    expect(s.resolve({ channelId: "slack:CREVIEW", userId: "slack:UAGENT", request: {} }).agentLayer).toBe("user");
  });

  it("request directives beat every other layer", async () => {
    const r = s.resolve({
      channelId: "slack:CREVIEW",
      userId: "slack:UFORCED",
      request: { agent: "coding", model: "anthropic/explicit" },
    });
    expect(r).toEqual({
      agentName: "coding",
      agentLayer: "request",
      modelRef: "anthropic/explicit",
      verbosity: "quiet",
    });
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

describe("channelsWithScope — the index of configured channels", () => {
  it("lists every channel with a static or runtime scope, sorted, with the setting NAMES it carries and where they come from", async () => {
    const s = store();
    await s.setChannelOverride("slack:CX", { instructions: "This channel is about billing." });
    await s.setChannelOverride("slack:CREVIEW", { models: { review: "anthropic/other" } });
    expect(s.channelsWithScope()).toEqual([
      { channelId: "slack:CMODEL", settings: ["models"], source: "config" },
      { channelId: "slack:CREVIEW", settings: ["agent", "models"], source: "both" },
      { channelId: "slack:CX", settings: ["instructions"], source: "runtime" },
    ]);
    // Names only: the instructions text and the model refs are not in the index.
    expect(JSON.stringify(s.channelsWithScope())).not.toContain("billing");
    expect(JSON.stringify(s.channelsWithScope())).not.toContain("anthropic/");
  });

  it("a channel whose runtime scope was cleared and has no static block leaves the index; a user scope never enters it", async () => {
    const s = store();
    await s.setChannelOverride("slack:CX", { agent: "review" });
    await s.setUserOverride("slack:UX", { agent: "review" });
    await s.clearChannelOverride("slack:CX");
    expect(s.channelsWithScope().map((r) => r.channelId)).toEqual(["slack:CMODEL", "slack:CREVIEW"]);
  });
});

// docs/reference/specs/routing-and-config.md item 28: verbosity rides the same
// ladder as effort and is always resolved — `quiet` when no layer says otherwise.
describe("verbosity resolution (the same layers as effort; quiet by default)", () => {
  const VERBOSITY_YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
defaults:
  agent: general
  models:
    general: anthropic/general-model
  verbosity: verbose
channels:
  "slack:CDEBUG":
    verbosity: debug
users:
  "slack:UQUIET":
    verbosity: quiet
`;
  const at = (s: ConfigStore, channelId: string, userId: string, request?: "quiet" | "verbose" | "debug") =>
    s.resolve({ channelId, userId, request: request ? { verbosity: request } : {} }).verbosity;

  it("no layer set → quiet; defaults.verbosity is the floor; channel over defaults; user over channel; the request over everything", async () => {
    expect(at(store(), "slack:CX", "slack:UX")).toBe("quiet");
    const s = store(VERBOSITY_YAML);
    expect(at(s, "slack:CX", "slack:UX")).toBe("verbose");
    expect(at(s, "slack:CDEBUG", "slack:UX")).toBe("debug");
    expect(at(s, "slack:CDEBUG", "slack:UQUIET")).toBe("quiet");
    expect(at(s, "slack:CDEBUG", "slack:UQUIET", "debug")).toBe("debug");
    expect(s.verbosityFor("slack:CDEBUG", "slack:UQUIET")).toBe("quiet");
    expect(s.verbosityFor("slack:CDEBUG", "slack:UX", "quiet")).toBe("quiet");
  });

  it("runtime overrides set it per scope, persist through the store, and clear back to the layer below", async () => {
    const s = store();
    await s.setUserOverride("slack:UX", { verbosity: "debug" });
    expect(at(s, "slack:CX", "slack:UX")).toBe("debug");
    await s.setChannelOverride("slack:CX", { verbosity: "verbose" });
    expect(at(s, "slack:CX", "slack:UY")).toBe("verbose");
    await s.clearUserOverride("slack:UX");
    expect(at(s, "slack:CX", "slack:UX")).toBe("verbose");
  });

  it("a word outside the ladder is refused at load by name — a static scope and defaults.verbosity alike", async () => {
    expect(() => store(VERBOSITY_YAML.replace("verbosity: debug", "verbosity: loud"))).toThrow(
      /channels\.slack:CDEBUG\.verbosity is "loud".*quiet, verbose, debug/,
    );
    expect(() => store(VERBOSITY_YAML.replace("verbosity: verbose", "verbosity: 2"))).toThrow(
      /defaults\.verbosity is "2".*quiet, verbose, debug/,
    );
  });

  it("a scope's severity, intake mode and grant read as words in config show and the config set reply (fmtScope)", async () => {
    const s = store();
    await s.setUserOverride("slack:UX", {
      review: { addressSeverity: "major" },
      intake: { threadReplies: "mention" },
      ship: { grant: { renewals: 2, costCapUsd: 40 } },
    });
    expect(s.describe("slack:CX", "slack:UX")).toMatch(
      /\*Your scope:\* severity `major`, intake `mention`, grant renewals=2 cap=\$40/,
    );
  });

  it("config show names the effective level for the caller, the defaults' word when set, and each scope's own", async () => {
    const s = store(VERBOSITY_YAML);
    const text = s.describe("slack:CDEBUG", "slack:UQUIET");
    expect(text).toMatch(/\*Effective for you in this channel:\*.*verbosity `quiet`/);
    expect(text).toMatch(/\*Defaults:\*.*verbosity `verbose`/);
    expect(text).toMatch(/\*Channel scope:\* verbosity `debug`/);
    expect(text).toMatch(/\*Your scope:\* verbosity `quiet`/);
    // No layer set: the effective line still says quiet; the defaults line says nothing of it.
    const bare = store().describe("slack:CX", "slack:UX");
    expect(bare).toMatch(/\*Effective for you in this channel:\*.*verbosity `quiet`/);
    expect(bare).not.toMatch(/\*Defaults:\*.*verbosity/);
  });
});

describe("effort resolution (the same layers as model)", () => {
  const EFFORT_YAML = `
organization: acme
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
    expect(
      s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: { agent: "review" } }).effort,
    ).toBeUndefined();
  });

  it("defaults.efforts.<agent> is the floor layer", async () => {
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: { agent: "coding" } }).effort).toBe(
      "medium",
    );
  });

  it("per-agent precedence: user efforts > channel efforts > defaults", async () => {
    expect(s.resolve({ channelId: "slack:CPERAGENT", userId: "slack:UX", request: { agent: "coding" } }).effort).toBe(
      "high",
    );
    expect(
      s.resolve({ channelId: "slack:CPERAGENT", userId: "slack:UPERAGENT", request: { agent: "coding" } }).effort,
    ).toBe("low");
  });

  it("a forced effort (user > channel) beats per-agent efforts, and the request directive beats everything", async () => {
    expect(s.resolve({ channelId: "slack:CLOW", userId: "slack:UPERAGENT", request: { agent: "coding" } }).effort).toBe(
      "low",
    );
    expect(s.resolve({ channelId: "slack:CLOW", userId: "slack:UHIGH", request: { agent: "coding" } }).effort).toBe(
      "high",
    );
    expect(
      s.resolve({ channelId: "slack:CLOW", userId: "slack:UHIGH", request: { agent: "coding", effort: "medium" } })
        .effort,
    ).toBe("medium");
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
    expect(() => store(EFFORT_YAML.replace("effort: low", "effort: turbo"))).toThrow(
      /channels\.slack:CLOW\.effort.*turbo.*low, medium, high, xhigh, max/,
    );
    expect(() => store(EFFORT_YAML.replace("    coding: medium", "    coding: turbo"))).toThrow(
      /defaults\.efforts\.coding.*turbo/,
    );
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

  it("a restricted agent admits only those granted agent:run:<name> (admins through `all`)", async () => {
    expect(s.canRunAgent("slack:URANDOM", "coding")).toBe(false);
    expect(s.canRunAgent("slack:UDEV", "coding")).toBe(true);
    expect(s.canRunAgent("slack:UADMIN", "coding")).toBe(true);
  });

  // authorization.md items 14 and 15: handed an Actor, a gate decides on its EFFECTIVE grants.
  it("handed a resolved actor, the gates decide on its effective grants: a relay's app ∩ person, a bound credential's own", async () => {
    const at = { channelId: "slack:CX", threadKey: "slack:CX:1.0" };
    const relayForAdmin = resolveChatActor({ ...at, userId: "slack:UADMIN", postedBy: "slack:bot:B0CLAUDE" }, (id) =>
      s.grantsFor(id),
    );
    expect(s.canRunAgent(relayForAdmin, "coding")).toBe(false); // the unlisted app bounds the admin
    expect(s.canRunAgent(relayForAdmin, "review")).toBe(true); // an open agent stays open
    expect(s.canEditChannelConfig(relayForAdmin)).toBe(false);
    expect(s.canManageRepos(relayForAdmin)).toBe(false);
    const admin = resolveChatActor({ ...at, userId: "slack:UADMIN" }, (id) => s.grantsFor(id));
    expect(s.canRunAgent(admin, "coding")).toBe(true);
    expect(s.canManageRepos(admin)).toBe(true);
    const boundToAdmin = resolveChatActor({ ...at, userId: "slack:UADMIN", authenticatedAs: "http:nobody" }, (id) =>
      s.grantsFor(id),
    );
    expect(s.canRunAgent(boundToAdmin, "coding")).toBe(false); // the credential's grants, not the admin's
  });

  it("restrictedAgentsFor names the restricted agents an actor may NOT run", async () => {
    expect(s.restrictedAgentsFor("slack:URANDOM")).toEqual(["coding"]);
    expect(s.restrictedAgentsFor("slack:UDEV")).toEqual([]);
    expect(s.restrictedAgentsFor("slack:UADMIN")).toEqual([]);
  });

  it("`config:write` is never a baseline: admins and the granted only", async () => {
    expect(s.canEditChannelConfig("slack:URANDOM")).toBe(false);
    expect(s.canEditChannelConfig("slack:UDEV")).toBe(false);
    expect(s.canEditChannelConfig("slack:UADMIN")).toBe(true);
    expect(store(devGranted("{ actions: [config:write] }")).canEditChannelConfig("slack:UDEV")).toBe(true);
  });
});

// Feature: docs/reference/specs/resident-repos.md — per-repo access is open unless the repo
// is listed under `restrict.repos`: then only actors whose `repos` grant
// covers it (or `all`) may use it.
describe("per-repo access (canUseRepo)", () => {
  it("no restrict.repos → every repo is open (open-when-absent)", async () => {
    const s = store(); // YAML_FIXTURE restricts no repo
    expect(s.canUseRepo("slack:URANDOM", "acme/api")).toBe(true);
  });

  const REPOS_FIXTURE = devGranted('{ actions: [agent:run:coding], repos: ["acme/api"] }') + `  repos: ["acme/api"]\n`;

  it("a repo absent from the restrict list stays open", async () => {
    const s = store(REPOS_FIXTURE);
    expect(s.canUseRepo("slack:URANDOM", "acme/other")).toBe(true);
  });

  it("a restricted repo admits the granted and admins, refuses everyone else", async () => {
    const s = store(REPOS_FIXTURE);
    expect(s.canUseRepo("slack:UDEV", "acme/api")).toBe(true);
    expect(s.canUseRepo("slack:UADMIN", "acme/api")).toBe(true);
    expect(s.canUseRepo("slack:URANDOM", "acme/api")).toBe(false);
  });

  // Every caller looks a repo up by a lowercased slug (parseSlug/slugOf/
  // repoResourceId), so a mixed-case restrict entry or grant must still match —
  // otherwise it would silently grant OPEN access instead of restricting.
  it("mixed-case slugs in restrict.repos and in a grant compare case-insensitively", async () => {
    const MIXED = devGranted('{ actions: [agent:run:coding], repos: ["Acme/API"] }') + `  repos: ["Acme/API"]\n`;
    const s = store(MIXED);
    expect(s.canUseRepo("slack:UDEV", "acme/api")).toBe(true);
    expect(s.canUseRepo("slack:UADMIN", "acme/api")).toBe(true);
    // A refused user proves the restriction matched despite the case.
    expect(s.canUseRepo("slack:URANDOM", "acme/api")).toBe(false);
  });

  it("restrict.repos must be owner/name slugs", async () => {
    expect(() => store(YAML_FIXTURE + `  repos: [notaslug]\n`)).toThrow(
      /restrict\.repos: "notaslug" is not an owner\/name slug/,
    );
  });
});

// Feature: docs/reference/specs/resident-repos.md — repo management is FAIL-CLOSED:
// `repo:write` is never a baseline, because onboarding provisions billable
// always-on compute and binds GitHub credentials.
describe("repo management gate (canManageRepos)", () => {
  it("nobody granted repo:write → non-admins refused, admins allowed (fail-closed)", async () => {
    const s = store();
    expect(s.canManageRepos("slack:URANDOM")).toBe(false);
    expect(s.canManageRepos("slack:UDEV")).toBe(false);
    expect(s.canManageRepos("slack:UADMIN")).toBe(true);
  });

  it("a repo:write grant admits its holder; nothing else implies it", async () => {
    const s = store(devGranted("{ actions: [agent:run:coding, repo:write] }"));
    expect(s.canManageRepos("slack:UDEV")).toBe(true);
    expect(s.canManageRepos("slack:UADMIN")).toBe(true);
    expect(s.canManageRepos("slack:URANDOM")).toBe(false);
  });
});

// Feature: docs/reference/specs/authorization.md item 9 — `grantsFor` is the ONE lookup the
// command registry's policy table decides on: a namespace baseline (the open
// chat commands for slack: users, every group's read plus the two personal chat writes for browser sessions,
// nothing for credentials) plus the actor's `grants` entry. FAIL-CLOSED: only
// `all` holds everything, and no such entry means nobody does.
describe("grantsFor — the grants the policy table decides on", () => {
  const holds = (s: ConfigStore, id: string, action: string) => hasAction(s.grantsFor(id).actions, action);
  const storeWith = (yaml: string, options: ConfigStoreOptions) => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, yaml);
    return new ConfigStore(cfg, join(dir, "overrides.json"), options);
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

  it("no `all` entry → nobody holds everything (fail-closed)", async () => {
    const s = store(YAML_FIXTURE.replace(/grants:[\s\S]*$/, ""));
    expect(s.grantsFor("slack:UADMIN")).not.toEqual(ALL_GRANTS);
    expect(holds(s, "slack:UADMIN", "runs:read")).toBe(false);
    expect(holds(s, "slack:URANDOM", "runs:read")).toBe(false);
  });

  it("a slack: entry ADDS to the chat baseline: UDEV granted repo:write also keeps the open commands; friction:write is not implied", async () => {
    const s = store(devGranted("{ actions: [repo:write] }"));
    expect([
      holds(s, "slack:UADMIN", "repo:write"),
      holds(s, "slack:UDEV", "repo:write"),
      holds(s, "slack:URANDOM", "repo:write"),
    ]).toEqual([true, true, false]);
    expect(holds(s, "slack:UDEV", "help:read")).toBe(true);
    expect(holds(s, "slack:UDEV", "friction:write")).toBe(false);
  });

  it("config:write only by grant; agent:run:<name> for a restricted agent only by grant, for an unrestricted agent by baseline", async () => {
    const s = store();
    expect([
      holds(s, "slack:UADMIN", "config:write"),
      holds(s, "slack:UDEV", "config:write"),
      holds(s, "slack:URANDOM", "config:write"),
    ]).toEqual([true, false, false]);
    expect(holds(store(devGranted("{ actions: [config:write] }")), "slack:UDEV", "config:write")).toBe(true);
    expect([
      holds(s, "slack:UADMIN", "agent:run:coding"),
      holds(s, "slack:UDEV", "agent:run:coding"),
      holds(s, "slack:URANDOM", "agent:run:coding"),
      holds(s, "slack:URANDOM", "agent:run:general"),
    ]).toEqual([true, true, false, true]);
    const unrestricted = store(YAML_FIXTURE.replace("restrict:\n  agents: [coding]\n", ""));
    expect(holds(unrestricted, "slack:URANDOM", "agent:run:coding")).toBe(true); // nothing restricted → the agent is open
  });

  it("an Access browser entry adds to the browser baseline (every registered group's read, the two personal chat writes); an unlisted session holds the baseline alone; a service token exactly its entry", async () => {
    const s = storeWith(
      withGrants(
        `  "access:alice@example.com": { actions: [runs:write, friction:write], channels: all }\n  "access:svc:reader-bot": { actions: [runs:read], channels: all }\n`,
      ),
      { commandGroups: ["runs", "friction"] },
    );
    expect(s.grantsFor("access:alice@example.com")).toEqual({
      actions: new Set(["runs:read", "friction:read", "memory:write", "mcp:write", "runs:write", "friction:write"]),
      channels: "all",
      repos: new Set(),
    });
    expect(s.grantsFor("access:stranger")).toEqual({
      actions: new Set(["runs:read", "friction:read", "memory:write", "mcp:write"]),
      channels: new Set(),
      repos: new Set(),
    });
    expect(s.grantsFor("access:svc:reader-bot")).toEqual({
      actions: new Set(["runs:read"]),
      channels: "all",
      repos: new Set(),
    });
    expect(s.grantsFor("access:svc:stranger")).toBe(NO_GRANTS);
    // Without the catalogue's groups the store cannot spell a group read: an unlisted browser session holds nothing.
    expect(store().grantsFor("access:stranger")).toBe(NO_GRANTS);
  });

  it("no admin at all → nobody may manage repos (still closed)", async () => {
    const s = store(YAML_FIXTURE.replace(/grants:[\s\S]*$/m, ""));
    expect(s.canManageRepos("slack:URANDOM")).toBe(false);
  });

  it("a surface entry alone: `access:*` gives every browser session the entry — the org Access admits, granted once; a service token is not a browser session", async () => {
    const s = storeWith(withGrants(`  "access:*": { actions: all, channels: all, repos: all }\n`), {
      commandGroups: ["runs", "friction"],
    });
    expect(s.grantsFor("access:anyone@example.com")).toEqual(ALL_GRANTS);
    expect(s.grantsFor("access:svc:anyone")).toBe(NO_GRANTS);
    expect(holds(s, "slack:URANDOM", "runs:read")).toBe(false);
  });

  it("surface + personal entry: the union — UDEV's own grant adds to `slack:*`, and an entry narrower than the surface entry does not narrow it", async () => {
    const s = store(withGrants(`  "slack:*": { actions: [runs:read, agent:run:coding], channels: [slack:C1] }\n`));
    // Unlisted: baseline + the surface entry.
    expect(holds(s, "slack:URANDOM", "runs:read")).toBe(true);
    expect(holds(s, "slack:URANDOM", "agent:run:coding")).toBe(true);
    expect(s.grantsFor("slack:URANDOM").channels).toEqual(new Set(["slack:C1"]));
    expect(holds(s, "slack:URANDOM", "config:write")).toBe(false);
    // Listed with only agent:run:coding — narrower than the surface entry — still holds runs:read and the channel.
    expect(holds(s, "slack:UDEV", "runs:read")).toBe(true);
    expect(s.grantsFor("slack:UDEV").channels).toEqual(new Set(["slack:C1"]));
    // Listed with more: both.
    const more = store(
      withGrants(`  "slack:*": { actions: [runs:read] }\n`).replace(
        '"slack:UDEV": { actions: [agent:run:coding] }',
        '"slack:UDEV": { actions: [agent:run:coding], channels: [slack:C2] }',
      ),
    );
    expect([holds(more, "slack:UDEV", "runs:read"), holds(more, "slack:UDEV", "agent:run:coding")]).toEqual([
      true,
      true,
    ]);
    expect(more.grantsFor("slack:UDEV").channels).toEqual(new Set(["slack:C2"]));
    expect(more.canRunAgent("slack:UDEV", "coding")).toBe(true);
    expect(more.canRunAgent("slack:URANDOM", "coding")).toBe(false);
  });

  it("grantedPeople lists the Slack people the grants table names, in its order, whatever they hold — never a credential, a surface star or a schedule", () => {
    const s = store(
      withGrants(
        `  "slack:*": { actions: [runs:read] }\n  "access:op-1": { actions: all, channels: all, repos: all }\n  "http:ops": { actions: [runs:read] }\n`,
      ),
    );
    expect(s.grantedPeople()).toEqual(["slack:UADMIN", "slack:UDEV"]);
  });

  it("adminsHint names people, never a surface: `slack:*` holding everything makes everyone an admin, and the hint still points at UADMIN", async () => {
    const s = store(withGrants(`  "slack:*": { actions: all, channels: all, repos: all }\n`));
    expect(s.grantsFor("slack:URANDOM")).toEqual(ALL_GRANTS);
    expect(s.adminsHint()).toBe("slack:UADMIN");
  });
});

// Feature: docs/reference/specs/routing-and-config.md behavior 9 — per-scope custom
// instructions: stored on Scope, capped, advisory only.
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
    expect(r).toEqual({
      agentName: "general",
      agentLayer: "default",
      modelRef: "anthropic/general-model",
      verbosity: "quiet",
    });
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
    writeFileSync(
      overrides,
      JSON.stringify({ users: { "slack:UX": { instructions: "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1) } } }),
    );
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

// Feature: docs/reference/specs/authorization.md — the `grants` block parses fail-closed.
describe("grants config — the one shape", () => {
  const load = (yaml: string, options?: ConstructorParameters<typeof ConfigStore>[2]) => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-grants-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, yaml);
    return new ConfigStore(cfg, join(dir, "overrides.json"), options);
  };
  const set = (...names: string[]) => new Set(names);

  it("a well-formed block validates and grantsFor resolves it: absent axis = empty set, `all` explicit; a credential holds exactly its entry", () => {
    const s = load(
      withGrants(
        `  "http:ci":\n    actions: [dispatch, runs:read]\n    channels: [http:ops]\n  "schedule:self-improvement":\n    actions: [friction:write]\n    channels: all\n`,
      ),
    );
    expect(s.grantsFor("http:ci")).toEqual({
      actions: set("dispatch", "runs:read"),
      channels: set("http:ops"),
      repos: set(),
    });
    expect(s.grantsFor("schedule:self-improvement")).toEqual({
      actions: set("friction:write"),
      channels: "all",
      repos: set(),
    });
    // Credentials hold exactly what names them — no baseline: an unlisted token or schedule holds nothing.
    expect(s.grantsFor("mcp:ci")).toBe(NO_GRANTS);
    expect(s.grantsFor("schedule:unlisted")).toEqual({ actions: set(), channels: set(), repos: set() });
  });

  it("an unknown actor id prefix fails the load naming the id", () => {
    expect(() => load(withGrants(`  "discord:123":\n    actions: all\n`))).toThrow(
      /config\.yaml: grants\["discord:123"\].*slack:, http:, mcp:, access:, schedule:/,
    );
  });

  it("a misspelled `all`, an unknown axis, and a non-mapping block fail the load naming the id and field", () => {
    expect(() => load(withGrants(`  "slack:UA":\n    actions: ALL\n`))).toThrow(
      /grants\["slack:UA"\]\.actions: expected "all" or a list/,
    );
    expect(() => load(withGrants(`  "slack:UA":\n    agents: [coding]\n`))).toThrow(
      /grants\["slack:UA"\]: unknown field agents/,
    );
    expect(() => load(YAML_FIXTURE.replace(/grants:[\s\S]*$/, "grants: [a]\n"))).toThrow(/grants must be a mapping/);
  });

  it("`*` is only ever a whole surface: a partial subject (slack:U*), schedule:*, access:svc:* and agent:* fail the load naming the id", () => {
    for (const id of ["slack:U*", "schedule:*", "access:svc:*", "agent:*"]) {
      expect(() => load(withGrants(`  "${id}":\n    actions: all\n`)), id).toThrow(
        new RegExp(
          `config\\.yaml: grants\\["${id.replace(/\*/g, "\\*")}"\\].*slack:\\*, http:\\*, mcp:\\*, access:\\*`,
        ),
      );
    }
  });

  it("the permission helpers answer from the grants table: adminsHint names the `all` holders, they manage repos and edit channel config, an unlisted user does neither", () => {
    const s = load(withGrants(`  "slack:UMGR":\n    actions: [repo:write]\n`));
    expect(s.adminsHint()).toBe("slack:UADMIN");
    expect([
      s.canManageRepos("slack:UADMIN"),
      s.canManageRepos("slack:UMGR"),
      s.canManageRepos("slack:URANDOM"),
    ]).toEqual([true, true, false]);
    expect([s.canEditChannelConfig("slack:UADMIN"), s.canEditChannelConfig("slack:URANDOM")]).toEqual([true, false]);
    expect(s.grantsFor("slack:URANDOM").actions).not.toContain("config:write");
  });
});

describe("restrict — closed unless granted (authorization.md item 11)", () => {
  it("restrict.agents must name registered agents; restrict.repos owner/name slugs; no other field", () => {
    expect(() => store(YAML_FIXTURE.replace("agents: [coding]", "agents: [nope]"))).toThrow(
      /config\.yaml: restrict\.agents: "nope" is not a registered agent/,
    );
    expect(() => store(YAML_FIXTURE.replace("agents: [coding]", "agents: coding"))).toThrow(
      /restrict\.agents: expected a list of non-empty names/,
    );
    expect(() => store(YAML_FIXTURE + `  channels: [x]\n`)).toThrow(/restrict: unknown field channels/);
  });

  it("no restrict block → nothing is restricted: every agent open, every repo open", () => {
    const s = store(YAML_FIXTURE.replace("restrict:\n  agents: [coding]\n", ""));
    expect(s.canRunAgent("slack:URANDOM", "coding")).toBe(true);
    expect(s.canUseRepo("slack:URANDOM", "acme/api")).toBe(true);
    expect(s.restrictedAgentsFor("slack:URANDOM")).toEqual([]);
  });

  it("an unknown top-level key is refused at load naming it — `permissions` is one, a typo of `grants` another; nothing is mapped or ignored", () => {
    expect(() => store(YAML_FIXTURE + `permissions:\n  admins: ["slack:UADMIN"]\n`)).toThrow(
      /^config\.yaml: unknown key `permissions`$/,
    );
    expect(() => store(YAML_FIXTURE + `grant:\n  slack:UADMIN:\n    actions: all\n`)).toThrow(
      /^config\.yaml: unknown key `grant`$/,
    );
    // A name every object inherits is not a key the document defines.
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      expect(() => store(YAML_FIXTURE + `${key}: 1\n`), key).toThrow(
        new RegExp(`^config\\.yaml: unknown key \`${key}\`$`),
      );
      expect(() => store(`${YAML_FIXTURE}\nselfImprovement:\n  repo: o/r\n  ${key}: 1\n`), key).toThrow(
        new RegExp(`^config\\.yaml: selfImprovement: unknown field ${key}$`),
      );
    }
  });
});

// Feature: docs/reference/specs/run-history.md — the `runHistory` section.
describe("runHistory config", () => {
  const withRunHistory = (block: string, extra = "") => `${YAML_FIXTURE}\n${extra}\nrunHistory:\n${block}\n`;
  const load = (yaml: string) => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, yaml);
    return new ConfigStore(cfg, join(dir, "overrides.json"));
  };

  it("accepts a well-formed section and exposes it", async () => {
    const s = load(
      withRunHistory("  retentionDays: 14\n  maxRuns: 100\n  worker:\n    baseUrl: https://state.example\n"),
    );
    expect(s.config.runHistory).toEqual({
      retentionDays: 14,
      maxRuns: 100,
      worker: { baseUrl: "https://state.example" },
    });
  });

  it("rejects retentionDays 0 and maxRuns 0", async () => {
    expect(() => load(withRunHistory("  retentionDays: 0\n"))).toThrow(
      /runHistory\.retentionDays must be an integer >= 1/,
    );
    expect(() => load(withRunHistory("  maxRuns: 0\n"))).toThrow(/runHistory\.maxRuns must be an integer >= 1/);
  });

  it("rejects an http:// worker baseUrl and an unknown store", async () => {
    expect(() => load(withRunHistory("  worker:\n    baseUrl: http://state.example\n"))).toThrow(
      /runHistory\.worker\.baseUrl must be an https: URL/,
    );
    expect(() => load(withRunHistory("  store: disk\n"))).toThrow(/runHistory\.store must be "worker" or "file"/);
  });
});

// Feature: run-metrics.md item 7 — the `metrics:` reader block is validated at
// load by field: a bad dataset name or a range outside 1..90 is a startup
// error, never a half-wired reader.
describe("metrics config", () => {
  it("loads a well-formed block and refuses a bad dataset name or days by field", () => {
    const s = store(`${YAML_FIXTURE}\nmetrics:\n  dataset: switchboard_runs\n  days: 7\n`);
    expect(s.config.metrics).toEqual({ dataset: "switchboard_runs", days: 7 });
    expect(() => store(`${YAML_FIXTURE}\nmetrics:\n  dataset: 1bad\n`)).toThrow(/metrics\.dataset/);
    expect(() => store(`${YAML_FIXTURE}\nmetrics:\n  dataset: runs\n  days: 91\n`)).toThrow(/metrics\.days/);
  });
});

// Feature: self-improvement.md item 1 — the section is `repo`/`label`/`minRuns`/`top`;
// the friction ledger is run history, so the section carries no ledger keys and
// an unknown field is refused by name, never ignored as if it did something.
describe("selfImprovement", () => {
  it("loads with repo/label/minRuns/top", () => {
    const s = store(`${YAML_FIXTURE}\nselfImprovement:\n  repo: o/r\n  label: friction\n  minRuns: 3\n  top: 2\n`);
    expect(s.config.selfImprovement).toEqual({ repo: "o/r", label: "friction", minRuns: 3, top: 2 });
  });

  it("an unknown field is refused naming it (a ledger key such as `worker` or `ledgerPath` is one); a non-mapping is refused too", () => {
    for (const key of [
      "worker:\n    baseUrl: https://state.example\n",
      "ledgerPath: data/friction.jsonl\n",
      "ledgerMax: 500\n",
      "toop: 3\n",
    ]) {
      expect(() => store(`${YAML_FIXTURE}\nselfImprovement:\n  repo: o/r\n  ${key}`)).toThrow(
        /^config\.yaml: selfImprovement: unknown field (worker|ledgerPath|ledgerMax|toop)$/,
      );
    }
    expect(() => store(`${YAML_FIXTURE}\nselfImprovement: 3\n`)).toThrow(/selfImprovement must be a mapping/);
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 21 — the `routing`
// block: the router's switch and its model, validated at load so a value that
// is not a boolean can never read as on or as off.
describe("routing block (routing.auto, routing.model)", () => {
  it("parses auto and model; an absent block leaves the field unset", () => {
    const s = store(YAML_FIXTURE + "routing:\n  auto: true\n  model: anthropic/fast-model\n");
    expect(s.config.routing).toEqual({ auto: true, model: "anthropic/fast-model" });
    expect(store(YAML_FIXTURE + "routing:\n  auto: false\n").config.routing).toEqual({ auto: false });
    expect(store().config.routing).toBeUndefined();
  });

  it("the router is on by default: no block, or a block naming only the model, routes; `auto: false` is the one way off", () => {
    expect(routingOn(store().config)).toBe(true);
    expect(routingOn(store(YAML_FIXTURE + "routing:\n  model: anthropic/fast-model\n").config)).toBe(true);
    expect(routingOn(store(YAML_FIXTURE + "routing:\n  auto: true\n").config)).toBe(true);
    expect(routingOn(store(YAML_FIXTURE + "routing:\n  auto: false\n").config)).toBe(false);
  });

  it("refuses a non-boolean auto by name, whatever it spells", () => {
    for (const value of ['"yes"', "1", '"true"', "on"])
      expect(() => store(YAML_FIXTURE + `routing:\n  auto: ${value}\n`)).toThrow(/routing\.auto must be true or false/);
  });

  it("refuses a model that is not a <provider>/<model> ref or names a provider the config does not define", () => {
    expect(() => store(YAML_FIXTURE + "routing:\n  model: fast-model\n")).toThrow(
      /routing\.model must be a <provider>\/<model> ref/,
    );
    expect(() => store(YAML_FIXTURE + "routing:\n  model: openai/gpt-5\n")).toThrow(
      /routing\.model names provider "openai", which providers does not define/,
    );
  });

  it("routing.answer is `tool` or `text` — the escape hatch for a provider without forced tool calls; anything else is refused by name", () => {
    expect(store(YAML_FIXTURE + "routing:\n  answer: text\n").config.routing).toEqual({ answer: "text" });
    expect(store(YAML_FIXTURE + "routing:\n  answer: tool\n").config.routing).toEqual({ answer: "tool" });
    for (const value of ['"json"', "true", '"Text"'])
      expect(() => store(YAML_FIXTURE + `routing:\n  answer: ${value}\n`)).toThrow(
        /routing\.answer must be tool or text/,
      );
  });

  it("refuses a non-mapping and an unknown key at load, naming the key", () => {
    expect(() => store(YAML_FIXTURE + "routing: true\n")).toThrow(/routing must be a mapping/);
    expect(() => store(YAML_FIXTURE + "routing:\n  automatic: true\n")).toThrow(
      /routing\.automatic is not a known key/,
    );
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 27 (record 0058) —
// the `intake` block and the `intake` scope field: the thread-reply gate's
// mode, its model, and the load-time card check under the classify default.
describe("intake block and Scope.intake (routing-and-config item 27)", () => {
  it("parses the block; a config without an intake block resolves the default mode classify", () => {
    const s = store(YAML_FIXTURE + "intake:\n  threadReplies: mention\n  model: anthropic/fast-model\n");
    expect(s.config.intake).toEqual({ threadReplies: "mention", model: "anthropic/fast-model" });
    expect(defaultIntakeMode(s.config)).toBe("mention");
    expect(store().config.intake).toBeUndefined();
    expect(defaultIntakeMode(store().config)).toBe("classify");
  });

  it("the intake model resolves intake.model, else routing.model, else defaults.models.general", () => {
    expect(intakeModelRef(store().config)).toBe("anthropic/general-model");
    expect(intakeModelRef(store(YAML_FIXTURE + "routing:\n  model: anthropic/fast-model\n").config)).toBe(
      "anthropic/fast-model",
    );
    expect(
      intakeModelRef(
        store(YAML_FIXTURE + "routing:\n  model: anthropic/fast-model\nintake:\n  model: anthropic/gate-model\n")
          .config,
      ),
    ).toBe("anthropic/gate-model");
  });

  it("refuses an unknown mode by name — a typo can never read as a working setting", () => {
    for (const value of ['"sometimes"', "true", '"Classify"'])
      expect(() => store(YAML_FIXTURE + `intake:\n  threadReplies: ${value}\n`)).toThrow(
        /intake\.threadReplies must be mention, classify or always/,
      );
    expect(() => store(YAML_FIXTURE + "intake: true\n")).toThrow(/intake must be a mapping/);
    expect(() => store(YAML_FIXTURE + "intake:\n  mode: classify\n")).toThrow(/intake\.mode is not a known key/);
  });

  it("refuses intake.model when it is not a <provider>/<model> ref or names an undeclared provider", () => {
    expect(() => store(YAML_FIXTURE + "intake:\n  model: fast-model\n")).toThrow(
      /intake\.model must be a <provider>\/<model> ref/,
    );
    expect(() => store(YAML_FIXTURE + "intake:\n  model: openai/gpt-5\n")).toThrow(
      /intake\.model names provider "openai", which providers does not define/,
    );
  });

  it("a card that supports neither a forced tool call nor the text contract is refused at load when the effective default mode is classify — and loads under mention or always", () => {
    const card = "    models:\n      gate-model:\n        answers: []\n";
    const providers = `organization: acme\nproviders:\n  anthropic:\n    type: anthropic\n    apiKeyEnv: ANTHROPIC_API_KEY\n${card}defaults:\n  agent: general\n  models:\n    general: anthropic/general-model\n`;
    expect(() => store(providers + "intake:\n  model: anthropic/gate-model\n")).toThrow(
      /intake.*neither.*(tool|text)/s,
    );
    // The same card is fine when intake never calls a model by default.
    expect(() => store(providers + "intake:\n  model: anthropic/gate-model\n  threadReplies: always\n")).not.toThrow();
    expect(() => store(providers + "intake:\n  model: anthropic/gate-model\n  threadReplies: mention\n")).not.toThrow();
    // A card that names an answer shape loads under classify.
    const tools = providers.replace("answers: []", 'answers: ["tool"]');
    expect(() => store(tools + "intake:\n  model: anthropic/gate-model\n")).not.toThrow();
    // A card that declares nothing is not refused: both shapes are assumed.
    expect(() => store(YAML_FIXTURE + "intake:\n  model: anthropic/general-model\n")).not.toThrow();
  });

  it("Scope.intake validates by name on channels and users: only threadReplies, only a known mode", () => {
    const withChannel = (block: string) => YAML_FIXTURE.replace("channels:", `channels:\n  "slack:CQUIET":\n${block}`);
    const s = store(withChannel("    intake:\n      threadReplies: mention"));
    expect(s.config.channels?.["slack:CQUIET"]?.intake).toEqual({ threadReplies: "mention" });
    expect(() =>
      store(YAML_FIXTURE.replace("users:", 'users:\n  "slack:UX":\n    intake:\n      threadReplies: sometimes')),
    ).toThrow(/users\.slack:UX\.intake\.threadReplies must be mention, classify or always/);
    expect(() => store(withChannel("    intake:\n      model: anthropic/x"))).toThrow(
      /channels\.slack:CQUIET\.intake\.model is not a known key/,
    );
    expect(() => store(withChannel("    intake: classify"))).toThrow(
      /channels\.slack:CQUIET\.intake must be a mapping/,
    );
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 27 (record 0058) —
// the thread scope: `Overrides.threads[threadKey]` is a third map in the one
// overrides document, read by `intakeModeFor` for `intake.threadReplies` only,
// above the user and channel layers.
describe("the thread scope and intakeModeFor (routing-and-config item 27)", () => {
  const THREAD = "slack:CX:1.0";
  const storeOver = async (backing: InMemoryOverridesBacking) => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, YAML_FIXTURE);
    return new ConfigStore(cfg, { backing, initial: await backing.load() });
  };

  it("resolves thread over user over channel over the default: each layer set in turn wins over the ones below", async () => {
    const backing = new InMemoryOverridesBacking();
    const s = await storeOver(backing);
    expect(s.intakeModeFor(THREAD, "slack:UX", "slack:CX")).toBe("classify"); // the code's default
    await s.setChannelOverride("slack:CX", { intake: { threadReplies: "always" } });
    expect(s.intakeModeFor(THREAD, "slack:UX", "slack:CX")).toBe("always");
    await s.setUserOverride("slack:UX", { intake: { threadReplies: "classify" } });
    expect(s.intakeModeFor(THREAD, "slack:UX", "slack:CX")).toBe("classify");
    await s.setThreadOverride(THREAD, { intake: { threadReplies: "mention" } });
    expect(s.intakeModeFor(THREAD, "slack:UX", "slack:CX")).toBe("mention");
    // Another thread in the same channel is untouched by the thread layer.
    expect(s.intakeModeFor("slack:CX:2.0", "slack:UX", "slack:CX")).toBe("classify");
    // A userless event skips the user layer — never resolved for a made-up id.
    expect(s.intakeModeFor("slack:CX:2.0", undefined, "slack:CX")).toBe("always");
    // The write persisted `threads` beside channels and users in the ONE document.
    expect(backing.document?.threads).toEqual({ [THREAD]: { intake: { threadReplies: "mention" } } });
  });

  it("the top-level intake block is the defaults layer under the three scopes", () => {
    const s = store(YAML_FIXTURE + "intake:\n  threadReplies: mention\n");
    expect(s.intakeModeFor(THREAD, "slack:UX", "slack:CX")).toBe("mention");
  });

  it("clearThreadOverride drops the thread's scope so the user layer shows through again", async () => {
    const backing = new InMemoryOverridesBacking();
    const s = await storeOver(backing);
    await s.setUserOverride("slack:UX", { intake: { threadReplies: "always" } });
    await s.setThreadOverride(THREAD, { intake: { threadReplies: "mention" } });
    await s.clearThreadOverride(THREAD);
    expect(s.intakeModeFor(THREAD, "slack:UX", "slack:CX")).toBe("always");
    expect(backing.document?.threads).toEqual({});
  });

  it("a stored thread scope with an unknown mode or key is refused at construction naming the path — never read as a default", async () => {
    const bad = new InMemoryOverridesBacking({
      channels: {},
      users: {},
      threads: { [THREAD]: { intake: { threadReplies: "sometimes" as "classify" } } },
    });
    await expect(storeOver(bad)).rejects.toThrow(
      /threads\.slack:CX:1\.0\.intake\.threadReplies must be mention, classify or always/,
    );
    const badKey = new InMemoryOverridesBacking({
      channels: {},
      users: {},
      threads: { [THREAD]: { intake: { mode: "classify" } as { threadReplies?: "classify" } } },
    });
    await expect(storeOver(badKey)).rejects.toThrow(/threads\.slack:CX:1\.0\.intake\.mode is not a known key/);
  });
});

// Feature: docs/reference/specs/harness.md item 8; harness-pi.md item 1 — the
// `harness` block puts a preset on a harness by the name the harness object
// declares: `pi` or `opencode`, the roster's two words, read off the roster
// (`HARNESS_NAMES`) so the validator spells no list of its own. A preset the
// block does not name runs on pi; nothing defaults to OpenCode. Any other word
// — `codex`, `native` (the deleted loop), a typo — fails the load naming the
// words the roster has, so no setting reads as "this preset runs on X" while
// nothing does.
describe("harness block (harness.<preset>: pi or opencode)", () => {
  it("parses a mapping of presets to the roster's words; an absent block leaves the field unset (every preset on pi)", () => {
    expect(store(YAML_FIXTURE + "harness:\n  coding: opencode\n  review: pi\n").config.harness).toEqual({
      coding: "opencode",
      review: "pi",
    });
    expect(store(YAML_FIXTURE + "harness:\n  coding: pi\n  review: pi\n").config.harness).toEqual({
      coding: "pi",
      review: "pi",
    });
    expect(store().config.harness).toBeUndefined();
  });

  it("refuses a preset the registry does not know, naming it", () => {
    expect(() => store(YAML_FIXTURE + "harness:\n  codng: opencode\n")).toThrow(/harness\.codng is not a known agent/);
  });

  it("refuses a word that is not a harness by name — codex, native, a case slip, a non-string — naming the two harnesses", () => {
    expect(() => store(YAML_FIXTURE + "harness:\n  coding: codex\n")).toThrow(
      /harness\.coding: codex is not a harness; the harnesses are pi and opencode/,
    );
    expect(() => store(YAML_FIXTURE + "harness:\n  coding: native\n")).toThrow(
      /harness\.coding: native is not a harness; the harnesses are pi and opencode/,
    );
    expect(() => store(YAML_FIXTURE + "harness:\n  coding: OpenCode\n")).toThrow(
      /harness\.coding: OpenCode is not a harness; the harnesses are pi and opencode/,
    );
    expect(() => store(YAML_FIXTURE + "harness:\n  coding: true\n")).toThrow(
      /harness\.coding: true is not a harness; the harnesses are pi and opencode/,
    );
  });

  it("refuses a non-mapping at load, naming the shape", () => {
    expect(() => store(YAML_FIXTURE + "harness: opencode\n")).toThrow(
      /harness must be a mapping of preset to a harness name \(pi or opencode\)/,
    );
    expect(() => store(YAML_FIXTURE + "harness:\n  - coding\n")).toThrow(
      /harness must be a mapping of preset to a harness name \(pi or opencode\)/,
    );
  });
});

// Feature: docs/reference/specs/routing-and-config.md items 2, 5 and 12;
// harness.md item 8 — the harness word is a scope setting: `harness.<preset>`
// under `channels.<id>` and `users.<id>` (static, or written at run time by
// `config set … --harness.<preset>`) resolves user > channel > the
// deployment's top-level block, with no request directive and no thread
// stickiness; a preset no layer names resolves to no word, and the loop opens
// it on pi. Every layer is held to the roster's words at load and on write, a
// hand-edited or stored overrides document included — a word that read as
// "your runs are on X" while nothing was would be the worst kind of quiet.
describe("harness as a scope setting (users.<id>.harness, channels.<id>.harness)", () => {
  const HARNESS_BASE = `
organization: acme
providers:
  anthropic:
    type: anthropic
defaults:
  agent: general
  models:
    general: anthropic/general-model
    coding: anthropic/coding-model
    review: anthropic/review-model
`;
  const HARNESS_YAML =
    HARNESS_BASE +
    `harness:
  review: opencode
channels:
  "slack:COC":
    harness:
      coding: opencode
  "slack:CPI":
    harness:
      coding: pi
      review: pi
users:
  "slack:UPI":
    harness:
      coding: pi
  "slack:UOC":
    harness:
      general: opencode
`;
  const at = (s: ConfigStore, channelId: string, userId: string, agent: string) =>
    s.resolve({ channelId, userId, request: { agent } }).harness;

  it("resolves user > channel > the deployment's block, each naming the scope whose word won; an unset layer falls through; a preset no layer names resolves to no word", () => {
    const s = store(HARNESS_YAML);
    // Nothing names coding on this path: no word, so the loop opens it on pi.
    expect(at(s, "slack:CX", "slack:UX", "coding")).toBeUndefined();
    // The deployment's top-level block is the defaults layer.
    expect(at(s, "slack:CX", "slack:UX", "review")).toEqual({ name: "opencode", scope: "defaults" });
    // A channel's word beats the deployment's; a user's beats the channel's.
    expect(at(s, "slack:COC", "slack:UX", "coding")).toEqual({ name: "opencode", scope: "channel" });
    expect(at(s, "slack:CPI", "slack:UX", "review")).toEqual({ name: "pi", scope: "channel" });
    expect(at(s, "slack:COC", "slack:UPI", "coding")).toEqual({ name: "pi", scope: "user" });
    // A user's word for another preset is not this preset's: it falls through to the channel's.
    expect(at(s, "slack:COC", "slack:UOC", "coding")).toEqual({ name: "opencode", scope: "channel" });
    expect(at(s, "slack:COC", "slack:UOC", "general")).toEqual({ name: "opencode", scope: "user" });
    // The triple is untouched beside it.
    expect(s.resolve({ channelId: "slack:COC", userId: "slack:UPI", request: { agent: "coding" } })).toEqual({
      agentName: "coding",
      agentLayer: "request",
      verbosity: "quiet",
      modelRef: "anthropic/coding-model",
      harness: { name: "pi", scope: "user" },
    });
  });

  it("runtime overrides set the word per scope, win over the static word for the same scope, persist through the store and clear", async () => {
    const s = store(HARNESS_YAML);
    await s.setUserOverride("slack:UPI", { harness: { coding: "opencode" } });
    expect(at(s, "slack:CPI", "slack:UPI", "coding")).toEqual({ name: "opencode", scope: "user" });
    await s.setChannelOverride("slack:CPI", { harness: { review: "opencode" } });
    expect(at(s, "slack:CPI", "slack:UX", "review")).toEqual({ name: "opencode", scope: "channel" });
    await s.clearUserOverride("slack:UPI");
    expect(at(s, "slack:CPI", "slack:UPI", "coding")).toEqual({ name: "pi", scope: "user" }); // the static word shows through
    await s.setUserOverride("slack:UX", { harness: { coding: "opencode" } });
    expect(at(s, "slack:CX", "slack:UX", "coding")).toEqual({ name: "opencode", scope: "user" });
    await s.clearUserOverride("slack:UX");
    expect(at(s, "slack:CX", "slack:UX", "coding")).toBeUndefined();
  });

  it("a word that is not a harness, an unknown preset and a non-mapping under a channel or a user fail the load by name — the path and the two harnesses", () => {
    expect(() => store(HARNESS_BASE + 'users:\n  "slack:UBAD":\n    harness:\n      coding: codex\n')).toThrow(
      /config\.yaml: users\.slack:UBAD\.harness\.coding: codex is not a harness; the harnesses are pi and opencode/,
    );
    expect(() => store(HARNESS_BASE + 'channels:\n  "slack:CBAD":\n    harness:\n      review: OpenCode\n')).toThrow(
      /channels\.slack:CBAD\.harness\.review: OpenCode is not a harness; the harnesses are pi and opencode/,
    );
    expect(() => store(HARNESS_BASE + 'channels:\n  "slack:CBAD":\n    harness:\n      codng: opencode\n')).toThrow(
      /config\.yaml: channels\.slack:CBAD\.harness\.codng is not a known agent/,
    );
    expect(() => store(HARNESS_BASE + 'users:\n  "slack:UBAD":\n    harness: opencode\n')).toThrow(
      /users\.slack:UBAD\.harness must be a mapping of preset to a harness name \(pi or opencode\)/,
    );
  });

  it("a scope that is not a mapping — a scalar or a list under a channel or user id — is refused by name before its harness is read", () => {
    expect(() =>
      validateHarnessWords({ users: { "slack:UBAD": "opencode" as unknown as Scope } }, "config.yaml"),
    ).toThrow(/^config\.yaml: users\.slack:UBAD must be a mapping of settings$/);
    expect(() =>
      validateHarnessWords({ channels: { "slack:CBAD": null as unknown as Scope } }, "overrides (in-memory)"),
    ).toThrow(/^overrides \(in-memory\): channels\.slack:CBAD must be a mapping of settings$/);
    expect(() =>
      validateHarnessWords({ channels: { "slack:CBAD": ["coding"] as unknown as Scope } }, "config.yaml"),
    ).toThrow(/channels\.slack:CBAD must be a mapping of settings/);
    expect(() => validateHarnessWords({ users: { "slack:UX": {} } }, "config.yaml")).not.toThrow();
  });

  it("`defaults.harness` is refused by name pointing at the top-level block — the deployment's words have one spelling", () => {
    expect(() => store(HARNESS_BASE.replace("defaults:\n", "defaults:\n  harness:\n    coding: opencode\n"))).toThrow(
      /config\.yaml: defaults\.harness is not a key; the deployment's harness words are the top-level harness block/,
    );
  });

  it("a stored overrides document is held to the same rule at load, naming the backing and the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, HARNESS_BASE);
    const overrides = join(dir, "overrides.json");
    writeFileSync(overrides, JSON.stringify({ channels: {}, users: { "slack:UX": { harness: { coding: "codex" } } } }));
    expect(() => new ConfigStore(cfg, overrides)).toThrow(
      /overrides \(file .*overrides\.json\): users\.slack:UX\.harness\.coding: codex is not a harness; the harnesses are pi and opencode/,
    );
    writeFileSync(overrides, JSON.stringify({ channels: { "slack:CX": { harness: { wizard: "pi" } } }, users: {} }));
    expect(() => new ConfigStore(cfg, overrides)).toThrow(
      /overrides \(file .*\): channels\.slack:CX\.harness\.wizard is not a known agent/,
    );
    writeFileSync(
      overrides,
      JSON.stringify({ channels: {}, users: { "slack:UX": { harness: { coding: "opencode" } } } }),
    );
    expect(at(new ConfigStore(cfg, overrides), "slack:CX", "slack:UX", "coding")).toEqual({
      name: "opencode",
      scope: "user",
    });
  });

  it("config show renders the effective harness per named preset with the scope that set it, the defaults' words and each scope's own — and no harness line when no layer names one", () => {
    const s = store(HARNESS_YAML);
    const text = s.describe("slack:COC", "slack:UPI");
    expect(text).toContain("*Effective harness:* coding `pi` (user), review `opencode` (defaults)");
    expect(text).toMatch(/\*Defaults:\*.*harness `review=opencode`/);
    expect(text).toMatch(/\*Channel scope:\* harness `coding=opencode`/);
    expect(text).toMatch(/\*Your scope:\* harness `coding=pi`/);
    expect(s.describeConfig("slack:COC", "slack:UPI").effective.harness).toEqual({
      coding: { name: "pi", scope: "user" },
      review: { name: "opencode", scope: "defaults" },
    });
    const plain = store();
    expect(plain.describe("slack:CX", "slack:UX")).not.toContain("harness");
    expect(plain.describeConfig("slack:CX", "slack:UX").effective).not.toHaveProperty("harness");
  });
});

// Feature: docs/reference/specs/agent-ship.md item 8 — the `ship` caps block: pipeline
// wall clock + review-round cap, deployment-level like the sibling `review`
// block, validated at load so a typo cannot silently become "no cap".
// Feature: docs/reference/specs/agent-conductor.md item 5 — the fan-out cap a
// spawning run meets, one knob validated at load like the ship caps.
describe("spawn block (spawn.maxChildren)", () => {
  it("parses maxChildren; an absent block leaves the field unset and the cap at its default of 3", () => {
    const s = store(YAML_FIXTURE + "spawn:\n  maxChildren: 5\n");
    expect(s.config.spawn).toEqual({ maxChildren: 5 });
    expect(maxChildrenOf(s.config.spawn)).toBe(5);
    expect(store().config.spawn).toBeUndefined();
    expect(maxChildrenOf(undefined)).toBe(DEFAULT_MAX_CHILDREN);
    expect(maxChildrenOf({})).toBe(3);
  });

  it("refuses 0, a fraction, a non-mapping and an unknown key at load, naming the key", () => {
    expect(() => store(YAML_FIXTURE + "spawn:\n  maxChildren: 0\n")).toThrow(
      /spawn\.maxChildren must be an integer >= 1/,
    );
    expect(() => store(YAML_FIXTURE + "spawn:\n  maxChildren: 2.5\n")).toThrow(
      /spawn\.maxChildren must be an integer >= 1/,
    );
    expect(() => store(YAML_FIXTURE + 'spawn: "three"\n')).toThrow(/spawn must be a mapping/);
    expect(() => store(YAML_FIXTURE + "spawn:\n  maxDepth: 2\n")).toThrow(/spawn\.maxDepth is not a known key/);
  });
});

describe("ship caps block (agent:ship pipeline)", () => {
  it("parses maxRounds/maxMinutes; absent block leaves the field unset", async () => {
    const s = store(YAML_FIXTURE + "ship:\n  maxRounds: 2\n  maxMinutes: 180\n");
    expect(s.config.ship).toEqual({ maxRounds: 2, maxMinutes: 180 });
    expect(store().config.ship).toBeUndefined();
  });

  it("rejects non-integers and values < 1 at load, naming the key", async () => {
    expect(() => store(YAML_FIXTURE + "ship:\n  maxRounds: 0\n")).toThrow(/ship\.maxRounds must be an integer >= 1/);
    expect(() => store(YAML_FIXTURE + "ship:\n  maxMinutes: 1.5\n")).toThrow(/ship\.maxMinutes must be an integer/);
    expect(() => store(YAML_FIXTURE + 'ship: "nope"\n')).toThrow(/ship must be a mapping/);
  });

  // agent-ship.md item 8, decision 0046: the fit at config load — the pipeline
  // holds its first child at its ask and every later round at its floor, or
  // the config is refused naming the sum, never left to cap out on every unit.
  it("a ship pipeline that cannot hold its loop is refused with the sum: 40 minutes against the 163 three review rounds need, 180 against the 189 four need; 163 at three rounds loads, and the default 240 at three rounds loads", async () => {
    expect(() => store(YAML_FIXTURE + "ship:\n  maxMinutes: 40\n")).toThrow(
      /ship\.maxMinutes 40 cannot hold the loop ship\.maxRounds 3 allows — 163 minutes are needed \(3 to provision, the coding child's 90, and the reserve for 3 review rounds at their floors\)/,
    );
    expect(() => store(YAML_FIXTURE + "ship:\n  maxRounds: 4\n  maxMinutes: 180\n")).toThrow(
      /ship\.maxMinutes 180 cannot hold the loop ship\.maxRounds 4 allows — 189 minutes are needed/,
    );
    expect(store(YAML_FIXTURE + "ship:\n  maxMinutes: 163\n").config.ship).toEqual({ maxMinutes: 163 });
    expect(store(YAML_FIXTURE + "ship:\n  maxRounds: 3\n").config.ship).toEqual({ maxRounds: 3 });
  });

  // docs/reference/specs/agent-ship.md item 16: the plan runner is the one ship
  // implementation, so the switch that once chose it is refused at load by
  // name — a config still carrying `ship.coordinator` is told to drop it rather
  // than left believing it chose anything; any other unknown key is refused too.
  it("ship.coordinator is refused at load by name, whatever its value; any other unknown ship key is refused by name", async () => {
    for (const value of ["true", "false", '"yes"'])
      expect(() => store(YAML_FIXTURE + `ship:\n  coordinator: ${value}\n`)).toThrow(
        /ship\.coordinator is no longer a key — every agent:ship request runs on the plan runner; remove it \(docs\/reference\/migrations\.md\)/,
      );
    expect(() => store(YAML_FIXTURE + "ship:\n  maxRounds: 2\n  coordinator: true\n")).toThrow(
      /ship\.coordinator is no longer a key/,
    );
    expect(() => store(YAML_FIXTURE + "ship:\n  maxRunds: 2\n")).toThrow(/ship\.maxRunds is not a known key/);
  });

  it("review.addressSeverity: parsed at load on the org block and the scopes, refused by name outside the ladder — and no longer a ship key; resolveAddressSeverity layers directive > user > channel > org with the default minor as the org's", async () => {
    expect(store(YAML_FIXTURE + "review:\n  addressSeverity: major\n").config.review).toEqual({
      addressSeverity: "major",
    });
    expect(() => store(YAML_FIXTURE + "review:\n  addressSeverity: huge\n")).toThrow(
      /review\.addressSeverity must be one of blocking, major, minor, nit/,
    );
    const channelScoped = YAML_FIXTURE.replace(
      '  "slack:CREVIEW":',
      '  "slack:CNIT":\n    review:\n      addressSeverity: nit\n  "slack:CREVIEW":',
    );
    expect(store(channelScoped).scopes("slack:CNIT", "slack:UHUGE").channel.review).toEqual({ addressSeverity: "nit" });
    const userScoped = YAML_FIXTURE.replace(
      '  "slack:UFORCED":',
      '  "slack:UHUGE":\n    review:\n      addressSeverity: huge\n  "slack:UFORCED":',
    );
    expect(() => store(userScoped)).toThrow(
      /users\.slack:UHUGE\.review\.addressSeverity must be one of blocking, major, minor, nit/,
    );
    // The knob moved off `ship` when the gate moved into the verdict parser:
    // the old path is refused naming the move, on the org block and on a
    // scope alike (a stored `config set … --ship.addressSeverity` from before
    // the move is named, never ignored into "no gate").
    expect(() => store(YAML_FIXTURE + "ship:\n  addressSeverity: major\n")).toThrow(
      /ship\.addressSeverity moved to review\.addressSeverity — the severity to address now gates every review/,
    );
    const staleScope = YAML_FIXTURE.replace(
      '  "slack:UFORCED":',
      '  "slack:USTALE":\n    ship:\n      addressSeverity: major\n  "slack:UFORCED":',
    );
    expect(() => store(staleScope)).toThrow(
      /users\.slack:USTALE\.ship\.addressSeverity moved to users\.slack:USTALE\.review\.addressSeverity/,
    );
    expect(resolveAddressSeverity({})).toEqual({ level: "minor", source: "org" });
    expect(resolveAddressSeverity({ org: "nit" })).toEqual({ level: "nit", source: "org" });
    expect(resolveAddressSeverity({ org: "nit", channel: "major" })).toEqual({ level: "major", source: "channel" });
    expect(resolveAddressSeverity({ channel: "major", user: "blocking" })).toEqual({
      level: "blocking",
      source: "user",
    });
    expect(resolveAddressSeverity({ user: "blocking", run: "nit" })).toEqual({ level: "nit", source: "run" });
  });

  it("ship.grant: parsed at load on the org block and the scopes, refused by name when malformed; resolveGrant layers a directive's count > user > channel > org with zero renewals and no cap as the org's default", async () => {
    expect(store(YAML_FIXTURE + "ship:\n  grant:\n    renewals: 3\n    costCapUsd: 40\n").config.ship).toEqual({
      grant: { renewals: 3, costCapUsd: 40 },
    });
    expect(store(YAML_FIXTURE + "ship:\n  grant:\n    renewals: 0\n").config.ship).toEqual({ grant: { renewals: 0 } });
    expect(() => store(YAML_FIXTURE + "ship:\n  grant:\n    renewals: 13\n")).toThrow(
      /ship\.grant\.renewals must be an integer from 0 to 12/,
    );
    expect(() => store(YAML_FIXTURE + "ship:\n  grant:\n    renewals: 1.5\n")).toThrow(
      /ship\.grant\.renewals must be an integer from 0 to 12/,
    );
    expect(() => store(YAML_FIXTURE + "ship:\n  grant:\n    costCapUsd: 0\n")).toThrow(
      /ship\.grant\.costCapUsd must be a positive number of dollars/,
    );
    expect(() => store(YAML_FIXTURE + "ship:\n  grant:\n    costCapUsd: 5\n    segments: 2\n")).toThrow(
      /ship\.grant: unknown field segments/,
    );
    expect(() => store(YAML_FIXTURE + "ship:\n  grant: 3\n")).toThrow(/ship\.grant must be a mapping/);
    expect(
      store(
        YAML_FIXTURE.replace(
          "channels:\n",
          'channels:\n  "slack:CGRANT":\n    ship:\n      grant:\n        renewals: 6\n',
        ),
      ).config.channels?.["slack:CGRANT"]?.ship,
    ).toEqual({ grant: { renewals: 6 } });
    expect(() =>
      store(
        YAML_FIXTURE.replace("users:\n", 'users:\n  "slack:UGRANT":\n    ship:\n      grant:\n        renewals: -1\n'),
      ),
    ).toThrow(/users\.slack:UGRANT\.ship\.grant\.renewals must be an integer from 0 to 12/);
    expect(resolveGrant({})).toEqual({ grant: { renewals: 0 }, source: "org" });
    expect(resolveGrant({ org: { renewals: 2, costCapUsd: 20 } })).toEqual({
      grant: { renewals: 2, costCapUsd: 20 },
      source: "org",
    });
    expect(resolveGrant({ org: { renewals: 2 }, channel: { renewals: 6, costCapUsd: 50 } })).toEqual({
      grant: { renewals: 6, costCapUsd: 50 },
      source: "channel",
    });
    expect(resolveGrant({ channel: { renewals: 6, costCapUsd: 50 }, user: { renewals: 1 } })).toEqual({
      grant: { renewals: 1 },
      source: "user",
    });
    // A directive sets the count and keeps the cap the scopes set: a person
    // may spend renewals by hand, never widen the dollars.
    expect(resolveGrant({ channel: { renewals: 6, costCapUsd: 50 }, run: 2 })).toEqual({
      grant: { renewals: 2, costCapUsd: 50 },
      source: "run",
    });
    expect(resolveGrant({ run: 0 })).toEqual({ grant: { renewals: 0 }, source: "run" });
  });

  it("ship.idleDays (record 0051): accepts 0 and 365 on the org block and a scope, refuses 366, -1 and a string by name; resolveIdleDays layers user > channel > org with 0 as the default", () => {
    expect(store(YAML_FIXTURE + "ship:\n  idleDays: 0\n").config.ship).toEqual({ idleDays: 0 });
    expect(store(YAML_FIXTURE + "ship:\n  idleDays: 365\n").config.ship).toEqual({ idleDays: 365 });
    expect(() => store(YAML_FIXTURE + "ship:\n  idleDays: 366\n")).toThrow(
      /ship\.idleDays must be an integer from 0 to 365/,
    );
    expect(() => store(YAML_FIXTURE + "ship:\n  idleDays: -1\n")).toThrow(
      /ship\.idleDays must be an integer from 0 to 365/,
    );
    expect(() => store(YAML_FIXTURE + 'ship:\n  idleDays: "seven"\n')).toThrow(
      /ship\.idleDays must be an integer from 0 to 365/,
    );
    // The scope field (routing-and-config item 2): a channel's or a user's
    // `ship.idleDays`, held to the same bounds and refused naming the path.
    expect(
      store(YAML_FIXTURE.replace("channels:\n", 'channels:\n  "slack:CIDLE":\n    ship:\n      idleDays: 7\n')).config
        .channels?.["slack:CIDLE"]?.ship,
    ).toEqual({ idleDays: 7 });
    expect(() =>
      store(YAML_FIXTURE.replace("users:\n", 'users:\n  "slack:UIDLE":\n    ship:\n      idleDays: 366\n')),
    ).toThrow(/users\.slack:UIDLE\.ship\.idleDays must be an integer from 0 to 365/);
    expect(() =>
      store(YAML_FIXTURE.replace("users:\n", 'users:\n  "slack:UIDLE":\n    ship:\n      idleDays: half\n')),
    ).toThrow(/users\.slack:UIDLE\.ship\.idleDays must be an integer from 0 to 365/);
    // Resolution: user over channel over org, the default 0 — nothing idles until someone says so.
    expect(resolveIdleDays({})).toBe(0);
    expect(resolveIdleDays({ org: 7 })).toBe(7);
    expect(resolveIdleDays({ org: 7, channel: 14 })).toBe(14);
    expect(resolveIdleDays({ org: 7, channel: 14, user: 3 })).toBe(3);
    expect(resolveIdleDays({ channel: 14, user: 0 })).toBe(0);
  });

  it("a stored overrides document's `ship.grant` is held to the same rule at load, naming the backing — the one way around the chat command's validation is refused too", () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, YAML_FIXTURE);
    const overrides = join(dir, "overrides.json");
    writeFileSync(overrides, JSON.stringify({ channels: { "slack:CGRANT": { ship: { grant: { renewals: 999 } } } } }));
    expect(() => new ConfigStore(cfg, overrides)).toThrow(
      /overrides.*channels\.slack:CGRANT\.ship\.grant\.renewals must be an integer from 0 to 12/,
    );
    writeFileSync(overrides, JSON.stringify({ users: { "slack:UGRANT": { ship: { grant: { costCapUsd: 0 } } } } }));
    expect(() => new ConfigStore(cfg, overrides)).toThrow(
      /overrides.*users\.slack:UGRANT\.ship\.grant\.costCapUsd must be a positive number of dollars/,
    );
    writeFileSync(overrides, JSON.stringify({ users: { "slack:UGRANT": { ship: { grant: { renewals: 2 } } } } }));
    expect(new ConfigStore(cfg, overrides).scopes("slack:CX", "slack:UGRANT").user.ship).toEqual({
      grant: { renewals: 2 },
    });
  });

  it("shipPresetFor: the ship preset as this deployment declares it — the registry's def with `ship.maxMinutes` as its budget, the default being the def's own; always a copy", () => {
    expect(SHIP_DEFAULT_MAX_MINUTES).toBe(AGENTS.ship.maxMinutes);
    expect(shipPresetFor(undefined)).toEqual(AGENTS.ship);
    expect(shipPresetFor(undefined)).not.toBe(AGENTS.ship);
    expect(shipPresetFor({ maxRounds: 1 })).toEqual(AGENTS.ship);
    expect(shipPresetFor({ maxMinutes: 45 })).toEqual({ ...AGENTS.ship, maxMinutes: 45 });
    expect(shipPresetFor({ maxMinutes: 45 }).maxMinutes).toBe(resolveShipCaps({ maxMinutes: 45 }).maxMinutes);
    expect(AGENTS.ship.maxMinutes).toBe(240); // the shared def is never mutated
  });

  it("the example config (config/config.example.yaml) still loads through ConfigStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-example-"));
    expect(
      () => new ConfigStore(join(process.cwd(), "config/config.example.yaml"), join(dir, "overrides.json")),
    ).not.toThrow();
  });
});

// Feature: docs/reference/specs/routing-and-config.md — the example config's provider
// blocks are real configurations, not prose: the OpenRouter block ships live and the
// example loads as shipped with it; the blocks still commented (Groq, a local server)
// load and build once turned on.
describe("the example config's provider blocks", () => {
  const EXAMPLE = readFileSync(join(process.cwd(), "config/config.example.yaml"), "utf8");
  const OPENROUTER = {
    type: "openai-compatible",
    wire: "openai-chat",
    vendor: "model",
    catalog: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  };

  /** The example with one commented `providers.<name>` block turned on: its `# <name>:` line and
   *  the `#   key: value` lines under it lose their `# `; every other comment stays one. */
  const uncommented = (name: string): string => {
    const lines = EXAMPLE.split("\n");
    const start = lines.indexOf(`  # ${name}:`);
    if (start < 0) throw new Error(`no commented provider block "${name}" in config.example.yaml`);
    lines[start] = `  ${name}:`;
    for (let i = start + 1; i < lines.length && lines[i].startsWith("  #   "); i++) {
      lines[i] = `  ${lines[i].slice(4)}`;
    }
    return lines.join("\n");
  };

  /** The example with one line edited; a replacement that changes nothing is a test bug, not a pass. */
  const edited = (from: string, to: string): string => {
    const yaml = EXAMPLE.replace(from, to);
    if (yaml === EXAMPLE) throw new Error(`config.example.yaml has no line ${JSON.stringify(from)}`);
    return yaml;
  };

  const storeFrom = (yaml: string): ConfigStore => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-example-provider-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, yaml);
    return new ConfigStore(cfg, join(dir, "overrides.json"));
  };

  /** A pi API answering every stream with one text message, so a completion proves the call reached it. */
  const scriptedApi = (provider: string): ProviderStreams => {
    const stream: ProviderStreams["stream"] = (model) => {
      const message: PiAssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: model.api,
        provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      };
      const out = createAssistantMessageEventStream();
      out.push({ type: "done", reason: "stop", message });
      return out;
    };
    return { stream, streamSimple: stream };
  };

  const request: CompletionRequest = {
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTokens: 50,
  };

  // Feature: docs/reference/specs/harness-pi.md item 13 — the block is the one
  // the router and reflection reach OpenRouter through, on pi's library.
  it("the OpenRouter block ships live: the example loads as shipped with it, every default model still on the anthropic block, and pi's library builds one openai-completions provider from it — a trailing slash on baseUrl kept by the loader and stripped by the reader", () => {
    const store = storeFrom(EXAMPLE);
    expect(store.config.providers.openrouter).toEqual(OPENROUTER);
    expect(Object.keys(store.config.providers)).toEqual(["anthropic", "openai", "openrouter"]);
    for (const ref of Object.values(store.config.defaults.models)) expect(ref).toMatch(/^anthropic\//);
    const provider = new PiAiProviders(store.config.providers, { secrets: secretsFrom({}) }).get("openrouter");
    expect(provider).toMatchObject({
      name: "openrouter",
      api: "openai-completions",
      baseUrl: OPENROUTER.baseUrl,
      keyEnv: OPENROUTER.apiKeyEnv,
    });
    const slashed = storeFrom(edited(`baseUrl: ${OPENROUTER.baseUrl}\n`, `baseUrl: ${OPENROUTER.baseUrl}/\n`));
    expect(slashed.config.providers.openrouter.baseUrl).toBe(`${OPENROUTER.baseUrl}/`);
    expect(new PiAiProviders(slashed.config.providers, { secrets: secretsFrom({}) }).get("openrouter").baseUrl).toBe(
      OPENROUTER.baseUrl,
    );
  });

  it("reads no key at construction: a process without OPENROUTER_API_KEY loads the example and completes on the anthropic block as today; only a call on the openrouter block fails, by the variable's name, at the first model call", async () => {
    const asked: string[] = [];
    const env = secretsFrom({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const secrets: Secrets = {
      ...env,
      named: (name) => {
        asked.push(name);
        return env.named(name);
      },
    };
    const table = new PiAiProviders(storeFrom(EXAMPLE).config.providers, {
      secrets,
      apis: { "anthropic-messages": scriptedApi("anthropic"), "openai-completions": scriptedApi("openrouter") },
    });
    expect(asked).toEqual([]);
    await expect(table.get("anthropic").complete(request)).resolves.toMatchObject({ stopReason: "end_turn" });
    await expect(table.get("openrouter").complete({ ...request, model: "anthropic/claude-sonnet-4" })).rejects.toThrow(
      'Provider "openrouter": OPENROUTER_API_KEY is not set',
    );
    expect(asked).toEqual(["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]);
  });

  // Feature: docs/reference/specs/model-proxy.md items 2 and 4 — a run's upstream is the
  // block the `<provider>` half of its model ref names; `upstreamFor` is called here, not changed.
  it("any preset's model points at OpenRouter by one ref: defaults.models.general: openrouter/anthropic/<model> splits at the first slash into the openrouter block and pi's model id anthropic/<model>; a run on it reaches the block's /chat/completions with the key as the bearer, and provider_key_missing names OPENROUTER_API_KEY without one", () => {
    const store = storeFrom(
      edited("general: anthropic/claude-haiku-4-5", "general: openrouter/anthropic/claude-sonnet-4"),
    );
    const ref = parseModelRef(store.config.defaults.models.general);
    expect(ref).toEqual({ provider: "openrouter", model: "anthropic/claude-sonnet-4" });
    const table = new PiAiProviders(store.config.providers, { secrets: secretsFrom({}) });
    expect(table.get(ref.provider).model(ref.model, 100)).toMatchObject({
      id: "anthropic/claude-sonnet-4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: OPENROUTER.baseUrl,
    });
    const block = store.config.providers[ref.provider];
    expect(
      upstreamFor("openai-chat", ref.provider, block, secretsFrom({ OPENROUTER_API_KEY: "sk-or-test" }), {}),
    ).toEqual({
      ok: true,
      url: `${OPENROUTER.baseUrl}/chat/completions`,
      headers: { "content-type": "application/json", authorization: "Bearer sk-or-test" },
    });
    expect(upstreamFor("openai-chat", ref.provider, block, secretsFrom({}), {})).toEqual({
      ok: false,
      code: "provider_key_missing",
      message: 'provider "openrouter": OPENROUTER_API_KEY is not set',
    });
  });

  it.each(["groq", "local"])(
    "the %s block, still commented, is a real configuration: turned on it loads and pi's library builds an openai-completions provider from it",
    (name) => {
      const store = storeFrom(uncommented(name));
      expect(store.config.providers[name].type).toBe("openai-compatible");
      expect(new PiAiProviders(store.config.providers, { secrets: secretsFrom({}) }).get(name).api).toBe(
        "openai-completions",
      );
    },
  );
});

// Feature: docs/reference/specs/routing-and-config.md item 12 — where runtime overrides persist.
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
    expect(backing.document).toEqual({
      channels: { "slack:CX": { agent: "review" } },
      users: { "slack:UX": { effort: "low" } },
    });
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
    expect(backing.document).toEqual({
      channels: {},
      users: { "slack:UX": { effort: "low" }, "slack:UY": { agent: "review" } },
    });
    expect(s.scopes("slack:CX", "slack:UX").user).toEqual({ effort: "low" });
    expect(s.scopes("slack:CX", "slack:UY").user).toEqual({ agent: "review" });
    expect(backing.saves).toBe(1);
  });

  it("a second stale refusal in a row surfaces the retry error, and the store now holds the other writer's document — a retry rebases on it, never on the stale snapshot", async () => {
    const { cfg } = cfgFile();
    const backing = new InMemoryOverridesBacking({ channels: {}, users: {} });
    const s = new ConfigStore(cfg, { backing, initial: await backing.load() });
    backing.conflictNextSaveWith = { channels: {}, users: { "slack:UX": { effort: "low" } } };
    backing.conflictAfterNextSaveWith = {
      channels: { "slack:CX": { agent: "coding" } },
      users: { "slack:UX": { effort: "low" } },
    };
    await expect(s.setUserOverride("slack:UY", { agent: "review" })).rejects.toThrow(OverridesConflictError);
    expect(backing.saves).toBe(0);
    expect(s.scopes("slack:CX", "slack:UX")).toMatchObject({ channel: { agent: "coding" }, user: { effort: "low" } });
    expect(s.scopes("slack:CX", "slack:UY").user).toEqual({});
    // The retry the error asks for now carries every writer's change.
    await s.setUserOverride("slack:UY", { agent: "review" });
    expect(backing.document).toEqual({
      channels: { "slack:CX": { agent: "coding" } },
      users: { "slack:UX": { effort: "low" }, "slack:UY": { agent: "review" } },
    });
  });

  it("a write the loader would refuse fails BEFORE the save and keeps the document — a duplicate github binding never poisons the backing (record 0062)", async () => {
    const { cfg } = cfgFile();
    const backing = new InMemoryOverridesBacking({ channels: {}, users: {} });
    const s = new ConfigStore(cfg, { backing, initial: await backing.load() });
    await s.setUserOverride("slack:UONE", { github: { login: "ivy-dev", id: 4242 } });
    await expect(s.setUserOverride("slack:UTWO", { github: { login: "Ivy-Dev", id: 9 } })).rejects.toThrow(
      /one login binds one person/,
    );
    expect(backing.saves).toBe(1);
    expect(s.userGithubBinding("slack:UTWO")).toBeUndefined();
    // The stored document stayed loadable: a restart over it constructs clean.
    expect(() => new ConfigStore(cfg, { backing, initial: backing.document })).not.toThrow();
  });

  it("concurrent writes in one process are serialized: neither loses the other's change", async () => {
    const { cfg } = cfgFile();
    const backing = new InMemoryOverridesBacking();
    const s = new ConfigStore(cfg, { backing, initial: undefined });
    await Promise.all([
      s.setUserOverride("slack:UX", { effort: "low" }),
      s.setChannelOverride("slack:CX", { agent: "review" }),
      s.setUserOverride("slack:UY", { agent: "coding" }),
    ]);
    expect(backing.saves).toBe(3);
    expect(backing.document).toEqual({
      channels: { "slack:CX": { agent: "review" } },
      users: { "slack:UX": { effort: "low" }, "slack:UY": { agent: "coding" } },
    });
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
    const backing = new InMemoryOverridesBacking({
      channels: {},
      users: { "slack:UX": { instructions: "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1) } },
    });
    expect(() => new ConfigStore(cfg, { backing, initial: backing.document })).toThrow(
      /overrides \(in-memory\).*instructions exceeds/,
    );
  });

  it("overridesBackingFor: no `runtimeOverrides` → the file; a worker → WorkerOverridesBacking; a worker without its bearer → a startup error naming the env var", () => {
    const base = { providers: {}, defaults: { agent: "general", models: {} } } as unknown as AppConfig;
    expect(overridesBackingFor(base, { overridesPath: "/tmp/o.json", secrets: secretsFrom({}) })).toBeInstanceOf(
      FileOverridesBacking,
    );
    const withWorker = { ...base, runtimeOverrides: { worker: { baseUrl: "https://state.example" } } } as AppConfig;
    expect(
      overridesBackingFor(withWorker, { overridesPath: "/tmp/o.json", secrets: secretsFrom({ MEMORY_TOKEN: "t" }) }),
    ).toBeInstanceOf(WorkerOverridesBacking);
    expect(() => overridesBackingFor(withWorker, { overridesPath: "/tmp/o.json", secrets: secretsFrom({}) })).toThrow(
      /runtimeOverrides.worker is configured but MEMORY_TOKEN is not set/,
    );
    const customEnv = {
      ...base,
      runtimeOverrides: { worker: { baseUrl: "https://state.example", tokenEnv: "STATE_TOKEN" } },
    } as AppConfig;
    expect(() => overridesBackingFor(customEnv, { overridesPath: "/tmp/o.json", secrets: secretsFrom({}) })).toThrow(
      /STATE_TOKEN is not set/,
    );
  });

  it("config.yaml validation: runtimeOverrides.worker.baseUrl must be https; tokenEnv a name", () => {
    expect(() => store(`${YAML_FIXTURE}\nruntimeOverrides:\n  worker:\n    baseUrl: http://state.example\n`)).toThrow(
      /runtimeOverrides\.worker\.baseUrl must be an https: URL/,
    );
    expect(() =>
      store(`${YAML_FIXTURE}\nruntimeOverrides:\n  worker:\n    baseUrl: https://state.example\n    tokenEnv: ""\n`),
    ).toThrow(/runtimeOverrides\.worker\.tokenEnv/);
    expect(() => store(`${YAML_FIXTURE}\nruntimeOverrides: []\n`)).toThrow(/runtimeOverrides must be a mapping/);
    expect(
      store(`${YAML_FIXTURE}\nruntimeOverrides:\n  worker:\n    baseUrl: https://state.example\n`).config
        .runtimeOverrides,
    ).toEqual({ worker: { baseUrl: "https://state.example" } });
  });

  it("openConfigStore picks the backing from config.yaml and loads the document (file backing here)", async () => {
    const { dir, cfg } = cfgFile();
    const path = join(dir, "overrides.json");
    writeFileSync(path, JSON.stringify({ channels: {}, users: { "slack:UX": { agent: "review" } } }));
    const s = await openConfigStore(cfg, { overridesPath: path, env: {}, secrets: secretsFrom({}) });
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).agentName).toBe("review");
    expect(s.overridesLocation()).toBe(`file ${path}`);
  });
});

describe("loadAppConfigFrom", () => {
  const env = { STATE_WORKER_URL: "https://state.example" };
  const secrets = secretsFrom({ MEMORY_TOKEN: "tok" });
  /** A state Worker whose `base` document is `document` (null = never pushed). */
  const stateWorker =
    (document: unknown, version = 3): typeof fetch =>
    async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key?: string };
      if (String(input) === "https://state.example/config/get" && body.key === "base")
        return Response.json({ document, version });
      return new Response("{}", { status: 404 });
    };
  const pushed = {
    yaml: YAML_FIXTURE,
    sha256: "a".repeat(64),
    source: "config/config.production.yaml",
    pushedAt: "2026-09-08T00:00:00.000Z",
  };

  it("a file path reads the file, as before", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "swb-config-")), "config.yaml");
    writeFileSync(cfg, YAML_FIXTURE);
    const config = await loadAppConfigFrom(cfg, { env: {}, secrets: secretsFrom({}), warn: () => {} });
    expect(config.defaults.agent).toBe("general");
  });

  it("state://base reads the pushed document from the state Worker, validates its YAML, and says which version it started on", async () => {
    const warnings: string[] = [];
    const config = await loadAppConfigFrom("state://base", {
      env,
      secrets,
      warn: (m) => warnings.push(m),
      fetch: stateWorker(pushed),
    });
    expect(config.defaults.models.general).toBe("anthropic/general-model");
    expect(warnings.some((w) => w.includes('base document "base" v3 from config/config.production.yaml'))).toBe(true);
  });

  it("no document yet is a startup error naming `deploy config`; a wrong-shaped one, a missing variable, and an unreachable Worker name the cause", async () => {
    await expect(
      loadAppConfigFrom("state://base", { env, secrets, warn: () => {}, fetch: stateWorker(null) }),
    ).rejects.toThrow(
      'SWITCHBOARD_CONFIG=state://base: no "base" document on state Worker https://state.example — push one with `deploy config`',
    );
    await expect(
      loadAppConfigFrom("state://base", { env, secrets, warn: () => {}, fetch: stateWorker({ channels: {} }) }),
    ).rejects.toThrow('the "base" document is not a base config document');
    await expect(loadAppConfigFrom("state://base", { env: {}, secrets, warn: () => {} })).rejects.toThrow(
      "STATE_WORKER_URL is not set",
    );
    await expect(
      loadAppConfigFrom("state://base", {
        env,
        secrets,
        warn: () => {},
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).rejects.toThrow("/config/get failed — ECONNREFUSED");
  });

  it("a pushed document whose YAML does not validate fails startup with the validation error, never a silent partial config", async () => {
    const broken = { ...pushed, yaml: "defaults:\n  agent: general\n  models: {}\n" };
    await expect(
      loadAppConfigFrom("state://base", { env, secrets, warn: () => {}, fetch: stateWorker(broken) }),
    ).rejects.toThrow();
  });
});

describe("WorkerOverridesBacking (the ConfigDO client)", () => {
  function fake(
    state: { document: Overrides | null; version: number },
    opts: { failStatus?: number; down?: boolean } = {},
  ) {
    const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (opts.down) throw new Error("ECONNREFUSED");
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
      if (opts.failStatus) return new Response("{}", { status: opts.failStatus });
      if (url.pathname === "/config/get") return Response.json({ document: state.document, version: state.version });
      if (url.pathname === "/config/put") {
        if (body.expectedVersion !== state.version)
          return Response.json({ error: "version conflict", version: state.version }, { status: 409 });
        state.version += 1;
        state.document = body.document as Overrides;
        return Response.json({ ok: true, version: state.version });
      }
      return new Response("{}", { status: 404 });
    };
    return {
      calls,
      backing: new WorkerOverridesBacking({ baseUrl: "https://state.example/", token: "tok", fetch: fetchImpl }),
    };
  }

  it("loads the document with its version, saves with expectedVersion, tracks the new version, sends the bearer", async () => {
    const state = {
      document: { channels: {}, users: { "slack:UX": { agent: "review" } } } as Overrides | null,
      version: 3,
    };
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
    await expect(fake({ document: null, version: 0 }, { failStatus: 500 }).backing.load()).rejects.toThrow(
      /config store answered HTTP 500/,
    );
    await expect(fake({ document: null, version: 0 }, { down: true }).backing.load()).rejects.toThrow(
      /config store unreachable: ECONNREFUSED/,
    );
  });
});

// Feature: docs/reference/specs/mcp-tools.md items 11 + 14 + 17 — MCP servers as a Scope setting.
describe("Scope.mcpServers (MCP servers layered through config)", () => {
  const MCP_YAML = `${YAML_FIXTURE}
  "slack:CMCP":
    mcpServers:
      notion: { url: "https://mcp.notion.so/mcp", auth: none }
`.replace("channels:\n", "channels:\n");
  const withDefaults = `
organization: acme
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
    await s.setChannelOverride("slack:CMCP", {
      mcpServers: { hubspot: { url: "https://mcp.hubspot.com/mcp", auth: "none", addedBy: "slack:UX", addedAt: 1 } },
    });
    await s.setUserOverride("slack:UX", {
      mcpServers: { asana: { url: "https://mcp.asana.com/mcp", auth: "none", addedBy: "slack:UX", addedAt: 2 } },
    });
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
    expect(
      s
        .mcpServersFor("slack:CMCP", "slack:UX")
        .filter((r) => r.kind === "channel")
        .map((r) => r.name),
    ).toEqual(["notion"]);
  });

  it("runtime entries layer over static ones per tier; `runtimeScope` is the runtime half only; the org tier is `defaults` + the `org` override", async () => {
    const s = store(withDefaults);
    await s.setUserOverride("slack:UY", {
      mcpServers: { hubspot: { url: "https://mcp.hubspot.com/mcp", auth: "none", addedBy: "slack:UY", addedAt: 1 } },
    });
    await s.setOrgOverride({
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp/", auth: "bearer", addedBy: "slack:UADMIN", addedAt: 2 },
      },
    });
    const resolved = s.mcpServersFor("slack:CX", "slack:UY");
    expect(resolved.map((r) => [r.kind, r.name, r.source])).toEqual([
      ["org", "linear", "config"],
      ["org", "github", "runtime"],
      ["user", "hubspot", "runtime"],
    ]);
    expect(s.runtimeScope("org").mcpServers).toEqual({
      github: expect.objectContaining({ url: "https://api.githubcopilot.com/mcp/" }),
    });
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

  it("validates every tier at load: slug names, http(s) + SSRF-safe URLs, known agents, auth kind, tokenEnv only with bearer, headersEnv as HTTP header names → env var names (never Authorization), and self-serve agents only outside org", () => {
    const bad = (yaml: string) => () => store(yaml);
    expect(bad(withDefaults.replace("notion:", "Bad Name:"))).toThrow(
      /channels\.slack:CMCP\.mcpServers\.Bad Name: server names are slugs/,
    );
    expect(bad(withDefaults.replace("https://mcp.notion.so/mcp", "http://169.254.169.254/"))).toThrow(
      /mcpServers\.notion\.url: .*169\.254/,
    );
    expect(bad(withDefaults.replace("https://mcp.notion.so/mcp", "ftp://x.example"))).toThrow(
      /mcpServers\.notion\.url:/,
    );
    expect(
      bad(
        withDefaults.replace(
          'notion: { url: "https://mcp.notion.so/mcp", auth: none }',
          'notion: { url: "https://mcp.notion.so/mcp", auth: none, agents: [wizard] }',
        ),
      ),
    ).toThrow(/unknown agent "wizard"/);
    expect(
      bad(
        withDefaults.replace(
          'vanta: { url: "https://mcp.vanta.com/mcp", auth: bearer }',
          'vanta: { url: "https://mcp.vanta.com/mcp", auth: bearer, agents: [coding] }',
        ),
      ),
    ).toThrow(/users\.slack:UX\.mcpServers\.vanta\.agents: a user-scoped server may name general\/research only/);
    expect(
      bad(
        withDefaults.replace(
          'notion: { url: "https://mcp.notion.so/mcp", auth: none }',
          'notion: { url: "https://mcp.notion.so/mcp", auth: none, agents: [review] }',
        ),
      ),
    ).toThrow(/a channel-scoped server may name general\/research only/);
    expect(bad(withDefaults.replace("auth: none }", "auth: magic }"))).toThrow(
      /must be \{ url, auth: none\|bearer\|oauth/,
    );
    // oauth is a valid static kind (item 18): the credential is the connect page's, so no tokenEnv.
    expect(bad(withDefaults.replace("auth: none }", "auth: oauth }"))).not.toThrow();
    expect(bad(withDefaults.replace("auth: none }", "auth: oauth, tokenEnv: X }"))).toThrow(
      /tokenEnv only applies to auth: bearer/,
    );
    expect(bad(withDefaults.replace("auth: none }", "auth: none, tokenEnv: X }"))).toThrow(
      /tokenEnv only applies to auth: bearer/,
    );
    // headersEnv: static headers whose VALUES are bot env vars (a Cloudflare Access
    // service token in front of a server). Header names are HTTP tokens; the
    // Authorization header belongs to `auth`, never to headersEnv.
    const access =
      "auth: none, headersEnv: { CF-Access-Client-Id: MCP_ACCESS_CLIENT_ID, CF-Access-Client-Secret: MCP_ACCESS_CLIENT_SECRET } }";
    expect(bad(withDefaults.replace("auth: none }", access))).not.toThrow();
    expect(
      store(withDefaults.replace("auth: none }", access)).config.channels?.["slack:CMCP"].mcpServers?.notion.headersEnv,
    ).toEqual({
      "CF-Access-Client-Id": "MCP_ACCESS_CLIENT_ID",
      "CF-Access-Client-Secret": "MCP_ACCESS_CLIENT_SECRET",
    });
    expect(bad(withDefaults.replace("auth: none }", "auth: none, headersEnv: [X] }"))).toThrow(
      /must be \{ url, auth: none\|bearer\|oauth, agents\?, tokenEnv\?, headersEnv\? \}/,
    );
    expect(bad(withDefaults.replace("auth: none }", "auth: none, headersEnv: { Authorization: MCP_X } }"))).toThrow(
      /mcpServers\.notion\.headersEnv: the Authorization header is `auth`'s/,
    );
    expect(bad(withDefaults.replace("auth: none }", 'auth: none, headersEnv: { "Bad Header": MCP_X } }'))).toThrow(
      /mcpServers\.notion\.headersEnv: "Bad Header" is not an HTTP header name/,
    );
    expect(bad(withDefaults.replace("auth: none }", 'auth: none, headersEnv: { X-Key: "" } }'))).toThrow(
      /must be \{ url, auth: none\|bearer\|oauth, agents\?, tokenEnv\?, headersEnv\? \}/,
    );
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
    const backing = new InMemoryOverridesBacking({
      channels: {},
      users: { "slack:UX": { mcpServers: { vanta: { url: "http://localhost:1/mcp", auth: "none" } } } },
    });
    expect(() => new ConfigStore(cfg, { backing, initial: backing.document })).toThrow(
      /overrides \(in-memory\): users\.slack:UX\.mcpServers\.vanta\.url/,
    );
  });
});

// Feature: routing-and-config.md item 15 — `organization` is required: it names
// the shared memory scope and the About block, and the code assumes no
// particular organization.
describe("organization", () => {
  it("is read from the config", () => {
    expect(store().config.organization).toBe("acme");
  });

  it("a config without one, or with an empty or non-string one, is refused naming the field", () => {
    const without = YAML_FIXTURE.replace("organization: acme\n", "");
    expect(() => store(without)).toThrow(/must name the organization.*organization: <GitHub org or user login>/);
    expect(() => store(YAML_FIXTURE.replace("organization: acme\n", 'organization: "  "\n'))).toThrow(
      /must name the organization/,
    );
    expect(() => store(YAML_FIXTURE.replace("organization: acme\n", "organization: 42\n"))).toThrow(
      /must name the organization/,
    );
  });
});

// Feature: docs/reference/specs/tracing.md item 3 — the span log's verbosity knob.
describe("tracing", () => {
  it("accepts `log: roots` and `log: slow`, refuses anything else at load, and defaults to absent", () => {
    expect(store(`${YAML_FIXTURE}\ntracing:\n  log: slow\n`).config.tracing).toEqual({ log: "slow" });
    expect(store(`${YAML_FIXTURE}\ntracing:\n  log: roots\n`).config.tracing).toEqual({ log: "roots" });
    expect(store().config.tracing).toBeUndefined();
    expect(() => store(`${YAML_FIXTURE}\ntracing:\n  log: verbose\n`)).toThrow(
      /tracing\.log must be one of roots, slow/,
    );
    expect(() => store(`${YAML_FIXTURE}\ntracing: 3\n`)).toThrow(/tracing must be a mapping/);
  });
});

// Feature: docs/reference/specs/access-gate.md (dashboard auth is a strategy) and
// docs/reference/specs/routing-and-config.md — the `dashboard` block is validated at load.
describe("dashboard", () => {
  it("accepts each strategy, exposes the block as written, and defaults to absent", () => {
    expect(store(`${YAML_FIXTURE}\ndashboard:\n  auth: none\n`).config.dashboard).toEqual({ auth: "none" });
    expect(store(`${YAML_FIXTURE}\ndashboard:\n  auth: access\n`).config.dashboard).toEqual({ auth: "access" });
    expect(
      store(`${YAML_FIXTURE}\ndashboard:\n  auth: token\n  token:\n    env: DASH\n    actor: access:ops\n`).config
        .dashboard,
    ).toEqual({ auth: "token", token: { env: "DASH", actor: "access:ops" } });
    expect(store().config.dashboard).toBeUndefined();
  });

  it("refuses a misspelled mode, an unknown key, and `token` without its actor at load, naming the key", () => {
    expect(() => store(`${YAML_FIXTURE}\ndashboard:\n  auth: nnoe\n`)).toThrow(
      /dashboard\.auth must be one of access, token, none/,
    );
    expect(() => store(`${YAML_FIXTURE}\ndashboard:\n  mode: none\n`)).toThrow(/dashboard\.mode is not a known key/);
    expect(() => store(`${YAML_FIXTURE}\ndashboard:\n  auth: token\n`)).toThrow(/dashboard\.token\.actor/);
    expect(() => store(`${YAML_FIXTURE}\ndashboard: none\n`)).toThrow(/dashboard must be a mapping/);
  });
});

// Feature: docs/reference/specs/routing-and-config.md item 2 — a boundary is a
// scope setting that caps the three profile axes and never grants; unlike every
// other setting it INTERSECTS across the layers (record 0026).
describe("boundaries (Scope.boundary): a scope caps, never grants", () => {
  const ALL_CLASSES = ["none", "blank", "repo-cold", "repo-resident"] as const;
  const BOUNDED = YAML_FIXTURE.replace("defaults:\n", "defaults:\n  boundary:\n    maxMinutes: 120\n")
    .replace(
      "channels:\n",
      `channels:\n  "slack:CBOUND":\n    boundary:\n      maxMinutes: 45\n      maxIdentity: write\n      machines: [none, blank, repo-cold, repo-resident]\n`,
    )
    .replace(
      "users:\n",
      `users:\n  "slack:UBOUND":\n    boundary:\n      maxMinutes: 60\n      maxIdentity: read\n      machines: [none, repo-resident]\n`,
    );
  const withChannelBoundary = (body: string) =>
    YAML_FIXTURE.replace("channels:\n", `channels:\n  "slack:CBAD":\n    boundary:\n${body}`);

  it("resolve() returns the intersected boundary beside the triple — the smallest minutes, the lowest identity, the classes every layer allows, each naming its scope — and no key at all when no layer sets one", () => {
    const s = store(BOUNDED);
    expect(s.resolve({ channelId: "slack:CBOUND", userId: "slack:UBOUND", request: {} }).boundary).toEqual({
      maxMinutes: { value: 45, scope: "channel" },
      maxIdentity: { value: "read", scope: "user" },
      machines: {
        value: ["none", "repo-resident"],
        by: [
          { scope: "channel", machines: [...ALL_CLASSES] },
          { scope: "user", machines: ["none", "repo-resident"] },
        ],
      },
    });
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).boundary).toEqual({
      maxMinutes: { value: 120, scope: "defaults" },
    });
    // Nothing set anywhere: the request resolves exactly as it always did.
    expect(store().resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} })).toEqual({
      agentName: "general",
      agentLayer: "default",
      verbosity: "quiet",
      modelRef: "anthropic/general-model",
    });
  });

  it("per-actor goldens: with no boundary set, every preset admits and refuses per actor kind exactly as canRunAgent does, and resolves its declared profile", () => {
    const s = store();
    const baseline: Record<string, Record<string, boolean>> = {
      "slack:URANDOM": {
        general: true,
        coding: false,
        review: true,
        ship: true,
        research: true,
        explore: true,
        conductor: true,
      },
      "slack:UDEV": {
        general: true,
        coding: true,
        review: true,
        ship: true,
        research: true,
        explore: true,
        conductor: true,
      },
      "slack:UADMIN": {
        general: true,
        coding: true,
        review: true,
        ship: true,
        research: true,
        explore: true,
        conductor: true,
      },
    };
    expect(Object.keys(baseline["slack:URANDOM"]).sort()).toEqual(Object.keys(AGENTS).sort());
    for (const [actor, byAgent] of Object.entries(baseline)) {
      for (const [name, admits] of Object.entries(byAgent)) {
        expect(s.canRunAgent(actor, name), `${actor} ${name}`).toBe(admits);
        const r = s.resolve({ channelId: "slack:CX", userId: actor, request: { agent: name } });
        expect(effectiveProfile(AGENTS[name], {}, r.boundary), `${actor} ${name}`).toEqual({
          kind: "profile",
          profile: declaredProfile(AGENTS[name]),
        });
      }
    }
  });

  it("a boundary never grants: the policy table's answer is untouched by any boundary, however wide", () => {
    const s = store(BOUNDED);
    expect(s.canRunAgent("slack:URANDOM", "coding")).toBe(false); // CBOUND allows `write`; the grant is still missing
    expect(s.canRunAgent("slack:UDEV", "coding")).toBe(true);
  });

  it("a user boundary tightens a channel's and never loosens it, runtime overrides included; the runtime boundary replaces the scope's static one whole, like every other setting", async () => {
    const s = store(BOUNDED);
    await s.setChannelOverride("slack:CX", { boundary: { maxMinutes: 30, maxIdentity: "read" } });
    await s.setUserOverride("slack:UX", { boundary: { maxMinutes: 500, maxIdentity: "write", machines: ["none"] } });
    expect(s.resolve({ channelId: "slack:CX", userId: "slack:UX", request: {} }).boundary).toEqual({
      maxMinutes: { value: 30, scope: "channel" },
      maxIdentity: { value: "read", scope: "channel" },
      machines: { value: ["none"], by: [{ scope: "user", machines: ["none"] }] },
    });
    // The static channel boundary of CBOUND is replaced whole by a runtime one.
    await s.setChannelOverride("slack:CBOUND", { boundary: { maxMinutes: 20 } });
    expect(s.scopes("slack:CBOUND", "slack:UX").channel.boundary).toEqual({ maxMinutes: 20 });
    // Clearing the override lets the static boundary show through again.
    await s.clearChannelOverride("slack:CBOUND");
    expect(s.scopes("slack:CBOUND", "slack:UX").channel.boundary).toEqual({
      maxMinutes: 45,
      maxIdentity: "write",
      machines: [...ALL_CLASSES],
    });
  });

  it("load-time validation names the path: a maxMinutes under 2 or fractional, an unknown identity, an unknown class, an empty class list, an unknown field, a non-mapping — under channels, users and defaults alike", () => {
    expect(() => store(withChannelBoundary("      maxMinutes: 1\n"))).toThrow(
      /channels\.slack:CBAD\.boundary\.maxMinutes must be an integer >= 2/,
    );
    expect(() => store(withChannelBoundary("      maxMinutes: 2.5\n"))).toThrow(
      /channels\.slack:CBAD\.boundary\.maxMinutes must be an integer >= 2/,
    );
    expect(() => store(withChannelBoundary("      maxIdentity: admin\n"))).toThrow(
      /channels\.slack:CBAD\.boundary\.maxIdentity is "admin" — valid identities: none, read, write/,
    );
    expect(() => store(withChannelBoundary("      machines: [laptop]\n"))).toThrow(
      /channels\.slack:CBAD\.boundary\.machines names "laptop" — valid classes: none, blank, repo-cold, repo-resident/,
    );
    expect(() => store(withChannelBoundary("      machines: []\n"))).toThrow(
      /channels\.slack:CBAD\.boundary\.machines must name at least one class/,
    );
    expect(() => store(withChannelBoundary("      machines: none\n"))).toThrow(
      /channels\.slack:CBAD\.boundary\.machines must be a list/,
    );
    expect(() => store(withChannelBoundary("      maxHours: 2\n"))).toThrow(
      /channels\.slack:CBAD\.boundary: unknown field maxHours/,
    );
    expect(() => store(YAML_FIXTURE.replace("channels:\n", `channels:\n  "slack:CBAD":\n    boundary: 45\n`))).toThrow(
      /channels\.slack:CBAD\.boundary must be a mapping/,
    );
    expect(() => store(YAML_FIXTURE.replace("defaults:\n", "defaults:\n  boundary:\n    maxMinutes: 0\n"))).toThrow(
      /defaults\.boundary\.maxMinutes must be an integer >= 2/,
    );
    expect(() =>
      store(YAML_FIXTURE.replace("users:\n", `users:\n  "slack:UBAD":\n    boundary:\n      maxIdentity: root\n`)),
    ).toThrow(/users\.slack:UBAD\.boundary\.maxIdentity is "root"/);
    // A boundary that caps nothing is legal: an empty mapping names no axis.
    expect(() =>
      store(YAML_FIXTURE.replace("channels:\n", `channels:\n  "slack:CNONE":\n    boundary: {}\n`)),
    ).not.toThrow();
  });

  it("a hand-edited overrides document is held to the same rule at load, naming the backing", () => {
    const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
    const cfg = join(dir, "config.yaml");
    writeFileSync(cfg, YAML_FIXTURE);
    const overrides = join(dir, "overrides.json");
    writeFileSync(overrides, JSON.stringify({ users: { "slack:UX": { boundary: { maxMinutes: 1 } } } }));
    expect(() => new ConfigStore(cfg, overrides)).toThrow(
      /overrides.*users\.slack:UX\.boundary\.maxMinutes must be an integer >= 2/,
    );
  });

  it("config show renders the effective boundary with each axis's scope and every scope's own boundary; nothing when none is set", () => {
    const s = store(BOUNDED);
    const shown = s.describe("slack:CBOUND", "slack:UBOUND");
    expect(shown).toContain(
      "*Effective boundary:* maxMinutes 45 (channel), maxIdentity `read` (user), machines `none`, `repo-resident` (channel, user)",
    );
    expect(shown).toMatch(
      /\*Channel scope:\*.*boundary maxMinutes=45 maxIdentity=write machines=none,blank,repo-cold,repo-resident/,
    );
    expect(shown).toMatch(/\*Your scope:\*.*boundary maxMinutes=60 maxIdentity=read machines=none,repo-resident/);
    expect(store().describe("slack:CX", "slack:UX")).not.toMatch(/boundary/i);
  });

  // record 0044, the confirm axis: a fourth field of the boundary with its own
  // intersection, read by the door and printed by `config show`; the run caps
  // and the model's configuration block never see it.
  describe("the confirm axis (record 0044)", () => {
    const CONFIRMED = YAML_FIXTURE.replace("defaults:\n", "defaults:\n  boundary:\n    confirm: write\n")
      .replace("channels:\n", `channels:\n  "slack:CCONF":\n    boundary:\n      confirm: destructive\n`)
      .replace(
        "users:\n",
        `users:\n  "slack:UCONF":\n    boundary:\n      maxMinutes: 30\n      confirm: destructive\n`,
      );

    it("boundaryLayers() is the path in resolution order keeping the scopes that set a boundary, and effectiveConfirm over it names the most cautious layer", () => {
      const s = store(CONFIRMED);
      expect(s.boundaryLayers("slack:CCONF", "slack:UCONF")).toEqual([
        { scope: "defaults", boundary: { confirm: "write" } },
        { scope: "channel", boundary: { confirm: "destructive" } },
        { scope: "user", boundary: { maxMinutes: 30, confirm: "destructive" } },
      ]);
      expect(effectiveConfirm(s.boundaryLayers("slack:CCONF", "slack:UCONF"))).toEqual({
        value: "write",
        scope: "defaults",
      });
      expect(s.boundaryLayers("slack:CX", "slack:UX")).toEqual([{ scope: "defaults", boundary: { confirm: "write" } }]);
      expect(store().boundaryLayers("slack:CX", "slack:UX")).toEqual([]);
      expect(effectiveConfirm(store().boundaryLayers("slack:CX", "slack:UX"))).toEqual({
        value: "write",
        scope: "built-in",
      });
    });

    it("a scope that sets only `confirm` caps no run: resolve() carries no boundary key, and one that sets it beside a cap resolves the cap alone", () => {
      const s = store(CONFIRMED);
      expect(s.resolve({ channelId: "slack:CCONF", userId: "slack:UX", request: {} }).boundary).toBeUndefined();
      expect(s.resolve({ channelId: "slack:CCONF", userId: "slack:UCONF", request: {} }).boundary).toEqual({
        maxMinutes: { value: 30, scope: "user" },
      });
    });

    it("config show prints a confirm-only scope's line as `boundary confirm=<class>` — never `(caps nothing)` — and the effective confirm with the deciding scope; nothing new when no layer set it", () => {
      const s = store(CONFIRMED);
      const shown = s.describe("slack:CCONF", "slack:UCONF");
      expect(shown).toMatch(/\*Channel scope:\* boundary confirm=destructive$/m);
      expect(shown).toMatch(/\*Your scope:\* boundary maxMinutes=30 confirm=destructive$/m);
      expect(shown).not.toContain("(caps nothing)");
      expect(shown).toContain("*Effective confirm:* `write` (defaults)");
      expect(shown).toContain("*Effective boundary:* maxMinutes 30 (user)");
      // The channel alone: the intersection of the run caps is empty, so no
      // effective boundary line, while the confirm line names the org's floor.
      const channelOnly = s.describe("slack:CCONF", "slack:UX");
      expect(channelOnly).not.toContain("*Effective boundary:*");
      expect(channelOnly).toContain("*Effective confirm:* `write` (defaults)");
      // Nothing set anywhere: the description is what it was, the built-in
      // default printing no line of its own.
      const plain = store().describe("slack:CX", "slack:UX");
      expect(plain).not.toMatch(/confirm/i);
      expect(plain).not.toMatch(/boundary/i);
    });

    it("a stored `never` or `exec` stops the load with its reason, an unknown class with the two classes — under defaults, a channel, a user and a hand-edited overrides document alike", () => {
      expect(() => store(withChannelBoundary("      confirm: never\n"))).toThrow(
        /channels\.slack:CBAD\.boundary\.confirm is "never" — not allowed until the door's write misbind rate has been measured over a period \(record 0044, open question 2\)/,
      );
      expect(() => store(YAML_FIXTURE.replace("defaults:\n", "defaults:\n  boundary:\n    confirm: exec\n"))).toThrow(
        /defaults\.boundary\.confirm is "exec" — a test or build never asks \(record 0044\)/,
      );
      expect(() =>
        store(YAML_FIXTURE.replace("users:\n", `users:\n  "slack:UBAD":\n    boundary:\n      confirm: read\n`)),
      ).toThrow(/users\.slack:UBAD\.boundary\.confirm is "read" — valid classes: write, destructive/);
      const dir = mkdtempSync(join(tmpdir(), "swb-config-"));
      const cfg = join(dir, "config.yaml");
      writeFileSync(cfg, YAML_FIXTURE);
      const overrides = join(dir, "overrides.json");
      writeFileSync(overrides, JSON.stringify({ channels: { "slack:CX": { boundary: { confirm: "never" } } } }));
      expect(() => new ConfigStore(cfg, overrides)).toThrow(
        /overrides.*channels\.slack:CX\.boundary\.confirm is "never"/,
      );
    });

    it("a runtime boundary carrying `confirm` replaces the scope's static one whole and clears with it, like every other setting", async () => {
      const s = store(CONFIRMED);
      await s.setChannelOverride("slack:CCONF", { boundary: { maxMinutes: 20 } });
      expect(s.boundaryLayers("slack:CCONF", "slack:UX")).toEqual([
        { scope: "defaults", boundary: { confirm: "write" } },
        { scope: "channel", boundary: { maxMinutes: 20 } },
      ]);
      await s.setUserOverride("slack:UX", { boundary: { confirm: "destructive" } });
      expect(effectiveConfirm(s.boundaryLayers("slack:CCONF", "slack:UX"))).toEqual({
        value: "write",
        scope: "defaults",
      });
      await s.clearChannelOverride("slack:CCONF");
      expect(s.scopes("slack:CCONF", "slack:UX").channel.boundary).toEqual({ confirm: "destructive" });
    });
  });
});

// Feature: docs/reference/specs/harness-pi.md item 4 — the `pi` block: the
// compaction thresholds the harness writes into pi's per-run settings,
// deployment-wide; positive integers in tokens, every other shape refused by
// name, and no block at all leaves pi on its own defaults.
describe("pi block (pi.compaction.reserveTokens, pi.compaction.keepRecentTokens)", () => {
  it("parses both thresholds, either alone, and an empty compaction block; an absent block leaves the field unset", () => {
    expect(
      store(YAML_FIXTURE + "pi:\n  compaction:\n    reserveTokens: 150000\n    keepRecentTokens: 8000\n").config.pi,
    ).toEqual({ compaction: { reserveTokens: 150_000, keepRecentTokens: 8_000 } });
    expect(store(YAML_FIXTURE + "pi:\n  compaction:\n    reserveTokens: 150000\n").config.pi).toEqual({
      compaction: { reserveTokens: 150_000 },
    });
    expect(store(YAML_FIXTURE + "pi:\n  compaction: {}\n").config.pi).toEqual({ compaction: {} });
    expect(store().config.pi).toBeUndefined();
  });

  it("refuses a threshold that is not a positive integer by name — a float, zero, a negative, a string", () => {
    for (const value of ["1.5", "0", "-1", '"16384"', "true"])
      expect(() => store(YAML_FIXTURE + `pi:\n  compaction:\n    reserveTokens: ${value}\n`)).toThrow(
        /pi\.compaction\.reserveTokens must be a positive integer/,
      );
    expect(() => store(YAML_FIXTURE + "pi:\n  compaction:\n    keepRecentTokens: 2.5\n")).toThrow(
      /pi\.compaction\.keepRecentTokens must be a positive integer/,
    );
  });

  it("refuses a non-mapping and an unknown key at either level, naming the key", () => {
    expect(() => store(YAML_FIXTURE + "pi: true\n")).toThrow(/pi must be a mapping/);
    expect(() => store(YAML_FIXTURE + "pi:\n  compaction: 16384\n")).toThrow(/pi\.compaction must be a mapping/);
    expect(() => store(YAML_FIXTURE + "pi:\n  reserveTokens: 16384\n")).toThrow(/pi\.reserveTokens is not a known key/);
    expect(() => store(YAML_FIXTURE + "pi:\n  compaction:\n    enabled: false\n")).toThrow(
      /pi\.compaction\.enabled is not a known key/,
    );
  });
});

// Feature: docs/reference/specs/harness.md item 8 — the `opencode` block: the
// compaction thresholds the harness writes into OpenCode's per-run
// configuration for every run on OpenCode, under OpenCode's own words
// (`buffer`, `keepTokens`), the way the `pi` block feeds pi; positive integers
// in tokens, every other shape refused by name, and no block at all leaves
// OpenCode on its own defaults.
describe("opencode block (opencode.compaction.buffer, opencode.compaction.keepTokens)", () => {
  it("parses both thresholds, either alone, and an empty compaction block; an absent block leaves the field unset", () => {
    expect(
      store(YAML_FIXTURE + "opencode:\n  compaction:\n    buffer: 20000\n    keepTokens: 8000\n").config.opencode,
    ).toEqual({ compaction: { buffer: 20_000, keepTokens: 8_000 } });
    expect(store(YAML_FIXTURE + "opencode:\n  compaction:\n    keepTokens: 8000\n").config.opencode).toEqual({
      compaction: { keepTokens: 8_000 },
    });
    expect(store(YAML_FIXTURE + "opencode:\n  compaction: {}\n").config.opencode).toEqual({ compaction: {} });
    expect(store().config.opencode).toBeUndefined();
  });

  it("refuses a threshold that is not a positive integer by name — a float, zero, a negative, a string", () => {
    for (const value of ["1.5", "0", "-1", '"16384"', "true"])
      expect(() => store(YAML_FIXTURE + `opencode:\n  compaction:\n    buffer: ${value}\n`)).toThrow(
        /opencode\.compaction\.buffer must be a positive integer/,
      );
    expect(() => store(YAML_FIXTURE + "opencode:\n  compaction:\n    keepTokens: 2.5\n")).toThrow(
      /opencode\.compaction\.keepTokens must be a positive integer/,
    );
  });

  it("refuses a non-mapping and an unknown key at either level, naming the key — pi's words are not OpenCode's", () => {
    expect(() => store(YAML_FIXTURE + "opencode: true\n")).toThrow(/opencode must be a mapping/);
    expect(() => store(YAML_FIXTURE + "opencode:\n  compaction: 16384\n")).toThrow(
      /opencode\.compaction must be a mapping/,
    );
    expect(() => store(YAML_FIXTURE + "opencode:\n  buffer: 16384\n")).toThrow(/opencode\.buffer is not a known key/);
    expect(() => store(YAML_FIXTURE + "opencode:\n  compaction:\n    reserveTokens: 150000\n")).toThrow(
      /opencode\.compaction\.reserveTokens is not a known key/,
    );
  });
});

// `references` block (record 0037): the linked-thread resolver's switch, off
// until a deployment turns it on, validated at load like `routing.auto`.
describe("references block (references.enabled)", () => {
  it("parses enabled; an absent block leaves the field unset and the resolver off", () => {
    expect(store(YAML_FIXTURE + "references:\n  enabled: true\n").config.references).toEqual({ enabled: true });
    expect(store().config.references).toBeUndefined();
    expect(referencesOn(store().config)).toBe(false);
    expect(referencesOn(store(YAML_FIXTURE + "references:\n  enabled: true\n").config)).toBe(true);
    expect(referencesOn(store(YAML_FIXTURE + "references:\n  enabled: false\n").config)).toBe(false);
  });

  it("refuses a non-boolean enabled and an unknown key by name", () => {
    expect(() => store(YAML_FIXTURE + 'references:\n  enabled: "yes"\n')).toThrow(
      /references\.enabled must be true or false/,
    );
    expect(() => store(YAML_FIXTURE + "references:\n  enabled: 1\n")).toThrow(
      /references\.enabled must be true or false/,
    );
    expect(() => store(YAML_FIXTURE + "references:\n  enable: true\n")).toThrow(
      /references\.enable is not a known key/,
    );
  });
});
