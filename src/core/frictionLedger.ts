import type { Predicate } from "./authz/types.js";
import { isFrictionRunRecord, type FrictionRunRecord } from "./frictionProposals.js";
import {
  clone,
  RUN_LIST_MAX_LIMIT,
  toVisibilityFilter,
  type RunListItem,
  type RunVisibilityFilter,
} from "./runRecord.js";
import type { RunStore } from "./runStore.js";

export { isFrictionRunRecord };

// The friction ledger (Area 7b / #84): where each finished run's diagnosis is
// read from so the proposer can look ACROSS runs. The live run registry evicts
// a finished run 60s after it ends; run history (features/run-history.md) is
// where every finished run's record — diagnosis included — lands, so the
// ledger is a READ over the run store (`RunStoreFrictionLedger`): one
// population for the dashboard and the self-improvement loop, nothing written
// twice. A record holds only what the runs index and the analyzer already
// expose: run id (not the view token), label, agent, and the redacted-at-source
// diagnosis. `InMemoryFrictionLedger` is the test double.

export interface LedgerReadOptions {
  /** Keep only the NEWEST n runs. */
  limit?: number;
  /** Keep only runs finished at or after this epoch ms. */
  sinceMs?: number;
  /** What the ACTOR may see: `predicateFor(actor, "runs:read", "run")`
   *  (authorization.md item 6 — `friction report` computes over the runs its
   *  caller can read, OQ2). A `FrictionRunRecord` carries no channel, user, or
   *  visibility by design, so only a ledger that reads the run store can apply
   *  a real predicate; a ledger of bare records (the in-memory test double)
   *  answers only a predicate that admits EVERYTHING (`all`) and contributes
   *  NOTHING under any other — fail closed, never a run the actor may not see.
   *  Absent = the caller already decided (a test, the dispatcher's own
   *  bookkeeping): everything. */
  visibleTo?: Predicate;
}

/** Whether a predicate lets bare records (no channel to check) through. */
function admitsEverything(visibleTo: Predicate | undefined): boolean {
  return visibleTo === undefined || visibleTo.kind === "all";
}

/** Recent finished runs with their friction diagnosis — what `friction report`
 *  / `friction propose` cluster over. Read-only: the write path is run history. */
export interface FrictionLedger {
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

/** The in-process test double: a ledger seeded by `record()` — the seam's
 *  ordering and trimming rules over bare records, with nothing durable behind
 *  it. Never a production choice (AGENTS.md invariant 6): production reads run
 *  history. */
export class InMemoryFrictionLedger implements FrictionLedger {
  private readonly records: FrictionRunRecord[] = [];
  private readonly max: number;

  constructor(opts: LedgerOptions = {}) {
    this.max = opts.max ?? DEFAULT_LEDGER_MAX;
  }

  /** Seed one run; upsert by run id, so a repeated seed replaces, never double-counts. */
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
 * down to the newest `limit ?? DEFAULT_LEDGER_MAX` runs, then orders and
 * trims exactly like the in-memory ledger so consumers see one shape. A run
 * store that cannot be read rejects — the friction command reports the cause.
 * This class never writes: the dispatcher's history write path does.
 */
export class RunStoreFrictionLedger implements FrictionLedger {
  constructor(private readonly store: RunStore) {}

  async recent(opts: LedgerReadOptions = {}): Promise<FrictionRunRecord[]> {
    const max = Math.max(0, opts.limit ?? DEFAULT_LEDGER_MAX);
    // The run store applies the predicate itself (its rows carry the channel
    // and visibility a predicate checks); the final trim then sees rows that
    // already match. `none` reads nothing at all.
    const { visibleTo, ...trim } = opts;
    if (visibleTo?.kind === "none") return [];
    const filter = visibleTo !== undefined && visibleTo.kind !== "all" ? toVisibilityFilter(visibleTo) : undefined;
    const items = await this.newest(max, opts.sinceMs, filter);
    return sortAndTrim(items.map(projectFrictionRecord), max, trim);
  }

  /** The newest `max` runs, newest first, paging by the `{ before, beforeId }`
   *  cursor (the last row's `finishedAt` + `id`, so same-millisecond siblings
   *  are not skipped) since one `list` call returns at most RUN_LIST_MAX_LIMIT rows. */
  private async newest(
    max: number,
    sinceMs: number | undefined,
    visibleTo: RunVisibilityFilter | undefined,
  ): Promise<RunListItem[]> {
    const out: RunListItem[] = [];
    let cursor: { before: number; beforeId: string } | undefined;
    while (out.length < max) {
      const page = await this.store.list({
        limit: max - out.length,
        ...cursor,
        sinceMs,
        ...(visibleTo !== undefined ? { visibleTo } : {}),
      });
      out.push(...page);
      if (page.length < Math.min(RUN_LIST_MAX_LIMIT, max - out.length + page.length)) break;
      const last = page[page.length - 1];
      cursor = { before: last.finishedAt, beforeId: last.id };
    }
    return out;
  }
}

/** The ledger of a process without run history (a Null Object, routing-and-
 *  config item 16): there are no recent runs anywhere, so nothing recurs. */
export class NullFrictionLedger implements FrictionLedger {
  async recent(_opts?: LedgerReadOptions): Promise<FrictionRunRecord[]> {
    return [];
  }
}

/** Startup wiring: the ledger is the run store; without one there are no
 *  recent runs anywhere and the null ledger says so with an empty answer. */
export function selectFrictionLedger(store: RunStore | null): FrictionLedger {
  return store ? new RunStoreFrictionLedger(store) : new NullFrictionLedger();
}
