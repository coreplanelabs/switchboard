import { Info as ConfigInfo } from "@opencode/schema/config";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { bearerHashOf } from "../../modelProxy/runBearers.js";
import {
  HARNESS_PORT_ENV,
  HarnessContainerError,
  HarnessContainerRuntimeReplacedError,
  PORT_ARG,
  type HarnessRequest,
  type HarnessResponse,
} from "../container.js";
import { HARNESS_URL_ENV, PROXY_PROVIDER, RUN_BEARER_ENV } from "../pi/process.js";
import { FakeHarnessContainer } from "../testing/fakeContainer.js";
import { OPENCODE_VERSION, openCodeAuthHeader, type OpenCodePermissionRule } from "./client.js";
import { OPENCODE_PLUGIN_SOURCE } from "./pluginSource.js";
import {
  ASK_ALL_RULE,
  OPENCODE_AGENT,
  OPENCODE_ALWAYS_DENIED,
  OPENCODE_BIN,
  OPENCODE_BUILTIN_TOOLS,
  OPENCODE_NONE_DENIED,
  OPENCODE_PASSWORD_ENV,
  OPENCODE_PLUGIN_REF,
  OPENCODE_READ_TOOLS,
  OpenCodeNotReadyError,
  TAILER_BIN,
  configProblem,
  launchOpenCode,
  loadedDocument,
  openCodeBuiltinToolsFor,
  openCodeConfig,
  openCodeConfigJson,
  openCodeFacts,
  openCodeLaunchArgs,
  openCodeLaunchEnv,
  openCodeLaunchFiles,
  openCodePassword,
  openCodePermissionRules,
  openCodePromptNote,
  openCodeRunPaths,
  openCodeRunPathsAt,
  openCodeTailerEnv,
  openCodeVariantId,
  openCodeVariants,
  type OpenCodeLaunchSpec,
} from "./process.js";
import type { ModelCard } from "../../modelCard.js";
import { OPENCODE_SERVE_PID_ENV, OPENCODE_TAILER_SOURCE } from "./tailerSource.js";

// Feature: docs/reference/specs/harness.md, the OpenCode process item — how a
// run's OpenCode is launched: per-run roots under the run, the
// bearer as the provider key through the environment (never a command line,
// never a model key), the proxy as the one provider, the `switchboard` agent
// whose rules ask the bot before every tool and hide what the identity does
// not hold, the launch through the seam on a picked port, readiness by name,
// the tailer beside it.

const BEARER = "sbr_run-7.a-secret-of-the-runs-own";

const spec: OpenCodeLaunchSpec = {
  runId: "run-7",
  paths: openCodeRunPaths("run-7"),
  model: { id: "claude-fable-5", providerType: "anthropic", maxTokens: 64000 },
  harnessUrl: "https://bot.example.com/",
  identity: "write",
  system: "You are the coding agent.\n",
  relayTools: ["update_status", "submit_pr_description"],
};

/** The review preset's launch: a read identity on the completions dialect. */
const reviewSpec: OpenCodeLaunchSpec = {
  ...spec,
  model: { id: "gpt-x-large", providerType: "openai-compatible", maxTokens: 32000 },
  identity: "read",
  system: "You are the review agent.\n",
  relayTools: ["update_status", "submit_verdict", "diff_digest"],
};

/** The general preset's launch: no identity and no workspace, on the bot host. */
const generalSpec: OpenCodeLaunchSpec = {
  ...spec,
  identity: "none",
  harnessUrl: "http://127.0.0.1:8080",
  system: "You are the general agent.\n",
  relayTools: ["web_fetch", "update_status", "github_repos"],
};

/** A card fixture (record 0052): the wire-default card, overridable per test. */
const cardOf = (over: Partial<ModelCard>): ModelCard => ({
  ref: "openrouter/acme/m1",
  block: "openrouter",
  model: "acme/m1",
  vendor: "acme",
  wire: "openai-chat",
  levels: "unknown",
  capField: "max_completion_tokens",
  window: 128_000,
  inputs: { image: "unknown", document: "unknown" },
  cache: "unknown",
  provenance: { levels: "wire", capField: "wire", window: "wire", inputs: "wire", cache: "wire", price: "wire" },
  ...over,
});

/** A card whose registry names every tier (`max` refused), caps under
 *  `max_tokens` and knows the window — the known-card scenario. */
const knownCard = cardOf({
  levels: {
    low: { word: "low", named: true },
    medium: { word: "medium", named: true },
    high: { word: "high", named: true },
    xhigh: { word: "high", named: false },
    max: "refused",
  },
  capField: "max_tokens",
  window: 131_072,
  inputs: { image: true, document: false },
  provenance: {
    levels: "registry",
    capField: "registry",
    window: "registry",
    inputs: "registry",
    cache: "wire",
    price: "wire",
  },
});

const SPECS: Array<[string, OpenCodeLaunchSpec]> = [
  ["write on the Anthropic dialect", spec],
  ["read on the completions dialect", reviewSpec],
  ["none on the Anthropic dialect", generalSpec],
  ["a card on the completions dialect", { ...reviewSpec, card: knownCard }],
  ["a card on the Anthropic dialect", { ...spec, card: cardOf({ wire: "anthropic-messages", cache: "markers" }) }],
];

/** OpenCode's own judgement, as its evaluator makes it (`findLast` over the
 *  agent's rules then the session's; an unmatched action asks): what a rule
 *  list means, so the tests read the outcome and not the list. */
function evaluate(action: string, rules: readonly OpenCodePermissionRule[]): OpenCodePermissionRule["effect"] {
  const match = (pattern: string) => pattern === "*" || pattern === action;
  for (let i = rules.length - 1; i >= 0; i--)
    if (match(rules[i].action) && rules[i].resource === "*") return rules[i].effect;
  return "ask";
}

const decodeConfig = Schema.decodeUnknownResult(ConfigInfo, { errors: "all" });

describe("openCodeRunPaths", () => {
  it("files the run directly under /var/tmp, outside the shared temp directory, every path derived from the run id, the XDG roots among the directories the start makes; HOME is left the container user's", () => {
    const p = openCodeRunPaths("run-7");
    expect(p.dir.startsWith("/tmp/")).toBe(false);
    expect(p.dir).toBe("/var/tmp/switchboard-oc-run-7");
    expect(p.dirs[0]).toBe(p.dir);
    expect(p.dirs).toEqual(
      expect.arrayContaining([p.xdg.data, p.xdg.config, p.xdg.cache, p.xdg.state, p.pluginDir, p.commandDir]),
    );
    expect(p.xdg).toEqual({
      data: `${p.dir}/xdg/data`,
      config: `${p.dir}/xdg/config`,
      cache: `${p.dir}/xdg/cache`,
      state: `${p.dir}/xdg/state`,
    });
    expect(p).not.toHaveProperty("home");
    expect(p.config).toBe(`${p.dir}/opencode.json`);
    expect(p.pluginDir).toBe(`${p.dir}/plugins/switchboard`);
    expect(p.plugin).toBe(`${p.pluginDir}/index.js`);
    expect(p.feed).toBe(`${p.dir}/feed.jsonl`);
    expect(p.tailerScript).toBe(`${p.dir}/tailer.js`);
    expect({ fifo: p.fifo, log: p.log, errLog: p.errLog, pidFile: p.pidFile, commandDir: p.commandDir }).toEqual({
      fifo: `${p.dir}/serve.in`,
      log: `${p.dir}/serve.log`,
      errLog: `${p.dir}/serve.err`,
      pidFile: `${p.dir}/pid`,
      commandDir: `${p.dir}/cmd`,
    });
  });

  it("gives the tailer a seam layout of its own under the same root, its log the feed, so its stdout lands where the harness reads", () => {
    const p = openCodeRunPaths("run-7");
    expect(p.tailer.dir).toBe(p.dir);
    expect(p.tailer.log).toBe(p.feed);
    expect(p.tailer.fifo).toBe(`${p.dir}/tailer.in`);
    expect(p.tailer.errLog).toBe(`${p.dir}/tailer.err`);
    expect(p.tailer.pidFile).toBe(`${p.dir}/tailer.pid`);
    expect(p.tailer.commandDir).toBe(p.commandDir);
    expect(p.tailer.fifo).not.toBe(p.fifo);
    expect(p.tailer.pidFile).not.toBe(p.pidFile);
  });

  it("openCodeRunPathsAt lays the same files under the root a row recorded, so a re-attach reads the feed where that build put it", () => {
    const recorded = openCodeRunPathsAt("/tmp/switchboard-oc-run-7-k3");
    expect(recorded.feed).toBe("/tmp/switchboard-oc-run-7-k3/feed.jsonl");
    expect(recorded.config).toBe("/tmp/switchboard-oc-run-7-k3/opencode.json");
    expect(openCodeRunPathsAt("/var/tmp/switchboard-oc-run-7")).toEqual(openCodeRunPaths("run-7"));
  });
});

describe("openCodeLaunchArgs and the environment", () => {
  it("serves on loopback on the port the seam picks: the placeholder among the arguments, never a port of its own", () => {
    expect(openCodeLaunchArgs()).toEqual(["serve", "--hostname", "127.0.0.1", "--port", PORT_ARG]);
  });

  it("hands the server exactly the run's variables — the bearer under the configuration's name, the bot's URL, the roots, the config, both project-config switches, the catalogue and update switches, the in-memory store, the password — and never a provider key, whatever the bot's process holds", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-never");
    vi.stubEnv("OPENAI_API_KEY", "sk-never");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-never");
    try {
      const env = openCodeLaunchEnv(spec, BEARER, "pw-1");
      expect(Object.keys(env).sort()).toEqual(
        [
          RUN_BEARER_ENV,
          HARNESS_URL_ENV,
          "SWITCHBOARD_RUN_ID",
          "XDG_DATA_HOME",
          "XDG_CONFIG_HOME",
          "XDG_CACHE_HOME",
          "XDG_STATE_HOME",
          "OPENCODE_CONFIG",
          "OPENCODE_CONFIG_PROJECT_DISABLE",
          "OPENCODE_DISABLE_PROJECT_CONFIG",
          "OPENCODE_DISABLE_MODELS_FETCH",
          "OPENCODE_DISABLE_AUTOUPDATE",
          "OPENCODE_DB",
          OPENCODE_PASSWORD_ENV,
        ].sort(),
      );
      expect(env[RUN_BEARER_ENV]).toBe(BEARER);
      expect(env[HARNESS_URL_ENV]).toBe("https://bot.example.com/");
      expect(env.SWITCHBOARD_RUN_ID).toBe("run-7");
      expect(env).not.toHaveProperty("HOME");
      expect(env.XDG_DATA_HOME).toBe(spec.paths.xdg.data);
      expect(env.XDG_CONFIG_HOME).toBe(spec.paths.xdg.config);
      expect(env.XDG_CACHE_HOME).toBe(spec.paths.xdg.cache);
      expect(env.XDG_STATE_HOME).toBe(spec.paths.xdg.state);
      expect(env.OPENCODE_CONFIG).toBe(spec.paths.config);
      expect(env.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("1");
      expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
      expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1");
      expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
      expect(env.OPENCODE_DB).toBe(":memory:");
      expect(env[OPENCODE_PASSWORD_ENV]).toBe("pw-1");
      for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_SERVER_PASSWORD"])
        expect(env).not.toHaveProperty(key);
      const values = Object.values(env).join("\n");
      expect(values).not.toContain("sk-ant-never");
      expect(values).not.toContain("sk-never");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the tailer's environment is the password and the server's pid; its port rides the seam's own variable", () => {
    expect(openCodeTailerEnv("pw-1", 4242)).toEqual({
      [OPENCODE_PASSWORD_ENV]: "pw-1",
      [OPENCODE_SERVE_PID_ENV]: "4242",
    });
    expect(HARNESS_PORT_ENV).toBe("SWITCHBOARD_HARNESS_PORT");
    expect(OPENCODE_TAILER_SOURCE).toContain(`process.env.${HARNESS_PORT_ENV}`);
    expect(OPENCODE_TAILER_SOURCE).toContain(`process.env.${OPENCODE_PASSWORD_ENV}`);
    expect(OPENCODE_TAILER_SOURCE).toContain(`process.env.${OPENCODE_SERVE_PID_ENV}`);
  });
});

describe("openCodePassword", () => {
  it("is the bearer's hash — per run, random because the bearer is, derivable by a later generation from the row's bearerHash, and no bearer", () => {
    const password = openCodePassword(BEARER);
    expect(password).toBe(bearerHashOf(BEARER));
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(password).not.toContain("a-secret-of-the-runs-own");
    expect(openCodePassword(BEARER)).toBe(password);
  });

  it("a bearer of another shape, which no row can name, gets a random password each time", () => {
    const one = openCodePassword("not-a-run-bearer");
    const two = openCodePassword("not-a-run-bearer");
    expect(one).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(two).not.toBe(one);
  });
});

describe("the gate's rules and the identity's tools", () => {
  it("every identity's rules begin with the ask-on-all rule and end in its denies, so under OpenCode's last-match evaluator the denies stand and everything else asks", () => {
    for (const identity of ["write", "read", "none"] as const) {
      const rules = openCodePermissionRules(identity);
      expect(rules[0]).toEqual(ASK_ALL_RULE);
      for (const rule of rules.slice(1)) expect(rule).toMatchObject({ resource: "*", effect: "deny" });
      expect(evaluate("shell", rules)).toBe(identity === "none" ? "deny" : "ask");
      expect(evaluate("update_status", rules)).toBe("ask");
      expect(evaluate("question", rules)).toBe("deny");
      expect(evaluate("subagent", rules)).toBe("deny");
      expect(evaluate("execute", rules)).toBe("deny");
      expect(evaluate("webfetch", rules)).toBe("deny");
      expect(evaluate("websearch", rules)).toBe("deny");
    }
  });

  it("a write run keeps every workspace tool on the ask road; a read run's edit is denied; a run without an identity has every workspace tool and the directory boundary denied", () => {
    const write = openCodePermissionRules("write");
    expect(write.slice(1).map((r) => r.action)).toEqual(OPENCODE_ALWAYS_DENIED);
    for (const action of ["read", "edit", "shell", "glob", "grep", "skill", "external_directory"])
      expect(evaluate(action, write)).toBe("ask");

    const read = openCodePermissionRules("read");
    expect(evaluate("edit", read)).toBe("deny");
    for (const action of ["read", "shell", "glob", "grep", "skill", "external_directory"])
      expect(evaluate(action, read)).toBe("ask");

    const none = openCodePermissionRules("none");
    for (const action of OPENCODE_NONE_DENIED) expect(evaluate(action, none)).toBe("deny");
    expect(none.slice(1).map((r) => r.action)).toEqual([...OPENCODE_ALWAYS_DENIED, ...OPENCODE_NONE_DENIED]);
  });

  it("the ask rule first is load-bearing: the same denies with the ask rule last would ask for everything and hide nothing", () => {
    const rules = openCodePermissionRules("none");
    const reversed = [...rules.slice(1), ASK_ALL_RULE];
    expect(evaluate("read", rules)).toBe("deny");
    expect(evaluate("read", reversed)).toBe("ask");
  });

  it("the built-in tools follow the identity: all for write, nothing that writes for read, none without one — the tools the denies leave visible", () => {
    expect(openCodeBuiltinToolsFor("write")).toEqual(OPENCODE_BUILTIN_TOOLS);
    expect(openCodeBuiltinToolsFor("read")).toEqual(OPENCODE_READ_TOOLS);
    expect(openCodeBuiltinToolsFor("none")).toEqual([]);
    expect(OPENCODE_READ_TOOLS).not.toContain("edit");
    expect(OPENCODE_READ_TOOLS).not.toContain("write");
    for (const tool of OPENCODE_BUILTIN_TOOLS) expect(OPENCODE_ALWAYS_DENIED).not.toContain(tool);
  });

  it("the harness note names OpenCode's own tools for the identity, maps the native names onto them, and lists the relayed tools", () => {
    const write = openCodePromptNote(spec.relayTools, "write");
    expect(write).toContain("`read`, `shell`, `edit`, `write`, `glob`, `grep` and `skill`");
    expect(write).toContain("where they say `bash` use `shell`");
    expect(write).toContain("`update_status`, `submit_pr_description`");
    const read = openCodePromptNote(reviewSpec.relayTools, "read");
    expect(read).toContain("it has no `edit` and no `write`");
    expect(read).not.toContain("`write_file`");
    const none = openCodePromptNote(generalSpec.relayTools, "none");
    expect(none).toContain("this run has no workspace");
    expect(none).toContain("exactly these");
    expect(openCodePromptNote([], "none")).toContain("No tools are available in this run.");
  });
});

describe("the configuration writer", () => {
  it.each(SPECS)("%s: validates against the pinned v2 schema", (_name, s) => {
    const result = decodeConfig(JSON.parse(openCodeConfigJson(s)));
    expect(result._tag, result._tag === "Failure" ? String(result.failure) : "").toBe("Success");
  });

  it("the schema bites: a value outside its literals is refused, so the passes above mean something", () => {
    const broken = { ...openCodeConfig(spec), update: "bogus" };
    expect(decodeConfig(broken)._tag).toBe("Failure");
  });

  it("names the proxy as the one provider on the run's dialect, its key the bearer's variable, a zero rate card and the run's output cap, and that model as the default", () => {
    const anthropic = openCodeConfig(spec) as any;
    expect(Object.keys(anthropic.providers)).toEqual([PROXY_PROVIDER]);
    expect(anthropic.providers.switchboard).toMatchObject({
      package: "aisdk:@ai-sdk/anthropic",
      settings: { baseURL: "https://bot.example.com/v1", apiKey: `{env:${RUN_BEARER_ENV}}` },
    });
    expect(anthropic.providers.switchboard.models).toEqual({
      "claude-fable-5": {
        name: "claude-fable-5",
        limit: { context: 200000, output: 64000 },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      },
    });
    expect(anthropic.model).toBe("switchboard/claude-fable-5");
    const completions = openCodeConfig(reviewSpec) as any;
    expect(completions.providers.switchboard.package).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(completions.providers.switchboard.settings.baseURL).toBe("https://bot.example.com/v1");
    expect(completions.model).toBe("switchboard/gpt-x-large");
    const loopback = openCodeConfig(generalSpec) as any;
    expect(loopback.providers.switchboard.settings.baseURL).toBe("http://127.0.0.1:8080/v1");
  });

  // A Responses block on OpenCode is refused at dispatch until the bundled
  // @ai-sdk/openai is measured against the logging fake (model-proxy item 1);
  // the wire's mapping is written here so the configuration is right when the
  // measurement lifts the refusal.
  it("an openai-responses card maps onto @ai-sdk/openai under the proxy's /v1 with no chat cap compat — max_output_tokens is that package's own spelling", () => {
    const card = cardOf({
      ref: "openai/gpt-5.4",
      block: "openai",
      model: "gpt-5.4",
      wire: "openai-responses",
      capField: "max_output_tokens",
    });
    const responses = openCodeConfig({
      ...reviewSpec,
      model: { ...reviewSpec.model, id: "gpt-5.4" },
      card,
    }) as any;
    expect(responses.providers.switchboard.package).toBe("aisdk:@ai-sdk/openai");
    expect(responses.providers.switchboard.settings.baseURL).toBe("https://bot.example.com/v1");
    expect(responses.providers.switchboard.models["gpt-5.4"]).not.toHaveProperty("compatibility");
  });

  // The card written into the document (record 0052): the word on the wire is
  // the card's, never one the harness chose.
  const modelEntry = (s: OpenCodeLaunchSpec) => (openCodeConfig(s) as any).providers[PROXY_PROVIDER].models[s.model.id];

  it("a known card writes its window as limit.context, its inputs as capabilities.input, its cap field, and one variant per tier it does not refuse", () => {
    const entry = modelEntry({ ...reviewSpec, card: knownCard });
    expect(entry.limit).toEqual({ context: 131072, output: 32000 });
    expect(entry.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] });
    expect(entry.compatibility).toEqual({ maxTokensField: "max_tokens" });
    // `max` is refused on the card, so no variant declares it; the fallback
    // tier's overlay spells the card's word (`high`), never the tier's own.
    expect(entry.variants).toEqual([
      { id: "low", body: { reasoning_effort: "low" } },
      { id: "medium", body: { reasoning_effort: "medium" } },
      { id: "high", body: { reasoning_effort: "high" } },
      { id: "xhigh", body: { reasoning_effort: "high" } },
    ]);
  });

  it("an unknown card writes the identity variants — five tiers, each overlay the tier's own word, unvouched — and its window", () => {
    const entry = modelEntry({ ...reviewSpec, card: cardOf({}) });
    expect(entry.limit.context).toBe(128000);
    expect(entry.capabilities.input).toEqual(["text", "image"]);
    expect(entry.variants.map((v: { id: string }) => v.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(entry.variants[3].body).toEqual({ reasoning_effort: "xhigh" });
    // The wire's own field, still spelled explicitly: the document says what
    // the card decided, default or not.
    expect(entry.compatibility).toEqual({ maxTokensField: "max_completion_tokens" });
  });

  it("the Anthropic dialect spells the tier as adaptive output_config.effort, and its cap field stays the dialect's own", () => {
    const entry = modelEntry({ ...spec, card: cardOf({ wire: "anthropic-messages", capField: "max_tokens" }) });
    expect(entry.variants[4]).toEqual({
      id: "max",
      body: { thinking: { type: "adaptive" }, output_config: { effort: "max" } },
    });
    expect(entry).not.toHaveProperty("compatibility");
  });

  it("a card that says no images narrows capabilities.input to text; no card declares no capabilities and no variants", () => {
    const entry = modelEntry({ ...reviewSpec, card: cardOf({ inputs: { image: false, document: "unknown" } }) });
    expect(entry.capabilities.input).toEqual(["text"]);
    const bare = modelEntry(reviewSpec);
    expect(bare).not.toHaveProperty("capabilities");
    expect(bare).not.toHaveProperty("variants");
  });

  it("a budget Anthropic model has no adaptive word to spell, so it gets no variants and no session variant", () => {
    const budget = { id: "claude-sonnet-4", providerType: "anthropic" as const, maxTokens: 64000 };
    expect(openCodeVariants(budget, cardOf({ wire: "anthropic-messages" }))).toBeUndefined();
    expect(openCodeVariantId("high", budget, cardOf({ wire: "anthropic-messages" }))).toBeUndefined();
  });

  it("the session's variant is the tier exactly when the document declares it: a refused tier and a card-less run select none", () => {
    const model = { id: "gpt-x-large", providerType: "openai-compatible" as const, maxTokens: 32000 };
    expect(openCodeVariantId("xhigh", model, knownCard)).toBe("xhigh");
    expect(openCodeVariantId("max", model, knownCard)).toBeUndefined();
    expect(openCodeVariantId("high", model, undefined)).toBeUndefined();
    expect(openCodeVariantId(undefined, model, knownCard)).toBeUndefined();
  });

  it("carries no secret: the bearer is a variable's name in the file, never its value", () => {
    for (const [, s] of SPECS) {
      const text = openCodeConfigJson(s);
      expect(text).toContain(`{env:${RUN_BEARER_ENV}}`);
      expect(text).not.toContain("sbr_");
    }
  });

  it("makes the switchboard agent the default, primary, with the composed prompt and the identity's rules, and removes the title agent so the first prompt spends no proxy turn on a title", () => {
    for (const [, s] of SPECS) {
      const config = openCodeConfig(s) as any;
      expect(config.default_agent).toBe(OPENCODE_AGENT);
      expect(config.agents.switchboard.mode).toBe("primary");
      expect(config.agents.switchboard.system).toBe(
        `${s.system.trimEnd()}\n\n${openCodePromptNote(s.relayTools, s.identity)}\n`,
      );
      expect(config.agents.switchboard.permissions).toEqual(openCodePermissionRules(s.identity));
      expect(config.agents.title).toEqual({ disabled: true });
    }
  });

  it("references the relay plugin as a directory beside the file, and switches every phone-home and side effect off", () => {
    const config = openCodeConfig(spec) as any;
    expect(config.plugins).toEqual([OPENCODE_PLUGIN_REF]);
    expect(OPENCODE_PLUGIN_REF).toMatch(/^\.\//);
    expect(OPENCODE_PLUGIN_REF).not.toMatch(/\.js$/);
    expect(config).toMatchObject({
      update: "disable",
      share: "disabled",
      snapshots: false,
      lsp: false,
      formatter: false,
    });
    expect(config).not.toHaveProperty("compaction");
  });

  it("carries the deployment's compaction thresholds under OpenCode's own keys when set, and validates with them", () => {
    const withBoth = openCodeConfig({ ...spec, compaction: { buffer: 20000, keepTokens: 40000 } }) as any;
    expect(withBoth.compaction).toEqual({ buffer: 20000, keep: { tokens: 40000 } });
    expect(decodeConfig(withBoth)._tag).toBe("Success");
    const bufferOnly = openCodeConfig({ ...spec, compaction: { buffer: 20000 } }) as any;
    expect(bufferOnly.compaction).toEqual({ buffer: 20000 });
    const empty = openCodeConfig({ ...spec, compaction: {} }) as any;
    expect(empty).not.toHaveProperty("compaction");
  });

  it("the files: the configuration, the relay plugin that speaks the bot's protocol, the tailer — none of them a secret", () => {
    const files = openCodeLaunchFiles(spec);
    expect(files.map((f) => f.path)).toEqual([spec.paths.config, spec.paths.plugin, spec.paths.tailerScript]);
    expect(files[0].content).toBe(openCodeConfigJson(spec));
    // The relay plugin (U12), not the placeholder: it registers the run's tools
    // from GET /harness/tools and speaks pi's `/harness/*` protocol.
    expect(files[1].content).toBe(OPENCODE_PLUGIN_SOURCE);
    expect(files[1].content).toContain("/harness/tools");
    expect(files[1].content).toContain("/harness/authorize");
    expect(files[1].content).toContain("/harness/tool");
    expect(files[2].content).toBe(OPENCODE_TAILER_SOURCE);
    for (const f of files) expect(f.content).not.toContain("sbr_");
  });
});

describe("configProblem — the loaded document held against what was written", () => {
  const info = openCodeConfig(spec);

  it("finds nothing wrong with the document as written", () => {
    expect(configProblem(info, spec)).toBeUndefined();
    expect(
      configProblem(openCodeConfig({ ...spec, compaction: { buffer: 1 } }), { ...spec, compaction: { buffer: 1 } }),
    ).toBeUndefined();
  });

  it("names the clause-carrying key OpenCode dropped, by key", () => {
    const without = (key: string) => {
      const copy: Record<string, unknown> = { ...info };
      delete copy[key];
      return copy;
    };
    expect(configProblem(without("providers"), spec)).toBe(`providers.${PROXY_PROVIDER} did not take`);
    expect(configProblem(without("default_agent"), spec)).toBe(`default_agent is not ${OPENCODE_AGENT}`);
    expect(configProblem({ ...info, agents: { title: { disabled: true } } }, spec)).toBe(
      `agents.${OPENCODE_AGENT} did not take`,
    );
    expect(configProblem({ ...info, agents: { switchboard: {} } }, spec)).toBe("agents.title.disabled did not take");
    expect(configProblem(without("plugins"), spec)).toBe("plugins did not take");
    expect(configProblem(without("update"), spec)).toBe("update is not disable");
    expect(configProblem(without("share"), spec)).toBe("share is not disabled");
    expect(configProblem(without("snapshots"), spec)).toBe("snapshots is not false");
    expect(configProblem(without("lsp"), spec)).toBe("lsp is not false");
    expect(configProblem(without("formatter"), spec)).toBe("formatter is not false");
    expect(configProblem(info, { ...spec, compaction: { buffer: 1 } })).toBe("compaction did not take");
  });

  it("loadedDocument picks the run's own file among the entries, and nothing when the server did not load it", () => {
    const entries = [
      { type: "directory" as const, path: `${spec.paths.xdg.config}/opencode` },
      { type: "document" as const, path: spec.paths.config, info },
    ];
    expect(loadedDocument(entries, spec.paths.config)).toBe(info);
    expect(loadedDocument(entries.slice(0, 1), spec.paths.config)).toBeUndefined();
    expect(
      loadedDocument([{ type: "document", path: "/elsewhere/opencode.json", info }], spec.paths.config),
    ).toBeUndefined();
  });
});

/** A launch over the fake container: a scripted server answering the three
 *  readiness routes, the clock advanced by every sleep. */
function harness(
  opts: { onRequest?: (req: HarnessRequest, container: FakeHarnessContainer) => HarnessResponse; feed?: false } = {},
) {
  const container = new FakeHarnessContainer();
  let now = 1_000_000;
  const clock = () => now;
  const sleep = async (ms: number) => {
    now += ms;
  };
  const password = openCodePassword(BEARER);
  const auth = openCodeAuthHeader(password);
  const json = (status: number, body: unknown): HarnessResponse => ({
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const health = (version = OPENCODE_VERSION) => json(200, { healthy: true, version, pid: 77 });
  /** The configuration route echoing what the launch wrote, as the server would after parsing it. */
  const configEcho = (
    c: FakeHarnessContainer,
    s: OpenCodeLaunchSpec,
    mutate?: (info: Record<string, unknown>) => void,
  ) => {
    const written = c.files.get(s.paths.config);
    const info = written ? (JSON.parse(written) as Record<string, unknown>) : {};
    mutate?.(info);
    return json(200, [
      { type: "directory", path: `${s.paths.xdg.config}/opencode` },
      { type: "document", path: s.paths.config, info },
    ]);
  };
  const serverFor = (s: OpenCodeLaunchSpec) => (req: HarnessRequest, c: FakeHarnessContainer) => {
    if (req.secretHeaders?.Authorization !== auth)
      return { status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' }, body: "" };
    if (req.method === "GET" && req.path === "/api/health") return health();
    if (req.method === "GET" && req.path === "/api/config") return configEcho(c, s);
    if (req.method === "POST" && req.path === "/api/plugin/await-activation")
      return { status: 204, headers: {}, body: "" };
    return json(404, { error: "no such route" });
  };
  container.onRequest = opts.onRequest ?? serverFor(spec);
  /** What the tailer writes first once it is subscribed: the note readiness waits for. */
  const connected = JSON.stringify({ feed: "tailer", at: 1, note: "connected", connections: 1 }) + "\n";
  /** The feed as a tailer that started and subscribed would have left it: the
   *  fake starts no process, so the test says what the tailer would have said
   *  through the fake's one log, which is the feed once the tailer's start named it. */
  const feedConnected = () => {
    container.emit({ feed: "tailer", at: 0, note: "started" });
    container.emit({ feed: "tailer", at: 1, note: "connected", connections: 1 });
  };
  if (opts.feed !== false) feedConnected();
  /** The feed's bytes as the harness reads them. */
  const feedText = async () => Buffer.from(await container.readLog(spec.paths.feed, 0, 65536)).toString("utf8");
  return {
    container,
    clock,
    sleep,
    password,
    auth,
    json,
    health,
    configEcho,
    serverFor,
    feedConnected,
    connected,
    feedText,
    deps: { container, clock, sleep, pollMs: 250 },
  };
}

describe("launchOpenCode — the server started through the seam and found ready", () => {
  it("writes the files, starts opencode serve on a free port with the run's environment, probes its health with the password as Basic auth, checks the configuration took, settles the plugin, and starts the tailer beside it", async () => {
    const h = harness();
    const started = await launchOpenCode(h.deps, spec, BEARER);
    expect(started).toMatchObject({
      pid: 4242,
      port: 41000,
      tailerPid: 4242,
      password: h.password,
      version: OPENCODE_VERSION,
      // The byte after the tailer's `connected` note: where the row starts reading the feed.
      feedOffset: Buffer.byteLength(await h.feedText(), "utf8"),
    });
    expect(started.feedOffset).toBeGreaterThan(Buffer.byteLength(h.connected, "utf8"));
    expect(started.paths).toEqual(spec.paths);
    // The files, before the start.
    expect([...h.container.files.keys()]).toEqual([spec.paths.config, spec.paths.plugin, spec.paths.tailerScript]);
    expect(h.container.files.get(spec.paths.config)).toBe(openCodeConfigJson(spec));
    // The server's start.
    expect(h.container.starts).toHaveLength(2);
    const [serve, tailer] = h.container.starts;
    expect(serve.command).toBe(OPENCODE_BIN);
    expect(serve.args).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "41000"]);
    expect(serve.port).toBe("free");
    expect(serve.stdoutFilter).toBeUndefined();
    expect(serve.paths).toEqual(spec.paths);
    expect(serve.env).toEqual(openCodeLaunchEnv(spec, BEARER, h.password));
    // The tailer's start: node on the script, the server's port and pid, the feed as its log.
    expect(tailer.command).toBe(TAILER_BIN);
    expect(tailer.args).toEqual([spec.paths.tailerScript]);
    expect(tailer.port).toBe(41000);
    expect(tailer.env).toEqual({ [OPENCODE_PASSWORD_ENV]: h.password, [OPENCODE_SERVE_PID_ENV]: "4242" });
    expect(tailer.paths).toEqual(spec.paths.tailer);
    expect(tailer.paths.log).toBe(spec.paths.feed);
    // The readiness requests, in order, each carrying the password as a secret header and nothing in the plain ones.
    expect(h.container.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/health",
      "GET /api/config",
      "POST /api/plugin/await-activation",
    ]);
    for (const r of h.container.requests) {
      expect(r.port).toBe(41000);
      expect(r.secretHeaders).toEqual({ Authorization: h.auth });
      expect(r.headers).toBeUndefined();
      expect(r.body).toBeUndefined();
    }
    // Nothing the bot's process holds reached the server.
    expect(JSON.stringify(serve.env)).not.toContain("API_KEY");
  });

  it("the row's facts carry the port and the root the launch settled on, the bearer's hash and never the bearer", () => {
    const started = { pid: 4242, port: 41000, tailerPid: 4243, paths: spec.paths };
    const facts = openCodeFacts(started, {
      sessionID: "ses_1",
      logOffset: 120,
      bearer: BEARER,
      container: "vm-fake",
      relaunches: 1,
    });
    expect(facts).toEqual({
      harness: "opencode",
      pid: 4242,
      port: 41000,
      tailerPid: 4243,
      logOffset: 120,
      sessionID: "ses_1",
      root: "/var/tmp/switchboard-oc-run-7",
      bearerHash: bearerHashOf(BEARER),
      container: "vm-fake",
      relaunches: 1,
    });
    expect(JSON.stringify(facts)).not.toContain("a-secret-of-the-runs-own");
    const bare = openCodeFacts(started, { sessionID: "ses_1", logOffset: 0, relaunches: 0 });
    expect(bare).not.toHaveProperty("bearerHash");
    expect(bare).not.toHaveProperty("container");
  });

  it("files under the root the container makes when it is not the one proposed, and the facts name that root", async () => {
    const h = harness({ feed: false });
    h.container.makeRoot = async (wanted) => `${wanted}-k3`;
    const placed = openCodeRunPathsAt("/var/tmp/switchboard-oc-run-7-k3");
    h.container.onRequest = h.serverFor({ ...spec, paths: placed });
    h.feedConnected();
    const started = await launchOpenCode(h.deps, spec, BEARER);
    expect(started.paths).toEqual(placed);
    expect([...h.container.files.keys()]).toEqual([placed.config, placed.plugin, placed.tailerScript]);
    expect(h.container.starts[0].paths).toEqual(placed);
    expect(h.container.starts[0].env.OPENCODE_CONFIG).toBe(placed.config);
    expect(openCodeFacts(started, { sessionID: "s", logOffset: 0, relaunches: 0 }).root).toBe(
      "/var/tmp/switchboard-oc-run-7-k3",
    );
  });

  it("polls a server that is not listening yet, then one that says it is starting, until it answers", async () => {
    const h = harness();
    let calls = 0;
    const ready = h.serverFor(spec);
    h.container.onRequest = (req, c) => {
      if (req.path === "/api/health" && ++calls <= 3) {
        if (calls <= 2)
          throw new HarnessContainerError("request", "curl: (7) Failed to connect to 127.0.0.1 port 41000");
        return h.json(503, { code: "service_starting" });
      }
      return ready(req, c);
    };
    const started = await launchOpenCode(h.deps, spec, BEARER);
    expect(started.port).toBe(41000);
    expect(h.container.requests.filter((r) => r.path === "/api/health")).toHaveLength(4);
    expect(h.clock()).toBe(1_000_000 + 3 * 250);
  });

  it("fails loudly by name when the health never answers within the bound, with the server's stderr tail", async () => {
    const h = harness();
    h.container.onRequest = () => {
      throw new HarnessContainerError("request", "curl: (7) Failed to connect to 127.0.0.1 port 41000");
    };
    h.container.files.set(spec.paths.errLog, "error: EADDRINUSE\n");
    const promise = launchOpenCode({ ...h.deps, readyMs: 1000 }, spec, BEARER);
    await expect(promise).rejects.toBeInstanceOf(OpenCodeNotReadyError);
    await expect(promise).rejects.toThrow(
      /did not answer its health within 1000 ms \(harness container: request failed — curl: \(7\)/,
    );
    await expect(promise).rejects.toThrow(/stderr: error: EADDRINUSE/);
    expect(h.container.starts).toHaveLength(1);
  });

  it("fails at once, by name, when the server refuses the password, when the binary on PATH is not the pin, when the health is not the health shape, and when the server exited first", async () => {
    const refused = harness({ onRequest: () => ({ status: 401, headers: {}, body: "" }) });
    await expect(launchOpenCode(refused.deps, spec, BEARER)).rejects.toThrow(/refused the run's password/);
    expect(refused.container.requests).toHaveLength(1);

    const other = harness({
      onRequest: () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ healthy: true, version: "2.0.4", pid: 1 }),
      }),
    });
    await expect(launchOpenCode(other.deps, spec, BEARER)).rejects.toThrow(
      /the opencode on PATH is 2\.0\.4; this build drives 2\.0\.3/,
    );

    const shape = harness({ onRequest: () => ({ status: 200, headers: {}, body: "<html>" }) });
    await expect(launchOpenCode(shape.deps, spec, BEARER)).rejects.toThrow(/not the health shape/);

    // 500 is the server saying its start failed: named at once, never polled to the deadline.
    const failedStart = harness({
      onRequest: () => ({ status: 500, headers: {}, body: JSON.stringify({ code: "service_failed" }) }),
    });
    await expect(launchOpenCode(failedStart.deps, spec, BEARER)).rejects.toThrow(
      /reported that its start failed \(health answered 500\)/,
    );
    expect(failedStart.container.requests).toHaveLength(1);
    expect(failedStart.clock()).toBe(1_000_000);

    const dead = harness();
    const start = dead.container.start.bind(dead.container);
    dead.container.start = async (s) => {
      const answer = await start(s);
      dead.container.die();
      return answer;
    };
    dead.container.files.set(spec.paths.errLog, "opencode: command not found\n");
    await expect(launchOpenCode(dead.deps, spec, BEARER)).rejects.toThrow(
      /exited before it answered its health.*opencode: command not found/,
    );
    expect(dead.container.requests).toHaveLength(0);
  });

  it("fails by name when the configuration did not take — the file not loaded, or a clause-carrying key dropped — and when plugin activation fails; the tailer is never started then", async () => {
    const missing = harness();
    const serve = missing.serverFor(spec);
    missing.container.onRequest = (req, c) =>
      req.path === "/api/config" ? missing.json(200, [{ type: "directory", path: "/somewhere" }]) : serve(req, c);
    await expect(launchOpenCode(missing.deps, spec, BEARER)).rejects.toThrow(
      /did not load the run's configuration file/,
    );
    expect(missing.container.starts).toHaveLength(1);

    const dropped = harness();
    const serve2 = dropped.serverFor(spec);
    dropped.container.onRequest = (req, c) =>
      req.path === "/api/config"
        ? dropped.configEcho(c, spec, (info) => {
            delete info.update;
          })
        : serve2(req, c);
    await expect(launchOpenCode(dropped.deps, spec, BEARER)).rejects.toThrow(
      /the run's configuration update is not disable/,
    );

    const notList = harness();
    const serve3 = notList.serverFor(spec);
    notList.container.onRequest = (req, c) =>
      req.path === "/api/config" ? notList.json(200, { nope: true }) : serve3(req, c);
    await expect(launchOpenCode(notList.deps, spec, BEARER)).rejects.toThrow(/not the entry list/);

    const activation = harness();
    const serve4 = activation.serverFor(spec);
    activation.container.onRequest = (req, c) =>
      req.path === "/api/plugin/await-activation" ? activation.json(500, { error: "boom" }) : serve4(req, c);
    await expect(launchOpenCode(activation.deps, spec, BEARER)).rejects.toThrow(/plugin activation answered 500/);
    expect(activation.container.starts).toHaveLength(1);
  });

  it("readiness ends only when the tailer says it is connected: a feed without the note within the bound is a named failure with the tailer's stderr, a tailer that exited first is another, and the feed offset answered is the byte after the note", async () => {
    const silent = harness({ feed: false });
    silent.container.files.set(spec.paths.tailer.errLog, "tailer: ECONNREFUSED\n");
    const promise = launchOpenCode({ ...silent.deps, readyMs: 1000 }, spec, BEARER);
    await expect(promise).rejects.toBeInstanceOf(OpenCodeNotReadyError);
    await expect(promise).rejects.toThrow(/the tailer did not connect to the event stream within 1000 ms/);
    await expect(promise).rejects.toThrow(/stderr: tailer: ECONNREFUSED/);
    expect(silent.container.starts).toHaveLength(2);

    const exited = harness({ feed: false });
    const start = exited.container.start.bind(exited.container);
    exited.container.start = async (s) => {
      const answer = await start(s);
      if (s.command === TAILER_BIN) exited.container.die();
      return answer;
    };
    exited.container.files.set(spec.paths.tailer.errLog, "node: cannot find module\n");
    await expect(launchOpenCode(exited.deps, spec, BEARER)).rejects.toThrow(
      /the tailer exited before it connected.*node: cannot find module/,
    );

    // The note lands after a poll: the offset is the byte after it, not the end of what follows.
    const late = harness({ feed: false });
    let polls = 0;
    const sleep = late.deps.sleep;
    late.deps.sleep = async (ms: number) => {
      await sleep(ms);
      if (++polls === 2) {
        late.feedConnected();
        late.container.emit({ feed: "event", at: 2, event: {} });
      }
    };
    const started = await launchOpenCode(late.deps, spec, BEARER);
    const feed = await late.feedText();
    expect(started.feedOffset).toBe(feed.indexOf(late.connected) + late.connected.length);
    expect(started.feedOffset).toBeLessThan(Buffer.byteLength(feed, "utf8"));
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("a container gone under the readiness probe is the typed error, rethrown as it is, never a not-ready verdict", async () => {
    const h = harness();
    h.container.onRequest = () => {
      throw new HarnessContainerRuntimeReplacedError("request", "resident /exec: runtime-replaced");
    };
    await expect(launchOpenCode(h.deps, spec, BEARER)).rejects.toBeInstanceOf(HarnessContainerRuntimeReplacedError);
  });

  it("a start that answers no port is a named seam failure before any probe", async () => {
    const h = harness();
    h.container.start = async () => ({ pid: 4242 });
    await expect(launchOpenCode(h.deps, spec, BEARER)).rejects.toThrow(/answered no port for opencode serve/);
    expect(h.container.requests).toHaveLength(0);
  });
});
