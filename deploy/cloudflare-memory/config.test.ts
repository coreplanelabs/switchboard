import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Feature: features/routing-and-config.md item 12 — the ConfigDO: versioned
// runtime config documents (the bot's chat-set `overrides`). Runs in workerd
// against the real SQLite-backed Durable Object.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

let n = 0;
const key = () => `doc-${Date.now().toString(36)}-${n++}`;

async function post(path: string, body: unknown, headers: Record<string, string> = AUTH) {
  const res = await SELF.fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON: leave {}
  }
  return { status: res.status, data };
}

describe("ConfigDO routes", () => {
  it("advertises the feature; refuses unauthenticated and non-POST", async () => {
    const health = await SELF.fetch(`${BASE}/healthz`);
    expect(((await health.json()) as { features: string[] }).features).toContain("config");
    expect((await post("/config/get", { key: "overrides" }, { "content-type": "application/json" })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/config/get`, { method: "GET" })).status).toBe(405);
  });

  it("get of an unknown key is null at version 0; put creates v1, replaces to v2, and a stale expectedVersion is a 409 carrying the current version", async () => {
    const k = key();
    expect((await post("/config/get", { key: k })).data).toEqual({ document: null, version: 0 });
    expect(
      (
        await post("/config/put", {
          key: k,
          document: { channels: { a: { agent: "coding" } }, users: {} },
          expectedVersion: 0,
        })
      ).data,
    ).toEqual({ ok: true, version: 1 });
    expect((await post("/config/get", { key: k })).data).toEqual({
      document: { channels: { a: { agent: "coding" } }, users: {} },
      version: 1,
    });
    // A writer that loaded v1 replaces it.
    expect(
      (
        await post("/config/put", {
          key: k,
          document: { channels: {}, users: { u: { effort: "low" } } },
          expectedVersion: 1,
        })
      ).data,
    ).toEqual({ ok: true, version: 2 });
    // A writer still holding v1 (or v0) is refused and told the current version — nothing is clobbered.
    const stale = await post("/config/put", { key: k, document: { channels: {}, users: {} }, expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.data).toEqual({ error: "version conflict", version: 2 });
    expect((await post("/config/get", { key: k })).data).toEqual({
      document: { channels: {}, users: { u: { effort: "low" } } },
      version: 2,
    });
  });

  it("validates: bad key, non-object document, bad expectedVersion, oversize document; unknown route 404", async () => {
    expect((await post("/config/get", { key: "Bad Key" })).status).toBe(400);
    expect((await post("/config/put", { key: key(), document: [1], expectedVersion: 0 })).status).toBe(400);
    expect((await post("/config/put", { key: key(), document: {}, expectedVersion: -1 })).status).toBe(400);
    expect((await post("/config/put", { key: key(), document: {}, expectedVersion: 1.5 })).status).toBe(400);
    expect(
      (await post("/config/put", { key: key(), document: { big: "x".repeat(300 * 1024) }, expectedVersion: 0 })).status,
    ).toBe(413);
    // The cap is BYTES: 100 K three-byte characters are 100 K UTF-16 code units but 300 KB.
    expect(
      (await post("/config/put", { key: key(), document: { big: "€".repeat(100 * 1024) }, expectedVersion: 0 })).status,
    ).toBe(413);
    expect(
      (await post("/config/put", { key: key(), document: { big: "€".repeat(80 * 1024) }, expectedVersion: 0 })).status,
    ).toBe(200);
    expect((await post("/config/nope", { key: key() })).status).toBe(404);
  });
});

describe("ConfigDO secrets + tickets (features/mcp-tools.md items 15–16)", () => {
  it("put → get → delete a sealed credential; the blob is stored verbatim and never interpreted", async () => {
    const serverId = `user:slack:U${key()}/vanta`;
    const sealed = { serverId, keyId: "k1", sealed: "AAAA", updatedAt: 3 };
    expect((await post("/config/secrets/get", { serverId })).data).toEqual({ sealed: null });
    expect((await post("/config/secrets/put", { sealed })).data).toEqual({ ok: true });
    expect((await post("/config/secrets/get", { serverId })).data).toEqual({ sealed });
    await post("/config/secrets/put", { sealed: { ...sealed, sealed: "BBBB", updatedAt: 4 } });
    expect(((await post("/config/secrets/get", { serverId })).data.sealed as { sealed: string }).sealed).toBe("BBBB");
    expect((await post("/config/secrets/delete", { serverId })).data).toEqual({ ok: true, removed: true });
    expect((await post("/config/secrets/delete", { serverId })).data).toEqual({ ok: true, removed: false });
    expect((await post("/config/secrets/put", { sealed: { serverId } })).status).toBe(400);
    expect((await post("/config/secrets/get", {})).status).toBe(400);
  });

  it("tickets: put (insert or replace) → get; a bad nonce is 400; writes sweep tickets expired more than a day ago", async () => {
    const serverId = `org/${key()}`;
    const nonce = `${"t".repeat(20)}${key()}`;
    const ticket = {
      nonce,
      serverId,
      requesterId: "slack:UALICE",
      createdAt: 1,
      expiresAt: Date.now() + 600_000,
      state: "pending",
    };
    expect((await post("/config/tickets/get", { nonce })).data).toEqual({ ticket: null });
    expect((await post("/config/tickets/put", { ticket })).data).toEqual({ ok: true });
    expect((await post("/config/tickets/get", { nonce })).data).toEqual({ ticket });
    await post("/config/tickets/put", { ticket: { ...ticket, state: "opened", openedBy: { sub: "cf", at: 2 } } });
    expect(((await post("/config/tickets/get", { nonce })).data.ticket as { state: string }).state).toBe("opened");
    expect((await post("/config/tickets/put", { ticket: { nonce: "short" } })).status).toBe(400);
    expect((await post("/config/tickets/get", { nonce: "short" })).status).toBe(400);
    const old = { ...ticket, nonce: `${"o".repeat(20)}${key()}`, expiresAt: Date.now() - 2 * 24 * 3600_000 };
    await post("/config/tickets/put", { ticket: old });
    await post("/config/tickets/put", { ticket: { ...ticket, nonce: `${"r".repeat(20)}${key()}` } }); // sweeps `old`
    expect((await post("/config/tickets/get", { nonce: old.nonce })).data).toEqual({ ticket: null });
  });

  it("tickets/transition is a compare-and-swap on the stored state: applied once; the race loser sees applied=false and the row is untouched", async () => {
    const serverId = `org/${key()}`;
    const nonce = `${"c".repeat(20)}${key()}`;
    const ticket = {
      nonce,
      serverId,
      requesterId: "slack:UALICE",
      createdAt: 1,
      expiresAt: Date.now() + 600_000,
      state: "pending",
    };
    const first = { ...ticket, state: "opened", openedBy: { sub: "cf-a", at: 2 } };
    const second = { ...ticket, state: "opened", openedBy: { sub: "cf-b", at: 3 } };
    expect((await post("/config/tickets/transition", { ticket: first, fromState: "pending" })).data).toEqual({
      ok: true,
      applied: false,
    }); // unknown nonce
    await post("/config/tickets/put", { ticket });
    expect((await post("/config/tickets/transition", { ticket: first, fromState: "pending" })).data).toEqual({
      ok: true,
      applied: true,
    });
    expect((await post("/config/tickets/transition", { ticket: second, fromState: "pending" })).data).toEqual({
      ok: true,
      applied: false,
    });
    expect(
      ((await post("/config/tickets/get", { nonce })).data.ticket as { openedBy: { sub: string } }).openedBy.sub,
    ).toBe("cf-a");
    // OAuth (item 18): opened → authorizing carries the sealed pending record, opaque here; the callback then claims it.
    const authorizing = { ...first, state: "authorizing", oauth: { keyId: "k1", sealed: "c2VhbGVk" } };
    expect((await post("/config/tickets/transition", { ticket: authorizing, fromState: "opened" })).data).toEqual({
      ok: true,
      applied: true,
    });
    expect(
      ((await post("/config/tickets/get", { nonce })).data.ticket as { state: string; oauth: { sealed: string } }).oauth
        .sealed,
    ).toBe("c2VhbGVk");
    const done = { ...authorizing, state: "completed", completedBy: { sub: "cf-a", at: 4 } };
    expect((await post("/config/tickets/transition", { ticket: done, fromState: "opened" })).data).toEqual({
      ok: true,
      applied: false,
    }); // it is authorizing now
    expect((await post("/config/tickets/transition", { ticket: done, fromState: "authorizing" })).data).toEqual({
      ok: true,
      applied: true,
    });
    expect((await post("/config/tickets/transition", { ticket: done, fromState: "authorizing" })).data).toEqual({
      ok: true,
      applied: false,
    });
    expect((await post("/config/tickets/transition", { ticket: done, fromState: "done" })).status).toBe(400);
    expect(
      (await post("/config/tickets/transition", { ticket: { nonce: "short" }, fromState: "pending" })).status,
    ).toBe(400);
  });
});
