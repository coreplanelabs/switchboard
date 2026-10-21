import { operatorSettingsEvidence } from "./core/testing/operatorSettings.js";
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
  // Two callers reach this fake in one `ask`: the operator streams a typed
  // bind, then the run loop's compatible adapter asks for the text answer.
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (script.kind === "refuse") {
        res.writeHead(script.status, { "content-type": "application/json" });
        res.end(script.body);
        return;
      }
      const { stream, tools } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        stream?: boolean;
        tools?: Array<{ function?: { name?: string } }>;
      };
      if (stream === true) {
        const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) =>
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage ? { usage } : {}),
          })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          tools?.some((tool) => tool.function?.name === "bind_preset")
            ? chunk(
                {
                  role: "assistant",
                  tool_calls: [
                    { index: 0, id: "call1", type: "function", function: { name: "bind_preset", arguments: "" } },
                  ],
                },
                null,
              ) +
                chunk(
                  {
                    tool_calls: [
                      {
                        index: 0,
                        function: {
                          arguments: JSON.stringify({
                            preset: "general",
                            reason: "answer the ask",
                            settingsEvidence: operatorSettingsEvidence(),
                          }),
                        },
                      },
                    ],
                  },
                  null,
                ) +
                chunk({}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) +
                "data: [DONE]\n\n"
            : chunk({ role: "assistant", content: script.text }, null) +
                chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) +
                "data: [DONE]\n\n",
        );
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

/** The CLI process from the empty directory, with both streams captured. */
function cliProcess(
  args: string[],
  clientConfig?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const repo = process.cwd();
  const child = spawn(process.execPath, [join(repo, "node_modules/.bin/tsx"), join(repo, "src/cli.ts"), ...args], {
    cwd: dir,
    env: {
      ...process.env,
      SWITCHBOARD_CONFIG: join(dir, "config", "config.yaml"),
      SWITCHBOARD_SKILLS_DIR: join(repo, "skills"),
      SWITCHBOARD_CLIENT_CONFIG: clientConfig ?? join(dir, "no-hosted-profile.json"),
      FAKE_API_KEY: "not-a-real-key",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

function ask(
  text: string,
  flags: string[] = [],
  clientConfig?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return cliProcess(["ask", ...flags, text], clientConfig);
}

/** The core's process log: `[run] …`, `[event] …`, `[done] …` — a tag in brackets at the start of a line. */
const PROCESS_LOG_LINE = /^\[[a-z-]+\] /m;

describe("the CLI process running `ask` against a provider", () => {
  it("an answered run: stdout is the answer alone, the status lines and the process log go to stderr, exit 0", async () => {
    script = { kind: "answer", text: "four" };
    const r = await ask("what is 2+2");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("four");
    expect(r.stdout).not.toMatch(PROCESS_LOG_LINE);
    // At the default (quiet) verbosity the card label is the bare agent name; the model ref joins at verbose.
    expect(r.stderr).toMatch(/✅ \*general\* ·/);
    expect(r.stderr).toMatch(/^\[run\] cli:\d+ user=cli:local agent=general model=fake\/m$/m);
    // The CLI is a channel like any other: the one door's typed bind runs
    // `general` directly, with no retired route receipt (routing-and-config item 21).
    expect(r.stderr).not.toMatch(/^\[route\] /m);
  }, 60_000);

  it("a run the provider refuses (a 401 on the key) exits 1 — the code every failed command exits with — with the refusal on the terminal", async () => {
    script = { kind: "refuse", status: 401, body: '{"error":{"message":"invalid api key"}}' };
    const r = await ask("what is 2+2");
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(1);
    // The one-shot operator call has no run lease to park under: the typed
    // key-invalid cause ends the request, while only its safe rendering reaches stdout.
    expect(r.stdout.trim()).toBe(
      "The model provider key was refused; this request cannot start until the service is restored.",
    );
    expect(r.stdout).not.toContain("invalid api key");
    expect(r.stdout).not.toMatch(PROCESS_LOG_LINE);
    expect(r.stderr).toContain("[operator] cli:");
    expect(r.stderr).toContain('Provider "fake": FAKE_API_KEY was refused');
  }, 60_000);

  it("a local retry key refuses before work because this process has no durable admission store", async () => {
    const r = await ask("what is 2+2", ["--idempotency-key", "local-retry"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(
      "--idempotency-key requires a connected host; local asks have no durable admission receipt.",
    );
  }, 60_000);
});

describe("the hosted CLI process admission receipt", () => {
  it("prints its key before a lost acknowledgement and retries the same native MCP request and owner", async () => {
    const requests: Array<{ text: string; thread: string; idempotencyKey: string }> = [];
    const credentials: Array<string | undefined> = [];
    const admitted = new Map<string, string>();
    const host = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(rpc.params.arguments);
        credentials.push(req.headers.authorization);
        const { thread, idempotencyKey } = rpc.params.arguments;
        const address = JSON.stringify([thread, idempotencyKey]);
        const duplicate = admitted.has(address);
        admitted.set(address, "original-owner");
        if (requests.length === 1) {
          res.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              content: [{ type: "text", text: "Request admitted." }],
              structuredContent: {
                admission: { status: "accepted", receiptId: "original-receipt", runId: "original-owner", duplicate },
              },
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    try {
      const profile = join(dir, "hosted-test.json");
      writeFileSync(
        profile,
        JSON.stringify({ url: `http://127.0.0.1:${(host.address() as AddressInfo).port}`, bearer: "a".repeat(64) }),
      );
      const first = await ask("continue the work", [], profile);
      expect(first.code).toBe(1);
      const key = /^Request key: (.+)$/m.exec(first.stderr)?.[1];
      const thread = /^Thread: (.+)$/m.exec(first.stderr)?.[1];
      expect(key).toMatch(/^"[a-f0-9-]{36}"$/);
      expect(thread).toMatch(/^"[^"\n]+"$/);
      const retry = await ask(
        "continue the work",
        ["--thread", JSON.parse(thread!), "--idempotency-key", JSON.parse(key!)],
        profile,
      );
      expect(retry.code, retry.stderr).toBe(0);
      expect(retry.stdout.trim()).toBe(
        "Admission: accepted\nReceipt: original-receipt\nRun: original-owner\nAlready received: yes",
      );
      expect(requests).toEqual([
        { text: "continue the work", thread: JSON.parse(thread!), idempotencyKey: JSON.parse(key!) },
        { text: "continue the work", thread: JSON.parse(thread!), idempotencyKey: JSON.parse(key!) },
      ]);
      expect(admitted.size).toBe(1);
      expect(credentials).toEqual([`Bearer ${"a".repeat(64)}`, `Bearer ${"a".repeat(64)}`]);
    } finally {
      await new Promise<void>((resolve) => host.close(() => resolve()));
    }
  }, 60_000);
});

describe("hosted CLI failure output", () => {
  it("prints only safe details for hosted commands and asks across response failures", async () => {
    const bearer = "a".repeat(64);
    let response = "transport";
    const host = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (response === "transport") {
          res.destroy();
          return;
        }
        if (response === "malformed") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("PRIVATE_RESPONSE");
          return;
        }
        if (response === "refused") {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { code: -32001, message: `forbidden https://private.example/x bearer ${bearer}` },
            }),
          );
          return;
        }
        if (response === "rpc-refused") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: -32001, message: "forbidden https://private.example/x" } }));
          return;
        }
        if (response === "unparseable") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end("PRIVATE_RESPONSE");
          return;
        }
        if (response === "bad-result") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ result: { content: [{ text: "header\nPRIVATE_RESPONSE" }] } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("null");
      });
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    try {
      const profile = join(dir, "hosted-failure-test.json");
      writeFileSync(
        profile,
        JSON.stringify({ url: `http://127.0.0.1:${(host.address() as AddressInfo).port}`, bearer }),
      );
      const cases = [
        { name: "transport", expected: "MCP transport failed before a response" },
        { name: "malformed", expected: "MCP HTTP 200 response was invalid" },
        { name: "refused", expected: "MCP HTTP 403; code -32001; message forbidden «redacted-url» bearer «redacted»" },
        { name: "unparseable", expected: "MCP HTTP 503" },
        { name: "primitive", expected: "MCP returned HTTP 200 without JSON" },
      ];
      for (const { name, expected } of cases) {
        response = name;
        for (const args of [
          ["runs", "list"],
          ["ask", "check status"],
        ]) {
          const result = await cliProcess(args, profile);
          expect(result.code, `${name} ${args[0]}: ${result.stderr}`).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr.trim().split("\n").at(-1), `${name} ${args[0]}`).toBe(expected);
          expect(result.stderr).not.toContain("PRIVATE_RESPONSE");
          expect(result.stderr).not.toContain("private.example");
          expect(result.stderr).not.toContain(bearer);
          expect(result.stderr).not.toContain("fetch failed");
        }
      }
      response = "rpc-refused";
      for (const args of [
        ["runs", "list"],
        ["ask", "check status"],
      ]) {
        const result = await cliProcess(args, profile);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr.trim().split("\n").at(-1)).toBe(
          `${args[0] === "ask" ? "hosted request" : "hosted command"} failed: code -32001; message forbidden «redacted-url»`,
        );
        expect(result.stderr).not.toContain("private.example");
      }
      response = "bad-result";
      const malformedResult = await cliProcess(["runs", "list"], profile);
      expect(malformedResult.code).toBe(1);
      expect(malformedResult.stdout).toBe("");
      expect(malformedResult.stderr.trim().split("\n").at(-1)).toBe("hosted command failed: invalid response");
      expect(malformedResult.stderr).not.toContain("PRIVATE_RESPONSE");
    } finally {
      await new Promise<void>((resolve) => host.close(() => resolve()));
    }
  }, 120_000);
});
