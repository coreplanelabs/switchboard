import type { MemoryCandidate, MemoryConfig, MemoryQuery, MemoryRecord, MemoryStore } from "./types.js";
import { keywordMatch, scoreRecord, tokenize } from "./scorer.js";

// Two implementations of the MemoryStore seam (AGENTS.md invariant 2). The
// durable WorkerMemoryStore (DO + SQLite FTS5) is PR3, behind this same
// interface — the core never changes.

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

/** Normalized text key for write-time dedup (trim + lowercase + collapse
 *  internal whitespace). */
function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** In-memory store: a `Map<scopeKey, MemoryRecord[]>` with whole-word keyword +
 *  recency ranking and dedup/supersede on write. Serves tests and dev; a fresh
 *  instance is empty, and in-process state is never treated as durable (AGENTS.md
 *  invariant 6 — the durable path is PR3). */
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
    const ranked = this.list(q.scopeKey)
      .filter((r) => r.status === "active" && keywordMatch(r, q.query) > 0)
      .map((r) => ({ r, score: scoreRecord(r, q.query, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, q.limit)
      .map(({ r }) => r);
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
      const norm = normalizeText(cand.text);
      // Supersede target: only an ACTIVE record in THIS scope; an unknown/foreign
      // id supersedes nothing and the new record still lands.
      const target = cand.supersedes
        ? list.find((r) => r.status === "active" && r.id === cand.supersedes)
        : undefined;
      // Dedup: a restatement of an existing active fact bumps usage instead of
      // inserting. A candidate carrying `supersedes` is an explicit correction
      // and dedups ONLY against its own target (none when the id doesn't
      // resolve — e.g. two facts in one batch correcting the same record) — a
      // text collision with some UNRELATED record must never swallow it (the
      // extractor sees existing text verbatim, so a collision can be induced
      // by a poisoned transcript).
      const dedupPool = cand.supersedes ? (target ? [target] : []) : list.filter((r) => r.status === "active");
      const existing = dedupPool.find((r) => normalizeText(r.text) === norm);
      if (existing) {
        existing.useCount += 1;
        continue;
      }
      // Soft delete the contradicted record (status flip, never a removal —
      // provenance stays auditable).
      if (target) target.status = "superseded";
      list.push({
        id: `mem:${scopeKey}:${this.seq++}`,
        scopeKey,
        kind: cand.kind,
        text: cand.text,
        keywords: cand.keywords ?? tokenize(cand.text),
        sourceThreadKey: cand.sourceThreadKey,
        sourceRunId: cand.sourceRunId,
        createdAt: now,
        useCount: 0,
        confidence: cand.confidence,
        supersedes: cand.supersedes,
        status: "active",
      });
    }
  }
}

/** Pick the store for a dispatch: `NullMemoryStore` when memory is disabled (the
 *  zero-behavior-change default), else the injected store (PR3's durable
 *  `WorkerMemoryStore`), falling back to a fresh `InMemoryMemoryStore` for
 *  dev/tests when nothing is injected. */
export function selectMemoryStore(cfg: MemoryConfig | undefined, injected?: MemoryStore): MemoryStore {
  if (!cfg?.enabled) return new NullMemoryStore();
  return injected ?? new InMemoryMemoryStore();
}
