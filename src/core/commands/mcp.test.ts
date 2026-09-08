import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore, InMemoryOverridesBacking } from "../../config.js";
import { InMemoryMcpClient } from "../../mcp/fake.js";
import { importCredentialKey } from "../../mcp/sealed.js";
import { InMemoryMcpSecretStore } from "../../mcp/secretStore.js";
import { McpService } from "../../mcp/service.js";
import {
  CommandRegistry,
  bindCommands,
  renderText,
  type Caller,
  type CommandInvoker,
  type JsonValue,
} from "../commandRegistry.js";
import { callerWith } from "../testing/callers.js";
import { MCP_COMMANDS, MCP_OFF_MESSAGE, registerMcpCommands, type McpCommandDeps } from "./mcp.js";

// features/mcp-tools.md items 13–15: the `mcp.*` commands are thin writes into
// the config layers through the service; these tests pin the surface contract
// — gates, codes, the render text, and that no output ever carries a credential.

const ADMIN = "slack:UADMIN";
const ALICE = "slack:UALICE";
const NOBODY = "slack:UNOBODY";
const YAML = `
organization: acme
providers:
  anthropic:
    type: anthropic
defaults:
  agent: general
  models:
    general: anthropic/general-model
permissions:
  admins: ["${ADMIN}"]
  repoManagement: ["${ADMIN}"]
`;

function service() {
  const dir = mkdtempSync(join(tmpdir(), "swb-mcp-cmd-"));
  const cfg = join(dir, "config.yaml");
  writeFileSync(cfg, YAML);
  const backing = new InMemoryOverridesBacking();
  const config = new ConfigStore(cfg, { backing, initial: undefined }, () => {});
  let n = 0;
  const svc = new McpService({
    config,
    secrets: new InMemoryMcpSecretStore(),
    key: importCredentialKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    factory: () => new InMemoryMcpClient([{ name: "search", inputSchema: {}, annotations: { readOnlyHint: true } }]),
    publicBaseUrl: "https://switchboard.test",
    env: {},
    // Auth detection (item 18): every server here answers 401 without OAuth metadata → `bearer`.
    fetch: async () => new Response("", { status: 401 }),
    now: () => 1_000_000,
    nonce: () => `nonce-${String(++n).padStart(20, "0")}`,
  });
  return { svc, backing };
}

function bind(svc: McpService | { unavailable: string }): CommandInvoker {
  const registry = new CommandRegistry<McpCommandDeps>({ audit: () => {} });
  registerMcpCommands(registry);
  return bindCommands(registry, { mcp: { service: async () => svc } });
}

/** A Slack person: the open chat commands, `config:write` unless `channelConfig: false` (the
 *  `permissions.channelConfig` key present and not naming them), everything for an admin. */
const chat = (id: string, opts: { admin?: boolean; channelConfig?: boolean } = {}): Caller =>
  callerWith(
    "chat",
    id,
    opts.admin === true || id === ADMIN
      ? "all"
      : { actions: new Set(["mcp:read", "mcp:write", ...(opts.channelConfig !== false ? ["config:write"] : [])]) },
    { origin: { channelId: "slack:CX", threadKey: "slack:CX:1" } },
  );
const machine = (actions: string[]): Caller => callerWith("mcp", "mcp:svc", actions);
const cli: Caller = callerWith("cli", "cli:local", "all");

async function text(
  inv: CommandInvoker,
  id: string,
  input: { args?: unknown[]; options?: Record<string, unknown> },
  caller: Caller,
) {
  const res = await inv.invoke(id, input, caller);
  if (!res.ok) return `${res.error}: ${res.message}`;
  return renderText(inv.get(id)!, res.value);
}

describe("mcp.* commands", () => {
  it("registers five commands on the typed model", () => {
    expect(MCP_COMMANDS.map((c) => c.id)).toEqual(["mcp.list", "mcp.add", "mcp.connect", "mcp.show", "mcp.remove"]);
    expect(MCP_COMMANDS.map((c) => c.action)).toEqual(["mcp:read", "mcp:write", "mcp:write", "mcp:read", "mcp:write"]);
    // The tiers are the handler's question about `config-scope`; the command itself names no resource.
    expect(MCP_COMMANDS.every((c) => c.resource === undefined)).toBe(true);
  });

  it("MCP off → `unavailable` with the standard sentence on every command", async () => {
    const inv = bind({ unavailable: MCP_OFF_MESSAGE });
    for (const [id, input] of [
      ["mcp.list", {}],
      ["mcp.add", { args: ["a"], options: { url: "https://x.example/mcp" } }],
      ["mcp.connect", { args: ["a"] }],
      ["mcp.show", { args: ["a"] }],
      ["mcp.remove", { args: ["a"] }],
    ] as const) {
      expect(await inv.invoke(id, input, cli)).toMatchObject({
        ok: false,
        error: "unavailable",
        message: MCP_OFF_MESSAGE,
      });
    }
  });

  it("add for yourself lands in your config scope; the reply carries the one-time link and never a token; the empty list points at the command", async () => {
    const { svc, backing } = service();
    const inv = bind(svc);
    expect(await text(inv, "mcp.list", {}, chat(ALICE))).toContain(
      "No MCP servers reach your runs here. Add one for yourself with `mcp add <name> --url <url>`",
    );
    const added = await text(
      inv,
      "mcp.add",
      { args: ["vanta"], options: { url: "https://mcp.vanta.com/mcp" } },
      chat(ALICE),
    );
    expect(added).toContain("`vanta` (user) ⏳ awaiting credential");
    expect(added).toContain("agents: general, research · auth: bearer");
    expect(added).toContain(
      "open this link and paste the server's token (only you can complete it; it expires in 10 min): https://switchboard.test/mcp/connect/nonce-00000000000000000001",
    );
    expect(backing.document?.users[ALICE].mcpServers?.vanta).toMatchObject({
      url: "https://mcp.vanta.com/mcp",
      auth: "bearer",
      addedBy: ALICE,
    });
    expect(await text(inv, "mcp.list", {}, chat(ALICE))).toContain(
      "`vanta` (user) ⏳ awaiting credential — https://mcp.vanta.com/mcp",
    );
    expect(await text(inv, "mcp.list", {}, chat(NOBODY))).toContain("No MCP servers"); // another user sees nothing of alice's
  });

  it("channel and org scopes are decided by the data: channel needs the channelConfig gate, org an admin / cli / machine mcp:write; refusals name `--scope me`", async () => {
    const inv = bind(service().svc);
    const url = "https://mcp.linear.app/mcp";
    const deniedOrg = await inv.invoke(
      "mcp.add",
      { args: ["linear"], options: { url, scope: "org", auth: "none" } },
      chat(ALICE),
    );
    expect(deniedOrg).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "handler" });
    expect((deniedOrg as { message: string }).message).toContain("`--scope me`");
    expect(
      await inv.invoke(
        "mcp.add",
        { args: ["linear"], options: { url, scope: "org", auth: "none", agents: "general,coding" } },
        chat(ADMIN),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await inv.invoke(
        "mcp.add",
        { args: ["notion"], options: { url: "https://mcp.notion.so/mcp", scope: "org", auth: "none" } },
        machine(["mcp:write"]),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await inv.invoke("mcp.add", { args: ["x"], options: { url, scope: "org", auth: "none" } }, machine(["mcp:read"])),
    ).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "registry" });
    const deniedChannel = await inv.invoke(
      "mcp.add",
      { args: ["hubspot"], options: { url: "https://mcp.hubspot.com/mcp", scope: "channel", auth: "none" } },
      chat(NOBODY, { channelConfig: false }),
    );
    expect(deniedChannel).toMatchObject({ ok: false, error: "unauthorized", decidedBy: "handler" });
    expect(
      await inv.invoke(
        "mcp.add",
        { args: ["hubspot"], options: { url: "https://mcp.hubspot.com/mcp", scope: "channel", auth: "none" } },
        chat(ALICE),
      ),
    ).toMatchObject({ ok: true });
    // A machine caller must name the channel.
    expect(
      await inv.invoke(
        "mcp.add",
        { args: ["h2"], options: { url: "https://h2.example/mcp", scope: "channel", auth: "none" } },
        machine(["mcp:write"]),
      ),
    ).toMatchObject({ ok: false, error: "invalid_input" });
    // Everyone in the channel sees org + channel servers; only the right tier removes them.
    const listed = await text(inv, "mcp.list", {}, chat(NOBODY, { channelConfig: false }));
    expect(listed).toContain("`linear` (org) ✅ connected");
    expect(listed).toContain("`hubspot` (channel) ✅ connected");
    expect(await inv.invoke("mcp.remove", { args: ["linear"], options: { scope: "org" } }, chat(ALICE))).toMatchObject({
      ok: false,
      error: "unauthorized",
    });
    expect(await inv.invoke("mcp.remove", { args: ["linear"], options: { scope: "org" } }, chat(ADMIN))).toMatchObject({
      ok: true,
      value: { removed: true, name: "linear", scope: "org" },
    });
  });

  it("semantic refusals carry the service's codes; grammar refusals the registry's", async () => {
    const inv = bind(service().svc);
    expect(
      await inv.invoke(
        "mcp.add",
        { args: ["v"], options: { url: "https://x.example/mcp", agents: "coding" } },
        chat(ALICE),
      ),
    ).toMatchObject({ ok: false, error: "invalid_input", decidedBy: "handler" });
    await inv.invoke("mcp.add", { args: ["v"], options: { url: "https://x.example/mcp", auth: "none" } }, chat(ALICE));
    expect(
      await inv.invoke(
        "mcp.add",
        { args: ["v"], options: { url: "https://x.example/mcp", auth: "none" } },
        chat(ALICE),
      ),
    ).toMatchObject({ ok: false, error: "conflict" });
    expect(await inv.invoke("mcp.show", { args: ["nope"] }, chat(ALICE))).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await inv.invoke("mcp.connect", { args: ["v"] }, chat(ALICE))).toMatchObject({
      ok: false,
      error: "invalid_input",
    }); // auth none needs no credential
    expect(
      await inv.invoke("mcp.add", { args: ["Bad Name"], options: { url: "https://x.example/mcp" } }, chat(ALICE)),
    ).toMatchObject({ ok: false, error: "invalid_input", decidedBy: "registry" });
    expect(await inv.invoke("mcp.add", { args: ["ok"], options: { url: "ftp://x" } }, chat(ALICE))).toMatchObject({
      ok: false,
      error: "invalid_input",
      decidedBy: "registry",
    });
  });

  it("show renders the live probe and connect re-keys; neither carries a credential", async () => {
    const { svc } = service();
    const inv = bind(svc);
    await inv.invoke("mcp.add", { args: ["vanta"], options: { url: "https://mcp.vanta.com/mcp" } }, chat(ALICE));
    await svc.completeTicket("nonce-00000000000000000001", { sub: "cf", email: "a@b.c" }, "vanta_SECRET_token");
    const shown = await text(inv, "mcp.show", { args: ["vanta"] }, chat(ALICE));
    expect(shown).toContain("`vanta` (user) ✅ connected");
    expect(shown).toContain("Tools (1):\n  - `search` (read-only)");
    expect(shown).not.toContain("SECRET");
    const rekey = await text(inv, "mcp.connect", { args: ["vanta"] }, chat(ALICE));
    expect(rekey).toContain("https://switchboard.test/mcp/connect/nonce-00000000000000000002");
    expect(rekey).not.toContain("SECRET");
    expect(JSON.stringify(await inv.invoke("mcp.list", {}, chat(ALICE)))).not.toContain("SECRET");
  });
});

describe("mcp.* commands — the connect follow-up (settle, item 19)", () => {
  const URL_ = "https://mcp.vanta.com/mcp";
  const bindWith = (svc: McpService, sleep: (ms: number) => Promise<void>): CommandInvoker => {
    const registry = new CommandRegistry<McpCommandDeps>({ audit: () => {} });
    registerMcpCommands(registry);
    return bindCommands(registry, { mcp: { service: async () => svc, sleep } });
  };
  const settle = async (inv: CommandInvoker, id: string, value: JsonValue) => inv.settle(id, value, chat(ALICE));

  it("`mcp add` and `mcp connect` settle; a link that gets used settles to the connected sentence with the tool count", async () => {
    const { svc } = service();
    const inv = bindWith(svc, async () => {
      await svc.completeTicket("nonce-00000000000000000001", { sub: "cf", email: "a@x.example" }, "tok-1");
    });
    expect(inv.settles("mcp.add")).toBe(true);
    expect(inv.settles("mcp.connect")).toBe(true);
    expect(inv.settles("mcp.list")).toBe(false);
    const added = await inv.invoke("mcp.add", { args: ["vanta"], options: { url: URL_, auth: "bearer" } }, chat(ALICE));
    expect(added.ok).toBe(true);
    expect(await settle(inv, "mcp.add", (added as { ok: true; value: JsonValue }).value)).toEqual({
      ok: true,
      text: "✅ `vanta` is connected — 1 tool. Your runs can use it now.",
    });
  });

  it("an `auth: none` add (no link) settles to nothing; an unused link settles to the expired sentence naming `mcp connect`; a superseded link settles to nothing", async () => {
    const { svc } = service();
    const inv = bindWith(svc, async () => {});
    const none = await inv.invoke(
      "mcp.add",
      { args: ["deepwiki"], options: { url: "https://mcp.deepwiki.com/mcp", auth: "none" } },
      chat(ALICE),
    );
    expect(await settle(inv, "mcp.add", (none as { ok: true; value: JsonValue }).value)).toBeUndefined();
    const added = await inv.invoke("mcp.add", { args: ["vanta"], options: { url: URL_, auth: "bearer" } }, chat(ALICE));
    // Time passes past the TTL with the link unused (the service clock is fixed: expire the ticket by hand).
    const t = (await svc.secrets.getTicket("nonce-00000000000000000001"))!;
    await svc.secrets.putTicket({ ...t, expiresAt: 1 });
    expect(await settle(inv, "mcp.add", (added as { ok: true; value: JsonValue }).value)).toEqual({
      ok: false,
      text: "⌛ The connect link for `vanta` expired unused. `mcp connect vanta` mints a new one.",
    });
    // A newer link that did connect makes the old one's expiry silent.
    const again = await inv.invoke("mcp.connect", { args: ["vanta"] }, chat(ALICE));
    await svc.completeTicket("nonce-00000000000000000002", { sub: "cf", email: "a@x.example" }, "tok-1");
    const third = await inv.invoke("mcp.connect", { args: ["vanta"] }, chat(ALICE));
    const t3 = (await svc.secrets.getTicket("nonce-00000000000000000003"))!;
    await svc.secrets.putTicket({ ...t3, expiresAt: 1 });
    expect(await settle(inv, "mcp.connect", (third as { ok: true; value: JsonValue }).value)).toBeUndefined();
    expect(await settle(inv, "mcp.connect", (again as { ok: true; value: JsonValue }).value)).toEqual({
      ok: true,
      text: "✅ `vanta` is connected — 1 tool. Your runs can use it now.",
    });
  });
});
