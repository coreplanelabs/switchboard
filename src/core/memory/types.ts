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
   *  inside the store. Driven by the post-run reflection pass (reflection.ts). */
  write(scopeKey: string, records: MemoryCandidate[]): Promise<void>;
  /** Human view: a scope's ACTIVE records, newest first, at most
   *  `limit`. Unlike `retrieve` this never bumps usage. */
  /** `query`: when given, only records that a query token hits
   *  (whole-token, text or keywords) are listed — the filter narrows, it
   *  never ranks or bumps usage. */
  list(scopeKey: string, limit: number, query?: string): Promise<MemoryRecord[]>;
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
  /** Max records retrieved/injected per request. Default 8. */
  limit?: number;
  /** Hard token budget for the injected block. Default ~800. */
  maxTokens?: number;
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
