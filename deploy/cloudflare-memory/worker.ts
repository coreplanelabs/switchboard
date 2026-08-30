import { DurableObject } from "cloudflare:workers";
import type { MemoryCandidate, MemoryRecord } from "../../src/core/memory/types.ts";
import { DEFAULT_SCOPE_CAP, mintRecord, normalizeText, planEviction, planWrite, rankRecords } from "../../src/core/memory/engine.ts";
import { tokenize } from "../../src/core/memory/scorer.ts";
import { isFrictionRunRecord, type FrictionRunRecord } from "../../src/core/frictionProposals.ts";
import { FIRING_DETAIL_MAX, isScheduleFiring, type ScheduleFiring } from "../../src/core/schedules.ts";

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
// Friction ledger routes (#84 — the durable FrictionLedger behind the bot's
// WorkerFrictionLedger, src/core/frictionLedgerWorker.ts): one FrictionDO per
// ledger key, a bounded table of run diagnoses. Same bearer, same body fence.
//   POST /friction/record {ledgerKey, record: FrictionRunRecord} → {ok:true, retained}
//   POST /friction/recent {ledgerKey, limit?, sinceMs?} → {records: FrictionRunRecord[]} (oldest first)
// Scheduled-firing routes (#244 — the record behind the /runs Scheduled panel;
// written by the bot's Worker shim after every cron firing, read by the bot's
// WorkerScheduleStore, src/core/scheduleStore.ts): ONE ScheduleDO, bounded per schedule.
//   POST /schedules/record {firing: ScheduleFiring} → {ok:true, retained}
//   POST /schedules/latest {}                       → {firings: ScheduleFiring[]} (newest per schedule)
//
// SECURITY: bearer comparison is constant-time (same helper as the resident
// Worker); an unset/empty secret grants nothing (fail closed); every body field
// is validated with size caps before it reaches storage.

export interface Env {
  MEMORY: DurableObjectNamespace<MemoryDO>;
  /** Friction ledgers (#84): one FrictionDO per ledger key (`friction:<repo>`). */
  FRICTION: DurableObjectNamespace<FrictionDO>;
  /** Scheduled firings (#244): ONE ScheduleDO (named "schedules") — the record behind the /runs Scheduled panel. */
  SCHEDULES: DurableObjectNamespace<ScheduleDO>;
  MEMORY_TOKEN?: string;
}

/** The single ScheduleDO's name — every schedule's firings live in one object. */
const SCHEDULES_OBJECT = "schedules";

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
/** Request body ceiling, checked against Content-Length before parsing. A full
 *  batch (50 × 4000-char texts + keywords + envelope) fits comfortably. */
const MAX_BODY_BYTES = 512 * 1024;

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
   *  rows.
   *
   *  Atomicity rests on two explicit facts, not on luck:
   *  1. The whole batch runs inside `transactionSync`: the read of active rows,
   *     the `MAX(seq)+1` base, and every UPDATE/INSERT commit together or not
   *     at all — an isolate evicted mid-batch can never leave a superseded row
   *     without its correction, and every statement inside is synchronous.
   *  2. A DO executes one JS turn at a time; with no `await` anywhere in this
   *     method (transactionSync forbids one) no other request on this scope can
   *     interleave between the seq read and the inserts. (Input gates are NOT
   *     the mechanism — they only fence async storage writes.)
   *  The concurrent-writers test in worker.test.ts guards both. */
  async write(
    scopeKey: string,
    candidates: MemoryCandidate[],
    cap: number = DEFAULT_SCOPE_CAP,
  ): Promise<{ inserted: number; deduped: number; superseded: number; evicted: number }> {
    const counts = { inserted: 0, deduped: 0, superseded: 0, evicted: 0 };
    if (candidates.length === 0) return counts;
    this.ctx.storage.transactionSync(() => {
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
      // Per-scope cap (#253), inside the same transaction: the batch never
      // commits with the scope over the cap. Soft delete — rows stay.
      for (const victim of planEviction(active, cap)) {
        this.sql.exec(`UPDATE records SET status = 'evicted' WHERE id = ? AND status = 'active'`, victim.id);
        victim.status = "evicted";
        counts.evicted++;
      }
    });
    return counts;
  }

  /** Human view (#278/#293): the scope's ACTIVE rows, newest first, no usage
   *  bump. With `query`, only rows an FTS token hits (the same quoted-OR MATCH
   *  as retrieve, so user text never reaches the FTS parser as syntax); a
   *  query with no tokens lists nothing. */
  async list(_scopeKey: string, limit: number, query?: string): Promise<MemoryRecord[]> {
    if (query === undefined) {
      return this.sql
        .exec<Row>(`SELECT * FROM records WHERE status = 'active' ORDER BY seq DESC LIMIT ?`, limit)
        .toArray()
        .map(toRecord);
    }
    const tokens = [...new Set(tokenize(query))];
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t}"`).join(" OR ");
    return this.sql
      .exec<Row>(
        `SELECT r.* FROM records r
           JOIN records_fts f ON f.id = r.id
          WHERE r.status = 'active' AND records_fts MATCH ?
          ORDER BY r.seq DESC
          LIMIT ?`,
        match,
        limit,
      )
      .toArray()
      .map(toRecord);
  }

  /** Human control (#278): soft-delete one ACTIVE row (`status = 'forgotten'`;
   *  the row and its provenance stay). Returns whether a row changed. The DO
   *  IS the scope, so an id from another scope simply matches nothing here. */
  async forget(_scopeKey: string, id: string): Promise<boolean> {
    const cursor = this.sql.exec(`UPDATE records SET status = 'forgotten' WHERE id = ? AND status = 'active'`, id);
    return cursor.rowsWritten > 0;
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
// Durable Object: one friction ledger per ledger key (#84)
// ---------------------------------------------------------------------------

/** Runs retained per ledger; the oldest fall off (mirrors the file ledger's default). */
const FRICTION_MAX_RUNS = 500;
/** One serialized run record — a diagnosis is a few KB; 64 KB is generous. */
const MAX_FRICTION_RECORD_CHARS = 64 * 1024;
const MAX_FRICTION_LIMIT = 1000;

type FrictionRow = { run_id: string; finished_at: number; record: string };

export class FrictionDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Idempotent schema: the record is stored verbatim as JSON (the bot's
    // FrictionRunRecord, validated on the way in); finished_at is the sort/
    // filter key. Re-recording a run id replaces it (idempotent retries).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS friction_runs (
        run_id TEXT PRIMARY KEY,
        finished_at INTEGER NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS friction_runs_finished ON friction_runs(finished_at);
    `);
  }

  /** Upsert one run, then trim to the newest FRICTION_MAX_RUNS. One sync
   *  transaction: a partial write can never leave the table over-bound or
   *  half-replaced. Returns how many runs the ledger retains. */
  async record(rec: FrictionRunRecord): Promise<number> {
    let retained = 0;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO friction_runs (run_id, finished_at, record) VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET finished_at = excluded.finished_at, record = excluded.record`,
        rec.runId,
        rec.finishedAt,
        JSON.stringify(rec),
      );
      this.sql.exec(
        `DELETE FROM friction_runs WHERE run_id IN (
           SELECT run_id FROM friction_runs ORDER BY finished_at DESC, run_id DESC LIMIT -1 OFFSET ?)`,
        FRICTION_MAX_RUNS,
      );
      retained = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM friction_runs`).one().n;
    });
    return retained;
  }

  /** Runs oldest-first, optionally at/after `sinceMs`, keeping the NEWEST `limit`. */
  async recent(opts: { limit?: number; sinceMs?: number }): Promise<FrictionRunRecord[]> {
    const rows = this.sql
      .exec<FrictionRow>(
        `SELECT run_id, finished_at, record FROM friction_runs
          WHERE finished_at >= ? ORDER BY finished_at DESC, run_id DESC LIMIT ?`,
        opts.sinceMs ?? 0,
        opts.limit ?? FRICTION_MAX_RUNS,
      )
      .toArray();
    const out: FrictionRunRecord[] = [];
    for (const row of rows.reverse()) {
      try {
        const parsed: unknown = JSON.parse(row.record);
        if (isFrictionRunRecord(parsed)) out.push(parsed);
      } catch {
        // a corrupt row is skipped, never fatal — the rest of the ledger still counts
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Scheduled firings (#244) — the durable record behind the /runs Scheduled panel
// ---------------------------------------------------------------------------

/** Firings kept per schedule; the oldest fall off. A weekly job needs ~2 years. */
const SCHEDULE_MAX_FIRINGS = 100;

type FiringRow = {
  record: string;
}

/**
 * ScheduleDO: one SQLite Durable Object holding every schedule's firings. The
 * Worker shim (deploy/cloudflare/worker.ts) appends one `ScheduleFiring` per
 * cron firing — including firings that produced NO run (misconfigured, ingress
 * error) — and the bot's /runs page reads the newest per schedule. Append-only
 * per firing (two firings at one instant are two rows; the later write is the
 * later id), bounded per schedule.
 */
export class ScheduleDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS firings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule TEXT NOT NULL,
        fired_at INTEGER NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS firings_schedule_time ON firings(schedule, fired_at DESC, id DESC);
    `);
  }

  /** Append one firing, then trim that schedule to the newest SCHEDULE_MAX_FIRINGS.
   *  One sync transaction. Returns how many firings the schedule retains. */
  async record(firing: ScheduleFiring): Promise<number> {
    let retained = 0;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO firings (schedule, fired_at, record) VALUES (?, ?, ?)`, firing.schedule, firing.firedAt, JSON.stringify(firing));
      this.sql.exec(
        `DELETE FROM firings WHERE schedule = ? AND id NOT IN (
           SELECT id FROM firings WHERE schedule = ? ORDER BY fired_at DESC, id DESC LIMIT ?)`,
        firing.schedule,
        firing.schedule,
        SCHEDULE_MAX_FIRINGS,
      );
      retained = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM firings WHERE schedule = ?`, firing.schedule).one().n;
    });
    return retained;
  }

  /** The newest firing of every schedule (by fired_at, then insertion order). */
  async latest(): Promise<ScheduleFiring[]> {
    const rows = this.sql
      .exec<FiringRow>(
        `SELECT f.record AS record FROM firings f
          WHERE f.id = (SELECT g.id FROM firings g WHERE g.schedule = f.schedule ORDER BY g.fired_at DESC, g.id DESC LIMIT 1)
          ORDER BY f.schedule`,
      )
      .toArray();
    const out: ScheduleFiring[] = [];
    for (const row of rows) {
      try {
        const parsed: unknown = JSON.parse(row.record);
        if (isScheduleFiring(parsed)) out.push(parsed);
      } catch {
        // a corrupt row is skipped, never fatal
      }
    }
    return out;
  }
}

function parseScheduleFiring(body: unknown): Validated<ScheduleFiring> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const f = (body as Record<string, unknown>).firing;
  if (!isScheduleFiring(f)) return invalid("firing must be a ScheduleFiring (schedule, firedAt, outcome[, runId, detail])");
  if (f.schedule.length > MAX_KEY_CHARS) return invalid(`firing.schedule must be at most ${MAX_KEY_CHARS} characters`);
  if (f.runId !== undefined && f.runId.length > MAX_KEY_CHARS) return invalid(`firing.runId must be at most ${MAX_KEY_CHARS} characters`);
  if (f.detail !== undefined && f.detail.length > FIRING_DETAIL_MAX) return invalid(`firing.detail must be at most ${FIRING_DETAIL_MAX} characters`);
  return { ok: true, value: f };
}

function parseFrictionRecord(body: unknown): Validated<{ ledgerKey: string; record: FrictionRunRecord }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseScopeKey(b.ledgerKey);
  if (!key.ok) return invalid(key.error.replace("scopeKey", "ledgerKey"));
  if (!isFrictionRunRecord(b.record)) return invalid("record must be a FrictionRunRecord (runId, finishedAt, diagnosis)");
  if (b.record.runId.length > MAX_KEY_CHARS) return invalid(`record.runId must be at most ${MAX_KEY_CHARS} characters`);
  if (JSON.stringify(b.record).length > MAX_FRICTION_RECORD_CHARS) {
    return invalid(`record must serialize to at most ${MAX_FRICTION_RECORD_CHARS} characters`);
  }
  return { ok: true, value: { ledgerKey: key.value, record: b.record } };
}

function parseFrictionRecent(body: unknown): Validated<{ ledgerKey: string; limit?: number; sinceMs?: number }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseScopeKey(b.ledgerKey);
  if (!key.ok) return invalid(key.error.replace("scopeKey", "ledgerKey"));
  const out: { ledgerKey: string; limit?: number; sinceMs?: number } = { ledgerKey: key.value };
  if (b.limit !== undefined) {
    if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1 || b.limit > MAX_FRICTION_LIMIT) {
      return invalid(`limit must be an integer between 1 and ${MAX_FRICTION_LIMIT}`);
    }
    out.limit = b.limit;
  }
  if (b.sinceMs !== undefined) {
    if (typeof b.sinceMs !== "number" || !Number.isFinite(b.sinceMs) || b.sinceMs < 0) return invalid("sinceMs must be a non-negative number");
    out.sinceMs = b.sinceMs;
  }
  return { ok: true, value: out };
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

function parseLimit(v: unknown): Validated<number> {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_LIMIT) {
    return invalid(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return { ok: true, value: v };
}

/** `POST /list {scopeKey, limit, query?}` (#278, #293). */
function parseList(body: unknown): Validated<{ scopeKey: string; limit: number; query?: string }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const scope = parseScopeKey(b.scopeKey);
  if (!scope.ok) return scope;
  const limit = parseLimit(b.limit);
  if (!limit.ok) return limit;
  if (b.query !== undefined) {
    if (typeof b.query !== "string") return invalid("query must be a string");
    if (b.query.length > MAX_QUERY_CHARS) return invalid(`query must be at most ${MAX_QUERY_CHARS} characters`);
  }
  return {
    ok: true,
    value: { scopeKey: scope.value, limit: limit.value, ...(typeof b.query === "string" ? { query: b.query } : {}) },
  };
}

/** `POST /forget {scopeKey, id}` (#278): the id is an opaque key, same caps as scopeKey. */
function parseForget(body: unknown): Validated<{ scopeKey: string; id: string }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const scope = parseScopeKey(b.scopeKey);
  if (!scope.ok) return scope;
  if (typeof b.id !== "string" || b.id.length === 0 || b.id.length > MAX_KEY_CHARS || /[\s\p{Cc}]/u.test(b.id)) {
    return invalid(`id must be a non-empty string of at most ${MAX_KEY_CHARS} characters with no whitespace`);
  }
  return { ok: true, value: { scopeKey: scope.value, id: b.id } };
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

/** Upper bound on a caller-supplied per-scope cap (#253). */
const MAX_SCOPE_CAP = 10_000;

function parseWrite(body: unknown): Validated<{ scopeKey: string; records: MemoryCandidate[]; cap?: number }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const scope = parseScopeKey(b.scopeKey);
  if (!scope.ok) return scope;
  let cap: number | undefined;
  if (b.cap !== undefined) {
    if (typeof b.cap !== "number" || !Number.isInteger(b.cap) || b.cap < 1 || b.cap > MAX_SCOPE_CAP) {
      return invalid(`cap must be an integer between 1 and ${MAX_SCOPE_CAP}`);
    }
    cap = b.cap;
  }
  if (!Array.isArray(b.records)) return invalid("records must be an array");
  if (b.records.length > MAX_BATCH) return invalid(`records must hold at most ${MAX_BATCH} candidates`);
  const records: MemoryCandidate[] = [];
  for (let i = 0; i < b.records.length; i++) {
    const c = parseCandidate(b.records[i], i);
    if (!c.ok) return c;
    records.push(c.value);
  }
  return { ok: true, value: { scopeKey: scope.value, records, ...(cap !== undefined ? { cap } : {}) } };
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
    const ROUTES = new Set(["/retrieve", "/write", "/list", "/forget", "/friction/record", "/friction/recent", "/schedules/record", "/schedules/latest"]);
    if (!ROUTES.has(url.pathname)) return json({ error: "not found" }, 404);
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!authorized(env, request)) return json({ error: "unauthorized" }, 401);

    // Size fence BEFORE parsing: a caller holding a valid bearer still can't
    // make us JSON-parse an oversized body just to be told 400 by the field
    // caps. Content-Length must be a plain digit string (RFC 9110) — that
    // rules out the absent header of a chunked/streamed body, a blank value,
    // and forms `Number()` would accept ("0x1000", "5e2", "12.5"); each is
    // 411 Length Required. A well-formed length over the cap is 413. Every
    // legitimate client (WorkerMemoryStore) sends a sized JSON body.
    const header = request.headers.get("content-length");
    if (header === null || !/^\d+$/.test(header.trim())) {
      return json({ error: "body must declare a numeric Content-Length" }, 411);
    }
    if (Number(header) > MAX_BODY_BYTES) {
      return json({ error: `body must be at most ${MAX_BODY_BYTES} bytes` }, 413);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "body must be valid JSON" }, 400);
    }

    if (url.pathname === "/schedules/record") {
      const parsed = parseScheduleFiring(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const firing = parsed.value;
      const retained = await env.SCHEDULES.get(env.SCHEDULES.idFromName(SCHEDULES_OBJECT)).record(firing);
      console.log(`[schedules/record] ${firing.schedule} ${firing.outcome}${firing.runId ? ` run ${firing.runId}` : ""} (${retained} retained)`);
      return json({ ok: true, retained });
    }
    if (url.pathname === "/schedules/latest") {
      const firings = await env.SCHEDULES.get(env.SCHEDULES.idFromName(SCHEDULES_OBJECT)).latest();
      console.log(`[schedules/latest] -> ${firings.length} schedules`);
      return json({ firings });
    }

    if (url.pathname === "/friction/record") {
      const parsed = parseFrictionRecord(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const { ledgerKey, record } = parsed.value;
      const retained = await env.FRICTION.get(env.FRICTION.idFromName(ledgerKey)).record(record);
      // Observability (ids + counts only, never finding text).
      console.log(`[friction/record] ${ledgerKey} <- ${record.runId} (${retained} retained)`);
      return json({ ok: true, retained });
    }
    if (url.pathname === "/friction/recent") {
      const parsed = parseFrictionRecent(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const { ledgerKey, ...opts } = parsed.value;
      const records = await env.FRICTION.get(env.FRICTION.idFromName(ledgerKey)).recent(opts);
      console.log(`[friction/recent] ${ledgerKey} -> ${records.length} runs`);
      return json({ records });
    }

    if (url.pathname === "/retrieve") {
      const parsed = parseRetrieve(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const { scopeKey, query, limit } = parsed.value;
      const stub = env.MEMORY.get(env.MEMORY.idFromName(scopeKey));
      const records = await stub.retrieve(scopeKey, query, limit);
      // Observability (counts + scopeKey only, never record content/PII): makes
      // `wrangler tail switchboard-memory` show retrieve traffic and depth.
      console.log(`[retrieve] ${scopeKey} -> ${records.length} records`);
      return json({ records });
    }

    if (url.pathname === "/list") {
      const parsed = parseList(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const { scopeKey, limit, query } = parsed.value;
      const records = await env.MEMORY.get(env.MEMORY.idFromName(scopeKey)).list(scopeKey, limit, query);
      console.log(`[list] ${scopeKey} -> ${records.length} records`);
      return json({ records });
    }
    if (url.pathname === "/forget") {
      const parsed = parseForget(body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const { scopeKey, id } = parsed.value;
      const forgotten = await env.MEMORY.get(env.MEMORY.idFromName(scopeKey)).forget(scopeKey, id);
      // Observability: scope + id only (ids carry no record text).
      console.log(`[forget] ${scopeKey} ${id} -> ${forgotten}`);
      return json({ ok: true, forgotten });
    }

    const parsed = parseWrite(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { scopeKey, records, cap } = parsed.value;
    const stub = env.MEMORY.get(env.MEMORY.idFromName(scopeKey));
    const counts = await stub.write(scopeKey, records, cap);
    // Observability (counts + scopeKey only, never record content/PII): confirms
    // the reflection write fired, how many candidates it carried, and whether
    // the per-scope cap evicted anything.
    console.log(`[write] ${scopeKey} <- ${records.length} candidates${counts.evicted > 0 ? ` (evicted ${counts.evicted})` : ""}`);
    return json({ ok: true, ...counts });
  },
} satisfies ExportedHandler<Env>;
