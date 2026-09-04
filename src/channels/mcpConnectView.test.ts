import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, InMemoryOverridesBacking } from "../config.js";
import { fakeAuthorizationServer, InMemoryMcpClient, type FakeAuthorizationServerOptions } from "../mcp/fake.js";
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

function harness(opts: { rejectTokens?: string[]; email?: string; oauth?: FakeAuthorizationServerOptions } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swb-connect-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, YAML);
  const config = new ConfigStore(cfg, { backing: new InMemoryOverridesBacking(), initial: undefined }, () => {});
  const secrets = new InMemoryMcpSecretStore();
  let n = 0;
  const as = fakeAuthorizationServer(opts.oauth ?? { server: "https://mcp.vanta.com/mcp" });
  const service = new McpService({
    config,
    secrets,
    key: importCredentialKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    publicBaseUrl: "https://switchboard.test",
    fetch: as.fetch,
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
  const addOAuth = (url = "https://mcp.vanta.com/mcp") => service.add(alice, ME, { name: "vanta", url, auth: "oauth" });
  return { secrets, service, handler, addVanta, addOAuth, as };
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

/** The authorization URL the forwarding page carries (the visible link; the meta refresh names the same one). */
function authUrlOf(html: string): string {
  const m = /<a href="([^"]+)">/.exec(html);
  if (!m) throw new Error("forwarding page carries no link");
  return m[1].replace(/&amp;/g, "&");
}

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

describe("OAuth on the connect page (item 18)", () => {
  const CALLBACK = "/mcp/oauth/callback";

  it("the callback path rides the same gate; GET only", async () => {
    expect(isConnectPath(CALLBACK)).toBe(true);
    expect(isConnectPath("/mcp/oauth")).toBe(false);
    const h = harness();
    const { server, base } = await serve(h.handler);
    try {
      const res = await post(base, CALLBACK, "x=1");
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      const bare = await fetch(`${base}${CALLBACK}`);
      expect(bare.status).toBe(400);
      expect(await bare.text()).toContain("carries nothing to finish");
    } finally {
      server.close();
    }
  });

  it("GET shows a sign-in button (no token field) for an oauth server under a CSP that allows the same-origin post; POST action=start answers a page that forwards to the authorization server (meta refresh + a visible link, no script, never a redirect — Chrome checks those against form-action) with PKCE + state; the ticket is `authorizing`", async () => {
    const h = harness();
    await h.addOAuth();
    const { server, base } = await serve(h.handler);
    try {
      const page = await fetch(`${base}${NONCE1}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      const html = await page.text();
      expect(html).toContain("Continue to mcp.vanta.com");
      expect(html).toContain('name="action" value="start"');
      expect(html).not.toContain('name="token"');
      const started = await post(base, NONCE1, "action=start");
      expect(started.status).toBe(200);
      expect(started.headers.get("location")).toBeNull();
      const forward = await started.text();
      expect(forward).toContain('<meta http-equiv="refresh" content="0;url=https://as.example.com/oauth/authorize?');
      expect(forward).not.toContain("<script");
      const location = new URL(authUrlOf(forward));
      expect(location.origin + location.pathname).toBe("https://as.example.com/oauth/authorize");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("redirect_uri")).toBe("https://switchboard.test/mcp/oauth/callback");
      expect((await h.secrets.getTicket("nonce-00000000000000000001"))?.state).toBe("authorizing");
      // Cross-site posts cannot start a sign-in either.
      expect((await post(base, NONCE1, "action=start", { "sec-fetch-site": "cross-site" })).status).toBe(403);
      // A stranger cannot start it.
      expect((await post(base, NONCE1, "action=start", { "x-test-sub": "cf-other", "x-test-email": "other@else.example" })).status).toBe(403);
    } finally {
      server.close();
    }
  });

  it("the callback with the right state + code connects the server (tools counted); the ticket is spent; a second callback is 410", async () => {
    const h = harness();
    await h.addOAuth();
    const { server, base } = await serve(h.handler);
    try {
      const started = await post(base, NONCE1, "action=start");
      const auth = authUrlOf(await started.text());
      const state = new URL(auth).searchParams.get("state") as string;
      const code = h.as.issueCode(auth);
      const done = await fetch(`${base}${CALLBACK}?state=${encodeURIComponent(state)}&code=${code}`);
      expect(done.status).toBe(200);
      const html = await done.text();
      expect(html).toContain("is connected");
      expect(html).toContain("<strong>1</strong> tool");
      expect(html).not.toMatch(/at-1|rt-1|client-1/);
      expect(await h.secrets.getCredential(KEY_ID)).toBeTruthy();
      expect((await fetch(`${base}${CALLBACK}?state=${encodeURIComponent(state)}&code=${code}`)).status).toBe(410);
    } finally {
      server.close();
    }
  });

  it("callback refusals: a stranger (403), a wrong state (502, nothing stored), the authorization server's error (502), a code the server rejects (502); the connect link still works for a retry", async () => {
    const h = harness();
    await h.addOAuth();
    const { server, base } = await serve(h.handler);
    try {
      const started = await post(base, NONCE1, "action=start");
      const auth = authUrlOf(await started.text());
      const state = new URL(auth).searchParams.get("state") as string;
      const nonce = "nonce-00000000000000000001";
      expect((await fetch(`${base}${CALLBACK}?state=${encodeURIComponent(state)}&code=c`, { headers: { "x-test-sub": "cf-other", "x-test-email": "other@else.example" } })).status).toBe(403);
      const wrong = await fetch(`${base}${CALLBACK}?state=${encodeURIComponent(`${nonce}.nope`)}&code=c`);
      expect(wrong.status).toBe(502);
      expect(await wrong.text()).toContain("state does not match");
      const denied = await fetch(`${base}${CALLBACK}?state=${encodeURIComponent(state)}&error=access_denied&error_description=nope`);
      expect(denied.status).toBe(502);
      expect(await denied.text()).toContain("access_denied");
      const badCode = await fetch(`${base}${CALLBACK}?state=${encodeURIComponent(state)}&code=never`);
      expect(badCode.status).toBe(502);
      expect(await badCode.text()).toContain("invalid_grant");
      expect(await h.secrets.getCredential(KEY_ID)).toBeNull();
      // The link still opens: the person can start again.
      expect((await fetch(`${base}${NONCE1}`)).status).toBe(200);
      expect((await post(base, NONCE1, "action=start")).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("a pasted token on an oauth server's link is refused with the button re-shown; action=start on a bearer server's link is a 502 naming the auth kind", async () => {
    const h = harness();
    await h.addOAuth();
    const { server, base } = await serve(h.handler);
    try {
      const res = await post(base, NONCE1, "token=abc");
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("signs in with OAuth");
      const bearer = harness();
      await bearer.addVanta();
      const s2 = await serve(bearer.handler);
      try {
        const started = await post(s2.base, NONCE1, "action=start");
        expect(started.status).toBe(502);
        expect(await started.text()).toContain("does not sign in with OAuth");
      } finally {
        s2.server.close();
      }
    } finally {
      server.close();
    }
  });
});
