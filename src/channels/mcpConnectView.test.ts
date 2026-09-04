import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, InMemoryOverridesBacking } from "../config.js";
import { InMemoryMcpClient } from "../mcp/fake.js";
import { MCP_TOKEN_MAX_CHARS } from "../mcp/registry.js";
import { importCredentialKey } from "../mcp/sealed.js";
import { InMemoryMcpSecretStore } from "../mcp/secretStore.js";
import { McpService, type McpActor } from "../mcp/service.js";
import type { AccessIdentity } from "./accessAuth.js";
import { createMcpConnectViewHandler, isConnectPath, parseConnectRoute } from "./mcpConnectView.js";

// features/mcp-tools.md item 15: the connect page. The handler receives the
// Access-verified identity from index.ts; these tests drive it over a real
// local http server with a fixed identity per request (header-selected so one
// server can play several people).

const YAML = "providers:\n  anthropic:\n    type: anthropic\ndefaults:\n  agent: general\n  models:\n    general: anthropic/m\n";
const alice: McpActor = { id: "slack:U1", orgAdmin: false, channelAdmin: true };
const ME = { kind: "user" as const, id: alice.id };
const KEY_ID = "user:slack:U1/vanta";

function harness(opts: { rejectTokens?: string[]; email?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swb-connect-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, YAML);
  const config = new ConfigStore(cfg, { backing: new InMemoryOverridesBacking(), initial: undefined }, () => {});
  const secrets = new InMemoryMcpSecretStore();
  let n = 0;
  const service = new McpService({
    config,
    secrets,
    key: importCredentialKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    publicBaseUrl: "https://switchboard.test",
    env: {},
    resolveEmail: opts.email ? async () => opts.email : undefined,
    now: () => 1_000_000,
    nonce: () => `nonce-${String(++n).padStart(20, "0")}`,
    factory: (spec) => {
      const c = new InMemoryMcpClient([{ name: "search", inputSchema: {} }]);
      if (spec.auth?.type === "bearer" && opts.rejectTokens?.includes(spec.auth.token)) c.failListWith = "MCP server returned HTTP 401";
      return c;
    },
  });
  const handler = createMcpConnectViewHandler({ registry: () => service, publicOrigin: "https://switchboard.test" });
  const addVanta = (url = "https://mcp.vanta.com/mcp") => service.add(alice, ME, { name: "vanta", url, auth: "bearer" });
  return { secrets, service, handler, addVanta };
}

async function serve(handler: ReturnType<typeof createMcpConnectViewHandler>): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    // The identity index.ts would have verified: chosen by a test header.
    const identity: AccessIdentity = { sub: String(req.headers["x-test-sub"] ?? "cf-justin"), email: String(req.headers["x-test-email"] ?? "justin@coreplane.ai") };
    if (!handler(req, res, identity)) {
      res.writeHead(404);
      res.end("fallthrough");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${addr.port}` };
}

const post = (base: string, path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...headers }, body, redirect: "manual" });

const NONCE1 = "/mcp/connect/nonce-00000000000000000001";

describe("connect route parsing", () => {
  it("matches only /mcp/connect/<nonce> with a plausible nonce; never the /mcp ingress", () => {
    expect(isConnectPath("/mcp")).toBe(false);
    expect(isConnectPath("/mcp/connect/abc")).toBe(true);
    expect(parseConnectRoute("/mcp/connect/" + "n".repeat(24))).toEqual({ nonce: "n".repeat(24) });
    expect(parseConnectRoute("/mcp/connect/short")).toBeUndefined();
    expect(parseConnectRoute("/mcp/connect/../etc")).toBeUndefined();
  });
});

describe("GET /mcp/connect/<nonce>", () => {
  it("shows the form to the right person, refuses a stranger (403), an unknown nonce (404), and a used one (410); never leaks the URL's query", async () => {
    const h = harness({ email: "justin@coreplane.ai" });
    const { server, base } = await serve(h.handler);
    try {
      await h.addVanta("https://mcp.vanta.com/mcp?k=SECRET");
      const ok = await fetch(`${base}${NONCE1}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-security-policy")).toContain("script-src 'self'");
      const html = await ok.text();
      expect(html).toContain(`<form method="post" action="${NONCE1}">`);
      expect(html).toContain('name="token" type="password"');
      expect(html).toContain("https://mcp.vanta.com/mcp");
      expect(html).not.toContain("SECRET");
      expect(html).not.toContain("<script");
      const stranger = await fetch(`${base}${NONCE1}`, { headers: { "x-test-sub": "cf-x", "x-test-email": "x@else.example" } });
      expect(stranger.status).toBe(403);
      expect(await stranger.text()).toContain("belongs to another user");
      expect((await fetch(`${base}/mcp/connect/${"z".repeat(24)}`)).status).toBe(404);
      expect((await fetch(`${base}/mcp/connect/tiny`)).status).toBe(404);
      await h.service.completeTicket("nonce-00000000000000000001", { sub: "cf-justin", email: "justin@coreplane.ai" }, "tok");
      expect((await fetch(`${base}${NONCE1}`)).status).toBe(410);
    } finally {
      server.close();
    }
  });

  it("503 when MCP is off; 405 on other methods", async () => {
    const off = await serve(createMcpConnectViewHandler({ registry: () => undefined }));
    const on = await serve(harness().handler);
    try {
      expect((await fetch(`${off.base}/mcp/connect/${"n".repeat(24)}`)).status).toBe(503);
      expect((await fetch(`${on.base}/mcp/connect/${"n".repeat(24)}`, { method: "PUT" })).status).toBe(405);
    } finally {
      off.server.close();
      on.server.close();
    }
  });
});

describe("POST /mcp/connect/<nonce>", () => {
  it("stores a verified token, the page confirms with the tool count, and a second post is 410", async () => {
    const h = harness();
    const { server, base } = await serve(h.handler);
    try {
      await h.addVanta();
      const res = await post(base, NONCE1, "token=vanta_live_token");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<strong>vanta</strong> is connected");
      expect(html).toContain("<strong>1</strong> tool.");
      expect(html).not.toContain("vanta_live");
      expect(await h.secrets.getCredential(KEY_ID)).not.toBeNull();
      expect((await h.service.list(alice, undefined)).find((s) => s.name === "vanta")?.state).toBe("connected");
      expect((await post(base, NONCE1, "token=again")).status).toBe(410);
    } finally {
      server.close();
    }
  });

  it("a token the server rejects is not stored and the form comes back (400); an empty token is 400 with the form; cross-site posts are 403", async () => {
    const h = harness({ rejectTokens: ["bad"] });
    const { server, base } = await serve(h.handler);
    try {
      await h.addVanta();
      const rejected = await post(base, NONCE1, "token=bad");
      expect(rejected.status).toBe(400);
      const html = await rejected.text();
      expect(html).toContain("rejected the token");
      expect(html).toContain("<form");
      expect(await h.secrets.getCredential(KEY_ID)).toBeNull();
      const empty = await post(base, NONCE1, "token=");
      expect(empty.status).toBe(400);
      expect(await empty.text()).toContain("the token is empty");
      expect((await post(base, NONCE1, "token=x", { "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await post(base, NONCE1, "token=x", { "sec-fetch-site": "", origin: "https://evil.example" })).status).toBe(403);
      expect((await post(base, NONCE1, "token=good")).status).toBe(200); // the real token still works on the same ticket
    } finally {
      server.close();
    }
  });

  it("a legal token at the 8192-char cap fits the form even fully URL-encoded (3 bytes per char); one char over gets the friendly bad_token page, never a bare 413", async () => {
    const h = harness();
    const { server, base } = await serve(h.handler);
    try {
      await h.addVanta();
      const over = await post(base, NONCE1, `token=${"%2B".repeat(MCP_TOKEN_MAX_CHARS + 1)}`);
      expect(over.status).toBe(400);
      expect(await over.text()).toContain(`longer than ${MCP_TOKEN_MAX_CHARS} characters`);
      expect(await h.secrets.getCredential(KEY_ID)).toBeNull();
      const max = await post(base, NONCE1, `token=${"%2B".repeat(MCP_TOKEN_MAX_CHARS)}`);
      expect(max.status).toBe(200);
      expect(await h.secrets.getCredential(KEY_ID)).not.toBeNull();
      // Something far past any token is still refused outright.
      expect((await post(base, NONCE1, `token=${"a".repeat(64 * 1024)}`)).status).toBe(413);
    } finally {
      server.close();
    }
  });

  it("the wrong person cannot complete a bound ticket even with the link", async () => {
    const h = harness({ email: "justin@coreplane.ai" });
    const { server, base } = await serve(h.handler);
    try {
      await h.addVanta();
      const res = await post(base, NONCE1, "token=x", { "x-test-sub": "cf-x", "x-test-email": "x@else.example" });
      expect(res.status).toBe(403);
      expect(await h.secrets.getCredential(KEY_ID)).toBeNull();
    } finally {
      server.close();
    }
  });
});
