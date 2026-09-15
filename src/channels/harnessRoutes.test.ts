import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessRegistry, type LiveHarness } from "../core/harness/pi/relay.js";
import { RunBearerStore, bearerHashOf } from "../core/modelProxy/runBearers.js";
import type { RunEvent } from "../core/runEvents.js";
import { LedgerTakeover, type TakeoverFacts } from "../core/runLedger/takeover.js";
import { createTracer } from "../core/trace/tracer.js";
import type { RunnableTool } from "../tools/runnableTool.js";
import {
  DOOR_HOLD_MS,
  HARNESS_AUTHORIZE_PATH,
  HARNESS_TOOLS_PATH,
  HARNESS_TOOL_PATH,
  createHarnessRoutesHandler,
  handleHarnessRequest,
  isHarnessPath,
} from "./harnessRoutes.js";

// Feature: docs/reference/specs/harness-pi.md item 7 — the three harness
// routes: the run bearer is the whole door, decided from the headers before
// the body; a run that is not on the harness answers nothing; then the tool
// definitions, the gate's verdict, or a relayed tool's result. During a
// generation's boot the door holds and answers retryably for a run the
// ledger still lists as live and not yet resumed here.

const clock = { now: 1_700_000_000_000 };
const root = createTracer({ clock: () => clock.now }).start("request", { sinks: [] });

/** The boot's takeover as the door reads it, driven by the test: unsettled
 *  until `settle` (with the runs the reclaim handed on), or timed out by `elapse`. */
function fakeTakeover(over: { settled?: boolean; pending?: string[] } = {}) {
  let settled = over.settled ?? true;
  const pending = new Set(over.pending ?? []);
  const waiters: ((settledInTime: boolean) => void)[] = [];
  const holds: number[] = [];
  const facts: TakeoverFacts = {
    get settled() {
      return settled;
    },
    whenSettled: (ms) => {
      holds.push(ms);
      return settled ? Promise.resolve(true) : new Promise<boolean>((r) => waiters.push(r));
    },
    pending: (id) => pending.has(id),
  };
  return {
    facts,
    holds,
    settle: (ids: string[] = []) => {
      settled = true;
      for (const id of ids) pending.add(id);
      for (const w of waiters.splice(0)) w(true);
    },
    elapse: () => {
      for (const w of waiters.splice(0)) w(false);
    },
    done: (id: string) => void pending.delete(id),
  };
}

function settledTakeover(): TakeoverFacts {
  const t = new LedgerTakeover();
  t.settle();
  return t;
}

function world(takeover: TakeoverFacts = settledTakeover()) {
  const bearers = new RunBearerStore({ clock: () => clock.now });
  const harnesses = new HarnessRegistry();
  const events: RunEvent[] = [];
  const echo: RunnableTool = {
    name: "update_status",
    description: "the card",
    inputSchema: { type: "object", properties: {} },
    run: async (input) => `status updated: ${String(input.checklist)}`,
  };
  const harness: LiveHarness = {
    runId: "run-7",
    tools: [echo],
    toolContext: { executor: { exec: async () => "", readFile: async () => "", writeFile: async () => "" } },
    rules: { identity: "write", checkout: "/work", branch: "feat/x" },
    emit: (e) => void events.push(e),
    toolSpan: () => undefined,
    gateSaw: () => {},
    toolsBlocked: () => undefined,
  };
  const grant = (runId: string) => ({
    runId,
    modelRef: "anthropic/m",
    providerName: "anthropic",
    providerType: "anthropic" as const,
    model: "m",
    maxTokens: 1000,
    maxTurns: 10,
    expiresAt: clock.now + 60_000,
    span: root,
    publish: () => {},
  });
  const bearer = bearers.mint(grant("run-7"));
  const other = bearers.mint(grant("run-8")); // minted, but not on the harness
  harnesses.register(harness);
  const deps = { bearers, harnesses, takeover };
  const headers = (b = bearer) => ({ authorization: `Bearer ${b}` });
  return { deps, bearer, other, headers, events, bearers, harnesses, harness, grant };
}

/** Whether a promise has settled by the next macrotask — a held door has not. */
async function answeredYet(p: Promise<unknown>): Promise<boolean> {
  let answered = false;
  void p.then(
    () => (answered = true),
    () => (answered = true),
  );
  await new Promise((r) => setImmediate(r));
  return answered;
}

/** A relayed tool that answers when the test releases it, counting its runs. */
function slowTool() {
  let release!: (text: string) => void;
  let runs = 0;
  const tool: RunnableTool = {
    name: "slow",
    description: "waits",
    inputSchema: { type: "object", properties: {} },
    run: () => {
      runs++;
      return new Promise<string>((r) => (release = r));
    },
  };
  return { tool, release: (text: string) => release(text), runs: () => runs };
}

describe("handleHarnessRequest", () => {
  it("names the three paths and nothing else", () => {
    expect([HARNESS_TOOLS_PATH, HARNESS_AUTHORIZE_PATH, HARNESS_TOOL_PATH].every(isHarnessPath)).toBe(true);
    expect(isHarnessPath("/harness/other")).toBe(false);
  });

  it("the door: no bearer 401, a malformed one 401, an unknown run 404, a wrong secret 401, a revoked one 403, a run not on the harness 404 — nothing served", async () => {
    const { deps, bearer, other, bearers } = world();
    const get = (headers: Record<string, string>) =>
      handleHarnessRequest(deps, { method: "GET", path: HARNESS_TOOLS_PATH, headers });
    expect(await get({})).toEqual({ status: 401, body: { error: "missing_bearer" } });
    expect(await get({ authorization: "Bearer nope" })).toEqual({ status: 401, body: { error: "malformed" } });
    expect(await get({ authorization: "Bearer sbr_run-9.abc" })).toEqual({
      status: 404,
      body: { error: "unknown_run" },
    });
    expect(await get({ authorization: `Bearer ${bearer.slice(0, -3)}xyz` })).toEqual({
      status: 401,
      body: { error: "unknown_bearer" },
    });
    expect(await get({ authorization: `Bearer ${other}` })).toEqual({
      status: 404,
      body: { error: "run_not_on_harness" },
    });
    bearers.revoke("run-7");
    expect(await get({ authorization: `Bearer ${bearer}` })).toEqual({ status: 403, body: { error: "revoked" } });
  });

  it("GET /harness/tools serves the run's relayed tool definitions", async () => {
    const { deps, headers } = world();
    expect(await handleHarnessRequest(deps, { method: "GET", path: HARNESS_TOOLS_PATH, headers: headers() })).toEqual({
      status: 200,
      body: {
        tools: [{ name: "update_status", description: "the card", inputSchema: { type: "object", properties: {} } }],
      },
    });
    expect(
      (await handleHarnessRequest(deps, { method: "POST", path: HARNESS_TOOLS_PATH, headers: headers() })).status,
    ).toBe(405);
  });

  it("POST /harness/authorize answers the gate's verdict; a malformed ask is 400", async () => {
    const { deps, headers, events } = world();
    const ask = (body: unknown) =>
      handleHarnessRequest(deps, { method: "POST", path: HARNESS_AUTHORIZE_PATH, headers: headers(), body });
    expect(await ask({ toolCallId: "c1", tool: "bash", input: { command: "npm test" } })).toEqual({
      status: 200,
      body: { allow: true },
    });
    expect(await ask({ toolCallId: "c2", tool: "bash", input: { command: "gh pr merge 1" } })).toEqual({
      status: 200,
      body: { allow: false, reason: "merge/approve — a coding run never merges or approves a pull request" },
    });
    expect(events).toHaveLength(1);
    expect(await ask({ tool: 42 })).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(
      (await handleHarnessRequest(deps, { method: "GET", path: HARNESS_AUTHORIZE_PATH, headers: headers() })).status,
    ).toBe(405);
  });

  it("POST /harness/tool runs the relayed tool and answers pi's content", async () => {
    const { deps, headers } = world();
    expect(
      await handleHarnessRequest(deps, {
        method: "POST",
        path: HARNESS_TOOL_PATH,
        headers: headers(),
        body: { toolCallId: "c1", tool: "update_status", input: { checklist: "○ x" } },
      }),
    ).toEqual({ status: 200, body: { content: [{ type: "text", text: "status updated: ○ x" }], isError: false } });
  });

  // harness-pi item 7: a relayed call that outlives one request.
  it("POST /harness/tool for a call still running after the window is 202 pending with the call id; the same id asked again joins the one run (never a second start) and reads the answer once it lands", async () => {
    const { deps, headers, harness } = world();
    const slow = slowTool();
    harness.tools.push(slow.tool);
    const ask = {
      method: "POST",
      path: HARNESS_TOOL_PATH,
      headers: headers(),
      body: { toolCallId: "c-slow", tool: "slow", input: {} },
    };
    const windowed = { ...deps, relayWindowMs: 5 };
    expect(await handleHarnessRequest(windowed, ask)).toEqual({
      status: 202,
      body: { pending: true, toolCallId: "c-slow" },
    });
    const again = handleHarnessRequest(windowed, ask);
    slow.release("finally");
    expect(await again).toEqual({
      status: 200,
      body: { content: [{ type: "text", text: "finally" }], isError: false },
    });
    expect(slow.runs()).toBe(1);
  });

  it("an unknown path is 404", async () => {
    const { deps, headers } = world();
    expect(await handleHarnessRequest(deps, { method: "GET", path: "/harness/nope", headers: headers() })).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });
});

describe("the door during a generation's boot — a run the ledger lists as live and not yet resumed here", () => {
  const strangers = { authorization: "Bearer sbr_run-9.abc" };
  const ask = (deps: Parameters<typeof handleHarnessRequest>[0], path: string, headers: Record<string, string>) =>
    handleHarnessRequest(deps, {
      method: path === HARNESS_TOOLS_PATH ? "GET" : "POST",
      path,
      headers,
      body: { toolCallId: "c-9", tool: "update_status", input: {} },
    });

  it("an unknown bearer before the reclaim settles is held, not answered, for up to DOOR_HOLD_MS; a reclaim that lists no such run makes it the store's 404 after all", async () => {
    const takeover = fakeTakeover({ settled: false });
    const { deps } = world(takeover.facts);
    const held = ask(deps, HARNESS_TOOL_PATH, strangers);
    expect(await answeredYet(held)).toBe(false);
    expect(takeover.holds).toEqual([DOOR_HOLD_MS]);
    takeover.settle([]);
    expect(await held).toEqual({ status: 404, body: { error: "unknown_run" } });
  });

  it("a reclaim that hands the run to the launcher makes the held ask retryable: 202 pending on /harness/tool, 503 with Retry-After on authorize and tools — never a 4xx", async () => {
    const takeover = fakeTakeover({ settled: false });
    const { deps } = world(takeover.facts);
    const tool = ask(deps, HARNESS_TOOL_PATH, strangers);
    const authorize = ask(deps, HARNESS_AUTHORIZE_PATH, strangers);
    const tools = ask(deps, HARNESS_TOOLS_PATH, strangers);
    expect(await answeredYet(Promise.all([tool, authorize, tools]))).toBe(false);
    takeover.settle(["run-9"]);
    expect(await tool).toEqual({ status: 202, body: { pending: true, reason: "run_resuming" } });
    expect(await authorize).toEqual({
      status: 503,
      body: { error: "run_resuming" },
      headers: { "retry-after": "2" },
    });
    expect(await tools).toEqual({ status: 503, body: { error: "run_resuming" }, headers: { "retry-after": "2" } });
  });

  it("the bound elapsing before the reclaim settles answers retryable too (reclaim_pending): the ledger has not spoken, so no bearer is unknown for good", async () => {
    const takeover = fakeTakeover({ settled: false });
    const { deps } = world(takeover.facts);
    const tool = ask(deps, HARNESS_TOOL_PATH, strangers);
    const authorize = ask(deps, HARNESS_AUTHORIZE_PATH, strangers);
    expect(await answeredYet(Promise.all([tool, authorize]))).toBe(false);
    takeover.elapse();
    expect(await tool).toEqual({ status: 202, body: { pending: true, reason: "reclaim_pending" } });
    expect(await authorize).toEqual({
      status: 503,
      body: { error: "reclaim_pending" },
      headers: { "retry-after": "2" },
    });
  });

  it("a surviving pi's bearer is retryable through the whole resume — unknown run before this generation's mint, unknown bearer between the mint and the adoption — and the same ask succeeds once the run registers and adopts it; after the resume ends the store's verdict is final again", async () => {
    const takeover = fakeTakeover({ settled: true, pending: ["run-5"] });
    const { deps, bearers, harnesses, harness, grant } = world(takeover.facts);
    // The bearer the previous generation revealed to its pi, and the hash its row carries.
    const previous = new RunBearerStore({ clock: () => clock.now });
    const old = previous.mint(grant("run-5"));
    const survivor = { authorization: `Bearer ${old}` };
    expect(await ask(deps, HARNESS_TOOL_PATH, survivor)).toEqual({
      status: 202,
      body: { pending: true, reason: "run_resuming" },
    });
    expect(takeover.holds).toEqual([]); // settled: nothing to wait for
    bearers.mint(grant("run-5")); // the resume's own mint: the old secret is a wrong one for a known run…
    expect(await ask(deps, HARNESS_AUTHORIZE_PATH, survivor)).toMatchObject({
      status: 503,
      body: { error: "run_resuming" },
    });
    harnesses.register({ ...harness, runId: "run-5" }); // …registered, still not adopted…
    expect(await ask(deps, HARNESS_TOOL_PATH, survivor)).toMatchObject({ status: 202 });
    expect(bearers.adopt("run-5", bearerHashOf(old)!)).toBe(true); // …adopted: the door opens on the same bearer
    expect(await ask(deps, HARNESS_TOOL_PATH, survivor)).toEqual({
      status: 200,
      body: { content: [{ type: "text", text: "status updated: undefined" }], isError: false },
    });
    takeover.done("run-5");
    expect(await ask(deps, HARNESS_TOOL_PATH, { authorization: "Bearer sbr_run-5.wrong" })).toEqual({
      status: 401,
      body: { error: "unknown_bearer" },
    });
    expect(await ask(deps, HARNESS_TOOL_PATH, strangers)).toEqual({ status: 404, body: { error: "unknown_run" } });
  });

  it("a malformed, revoked or expired bearer, or a missing one, is final whatever the takeover says: nothing later adopts it", async () => {
    const takeover = fakeTakeover({ settled: false });
    const { deps, bearer, bearers } = world(takeover.facts);
    expect(await ask(deps, HARNESS_TOOL_PATH, {})).toEqual({ status: 401, body: { error: "missing_bearer" } });
    expect(await ask(deps, HARNESS_TOOL_PATH, { authorization: "Bearer nope" })).toEqual({
      status: 401,
      body: { error: "malformed" },
    });
    bearers.revoke("run-7");
    expect(await ask(deps, HARNESS_TOOL_PATH, { authorization: `Bearer ${bearer}` })).toEqual({
      status: 403,
      body: { error: "revoked" },
    });
    expect(takeover.holds).toEqual([]);
  });
});

describe("createHarnessRoutesHandler — the node adapter", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function serve(deps: Parameters<typeof createHarnessRoutesHandler>[0]) {
    const handler = createHarnessRoutesHandler({ ...deps, log: () => {} });
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("refuses from the headers, reads a capped JSON body, and answers one JSON document", async () => {
    const { deps, headers } = world();
    const base = await serve(deps);
    const refused = await fetch(`${base}${HARNESS_TOOLS_PATH}`);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "missing_bearer" });
    const tools = await fetch(`${base}${HARNESS_TOOLS_PATH}`, { headers: headers() });
    expect(tools.status).toBe(200);
    expect(((await tools.json()) as { tools: unknown[] }).tools).toHaveLength(1);
    const bad = await fetch(`${base}${HARNESS_AUTHORIZE_PATH}`, {
      method: "POST",
      headers: headers(),
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}${HARNESS_TOOL_PATH}`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ toolCallId: "c", tool: "update_status", input: { checklist: "hi" } }),
    });
    expect(await ok.json()).toEqual({ content: [{ type: "text", text: "status updated: hi" }], isError: false });
  });

  it("a call that outlives the window is answered 202 pending over HTTP, and the retry with the same id reads the result: a response is held for the window, never for the tool", async () => {
    const { deps, headers, harness } = world();
    const slow = slowTool();
    harness.tools.push(slow.tool);
    const base = await serve({ ...deps, relayWindowMs: 20 });
    const post = () =>
      fetch(`${base}${HARNESS_TOOL_PATH}`, {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({ toolCallId: "c-slow", tool: "slow", input: {} }),
      });
    const pending = await post();
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ pending: true, toolCallId: "c-slow" });
    const again = post();
    slow.release("finally");
    const answered = await again;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ content: [{ type: "text", text: "finally" }], isError: false });
    expect(slow.runs()).toBe(1);
  });

  it("over HTTP a run still resuming is answered 503 with a Retry-After header, 202 pending on /harness/tool, and the log names the hold; the body is never read for it", async () => {
    const takeover = fakeTakeover({ settled: true, pending: ["run-9"] });
    const { deps } = world(takeover.facts);
    const lines: string[] = [];
    const handler = createHarnessRoutesHandler({ ...deps, log: (l) => lines.push(l) });
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const survivor = { authorization: "Bearer sbr_run-9.abc" };
    const tools = await fetch(`${base}${HARNESS_TOOLS_PATH}`, { headers: survivor });
    expect(tools.status).toBe(503);
    expect(tools.headers.get("retry-after")).toBe("2");
    expect(await tools.json()).toEqual({ error: "run_resuming" });
    const tool = await fetch(`${base}${HARNESS_TOOL_PATH}`, {
      method: "POST",
      headers: { ...survivor, "content-type": "application/json" },
      body: "{not json — never parsed",
    });
    expect(tool.status).toBe(202);
    expect(await tool.json()).toEqual({ pending: true, reason: "run_resuming" });
    expect(lines).toEqual([
      "[harness] 503 tools — held (run_resuming) run=run-9",
      "[harness] 202 tool — held (run_resuming) run=run-9",
    ]);
  });
});
