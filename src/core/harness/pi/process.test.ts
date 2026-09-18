import { describe, expect, it } from "vitest";
import {
  HARNESS_URL_ENV,
  PI_BUILTIN_TOOLS,
  PI_READ_TOOLS,
  PROXY_PROVIDER,
  RUN_BEARER_ENV,
  harnessPromptNote,
  piBuiltinToolsFor,
  piLaunchArgs,
  piLaunchEnv,
  piLaunchFiles,
  piSettingsJson,
  piModelsJson,
  piRunPaths,
  piRunPathsAt,
  piThinkingLevel,
  piThinkingLevelMap,
  takesAdaptiveThinking,
  type PiLaunchSpec,
} from "./process.js";
import { PI_EXTENSION_SOURCE } from "./extensionSource.js";
import type { ModelCard } from "../../modelCard.js";

// Feature: docs/reference/specs/harness-pi.md item 4 — how a run's pi is
// launched: RPC mode with every discovery off but the harness's extension,
// the bearer as the provider key through the environment (never a command
// line, never a model key), the proxy as the one provider in models.json, the
// composed system prompt as SYSTEM.md, the effort tier as pi's thinking level.

const spec: PiLaunchSpec = {
  runId: "run-7",
  paths: piRunPaths("run-7"),
  model: { id: "claude-fable-5", providerType: "anthropic", maxTokens: 64000 },
  harnessUrl: "https://bot.example.com/",
  effort: "high",
  identity: "write",
  system: "You are the coding agent.\n",
  relayTools: ["update_status", "submit_pr_description"],
};

/** The review preset's launch: a read identity, the readonly toolset's relays. */
const reviewSpec: PiLaunchSpec = {
  ...spec,
  identity: "read",
  effort: "medium",
  system: "You are the review agent.\n",
  relayTools: ["update_status", "submit_verdict", "diff_digest"],
};

/** The general preset's launch: no identity and no workspace, the assistant toolset's relays. */
const generalSpec: PiLaunchSpec = {
  ...spec,
  identity: "none",
  effort: undefined,
  harnessUrl: "http://127.0.0.1:8080",
  system: "You are the general agent.\n",
  relayTools: ["web_fetch", "update_status", "github_repos", "github_issue_create"],
};

describe("piRunPaths", () => {
  // The resident runs each thread's commands as that thread's pool user, and
  // a parent `mkdir -p` creates belongs to whichever user created it: any
  // directory between /var/tmp and a run's files would refuse every other user's
  // run at its own mkdir. So a run's root is its own, directly under /var/tmp
  // (sticky, 1777: any user may create a sibling there and only the owner may
  // remove it), and nothing about it depends on knowing which user runs the
  // commands.
  it("derives every path from the run id under one directory of the run's own directly under /var/tmp, a sibling of every other run's with no shared parent", () => {
    const p = piRunPaths("run-7");
    // Outside the shared temp directory a suite or cleanup empties, taking a live run's FIFO with it.
    expect(p.dir.startsWith("/tmp/")).toBe(false);
    expect(p.dir).toBe("/var/tmp/switchboard-pi-run-7");
    expect(p.agentDir).toBe("/var/tmp/switchboard-pi-run-7/agent");
    expect(p.sessionDir).toBe("/var/tmp/switchboard-pi-run-7/agent/sessions");
    expect(p.extension).toBe("/var/tmp/switchboard-pi-run-7/extension.js");
    expect(p.fifo).toBe("/var/tmp/switchboard-pi-run-7/rpc.in");
    expect(p.log).toBe("/var/tmp/switchboard-pi-run-7/rpc.log");
    expect(p.errLog).toBe("/var/tmp/switchboard-pi-run-7/rpc.err");
    expect(p.pidFile).toBe("/var/tmp/switchboard-pi-run-7/pi.pid");
    expect(p.commandDir).toBe("/var/tmp/switchboard-pi-run-7/cmd");
    expect(
      Object.values(p)
        .flat()
        .every((v) => v === p.dir || v.startsWith(`${p.dir}/`)),
    ).toBe(true);
    // The root's parent is /var/tmp itself: nothing between them for one user to own.
    expect(p.dir.slice(0, p.dir.lastIndexOf("/"))).toBe("/var/tmp");
    // Another run's root is a sibling, never above or below this one.
    const other = piRunPaths("run-8");
    expect(other.dir).toBe("/var/tmp/switchboard-pi-run-8");
    expect(other.dir.startsWith(`${p.dir}/`)).toBe(false);
    expect(p.dir.startsWith(`${other.dir}/`)).toBe(false);
    // The shared root of before is gone in every case: no path is under it.
    expect(
      Object.values(p)
        .flat()
        .some((v) => v.startsWith("/var/tmp/switchboard-pi/")),
    ).toBe(false);
  });

  // A run's row records the root its pi was filed under (harness-pi item 8),
  // and the build that comes back after a restart lays the same files out
  // under that root, whatever root it would choose for a fresh run of its own.
  it("piRunPathsAt lays a run's files out under a given root, the one a row recorded, and piRunPaths is that layout under this build's own root", () => {
    const theirs = piRunPathsAt("/tmp/switchboard-pi-worker2/run-7");
    expect(theirs.dir).toBe("/tmp/switchboard-pi-worker2/run-7");
    expect(theirs.log).toBe("/tmp/switchboard-pi-worker2/run-7/rpc.log");
    expect(theirs.fifo).toBe("/tmp/switchboard-pi-worker2/run-7/rpc.in");
    expect(theirs.sessionDir).toBe("/tmp/switchboard-pi-worker2/run-7/agent/sessions");
    expect(
      Object.values(theirs)
        .flat()
        .every((v) => v === theirs.dir || v.startsWith(`${theirs.dir}/`)),
    ).toBe(true);
    expect(piRunPaths("run-7")).toEqual(piRunPathsAt("/var/tmp/switchboard-pi-run-7"));
  });
});

describe("piLaunchArgs", () => {
  it("pins RPC mode, disables every discovery, loads only the harness extension, allowlists pi's tools plus the relayed ones, names the proxy provider and the model with its thinking level, and a session directory", () => {
    const args = piLaunchArgs(spec);
    expect(args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"])
      expect(args).toContain(flag);
    expect(args[args.indexOf("-e") + 1]).toBe(spec.paths.extension);
    expect(args[args.indexOf("--tools") + 1]).toBe(
      [...PI_BUILTIN_TOOLS, "update_status", "submit_pr_description"].join(","),
    );
    expect(args[args.indexOf("--provider") + 1]).toBe(PROXY_PROVIDER);
    expect(args[args.indexOf("--model") + 1]).toBe("claude-fable-5:high");
    expect(args[args.indexOf("--session-dir") + 1]).toBe(spec.paths.sessionDir);
    expect(args).not.toContain("--api-key");
    expect(args).not.toContain("--session");
  });
  // docs/reference/specs/harness-pi.md item 10 — a read-identity run's allowlist
  // holds no `edit` or `write`: pi never has the tools, before the gate ever
  // sees a call.
  it("a read-identity run's allowlist is pi's tools less edit and write, then the relayed ones — a write run's is unchanged", () => {
    expect(PI_READ_TOOLS).toEqual(["read", "bash", "grep", "find", "ls"]);
    expect(piBuiltinToolsFor("write")).toBe(PI_BUILTIN_TOOLS);
    expect(piBuiltinToolsFor("read")).toBe(PI_READ_TOOLS);
    const args = piLaunchArgs(reviewSpec);
    const tools = args[args.indexOf("--tools") + 1].split(",");
    expect(tools).toEqual(["read", "bash", "grep", "find", "ls", "update_status", "submit_verdict", "diff_digest"]);
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-fable-5:medium");
  });
  // docs/reference/specs/harness-pi.md item 12: a preset without an identity
  // has no workspace, so its pi holds none of pi's own tools: the allowlist is
  // the relayed tools alone, and pi never has a shell or a file tool to call.
  it("a run without a workspace (identity none) holds none of pi's own tools: the allowlist is the relayed tools alone", () => {
    expect(piBuiltinToolsFor("none")).toEqual([]);
    const args = piLaunchArgs(generalSpec);
    expect(args[args.indexOf("--tools") + 1]).toBe("web_fetch,update_status,github_repos,github_issue_create");
    for (const tool of PI_BUILTIN_TOOLS) expect(args[args.indexOf("--tools") + 1].split(",")).not.toContain(tool);
  });
  it("no effort leaves pi's default thinking level; a resume continues the session file instead of a directory", () => {
    expect(piLaunchArgs({ ...spec, effort: undefined })).toContain("claude-fable-5");
    const resumed = piLaunchArgs({ ...spec, sessionPath: "/var/tmp/switchboard-pi-run-7/agent/sessions/s.jsonl" });
    expect(resumed[resumed.indexOf("--session") + 1]).toBe("/var/tmp/switchboard-pi-run-7/agent/sessions/s.jsonl");
    expect(resumed).not.toContain("--session-dir");
  });
  it("the five effort tiers are pi's thinking levels by name", () => {
    for (const tier of ["low", "medium", "high", "xhigh", "max"] as const) expect(piThinkingLevel(tier)).toBe(tier);
    expect(piThinkingLevel(undefined)).toBeUndefined();
  });
});

describe("piLaunchEnv", () => {
  it("carries the bearer under the name models.json reads, the bot's URL, the run id, pi's config directory and the offline switches — and nothing else", () => {
    expect(piLaunchEnv(spec, "sbr_run-7.s3cret")).toEqual({
      [RUN_BEARER_ENV]: "sbr_run-7.s3cret",
      [HARNESS_URL_ENV]: "https://bot.example.com/",
      SWITCHBOARD_RUN_ID: "run-7",
      PI_CODING_AGENT_DIR: "/var/tmp/switchboard-pi-run-7/agent",
      PI_SKIP_VERSION_CHECK: "1",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    });
    expect(Object.keys(piLaunchEnv(spec, "x")).some((k) => k.endsWith("_API_KEY"))).toBe(false);
  });
});

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

describe("piModelsJson", () => {
  it("names the proxy as the one provider on the Anthropic shape, the key interpolated from the bearer's variable, a zero rate card", () => {
    const models = JSON.parse(piModelsJson(spec)) as {
      providers: Record<
        string,
        { baseUrl: string; api: string; apiKey: string; models: Array<Record<string, unknown>> }
      >;
    };
    const p = models.providers[PROXY_PROVIDER];
    expect(Object.keys(models.providers)).toEqual([PROXY_PROVIDER]);
    expect(p.baseUrl).toBe("https://bot.example.com");
    expect(p.api).toBe("anthropic-messages");
    expect(p.apiKey).toBe(`$${RUN_BEARER_ENV}`);
    expect(p.models[0]).toMatchObject({
      id: "claude-fable-5",
      maxTokens: 64000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(piModelsJson(spec)).not.toContain("s3cret");
  });
  it("an OpenAI-compatible provider gets the completions shape under the proxy's /v1", () => {
    const models = JSON.parse(
      piModelsJson({ ...spec, model: { ...spec.model, providerType: "openai-compatible" } }),
    ) as {
      providers: Record<string, { baseUrl: string; api: string }>;
    };
    expect(models.providers[PROXY_PROVIDER]).toMatchObject({
      baseUrl: "https://bot.example.com/v1",
      api: "openai-completions",
    });
  });
  // The proxy's model is not in pi's built-in catalog, so nothing tells pi
  // which thinking payload the model takes; without the flag pi sends the
  // legacy budget, and a Claude 5 model answers 400 on the first thinking turn.
  it("the run's model entry asks a Claude 5 model for adaptive thinking through the proxy, beside every field it had", () => {
    const models = JSON.parse(piModelsJson(spec)) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    expect(models.providers[PROXY_PROVIDER].models).toEqual([
      {
        id: "claude-fable-5",
        name: "claude-fable-5",
        reasoning: true,
        compat: { forceAdaptiveThinking: true },
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 64000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });
  it("a Claude model before 4.6 keeps the budget payload — it refuses adaptive thinking the way a Claude 5 model refuses the budget", () => {
    const models = JSON.parse(piModelsJson({ ...spec, model: { ...spec.model, id: "claude-sonnet-4-5" } })) as {
      providers: Record<string, { models: Array<{ compat?: Record<string, unknown> }> }>;
    };
    expect(models.providers[PROXY_PROVIDER].models[0].compat).toEqual({ forceAdaptiveThinking: false });
  });
  it("an OpenAI-compatible provider's entry carries no Anthropic compat — the thinking payload is the Anthropic shape's business", () => {
    const models = JSON.parse(
      piModelsJson({ ...spec, model: { ...spec.model, providerType: "openai-compatible" } }),
    ) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    expect(models.providers[PROXY_PROVIDER].models[0]).not.toHaveProperty("compat");
  });

  // The card written into the file (record 0052): the word on the wire is the
  // card's, never one pi chose — pi clamps nothing, prices nothing, invents no window.
  const modelOf = (s: PiLaunchSpec) =>
    (JSON.parse(piModelsJson(s)) as { providers: Record<string, { models: Array<Record<string, unknown>> }> })
      .providers[PROXY_PROVIDER].models[0];

  it("a known card writes its level map, its cap field and its window into the run's entry", () => {
    const card = cardOf({
      levels: {
        low: { word: "low", named: true },
        medium: { word: "medium", named: true },
        high: { word: "high", named: true },
        xhigh: { word: "high", named: false },
        max: "refused",
      },
      capField: "max_tokens",
      window: 131_072,
      provenance: {
        levels: "registry",
        capField: "registry",
        window: "registry",
        inputs: "wire",
        cache: "wire",
        price: "wire",
      },
    });
    const entry = modelOf({ ...spec, model: { ...spec.model, providerType: "openai-compatible" }, card });
    expect(entry.thinkingLevelMap).toEqual({ low: "low", medium: "medium", high: "high", xhigh: "high", max: null });
    expect(entry.compat).toEqual({ maxTokensField: "max_tokens" });
    expect(entry.contextWindow).toBe(131_072);
  });

  it("an unknown card writes the identity map — pi clamps nothing — pi's unknown window and the wire's cap field", () => {
    const entry = modelOf({ ...spec, model: { ...spec.model, providerType: "openai-compatible" }, card: cardOf({}) });
    expect(entry.thinkingLevelMap).toEqual({ low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
    expect(entry.contextWindow).toBe(128_000);
    expect(entry.compat).toEqual({ maxTokensField: "max_completion_tokens" });
  });

  it("a markers card asks for Anthropic-style cache_control on the completions shape — an Anthropic vendor through an aggregator", () => {
    const card = cardOf({ vendor: "anthropic", cache: "markers" });
    const entry = modelOf({ ...spec, model: { ...spec.model, providerType: "openai-compatible" }, card });
    expect((entry.compat as Record<string, unknown>).cacheControlFormat).toBe("anthropic");
  });

  it("the Anthropic shape keeps its own compat beside the card: the window and the map are the card's, the cap field and the markers are the shape's own", () => {
    const card = cardOf({ wire: "anthropic-messages", cache: "markers", window: 200_000 });
    const entry = modelOf({ ...spec, card });
    expect(entry.compat).toEqual({ forceAdaptiveThinking: true });
    expect(entry.contextWindow).toBe(200_000);
    expect(entry.thinkingLevelMap).toEqual({ low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
  });

  it("an openai-responses card puts pi on the Responses API under the proxy's /v1, with no completions compat — max_output_tokens is that adapter's own spelling", () => {
    const card = cardOf({
      ref: "openai/gpt-5.4",
      block: "openai",
      model: "gpt-5.4",
      wire: "openai-responses",
      capField: "max_output_tokens",
    });
    const models = JSON.parse(
      piModelsJson({ ...spec, model: { ...spec.model, id: "gpt-5.4", providerType: "openai-compatible" }, card }),
    ) as { providers: Record<string, { baseUrl: string; api: string; models: Array<Record<string, unknown>> }> };
    const p = models.providers[PROXY_PROVIDER];
    expect(p.baseUrl).toBe("https://bot.example.com/v1");
    expect(p.api).toBe("openai-responses");
    expect(p.models[0]).not.toHaveProperty("compat");
  });

  it("a markers card on the Responses wire asks for no cache_control format — the compat knob is the completions shape's alone", () => {
    const card = cardOf({ wire: "openai-responses", vendor: "anthropic", cache: "markers" });
    const entry = modelOf({ ...spec, model: { ...spec.model, providerType: "openai-compatible" }, card });
    expect(entry).not.toHaveProperty("compat");
  });

  it("a card that says no images narrows the entry's input to text", () => {
    const entry = modelOf({
      ...spec,
      model: { ...spec.model, providerType: "openai-compatible" },
      card: cardOf({ inputs: { image: false, document: "unknown" } }),
    });
    expect(entry.input).toEqual(["text"]);
  });
});

describe("piThinkingLevelMap", () => {
  it("unknown levels are the identity map; a refused tier is null; a fallback's word is the card's, not pi's", () => {
    expect(piThinkingLevelMap("unknown")).toEqual({
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
    expect(
      piThinkingLevelMap({
        low: { word: "LOW", named: true },
        medium: { word: "medium", named: true },
        high: { word: "high", named: true },
        xhigh: { word: "high", named: false },
        max: "refused",
      }),
    ).toEqual({ low: "LOW", medium: "medium", high: "high", xhigh: "high", max: null });
  });
});

describe("takesAdaptiveThinking", () => {
  // pi's built-in Anthropic catalog draws the line at the 4.6 generation, as
  // Anthropic does: from Opus 4.6 and Sonnet 4.6 on a Claude model takes
  // adaptive thinking (`thinking.type: "adaptive"` plus `output_config.effort`);
  // the 4.5 generation and older take the legacy budget and refuse adaptive.
  it.each([
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
  ])("%s — the 4.6 generation on, and the whole 5 family — takes adaptive thinking", (id) => {
    expect(takesAdaptiveThinking(id)).toBe(true);
  });
  it.each(["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5", "claude-opus-4-1", "claude-3-5-sonnet"])(
    "%s — the 4.5 generation and older — keeps the budget payload",
    (id) => {
      expect(takesAdaptiveThinking(id)).toBe(false);
    },
  );
  it.each([
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-5-20251101",
    "claude-opus-4-1-20250805",
    "claude-opus-4-20250514",
    "claude-3-7-sonnet-20250219",
  ])("%s — a dated alias is read by its version, never by its date", (id) => {
    expect(takesAdaptiveThinking(id)).toBe(false);
  });
  it("an id with no version number is taken for the current generation — every model Anthropic ships now is adaptive", () => {
    expect(takesAdaptiveThinking("claude-latest")).toBe(true);
    expect(takesAdaptiveThinking("my-proxy-alias")).toBe(true);
  });
});

describe("piLaunchFiles", () => {
  it("writes settings that never trust the checkout, the models file, the system prompt with the harness note last, and the extension — none a secret", () => {
    const files = piLaunchFiles(spec);
    expect(files.map((f) => f.path)).toEqual([
      "/var/tmp/switchboard-pi-run-7/agent/settings.json",
      "/var/tmp/switchboard-pi-run-7/agent/models.json",
      "/var/tmp/switchboard-pi-run-7/agent/SYSTEM.md",
      "/var/tmp/switchboard-pi-run-7/extension.js",
    ]);
    expect(JSON.parse(files[0].content)).toEqual({ defaultProjectTrust: "never", checkForUpdates: false });
    expect(files[2].content.startsWith("You are the coding agent.\n\nHARNESS NOTE:")).toBe(true);
    expect(files[2].content).toContain("`update_status`, `submit_pr_description`");
    expect(files[3].content).toBe(PI_EXTENSION_SOURCE);
    for (const f of files) expect(f.content).not.toContain("s3cret");
  });
  // harness-pi item 4: the deployment's compaction thresholds ride pi's own
  // settings key; without them the file is exactly what it was.
  it("carries the deployment's compaction thresholds under pi's `compaction` key when set — each alone or both — and is byte-identical without them", () => {
    const both = piLaunchFiles({ ...spec, compaction: { reserveTokens: 150_000, keepRecentTokens: 8_000 } });
    expect(JSON.parse(both[0].content)).toEqual({
      defaultProjectTrust: "never",
      checkForUpdates: false,
      compaction: { reserveTokens: 150_000, keepRecentTokens: 8_000 },
    });
    expect(JSON.parse(piSettingsJson({ reserveTokens: 150_000 }))).toEqual({
      defaultProjectTrust: "never",
      checkForUpdates: false,
      compaction: { reserveTokens: 150_000 },
    });
    expect(piSettingsJson({})).toBe(piSettingsJson());
    expect(piLaunchFiles(spec)[0].content).toBe(piSettingsJson());
    expect(piSettingsJson()).not.toContain("compaction");
  });
  it("the harness note maps the native tool names onto pi's and names the relayed tools", () => {
    expect(harnessPromptNote(["update_status"], "write")).toContain("`read_file` use `read`");
    expect(harnessPromptNote(["update_status"], "write")).toContain("`write_file` use `write`");
    expect(harnessPromptNote([], "write")).toContain("No other tools are available in this run.");
  });
  it("a read-identity run's note names the five read tools, says the run has no edit or write, and never maps write_file onto one", () => {
    const note = harnessPromptNote(["update_status", "submit_verdict"], "read");
    expect(note).toContain("`read`, `bash`, `grep`, `find` and `ls`");
    expect(note).toContain("no `edit` and no `write`");
    expect(note).toContain("read-only");
    expect(note).toContain("`read_file` use `read`");
    expect(note).not.toContain("`write_file` use `write`");
    expect(note).toContain("`update_status`, `submit_verdict`");
    const files = piLaunchFiles(reviewSpec);
    const system = files.find((f) => f.path.endsWith("SYSTEM.md"))!.content;
    expect(system.startsWith("You are the review agent.\n\nHARNESS NOTE:")).toBe(true);
    expect(system).toContain("no `edit` and no `write`");
    expect(system).not.toContain("`write_file` use `write`");
  });
  it("a run without a workspace is told it has none of pi's own tools and that a call to any is refused, names its relayed tools, and maps no native name onto one; models.json points at the loopback URL it was given", () => {
    const note = harnessPromptNote(["web_fetch", "update_status"], "none");
    expect(note).toContain("no workspace");
    expect(note).toContain("none of pi's own tools");
    expect(note).toContain("`read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`");
    expect(note).toContain("refused");
    expect(note).not.toContain("`read_file` use `read`");
    expect(note).not.toContain("`write_file` use `write`");
    expect(note).toContain("`web_fetch`, `update_status`");
    const files = piLaunchFiles(generalSpec);
    const system = files.find((f) => f.path.endsWith("SYSTEM.md"))!.content;
    expect(system.startsWith("You are the general agent.\n\nHARNESS NOTE:")).toBe(true);
    expect(system).toContain("none of pi's own tools");
    const models = JSON.parse(files.find((f) => f.path.endsWith("models.json"))!.content);
    expect(models.providers[PROXY_PROVIDER].baseUrl).toBe("http://127.0.0.1:8080");
    expect(piLaunchEnv(generalSpec, "sbr_x.y")[HARNESS_URL_ENV]).toBe("http://127.0.0.1:8080");
  });
});
