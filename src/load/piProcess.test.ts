import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Secret } from "../secrets.js";
import { PI_CODING_TOOLS, jsonlLines, piArgs, piEnv, piKeyEnvFor, writeAgentDir } from "./piProcess.js";

// How `load:pi` starts pi (docs/reference/specs/load-harness.md, the pi
// driver items): the argument list that pins RPC mode and turns every
// discovery off but the one extension, the environment allowlist that hands
// pi the model key under the name pi reads and nothing else, the config
// directory pi is pointed at, and the LF-only line reader over its stdout.

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
  it("the coding child's allowlist carries the extension's terminal tools — pi's --tools filters those too", () => {
    expect(PI_CODING_TOOLS).toContain("submit_pr_description");
    expect(PI_CODING_TOOLS).toContain("submit_verdict");
    for (const tool of ["read", "bash", "edit", "write", "grep", "find", "ls"]) expect(PI_CODING_TOOLS).toContain(tool);
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
});

describe("jsonlLines", () => {
  it("yields one record per LF however the chunks fall, and the unterminated tail at the end", async () => {
    const chunks = ['{"a":1}\n{"b":', '2}\r\n{"c":3}', '\n{"d":4}'];
    const out: string[] = [];
    for await (const line of jsonlLines(Readable.from(chunks))) out.push(line);
    expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
  });
});
