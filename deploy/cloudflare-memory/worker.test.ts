import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MemoryDO } from "./worker.ts";

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
    // `features` lets the bot's boot probe see which routes this deploy carries (#157);
    // `build` names the commit the deploy injected (features/execution.md item 13) —
    // this bundle carries no `--define`, so it must say `unknown` rather than break.
    expect(await res.json()).toEqual({
      ok: true,
      build: { commit: "unknown" },
      features: ["memory", "schedules", "runs", "config"],
    });
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
    const bad = await post("/write", {
      scopeKey: "org:a",
      records: [{ kind: "opinion", text: "x", sourceThreadKey: "t" }],
    });
    expect(bad.status).toBe(400);
    expect(String(bad.data.error)).toMatch(/kind/);
    expect((await post("/write", { scopeKey: "org:a", records: [cand("   ")] })).status).toBe(400);
    expect((await post("/write", { scopeKey: "org:a", records: [cand("x", { sourceThreadKey: 1 })] })).status).toBe(
      400,
    );
    expect((await post("/write", { scopeKey: "org:a", records: [cand("x", { keywords: "deploy" })] })).status).toBe(
      400,
    );
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
    for (const q of [
      'deploy" OR "x',
      "deploy AND NOT command",
      "deploy*",
      "(deploy)",
      "NEAR(deploy command)",
      "deploy:x",
    ]) {
      const r = await post("/retrieve", { scopeKey: s, query: q, limit: 8 });
      expect(r.status).toBe(200);
      expect((r.data.records as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("non-ASCII record text is stored and retrievable by its ASCII tokens; accented queries are inert, never errors", async () => {
    const s = scope();
    const w = await post("/write", {
      scopeKey: s,
      records: [cand("le déploiement se fait avec npm run deploy — ça marche")],
    });
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
      records: [
        cand("deploy uses npm run deploy", { keywords: ["deploy", "npm"] }),
        cand("vacation policy is 20 days"),
        cand("redeploy after a merge", { keywords: ["release"] }),
      ],
    });
    const hits = (await post("/list", { scopeKey: s, limit: 10, query: "deploy release" })).data.records as Array<
      Record<string, unknown>
    >;
    expect(hits.map((r) => r.text)).toEqual(["redeploy after a merge", "deploy uses npm run deploy"]);
    expect(hits.every((r) => r.useCount === 0 && r.lastUsedAt === undefined)).toBe(true);
    expect(
      ((await post("/list", { scopeKey: s, limit: 1, query: "deploy release" })).data.records as unknown[]).length,
    ).toBe(1);
    expect((await post("/list", { scopeKey: s, limit: 10, query: "deplo" })).data).toEqual({ records: [] }); // substring ≠ token
    expect((await post("/list", { scopeKey: s, limit: 10, query: "!!!" })).data).toEqual({ records: [] }); // no tokens
    expect((await post("/list", { scopeKey: s, limit: 10, query: 'deploy" OR 1=1 --' })).status).toBe(200); // FTS syntax inert
    await post("/forget", { scopeKey: s, id: `mem:${s}:2` });
    expect(
      (
        (await post("/list", { scopeKey: s, limit: 10, query: "deploy release" })).data.records as Array<
          Record<string, unknown>
        >
      ).map((r) => r.text),
    ).toEqual(["deploy uses npm run deploy"]);
    expect((await post("/list", { scopeKey: s, limit: 10, query: 5 })).status).toBe(400);
    expect((await post("/list", { scopeKey: s, limit: 10, query: "x".repeat(4001) })).status).toBe(400);
  });

  it("/forget soft-deletes one active record: hidden from /list, /retrieve, and dedup; row kept; second call → false", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("keep this fact"), cand("drop this fact")] });
    const f = await post("/forget", { scopeKey: s, id: `mem:${s}:1` });
    expect(f.status).toBe(200);
    expect(f.data).toEqual({ ok: true, forgotten: true });
    expect(
      ((await post("/list", { scopeKey: s, limit: 10 })).data.records as Array<Record<string, unknown>>).map(
        (r) => r.text,
      ),
    ).toEqual(["keep this fact"]);
    // "drop" is the token only the forgotten record carries ("fact" is shared with the kept one).
    expect(((await post("/retrieve", { scopeKey: s, query: "drop", limit: 8 })).data.records as unknown[]).length).toBe(
      0,
    );
    // Not a dedup target any more: restating inserts a fresh active record.
    expect((await post("/write", { scopeKey: s, records: [cand("drop this fact")] })).data).toMatchObject({
      inserted: 1,
      deduped: 0,
    });
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
    expect((await post("/forget", { scopeKey: s, id: "mem:x:0" }, { "content-type": "application/json" })).status).toBe(
      401,
    );
  });
});

describe("dedup / supersede (shared engine rules)", () => {
  it("dedups identical normalized text: bumps useCount, inserts nothing", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("the deploy command is npm run deploy")] });
    const w = await post("/write", { scopeKey: s, records: [cand("  The DEPLOY   command is npm run deploy ")] });
    expect(w.data).toMatchObject({ inserted: 0, deduped: 1 });
    const r = (await post("/retrieve", { scopeKey: s, query: "deploy", limit: 8 })).data.records as Array<
      Record<string, unknown>
    >;
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
    await post("/write", {
      scopeKey: s,
      records: [cand("stale deploy fact"), cand("the deploy command is npm run ship")],
    });
    // Correct record 0 with text identical to (unrelated) record 1.
    const w = await post("/write", {
      scopeKey: s,
      records: [cand("the deploy command is npm run ship", { supersedes: `mem:${s}:0` })],
    });
    expect(w.data).toMatchObject({ inserted: 1, deduped: 0, superseded: 1 });
    const r = (await post("/retrieve", { scopeKey: s, query: "deploy", limit: 8 })).data.records as Array<
      Record<string, unknown>
    >;
    expect(r.map((x) => x.text).sort()).toEqual([
      "the deploy command is npm run ship",
      "the deploy command is npm run ship",
    ]);
    expect(r.some((x) => x.text === "stale deploy fact")).toBe(false);
  });

  it("restating a superseded record's text creates a fresh active record (superseded rows are not dedup targets)", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("deploy v1")] });
    await post("/write", { scopeKey: s, records: [cand("deploy v2", { supersedes: `mem:${s}:0` })] });
    const w = await post("/write", { scopeKey: s, records: [cand("deploy v1")] });
    expect(w.data).toMatchObject({ inserted: 1, deduped: 0 });
    const r = (await post("/retrieve", { scopeKey: s, query: "deploy", limit: 8 })).data.records as Array<
      Record<string, unknown>
    >;
    expect(r.map((x) => x.text).sort()).toEqual(["deploy v1", "deploy v2"]);
  });
});

// Feature: features/memory.md — per-scope cap (#253): applied inside the write
// transaction; evicted rows are soft-deleted and hidden from retrieve + list.
describe("per-scope cap (#253)", () => {
  it("an over-cap write evicts the least recently used records down to the cap and reports `evicted`", async () => {
    const s = scope();
    for (const t of ["alpha note", "beta note", "gamma note"]) {
      expect((await post("/write", { scopeKey: s, records: [cand(t)], cap: 3 })).data).toMatchObject({ evicted: 0 });
    }
    // Touch alpha so beta is the least recently used.
    await post("/retrieve", { scopeKey: s, query: "alpha", limit: 8 });
    const w = await post("/write", { scopeKey: s, records: [cand("delta note"), cand("epsilon note")], cap: 3 });
    expect(w.status).toBe(200);
    expect(w.data).toMatchObject({ inserted: 2, evicted: 2 });
    const listed = ((await post("/list", { scopeKey: s, limit: 10 })).data.records as Array<Record<string, unknown>>)
      .map((r) => r.text)
      .sort();
    expect(listed).toEqual(["alpha note", "delta note", "epsilon note"]);
    expect(
      ((await post("/retrieve", { scopeKey: s, query: "beta gamma", limit: 8 })).data.records as unknown[]).length,
    ).toBe(0);
    // Evicted rows are not dedup targets: restating inserts fresh (and evicts the next LRU).
    expect((await post("/write", { scopeKey: s, records: [cand("beta note")], cap: 3 })).data).toMatchObject({
      inserted: 1,
      deduped: 0,
      evicted: 1,
    });
  });

  it("absent `cap` uses the server default (no eviction under it); bad caps are 400", async () => {
    const s = scope();
    for (let i = 0; i < 5; i++) await post("/write", { scopeKey: s, records: [cand(`note ${i}`)] });
    expect(((await post("/list", { scopeKey: s, limit: 50 })).data.records as unknown[]).length).toBe(5);
    expect((await post("/write", { scopeKey: s, records: [cand("x")], cap: 0 })).status).toBe(400);
    expect((await post("/write", { scopeKey: s, records: [cand("x")], cap: 10001 })).status).toBe(400);
    expect((await post("/write", { scopeKey: s, records: [cand("x")], cap: "5" })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Feature: features/memory.md §15/§17/§18 (#356 item 10) — SQL/FTS efficiency.
// These tests reach inside the DO (runInDurableObject) to observe what the
// route surface cannot: FTS row counts, index presence, and the exact SQL
// statements a call runs (the spySql pattern shared with runs.test.ts).
// ---------------------------------------------------------------------------

const memStub = (s: string) => env.MEMORY.get(env.MEMORY.idFromName(s));

/** Record the SQL text of every statement the instance runs from now on. */
function spySql(inst: MemoryDO): string[] {
  const seen: string[] = [];
  const real = (inst as unknown as { sql: SqlStorage }).sql;
  Object.defineProperty(inst, "sql", {
    value: { exec: (q: string, ...p: unknown[]) => (seen.push(q), real.exec(q, ...p)) },
  });
  return seen;
}

const ftsCount = (s: string) =>
  runInDurableObject(
    memStub(s),
    async (_i: MemoryDO, state) =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM records_fts`).one().n,
  );

const recordCount = (s: string) =>
  runInDurableObject(
    memStub(s),
    async (_i: MemoryDO, state) => state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM records`).one().n,
  );

type SeedRow = { seq: number; text: string; createdAt: number; lastUsedAt?: number };

/** Seed rows straight into the DO's SQLite (bypassing /write) so tests control
 *  `created_at`/`last_used_at` exactly — the levers recency ordering keys on. */
const seed = (s: string, rows: SeedRow[]) =>
  runInDurableObject(memStub(s), async (_i: MemoryDO, state) => {
    for (const r of rows) {
      const id = `mem:${s}:${r.seq}`;
      state.storage.sql.exec(
        `INSERT INTO records (id, seq, scope_key, kind, text, norm, keywords, source_thread_key, source_run_id,
                              created_at, last_used_at, use_count, confidence, supersedes, status)
         VALUES (?, ?, ?, 'fact', ?, ?, '[]', 'slack:C1:1.0', NULL, ?, ?, 0, NULL, NULL, 'active')`,
        id,
        r.seq,
        s,
        r.text,
        r.text.trim().toLowerCase().replace(/\s+/g, " "),
        r.createdAt,
        r.lastUsedAt ?? null,
      );
      state.storage.sql.exec(`INSERT INTO records_fts (id, body) VALUES (?, ?)`, id, r.text);
    }
  });

describe("retrieval + write efficiency (#356)", () => {
  it("bm25 candidate ordering rescues a relevant-but-old record that recency ordering dropped", async () => {
    const s = scope();
    const now = Date.now();
    // One strong old match (both query tokens, one of them nowhere else) plus
    // 505 recent weak matches ("deploy" only). Recency-ordered candidates at
    // any cap ≤505 never include the strong record; bm25 puts it first.
    const strong = "vibranium deploy pipeline uses vibranium keys";
    await seed(s, [{ seq: 0, text: strong, createdAt: now - 30 * 24 * 60 * 60 * 1000 }]);
    await seed(
      s,
      Array.from({ length: 505 }, (_, i) => ({
        seq: i + 1,
        text: `deploy filler note ${i} about pipelines rollouts and other routine chatter`,
        createdAt: now,
      })),
    );
    const r = await post("/retrieve", { scopeKey: s, query: "vibranium deploy", limit: 8 });
    expect(r.status).toBe(200);
    const texts = (r.data.records as Array<{ text: string }>).map((x) => x.text);
    expect(texts).toContain(strong);
    expect(texts[0]).toBe(strong); // the engine ranks it first once it is a candidate
  }, 30_000);

  it("the 50-candidate floor hands the engine every match in a small scope (bm25 decides nothing)", async () => {
    const s = scope();
    const now = Date.now();
    // 39 old, short, term-dense rows (bm25-best) + 1 new long row (bm25-worst).
    // All match "gamma" equally for the engine, whose recency term picks the
    // NEW row. With limit 1 a bare 5×limit cap would keep only bm25 favorites
    // and lose it; the floor (50) lets the whole scope through to the engine.
    const target = `gamma ${Array.from({ length: 40 }, (_, i) => `pad${i}`).join(" ")}`;
    await seed(
      s,
      Array.from({ length: 39 }, (_, i) => ({
        seq: i,
        text: `gamma gamma gamma gamma ${i}`,
        createdAt: now - 20 * 24 * 60 * 60 * 1000,
      })),
    );
    await seed(s, [{ seq: 39, text: target, createdAt: now }]);
    const r = await post("/retrieve", { scopeKey: s, query: "gamma", limit: 1 });
    expect((r.data.records as Array<{ text: string }>).map((x) => x.text)).toEqual([target]);
  });

  it("the FTS MATCH is capped at the 24 longest distinct tokens of a degenerate query", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("zzqx protocol notes")] });
    const junk = (len: number) => Array.from({ length: 29 }, (_, i) => `j${String(i).padStart(len - 1, "x")}`);
    // 29 unmatched 3-char tokens + the 8-char matching token: kept (longest) → found.
    const kept = await post("/retrieve", { scopeKey: s, query: `${junk(3).join(" ")} zzqxzzqx protocol`, limit: 8 });
    expect((kept.data.records as unknown[]).length).toBe(1);
    // 29 unmatched 6-char tokens + the 4-char matching token: dropped (shortest
    // of 30 distinct) → not a candidate. The documented trade for degenerate
    // queries; realistic queries stay under 24 distinct tokens.
    const dropped = await post("/retrieve", { scopeKey: s, query: `${junk(6).join(" ")} zzqx`, limit: 8 });
    expect(dropped.status).toBe(200);
    expect(dropped.data.records).toEqual([]);
  });

  it("the usage bump is one batched UPDATE … WHERE id IN (…), not one statement per row", async () => {
    const s = scope();
    await post("/write", {
      scopeKey: s,
      records: [cand("deploy variant one"), cand("deploy variant two"), cand("deploy variant three")],
    });
    const { seen, returned } = await runInDurableObject(memStub(s), async (inst: MemoryDO) => {
      const statements = spySql(inst);
      const records = await inst.retrieve(s, "deploy variant", 8);
      return { seen: statements, returned: records.length };
    });
    expect(returned).toBe(3);
    const bumps = seen.filter((q) => /UPDATE records SET last_used_at/.test(q));
    expect(bumps).toHaveLength(1);
    expect(bumps[0]).toMatch(/WHERE id IN \(\?, \?, \?\)/);
  });

  it("the batched bump works at MAX_LIMIT (50 ids in one statement), every returned row bumped", async () => {
    const s = scope();
    const now = Date.now();
    await seed(
      s,
      Array.from({ length: 55 }, (_, i) => ({ seq: i, text: `deploy fact ${i}`, createdAt: now - i * 1000 })),
    );
    const r = await post("/retrieve", { scopeKey: s, query: "deploy fact", limit: 50 });
    const records = r.data.records as Array<{ useCount: number; lastUsedAt?: number }>;
    expect(records).toHaveLength(50);
    expect(records.every((x) => x.useCount === 1 && typeof x.lastUsedAt === "number")).toBe(true);
  });

  it("write plans from targeted lookups (norm + supersede id), never a full-active scan under the cap", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("existing deploy fact")] });
    const { seen, counts } = await runInDurableObject(memStub(s), async (inst: MemoryDO) => {
      const statements = spySql(inst);
      const result = await inst.write(s, [
        { kind: "fact", text: "a brand new fact", sourceThreadKey: "slack:C1:1.0" },
        { kind: "fact", text: "Existing DEPLOY fact", sourceThreadKey: "slack:C1:1.0" },
        { kind: "fact", text: "a correction", sourceThreadKey: "slack:C1:1.0", supersedes: `mem:${s}:0` },
      ]);
      return { seen: statements, counts: result };
    });
    expect(counts).toMatchObject({ inserted: 2, deduped: 1, superseded: 1 });
    // The old shape loaded every active row into JS per batch; the new shape
    // reads only the rows planWrite can act on.
    const fullScans = seen.filter((q) => /SELECT \* FROM records WHERE status = 'active'\s*$/.test(q.trim()));
    expect(fullScans).toEqual([]);
    expect(seen.some((q) => /norm = \?/.test(q))).toBe(true);
    expect(seen.some((q) => /WHERE id = \? AND status = 'active'/.test(q))).toBe(true);
  });

  it("a batch's later candidate dedups against its own earlier insert", async () => {
    const s = scope();
    const w = await post("/write", { scopeKey: s, records: [cand("same fact twice"), cand("  Same   FACT twice ")] });
    expect(w.data).toMatchObject({ ok: true, inserted: 1, deduped: 1 });
    const listed = (await post("/list", { scopeKey: s, limit: 10 })).data.records as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0].useCount).toBe(1); // the dedup bump
  });

  it("a candidate with an EMPTY supersedes ('' — passes validation, falsy to planWrite) still dedups against the whole active set", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("the deploy command is npm run deploy")] });
    // planWrite branches on truthiness (engine.ts): '' means NO supersede, so
    // the dedup pool is every active row — the store's lookup branch must
    // agree, or a duplicate-text candidate inserts a second active row.
    const w = await post("/write", {
      scopeKey: s,
      records: [cand("the deploy command is npm run deploy", { supersedes: "" })],
    });
    expect(w.status).toBe(200);
    expect(w.data).toMatchObject({ ok: true, inserted: 0, deduped: 1, superseded: 0 });
    const listed = (await post("/list", { scopeKey: s, limit: 10 })).data.records as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0].useCount).toBe(1); // the dedup bump
  });

  it("dedup against duplicate-norm actives bumps the earliest (seq order), deterministically", async () => {
    const s = scope();
    // The §8 collision path is the one legitimate way two ACTIVE rows share a
    // norm: a targeted supersede whose text collides with an unrelated record.
    await post("/write", { scopeKey: s, records: [cand("stale fact"), cand("the deploy command is npm run ship")] });
    await post("/write", {
      scopeKey: s,
      records: [cand("the deploy command is npm run ship", { supersedes: `mem:${s}:0` })],
    });
    const w = await post("/write", { scopeKey: s, records: [cand("the deploy command is npm run ship")] });
    expect(w.data).toMatchObject({ inserted: 0, deduped: 1 });
    const listed = (await post("/list", { scopeKey: s, limit: 10 })).data.records as Array<{
      id: string;
      useCount: number;
    }>;
    expect(listed.find((r) => r.id === `mem:${s}:1`)?.useCount).toBe(1); // earliest duplicate took the bump
    expect(listed.find((r) => r.id === `mem:${s}:2`)?.useCount).toBe(0);
  });

  it("the schema migration adds the status-prefixed indexes (idempotent over live data)", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("any fact")] });
    const names = await runInDurableObject(memStub(s), async (_i: MemoryDO, state) =>
      state.storage.sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'records'`)
        .toArray()
        .map((r) => r.name),
    );
    expect(names).toContain("records_status_norm");
    expect(names).toContain("records_active_seq");
    expect(names).toContain("records_active_used");
  });
});

describe("FTS hygiene (#356)", () => {
  it("forget deletes the FTS row; the record row stays (soft delete)", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("keep this fact"), cand("drop this fact")] });
    expect(await ftsCount(s)).toBe(2);
    expect((await post("/forget", { scopeKey: s, id: `mem:${s}:1` })).data).toEqual({ ok: true, forgotten: true });
    expect(await ftsCount(s)).toBe(1);
    expect(await recordCount(s)).toBe(2);
    // Forgetting a non-active row again deletes nothing more.
    await post("/forget", { scopeKey: s, id: `mem:${s}:1` });
    expect(await ftsCount(s)).toBe(1);
  });

  it("supersede deletes the superseded row's FTS entry; the record row stays", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("the deploy command is npm run deploy")] });
    await post("/write", {
      scopeKey: s,
      records: [cand("the deploy command is now npm run ship", { supersedes: `mem:${s}:0` })],
    });
    expect(await ftsCount(s)).toBe(1);
    expect(await recordCount(s)).toBe(2);
  });

  it("eviction deletes evicted rows' FTS entries; the record rows stay", async () => {
    const s = scope();
    const w1 = await post("/write", {
      scopeKey: s,
      records: [cand("alpha note"), cand("beta note"), cand("gamma note")],
      cap: 3,
    });
    expect(w1.data).toMatchObject({ evicted: 0 });
    const w2 = await post("/write", { scopeKey: s, records: [cand("delta note"), cand("epsilon note")], cap: 3 });
    expect(w2.data).toMatchObject({ inserted: 2, evicted: 2 });
    expect(await ftsCount(s)).toBe(3);
    expect(await recordCount(s)).toBe(5);
  });

  it("reconciliation removes dead FTS rows (non-active or missing records) and keeps active ones", async () => {
    const s = scope();
    await post("/write", { scopeKey: s, records: [cand("live deploy fact")] });
    // Simulate pre-#356 state: a forgotten record whose FTS row survived, plus
    // an orphan FTS row with no record at all.
    await runInDurableObject(memStub(s), async (_i: MemoryDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO records (id, seq, scope_key, kind, text, norm, keywords, source_thread_key, source_run_id,
                              created_at, last_used_at, use_count, confidence, supersedes, status)
         VALUES (?, 90, ?, 'fact', 'dead deploy fact', 'dead deploy fact', '[]', 'slack:C1:1.0', NULL, ?, NULL, 0, NULL, NULL, 'forgotten')`,
        `mem:${s}:90`,
        s,
        Date.now(),
      );
      state.storage.sql.exec(`INSERT INTO records_fts (id, body) VALUES (?, 'dead deploy fact')`, `mem:${s}:90`);
      state.storage.sql.exec(`INSERT INTO records_fts (id, body) VALUES (?, 'orphan deploy fact')`, `mem:${s}:91`);
    });
    expect(await ftsCount(s)).toBe(3);
    // The constructor runs this on every DO start; here we invoke it directly
    // (the test harness cannot re-construct a live instance).
    const removed = await runInDurableObject(memStub(s), (inst: MemoryDO) => inst.reconcileFts());
    expect(removed).toBe(2);
    expect(await ftsCount(s)).toBe(1);
    // Idempotent, and the live row still matches.
    expect(await runInDurableObject(memStub(s), (inst: MemoryDO) => inst.reconcileFts())).toBe(0);
    const r = await post("/retrieve", { scopeKey: s, query: "deploy", limit: 8 });
    expect((r.data.records as Array<{ text: string }>).map((x) => x.text)).toEqual(["live deploy fact"]);
  });
});
