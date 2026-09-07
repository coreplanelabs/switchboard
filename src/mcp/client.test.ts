import { describe, expect, it } from "vitest";
import { MCP_PROTOCOL_VERSION, sseDataFrames, StreamableHttpMcpClient } from "./client.js";
import { fakeMcpServerFetch } from "./fake.js";
import { McpError } from "./types.js";

const TOOLS = [
  {
    name: "search_issues",
    description: "Search issues",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  },
  {
    name: "create_issue",
    description: "Create",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: false },
  },
];

function client(
  server: ReturnType<typeof fakeMcpServerFetch>,
  extra: Partial<ConstructorParameters<typeof StreamableHttpMcpClient>[0]> = {},
) {
  return new StreamableHttpMcpClient({ url: "https://mcp.example.com/mcp", fetch: server.fetch, ...extra });
}

describe("StreamableHttpMcpClient", () => {
  it("initializes once, keeps the session id, and sends it on later requests", async () => {
    const server = fakeMcpServerFetch({ tools: TOOLS, sessionId: "sess-1" });
    const c = client(server);
    await c.listTools();
    await c.callTool("search_issues", { q: "x" });
    const methods = server.requests.map((r) => r.body.method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    // initialize carries the protocol version and no session; later calls carry the session
    expect(server.requests[0].body.params).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION });
    expect(server.requests[0].headers["mcp-session-id"]).toBeUndefined();
    expect(server.requests[2].headers["mcp-session-id"]).toBe("sess-1");
    expect(server.requests[3].headers["mcp-session-id"]).toBe("sess-1");
    expect(server.requests[2].headers["mcp-protocol-version"]).toBe(MCP_PROTOCOL_VERSION);
    expect(server.requests[2].headers.accept).toContain("text/event-stream");
  });

  it("reads a JSON response", async () => {
    const server = fakeMcpServerFetch({ tools: TOOLS });
    const tools = await client(server).listTools();
    expect(tools.map((t) => t.name)).toEqual(["search_issues", "create_issue"]);
    expect(tools[1].annotations).toEqual({ readOnlyHint: false });
  });

  it("reads an SSE response and picks the frame with the request id", async () => {
    const server = fakeMcpServerFetch({
      tools: TOOLS,
      sse: true,
      onCall: () => ({ content: [{ type: "text", text: "from sse" }] }),
    });
    const c = client(server);
    expect((await c.listTools()).length).toBe(2);
    const res = await c.callTool("search_issues", {});
    expect(res.content).toEqual([{ type: "text", text: "from sse" }]);
  });

  it("sends the bearer token only when configured", async () => {
    const withAuth = fakeMcpServerFetch({ tools: TOOLS });
    await client(withAuth, { headers: { authorization: "Bearer secret-token" } }).listTools();
    expect(withAuth.requests.every((r) => r.headers.authorization === "Bearer secret-token")).toBe(true);
    const without = fakeMcpServerFetch({ tools: TOOLS });
    await client(without).listTools();
    expect(without.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
  });

  it("maps a JSON-RPC error", async () => {
    const server = fakeMcpServerFetch({ tools: TOOLS, rpcError: { code: -32602, message: "bad args" } });
    const err = await client(server)
      .callTool("search_issues", {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(-32602);
    expect((err as McpError).message).toContain("bad args");
  });

  it("reports a non-2xx status", async () => {
    const server = fakeMcpServerFetch({ status: 503 });
    const err = await client(server)
      .listTools()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).message).toContain("HTTP 503");
  });

  it("times out", async () => {
    const server = fakeMcpServerFetch({ tools: TOOLS, delayMs: 200 });
    const err = await client(server, { timeoutMs: 20 })
      .listTools()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe("timeout");
  });

  it("a timeout while the body is still streaming is the same timeout error, not a raw AbortError", async () => {
    // An SSE stream the server holds open after answering: the headers arrive,
    // the body never ends, the request timeout fires mid-read.
    const server = fakeMcpServerFetch({ tools: TOOLS, hangBody: true });
    const err = await client(server, { timeoutMs: 20 })
      .listTools()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe("timeout");
    expect((err as McpError).message).toContain("20 ms");
  });

  it("refuses an over-cap response body", async () => {
    const big = { name: "t", description: "x".repeat(5000), inputSchema: { type: "object" } };
    const server = fakeMcpServerFetch({ tools: [big] });
    const err = await client(server, { maxResponseBytes: 1024 })
      .listTools()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe("too_large");
  });

  it("a non-JSON-RPC body is a protocol error, not a crash", async () => {
    const server = fakeMcpServerFetch({ tools: TOOLS, rawFirstBody: "<html>login</html>" });
    const err = await client(server)
      .listTools()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe("protocol");
  });

  it("pages tools/list and stops at the cap", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: "object" } }));
    const server = fakeMcpServerFetch({ tools: many, pageSize: 5 });
    const all = await client(server).listTools();
    expect(all.map((t) => t.name)).toEqual(many.map((t) => t.name));
    const capped = await client(fakeMcpServerFetch({ tools: many, pageSize: 5 }), { maxTools: 7 }).listTools();
    expect(capped.length).toBe(7);
  });

  it("re-initializes once on a 404 session", async () => {
    const server = fakeMcpServerFetch({ tools: TOOLS, sessionId: "s", forgetSessionAfter: 1 });
    const c = client(server);
    await c.listTools(); // served=1 → session forgotten after this
    const res = await c.callTool("search_issues", {}); // 404 → re-init → retry
    expect(res.content[0]).toEqual({ type: "text", text: "search_issues ok" });
    const methods = server.requests.map((r) => r.body.method);
    expect(methods.filter((m) => m === "initialize").length).toBe(2);
  });

  it("drops malformed tool entries instead of failing the list", async () => {
    const server = fakeMcpServerFetch({
      tools: [{ name: "ok", inputSchema: { type: "object" } }, { nope: true } as never, { name: "", inputSchema: {} }],
    });
    const tools = await client(server).listTools();
    expect(tools.map((t) => t.name)).toEqual(["ok"]);
  });
});

describe("sseDataFrames", () => {
  it("joins multi-line data, skips comments and other fields, tolerates CRLF", () => {
    const text = ': comment\r\nevent: message\r\nid: 1\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata:solo\n\n';
    expect(sseDataFrames(text)).toEqual(['{"a":\n1}', "solo"]);
  });
});
