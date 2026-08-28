import type { MemoryCandidate, MemoryConfig, MemoryQuery, MemoryRecord, MemoryStore } from "./types.js";
import { mintRecord, planWrite, rankRecords } from "./engine.js";

// Three implementations of the MemoryStore seam (AGENTS.md invariant 2): the
// disabled `NullMemoryStore`, the in-process `InMemoryMemoryStore` (tests/dev),
// and the durable `WorkerMemoryStore` (workerStore.ts) — an HTTPS client to
// the Memory Worker in deploy/cloudflare-memory/. The ranking and write rules
// live in engine.ts and are shared by the in-process store and the Worker's
// Durable Object, so the two durable/non-durable paths cannot drift.

/** No-op store: `retrieve` always returns [], `write` does nothing. This is the
 *  default when memory is disabled — the mechanism that guarantees zero behavior
 *  change (the injected block is only ever built from `retrieve`'s output, so an
 *  always-empty result means the model input is byte-identical to memory-off). */
export class NullMemoryStore implements MemoryStore {
  async retrieve(_q: MemoryQuery): Promise<MemoryRecord[]> {
    return [];
  }
  async write(_scopeKey: string, _records: MemoryCandidate[]): Promise<void> {
    // intentionally nothing
  }
}

/** In-memory store: a `Map<scopeKey, MemoryRecord[]>` driven by the shared
 *  engine (rank + write plan). Serves tests and dev; a fresh instance is empty,
 *  and in-process state is never treated as durable (AGENTS.md invariant 6 —
 *  the durable path is `WorkerMemoryStore`). */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly byScope = new Map<string, MemoryRecord[]>();
  private readonly now: () => number;
  private seq = 0;

  constructor(seed: MemoryRecord[] = [], opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    for (const r of seed) this.list(r.scopeKey).push(r);
  }

  private list(scopeKey: string): MemoryRecord[] {
    let list = this.byScope.get(scopeKey);
    if (!list) {
      list = [];
      this.byScope.set(scopeKey, list);
    }
    return list;
  }

  async retrieve(q: MemoryQuery): Promise<MemoryRecord[]> {
    const now = this.now();
    const ranked = rankRecords(this.list(q.scopeKey), q.query, now, q.limit);
    // Retrieval bumps recency/usage (feeds the decay term next time).
    for (const r of ranked) {
      r.lastUsedAt = now;
      r.useCount += 1;
    }
    return ranked;
  }

  async write(scopeKey: string, records: MemoryCandidate[]): Promise<void> {
    const list = this.list(scopeKey);
    const now = this.now();
    for (const cand of records) {
      const plan = planWrite(list, cand, (c) => mintRecord(scopeKey, this.seq++, now, c));
      if (plan.action === "dedup") {
        plan.target.useCount += 1;
        continue;
      }
      // Soft delete the contradicted record (status flip, never a removal —
      // provenance stays auditable).
      if (plan.supersede) plan.supersede.status = "superseded";
      list.push(plan.record);
    }
  }
}

/** Pick the store for a dispatch: `NullMemoryStore` when memory is disabled (the
 *  zero-behavior-change default), else the injected store (the durable
 *  `WorkerMemoryStore` in production), falling back to a fresh
 *  `InMemoryMemoryStore` for dev/tests when nothing is injected. */
export function selectMemoryStore(cfg: MemoryConfig | undefined, injected?: MemoryStore): MemoryStore {
  if (!cfg?.enabled) return new NullMemoryStore();
  return injected ?? new InMemoryMemoryStore();
}
