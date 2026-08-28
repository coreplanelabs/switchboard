// Cross-session self-learning memory (Area 7c, #85). The seam: distilled
// records scoped to a resource, retrieved by keyword+recency and injected as a
// dedicated advisory context block before the model turn. PR1 ships the seam +
// the READ path behind a flag (default off → zero behavior change); the write/
// reflection path (PR2) and the durable Worker store (PR3) hang off the same
// interface. See features/memory.md.

/** A distilled, self-contained memory record. Never a raw transcript — those
 *  live in thread history; duplicating them defeats the token win. Every record
 *  keeps provenance (`sourceThreadKey`/`sourceRunId`) so a distilled fact can be
 *  re-grounded in the run that produced it. */
export interface MemoryRecord {
  /** Internal id, namespaced per AGENTS.md invariant 4 (`mem:<scopeKey>:<n>`). */
  id: string;
  /** The resource this record belongs to, e.g. `org:coreplanelabs`. */
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
  status: "active" | "superseded";
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
 *  this interface, never a concrete store). Two implementations ship in PR1
 *  (invariant 2): `NullMemoryStore` (disabled default) and `InMemoryMemoryStore`
 *  (tests/dev); the durable `WorkerMemoryStore` is PR3. */
export interface MemoryStore {
  /** Scope-partitioned retrieval, ranked by the pure scorer, oldest-irrelevant
   *  dropped. Returns [] when nothing matches. */
  retrieve(q: MemoryQuery): Promise<MemoryRecord[]>;
  /** Persist distilled candidates. Dedup (identical normalized text → bump
   *  `useCount`) and supersede (`supersedes` id → old record soft-deleted) live
   *  inside the store. Driven by the post-run reflection pass (reflection.ts). */
  write(scopeKey: string, records: MemoryCandidate[]): Promise<void>;
}

/** Which resource memory is scoped to. PR1 implements `org` only; `repo`/
 *  `channel` are a PR4 gap (features/memory.md). Tighter scope prevents
 *  cross-context poisoning (mirrors Claude's compartmentalization). */
export type MemoryScope = "org";

/** The `memory` config section (all optional; default OFF). */
export interface MemoryConfig {
  /** Master switch. Default false → `NullMemoryStore` → zero behavior change. */
  enabled?: boolean;
  /** Which resource to scope to. Default `org`. */
  scope?: MemoryScope;
  /** Max records retrieved/injected per request. Default 8. */
  limit?: number;
  /** Hard token budget for the injected block. Default ~800. */
  maxTokens?: number;
  /** `<provider>/<model>` ref for the post-run reflection (write path) — a cheap
   *  tier. Absent → the run's own resolved model. Never hardcoded (invariant 7). */
  model?: string;
  /** The durable store: the Memory Worker (deploy/cloudflare-memory/). Absent →
   *  an in-process store that a restart loses (dev only; startup warns). */
  worker?: {
    /** Base URL, e.g. https://switchboard-memory.coreplanelabs.dev */
    baseUrl: string;
    /** Env var holding the bearer secret. Default MEMORY_TOKEN. */
    tokenEnv?: string;
  };
}
