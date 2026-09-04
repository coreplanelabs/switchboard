import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, InMemoryOverridesBacking } from "../config.js";
import { InMemoryMcpClient } from "./fake.js";
import { MCP_TICKET_TTL_MS } from "./registry.js";
import { importCredentialKey } from "./sealed.js";
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

function harness(opts: { key?: boolean; publicBaseUrl?: string; email?: Record<string, string>; rejectTokens?: string[]; serverDown?: boolean; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "swb-mcp-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, YAML);
  const backing = new InMemoryOverridesBacking();
  const config = new ConfigStore(cfg, { backing, initial: undefined }, () => {});
  const secrets = new InMemoryMcpSecretStore();
  let t = 1_000_000;
  let n = 0;
  const clients: Array<{ spec: McpServerSpec; client: InMemoryMcpClient }> = [];
  const service = new McpService({
    config,
    secrets,
    key: opts.key === false ? undefined : KEY,
    publicBaseUrl: opts.publicBaseUrl === undefined ? "https://switchboard.test" : opts.publicBaseUrl || undefined,
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
  return { config, backing, secrets, service, clients, tick: (ms: number) => (t += ms), now: () => t };
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
    expect(seen.map((s) => `${s.scope}/${s.name}/${s.state}/${s.source}`)).toEqual(["org/github/static/config", "channel/notion/connected/config", "user/vanta/connected/runtime"]);
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
