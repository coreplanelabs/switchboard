import { describe, expect, it, vi } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import { createMcpHandler, handleMcpRequest, McpIO } from "./mcp.js";
import type { DispatchFn, IngressConfig } from "./http.js";
import type { CoreDeps } from "../core/dispatcher.js";
import type { ChannelIO, IncomingMessage } from "../core/types.js";

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

const authConfig = (tokens: IngressConfig["tokens"]): IngressConfig => ({ tokens });
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
    const res = await handleMcpRequest(
      rpc("tools/call", { name: "nope", arguments: { text: "hi" } }),
      deps,
      { auth: good, dispatch: d.fn },
    );
    expect(res.status).toBe(200);
    expect((res.body as RpcError).error.code).toBe(-32602);
    expect(d.calls).toHaveLength(0);
  });

  it("rejects missing/blank/non-string text with -32602, dispatch never called", async () => {
    const d = fakeDispatch();
    for (const args of [{}, { text: "  " }, { text: 5 }, { name: "dispatch" }]) {
      const res = await handleMcpRequest(
        rpc("tools/call", { name: "dispatch", arguments: args }),
        deps,
        { auth: good, dispatch: d.fn },
      );
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
      { method: "POST", headers: bearer("tok"), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) },
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
    const t = fakeReqRes("POST", bearer("tok"), JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "dispatch", arguments: { text: "hi" } },
    }));
    handler(t.req, t.res);
    await vi.waitFor(() => expect(t.status()).toBe(200));
    expect(t.json().result).toEqual({ content: [{ type: "text", text: "wrapped" }] });
    expect(d.calls[0].msg.userId).toBe("mcp:alice");
  });

  it("writes an empty 202 body for a notification", async () => {
    const handler = createMcpHandler(deps, { auth: good });
    const t = fakeReqRes("POST", bearer("tok"), JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
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
