import { DurableObject } from "cloudflare:workers";
import type { MemoryCandidate, MemoryRecord } from "../../src/core/memory/types.ts";
import {
  DEFAULT_SCOPE_CAP,
  mintRecord,
  normalizeText,
  planEviction,
  planWrite,
  rankRecords,
} from "../../src/core/memory/engine.ts";
import { tokenize } from "../../src/core/memory/scorer.ts";
import { FIRING_DETAIL_MAX, isScheduleFiring, type ScheduleFiring } from "../../src/core/schedules.ts";
import { REPO_SLUG } from "../../src/core/delivery.ts";
import {
  isDeliverySnapshot,
  isDeliverySnapshotPatch,
  type DeliverySnapshot,
  type DeliverySnapshotPatch,
} from "../../src/core/deliverySnapshotStore.ts";
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
  MAX_EVENT_BYTES,
  type RetentionPolicy,
  type RunListItem,
  type RunListOptions,
  type RunRecord,
  type RunVisibilityFilter,
  type StoredRunEvent,
} from "../../src/core/runRecord.ts";
import type { RunEvent } from "../../src/core/runEvents.ts";
import {
  checkFence,
  decideClaim,
  decideClaimWrite,
  phaseTransition,
  reclaimPhase,
  selectReclaim,
} from "../../src/core/runLedger/decisions.ts";
import {
  IDEMPOTENCY_KEY_PATTERN,
  INSTANCE_ID_PATTERN,
  isCoordinatorInstance,
  isCoordinatorUnit,
  sendRunFinished,
  type CoordinatorInstance,
  type CoordinatorUnit,
  type RunFinishedSend,
} from "../../src/core/coordinator/contract.ts";
import {
  GEN_PATTERN,
  type ClaimRequest,
  type ClaimResult,
  type FenceResult,
  type LivePhase,
  type LiveRunRow,
  type ReclaimedRun,
  type RunState,
  type StepRecord,
  type StopMode,
  type TranscriptAttachment,
  type TranscriptRow,
} from "../../src/core/runLedger/types.ts";
import {
  isMcpTicket,
  isSealedCredential,
  MCP_TICKET_STATES,
  type McpTicket,
  type McpTicketState,
  type SealedCredential,
} from "../../src/mcp/registry.ts";
import { injectedBuildStamp } from "../../src/deploy/buildStamp.ts";
import { systemClock } from "../../src/core/trace/clock.ts";
import { createTracer } from "../../src/core/trace/tracer.ts";
import { startAdoptedRoot, workerLogSink } from "../../src/core/trace/workerTrace.ts";

/** The commit this bundle was built from, injected by the deploy
 *  (`deploy/bin/build-stamp.mjs`) and answered on GET /healthz as `build`. */
const BUILD = injectedBuildStamp();

// The Worker's own spans (docs/reference/specs/tracing.md item 22): one `state.fetch` root
// per authenticated request, joining the bot's trace, on a `slow` log sink
// whose filter drops the line a refusal would leave.
const tracer = createTracer({ clock: systemClock });
const traceSinks = [workerLogSink((line) => console.log(line))];

// Memory Worker: the durable backend behind the bot's WorkerMemoryStore
// (src/core/memory/workerStore.ts) — cross-session memory (docs/reference/specs/memory.md). One
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
// Scheduled-firing routes (the record behind the /runs Scheduled panel;
// written by the bot's Worker shim after every cron firing, read by the bot's
// WorkerScheduleStore, src/core/scheduleStore.ts): ONE ScheduleDO, bounded per schedule.
//   POST /schedules/record {firing: ScheduleFiring} → {ok:true, retained}
//   POST /schedules/latest {}                       → {firings: ScheduleFiring[]} (newest per schedule)
// Run history routes (the durable RunStore behind the bot's WorkerRunStore,
// src/core/runStoreWorker.ts; docs/reference/specs/run-history.md): one RunHistoryDO per
// store key, owning the retention policy. Same bearer; /runs/put has its own 2 MiB
// body fence (a record is budgeted to 1.5 MiB upstream), every other route
// keeps the 512 KB one.
//   POST /runs/put    {storeKey, record, policy?, policyUpdatedAt?} → {ok, retained, stored, rewritten}
//   POST /runs/get    {storeKey, id} → {record: RunRecord | null}      (unknown/expired: null, 200)
//   POST /runs/list   {storeKey, limit?, before?, beforeId?, sinceMs?, agent?, channel?}
//                       → {items: RunListItem[], nextBefore?: {finishedAt, id}}   (cursor = the last row's list key)
//   POST /runs/events {storeKey, id, afterSeq?, limit?} → {events: (RunEvent & {seq})[] | null, nextAfterSeq?}
//                       (`events: null` when the run is unknown or hidden by retention; `seq` is the registry's stamp)
//   POST /runs/delete {storeKey, id} → {ok: true, deleted}
//   GET  /healthz → {ok: true, build: {commit, builtAt?}, features: ["memory", "schedules", "runs", "config"]}
//
// SECURITY: bearer comparison is constant-time (same helper as the resident
// Worker); an unset/empty secret grants nothing (fail closed); every body field
// is validated with size caps before it reaches storage.

export interface Env {
  MEMORY: DurableObjectNamespace<MemoryDO>;
  /** Scheduled firings: ONE ScheduleDO (named "schedules") — the record behind the /runs Scheduled panel. */
  SCHEDULES: DurableObjectNamespace<ScheduleDO>;
  /** Run history: one RunHistoryDO per store key (`runs:default`). */
  RUNS: DurableObjectNamespace<RunHistoryDO>;
  /** Runtime config documents (routing-and-config item 12): ONE ConfigDO (named "config"). */
  CONFIG: DurableObjectNamespace<ConfigDO>;
  /** Live-run transcripts (run-history item 32): one RunTranscriptDO per live run, named by run id. */
  RUN_TRANSCRIPTS: DurableObjectNamespace<RunTranscriptDO>;
  /** Delivery snapshots (delivery item 10): ONE DeliveryDO (named "delivery"), one snapshot per repository. */
  DELIVERY: DurableObjectNamespace<DeliveryDO>;
  /** The ship coordinator Workflow in the bot's shim Worker (run-history item
   *  47): where `RunHistoryDO.finish` sends `run finished:<runId>` for a record
   *  carrying `parentInstanceId`. Optional: this Worker deploys without it (the
   *  binding is a cross-script one, and the class must exist on the bot before
   *  the state Worker may name it), and a finish then commits with no event. */
  SHIP_COORDINATOR?: Workflow;
  MEMORY_TOKEN?: string;
}

/** The single DeliveryDO's name — every repository's snapshot lives in one object. */
const DELIVERY_OBJECT = "delivery";

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
/** Unit rows one put may carry: a plan has tens of units, never hundreds. */
const MAX_UNITS_PER_PUT = 200;
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
 *  of the pool by recent weak matches. */
const FTS_CANDIDATES_PER_LIMIT = 5;
const FTS_CANDIDATES_FLOOR = 50;
/** MATCH terms per query: the N longest distinct tokens (ties by first
 *  appearance). A 4000-char query would otherwise become a several-hundred-term
 *  OR the FTS index must union on every retrieval; longer tokens are the
 *  selective ones — the `[a-z0-9]+` tokenizer's 1–3-char tokens are mostly
 *  stopwords ("a", "the", "to"). Realistic queries have far fewer distinct
 *  tokens and are untouched; the engine still ranks with the FULL query, so the
 *  cap only shapes which rows can become candidates. */
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
    // fetch); records_fts holds text + keywords for the
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
   *  the dead rows older deploys left behind, kept on every start as a
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
    // algorithm with the in-process store.
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
    const now = systemClock();
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
      const now = systemClock();
      for (const cand of candidates) {
        // Targeted lookups, never a full-active scan: planWrite
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
          // superseded row must stop matching queries at the source.
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
      // Per-scope cap, inside the same transaction: the batch never
      // commits with the scope over the cap. Soft delete — rows stay (their
      // FTS entries do not). The full active set is fetched only when
      // the indexed COUNT says the scope is over the cap — the common
      // under-cap batch does no full scan.
      const activeCount = this.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM records WHERE status = 'active'`)
        .one().n;
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

  /** Human view (docs/reference/specs/memory.md item 24): the scope's ACTIVE rows, newest first, no usage
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

  /** Human control: soft-delete one ACTIVE row (`status = 'forgotten'`;
   *  the row and its provenance stay). Returns whether a row changed. The DO
   *  IS the scope, so an id from another scope simply matches nothing here. */
  async forget(_scopeKey: string, id: string): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const flipped =
        this.sql.exec(`UPDATE records SET status = 'forgotten' WHERE id = ? AND status = 'active'`, id).rowsWritten > 0;
      // Soft delete for the record row, hard delete for its FTS entry:
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
// Scheduled firings — the durable record behind the /runs Scheduled panel
// ---------------------------------------------------------------------------

/** Firings kept per schedule; the oldest fall off. A weekly job needs ~2 years. */
const SCHEDULE_MAX_FIRINGS = 100;

type FiringRow = {
  record: string;
};

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
      this.sql.exec(
        `INSERT INTO firings (schedule, fired_at, record) VALUES (?, ?, ?)`,
        firing.schedule,
        firing.firedAt,
        JSON.stringify(firing),
      );
      this.sql.exec(
        `DELETE FROM firings WHERE schedule = ? AND id NOT IN (
           SELECT id FROM firings WHERE schedule = ? ORDER BY fired_at DESC, id DESC LIMIT ?)`,
        firing.schedule,
        firing.schedule,
        SCHEDULE_MAX_FIRINGS,
      );
      retained = this.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM firings WHERE schedule = ?`, firing.schedule)
        .one().n;
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
// Durable Object: runtime config documents (docs/reference/specs/routing-and-config.md item
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

  // ---- MCP sealed credentials + connect tickets (docs/reference/specs/mcp-tools.md items 15–16).
  // Ciphertext the bot sealed — opaque here — and one-time tickets: the two
  // things a config document must never carry, kept beside it on this object.

  async putSecret(sealed: SealedCredential): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO secrets (server_id, sealed) VALUES (?, ?)`,
      sealed.serverId,
      JSON.stringify(sealed),
    );
  }

  async getSecret(serverId: string): Promise<SealedCredential | null> {
    const row = this.sql
      .exec<{ sealed: string }>(`SELECT sealed FROM secrets WHERE server_id = ?`, serverId)
      .toArray()[0];
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
      this.sql.exec(
        `INSERT OR REPLACE INTO tickets (nonce, server_id, expires_at, ticket) VALUES (?, ?, ?, ?)`,
        ticket.nonce,
        ticket.serverId,
        ticket.expiresAt,
        JSON.stringify(ticket),
      );
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
      const row = this.sql
        .exec<{ ticket: string }>(`SELECT ticket FROM tickets WHERE nonce = ?`, ticket.nonce)
        .toArray()[0];
      const stored = row ? parseStored(row.ticket, isMcpTicket) : null;
      if (!stored || stored.state !== fromState) return false;
      this.sql.exec(
        `UPDATE tickets SET server_id = ?, expires_at = ?, ticket = ? WHERE nonce = ?`,
        ticket.serverId,
        ticket.expiresAt,
        JSON.stringify(ticket),
        ticket.nonce,
      );
      return true;
    });
  }

  async get(key: string): Promise<{ document: unknown; version: number }> {
    const row = this.sql
      .exec<{ version: number; body: string }>(`SELECT version, body FROM documents WHERE key = ?`, key)
      .toArray()[0];
    if (!row) return { document: null, version: 0 };
    try {
      return { document: JSON.parse(row.body) as unknown, version: row.version };
    } catch {
      return { document: null, version: row.version };
    }
  }

  /** Replace the document iff its stored version equals `expectedVersion`
   *  (0 = not yet stored). Returns the new version, or the current one on conflict. */
  async put(
    key: string,
    document: unknown,
    expectedVersion: number,
    now: number,
  ): Promise<{ ok: true; version: number } | { ok: false; version: number }> {
    let outcome: { ok: true; version: number } | { ok: false; version: number } = { ok: false, version: 0 };
    this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec<{ version: number }>(`SELECT version FROM documents WHERE key = ?`, key).toArray()[0];
      const current = row?.version ?? 0;
      if (current !== expectedVersion) {
        outcome = { ok: false, version: current };
        return;
      }
      const next = current + 1;
      this.sql.exec(
        `INSERT OR REPLACE INTO documents (key, version, body, updated_at) VALUES (?, ?, ?, ?)`,
        key,
        next,
        JSON.stringify(document),
        now,
      );
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

// ---------------------------------------------------------------------------
// Durable Object: delivery snapshots, one per repository
// ---------------------------------------------------------------------------

// The delivery page's snapshot (docs/reference/specs/delivery.md item 10): the
// merged pull requests' facts over the snapshot window, as GitHub gave them,
// and when they were read. A busy repository's window is many MB — the review
// bodies and every workflow run of every branch — so a snapshot is stored as
// one row per pull request under a meta row, never as one JSON value (the
// per-row limit is 2 MB). A put replaces the repository's snapshot whole, in
// one transaction — the first read; a merge applies a refresh — the rows it
// re-read replace theirs by number, the rows that aged out go, the meta is
// replaced — so the hourly write is the change, not the window; a get
// reassembles the snapshot in pull request number order.

/** One pull request's facts may not exceed a fraction of the row limit; the fence names the pull request. */
const MAX_PULL_REQUEST_FACTS_BYTES = 1024 * 1024;

export class DeliveryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        repo TEXT PRIMARY KEY,
        snapshot_at TEXT NOT NULL,
        meta TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pull_requests (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        facts TEXT NOT NULL,
        PRIMARY KEY (repo, number)
      );
    `);
  }

  /** Replace the repository's snapshot: the meta row and one row per pull request, in one transaction. */
  async put(snapshot: DeliverySnapshot): Promise<number> {
    const { prs, ...meta } = snapshot;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM pull_requests WHERE repo = ?`, snapshot.repo);
      for (const pr of prs) {
        this.sql.exec(
          `INSERT OR REPLACE INTO pull_requests (repo, number, facts) VALUES (?, ?, ?)`,
          snapshot.repo,
          pr.number,
          JSON.stringify(pr),
        );
      }
      this.sql.exec(
        `INSERT OR REPLACE INTO snapshots (repo, snapshot_at, meta) VALUES (?, ?, ?)`,
        snapshot.repo,
        snapshot.snapshotAt,
        JSON.stringify(meta),
      );
    });
    return prs.length;
  }

  /** Apply a refresh to the repository's snapshot in one transaction; the rows now stored, or null
   *  when the repository has no snapshot to merge into (a partial snapshot would claim a
   *  completeness it lacks — the caller writes whole instead). */
  async merge(patch: DeliverySnapshotPatch): Promise<number | null> {
    const { upsert, drop, ...meta } = patch;
    return this.ctx.storage.transactionSync(() => {
      const stored = this.sql.exec(`SELECT 1 FROM snapshots WHERE repo = ?`, patch.repo).toArray().length > 0;
      if (!stored) return null;
      for (const pr of upsert) {
        this.sql.exec(
          `INSERT OR REPLACE INTO pull_requests (repo, number, facts) VALUES (?, ?, ?)`,
          patch.repo,
          pr.number,
          JSON.stringify(pr),
        );
      }
      for (const number of drop) {
        this.sql.exec(`DELETE FROM pull_requests WHERE repo = ? AND number = ?`, patch.repo, number);
      }
      this.sql.exec(
        `INSERT OR REPLACE INTO snapshots (repo, snapshot_at, meta) VALUES (?, ?, ?)`,
        patch.repo,
        patch.snapshotAt,
        JSON.stringify(meta),
      );
      const count = this.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pull_requests WHERE repo = ?`, patch.repo)
        .toArray()[0];
      return count?.n ?? 0;
    });
  }

  /** The repository's snapshot, pull requests in number order; null when none was stored. */
  async get(repo: string): Promise<DeliverySnapshot | null> {
    const row = this.sql.exec<{ meta: string }>(`SELECT meta FROM snapshots WHERE repo = ?`, repo).toArray()[0];
    if (!row) return null;
    const prs = this.sql
      .exec<{ facts: string }>(`SELECT facts FROM pull_requests WHERE repo = ? ORDER BY number`, repo)
      .toArray()
      .map((r) => JSON.parse(r.facts) as DeliverySnapshot["prs"][number]);
    return { ...(JSON.parse(row.meta) as Omit<DeliverySnapshot, "prs">), prs };
  }
}

const DELIVERY_ROUTES = new Set(["/delivery/get", "/delivery/put", "/delivery/merge"]);

/** The pull request whose facts exceed the row fence, if any — checked before the transaction. */
function oversizedFacts(prs: readonly DeliverySnapshot["prs"][number][]): number | undefined {
  const encoder = new TextEncoder();
  return prs.find((pr) => encoder.encode(JSON.stringify(pr)).byteLength > MAX_PULL_REQUEST_FACTS_BYTES)?.number;
}

async function handleDelivery(pathname: string, body: unknown, env: Env): Promise<Response> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const dO = env.DELIVERY.get(env.DELIVERY.idFromName(DELIVERY_OBJECT));
  if (pathname === "/delivery/get") {
    if (typeof b.repo !== "string" || !REPO_SLUG.test(b.repo)) return json({ error: "repo must be owner/name" }, 400);
    const snapshot = await dO.get(b.repo);
    console.log(
      `[delivery/get] ${b.repo} -> ${snapshot ? `${snapshot.prs.length} pull requests as of ${snapshot.snapshotAt}` : "none"}`,
    );
    return json({ snapshot });
  }
  if (pathname === "/delivery/put") {
    if (!isDeliverySnapshot(b.snapshot))
      return json(
        { error: "snapshot must be a DeliverySnapshot (repo, snapshotAt, range, prs[], truncated, completeFrom)" },
        400,
      );
    const oversized = oversizedFacts(b.snapshot.prs);
    if (oversized !== undefined)
      return json(
        { error: `pull request ${oversized}'s facts must be at most ${MAX_PULL_REQUEST_FACTS_BYTES} bytes` },
        413,
      );
    const prs = await dO.put(b.snapshot);
    console.log(`[delivery/put] ${b.snapshot.repo} <- ${prs} pull requests as of ${b.snapshot.snapshotAt}`);
    return json({ ok: true, prs });
  }
  if (pathname === "/delivery/merge") {
    if (!isDeliverySnapshotPatch(b.patch))
      return json(
        {
          error:
            "patch must be a DeliverySnapshotPatch (repo, snapshotAt, range, truncated, completeFrom, upsert[], drop[])",
        },
        400,
      );
    const oversized = oversizedFacts(b.patch.upsert);
    if (oversized !== undefined)
      return json(
        { error: `pull request ${oversized}'s facts must be at most ${MAX_PULL_REQUEST_FACTS_BYTES} bytes` },
        413,
      );
    const prs = await dO.merge(b.patch);
    if (prs === null) return json({ error: `no snapshot for ${b.patch.repo} to merge into` }, 404);
    console.log(
      `[delivery/merge] ${b.patch.repo} <- ${b.patch.upsert.length} pull requests re-read, ${b.patch.drop.length} dropped, ${prs} stored as of ${b.patch.snapshotAt}`,
    );
    return json({ ok: true, prs });
  }
  return json({ error: "not found" }, 404);
}

/** Documents are small; a body over this is refused before storage. */
const MAX_CONFIG_DOCUMENT_BYTES = 256 * 1024;

const CONFIG_ROUTES = new Set([
  "/config/get",
  "/config/put",
  "/config/secrets/put",
  "/config/secrets/get",
  "/config/secrets/delete",
  "/config/tickets/put",
  "/config/tickets/get",
  "/config/tickets/transition",
]);
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
      await dO.putTicket(b.ticket, systemClock());
      console.log(`[config/tickets/put] ${b.ticket.serverId} state=${b.ticket.state}`);
      return json({ ok: true });
    }
    case "/config/tickets/get": {
      if (typeof b.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(b.nonce))
        return json({ error: "nonce malformed" }, 400);
      return json({ ticket: await dO.getTicket(b.nonce) });
    }
    case "/config/tickets/transition": {
      if (!isMcpTicket(b.ticket)) return json({ error: "ticket must be an McpTicket" }, 400);
      if (typeof b.fromState !== "string" || !TICKET_STATES.has(b.fromState))
        return json({ error: "fromState must be a ticket state" }, 400);
      const applied = await dO.transitionTicket(b.ticket, b.fromState as McpTicketState);
      console.log(
        `[config/tickets/transition] ${b.ticket.serverId} ${b.fromState}→${b.ticket.state} applied=${applied}`,
      );
      return json({ ok: true, applied });
    }
    default:
      break;
  }
  if (typeof b.key !== "string" || !CONFIG_KEY_RE.test(b.key))
    return json({ error: "key must be a short lowercase slug" }, 400);
  if (pathname === "/config/get") {
    return json(await dO.get(b.key));
  }
  if (pathname === "/config/put") {
    if (typeof b.document !== "object" || b.document === null || Array.isArray(b.document))
      return json({ error: "document must be a JSON object" }, 400);
    if (typeof b.expectedVersion !== "number" || !Number.isInteger(b.expectedVersion) || b.expectedVersion < 0)
      return json({ error: "expectedVersion must be a non-negative integer" }, 400);
    if (new TextEncoder().encode(JSON.stringify(b.document)).byteLength > MAX_CONFIG_DOCUMENT_BYTES)
      return json({ error: `document must be at most ${MAX_CONFIG_DOCUMENT_BYTES} bytes` }, 413);
    const out = await dO.put(b.key, b.document, b.expectedVersion, systemClock());
    if (!out.ok) return json({ error: "version conflict", version: out.version }, 409);
    console.log(`[config/put] ${b.key} v${out.version}`);
    return json({ ok: true, version: out.version });
  }
  return json({ error: "not found" }, 404);
}

function parseScheduleFiring(body: unknown): Validated<ScheduleFiring> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const f = (body as Record<string, unknown>).firing;
  if (!isScheduleFiring(f))
    return invalid("firing must be a ScheduleFiring (schedule, firedAt, outcome[, runId, detail])");
  if (f.schedule.length > MAX_KEY_CHARS) return invalid(`firing.schedule must be at most ${MAX_KEY_CHARS} characters`);
  if (f.runId !== undefined && f.runId.length > MAX_KEY_CHARS)
    return invalid(`firing.runId must be at most ${MAX_KEY_CHARS} characters`);
  if (f.detail !== undefined && f.detail.length > FIRING_DETAIL_MAX)
    return invalid(`firing.detail must be at most ${FIRING_DETAIL_MAX} characters`);
  return { ok: true, value: f };
}

// ---------------------------------------------------------------------------
// Durable Object: one run history per store key
// ---------------------------------------------------------------------------

// Cloudflare Durable Object SQLite limits (developers.cloudflare.com/durable-objects/platform/limits/;
// re-read them when a bound below looks wrong): 100 bound parameters per query; 100 KB per SQL statement;
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
/** Rows a single `put` may delete while trimming (the deletion fence): a
 *  policy shrink dropping thousands of runs is spread over successive puts and
 *  the 6 h alarm, so no single write stalls. Reads hide them immediately. */
const RUN_TRIM_FENCE = 500;
/** How often `alarm()` sweeps everything outside the retention policy. */
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

/** A `live_runs` row as SQLite returns it. */
type LiveRow = {
  run_id: string;
  thread_key: string;
  owner_gen: string;
  lease_until: number;
  started_at: number;
  phase: string;
  stop: string | null;
  meta_json: string;
  card_json: string | null;
  system_text: string;
  tools_json: string;
  state_json: string;
};

function rowToLive(r: LiveRow): LiveRunRow {
  return {
    runId: r.run_id,
    threadKey: r.thread_key,
    ownerGen: r.owner_gen,
    leaseUntil: r.lease_until,
    startedAt: r.started_at,
    phase: r.phase as LivePhase,
    stop: (r.stop as StopMode | null) ?? null,
    meta: JSON.parse(r.meta_json) as LiveRunRow["meta"],
    card: r.card_json ? (JSON.parse(r.card_json) as LiveRunRow["card"]) : null,
    system: r.system_text,
    tools: JSON.parse(r.tools_json) as LiveRunRow["tools"],
    state: JSON.parse(r.state_json) as RunState,
  };
}

type HeartbeatAnswer = FenceResult & { stop?: StopMode | null; phase?: LivePhase };

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
    // The one column migration this DO has (the run-visibility stamp): a table
    // created before the visibility stamp gains the column with `unknown` for
    // every existing row — so a run written before the stamp is never public.
    // Then the indexes the visibility predicate's leaves walk (`channel_id IN`,
    // `channel_visibility IN`, `user_id =`), each ordered like the page.
    const columns = new Set(
      this.sql
        .exec<{ name: string }>(`PRAGMA table_info(runs)`)
        .toArray()
        .map((c) => c.name),
    );
    if (!columns.has("channel_visibility"))
      this.sql.exec(`ALTER TABLE runs ADD COLUMN channel_visibility TEXT NOT NULL DEFAULT 'unknown'`);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS runs_channel_finished ON runs(channel_id, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_visibility_finished ON runs(channel_visibility, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_user_finished ON runs(user_id, finished_at DESC, run_id DESC);
    `);
    // The live-run ledger (run-history items 28–34): live runs never enter
    // `runs` — that table's finished_at drives retention and listing — they
    // live here until `finish` moves them across in one transaction.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS live_runs (
        run_id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL UNIQUE,
        owner_gen TEXT NOT NULL,
        lease_until INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        phase TEXT NOT NULL,
        stop TEXT,
        meta_json TEXT NOT NULL,
        card_json TEXT,
        system_text TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_steps (
        run_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, step)
      );
      CREATE TABLE IF NOT EXISTS run_inbox (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS run_jobs (
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (run_id, kind)
      );
    `);
    // The coordinator's parent records (run-history item 49): one row per
    // instance, written by the bot at the instance's creation and read by the
    // spawn route for the requester, channel and thread every child acts as.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_instances (
        instance_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    // The units of the plan an instance runs (run-history item 50): one row per
    // (instance, unit), replaced whole as the runner reaches the unit; the
    // rowid keeps the order the rows were first written — the plan's.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_units (
        instance_id TEXT NOT NULL,
        unit TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (instance_id, unit)
      );
    `);
  }

  // ---- the coordinator's parent records (run-history item 49) -----------------

  /** Idempotent for the same record; a different record under a taken id is refused. */
  async putInstance(instance: CoordinatorInstance): Promise<{ ok: true } | { ok: false; reason: "exists" }> {
    let out: { ok: true } | { ok: false; reason: "exists" } = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const text = JSON.stringify(instance);
      const existing = this.sql
        .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, instance.id)
        .toArray()[0];
      if (existing) {
        if (existing.json !== text) out = { ok: false, reason: "exists" };
        return;
      }
      this.sql.exec(
        `INSERT INTO coordinator_instances (instance_id, json, created_at) VALUES (?, ?, ?)`,
        instance.id,
        text,
        instance.createdAt,
      );
    });
    return out;
  }

  async getInstance(id: string): Promise<CoordinatorInstance | null> {
    const row = this.sql
      .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, id)
      .toArray()[0];
    return row ? (JSON.parse(row.json) as CoordinatorInstance) : null;
  }

  // ---- the units of the plan an instance runs (run-history item 50) -----------

  /** Each row replaced whole under its (instance, unit); a replace keeps the row's place. */
  async putUnits(units: CoordinatorUnit[], now: number): Promise<{ ok: true }> {
    this.ctx.storage.transactionSync(() => {
      for (const u of units) {
        this.sql.exec(
          `INSERT INTO coordinator_units (instance_id, unit, json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(instance_id, unit) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
          u.instanceId,
          u.unit,
          JSON.stringify(u),
          now,
        );
      }
    });
    return { ok: true };
  }

  async listUnits(instanceId: string): Promise<CoordinatorUnit[]> {
    return this.sql
      .exec<{ json: string }>(`SELECT json FROM coordinator_units WHERE instance_id = ? ORDER BY rowid`, instanceId)
      .toArray()
      .map((r) => JSON.parse(r.json) as CoordinatorUnit);
  }

  // ---- the live-run ledger (run-history items 28–34) --------------------------

  private liveRow(runId: string): LiveRunRow | undefined {
    const r = this.sql.exec<LiveRow>(`SELECT * FROM live_runs WHERE run_id = ?`, runId).toArray()[0];
    return r ? rowToLive(r) : undefined;
  }

  private liveByThread(threadKey: string): LiveRunRow | undefined {
    const r = this.sql.exec<LiveRow>(`SELECT * FROM live_runs WHERE thread_key = ?`, threadKey).toArray()[0];
    return r ? rowToLive(r) : undefined;
  }

  /** One live run per thread (item 29): the UNIQUE on thread_key is the
   *  store-level guarantee; the decision names the live run for the steer. */
  async claim(req: ClaimRequest, now: number): Promise<ClaimResult> {
    let out: ClaimResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const existing = this.liveByThread(req.threadKey);
      out = decideClaim(
        existing
          ? {
              runId: existing.runId,
              agent: existing.meta.agent,
              startedAt: existing.startedAt,
              ownerGen: existing.ownerGen,
              idempotencyKey: existing.meta.idempotencyKey,
            }
          : undefined,
        req,
      );
      if (!out.ok) return;
      switch (decideClaimWrite(existing, req)) {
        case "keep":
          return;
        case "refresh":
          this.sql.exec(`UPDATE live_runs SET lease_until = ? WHERE run_id = ?`, now + req.leaseMs, req.runId);
          return;
        case "promote":
          // The prompt landed on the owner's own attaching row (item 42): the
          // claim the dispatcher always made, applied in place — identity,
          // thread and start stay; the row goes live.
          this.sql.exec(
            `UPDATE live_runs SET lease_until = ?, phase = 'live', meta_json = ?, card_json = ?, system_text = ?, tools_json = ?, state_json = ? WHERE run_id = ?`,
            now + req.leaseMs,
            JSON.stringify(req.meta),
            req.card ? JSON.stringify(req.card) : null,
            req.system,
            JSON.stringify(req.tools),
            JSON.stringify(req.state ?? {}),
            req.runId,
          );
          return;
        case "insert":
          break;
      }
      this.sql.exec(
        `INSERT INTO live_runs (run_id, thread_key, owner_gen, lease_until, started_at, phase, stop, meta_json, card_json, system_text, tools_json, state_json)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        req.runId,
        req.threadKey,
        req.gen,
        now + req.leaseMs,
        req.startedAt,
        req.phase ?? "live",
        JSON.stringify(req.meta),
        req.card ? JSON.stringify(req.card) : null,
        req.system,
        JSON.stringify(req.tools),
        JSON.stringify(req.state ?? {}),
      );
    });
    return out;
  }

  /** Extends the lease iff the caller owns the run; answers what another generation asked for. */
  async heartbeat(runId: string, gen: string, leaseMs: number, now: number): Promise<HeartbeatAnswer> {
    let out: HeartbeatAnswer = { ok: false, reason: "unknown-run" };
    this.ctx.storage.transactionSync(() => {
      const row = this.liveRow(runId);
      const fence = checkFence(row, gen);
      if (!fence.ok || !row) {
        out = fence;
        return;
      }
      this.sql.exec(`UPDATE live_runs SET lease_until = ? WHERE run_id = ?`, now + leaseMs, runId);
      out = { ok: true, stop: row.stop, phase: row.phase };
    });
    return out;
  }

  /** Append events with their registry seq (item 30). Fenced. */
  async appendEvents(runId: string, gen: string, events: Array<{ seq: number; json: string }>): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      out = checkFence(this.liveRow(runId), gen);
      if (!out.ok) return;
      for (let i = 0; i < events.length; i += RUN_EVENT_INSERT_BATCH) {
        const batch = events.slice(i, i + RUN_EVENT_INSERT_BATCH);
        const params: (string | number)[] = [];
        for (const e of batch) params.push(runId, e.seq, e.json);
        this.sql.exec(
          `INSERT OR REPLACE INTO run_events (run_id, seq, json) VALUES ${batch.map(() => "(?, ?, ?)").join(",")}`,
          ...params,
        );
      }
    });
    return out;
  }

  /** The step record (item 31), written by the client AFTER the transcript turns. Fenced. */
  async recordStep(runId: string, gen: string, record: StepRecord): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      out = checkFence(this.liveRow(runId), gen);
      if (!out.ok) return;
      this.sql.exec(
        `INSERT OR REPLACE INTO run_steps (run_id, step, json) VALUES (?, ?, ?)`,
        runId,
        record.step,
        JSON.stringify(record),
      );
    });
    return out;
  }

  async setState(runId: string, gen: string, state: RunState): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      out = checkFence(this.liveRow(runId), gen);
      if (!out.ok) return;
      this.sql.exec(`UPDATE live_runs SET state_json = ? WHERE run_id = ?`, JSON.stringify(state), runId);
    });
    return out;
  }

  /** Any generation: a steer arrives on whichever container is up. */
  async pushInbox(runId: string, message: Record<string, unknown>): Promise<{ ok: boolean; seq?: number }> {
    let out: { ok: boolean; seq?: number } = { ok: false };
    this.ctx.storage.transactionSync(() => {
      if (!this.liveRow(runId)) return;
      const last = this.sql
        .exec<{ m: number | null }>(`SELECT MAX(seq) AS m FROM run_inbox WHERE run_id = ?`, runId)
        .one().m;
      const seq = (last ?? 0) + 1;
      this.sql.exec(`INSERT INTO run_inbox (run_id, seq, json) VALUES (?, ?, ?)`, runId, seq, JSON.stringify(message));
      out = { ok: true, seq };
    });
    return out;
  }

  /** The inbox past a seq (run-history item 40): the resume's re-read at adopt. */
  async readInbox(runId: string, afterSeq: number): Promise<{ seq: number; message: Record<string, unknown> }[]> {
    return this.sql
      .exec<{ seq: number; json: string }>(
        `SELECT seq, json FROM run_inbox WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
        runId,
        afterSeq,
      )
      .toArray()
      .map((r) => ({ seq: r.seq, message: JSON.parse(r.json) as Record<string, unknown> }));
  }

  async requestStop(runId: string, mode: StopMode, now: number): Promise<{ ok: boolean; ownerLive?: boolean }> {
    let out: { ok: boolean; ownerLive?: boolean } = { ok: false };
    this.ctx.storage.transactionSync(() => {
      const row = this.liveRow(runId);
      if (!row) return;
      this.sql.exec(`UPDATE live_runs SET stop = ? WHERE run_id = ?`, mode, runId);
      out = { ok: true, ownerLive: row.leaseUntil > now };
    });
    return out;
  }

  /** SIGTERM: mark this generation's live runs for the next one (item 33). */
  async handoff(gen: string, runIds: string[]): Promise<{ marked: string[] }> {
    const marked: string[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const id of runIds) {
        const row = this.liveRow(id);
        if (row && row.ownerGen === gen && phaseTransition(row.phase, "handoff")) {
          this.sql.exec(`UPDATE live_runs SET phase = 'handoff' WHERE run_id = ?`, id);
          marked.push(id);
        }
      }
    });
    return { marked };
  }

  /** CAS live → finishing, taken before the reply (item 33). Fenced. */
  async finishing(runId: string, gen: string): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const row = this.liveRow(runId);
      const fence = checkFence(row, gen);
      if (!fence.ok || !row) {
        out = fence;
        return;
      }
      if (!phaseTransition(row.phase, "finishing")) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      this.sql.exec(`UPDATE live_runs SET phase = 'finishing' WHERE run_id = ?`, runId);
    });
    return out;
  }

  /** The finished record replaces the live rows in ONE transaction (item 33).
   *  Fenced. Then, for a record carrying `parentInstanceId`, ONE `run
   *  finished:<runId>` to that coordinator instance (item 47) — after the
   *  commit, never inside it, and never able to undo it: a refused send (the
   *  instance ended, no binding) is the answer's `event`, not an error. */
  async finish(
    runId: string,
    gen: string,
    record: RunRecord,
    proposal?: RunPolicyProposal,
  ): Promise<FenceResult & { stored?: boolean; event?: RunFinishedSend["kind"] }> {
    let out: FenceResult & { stored?: boolean } = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const fence = checkFence(this.liveRow(runId), gen);
      if (!fence.ok) {
        out = fence;
        return;
      }
      const put = this.upsertInTransaction(record, proposal);
      this.deleteLiveRows([runId]);
      out = { ok: true, stored: put.stored };
    });
    if (!out.ok) return out;
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(systemClock() + RUN_SWEEP_INTERVAL_MS);
    const event = await sendRunFinished(this.env.SHIP_COORDINATOR, record);
    if (event.kind === "failed")
      console.warn(`[runs/finish] ${runId} → run finished not delivered to ${event.instance}: ${event.reason}`);
    return { ...out, event: event.kind };
  }

  /** The live rows go with no record (item 42): a reserved run that never
   *  started. Fenced. */
  async abandon(runId: string, gen: string): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      out = checkFence(this.liveRow(runId), gen);
      if (!out.ok) return;
      this.deleteLiveRows([runId]);
    });
    return out;
  }

  private deleteLiveRows(runIds: string[]): void {
    for (const id of runIds) {
      this.sql.exec(`DELETE FROM live_runs WHERE run_id = ?`, id);
      this.sql.exec(`DELETE FROM run_steps WHERE run_id = ?`, id);
      this.sql.exec(`DELETE FROM run_inbox WHERE run_id = ?`, id);
      this.sql.exec(`DELETE FROM run_jobs WHERE run_id = ?`, id);
    }
  }

  /** A booting generation takes every expired or handed-off run (item 31),
   *  atomically, with what a resume needs. */
  async reclaim(gen: string, now: number, leaseMs: number): Promise<ReclaimedRun[]> {
    const out: ReclaimedRun[] = [];
    this.ctx.storage.transactionSync(() => {
      const rows = this.sql.exec<LiveRow>(`SELECT * FROM live_runs`).toArray().map(rowToLive);
      for (const row of selectReclaim(rows, now, gen)) {
        const phase = reclaimPhase(row.phase);
        this.sql.exec(
          `UPDATE live_runs SET owner_gen = ?, lease_until = ?, phase = ? WHERE run_id = ?`,
          gen,
          now + leaseMs,
          phase,
          row.runId,
        );
        const stepRow = this.sql
          .exec<{ json: string }>(`SELECT json FROM run_steps WHERE run_id = ? ORDER BY step DESC LIMIT 1`, row.runId)
          .toArray()[0];
        const lastStep = stepRow ? (JSON.parse(stepRow.json) as StepRecord) : null;
        const consumed = lastStep?.inboxConsumedSeq ?? 0;
        const inbox = this.sql
          .exec<{ seq: number; json: string }>(
            `SELECT seq, json FROM run_inbox WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
            row.runId,
            consumed,
          )
          .toArray()
          .map((r) => ({ seq: r.seq, message: JSON.parse(r.json) as Record<string, unknown> }));
        const jobs = this.sql
          .exec<{ kind: string; json: string }>(`SELECT kind, json FROM run_jobs WHERE run_id = ?`, row.runId)
          .toArray()
          .map((r) => ({ kind: r.kind, payload: JSON.parse(r.json) as unknown }));
        out.push({
          row: { ...row, ownerGen: gen, leaseUntil: now + leaseMs, phase },
          reclaimedFrom: row.phase,
          lastStep,
          inbox,
          jobs,
        });
      }
    });
    return out;
  }

  async listLive(): Promise<LiveRunRow[]> {
    return this.sql.exec<LiveRow>(`SELECT * FROM live_runs ORDER BY started_at ASC`).toArray().map(rowToLive);
  }

  /** The events a live run has appended so far (item 30), in seq order — what
   *  a reclaim closes an unresumable run's record with. The finished-runs
   *  reads never see a live run, so this is the one way at its events. */
  async liveEvents(runId: string): Promise<StoredRunEvent[]> {
    return parseEventRows(this.eventRows(runId, 0, Number.MAX_SAFE_INTEGER));
  }

  // ---- policy ---------------------------------------------------------------

  /** The persisted policy (defaults until the first proposal lands). */
  policyState(): StoredPolicy {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, POLICY_KEY).toArray()[0];
    if (!row) return { policy: clampRetentionPolicy({}), policyUpdatedAt: 0 };
    try {
      const parsed = JSON.parse(row.value) as Partial<RetentionPolicy> & { policyUpdatedAt?: number };
      const at =
        typeof parsed.policyUpdatedAt === "number" && Number.isFinite(parsed.policyUpdatedAt)
          ? parsed.policyUpdatedAt
          : 0;
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
    return this.sql
      .exec<RetentionRow>(`SELECT run_id, finished_at, bytes FROM runs ORDER BY finished_at ASC, run_id ASC`)
      .toArray();
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
  private trim(
    policy: RetentionPolicy,
    now: number,
    fence: number | undefined,
    first?: string,
  ): { deleted: number; kept: Set<string> } {
    const rows = this.retentionRows();
    const kept = RunHistoryDO.keptIds(rows, policy, now);
    const outside = rows.map((r) => r.run_id).filter((id) => !kept.has(id) && id !== first);
    const firstDoomed = first !== undefined && !kept.has(first);
    const doomed = firstDoomed ? [first, ...outside] : outside;
    const victims = fence === undefined ? doomed : doomed.slice(0, Math.max(fence, firstDoomed ? 1 : 0));
    this.deleteRuns(victims);
    if (victims.length < doomed.length)
      console.log(
        `[runs/trim] deletion fence: ${victims.length} of ${doomed.length} rows outside policy deleted this put`,
      );
    return { deleted: victims.length, kept };
  }

  // ---- writes ---------------------------------------------------------------

  /** Upsert one record and trim, in ONE sync transaction (see MemoryDO.write for
   *  why this is atomic and un-interleavable). Event rows are rewritten only
   *  when the stored version changed (`event_count`, `finished_at`, `bytes`) —
   *  an identical retry is a no-op on `run_events`. `stored: false` when the
   *  record itself fell outside the (possibly just-updated) policy: it was
   *  written and deleted in the same transaction, so nothing of it remains. */
  async put(
    record: RunRecord,
    proposal?: RunPolicyProposal,
  ): Promise<{ ok: true; retained: number; stored: boolean; rewritten: boolean }> {
    let result = { ok: true as const, retained: 0, stored: false, rewritten: false };
    this.ctx.storage.transactionSync(() => {
      result = this.upsertInTransaction(record, proposal);
    });
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(systemClock() + RUN_SWEEP_INTERVAL_MS);
    return result;
  }

  /** The body of `put`, for a caller already inside `transactionSync` — the
   *  ledger's `finish` writes the finished record and deletes the live rows in
   *  ONE transaction (run-history item 33), so this cannot open its own. */
  private upsertInTransaction(
    record: RunRecord,
    proposal?: RunPolicyProposal,
  ): { ok: true; retained: number; stored: boolean; rewritten: boolean } {
    {
      const now = systemClock();
      const policy = proposal ? this.applyProposal(proposal, now).policy : this.policyState().policy;
      const finishedAt = Math.min(record.finishedAt, now + RUN_MAX_FUTURE_MS);
      // The tracing stamps get the same skew clamp (docs/reference/specs/tracing.md).
      const stored: RunRecord = {
        ...record,
        finishedAt,
        ...(record.receivedAt !== undefined
          ? { receivedAt: Math.min(record.receivedAt, now + RUN_MAX_FUTURE_MS) }
          : {}),
        ...(record.sealedAt !== undefined ? { sealedAt: Math.min(record.sealedAt, now + RUN_MAX_FUTURE_MS) } : {}),
      };
      const { events, ...summary } = stored;
      const bytes = utf8ByteLength(JSON.stringify(stored));
      const existing = this.sql
        .exec<{ event_count: number; finished_at: number; bytes: number }>(
          `SELECT event_count, finished_at, bytes FROM runs WHERE run_id = ?`,
          record.id,
        )
        .toArray()[0];
      const unchanged =
        existing !== undefined &&
        sameStoredVersion(
          { eventCount: existing.event_count, finishedAt: existing.finished_at, bytes: existing.bytes },
          { eventCount: stored.eventCount, finishedAt, bytes },
        );
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
          this.sql.exec(
            `INSERT INTO run_events (run_id, seq, json) VALUES ${batch.map(() => "(?, ?, ?)").join(",")}`,
            ...params,
          );
        }
      }
      // The just-written row is either kept or was deleted by the trim (it is
      // always `first`), so kept membership IS whether it is still stored.
      const { kept } = this.trim(policy, now, RUN_TRIM_FENCE, record.id);
      return {
        ok: true as const,
        retained: kept.size,
        stored: kept.has(record.id),
        rewritten: existing !== undefined && !unchanged,
      };
    }
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
    // The sweep nobody asked for is a root of its own (docs/reference/specs/tracing.md
    // item 25): `state.alarm`, ending with how many rows it swept.
    const root = startAdoptedRoot(tracer, "state.alarm", { sinks: traceSinks });
    try {
      const now = systemClock();
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
      root.end("ok", { swept: deleted });
    } catch (err) {
      root.fail(err);
      root.end("error");
      throw err;
    }
  }

  // ---- reads ----------------------------------------------------------------

  /** The record with its events in seq order, each carrying the `seq` it is
   *  stored under (the registry's stamp — see `eventSeqs`), or null when
   *  unknown or outside policy — one not-found shape. A corrupt event row is skipped. */
  async get(id: string): Promise<RunRecord | null> {
    const now = systemClock();
    const row = this.sql
      .exec<RunRow>(
        `SELECT run_id, agent, channel_id, finished_at, bytes, event_count, summary_json FROM runs WHERE run_id = ?`,
        id,
      )
      .toArray()[0];
    if (!row || !this.isKept(row, this.policyState().policy, now)) return null;
    const summary = parseSummary(row);
    if (!summary) return null;
    const events: RunEvent[] = parseEventRows(this.eventRows(id, 0, Number.MAX_SAFE_INTEGER));
    return { ...summary, events };
  }

  private eventRows(id: string, afterSeq: number, limit: number): EventRow[] {
    return this.sql
      .exec<EventRow>(
        `SELECT seq, json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        id,
        afterSeq,
        limit,
      )
      .toArray();
  }

  /** A page of events with seq > afterSeq. `nextAfterSeq` is set when more
   *  rows follow (the cursor is the last seq READ, so a skipped corrupt row
   *  never stalls paging). Unknown or expired run → null (the same not-found
   *  as `get`); a run with nothing past `afterSeq` → an empty page. One query
   *  reads `limit + 1` rows: the page is the first `limit`, the extra row only
   *  says that more follow. */
  async events(
    id: string,
    afterSeq: number,
    limit: number,
  ): Promise<{ events: StoredRunEvent[]; nextAfterSeq?: number } | null> {
    const row = this.sql
      .exec<RetentionRow>(`SELECT run_id, finished_at, bytes FROM runs WHERE run_id = ?`, id)
      .toArray()[0];
    if (!row || !this.isKept(row, this.policyState().policy, systemClock())) return null;
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
    const row = this.sql
      .exec<RunRow>(
        `SELECT run_id, agent, channel_id, finished_at, bytes, event_count, summary_json FROM runs WHERE run_id = ?`,
        id,
      )
      .toArray()[0];
    if (!row || !this.isKept(row, this.policyState().policy, systemClock())) return null;
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
    const now = systemClock();
    const limit = clampListLimit(q.limit);
    if (q.visibleTo?.kind === "none") return { items: [] };
    const { policy } = this.policyState();
    const cutoff = now - policy.retentionDays * 86_400_000;
    const inPolicy = this.sql
      .exec<{ n: number; b: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM runs WHERE finished_at >= ?`,
        cutoff,
      )
      .one();
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
    return isRunRecord({ ...(parsed as object), events: [] })
      ? normalizeStored(parsed as Omit<RunRecord, "events">)
      : null;
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
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max)
    return invalid(`${name} must be an integer between 1 and ${max}`);
  return { ok: true, value: v };
}

function parseRunPut(body: unknown): Validated<{ storeKey: string; record: RunRecord; proposal?: RunPolicyProposal }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return key;
  if (!isRunRecord(b.record)) return invalid("record must be a RunRecord");
  const out: { storeKey: string; record: RunRecord; proposal?: RunPolicyProposal } = {
    storeKey: key.value,
    record: b.record,
  };
  if (b.policy !== undefined) {
    if (typeof b.policy !== "object" || b.policy === null) return invalid("policy must be an object");
    const p = b.policy as Record<string, unknown>;
    const policy: Partial<RetentionPolicy> = {};
    for (const field of ["retentionDays", "maxRuns", "maxBytes"] as const) {
      const v = p[field];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
        return invalid(`policy.${field} must be an integer >= 1`);
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
    if (typeof b.afterSeq !== "number" || !Number.isInteger(b.afterSeq) || b.afterSeq < 0)
      return invalid("afterSeq must be a non-negative integer");
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
    if (typeof b.limit !== "number" || !Number.isInteger(b.limit) || b.limit < 1)
      return invalid("limit must be a positive integer");
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
    if (typeof v !== "string" || v.length > MAX_KEY_CHARS)
      return invalid(`${field} must be a string of at most ${MAX_KEY_CHARS} characters`);
    query[field] = v;
  }
  if (b.visibleTo !== undefined) {
    // A malformed filter is a 400, never "all": the bot degrades to live rows
    // rather than the DO widening what an actor may see.
    if (!isRunVisibilityFilter(b.visibleTo)) return invalid("visibleTo must be a run visibility filter");
    if (boundParameters(b.visibleTo) > DO_MAX_BOUND_PARAMETERS - RUN_LIST_BASE_PARAMETERS)
      return invalid(`visibleTo names more than ${DO_MAX_BOUND_PARAMETERS - RUN_LIST_BASE_PARAMETERS} ids`);
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

/** A scope key is an opaque namespaced id (`org:acme`): non-empty,
 *  bounded, no whitespace or control characters. `fieldName` names the body
 *  field in the error (the run routes call theirs
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

/** `POST /list {scopeKey, limit, query?}`. */
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

/** `POST /forget {scopeKey, id}`: the id is an opaque key, same caps as scopeKey. */
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
  if (
    typeof c.sourceThreadKey !== "string" ||
    c.sourceThreadKey.length === 0 ||
    c.sourceThreadKey.length > MAX_KEY_CHARS
  ) {
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
    if (typeof c.sourceRunId !== "string" || c.sourceRunId.length > MAX_KEY_CHARS)
      return invalid(`${at}.sourceRunId must be a string`);
    out.sourceRunId = c.sourceRunId;
  }
  if (c.confidence !== undefined) {
    if (typeof c.confidence !== "number" || !Number.isFinite(c.confidence) || c.confidence < 0 || c.confidence > 1) {
      return invalid(`${at}.confidence must be a number in [0, 1]`);
    }
    out.confidence = c.confidence;
  }
  if (c.supersedes !== undefined) {
    if (typeof c.supersedes !== "string" || c.supersedes.length > MAX_KEY_CHARS)
      return invalid(`${at}.supersedes must be a string`);
    out.supersedes = c.supersedes;
  }
  return { ok: true, value: out };
}

/** Upper bound on a caller-supplied per-scope cap. */
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

// ---------------------------------------------------------------------------
// Live-run transcripts (run-history item 32)
// ---------------------------------------------------------------------------

/** One object per LIVE run, named by run id: the raw transcript a resumed run
 *  continues from, one row per content part (never near the 2 MB row limit),
 *  attachments over the reference threshold stored once. Fenced by its own
 *  `owner` row — set at claim, replaced by reclaim — because this object and
 *  the history object commit independently, and a zombie generation whose
 *  history write is about to be refused must not land transcript rows either. */
export class RunTranscriptDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS owner (k INTEGER PRIMARY KEY CHECK (k = 1), gen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_messages (
        idx INTEGER NOT NULL,
        part INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (idx, part)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        ref TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
  }

  async setOwner(gen: string): Promise<{ ok: true }> {
    this.sql.exec(`INSERT INTO owner (k, gen) VALUES (1, ?) ON CONFLICT(k) DO UPDATE SET gen = excluded.gen`, gen);
    return { ok: true };
  }

  private owner(): string | undefined {
    return this.sql.exec<{ gen: string }>(`SELECT gen FROM owner WHERE k = 1`).toArray()[0]?.gen;
  }

  async write(gen: string, rows: TranscriptRow[], attachments: TranscriptAttachment[]): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const owner = this.owner();
      if (owner === undefined) {
        out = { ok: false, reason: "unknown-run" };
        return;
      }
      if (owner !== gen) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      for (const a of attachments) {
        this.sql.exec(
          `INSERT OR REPLACE INTO attachments (ref, media_type, data) VALUES (?, ?, ?)`,
          a.ref,
          a.mediaType,
          a.data,
        );
      }
      for (const r of rows) {
        this.sql.exec(`INSERT OR REPLACE INTO run_messages (idx, part, json) VALUES (?, ?, ?)`, r.idx, r.part, r.json);
      }
    });
    return out;
  }

  async read(): Promise<{ rows: TranscriptRow[]; attachments: TranscriptAttachment[] }> {
    const rows = this.sql
      .exec<{ idx: number; part: number; json: string }>(`SELECT idx, part, json FROM run_messages ORDER BY idx, part`)
      .toArray();
    const attachments = this.sql
      .exec<{ ref: string; media_type: string; data: string }>(`SELECT ref, media_type, data FROM attachments`)
      .toArray()
      .map((a) => ({ ref: a.ref, mediaType: a.media_type, data: a.data }));
    return { rows, attachments };
  }

  async clear(): Promise<{ ok: true }> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM run_messages`);
      this.sql.exec(`DELETE FROM attachments`);
      this.sql.exec(`DELETE FROM owner`);
    });
    return { ok: true };
  }
}

const LEDGER_ROUTES = new Set([
  "/runs/coordinator/put",
  "/runs/coordinator/get",
  "/runs/coordinator/units/put",
  "/runs/coordinator/units/list",
  "/runs/claim",
  "/runs/heartbeat",
  "/runs/append",
  "/runs/step",
  "/runs/state",
  "/runs/inbox",
  "/runs/inbox/read",
  "/runs/stop",
  "/runs/handoff",
  "/runs/finishing",
  "/runs/finish",
  "/runs/abandon",
  "/runs/reclaim",
  "/runs/live",
  "/runs/live-events",
  "/runs/transcript/owner",
  "/runs/transcript/write",
  "/runs/transcript/read",
  "/runs/transcript/clear",
]);

/** Routes whose bodies may carry a record, a transcript chunk, or an event batch. */
const WIDE_BODY_ROUTES = new Set(["/runs/put", "/runs/finish", "/runs/append", "/runs/transcript/write"]);
/** A delivery snapshot written whole, or a refresh's patch: every merged pull request's reviews and
 *  its branch's workflow runs — about 7 KB a pull request (measured: 291 pull requests, 2.1 MB), so
 *  a first read at the listing cap is under 6 MB and a busy repository's whole window many MB. */
const MAX_SNAPSHOT_BODY_BYTES = 16 * 1024 * 1024;

/** The request body ceiling per route, decided after routing and before the parse. */
function bodyFenceFor(pathname: string): number {
  if (WIDE_BODY_ROUTES.has(pathname)) return MAX_RUN_PUT_BODY_BYTES;
  if (pathname === "/delivery/put" || pathname === "/delivery/merge") return MAX_SNAPSHOT_BODY_BYTES;
  return MAX_BODY_BYTES;
}

const gen = (v: unknown): Validated<string> =>
  typeof v === "string" && GEN_PATTERN.test(v)
    ? { ok: true, value: v }
    : invalid("gen must match the generation pattern");

function parseLeaseMs(v: unknown): Validated<number> {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1_000 || v > 3_600_000) {
    return invalid("leaseMs must be an integer between 1000 and 3600000");
  }
  return { ok: true, value: v };
}

function parseClaim(b: Record<string, unknown>): Validated<ClaimRequest> {
  const run = b.run;
  if (typeof run !== "object" || run === null) return invalid("run must be an object");
  const r = run as Record<string, unknown>;
  const runId = parseRunId(r.runId);
  if (!runId.ok) return runId;
  const g = gen(r.gen);
  if (!g.ok) return g;
  const lease = parseLeaseMs(r.leaseMs);
  if (!lease.ok) return lease;
  if (typeof r.threadKey !== "string" || r.threadKey.length === 0 || r.threadKey.length > 256) {
    return invalid("run.threadKey must be a non-empty string");
  }
  if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt))
    return invalid("run.startedAt must be a number");
  if (typeof r.meta !== "object" || r.meta === null) return invalid("run.meta must be an object");
  // A coordinator's tag (run-history item 48) is stored at the claim and read
  // by the finish's send and the refusal a second claim meets: shaped or
  // refused, and both fields or neither — one alone is no tag.
  const meta = r.meta as Record<string, unknown>;
  if ((meta.parentInstanceId === undefined) !== (meta.idempotencyKey === undefined))
    return invalid("run.meta.parentInstanceId and run.meta.idempotencyKey come together or not at all");
  if (meta.parentInstanceId !== undefined) {
    if (typeof meta.parentInstanceId !== "string" || !INSTANCE_ID_PATTERN.test(meta.parentInstanceId))
      return invalid("run.meta.parentInstanceId must be a Workflow instance id");
  }
  if (meta.idempotencyKey !== undefined) {
    if (typeof meta.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(meta.idempotencyKey))
      return invalid("run.meta.idempotencyKey must be <parentInstanceId>:<step>");
  }
  if (typeof r.system !== "string") return invalid("run.system must be a string");
  if (!Array.isArray(r.tools)) return invalid("run.tools must be an array");
  if (r.card !== undefined && r.card !== null) {
    const c = r.card as Record<string, unknown>;
    if (typeof c.channel !== "string" || typeof c.ts !== "string") return invalid("run.card must be {channel, ts}");
  }
  if (r.state !== undefined && (typeof r.state !== "object" || r.state === null))
    return invalid("run.state must be an object");
  if (r.phase !== undefined && r.phase !== "attaching" && r.phase !== "live")
    return invalid("run.phase must be attaching or live");
  return {
    ok: true,
    value: {
      runId: runId.value,
      threadKey: r.threadKey,
      gen: g.value,
      leaseMs: lease.value,
      startedAt: r.startedAt,
      meta: r.meta as ClaimRequest["meta"],
      card: (r.card as ClaimRequest["card"]) ?? null,
      system: r.system,
      tools: r.tools as ClaimRequest["tools"],
      ...(r.state ? { state: r.state as RunState } : {}),
      ...(r.phase !== undefined ? { phase: r.phase as "attaching" | "live" } : {}),
    },
  };
}

function parseStep(v: unknown): Validated<StepRecord> {
  if (typeof v !== "object" || v === null) return invalid("record must be an object");
  const s = v as Record<string, unknown>;
  for (const k of ["step", "seq", "turnIndex", "inboxConsumedSeq", "remainingMs", "turn", "iteration"] as const) {
    if (typeof s[k] !== "number" || !Number.isInteger(s[k]) || (s[k] as number) < 0) {
      return invalid(`record.${k} must be a non-negative integer`);
    }
  }
  if (!Array.isArray(s.inFlight)) return invalid("record.inFlight must be an array");
  for (const c of s.inFlight) {
    const call = c as Record<string, unknown>;
    if (typeof call?.callId !== "string" || typeof call?.tool !== "string")
      return invalid("record.inFlight entries must be {callId, tool}");
  }
  return { ok: true, value: s as unknown as StepRecord };
}

function parseTranscriptRows(v: unknown): Validated<TranscriptRow[]> {
  if (!Array.isArray(v)) return invalid("rows must be an array");
  for (const r of v) {
    const row = r as Record<string, unknown>;
    if (
      typeof row?.idx !== "number" ||
      !Number.isInteger(row.idx) ||
      row.idx < 0 ||
      typeof row?.part !== "number" ||
      !Number.isInteger(row.part) ||
      row.part < 0 ||
      typeof row?.json !== "string"
    ) {
      return invalid("rows entries must be {idx, part, json}");
    }
  }
  return { ok: true, value: v as TranscriptRow[] };
}

function parseAttachments(v: unknown): Validated<TranscriptAttachment[]> {
  if (!Array.isArray(v)) return invalid("attachments must be an array");
  for (const a of v) {
    const att = a as Record<string, unknown>;
    if (typeof att?.ref !== "string" || typeof att?.mediaType !== "string" || typeof att?.data !== "string") {
      return invalid("attachments entries must be {ref, mediaType, data}");
    }
  }
  return { ok: true, value: v as TranscriptAttachment[] };
}

/** The ledger routes (run-history items 28–34). Bodies are validated before
 *  any object call; fenced answers are 409 with the reason; observability
 *  lines carry ids and counts only. */
async function handleLedger(pathname: string, body: unknown, env: Env): Promise<Response> {
  if (typeof body !== "object" || body === null) return json({ error: "body must be a JSON object" }, 400);
  const b = body as Record<string, unknown>;
  const fenced = (r: FenceResult) => (r.ok ? json(r) : json(r, 409));

  if (pathname.startsWith("/runs/transcript/")) {
    const runId = parseRunId(b.runId);
    if (!runId.ok) return json({ error: runId.error }, 400);
    const stub = env.RUN_TRANSCRIPTS.get(env.RUN_TRANSCRIPTS.idFromName(runId.value));
    if (pathname === "/runs/transcript/owner") {
      const g = gen(b.gen);
      if (!g.ok) return json({ error: g.error }, 400);
      return json(await stub.setOwner(g.value));
    }
    if (pathname === "/runs/transcript/write") {
      const g = gen(b.gen);
      if (!g.ok) return json({ error: g.error }, 400);
      const rows = parseTranscriptRows(b.rows);
      if (!rows.ok) return json({ error: rows.error }, 400);
      const attachments = parseAttachments(b.attachments);
      if (!attachments.ok) return json({ error: attachments.error }, 400);
      const r = await stub.write(g.value, rows.value, attachments.value);
      console.log(
        `[runs/transcript/write] ${runId.value} <- ${rows.value.length} row(s), ${attachments.value.length} attachment(s), ok=${r.ok}`,
      );
      return fenced(r);
    }
    if (pathname === "/runs/transcript/read") return json(await stub.read());
    return json(await stub.clear());
  }

  const key = parseStoreKey(b);
  if (!key.ok) return json({ error: key.error }, 400);
  const stub = env.RUNS.get(env.RUNS.idFromName(key.value));
  const now = systemClock();

  if (pathname === "/runs/claim") {
    const req = parseClaim(b);
    if (!req.ok) return json({ error: req.error }, 400);
    const r = await stub.claim(req.value, now);
    console.log(
      `[runs/claim] ${key.value} ${req.value.runId} on ${req.value.threadKey} → ${r.ok ? "claimed" : r.reason}`,
    );
    return r.ok ? json(r) : json(r, 409);
  }
  if (pathname === "/runs/live") return json({ runs: await stub.listLive() });
  if (pathname === "/runs/reclaim") {
    const g = gen(b.gen);
    if (!g.ok) return json({ error: g.error }, 400);
    const lease = parseLeaseMs(b.leaseMs);
    if (!lease.ok) return json({ error: lease.error }, 400);
    const at = typeof b.now === "number" && Number.isFinite(b.now) ? b.now : now;
    // The RPC type mapping reads the row's open-ended JSON fields as
    // unserializable; the values are plain JSON, so the cast only restores the
    // declared shape.
    const runs = (await stub.reclaim(g.value, at, lease.value)) as unknown as ReclaimedRun[];
    console.log(`[runs/reclaim] ${key.value} ${g.value} took ${runs.length} run(s)`);
    return json({ runs });
  }
  if (pathname === "/runs/handoff") {
    const g = gen(b.gen);
    if (!g.ok) return json({ error: g.error }, 400);
    const ids: unknown[] = Array.isArray(b.runIds) ? b.runIds : [];
    if (!Array.isArray(b.runIds) || !ids.every((id) => typeof id === "string" && RUN_ID_PATTERN.test(id))) {
      return json({ error: "runIds must be an array of run ids" }, 400);
    }
    const runIds = ids as string[];
    const r = await stub.handoff(g.value, runIds);
    console.log(`[runs/handoff] ${key.value} ${g.value} marked ${r.marked.length}/${runIds.length}`);
    return json(r);
  }

  // The coordinator's parent records (run-history item 49): the record whole,
  // validated by the shared contract; a read by instance id.
  if (pathname === "/runs/coordinator/put") {
    if (!isCoordinatorInstance(b.instance))
      return json({ error: "instance must be a coordinator instance record" }, 400);
    const r = await stub.putInstance(b.instance);
    console.log(`[runs/coordinator/put] ${key.value} ${b.instance.id} → ${r.ok ? "stored" : r.reason}`);
    return r.ok ? json(r) : json(r, 409);
  }
  if (pathname === "/runs/coordinator/get") {
    if (typeof b.id !== "string" || !INSTANCE_ID_PATTERN.test(b.id))
      return json({ error: "id must be a Workflow instance id" }, 400);
    return json({ instance: await stub.getInstance(b.id) });
  }
  // The units of the plan an instance runs (run-history item 50): rows
  // validated by the shared contract, each replaced whole; a list by instance.
  if (pathname === "/runs/coordinator/units/put") {
    if (!Array.isArray(b.units) || b.units.length === 0 || b.units.length > MAX_UNITS_PER_PUT)
      return json({ error: `units must be a non-empty array of at most ${MAX_UNITS_PER_PUT} unit rows` }, 400);
    if (!b.units.every(isCoordinatorUnit)) return json({ error: "every unit must be a coordinator unit row" }, 400);
    const units = b.units as CoordinatorUnit[];
    const r = await stub.putUnits(units, now);
    console.log(`[runs/coordinator/units/put] ${key.value} ${units[0]!.instanceId} ${units.length} row(s)`);
    return json(r);
  }
  if (pathname === "/runs/coordinator/units/list") {
    if (typeof b.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(b.instanceId))
      return json({ error: "instanceId must be a Workflow instance id" }, 400);
    return json({ units: await stub.listUnits(b.instanceId) });
  }

  const runId = parseRunId(b.runId);
  if (!runId.ok) return json({ error: runId.error }, 400);
  if (pathname === "/runs/inbox") {
    if (typeof b.message !== "object" || b.message === null) return json({ error: "message must be an object" }, 400);
    return json(await stub.pushInbox(runId.value, b.message as Record<string, unknown>));
  }
  if (pathname === "/runs/live-events") return json({ events: await stub.liveEvents(runId.value) });
  if (pathname === "/runs/inbox/read") {
    const after = b.afterSeq === undefined ? 0 : b.afterSeq;
    if (typeof after !== "number" || !Number.isInteger(after) || after < 0) {
      return json({ error: "afterSeq must be a non-negative integer" }, 400);
    }
    return json({ items: await stub.readInbox(runId.value, after) });
  }
  if (pathname === "/runs/stop") {
    if (b.mode !== "soft" && b.mode !== "hard") return json({ error: "mode must be soft or hard" }, 400);
    return json(await stub.requestStop(runId.value, b.mode, now));
  }

  const g = gen(b.gen);
  if (!g.ok) return json({ error: g.error }, 400);
  if (pathname === "/runs/heartbeat") {
    const lease = parseLeaseMs(b.leaseMs);
    if (!lease.ok) return json({ error: lease.error }, 400);
    const r = await stub.heartbeat(runId.value, g.value, lease.value, now);
    return r.ok ? json(r) : json(r, 409);
  }
  if (pathname === "/runs/append") {
    if (!Array.isArray(b.events)) return json({ error: "events must be an array" }, 400);
    const events: Array<{ seq: number; json: string }> = [];
    for (const e of b.events) {
      const ev = e as Record<string, unknown>;
      if (typeof ev?.seq !== "number" || !Number.isInteger(ev.seq) || ev.seq < 1)
        return json({ error: "every event needs an integer seq ≥ 1" }, 400);
      const text = JSON.stringify(e);
      if (utf8ByteLength(text) > MAX_EVENT_BYTES)
        return json({ error: `event ${ev.seq} exceeds ${MAX_EVENT_BYTES} bytes` }, 400);
      events.push({ seq: ev.seq, json: text });
    }
    const r = await stub.appendEvents(runId.value, g.value, events);
    console.log(`[runs/append] ${key.value} ${runId.value} <- ${events.length} event(s), ok=${r.ok}`);
    return fenced(r);
  }
  if (pathname === "/runs/step") {
    const record = parseStep(b.record);
    if (!record.ok) return json({ error: record.error }, 400);
    return fenced(await stub.recordStep(runId.value, g.value, record.value));
  }
  if (pathname === "/runs/state") {
    if (typeof b.state !== "object" || b.state === null) return json({ error: "state must be an object" }, 400);
    return fenced(await stub.setState(runId.value, g.value, b.state as RunState));
  }
  if (pathname === "/runs/finishing") return fenced(await stub.finishing(runId.value, g.value));
  if (pathname === "/runs/abandon") {
    const r = await stub.abandon(runId.value, g.value);
    console.log(`[runs/abandon] ${key.value} ${runId.value} ok=${r.ok}${r.ok ? "" : ` ${r.reason}`}`);
    return fenced(r);
  }
  if (pathname === "/runs/finish") {
    const parsed = parseRunPut({ ...b, storeKey: key.value });
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    if (parsed.value.record.id !== runId.value) return json({ error: "record.id must equal runId" }, 400);
    const r = await stub.finish(runId.value, g.value, parsed.value.record, parsed.value.proposal);
    console.log(
      `[runs/finish] ${key.value} ${runId.value} ok=${r.ok}${r.ok ? ` stored=${r.stored} event=${r.event}` : ` ${r.reason}`}`,
    );
    return r.ok ? json(r) : json(r, 409);
  }
  return json({ error: "not found" }, 404);
}

/** The `/runs/*` routes. Observability lines carry ids + counts only —
 *  never event text. A bad `id` is 400 before any DO call. */
async function handleRuns(pathname: string, body: unknown, env: Env): Promise<Response> {
  const stub = (key: string) => env.RUNS.get(env.RUNS.idFromName(key));
  if (LEDGER_ROUTES.has(pathname)) return handleLedger(pathname, body, env);
  if (pathname === "/runs/put") {
    const parsed = parseRunPut(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { storeKey, record, proposal } = parsed.value;
    const result = await stub(storeKey).put(record, proposal);
    console.log(
      `[runs/put] ${storeKey} <- ${record.id} (${record.storedEventCount} events, stored=${result.stored}, ${result.retained} retained)`,
    );
    return json(result);
  }
  if (pathname === "/runs/get") {
    const parsed = parseRunTarget(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const record = await stub(parsed.value.storeKey).get(parsed.value.id);
    console.log(
      `[runs/get] ${parsed.value.storeKey} ${parsed.value.id} -> ${record ? `${record.events.length} events` : "not found"}`,
    );
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
    console.log(
      `[runs/events] ${storeKey} ${id} after ${afterSeq} -> ${result ? `${result.events.length} events` : "not found"}`,
    );
    return json(result ?? { events: null });
  }
  // /runs/delete
  const parsed = parseRunTarget(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const deleted = await stub(parsed.value.storeKey).delete(parsed.value.id);
  console.log(`[runs/delete] ${parsed.value.storeKey} ${parsed.value.id} -> deleted=${deleted}`);
  return json({ ok: true, deleted });
}

const ROUTES = new Set([
  ...CONFIG_ROUTES,
  ...DELIVERY_ROUTES,
  "/retrieve",
  "/write",
  "/list",
  "/forget",
  "/schedules/record",
  "/schedules/latest",
  "/runs/put",
  "/runs/get",
  "/runs/summary",
  "/runs/list",
  "/runs/events",
  "/runs/delete",
  ...LEDGER_ROUTES,
]);

/** The two decisions `fetch` makes once and hands down: is the path one of
 *  ours, and did the bearer check out. `handleRequest` answers from them in the
 *  order it always did (404, then 405, then 401) and never re-decides. */
interface Admission {
  known: boolean;
  authorized: boolean;
}

/** Every request, once `fetch` has decided whether it gets a root. */
async function handleRequest(request: Request, env: Env, admission: Admission): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz" && request.method === "GET")
    return json({ ok: true, build: BUILD, features: ["memory", "schedules", "runs", "config", "delivery"] });
  if (!admission.known) return json({ error: "not found" }, 404);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!admission.authorized) return json({ error: "unauthorized" }, 401);

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
  // The ledger's bulk routes carry a finished record, a transcript chunk, or
  // an event batch (32 × 64 KiB) and share /runs/put's fence; a delivery
  // snapshot carries a whole window of pull request facts and has its own.
  const maxBodyBytes = bodyFenceFor(url.pathname);
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
    console.log(
      `[schedules/record] ${firing.schedule} ${firing.outcome}${firing.runId ? ` run ${firing.runId}` : ""} (${retained} retained)`,
    );
    return json({ ok: true, retained });
  }
  if (url.pathname === "/schedules/latest") {
    const firings = await env.SCHEDULES.get(env.SCHEDULES.idFromName(SCHEDULES_OBJECT)).latest();
    console.log(`[schedules/latest] -> ${firings.length} schedules`);
    return json({ firings });
  }
  if (url.pathname.startsWith("/runs/")) return handleRuns(url.pathname, body, env);
  if (url.pathname.startsWith("/config/")) return handleConfig(url.pathname, body, env);
  if (url.pathname.startsWith("/delivery/")) return handleDelivery(url.pathname, body, env);

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
  console.log(
    `[write] ${scopeKey} <- ${records.length} candidates${counts.evicted > 0 ? ` (evicted ${counts.evicted})` : ""}`,
  );
  return json({ ok: true, ...counts });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One `state.fetch` root per authenticated, routed request (docs/reference/specs/
    // tracing.md item 22), adopting the bot's trace context — never before the
    // bearer checked out, so a refusal, an unknown path or the unauthenticated
    // /healthz leaves no line and the route attr is always a word from ROUTES.
    const url = new URL(request.url);
    const admission: Admission = { known: ROUTES.has(url.pathname), authorized: authorized(env, request) };
    if (!admission.known || !admission.authorized) return handleRequest(request, env, admission);
    const root = startAdoptedRoot(tracer, "state.fetch", {
      sinks: traceSinks,
      traceparent: request.headers.get("traceparent"),
      attrs: { route: url.pathname },
    });
    try {
      const res = await handleRequest(request, env, admission);
      root.end(res.status >= 500 ? "error" : "ok", { httpStatus: res.status });
      return res;
    } catch (err) {
      root.fail(err);
      root.end("error");
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
