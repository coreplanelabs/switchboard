import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelCard } from "../../../modelCard.js";
import {
  piModelsJson,
  piRunPathsAt,
  piSettingsJson,
  PROXY_PROVIDER,
  RUN_BEARER_ENV,
  type PiLaunchSpec,
} from "../process.js";

// Feature: docs/reference/specs/harness-pi.md item 4 (U45) — the biller's
// compat words in `models.json`, honoured by the REAL pi binary against a
// logging fake upstream. pi through the proxy sees the bot's URL, so its own
// completions detection takes any block for a generic endpoint; the file's
// words must make it behave as it does against the aggregator directly:
// `reasoning: { effort }` in place of the flat `reasoning_effort`, the
// developer role for the aggregator's Anthropic ids, and the per-block
// `cache_control` markers on the system prompt, the last tool and the last
// message. The generic block's captured body is the contrast: the flat effort
// word and no marker anywhere.

const BIN = resolve(import.meta.dirname, "../../../../../node_modules/.bin/pi");
const piBinaryAvailable = (): boolean => existsSync(BIN);

/** The aggregator card the dispatcher would resolve for the block (record
 *  0052): markers from the vendor table, the levels unknown (identity map). */
const cardOf = (over: Partial<ModelCard>): ModelCard => ({
  ref: "openrouter/anthropic/claude-sonnet-4",
  block: "openrouter",
  model: "anthropic/claude-sonnet-4",
  vendor: "anthropic",
  wire: "openai-chat",
  levels: "unknown",
  capField: "max_completion_tokens",
  window: 200_000,
  inputs: { image: true, document: "unknown" },
  cache: "markers",
  provenance: { levels: "wire", capField: "wire", window: "wire", inputs: "wire", cache: "wire", price: "wire" },
  ...over,
});

/** One streamed answer, whatever the request: enough for pi to settle the turn. */
function answer(model: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
    })}\n\n`;
  return chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}

interface Probe {
  bodies: Array<Record<string, unknown>>;
  server: Server;
  child: ChildProcess;
  dirs: string[];
}

const open: Probe[] = [];

afterEach(() => {
  for (const p of open.splice(0)) {
    p.child.kill("SIGKILL");
    p.server.close();
    for (const dir of p.dirs) rmSync(dir, { recursive: true, force: true });
  }
});

/** Starts the logging fake, writes the run's files from the harness's own
 *  write (`piModelsJson`, `piSettingsJson`), spawns the real pi in RPC mode
 *  pointed at them — no extension: the probe measures the completions
 *  adapter's compat, not the relay — prompts once, and hands back the bodies
 *  the fake captured. */
async function capturedBody(card: ModelCard): Promise<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}") as Record<string, unknown>);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(answer(card.model));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake did not bind a port");

  const agentDir = mkdtempSync(join(tmpdir(), "pi-real-compat-agent-"));
  const workDir = mkdtempSync(join(tmpdir(), "pi-real-compat-work-"));
  const sessionDir = join(agentDir, "sessions");
  mkdirSync(sessionDir);
  const spec: PiLaunchSpec = {
    runId: "real-compat",
    paths: piRunPathsAt(workDir), // the two writes below read nothing from it
    model: { id: card.model, providerType: "openai-compatible", maxTokens: 4096 },
    harnessUrl: `http://127.0.0.1:${address.port}`,
    modelStreamTimeoutMs: 5 * 60_000,
    effort: "high",
    identity: "write",
    system: "",
    relayTools: [],
    card,
  };
  writeFileSync(join(agentDir, "models.json"), piModelsJson(spec));
  writeFileSync(join(agentDir, "settings.json"), piSettingsJson());

  const child = spawn(
    BIN,
    [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--tools",
      "read",
      "--provider",
      PROXY_PROVIDER,
      "--model",
      `${card.model}:high`,
      "--session-dir",
      sessionDir,
    ],
    {
      cwd: workDir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: workDir,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        [RUN_BEARER_ENV]: "test-bearer",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const probe: Probe = { bodies, server, child, dirs: [agentDir, workDir] };
  open.push(probe);
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  child.stdin?.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "hello" })}\n`);

  const deadline = Date.now() + 60_000;
  while (bodies.length === 0) {
    if (child.exitCode !== null) throw new Error(`pi exited ${child.exitCode} before calling the model: ${stderr}`);
    if (Date.now() > deadline) throw new Error(`pi never called the model: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return bodies[0]!;
}

const carriesMarker = (v: unknown): boolean => JSON.stringify(v)?.includes('"cache_control"') ?? false;

describe.skipIf(!piBinaryAvailable())("the real pi binary honours the biller's compat words", () => {
  it("an aggregator block's turn spells the tier as reasoning.effort, takes the developer role for an Anthropic id, and places the markers on the prompt, the last tool and the last message", async () => {
    const body = await capturedBody(cardOf({}));
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body).not.toHaveProperty("reasoning_effort");
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const prompt = messages.find((m) => m.role === "developer" || m.role === "system");
    expect(prompt?.role).toBe("developer");
    expect(carriesMarker(prompt?.content)).toBe(true);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.length).toBeGreaterThan(0);
    expect(carriesMarker(tools.at(-1))).toBe(true);
    expect(carriesMarker(messages.at(-1))).toBe(true);
  }, 90_000);

  it("a generic block's turn carries none of them: the flat reasoning_effort and no marker anywhere", async () => {
    const body = await capturedBody(cardOf({ ref: "local/anthropic/claude-sonnet-4", block: "local" }));
    expect(body.reasoning_effort).toBe("high");
    expect(body).not.toHaveProperty("reasoning");
    expect(carriesMarker(body)).toBe(false);
  }, 90_000);
});
