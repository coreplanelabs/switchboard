import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isFrictionRunRecord, type FrictionRunRecord } from "./frictionProposals.js";

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
  let out = [...records].sort((a, b) => a.finishedAt - b.finishedAt || a.runId.localeCompare(b.runId)).slice(-max);
  if (opts.sinceMs !== undefined) out = out.filter((r) => r.finishedAt >= opts.sinceMs!);
  if (opts.limit !== undefined) out = out.slice(-Math.max(0, opts.limit));
  return out.map(clone);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
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
