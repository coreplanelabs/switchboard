import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Feature: docs/reference/specs/command-registry.md item 16 — the `ask` built-in
// as a shell sees it: the whole CLI process (`npx tsx src/cli.ts ask …`) driven
// against a fake OpenAI-compatible provider on localhost. The unit tests in
// cli.test.ts prove the pure mapping (`askExitCode`, `ConsoleIO`); this file
// proves the process wires it — the exit code, and which stream each line lands
// on — the way a first-time operator's terminal or a CI step observes it.

/** What the fake provider answers next: a completion, or a refusal with an HTTP status. */
type Script = { kind: "answer"; text: string } | { kind: "refuse"; status: number; body: string };

let server: Server;
let script: Script = { kind: "answer", text: "four" };
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (script.kind === "refuse") {
        res.writeHead(script.status, { "content-type": "application/json" });
        res.end(script.body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: script.text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // A config like the one `init` writes, pointed at the fake provider; the
  // process runs from an empty directory so nothing of the checkout is read but
  // the source and the bundled skills.
  dir = mkdtempSync(join(tmpdir(), "swb-cli-ask-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(
    join(dir, "config", "config.yaml"),
    [
      "organization: acme",
      "providers:",
      "  fake:",
      "    type: openai-compatible",
      `    baseUrl: http://127.0.0.1:${port}/v1`,
      "    apiKeyEnv: FAKE_API_KEY",
      "defaults:",
      "  agent: general",
      "  models:",
      "    general: fake/m",
      "    coding: fake/m",
      "    review: fake/m",
      `workspaceDir: ${join(dir, "workspaces")}`,
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** `npx tsx src/cli.ts ask <text>` from the empty directory, both streams captured. */
function ask(text: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const repo = process.cwd();
  const child = spawn(process.execPath, [join(repo, "node_modules/.bin/tsx"), join(repo, "src/cli.ts"), "ask", text], {
    cwd: dir,
    env: {
      ...process.env,
      SWITCHBOARD_CONFIG: join(dir, "config", "config.yaml"),
      SWITCHBOARD_SKILLS_DIR: join(repo, "skills"),
      FAKE_API_KEY: "not-a-real-key",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

describe("the CLI process running `ask` against a provider", () => {
  it("an answered run: the answer on stdout, the status lines on stderr, exit 0", async () => {
    script = { kind: "answer", text: "four" };
    const r = await ask("what is 2+2");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("four");
    expect(r.stderr).toMatch(/✅ \*general\* on `fake\/m`/);
  }, 60_000);

  it("a run the provider refuses (a 401 on the key) exits 1 — the code every failed command exits with — with the refusal on the terminal", async () => {
    script = { kind: "refuse", status: 401, body: '{"error":{"message":"invalid api key"}}' };
    const r = await ask("what is 2+2");
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(1);
    expect(r.stdout).toContain('⚠️ Provider "fake" HTTP 401');
    expect(r.stderr).toMatch(/❌ \*general\* on `fake\/m`/);
  }, 60_000);
});
