import { DurableObject } from "cloudflare:workers";
import type { MemoryCandidate, MemoryRecord } from "../../src/core/memory/types.ts";
import { mintRecord, normalizeText, planWrite, rankRecords } from "../../src/core/memory/engine.ts";
import { tokenize } from "../../src/core/memory/scorer.ts";

// Memory Worker: the durable backend behind the bot's WorkerMemoryStore
// (src/core/memory/workerStore.ts) — cross-session memory PR3 (#85). One
// SQLite-backed Durable Object per scopeKey (the DO name IS the scope key), so
// a scope's records live in one database that survives every bot restart
// (AGENTS.md invariant 6) and cross-scope reads are impossible by construction.
//
// The ranking and dedup/supersede rules are NOT reimplemented here: this file
// imports the pure engine from src/core/memory/ by relative path (bundled by
// wrangler), so the durable store and the in-process store run one algorithm.
// SQLite's job is persistence plus an FTS5 candidate prefilter; the engine
// re-checks whole-token relevance and orders by keyword+recency.
//
// Route surface (JSON in/out; bearer MEMORY_TOKEN on everything but /healthz):
//   POST /retrieve {scopeKey, query, limit} → {records: MemoryRecord[]}
//   POST /write    {scopeKey, records: MemoryCandidate[]} → {ok, inserted, deduped, superseded}
//   GET  /healthz  → {ok:true}  (deploy wake ping; touches no DO)
//
// SECURITY: bearer comparison is constant-time (same helper as the resident
// Worker); an unset/empty secret grants nothing (fail closed); every body field
// is validated with size caps before it reaches storage.

export interface Env {
  MEMORY: DurableObjectNamespace<MemoryDO>;
  MEMORY_TOKEN?: string;
}

/** Retrieval limit ceiling (the bot's default is 8). */
const MAX_LIMIT = 50;
/** Candidates per write batch (the reflection pass emits ≤6). */
const MAX_BATCH = 50;
const MAX_TEXT_CHARS = 4000;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_CHARS = 64;
const MAX_QUERY_CHARS = 4000;
const MAX_KEY_CHARS = 200;
/** FTS candidates handed to the engine per retrieval, most recently used first. */
const FTS_CANDIDATES = 500;

// ---------------------------------------------------------------------------
// Durable Object: one per scopeKey
// ---------------------------------------------------------------------------

/** A stored row. `keywords` is JSON text; nullable optionals are NULL. (A type
 *  alias, not an interface: SqlStorage's row constraint needs the implicit
 *  index signature only aliases get.) */
type Row = {
  id: string;
  seq: number;
  scope_key: string;
  kind: string;
  text: string;
  keywords: string;
  source_thread_key: string;
  source_run_id: string | null;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  confidence: number | null;
  supersedes: string | null;
  status: string;
};

export class MemoryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Idempotent schema. `norm` is the dedup key (normalizeText) so a dedup
    // lookup is an indexed hit; records_fts holds text + keywords for the
    // whole-token candidate prefilter (unicode61 tokenizer ≈ the engine's
    // tokenize; the engine re-verifies every hit).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        norm TEXT NOT NULL,
        keywords TEXT NOT NULL,
        source_thread_key TEXT NOT NULL,
        source_run_id TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        confidence REAL,
        supersedes TEXT,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_status_norm ON records(status, norm);
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(id UNINDEXED, body);
    `);
  }

  /** Rank the scope's active records for `query` (engine rules), bump usage on
   *  the returned ones, return them. */
  async retrieve(scopeKey: string, query: string, limit: number): Promise<MemoryRecord[]> {
    const tokens = [...new Set(tokenize(query))];
    if (tokens.length === 0) return [];
    // FTS5 MATCH with each token as a quoted phrase joined by OR: operators,
    // parentheses and colons in user text can never reach the query parser
    // because tokens are [a-z0-9]+ by construction.
    const match = tokens.map((t) => `"${t}"`).join(" OR ");
    const rows = this.sql
      .exec<Row>(
        `SELECT r.* FROM records r
           JOIN records_fts f ON f.id = r.id
          WHERE r.status = 'active' AND records_fts MATCH ?
          ORDER BY COALESCE(r.last_used_at, r.created_at) DESC
          LIMIT ?`,
        match,
        FTS_CANDIDATES,
      )
      .toArray();
    const now = Date.now();
    const ranked = rankRecords(rows.map(toRecord), query, now, limit);
    for (const r of ranked) {
      this.sql.exec(`UPDATE records SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?`, now, r.id);
      r.lastUsedAt = now;
      r.useCount += 1;
    }
    return ranked;
  }

  /** Apply the engine's write plan per candidate against the scope's ACTIVE
   *  rows. Input gates make the read-plan-write sequence atomic per DO. */
  async write(
    scopeKey: string,
    candidates: MemoryCandidate[],
  ): Promise<{ inserted: number; deduped: number; superseded: number }> {
    const counts = { inserted: 0, deduped: 0, superseded: 0 };
    if (candidates.length === 0) return counts;
    const active = this.sql.exec<Row>(`SELECT * FROM records WHERE status = 'active'`).toArray().map(toRecord);
    let seq = this.sql.exec<{ next: number }>(`SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM records`).one().next;
    const now = Date.now();
    for (const cand of candidates) {
      const plan = planWrite(active, cand, (c) => mintRecord(scopeKey, seq++, now, c));
      if (plan.action === "dedup") {
        this.sql.exec(`UPDATE records SET use_count = use_count + 1 WHERE id = ?`, plan.target.id);
        plan.target.useCount += 1;
        counts.deduped++;
        continue;
      }
      if (plan.supersede) {
        this.sql.exec(`UPDATE records SET status = 'superseded' WHERE id = ?`, plan.supersede.id);
        plan.supersede.status = "superseded";
        counts.superseded++;
      }
      const r = plan.record;
      this.sql.exec(
        `INSERT INTO records (id, seq, scope_key, kind, text, norm, keywords, source_thread_key, source_run_id,
                              created_at, last_used_at, use_count, confidence, supersedes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, 'active')`,
        r.id,
        seq - 1,
        r.scopeKey,
        r.kind,
        r.text,
        normalizeText(r.text),
        JSON.stringify(r.keywords),
        r.sourceThreadKey,
        r.sourceRunId ?? null,
        r.createdAt,
        r.confidence ?? null,
        r.supersedes ?? null,
      );
      this.sql.exec(`INSERT INTO records_fts (id, body) VALUES (?, ?)`, r.id, `${r.text} ${r.keywords.join(" ")}`);
      active.push(r); // later candidates in the batch see this one
      counts.inserted++;
    }
    return counts;
  }
}

/** Row → wire record. Optional fields are OMITTED when NULL (never `null` on
 *  the wire — the bot's record type has them as `?: T`). */
function toRecord(row: Row): MemoryRecord {
  const r: MemoryRecord = {
    id: row.id,
    scopeKey: row.scope_key,
    kind: row.kind as MemoryRecord["kind"],
    text: row.text,
    keywords: JSON.parse(row.keywords) as string[],
    sourceThreadKey: row.source_thread_key,
    createdAt: row.created_at,
    useCount: row.use_count,
    status: row.status as MemoryRecord["status"],
  };
  if (row.source_run_id !== null) r.sourceRunId = row.source_run_id;
  if (row.last_used_at !== null) r.lastUsedAt = row.last_used_at;
  if (row.confidence !== null) r.confidence = row.confidence;
  if (row.supersedes !== null) r.supersedes = row.supersedes;
  return r;
}

// ---------------------------------------------------------------------------
// Auth (mirrors the resident Worker)
// ---------------------------------------------------------------------------

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/** Constant-time byte comparison; the length early-return leaks only length. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** Fail closed: an unset/empty secret grants nothing. */
function authorized(env: Env, request: Request): boolean {
  const token = bearerToken(request);
  return !!token && !!env.MEMORY_TOKEN && timingSafeEqual(token, env.MEMORY_TOKEN);
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function invalid<T>(error: string): Validated<T> {
  return { ok: false, error };
}

/** A scope key is an opaque namespaced id (`org:coreplanelabs`): non-empty,
 *  bounded, no whitespace or control characters. */
function parseScopeKey(v: unknown): Validated<string> {
  if (typeof v !== "string" || v.length === 0) return invalid("scopeKey must be a non-empty string");
  if (v.length > MAX_KEY_CHARS) return invalid(`scopeKey must be at most ${MAX_KEY_CHARS} characters`);
  if (/[\s\p{C}]/u.test(v)) return invalid("scopeKey must not contain whitespace or control characters");
  return { ok: true, value: v };
}

function parseRetrieve(body: unknown): Validated<{ scopeKey: string; query: string; limit: number }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const scope = parseScopeKey(b.scopeKey);
  if (!scope.ok) return scope;
  if (typeof b.query !== "string") return invalid("query must be a string");
  if (b.query.length > MAX_QUERY_CHARS) return invalid(`query must be at most ${MAX_QUERY_CHARS} characters`);
  if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1 || b.limit > MAX_LIMIT) {
    return invalid(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return { ok: true, value: { scopeKey: scope.value, query: b.query, limit: b.limit } };
}

function parseCandidate(v: unknown, i: number): Validated<MemoryCandidate> {
  const at = `records[${i}]`;
  if (typeof v !== "object" || v === null) return invalid(`${at} must be an object`);
  const c = v as Record<string, unknown>;
  if (c.kind !== "fact" && c.kind !== "summary") return invalid(`${at}.kind must be "fact" or "summary"`);
  if (typeof c.text !== "string" || c.text.trim().length === 0) return invalid(`${at}.text must be a non-empty string`);
  if (c.text.length > MAX_TEXT_CHARS) return invalid(`${at}.text must be at most ${MAX_TEXT_CHARS} characters`);
  if (typeof c.sourceThreadKey !== "string" || c.sourceThreadKey.length === 0 || c.sourceThreadKey.length > MAX_KEY_CHARS) {
    return invalid(`${at}.sourceThreadKey must be a non-empty string`);
  }
  const out: MemoryCandidate = { kind: c.kind, text: c.text, sourceThreadKey: c.sourceThreadKey };
  if (c.keywords !== undefined) {
    if (
      !Array.isArray(c.keywords) ||
      c.keywords.length > MAX_KEYWORDS ||
      !c.keywords.every((k) => typeof k === "string" && k.length > 0 && k.length <= MAX_KEYWORD_CHARS)
    ) {
      return invalid(`${at}.keywords must be an array of at most ${MAX_KEYWORDS} short strings`);
    }
    out.keywords = c.keywords as string[];
  }
  if (c.sourceRunId !== undefined) {
    if (typeof c.sourceRunId !== "string" || c.sourceRunId.length > MAX_KEY_CHARS) return invalid(`${at}.sourceRunId must be a string`);
    out.sourceRunId = c.sourceRunId;
  }
  if (c.confidence !== undefined) {
    if (typeof c.confidence !== "number" || !Number.isFinite(c.confidence) || c.confidence < 0 || c.confidence > 1) {
      return invalid(`${at}.confidence must be a number in [0, 1]`);
    }
    out.confidence = c.confidence;
  }
  if (c.supersedes !== undefined) {
    if (typeof c.supersedes !== "string" || c.supersedes.length > MAX_KEY_CHARS) return invalid(`${at}.supersedes must be a string`);
    out.supersedes = c.supersedes;
  }
  return { ok: true, value: out };
}

function parseWrite(body: unknown): Validated<{ scopeKey: string; records: MemoryCandidate[] }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const scope = parseScopeKey(b.scopeKey);
  if (!scope.ok) return scope;
  if (!Array.isArray(b.records)) return invalid("records must be an array");
  if (b.records.length > MAX_BATCH) return invalid(`records must hold at most ${MAX_BATCH} candidates`);
  const records: MemoryCandidate[] = [];
  for (let i = 0; i < b.records.length; i++) {
    const c = parseCandidate(b.records[i], i);
    if (!c.ok) return c;
    records.push(c.value);
  }
  return { ok: true, value: { scopeKey: scope.value, records } };
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true });
    if (url.pathname !== "/retrieve" && url.pathname !== "/write") return json({ error: "not found" }, 404);
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!authorized(env, request)) return json({ error: "unauthorized" }, 401);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "body must be valid JSON" }, 400);
    }

    if (url.pathname === "/retrieve") {
      const parsed = parseRetrieve(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const { scopeKey, query, limit } = parsed.value;
      const stub = env.MEMORY.get(env.MEMORY.idFromName(scopeKey));
      return json({ records: await stub.retrieve(scopeKey, query, limit) });
    }

    const parsed = parseWrite(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { scopeKey, records } = parsed.value;
    const stub = env.MEMORY.get(env.MEMORY.idFromName(scopeKey));
    const counts = await stub.write(scopeKey, records);
    return json({ ok: true, ...counts });
  },
} satisfies ExportedHandler<Env>;
