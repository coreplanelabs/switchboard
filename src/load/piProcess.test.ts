import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Secret } from "../secrets.js";
import {
  PI_CODING_TOOLS,
  PI_REVIEW_TOOLS,
  PROXIED_MODEL_ENTRY,
  earlyExitNote,
  parseGithubSlug,
  piArgs,
  piEnv,
  piKeyEnvFor,
  prHeadCheckoutArgs,
  prHeadFetchArgs,
  spawnPi,
  writeAgentDir,
} from "./piProcess.js";

// How `load:pi` starts pi (docs/reference/specs/load-harness.md, the pi
// driver items): the argument list that pins RPC mode and turns every
// discovery off but the one extension, the environment allowlist that hands
// pi the model key under the name pi reads and nothing else, the config
// directory pi is pointed at — every path absolute, because pi runs in the
// checkout and looks a relative path up there — and the note the receipt
// carries when pi left before its first turn.

const base = {
  piBin: "/opt/pi/bin/pi",
  checkout: "/work/repo",
  extensionPath: "/work/switchboard/src/load/piExtension.ts",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  keyEnvName: "ANTHROPIC_API_KEY",
  keyValue: new Secret("sk-test", "ANTHROPIC_API_KEY"),
  agentDir: "/tmp/agent",
  sessionDir: "/tmp/agent/sessions",
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

describe("piArgs", () => {
  it("pins RPC mode, disables every discovery, loads only the harness extension, and names the model", () => {
    const args = piArgs(base);
    expect(args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"]) {
      expect(args).toContain(flag);
    }
    expect(args).toContain("-e");
    expect(args[args.indexOf("-e") + 1]).toBe(base.extensionPath);
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls");
    expect(args[args.indexOf("--provider") + 1]).toBe("anthropic");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-5");
    expect(args[args.indexOf("--session-dir") + 1]).toBe("/tmp/agent/sessions");
    expect(args).not.toContain("--api-key");
    expect(args.join(" ")).not.toContain("sk-test");
    expect(JSON.stringify(base)).not.toContain("sk-test");
  });
  it("adds a thinking level as pi's model suffix when asked", () => {
    expect(piArgs({ ...base, thinking: "high" })).toContain("claude-sonnet-4-5:high");
  });
  it("hands pi an absolute session directory and extension path — pi runs in the checkout, and would look a relative path up there", () => {
    const args = piArgs({
      ...base,
      sessionDir: "load-results/pi-x-agent/sessions",
      extensionPath: "src/load/piExtension.ts",
    });
    const sessionDir = args[args.indexOf("--session-dir") + 1];
    const extension = args[args.indexOf("-e") + 1];
    expect(isAbsolute(sessionDir)).toBe(true);
    expect(sessionDir).toBe(resolve("load-results/pi-x-agent/sessions"));
    expect(extension).toBe(resolve("src/load/piExtension.ts"));
  });
  it("the coding child's allowlist carries the extension's terminal tools — pi's --tools filters those too", () => {
    expect(PI_CODING_TOOLS).toContain("submit_pr_description");
    expect(PI_CODING_TOOLS).toContain("submit_verdict");
    for (const tool of ["read", "bash", "edit", "write", "grep", "find", "ls"]) expect(PI_CODING_TOOLS).toContain(tool);
  });
  it("the review child's allowlist is the read identity's — pi's tools less edit and write — plus the verdict tool alone", () => {
    expect(PI_REVIEW_TOOLS).toEqual(["read", "bash", "grep", "find", "ls", "submit_verdict"]);
    expect(piArgs({ ...base, tools: PI_REVIEW_TOOLS })[piArgs(base).indexOf("--tools") + 1]).toBe(
      "read,bash,grep,find,ls,submit_verdict",
    );
  });
});

describe("parseGithubSlug", () => {
  it("reads owner/name off the https and ssh forms, with or without .git, and answers undefined for anything else", () => {
    expect(parseGithubSlug("https://github.com/acme/api")).toBe("acme/api");
    expect(parseGithubSlug("https://github.com/acme/api.git")).toBe("acme/api");
    expect(parseGithubSlug("https://github.com/acme/api/")).toBe("acme/api");
    expect(parseGithubSlug("git@github.com:acme/api.git\n")).toBe("acme/api");
    expect(parseGithubSlug("https://gitlab.com/acme/api")).toBeUndefined();
    expect(parseGithubSlug("/srv/mirrors/api.git")).toBeUndefined();
  });
});

describe("the review suite's checkout", () => {
  it("fetches the pull request's head into a ref of the driver's own beside the base branch, then detaches at it", () => {
    expect(prHeadFetchArgs({ number: 1067, baseRef: "main" })).toEqual([
      "fetch",
      "-q",
      "origin",
      "main",
      "+refs/pull/1067/head:refs/remotes/load-pi/pr-1067",
    ]);
    expect(prHeadCheckoutArgs({ number: 1067 })).toEqual([
      "checkout",
      "-q",
      "--detach",
      "refs/remotes/load-pi/pr-1067",
    ]);
  });
});

describe("piEnv", () => {
  it("passes PATH and HOME, the key under pi's name, the config dir and the offline switches — nothing else", () => {
    const env = piEnv(base, { PATH: "/usr/bin", HOME: "/home/u", ANTHROPIC_API_KEY: "leak", OTHER: "x" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "sk-test",
      PI_CODING_AGENT_DIR: "/tmp/agent",
      PI_SKIP_VERSION_CHECK: "1",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    });
  });
  it("a custom provider gets its key under the harness's own name, the one models.json interpolates", () => {
    const env = piEnv({ ...base, provider: "scripted", keyEnvName: "SWITCHBOARD_PI_MODEL_KEY" }, { PATH: "p" });
    expect(env.SWITCHBOARD_PI_MODEL_KEY).toBe("sk-test");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it("hands pi an absolute config directory whichever directory the driver ran from — a relative one is looked up in the checkout, where no models.json is, and pi knows no custom provider", () => {
    const env = piEnv({ ...base, agentDir: "load-results/pi-x-agent" }, { PATH: "p" });
    expect(isAbsolute(env.PI_CODING_AGENT_DIR)).toBe(true);
    expect(env.PI_CODING_AGENT_DIR).toBe(resolve("load-results/pi-x-agent"));
  });
});

describe("piKeyEnvFor", () => {
  it("names the variable pi reads for its built-in providers and the harness's own for a custom one", () => {
    expect(piKeyEnvFor("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(piKeyEnvFor("openai")).toBe("OPENAI_API_KEY");
    expect(piKeyEnvFor("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(piKeyEnvFor("scripted")).toBe("SWITCHBOARD_PI_MODEL_KEY");
  });
});

describe("writeAgentDir", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a settings file that never trusts the project, and no models file for a built-in provider", () => {
    dir = mkdtempSync(join(tmpdir(), "load-pi-test-"));
    const out = writeAgentDir(dir, { provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ defaultProjectTrust: "never" });
    expect(out.modelsPath).toBeUndefined();
    expect(out.sessionDir).toBe(join(dir, "sessions"));
  });
  it("writes a models.json for a custom OpenAI-compatible endpoint whose key is read from the harness variable", () => {
    dir = mkdtempSync(join(tmpdir(), "load-pi-test-"));
    const out = writeAgentDir(dir, { provider: "scripted", model: "any", baseUrl: "http://127.0.0.1:8089" });
    const models = JSON.parse(readFileSync(out.modelsPath!, "utf8")) as {
      providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: Array<{ id: string }> }>;
    };
    expect(models.providers.scripted.baseUrl).toBe("http://127.0.0.1:8089");
    expect(models.providers.scripted.api).toBe("openai-completions");
    expect(models.providers.scripted.apiKey).toBe("$SWITCHBOARD_PI_MODEL_KEY");
    expect(models.providers.scripted.models).toEqual([{ id: "any" }]);
  });
  it("names the Anthropic messages shape for the bot's model proxy when asked — the through-proxy receipt", () => {
    dir = mkdtempSync(join(tmpdir(), "load-pi-test-"));
    const out = writeAgentDir(dir, {
      provider: "switchboard",
      model: "claude-fable-5",
      baseUrl: "https://bot.example.com",
      api: "anthropic-messages",
    });
    const models = JSON.parse(readFileSync(out.modelsPath!, "utf8")) as {
      providers: Record<string, { baseUrl: string; api: string; apiKey: string }>;
    };
    expect(models.providers.switchboard).toMatchObject({
      baseUrl: "https://bot.example.com",
      api: "anthropic-messages",
      apiKey: "$SWITCHBOARD_PI_MODEL_KEY",
    });
  });
  it("the proxy's model entry says the model can think and carries the family's window and output ceiling — pi tells a bare custom entry it cannot reason, and runs it with thinking off", () => {
    dir = mkdtempSync(join(tmpdir(), "load-pi-test-"));
    const out = writeAgentDir(dir, {
      provider: "switchboard",
      model: "claude-fable-5",
      baseUrl: "https://bot.example.com",
      api: "anthropic-messages",
      modelEntry: PROXIED_MODEL_ENTRY,
    });
    const models = JSON.parse(readFileSync(out.modelsPath!, "utf8")) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    expect(models.providers.switchboard.models).toEqual([
      {
        id: "claude-fable-5",
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 64_000,
        compat: { forceAdaptiveThinking: true },
      },
    ]);
  });
  // Live, the through-proxy arm on claude-fable-5 settled every task in one
  // turn with no tokens: pi sent the legacy budget (`thinking.type: "enabled"`,
  // `budget_tokens`) and the model answered 400 — a Claude 5 model takes
  // adaptive thinking, and only pi's catalog knows that, which the proxy's
  // model is not in.
  it("the proxy's model entry asks a Claude 5 model for adaptive thinking — pi's built-in catalog says so per model, and the proxy's model is not in it", () => {
    dir = mkdtempSync(join(tmpdir(), "load-pi-test-"));
    const out = writeAgentDir(dir, {
      provider: "switchboard",
      model: "claude-fable-5",
      baseUrl: "https://bot.example.com",
      api: "anthropic-messages",
      modelEntry: PROXIED_MODEL_ENTRY,
    });
    const models = JSON.parse(readFileSync(out.modelsPath!, "utf8")) as {
      providers: Record<string, { models: Array<{ compat?: Record<string, unknown> }> }>;
    };
    expect(models.providers.switchboard.models[0].compat).toEqual({ forceAdaptiveThinking: true });
  });
  it("the proxy's model entry asks a Claude model before 4.6 for the budget payload — that generation refuses adaptive thinking", () => {
    dir = mkdtempSync(join(tmpdir(), "load-pi-test-"));
    const out = writeAgentDir(dir, {
      provider: "switchboard",
      model: "claude-sonnet-4-5",
      baseUrl: "https://bot.example.com",
      api: "anthropic-messages",
      modelEntry: PROXIED_MODEL_ENTRY,
    });
    const models = JSON.parse(readFileSync(out.modelsPath!, "utf8")) as {
      providers: Record<string, { models: Array<{ compat?: Record<string, unknown> }> }>;
    };
    expect(models.providers.switchboard.models[0].compat).toEqual({ forceAdaptiveThinking: false });
  });
  it("the completions shape through the proxy carries no Anthropic compat — the thinking payload is the Anthropic shape's business", () => {
    dir = mkdtempSync(join(tmpdir(), "load-pi-test-"));
    const out = writeAgentDir(dir, {
      provider: "switchboard",
      model: "claude-fable-5",
      baseUrl: "https://bot.example.com/v1",
      api: "openai-completions",
      modelEntry: PROXIED_MODEL_ENTRY,
    });
    const models = JSON.parse(readFileSync(out.modelsPath!, "utf8")) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    expect(models.providers.switchboard.models).toEqual([
      { id: "claude-fable-5", reasoning: true, contextWindow: 1_000_000, maxTokens: 64_000 },
    ]);
  });
  it("the dry run's scripted model stays a bare entry — nothing there thinks", () => {
    dir = mkdtempSync(join(tmpdir(), "load-pi-test-"));
    const out = writeAgentDir(dir, { provider: "scripted", model: "any", baseUrl: "http://127.0.0.1:8089" });
    const models = JSON.parse(readFileSync(out.modelsPath!, "utf8")) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    expect(models.providers.scripted.models).toEqual([{ id: "any" }]);
  });
});

describe("earlyExitNote", () => {
  // A stand-in for a pi that dies on startup: the process pi's binary path
  // names is Node itself, and the spawn seam swaps pi's arguments for a
  // script that writes one line to stderr and exits — through the real
  // spawnPi, so the stderr the note reads is the captured one.
  const scripted =
    (stderrLine: string) => (command: string, _args: string[], options: Parameters<typeof nodeSpawn>[2]) =>
      nodeSpawn(
        command,
        ["-e", `process.stderr.write(${JSON.stringify(stderrLine + "\n")}); process.exit(1);`],
        options,
      );

  it("a task pi left before its first turn carries pi's own stderr, on one line, so the reason is in the receipt and not only the JSON", async () => {
    const line = 'Error: Unknown provider "switchboard". Use --list-models to see available providers/models.';
    const proc = spawnPi({ ...base, piBin: process.execPath, checkout: tmpdir() }, scripted(line));
    proc.transport.close();
    expect((await proc.exited).code).toBe(1);
    expect(earlyExitNote("test-gap", { terminal: "exited", turns: 0 }, proc.stderr())).toBe(
      `test-gap: pi exited before its first turn — its stderr: ${line}`,
    );
  });
  it("redacts what it shows, folds the lines into one and keeps the first 300 characters", () => {
    const stderr = `Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\nsecond line\n${"x".repeat(400)}\n`;
    const note = earlyExitNote("t", { terminal: "exited", turns: 0 }, stderr)!;
    expect(note).not.toContain("abcdefghijklmnop");
    expect(note).toContain("Bearer «redacted» second line x");
    expect(note).not.toContain("\n");
    expect(note.endsWith("…")).toBe(true);
    expect(note.split("its stderr: ")[1]).toHaveLength(301);
  });
  it("says so when stderr was empty", () => {
    expect(earlyExitNote("t", { terminal: "exited", turns: 0 }, "  \n")).toBe(
      "t: pi exited before its first turn — its stderr: (empty)",
    );
  });
  it("adds nothing for a task that reached a turn or ended any other way", () => {
    expect(earlyExitNote("t", { terminal: "exited", turns: 1 }, "noise")).toBeUndefined();
    expect(earlyExitNote("t", { terminal: "settled", turns: 0 }, "noise")).toBeUndefined();
    expect(earlyExitNote("t", { terminal: "error", turns: 0 }, "noise")).toBeUndefined();
    expect(earlyExitNote("t", { terminal: "budget", turns: 0 }, "noise")).toBeUndefined();
  });
});
