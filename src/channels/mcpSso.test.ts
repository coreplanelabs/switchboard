import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { secretsFrom } from "../secrets.js";
import { ALL_GRANTS, grantsFor } from "../core/authz/grants.js";
import { NO_GRANTS } from "../core/authz/types.js";
import type { CoreDeps } from "../core/dispatcher.js";
import type { IncomingMessage } from "../core/types.js";
import { CommandRegistry, bindCommands } from "../core/commandRegistry.js";
import { buildDashboardVerifier, loopbackVerifier, tokenVerifier } from "./dashboardAuth.js";
import { handleMcpRequest, type McpOptions } from "./mcp.js";
import { digestBearer, InMemoryPersonalTokenStore } from "../mcp/personalTokens.js";

// Feature: docs/reference/specs/mcp-ingress.md and access-gate.md — MCP reuses browser access.
const now = 1_700_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "sso-key" };
const claims = {
  iss: "https://team.cloudflareaccess.com",
  aud: "application",
  sub: "alice",
  email: "alice@example.com",
  exp: now / 1000 + 300,
};
function jwt(payload = claims, alg = "RS256") {
  const input = [JSON.stringify({ alg, kid: "sso-key" }), JSON.stringify(payload)]
    .map((part) => Buffer.from(part).toString("base64url"))
    .join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}
const request = (headers: Record<string, string>) => ({
  method: "POST",
  headers,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "dispatch", arguments: { text: "hello" } },
  }),
});
function fixture(linked = true, sessionGranted = true) {
  const messages: IncomingMessage[] = [];
  const deps = {
    config: {
      config: {},
      grantsFor: (id: string) => (id === "access:alice" && sessionGranted ? ALL_GRANTS : NO_GRANTS),
    },
  } as unknown as CoreDeps;
  const options: McpOptions = {
    auth: { tokens: {} },
    personByEmail: async () => (linked ? { id: "slack:UALICE" } : undefined),
    dispatch: async (_deps: CoreDeps, message: IncomingMessage, io: { reply(text: string): Promise<void> }) => {
      messages.push(message);
      await io.reply("SSO request accepted");
    },
    sso: buildDashboardVerifier({
      dashboard: { auth: "access" },
      access: { teamDomain: "team.cloudflareaccess.com", aud: "application" },
      secrets: secretsFrom({}),
      publicBaseUrl: undefined,
      verify: { fetchJwks: async () => [jwk], now: () => now },
    }),
  };
  return { deps, options, messages };
}

describe("MCP SSO", () => {
  it("accepts the signed Access assertion without an ingress or personal bearer", async () => {
    const f = fixture();
    const result = await handleMcpRequest(
      request({ authorization: "Bearer oauth:opaque", "cf-access-jwt-assertion": jwt() }),
      f.deps,
      f.options,
    );
    expect(result).toMatchObject({
      status: 200,
      body: { result: { content: [{ type: "text", text: "SSO request accepted" }] } },
    });
    expect(f.messages[0]).toMatchObject({
      userId: "slack:UALICE",
      authenticatedAs: "access:alice",
      channelId: "mcp:default",
      text: "hello",
    });
  });

  it("uses the verified account when no Slack person is linked", async () => {
    const f = fixture(false);
    const result = await handleMcpRequest(request({ "cf-access-jwt-assertion": jwt() }), f.deps, f.options);
    expect(result.status).toBe(200);
    expect(f.messages[0]).toMatchObject({ userId: "access:alice" });
  });

  it("passes the browser caller and verified channel membership to registry tools", async () => {
    const f = fixture();
    const registry = new CommandRegistry({ audit: () => {} });
    registry.register({
      id: "runs.inspect",
      action: "runs:read",
      effect: "read",
      describe: "Read the caller",
      handler: async ({ caller }) => ({
        kind: caller.kind,
        id: caller.actor.id,
        self: [...(caller.actor.self ?? [])],
        channels: [...(caller.actor.memberOf ?? [])],
      }),
    });
    const req = request({ "cf-access-jwt-assertion": jwt() });
    req.body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "runs_inspect", arguments: {} },
    });
    const result = await handleMcpRequest(req, f.deps, {
      ...f.options,
      commands: bindCommands(registry, {}),
      channelsOf: async () => new Set(["slack:CONE"]),
    });
    expect(result).toMatchObject({
      status: 200,
      body: {
        result: {
          content: [
            {
              type: "text",
              text: 'runs.inspect: ok\n{"kind":"access","id":"access:alice","self":["access:alice","slack:UALICE"],"channels":["slack:CONE"]}',
            },
          ],
        },
      },
    });
  });

  it("keeps a recognized operator bearer on its own grants even beside SSO", async () => {
    const f = fixture();
    f.options.auth.tokens.operator = { subject: "machine" };
    for (const authorization of ["Bearer operator", "bearer operator", "Bearer  operator", " Bearer operator "]) {
      const result = await handleMcpRequest(
        request({ authorization, "cf-access-jwt-assertion": jwt() }),
        f.deps,
        f.options,
      );
      expect(result).toMatchObject({
        status: 200,
        body: { error: { code: -32001, message: "mcp:machine is not allowed to call dispatch" } },
      });
    }
    expect(f.messages).toEqual([]);
  });

  it("refuses missing, forged, expired, wrong-issuer and wrong-audience assertions", async () => {
    const f = fixture();
    for (const assertion of [
      undefined,
      "forged",
      jwt({ ...claims, exp: now / 1000 - 1 }),
      jwt({ ...claims, iss: "https://attacker.example" }),
      jwt({ ...claims, aud: "other" }),
      jwt(claims, "HS256"),
    ]) {
      const result = await handleMcpRequest(
        request({
          authorization: "Bearer oauth:opaque",
          ...(assertion ? { "cf-access-jwt-assertion": assertion } : {}),
        }),
        f.deps,
        f.options,
      );
      expect(result.status).toBe(401);
    }
    expect(f.messages).toEqual([]);
  });

  it("requires the same session grants as the browser for registry commands", async () => {
    const registry = new CommandRegistry({ audit: () => {} });
    registry.register({
      id: "repo.reconfigure",
      action: "repo:write",
      effect: "write",
      annotations: { destructive: false },
      describe: "Update the repository",
      handler: async () => ({ saved: "configuration" }),
    });
    for (const f of [fixture(true, false), fixture(false, false)]) {
      const req = request({ "cf-access-jwt-assertion": jwt() });
      req.body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "repo_reconfigure", arguments: {} },
      });
      const result = await handleMcpRequest(req, f.deps, { ...f.options, commands: bindCommands(registry, {}) });
      expect(result).toMatchObject({ status: 200, body: { error: { code: -32001, data: { code: "unauthorized" } } } });
      expect(f.messages).toEqual([]);
    }
  });

  it("dispatches an ordinary browser account through its actual agent baseline", async () => {
    const f = fixture();
    f.deps.config.grantsFor = (id) => grantsFor(id, { agentNames: ["general"], commandGroups: ["runs", "repo"] });
    const result = await handleMcpRequest(request({ "cf-access-jwt-assertion": jwt() }), f.deps, f.options);
    expect(result).toMatchObject({
      status: 200,
      body: { result: { content: [{ type: "text", text: "SSO request accepted" }] } },
    });
    expect(f.messages[0]).toMatchObject({ userId: "slack:UALICE", authenticatedAs: "access:alice" });
  });

  it("keeps a personal bearer's limits and revocation even beside an administrator SSO assertion", async () => {
    const f = fixture();
    const bearer = "a".repeat(64);
    const personalTokens = new InMemoryPersonalTokenStore();
    await personalTokens.put({
      digest: digestBearer(bearer),
      subject: "personal:device",
      email: "alice@example.com",
      userId: "access:device",
      createdAt: 1,
    });
    f.deps.config.grantsFor = (id) =>
      id === "mcp:personal:device" ? { ...NO_GRANTS, actions: new Set(["repo:read"]) } : ALL_GRANTS;
    const registry = new CommandRegistry({ audit: () => {}, confirmationClass: () => "destructive" });
    registry.register({
      id: "repo.reconfigure",
      action: "repo:write",
      effect: "write",
      annotations: { destructive: false },
      describe: "Update the repository",
      handler: async () => ({ saved: "configuration" }),
    });
    registry.register({
      id: "repo.inspect",
      action: "repo:read",
      effect: "read",
      describe: "Read the account",
      handler: async ({ caller }) => ({ id: caller.actor.id }),
    });
    const write = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "repo_reconfigure", arguments: {} },
    });
    const read = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "repo_inspect", arguments: {} },
    });
    const options = { ...f.options, personalTokens, commands: bindCommands(registry, {}) };
    const headers = [`Bearer ${bearer}`, `bearer ${bearer}`, `Bearer  ${bearer}`, ` Bearer ${bearer} `];
    for (const authorization of headers) {
      for (const sso of [options.sso, tokenVerifier({ token: bearer, env: "DASHBOARD_TOKEN", subject: "alice" })]) {
        const req = request({ authorization, "cf-access-jwt-assertion": jwt() });
        req.body = write;
        expect((await handleMcpRequest(req, f.deps, { ...options, sso })).body).toMatchObject({
          error: { code: -32001, message: "mcp:personal:device is not allowed to run repo.reconfigure" },
        });
        req.body = read;
        expect((await handleMcpRequest(req, f.deps, { ...options, sso })).body).toMatchObject({
          result: { content: [{ type: "text", text: 'repo.inspect: ok\n{"id":"mcp:personal:device"}' }] },
        });
      }
    }
    await personalTokens.delete(digestBearer(bearer), "personal:device");
    for (const authorization of headers)
      expect(
        (await handleMcpRequest(request({ authorization, "cf-access-jwt-assertion": jwt() }), f.deps, options)).status,
      ).toBe(401);
    personalTokens.get = async () => {
      throw new Error("store unavailable");
    };
    for (const authorization of headers)
      for (const sso of [options.sso, tokenVerifier({ token: bearer, env: "DASHBOARD_TOKEN", subject: "alice" })])
        expect(
          (
            await handleMcpRequest(request({ authorization, "cf-access-jwt-assertion": jwt() }), f.deps, {
              ...options,
              sso,
            })
          ).status,
        ).toBe(503);
    expect(f.messages).toEqual([]);
  });

  it("uses the browser origin guard to refuse cross-site SSO requests", async () => {
    const f = fixture();
    const options = { ...f.options, publicBaseUrl: "https://bot.example" };
    const blocked: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "https://bot.example", "sec-fetch-site": "cross-site" },
      { origin: "null" },
    ];
    for (const headers of blocked) {
      const result = await handleMcpRequest(request({ "cf-access-jwt-assertion": jwt(), ...headers }), f.deps, options);
      expect(result).toMatchObject({ status: 403, body: { error: { code: -32001, message: "forbidden" } } });
    }
    expect(f.messages).toEqual([]);
    const accepted = await handleMcpRequest(
      request({ "cf-access-jwt-assertion": jwt(), origin: "https://bot.example", "sec-fetch-site": "same-origin" }),
      f.deps,
      options,
    );
    expect(accepted.status).toBe(200);
    expect(f.messages[0]).toMatchObject({ userId: "slack:UALICE", authenticatedAs: "access:alice" });
  });

  it("refuses machine service assertions and the credential-free loopback strategy", async () => {
    const f = fixture();
    const service = jwt({ ...claims, sub: "", common_name: "service" } as typeof claims);
    expect((await handleMcpRequest(request({ "cf-access-jwt-assertion": service }), f.deps, f.options)).status).toBe(
      401,
    );
    expect(
      (await handleMcpRequest(request({}), f.deps, { ...f.options, sso: loopbackVerifier(undefined) })).status,
    ).toBe(503);
    expect(f.messages).toEqual([]);
  });

  it("uses the existing non-Cloudflare verifier through the same interface", async () => {
    const f = fixture(false);
    const sso = tokenVerifier({ token: "proxy-credential", env: "DASHBOARD_TOKEN", subject: "alice" });
    const result = await handleMcpRequest(request({ authorization: "Bearer proxy-credential" }), f.deps, {
      ...f.options,
      sso,
    });
    expect(result.status).toBe(200);
    expect(f.messages[0]).toMatchObject({ userId: "access:alice" });
    expect(
      (await handleMcpRequest(request({ authorization: "Bearer wrong" }), f.deps, { ...f.options, sso })).status,
    ).toBe(401);
  });

  it("accepts a configured 64-hex dashboard token while preserving stored personal limits", async () => {
    const f = fixture();
    const bearer = "b".repeat(64);
    const personalTokens = new InMemoryPersonalTokenStore();
    const sso = tokenVerifier({ token: bearer, env: "DASHBOARD_TOKEN", subject: "alice" });
    const options = { ...f.options, personalTokens, sso };
    const headers = [`Bearer ${bearer}`, `bearer ${bearer}`, `Bearer  ${bearer}`, `Bearer ${bearer} `];
    for (const authorization of headers) {
      const accepted = await handleMcpRequest(request({ authorization }), f.deps, options);
      expect(accepted).toMatchObject({
        status: 200,
        body: { result: { content: [{ type: "text", text: "SSO request accepted" }] } },
      });
    }
    expect(f.messages[0]).toMatchObject({ userId: "access:alice", authenticatedAs: "access:alice" });
    await personalTokens.put({
      digest: digestBearer(bearer),
      subject: "personal:device",
      email: "alice@example.com",
      userId: "access:device",
      createdAt: 1,
    });
    for (const authorization of headers) {
      const limited = await handleMcpRequest(request({ authorization }), f.deps, options);
      expect(limited).toMatchObject({
        body: { error: { code: -32001, message: "mcp:personal:device is not allowed to call dispatch" } },
      });
    }
    const wrong = await handleMcpRequest(
      request({ authorization: `Bearer ${"c".repeat(64)}`, "cf-access-jwt-assertion": jwt() }),
      f.deps,
      options,
    );
    expect(wrong.status).toBe(401);
  });

  it("logs a verifier fault with its cause while redacting credentials", async () => {
    const f = fixture();
    const assertion = jwt();
    const logs: unknown[] = [];
    const capture = vi.spyOn(console, "error").mockImplementation((line) => {
      logs.push(line);
    });
    try {
      const sso = {
        ...f.options.sso!,
        verify: async () => {
          throw new Error(`JWKS unavailable for oauth:opaque assertion ${assertion} API_KEY=unsafe-secret-value`);
        },
      };
      const result = await handleMcpRequest(
        request({ authorization: "Bearer oauth:opaque", "cf-access-jwt-assertion": assertion }),
        f.deps,
        { ...f.options, sso },
      );
      expect(result).toMatchObject({
        status: 503,
        body: { error: { code: -32001, message: "MCP access unavailable" } },
      });
      expect(logs).toEqual([
        "[mcp] dashboard verifier fault: JWKS unavailable for «redacted» assertion «redacted» API_KEY=«redacted»",
      ]);
    } finally {
      capture.mockRestore();
    }
  });
});
