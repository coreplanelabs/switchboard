import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Predicate } from "./authz/types.js";
import { isFrictionRunRecord, type FrictionRunRecord } from "./frictionProposals.js";
import { clone, RUN_LIST_MAX_LIMIT, toVisibilityFilter, type RunListItem, type RunVisibilityFilter } from "./runRecord.js";
import type { RunStore } from "./runStore.js";

export { isFrictionRunRecord };

// The friction ledger (Area 7b / #84): where each finished run's diagnosis is
// kept so the proposer can look ACROSS runs. The live run registry evicts a
// finished run 60s after it ends, so without this the "recent runs" the
// self-improvement loop needs do not exist anywhere. Three implementations
// (AGENTS.md invariant 2): in-memory (tests, dev), an append-only JSONL file
// under data/ (the same place and durability as data/overrides.json — a volume
// on Fly/compose, ephemeral on Cloudflare Containers), and the durable
// `WorkerFrictionLedger` (frictionLedgerWorker.ts — a Durable Object on the
// state Worker; the production choice, AGENTS.md invariant 6). A record holds
// only what the runs index and the analyzer already expose: run id (not the
// view token), label, agent, and the redacted-at-source diagnosis.

export interface LedgerReadOptions {
  /** Keep only the NEWEST n runs. */
  limit?: number;
  /** Keep only runs finished at or after this epoch ms. */
  sinceMs?: number;
  /** What the ACTOR may see: `predicateFor(actor, "runs:read", "run")`
   *  (authorization.md item 6 — `friction report` computes over the runs its
   *  caller can read, OQ2). A `FrictionRunRecord` carries no channel, user, or
   *  visibility by design, so only a ledger that reads the run store can apply
   *  a real predicate; a ledger of bare records (in-memory, file, legacy
   *  FrictionDO rows) answers only a predicate that admits EVERYTHING (`all`)
   *  and contributes NOTHING under any other — fail closed, never a run the
   *  actor may not see. Absent = the caller already decided (a test, the
   *  dispatcher's own bookkeeping): everything. */
  visibleTo?: Predicate;
}

/** Whether a predicate lets bare records (no channel to check) through. */
function admitsEverything(visibleTo: Predicate | undefined): boolean {
  return visibleTo === undefined || visibleTo.kind === "all";
}

export interface FrictionLedger {
  /** Append one finished run. Never throws into a run — callers treat it as best-effort. */
  record(rec: FrictionRunRecord): Promise<void>;
  /** Retained runs, oldest first, filtered by `opts`. Always copies. */
  recent(opts?: LedgerReadOptions): Promise<FrictionRunRecord[]>;
}

export interface LedgerOptions {
  /** Max runs retained; the oldest fall off. Default 500. */
  max?: number;
}

export const DEFAULT_LEDGER_MAX = 500;

function sortAndTrim(records: FrictionRunRecord[], max: number, opts: LedgerReadOptions): FrictionRunRecord[] {
  if (!admitsEverything(opts.visibleTo)) return []; // bare records carry no channel: nothing can be shown to match
  let out = [...records].sort((a, b) => a.finishedAt - b.finishedAt || a.runId.localeCompare(b.runId)).slice(-max);
  if (opts.sinceMs !== undefined) out = out.filter((r) => r.finishedAt >= opts.sinceMs!);
  if (opts.limit !== undefined) out = out.slice(-Math.max(0, opts.limit));
  return out.map(clone);
}

/** In-process ledger for tests and dev. Not durable — never the production
 *  choice on its own (AGENTS.md invariant 6). */
export class InMemoryFrictionLedger implements FrictionLedger {
  private readonly records: FrictionRunRecord[] = [];
  private readonly max: number;

  constructor(opts: LedgerOptions = {}) {
    this.max = opts.max ?? DEFAULT_LEDGER_MAX;
  }

  /** Upsert by run id: a retried write replaces, never double-counts. */
  async record(rec: FrictionRunRecord): Promise<void> {
    const i = this.records.findIndex((r) => r.runId === rec.runId);
    if (i !== -1) this.records.splice(i, 1);
    this.records.push(clone(rec));
    this.records.sort((a, b) => a.finishedAt - b.finishedAt || a.runId.localeCompare(b.runId));
    if (this.records.length > this.max) this.records.splice(0, this.records.length - this.max);
  }

  async recent(opts: LedgerReadOptions = {}): Promise<FrictionRunRecord[]> {
    return sortAndTrim(this.records, this.max, opts);
  }
}

/** Append-only JSON-lines file, one record per line. Reads tolerate corrupt or
 *  foreign lines (skipped). Compacts to the newest `max` once the file holds
 *  2×`max` lines, so the on-disk size stays bounded without rewriting per run. */
export class FileFrictionLedger implements FrictionLedger {
  private readonly path: string;
  private readonly max: number;
  /** Lines in the file as of the last read/compaction; lazily initialized. */
  private lineCount: number | undefined;

  constructor(path: string, opts: LedgerOptions = {}) {
    this.path = resolve(path);
    this.max = opts.max ?? DEFAULT_LEDGER_MAX;
  }

  async record(rec: FrictionRunRecord): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`);
    this.lineCount = (this.lineCount ?? this.countLines()) + 1;
    if (this.lineCount > this.max * 2) this.compact();
  }

  async recent(opts: LedgerReadOptions = {}): Promise<FrictionRunRecord[]> {
    return sortAndTrim(this.readAll(), this.max, opts);
  }

  /** Every valid line, with a repeated run id resolved to its LAST line — the
   *  append-only file's form of upsert (a retried write never double-counts);
   *  compaction then materializes the dedup. */
  private readAll(): FrictionRunRecord[] {
    if (!existsSync(this.path)) return [];
    const byRun = new Map<string, FrictionRunRecord>();
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isFrictionRunRecord(parsed)) {
          byRun.delete(parsed.runId); // re-insert so the newest write wins on ties
          byRun.set(parsed.runId, parsed);
        }
      } catch {
        // a torn or corrupt line: skip — the rest of the ledger still counts
      }
    }
    return [...byRun.values()];
  }

  private countLines(): number {
    if (!existsSync(this.path)) return 0;
    return readFileSync(this.path, "utf8").split("\n").filter((l) => l.trim()).length;
  }

  private compact(): void {
    const keep = sortAndTrim(this.readAll(), this.max, {});
    writeFileSync(this.path, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));
    this.lineCount = keep.length;
  }
}

// ---------------------------------------------------------------------------
// Served from the run store (#157, KD3 / KTD12)
// ---------------------------------------------------------------------------

/** The ONLY fields a run-store row contributes to a friction record: the same
 *  five the dispatcher has always written — message text and platform ids
 *  never reach a `FrictionRunRecord` or an issue body. */
export function projectFrictionRecord(item: RunListItem): FrictionRunRecord {
  const out: FrictionRunRecord = { runId: item.id, finishedAt: item.finishedAt, diagnosis: item.diagnosis };
  if (item.label !== undefined) out.label = item.label;
  if (item.agent !== undefined) out.agent = item.agent;
  return out;
}

/**
 * The friction ledger READ from the run store (KD3): one population for the
 * dashboard and the self-improvement loop. `recent()` pages `store.list`
 * (never `get` — listings carry the diagnosis, so no event stream is loaded)
 * down to the newest `limit ?? DEFAULT_LEDGER_MAX` runs, unions the legacy
 * ledger's rows for the rollout window (deduped by run id, run-store row wins),
 * then orders and trims exactly like the file/in-memory ledgers so consumers
 * see no change. The two sources are read independently: one failing half is
 * warned about once (per read) and the other half is still served; only when
 * BOTH fail does `recent()` reject, with the run store's error. `record()`
 * still forwards to the legacy ledger — FrictionDO keeps receiving its small
 * diagnosis write until the deferred decommission (KD3 call-out) — and is a
 * no-op without one; this class never writes the run store (the dispatcher's
 * history write path does).
 */
export class RunStoreFrictionLedger implements FrictionLedger {
  constructor(
    private readonly store: RunStore,
    private readonly legacy?: FrictionLedger,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
  ) {}

  async record(rec: FrictionRunRecord): Promise<void> {
    if (this.legacy) await this.legacy.record(rec);
  }

  async recent(opts: LedgerReadOptions = {}): Promise<FrictionRunRecord[]> {
    const max = Math.max(0, opts.limit ?? DEFAULT_LEDGER_MAX);
    // Under a predicate that does not admit everything the legacy rows are
    // skipped outright (they carry nothing a predicate could check — see
    // LedgerReadOptions.visibleTo) and the run store applies the predicate
    // itself; the final trim then sees rows that already match. `none` reads
    // nothing at all.
    const { visibleTo, ...trim } = opts;
    if (visibleTo?.kind === "none") return [];
    const filter = visibleTo !== undefined && visibleTo.kind !== "all" ? toVisibilityFilter(visibleTo) : undefined;
    const [legacyRes, storeRes] = await Promise.allSettled([
      this.legacy && admitsEverything(visibleTo) ? this.legacy.recent(opts) : [],
      this.newest(max, opts.sinceMs, filter),
    ]);
    if (storeRes.status === "rejected" && legacyRes.status === "rejected") throw storeRes.reason;
    const describe = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
    if (legacyRes.status === "rejected") this.warn(`[friction] legacy ledger read failed; serving run-store rows only: ${describe(legacyRes.reason)}`);
    if (storeRes.status === "rejected") this.warn(`[friction] run store read failed; serving legacy ledger rows only: ${describe(storeRes.reason)}`);
    const byRun = new Map<string, FrictionRunRecord>();
    if (legacyRes.status === "fulfilled") for (const r of legacyRes.value) byRun.set(r.runId, r);
    if (storeRes.status === "fulfilled") for (const item of storeRes.value) byRun.set(item.id, projectFrictionRecord(item));
    return sortAndTrim([...byRun.values()], max, trim);
  }

  /** The newest `max` runs, newest first, paging by the `{ before, beforeId }`
   *  cursor (the last row's `finishedAt` + `id`, so same-millisecond siblings
   *  are not skipped) since one `list` call returns at most RUN_LIST_MAX_LIMIT rows. */
  private async newest(max: number, sinceMs: number | undefined, visibleTo: RunVisibilityFilter | undefined): Promise<RunListItem[]> {
    const out: RunListItem[] = [];
    let cursor: { before: number; beforeId: string } | undefined;
    while (out.length < max) {
      const page = await this.store.list({ limit: max - out.length, ...cursor, sinceMs, ...(visibleTo !== undefined ? { visibleTo } : {}) });
      out.push(...page);
      if (page.length < Math.min(RUN_LIST_MAX_LIMIT, max - out.length + page.length)) break;
      const last = page[page.length - 1];
      cursor = { before: last.finishedAt, beforeId: last.id };
    }
    return out;
  }
}

/** Startup wiring: with a run store the ledger is served from it (legacy rows
 *  unioned); without one the legacy ledger is used unchanged. */
export function selectFrictionLedger(store: RunStore | null, legacy: FrictionLedger, warn?: (message: string) => void): FrictionLedger {
  return store ? new RunStoreFrictionLedger(store, legacy, warn) : legacy;
}
