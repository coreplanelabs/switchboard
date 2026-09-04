import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, InMemoryOverridesBacking } from "../config.js";
import { fakeAuthorizationServer, InMemoryMcpClient, type FakeAuthorizationServerOptions } from "./fake.js";
import { MCP_TICKET_TTL_MS, type McpTicket } from "./registry.js";
import { importCredentialKey, openCredential } from "./sealed.js";
import { InMemoryMcpSecretStore } from "./secretStore.js";
import { McpService, McpServiceError, type McpActor, type McpTarget } from "./service.js";
import type { McpServerSpec } from "./types.js";

// features/mcp-tools.md items 13–17: the MCP rules over the CONFIG layers.

const KEY = importCredentialKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
const YAML = `
providers:
  anthropic:
    type: anthropic
defaults:
  agent: general
  models:
    general: anthropic/general-model
  mcpServers:
    github: { url: "https://api.githubcopilot.com/mcp/", auth: bearer, tokenEnv: MCP_GITHUB_TOKEN, agents: [general, coding] }
channels:
  "slack:CSTATIC":
    mcpServers:
      notion: { url: "https://mcp.notion.so/mcp", auth: none }
      compliance: { url: "https://mcp.vanta.com/mcp", auth: oauth }
permissions:
  admins: ["slack:UADMIN"]
  repoManagement: ["slack:UADMIN"]
`;

const admin: McpActor = { id: "slack:UADMIN", orgAdmin: true, channelAdmin: true };
const alice: McpActor = { id: "slack:UALICE", orgAdmin: false, channelAdmin: true };
const bob: McpActor = { id: "slack:UBOB", orgAdmin: false, channelAdmin: false };
const justin = { sub: "cf-justin", email: "justin@coreplane.ai" };
const stranger = { sub: "cf-stranger", email: "x@else.example" };
const ME = (a: McpActor): McpTarget => ({ kind: "user", id: a.id });
const ORG: McpTarget = { kind: "org" };
const CH = (id: string): McpTarget => ({ kind: "channel", id });

function harness(opts: { key?: boolean; publicBaseUrl?: string; email?: Record<string, string>; rejectTokens?: string[]; serverDown?: boolean; env?: Record<string, string>; oauth?: FakeAuthorizationServerOptions; fetch?: false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swb-mcp-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, YAML);
  const backing = new InMemoryOverridesBacking();
  const config = new ConfigStore(cfg, { backing, initial: undefined }, () => {});
  const secrets = new InMemoryMcpSecretStore();
  let t = 1_000_000;
  let n = 0;
  const clients: Array<{ spec: McpServerSpec; client: InMemoryMcpClient }> = [];
  // The fake authorization server (item 18) doubles as the auth-detection
  // target; without `oauth`, every server answers 401 with no metadata → bearer.
  const as = fakeAuthorizationServer(opts.oauth ?? { server: "https://mcp.vanta.com/mcp", metadata: false });
  const service = new McpService({
    config,
    secrets,
    key: opts.key === false ? undefined : KEY,
    publicBaseUrl: opts.publicBaseUrl === undefined ? "https://switchboard.test" : opts.publicBaseUrl || undefined,
    ...(opts.fetch === false ? {} : { fetch: as.fetch }),
    env: opts.env ?? { MCP_GITHUB_TOKEN: "ghp_static" },
    resolveEmail: opts.email ? async (id) => opts.email![id] : undefined,
    now: () => t,
    nonce: () => `nonce-${String(++n).padStart(20, "0")}`,
    factory: (spec) => {
      const client = new InMemoryMcpClient([{ name: "search", inputSchema: {}, annotations: { readOnlyHint: true } }, { name: "create", inputSchema: {} }]);
      if (opts.serverDown) client.failListWith = "MCP transport failed: ECONNREFUSED";
      else if (spec.auth?.type === "bearer" && opts.rejectTokens?.includes(spec.auth.token)) client.failListWith = "MCP server returned HTTP 401";
      clients.push({ spec, client });
      return client;
    },
  });
  return { config, backing, secrets, service, clients, as, tick: (ms: number) => (t += ms), now: () => t };
}

const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
    return "ok";
  } catch (e) {
    return e instanceof McpServiceError ? e.code : `other:${String(e)}`;
  }
};

describe("McpService — tiers and authorization (items 13–14)", () => {
  it("target(): me for anyone; channel needs channel-config rights and a channel; org needs an admin — each refusal names `--scope me`", async () => {
    const h = harness();
    expect(h.service.target(alice, "me", "slack:C1")).toEqual({ kind: "user", id: alice.id });
    expect(h.service.target(alice, "channel", "slack:C1")).toEqual({ kind: "channel", id: "slack:C1" });
    expect(await code(() => h.service.target(bob, "channel", "slack:C1"))).toBe("unauthorized");
    expect(await code(() => h.service.target(alice, "channel", undefined))).toBe("invalid_input");
    expect(await code(() => h.service.target(alice, "org", undefined))).toBe("unauthorized");
    expect(h.service.target(admin, "org", undefined)).toEqual({ kind: "org" });
  });

  it("add writes the entry into the tier's RUNTIME scope (never the static config); the view carries no secret and the URL no query", async () => {
    const h = harness();
    const mine = await h.service.add(alice, ME(alice), { name: "vanta", url: "https://mcp.vanta.com/mcp?k=SECRET", auth: "none" });
    expect(mine.server).toMatchObject({ name: "vanta", scope: "user", scopeKey: "user:slack:UALICE", state: "connected", source: "runtime", agents: ["general", "research"], url: "https://mcp.vanta.com/mcp", addedBy: alice.id });
    expect(JSON.stringify(mine)).not.toContain("SECRET");
    expect(h.backing.document?.users["slack:UALICE"].mcpServers?.vanta).toMatchObject({ url: "https://mcp.vanta.com/mcp?k=SECRET", auth: "none" });
    const org = await h.service.add(admin, ORG, { name: "linear", url: "https://mcp.linear.app/mcp", auth: "none", agents: ["general", "coding", "review"] });
    expect(org.server).toMatchObject({ scope: "org", agents: ["general", "coding", "review"] });
    expect(h.backing.document?.org?.mcpServers?.linear).toBeDefined();
    const chan = await h.service.add(alice, CH("slack:C1"), { name: "hubspot", url: "https://mcp.hubspot.com/mcp", auth: "none" });
    expect(chan.server).toMatchObject({ scope: "channel", scopeKey: "channel:slack:C1" });
    // The static config is untouched.
    expect(h.config.config.defaults.mcpServers).toEqual({ github: expect.anything() });
  });

  it("channel and user servers may reach general/research only; unknown agents, SSRF URLs, duplicates (runtime or static), and lower-tier shadowing are refused", async () => {
    const h = harness();
    expect(await code(h.service.add(alice, ME(alice), { name: "a", url: "https://x.example/mcp", auth: "none", agents: ["coding"] }))).toBe("invalid_input");
    expect(await code(h.service.add(alice, CH("slack:C1"), { name: "a", url: "https://x.example/mcp", auth: "none", agents: ["review"] }))).toBe("invalid_input");
    expect(await code(h.service.add(alice, ME(alice), { name: "a", url: "https://x.example/mcp", auth: "none", agents: ["wizard"] }))).toBe("invalid_input");
    expect(await code(h.service.add(alice, ME(alice), { name: "a", url: "http://169.254.169.254/", auth: "none" }))).toBe("invalid_input");
    await h.service.add(alice, ME(alice), { name: "a", url: "https://x.example/mcp", auth: "none" });
    expect(await code(h.service.add(alice, ME(alice), { name: "a", url: "https://y.example/mcp", auth: "none" }))).toBe("conflict");
    // A static org server's name (github) and a static channel server's name (notion, in slack:CSTATIC).
    expect(await code(h.service.add(admin, ORG, { name: "github", url: "https://y.example/mcp", auth: "none" }))).toBe("conflict");
    expect(await code(h.service.add(alice, CH("slack:CSTATIC"), { name: "notion", url: "https://y.example/mcp", auth: "none" }))).toBe("conflict");
    // A user may not take an org name; a user in slack:CSTATIC may not take that channel's name.
    expect(await code(h.service.add(bob, ME(bob), { name: "github", url: "https://y.example/mcp", auth: "none" }))).toBe("conflict");
  });

  it("list shows org + this channel + own (never another user's); remove needs the tier; a pinned entry cannot be removed here", async () => {
    const h = harness();
    await h.service.add(alice, ME(alice), { name: "vanta", url: "https://mcp.vanta.com/mcp", auth: "none" });
    await h.service.add(bob, ME(bob), { name: "secretive", url: "https://s.example/mcp", auth: "none" });
    const seen = await h.service.list(alice, "slack:CSTATIC");
    expect(seen.map((s) => `${s.scope}/${s.name}/${s.state}/${s.source}`)).toEqual(["org/github/static/config", "channel/notion/connected/config", "channel/compliance/awaiting_credential/config", "user/vanta/connected/runtime"]);
    expect((await h.service.list(bob, "slack:COTHER")).map((s) => s.name)).toEqual(["github", "secretive"]);
    expect(await code(h.service.remove(alice, ORG, "github"))).toBe("conflict"); // pinned in config.yaml
    expect(await code(h.service.remove(alice, ME(alice), "secretive"))).toBe("not_found"); // bob's
    expect(await h.service.remove(alice, ME(alice), "vanta")).toEqual({ removed: true, name: "vanta", scope: "user" });
    expect(h.backing.document?.users["slack:UALICE"].mcpServers).toBeUndefined();
  });

  it("show probes live (names + read-only flags) for a connected server; a static bearer uses its env var", async () => {
    const h = harness();
    const shown = await h.service.show(alice, ORG, "github");
    expect(shown.state).toBe("static");
    expect(shown.probe).toEqual({ ok: true, tools: [{ name: "search", readOnly: true, description: "" }, { name: "create", readOnly: false, description: "" }] });
    expect(h.clients.at(-1)?.spec.auth).toEqual({ type: "bearer", token: "ghp_static" });
    const noEnv = harness({ env: {} });
    expect((await noEnv.service.show(alice, ORG, "github")).probe).toEqual({ ok: false, error: "MCP_GITHUB_TOKEN is not set on the bot" });
  });
});

describe("McpService — the connect flow (items 15–16)", () => {
  it("a bearer add mints a ticket and a link; without the key or PUBLIC_BASE_URL it is refused as unavailable", async () => {
    const h = harness({ email: { [alice.id]: "Justin@CorePlane.ai" } });
    const out = await h.service.add(alice, ME(alice), { name: "vanta", url: "https://mcp.vanta.com/mcp", auth: "bearer" });
    expect(out.server).toMatchObject({ state: "awaiting_credential", auth: "bearer" });
    expect(out.connectUrl).toBe("https://switchboard.test/mcp/connect/nonce-00000000000000000001");
    expect(out.expiresAt).toBe(h.now() + MCP_TICKET_TTL_MS);
    expect(out.expiresInMinutes).toBe(10);
    expect(await h.secrets.getTicket("nonce-00000000000000000001")).toMatchObject({ serverId: "user:slack:UALICE/vanta", requesterId: alice.id, requesterEmail: "justin@coreplane.ai", state: "pending" });
    expect(await code(harness({ key: false }).service.add(alice, ME(alice), { name: "v", url: "https://x.example/mcp", auth: "bearer" }))).toBe("unavailable");
    expect(await code(harness({ publicBaseUrl: "" }).service.add(alice, ME(alice), { name: "v", url: "https://x.example/mcp", auth: "bearer" }))).toBe("unavailable");
  });

  it("open → complete: identity-bound, token verified against the server, sealed at rest, single-use; the next run uses it", async () => {
    const h = harness({ email: { [alice.id]: "justin@coreplane.ai" } });
    await h.service.add(alice, ME(alice), { name: "vanta", url: "https://mcp.vanta.com/mcp", auth: "bearer" });
    const nonce = "nonce-00000000000000000001";
    expect((await h.service.openTicket(nonce, stranger)).decision).toEqual({ ok: false, refusal: { kind: "wrong_identity" } });
    const opened = await h.service.openTicket(nonce, justin);
    expect(opened.decision.ok).toBe(true);
    expect(opened.server?.name).toBe("vanta");
    const done = await h.service.completeTicket(nonce, justin, "  vanta_live_TOKEN  ");
    expect(done).toMatchObject({ verified: true, toolCount: 2 });
    expect(done.server?.state).toBe("connected");
    const sealed = await h.secrets.getCredential("user:slack:UALICE/vanta");
    expect(sealed?.sealed).not.toContain("vanta_live");
    expect(JSON.stringify(h.backing.document)).not.toContain("vanta_live"); // never in the config document
    expect(h.clients.at(-1)?.spec.auth).toEqual({ type: "bearer", token: "vanta_live_TOKEN" });
    expect((await h.service.completeTicket(nonce, justin, "again")).decision).toEqual({ ok: false, refusal: { kind: "used" } });
    // The run resolves it, decrypted for the run only.
    const run = await h.service.resolveForRun("general", { userId: alice.id, channelId: "slack:C1" });
    expect(run.map((r) => ("spec" in r ? [r.spec.id, r.spec.auth] : r))).toEqual([
      ["org/github", { type: "bearer", token: "ghp_static" }],
      ["user:slack:UALICE/vanta", { type: "bearer", token: "vanta_live_TOKEN" }],
    ]);
    expect((await h.service.list(alice, "slack:C1")).find((s) => s.name === "vanta")?.state).toBe("connected");
  });

  it("a token the server rejects (401/403) is NOT stored and the ticket stays open; an unreachable server stores with a warning; `connect` re-keys; a static entry cannot be connected", async () => {
    const h = harness({ rejectTokens: ["bad"] });
    await h.service.add(alice, ME(alice), { name: "vanta", url: "https://mcp.vanta.com/mcp", auth: "bearer" });
    const nonce = "nonce-00000000000000000001";
    const rejected = await h.service.completeTicket(nonce, justin, "bad");
    expect(rejected.verified).toBe(false);
    expect(rejected.warning).toMatch(/rejected the token/);
    expect(await h.secrets.getCredential("user:slack:UALICE/vanta")).toBeNull();
    expect((await h.service.completeTicket(nonce, justin, "good")).verified).toBe(true);
    const down = harness({ serverDown: true });
    await down.service.add(alice, ME(alice), { name: "vanta", url: "https://mcp.vanta.com/mcp", auth: "bearer" });
    const stored = await down.service.completeTicket("nonce-00000000000000000001", justin, "tok");
    expect(stored.verified).toBe(true);
    expect(stored.warning).toMatch(/could not be reached to verify/);
    const again = await h.service.connect(alice, ME(alice), "vanta");
    expect(again.connectUrl).toBe("https://switchboard.test/mcp/connect/nonce-00000000000000000002");
    expect(again.server.state).toBe("connected"); // the old credential stays until the new one lands
    expect(await code(h.service.connect(alice, ORG, "github"))).toBe("invalid_input"); // tokenEnv, pinned
    expect(await code(h.service.connect(bob, ME(bob), "vanta"))).toBe("not_found");
  });

  it("unbound tickets bind to the first opener; expiry ends the flow", async () => {
    const h = harness();
    await h.service.add(alice, ME(alice), { name: "vanta", url: "https://mcp.vanta.com/mcp", auth: "bearer" });
    const n1 = "nonce-00000000000000000001";
    expect((await h.service.openTicket(n1, stranger)).decision).toMatchObject({ ok: true, bound: true });
    expect((await h.service.openTicket(n1, justin)).decision).toEqual({ ok: false, refusal: { kind: "wrong_identity" } });
    h.tick(MCP_TICKET_TTL_MS + 1);
    expect((await h.service.completeTicket(n1, stranger, "tok")).decision).toEqual({ ok: false, refusal: { kind: "expired" } });
  });

  it("single-use is enforced by a compare-and-swap: of two concurrent completions exactly one seals; of two first-openers exactly one binds", async () => {
    const h = harness();
    await h.service.add(alice, ME(alice), { name: "vanta", url: "https://mcp.vanta.com/mcp", auth: "bearer" });
    const n1 = "nonce-00000000000000000001";
    // Two POSTs racing on a pending ticket: both read `pending`, both verify, one claims it.
    const [a, b] = await Promise.all([h.service.completeTicket(n1, justin, "tok-a"), h.service.completeTicket(n1, justin, "tok-b")]);
    const outcomes = [a, b].map((r) => (r.decision.ok ? "ok" : r.decision.refusal.kind)).sort();
    expect(outcomes).toEqual(["ok", "used"]);
    expect((await h.secrets.getTicket(n1))?.state).toBe("completed");
    expect(await h.secrets.getCredential("user:slack:UALICE/vanta")).not.toBeNull();
    // Two strangers opening an unbound ticket at once: one binds, the other is refused as the wrong identity.
    await h.service.connect(alice, ME(alice), "vanta");
    const n2 = "nonce-00000000000000000002";
    const [o1, o2] = await Promise.all([h.service.openTicket(n2, stranger), h.service.openTicket(n2, justin)]);
    const opens = [o1, o2].map((r) => (r.decision.ok ? (r.decision.bound ? "bound" : "open") : r.decision.refusal.kind)).sort();
    expect(opens).toEqual(["bound", "wrong_identity"]);
    const bound = (await h.secrets.getTicket(n2))?.openedBy?.sub;
    expect([stranger.sub, justin.sub]).toContain(bound);
    // The binder completes; the loser cannot.
    const winner = bound === stranger.sub ? stranger : justin;
    const loser = winner === stranger ? justin : stranger;
    expect((await h.service.completeTicket(n2, loser, "tok")).decision).toEqual({ ok: false, refusal: { kind: "wrong_identity" } });
    expect((await h.service.completeTicket(n2, winner, "tok")).decision.ok).toBe(true);
  });
});

describe("McpService — the run-time view (item 17)", () => {
  it("resolves org + channel + own servers for the agent, shadowed names reported, self-serve tiers never reach coding; the source bridges them", async () => {
    const h = harness();
    await h.service.add(alice, ME(alice), { name: "vanta", url: "https://mcp.vanta.com/mcp", auth: "none" });
    await h.service.add(alice, CH("slack:C1"), { name: "hubspot", url: "https://mcp.hubspot.com/mcp", auth: "none" });
    // A runtime user entry shadowing the org's github (cannot be added via add(); simulate a stale document).
    await h.config.setUserOverride(alice.id, { mcpServers: { vanta: { url: "https://mcp.vanta.com/mcp", auth: "none" }, github: { url: "https://evil.example/mcp", auth: "none" } } });
    const general = await h.service.resolveForRun("general", { userId: alice.id, channelId: "slack:C1" });
    expect(general.map((r) => ("spec" in r ? r.spec.id : `!${r.name}: ${r.unavailable}`))).toEqual([
      "org/github",
      "channel:slack:C1/hubspot",
      "user:slack:UALICE/vanta",
      "!github: name shadowed by the org-scoped server of the same name",
    ]);
    expect((await h.service.resolveForRun("coding", { userId: alice.id, channelId: "slack:C1" })).map((r) => ("spec" in r ? r.spec.id : r.name))).toEqual(["org/github"]);
    expect(await h.service.resolveForRun("review", { userId: alice.id, channelId: "slack:C1" })).toEqual([]);
    const run = await h.service.source.toolsFor("general", { userId: alice.id, channelId: "slack:C1" });
    expect(run.tools.map((t) => t.name)).toEqual(["mcp__github__search", "mcp__github__create", "mcp__hubspot__search", "mcp__hubspot__create", "mcp__vanta__search", "mcp__vanta__create"]);
    expect(run.servers).toEqual([
      { server: "github", toolCount: 2 },
      { server: "hubspot", toolCount: 2 },
      { server: "vanta", toolCount: 2 },
      { server: "github", unavailable: "name shadowed by the org-scoped server of the same name" },
    ]);
  });

  it("a credential that will not open, a missing one, and a secret-store outage are named outcomes, never a crash", async () => {
    const h = harness();
    await h.service.add(alice, ME(alice), { name: "vanta", url: "https://mcp.vanta.com/mcp", auth: "bearer" });
    expect(await h.service.resolveForRun("general", { userId: alice.id })).toEqual([expect.objectContaining({ spec: expect.anything() }), { name: "vanta", unavailable: "no credential stored — run `mcp connect`" }]);
    await h.service.completeTicket("nonce-00000000000000000001", justin, "tok");
    const sealed = (await h.secrets.getCredential("user:slack:UALICE/vanta"))!;
    await h.secrets.putCredential({ ...sealed, keyId: "k9" });
    expect((await h.service.resolveForRun("general", { userId: alice.id }))[1]).toEqual({ name: "vanta", unavailable: 'credential sealed under key "k9", this process holds "k1"' });
    h.secrets.getCredential = async () => {
      throw new Error("DO offline");
    };
    expect((await h.service.resolveForRun("general", { userId: alice.id }))[1]).toEqual({ name: "vanta", unavailable: "secret store: DO offline" });
  });
});

describe("McpService — OAuth (item 18)", () => {
  const VANTA = "https://mcp.vanta.com/mcp";
  const NONCE1 = "nonce-00000000000000000001";
  const startFlow = async (h: ReturnType<typeof harness>, nonce = NONCE1) => {
    const started = (await h.service.startOAuth(nonce, justin)) as { ok: true; redirectUrl: string };
    expect(started.ok).toBe(true);
    return { redirectUrl: started.redirectUrl, state: new URL(started.redirectUrl).searchParams.get("state") as string, code: h.as.issueCode(started.redirectUrl) };
  };
  const tokenFor = async (h: ReturnType<typeof harness>) => {
    const hit = (await h.service.resolveForRun("general", { userId: alice.id })).find((s) => ("spec" in s ? s.spec.name : s.name) === "vanta");
    return hit && "spec" in hit ? hit.spec.auth?.token : hit;
  };

  it("add without --auth detects it from the server: 401 + metadata → oauth with a connect link; 2xx → none; 401 without metadata → bearer; unreachable → invalid_input; an explicit --auth never probes", async () => {
    const h = harness({ oauth: { server: VANTA } });
    expect(await h.service.add(alice, ME(alice), { name: "vanta", url: VANTA })).toMatchObject({ detected: "oauth", server: { auth: "oauth", state: "awaiting_credential" }, connectUrl: `https://switchboard.test/mcp/connect/${NONCE1}` });
    expect(h.backing.document?.users[alice.id].mcpServers?.vanta.auth).toBe("oauth");
    expect(await harness({ oauth: { server: VANTA, initializeStatus: 200 } }).service.add(alice, ME(alice), { name: "vanta", url: VANTA })).toMatchObject({ detected: "none", server: { state: "connected" } });
    expect(await harness({ oauth: { server: VANTA, metadata: false } }).service.add(alice, ME(alice), { name: "vanta", url: VANTA })).toMatchObject({ detected: "bearer" });
    expect(await code(harness({ oauth: { server: VANTA, down: true } }).service.add(alice, ME(alice), { name: "vanta", url: VANTA }))).toBe("invalid_input");
    const explicit = harness({ oauth: { server: VANTA, down: true } });
    expect(await explicit.service.add(alice, ME(alice), { name: "vanta", url: VANTA, auth: "none" })).toMatchObject({ server: { auth: "none" } });
    expect(explicit.as.calls).toHaveLength(0);
    // Without a fetch wired, detection is impossible and says so.
    expect(await code(harness({ fetch: false }).service.add(alice, ME(alice), { name: "vanta", url: VANTA }))).toBe("invalid_input");
  });

  it("startOAuth: discovers, registers Switchboard as a public client, seals the PKCE record onto the ticket (now `authorizing`), returns the authorization URL; only the ticket's owner may start; a bearer server's ticket is refused", async () => {
    const h = harness({ oauth: { server: VANTA }, email: { [alice.id]: "justin@coreplane.ai" } });
    await h.service.add(alice, ME(alice), { name: "vanta", url: VANTA });
    expect(await h.service.startOAuth(NONCE1, stranger)).toMatchObject({ ok: false, refusal: { kind: "wrong_identity" } });
    const { redirectUrl } = await startFlow(h);
    const u = new URL(redirectUrl);
    expect(u.origin + u.pathname).toBe("https://as.example.com/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "client-1", redirect_uri: "https://switchboard.test/mcp/oauth/callback", code_challenge_method: "S256", resource: "https://mcp.vanta.com/mcp", scope: "mcp-api.all:write" });
    expect(u.searchParams.get("state")).toMatch(new RegExp(`^${NONCE1}\\.`));
    const ticket = await h.secrets.getTicket(NONCE1);
    expect(ticket).toMatchObject({ state: "authorizing", oauth: { keyId: "k1" } });
    expect(JSON.stringify(ticket)).not.toMatch(/code_verifier|client-1/);
    expect(h.as.registrations[0]).toMatchObject({ client_name: "Switchboard", redirect_uris: ["https://switchboard.test/mcp/oauth/callback"], client_uri: "https://switchboard.test" });
    await h.service.add(alice, ME(alice), { name: "linear", url: "https://mcp.linear.app/mcp", auth: "bearer" });
    expect(await h.service.startOAuth("nonce-00000000000000000002", justin)).toMatchObject({ ok: false, refusal: { kind: "oauth_failed", reason: expect.stringMatching(/does not sign in with OAuth/) } });
    expect(await h.service.startOAuth("nonce-00000000000000000009", justin)).toMatchObject({ ok: false, refusal: { kind: "not_found" } });
  });

  it("startOAuth failures are sentences and leave the ticket untouched", async () => {
    const h = harness({ oauth: { server: VANTA, registrationStatus: 400 } });
    await h.service.add(alice, ME(alice), { name: "vanta", url: VANTA });
    expect(await h.service.startOAuth(NONCE1, justin)).toMatchObject({ ok: false, refusal: { kind: "oauth_failed", reason: expect.stringMatching(/registration was refused/) } });
    expect((await h.secrets.getTicket(NONCE1))?.state).toBe("pending");
  });

  it("startOAuth's CAS losing is named for what happened: a ticket cancelled underneath is `cancelled`, one another start moved is `oauth_failed` asking for the button again — never `wrong_identity`, and the winner's pending record survives", async () => {
    const h = harness({ oauth: { server: VANTA } });
    await h.service.add(alice, ME(alice), { name: "vanta", url: VANTA });
    // The race: between the read and the CAS, the stored ticket changes hands.
    const raceWith = (mutate: (cur: McpTicket) => McpTicket) => {
      const real = h.secrets.transitionTicket.bind(h.secrets);
      let raced = false;
      h.secrets.transitionTicket = async (ticket, from) => {
        if (!raced) {
          raced = true;
          h.secrets.tickets.set(ticket.nonce, mutate(h.secrets.tickets.get(ticket.nonce)!));
        }
        return real(ticket, from);
      };
    };
    raceWith((cur) => ({ ...cur, state: "cancelled" }));
    expect(await h.service.startOAuth(NONCE1, justin)).toMatchObject({ ok: false, refusal: { kind: "cancelled" } });
    await h.service.connect(alice, ME(alice), "vanta");
    raceWith((cur) => ({ ...cur, state: "authorizing", oauth: { keyId: "k1", sealed: "the-other-tab" } }));
    expect(await h.service.startOAuth("nonce-00000000000000000002", justin)).toMatchObject({ ok: false, refusal: { kind: "oauth_failed", reason: expect.stringMatching(/changed while sign-in was starting/) } });
    expect(h.secrets.tickets.get("nonce-00000000000000000002")).toMatchObject({ state: "authorizing", oauth: { sealed: "the-other-tab" } });
  });

  it("completeOAuth: the owner returns with code + the exact state → code exchanged with the sealed verifier, token probed against the server, ticket claimed, credential sealed as the OAuth set; runs get the access token as a bearer", async () => {
    const h = harness({ oauth: { server: VANTA } });
    await h.service.add(alice, ME(alice), { name: "vanta", url: VANTA });
    const { state, code: c } = await startFlow(h);
    expect(await h.service.completeOAuth(justin, { state, code: c })).toMatchObject({ ok: true, toolCount: 2, server: { state: "connected" } });
    expect((await h.secrets.getTicket(NONCE1))?.state).toBe("completed");
    const sealed = await h.secrets.getCredential("user:slack:UALICE/vanta");
    expect(sealed?.sealed).toBeTruthy();
    expect(sealed!.sealed).not.toContain("at-1");
    expect(JSON.parse(await openCredential(KEY, sealed!))).toMatchObject({ kind: "oauth", accessToken: "at-1", refreshToken: "rt-1", clientId: "client-1" });
    expect(await tokenFor(h)).toBe("at-1");
    expect(h.clients.at(-1)?.spec.auth).toEqual({ type: "bearer", token: "at-1" });
    // The ticket is spent: the callback cannot run twice.
    expect(await h.service.completeOAuth(justin, { state, code: c })).toMatchObject({ ok: false, refusal: { kind: "used" } });
  });

  it("completeOAuth refusals: a stranger; a mismatched or malformed state; an `error` from the authorization server; a code the server rejects; a token the MCP server rejects — nothing stored, the ticket stays `authorizing`; a ticket that never started is `not_authorizing`", async () => {
    const h = harness({ oauth: { server: VANTA }, rejectTokens: ["at-1"] });
    await h.service.add(alice, ME(alice), { name: "vanta", url: VANTA });
    const { state, code: c } = await startFlow(h);
    expect(await h.service.completeOAuth(stranger, { state, code: c })).toMatchObject({ ok: false, refusal: { kind: "wrong_identity" } });
    expect(await h.service.completeOAuth(justin, { state: `${NONCE1}.wrong`, code: c })).toMatchObject({ ok: false, refusal: { kind: "oauth_failed", reason: expect.stringMatching(/state/) } });
    expect(await h.service.completeOAuth(justin, { state: "no-dot", code: c })).toMatchObject({ ok: false, refusal: { kind: "not_found" } });
    expect(await h.service.completeOAuth(justin, { state, error: "access_denied", errorDescription: "user cancelled" })).toMatchObject({ ok: false, refusal: { kind: "oauth_failed", reason: expect.stringMatching(/access_denied.*user cancelled/) } });
    // The state is proven before the server's error is relayed: a wrong state carrying an `error` is a state mismatch, not that error.
    expect(await h.service.completeOAuth(justin, { state: `${NONCE1}.wrong`, error: "access_denied" })).toMatchObject({ ok: false, refusal: { kind: "oauth_failed", reason: expect.stringMatching(/state/) } });
    expect(await h.service.completeOAuth(justin, { state, code: "never-issued" })).toMatchObject({ ok: false, refusal: { kind: "oauth_failed", reason: expect.stringMatching(/invalid_grant/) } });
    expect(await h.service.completeOAuth(justin, { state, code: c })).toMatchObject({ ok: false, refusal: { kind: "oauth_failed", reason: expect.stringMatching(/rejected the token/) } });
    expect(await h.secrets.getCredential("user:slack:UALICE/vanta")).toBeNull();
    expect((await h.secrets.getTicket(NONCE1))?.state).toBe("authorizing");
    await h.service.add(alice, ME(alice), { name: "other", url: VANTA, auth: "oauth" });
    expect(await h.service.completeOAuth(justin, { state: "nonce-00000000000000000002.x", code: "c" })).toMatchObject({ ok: false, refusal: { kind: "not_authorizing" } });
  });

  it("run time: a live token is used as is; inside the refresh skew it is refreshed ONCE for N concurrent runs, stored back, the cached client rebuilt; a revoked refresh token is a named `unavailable`", async () => {
    const h = harness({ oauth: { server: VANTA } });
    await h.service.add(alice, ME(alice), { name: "vanta", url: VANTA });
    const { state, code: c } = await startFlow(h);
    expect((await h.service.completeOAuth(justin, { state, code: c })).ok).toBe(true);
    expect(await tokenFor(h)).toBe("at-1");
    h.tick(3600_000 - 30_000); // inside the 60 s skew
    expect(await Promise.all([tokenFor(h), tokenFor(h), tokenFor(h)])).toEqual(["at-2", "at-2", "at-2"]);
    expect(h.as.tokenRequests.filter((r) => r.grant_type === "refresh_token")).toHaveLength(1);
    expect(JSON.parse(await openCredential(KEY, (await h.secrets.getCredential("user:slack:UALICE/vanta"))!))).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1", expiresAt: h.now() + 3600_000 });
    expect(await tokenFor(h)).toBe("at-2");
    expect(h.as.tokenRequests.filter((r) => r.grant_type === "refresh_token")).toHaveLength(1);
    h.as.revokeRefreshTokens();
    h.tick(3600_000);
    expect(await tokenFor(h)).toMatchObject({ name: "vanta", unavailable: expect.stringMatching(/invalid_grant/) });
  });

  it("a static `auth: oauth` server in config.yaml is connected the same way: `connect --scope channel` mints the link, the callback seals the channel's credential, runs in that channel get the token; a static bearer without tokenEnv cannot be connected (it is not a stored credential)", async () => {
    const h = harness({ oauth: { server: "https://mcp.vanta.com/mcp" } });
    const link = await h.service.connect(alice, CH("slack:CSTATIC"), "compliance");
    expect(link).toMatchObject({ server: { auth: "oauth", source: "config", state: "awaiting_credential" }, connectUrl: `https://switchboard.test/mcp/connect/${NONCE1}` });
    const { state, code: c } = await startFlow(h);
    expect((await h.service.completeOAuth(justin, { state, code: c })).ok).toBe(true);
    expect(await h.secrets.getCredential("channel:slack:CSTATIC/compliance")).toBeTruthy();
    const inChannel = (await h.service.resolveForRun("general", { userId: bob.id, channelId: "slack:CSTATIC" })).find((s) => "spec" in s && s.spec.name === "compliance") as { spec: McpServerSpec };
    expect(inChannel.spec.auth).toEqual({ type: "bearer", token: "at-1" });
    expect(await code(h.service.connect(admin, ORG, "github"))).toBe("invalid_input"); // tokenEnv — nothing stored to re-key
  });

  it("connect re-keys an oauth server with a fresh link; list/show report the state and never a credential; remove drops the sealed set", async () => {
    const h = harness({ oauth: { server: VANTA } });
    await h.service.add(alice, ME(alice), { name: "vanta", url: VANTA });
    expect((await h.service.connect(alice, ME(alice), "vanta")).connectUrl).toBe("https://switchboard.test/mcp/connect/nonce-00000000000000000002");
    expect((await h.service.list(alice, undefined)).find((s) => s.name === "vanta")).toMatchObject({ auth: "oauth", state: "awaiting_credential" });
    const { state, code: c } = await startFlow(h, "nonce-00000000000000000002");
    expect((await h.service.completeOAuth(justin, { state, code: c })).ok).toBe(true);
    expect(JSON.stringify(await h.service.show(alice, ME(alice), "vanta"))).not.toMatch(/at-1|rt-1|client-1/);
    await h.service.remove(alice, ME(alice), "vanta");
    expect(await h.secrets.getCredential("user:slack:UALICE/vanta")).toBeNull();
  });
});
