import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Feature: features/memory.md — the Memory Worker (PR3, #85): the durable
// backend behind WorkerMemoryStore. Runs in workerd against the real
// SQLite-backed Durable Object, so FTS5 + persistence are exercised for real.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

/** Unique scope per test so DO state never leaks between cases. */
let n = 0;
const scope = () => `org:test-${Date.now()}-${n++}`;

async function post(path: string, body: unknown, headers: Record<string, string> = AUTH) {
  const res = await SELF.fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON: leave {}
  }
  return { status: res.status, data, text };
}

const cand = (text: string, over: Record<string, unknown> = {}) => ({
  kind: "fact",
  text,
  sourceThreadKey: "slack:C1:1.0",
  sourceRunId: "run-1",
  ...over,
});

describe("auth + routing", () => {
  it("GET /healthz is open", async () => {
    const res = await SELF.fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses a missing, malformed, or wrong bearer with 401 and touches no data", async () => {
    const body = { scopeKey: scope(), query: "x", limit: 8 };
    expect((await post("/retrieve", body, { "content-type": "application/json" })).status).toBe(401);
    expect((await post("/retrieve", body, { ...AUTH, authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post("/retrieve", body, { ...AUTH, authorization: "Basic dGVzdA==" })).status).toBe(401);
  });

  it("unknown routes and non-POST methods are 404/405, even authenticated", async () => {
    expect((await post("/nope", {})).status).toBe(404);
    const res = await SELF.fetch(`${BASE}/retrieve`, { headers: AUTH });
    expect(res.status).toBe(405);
  });

  it("fences body size before parsing: oversized → 413, undeclared → 411, even authenticated", async () => {
    const big = JSON.stringify({ scopeKey: "org:a", records: [cand("x".repeat(600 * 1024))] });
    const res = await SELF.fetch(`${BASE}/write`, { method: "POST", headers: AUTH, body: big });
    expect(res.status).toBe(413);
    // A bodiless POST declares no Content-Length in this runtime → undeclared
    // → 411 Length Required at the fence, before the parser is ever reached.
    const empty = await SELF.fetch(`${BASE}/retrieve`, { method: "POST", headers: AUTH });
    expect(empty.status).toBe(411);
  });

  it("a streamed body with NO Content-Length is 411 — never parsed (regression: Number(null) is 0)", async () => {
    // A chunked/streamed request declares no length. Even a small, well-formed
    // body must be refused: the fence can't know its size up front and the
    // only legitimate client always declares one.
    const small = JSON.stringify({ scopeKey: scope(), query: "deploy", limit: 8 });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(small));
        c.close();
      },
    });
    const res = await SELF.fetch(`${BASE}/retrieve`, {
      method: "POST",
      headers: AUTH,
      body: stream,
      // @ts-expect-error duplex is required for streaming request bodies but not yet in lib types
      duplex: "half",
    });
    expect(res.status).toBe(411);
    // (A blank `Content-Length: ""` or a non-digit form like "0x1000"/"5e2" is
    // refused the same way in code — the fence accepts only /^\d+$/ — but fetch
    // treats Content-Length as a forbidden header and replaces it with the real
    // length, so those cases cannot be constructed from a test client.)
  });

  it("rejects malformed bodies with 400 and a reason", async () => {
    expect((await post("/retrieve", "not json")).status).toBe(400);
    expect((await post("/retrieve", { scopeKey: "", query: "x", limit: 8 })).status).toBe(400);
    expect((await post("/retrieve", { scopeKey: "has space", query: "x", limit: 8 })).status).toBe(400);
    expect((await post("/retrieve", { scopeKey: "org:a", query: "x", limit: 0 })).status).toBe(400);
    expect((await post("/retrieve", { scopeKey: "org:a", query: "x", limit: 999 })).status).toBe(400);
    expect((await post("/retrieve", { scopeKey: "org:a", query: 5, limit: 8 })).status).toBe(400);
    expect((await post("/write", { scopeKey: "org:a", records: "nope" })).status).toBe(400);
    const bad = await post("/write", { scopeKey: "org:a", records: [{ kind: "opinion", text: "x", sourceThreadKey: "t" }] });
    expect(bad.status).toBe(400);
    expect(String(bad.data.error)).toMatch(/kind/);
    expect((await post("/write", { scopeKey: "org:a", records: [cand("   ")] })).status).toBe(400);
    expect((await post("/write", { scopeKey: "org:a", records: [cand("x", { sourceThreadKey: 1 })] })).status).toBe(400);
    expect((await post("/write", { scopeKey: "org:a", records: [cand("x", { keywords: "deploy" })] })).status).toBe(400);
    expect((await post("/write", { scopeKey: "org:a", records: [cand("x".repeat(4001))] })).status).toBe(400);
  });
});

describe("write → retrieve round trip", () => {
  it("inserts minted, namespaced, active records with provenance and returns them ranked by keyword+recency", async () => {
    const s = scope();
    const w = await post("/write", {
      scopeKey: s,
      records: [
        cand("the deploy command is npm run deploy", { keywords: ["deploy", "npm"], confidence: 0.9 }),
        cand("vacation policy is 20 days"),
        { kind: "summary", text: "User asked how to deploy.", sourceThreadKey: "slack:C1:1.0" },
      ],
    });
    expect(w.status).toBe(200);
    expect(w.data).toMatchObject({ ok: true, inserted: 3, deduped: 0, superseded: 0 });

    const r = await post("/retrieve", { scopeKey: s, query: "how do we deploy", limit: 8 });
    expect(r.status).toBe(200);
    const records = r.data.records as Array<Record<string, unknown>>;
    // Shared-engine ranking: the summary hits 2 of the 4 query tokens ("how",
    // "deploy"), the fact hits 1 ("deploy"); "vacation policy" hits none and is
    // gated out.
    expect(records.map((x) => x.text)).toEqual(["User asked how to deploy.", "the deploy command is npm run deploy"]);
    const fact = records[1];
    expect(fact).toMatchObject({
      id: `mem:${s}:0`,
      scopeKey: s,
      kind: "fact",
      keywords: ["deploy", "npm"],
      sourceThreadKey: "slack:C1:1.0",
      sourceRunId: "run-1",
      confidence: 0.9,
      status: "active",
      useCount: 1, // bumped by this retrieval
    });
    expect(typeof fact.createdAt).toBe("number");
    expect(typeof fact.lastUsedAt).toBe("number");
    expect(records[0]).not.toHaveProperty("sourceRunId"); // absent stays absent, never null
    expect(records[0]).not.toHaveProperty("confidence");
  });

  it("is whole-token: a one-letter query token does not match inside a word; no query tokens → []", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("the deploy command is npm run deploy")] });
    expect((await post("/retrieve", { scopeKey: s, query: "a", limit: 8 })).data.records).toEqual([]);
    expect((await post("/retrieve", { scopeKey: s, query: "!!! ???", limit: 8 })).data.records).toEqual([]);
    expect((await post("/retrieve", { scopeKey: s, query: "COMMAND", limit: 8 })).data.records).toHaveLength(1);
  });

  it("respects the limit and bumps useCount/lastUsedAt only on returned records", async () => {
    const s = scope();
    await post("/write", {
      scopeKey: s,
      records: [cand("deploy variant one"), cand("deploy variant two"), cand("deploy variant three")],
    });
    const first = await post("/retrieve", { scopeKey: s, query: "deploy", limit: 2 });
    expect(first.data.records).toHaveLength(2);
    const all = (await post("/retrieve", { scopeKey: s, query: "deploy variant", limit: 8 })).data.records as Array<
      Record<string, unknown>
    >;
    const counts = all.map((r) => r.useCount).sort();
    expect(counts).toEqual([1, 2, 2]); // two records seen twice, one seen once
  });

  it("scopes are isolated: another scope's records are invisible", async () => {
    const a = scope();
    const b = scope();
    await post("/write", { scopeKey: a, records: [cand("deploy secret of scope a")] });
    expect((await post("/retrieve", { scopeKey: b, query: "deploy", limit: 8 })).data.records).toEqual([]);
  });

  it("special characters in the query never break the FTS match (treated as tokens, not syntax)", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("the deploy command is npm run deploy")] });
    for (const q of ['deploy" OR "x', "deploy AND NOT command", "deploy*", "(deploy)", "NEAR(deploy command)", "deploy:x"]) {
      const r = await post("/retrieve", { scopeKey: s, query: q, limit: 8 });
      expect(r.status).toBe(200);
      expect((r.data.records as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("non-ASCII record text is stored and retrievable by its ASCII tokens; accented queries are inert, never errors", async () => {
    const s = scope();
    const w = await post("/write", { scopeKey: s, records: [cand("le déploiement se fait avec npm run deploy — ça marche")] });
    expect(w.status).toBe(200);
    const hit = await post("/retrieve", { scopeKey: s, query: "npm deploy", limit: 8 });
    expect((hit.data.records as Array<Record<string, unknown>>).map((r) => r.text)).toEqual([
      "le déploiement se fait avec npm run deploy — ça marche",
    ]);
    // The engine's tokenizer is ASCII [a-z0-9]+: "déploiement" splits into "d" +
    // "ploiement", so an accented query only matches on the ASCII fragments both
    // sides share. This is the documented miss-only mismatch — no error, no
    // false-add.
    const accented = await post("/retrieve", { scopeKey: s, query: "déploiement", limit: 8 });
    expect(accented.status).toBe(200);
    expect(Array.isArray(accented.data.records)).toBe(true);
    const unrelated = await post("/retrieve", { scopeKey: s, query: "ça", limit: 8 });
    expect(unrelated.status).toBe(200);
  });

  it("concurrent writers to one scope never collide on seq and see a consistent batch result", async () => {
    const s = scope();
    const batches = Array.from({ length: 5 }, (_, b) =>
      post("/write", { scopeKey: s, records: [cand(`deploy note ${b}a`), cand(`deploy note ${b}b`)] }),
    );
    const results = await Promise.all(batches);
    for (const r of results) expect(r.data).toMatchObject({ ok: true, inserted: 2 });
    const all = (await post("/retrieve", { scopeKey: s, query: "deploy note", limit: 50 })).data.records as Array<
      Record<string, unknown>
    >;
    expect(all).toHaveLength(10);
    const ids = new Set(all.map((r) => r.id));
    expect(ids.size).toBe(10); // no duplicate ids → no seq collision
    expect([...ids].every((id) => String(id).startsWith(`mem:${s}:`))).toBe(true);
  });

  it("empty write batch is a no-op 200", async () => {
    const w = await post("/write", { scopeKey: scope(), records: [] });
    expect(w.status).toBe(200);
    expect(w.data).toMatchObject({ ok: true, inserted: 0 });
  });
});

// Feature: features/memory.md §24 (#278) — human controls: /list + /forget.
describe("list / forget (#278 human controls)", () => {
  it("/list returns the scope's ACTIVE records newest first, capped at limit, without bumping usage", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("first fact"), cand("second fact"), cand("third fact")] });
    const all = (await post("/list", { scopeKey: s, limit: 10 })).data.records as Array<Record<string, unknown>>;
    expect(all.map((r) => r.text)).toEqual(["third fact", "second fact", "first fact"]);
    expect(all.every((r) => r.useCount === 0 && r.lastUsedAt === undefined)).toBe(true);
    const two = (await post("/list", { scopeKey: s, limit: 2 })).data.records as Array<Record<string, unknown>>;
    expect(two.map((r) => r.text)).toEqual(["third fact", "second fact"]);
    expect((await post("/list", { scopeKey: scope(), limit: 10 })).data).toEqual({ records: [] });
  });

  it("/list with `query` prefilters by whole token (text or keywords), newest first, limit after filter, no usage bump; forgotten rows excluded (#293)", async () => {
    const s = scope();
    await post("/write", {
      scopeKey: s,
      records: [cand("deploy uses npm run deploy", { keywords: ["deploy", "npm"] }), cand("vacation policy is 20 days"), cand("redeploy after a merge", { keywords: ["release"] })],
    });
    const hits = (await post("/list", { scopeKey: s, limit: 10, query: "deploy release" })).data.records as Array<Record<string, unknown>>;
    expect(hits.map((r) => r.text)).toEqual(["redeploy after a merge", "deploy uses npm run deploy"]);
    expect(hits.every((r) => r.useCount === 0 && r.lastUsedAt === undefined)).toBe(true);
    expect(((await post("/list", { scopeKey: s, limit: 1, query: "deploy release" })).data.records as unknown[]).length).toBe(1);
    expect((await post("/list", { scopeKey: s, limit: 10, query: "deplo" })).data).toEqual({ records: [] }); // substring ≠ token
    expect((await post("/list", { scopeKey: s, limit: 10, query: "!!!" })).data).toEqual({ records: [] }); // no tokens
    expect((await post("/list", { scopeKey: s, limit: 10, query: 'deploy" OR 1=1 --' })).status).toBe(200); // FTS syntax inert
    await post("/forget", { scopeKey: s, id: `mem:${s}:2` });
    expect(((await post("/list", { scopeKey: s, limit: 10, query: "deploy release" })).data.records as Array<Record<string, unknown>>).map((r) => r.text)).toEqual([
      "deploy uses npm run deploy",
    ]);
    expect((await post("/list", { scopeKey: s, limit: 10, query: 5 })).status).toBe(400);
    expect((await post("/list", { scopeKey: s, limit: 10, query: "x".repeat(4001) })).status).toBe(400);
  });

  it("/forget soft-deletes one active record: hidden from /list, /retrieve, and dedup; row kept; second call → false", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("keep this fact"), cand("drop this fact")] });
    const f = await post("/forget", { scopeKey: s, id: `mem:${s}:1` });
    expect(f.status).toBe(200);
    expect(f.data).toEqual({ ok: true, forgotten: true });
    expect(((await post("/list", { scopeKey: s, limit: 10 })).data.records as Array<Record<string, unknown>>).map((r) => r.text)).toEqual([
      "keep this fact",
    ]);
    // "drop" is the token only the forgotten record carries ("fact" is shared with the kept one).
    expect(((await post("/retrieve", { scopeKey: s, query: "drop", limit: 8 })).data.records as unknown[]).length).toBe(0);
    // Not a dedup target any more: restating inserts a fresh active record.
    expect((await post("/write", { scopeKey: s, records: [cand("drop this fact")] })).data).toMatchObject({ inserted: 1, deduped: 0 });
    expect((await post("/forget", { scopeKey: s, id: `mem:${s}:1` })).data).toEqual({ ok: true, forgotten: false });
  });

  it("/forget through another scope's DO matches nothing (the DO is the scope); unknown id → false", async () => {
    const a = scope();
    const b = scope();
    await post("/write", { scopeKey: a, records: [cand("a's fact")] });
    expect((await post("/forget", { scopeKey: b, id: `mem:${a}:0` })).data).toEqual({ ok: true, forgotten: false });
    expect((await post("/forget", { scopeKey: a, id: `mem:${a}:99` })).data).toEqual({ ok: true, forgotten: false });
    expect(((await post("/list", { scopeKey: a, limit: 10 })).data.records as unknown[]).length).toBe(1);
  });

  it("validates bodies: bad limit, missing/whitespace id, bad scopeKey → 400 with a reason", async () => {
    const s = scope();
    expect((await post("/list", { scopeKey: s, limit: 0 })).status).toBe(400);
    expect((await post("/list", { scopeKey: s, limit: 51 })).status).toBe(400);
    expect((await post("/list", { scopeKey: "bad key", limit: 5 })).status).toBe(400);
    expect((await post("/forget", { scopeKey: s })).status).toBe(400);
    expect((await post("/forget", { scopeKey: s, id: "has space" })).status).toBe(400);
    expect((await post("/forget", { scopeKey: s, id: "x".repeat(201) })).status).toBe(400);
  });

  it("both routes require the bearer", async () => {
    const s = scope();
    expect((await post("/list", { scopeKey: s, limit: 5 }, { "content-type": "application/json" })).status).toBe(401);
    expect((await post("/forget", { scopeKey: s, id: "mem:x:0" }, { "content-type": "application/json" })).status).toBe(401);
  });
});

describe("dedup / supersede (shared engine rules)", () => {
  it("dedups identical normalized text: bumps useCount, inserts nothing", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("the deploy command is npm run deploy")] });
    const w = await post("/write", { scopeKey: s, records: [cand("  The DEPLOY   command is npm run deploy ")] });
    expect(w.data).toMatchObject({ inserted: 0, deduped: 1 });
    const r = (await post("/retrieve", { scopeKey: s, query: "deploy", limit: 8 })).data.records as Array<Record<string, unknown>>;
    expect(r).toHaveLength(1);
    expect(r[0].useCount).toBe(2); // dedup bump + this retrieval
  });

  it("supersede: soft-deletes the named active record (kept, invisible to retrieval) and inserts the correction", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("the deploy command is npm run deploy")] });
    const w = await post("/write", {
      scopeKey: s,
      records: [cand("the deploy command is now npm run ship", { supersedes: `mem:${s}:0` })],
    });
    expect(w.data).toMatchObject({ inserted: 1, superseded: 1 });
    const r = (await post("/retrieve", { scopeKey: s, query: "deploy command", limit: 8 })).data.records as Array<
      Record<string, unknown>
    >;
    expect(r.map((x) => x.text)).toEqual(["the deploy command is now npm run ship"]);
    expect(r[0].supersedes).toBe(`mem:${s}:0`);
  });

  it("an unknown supersedes id supersedes nothing; the record still lands", async () => {
    const s = scope();
    const w = await post("/write", { scopeKey: s, records: [cand("deploy fact", { supersedes: `mem:${s}:999` })] });
    expect(w.data).toMatchObject({ inserted: 1, superseded: 0 });
  });

  it("a targeted supersede is not swallowed by a text collision with an unrelated record", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("stale deploy fact"), cand("the deploy command is npm run ship")] });
    // Correct record 0 with text identical to (unrelated) record 1.
    const w = await post("/write", {
      scopeKey: s,
      records: [cand("the deploy command is npm run ship", { supersedes: `mem:${s}:0` })],
    });
    expect(w.data).toMatchObject({ inserted: 1, deduped: 0, superseded: 1 });
    const r = (await post("/retrieve", { scopeKey: s, query: "deploy", limit: 8 })).data.records as Array<Record<string, unknown>>;
    expect(r.map((x) => x.text).sort()).toEqual(["the deploy command is npm run ship", "the deploy command is npm run ship"]);
    expect(r.some((x) => x.text === "stale deploy fact")).toBe(false);
  });

  it("restating a superseded record's text creates a fresh active record (superseded rows are not dedup targets)", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("deploy v1")] });
    await post("/write", { scopeKey: s, records: [cand("deploy v2", { supersedes: `mem:${s}:0` })] });
    const w = await post("/write", { scopeKey: s, records: [cand("deploy v1")] });
    expect(w.data).toMatchObject({ inserted: 1, deduped: 0 });
    const r = (await post("/retrieve", { scopeKey: s, query: "deploy", limit: 8 })).data.records as Array<Record<string, unknown>>;
    expect(r.map((x) => x.text).sort()).toEqual(["deploy v1", "deploy v2"]);
  });
});
