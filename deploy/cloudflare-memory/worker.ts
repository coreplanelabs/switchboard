import { DurableObject } from "cloudflare:workers";
import type { MemoryCandidate, MemoryRecord } from "../../src/core/memory/types.ts";
import { DEFAULT_SCOPE_CAP, mintRecord, normalizeText, planEviction, planWrite, rankRecords } from "../../src/core/memory/engine.ts";
import { tokenize } from "../../src/core/memory/scorer.ts";
import { isFrictionRunRecord, type FrictionRunRecord } from "../../src/core/frictionProposals.ts";
import { FIRING_DETAIL_MAX, isScheduleFiring, type ScheduleFiring } from "../../src/core/schedules.ts";
import {
  applyRetention,
  clampRetentionPolicy,
  isRunRecord,
  isRunVisibilityFilter,
  normalizeStored,
  RUN_EVENTS_DEFAULT_PAGE,
  RUN_EVENTS_MAX_PAGE,
  RUN_ID_PATTERN,
  clampListLimit,
  RUN_LIST_MAX_LIMIT,
  sameStoredVersion,
  storedEventSeqs,
  utf8ByteLength,
  type RetentionPolicy,
  type RunListItem,
  type RunListOptions,
  type RunRecord,
  type RunVisibilityFilter,
  type StoredRunEvent,
} from "../../src/core/runRecord.ts";
import type { RunEvent } from "../../src/core/runEvents.ts";
import { isMcpTicket, isSealedCredential, MCP_TICKET_STATES, type McpTicket, type McpTicketState, type SealedCredential } from "../../src/mcp/registry.ts";
import { injectedBuildStamp } from "../../src/deploy/buildStamp.ts";

/** The commit this bundle was built from, injected by the deploy
 *  (`deploy/bin/build-stamp.mjs`) and answered on GET /healthz as `build`. */
const BUILD = injectedBuildStamp();

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
// Run history routes (#157 — the durable RunStore behind the bot's
// WorkerRunStore, src/core/runStoreWorker.ts): one RunHistoryDO per store key,
// owning the retention policy (KTD5). Same bearer; /runs/put has its own 2 MiB
// body fence (a record is budgeted to 1.5 MiB upstream), every other route
// keeps the 512 KB one.
//   POST /runs/put    {storeKey, record, policy?, policyUpdatedAt?} → {ok, retained, stored, rewritten}
//   POST /runs/get    {storeKey, id} → {record: RunRecord | null}      (unknown/expired: null, 200)
//   POST /runs/list   {storeKey, limit?, before?, beforeId?, sinceMs?, agent?, channel?}
//                       → {items: RunListItem[], nextBefore?: {finishedAt, id}}   (cursor = the last row's list key)
//   POST /runs/events {storeKey, id, afterSeq?, limit?} → {events: (RunEvent & {seq})[] | null, nextAfterSeq?}
//                       (`events: null` when the run is unknown or hidden by retention; `seq` is the registry's stamp)
//   POST /runs/delete {storeKey, id} → {ok: true, deleted}
//   GET  /healthz → {ok: true, build: {commit, builtAt?}, features: ["memory", "friction", "schedules", "runs", "config"]}
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
  /** Run history (#157): one RunHistoryDO per store key (`runs:default`). */
  RUNS: DurableObjectNamespace<RunHistoryDO>;
  /** Runtime config documents (routing-and-config item 12): ONE ConfigDO (named "config"). */
  CONFIG: DurableObjectNamespace<ConfigDO>;
  MEMORY_TOKEN?: string;
}

/** The single ConfigDO's name. */
const CONFIG_OBJECT = "config";
/** A config document key: short, lowercase, like `overrides`. */
const CONFIG_KEY_RE = /^[a-z][a-z0-9-]{0,63}$/;

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
/** FTS candidate pool per retrieval: ~5× the requested limit gives the engine's
 *  re-rank slack to disagree with bm25, and the floor hands the engine EVERY
 *  match in a scope with ≤50 hits — small scopes rank exactly as the engine
 *  alone decides. Was a flat 500 recency-ordered rows; ordering candidates by
 *  bm25 instead means a relevant-but-old record can no longer be starved out
 *  of the pool by recent weak matches (#356 item 10). */
const FTS_CANDIDATES_PER_LIMIT = 5;
const FTS_CANDIDATES_FLOOR = 50;
/** MATCH terms per query: the N longest distinct tokens (ties by first
 *  appearance). A 4000-char query would otherwise become a several-hundred-term
 *  OR the FTS index must union on every retrieval; longer tokens are the
 *  selective ones — the `[a-z0-9]+` tokenizer's 1–3-char tokens are mostly
 *  stopwords ("a", "the", "to"). Realistic queries have far fewer distinct
 *  tokens and are untouched; the engine still ranks with the FULL query, so the
 *  cap only shapes which rows can become candidates (#356 item 10). */
const MAX_MATCH_TOKENS = 24;
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
    // Idempotent schema — CREATE … IF NOT EXISTS is this DO's one migration
    // path, re-applied on every start and safe over live data. `norm` is the
    // dedup key (normalizeText) so a dedup lookup is an indexed hit;
    // records_active_seq serves list()'s newest-first page and
    // records_active_used the status-prefixed scans (active count, eviction
    // fetch) (#356 item 10); records_fts holds text + keywords for the
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
      CREATE INDEX IF NOT EXISTS records_active_seq ON records(status, seq DESC);
      CREATE INDEX IF NOT EXISTS records_active_used ON records(status, last_used_at DESC, created_at DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(id UNINDEXED, body);
    `);
    this.reconcileFts();
  }

  /** Reconcile records_fts down to exactly the active rows. Forget, supersede,
   *  and evict delete their FTS entry inline; this is the one-time cleanup of
   *  the dead rows deploys before #356 left behind, kept on every start as a
   *  self-healing invariant. Idempotent, and O(active rows) once clean (the
   *  scan is over the FTS table, which then holds only active rows — bounded by
   *  the scope cap), so it stays cheap forever. Returns rows removed. */
  reconcileFts(): number {
    return this.sql.exec(`DELETE FROM records_fts WHERE id NOT IN (SELECT id FROM records WHERE status = 'active')`)
      .rowsWritten;
  }

  /** Rank the scope's active records for `query` (engine rules), bump usage on
   *  the returned ones, return them. */
  async retrieve(scopeKey: string, query: string, limit: number): Promise<MemoryRecord[]> {
    const match = ftsMatchExpr(query);
    if (match === null) return [];
    // Candidates ordered by bm25 (best match first — fts5's bm25() is
    // more-negative-is-better, so ascending), NOT by recency: recency ordering
    // let recent weak matches starve a relevant-but-old record out of the pool
    // before the engine ever saw it. bm25 only chooses which rows reach the
    // engine; the shared rankRecords still decides the final order — one
    // algorithm with the in-process store (#356 item 10).
    const rows = this.sql
      .exec<Row>(
        `SELECT r.* FROM records r
           JOIN records_fts f ON f.id = r.id
          WHERE r.status = 'active' AND records_fts MATCH ?
          ORDER BY bm25(records_fts)
          LIMIT ?`,
        match,
        Math.max(FTS_CANDIDATES_FLOOR, limit * FTS_CANDIDATES_PER_LIMIT),
      )
      .toArray();
    const now = Date.now();
    const ranked = rankRecords(rows.map(toRecord), query, now, limit);
    if (ranked.length > 0) {
      // One batched usage bump for the returned set (ids are server-minted and
      // parameterized; at most MAX_LIMIT of them), not a statement per row.
      this.sql.exec(
        `UPDATE records SET last_used_at = ?, use_count = use_count + 1 WHERE id IN (${ranked.map(() => "?").join(", ")})`,
        now,
        ...ranked.map((r) => r.id),
      );
      for (const r of ranked) {
        r.lastUsedAt = now;
        r.useCount += 1;
      }
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
      let seq = this.sql.exec<{ next: number }>(`SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM records`).one().next;
      const now = Date.now();
      for (const cand of candidates) {
        // Targeted lookups, never a full-active scan (#356 item 10): planWrite
        // only ever inspects (a) the active row `supersedes` names — its
        // supersede target AND its whole dedup pool — or (b) the active rows
        // whose norm equals the candidate's (the dedup key, an indexed hit on
        // records_status_norm; ordered by seq so with duplicate-norm actives —
        // the engine's collision case — the earliest still takes the dedup
        // bump, exactly as the full-set scan did). Reads inside transactionSync
        // see the batch's own earlier inserts and flips, so later candidates
        // still dedup/supersede against them. The branch matches planWrite's
        // own TRUTHINESS test: `supersedes: ""` passes validation but means NO
        // supersede to the engine, so it must dedup against the norm pool —
        // an `!== undefined` branch here would hand it an empty pool and
        // insert a duplicate active row.
        const relevant = (
          cand.supersedes
            ? this.sql.exec<Row>(`SELECT * FROM records WHERE id = ? AND status = 'active'`, cand.supersedes)
            : this.sql.exec<Row>(
                `SELECT * FROM records WHERE status = 'active' AND norm = ? ORDER BY seq`,
                normalizeText(cand.text),
              )
        )
          .toArray()
          .map(toRecord);
        const plan = planWrite(relevant, cand, (c) => mintRecord(scopeKey, seq++, now, c));
        if (plan.action === "dedup") {
          this.sql.exec(`UPDATE records SET use_count = use_count + 1 WHERE id = ?`, plan.target.id);
          counts.deduped++;
          continue;
        }
        if (plan.supersede) {
          this.sql.exec(`UPDATE records SET status = 'superseded' WHERE id = ?`, plan.supersede.id);
          // Soft delete for the record row, hard delete for its FTS entry: a
          // superseded row must stop matching queries at the source (#356).
          this.sql.exec(`DELETE FROM records_fts WHERE id = ?`, plan.supersede.id);
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
        counts.inserted++;
      }
      // Per-scope cap (#253), inside the same transaction: the batch never
      // commits with the scope over the cap. Soft delete — rows stay (their
      // FTS entries do not, #356). The full active set is fetched only when
      // the indexed COUNT says the scope is over the cap — the common
      // under-cap batch does no full scan (#356 item 10).
      const activeCount = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM records WHERE status = 'active'`).one().n;
      if (activeCount > cap) {
        const active = this.sql.exec<Row>(`SELECT * FROM records WHERE status = 'active'`).toArray().map(toRecord);
        for (const victim of planEviction(active, cap)) {
          this.sql.exec(`UPDATE records SET status = 'evicted' WHERE id = ? AND status = 'active'`, victim.id);
          this.sql.exec(`DELETE FROM records_fts WHERE id = ?`, victim.id);
          counts.evicted++;
        }
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
    const match = ftsMatchExpr(query);
    if (match === null) return [];
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
    return this.ctx.storage.transactionSync(() => {
      const flipped = this.sql.exec(`UPDATE records SET status = 'forgotten' WHERE id = ? AND status = 'active'`, id).rowsWritten > 0;
      // Soft delete for the record row, hard delete for its FTS entry (#356):
      // one sync transaction, so no crash can strand a dead FTS row (and the
      // start-time reconciliation would heal it anyway).
      if (flipped) this.sql.exec(`DELETE FROM records_fts WHERE id = ?`, id);
      return flipped;
    });
  }
}

/** Build the FTS5 MATCH expression for a query: each engine token (`[a-z0-9]+`
 *  by construction) quoted and OR-joined, so operators, parentheses and colons
 *  in user text can never reach the FTS query parser as syntax. At most the
 *  MAX_MATCH_TOKENS longest distinct tokens are used (see the constant's note);
 *  `null` when the query has no tokens. Shared by retrieve and list — the one
 *  place user text becomes a MATCH. */
function ftsMatchExpr(query: string): string | null {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return null;
  const kept =
    tokens.length <= MAX_MATCH_TOKENS
      ? tokens
      : tokens
          .map((t, i) => [t, i] as const)
          .sort((a, b) => b[0].length - a[0].length || a[1] - b[1])
          .slice(0, MAX_MATCH_TOKENS)
          .map(([t]) => t);
  return kept.map((t) => `"${t}"`).join(" OR ");
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

// ---------------------------------------------------------------------------
// Durable Object: runtime config documents (features/routing-and-config.md item
// 10). ONE object, a table of small JSON documents by key — today the bot's
// `overrides` document (chat-set channel/user settings) — each with a version
// for optimistic concurrency: a `put` whose `expectedVersion` is stale is a 409,
// never a silent clobber (the bot and the CLI both write this document).

export class ConfigDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secrets (
        server_id TEXT PRIMARY KEY,
        sealed TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tickets (
        nonce TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        ticket TEXT NOT NULL
      );
    `);
  }

  // ---- MCP sealed credentials + connect tickets (features/mcp-tools.md items 15–16).
  // Ciphertext the bot sealed — opaque here — and one-time tickets: the two
  // things a config document must never carry, kept beside it on this object.

  async putSecret(sealed: SealedCredential): Promise<void> {
    this.sql.exec(`INSERT OR REPLACE INTO secrets (server_id, sealed) VALUES (?, ?)`, sealed.serverId, JSON.stringify(sealed));
  }

  async getSecret(serverId: string): Promise<SealedCredential | null> {
    const row = this.sql.exec<{ sealed: string }>(`SELECT sealed FROM secrets WHERE server_id = ?`, serverId).toArray()[0];
    return row ? parseStored(row.sealed, isSealedCredential) : null;
  }

  async deleteSecret(serverId: string): Promise<boolean> {
    const had = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM secrets WHERE server_id = ?`, serverId).one().n;
    this.sql.exec(`DELETE FROM secrets WHERE server_id = ?`, serverId);
    return had > 0;
  }

  /** Insert or replace; tickets expired more than a day ago are swept on every write. */
  async putTicket(ticket: McpTicket, now: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT OR REPLACE INTO tickets (nonce, server_id, expires_at, ticket) VALUES (?, ?, ?, ?)`, ticket.nonce, ticket.serverId, ticket.expiresAt, JSON.stringify(ticket));
      this.sql.exec(`DELETE FROM tickets WHERE expires_at < ?`, now - 24 * 3600_000);
    });
  }

  async getTicket(nonce: string): Promise<McpTicket | null> {
    const row = this.sql.exec<{ ticket: string }>(`SELECT ticket FROM tickets WHERE nonce = ?`, nonce).toArray()[0];
    return row ? parseStored(row.ticket, isMcpTicket) : null;
  }

  /** Compare-and-swap: write `ticket` only while the stored row is still in
   *  `fromState`. One transaction on a single-threaded object, so of two
   *  concurrent opens/completions exactly one is applied — "single-use" is a
   *  property of the store, not of request timing. */
  async transitionTicket(ticket: McpTicket, fromState: McpTicketState): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec<{ ticket: string }>(`SELECT ticket FROM tickets WHERE nonce = ?`, ticket.nonce).toArray()[0];
      const stored = row ? parseStored(row.ticket, isMcpTicket) : null;
      if (!stored || stored.state !== fromState) return false;
      this.sql.exec(`UPDATE tickets SET server_id = ?, expires_at = ?, ticket = ? WHERE nonce = ?`, ticket.serverId, ticket.expiresAt, JSON.stringify(ticket), ticket.nonce);
      return true;
    });
  }

  async get(key: string): Promise<{ document: unknown; version: number }> {
    const row = this.sql.exec<{ version: number; body: string }>(`SELECT version, body FROM documents WHERE key = ?`, key).toArray()[0];
    if (!row) return { document: null, version: 0 };
    try {
      return { document: JSON.parse(row.body) as unknown, version: row.version };
    } catch {
      return { document: null, version: row.version };
    }
  }

  /** Replace the document iff its stored version equals `expectedVersion`
   *  (0 = not yet stored). Returns the new version, or the current one on conflict. */
  async put(key: string, document: unknown, expectedVersion: number, now: number): Promise<{ ok: true; version: number } | { ok: false; version: number }> {
    let outcome: { ok: true; version: number } | { ok: false; version: number } = { ok: false, version: 0 };
    this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec<{ version: number }>(`SELECT version FROM documents WHERE key = ?`, key).toArray()[0];
      const current = row?.version ?? 0;
      if (current !== expectedVersion) {
        outcome = { ok: false, version: current };
        return;
      }
      const next = current + 1;
      this.sql.exec(`INSERT OR REPLACE INTO documents (key, version, body, updated_at) VALUES (?, ?, ?, ?)`, key, next, JSON.stringify(document), now);
      outcome = { ok: true, version: next };
    });
    return outcome;
  }
}

function parseStored<T>(text: string, guard: (v: unknown) => v is T): T | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Documents are small; a body over this is refused before storage. */
const MAX_CONFIG_DOCUMENT_BYTES = 256 * 1024;

const CONFIG_ROUTES = new Set(["/config/get", "/config/put", "/config/secrets/put", "/config/secrets/get", "/config/secrets/delete", "/config/tickets/put", "/config/tickets/get", "/config/tickets/transition"]);
const TICKET_STATES: ReadonlySet<string> = new Set<McpTicketState>(MCP_TICKET_STATES);

async function handleConfig(pathname: string, body: unknown, env: Env): Promise<Response> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const dO = env.CONFIG.get(env.CONFIG.idFromName(CONFIG_OBJECT));
  // MCP secrets + tickets (opaque to this Worker beyond shape).
  switch (pathname) {
    case "/config/secrets/put": {
      if (!isSealedCredential(b.sealed)) return json({ error: "sealed must be a SealedCredential" }, 400);
      await dO.putSecret(b.sealed);
      console.log(`[config/secrets/put] ${b.sealed.serverId} key=${b.sealed.keyId}`);
      return json({ ok: true });
    }
    case "/config/secrets/get": {
      if (typeof b.serverId !== "string" || !b.serverId) return json({ error: "serverId required" }, 400);
      return json({ sealed: await dO.getSecret(b.serverId) });
    }
    case "/config/secrets/delete": {
      if (typeof b.serverId !== "string" || !b.serverId) return json({ error: "serverId required" }, 400);
      return json({ ok: true, removed: await dO.deleteSecret(b.serverId) });
    }
    case "/config/tickets/put": {
      if (!isMcpTicket(b.ticket)) return json({ error: "ticket must be an McpTicket" }, 400);
      await dO.putTicket(b.ticket, Date.now());
      console.log(`[config/tickets/put] ${b.ticket.serverId} state=${b.ticket.state}`);
      return json({ ok: true });
    }
    case "/config/tickets/get": {
      if (typeof b.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(b.nonce)) return json({ error: "nonce malformed" }, 400);
      return json({ ticket: await dO.getTicket(b.nonce) });
    }
    case "/config/tickets/transition": {
      if (!isMcpTicket(b.ticket)) return json({ error: "ticket must be an McpTicket" }, 400);
      if (typeof b.fromState !== "string" || !TICKET_STATES.has(b.fromState)) return json({ error: "fromState must be a ticket state" }, 400);
      const applied = await dO.transitionTicket(b.ticket, b.fromState as McpTicketState);
      console.log(`[config/tickets/transition] ${b.ticket.serverId} ${b.fromState}→${b.ticket.state} applied=${applied}`);
      return json({ ok: true, applied });
    }
    default:
      break;
  }
  if (typeof b.key !== "string" || !CONFIG_KEY_RE.test(b.key)) return json({ error: "key must be a short lowercase slug" }, 400);
  if (pathname === "/config/get") {
    return json(await dO.get(b.key));
  }
  if (pathname === "/config/put") {
    if (typeof b.document !== "object" || b.document === null || Array.isArray(b.document)) return json({ error: "document must be a JSON object" }, 400);
    if (typeof b.expectedVersion !== "number" || !Number.isInteger(b.expectedVersion) || b.expectedVersion < 0) return json({ error: "expectedVersion must be a non-negative integer" }, 400);
    if (new TextEncoder().encode(JSON.stringify(b.document)).byteLength > MAX_CONFIG_DOCUMENT_BYTES) return json({ error: `document must be at most ${MAX_CONFIG_DOCUMENT_BYTES} bytes` }, 413);
    const out = await dO.put(b.key, b.document, b.expectedVersion, Date.now());
    if (!out.ok) return json({ error: "version conflict", version: out.version }, 409);
    console.log(`[config/put] ${b.key} v${out.version}`);
    return json({ ok: true, version: out.version });
  }
  return json({ error: "not found" }, 404);
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
  const key = parseScopeKey(b.ledgerKey, "ledgerKey");
  if (!key.ok) return key;
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
  const key = parseScopeKey(b.ledgerKey, "ledgerKey");
  if (!key.ok) return key;
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
// Durable Object: one run history per store key (#157)
// ---------------------------------------------------------------------------

// Cloudflare Durable Object SQLite limits (developers.cloudflare.com/durable-objects/platform/limits/,
// read 2026-08-29): 100 bound parameters per query; 100 KB per SQL statement;
// 2 MB per string/BLOB/row; 100 columns per table; 10 GB storage per object
// (Workers Paid). Consequences here: event inserts carry 3 parameters per row,
// so a batch is 33 rows (99 parameters); deletions by id list are batched at
// 100 ids; an event is capped to 64 KiB upstream (MAX_EVENT_BYTES) so no row
// nears 2 MB; and `maxBytes` is clamped to 8 GiB (RETENTION_BOUNDS), under the
// 10 GB per-object ceiling.
const DO_MAX_BOUND_PARAMETERS = 100;
/** Rows per `INSERT INTO run_events` statement: floor(100 / 3 parameters). */
export const RUN_EVENT_INSERT_BATCH = Math.floor(DO_MAX_BOUND_PARAMETERS / 3);
/** Ids per `DELETE ... WHERE run_id IN (...)` statement. */
const RUN_DELETE_BATCH = DO_MAX_BOUND_PARAMETERS;
/** Rows a single `put` may delete while trimming (deletion fence, KTD5): a
 *  policy shrink dropping thousands of runs is spread over successive puts and
 *  the 6 h alarm, so no single write stalls. Reads hide them immediately. */
const RUN_TRIM_FENCE = 500;
/** How often `alarm()` sweeps everything outside policy (KTD5). */
const RUN_SWEEP_INTERVAL_MS = 6 * 3600_000;
/** `finishedAt` further ahead of the DO clock than this is clamped (a skewed bot clock). */
const RUN_MAX_FUTURE_MS = 24 * 3600_000;
/** Request body ceiling for `/runs/put` (a record is budgeted to 1.5 MiB upstream). */
const MAX_RUN_PUT_BODY_BYTES = 2 * 1024 * 1024;
const POLICY_KEY = "policy";

type RunRow = {
  run_id: string;
  agent: string | null;
  channel_id: string | null;
  finished_at: number;
  bytes: number;
  event_count: number;
  summary_json: string;
};

interface StoredPolicy {
  policy: RetentionPolicy;
  policyUpdatedAt: number;
}

export interface RunPolicyProposal {
  policy: Partial<RetentionPolicy>;
  policyUpdatedAt: number;
}

/** What retention needs from a `runs` row. */
type RetentionRow = { run_id: string; finished_at: number; bytes: number };

export class RunHistoryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Idempotent schema. `runs` carries the listing columns plus the record
    // minus its events as JSON (`summary_json`, what `list` returns); events
    // live one per row keyed (run_id, seq) so a 5000-event run is paged, never
    // loaded whole to answer a listing. `meta` holds the persisted policy.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        label TEXT,
        agent TEXT,
        model TEXT,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        channel_visibility TEXT NOT NULL DEFAULT 'unknown',
        repo TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        stored_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        stored_event_count INTEGER NOT NULL,
        truncated INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        diagnosis_json TEXT NOT NULL,
        summary_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_finished ON runs(finished_at);
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // The one column migration this DO has (authorization KTD7): a table
    // created before the visibility stamp gains the column with `unknown` for
    // every existing row — so a run written before the stamp is never public.
    // Then the indexes the visibility predicate's leaves walk (`channel_id IN`,
    // `channel_visibility IN`, `user_id =`), each ordered like the page.
    const columns = new Set(this.sql.exec<{ name: string }>(`PRAGMA table_info(runs)`).toArray().map((c) => c.name));
    if (!columns.has("channel_visibility")) this.sql.exec(`ALTER TABLE runs ADD COLUMN channel_visibility TEXT NOT NULL DEFAULT 'unknown'`);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS runs_channel_finished ON runs(channel_id, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_visibility_finished ON runs(channel_visibility, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_user_finished ON runs(user_id, finished_at DESC, run_id DESC);
    `);
  }

  // ---- policy ---------------------------------------------------------------

  /** The persisted policy (defaults until the first proposal lands). */
  policyState(): StoredPolicy {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, POLICY_KEY).toArray()[0];
    if (!row) return { policy: clampRetentionPolicy({}), policyUpdatedAt: 0 };
    try {
      const parsed = JSON.parse(row.value) as Partial<RetentionPolicy> & { policyUpdatedAt?: number };
      const at = typeof parsed.policyUpdatedAt === "number" && Number.isFinite(parsed.policyUpdatedAt) ? parsed.policyUpdatedAt : 0;
      return { policy: clampRetentionPolicy(parsed), policyUpdatedAt: at };
    } catch {
      return { policy: clampRetentionPolicy({}), policyUpdatedAt: 0 };
    }
  }

  /** Accept a proposal only when strictly newer than the stored one; its stamp
   *  is clamped to the DO clock so a skewed proposer cannot lock the policy. */
  private applyProposal(proposal: RunPolicyProposal, now: number): StoredPolicy {
    const current = this.policyState();
    const stamp = Math.min(proposal.policyUpdatedAt, now);
    if (stamp <= current.policyUpdatedAt) return current;
    const next: StoredPolicy = { policy: clampRetentionPolicy(proposal.policy), policyUpdatedAt: stamp };
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      POLICY_KEY,
      JSON.stringify({ ...next.policy, policyUpdatedAt: next.policyUpdatedAt }),
    );
    return next;
  }

  // ---- retention ------------------------------------------------------------

  /** The ids the policy keeps among `rows`, computed by the ONE shared
   *  retention function over each row's (id, finishedAt, bytes). */
  private static keptIds(rows: readonly RetentionRow[], policy: RetentionPolicy, now: number): Set<string> {
    const kept = applyRetention(
      rows.map((r) => ({ id: r.run_id, finishedAt: r.finished_at, bytes: r.bytes })),
      policy,
      now,
    );
    return new Set(kept.map((r) => r.id));
  }

  /** Every row, oldest first (`finished_at ASC, run_id ASC`) — the deletion order. */
  private retentionRows(): RetentionRow[] {
    return this.sql.exec<RetentionRow>(`SELECT run_id, finished_at, bytes FROM runs ORDER BY finished_at ASC, run_id ASC`).toArray();
  }

  /**
   * Whether ONE row is kept, without materializing the table — the same answer
   * `applyRetention` gives for it, decided in its order: (1) finished before
   * the `retentionDays` cutoff → out; (2) rows ranked ahead of it (newest
   * first: `finished_at DESC, run_id DESC`, among those inside the cutoff) must
   * number fewer than `maxRuns`; (3) their bytes plus its own must fit
   * `maxBytes` (bytes are non-negative, so the cumulative total is monotone and
   * "the first row over the budget and everything after it" reduces to this one
   * inequality). Ids are ASCII (`RUN_ID_PATTERN`), so SQLite's binary `run_id`
   * order is the JS string order `newestFirst` uses.
   */
  private isKept(row: RetentionRow, policy: RetentionPolicy, now: number): boolean {
    const cutoff = now - policy.retentionDays * 86_400_000;
    if (row.finished_at < cutoff) return false;
    const ahead = this.sql
      .exec<{ n: number; b: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM runs
          WHERE finished_at >= ? AND (finished_at > ? OR (finished_at = ? AND run_id > ?))`,
        cutoff,
        row.finished_at,
        row.finished_at,
        row.run_id,
      )
      .one();
    return ahead.n < policy.maxRuns && ahead.b + row.bytes <= policy.maxBytes;
  }

  private deleteRuns(ids: readonly string[]): void {
    for (let i = 0; i < ids.length; i += RUN_DELETE_BATCH) {
      const batch = ids.slice(i, i + RUN_DELETE_BATCH);
      const marks = batch.map(() => "?").join(",");
      this.sql.exec(`DELETE FROM run_events WHERE run_id IN (${marks})`, ...batch);
      this.sql.exec(`DELETE FROM runs WHERE run_id IN (${marks})`, ...batch);
    }
  }

  /** Delete rows outside policy, oldest first, at most `fence` of them (all
   *  when `fence` is undefined). `first`, when outside policy, is always
   *  deleted — the record just written must not survive its own put as a
   *  hidden row. One scan of `runs` feeds both the kept set and the deletion
   *  order. Returns how many rows were deleted and the kept ids — which are
   *  exactly the rows retained after the delete: the kept set is the newest
   *  prefix of the age-filtered order, and only rows outside it were removed,
   *  so re-running retention on what remains selects the same rows. */
  private trim(policy: RetentionPolicy, now: number, fence: number | undefined, first?: string): { deleted: number; kept: Set<string> } {
    const rows = this.retentionRows();
    const kept = RunHistoryDO.keptIds(rows, policy, now);
    const outside = rows.map((r) => r.run_id).filter((id) => !kept.has(id) && id !== first);
    const firstDoomed = first !== undefined && !kept.has(first);
    const doomed = firstDoomed ? [first, ...outside] : outside;
    const victims = fence === undefined ? doomed : doomed.slice(0, Math.max(fence, firstDoomed ? 1 : 0));
    this.deleteRuns(victims);
    if (victims.length < doomed.length) console.log(`[runs/trim] deletion fence: ${victims.length} of ${doomed.length} rows outside policy deleted this put`);
    return { deleted: victims.length, kept };
  }

  // ---- writes ---------------------------------------------------------------

  /** Upsert one record and trim, in ONE sync transaction (see MemoryDO.write for
   *  why this is atomic and un-interleavable). Event rows are rewritten only
   *  when the stored version changed (`event_count`, `finished_at`, `bytes`) —
   *  an identical retry is a no-op on `run_events`. `stored: false` when the
   *  record itself fell outside the (possibly just-updated) policy: it was
   *  written and deleted in the same transaction, so nothing of it remains. */
  async put(record: RunRecord, proposal?: RunPolicyProposal): Promise<{ ok: true; retained: number; stored: boolean; rewritten: boolean }> {
    let result = { ok: true as const, retained: 0, stored: false, rewritten: false };
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const policy = proposal ? this.applyProposal(proposal, now).policy : this.policyState().policy;
      const finishedAt = Math.min(record.finishedAt, now + RUN_MAX_FUTURE_MS);
      const stored: RunRecord = { ...record, finishedAt };
      const { events, ...summary } = stored;
      const bytes = utf8ByteLength(JSON.stringify(stored));
      const existing = this.sql
        .exec<{ event_count: number; finished_at: number; bytes: number }>(`SELECT event_count, finished_at, bytes FROM runs WHERE run_id = ?`, record.id)
        .toArray()[0];
      const unchanged =
        existing !== undefined &&
        sameStoredVersion({ eventCount: existing.event_count, finishedAt: existing.finished_at, bytes: existing.bytes }, { eventCount: stored.eventCount, finishedAt, bytes });
      this.sql.exec(
        `INSERT INTO runs (run_id, label, agent, model, channel_id, user_id, thread_key, channel_visibility, repo, started_at, finished_at, stored_at, status,
                           event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           label = excluded.label, agent = excluded.agent, model = excluded.model, channel_id = excluded.channel_id,
           user_id = excluded.user_id, thread_key = excluded.thread_key, channel_visibility = excluded.channel_visibility,
           repo = excluded.repo, started_at = excluded.started_at,
           finished_at = excluded.finished_at, stored_at = excluded.stored_at, status = excluded.status,
           event_count = excluded.event_count, stored_event_count = excluded.stored_event_count, truncated = excluded.truncated,
           bytes = excluded.bytes, diagnosis_json = excluded.diagnosis_json, summary_json = excluded.summary_json`,
        stored.id,
        stored.label ?? null,
        stored.agent ?? null,
        stored.model ?? null,
        stored.channelId,
        stored.userId,
        stored.threadKey,
        stored.channelVisibility ?? "unknown",
        stored.repo ?? null,
        stored.startedAt,
        finishedAt,
        now,
        stored.status,
        stored.eventCount,
        stored.storedEventCount,
        stored.truncated ? 1 : 0,
        bytes,
        JSON.stringify(stored.diagnosis),
        JSON.stringify(summary),
      );
      if (!unchanged) {
        this.sql.exec(`DELETE FROM run_events WHERE run_id = ?`, record.id);
        const seqs = storedEventSeqs(events); // the registry's stamps (see runRecord.ts)
        for (let i = 0; i < events.length; i += RUN_EVENT_INSERT_BATCH) {
          const batch = events.slice(i, i + RUN_EVENT_INSERT_BATCH);
          const params: (string | number)[] = [];
          batch.forEach((e, j) => params.push(record.id, seqs[i + j], JSON.stringify(e)));
          this.sql.exec(`INSERT INTO run_events (run_id, seq, json) VALUES ${batch.map(() => "(?, ?, ?)").join(",")}`, ...params);
        }
      }
      // The just-written row is either kept or was deleted by the trim (it is
      // always `first`), so kept membership IS whether it is still stored.
      const { kept } = this.trim(policy, now, RUN_TRIM_FENCE, record.id);
      result = { ok: true, retained: kept.size, stored: kept.has(record.id), rewritten: existing !== undefined && !unchanged };
    });
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + RUN_SWEEP_INTERVAL_MS);
    return result;
  }

  /** Remove a run and its events. Returns whether a run row existed. */
  async delete(id: string): Promise<boolean> {
    let deleted = false;
    this.ctx.storage.transactionSync(() => {
      deleted = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE run_id = ?`, id).one().n === 1;
      this.deleteRuns([id]);
    });
    return deleted;
  }

  /** Every 6 h: delete everything outside policy (no fence — this is where a
   *  large shrink finishes), sweep orphaned events, then re-arm. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const { policy } = this.policyState();
    let deleted = 0;
    this.ctx.storage.transactionSync(() => {
      deleted = this.trim(policy, now, undefined).deleted;
      // Orphan sweep: events whose run is gone (defensive — `deleteRuns` pairs
      // the two deletes, so this is a periodic check, not a per-put cost).
      this.sql.exec(`DELETE FROM run_events WHERE run_id NOT IN (SELECT run_id FROM runs)`);
    });
    console.log(`[runs/alarm] swept ${deleted} rows outside policy`);
    await this.ctx.storage.setAlarm(now + RUN_SWEEP_INTERVAL_MS);
  }

  // ---- reads ----------------------------------------------------------------

  /** The record with its events in seq order, each carrying the `seq` it is
   *  stored under (the registry's stamp — see `eventSeqs`), or null when
   *  unknown or outside policy — one not-found shape. A corrupt event row is skipped. */
  async get(id: string): Promise<RunRecord | null> {
    const now = Date.now();
    const row = this.sql.exec<RunRow>(`SELECT run_id, agent, channel_id, finished_at, bytes, event_count, summary_json FROM runs WHERE run_id = ?`, id).toArray()[0];
    if (!row || !this.isKept(row, this.policyState().policy, now)) return null;
    const summary = parseSummary(row);
    if (!summary) return null;
    const events: RunEvent[] = parseEventRows(this.eventRows(id, 0, Number.MAX_SAFE_INTEGER));
    return { ...summary, events };
  }

  private eventRows(id: string, afterSeq: number, limit: number): EventRow[] {
    return this.sql.exec<EventRow>(`SELECT seq, json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`, id, afterSeq, limit).toArray();
  }

  /** A page of events with seq > afterSeq. `nextAfterSeq` is set when more
   *  rows follow (the cursor is the last seq READ, so a skipped corrupt row
   *  never stalls paging). Unknown or expired run → null (the same not-found
   *  as `get`); a run with nothing past `afterSeq` → an empty page. One query
   *  reads `limit + 1` rows: the page is the first `limit`, the extra row only
   *  says that more follow. */
  async events(id: string, afterSeq: number, limit: number): Promise<{ events: StoredRunEvent[]; nextAfterSeq?: number } | null> {
    const row = this.sql.exec<RetentionRow>(`SELECT run_id, finished_at, bytes FROM runs WHERE run_id = ?`, id).toArray()[0];
    if (!row || !this.isKept(row, this.policyState().policy, Date.now())) return null;
    const rows = this.eventRows(id, afterSeq, limit + 1);
    const page = rows.slice(0, limit);
    const out: { events: StoredRunEvent[]; nextAfterSeq?: number } = { events: parseEventRows(page) };
    if (rows.length > limit) out.nextAfterSeq = page[page.length - 1].seq;
    return out;
  }

  /** The record minus its events (the listing row, `bytes` included), or null
   *  when unknown or outside policy — the same not-found as `get`. No event row
   *  is touched: the read for callers that need identity, status, or the
   *  diagnosis but not the event set. */
  async summary(id: string): Promise<RunListItem | null> {
    const row = this.sql.exec<RunRow>(`SELECT run_id, agent, channel_id, finished_at, bytes, event_count, summary_json FROM runs WHERE run_id = ?`, id).toArray()[0];
    if (!row || !this.isKept(row, this.policyState().policy, Date.now())) return null;
    const summary = parseSummary(row);
    return summary ? { ...summary, bytes: row.bytes } : null;
  }

  /**
   * Newest first (finished_at desc, run_id desc) among the rows the policy
   * keeps, filtered, capped at RUN_LIST_MAX_LIMIT. The `before`/`beforeId`
   * cursor is the previous page's last row: rows strictly after it in the list
   * order (`finished_at < before`, or equal with `run_id < beforeId`), so
   * same-millisecond siblings are never skipped; `before` alone falls back to
   * `finished_at < before`. `nextBefore` is the last row's key when this page
   * was full.
   *
   * Two paths, decided by ONE aggregate over the in-policy rows (`COUNT(*)`,
   * `SUM(bytes)` where `finished_at >= cutoff`): when both are within
   * `maxRuns`/`maxBytes` every in-cutoff row is kept, so the page is ONE indexed
   * query (age cutoff, filters, cursor, order, `LIMIT`) — no table scan. Only
   * when a bound is exceeded is the kept set computed (`retentionRows` +
   * `applyRetention`, the same function `put`/`alarm` trim with) and the rows
   * walked until the page fills; the kept set is the newest prefix of the
   * in-cutoff order, so the walk stops at the first row outside it.
   *
   * `visibleTo` — the caller's authorization predicate (authorization.md item
   * 6) — is compiled into the same WHERE clause (`visibilitySql`): its leaves
   * become `channel_id IN (…)`, `channel_visibility IN (…)`, `user_id = ?`,
   * `repo IN (…)`, each backed by an index, so the actor's view is one more
   * indexed filter on the page query, never a post-filter. `none` answers an
   * empty page without a query.
   */
  async list(q: RunListOptions): Promise<{ items: RunListItem[]; nextBefore?: { finishedAt: number; id: string } }> {
    const now = Date.now();
    const limit = clampListLimit(q.limit);
    if (q.visibleTo?.kind === "none") return { items: [] };
    const { policy } = this.policyState();
    const cutoff = now - policy.retentionDays * 86_400_000;
    const inPolicy = this.sql.exec<{ n: number; b: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM runs WHERE finished_at >= ?`, cutoff).one();
    const boundExceeded = inPolicy.n > policy.maxRuns || inPolicy.b > policy.maxBytes;
    const kept = boundExceeded ? RunHistoryDO.keptIds(this.retentionRows(), policy, now) : null;
    const before = q.before ?? Number.MAX_SAFE_INTEGER;
    const where = [`(finished_at < ? OR (finished_at = ? AND run_id < ?))`, `finished_at >= ?`];
    // no beforeId → no row satisfies `run_id < ''`: the equality branch is inert
    const params: (string | number)[] = [before, before, q.beforeId ?? "", Math.max(q.sinceMs ?? 0, cutoff)];
    if (q.agent !== undefined) {
      where.push(`agent = ?`);
      params.push(q.agent);
    }
    if (q.channel !== undefined) {
      where.push(`channel_id = ?`);
      params.push(q.channel);
    }
    if (q.visibleTo !== undefined && q.visibleTo.kind !== "all") where.push(visibilitySql(q.visibleTo, params));
    const select = `SELECT run_id, agent, channel_id, finished_at, bytes, event_count, summary_json FROM runs WHERE ${where.join(" AND ")} ORDER BY finished_at DESC, run_id DESC`;
    // `LIMIT` holds on the over-bound path too: the kept set is the newest
    // prefix of this same ordering, so the first `limit` rows are the page (or
    // the walk stops early at the first evicted row) — never a full table load.
    const rows = this.sql.exec<RunRow>(`${select} LIMIT ?`, ...params, limit).toArray();
    const items: RunListItem[] = [];
    for (const row of rows) {
      if (items.length >= limit) break;
      if (kept !== null && !kept.has(row.run_id)) break; // kept is a newest-first prefix: nothing older is kept either
      const summary = parseSummary(row);
      if (summary) items.push({ ...summary, bytes: row.bytes });
    }
    const out: { items: RunListItem[]; nextBefore?: { finishedAt: number; id: string } } = { items };
    if (items.length === limit) {
      const last = items[items.length - 1];
      out.nextBefore = { finishedAt: last.finishedAt, id: last.id };
    }
    return out;
  }
}

type EventRow = { seq: number; json: string };

/** A visibility filter as one SQL boolean over the `runs` columns, its values
 *  appended to `params` — the same truth table as `matchesVisibility`
 *  (runRecord.ts). An empty `IN ()` list and an empty `or` are `0` (nothing),
 *  an empty `and` is `0` too (fail-closed, like the reference evaluator). The
 *  body validator (`isRunVisibilityFilter`) already bounded depth and width. */
function visibilitySql(f: RunVisibilityFilter, params: (string | number)[]): string {
  const inList = (column: string, values: readonly string[]): string => {
    if (values.length === 0) return "0";
    params.push(...values);
    return `${column} IN (${values.map(() => "?").join(",")})`;
  };
  switch (f.kind) {
    case "none":
      return "0";
    case "all":
      return "1";
    case "channels-in":
      return inList("channel_id", f.channelIds);
    case "visibility-in":
      return inList("channel_visibility", f.visibilities);
    case "repos-in":
      return inList("repo", f.repos);
    case "user-is":
      params.push(f.userId);
      return "user_id = ?";
    case "or":
      return f.of.length === 0 ? "0" : `(${f.of.map((p) => visibilitySql(p, params)).join(" OR ")})`;
    case "and":
      return f.of.length === 0 ? "0" : `(${f.of.map((p) => visibilitySql(p, params)).join(" AND ")})`;
  }
}

/** Event rows → stored events. A corrupt row is skipped, never fatal — the rest of the run still reads. */
function parseEventRows(rows: readonly EventRow[]): StoredRunEvent[] {
  const out: StoredRunEvent[] = [];
  for (const r of rows) {
    try {
      const parsed: unknown = JSON.parse(r.json);
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as { type?: unknown }).type === "string") {
        out.push({ ...(parsed as RunEvent), seq: r.seq });
      }
    } catch {
      // skipped
    }
  }
  return out;
}

/** The stored summary (record minus events); null when the row is unreadable. */
function parseSummary(row: RunRow): Omit<RunRecord, "events"> | null {
  try {
    const parsed: unknown = JSON.parse(row.summary_json);
    return isRunRecord({ ...(parsed as object), events: [] }) ? normalizeStored(parsed as Omit<RunRecord, "events">) : null;
  } catch {
    return null;
  }
}

function parseRunId(v: unknown): Validated<string> {
  if (typeof v !== "string" || !RUN_ID_PATTERN.test(v)) return invalid("id must match ^[A-Za-z0-9_-]{1,64}$");
  return { ok: true, value: v };
}

function parseStoreKey(b: Record<string, unknown>): Validated<string> {
  return parseScopeKey(b.storeKey, "storeKey");
}

function parsePositiveInt(v: unknown, name: string, max: number): Validated<number> {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) return invalid(`${name} must be an integer between 1 and ${max}`);
  return { ok: true, value: v };
}

function parseRunPut(body: unknown): Validated<{ storeKey: string; record: RunRecord; proposal?: RunPolicyProposal }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return key;
  if (!isRunRecord(b.record)) return invalid("record must be a RunRecord");
  const out: { storeKey: string; record: RunRecord; proposal?: RunPolicyProposal } = { storeKey: key.value, record: b.record };
  if (b.policy !== undefined) {
    if (typeof b.policy !== "object" || b.policy === null) return invalid("policy must be an object");
    const p = b.policy as Record<string, unknown>;
    const policy: Partial<RetentionPolicy> = {};
    for (const field of ["retentionDays", "maxRuns", "maxBytes"] as const) {
      const v = p[field];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return invalid(`policy.${field} must be an integer >= 1`);
      policy[field] = v;
    }
    if (typeof b.policyUpdatedAt !== "number" || !Number.isFinite(b.policyUpdatedAt) || b.policyUpdatedAt < 0) {
      return invalid("policyUpdatedAt must be a non-negative number when a policy is proposed");
    }
    out.proposal = { policy, policyUpdatedAt: b.policyUpdatedAt };
  }
  return { ok: true, value: out };
}

/** `{storeKey, id}` — the body of /runs/get, /runs/summary and /runs/delete, and the base of /runs/events. */
function parseRunTarget(body: unknown): Validated<{ storeKey: string; id: string }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return key;
  const id = parseRunId(b.id);
  if (!id.ok) return id;
  return { ok: true, value: { storeKey: key.value, id: id.value } };
}

function parseRunEvents(body: unknown): Validated<{ storeKey: string; id: string; afterSeq: number; limit: number }> {
  const base = parseRunTarget(body);
  if (!base.ok) return base;
  const b = body as Record<string, unknown>;
  let afterSeq = 0;
  if (b.afterSeq !== undefined) {
    if (typeof b.afterSeq !== "number" || !Number.isInteger(b.afterSeq) || b.afterSeq < 0) return invalid("afterSeq must be a non-negative integer");
    afterSeq = b.afterSeq;
  }
  let limit = RUN_EVENTS_DEFAULT_PAGE;
  if (b.limit !== undefined) {
    const l = parsePositiveInt(b.limit, "limit", RUN_EVENTS_MAX_PAGE);
    if (!l.ok) return l;
    limit = l.value;
  }
  return { ok: true, value: { ...base.value, afterSeq, limit } };
}

function parseRunList(body: unknown): Validated<{ storeKey: string; query: RunListOptions }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return key;
  const query: RunListOptions = {};
  if (b.limit !== undefined) {
    // Over-asking is not an error: the cap is the contract (`limit: 1000` → 200 rows).
    if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1) return invalid("limit must be a positive integer");
    query.limit = Math.min(b.limit, RUN_LIST_MAX_LIMIT);
  }
  for (const field of ["before", "sinceMs"] as const) {
    const v = b[field];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) return invalid(`${field} must be a number`);
    query[field] = v;
  }
  if (b.beforeId !== undefined) {
    const id = parseRunId(b.beforeId);
    if (!id.ok) return invalid("beforeId must match ^[A-Za-z0-9_-]{1,64}$");
    query.beforeId = id.value;
  }
  for (const field of ["agent", "channel"] as const) {
    const v = b[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > MAX_KEY_CHARS) return invalid(`${field} must be a string of at most ${MAX_KEY_CHARS} characters`);
    query[field] = v;
  }
  if (b.visibleTo !== undefined) {
    // A malformed filter is a 400, never "all": the bot degrades to live rows
    // rather than the DO widening what an actor may see.
    if (!isRunVisibilityFilter(b.visibleTo)) return invalid("visibleTo must be a run visibility filter");
    if (boundParameters(b.visibleTo) > DO_MAX_BOUND_PARAMETERS - RUN_LIST_BASE_PARAMETERS) return invalid(`visibleTo names more than ${DO_MAX_BOUND_PARAMETERS - RUN_LIST_BASE_PARAMETERS} ids`);
    query.visibleTo = b.visibleTo;
  }
  return { ok: true, value: { storeKey: key.value, query } };
}

/** Parameters the page query binds before any filter: the cursor pair (3) and the age floor (1),
 *  plus `agent`, `channel`, and the LIMIT at most — the headroom `visibleTo` must fit under. */
const RUN_LIST_BASE_PARAMETERS = 7;

/** How many `?` a filter binds (one per id, one per user). */
function boundParameters(f: RunVisibilityFilter): number {
  switch (f.kind) {
    case "none":
    case "all":
      return 0;
    case "channels-in":
      return f.channelIds.length;
    case "visibility-in":
      return f.visibilities.length;
    case "repos-in":
      return f.repos.length;
    case "user-is":
      return 1;
    case "or":
    case "and":
      return f.of.reduce((n, p) => n + boundParameters(p), 0);
  }
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
 *  bounded, no whitespace or control characters. `fieldName` names the body
 *  field in the error (the friction and run routes call theirs `ledgerKey` /
 *  `storeKey`). */
function parseScopeKey(v: unknown, fieldName = "scopeKey"): Validated<string> {
  if (typeof v !== "string" || v.length === 0) return invalid(`${fieldName} must be a non-empty string`);
  if (v.length > MAX_KEY_CHARS) return invalid(`${fieldName} must be at most ${MAX_KEY_CHARS} characters`);
  if (/[\s\p{C}]/u.test(v)) return invalid(`${fieldName} must not contain whitespace or control characters`);
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

/** The `/runs/*` routes (#157). Observability lines carry ids + counts only —
 *  never event text. A bad `id` is 400 before any DO call (R4). */
async function handleRuns(pathname: string, body: unknown, env: Env): Promise<Response> {
  const stub = (key: string) => env.RUNS.get(env.RUNS.idFromName(key));
  if (pathname === "/runs/put") {
    const parsed = parseRunPut(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { storeKey, record, proposal } = parsed.value;
    const result = await stub(storeKey).put(record, proposal);
    console.log(`[runs/put] ${storeKey} <- ${record.id} (${record.storedEventCount} events, stored=${result.stored}, ${result.retained} retained)`);
    return json(result);
  }
  if (pathname === "/runs/get") {
    const parsed = parseRunTarget(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const record = await stub(parsed.value.storeKey).get(parsed.value.id);
    console.log(`[runs/get] ${parsed.value.storeKey} ${parsed.value.id} -> ${record ? `${record.events.length} events` : "not found"}`);
    return json({ record });
  }
  if (pathname === "/runs/summary") {
    const parsed = parseRunTarget(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const summary = await stub(parsed.value.storeKey).summary(parsed.value.id);
    console.log(`[runs/summary] ${parsed.value.storeKey} ${parsed.value.id} -> ${summary ? "found" : "not found"}`);
    return json({ summary });
  }
  if (pathname === "/runs/list") {
    const parsed = parseRunList(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const result = await stub(parsed.value.storeKey).list(parsed.value.query);
    console.log(`[runs/list] ${parsed.value.storeKey} -> ${result.items.length} runs`);
    return json(result);
  }
  if (pathname === "/runs/events") {
    const parsed = parseRunEvents(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { storeKey, id, afterSeq, limit } = parsed.value;
    const result = await stub(storeKey).events(id, afterSeq, limit);
    console.log(`[runs/events] ${storeKey} ${id} after ${afterSeq} -> ${result ? `${result.events.length} events` : "not found"}`);
    return json(result ?? { events: null });
  }
  // /runs/delete
  const parsed = parseRunTarget(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const deleted = await stub(parsed.value.storeKey).delete(parsed.value.id);
  console.log(`[runs/delete] ${parsed.value.storeKey} ${parsed.value.id} -> deleted=${deleted}`);
  return json({ ok: true, deleted });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true, build: BUILD, features: ["memory", "friction", "schedules", "runs", "config"] });
    const ROUTES = new Set([
      ...CONFIG_ROUTES,
      "/retrieve",
      "/write",
      "/list",
      "/forget",
      "/friction/record",
      "/friction/recent",
      "/schedules/record",
      "/schedules/latest",
      "/runs/put",
      "/runs/get",
      "/runs/summary",
      "/runs/list",
      "/runs/events",
      "/runs/delete",
    ]);
    if (!ROUTES.has(url.pathname)) return json({ error: "not found" }, 404);
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!authorized(env, request)) return json({ error: "unauthorized" }, 401);

    // Size fence BEFORE parsing: a caller holding a valid bearer still can't
    // make us JSON-parse an oversized body just to be told 400 by the field
    // caps. Content-Length must be a plain digit string (RFC 9110) — that
    // rules out the absent header of a chunked/streamed body, a blank value,
    // and forms `Number()` would accept ("0x1000", "5e2", "12.5"); each is
    // 411 Length Required. A well-formed length over the cap is 413. Every
    // legitimate client (WorkerMemoryStore) sends a sized JSON body. The cap
    // is per route — decided AFTER routing and before the parse: /runs/put
    // carries a whole run record (budgeted to 1.5 MiB upstream) and gets 2 MiB;
    // every other route keeps the 512 KB fence.
    const header = request.headers.get("content-length");
    if (header === null || !/^\d+$/.test(header.trim())) {
      return json({ error: "body must declare a numeric Content-Length" }, 411);
    }
    const maxBodyBytes = url.pathname === "/runs/put" ? MAX_RUN_PUT_BODY_BYTES : MAX_BODY_BYTES;
    if (Number(header) > maxBodyBytes) {
      return json({ error: `body must be at most ${maxBodyBytes} bytes` }, 413);
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
    if (url.pathname.startsWith("/runs/")) return handleRuns(url.pathname, body, env);
    if (url.pathname.startsWith("/config/")) return handleConfig(url.pathname, body, env);

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
