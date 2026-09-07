import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { McpTicket, SealedCredential } from "./registry.js";
import {
  FileMcpSecretStore,
  InMemoryMcpSecretStore,
  WorkerMcpSecretStore,
  type McpSecretStore,
} from "./secretStore.js";

// features/mcp-tools.md items 15–16: where sealed credentials and tickets live.

const sealed: SealedCredential = { serverId: "user:slack:U1/vanta", keyId: "k1", sealed: "AAAA", updatedAt: 2 };
const ticket: McpTicket = {
  nonce: "n".repeat(24),
  serverId: "user:slack:U1/vanta",
  requesterId: "slack:U1",
  createdAt: 1,
  expiresAt: Date.now() + 600_000,
  state: "pending",
};

function contract(name: string, make: () => McpSecretStore) {
  describe(name, () => {
    it("stores and returns credentials and tickets; delete reports whether something was there", async () => {
      const s = make();
      expect(await s.getCredential(sealed.serverId)).toBeNull();
      await s.putCredential(sealed);
      expect(await s.getCredential(sealed.serverId)).toEqual(sealed);
      await s.putCredential({ ...sealed, sealed: "BBBB", updatedAt: 3 });
      expect((await s.getCredential(sealed.serverId))?.sealed).toBe("BBBB"); // replace
      expect(await s.deleteCredential(sealed.serverId)).toBe(true);
      expect(await s.deleteCredential(sealed.serverId)).toBe(false);
      expect(await s.getTicket(ticket.nonce)).toBeNull();
      await s.putTicket(ticket);
      expect(await s.getTicket(ticket.nonce)).toEqual(ticket);
      // An OAuth ticket (item 18): the `authorizing` state and the sealed pending record round-trip verbatim.
      const authorizing: McpTicket = {
        ...ticket,
        state: "authorizing",
        openedBy: { sub: "cf", at: 2 },
        oauth: { keyId: "k1", sealed: "c2VhbGVk" },
      };
      await s.putTicket(authorizing);
      expect(await s.getTicket(ticket.nonce)).toEqual(authorizing);
      await s.putTicket(ticket);
      await s.putTicket({ ...ticket, state: "opened" });
      expect((await s.getTicket(ticket.nonce))?.state).toBe("opened");
      expect(typeof s.describe()).toBe("string");
    });

    it("transitionTicket is a compare-and-swap on the stored state: applied once, refused when the state moved or the ticket is unknown", async () => {
      const s = make();
      const opened: McpTicket = { ...ticket, state: "opened", openedBy: { sub: "cf-a", at: 2 } };
      expect(await s.transitionTicket(opened, "pending")).toBe(false); // nothing stored yet
      expect(await s.getTicket(ticket.nonce)).toBeNull();
      await s.putTicket(ticket);
      const other: McpTicket = { ...ticket, state: "opened", openedBy: { sub: "cf-b", at: 3 } };
      expect(await s.transitionTicket(opened, "pending")).toBe(true);
      expect(await s.transitionTicket(other, "pending")).toBe(false); // the race loser: state is no longer pending
      expect((await s.getTicket(ticket.nonce))?.openedBy?.sub).toBe("cf-a");
      const completed: McpTicket = { ...opened, state: "completed", completedBy: { sub: "cf-a", at: 4 } };
      expect(await s.transitionTicket(completed, "opened")).toBe(true);
      expect(await s.transitionTicket(completed, "opened")).toBe(false);
      expect((await s.getTicket(ticket.nonce))?.state).toBe("completed");
    });
  });
}

contract("InMemoryMcpSecretStore", () => new InMemoryMcpSecretStore());
contract(
  "FileMcpSecretStore",
  () => new FileMcpSecretStore(join(mkdtempSync(join(tmpdir(), "swb-mcp-secrets-")), "mcp-secrets.json")),
);

describe("FileMcpSecretStore", () => {
  it("sweeps tickets expired more than a day ago on write and skips malformed rows on read", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "swb-mcp-secrets-")), "s.json");
    const s = new FileMcpSecretStore(path);
    const old = { ...ticket, nonce: "o".repeat(24), expiresAt: Date.now() - 2 * 24 * 3600_000 };
    await s.putTicket(old);
    await s.putTicket(ticket);
    expect(await s.getTicket(old.nonce)).toBeNull();
    expect(await s.getTicket(ticket.nonce)).toEqual(ticket);
    expect(s.describe()).toBe(`file ${path}`);
  });
});

describe("WorkerMcpSecretStore (the ConfigDO secrets/tickets client)", () => {
  function fake(routes: Record<string, (body: Record<string, unknown>) => unknown>, status = 200) {
    const calls: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
      const handler = routes[url.pathname];
      if (!handler) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(handler(body)), { status, headers: { "content-type": "application/json" } });
    };
    return {
      calls,
      store: new WorkerMcpSecretStore({ baseUrl: "https://memory.test/", token: "tok", fetch: fetchImpl }),
    };
  }

  it("speaks the route contract with the bearer and validates every answer", async () => {
    const { calls, store } = fake({
      "/config/secrets/put": () => ({ ok: true }),
      "/config/secrets/get": () => ({ sealed }),
      "/config/secrets/delete": () => ({ ok: true, removed: false }),
      "/config/tickets/put": () => ({ ok: true }),
      "/config/tickets/get": () => ({ ticket }),
      "/config/tickets/transition": (body) => ({ ok: true, applied: body.fromState === "pending" }),
    });
    await store.putCredential(sealed);
    expect(await store.getCredential(sealed.serverId)).toEqual(sealed);
    expect(await store.deleteCredential(sealed.serverId)).toBe(false);
    await store.putTicket(ticket);
    expect(await store.getTicket(ticket.nonce)).toEqual(ticket);
    expect(await store.transitionTicket({ ...ticket, state: "opened" }, "pending")).toBe(true);
    expect(await store.transitionTicket({ ...ticket, state: "opened" }, "opened")).toBe(false);
    expect(calls.map((c) => c.path)).toEqual([
      "/config/secrets/put",
      "/config/secrets/get",
      "/config/secrets/delete",
      "/config/tickets/put",
      "/config/tickets/get",
      "/config/tickets/transition",
      "/config/tickets/transition",
    ]);
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    expect(calls[0].body).toEqual({ sealed });
    expect(calls[5].body).toEqual({ ticket: { ...ticket, state: "opened" }, fromState: "pending" });
  });

  it("a malformed answer is null, not a crash; non-2xx and transport failures throw naming the store", async () => {
    const { store } = fake({
      "/config/secrets/get": () => ({ sealed: { serverId: "x" } }),
      "/config/tickets/get": () => ({ ticket: "nope" }),
    });
    expect(await store.getCredential("x")).toBeNull();
    expect(await store.getTicket(ticket.nonce)).toBeNull();
    await expect(fake({ "/config/tickets/get": () => ({}) }, 500).store.getTicket(ticket.nonce)).rejects.toThrow(
      /MCP secret store answered HTTP 500/,
    );
    const down = new WorkerMcpSecretStore({
      baseUrl: "https://memory.test",
      token: "t",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(down.getCredential("x")).rejects.toThrow(/MCP secret store unreachable: ECONNREFUSED/);
  });
});
