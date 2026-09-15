import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessRegistry, type LiveHarness } from "../core/harness/pi/relay.js";
import { RunBearerStore } from "../core/modelProxy/runBearers.js";
import type { RunEvent } from "../core/runEvents.js";
import { createTracer } from "../core/trace/tracer.js";
import type { RunnableTool } from "../tools/workspace.js";
import {
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
// definitions, the gate's verdict, or a relayed tool's result.

const clock = { now: 1_700_000_000_000 };
const root = createTracer({ clock: () => clock.now }).start("request", { sinks: [] });

function world() {
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
  const deps = { bearers, harnesses };
  const headers = (b = bearer) => ({ authorization: `Bearer ${b}` });
  return { deps, bearer, other, headers, events, bearers, harness };
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
});
