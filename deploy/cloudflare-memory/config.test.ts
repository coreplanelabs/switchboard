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
    expect((await post("/config/put", { key: k, document: { channels: { a: { agent: "coding" } }, users: {} }, expectedVersion: 0 })).data).toEqual({ ok: true, version: 1 });
    expect((await post("/config/get", { key: k })).data).toEqual({ document: { channels: { a: { agent: "coding" } }, users: {} }, version: 1 });
    // A writer that loaded v1 replaces it.
    expect((await post("/config/put", { key: k, document: { channels: {}, users: { u: { effort: "low" } } }, expectedVersion: 1 })).data).toEqual({ ok: true, version: 2 });
    // A writer still holding v1 (or v0) is refused and told the current version — nothing is clobbered.
    const stale = await post("/config/put", { key: k, document: { channels: {}, users: {} }, expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.data).toEqual({ error: "version conflict", version: 2 });
    expect((await post("/config/get", { key: k })).data).toEqual({ document: { channels: {}, users: { u: { effort: "low" } } }, version: 2 });
  });

  it("validates: bad key, non-object document, bad expectedVersion, oversize document; unknown route 404", async () => {
    expect((await post("/config/get", { key: "Bad Key" })).status).toBe(400);
    expect((await post("/config/put", { key: key(), document: [1], expectedVersion: 0 })).status).toBe(400);
    expect((await post("/config/put", { key: key(), document: {}, expectedVersion: -1 })).status).toBe(400);
    expect((await post("/config/put", { key: key(), document: {}, expectedVersion: 1.5 })).status).toBe(400);
    expect((await post("/config/put", { key: key(), document: { big: "x".repeat(300 * 1024) }, expectedVersion: 0 })).status).toBe(413);
    // The cap is BYTES: 100 K three-byte characters are 100 K UTF-16 code units but 300 KB.
    expect((await post("/config/put", { key: key(), document: { big: "€".repeat(100 * 1024) }, expectedVersion: 0 })).status).toBe(413);
    expect((await post("/config/put", { key: key(), document: { big: "€".repeat(80 * 1024) }, expectedVersion: 0 })).status).toBe(200);
    expect((await post("/config/nope", { key: key() })).status).toBe(404);
  });
});
