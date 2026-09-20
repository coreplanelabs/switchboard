import { DurableObject } from "cloudflare:workers";
import type { MemoryCandidate, MemoryRecord } from "../../src/core/memory/types.ts";
import {
  DEFAULT_SCOPE_CAP,
  mintRecord,
  normalizeText,
  planEviction,
  planWrite,
  rankRecords,
  rejectionMarkers,
} from "../../src/core/memory/engine.ts";
import { tokenize } from "../../src/core/memory/scorer.ts";
import { FIRING_DETAIL_MAX, isScheduleFiring, type ScheduleFiring } from "../../src/core/schedules.ts";
import { isCostsSnapshot, type CostsSnapshot } from "../../src/core/costsSnapshotStore.ts";
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
  isRunSession,
  isRunVisibilityFilter,
  normalizeStored,
  pullRequestNumberOf,
  RETENTION_BOUNDS,
  RUN_EVENTS_DEFAULT_PAGE,
  RUN_EVENTS_MAX_PAGE,
  RUN_ID_PATTERN,
  clampListLimit,
  RUN_LIST_MAX_LIMIT,
  sameStoredVersion,
  SESSION_KEY_PATTERN,
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
import {
  attachmentRefsOf,
  DEFAULT_SESSION_LOG_MAX_BYTES,
  droppedToolResultRow,
  GAP_MARKER,
  NOTEPAD_MAX_BYTES,
  planSessionTrim,
  roleOfStoredRow,
  rowKind,
  SEARCH_MAX_HITS,
  sessionsToDrop,
  tailCut,
  textOfStoredRow,
} from "../../src/core/runLedger/sessionLog.ts";
import type { RunEvent } from "../../src/core/runEvents.ts";
import {
  isRunUsage,
  usageOfEvents,
  type RunUsage,
  type RunUsageRows,
  type UsageIdentity,
  type UsageRun,
} from "../../src/core/runUsage.ts";
import {
  checkFence,
  decideClaim,
  decideClaimWrite,
  decideIntakeInsert,
  phaseTransition,
  reclaimPhase,
  selectReclaim,
} from "../../src/core/runLedger/decisions.ts";
import { intakeReceiptRetentionMs, minutesToMs, PLANE } from "../../src/core/budgets.ts";
import {
  decide,
  effectCapRefusal,
  planeAskAnswerOf,
  planeAskWordOf,
  RESIDENT_DRAIN_WINDOW,
  type PlaneAskAnswer,
  type PlaneLevelRow,
  type PlaneAckOutcome,
  type PlaneEffect,
  type PlaneEvent,
  type PlaneOutcomePost,
  type PlaneQueueRow,
  type PlaneReservation,
  type PlaneStage,
  type PlaneState,
  type PlaneWrite,
} from "../../src/core/plane/decide.ts";
import {
  IDEMPOTENCY_KEY_PATTERN,
  capThreadEvent,
  INSTANCE_ID_PATTERN,
  isCoordinatorInstance,
  isCoordinatorUnit,
  isThreadEvent,
  sendRunFinished,
  UNIT_PATTERN,
  type CoordinatorInstance,
  type CoordinatorUnit,
  type RunFinishedSend,
  type ThreadEvent,
} from "../../src/core/coordinator/contract.ts";
import {
  GEN_PATTERN,
  isIntakeReceipt,
  type ClaimRequest,
  type ClaimResult,
  type FenceResult,
  type IntakeQuery,
  type IntakeReceipt,
  type IntakeWriteResult,
  type LivePhase,
  type LiveRunRow,
  type ReclaimedRun,
  type RunState,
  type SessionHit,
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
import { isRunMetricsPoint, pointTurnsFinal, type RunMetricsPoint } from "../../src/core/runMetrics.ts";
import { AnalyticsEngineSink, NullSink, type RunMetricsSink } from "./runMetricsSink.ts";
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
//   POST /write    {scopeKey, records: MemoryCandidate[]} → {ok, inserted, deduped, restated, superseded, evicted}
//   POST /sweep    {scopeKey, dryRun?} → {ok, swept} (+ ids under dryRun — the marked rows, flipped to `swept`)
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
//   POST /runs/put    {storeKey, record, policy?, policyUpdatedAt?, point?} → {ok, retained, stored, rewritten}
//   POST /runs/get    {storeKey, id} → {record: RunRecord | null}      (unknown/expired: null, 200)
//   POST /runs/list   {storeKey, limit?, before?, beforeId?, sinceMs?, agent?, channel?, threadKey?, parentRunId?}
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
  /** Live-run transcripts of runs claimed before the session log existed (run-history
   *  item 32): one RunTranscriptDO per such run, named by run id. New runs never write here. */
  RUN_TRANSCRIPTS: DurableObjectNamespace<RunTranscriptDO>;
  /** Session logs (docs/reference/specs/session-log.md): one SessionLogDO per thread and
   *  agent, named `<threadKey>:<agent>` — every run of the session appends its rows. */
  SESSION_LOGS: DurableObjectNamespace<SessionLogDO>;
  /** Delivery snapshots (delivery item 10): ONE DeliveryDO (named "delivery"), one snapshot per repository. */
  DELIVERY: DurableObjectNamespace<DeliveryDO>;
  /** The costs snapshot (costs item 6): ONE CostsSnapshotDO (named "costs"), one snapshot per installation. */
  COSTS: DurableObjectNamespace<CostsSnapshotDO>;
  /** The ship coordinator Workflow in the bot's shim Worker (run-history item
   *  47): where `RunHistoryDO.finish` sends `run-finished-<runId>` for a record
   *  carrying `parentInstanceId`. Optional: this Worker deploys without it (the
   *  binding is a cross-script one, and the class must exist on the bot before
   *  the state Worker may name it), and a finish then commits with no event. */
  SHIP_COORDINATOR?: Workflow;
  /** The run-metrics dataset (docs/reference/specs/run-metrics.md): where the
   *  RunHistoryDO writes one point per run whose row turned final. Optional
   *  like SHIP_COORDINATOR: this Worker deploys without it and every answer is
   *  byte-identical — the NullSink swallows the points. */
  RUN_METRICS?: AnalyticsEngineDataset;
  /** The dataset's name, rendered beside the binding, so `/healthz` can answer
   *  `runMetrics:<dataset>` and the bot's boot probe can compare names. */
  RUN_METRICS_DATASET?: string;
  /** The bot Worker, for the plane's effect push (record 0064, "Where it
   *  lives"): committed effects are POSTed to its bearer-gated
   *  `/plane/effects`, which forwards to the container. Optional like
   *  SHIP_COORDINATOR — without it effects ride the heartbeat answers alone. */
  BOT?: Fetcher;
  MEMORY_TOKEN?: string;
}

/** The single DeliveryDO's name — every repository's snapshot lives in one object. */
const DELIVERY_OBJECT = "delivery";

/** The single CostsSnapshotDO's name — the installation has one costs snapshot. */
const COSTS_OBJECT = "costs";

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
/** A `recall` query's size and the most hits one answers (session-log item 10):
 *  a query is a few words, and the tool's default is five. */
const MAX_SEARCH_QUERY_BYTES = 1_024;
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
  ): Promise<{ inserted: number; deduped: number; restated: number; superseded: number; evicted: number }> {
    const counts = { inserted: 0, deduped: 0, restated: 0, superseded: 0, evicted: 0 };
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
        // insert a duplicate active row. A `restates` id is looked up first
        // (the restate target); when it misses — not active, or another
        // scope's id, which this DO simply doesn't hold — the candidate takes
        // today's pool, so planWrite falls through to dedup-or-insert.
        const restatePool = cand.restates
          ? this.sql
              .exec<Row>(`SELECT * FROM records WHERE id = ? AND status = 'active'`, cand.restates)
              .toArray()
              .map(toRecord)
          : [];
        const relevant =
          restatePool.length > 0
            ? restatePool
            : (cand.supersedes
                ? this.sql.exec<Row>(`SELECT * FROM records WHERE id = ? AND status = 'active'`, cand.supersedes)
                : this.sql.exec<Row>(
                    `SELECT * FROM records WHERE status = 'active' AND norm = ? ORDER BY seq`,
                    normalizeText(cand.text),
                  )
              )
                .toArray()
                .map(toRecord);
        const plan = planWrite(relevant, cand, (c) => mintRecord(scopeKey, seq++, now, c));
        if (plan.action === "restate") {
          // The shown record is refreshed in place; COALESCE keeps the stored
          // confidence when the plan carries none (neither side had a value).
          this.sql.exec(
            `UPDATE records SET use_count = use_count + 1, last_used_at = ?, confidence = COALESCE(?, confidence) WHERE id = ?`,
            now,
            plan.confidence ?? null,
            plan.target.id,
          );
          counts.restated++;
          continue;
        }
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

  /** Human view and the repository window's read (docs/reference/specs/memory.md items 22, 26): the
   *  scope's ACTIVE rows, newest first, no usage bump. With `query`, only rows
   *  an FTS token hits (the same quoted-OR MATCH as retrieve, so user text
   *  never reaches the FTS parser as syntax); a query with no tokens lists
   *  nothing. With `kind`, only rows of that kind (the window lists facts). */
  async list(_scopeKey: string, limit: number, query?: string, kind?: MemoryRecord["kind"]): Promise<MemoryRecord[]> {
    if (query === undefined) {
      return this.sql
        .exec<Row>(
          `SELECT * FROM records WHERE status = 'active'${kind === undefined ? "" : " AND kind = ?"} ORDER BY seq DESC LIMIT ?`,
          ...(kind === undefined ? [] : [kind]),
          limit,
        )
        .toArray()
        .map(toRecord);
    }
    const match = ftsMatchExpr(query);
    if (match === null) return [];
    return this.sql
      .exec<Row>(
        `SELECT r.* FROM records r
           JOIN records_fts f ON f.id = r.id
          WHERE r.status = 'active'${kind === undefined ? "" : " AND r.kind = ?"} AND records_fts MATCH ?
          ORDER BY r.seq DESC
          LIMIT ?`,
        ...(kind === undefined ? [] : [kind]),
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

  /** Human control (docs/reference/specs/memory.md item 27): retire every
   *  ACTIVE fact whose text the write gate would reject today — the same
   *  `rejectionMarkers` the bot's write path runs, imported from the shared
   *  engine, so the sweep and the gate can never disagree. Summaries are never
   *  gated, so never swept. The scan, the flips and the FTS deletes run in ONE
   *  sync transaction (the per-scope cap's atomicity rule): the sweep commits
   *  whole or not at all. Idempotent — swept rows are no longer active, so a
   *  second call answers 0. Under `dryRun` nothing flips. */
  async sweep(_scopeKey: string, dryRun: boolean): Promise<{ swept: number; ids: string[] }> {
    return this.ctx.storage.transactionSync(() => {
      const ids = this.sql
        .exec<Row>(`SELECT * FROM records WHERE status = 'active' AND kind = 'fact'`)
        .toArray()
        .filter((row) => rejectionMarkers(row.text).length > 0)
        .map((row) => row.id);
      if (!dryRun) {
        for (const id of ids) {
          // Soft delete for the record row, hard delete for its FTS entry —
          // the forget/supersede/evict hygiene rule (§15).
          this.sql.exec(`UPDATE records SET status = 'swept' WHERE id = ? AND status = 'active'`, id);
          this.sql.exec(`DELETE FROM records_fts WHERE id = ?`, id);
        }
      }
      return { swept: ids.length, ids };
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

/** What the bot posts to mint a confirmation: the facts this object judges on
 *  and the bot's own row as an opaque body (routing-and-config item 25). */
interface ConfirmationInput {
  id: string;
  threadKey: string;
  requester: string;
  body: Record<string, unknown>;
}
/** A stored confirmation as a consume returns it: the input plus the expiry this object stamped. */
interface ConfirmationRow extends ConfirmationInput {
  expiresAt: number;
}
/** Why a consume or a cancel refused: the row is gone (`used`), past its expiry (`expired`), or someone else's (`foreign`). */
type ConfirmationRefusal = "used" | "expired" | "foreign";
/** A refusal names the row where one still exists — `expired` (deleted here)
 *  and `foreign` (kept) — so the bot can record the click's refusal against
 *  the command that was bound (record 0054); `used` has no row to name. */
type ConfirmationOutcome = { row: ConfirmationRow } | { refused: ConfirmationRefusal; row?: ConfirmationRow };
type ConfirmationCancelOutcome = { ok: true } | { refused: Exclude<ConfirmationRefusal, "expired"> };
/** The consume log's word: a refusal may carry the row it names (expired,
 *  foreign), so the refusal is the discriminant, never the row's presence. The
 *  parameter is the declared union, where the narrowing holds; the stub's
 *  return type narrows to `never` across `in`. */
function consumeWord(outcome: ConfirmationOutcome): string {
  return "refused" in outcome ? outcome.refused : "consumed";
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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
      CREATE TABLE IF NOT EXISTS confirmations (
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        requester TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        body TEXT NOT NULL
      );
    `);
  }

  // ---- Confirmations (docs/reference/specs/routing-and-config.md item 25): the
  // row a routed write is offered as, minted by the bot and consumed once at
  // the click. The body is the bot's row, opaque here; this object owns the
  // three facts the consume decides on — the thread (one pending row per
  // thread), the requester (the click must be theirs) and the expiry, stamped
  // and judged on this object's clock so two bot processes alive during a roll
  // read one answer. Nothing sweeps: expiry is checked on touch.

  /** Insert the row and drop the thread's older one in one transaction; the
   *  expiry is `now + ttlMs`, stamped here and answered to the caller. */
  async putConfirmation(row: ConfirmationInput, ttlMs: number, now: number): Promise<number> {
    const expiresAt = now + ttlMs;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM confirmations WHERE thread_key = ?`, row.threadKey);
      this.sql.exec(
        `INSERT OR REPLACE INTO confirmations (id, thread_key, requester, expires_at, body) VALUES (?, ?, ?, ?, ?)`,
        row.id,
        row.threadKey,
        row.requester,
        expiresAt,
        JSON.stringify(row.body),
      );
    });
    return expiresAt;
  }

  /** Read, judge and delete in one transaction on the single-threaded object,
   *  so a confirmation runs at most once whatever the click timing: a missing
   *  row is `used`, a row past its expiry is deleted and `expired`, a requester
   *  none of `actorIds` names is `foreign` (the row stays for its requester),
   *  and otherwise the row is deleted and returned. */
  async consumeConfirmation(id: string, actorIds: readonly string[], now: number): Promise<ConfirmationOutcome> {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.readConfirmation(id);
      if (!stored) return { refused: "used" };
      if (stored.expiresAt <= now) {
        this.sql.exec(`DELETE FROM confirmations WHERE id = ?`, id);
        return { refused: "expired", row: stored };
      }
      if (!actorIds.includes(stored.requester)) return { refused: "foreign", row: stored };
      this.sql.exec(`DELETE FROM confirmations WHERE id = ?`, id);
      return { row: stored };
    });
  }

  /** Delete the row under the same requester check as a consume; a missing row
   *  is `used`. Expiry plays no part: cancelling an expired offer still leaves
   *  nothing pending, which is what the click asked for. */
  async cancelConfirmation(id: string, actorIds: readonly string[]): Promise<ConfirmationCancelOutcome> {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.readConfirmation(id);
      if (!stored) return { refused: "used" };
      if (!actorIds.includes(stored.requester)) return { refused: "foreign" };
      this.sql.exec(`DELETE FROM confirmations WHERE id = ?`, id);
      return { ok: true };
    });
  }

  /** Delete the thread's pending row under the same requester check (record
   *  0054: a typed answer supersedes the button, so a click cannot follow
   *  it). At most one row per thread exists (`putConfirmation` replaces); a
   *  thread with none is `used`. The body stays opaque here — a row stored
   *  before the bot's union gained `kind` cancels the same way. */
  async cancelConfirmationByThread(threadKey: string, actorIds: readonly string[]): Promise<ConfirmationCancelOutcome> {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.sql
        .exec<{ id: string; requester: string }>(
          `SELECT id, requester FROM confirmations WHERE thread_key = ?`,
          threadKey,
        )
        .toArray()[0];
      if (!stored) return { refused: "used" };
      if (!actorIds.includes(stored.requester)) return { refused: "foreign" };
      this.sql.exec(`DELETE FROM confirmations WHERE id = ?`, stored.id);
      return { ok: true };
    });
  }

  /** The thread's pending row when one exists and is inside its ttl, else
   *  null. A pure read: expiry is checked here on this object's clock and
   *  nothing is deleted — nothing sweeps, and a consume still finds the
   *  expired row to name `expired`. */
  async pendingConfirmationByThread(threadKey: string, now: number): Promise<ConfirmationRow | null> {
    const row = this.sql
      .exec<{ id: string; requester: string; expires_at: number; body: string }>(
        `SELECT id, requester, expires_at, body FROM confirmations WHERE thread_key = ?`,
        threadKey,
      )
      .toArray()[0];
    if (!row || row.expires_at <= now) return null;
    return {
      id: row.id,
      threadKey,
      requester: row.requester,
      expiresAt: row.expires_at,
      body: parseStored(row.body, isJsonObject) ?? {},
    };
  }

  private readConfirmation(id: string): ConfirmationRow | undefined {
    const row = this.sql
      .exec<{ thread_key: string; requester: string; expires_at: number; body: string }>(
        `SELECT thread_key, requester, expires_at, body FROM confirmations WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (!row) return undefined;
    return {
      id,
      threadKey: row.thread_key,
      requester: row.requester,
      expiresAt: row.expires_at,
      body: parseStored(row.body, isJsonObject) ?? {},
    };
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

// ---------------------------------------------------------------------------
// The costs snapshot (docs/reference/specs/costs.md item 6)
// ---------------------------------------------------------------------------

/** The datasets a snapshot's `usage` carries, each stored as its own row. */
const USAGE_PARTS = [
  "containers",
  "durableObjectRequests",
  "durableObjectDays",
  "durableObjectStorage",
  "workers",
  "r2Storage",
  "r2Operations",
  "workflows",
] as const;

/**
 * The installation's one costs snapshot: both billing sources' rows over the
 * page's widest range plus the run history's per-user usage, and when they
 * were read (`CostsSnapshot`, the shape the bot validates too). Stored as one
 * row per part — the meta, each usage dataset, the LLM rows, the run usage —
 * so no single value nears the row limit as the window's rows grow; replaced
 * whole on every put, in one transaction, and read back as one document.
 */
export class CostsSnapshotDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS parts (
        part TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
    `);
  }

  /** Replace the snapshot whole: every part rewritten in one transaction. Each
   *  logical part is its own named row — `invoices` included, never a rest-spread
   *  into the meta row that would silently absorb future fields. */
  async put(snapshot: CostsSnapshot): Promise<void> {
    const { usage, llm, invoices, runUsage, ...meta } = snapshot;
    const rows: Array<[string, unknown]> = [
      ["meta", meta],
      ...USAGE_PARTS.map((name): [string, unknown] => [`usage.${name}`, usage[name]]),
      ["llm", llm],
      ...(invoices !== undefined ? [["invoices", invoices] as [string, unknown]] : []),
      ["runUsage", runUsage],
    ];
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM parts`);
      for (const [part, body] of rows)
        this.sql.exec(`INSERT INTO parts (part, body) VALUES (?, ?)`, part, JSON.stringify(body));
    });
  }

  /** The stored snapshot reassembled from its parts, or null when none was stored (or the parts do not make one). */
  async get(): Promise<CostsSnapshot | null> {
    const parts = new Map(
      this.sql
        .exec<{ part: string; body: string }>(`SELECT part, body FROM parts`)
        .toArray()
        .map((r) => [r.part, r.body]),
    );
    const meta = parts.get("meta");
    if (meta === undefined) return null;
    const read = (part: string): unknown => {
      const body = parts.get(part);
      return body === undefined ? undefined : (JSON.parse(body) as unknown);
    };
    const usage = Object.fromEntries(USAGE_PARTS.map((name) => [name, read(`usage.${name}`)]));
    const invoices = read("invoices");
    const snapshot = {
      ...(JSON.parse(meta) as Record<string, unknown>),
      usage,
      llm: read("llm"),
      ...(invoices !== undefined ? { invoices } : {}),
      runUsage: read("runUsage"),
    };
    return isCostsSnapshot(snapshot) ? snapshot : null;
  }
}

const COSTS_ROUTES = new Set(["/costs/snapshot/get", "/costs/snapshot/put"]);

async function handleCosts(pathname: string, body: unknown, env: Env): Promise<Response> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const dO = env.COSTS.get(env.COSTS.idFromName(COSTS_OBJECT));
  if (pathname === "/costs/snapshot/get") {
    const snapshot = await dO.get();
    console.log(
      `[costs/snapshot/get] -> ${snapshot ? `snapshot taken ${snapshot.takenAt} by ${snapshot.takenBy}` : "none"}`,
    );
    return json({ snapshot });
  }
  if (pathname === "/costs/snapshot/put") {
    if (!isCostsSnapshot(b.snapshot))
      return json(
        { error: "snapshot must be a CostsSnapshot (takenAt, takenBy, durationMs, range, usage, llm, runUsage)" },
        400,
      );
    await dO.put(b.snapshot);
    console.log(`[costs/snapshot/put] <- snapshot taken ${b.snapshot.takenAt} by ${b.snapshot.takenBy}`);
    return json({ ok: true });
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
  "/config/confirmations/put",
  "/config/confirmations/consume",
  "/config/confirmations/cancel",
  "/config/confirmations/cancel-by-thread",
  "/config/confirmations/pending-by-thread",
]);
const TICKET_STATES: ReadonlySet<string> = new Set<McpTicketState>(MCP_TICKET_STATES);
/** A confirmation id as the bot mints it (a UUID) — one token, no whitespace, bounded. */
const CONFIRMATION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** The `{ id, actorIds }` a consume or a cancel carries, or the 400 that refuses it. */
function confirmationClickOf(b: Record<string, unknown>): { id: string; actorIds: string[] } | Response {
  if (typeof b.id !== "string" || !CONFIRMATION_ID_RE.test(b.id)) return json({ error: "id malformed" }, 400);
  if (!Array.isArray(b.actorIds) || !b.actorIds.every((a): a is string => typeof a === "string"))
    return json({ error: "actorIds must be a list of actor ids" }, 400);
  return { id: b.id, actorIds: b.actorIds };
}

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
    // Confirmations (routing-and-config item 25): the body is the bot's row,
    // stored verbatim; the expiry is this object's clock plus the ttl the bot
    // passed, never a timestamp the bot chose.
    case "/config/confirmations/put": {
      if (typeof b.id !== "string" || !CONFIRMATION_ID_RE.test(b.id)) return json({ error: "id malformed" }, 400);
      if (typeof b.threadKey !== "string" || !b.threadKey) return json({ error: "threadKey required" }, 400);
      if (typeof b.requester !== "string" || !b.requester) return json({ error: "requester required" }, 400);
      if (!isJsonObject(b.body)) return json({ error: "body must be a JSON object" }, 400);
      if (typeof b.ttlMs !== "number" || !Number.isInteger(b.ttlMs) || b.ttlMs < 0)
        return json({ error: "ttlMs must be a non-negative integer" }, 400);
      const expiresAt = await dO.putConfirmation(
        { id: b.id, threadKey: b.threadKey, requester: b.requester, body: b.body },
        b.ttlMs,
        systemClock(),
      );
      console.log(`[config/confirmations/put] ${b.threadKey} ${b.id} expires_at=${expiresAt}`);
      return json({ ok: true, expiresAt });
    }
    case "/config/confirmations/consume": {
      const click = confirmationClickOf(b);
      if (click instanceof Response) return click;
      const outcome = await dO.consumeConfirmation(click.id, click.actorIds, systemClock());
      console.log(`[config/confirmations/consume] ${click.id} ${consumeWord(outcome)}`);
      return json(outcome);
    }
    case "/config/confirmations/cancel": {
      const click = confirmationClickOf(b);
      if (click instanceof Response) return click;
      const outcome = await dO.cancelConfirmation(click.id, click.actorIds);
      console.log(`[config/confirmations/cancel] ${click.id} ${"ok" in outcome ? "cancelled" : outcome.refused}`);
      return json(outcome);
    }
    case "/config/confirmations/pending-by-thread": {
      if (typeof b.threadKey !== "string" || !b.threadKey) return json({ error: "threadKey required" }, 400);
      // The stub types this result `never`: workers-types' Serializable rejects
      // the row's opaque `Record<string, unknown>` body. What arrives is the
      // object's declared result, so the boundary restates it.
      const row = (await dO.pendingConfirmationByThread(b.threadKey, systemClock())) as ConfirmationRow | null;
      console.log(`[config/confirmations/pending-by-thread] ${b.threadKey} ${row === null ? "none" : row.id}`);
      return json({ row });
    }
    case "/config/confirmations/cancel-by-thread": {
      if (typeof b.threadKey !== "string" || !b.threadKey) return json({ error: "threadKey required" }, 400);
      if (!Array.isArray(b.actorIds) || !b.actorIds.every((a): a is string => typeof a === "string"))
        return json({ error: "actorIds must be a list of actor ids" }, 400);
      const outcome = await dO.cancelConfirmationByThread(b.threadKey, b.actorIds);
      console.log(
        `[config/confirmations/cancel-by-thread] ${b.threadKey} ${"ok" in outcome ? "cancelled" : outcome.refused}`,
      );
      return json(outcome);
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

type HeartbeatAnswer = FenceResult & { stop?: StopMode | null; phase?: LivePhase; effects?: PlaneEffect[] };

/** Whether the bot's outcome and the decider's word agree (orchestration-plane item 8): `proceeded`
 *  beside `proceed`, and a thread-live refusal beside `queued` — the refusal
 *  IS the queue position the plane would hold. `null` for a pair the decider
 *  does not model yet: logged, never counted. */
function planeAgreementOf(outcome: string, decider: "proceed" | "queued"): boolean | null {
  if (outcome === "proceeded") return decider === "proceed";
  if (outcome === "refused:thread-live") return decider === "queued";
  return null;
}

/** The most effects one answer carries (record 0064; orchestration-plane item 7): the rest ride the next heartbeat. */
const PLANE_EFFECTS_PER_ANSWER = 32;

export class RunHistoryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Where a turned-final run's point goes (run-metrics.md): the Analytics
   *  Engine dataset when the deploy bound one, the NullSink otherwise —
   *  selected once at construction, the `SHIP_COORDINATOR?` shape. */
  private readonly metrics: RunMetricsSink;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.metrics = env.RUN_METRICS !== undefined ? new AnalyticsEngineSink(env.RUN_METRICS) : new NullSink();
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
      CREATE INDEX IF NOT EXISTS runs_thread_key ON runs(thread_key, finished_at);
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
    this.migrateRunsTable();
    // The indexes the visibility predicate's leaves walk (`channel_id IN`,
    // `channel_visibility IN`, `user_id =`), each ordered like the page; the
    // session the sweep asks about; the parent a children listing filters on;
    // the pull request a findings listing filters on.
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS runs_channel_finished ON runs(channel_id, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_visibility_finished ON runs(channel_visibility, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_user_finished ON runs(user_id, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_session ON runs(session_key);
      CREATE INDEX IF NOT EXISTS runs_parent ON runs(parent_run_id, finished_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS runs_pr ON runs(repo, pr_number, finished_at DESC, run_id DESC);
    `);
    // The sessions registry (session-log item 7): every session log a run of
    // this store claimed, with its thread — the sweep cannot enumerate the
    // SESSION_LOGS namespace, so this is how it knows which objects exist and
    // which thread's live row would block a drop.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        agent TEXT,
        last_finished_at INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0
      );
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
    // The intake receipts (run-history item 59): one verdict per message key,
    // first writer wins, beside the live rows because the reconnect catch-up
    // reads them through the same store key. `prune_after` is stamped at the
    // insert (the bound is the writer's window through
    // `intakeReceiptRetentionMs`) and the alarm sweeps by it.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS intake_receipts (
        key TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        decided_at INTEGER NOT NULL,
        prune_after INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS intake_thread ON intake_receipts(thread_key, decided_at);
      CREATE INDEX IF NOT EXISTS intake_prune ON intake_receipts(prune_after);
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
    // The thread events of a unit-owned thread (record 0051's reply-as-event rule): a
    // sibling table of the unit rows, never a field on them — `putUnits`
    // replaces a row whole, so an append landing between a route's read and
    // its put would be lost. Consumption is a column of its own, set once.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS coordinator_unit_events (
        instance_id TEXT NOT NULL,
        unit TEXT NOT NULL,
        seq INTEGER NOT NULL,
        json TEXT NOT NULL,
        consumed_by TEXT,
        PRIMARY KEY (instance_id, unit, seq)
      );
    `);
    // The orchestration plane's tables (record 0064; orchestration-plane.md item 7):
    // the queue with its conditions, the reservations, the quiet and pressure
    // windows, the watches' findings, the offered effects and the residents'
    // levels. This unit opens them all so a later Worker and an earlier one agree on
    // the schema; only the queue and the effects are written yet.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS plane_queue (
        run_id TEXT PRIMARY KEY,
        requester TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        stage TEXT NOT NULL,
        request_json TEXT NOT NULL,
        conditions_json TEXT NOT NULL,
        position_at INTEGER NOT NULL,
        queued_at INTEGER NOT NULL,
        state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plane_queue_waiting ON plane_queue(state, queued_at);
      CREATE TABLE IF NOT EXISTS plane_reservations (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
      );
      CREATE TABLE IF NOT EXISTS plane_windows (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        phase TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        reason_json TEXT NOT NULL,
        PRIMARY KEY (kind, key)
      );
      CREATE TABLE IF NOT EXISTS plane_findings (
        id TEXT PRIMARY KEY,
        watch TEXT NOT NULL,
        subject TEXT NOT NULL,
        timeline_json TEXT NOT NULL,
        filed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plane_effects (
        id TEXT PRIMARY KEY,
        body_json TEXT NOT NULL,
        offered_at INTEGER NOT NULL,
        acked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS plane_effects_open ON plane_effects(acked_at, offered_at);
      CREATE TABLE IF NOT EXISTS plane_levels (
        resident TEXT NOT NULL,
        name TEXT NOT NULL,
        side TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        generation TEXT NOT NULL,
        PRIMARY KEY (resident, name)
      );
    `);
  }

  // ---- the orchestration plane (record 0064; orchestration-plane.md) ----------

  /** The decider's state, read inside the caller's `transactionSync`: the
   *  queue oldest first and the threads a live row holds. `excludeRunId` drops
   *  that run's own live row from the view — a shadow post judged after the
   *  dispatch it describes claimed the thread must not read its own claim as
   *  "thread live" (orchestration-plane item 8). */
  private planeState(excludeRunId?: string): PlaneState {
    const now = systemClock();
    // A reservation not yet promoted into a live row expires after its window:
    // a dispatch that died between the admission answer and its claim must not
    // hold the thread forever. Promotion deletes the row (the live row holds
    // the thread from there), so age alone is the test.
    const reservations = this.sql
      .exec<{ kind: string; key: string; run_id: string; at: number }>(
        `SELECT * FROM plane_reservations WHERE kind = 'thread' AND at > ?`,
        now - minutesToMs(PLANE.reservationMinutes),
      )
      .toArray()
      .map((r): PlaneReservation => ({ kind: "thread", key: r.key, runId: r.run_id, at: r.at }));
    const openWindows = this.sql
      .exec<{ kind: string }>(`SELECT kind FROM plane_windows WHERE phase = 'open'`)
      .toArray()
      .map((r) => r.kind);
    const queue = this.sql
      .exec<{
        run_id: string;
        requester: string;
        thread_key: string;
        stage: string;
        request_json: string;
        conditions_json: string;
        position_at: number;
        queued_at: number;
        state: string;
      }>(`SELECT * FROM plane_queue ORDER BY queued_at ASC, run_id ASC`)
      .toArray()
      .map((r): PlaneQueueRow => ({
        runId: r.run_id,
        requester: r.requester,
        threadKey: r.thread_key,
        stage: r.stage as PlaneStage,
        request: JSON.parse(r.request_json) as Record<string, unknown>,
        conditions: JSON.parse(r.conditions_json) as PlaneQueueRow["conditions"],
        position: r.position_at,
        queuedAt: r.queued_at,
        state: r.state as PlaneQueueRow["state"],
      }));
    const liveThreads = this.sql
      .exec<{ thread_key: string }>(`SELECT thread_key FROM live_runs WHERE run_id IS NOT ?`, excludeRunId ?? null)
      .toArray()
      .map((r) => r.thread_key);
    const levels = this.sql
      .exec<{ resident: string; name: string; side: string; reported_at: number; generation: string }>(
        `SELECT * FROM plane_levels`,
      )
      .toArray()
      .map((r): PlaneLevelRow => ({
        resident: r.resident,
        name: r.name as PlaneLevelRow["name"],
        side: r.side as PlaneLevelRow["side"],
        reportedAt: r.reported_at,
        generation: r.generation,
      }));
    return { queue, liveThreads, reservations, openWindows, levels };
  }

  /** The decider's writes, applied inside the same `transactionSync` that read
   *  the state — the decision and its consequences land together (orchestration-plane item 6). */
  private applyPlaneWrites(writes: PlaneWrite[]): void {
    for (const w of writes) {
      if (w.table === "plane_queue" && w.op === "put") {
        this.sql.exec(
          `INSERT OR REPLACE INTO plane_queue
             (run_id, requester, thread_key, stage, request_json, conditions_json, position_at, queued_at, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          w.row.runId,
          w.row.requester,
          w.row.threadKey,
          w.row.stage,
          JSON.stringify(w.row.request),
          JSON.stringify(w.row.conditions),
          w.row.position,
          w.row.queuedAt,
          w.row.state,
        );
      } else if (w.table === "plane_queue" && w.op === "state") {
        this.sql.exec(`UPDATE plane_queue SET state = ? WHERE run_id = ?`, w.state, w.runId);
      } else if (w.table === "plane_reservations" && w.op === "put") {
        this.sql.exec(
          `INSERT OR REPLACE INTO plane_reservations (kind, key, run_id, at) VALUES (?, ?, ?, ?)`,
          w.row.kind,
          w.row.key,
          w.row.runId,
          w.row.at,
        );
      } else if (w.table === "plane_reservations" && w.op === "del") {
        this.sql.exec(`DELETE FROM plane_reservations WHERE kind = 'thread' AND key = ?`, w.key);
      } else if (w.table === "plane_windows" && w.op === "put") {
        this.sql.exec(
          `INSERT OR REPLACE INTO plane_windows (kind, key, phase, opened_at, reason_json) VALUES (?, ?, 'open', ?, '{}')`,
          w.window,
          w.window,
          w.at,
        );
      } else if (w.table === "plane_windows" && w.op === "del") {
        this.sql.exec(`DELETE FROM plane_windows WHERE kind = ?`, w.window);
      } else if (w.table === "plane_levels") {
        this.sql.exec(
          `INSERT OR REPLACE INTO plane_levels (resident, name, side, reported_at, generation) VALUES (?, ?, ?, ?, ?)`,
          w.row.resident,
          w.row.name,
          w.row.side,
          w.row.reportedAt,
          w.row.generation,
        );
      } else {
        // The effect bounds (record 0064): an offer past the per-run or total
        // cap is refused by the cap's name — the throw aborts the transaction,
        // so the queue row stays waiting and the next event re-decides.
        const total = Number(
          this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM plane_effects WHERE acked_at IS NULL`).toArray()[0]
            ?.n ?? 0,
        );
        const forRun =
          w.effect.kind === "admit"
            ? Number(
                this.sql
                  .exec<{
                    n: number;
                  }>(
                    // Exact id matching (`admit:<runId>`): the seal runs with bot-minted
                    // run ids, and a LIKE would read `%`/`_` in one as wildcards.
                    `SELECT COUNT(*) AS n FROM plane_effects WHERE acked_at IS NULL AND id = 'admit:' || ?`,
                    w.effect.runId,
                  )
                  .toArray()[0]?.n ?? 0,
              )
            : 0;
        const refusal = effectCapRefusal({ total, forRun }, w.effect);
        if (refusal !== undefined) throw new Error(refusal);
        // A re-offer lands after an ack for any kind — a probe re-probes after
        // its ack (one open probe per resident, record 0064), and an observation
        // re-enters an admitted run whose acked `admit:<runId>` row would
        // otherwise swallow the walk's re-offer, stranding the run `admitted`
        // with no effect delivered. The decider only re-emits an effect when
        // its subject is waiting again, and the bot's own getById dedup guards
        // a genuine duplicate admit, so the acked row is history, not a fence.
        this.sql.exec(`DELETE FROM plane_effects WHERE id = ? AND acked_at IS NOT NULL`, w.effect.id);
        // An offer keeps its first `offered_at`: a re-decided admit after a
        // roll is the same effect, not a younger one.
        this.sql.exec(
          `INSERT OR IGNORE INTO plane_effects (id, body_json, offered_at, acked_at) VALUES (?, ?, ?, NULL)`,
          w.effect.id,
          JSON.stringify(w.effect),
          w.at,
        );
        // The admitted run's attaching row, in the same transaction as the
        // effect (record 0064, "The queue"): owner `plane`, lease already
        // expired, request in the meta — exactly the row a reserved run whose
        // owner died leaves (run-history item 42), so the bot's reclaim sweep
        // restarts it from the stored request under this id.
        if (w.effect.kind === "admit") {
          this.sql.exec(
            `INSERT OR IGNORE INTO live_runs (run_id, thread_key, owner_gen, lease_until, started_at, phase, stop, meta_json, card_json, system_text, tools_json, state_json)
             VALUES (?, ?, 'plane', ?, ?, 'attaching', NULL, ?, NULL, '', '[]', '{}')`,
            w.effect.runId,
            w.effect.threadKey,
            w.at,
            w.at,
            JSON.stringify({ request: w.effect.request }),
          );
        }
      }
    }
  }

  /** Apply one plane event: state read, decider, writes and effects in ONE
   *  `transactionSync` (orchestration-plane item 6). The transport unit's routes feed it; the tests pin the atomicity. */
  planeApply(event: PlaneEvent): { effects: PlaneEffect[] } {
    let effects: PlaneEffect[] = [];
    this.ctx.storage.transactionSync(() => {
      const decision = decide(this.planeState(), event);
      this.applyPlaneWrites(decision.writes);
      effects = decision.effects;
    });
    this.pushPlaneEffects(effects);
    return { effects };
  }

  /** The admission ask (`POST /plane/admit`, record 0064 "The queue"): one
   *  transaction decides and writes — `admitted` reserves the thread,
   *  `queued` stores the request under the minted id. */
  planeAdmit(
    post: {
      runId: string;
      requester: string;
      threadKey: string;
      request: Record<string, unknown>;
      stage?: PlaneStage;
      resident?: string;
      restartOf?: boolean;
      reaskMs?: number;
    },
    now: number,
  ): PlaneAskAnswer {
    let answer!: PlaneAskAnswer;
    this.ctx.storage.transactionSync(() => {
      if (post.reaskMs !== undefined)
        this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('plane_reask_ms', ?)`, String(post.reaskMs));
      const decision = decide(this.planeState(), {
        kind: "ask",
        at: now,
        runId: post.runId,
        requester: post.requester,
        threadKey: post.threadKey,
        stage: post.stage ?? "admission",
        request: post.request,
        ...(post.resident !== undefined ? { resident: post.resident } : {}),
        ...(post.restartOf !== undefined ? { restartOf: post.restartOf } : {}),
      });
      this.applyPlaneWrites(decision.writes);
      answer = planeAskAnswerOf(decision, post.runId);
    });
    if (answer.kind === "queued") void this.ensurePlaneReaskAlarm(now);
    console.log(
      `[plane/admit] ${post.threadKey} → ${answer.kind}${answer.kind === "queued" ? ` position ${answer.position}` : ""} (run ${post.runId})`,
    );
    return answer;
  }

  /** A resident's level report (`POST /plane/level`, record 0064): `seat` and `memory`
   *  land as level events — a `below` side walks the queue; the registry's
   *  drain posts land as the resident-drain window's open (`above`) and lift
   *  (`below` — a `cleared` or the alarm's `expired`). */
  planeLevel(
    post: { resident: string; name: "seat" | "memory" | "drain"; side: "below" | "above"; generation: string },
    now: number,
  ): { admitted: number } {
    const r =
      post.name === "drain"
        ? this.planeApply({
            kind: "window",
            at: now,
            window: RESIDENT_DRAIN_WINDOW,
            phase: post.side === "above" ? "opened" : "lifted",
          })
        : this.planeApply({
            kind: "level",
            at: now,
            resident: post.resident,
            name: post.name,
            side: post.side,
            generation: post.generation,
          });
    const admitted = r.effects.filter((e) => e.kind === "admit").length;
    console.log(`[plane/level] ${post.resident} ${post.name} ${post.side} — ${admitted} admission(s)`);
    return { admitted };
  }

  /** A refusal-by-name the bot met at attach or exec (`POST /plane/observe`,
   *  record 0064): an admitted run re-enters the queue at its old position. */
  planeObserve(post: { runId: string; resident: string; refusal: string }, now: number): { reentered: boolean } {
    let reentered = false;
    this.ctx.storage.transactionSync(() => {
      const decision = decide(this.planeState(), {
        kind: "observation",
        at: now,
        runId: post.runId,
        resident: post.resident,
        refusal: post.refusal,
      });
      this.applyPlaneWrites(decision.writes);
      reentered = decision.writes.length > 0;
    });
    if (reentered) void this.ensurePlaneReaskAlarm(now);
    console.log(
      `[plane/observe] run ${post.runId} on ${post.resident}: ${post.refusal.slice(0, 60)} — ${reentered ? "re-entered" : "no-op"}`,
    );
    return { reentered };
  }

  /** The re-ask cadence (record 0064): while a queued row waits on a resident,
   *  the object's alarm fires within the cadence — the sweep's own 6 h alarm
   *  is pulled forward, never pushed back. */
  private planeReaskMs(): number {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'plane_reask_ms'`).toArray()[0];
    const stored = row ? Number(row.value) : NaN;
    return Number.isFinite(stored) && stored > 0 ? stored : minutesToMs(PLANE.reaskMinutes);
  }

  private planeWaitsOnResident(): boolean {
    return this.planeState().queue.some(
      (r) => r.state === "waiting" && r.conditions.some((c) => c.kind === "seat" || c.kind === "memory"),
    );
  }

  private async ensurePlaneReaskAlarm(now: number): Promise<void> {
    if (!this.planeWaitsOnResident()) return;
    const due = now + this.planeReaskMs();
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > due) await this.ctx.storage.setAlarm(due);
  }

  /** A window's open or lift over the RPC seam (`/plane/deploy`; a later
   *  unit's `plane window lift`): kind `deploy` is the pending deploy. */
  planeWindow(window: string, phase: "opened" | "lifted", now: number): { admitted: number } {
    const r = this.planeApply({ kind: "window", at: now, window, phase });
    return { admitted: r.effects.length };
  }

  /** `runs stop` on a queued id (record 0064): the waiting row is withdrawn;
   *  an id the queue does not hold waiting answers false. */
  planeWithdraw(runId: string, now: number): { withdrawn: boolean } {
    let withdrawn = false;
    this.ctx.storage.transactionSync(() => {
      const decision = decide(this.planeState(), { kind: "withdraw", at: now, runId });
      this.applyPlaneWrites(decision.writes);
      withdrawn = decision.writes.length > 0;
    });
    return { withdrawn };
  }

  /** One queued row, for the queued id's page. */
  planeQueueRowOf(runId: string): PlaneQueueRow | null {
    return this.planeState().queue.find((r) => r.runId === runId) ?? null;
  }

  /** The seal (record 0064, "The queue"): the run's own open effects are
   *  dropped — an admit for a run that just ended is stale — then the sealed
   *  event frees the thread and walks the queue, all in one transaction. */
  private planeSealed(runId: string, threadKey: string, now: number): void {
    let effects: PlaneEffect[] = [];
    try {
      this.ctx.storage.transactionSync(() => {
        // Exact id matching (`admit:<runId>`), never LIKE: a bot-minted run id
        // can carry `%` or `_`, which a pattern would read as wildcards.
        this.sql.exec(`DELETE FROM plane_effects WHERE acked_at IS NULL AND id = 'admit:' || ?`, runId);
        const decision = decide(this.planeState(), { kind: "sealed", at: now, threadKey });
        this.applyPlaneWrites(decision.writes);
        effects = decision.effects;
      });
    } catch (err) {
      // A cap refusal here must not undo the finish that already committed.
      console.warn(`[plane/sealed] ${threadKey}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.pushPlaneEffects(effects);
  }

  /** The transport's push (record 0064, "Where it lives"): committed effects
   *  are pushed to the bot Worker over the service binding, which forwards to
   *  the container. Fire and forget — a push that fails is not retried by a
   *  timer; the effect rides the next heartbeat or reclaim-sweep answer. */
  private pushPlaneEffects(effects: PlaneEffect[]): void {
    if (effects.length === 0) return;
    const bot = this.env.BOT;
    if (!bot) return;
    void bot
      .fetch("https://bot/plane/effects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.env.MEMORY_TOKEN ?? ""}`,
        },
        body: JSON.stringify({ effects }),
      })
      .then((r) => {
        if (!r.ok)
          console.warn(
            `[plane/push] ${effects.length} effect(s) → bot answered ${r.status} — they ride the next heartbeat`,
          );
      })
      .catch((err: unknown) => {
        console.warn(
          `[plane/push] ${effects.length} effect(s) not delivered: ${err instanceof Error ? err.message : String(err)} — they ride the next heartbeat`,
        );
      });
  }

  /** The unacknowledged effects, oldest first, at most `PLANE_EFFECTS_PER_ANSWER`
   *  (orchestration-plane item 7) — what every heartbeat and reclaim answer carries. Public: the
   *  reclaim route composes it beside the runs it took. */
  openPlaneEffects(): PlaneEffect[] {
    return this.sql
      .exec<{ body_json: string }>(
        `SELECT body_json FROM plane_effects WHERE acked_at IS NULL ORDER BY offered_at ASC, id ASC LIMIT ?`,
        PLANE_EFFECTS_PER_ANSWER,
      )
      .toArray()
      .map((r) => JSON.parse(r.body_json) as PlaneEffect);
  }

  /** Shadow (orchestration-plane item 8): the bot's own outcome for one dispatch, judged beside the
   *  decider's word for the same ask. Nothing runs and nothing queues from
   *  the decider here — the comparison is logged, and a disagreement bumps a
   *  per-condition counter in `meta` for the `plane disagreements` line. An
   *  outcome the decider does not model yet (an allowlist refusal, a cold
   *  fall) is logged uncounted. The post is fired without an await, so it can
   *  arrive AFTER the dispatch it describes claimed this thread's `live_runs`
   *  row; a post carrying the run's own id excludes that row from the live
   *  view so the run's own claim never reads as a false disagreement. */
  planeOutcome(
    post: PlaneOutcomePost,
    now: number,
  ): { ok: true; decider: "proceed" | "queued"; agreed: boolean | null } {
    let decider: "proceed" | "queued" = "proceed";
    let agreed: boolean | null = null;
    this.ctx.storage.transactionSync(() => {
      const ask: PlaneEvent = {
        kind: "ask",
        at: now,
        runId: post.runId ?? `ask:${post.threadKey}:${now}`,
        requester: post.requester,
        threadKey: post.threadKey,
        stage: post.stage,
        request: {},
      };
      decider = planeAskWordOf(decide(this.planeState(post.runId), ask), ask.runId);
      agreed = planeAgreementOf(post.outcome, decider);
      if (agreed === false) this.bumpPlaneDisagreement("thread_free");
    });
    console.log(
      `[plane/outcome] ${post.threadKey} ${post.stage} bot=${post.outcome} decider=${decider} agreed=${agreed ?? "uncompared"}`,
    );
    return { ok: true, decider, agreed };
  }

  /** The per-condition disagreement counts (orchestration-plane item 8), kept in `meta` so the table's
   *  later `plane disagreements` line can read them. */
  private bumpPlaneDisagreement(condition: string): void {
    const row = this.sql
      .exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'plane_disagreements'`)
      .toArray()[0];
    const counts = row ? (JSON.parse(row.value) as Record<string, number>) : {};
    counts[condition] = (counts[condition] ?? 0) + 1;
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('plane_disagreements', ?)`, JSON.stringify(counts));
  }

  /** An effect's acknowledgement by id (orchestration-plane item 7): `done` and `skipped` close it,
   *  `deferred` leaves it offered for the next answer. An unknown id is a
   *  no-op — the bot may ack an effect an older table never held. */
  planeAck(id: string, outcome: PlaneAckOutcome, now: number): { ok: true } {
    if (outcome !== "deferred")
      this.sql.exec(`UPDATE plane_effects SET acked_at = ? WHERE id = ? AND acked_at IS NULL`, now, id);
    return { ok: true };
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

  /** The record written over whatever the id holds and the id's unit rows
   *  dropped, in one transaction — an attempt starting over: the leftover of one
   *  whose Workflow instance was never created, once the shim said so. */
  async replaceInstance(instance: CoordinatorInstance): Promise<{ ok: true }> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO coordinator_instances (instance_id, json, created_at) VALUES (?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at`,
        instance.id,
        JSON.stringify(instance),
        instance.createdAt,
      );
      this.sql.exec(`DELETE FROM coordinator_units WHERE instance_id = ?`, instance.id);
    });
    return { ok: true };
  }

  async getInstance(id: string): Promise<CoordinatorInstance | null> {
    const row = this.sql
      .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, id)
      .toArray()[0];
    return row ? (JSON.parse(row.json) as CoordinatorInstance) : null;
  }

  /** The hard stop's mark on the instance row (record 0060; issue 1924).
   *  Idempotent: a marked row keeps its first mark. */
  async markInstanceStopped(id: string, at: number): Promise<{ ok: true } | { ok: false; reason: "unknown_instance" }> {
    let out: { ok: true } | { ok: false; reason: "unknown_instance" } = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<{ json: string }>(`SELECT json FROM coordinator_instances WHERE instance_id = ?`, id)
        .toArray()[0];
      if (!row) {
        out = { ok: false, reason: "unknown_instance" };
        return;
      }
      const instance = JSON.parse(row.json) as CoordinatorInstance;
      if (instance.stop !== undefined) return;
      this.sql.exec(
        `UPDATE coordinator_instances SET json = ? WHERE instance_id = ?`,
        JSON.stringify({ ...instance, stop: { at } }),
        id,
      );
    });
    return out;
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

  // ---- the thread events of a unit-owned thread (record 0051's reply-as-event rule) --------------

  /** The next sequence assigned in one transaction, the per-event cap applied
   *  (attachments dropped whole, the row saying how many). */
  async appendUnitEvent(
    instanceId: string,
    unit: string,
    event: Omit<ThreadEvent, "seq">,
  ): Promise<{ ok: true; seq: number }> {
    let seq = 1;
    this.ctx.storage.transactionSync(() => {
      const max = this.sql
        .exec<{
          m: number | null;
        }>(`SELECT MAX(seq) AS m FROM coordinator_unit_events WHERE instance_id = ? AND unit = ?`, instanceId, unit)
        .toArray()[0];
      seq = (max?.m ?? 0) + 1;
      const capped = capThreadEvent({ ...event, seq });
      this.sql.exec(
        `INSERT INTO coordinator_unit_events (instance_id, unit, seq, json) VALUES (?, ?, ?, ?)`,
        instanceId,
        unit,
        seq,
        JSON.stringify(capped),
      );
    });
    return { ok: true, seq };
  }

  /** The unit's events in sequence order; `unconsumedOnly` filters to the rows nothing has consumed. */
  async listUnitEvents(instanceId: string, unit: string, unconsumedOnly: boolean): Promise<ThreadEvent[]> {
    return this.sql
      .exec<{ json: string; consumed_by: string | null }>(
        `SELECT json, consumed_by FROM coordinator_unit_events WHERE instance_id = ? AND unit = ?${
          unconsumedOnly ? " AND consumed_by IS NULL" : ""
        } ORDER BY seq ASC`,
        instanceId,
        unit,
      )
      .toArray()
      .map((r) => {
        const e = JSON.parse(r.json) as ThreadEvent;
        return r.consumed_by !== null ? { ...e, consumedBy: r.consumed_by } : e;
      });
  }

  /** Consumption set once — idempotent: a row already consumed keeps its first consumer. */
  async markUnitEventsConsumed(instanceId: string, unit: string, seqs: number[], by: string): Promise<{ ok: true }> {
    this.ctx.storage.transactionSync(() => {
      for (const seq of seqs) {
        this.sql.exec(
          `UPDATE coordinator_unit_events SET consumed_by = ? WHERE instance_id = ? AND unit = ? AND seq = ? AND consumed_by IS NULL`,
          by,
          instanceId,
          unit,
          seq,
        );
      }
    });
    return { ok: true };
  }

  // ---- the live-run ledger (run-history items 28–34) --------------------------

  private liveRow(runId: string): LiveRunRow | undefined {
    const r = this.sql.exec<LiveRow>(`SELECT * FROM live_runs WHERE run_id = ?`, runId).toArray()[0];
    return r ? rowToLive(r) : undefined;
  }

  /** The `runs` table's column migrations, run at every construction and
   *  idempotent: a table created before a column existed gains it, with the
   *  value a row written back then should read. The run-visibility stamp: a
   *  run written before the stamp is `unknown`, never public. The session a
   *  run was a range of (session-log item 7), so the sweep can tell which
   *  sessions still have a kept run; null for a record without one. What the
   *  run cost in tokens (costs.md, cost by user), NULL until the by-user
   *  aggregate fills it from the run's stored events. The parent a child names
   *  (run-history item 46), the column a children listing filters on: the
   *  record already carries it in `summary_json`, so existing rows are filled
   *  from there once, and every later `put` writes it beside the row. The pull
   *  request a run names (run-history item 58; `pullRequestNumberOf`), the
   *  column a findings listing filters on: the same one-time fill from
   *  `summary_json` — the coding post-step's `pr`, else a posted review's
   *  target — and every later `put` writes it beside the row. */
  migrateRunsTable(): void {
    const columns = new Set(
      this.sql
        .exec<{ name: string }>(`PRAGMA table_info(runs)`)
        .toArray()
        .map((c) => c.name),
    );
    if (!columns.has("channel_visibility"))
      this.sql.exec(`ALTER TABLE runs ADD COLUMN channel_visibility TEXT NOT NULL DEFAULT 'unknown'`);
    if (!columns.has("session_key")) this.sql.exec(`ALTER TABLE runs ADD COLUMN session_key TEXT`);
    if (!columns.has("usage_json")) this.sql.exec(`ALTER TABLE runs ADD COLUMN usage_json TEXT`);
    if (!columns.has("parent_run_id")) {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN parent_run_id TEXT`);
      this.sql.exec(
        `UPDATE runs SET parent_run_id = json_extract(summary_json, '$.parentRunId')
         WHERE json_type(summary_json, '$.parentRunId') = 'text'`,
      );
    }
    if (!columns.has("pr_number")) {
      this.sql.exec(`ALTER TABLE runs ADD COLUMN pr_number INTEGER`);
      // `pullRequestNumberOf` in SQL: the coding post-step's pull request, else
      // the one a posted review targeted (a skipped post has no target).
      this.sql.exec(
        `UPDATE runs SET pr_number = COALESCE(
           CASE WHEN json_type(summary_json, '$.pr.number') = 'integer' THEN json_extract(summary_json, '$.pr.number') END,
           CASE WHEN json_extract(summary_json, '$.reviewPost.posted') = 1
                 AND json_type(summary_json, '$.reviewPost.target.number') = 'integer'
                THEN json_extract(summary_json, '$.reviewPost.target.number') END
         )`,
      );
    }
  }

  private liveByThread(threadKey: string): LiveRunRow | undefined {
    const r = this.sql.exec<LiveRow>(`SELECT * FROM live_runs WHERE thread_key = ?`, threadKey).toArray()[0];
    return r ? rowToLive(r) : undefined;
  }

  /** One live run per thread (item 29): the UNIQUE on thread_key is the
   *  store-level guarantee; the decision names the live run for the steer. */
  /** A claim naming a session log registers it (session-log item 7), so the
   *  sweep knows the object exists and which thread it belongs to. Inside the
   *  claim's transaction. */
  private registerSession(req: ClaimRequest): void {
    const session = req.meta.session;
    if (!session) return;
    this.sql.exec(
      `INSERT INTO sessions (key, thread_key, agent) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET thread_key = excluded.thread_key, agent = excluded.agent`,
      session.key,
      req.threadKey,
      req.meta.agent ?? null,
    );
  }

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
      // The claim promotes the thread's reservation (record 0064, "The queue"):
      // the live row holds the thread from here, so the reservation row retires
      // in the same transaction that writes the claim.
      this.sql.exec(`DELETE FROM plane_reservations WHERE kind = 'thread' AND key = ?`, req.threadKey);
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
          this.registerSession(req);
          return;
        case "insert":
          break;
      }
      this.registerSession(req);
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
      // The plane's open effects ride every owner's heartbeat answer (record
      // 0064; orchestration-plane item 7) — empty until a unit writes them, but always present, so the
      // client's ack loop needs no version probe.
      out = { ok: true, stop: row.stop, phase: row.phase, effects: this.openPlaneEffects() };
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
    point?: RunMetricsPoint,
  ): Promise<FenceResult & { stored?: boolean; event?: RunFinishedSend["kind"] }> {
    let out: FenceResult & { stored?: boolean } = { ok: true };
    let turnedFinal = false;
    this.ctx.storage.transactionSync(() => {
      const fence = checkFence(this.liveRow(runId), gen);
      if (!fence.ok) {
        out = fence;
        return;
      }
      const put = this.upsertInTransaction(record, proposal);
      this.deleteLiveRows([runId]);
      turnedFinal = put.turnedFinal;
      out = { ok: true, stored: put.stored };
    });
    if (!out.ok) return out;
    // The seal flips `thread_free` (record 0064, "The queue"): the plane frees
    // the thread, drops the sealed run's own open effects and walks the queue.
    this.planeSealed(runId, record.threadKey, systemClock());
    // The point after the commit, never inside it (`sendRunFinished`'s placement):
    // the finish usually replaces the start tombstone, so this is where most
    // runs are counted (run-metrics.md item 2).
    this.writeMetricsPoint(runId, point, turnedFinal && out.stored === true);
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(systemClock() + RUN_SWEEP_INTERVAL_MS);
    await this.refreshSessionBytes(record.session?.key);
    const event = await sendRunFinished(this.env.SHIP_COORDINATOR, record);
    if (event.kind === "failed")
      console.warn(`[runs/finish] ${runId} → ${event.type} not delivered to ${event.instance}: ${event.reason}`);
    return { ...out, event: event.kind };
  }

  /** The live rows go with no record (item 42): a reserved run that never
   *  started. Fenced. */
  async abandon(runId: string, gen: string): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    let threadKey: string | undefined;
    this.ctx.storage.transactionSync(() => {
      const row = this.liveRow(runId);
      out = checkFence(row, gen);
      if (!out.ok) return;
      threadKey = row?.threadKey;
      this.deleteLiveRows([runId]);
    });
    // An abandoned reservation seals like a finish does: the thread frees and the queue walks.
    if (out.ok && threadKey !== undefined) this.planeSealed(runId, threadKey, systemClock());
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

  // ---- the intake receipts (run-history item 59) -------------------------------

  private intakeRow(key: string): IntakeReceipt | undefined {
    const r = this.sql.exec<{ json: string }>(`SELECT json FROM intake_receipts WHERE key = ?`, key).toArray()[0];
    return r ? (JSON.parse(r.json) as IntakeReceipt) : undefined;
  }

  /** Insert-if-absent inside one transaction: the first writer's row stands
   *  and every caller acts on `stored` (`decideIntakeInsert`). `windowMs` is
   *  the writer's reconnect catch-up window; the retention bound is stamped on
   *  the row so the alarm's sweep is one indexed delete. */
  async recordIntake(key: string, receipt: IntakeReceipt, windowMs: number): Promise<IntakeWriteResult> {
    let out: IntakeWriteResult = { inserted: false, stored: receipt };
    this.ctx.storage.transactionSync(() => {
      out = decideIntakeInsert(this.intakeRow(key), receipt);
      if (!out.inserted) return;
      this.sql.exec(
        `INSERT INTO intake_receipts (key, thread_key, decided_at, prune_after, json) VALUES (?, ?, ?, ?, ?)`,
        key,
        receipt.threadKey,
        receipt.decidedAt,
        receipt.decidedAt + intakeReceiptRetentionMs(windowMs),
        JSON.stringify(receipt),
      );
    });
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(systemClock() + RUN_SWEEP_INTERVAL_MS);
    return out;
  }

  async readIntake(key: string): Promise<IntakeReceipt | null> {
    return this.intakeRow(key) ?? null;
  }

  /** A thread's receipts, or the receipts since an instant, oldest first. */
  async listIntake(query: IntakeQuery): Promise<IntakeReceipt[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.threadKey !== undefined) {
      clauses.push("thread_key = ?");
      params.push(query.threadKey);
    }
    if (query.since !== undefined) {
      clauses.push("decided_at >= ?");
      params.push(query.since);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.sql
      .exec<{ json: string }>(`SELECT json FROM intake_receipts${where} ORDER BY decided_at ASC`, ...params)
      .toArray()
      .map((r) => JSON.parse(r.json) as IntakeReceipt);
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
   *  written and deleted in the same transaction, so nothing of it remains.
   *  `point` is the record's metrics point, computed by the client
   *  (run-metrics.md): written to the sink AFTER the commit, only when the row
   *  turned final and the record was stored — `turnedFinal` stays internal (the
   *  route strips it), so the wire answer is exactly the shape it always was. */
  async put(
    record: RunRecord,
    proposal?: RunPolicyProposal,
    point?: RunMetricsPoint,
  ): Promise<{ ok: true; retained: number; stored: boolean; rewritten: boolean; turnedFinal: boolean }> {
    let result = { ok: true as const, retained: 0, stored: false, rewritten: false, turnedFinal: false };
    this.ctx.storage.transactionSync(() => {
      result = this.upsertInTransaction(record, proposal);
    });
    this.writeMetricsPoint(record.id, point, result.turnedFinal && result.stored);
    // A coordinator child closed OUTSIDE the ledger's finish — the run loop or
    // a reclaim writing an `interrupted` record, the pi harness's typed restart,
    // a resume abandoning a lost workspace — still wakes its parent's wait at
    // once (run-history item 47): the same `run-finished-<runId>` event rides
    // this commit. The tombstone a run writes at its start is excluded (its
    // `finishedAt` equals `startedAt`); the parent confirms by `read-record`
    // before it acts, so a duplicate send is harmless.
    if (result.stored && record.parentInstanceId !== undefined && record.finishedAt > record.startedAt) {
      const event = await sendRunFinished(this.env.SHIP_COORDINATOR, record);
      if (event.kind === "failed")
        console.warn(`[runs/put] ${record.id} → ${event.type} not delivered to ${event.instance}: ${event.reason}`);
    }
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
  ): { ok: true; retained: number; stored: boolean; rewritten: boolean; turnedFinal: boolean } {
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
        .exec<{ event_count: number; finished_at: number; bytes: number; summary_json: string }>(
          `SELECT event_count, finished_at, bytes, summary_json FROM runs WHERE run_id = ?`,
          record.id,
        )
        .toArray()[0];
      // The one field of the stored summary the emission rule reads (run-metrics.md
      // item 2): the row's `provisional`, parsed alone — never deserialized whole.
      const existingProvisional = existing !== undefined && summaryIsProvisional(existing.summary_json);
      const turnedFinal = pointTurnsFinal(
        existing !== undefined ? { provisional: existingProvisional } : undefined,
        stored,
      );
      // A provisional record never overwrites a final row (run-history.md item 27;
      // run-metrics.md item 3): a start tombstone sitting in retry backoff or a
      // drain upgrade racing a fast finish would otherwise land after the finish
      // record, overwrite it with `interrupted` — and let the run's point be
      // written twice when a later final write turned the row "final" again.
      // Answered as stored, with nothing written: the row, its events and the
      // sessions table stay exactly as the final write left them.
      if (stored.provisional === true && existing !== undefined && !existingProvisional) {
        const retained = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`).one().n;
        return { ok: true as const, retained, stored: true, rewritten: false, turnedFinal: false };
      }
      const unchanged =
        existing !== undefined &&
        sameStoredVersion(
          { eventCount: existing.event_count, finishedAt: existing.finished_at, bytes: existing.bytes },
          { eventCount: stored.eventCount, finishedAt, bytes },
        );
      this.sql.exec(
        `INSERT INTO runs (run_id, label, agent, model, channel_id, user_id, thread_key, channel_visibility, repo, started_at, finished_at, stored_at, status,
                           event_count, stored_event_count, truncated, bytes, diagnosis_json, summary_json, session_key, usage_json, parent_run_id, pr_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           label = excluded.label, agent = excluded.agent, model = excluded.model, channel_id = excluded.channel_id,
           user_id = excluded.user_id, thread_key = excluded.thread_key, channel_visibility = excluded.channel_visibility,
           repo = excluded.repo, started_at = excluded.started_at,
           finished_at = excluded.finished_at, stored_at = excluded.stored_at, status = excluded.status,
           event_count = excluded.event_count, stored_event_count = excluded.stored_event_count, truncated = excluded.truncated,
           bytes = excluded.bytes, diagnosis_json = excluded.diagnosis_json, summary_json = excluded.summary_json,
           session_key = excluded.session_key,
           usage_json = COALESCE(excluded.usage_json, runs.usage_json),
           parent_run_id = excluded.parent_run_id,
           pr_number = excluded.pr_number`,
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
        stored.session?.key ?? null,
        stored.usage ? JSON.stringify(stored.usage) : null,
        stored.parentRunId ?? null,
        pullRequestNumberOf(stored) ?? null,
      );
      // The session's registry row learns its newest finish (session-log item
      // 7); a record that reaches the store without a claim (the plain put
      // of a detached run) still registers the session it names.
      if (stored.session) {
        this.sql.exec(
          `INSERT INTO sessions (key, thread_key, agent, last_finished_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET last_finished_at = MAX(sessions.last_finished_at, excluded.last_finished_at)`,
          stored.session.key,
          stored.threadKey,
          stored.agent ?? null,
          finishedAt,
        );
      }
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
        turnedFinal,
      };
    }
  }

  /** One point per run whose row turned final, AFTER the commit (run-metrics.md
   *  item 2) — advisory: a throwing sink leaves the answer exactly as a
   *  recording one would, and says so in one warn line with the run id and the
   *  error's constructor name, never the point's contents. */
  private writeMetricsPoint(runId: string, point: RunMetricsPoint | undefined, turnedFinal: boolean): void {
    if (point === undefined || !turnedFinal) return;
    try {
      this.metrics.write(point);
    } catch (err) {
      const kind = err instanceof Error ? err.constructor.name : "Error";
      console.warn(`[runs/metrics] ${runId} point not written: ${kind}`);
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
      let receipts = 0;
      let candidates: { key: string; threadKey: string }[] = [];
      this.ctx.storage.transactionSync(() => {
        deleted = this.trim(policy, now, undefined).deleted;
        // Orphan sweep: events whose run is gone (defensive — `deleteRuns` pairs
        // the two deletes, so this is a periodic check, not a per-put cost).
        this.sql.exec(`DELETE FROM run_events WHERE run_id NOT IN (SELECT run_id FROM runs)`);
        // Intake receipts past their bound (item 59): each row carries its own
        // `prune_after`, stamped at the insert from the writer's window.
        receipts = this.sql
          .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM intake_receipts WHERE prune_after <= ?`, now)
          .one().n;
        this.sql.exec(`DELETE FROM intake_receipts WHERE prune_after <= ?`, now);
        // The sessions no kept run names any more (session-log item 7): decided
        // here, on the rows this transaction leaves; dropped after it.
        candidates = this.sql
          .exec<{ key: string; thread_key: string }>(
            `SELECT key, thread_key FROM sessions
              WHERE key NOT IN (SELECT session_key FROM runs WHERE session_key IS NOT NULL)`,
          )
          .toArray()
          .map((r) => ({ key: r.key, threadKey: r.thread_key }));
      });
      const dropped = await this.sweepSessions(candidates);
      console.log(
        `[runs/alarm] swept ${deleted} rows outside policy, pruned ${receipts} intake receipt(s), dropped ${dropped} session log(s)`,
      );
      // The plane's re-ask (record 0064): while a queued row waits on a resident
      // that has said nothing within the cadence, one probe effect per
      // resident — and the next alarm is pulled forward to the cadence, so a
      // silent resident is probed, never waited on forever. The sweep rides
      // the same alarm; a probing cadence re-runs it, which is only indexed
      // deletes and only while something waits.
      if (this.planeWaitsOnResident()) {
        const probes = this.planeApply({ kind: "reask", at: now, cadenceMs: this.planeReaskMs() }).effects;
        if (probes.length > 0) console.log(`[plane/reask] ${probes.map((e) => e.id).join(", ")}`);
      }
      await this.ctx.storage.setAlarm(now + RUN_SWEEP_INTERVAL_MS);
      await this.ensurePlaneReaskAlarm(now);
      root.end("ok", { swept: deleted });
    } catch (err) {
      root.fail(err);
      root.end("error");
      throw err;
    }
  }

  /** Drop the session logs among `candidates` that still have no kept run and
   *  no live run on their thread (session-log item 7), each object's owner row
   *  first so a late write is refused, then its rows; the registry row goes
   *  once the object is empty. Outside the sweep's transaction — a Durable
   *  Object call cannot run inside one — so each drop awaits, and a claim or a
   *  finish can land between two of them: the decision is therefore taken per
   *  key on what the object reads right before that key's drop, never on the
   *  list the transaction produced. A candidate a live run or a fresh record
   *  has overtaken is skipped and keeps its registry row. Returns how many dropped. */
  async sweepSessions(candidates: readonly { key: string; threadKey: string }[]): Promise<number> {
    let dropped = 0;
    for (const { key, threadKey } of candidates) {
      const [{ decision }] = sessionsToDrop([
        {
          key,
          hasKeptRun: this.sql.exec(`SELECT 1 FROM runs WHERE session_key = ? LIMIT 1`, key).toArray().length > 0,
          threadLive:
            this.sql.exec(`SELECT 1 FROM live_runs WHERE thread_key = ? LIMIT 1`, threadKey).toArray().length > 0,
        },
      ]);
      if (decision !== "drop") continue;
      try {
        await this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(key)).drop();
        this.sql.exec(`DELETE FROM sessions WHERE key = ?`, key);
        dropped++;
      } catch (err) {
        console.warn(
          `[runs/alarm] session log ${key} not dropped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return dropped;
  }

  /** The registry row's `bytes` is the object's own count, read after a finish
   *  (the one moment a session's size changes and the store is told). Best
   *  effort: a registry row without a fresh count is a stale number, never a
   *  wrong decision — the sweep decides on run rows and live rows alone. */
  private async refreshSessionBytes(key: string | undefined): Promise<void> {
    if (key === undefined) return;
    try {
      const bytes = await this.env.SESSION_LOGS.get(this.env.SESSION_LOGS.idFromName(key)).bytes();
      this.sql.exec(`UPDATE sessions SET bytes = ? WHERE key = ?`, bytes, key);
    } catch (err) {
      console.warn(`[runs/finish] session ${key} bytes not read: ${err instanceof Error ? err.message : String(err)}`);
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
   * What the runs that finished in [sinceMs, untilMs) and are inside the
   * retention window cost (costs.md items 10–10a; run-history item 56): one row
   * per run — its requester, thread, channel, agent and usage — plus the
   * identity of every parent a child names that is outside the batch, so the
   * bot bills the child without a second read. The arithmetic is the bot's; the
   * Worker only reads its rows. A row written before `usage_json` existed is
   * filled in here from its stored `model.turn` events — up to
   * USAGE_BACKFILL_PER_CALL a call, the rest answered without `usage` and
   * counted in `pending` — so the history heals as it is read, with no
   * operator step; a run without turns is written back as the zero usage so it
   * is not re-read.
   */
  usage(sinceMs: number, untilMs: number): RunUsageRows {
    const now = systemClock();
    const { policy } = this.policyState();
    const cutoff = now - policy.retentionDays * 86_400_000;
    const rows = this.sql
      .exec<UsageRow>(
        `SELECT run_id, user_id, agent, channel_id, thread_key, started_at, finished_at, usage_json, summary_json FROM runs
          WHERE finished_at >= ? AND finished_at < ? ORDER BY finished_at ASC, run_id ASC`,
        Math.max(sinceMs, cutoff),
        untilMs,
      )
      .toArray();
    let backfilled = 0;
    let pending = 0;
    const runs: UsageRun[] = rows.map((row) => {
      let usage = parseUsageJson(row.usage_json);
      if (usage === undefined && backfilled < USAGE_BACKFILL_PER_CALL) {
        usage = usageOfEvents(this.modelTurnEvents(row.run_id));
        this.sql.exec(`UPDATE runs SET usage_json = ? WHERE run_id = ?`, JSON.stringify(usage), row.run_id);
        backfilled += 1;
      }
      if (usage === undefined) pending += 1;
      const who = identityOfSummary(row.summary_json);
      return {
        id: row.run_id,
        userId: row.user_id,
        ...(who.userName ? { userName: who.userName } : {}),
        ...(who.parentRunId ? { parentRunId: who.parentRunId } : {}),
        threadKey: row.thread_key,
        channelId: row.channel_id,
        ...(row.agent ? { agent: row.agent } : {}),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        ...(usage ? { usage } : {}),
      };
    });
    // The parents a child names that are not in the batch: looked up once each, known or not.
    const inBatch = new Set(runs.map((r) => r.id));
    const parents: Record<string, UsageIdentity> = {};
    for (const id of new Set(runs.map((r) => r.parentRunId).filter((p): p is string => !!p && !inBatch.has(p)))) {
      const p = this.sql
        .exec<{ user_id: string; summary_json: string }>(`SELECT user_id, summary_json FROM runs WHERE run_id = ?`, id)
        .toArray()[0];
      if (!p) continue;
      const who = identityOfSummary(p.summary_json);
      parents[id] = { userId: p.user_id, ...(who.userName ? { userName: who.userName } : {}) };
    }
    const earliest = this.sql
      .exec<{ m: number | null }>(`SELECT MIN(finished_at) AS m FROM runs WHERE finished_at >= ?`, cutoff)
      .one().m;
    return {
      runs,
      parents,
      pending,
      ...(earliest !== null ? { earliestFinishedAt: earliest } : {}),
      retentionDays: policy.retentionDays,
    };
  }

  /** The stored `model.turn` span ends of one run — the rows a backfill prices. */
  private modelTurnEvents(runId: string): RunEvent[] {
    const out: RunEvent[] = [];
    for (const r of this.sql
      .exec<{ json: string }>(`SELECT json FROM run_events WHERE run_id = ? AND json LIKE '%"model.turn"%'`, runId)
      .toArray()) {
      try {
        const e = JSON.parse(r.json) as RunEvent;
        if (e && e.type === "span_end") out.push(e);
      } catch {
        // an unparsable event row prices nothing
      }
    }
    return out;
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
    if (q.threadKey !== undefined) {
      where.push(`thread_key = ?`);
      params.push(q.threadKey);
    }
    if (q.parentRunId !== undefined) {
      where.push(`parent_run_id = ?`);
      params.push(q.parentRunId);
    }
    if (q.pr !== undefined) {
      // `namesPullRequest` in SQL: the row's repository and the number it names.
      where.push(`repo = ?`, `pr_number = ?`);
      params.push(q.pr.repo, q.pr.number);
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
/** How many usage-less rows one by-user read prices from their events before
 *  reporting the rest as pending: a page load stays quick while the history heals. */
const USAGE_BACKFILL_PER_CALL = 200;

type UsageRow = {
  run_id: string;
  user_id: string;
  agent: string | null;
  channel_id: string;
  thread_key: string;
  started_at: number;
  finished_at: number;
  usage_json: string | null;
  summary_json: string;
};

/** A stored `usage_json`, or undefined when absent or unreadable (then it is recomputed). */
function parseUsageJson(raw: string | null): RunUsage | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRunUsage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The two identity fields the by-user aggregate needs off a summary, read leniently. */
function identityOfSummary(raw: string): { userName?: string; parentRunId?: string } {
  try {
    const s = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(typeof s.userName === "string" && s.userName ? { userName: s.userName } : {}),
      ...(typeof s.parentRunId === "string" && s.parentRunId ? { parentRunId: s.parentRunId } : {}),
    };
  } catch {
    return {};
  }
}

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

/** The one field of a stored row's summary the emission rule reads: whether the
 *  row is a provisional tombstone. Deliberately not a full `RunRecord` parse
 *  (run-metrics.md item 2) — this runs inside every upsert's transaction. */
function summaryIsProvisional(summaryJson: string): boolean {
  try {
    return (JSON.parse(summaryJson) as { provisional?: unknown }).provisional === true;
  } catch {
    return false;
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

function parseRunPut(
  body: unknown,
): Validated<{ storeKey: string; record: RunRecord; proposal?: RunPolicyProposal; point?: RunMetricsPoint }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return key;
  if (!isRunRecord(b.record)) return invalid("record must be a RunRecord");
  const out: { storeKey: string; record: RunRecord; proposal?: RunPolicyProposal; point?: RunMetricsPoint } = {
    storeKey: key.value,
    record: b.record,
  };
  // The record's metrics point (run-metrics.md item 1), validated at the door
  // like everything else that reaches storage.
  if (b.point !== undefined) {
    if (!isRunMetricsPoint(b.point)) return invalid("point must be a RunMetricsPoint");
    out.point = b.point;
  }
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
/** At most a year of runs a call — the page asks for 90 days at most. */
const USAGE_QUERY_MAX_SPAN_MS = 366 * 86_400_000;

function parseRunUsageQuery(body: unknown): Validated<{ storeKey: string; sinceMs: number; untilMs: number }> {
  if (typeof body !== "object" || body === null) return invalid("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return key;
  const { sinceMs, untilMs } = b;
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs) || sinceMs < 0)
    return invalid("sinceMs must be a non-negative number");
  if (typeof untilMs !== "number" || !Number.isFinite(untilMs) || untilMs <= sinceMs)
    return invalid("untilMs must be a number after sinceMs");
  if (untilMs - sinceMs > USAGE_QUERY_MAX_SPAN_MS) return invalid("the range may span at most 366 days");
  return { ok: true, value: { storeKey: key.value, sinceMs, untilMs } };
}

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
  for (const field of ["agent", "channel", "threadKey"] as const) {
    const v = b[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > MAX_KEY_CHARS)
      return invalid(`${field} must be a string of at most ${MAX_KEY_CHARS} characters`);
    query[field] = v;
  }
  if (b.parentRunId !== undefined) {
    const id = parseRunId(b.parentRunId);
    if (!id.ok) return invalid("parentRunId must match ^[A-Za-z0-9_-]{1,64}$");
    query.parentRunId = id.value;
  }
  if (b.pr !== undefined) {
    const pr = b.pr as Record<string, unknown> | null;
    if (
      typeof pr !== "object" ||
      pr === null ||
      typeof pr.repo !== "string" ||
      !REPO_SLUG.test(pr.repo) ||
      typeof pr.number !== "number" ||
      !Number.isInteger(pr.number) ||
      pr.number < 1
    )
      return invalid("pr must be { repo: owner/name, number: a positive integer }");
    query.pr = { repo: pr.repo, number: pr.number };
  }
  if (b.visibleTo !== undefined) {
    // A malformed filter is a 400, never "all": the bot degrades to live rows
    // rather than the DO widening what an actor may see.
    if (!isRunVisibilityFilter(b.visibleTo)) return invalid("visibleTo must be a run visibility filter");
    const headroom = DO_MAX_BOUND_PARAMETERS - RUN_LIST_BASE_PARAMETERS - (query.pr ? RUN_LIST_PR_PARAMETERS : 0);
    if (boundParameters(b.visibleTo) > headroom) return invalid(`visibleTo names more than ${headroom} ids`);
    query.visibleTo = b.visibleTo;
  }
  return { ok: true, value: { storeKey: key.value, query } };
}

/** Parameters the page query binds before any filter: the cursor pair (3) and the age floor (1),
 *  plus `agent`, `channel`, `threadKey`, `parentRunId`, and the LIMIT at most — the headroom `visibleTo` must fit under. */
const RUN_LIST_BASE_PARAMETERS = 9;
/** The two more a `pr` filter binds (`repo`, `pr_number`), taken from the same headroom only when asked. */
const RUN_LIST_PR_PARAMETERS = 2;

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

/** `POST /list {scopeKey, limit, query?, kind?}`. */
function parseList(
  body: unknown,
): Validated<{ scopeKey: string; limit: number; query?: string; kind?: MemoryRecord["kind"] }> {
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
  if (b.kind !== undefined && b.kind !== "fact" && b.kind !== "summary")
    return invalid('kind must be "fact" or "summary"');
  return {
    ok: true,
    value: {
      scopeKey: scope.value,
      limit: limit.value,
      ...(typeof b.query === "string" ? { query: b.query } : {}),
      ...(b.kind === "fact" || b.kind === "summary" ? { kind: b.kind } : {}),
    },
  };
}

/** `POST /sweep {scopeKey, dryRun?}`. */
function parseSweep(body: unknown): Validated<{ scopeKey: string; dryRun: boolean }> {
  if (!isJsonObject(body)) return invalid("body must be a JSON object");
  const b = body;
  const scope = parseScopeKey(b.scopeKey);
  if (!scope.ok) return scope;
  if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") return invalid("dryRun must be a boolean");
  return { ok: true, value: { scopeKey: scope.value, dryRun: b.dryRun === true } };
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
  if (c.restates !== undefined) {
    if (typeof c.restates !== "string" || c.restates.length > MAX_KEY_CHARS)
      return invalid(`${at}.restates must be a string`);
    out.restates = c.restates;
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

/** A tool-result marker's size, for the byte policy's first estimate of how
 *  many rows to replace; the pass repeats on the measured total, so the
 *  estimate only decides how many rows one pass tries. */
const TRIM_MARKER_BYTES_ESTIMATE = 260;

type SessionTurnRow = { id: number; idx: number; part: number; json: string; text: string };

/**
 * One session log (docs/reference/specs/session-log.md): the transcript rows of every
 * run of a thread-and-agent session, each at its log index, under the same
 * `(idx, part)` upsert and owner fence as a run's transcript object — plus a
 * full-text index over the rows' text, kept in step by hand because an
 * external-content FTS5 table learns of a replaced row only when told, the
 * attachments the rows reference, the byte policy that replaces the oldest
 * tool results with a marker once the log is over its budget, and the
 * notepad row a later release writes. Nothing here is cleared when a run
 * finishes; the sweep on `RunHistoryDO` drops the whole object.
 */
export class SessionLogDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS owner (k INTEGER PRIMARY KEY CHECK (k = 1), run_id TEXT NOT NULL, gen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY,
        idx INTEGER NOT NULL,
        part INTEGER NOT NULL,
        kind TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        trimmed INTEGER NOT NULL DEFAULT 0,
        json TEXT NOT NULL,
        text TEXT NOT NULL,
        UNIQUE (idx, part)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(text, content='turns', content_rowid='id');
      CREATE TABLE IF NOT EXISTS attachments (
        ref TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        data TEXT NOT NULL,
        bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notepad (k INTEGER PRIMARY KEY CHECK (k = 1), text TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    // The keyed append's identity (session-log item 13): a row group's id, on
    // its first part; a partial unique index holds the idempotency line. Added
    // by ALTER so a log written before the column keeps its rows.
    const columns = new Set(
      this.sql
        .exec<{ name: string }>(`SELECT name FROM pragma_table_info('turns')`)
        .toArray()
        .map((r) => r.name),
    );
    if (!columns.has("row_id")) this.sql.exec(`ALTER TABLE turns ADD COLUMN row_id TEXT`);
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS turns_row_id ON turns(row_id) WHERE row_id IS NOT NULL`);
  }

  /** The index the next row lands at: one past the newest turn, 0 for an empty
   *  log. (Not named `tail`: the runtime reserves that as a handler name on an
   *  entrypoint and refuses it over RPC.) */
  async nextIndex(): Promise<{ next: number }> {
    return { next: this.next() };
  }

  private next(): number {
    return this.sql.exec<{ next: number }>(`SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM turns`).one().next;
  }

  /** The live writer: the run and the generation whose writes land. Replaced
   *  by every claim and reclaim, as the transcript object's owner is. The byte
   *  budget rides along so the object enforces the store's policy on write. */
  async setOwner(runId: string, gen: string, maxBytes: number = DEFAULT_SESSION_LOG_MAX_BYTES): Promise<{ ok: true }> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO owner (k, run_id, gen) VALUES (1, ?, ?) ON CONFLICT(k) DO UPDATE SET run_id = excluded.run_id, gen = excluded.gen`,
        runId,
        gen,
      );
      this.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('max_bytes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(maxBytes),
      );
    });
    return { ok: true };
  }

  async maxBytes(): Promise<number> {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'max_bytes'`).toArray()[0];
    const n = row ? Number(row.value) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_LOG_MAX_BYTES;
  }

  private owner(): { runId: string; gen: string } | undefined {
    const row = this.sql
      .exec<{ run_id: string; gen: string }>(`SELECT run_id, gen FROM owner WHERE k = 1`)
      .toArray()[0];
    return row ? { runId: row.run_id, gen: row.gen } : undefined;
  }

  /** The owner releases the log at its finish so a zombie of a finished run is
   *  refused rather than appending to a session it no longer drives; only the
   *  owner may. The rows stay. */
  async clearOwner(runId: string, gen: string): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const owner = this.owner();
      if (!owner) {
        out = { ok: false, reason: "unknown-run" };
        return;
      }
      if (owner.runId !== runId || owner.gen !== gen) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      this.sql.exec(`DELETE FROM owner`);
    });
    return out;
  }

  /** One row into the table and the index. A row already at `(idx, part)` — a
   *  zombie's late write the new generation overwrites — has its index entry
   *  deleted first, then goes; the new row is inserted with its own id and
   *  indexed. */
  private putRow(row: TranscriptRow, json: string, trimmed: boolean): void {
    const existing = this.sql
      .exec<{ id: number; text: string }>(`SELECT id, text FROM turns WHERE idx = ? AND part = ?`, row.idx, row.part)
      .toArray()[0];
    if (existing) {
      this.sql.exec(
        `INSERT INTO turns_fts (turns_fts, rowid, text) VALUES ('delete', ?, ?)`,
        existing.id,
        existing.text,
      );
      this.sql.exec(`DELETE FROM turns WHERE id = ?`, existing.id);
    }
    const text = textOfStoredRow(json);
    this.sql.exec(
      `INSERT INTO turns (idx, part, kind, bytes, trimmed, json, text) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.idx,
      row.part,
      rowKind(json),
      utf8ByteLength(json),
      trimmed ? 1 : 0,
      json,
      text,
    );
    const id = this.sql.exec<{ id: number }>(`SELECT last_insert_rowid() AS id`).one().id;
    this.sql.exec(`INSERT INTO turns_fts (rowid, text) VALUES (?, ?)`, id, text);
  }

  /** The idempotent keyed append (session-log item 13): the parts of ONE turn
   *  land at the tail under `rowId` — a fold of a `ship_unit` event, a
   *  connector's turn, a migrated row. A row id the log has seen appends
   *  nothing, so a fold read twice yields one row; two appends keep their
   *  arrival order, since each lands at the tail inside one transaction. No
   *  owner fence: a thread session has no one owning run. */
  async appendKeyed(
    rowId: string,
    rows: Array<{ part: number; json: string }>,
  ): Promise<{ ok: true; appended: boolean }> {
    let appended = false;
    this.ctx.storage.transactionSync(() => {
      const seen = this.sql.exec(`SELECT 1 FROM turns WHERE row_id = ? LIMIT 1`, rowId).toArray().length > 0;
      if (seen) return;
      const idx = this.next();
      for (const [i, r] of rows.entries()) {
        this.putRow({ idx, part: r.part, json: r.json }, r.json, false);
        if (i === 0) this.sql.exec(`UPDATE turns SET row_id = ? WHERE idx = ? AND part = ?`, rowId, idx, r.part);
      }
      appended = true;
      this.enforceBytePolicy();
    });
    return { ok: true, appended };
  }

  async write(
    gen: string,
    rows: TranscriptRow[],
    attachments: TranscriptAttachment[],
  ): Promise<FenceResult & { bytes?: number }> {
    let out: FenceResult & { bytes?: number } = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const owner = this.owner();
      if (owner === undefined) {
        out = { ok: false, reason: "unknown-run" };
        return;
      }
      if (owner.gen !== gen) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      for (const a of attachments) {
        this.sql.exec(
          `INSERT OR REPLACE INTO attachments (ref, media_type, data, bytes) VALUES (?, ?, ?, ?)`,
          a.ref,
          a.mediaType,
          a.data,
          utf8ByteLength(a.data),
        );
      }
      for (const r of rows) this.putRow(r, r.json, false);
      out = { ok: true, bytes: this.enforceBytePolicy() };
    });
    return out;
  }

  private totalBytes(): number {
    return (
      this.sql.exec<{ b: number }>(`SELECT COALESCE(SUM(bytes), 0) AS b FROM turns`).one().b +
      this.sql.exec<{ b: number }>(`SELECT COALESCE(SUM(bytes), 0) AS b FROM attachments`).one().b
    );
  }

  /** Whether any row other than `exceptId` references the attachment `ref`.
   *  Rows carry references inside their JSON, so the check is a substring
   *  match on the quoted field; refs are `t<idx>p<part>`, and the closing quote
   *  keeps `t1p0` from matching `t1p01`. */
  private referencedElsewhere(ref: string, exceptId: number): boolean {
    return (
      this.sql
        .exec(`SELECT 1 FROM turns WHERE id != ? AND INSTR(json, ?) > 0 LIMIT 1`, exceptId, `"dataRef":"${ref}"`)
        .toArray().length > 0
    );
  }

  /** The bytes a trimmed row would free beyond its own: the attachments only
   *  it references (session-log item 5). */
  private soleAttachmentBytes(row: { id: number; json: string }): number {
    let bytes = 0;
    for (const ref of attachmentRefsOf(row.json)) {
      if (this.referencedElsewhere(ref, row.id)) continue;
      bytes +=
        this.sql.exec<{ bytes: number }>(`SELECT bytes FROM attachments WHERE ref = ?`, ref).toArray()[0]?.bytes ?? 0;
    }
    return bytes;
  }

  /** The byte policy (session-log item 5): over the budget, the oldest tool
   *  results are replaced by a marker, oldest first, each taking with it the
   *  attachments no remaining row references, until the log fits or none is
   *  left; user and assistant text is never dropped, nor an attachment a kept
   *  row still shows. Each pass plans on an estimate of the marker's size and
   *  re-measures, so a pass is never short by more than the estimate's error
   *  and the loop ends when the candidates do. Returns the total after. */
  private enforceBytePolicy(): number {
    const max = Number(
      this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'max_bytes'`).toArray()[0]?.value ??
        DEFAULT_SESSION_LOG_MAX_BYTES,
    );
    let total = this.totalBytes();
    while (total > max) {
      const candidates = this.sql
        .exec<{ id: number; bytes: number; json: string }>(
          `SELECT id, bytes, json FROM turns WHERE kind = 'tool_result' AND trimmed = 0 ORDER BY idx ASC, part ASC`,
        )
        .toArray()
        .map((c) => ({ id: c.id, bytes: c.bytes + this.soleAttachmentBytes(c) }));
      const ids = planSessionTrim(candidates, total - max, TRIM_MARKER_BYTES_ESTIMATE);
      if (ids.length === 0) break;
      for (const id of ids) {
        const row = this.sql
          .exec<SessionTurnRow & { row_id: string | null }>(
            `SELECT id, idx, part, json, text, row_id FROM turns WHERE id = ?`,
            id,
          )
          .toArray()[0];
        if (!row) continue;
        const marker = droppedToolResultRow(row.json);
        if (marker === undefined) {
          // Not replaceable after all: mark it so the loop never picks it again.
          this.sql.exec(`UPDATE turns SET trimmed = 1 WHERE id = ?`, id);
          continue;
        }
        const refs = attachmentRefsOf(row.json);
        this.putRow({ idx: row.idx, part: row.part, json: marker }, marker, true);
        // The marker keeps the row's keyed-append id (item 13): `putRow` deletes
        // the old row, so without this the partial unique index forgets the id
        // and a replayed migration or fold would re-append the trimmed turn.
        if (row.row_id !== null)
          this.sql.exec(`UPDATE turns SET row_id = ? WHERE idx = ? AND part = ?`, row.row_id, row.idx, row.part);
        // The marker references nothing, so an attachment only this row showed is now orphaned.
        for (const ref of refs) {
          if (!this.referencedElsewhere(ref, -1)) this.sql.exec(`DELETE FROM attachments WHERE ref = ?`, ref);
        }
      }
      total = this.totalBytes();
    }
    return total;
  }

  /** Every attachment the log holds, by reference. */
  async attachmentRefs(): Promise<string[]> {
    return this.sql
      .exec<{ ref: string }>(`SELECT ref FROM attachments ORDER BY ref`)
      .toArray()
      .map((r) => r.ref);
  }

  /** The rows from `from` to `to` (inclusive; the tail when `to` is absent), in
   *  (idx, part) order, with the attachments those rows reference. */
  async read(from: number, to?: number): Promise<{ rows: TranscriptRow[]; attachments: TranscriptAttachment[] }> {
    const rows = this.sql
      .exec<{ idx: number; part: number; json: string }>(
        `SELECT idx, part, json FROM turns WHERE idx >= ? AND idx <= ? ORDER BY idx, part`,
        from,
        to ?? Number.MAX_SAFE_INTEGER,
      )
      .toArray();
    return { rows, attachments: this.attachmentsOf(rows) };
  }

  private attachmentsOf(rows: readonly TranscriptRow[]): TranscriptAttachment[] {
    const refs = [...new Set(rows.flatMap((r) => attachmentRefsOf(r.json)))];
    if (refs.length === 0) return [];
    const out: TranscriptAttachment[] = [];
    for (let i = 0; i < refs.length; i += DO_MAX_BOUND_PARAMETERS) {
      const batch = refs.slice(i, i + DO_MAX_BOUND_PARAMETERS);
      out.push(
        ...this.sql
          .exec<{ ref: string; media_type: string; data: string }>(
            `SELECT ref, media_type, data FROM attachments WHERE ref IN (${batch.map(() => "?").join(",")}) ORDER BY ref`,
            ...batch,
          )
          .toArray()
          .map((a) => ({ ref: a.ref, mediaType: a.media_type, data: a.data })),
      );
    }
    return out;
  }

  /** The tail a follow-up seeds from (session-log item 4): the newest whole
   *  turns within `maxBytes`, answered oldest first with the first index they
   *  start at; when even the newest turn is over the budget, no rows and the
   *  tail index. */
  async readTail(
    maxBytes: number,
  ): Promise<{ rows: TranscriptRow[]; attachments: TranscriptAttachment[]; from: number }> {
    const newestFirst = this.sql
      .exec<{ idx: number; bytes: number }>(`SELECT idx, bytes FROM turns ORDER BY idx DESC, part DESC`)
      .toArray();
    const from = tailCut(newestFirst, maxBytes);
    if (from === undefined) return { rows: [], attachments: [], from: this.next() };
    return { ...(await this.read(from)), from };
  }

  /** The rows whose text matches `query`, in relevance order (FTS5's bm25 rank,
   *  the order the memory store's search uses; the newest first among equals),
   *  each with its turn, part, role, kind and indexed text — what `recall`
   *  answers (session-log item 10). */
  async search(query: string, limit: number): Promise<SessionHit[]> {
    const match = ftsMatchExpr(query);
    if (match === null) return [];
    return this.sql
      .exec<{ idx: number; part: number; kind: string; json: string; text: string }>(
        `SELECT t.idx, t.part, t.kind, t.json, t.text FROM turns_fts f JOIN turns t ON t.id = f.rowid
          WHERE turns_fts MATCH ? ORDER BY f.rank, t.idx DESC, t.part DESC LIMIT ?`,
        match,
        limit,
      )
      .toArray()
      .map(({ idx, part, kind, json, text }) => {
        const role = roleOfStoredRow(json);
        return { idx, part, ...(role !== undefined ? { role } : {}), kind, text };
      });
  }

  /** The gap markers (session-log item 9) whose turn lies in `[from, to]`: the
   *  rows a follow-up appended because the run before it detached, so a search
   *  whose hits straddle one can say the log ends short between them. */
  async gapsBetween(from: number, to: number): Promise<number[]> {
    return this.sql
      .exec<{ idx: number }>(
        `SELECT DISTINCT idx FROM turns WHERE idx >= ? AND idx <= ? AND kind = 'text' AND text = ? ORDER BY idx`,
        from,
        to,
        GAP_MARKER,
      )
      .toArray()
      .map((r) => r.idx);
  }

  /** The notepad, replaced whole by the live run (session-log item 10): the
   *  same fence as a row write — unknown-run before an owner, fenced for
   *  another generation — and the write's time kept beside the text. */
  async writeNotepad(gen: string, text: string, now: number): Promise<FenceResult> {
    let out: FenceResult = { ok: true };
    this.ctx.storage.transactionSync(() => {
      const owner = this.owner();
      if (owner === undefined) {
        out = { ok: false, reason: "unknown-run" };
        return;
      }
      if (owner.gen !== gen) {
        out = { ok: false, reason: "fenced" };
        return;
      }
      this.sql.exec(
        `INSERT INTO notepad (k, text, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(k) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
        text,
        now,
      );
    });
    return out;
  }

  async bytes(): Promise<number> {
    return this.totalBytes();
  }

  async rowCount(): Promise<number> {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM turns`).one().n;
  }

  async notepad(): Promise<{ text: string; updatedAt: number } | null> {
    const row = this.sql
      .exec<{ text: string; updated_at: number }>(`SELECT text, updated_at FROM notepad WHERE k = 1`)
      .toArray()[0];
    return row ? { text: row.text, updatedAt: row.updated_at } : null;
  }

  /** The sweep's drop (session-log item 7): the owner first, so a write that
   *  races the drop is refused rather than landing on a log about to go, then
   *  every row, index entry, attachment, the notepad and the budget. */
  async drop(): Promise<{ ok: true }> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM owner`);
      this.sql.exec(`INSERT INTO turns_fts (turns_fts) VALUES ('delete-all')`);
      this.sql.exec(`DELETE FROM turns`);
      this.sql.exec(`DELETE FROM attachments`);
      this.sql.exec(`DELETE FROM notepad`);
      this.sql.exec(`DELETE FROM meta`);
    });
    return { ok: true };
  }
}

const LEDGER_ROUTES = new Set([
  "/runs/coordinator/put",
  "/runs/coordinator/replace",
  "/runs/coordinator/get",
  "/runs/coordinator/stop",
  "/runs/coordinator/units/put",
  "/runs/coordinator/units/list",
  "/runs/coordinator/events/append",
  "/runs/coordinator/events/list",
  "/runs/coordinator/events/mark-consumed",
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
  "/runs/intake",
  "/runs/intake/read",
  "/runs/intake/list",
  "/runs/transcript/owner",
  "/runs/transcript/write",
  "/runs/transcript/read",
  "/runs/transcript/clear",
  "/runs/session/tail",
  "/runs/session/owner",
  "/runs/session/write",
  "/runs/session/append",
  "/runs/session/read",
  "/runs/session/read-tail",
  "/runs/session/clear-owner",
  "/runs/session/search",
  "/runs/session/notepad",
  "/runs/session/notepad/write",
]);

/** The plane's routes (record 0064; orchestration-plane items 7 and 8): the shadow outcome post and the
 *  effect acknowledgement. Both land on the ledger object of the given store
 *  key, like every `/runs/*` route. */
const PLANE_ROUTES = new Set([
  "/plane/outcome",
  "/plane/ack",
  "/plane/admit",
  "/plane/withdraw",
  "/plane/deploy",
  "/plane/queued",
  "/plane/level",
  "/plane/observe",
]);

const PLANE_LEVEL_NAMES = new Set(["seat", "memory", "drain"]);
const PLANE_LEVEL_SIDES = new Set(["below", "above"]);

const PLANE_STAGES = new Set(["admission", "runner", "resident"]);
const PLANE_OUTCOME = /^(proceeded|refused:[a-z0-9-]+|fell_cold:[a-z0-9_-]+)$/;
const PLANE_ACK_OUTCOMES = new Set(["done", "skipped", "deferred"]);

/** The `/plane/*` routes: validated before any object call, ids and words
 *  only on the log lines. */
async function handlePlane(pathname: string, body: unknown, env: Env): Promise<Response> {
  if (typeof body !== "object" || body === null) return json({ error: "body must be a JSON object" }, 400);
  const b = body as Record<string, unknown>;
  const key = parseStoreKey(b);
  if (!key.ok) return json({ error: key.error }, 400);
  const stub = env.RUNS.get(env.RUNS.idFromName(key.value));
  const now = systemClock();
  if (pathname === "/plane/outcome") {
    if (typeof b.threadKey !== "string" || b.threadKey.length === 0)
      return json({ error: "threadKey must be a non-empty string" }, 400);
    if (typeof b.requester !== "string" || b.requester.length === 0)
      return json({ error: "requester must be a non-empty string" }, 400);
    if (typeof b.stage !== "string" || !PLANE_STAGES.has(b.stage))
      return json({ error: "stage must be admission, runner or resident" }, 400);
    if (typeof b.outcome !== "string" || !PLANE_OUTCOME.test(b.outcome))
      return json({ error: "outcome must be proceeded, refused:<code> or fell_cold:<token>" }, 400);
    let runId: string | undefined;
    if (b.runId !== undefined) {
      const parsed = parseRunId(b.runId);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      runId = parsed.value;
    }
    const r = await stub.planeOutcome(
      {
        ...(runId !== undefined ? { runId } : {}),
        requester: b.requester,
        threadKey: b.threadKey,
        stage: b.stage as PlaneStage,
        outcome: b.outcome,
      },
      now,
    );
    return json(r);
  }
  if (pathname === "/plane/ack") {
    if (typeof b.id !== "string" || b.id.length === 0) return json({ error: "id must be a non-empty string" }, 400);
    if (typeof b.outcome !== "string" || !PLANE_ACK_OUTCOMES.has(b.outcome))
      return json({ error: "outcome must be done, skipped or deferred" }, 400);
    return json(await stub.planeAck(b.id, b.outcome as PlaneAckOutcome, now));
  }
  if (pathname === "/plane/admit") {
    // The admission-stage ask (record 0064, "The queue"): the thread key, the
    // requester and the request in the durable inbox's shape. The route mints
    // the run id: `queued` stores the request under it, `admitted` names it as
    // the reservation.
    if (typeof b.threadKey !== "string" || b.threadKey.length === 0)
      return json({ error: "threadKey must be a non-empty string" }, 400);
    if (typeof b.requester !== "string" || b.requester.length === 0)
      return json({ error: "requester must be a non-empty string" }, 400);
    if (typeof b.request !== "object" || b.request === null || Array.isArray(b.request))
      return json({ error: "request must be a JSON object" }, 400);
    if (b.stage !== undefined && (typeof b.stage !== "string" || !PLANE_STAGES.has(b.stage)))
      return json({ error: "stage must be admission, runner or resident" }, 400);
    if (b.resident !== undefined && (typeof b.resident !== "string" || b.resident.length === 0))
      return json({ error: "resident must be a non-empty string" }, 400);
    if (b.restartOf !== undefined && typeof b.restartOf !== "boolean")
      return json({ error: "restartOf must be a boolean" }, 400);
    if (b.reaskMs !== undefined && (typeof b.reaskMs !== "number" || !(b.reaskMs > 0)))
      return json({ error: "reaskMs must be a positive number of milliseconds" }, 400);
    try {
      const answer = await stub.planeAdmit(
        {
          runId: crypto.randomUUID(),
          requester: b.requester,
          threadKey: b.threadKey,
          request: b.request as Record<string, unknown>,
          ...(b.stage !== undefined ? { stage: b.stage as PlaneStage } : {}),
          ...(b.resident !== undefined ? { resident: b.resident } : {}),
          ...(b.restartOf !== undefined ? { restartOf: b.restartOf } : {}),
          ...(b.reaskMs !== undefined ? { reaskMs: b.reaskMs } : {}),
        },
        now,
      );
      return json(answer);
    } catch (err) {
      // The effect caps refuse by name (record 0064): the ask is answered with
      // the cap's own sentence, never queued silently.
      return json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  }
  if (pathname === "/plane/level") {
    // A resident's level report (record 0064): forwarded by the bot from the levels a
    // resident answer carried, or from the registry's drain outbox.
    if (typeof b.resident !== "string" || b.resident.length === 0)
      return json({ error: "resident must be a non-empty string" }, 400);
    if (typeof b.name !== "string" || !PLANE_LEVEL_NAMES.has(b.name))
      return json({ error: "name must be seat, memory or drain" }, 400);
    if (typeof b.side !== "string" || !PLANE_LEVEL_SIDES.has(b.side))
      return json({ error: "side must be below or above" }, 400);
    if (typeof b.generation !== "string") return json({ error: "generation must be a string" }, 400);
    return json(
      await stub.planeLevel(
        {
          resident: b.resident,
          name: b.name as "seat" | "memory" | "drain",
          side: b.side as "below" | "above",
          generation: b.generation,
        },
        now,
      ),
    );
  }
  if (pathname === "/plane/observe") {
    // A refusal-by-name met at attach or exec (record 0064).
    const parsed = parseRunId(b.runId);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    if (typeof b.resident !== "string" || b.resident.length === 0)
      return json({ error: "resident must be a non-empty string" }, 400);
    if (typeof b.refusal !== "string" || b.refusal.length === 0)
      return json({ error: "refusal must be a non-empty string" }, 400);
    return json(await stub.planeObserve({ runId: parsed.value, resident: b.resident, refusal: b.refusal }, now));
  }
  if (pathname === "/plane/withdraw") {
    const parsed = parseRunId(b.runId);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    return json(await stub.planeWithdraw(parsed.value, now));
  }
  if (pathname === "/plane/queued") {
    const parsed = parseRunId(b.runId);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    return json({ row: await stub.planeQueueRowOf(parsed.value) });
  }
  if (pathname === "/plane/deploy") {
    // The deploy runner's post (record 0064, "The queue"): `landed` lifts the
    // pending-deploy window — `deploy_settled` flips and the queue walks;
    // `pending` opens it. Version and workers ride the log line only.
    if (b.phase !== "landed" && b.phase !== "pending") return json({ error: "phase must be landed or pending" }, 400);
    try {
      const r = await stub.planeWindow("deploy", b.phase === "landed" ? "lifted" : "opened", now);
      console.log(
        `[plane/deploy] ${b.phase}${typeof b.version === "string" ? ` ${b.version}` : ""} — ${r.admitted} admission(s)`,
      );
      return json({ ok: true, admitted: r.admitted });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  }
  return json({ error: "not found" }, 404);
}

/** Routes whose bodies may carry a record, a transcript chunk, or an event batch. */
const WIDE_BODY_ROUTES = new Set([
  "/runs/put",
  "/runs/finish",
  "/runs/append",
  "/runs/transcript/write",
  "/runs/session/write",
  "/runs/session/append",
]);
/** A delivery snapshot written whole, or a refresh's patch: every merged pull request's reviews and
 *  its branch's workflow runs — about 7 KB a pull request (measured: 291 pull requests, 2.1 MB), so
 *  a first read at the listing cap is under 6 MB and a busy repository's whole window many MB. */
const MAX_SNAPSHOT_BODY_BYTES = 16 * 1024 * 1024;

/** The request body ceiling per route, decided after routing and before the parse. */
function bodyFenceFor(pathname: string): number {
  if (WIDE_BODY_ROUTES.has(pathname)) return MAX_RUN_PUT_BODY_BYTES;
  if (pathname === "/delivery/put" || pathname === "/delivery/merge") return MAX_SNAPSHOT_BODY_BYTES;
  // A ninety-day costs snapshot is a few hundred KB today and grows with the account's rows.
  if (pathname === "/costs/snapshot/put") return MAX_SNAPSHOT_BODY_BYTES;
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
  if (meta.session !== undefined && !isRunSession(meta.session))
    return invalid("run.meta.session must name a session log and the run's range in it");
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

/** The keyed append's rows (session-log item 13): the parts of one turn, no index — the object assigns the tail's. */
function parseKeyedRows(v: unknown): Validated<Array<{ part: number; json: string }>> {
  if (!Array.isArray(v) || v.length === 0) return invalid("rows must be a non-empty array");
  for (const r of v) {
    const row = r as Record<string, unknown>;
    if (typeof row?.part !== "number" || !Number.isInteger(row.part) || row.part < 0 || typeof row?.json !== "string")
      return invalid("rows entries must be {part, json}");
  }
  return { ok: true, value: v as Array<{ part: number; json: string }> };
}

/** The keyed append's row id (session-log item 13): non-empty, bounded — an event id, a message id with its edit stamp, a migrated row's name. */
function parseRowId(v: unknown): Validated<string> {
  if (typeof v !== "string" || v.length === 0 || v.length > 512)
    return invalid("rowId must be a string of 1..512 characters");
  return { ok: true, value: v };
}

function parseSessionKey(v: unknown): Validated<string> {
  if (typeof v !== "string" || !SESSION_KEY_PATTERN.test(v)) return invalid("key must be a session key");
  return { ok: true, value: v };
}

function parseLogIndex(v: unknown, name: string): Validated<number> {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return invalid(`${name} must be an integer >= 0`);
  return { ok: true, value: v };
}

/** The session log's byte budget on the owner claim: the store's policy field,
 *  clamped into its bounds like every policy field; absent, the default. */
function parseSessionMaxBytes(v: unknown): Validated<number> {
  if (v === undefined) return { ok: true, value: DEFAULT_SESSION_LOG_MAX_BYTES };
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return invalid("maxBytes must be an integer >= 1");
  const [lo, hi] = RETENTION_BOUNDS.sessionLogMaxBytes;
  return { ok: true, value: Math.min(hi, Math.max(lo, v)) };
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

  if (pathname.startsWith("/runs/session/")) {
    const key = parseSessionKey(b.key);
    if (!key.ok) return json({ error: key.error }, 400);
    const stub = env.SESSION_LOGS.get(env.SESSION_LOGS.idFromName(key.value));
    if (pathname === "/runs/session/tail") return json(await stub.nextIndex());
    if (pathname === "/runs/session/owner") {
      const runId = parseRunId(b.runId);
      if (!runId.ok) return json({ error: runId.error }, 400);
      const g = gen(b.gen);
      if (!g.ok) return json({ error: g.error }, 400);
      const max = parseSessionMaxBytes(b.maxBytes);
      if (!max.ok) return json({ error: max.error }, 400);
      return json(await stub.setOwner(runId.value, g.value, max.value));
    }
    if (pathname === "/runs/session/write") {
      const g = gen(b.gen);
      if (!g.ok) return json({ error: g.error }, 400);
      const rows = parseTranscriptRows(b.rows);
      if (!rows.ok) return json({ error: rows.error }, 400);
      const attachments = parseAttachments(b.attachments);
      if (!attachments.ok) return json({ error: attachments.error }, 400);
      const r = await stub.write(g.value, rows.value, attachments.value);
      console.log(
        `[runs/session/write] ${key.value} <- ${rows.value.length} row(s), ${attachments.value.length} attachment(s), ok=${r.ok}`,
      );
      return fenced(r);
    }
    if (pathname === "/runs/session/append") {
      const rowId = parseRowId(b.rowId);
      if (!rowId.ok) return json({ error: rowId.error }, 400);
      const rows = parseKeyedRows(b.rows);
      if (!rows.ok) return json({ error: rows.error }, 400);
      const r = await stub.appendKeyed(rowId.value, rows.value);
      console.log(
        `[runs/session/append] ${key.value} <- ${rows.value.length} row(s) under ${rowId.value}, appended=${r.appended}`,
      );
      return json(r);
    }
    if (pathname === "/runs/session/read") {
      const from = parseLogIndex(b.from, "from");
      if (!from.ok) return json({ error: from.error }, 400);
      if (b.to !== undefined) {
        const to = parseLogIndex(b.to, "to");
        if (!to.ok) return json({ error: to.error }, 400);
        if (to.value < from.value) return json({ error: "to must be at least from" }, 400);
        return json(await stub.read(from.value, to.value));
      }
      return json(await stub.read(from.value));
    }
    if (pathname === "/runs/session/read-tail") {
      const max = b.maxBytes;
      if (typeof max !== "number" || !Number.isInteger(max) || max < 1)
        return json({ error: "maxBytes must be an integer >= 1" }, 400);
      return json(await stub.readTail(max));
    }
    if (pathname === "/runs/session/clear-owner") {
      const runId = parseRunId(b.runId);
      if (!runId.ok) return json({ error: runId.error }, 400);
      const g = gen(b.gen);
      if (!g.ok) return json({ error: g.error }, 400);
      return fenced(await stub.clearOwner(runId.value, g.value));
    }
    // `recall` (session-log item 10): the hits in relevance order, and the gap
    // markers that lie between the oldest and the newest of them.
    if (pathname === "/runs/session/search") {
      if (
        typeof b.query !== "string" ||
        b.query.trim().length === 0 ||
        utf8ByteLength(b.query) > MAX_SEARCH_QUERY_BYTES
      )
        return json({ error: `query must be a non-empty string of at most ${MAX_SEARCH_QUERY_BYTES} bytes` }, 400);
      const limit = b.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_HITS)
        return json({ error: `limit must be an integer in 1..${SEARCH_MAX_HITS}` }, 400);
      const hits = await stub.search(b.query, limit);
      const gaps =
        hits.length > 1
          ? await stub.gapsBetween(Math.min(...hits.map((h) => h.idx)), Math.max(...hits.map((h) => h.idx)))
          : [];
      console.log(`[runs/session/search] ${key.value} -> ${hits.length} hit(s), ${gaps.length} gap(s)`);
      return json({ hits, gaps });
    }
    if (pathname === "/runs/session/notepad") return json({ notepad: await stub.notepad() });
    if (pathname === "/runs/session/notepad/write") {
      const g = gen(b.gen);
      if (!g.ok) return json({ error: g.error }, 400);
      if (typeof b.text !== "string") return json({ error: "text must be a string" }, 400);
      const bytes = utf8ByteLength(b.text);
      if (bytes > NOTEPAD_MAX_BYTES)
        return json({ error: `text is ${bytes} bytes; the notepad holds at most ${NOTEPAD_MAX_BYTES}` }, 400);
      const r = await stub.writeNotepad(g.value, b.text, systemClock());
      console.log(`[runs/session/notepad/write] ${key.value} <- ${bytes} byte(s), ok=${r.ok}`);
      return fenced(r);
    }
    return json({ error: "not found" }, 404);
  }

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
    // The reclaim sweep's answer carries the plane's open effects like every
    // heartbeat answer does (record 0064; orchestration-plane item 7) — empty until a unit writes them.
    return json({ runs, effects: await stub.openPlaneEffects() });
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
  if (pathname === "/runs/coordinator/replace") {
    if (!isCoordinatorInstance(b.instance))
      return json({ error: "instance must be a coordinator instance record" }, 400);
    const r = await stub.replaceInstance(b.instance);
    console.log(`[runs/coordinator/replace] ${key.value} ${b.instance.id} → replaced`);
    return json(r);
  }
  if (pathname === "/runs/coordinator/get") {
    if (typeof b.id !== "string" || !INSTANCE_ID_PATTERN.test(b.id))
      return json({ error: "id must be a Workflow instance id" }, 400);
    return json({ instance: await stub.getInstance(b.id) });
  }
  // The hard stop's mark on the instance row (record 0060; issue 1924): the
  // bot writes it when the hosted parent is sealed; the runner reads it back.
  if (pathname === "/runs/coordinator/stop") {
    if (typeof b.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(b.instanceId))
      return json({ error: "instanceId must be a Workflow instance id" }, 400);
    if (typeof b.at !== "number" || !Number.isFinite(b.at)) return json({ error: "at must be a time" }, 400);
    const r = await stub.markInstanceStopped(b.instanceId, b.at);
    console.log(`[runs/coordinator/stop] ${key.value} ${b.instanceId} → ${r.ok ? "marked" : r.reason}`);
    return r.ok ? json(r) : json(r, 409);
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
  // The thread events of a unit-owned thread (record 0051's reply-as-event rule): append assigns
  // the sequence, list filters unconsumed, mark-consumed is idempotent.
  if (pathname.startsWith("/runs/coordinator/events/")) {
    if (typeof b.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(b.instanceId))
      return json({ error: "instanceId must be a Workflow instance id" }, 400);
    if (typeof b.unit !== "string" || !UNIT_PATTERN.test(b.unit)) return json({ error: "unit must be a unit id" }, 400);
    if (pathname === "/runs/coordinator/events/append") {
      if (!isThreadEvent({ ...(b.event as Record<string, unknown>), seq: 1 }))
        return json({ error: "event must be a thread event (without its seq)" }, 400);
      // The store assigns the sequence and the consumer: a caller's `seq` or
      // `consumedBy` is dropped, so no row is born consumed in its JSON while
      // its column still lists it unconsumed.
      const { seq: _ignored, consumedBy: _fresh, ...event } = b.event as ThreadEvent;
      const r = await stub.appendUnitEvent(b.instanceId, b.unit, event as Omit<ThreadEvent, "seq" | "consumedBy">);
      console.log(`[runs/coordinator/events/append] ${key.value} ${b.instanceId}:${b.unit} seq ${r.seq}`);
      return json(r);
    }
    if (pathname === "/runs/coordinator/events/list") {
      return json({ events: await stub.listUnitEvents(b.instanceId, b.unit, b.unconsumedOnly === true) });
    }
    if (pathname === "/runs/coordinator/events/mark-consumed") {
      if (!Array.isArray(b.seqs) || !b.seqs.every((s) => typeof s === "number" && Number.isInteger(s) && s >= 1))
        return json({ error: "seqs must be an array of sequence numbers" }, 400);
      if (typeof b.by !== "string" || b.by.length === 0 || b.by.length > 200)
        return json({ error: "by must name the consumer" }, 400);
      const r = await stub.markUnitEventsConsumed(b.instanceId, b.unit, b.seqs as number[], b.by);
      console.log(
        `[runs/coordinator/events/mark-consumed] ${key.value} ${b.instanceId}:${b.unit} ${b.seqs.length} row(s) by ${b.by}`,
      );
      return json(r);
    }
  }

  // The intake receipts (run-history item 59): keyed by the message, not a run.
  if (pathname === "/runs/intake" || pathname === "/runs/intake/read") {
    const receiptKey = b.key;
    if (typeof receiptKey !== "string" || receiptKey.length === 0 || receiptKey.length > 256)
      return json({ error: "key must be a non-empty string of at most 256 characters" }, 400);
    if (pathname === "/runs/intake/read") return json({ receipt: await stub.readIntake(receiptKey) });
    if (!isIntakeReceipt(b.receipt)) return json({ error: "receipt must be an intake receipt" }, 400);
    if (b.windowMs !== undefined && (typeof b.windowMs !== "number" || !Number.isFinite(b.windowMs) || b.windowMs < 0))
      return json({ error: "windowMs must be a non-negative number" }, 400);
    const r = await stub.recordIntake(receiptKey, b.receipt, typeof b.windowMs === "number" ? b.windowMs : 0);
    console.log(`[runs/intake] ${key.value} ${receiptKey} → ${r.inserted ? "inserted" : "existing"}`);
    return json(r);
  }
  if (pathname === "/runs/intake/list") {
    if (b.threadKey !== undefined && (typeof b.threadKey !== "string" || b.threadKey.length === 0))
      return json({ error: "threadKey must be a non-empty string" }, 400);
    if (b.since !== undefined && (typeof b.since !== "number" || !Number.isFinite(b.since)))
      return json({ error: "since must be a number" }, 400);
    return json({
      receipts: await stub.listIntake({
        ...(b.threadKey !== undefined ? { threadKey: b.threadKey } : {}),
        ...(b.since !== undefined ? { since: b.since } : {}),
      }),
    });
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
    // The RPC type mapping reads the effects' open-ended `request` JSON as
    // unserializable; the values are plain JSON, so the cast only restores the
    // declared shape (as the reclaim route's does).
    const r = (await stub.heartbeat(runId.value, g.value, lease.value, now)) as unknown as HeartbeatAnswer;
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
    const r = await stub.finish(runId.value, g.value, parsed.value.record, parsed.value.proposal, parsed.value.point);
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
    const { storeKey, record, proposal, point } = parsed.value;
    // `turnedFinal` stays internal: the wire answer is exactly the shape it
    // always was, binding or no binding (run-metrics.md item 4).
    const { turnedFinal: _turnedFinal, ...result } = await stub(storeKey).put(record, proposal, point);
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
  if (pathname === "/runs/usage") {
    const parsed = parseRunUsageQuery(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { storeKey, sinceMs, untilMs } = parsed.value;
    const rows = await stub(storeKey).usage(sinceMs, untilMs);
    console.log(`[runs/usage] ${storeKey} -> ${rows.runs.length} runs, ${rows.pending} pending`);
    return json(rows);
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
  ...COSTS_ROUTES,
  "/retrieve",
  "/write",
  "/list",
  "/forget",
  "/sweep",
  "/schedules/record",
  "/schedules/latest",
  "/runs/put",
  "/runs/get",
  "/runs/summary",
  "/runs/list",
  "/runs/events",
  "/runs/usage",
  "/runs/delete",
  ...LEDGER_ROUTES,
  ...PLANE_ROUTES,
]);

/** The two decisions `fetch` makes once and hands down: is the path one of
 *  ours, and did the bearer check out. `handleRequest` answers from them in the
 *  order it always did (404, then 405, then 401) and never re-decides. */
interface Admission {
  known: boolean;
  authorized: boolean;
}

/** What this deploy carries, for the bot's boot probe: the fixed route set,
 *  plus `runMetrics:<dataset>` when the deploy bound the Analytics Engine
 *  dataset (run-metrics.md item 5) — the name from the `RUN_METRICS_DATASET`
 *  var rendered beside the binding, so the probe can compare it to the bot's. */
export function featuresOf(env: Pick<Env, "RUN_METRICS" | "RUN_METRICS_DATASET">): string[] {
  const features = ["memory", "schedules", "runs", "config", "delivery", "costs", "plane"];
  if (env.RUN_METRICS !== undefined) features.push(`runMetrics:${env.RUN_METRICS_DATASET ?? "unknown"}`);
  return features;
}

/** Every request, once `fetch` has decided whether it gets a root. */
async function handleRequest(request: Request, env: Env, admission: Admission): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz" && request.method === "GET")
    return json({ ok: true, build: BUILD, features: featuresOf(env) });
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
  if (url.pathname.startsWith("/plane/")) return handlePlane(url.pathname, body, env);
  if (url.pathname.startsWith("/config/")) return handleConfig(url.pathname, body, env);
  if (url.pathname.startsWith("/delivery/")) return handleDelivery(url.pathname, body, env);
  if (url.pathname.startsWith("/costs/")) return handleCosts(url.pathname, body, env);

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
    const { scopeKey, limit, query, kind } = parsed.value;
    const records = await env.MEMORY.get(env.MEMORY.idFromName(scopeKey)).list(scopeKey, limit, query, kind);
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
  if (url.pathname === "/sweep") {
    const parsed = parseSweep(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const { scopeKey, dryRun } = parsed.value;
    const out = await env.MEMORY.get(env.MEMORY.idFromName(scopeKey)).sweep(scopeKey, dryRun);
    // Observability: scope + count only (ids carry no record text; they ride
    // the dryRun answer, not the log).
    console.log(`[sweep] ${scopeKey} -> ${out.swept}${dryRun ? " (dry run)" : ""}`);
    return json({ ok: true, swept: out.swept, ...(dryRun ? { ids: out.ids } : {}) });
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
