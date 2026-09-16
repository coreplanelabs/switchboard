import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { OC_BLOCKED_AT_DOOR_PREFIX, OPENCODE_PLUGIN_SOURCE } from "./pluginSource.js";

// Feature: docs/reference/specs/harness.md item 3 — the relay plugin. The plugin
// text is a constant the harness writes into the run's plugin directory; loaded
// by OpenCode as `./plugins/switchboard/index.js`, it registers the run's
// relayed tools from `GET /harness/tools` and runs each through
// `POST /harness/authorize` then `POST /harness/tool` with the model's call id,
// honouring a `202 pending` by re-asking under the same id — pi's protocol
// exactly. The test writes the constant to a file, imports it, and drives its
// default export against a stubbed `fetch` and a fake plugin context.

const BEARER = "sbr_run-c.the-secret-no-plugin-text-may-carry";
const URL = "https://bot.example.com";

interface AddedTool {
  name: string;
  description: string;
  input: unknown;
  options: { codemode: boolean };
  execute: (input: unknown, context: { id: string; signal?: AbortSignal }) => Promise<{ content: unknown }>;
}

/** Loads the plugin from the file the container would run and returns its default export. */
async function loadPlugin(dir: string): Promise<{ id: string; setup: (ctx: unknown) => Promise<void> }> {
  const file = join(dir, `plugin-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, OPENCODE_PLUGIN_SOURCE);
  const mod = (await import(pathToFileURL(file).href)) as {
    default: { id: string; setup: (ctx: unknown) => Promise<void> };
  };
  return mod.default;
}

/** A fake `/harness/*` server behind a stubbed `fetch`: it records every call,
 *  answers the tool roster, the door and the relay, and can be scripted to
 *  answer a relay call `202 pending` a set number of times first. */
interface FakeHarness {
  calls: Array<{ path: string; body: Record<string, unknown> }>;
  toolAnswers: Record<string, unknown>;
  authorize: (body: Record<string, unknown>) => { status: number; body: unknown };
  pendingBefore: number;
  fetch: typeof fetch;
}

function fakeHarness(
  opts: {
    tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
    authorize?: (body: Record<string, unknown>) => { status: number; body: unknown };
    toolAnswer?: unknown;
    pendingBefore?: number;
  } = {},
): FakeHarness {
  const tools = opts.tools ?? [
    { name: "update_status", description: "A relayed tool.", inputSchema: { type: "object" } },
  ];
  const fake: FakeHarness = {
    calls: [],
    toolAnswers: {},
    authorize: opts.authorize ?? (() => ({ status: 200, body: { allow: true } })),
    pendingBefore: opts.pendingBefore ?? 0,
    fetch: undefined as unknown as typeof fetch,
  };
  fake.fetch = (async (url: string, init?: RequestInit) => {
    const path = url.slice(URL.length);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    fake.calls.push({ path, body });
    const respond = (status: number, obj: unknown) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (path === "/harness/tools") return respond(200, { tools });
    if (path === "/harness/authorize") {
      const a = fake.authorize(body);
      return respond(a.status, a.body);
    }
    if (path === "/harness/tool") {
      const seen = fake.calls.filter((c) => c.path === "/harness/tool").length;
      if (seen <= fake.pendingBefore) return respond(202, { pending: true, toolCallId: body.toolCallId });
      return respond(200, opts.toolAnswer ?? { content: [{ type: "text", text: "relayed OK" }], isError: false });
    }
    return respond(404, { error: "no" });
  }) as unknown as typeof fetch;
  return fake;
}

const originalFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SWITCHBOARD_RUN_BEARER;
  delete process.env.SWITCHBOARD_HARNESS_URL;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-plugin-"));
  dirs.push(dir);
  return dir;
}

/** Loads the plugin, runs setup against the fake, and returns the tools it registered. */
async function register(fake: FakeHarness): Promise<AddedTool[]> {
  process.env.SWITCHBOARD_RUN_BEARER = BEARER;
  process.env.SWITCHBOARD_HARNESS_URL = URL;
  globalThis.fetch = fake.fetch;
  const plugin = await loadPlugin(scratch());
  const added: AddedTool[] = [];
  const hooks: Record<string, unknown> = {};
  await plugin.setup({
    tool: {
      transform: async (fn: (editor: { add: (t: AddedTool) => void }) => void) => fn({ add: (t) => added.push(t) }),
      hook: (name: string, cb: unknown) => {
        hooks[name] = cb;
      },
    },
  });
  return added;
}

describe("the OpenCode relay plugin", () => {
  it("carries no secret: the bearer and the bot's URL are read from the environment at runtime, never baked into the text", () => {
    expect(OPENCODE_PLUGIN_SOURCE).not.toContain(BEARER);
    expect(OPENCODE_PLUGIN_SOURCE).not.toContain("the-secret");
    expect(OPENCODE_PLUGIN_SOURCE).toContain("process.env[BEARER_ENV]");
    expect(OPENCODE_PLUGIN_SOURCE).toContain("SWITCHBOARD_RUN_BEARER");
    // Deterministic: the same text every time (a constant, not a per-run render).
    expect(typeof OPENCODE_PLUGIN_SOURCE).toBe("string");
  });

  it("registers each relayed tool as a DIRECT tool under its own name and JSON Schema (codemode off, so the model calls it by name and not through CodeMode)", async () => {
    const fake = fakeHarness({
      tools: [
        {
          name: "update_status",
          description: "Report the checklist.",
          inputSchema: { type: "object", properties: { checklist: { type: "string" } } },
        },
        { name: "submit_pr_description", description: "Submit the PR.", inputSchema: { type: "object" } },
      ],
    });
    const added = await register(fake);
    expect(added.map((t) => t.name)).toEqual(["update_status", "submit_pr_description"]);
    expect(added[0].options).toEqual({ codemode: false });
    expect(added[0].description).toBe("Report the checklist.");
    expect(added[0].input).toEqual({ type: "object", properties: { checklist: { type: "string" } } });
    // The roster came from GET /harness/tools with the run bearer.
    expect(fake.calls[0].path).toBe("/harness/tools");
  });

  it("runs a call through the door then the relay with the SAME call id, and returns the tool's text once", async () => {
    const fake = fakeHarness();
    const [tool] = await register(fake);
    const result = await tool.execute({ checklist: "○ first step" }, { id: "call_7" });
    expect(result.content).toBe("relayed OK");
    const harnessCalls = fake.calls.filter((c) => c.path !== "/harness/tools");
    expect(harnessCalls.map((c) => c.path)).toEqual(["/harness/authorize", "/harness/tool"]);
    // The call id is the same at the door and at the relay: the join holds.
    expect(harnessCalls[0].body.toolCallId).toBe("call_7");
    expect(harnessCalls[1].body.toolCallId).toBe("call_7");
    expect(harnessCalls[0].body.tool).toBe("update_status");
  });

  it("re-asks a 202 pending under the same call id until the bot answers, and runs the tool's result out once", async () => {
    const fake = fakeHarness({ pendingBefore: 1 });
    const [tool] = await register(fake);
    const result = await tool.execute({ checklist: "x" }, { id: "call_9" });
    expect(result.content).toBe("relayed OK");
    const toolPosts = fake.calls.filter((c) => c.path === "/harness/tool");
    // The bot said pending once, then answered: two posts, both the same call id.
    expect(toolPosts).toHaveLength(2);
    expect(toolPosts.every((c) => c.body.toolCallId === "call_9")).toBe(true);
  }, 10_000);

  it("a refusal from /harness/authorize (a 4xx at the door) becomes the tool's error text, and the relay never runs", async () => {
    const fake = fakeHarness({ authorize: () => ({ status: 403, body: { error: "run not on harness" } }) });
    const [tool] = await register(fake);
    await expect(tool.execute({}, { id: "call_x" })).rejects.toThrow(OC_BLOCKED_AT_DOOR_PREFIX);
    // The door refused, so /harness/tool was never posted.
    expect(fake.calls.some((c) => c.path === "/harness/tool")).toBe(false);
  });

  it("a tool result the bot marks isError becomes the tool's thrown error text", async () => {
    const fake = fakeHarness({ toolAnswer: { content: [{ type: "text", text: "the tool blew up" }], isError: true } });
    const [tool] = await register(fake);
    await expect(tool.execute({}, { id: "call_e" })).rejects.toThrow("the tool blew up");
  });
});
