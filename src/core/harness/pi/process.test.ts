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
  piModelsJson,
  piRunPaths,
  piRunPathsAt,
  piThinkingLevel,
  takesAdaptiveThinking,
  type PiLaunchSpec,
} from "./process.js";
import { PI_EXTENSION_SOURCE } from "./extensionSource.js";

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

describe("piRunPaths", () => {
  // The resident runs each thread's commands as that thread's pool user, and
  // a parent `mkdir -p` creates belongs to whichever user created it: any
  // directory between /tmp and a run's files would refuse every other user's
  // run at its own mkdir. So a run's root is its own, directly under /tmp
  // (sticky, 1777: any user may create a sibling there and only the owner may
  // remove it), and nothing about it depends on knowing which user runs the
  // commands.
  it("derives every path from the run id under one directory of the run's own directly under /tmp, a sibling of every other run's with no shared parent", () => {
    const p = piRunPaths("run-7");
    expect(p.dir).toBe("/tmp/switchboard-pi-run-7");
    expect(p.agentDir).toBe("/tmp/switchboard-pi-run-7/agent");
    expect(p.sessionDir).toBe("/tmp/switchboard-pi-run-7/agent/sessions");
    expect(p.extension).toBe("/tmp/switchboard-pi-run-7/extension.js");
    expect(p.fifo).toBe("/tmp/switchboard-pi-run-7/rpc.in");
    expect(p.log).toBe("/tmp/switchboard-pi-run-7/rpc.log");
    expect(p.errLog).toBe("/tmp/switchboard-pi-run-7/rpc.err");
    expect(p.pidFile).toBe("/tmp/switchboard-pi-run-7/pi.pid");
    expect(p.commandDir).toBe("/tmp/switchboard-pi-run-7/cmd");
    expect(Object.values(p).every((v) => v === p.dir || v.startsWith(`${p.dir}/`))).toBe(true);
    // The root's parent is /tmp itself: nothing between them for one user to own.
    expect(p.dir.slice(0, p.dir.lastIndexOf("/"))).toBe("/tmp");
    // Another run's root is a sibling, never above or below this one.
    const other = piRunPaths("run-8");
    expect(other.dir).toBe("/tmp/switchboard-pi-run-8");
    expect(other.dir.startsWith(`${p.dir}/`)).toBe(false);
    expect(p.dir.startsWith(`${other.dir}/`)).toBe(false);
    // The shared root of before is gone in every case: no path is under it.
    expect(Object.values(p).some((v) => v.startsWith("/tmp/switchboard-pi/"))).toBe(false);
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
    expect(Object.values(theirs).every((v) => v === theirs.dir || v.startsWith(`${theirs.dir}/`))).toBe(true);
    expect(piRunPaths("run-7")).toEqual(piRunPathsAt("/tmp/switchboard-pi-run-7"));
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
    expect(piBuiltinToolsFor("none")).toBe(PI_READ_TOOLS);
    const args = piLaunchArgs(reviewSpec);
    const tools = args[args.indexOf("--tools") + 1].split(",");
    expect(tools).toEqual(["read", "bash", "grep", "find", "ls", "update_status", "submit_verdict", "diff_digest"]);
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-fable-5:medium");
  });
  it("no effort leaves pi's default thinking level; a resume continues the session file instead of a directory", () => {
    expect(piLaunchArgs({ ...spec, effort: undefined })).toContain("claude-fable-5");
    const resumed = piLaunchArgs({ ...spec, sessionPath: "/tmp/switchboard-pi-run-7/agent/sessions/s.jsonl" });
    expect(resumed[resumed.indexOf("--session") + 1]).toBe("/tmp/switchboard-pi-run-7/agent/sessions/s.jsonl");
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
      PI_CODING_AGENT_DIR: "/tmp/switchboard-pi-run-7/agent",
      PI_SKIP_VERSION_CHECK: "1",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    });
    expect(Object.keys(piLaunchEnv(spec, "x")).some((k) => k.endsWith("_API_KEY"))).toBe(false);
  });
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
      "/tmp/switchboard-pi-run-7/agent/settings.json",
      "/tmp/switchboard-pi-run-7/agent/models.json",
      "/tmp/switchboard-pi-run-7/agent/SYSTEM.md",
      "/tmp/switchboard-pi-run-7/extension.js",
    ]);
    expect(JSON.parse(files[0].content)).toEqual({ defaultProjectTrust: "never", checkForUpdates: false });
    expect(files[2].content.startsWith("You are the coding agent.\n\nHARNESS NOTE:")).toBe(true);
    expect(files[2].content).toContain("`update_status`, `submit_pr_description`");
    expect(files[3].content).toBe(PI_EXTENSION_SOURCE);
    for (const f of files) expect(f.content).not.toContain("s3cret");
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
});
