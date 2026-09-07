import { describe, expect, it, vi } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import { createMcpHandler, handleMcpRequest, McpIO, toCaller } from "./mcp.js";
import { ALL_GRANTS } from "../core/authz/grants.js";
import type { DispatchFn, IngressConfig, IngressIdentity } from "./http.js";
import type { CoreDeps } from "../core/dispatcher.js";
import type { ChannelIO, IncomingMessage } from "../core/types.js";
import { CommandRegistry, bindCommands } from "../core/commandRegistry.js";
import { registerRunsCommands, type RunsCommandDeps } from "../core/commands/runs.js";
import type { RunEvent } from "../core/runEvents.js";
import { analyzeRunFriction } from "../core/runFriction.js";
import type { RunRecord } from "../core/runRecord.js";
import { RunRegistry } from "../core/runRegistry.js";
import { InMemoryRunStore } from "../core/runStore.js";
import { createRunsService } from "../core/runsService.js";

// Feature: features/mcp-ingress.md — adapter #4 (MCP). A minimal MCP server over
// streamable-HTTP (JSON-RPC 2.0 over POST /mcp). It reuses http.ts's fail-closed,
// constant-time bearer auth; a token maps to a `mcp:`-namespaced identity that
// flows into the same dispatch() the Slack/CLI/HTTP adapters use. A fake dispatch
// keeps these off real providers.

const deps = {} as CoreDeps;

/** A dispatch double that records the message and echoes a canned reply. */
function fakeDispatch(reply = "the answer") {
  const calls: { msg: IncomingMessage; io: ChannelIO }[] = [];
  const fn: DispatchFn = async (_deps, msg, io) => {
    calls.push({ msg, io });
    await io.reply(reply);
  };
  return { fn, calls };
}

/** Fixture identities carry the parser's default scopes (`["dispatch"]`). */
const authConfig = (tokens: Record<string, Omit<IngressIdentity, "scopes">>): IngressConfig => ({
  tokens: Object.fromEntries(Object.entries(tokens).map(([t, id]) => [t, { ...id, scopes: ["dispatch"] }])),
});
const bearer = (token: string): IncomingHttpHeaders => ({ authorization: `Bearer ${token}` });
const good = authConfig({ tok: { subject: "alice" } });

/** Build a POST /mcp request carrying a JSON-RPC message body. */
function rpc(
  method: string,
  params: unknown,
  id: string | number | null = 1,
  headers: IncomingHttpHeaders = bearer("tok"),
) {
  const message: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (id !== undefined) message.id = id;
  if (params !== undefined) message.params = params;
  return { method: "POST", headers, body: JSON.stringify(message) };
}

// The body of a successful JSON-RPC response.
type RpcResult = { jsonrpc: "2.0"; id: unknown; result: Record<string, unknown> };
type RpcError = { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };

describe("handleMcpRequest — initialize", () => {
  it("returns the protocol version, tools capability, and server info", async () => {
    const res = await handleMcpRequest(rpc("initialize", { protocolVersion: "2025-06-18" }), deps, { auth: good });
    expect(res.status).toBe(200);
    const body = res.body as RpcResult;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(typeof body.result.protocolVersion).toBe("string");
    expect(body.result.capabilities).toMatchObject({ tools: {} });
    expect((body.result.serverInfo as { name: string }).name).toBeTruthy();
  });
});

describe("handleMcpRequest — tools/list", () => {
  it("advertises exactly one tool with a text/thread/channel input schema", async () => {
    const res = await handleMcpRequest(rpc("tools/list", {}), deps, { auth: good });
    expect(res.status).toBe(200);
    const tools = (res.body as RpcResult).result.tools as Array<{
      name: string;
      description: string;
      inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("dispatch");
    expect(tools[0].description).toBeTruthy();
    expect(tools[0].inputSchema.type).toBe("object");
    expect(Object.keys(tools[0].inputSchema.properties).sort()).toEqual(["channel", "text", "thread"]);
    expect(tools[0].inputSchema.required).toEqual(["text"]);
  });
});

describe("handleMcpRequest — tools/call", () => {
  it("builds the mcp:-namespaced IncomingMessage and returns the reply as tool content", async () => {
    const d = fakeDispatch("hello from agent");
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "dispatch", arguments: { text: "hi", channel: "ops", thread: "t1" } }, 7),
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect(res.status).toBe(200);
    const body = res.body as RpcResult;
    expect(body.id).toBe(7);
    expect(body.result).toEqual({ content: [{ type: "text", text: "hello from agent" }] });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].msg).toEqual({
      userId: "mcp:alice",
      channelId: "mcp:ops",
      threadKey: "mcp:ops:t1",
      text: "hi",
    });
  });

  it("defaults channel/thread when the arguments omit them", async () => {
    const d = fakeDispatch();
    await handleMcpRequest(rpc("tools/call", { name: "dispatch", arguments: { text: "hi" } }), deps, {
      auth: good,
      dispatch: d.fn,
    });
    expect(d.calls[0].msg.channelId).toBe("mcp:default");
    expect(d.calls[0].msg.threadKey).toBe("mcp:default:default");
  });

  it("a token-pinned channel overrides the arguments' channel", async () => {
    const d = fakeDispatch();
    const pinned = authConfig({ tok: { subject: "alice", channel: "locked" } });
    await handleMcpRequest(
      rpc("tools/call", { name: "dispatch", arguments: { text: "hi", channel: "attacker" } }),
      deps,
      { auth: pinned, dispatch: d.fn },
    );
    expect(d.calls[0].msg.channelId).toBe("mcp:locked");
    expect(d.calls[0].msg.threadKey).toBe("mcp:locked:default");
  });

  it("history is empty for a single-shot MCP tool call", async () => {
    const d = fakeDispatch();
    await handleMcpRequest(rpc("tools/call", { name: "dispatch", arguments: { text: "hi" } }), deps, {
      auth: good,
      dispatch: d.fn,
    });
    expect(await d.calls[0].io.history()).toEqual([]);
  });

  it("rejects an unknown tool name with -32602, dispatch never called", async () => {
    const d = fakeDispatch();
    const res = await handleMcpRequest(rpc("tools/call", { name: "nope", arguments: { text: "hi" } }), deps, {
      auth: good,
      dispatch: d.fn,
    });
    expect(res.status).toBe(200);
    expect((res.body as RpcError).error.code).toBe(-32602);
    expect(d.calls).toHaveLength(0);
  });

  it("rejects missing/blank/non-string text with -32602, dispatch never called", async () => {
    const d = fakeDispatch();
    for (const args of [{}, { text: "  " }, { text: 5 }, { name: "dispatch" }]) {
      const res = await handleMcpRequest(rpc("tools/call", { name: "dispatch", arguments: args }), deps, {
        auth: good,
        dispatch: d.fn,
      });
      expect((res.body as RpcError).error.code).toBe(-32602);
    }
    expect(d.calls).toHaveLength(0);
  });
});

describe("handleMcpRequest — auth (fail-closed)", () => {
  it("no tokens configured → 503 disabled, dispatch never called", async () => {
    const d = fakeDispatch();
    const res = await handleMcpRequest(rpc("tools/list", {}), deps, { auth: authConfig({}), dispatch: d.fn });
    expect(res.status).toBe(503);
    expect((res.body as RpcError).error).toBeTruthy();
    expect(d.calls).toHaveLength(0);
  });

  it("missing token → 401, dispatch never called", async () => {
    const d = fakeDispatch();
    const res = await handleMcpRequest(rpc("tools/list", {}, 1, {}), deps, { auth: good, dispatch: d.fn });
    expect(res.status).toBe(401);
    expect((res.body as RpcError).error).toBeTruthy();
    expect(d.calls).toHaveLength(0);
  });

  it("unknown token → 401, dispatch never called", async () => {
    const d = fakeDispatch();
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "dispatch", arguments: { text: "hi" } }, 1, bearer("bad")),
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect(res.status).toBe(401);
    expect(d.calls).toHaveLength(0);
  });
});

describe("handleMcpRequest — JSON-RPC framing errors", () => {
  it("unknown method → -32601", async () => {
    const res = await handleMcpRequest(rpc("resources/list", {}), deps, { auth: good });
    expect(res.status).toBe(200);
    expect((res.body as RpcError).error.code).toBe(-32601);
  });

  it("malformed JSON → -32700 with a null id", async () => {
    const res = await handleMcpRequest({ method: "POST", headers: bearer("tok"), body: "{not json" }, deps, {
      auth: good,
    });
    const body = res.body as RpcError;
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  it("a non-object / array / method-less message → -32600", async () => {
    for (const raw of ["[]", "42", JSON.stringify({ jsonrpc: "2.0", id: 1 })]) {
      const res = await handleMcpRequest({ method: "POST", headers: bearer("tok"), body: raw }, deps, { auth: good });
      expect((res.body as RpcError).error.code).toBe(-32600);
    }
  });

  it('a missing or non-"2.0" jsonrpc field → -32600', async () => {
    for (const raw of [
      JSON.stringify({ method: "tools/list", id: 1 }), // jsonrpc missing
      JSON.stringify({ jsonrpc: "1.0", method: "tools/list", id: 1 }), // wrong version
    ]) {
      const res = await handleMcpRequest({ method: "POST", headers: bearer("tok"), body: raw }, deps, { auth: good });
      expect((res.body as RpcError).error.code).toBe(-32600);
    }
  });

  it("a malformed id (object/boolean) → -32600, not silently coerced to null", async () => {
    for (const badId of [{}, true]) {
      const res = await handleMcpRequest(
        {
          method: "POST",
          headers: bearer("tok"),
          body: JSON.stringify({ jsonrpc: "2.0", id: badId, method: "tools/list" }),
        },
        deps,
        { auth: good },
      );
      expect((res.body as RpcError).error.code).toBe(-32600);
    }
  });

  it("non-POST → 405, dispatch never called", async () => {
    const d = fakeDispatch();
    const res = await handleMcpRequest({ method: "GET", headers: bearer("tok"), body: "" }, deps, {
      auth: good,
      dispatch: d.fn,
    });
    expect(res.status).toBe(405);
    expect(d.calls).toHaveLength(0);
  });

  it("a notification (no id) is accepted with 202 and no response body, dispatch never called", async () => {
    const d = fakeDispatch();
    const res = await handleMcpRequest(
      {
        method: "POST",
        headers: bearer("tok"),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      },
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect(res.status).toBe(202);
    expect(res.body).toBeUndefined();
    expect(d.calls).toHaveLength(0);
  });
});

describe("McpIO (single-shot ChannelIO)", () => {
  it("collects replies and joins them; status is a no-op; history is empty", async () => {
    const io = new McpIO();
    await io.reply("one");
    await io.reply("two");
    expect(io.collected()).toBe("one\n\ntwo");
    expect(await io.history()).toEqual([]);
    const handle = await io.status({ title: "working" });
    expect(() => handle.update({ title: "still working" })).not.toThrow();
    await expect(handle.done({ title: "done" })).resolves.toBeUndefined();
  });
});

describe("createMcpHandler (node:http wrapper)", () => {
  function fakeReqRes(method: string, headers: IncomingHttpHeaders, body: string) {
    async function* iter() {
      yield Buffer.from(body, "utf8");
    }
    const req = Object.assign(iter(), { method, headers, destroy: vi.fn() });
    let statusCode = 0;
    let payload = "";
    const res = {
      writeHead: (code: number) => {
        statusCode = code;
      },
      end: (chunk?: string) => {
        payload = chunk ?? "";
      },
    };
    return {
      req: req as unknown as Parameters<ReturnType<typeof createMcpHandler>>[0],
      res: res as unknown as Parameters<ReturnType<typeof createMcpHandler>>[1],
      status: () => statusCode,
      raw: () => payload,
      json: () => JSON.parse(payload),
      reqRaw: req,
    };
  }

  it("reads the body, routes tools/call, and writes a 200 JSON-RPC reply", async () => {
    const d = fakeDispatch("wrapped");
    const handler = createMcpHandler(deps, { auth: good, dispatch: d.fn });
    const t = fakeReqRes(
      "POST",
      bearer("tok"),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "dispatch", arguments: { text: "hi" } },
      }),
    );
    handler(t.req, t.res);
    await vi.waitFor(() => expect(t.status()).toBe(200));
    expect(t.json().result).toEqual({ content: [{ type: "text", text: "wrapped" }] });
    expect(d.calls[0].msg.userId).toBe("mcp:alice");
  });

  // Unified with #56: an unauthorized caller is rejected from headers without
  // the body ever being read/buffered.
  it("rejects an unauthorized request without reading the body (pre-auth)", async () => {
    const d = fakeDispatch();
    let bodyRead = false;
    async function* iter() {
      bodyRead = true;
      yield Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), "utf8");
    }
    const destroy = vi.fn();
    const req = Object.assign(iter(), { method: "POST", headers: bearer("wrong"), destroy });
    let statusCode = 0;
    const res = {
      writeHead: (c: number) => {
        statusCode = c;
      },
      end: () => {},
    };
    const handler = createMcpHandler(deps, { auth: good, dispatch: d.fn });
    handler(
      req as unknown as Parameters<ReturnType<typeof createMcpHandler>>[0],
      res as unknown as Parameters<ReturnType<typeof createMcpHandler>>[1],
    );
    await vi.waitFor(() => expect(statusCode).toBe(401));
    expect(bodyRead).toBe(false); // body iterator never consumed
    expect(d.calls).toHaveLength(0);
    expect(destroy).toHaveBeenCalled();
  });

  it("writes an empty 202 body for a notification", async () => {
    const handler = createMcpHandler(deps, { auth: good });
    const t = fakeReqRes(
      "POST",
      bearer("tok"),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    handler(t.req, t.res);
    await vi.waitFor(() => expect(t.status()).toBe(202));
    expect(t.raw()).toBe("");
  });

  it("answers 413 and destroys the request when the body exceeds the cap", async () => {
    const d = fakeDispatch();
    const handler = createMcpHandler(deps, { auth: good, dispatch: d.fn, maxBodyBytes: 5 });
    const t = fakeReqRes("POST", bearer("tok"), JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    handler(t.req, t.res);
    await vi.waitFor(() => expect(t.status()).toBe(413));
    expect(d.calls).toHaveLength(0);
    expect((t.reqRaw as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalled();
  });
});

// --- Registry commands as MCP tools (#157 U7: R7/R9, KTD2/KTD11/KTD17) -------

const NOW = 1_700_000_000_000;

/** One live run (with a `tok-` capability token) and two persisted runs behind
 *  the `runs.*` registrations, bound for the adapter. The Slack runs are stamped
 *  `public` so a token with no channel grant still sees them (member-of's
 *  public half); `fin-2` lives in the machine channel `mcp:dev`. */
async function commandFixture() {
  let n = 0;
  const reg = new RunRegistry({ genId: () => `live-${++n}`, genToken: () => `tok-${n}`, now: () => NOW });
  const live = reg.create("coding · acme/live", {
    agent: "coding",
    channelId: "slack:C1",
    userId: "slack:U1",
    threadKey: "slack:C1:t",
    channelVisibility: "public",
  });
  reg.publish(live.id, { type: "input", text: "live request" });
  const store = new InMemoryRunStore({ now: () => NOW });
  const events: RunEvent[] = [
    { type: "input", text: "please do the thing", seq: 1 },
    { type: "answer", text: "all done", seq: 2 },
  ];
  const persisted = (
    id: string,
    channelId: string,
    channelVisibility: RunRecord["channelVisibility"],
    finishedAt: number,
  ): RunRecord => ({
    id,
    label: `coding · acme/${id}`,
    agent: "coding",
    model: "anthropic/claude",
    channelId,
    userId: "slack:U1",
    threadKey: `${channelId}:${id}`,
    channelVisibility,
    startedAt: finishedAt - 10_000,
    finishedAt,
    status: "completed",
    eventCount: 2,
    storedEventCount: 2,
    truncated: false,
    events,
    diagnosis: analyzeRunFriction(events),
  });
  await store.put(persisted("fin-1", "slack:C1", "public", NOW - 1000));
  await store.put(persisted("fin-2", "mcp:dev", "machine", NOW - 2000));
  const registry = new CommandRegistry<RunsCommandDeps>({ audit: () => {} });
  registerRunsCommands(registry);
  const commands = bindCommands(registry, { runs: async () => createRunsService({ registry: reg, store }) });
  return { reg, live, commands };
}

const scoped = (scopes: string[], channel?: string): IngressConfig => ({
  tokens: { tok: { subject: "alice", scopes, ...(channel ? { channel } : {}) } },
});

/** The tool result text is `<one-line header>\n<JSON>`; return the parsed JSON. */
function toolJson(res: { body?: unknown }): unknown {
  const text = ((res.body as RpcResult).result.content as { text: string }[])[0].text;
  const nl = text.indexOf("\n");
  expect(nl).toBeGreaterThan(0);
  return JSON.parse(text.slice(nl + 1));
}

describe("toCaller — the Caller a tool call runs as carries the mcp: Actor (plan U2)", () => {
  it("a pinned token → service mcp:<subject>, grants = the token's scopes over mcp:<channel> (from the token map when no lookup is wired); neither `scopes` nor a `channel` pin on the caller — the actor's grants ARE the pin", () => {
    const auth = scoped(["runs:read"], "ops");
    const c = toCaller(auth.tokens.tok, { auth });
    expect(c).toEqual({ kind: "mcp", id: "mcp:alice", actor: c.actor });
    expect(c).not.toHaveProperty("channel");
    expect(c).not.toHaveProperty("scopes");
    expect(c.actor).toEqual({
      kind: "service",
      id: "mcp:alice",
      grants: { actions: new Set(["runs:read"]), channels: new Set(["mcp:ops"]), repos: new Set() },
    });
  });

  it("an unpinned token's actor holds NO channel (OQ4, option a — fail-closed); a wired `grantsFor` (ConfigStore) is consulted by the mcp: id", () => {
    const auth = scoped(["dispatch"]);
    expect(toCaller(auth.tokens.tok, { auth }).actor).toEqual({
      kind: "service",
      id: "mcp:alice",
      grants: { actions: new Set(["dispatch"]), channels: new Set(), repos: new Set() },
    });
    const asked: string[] = [];
    const c = toCaller(auth.tokens.tok, { auth, grantsFor: (id) => (asked.push(id), ALL_GRANTS) });
    expect(asked).toEqual(["mcp:alice"]);
    expect(c.actor?.grants).toBe(ALL_GRANTS);
  });
});

describe("handleMcpRequest — registry commands as tools", () => {
  it("tools/list = dispatch + every registered command with a derived inputSchema (runs_list has the status enum)", async () => {
    const { commands } = await commandFixture();
    const res = await handleMcpRequest(rpc("tools/list", {}), deps, { auth: good, commands });
    const tools = (res.body as RpcResult).result.tools as Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
    expect(tools[0].name).toBe("dispatch");
    expect(tools.map((t) => t.name)).toEqual([
      "dispatch",
      "runs_list",
      "runs_get",
      "runs_events",
      "runs_friction",
      "runs_stop",
    ]);
    const list = tools.find((t) => t.name === "runs_list")!;
    expect(list.description).toBeTruthy();
    expect((list.inputSchema.properties as Record<string, { enum?: string[] }>).status.enum).toEqual([
      "active",
      "finished",
      "all",
    ]);
    expect(list.inputSchema.type).toBe("object");
  });

  it("a command that opted out of MCP is not listed", async () => {
    const registry = new CommandRegistry<unknown>({ audit: () => {} });
    registry.register({
      id: "hidden.cmd",
      action: "hidden:read",
      effect: "read",
      surfaces: { mcp: false },
      describe: "not for MCP",
      handler: async () => ({}),
    });
    const res = await handleMcpRequest(rpc("tools/list", {}), deps, {
      auth: good,
      commands: bindCommands(registry, undefined),
    });
    expect(((res.body as RpcResult).result.tools as { name: string }[]).map((t) => t.name)).toEqual(["dispatch"]);
  });

  it("tools/call runs_list returns a header line plus the invoke JSON, with no token", async () => {
    const { commands } = await commandFixture();
    const res = await handleMcpRequest(rpc("tools/call", { name: "runs_list", arguments: { status: "all" } }), deps, {
      auth: scoped(["runs:read"]),
      commands,
    });
    expect(res.status).toBe(200);
    const body = toolJson(res) as { runs: { id: string }[] };
    expect(body.runs.map((r) => r.id).sort()).toEqual(["fin-1", "live-1"]);
    expect(JSON.stringify(res.body)).not.toContain("tok-");
    const direct = await commands.invoke(
      "runs.list",
      { options: { status: "all" } },
      toCaller(scoped(["runs:read"]).tokens.tok, { auth: scoped(["runs:read"]) }),
    );
    expect(body).toEqual(direct.ok ? direct.value : null);
  });

  it("runs_get on an unknown run → JSON-RPC error with data.code 'not_found'", async () => {
    const { commands } = await commandFixture();
    const res = await handleMcpRequest(rpc("tools/call", { name: "runs_get", arguments: { id: "nope" } }), deps, {
      auth: scoped(["runs:read"]),
      commands,
    });
    expect(res.status).toBe(200);
    const body = res.body as RpcError & { error: { data?: { code: string } } };
    expect(body.error.data?.code).toBe("not_found");
    expect(body.error.message).toBeTruthy();
  });

  it("bad input → JSON-RPC -32602 with data.code 'invalid_input', never echoing the value", async () => {
    const { commands } = await commandFixture();
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "runs_list", arguments: { status: "s3cret" } }),
      deps,
      { auth: scoped(["runs:read"]), commands },
    );
    const body = res.body as RpcError & { error: { data?: { code: string } } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.data?.code).toBe("invalid_input");
    expect(JSON.stringify(body)).not.toContain("s3cret");
  });

  it("a dispatch-only token is refused on runs_list and runs_stop with data.code 'unauthorized' (AE5)", async () => {
    const { commands, live, reg } = await commandFixture();
    for (const [name, args] of [
      ["runs_list", { status: "all" }],
      ["runs_stop", { id: live.id, mode: "soft" }],
    ] as const) {
      const res = await handleMcpRequest(rpc("tools/call", { name, arguments: args }), deps, { auth: good, commands });
      const body = res.body as RpcError & { error: { data?: { code: string } } };
      expect(body.error.data?.code, name).toBe("unauthorized");
    }
    expect(reg.getById(live.id)?.stop).toBeUndefined();
  });

  it("a runs:write token stops a live run as actor mcp:<subject>; a finished run → data.code 'conflict'", async () => {
    const { commands, live, reg } = await commandFixture();
    const auth = scoped(["runs:write"]);
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "runs_stop", arguments: { id: live.id, mode: "soft" } }),
      deps,
      { auth, commands },
    );
    expect((res.body as RpcResult).result).toBeTruthy();
    const note = reg
      .snapshotById(live.id)!
      .events.find((e) => e.type === "run_note" && e.kind === "stop_requested") as { actor?: unknown };
    expect(note.actor).toEqual({ kind: "mcp", id: "mcp:alice" });
    const fin = await handleMcpRequest(
      rpc("tools/call", { name: "runs_stop", arguments: { id: "fin-1", mode: "soft" } }),
      deps,
      { auth, commands },
    );
    expect((fin.body as RpcError & { error: { data?: { code: string } } }).error.data?.code).toBe("conflict");
  });

  it("a token's `channel` is its one channel grant (`mcp:<channel>`): it lists that channel's runs plus the public ones, never another machine channel's; a token with no `channel` lists the public runs only", async () => {
    const { commands, live } = await commandFixture();
    const list = async (auth: IngressConfig) =>
      (
        toolJson(
          await handleMcpRequest(rpc("tools/call", { name: "runs_list", arguments: { status: "all" } }), deps, {
            auth,
            commands,
          }),
        ) as { runs: { id: string }[] }
      ).runs.map((r) => r.id);
    expect(await list(scoped(["runs:read"], "ops"))).toEqual([live.id, "fin-1"]);
    expect(await list(scoped(["runs:read"], "dev"))).toEqual([live.id, "fin-1", "fin-2"]);
    expect(await list(scoped(["runs:read"]))).toEqual([live.id, "fin-1"]);
    const get = await handleMcpRequest(rpc("tools/call", { name: "runs_get", arguments: { id: "fin-2" } }), deps, {
      auth: scoped(["runs:read"], "ops"),
      commands,
    });
    expect((get.body as RpcError & { error: { data?: { code: string } } }).error.data?.code).toBe("not_found");
  });

  it("a token without the dispatch scope (runs:read only) cannot call `dispatch`: -32001 data.code 'unauthorized', dispatch never called", async () => {
    const { commands } = await commandFixture();
    const d = fakeDispatch("hi");
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "dispatch", arguments: { text: "start a run" } }),
      deps,
      { auth: scoped(["runs:read"]), commands, dispatch: d.fn },
    );
    const body = res.body as RpcError & { error: { data?: { code: string } } };
    expect(body.error.code).toBe(-32001);
    expect(body.error.data?.code).toBe("unauthorized");
    expect(d.calls).toHaveLength(0);
    // the same token still reads through the registry tool it IS scoped for
    const list = await handleMcpRequest(rpc("tools/call", { name: "runs_list", arguments: { status: "all" } }), deps, {
      auth: scoped(["runs:read"]),
      commands,
    });
    expect((list.body as RpcResult).result).toBeTruthy();
  });

  it("dispatch is unchanged alongside the registry tools; an unknown tool is still -32602", async () => {
    const { commands } = await commandFixture();
    const d = fakeDispatch("hi");
    const res = await handleMcpRequest(rpc("tools/call", { name: "dispatch", arguments: { text: "hello" } }), deps, {
      auth: good,
      commands,
      dispatch: d.fn,
    });
    expect((res.body as RpcResult).result).toEqual({ content: [{ type: "text", text: "hi" }] });
    expect(d.calls).toHaveLength(1);
    const unknown = await handleMcpRequest(rpc("tools/call", { name: "runs_frobnicate", arguments: {} }), deps, {
      auth: good,
      commands,
    });
    expect((unknown.body as RpcError).error.code).toBe(-32602);
  });
});
