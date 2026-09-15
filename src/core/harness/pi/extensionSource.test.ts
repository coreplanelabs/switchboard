import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PI_EXTENSION_SOURCE } from "./extensionSource.js";
import { HARNESS_URL_ENV, RUN_BEARER_ENV } from "./process.js";

// Feature: docs/reference/specs/harness-pi.md item 7 — the extension pi loads
// in the run's container: the shipped text itself is written to a file and
// imported, then driven with a fake pi API and a fake fetch, so what is tested
// is what runs. It registers the bot's tool definitions as relays, asks the
// bot before every tool call, blocks with the bot's reason, blocks at once on
// a refusal at the door, and blocks by itself when the bot cannot be reached
// or keeps failing for the wait.

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<{ content: unknown[]; details: unknown }>;
}

function fakePi() {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, Handler>();
  return {
    tools,
    handlers,
    api: {
      registerTool: (t: RegisteredTool) => void tools.push(t),
      on: (event: string, handler: Handler) => void handlers.set(event, handler),
    },
  };
}

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A bot: answers by path, records every call; `fail` makes fetch throw. */
function fakeBot(answers: Record<string, unknown | ((body: unknown) => unknown)>, opts: { fail?: () => boolean } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (opts.fail?.()) throw new TypeError("fetch failed");
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, headers: init.headers as Record<string, string>, body });
    const answer = answers[path];
    if (answer === undefined) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const payload = typeof answer === "function" ? (answer as (b: unknown) => unknown)(body) : answer;
    // A whole Response stands for an answer with a status of its own (the relay's 202).
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  return { calls };
}

/** The bot's answer for a relayed call still running: 202 and the call id, as the route answers. */
const pending = (toolCallId: string) => new Response(JSON.stringify({ pending: true, toolCallId }), { status: 202 });

let dir: string;
let load: () => Promise<(pi: unknown) => Promise<void>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swb-pi-ext-"));
  const file = join(dir, "extension.mjs");
  writeFileSync(file, PI_EXTENSION_SOURCE);
  load = async () => ((await import(pathToFileURL(file).href)) as { default: (pi: unknown) => Promise<void> }).default;
  process.env[HARNESS_URL_ENV] = "https://bot.example.com/";
  process.env[RUN_BEARER_ENV] = "sbr_run-7.s3cret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env[HARNESS_URL_ENV];
  delete process.env[RUN_BEARER_ENV];
  rmSync(dir, { recursive: true, force: true });
});

const TOOLS = {
  tools: [
    {
      name: "update_status",
      description: "the card",
      inputSchema: { type: "object", properties: { checklist: { type: "string" } } },
    },
    { name: "submit_pr_description", description: "the PR", inputSchema: { type: "object", properties: {} } },
  ],
};

describe("the harness extension", () => {
  it("imports nothing and reads its settings from the environment", async () => {
    expect(PI_EXTENSION_SOURCE).not.toMatch(/^\s*import\s/m);
    expect(PI_EXTENSION_SOURCE).not.toContain("require(");
    delete process.env[RUN_BEARER_ENV];
    const bot = fakeBot({ "/harness/tools": TOOLS });
    const pi = fakePi();
    await expect((await load())(pi.api)).rejects.toThrow(
      /SWITCHBOARD_HARNESS_URL and SWITCHBOARD_RUN_BEARER must be set/,
    );
    expect(bot.calls).toHaveLength(0);
  });

  it("registers every tool the bot serves as a relay with the bot's schema, asking with the bearer and never with anything else", async () => {
    const bot = fakeBot({ "/harness/tools": TOOLS });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    expect(pi.tools.map((t) => t.name)).toEqual(["update_status", "submit_pr_description"]);
    expect(pi.tools[0].parameters).toEqual(TOOLS.tools[0].inputSchema);
    expect(pi.tools[0].description).toBe("the card");
    expect(bot.calls[0]).toMatchObject({ method: "GET", path: "/harness/tools" });
    expect(bot.calls[0].headers.authorization).toBe("Bearer sbr_run-7.s3cret");
    expect(Object.keys(bot.calls[0].headers).map((h) => h.toLowerCase())).toEqual([
      "authorization",
      "content-type",
      "accept",
    ]);
    expect(pi.handlers.has("tool_call")).toBe(true);
  });

  it("a relayed tool posts the call to the bot and answers pi with the bot's content; an error answer throws so pi records the failure", async () => {
    fakeBot({
      "/harness/tools": TOOLS,
      "/harness/tool": (body: unknown) => {
        const b = body as { tool: string; input: { checklist?: string } };
        return b.tool === "update_status"
          ? { content: [{ type: "text", text: `status updated: ${b.input.checklist}` }], isError: false }
          : { content: [{ type: "text", text: "the description is missing its title" }], isError: true };
      },
    });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    await expect(pi.tools[0].execute("c1", { checklist: "○ plan" })).resolves.toEqual({
      content: [{ type: "text", text: "status updated: ○ plan" }],
      details: {},
    });
    await expect(pi.tools[1].execute("c2", {})).rejects.toThrow("the description is missing its title");
  });

  it("the tool_call hook asks the bot and lets an allowed call run, or blocks with the bot's own reason", async () => {
    const bot = fakeBot({
      "/harness/tools": TOOLS,
      "/harness/authorize": (body: unknown) =>
        (body as { input: { command?: string } }).input.command === "git push origin main"
          ? { allow: false, reason: "repo:use — push to `main`, not the run's branch" }
          : { allow: true },
    });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    const hook = pi.handlers.get("tool_call")!;
    await expect(
      hook({ toolCallId: "c1", toolName: "bash", input: { command: "npm test" } }, {}),
    ).resolves.toBeUndefined();
    await expect(
      hook({ toolCallId: "c2", toolName: "bash", input: { command: "git push origin main" } }, {}),
    ).resolves.toEqual({
      block: true,
      reason: "repo:use — push to `main`, not the run's branch",
    });
    expect(bot.calls.filter((c) => c.path === "/harness/authorize").map((c) => c.body)).toEqual([
      { toolCallId: "c1", tool: "bash", input: { command: "npm test" } },
      { toolCallId: "c2", tool: "bash", input: { command: "git push origin main" } },
    ]);
  });

  it("an unreachable bot is asked again every two seconds and blocks the call after the wait, naming why", async () => {
    vi.useFakeTimers();
    const bot = fakeBot({ "/harness/tools": TOOLS, "/harness/authorize": { allow: true } });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    let down = true;
    vi.stubGlobal("fetch", async () => {
      if (down) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ allow: true }), { status: 200 });
    });
    const hook = pi.handlers.get("tool_call")!;
    const verdict = hook({ toolCallId: "c1", toolName: "bash", input: { command: "ls" } }, {});
    await vi.advanceTimersByTimeAsync(90_000 + 2_000);
    await expect(verdict).resolves.toEqual({
      block: true,
      reason: expect.stringMatching(/^authorization unavailable: the bot did not answer for 90 s \(.*fetch failed\)$/),
    });
    // A bot that comes back inside the wait answers the call.
    down = true;
    const recovered = hook({ toolCallId: "c2", toolName: "bash", input: { command: "ls" } }, {});
    await vi.advanceTimersByTimeAsync(4_000);
    down = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(recovered).resolves.toBeUndefined();
    void bot;
  });

  it("a refusal at the door — a 4xx: the bearer revoked, the run not on the harness — blocks the call at once, while a failing bot (a 5xx) is asked again", async () => {
    vi.useFakeTimers();
    fakeBot({ "/harness/tools": TOOLS });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    const hook = pi.handlers.get("tool_call")!;
    let asked = 0;
    let answer: { status: number; body: unknown } = { status: 403, body: { error: "revoked" } };
    vi.stubGlobal("fetch", async () => {
      asked++;
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    });
    await expect(hook({ toolCallId: "c1", toolName: "bash", input: { command: "ls" } }, {})).resolves.toEqual({
      block: true,
      reason: "authorization refused at the door: switchboard harness: POST /harness/authorize answered 403: revoked",
    });
    expect(asked).toBe(1);
    answer = { status: 404, body: { error: "run_not_on_harness" } };
    await expect(hook({ toolCallId: "c2", toolName: "bash", input: { command: "ls" } }, {})).resolves.toEqual({
      block: true,
      reason: expect.stringMatching(/answered 404: run_not_on_harness$/),
    });
    expect(asked).toBe(2);
    // A 5xx is the bot failing, not a verdict: asked again, answered when it recovers.
    answer = { status: 503, body: { error: "draining" } };
    const recovered = hook({ toolCallId: "c3", toolName: "bash", input: { command: "ls" } }, {});
    await vi.advanceTimersByTimeAsync(2_000);
    answer = { status: 200, body: { allow: true } };
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(recovered).resolves.toBeUndefined();
    expect(asked).toBeGreaterThanOrEqual(4);
  });

  // harness-pi item 7: a relayed call that outlives one request. The bot
  // answers that the call is still running, and the extension asks again with
  // the same call id until the answer lands.
  it("a relayed tool whose bot says the call is still running asks again with the same call id until the bot answers, and hands pi the one result", async () => {
    vi.useFakeTimers();
    let asks = 0;
    const { calls } = fakeBot({
      "/harness/tools": TOOLS,
      "/harness/tool": () =>
        ++asks < 3 ? pending("c1") : { content: [{ type: "text", text: "done at last" }], isError: false },
    });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    const result = pi.tools[0].execute("c1", { checklist: "x" });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toEqual({ content: [{ type: "text", text: "done at last" }], details: {} });
    const posts = calls.filter((c) => c.path === "/harness/tool");
    expect(posts).toHaveLength(3);
    expect(posts.map((c) => (c.body as { toolCallId: string }).toolCallId)).toEqual(["c1", "c1", "c1"]);
    expect(posts.map((c) => c.headers.authorization)).toEqual(Array(3).fill("Bearer sbr_run-7.s3cret"));
  });

  // harness-pi item 7: the door during a generation's boot. A pi that outlived
  // the bot asks again for a call in flight; the new generation's door holds
  // and answers retryably until the run is back on the harness, and the
  // extension's own rules — a 5xx is a bot not yet answering, a pending answer
  // a call still running — carry the same call id onto the settled answer.
  it("a bot whose door opens late — 503 reclaim_pending, then 202 run_resuming, then the settled answer — is asked again with the same call id until it answers, and the hook waits through the same 503 for its verdict", async () => {
    vi.useFakeTimers();
    const answer = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
    let toolAsks = 0;
    let authorizeAsks = 0;
    const { calls } = fakeBot({
      "/harness/tools": TOOLS,
      "/harness/tool": () => {
        toolAsks++;
        if (toolAsks === 1) return answer({ error: "reclaim_pending" }, 503);
        if (toolAsks <= 3) return answer({ pending: true, reason: "run_resuming" }, 202);
        return {
          content: [{ type: "text", text: "the bot restarted while update_status was running; it was not run again" }],
          isError: true,
        };
      },
      "/harness/authorize": () => (++authorizeAsks <= 2 ? answer({ error: "run_resuming" }, 503) : { allow: true }),
    });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    const relayed = pi.tools[0].execute("c1", { checklist: "x" });
    const settled = expect(relayed).rejects.toThrow(
      /^the bot restarted while update_status was running; it was not run again$/,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    await settled;
    const posts = calls.filter((c) => c.path === "/harness/tool");
    expect(posts).toHaveLength(4);
    expect(posts.map((c) => (c.body as { toolCallId: string }).toolCallId)).toEqual(["c1", "c1", "c1", "c1"]);
    const hook = pi.handlers.get("tool_call")!;
    const verdict = hook({ toolCallId: "c2", toolName: "bash", input: { command: "ls" } }, {});
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(verdict).resolves.toBeUndefined();
    expect(authorizeAsks).toBe(3);
  });

  it("a bot that stops answering mid-wait is asked again every two seconds and the call fails after 90 s naming the tool; a refusal at the door fails it at once; pi's abort stops the asking", async () => {
    vi.useFakeTimers();
    fakeBot({ "/harness/tools": TOOLS });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    let mode: "pending" | "down" | "door" = "pending";
    let asks = 0;
    vi.stubGlobal("fetch", async () => {
      asks++;
      if (mode === "down") throw new TypeError("fetch failed");
      if (mode === "door") return new Response(JSON.stringify({ error: "bearer_revoked" }), { status: 403 });
      return pending("c1");
    });
    // Down for good after one pending answer: asked every two seconds, failed after the wait.
    const failing = expect(pi.tools[0].execute("c1", {})).rejects.toThrow(
      /^switchboard harness: the bot did not answer update_status for 90 s \(.*fetch failed\)$/,
    );
    await vi.advanceTimersByTimeAsync(10);
    mode = "down";
    const before = asks;
    await vi.advanceTimersByTimeAsync(92_000);
    await failing;
    expect(asks - before).toBeGreaterThanOrEqual(45);
    // A 4xx at the door is a verdict: failed at once, never asked again.
    mode = "door";
    const atDoor = asks;
    await expect(pi.tools[0].execute("c2", {})).rejects.toThrow(/answered 403: bearer_revoked/);
    expect(asks - atDoor).toBe(1);
    // pi's abort ends the asking while the bot still says the call is running.
    mode = "pending";
    const ac = new AbortController();
    const aborted = expect(pi.tools[0].execute("c3", {}, ac.signal)).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    await aborted;
  });
});
