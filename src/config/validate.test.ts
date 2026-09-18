import { describe, expect, it } from "vitest";
import type { AppConfig, Scope } from "../config.js";
import { boundaryProblem, validateBoundaries, validateProviders, validateSlack } from "./validate.js";
import { wireOf, type ProviderConfig } from "../core/provider.js";

const providers = (blocks: Record<string, unknown>): AppConfig => ({ providers: blocks }) as unknown as AppConfig;

// Feature: docs/reference/specs/model-proxy.md item 11 and
// docs/reference/specs/routing-and-config.md item 2 — the block's declaration
// (record 0052): `wire` is the spelling, `type` loads as its alias for one
// release, and a malformed override is refused by name.
describe("validateProviders — the block's declaration", () => {
  it("loads `type: openai-compatible` as `wire: openai-chat` and `type: anthropic` as `wire: anthropic-messages`", () => {
    const cfg = providers({
      anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
      openai: { type: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
    });
    validateProviders(cfg, "config.yaml");
    expect(wireOf(cfg.providers.anthropic as ProviderConfig)).toBe("anthropic-messages");
    expect(wireOf(cfg.providers.openai as ProviderConfig)).toBe("openai-chat");
  });

  it("derives the legacy type from `wire` alone, so a block that declares wire keeps loading", () => {
    const cfg = providers({ openai: { wire: "openai-responses", baseUrl: "https://api.openai.com/v1" } });
    validateProviders(cfg, "config.yaml");
    expect((cfg.providers.openai as ProviderConfig).type).toBe("openai-compatible");
    expect(wireOf(cfg.providers.openai as ProviderConfig)).toBe("openai-responses");
  });

  it("refuses a block that declares neither, both, an unknown wire, a catalog the registry does not ship, or a vendor: model block with a slashless model", () => {
    expect(() => validateProviders(providers({ a: {} }), "config.yaml")).toThrow(/providers\.a must declare wire/);
    expect(() =>
      validateProviders(providers({ a: { type: "anthropic", wire: "anthropic-messages" } }), "config.yaml"),
    ).toThrow(/declares both type and wire/);
    expect(() => validateProviders(providers({ a: { wire: "openai-json" } }), "config.yaml")).toThrow(
      /providers\.a\.wire must be anthropic-messages, openai-chat, openai-responses/,
    );
    expect(() => validateProviders(providers({ a: { wire: "openai-chat", catalog: "nope" } }), "config.yaml")).toThrow(
      /providers\.a\.catalog names "nope"/,
    );
    expect(() =>
      validateProviders(
        providers({ a: { wire: "openai-chat", vendor: "model", models: { "gpt-5": {} } } }),
        "config.yaml",
      ),
    ).toThrow(/providers\.a\.models\.gpt-5: a vendor: model block names its models <vendor>\/<id>/);
  });

  it("refuses a malformed models.<id>.levels by name", () => {
    expect(() =>
      validateProviders(
        providers({ a: { wire: "openai-chat", models: { "m-1": { levels: { turbo: "high" } } } } }),
        "config.yaml",
      ),
    ).toThrow(/providers\.a\.models\.m-1\.levels\.turbo is not an effort/);
    expect(() =>
      validateProviders(
        providers({ a: { wire: "openai-chat", models: { "m-1": { levels: { high: 3 } } } } }),
        "config.yaml",
      ),
    ).toThrow(/providers\.a\.models\.m-1\.levels\.high must be a wire word or null/);
  });

  it("refuses a malformed models.<id>.answers by name: not a list, or a word that is not an answer shape", () => {
    expect(() =>
      validateProviders(
        providers({ a: { wire: "openai-chat", models: { "m-1": { answers: "tool" } } } }),
        "config.yaml",
      ),
    ).toThrow(/providers\.a\.models\.m-1\.answers must be a list of answer shapes \(tool, text\)/);
    expect(() =>
      validateProviders(
        providers({ a: { wire: "openai-chat", models: { "m-1": { answers: ["tool", "json"] } } } }),
        "config.yaml",
      ),
    ).toThrow(/providers\.a\.models\.m-1\.answers carries "json", which is not an answer shape \(tool, text\)/);
    expect(() =>
      validateProviders(
        providers({ a: { wire: "openai-chat", models: { "m-1": { answers: ["text"] } } } }),
        "config.yaml",
      ),
    ).not.toThrow();
  });

  it("accepts a well-formed override: levels as words or null, a window, inputs, a cache rule and a price", () => {
    const cfg = providers({
      a: {
        wire: "openai-chat",
        models: {
          "v/m-1": {
            levels: { high: "high", xhigh: null },
            capField: "max_tokens",
            window: 1_048_576,
            inputs: { image: true, document: false },
            cache: "automatic",
            price: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
          },
        },
      },
    });
    expect(() => validateProviders(cfg, "config.yaml")).not.toThrow();
  });
});

/** A scope as a stored document carries it — any shape, typed as nothing yet — so the test can hand the validator the words it must refuse. */
const stored = (boundary: Record<string, unknown>): Scope => ({ boundary }) as unknown as Scope;

// Feature: docs/reference/specs/routing-and-config.md item 2 (record 0044, the
// confirm axis) — the validator holds `boundary.confirm` to its two settable
// classes wherever config can carry a boundary. `exec` and `never` are words
// on or beside the ladder that no scope may set yet, each refused with its own
// reason; any other word is refused with the class list; a stored `never` or
// `exec` stops the load exactly as a bad `maxMinutes` does.
describe("boundaryProblem — the confirm axis", () => {
  it("accepts the two settable classes, `write` and `destructive`, alone or beside the run axes", () => {
    expect(boundaryProblem("defaults.boundary", { confirm: "write" })).toBeUndefined();
    expect(boundaryProblem("defaults.boundary", { confirm: "destructive" })).toBeUndefined();
    expect(
      boundaryProblem("users.slack:UX.boundary", { maxMinutes: 45, maxIdentity: "read", confirm: "destructive" }),
    ).toBeUndefined();
  });

  it("refuses `exec` by name with its reason: a test or build never asks", () => {
    expect(boundaryProblem("channels.slack:CX.boundary", { confirm: "exec" })).toBe(
      'channels.slack:CX.boundary.confirm is "exec" — a test or build never asks (record 0044)',
    );
  });

  it("refuses `never` by name with its reason: the door's write misbind rate has not been measured over a period", () => {
    expect(boundaryProblem("users.slack:UX.boundary", { confirm: "never" })).toBe(
      'users.slack:UX.boundary.confirm is "never" — not allowed until the door\'s write misbind rate has been measured over a period (record 0044, open question 2)',
    );
  });

  it("refuses any other word with the two classes, in the shape of the identity message; a non-string too", () => {
    expect(boundaryProblem("defaults.boundary", { confirm: "read" })).toBe(
      'defaults.boundary.confirm is "read" — valid classes: write, destructive',
    );
    expect(boundaryProblem("defaults.boundary", { confirm: "always" })).toBe(
      'defaults.boundary.confirm is "always" — valid classes: write, destructive',
    );
    expect(boundaryProblem("defaults.boundary", { confirm: 1 })).toBe(
      'defaults.boundary.confirm is "1" — valid classes: write, destructive',
    );
  });

  it("the run axes are judged first, so a bad minutes cap is named before a bad confirm; an unknown field still wins over both", () => {
    expect(boundaryProblem("defaults.boundary", { maxMinutes: 1, confirm: "never" })).toBe(
      "defaults.boundary.maxMinutes must be an integer >= 2",
    );
    expect(boundaryProblem("defaults.boundary", { confirms: "write" })).toBe(
      "defaults.boundary: unknown field confirms",
    );
  });
});

describe("validateBoundaries — a stored confirm is held to the same rule at load", () => {
  it("a `never` under a user, an `exec` under the defaults and an unknown class under a channel each stop the load naming the source and the path", () => {
    expect(() => validateBoundaries({ users: { "slack:UX": stored({ confirm: "never" }) } }, "overrides.json")).toThrow(
      'overrides.json: users.slack:UX.boundary.confirm is "never" — not allowed until the door\'s write misbind rate has been measured over a period (record 0044, open question 2)',
    );
    expect(() => validateBoundaries({ defaults: { boundary: { confirm: "exec" } } }, "config.yaml")).toThrow(
      'config.yaml: defaults.boundary.confirm is "exec" — a test or build never asks (record 0044)',
    );
    expect(() =>
      validateBoundaries({ channels: { "slack:CX": stored({ confirm: "sometimes" }) } }, "config.yaml"),
    ).toThrow('config.yaml: channels.slack:CX.boundary.confirm is "sometimes" — valid classes: write, destructive');
  });

  it("the two classes load under every scope, alone or beside the run axes", () => {
    expect(() =>
      validateBoundaries(
        {
          defaults: { boundary: { maxMinutes: 120, confirm: "write" } },
          channels: { "slack:CX": { boundary: { confirm: "destructive" } } },
          users: { "slack:UX": { boundary: { maxIdentity: "read", confirm: "write" } } },
        },
        "config.yaml",
      ),
    ).not.toThrow();
  });
});

// Feature: docs/reference/specs/slack-channel.md item 13 — `slack.relayApps`
// names the apps whose relay footer is read for the person. Held to Slack's
// bot-id shape at load, so a typo cannot silently leave every relayed request
// billed to the app.
describe("validateSlack — the relay apps", () => {
  it("accepts an absent block, an absent list and a list of Slack bot ids", () => {
    expect(() => validateSlack(undefined)).not.toThrow();
    expect(() => validateSlack({ catchUp: { enabled: true } })).not.toThrow();
    expect(() => validateSlack({ relayApps: [] })).not.toThrow();
    expect(() => validateSlack({ relayApps: ["B0CLAUDE", "B0RELAY2"] })).not.toThrow();
  });

  it("refuses a block that is not a mapping, a list that is not a list, and an entry that is not a bot id, each by name", () => {
    expect(() => validateSlack("yes")).toThrow("config.yaml: slack must be a mapping");
    expect(() => validateSlack({ relayApps: "B0CLAUDE" })).toThrow(
      "config.yaml: slack.relayApps must be a list of Slack bot ids (B…)",
    );
    expect(() => validateSlack({ relayApps: ["slack:bot:B0CLAUDE"] })).toThrow(
      'config.yaml: slack.relayApps[0] is "slack:bot:B0CLAUDE" — a Slack bot id looks like B0ABC123',
    );
    expect(() => validateSlack({ relayApps: ["B0CLAUDE", 7] })).toThrow(
      'config.yaml: slack.relayApps[1] is "7" — a Slack bot id looks like B0ABC123',
    );
    expect(() => validateSlack({ relayApps: [""] })).toThrow('config.yaml: slack.relayApps[0] is ""');
  });
});
