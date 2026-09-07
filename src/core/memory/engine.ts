import type { MemoryCandidate, MemoryRecord } from "./types.js";
import { keywordMatch, scoreRecord, tokenize } from "./scorer.js";

// The store-agnostic memory algorithms: retrieval ranking and the write plan
// (dedup / supersede). Pure functions over plain records, no I/O and no clock
// of their own, so BOTH MemoryStore implementations — the in-process
// `InMemoryMemoryStore` and the Durable Object behind `WorkerMemoryStore`
// (deploy/cloudflare-memory/worker.ts imports this file by relative path and
// bundles it) — run the exact same rules from one source. A store only owns
// persistence: fetching the active rows of a scope and applying the plan.

/** Normalized text key for write-time dedup (trim + lowercase + collapse
 *  internal whitespace). Stored alongside the text by durable backends so the
 *  dedup lookup is an index hit, not a scan. */
export function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Rank a scope's ACTIVE records for a query: relevance-gated (a record the
 *  query does not touch is dropped), scored by the pure scorer, best first,
 *  cut at `limit`. Does NOT bump usage — the caller persists that. */
export function rankRecords(active: MemoryRecord[], query: string, now: number, limit: number): MemoryRecord[] {
  // The query (up to ~4k chars) is tokenized ONCE here, not once per record per
  // pass: the Memory Worker runs this over its FTS candidate pool (up to
  // max(50, 5×limit) bm25-ordered rows, #356) on a single Durable Object
  // thread, and each record's match is computed exactly once — the relevance
  // gate and the score share it.
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const scored: Array<{ r: MemoryRecord; score: number }> = [];
  for (const r of active) {
    if (r.status !== "active") continue;
    const match = keywordMatch(r, queryTokens);
    if (match <= 0) continue;
    scored.push({ r, score: scoreRecord(r, queryTokens, now) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ r }) => r);
}

/** Default per-scope cap on ACTIVE records (#253) when config does not set one. */
export const DEFAULT_SCOPE_CAP = 500;

/** Per-scope cap (#253): which ACTIVE records a store must evict so that at
 *  most `cap` remain — the least recently USED first (`lastUsedAt ??
 *  createdAt` ascending; ties broken by lower `createdAt`, so the older record
 *  goes first), exactly `active.length - cap` of them, none at or under the
 *  cap. Non-active rows are ignored (they neither count nor get evicted).
 *  Pure: the caller flips status (soft delete — provenance stays). */
export function planEviction(active: MemoryRecord[], cap: number): MemoryRecord[] {
  const live = active.filter((r) => r.status === "active");
  const excess = live.length - cap;
  if (excess <= 0) return [];
  return live
    .slice()
    .sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt) || a.createdAt - b.createdAt)
    .slice(0, excess);
}

/** What a store must do for one candidate. `dedup`: bump `target.useCount`,
 *  insert nothing. `insert`: append `record` (already minted) and, when
 *  `supersede` is set, flip that record to `superseded`. */
export type WritePlan =
  { action: "dedup"; target: MemoryRecord } | { action: "insert"; record: MemoryRecord; supersede?: MemoryRecord };

/**
 * Decide how one candidate lands among a scope's ACTIVE records (features/
 * memory.md §8):
 * - **Supersede target** = the active same-scope record whose id equals
 *   `cand.supersedes`; an unknown/foreign id resolves to nothing (the new
 *   record still lands, superseding nothing).
 * - **Dedup**: a candidate WITHOUT `supersedes` dedups against every active
 *   record (normalized-text equality → bump, no insert). A candidate WITH
 *   `supersedes` is an explicit correction and dedups ONLY against its own
 *   target — and against nothing when the id doesn't resolve — so a text
 *   collision with an unrelated record can never swallow the correction (the
 *   extractor sees existing text verbatim; a poisoned transcript could induce
 *   such a collision to keep a stale record alive).
 * - Otherwise **insert** the minted record (`mint` assigns id/timestamps),
 *   soft-deleting the target if there is one.
 */
export function planWrite(
  active: MemoryRecord[],
  cand: MemoryCandidate,
  mint: (cand: MemoryCandidate) => MemoryRecord,
): WritePlan {
  const norm = normalizeText(cand.text);
  const target = cand.supersedes ? active.find((r) => r.status === "active" && r.id === cand.supersedes) : undefined;
  const dedupPool = cand.supersedes ? (target ? [target] : []) : active.filter((r) => r.status === "active");
  const existing = dedupPool.find((r) => normalizeText(r.text) === norm);
  if (existing) return { action: "dedup", target: existing };
  return { action: "insert", record: mint(cand), ...(target ? { supersede: target } : {}) };
}

/** Build the record a store persists for a candidate. Ids are namespaced per
 *  AGENTS.md invariant 4 (`mem:<scopeKey>:<seq>`); keywords default to the
 *  text's tokens so keyword retrieval always has something to hit. */
export function mintRecord(scopeKey: string, seq: number, now: number, cand: MemoryCandidate): MemoryRecord {
  return {
    id: `mem:${scopeKey}:${seq}`,
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
  };
}
