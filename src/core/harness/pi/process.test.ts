import { describe, expect, it } from "vitest";
import {
  HARNESS_URL_ENV,
  PI_BUILTIN_TOOLS,
  PROXY_PROVIDER,
  RUN_BEARER_ENV,
  harnessPromptNote,
  piLaunchArgs,
  piLaunchEnv,
  piLaunchFiles,
  piModelsJson,
  piRunPaths,
  piThinkingLevel,
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
  system: "You are the coding agent.\n",
  relayTools: ["update_status", "submit_pr_description"],
};

describe("piRunPaths", () => {
  it("derives every path from the run id under one directory outside the checkout", () => {
    const p = piRunPaths("run-7");
    expect(p.dir).toBe("/tmp/switchboard-pi/run-7");
    expect(p.agentDir).toBe("/tmp/switchboard-pi/run-7/agent");
    expect(p.sessionDir).toBe("/tmp/switchboard-pi/run-7/agent/sessions");
    expect(p.fifo).toBe("/tmp/switchboard-pi/run-7/rpc.in");
    expect(p.log).toBe("/tmp/switchboard-pi/run-7/rpc.log");
    expect(p.pidFile).toBe("/tmp/switchboard-pi/run-7/pi.pid");
    expect(p.extension).toBe("/tmp/switchboard-pi/run-7/extension.js");
    expect(Object.values(p).every((v) => v.startsWith("/tmp/switchboard-pi/run-7"))).toBe(true);
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
  it("no effort leaves pi's default thinking level; a resume continues the session file instead of a directory", () => {
    expect(piLaunchArgs({ ...spec, effort: undefined })).toContain("claude-fable-5");
    const resumed = piLaunchArgs({ ...spec, sessionPath: "/tmp/switchboard-pi/run-7/agent/sessions/s.jsonl" });
    expect(resumed[resumed.indexOf("--session") + 1]).toBe("/tmp/switchboard-pi/run-7/agent/sessions/s.jsonl");
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
      PI_CODING_AGENT_DIR: "/tmp/switchboard-pi/run-7/agent",
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
});

describe("piLaunchFiles", () => {
  it("writes settings that never trust the checkout, the models file, the system prompt with the harness note last, and the extension — none a secret", () => {
    const files = piLaunchFiles(spec);
    expect(files.map((f) => f.path)).toEqual([
      "/tmp/switchboard-pi/run-7/agent/settings.json",
      "/tmp/switchboard-pi/run-7/agent/models.json",
      "/tmp/switchboard-pi/run-7/agent/SYSTEM.md",
      "/tmp/switchboard-pi/run-7/extension.js",
    ]);
    expect(JSON.parse(files[0].content)).toEqual({ defaultProjectTrust: "never", checkForUpdates: false });
    expect(files[2].content.startsWith("You are the coding agent.\n\nHARNESS NOTE:")).toBe(true);
    expect(files[2].content).toContain("`update_status`, `submit_pr_description`");
    expect(files[3].content).toBe(PI_EXTENSION_SOURCE);
    for (const f of files) expect(f.content).not.toContain("s3cret");
  });
  it("the harness note maps the native tool names onto pi's and names the relayed tools", () => {
    expect(harnessPromptNote(["update_status"])).toContain("`read_file` use `read`");
    expect(harnessPromptNote(["update_status"])).toContain("`write_file` use `write`");
    expect(harnessPromptNote([])).toContain("No other tools are available in this run.");
  });
});
