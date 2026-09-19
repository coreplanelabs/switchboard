// Cross-session self-learning memory. The seam: distilled records scoped to a
// resource, retrieved by keyword+recency and injected as a dedicated advisory
// context block before the model turn. The READ path sits behind a flag
// (default off → zero behavior change); the write/reflection path and the
// durable Worker store hang off the same interface. See docs/reference/specs/memory.md and
// docs/decisions/0017-memory-off-by-default.md.

/** A distilled, self-contained memory record. Never a raw transcript — those
 *  live in thread history; duplicating them defeats the token win. Every record
 *  keeps provenance (`sourceThreadKey`/`sourceRunId`) so a distilled fact can be
 *  re-grounded in the run that produced it. */
import type { TraceOptions } from "../trace/types.js";

export interface MemoryRecord {
  /** Internal id, namespaced per AGENTS.md invariant 4 (`mem:<scopeKey>:<n>`). */
  id: string;
  /** The resource this record belongs to: `org:<organization>` (the config's organization) or `user:slack:U…`. */
  scopeKey: string;
  /** Semantic fact vs. episodic thread summary. */
  kind: "fact" | "summary";
  /** Self-contained natural-language statement. */
  text: string;
  /** Lowercased keywords for keyword/FTS retrieval at MVP (no embeddings). */
  keywords: string[];
  /** Provenance: the thread this was distilled from (`slack:C…:<ts>`). */
  sourceThreadKey: string;
  /** Provenance: ties to the runRegistry / live-view page, when known. */
  sourceRunId?: string;
  createdAt: number;
  /** Bumped on retrieval → drives the recency term and decay. */
  lastUsedAt?: number;
  useCount: number;
  /** Extractor's importance/confidence (0–1); folded into scoring later. */
  confidence?: number;
  /** id this record replaces (conflict resolution / supersession). */
  supersedes?: string;
  /** `evicted`: dropped by the per-scope cap (least recently used);
   *  `superseded`: replaced by a newer record; `forgotten`: removed by a human
   *  via `memory forget`. Both are soft deletes — the row stays for
   *  provenance but is invisible to retrieval, list, and dedup. */
  status: "active" | "superseded" | "forgotten" | "evicted";
}

/** What the reflection extractor emits. The store assigns id/timestamps/useCount/
 *  status on write, so a candidate carries only the distilled content and its
 *  provenance. */
export interface MemoryCandidate {
  kind: "fact" | "summary";
  text: string;
  keywords?: string[];
  sourceThreadKey: string;
  sourceRunId?: string;
  confidence?: number;
  supersedes?: string;
}

/** What one `write` batch actually did, per candidate action — the seam's
 *  receipt (the counters on the `[memory]` outcome line are these plus the
 *  parse gate's own). `restated` stays 0 until the restate action lands on the
 *  write plan; it is on the shape now so every store answers the same fields. */
export interface WriteCounts {
  /** Candidates minted as new active records. */
  inserted: number;
  /** Candidates whose normalized text bumped an existing active record. */
  deduped: number;
  /** Candidates that bumped the shown record they restate (no insert). */
  restated: number;
  /** Records flipped to `superseded` by a candidate's pointer. */
  superseded: number;
  /** Records the per-scope cap evicted inside the same batch. */
  evicted: number;
}

/** Narrowing filters for `MemoryStore.list` — each narrows, never ranks. */
export interface MemoryListOptions {
  /** Whole-token text/keyword filter (the human command's `<words>`). */
  query?: string;
  /** Keep only records of this kind (the repository window lists facts). */
  kind?: MemoryRecord["kind"];
}

/** A retrieval request: which resource, what to match, how many at most. */
export interface MemoryQuery {
  scopeKey: string;
  query: string;
  limit: number;
}

/** The boundary the core sees (AGENTS.md invariant 2: the dispatcher depends on
 *  this interface, never a concrete store). Three implementations:
 *  `NullMemoryStore` (disabled default), `InMemoryMemoryStore` (tests/dev) and
 *  the durable `WorkerMemoryStore`. */
export interface MemoryStore {
  /** Scope-partitioned retrieval, ranked by the pure scorer, oldest-irrelevant
   *  dropped. Returns [] when nothing matches. */
  retrieve(q: MemoryQuery, trace?: TraceOptions): Promise<MemoryRecord[]>;
  /** Persist distilled candidates. Dedup (identical normalized text → bump
   *  `useCount`) and supersede (`supersedes` id → old record soft-deleted) live
   *  inside the store. Driven by the post-run reflection pass (reflection.ts).
   *  Answers what the batch did (`WriteCounts`), so the caller's outcome line
   *  reports the store's actions, never a guess. */
  write(scopeKey: string, records: MemoryCandidate[]): Promise<WriteCounts>;
  /** Human view and the repository window's read: a scope's ACTIVE records,
   *  newest first, at most `limit`. Unlike `retrieve` this never bumps usage.
   *  `opts.query`: when given, only records that a query token hits
   *  (whole-token, text or keywords) are listed — the filter narrows, it
   *  never ranks or bumps usage. `opts.kind`: when given, only records of
   *  that kind (the repository window lists facts, never summaries). */
  list(scopeKey: string, limit: number, opts?: MemoryListOptions): Promise<MemoryRecord[]>;
  /** Human control: soft-delete one ACTIVE record of this scope
   *  (`status: "forgotten"`, row kept for provenance). Resolves true when a
   *  record was forgotten, false when the id names nothing active in this
   *  scope — a foreign-scope id can never be forgotten through another scope. */
  forget(scopeKey: string, id: string): Promise<boolean>;
}

/** The resources memory is scoped to. `org` is the shared resource every
 *  request reads; `user` is the requesting person's own records,
 *  read and written only for that person; `repo` (the run's bound repository)
 *  and `channel` (the message's channel) are shared by everyone who runs there
 *  in the same place. Tighter scope prevents cross-context poisoning (mirrors
 *  Claude's compartmentalization). */
export type MemoryScope = "org" | "user" | "repo" | "channel";

/** The `memory` config section (all optional; default OFF). */
export interface MemoryConfig {
  /** Master switch. Default false → `NullMemoryStore` → zero behavior change. */
  enabled?: boolean;
  /** Max records retrieved/injected per request. Default 32. */
  limit?: number;
  /** Hard token budget for the injected block. Default ~3000. */
  maxTokens?: number;
  /** The repository window: a run bound to a repository leads its block with
   *  that repository's newest facts — at most this many, read with
   *  `list(repoScope, repoWindow, { kind: "fact" })` — ahead of the keyword
   *  hits, under the same budget. Default 24; `0` disables the window (the
   *  repository scope is retrieved by keyword like the others). */
  repoWindow?: number;
  /** Per-scope cap on ACTIVE records. A write that would leave a scope
   *  over the cap evicts the least recently used records (soft delete, status
   *  `evicted`) down to it, inside the same write. Default 500. */
  maxRecordsPerScope?: number;
  /** `<provider>/<model>` ref for the post-run reflection (write path) — a cheap
   *  tier. Absent → the run's own resolved model. Never hardcoded (invariant 7). */
  model?: string;
  /** The durable store: the Memory Worker (deploy/cloudflare-memory/). Absent →
   *  an in-process store that a restart loses (dev only; startup warns). */
  worker?: {
    /** Base URL, e.g. https://switchboard-memory.example.com */
    baseUrl: string;
    /** Env var holding the bearer secret. Default MEMORY_TOKEN. */
    tokenEnv?: string;
  };
}
