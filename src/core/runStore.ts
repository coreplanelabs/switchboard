import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunEvent } from "./runEvents.js";
import {
  applyRetention,
  clampListLimit,
  clampRetentionPolicy,
  clone,
  DEFAULT_RETENTION_POLICY,
  isAfterCursor,
  isRunListItem,
  isRunRecord,
  newestFirst,
  normalizeStored,
  RUN_EVENTS_DEFAULT_PAGE,
  RUN_EVENTS_MAX_PAGE,
  RUN_ID_PATTERN,
  sameStoredVersion,
  storedEventSeqs,
  utf8ByteLength,
  type RetentionPolicy,
  type RunListItem,
  type RunListOptions,
  type RunRecord,
  type StoredRunEvent,
} from "./runRecord.js";
import { DEFAULT_RUN_STORE_TOKEN_ENV, RUN_STORE_KEY, WorkerRunStore } from "./runStoreWorker.js";

// Run history (#157, U2): the store seam behind every `runs.*` read and the
// dispatcher's write at run finish. Three implementations (AGENTS.md invariant
// 2): `InMemoryRunStore` (tests/dev), `FileRunStore` (an explicit opt-in that
// keeps `data/runs/<id>.json` files on the host disk — ephemeral on Cloudflare
// Containers), and `WorkerRunStore` (runStoreWorker.ts — the `RunHistoryDO` on
// the state Worker; the production choice, AGENTS.md invariant 6). Every
// implementation runs the ONE retention function from runRecord.ts, so a read
// on any side hides the same rows, and rejects an id failing `RUN_ID_PATTERN`
// before touching storage (R4): a bad id is not-found, never a path.

export interface PutResult {
  ok: true;
  /** Runs the store holds after this write. */
  retained: number;
  /** False when the record fell outside the retention policy in its own write. */
  stored: boolean;
  /** True when an existing record with this id was replaced by a different one. */
  rewritten: boolean;
}

export type { RunListOptions, StoredRunEvent };

export interface RunEventsOptions {
  /** Return events with `seq` strictly greater than this (default 0 = from the start). */
  afterSeq?: number;
  /** Default `RUN_EVENTS_DEFAULT_PAGE`, capped at `RUN_EVENTS_MAX_PAGE`. */
  limit?: number;
}

export interface RunEventsPage {
  events: StoredRunEvent[];
  /** Present when more events follow: pass it back as `afterSeq`. */
  nextAfterSeq?: number;
}

export interface RunStore {
  put(record: RunRecord): Promise<PutResult>;
  /** The record, or null when unknown, expired, or the id is malformed — one not-found shape (R4). */
  get(id: string): Promise<RunRecord | null>;
  /** The record WITHOUT its events (the listing row, `bytes` included) — the
   *  same not-found shape as `get`. The read for a caller that needs identity,
   *  status, or the diagnosis but not the event set (`RunsService.getRun`
   *  without `include`, `getRunFriction`, `stopRun`), so a 5000-event run is
   *  never loaded whole to answer them. */
  getSummary(id: string): Promise<RunListItem | null>;
  /** Newest first (`finishedAt` desc, `id` desc); never includes events. */
  list(opts: RunListOptions): Promise<RunListItem[]>;
  /** A page of a run's events, or null when the run is unknown, expired, or the
   *  id is malformed (the same not-found as `get`). An existing run with no
   *  events past `afterSeq` is `{ events: [] }`, never null. */
  events(id: string, opts: RunEventsOptions): Promise<RunEventsPage | null>;
  /** Remove a run and its events (the incident lever for a redaction miss). Unknown id is a no-op. */
  delete(id: string): Promise<void>;
}

/** How often every store implementation sweeps expired rows (KTD5). */
export const SWEEP_INTERVAL_MS = 6 * 3600_000;
/** Directory under the data dir holding `<id>.json` files and `index.jsonl`. */
export const RUNS_DIR = "runs";

export function isValidRunId(id: unknown): id is string {
  return typeof id === "string" && RUN_ID_PATTERN.test(id);
}

export function clampEventsLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return RUN_EVENTS_DEFAULT_PAGE;
  return Math.min(RUN_EVENTS_MAX_PAGE, Math.max(1, Math.floor(limit)));
}

/** The listing filters and cap, applied to an already-retained set. Shared by
 *  the in-memory and file stores; the Worker applies the same rules in SQL. */
export function selectListItems<T extends RunListItem>(items: readonly T[], opts: RunListOptions): T[] {
  let out = [...items].sort(newestFirst);
  if (opts.before !== undefined) out = out.filter((r) => isAfterCursor(r, opts.before!, opts.beforeId));
  if (opts.sinceMs !== undefined) out = out.filter((r) => r.finishedAt >= opts.sinceMs!);
  if (opts.agent !== undefined) out = out.filter((r) => r.agent === opts.agent);
  if (opts.channel !== undefined) out = out.filter((r) => r.channelId === opts.channel);
  return out.slice(0, clampListLimit(opts.limit));
}

/** A record's events with the `seq` each is stored under (`storedEventSeqs`). */
export function storedEvents(events: readonly RunEvent[]): StoredRunEvent[] {
  const seqs = storedEventSeqs(events);
  return events.map((e, i) => ({ ...e, seq: seqs[i] }));
}

/** Page a record's events: those with `seq > afterSeq`, in order, at most
 *  `limit`. Shared by the in-memory and file stores. */
export function pageEvents(events: readonly RunEvent[], opts: RunEventsOptions): RunEventsPage {
  const after = Math.max(0, Math.floor(opts.afterSeq ?? 0));
  const limit = clampEventsLimit(opts.limit);
  const rest = storedEvents(events).filter((e) => e.seq > after);
  const page = rest.slice(0, limit);
  const out: RunEventsPage = { events: page };
  if (page.length < rest.length && page.length > 0) out.nextAfterSeq = page[page.length - 1].seq;
  return out;
}

export function toListItem(record: RunRecord, bytes: number): RunListItem {
  const { events: _events, ...rest } = record;
  return { ...rest, bytes };
}

export interface LocalStoreOptions {
  policy?: Partial<RetentionPolicy>;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

/** In-process store for tests and dev. Not durable — never the production
 *  choice on its own (AGENTS.md invariant 6). */
export class InMemoryRunStore implements RunStore {
  private readonly records = new Map<string, { record: RunRecord; bytes: number }>();
  private readonly policy: RetentionPolicy;
  private readonly now: () => number;

  constructor(opts: LocalStoreOptions = {}) {
    this.policy = clampRetentionPolicy(opts.policy ?? {});
    this.now = opts.now ?? Date.now;
  }

  private items(): RunListItem[] {
    return [...this.records.values()].map(({ record, bytes }) => toListItem(record, bytes));
  }

  private retained(): RunListItem[] {
    return applyRetention(this.items(), this.policy, this.now());
  }

  async put(record: RunRecord): Promise<PutResult> {
    if (!isValidRunId(record.id)) return { ok: true, retained: this.records.size, stored: false, rewritten: false };
    const bytes = utf8ByteLength(JSON.stringify(record));
    const prev = this.records.get(record.id);
    const rewritten = prev !== undefined && !sameStoredVersion({ ...prev.record, bytes: prev.bytes }, { ...record, bytes });
    this.records.set(record.id, { record: clone(record), bytes });
    const kept = new Set(this.retained().map((r) => r.id));
    for (const id of [...this.records.keys()]) if (!kept.has(id)) this.records.delete(id);
    return { ok: true, retained: this.records.size, stored: kept.has(record.id), rewritten };
  }

  async get(id: string): Promise<RunRecord | null> {
    if (!isValidRunId(id)) return null;
    const entry = this.records.get(id);
    if (!entry || !this.retained().some((r) => r.id === id)) return null;
    return normalizeStored(clone(entry.record));
  }

  async getSummary(id: string): Promise<RunListItem | null> {
    if (!isValidRunId(id)) return null;
    const entry = this.records.get(id);
    if (!entry || !this.retained().some((r) => r.id === id)) return null;
    return normalizeStored(clone(toListItem(entry.record, entry.bytes)));
  }

  async list(opts: RunListOptions): Promise<RunListItem[]> {
    return selectListItems(this.retained(), opts).map((r) => normalizeStored(clone(r)));
  }

  async events(id: string, opts: RunEventsOptions): Promise<RunEventsPage | null> {
    const record = await this.get(id);
    return record ? pageEvents(record.events, opts) : null;
  }

  async delete(id: string): Promise<void> {
    if (!isValidRunId(id)) return;
    this.records.delete(id);
  }
}

// ---------------------------------------------------------------------------
// File (directory store)
// ---------------------------------------------------------------------------

const INDEX_FILE = "index.jsonl";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * A directory store: `<dir>/<id>.json` per run (written temp-then-rename, mode
 * 0600, in a 0700 directory) plus `<dir>/index.jsonl` of `RunListItem`s (with
 * `bytes`), so `list` never opens a record file and `get` opens exactly one.
 * Retention runs on every read (hidden) and on every write (files unlinked, the
 * index compacted); `sweep()` does the write-side work with no new record, and
 * `buildRunStore` runs it on start and every 6 h (KTD5). A torn record file is
 * absent from `list` (size ≠ the indexed `bytes`) and not-found from `get`
 * (unparsable or missing — `get` opens the one file instead of stat'ing them
 * all); an index line whose file is gone is hidden and dropped at the next
 * compaction. The same durability as `data/overrides.json` — a volume on
 * Fly/compose, ephemeral on Cloudflare Containers — hence an explicit opt-in.
 */
export class FileRunStore implements RunStore {
  private readonly dir: string;
  private readonly policy: RetentionPolicy;
  private readonly now: () => number;

  constructor(dir: string, opts: LocalStoreOptions = {}) {
    this.dir = resolve(dir);
    this.policy = clampRetentionPolicy(opts.policy ?? {});
    this.now = opts.now ?? Date.now;
  }

  private recordPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
    chmodSync(this.dir, DIR_MODE);
  }

  /** Atomic replace: write `<path>.tmp-<n>` with the file mode, then rename over.
   *  A chmod/rename failure removes the temp file so a failed write never leaves
   *  an orphan behind (the same discipline as `bootstrapCli.ts`). */
  private writeAtomic(path: string, content: string): void {
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, content, { mode: FILE_MODE });
    try {
      chmodSync(tmp, FILE_MODE);
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  /** Every valid index line, a repeated id resolved to its last line. */
  private readIndex(): RunListItem[] {
    const path = join(this.dir, INDEX_FILE);
    if (!existsSync(path)) return [];
    const byId = new Map<string, RunListItem>();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRunListItem(parsed)) byId.set(parsed.id, normalizeStored(parsed));
      } catch {
        // a torn or corrupt line: skip — the rest of the index still counts
      }
    }
    return [...byId.values()];
  }

  /** True when the record file is present and exactly as long as the index says. */
  private fileIntact(item: RunListItem): boolean {
    try {
      return statSync(this.recordPath(item.id)).size === item.bytes;
    } catch {
      return false;
    }
  }

  /** The index rows the policy keeps, newest first, only those whose file is intact. */
  private retainedIntact(): RunListItem[] {
    return applyRetention(this.readIndex(), this.policy, this.now()).filter((r) => this.fileIntact(r));
  }

  /** Write-side retention: unlink every record file outside policy or without a
   *  healthy file, and rewrite the index to exactly the kept rows. Returns the kept rows. */
  private compact(index: RunListItem[]): RunListItem[] {
    const kept = applyRetention(index, this.policy, this.now()).filter((r) => this.fileIntact(r));
    const keptIds = new Set(kept.map((r) => r.id));
    for (const item of index) if (!keptIds.has(item.id)) rmSync(this.recordPath(item.id), { force: true });
    this.writeAtomic(join(this.dir, INDEX_FILE), kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
    return kept;
  }

  async put(record: RunRecord): Promise<PutResult> {
    if (!isValidRunId(record.id)) return { ok: true, retained: this.readIndex().length, stored: false, rewritten: false };
    this.ensureDir();
    const content = JSON.stringify(record);
    const bytes = utf8ByteLength(content);
    const index = this.readIndex();
    const prev = index.find((r) => r.id === record.id);
    const rewritten = prev !== undefined && !sameStoredVersion(prev, { ...record, bytes });
    this.writeAtomic(this.recordPath(record.id), content);
    const item = toListItem(record, bytes);
    const kept = this.compact([...index.filter((r) => r.id !== record.id), item]);
    return { ok: true, retained: kept.length, stored: kept.some((r) => r.id === record.id), rewritten };
  }

  /** Retention is decided from the index alone (no per-file stat); the one
   *  file that matters is then read directly — a torn or missing file lands
   *  in the catch below, so nothing is stat'd that will not be opened. */
  async get(id: string): Promise<RunRecord | null> {
    if (!isValidRunId(id)) return null;
    if (!applyRetention(this.readIndex(), this.policy, this.now()).some((r) => r.id === id)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.recordPath(id), "utf8"));
      return isRunRecord(parsed) && parsed.id === id ? normalizeStored(parsed) : null;
    } catch {
      return null; // torn or unreadable: not-found, healed at the next write
    }
  }

  /** The index row IS the summary: no record file is opened. Hidden like `list`
   *  hides it — outside policy, or a file whose size differs from the indexed
   *  `bytes` (torn) — so `getSummary` and `list` always agree row for row. */
  async getSummary(id: string): Promise<RunListItem | null> {
    if (!isValidRunId(id)) return null;
    const row = this.retainedIntact().find((r) => r.id === id);
    return row ? normalizeStored(row) : null;
  }

  async list(opts: RunListOptions): Promise<RunListItem[]> {
    return selectListItems(this.retainedIntact(), opts);
  }

  async events(id: string, opts: RunEventsOptions): Promise<RunEventsPage | null> {
    const record = await this.get(id);
    return record ? pageEvents(record.events, opts) : null;
  }

  async delete(id: string): Promise<void> {
    if (!isValidRunId(id)) return;
    const index = this.readIndex();
    if (!index.some((r) => r.id === id) && !existsSync(this.recordPath(id))) return;
    this.ensureDir();
    rmSync(this.recordPath(id), { force: true });
    this.compact(index.filter((r) => r.id !== id));
  }

  /** Delete everything outside policy now (start-up and the 6 h timer). A
   *  missing directory means nothing to sweep. */
  sweep(): void {
    if (!existsSync(this.dir)) return;
    this.compact(this.readIndex());
  }
}

// ---------------------------------------------------------------------------
// Config + startup selection
// ---------------------------------------------------------------------------

/** The `runHistory` config section (KTD14). Absent → history is OFF (live-only). */
export interface RunHistoryConfig {
  /** Days a finished run stays readable. Default 30, clamped to [1, 365]. */
  retentionDays?: number;
  /** Newest runs kept. Default 5000, clamped to [1, 20000]. */
  maxRuns?: number;
  /** Total stored bytes kept. Default 2 GiB, clamped to [16 MiB, 8 GiB]. */
  maxBytes?: number;
  /** Include the thread-context turns fed to the model in the run stream — the
   *  live page and the persisted record alike (the dispatcher publishes them as
   *  `context` message events). Default true. */
  includeContext?: boolean;
  /** `worker` (default when `worker` is set) or `file` — an explicit host-disk opt-in. */
  store?: "worker" | "file";
  /** The `RunHistoryDO` on the state Worker (deploy/cloudflare-memory/). */
  worker?: {
    /** Base URL, must be https:, e.g. https://switchboard-memory.coreplanelabs.dev */
    baseUrl: string;
    /** Env var holding the bearer secret. Default MEMORY_TOKEN. */
    tokenEnv?: string;
  };
}

export function retentionPolicyOf(cfg: RunHistoryConfig): RetentionPolicy {
  return clampRetentionPolicy({ retentionDays: cfg.retentionDays, maxRuns: cfg.maxRuns, maxBytes: cfg.maxBytes });
}

export interface BuildRunStoreDeps {
  dataDir: string;
  warn: (message: string) => void;
  /** Injectable clock (epoch ms); also stamps `policyUpdatedAt` for the Worker store. */
  now?: () => number;
  /** Injectable timer for the file store's 6 h sweep. */
  setInterval?: typeof setInterval;
}

/**
 * Process-startup store selection (src/index.ts). Pure w.r.t. the environment.
 * - no `runHistory` section → null: history is off, runs stay live-only.
 * - `store: "file"` → `FileRunStore` under `<dataDir>/runs`, swept now and every 6 h (timer unref'd).
 * - otherwise a `worker` whose bearer is present → `WorkerRunStore` keyed `runs:default`,
 *   proposing the configured policy stamped with the current time.
 * - a `worker` without its bearer → null with a warning naming the env var
 *   (history off rather than a silent host-disk fallback: the file store is an opt-in).
 */
export function buildRunStore(cfg: RunHistoryConfig | undefined, env: Record<string, string | undefined>, deps: BuildRunStoreDeps): RunStore | null {
  if (!cfg) return null;
  const now = deps.now ?? Date.now;
  const policy = retentionPolicyOf(cfg);
  if (cfg.store === "file") {
    const store = new FileRunStore(join(deps.dataDir, RUNS_DIR), { policy, now });
    store.sweep();
    const timer = (deps.setInterval ?? setInterval)(() => store.sweep(), SWEEP_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
    return store;
  }
  const worker = cfg.worker;
  if (!worker?.baseUrl) {
    deps.warn("runHistory is configured without runHistory.worker.baseUrl (or store: file) — run history is off.");
    return null;
  }
  const tokenEnv = worker.tokenEnv ?? DEFAULT_RUN_STORE_TOKEN_ENV;
  const token = env[tokenEnv]?.trim();
  if (!token) {
    deps.warn(`runHistory.worker is configured but ${tokenEnv} is unset — run history is off. Set ${tokenEnv} to the state Worker's bearer.`);
    return null;
  }
  return new WorkerRunStore({ baseUrl: worker.baseUrl, token, storeKey: RUN_STORE_KEY, policy, policyUpdatedAt: now() });
}

export { DEFAULT_RETENTION_POLICY };
