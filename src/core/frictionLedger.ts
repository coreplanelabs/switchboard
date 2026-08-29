import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FrictionRunRecord } from "./frictionProposals.js";
import { FRICTION_CATEGORIES } from "./runFriction.js";

// The friction ledger (Area 7b / #84): where each finished run's diagnosis is
// kept so the proposer can look ACROSS runs. The live run registry evicts a
// finished run 60s after it ends, so without this the "recent runs" the
// self-improvement loop needs do not exist anywhere. Two implementations
// (AGENTS.md invariant 2): in-memory (tests, dev) and an append-only JSONL file
// under data/ — the same place and the same durability as data/overrides.json
// (a volume on Fly/compose; on Cloudflare Containers the disk is ephemeral, so a
// redeploy starts the ledger over — stated in features/self-improvement.md, and
// index.ts logs the path at startup so the loss is never silent). A record
// holds only what the runs index and the analyzer already expose: run id (not
// the view token), label, agent, and the redacted-at-source diagnosis.

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

/** Structural check on a record read from disk (or a CLI input file): only the
 *  fields the clusterer relies on. A foreign or truncated line is skipped, never
 *  a crash. */
export function isFrictionRunRecord(v: unknown): v is FrictionRunRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.runId !== "string" || typeof r.finishedAt !== "number" || !Number.isFinite(r.finishedAt)) return false;
  if (r.label !== undefined && typeof r.label !== "string") return false;
  if (r.agent !== undefined && typeof r.agent !== "string") return false;
  return isDiagnosis(r.diagnosis);
}

function isDiagnosis(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  if (!Array.isArray(d.findings) || typeof d.eventCount !== "number" || typeof d.verdict !== "string") return false;
  if (typeof d.byCategory !== "object" || d.byCategory === null) return false;
  if (d.runMs !== undefined && typeof d.runMs !== "number") return false;
  return FRICTION_CATEGORIES.every((c) => typeof (d.byCategory as Record<string, unknown>)[c] === "object");
}

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

  async record(rec: FrictionRunRecord): Promise<void> {
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

  private readAll(): FrictionRunRecord[] {
    if (!existsSync(this.path)) return [];
    const out: FrictionRunRecord[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isFrictionRunRecord(parsed)) out.push(parsed);
      } catch {
        // a torn or corrupt line: skip — the rest of the ledger still counts
      }
    }
    return out;
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
