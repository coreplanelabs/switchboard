import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createBashToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { normalizeContext, validateToolArguments, type Model, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { judgeToolCall } from "./toolRules.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piExtensionSource } from "./extensionSource.js";
import type { ToolDef } from "../../provider.js";
import { runCheckTool } from "../../../tools/check.js";
const PI_EXTENSION_SOURCE = piExtensionSource([]);
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
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    update?: unknown,
    ctx?: { cwd: string },
  ): Promise<{ content: unknown[]; details: unknown }>;
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

const originalTmpdir = process.env.TMPDIR;
const originalOutputRoot = process.env.SWITCHBOARD_PI_OUTPUT_ROOT;
const originalRunScratch = process.env.SWITCHBOARD_RUN_SCRATCH;
let dir: string;
let load: (tools?: readonly ToolDef[]) => Promise<(pi: unknown) => Promise<void>>;

beforeEach(() => {
  delete process.env.SWITCHBOARD_PI_OUTPUT_ROOT;
  delete process.env.SWITCHBOARD_RUN_SCRATCH;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "swb-pi-ext-")));
  const file = join(dir, "extension.mjs");
  writeFileSync(file, piExtensionSource(TOOLS.tools));
  // pi's pinned loader aliases its SDK even outside node_modules. Native
  // imports in this fixture use the same installed SDK through a temp link.
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "dir");
  load = async (tools = TOOLS.tools) => {
    writeFileSync(file, piExtensionSource(tools));
    return ((await import(pathToFileURL(file).href)) as { default: (pi: unknown) => Promise<void> }).default;
  };
  process.env[HARNESS_URL_ENV] = "https://bot.example.com/";
  process.env[RUN_BEARER_ENV] = "sbr_run-7.s3cret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env[HARNESS_URL_ENV];
  delete process.env[RUN_BEARER_ENV];
  if (originalOutputRoot === undefined) delete process.env.SWITCHBOARD_PI_OUTPUT_ROOT;
  else process.env.SWITCHBOARD_PI_OUTPUT_ROOT = originalOutputRoot;
  if (originalRunScratch === undefined) delete process.env.SWITCHBOARD_RUN_SCRATCH;
  else process.env.SWITCHBOARD_RUN_SCRATCH = originalRunScratch;
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
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
  it("keeps the authorization gate and checkout reader on unsupported hosts without scratch access", async () => {
    const host = process;
    vi.stubGlobal(
      "process",
      new Proxy(host, { get: (target, key) => (key === "platform" ? "darwin" : Reflect.get(target, key)) }),
    );
    const checkout = join(dir, "checkout");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "normal.txt"), "normal");
    const output = join(dir, "output");
    mkdirSync(output);
    const alias = join(dir, "output-alias");
    symlinkSync(output, alias, "dir");
    process.env.SWITCHBOARD_PI_OUTPUT_ROOT = alias;
    fakeBot({ "/harness/tools": TOOLS, "/harness/authorize": { allow: false, reason: "blocked by bot" } });
    const pi = fakePi();
    await expect((await load())(pi.api)).resolves.toBeUndefined();
    expect(pi.handlers.has("tool_call")).toBe(true);
    expect(
      await pi.handlers.get("tool_call")!({ toolCallId: "b", toolName: "bash", input: { command: "git push" } }, {}),
    ).toEqual({ block: true, reason: "blocked by bot" });
    const read = pi.tools.find((t) => t.name === "read")!;
    expect(await read.execute("r", { path: "normal.txt" }, undefined, undefined, { cwd: checkout })).toMatchObject({
      content: [{ type: "text", text: "normal" }],
    });
    const outside = join(output, "outside.log");
    writeFileSync(outside, "outside");
    await expect(read.execute("r", { path: outside }, undefined, undefined, { cwd: checkout })).rejects.toThrow();
  });

  it.each(["find", "ls"] as const)(
    "keeps a missing %s directory recoverable and lists the corrected location",
    async (name) => {
      const checkout = join(dir, "checkout");
      mkdirSync(join(checkout, "node_modules", "package"), { recursive: true });
      writeFileSync(join(checkout, "node_modules", "package", "index.js"), "export default 1;");
      fakeBot({});
      const pi = fakePi();
      await (
        await load([])
      )(pi.api);
      const tool = pi.tools.find((tool) => tool.name === name)!;
      const params = { path: "apps/console/node_modules/package", pattern: "*.js" };
      expect(await tool.execute("missing", params, undefined, undefined, { cwd: checkout })).toEqual({
        content: [
          {
            type: "text",
            text: "No directory at apps/console/node_modules/package. List its parent or the repository root before choosing another path. Dependencies can be in the root node_modules.",
          },
        ],
        details: undefined,
      });
      const listed = pi.tools.find((tool) => tool.name === "ls")!;
      expect(
        await listed.execute("present", { path: "node_modules/package" }, undefined, undefined, { cwd: checkout }),
      ).toMatchObject({
        content: [{ type: "text", text: "index.js" }],
      });
      symlinkSync("loop", join(checkout, "loop"));
      await expect(
        tool.execute("filesystem-error", { path: "loop", pattern: "*" }, undefined, undefined, { cwd: checkout }),
      ).rejects.toMatchObject({ code: "ELOOP" });
      const abort = new AbortController();
      abort.abort();
      await expect(tool.execute("cancelled", params, abort.signal, undefined, { cwd: checkout })).rejects.toMatchObject(
        { name: "AbortError" },
      );
    },
  );

  it("directs an oversized review source to the available byte reader instead of bash", async () => {
    const checkout = join(dir, "checkout");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "catalog.txt"), "x".repeat(900_000));
    process.env.SWITCHBOARD_PI_OUTPUT_ROOT = join(dir, "output");
    const tool = { name: "review_read", description: "bounded source", inputSchema: { type: "object" } };
    fakeBot({ "/harness/tools": { tools: [tool] } });
    const pi = fakePi();
    await (
      await load([tool])
    )(pi.api);
    const read = pi.tools.find((t) => t.name === "read")!;
    const result = await read.execute("large", { path: "catalog.txt" }, undefined, undefined, { cwd: checkout });
    expect(result.content).toEqual([
      {
        type: "text",
        text: 'This line exceeds the read tool limit. Read the tracked file at the pinned review head with review_read {"kind":"file","path":"catalog.txt","offset":0}; continue with each returned nextOffset and sourceHash until eof. Uncommitted files are not included.',
      },
    ]);
  });

  it("retains a blocking gate when extension initialization fails", async () => {
    fakeBot({});
    const pi = fakePi();
    const register = pi.api.registerTool;
    pi.api.registerTool = (tool) => {
      if (tool.name === "submit_pr_description") throw new Error("private registration details");
      register(tool);
    };
    await (
      await load()
    )(pi.api);
    expect(pi.tools.map((tool) => tool.name)).toEqual(["update_status"]);
    expect(
      await pi.handlers.get("tool_call")!({ toolCallId: "blocked", toolName: "update_status", input: {} }, {}),
    ).toEqual({
      block: true,
      reason:
        "authorization unavailable: harness initialization failed during tool registration (Error); tool execution blocked",
    });
  });

  it.each([null, "private upstream text"])("keeps authorization and relay 4xx final for body %j", async (body) => {
    const bot = fakeBot({
      "/harness/tools": TOOLS,
      "/harness/authorize": () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 403 }),
      "/harness/tool": () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 403 }),
    });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    const verdict = await pi.handlers.get("tool_call")!(
      { toolCallId: "blocked", toolName: "update_status", input: {} },
      {},
    );
    expect(verdict).toEqual({
      block: true,
      reason:
        body === null
          ? "authorization refused at the door: switchboard harness: POST /harness/authorize answered 403: null"
          : "authorization refused at the door: switchboard harness: POST /harness/authorize answered 403 with a body that is not JSON",
    });
    await expect(pi.tools[0].execute("blocked", {})).rejects.toThrow(
      body === null
        ? "switchboard harness: POST /harness/tool answered 403: null"
        : "switchboard harness: POST /harness/tool answered 403 with a body that is not JSON",
    );
    expect(bot.calls.filter((call) => call.path === "/harness/authorize")).toHaveLength(1);
    expect(bot.calls.filter((call) => call.path === "/harness/tool")).toHaveLength(1);
  });

  it("names scratch setup failure without exposing paths or opening the gate", async () => {
    process.env.SWITCHBOARD_PI_OUTPUT_ROOT = join(dir, "output");
    process.env.SWITCHBOARD_RUN_SCRATCH = join(dir, "private-file");
    writeFileSync(process.env.SWITCHBOARD_RUN_SCRATCH, "occupied");
    fakeBot({ "/harness/tools": TOOLS });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    expect(
      await pi.handlers.get("tool_call")!({ toolCallId: "blocked", toolName: "bash", input: { command: "ls" } }, {}),
    ).toEqual({
      block: true,
      reason:
        "authorization unavailable: harness initialization failed during scratch setup (EEXIST); tool execution blocked",
    });
  });

  it("uses the pinned reader's path normalization before checking and reading the target", async () => {
    const checkout = join(dir, "checkout");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "normal.txt"), "normal");
    process.env.SWITCHBOARD_PI_OUTPUT_ROOT = join(dir, "output");
    fakeBot({ "/harness/tools": TOOLS });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    const read = pi.tools.find((t) => t.name === "read")!;
    for (const path of ["@normal.txt", "@" + join(checkout, "normal.txt")])
      expect(await read.execute("r", { path }, undefined, undefined, { cwd: checkout })).toMatchObject({
        content: [{ type: "text", text: "normal" }],
      });
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "outside");
    await expect(read.execute("r", { path: "@" + outside }, undefined, undefined, { cwd: checkout })).rejects.toThrow();
  });
  it("loads the output read override through the pinned pi loader outside node_modules", async () => {
    rmSync(join(dir, "node_modules"));
    process.env.SWITCHBOARD_PI_OUTPUT_ROOT = join(dir, "output");
    fakeBot({ "/harness/tools": TOOLS });
    const loader = (await import(
      new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
    )) as {
      loadExtensions(
        paths: string[],
        cwd: string,
      ): Promise<{ extensions: { tools: Map<string, unknown> }[]; errors: unknown[] }>;
    };
    const loaded = await loader.loadExtensions([join(dir, "extension.mjs")], dir);
    expect(loaded.errors).toEqual([]);
    expect([...loaded.extensions[0].tools.keys()]).toEqual([
      "read",
      "update_status",
      "submit_pr_description",
      "find",
      "ls",
    ]);
    if (process.platform === "linux") expect(process.env.TMPDIR?.startsWith(`${dir}/output/process-`)).toBe(true);
    else expect(process.env.TMPDIR).toBe(originalTmpdir);
  });

  // Workspace pi runs on Linux; the kernel resolves held descriptors through /proc.
  it.runIf(process.platform === "linux").each(["read", "write"] as const)(
    "reads pinned pi bash spills only from this process's output scratch for %s identity",
    async (identity) => {
      const checkout = join(dir, "checkout");
      const root = join(dir, "run", "output");
      mkdirSync(checkout);
      mkdirSync(root, { recursive: true });
      const credential = join(dir, "run", "agent", "models.json");
      mkdirSync(join(dir, "run", "agent"));
      writeFileSync(credential, "not output");
      writeFileSync(join(checkout, "normal.txt"), "ordinary checkout read");
      process.env.SWITCHBOARD_PI_OUTPUT_ROOT = root;
      const bot = fakeBot({
        "/harness/tools": TOOLS,
        "/harness/authorize": (body: unknown) => {
          const ask = body as { tool: string; input: unknown };
          const verdict = judgeToolCall(ask.tool, ask.input, {
            identity,
            checkout,
            outputDir: root,
            noShellPush: true,
          });
          return verdict.verdict === "allowed" ? { allow: true } : { allow: false, reason: verdict.reason };
        },
      });
      const pi = fakePi();
      await (
        await load()
      )(pi.api);
      const scratch = process.env.TMPDIR!;
      expect(scratch.startsWith(`${root}/`)).toBe(true);
      expect(scratch.startsWith(`${checkout}/`)).toBe(false);
      let exitCode = 0;
      const context = { cwd: checkout } as ExtensionToolContext;
      const bash = createBashToolDefinition(checkout, {
        exposeSessionEnvironment: false,
        operations: {
          exec: async (_command, _cwd, { onData }) => {
            onData(Buffer.from(Array.from({ length: 2200 }, (_, i) => `row ${i + 1}`).join("\n")));
            return { exitCode };
          },
        },
      });
      const output = await bash.execute("bash-1", { command: "fixture" }, undefined, undefined, context);
      const path = (output.details as { fullOutputPath: string }).fullOutputPath;
      expect(path.startsWith(`${scratch}/`)).toBe(true);
      const hook = pi.handlers.get("tool_call")!;
      expect(
        await hook({ toolCallId: "read-1", toolName: "read", input: { path } }, { cwd: checkout }),
      ).toBeUndefined();
      const read = pi.tools.find((tool) => tool.name === "read")!;
      expect(read).toBeDefined();
      const readAt = (file: string, offset = 1, limit = 2) =>
        read.execute("read-1", { path: file, offset, limit }, undefined, undefined, { cwd: checkout });
      expect(await readAt(path)).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("row 1\nrow 2") }],
      });
      expect(await readAt(path, 2199)).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("row 2199\nrow 2200") }],
      });
      expect(await readAt(join(checkout, "normal.txt"))).toMatchObject({
        content: [{ type: "text", text: "ordinary checkout read" }],
      });
      const checkoutAlias = join(dir, "checkout-alias");
      symlinkSync(checkout, checkoutAlias, "dir");
      expect(
        await read.execute(
          "absolute-checkout-alias",
          { path: join(checkoutAlias, "normal.txt") },
          undefined,
          undefined,
          { cwd: checkoutAlias },
        ),
      ).toMatchObject({
        content: [{ type: "text", text: "ordinary checkout read" }],
      });
      exitCode = 1;
      const failure = await bash.execute("bash-failed", { command: "fixture failure" }, undefined, undefined, context);
      expect(failure.isError).toBe(true);
      const failedPath = (failure.details as { fullOutputPath: string }).fullOutputPath;
      expect(failedPath.startsWith(`${scratch}/`)).toBe(true);
      expect(await readAt(failedPath)).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("row 1\nrow 2") }],
      });
      for (const file of [credential, join(dir, "pi-bash-other.log"), join(root, "other-process", "pi-bash-file.log")])
        await expect(readAt(file)).rejects.toThrow();
      expect(
        await hook({ toolCallId: "read-outside", toolName: "read", input: { path: credential } }, {}),
      ).toMatchObject({ block: true });
      for (const tool of ["write", "edit", "ls", "grep", "find"])
        expect(await hook({ toolCallId: `outside-${tool}`, toolName: tool, input: { path } }, {})).toMatchObject({
          block: true,
        });
      const symlink = join(scratch, "link.log");
      symlinkSync(credential, symlink);
      await expect(readAt(symlink)).rejects.toThrow();
      const hardlink = join(scratch, "hardlink.log");
      linkSync(credential, hardlink);
      await expect(readAt(hardlink)).rejects.toThrow();
      symlinkSync(join(dir, "run", "agent"), join(scratch, "escape"));
      await expect(readAt(join(scratch, "escape", "models.json"))).rejects.toThrow();
      symlinkSync(path, join(checkout, "output-link"));
      await expect(readAt(join(checkout, "output-link"))).rejects.toThrow();
      // A bot reattach uses the same loaded extension; a fresh pi does not
      // inherit a previous process's scratch, even with the same run root.
      expect(await readAt(path)).toBeDefined();
      const fresh = fakePi();
      await (
        await load()
      )(fresh.api);
      expect(process.env.TMPDIR).not.toBe(scratch);
      const freshRead = fresh.tools.find((tool) => tool.name === "read")!;
      await expect(freshRead.execute("old", { path }, undefined, undefined, { cwd: checkout })).rejects.toThrow();
      // Replacing the directory with an alias cannot extend the old grant.
      renameSync(scratch, `${scratch}-moved`);
      symlinkSync(join(dir, "run", "agent"), scratch);
      await expect(readAt(join(scratch, "models.json"))).rejects.toThrow();
      expect(bot.calls.some((call) => call.path === "/harness/authorize")).toBe(true);
    },
  );
  it.each(process.platform === "darwin" ? ["canonical", "macOS alias"] : ["canonical"])(
    "reads a run-owned temporary file while keeping runtime files and aliases outside the grant: %s",
    async (spelling) => {
      const checkout = join(dir, "checkout");
      const scratch = join(
        spelling === "macOS alias" ? dir.replace(/^\/private(?=\/var\/)/, "") : dir,
        "run",
        "scratch",
      );
      const runtime = join(dir, "run", "agent");
      mkdirSync(checkout);
      mkdirSync(runtime, { recursive: true });
      process.env.SWITCHBOARD_PI_OUTPUT_ROOT = join(dir, "run", "output");
      process.env.SWITCHBOARD_RUN_SCRATCH = scratch;
      fakeBot({
        "/harness/tools": TOOLS,
        "/harness/authorize": (body: unknown) => {
          const ask = body as { tool: string; input: unknown };
          const verdict = judgeToolCall(ask.tool, ask.input, { identity: "read", checkout, scratchDir: scratch });
          return verdict.verdict === "allowed" ? { allow: true } : { allow: false, reason: verdict.reason };
        },
      });
      const pi = fakePi();
      await (
        await load()
      )(pi.api);
      expect(process.env.TMPDIR).toBe(scratch);
      const path = join(scratch, "review.diff");
      writeFileSync(path, "verified temporary diff");
      const tool = pi.tools.find((t) => t.name === "read")!;
      expect(await tool.execute("scratch-read", { path }, undefined, undefined, { cwd: checkout })).toMatchObject({
        content: [{ type: "text", text: "verified temporary diff" }],
      });
      const privateFile = join(runtime, "models.json");
      writeFileSync(privateFile, "runtime config");
      await expect(
        tool.execute("runtime-read", { path: privateFile }, undefined, undefined, { cwd: checkout }),
      ).rejects.toThrow();
      symlinkSync(privateFile, join(scratch, "alias"));
      await expect(
        tool.execute("alias-read", { path: join(scratch, "alias") }, undefined, undefined, { cwd: checkout }),
      ).rejects.toThrow();
    },
  );
  it("imports only the pinned pi SDK and Node builtins and reads its settings from the environment", async () => {
    expect(PI_EXTENSION_SOURCE.match(/^import .* from "([^"]+)"/gm)).toEqual([
      'import { constants } from "node:fs"',
      'import { mkdir, mkdtemp, open, realpath, stat as fileStat } from "node:fs/promises"',
      'import { isAbsolute, relative, resolve } from "node:path"',
      'import { pathToFileURL } from "node:url"',
      'import { createReadToolDefinition, createFindToolDefinition, createLsToolDefinition, getPackageDir } from "@earendil-works/pi-coding-agent"',
    ]);
    expect(PI_EXTENSION_SOURCE).not.toContain("require(");
    delete process.env[RUN_BEARER_ENV];
    const bot = fakeBot({ "/harness/tools": TOOLS });
    const pi = fakePi();
    await expect((await load())(pi.api)).resolves.toBeUndefined();
    expect(
      await pi.handlers.get("tool_call")!({ toolCallId: "b", toolName: "bash", input: { command: "touch file" } }, {}),
    ).toMatchObject({ block: true });
    expect(bot.calls).toHaveLength(0);
  });

  it("registers every launch definition as a relay without a discovery request", async () => {
    const bot = fakeBot({ "/harness/tools": TOOLS });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    expect(pi.tools.map((t) => t.name)).toEqual(["update_status", "submit_pr_description", "find", "ls"]);
    expect(pi.tools[0].parameters).toEqual({ type: "object", properties: { checklist: { type: "string" } } });
    expect(pi.tools[0].description).toBe("the card");
    expect(bot.calls).toEqual([]);
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

  it("the session_before_compact hook asks the bot once with the preparation's facts — the trigger, the size, the previous summary, pi's own file lists — and hands pi the bot's summary as the extension's compaction under pi's kept entry and size; a bot that leaves the summary to pi, or cannot be reached, answers nothing and is not asked again", async () => {
    let summary: string | undefined = "POINTER";
    const bot = fakeBot({
      "/harness/tools": TOOLS,
      "/harness/compaction": () => (summary === undefined ? {} : { summary }),
    });
    const pi = fakePi();
    await (
      await load()
    )(pi.api);
    const hook = pi.handlers.get("session_before_compact")!;
    const preparation = {
      firstKeptEntryId: "e9",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: true,
      tokensBefore: 187_000,
      previousSummary: "so far: two tests fail",
      fileOps: {
        read: new Set(["src/a.ts", "src/b.ts"]),
        edited: new Set(["src/b.ts"]),
        written: new Set(["src/c.ts"]),
      },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    };
    const event = (signal = new AbortController().signal) => ({
      type: "session_before_compact",
      preparation,
      branchEntries: [],
      reason: "threshold",
      willRetry: false,
      signal,
    });
    await expect(hook(event(), {})).resolves.toEqual({
      compaction: {
        summary: "POINTER",
        firstKeptEntryId: "e9",
        tokensBefore: 187_000,
        details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts", "src/c.ts"] },
      },
    });
    expect(bot.calls.filter((c) => c.path === "/harness/compaction").map((c) => c.body)).toEqual([
      {
        reason: "threshold",
        tokensBefore: 187_000,
        previousSummary: "so far: two tests fail",
        readFiles: ["src/a.ts"],
        modifiedFiles: ["src/b.ts", "src/c.ts"],
      },
    ]);
    // The bot leaves it to pi: nothing.
    summary = undefined;
    await expect(hook(event(), {})).resolves.toBeUndefined();
    // No previous summary: the key is not sent.
    await hook({ ...event(), preparation: { ...preparation, previousSummary: undefined } }, {});
    expect(bot.calls.at(-1)?.body).not.toHaveProperty("previousSummary");
    // The bot cannot be reached: pi's own compaction, at once — one ask, no wait.
    vi.unstubAllGlobals();
    const dead = fakeBot({}, { fail: () => true });
    await expect(hook(event(), {})).resolves.toBeUndefined();
    expect(dead.calls).toEqual([]);
    // A refusal at the door is the same answer.
    vi.unstubAllGlobals();
    fakeBot({});
    await expect(hook(event(), {})).resolves.toBeUndefined();
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

describe("hosted Review extension relay", () => {
  it("registers the hosted command and preserves its call id and payload without a shell alias", async () => {
    const bot = fakeBot({
      "/harness/tools": {
        tools: [{ name: "run_check", description: "Recorded command", inputSchema: { type: "object" } }],
      },
      "/harness/authorize": { allow: true },
      "/harness/tool": { content: [{ type: "text", text: "completed with exit 1" }], isError: false },
    });
    const pi = fakePi();
    await (
      await load([{ name: "run_check", description: "Recorded command", inputSchema: { type: "object" } }])
    )(pi.api);
    expect(pi.tools.map((tool) => tool.name)).toEqual(["run_check", "find", "ls"]);
    const input = { command: "git status --short", purpose: "verification", timeoutMs: 10000 };
    expect(await pi.tools[0].execute("original-review-call", input)).toMatchObject({
      content: [{ type: "text", text: "completed with exit 1" }],
    });
    expect(bot.calls.filter((call) => call.path === "/harness/tool").map((call) => call.body)).toEqual([
      { toolCallId: "original-review-call", tool: "run_check", input },
    ]);
  });
});

describe("run_check provider schema", () => {
  it.each(["sk-ant-test", "sk-ant-oat01-test"])(
    "retains the checkpoint rule in the serialized Anthropic payload for %s without restoring removed tools",
    async (apiKey) => {
      const pi = fakePi();
      await (
        await load([runCheckTool, ...TOOLS.tools])
      )(pi.api);
      const model: Model<"anthropic-messages"> = {
        id: "claude-sonnet-4-6",
        name: "fixture",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 100,
      };
      const tool: Tool = {
        name: runCheckTool.name,
        description: runCheckTool.description,
        parameters: runCheckTool.inputSchema as Tool["parameters"],
      };
      const bodies: Array<{
        model: string;
        max_tokens: number;
        tools: Array<{ name: string; input_schema: Tool["parameters"] }>;
      }> = [];
      const request = async (tools: Tool[]) =>
        anthropicStream(model, normalizeContext({ messages: [], tools }), {
          apiKey,
          onPayload: async (payload) => pi.handlers.get("before_provider_request")?.({ payload }, {}),
          fetch: async (_url, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return new Response(
              'event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
            );
          },
        }).result();
      const other: Tool = {
        name: "update_status",
        description: "status",
        parameters: { type: "object", properties: {}, required: [] },
      };
      await request([tool, other]);
      expect({ model: bodies[0].model, maxTokens: bodies[0].max_tokens }).toEqual({
        model: "claude-sonnet-4-6",
        maxTokens: 100,
      });
      expect(bodies[0].tools.find((entry) => entry.name === "update_status")?.input_schema).toEqual({
        type: "object",
        properties: {},
        required: [],
      });
      const sent = bodies[0].tools.find((entry) => entry.name === "run_check")!;
      const checkpoint = {
        phase: "verify",
        goal: "Check the change",
        decisions: [],
        rejected: [],
        completed: [],
        unproven: [],
        next: "Review",
      };
      const validate = (input: ToolCall["arguments"]) =>
        validateToolArguments(
          { ...tool, parameters: sent.input_schema },
          {
            type: "toolCall",
            id: "payload-check",
            name: tool.name,
            arguments: input,
          },
        );
      expect(() => validate({ command: "true", purpose: "baseline", checkpoint })).toThrow(
        'Validation failed for tool "run_check"',
      );
      const validInputs: ToolCall["arguments"][] = [
        { command: "true", purpose: "baseline" },
        { command: "true", purpose: "verification" },
        { command: "true", purpose: "verification", checkpoint },
      ];
      for (const input of validInputs) expect(validate(input)).toEqual(input);
      await request([other]);
      expect(bodies[1].tools.map(({ name, input_schema }) => ({ name, input_schema }))).toEqual([
        { name: "update_status", input_schema: { type: "object", properties: {}, required: [] } },
      ]);
      const otherWire = { tools: [{ type: "function", name: "run_check", parameters: { type: "object" } }] };
      expect((await pi.handlers.get("before_provider_request")?.({ payload: otherWire }, {})) ?? otherWire).toEqual({
        tools: [{ type: "function", name: "run_check", parameters: { type: "object" } }],
      });
      for (const tool of [
        { name: "run_check", strict: true, input_schema: { type: "object" } },
        {
          name: "run_check",
          input_schema: { type: "object", anyOf: [{ properties: { purpose: { enum: ["verification"] } } }] },
        },
      ]) {
        const payload = { tools: [tool] };
        expect((await pi.handlers.get("before_provider_request")?.({ payload }, {})) ?? payload).toBe(payload);
      }
    },
  );
});
