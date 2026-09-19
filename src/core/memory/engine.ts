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
  // max(50, 5×limit) bm25-ordered rows) on a single Durable Object
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

/** Default per-scope cap on ACTIVE records when config does not set one. */
export const DEFAULT_SCOPE_CAP = 500;

/** Per-scope cap: which ACTIVE records a store must evict so that at
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

/** What a store must do for one candidate. `restate`: bump `target.useCount`,
 *  set its `lastUsedAt` to the store's now and its confidence to `confidence`
 *  when the plan carries one (the higher of the two sides), insert nothing.
 *  `dedup`: bump `target.useCount`, insert nothing. `insert`: append `record`
 *  (already minted) and, when `supersede` is set, flip that record to
 *  `superseded`. */
export type WritePlan =
  | { action: "restate"; target: MemoryRecord; confidence?: number }
  | { action: "dedup"; target: MemoryRecord }
  | { action: "insert"; record: MemoryRecord; supersede?: MemoryRecord };

/**
 * Decide how one candidate lands among a scope's ACTIVE records (docs/reference/specs/
 * memory.md §8):
 * - **Restate target** = the active same-scope record whose id equals
 *   `cand.restates`: the fact re-teaches a shown record, so that record is
 *   refreshed — usage bumped, confidence the higher of the two — and nothing
 *   is inserted, whatever the candidate's wording. A missing or non-active
 *   target falls through to the rules below (today's dedup-or-insert).
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
  if (cand.restates) {
    const restated = active.find((r) => r.status === "active" && r.id === cand.restates);
    if (restated) {
      const confidences = [restated.confidence, cand.confidence].filter((c): c is number => c !== undefined);
      return {
        action: "restate",
        target: restated,
        ...(confidences.length > 0 ? { confidence: Math.max(...confidences) } : {}),
      };
    }
  }
  const norm = normalizeText(cand.text);
  const target = cand.supersedes ? active.find((r) => r.status === "active" && r.id === cand.supersedes) : undefined;
  const dedupPool = cand.supersedes ? (target ? [target] : []) : active.filter((r) => r.status === "active");
  const existing = dedupPool.find((r) => normalizeText(r.text) === norm);
  if (existing) return { action: "dedup", target: existing };
  return { action: "insert", record: mint(cand), ...(target ? { supersede: target } : {}) };
}

// ---- The write gate (docs/reference/specs/memory.md item 13) -----------------
// Status — the state of one pull request at one moment — and change
// descriptions — what one change did, which the spec and the diff already say —
// must never become facts: the prompt has asked for that since the write path
// shipped, and a rule a model is asked to follow is a rule it follows on
// average. The gate is therefore code, pure and total, and lives HERE in the
// shared engine so the bot's write path and the Worker's sweep run the exact
// same rule. A summary is never gated (episodic by definition).

/** A delivery predicate: words that say a change LANDED — one moment's news,
 *  never a lesson. Shared by the `delivery` marker and the reference marker's
 *  same-clause test. The auxiliary may sit up to two words from the participle
 *  ("is fixed and pushed"). */
const DELIVERY_PREDICATE =
  /\b(?:(?:was|were|is|are)\s+(?:\w+\s+){0,2}?(?:pushed|merged|approved)|all\s+green|lgtm|ready\s+for\s+review|awaits?\s+ci|is\s+complete)\b/i;

/** A pull-request / issue / unit reference in subject position: the fact opens
 *  with the noun and a number, so the reference is what the fact is ABOUT. */
const REFERENCE_SUBJECT = /^\s*(?:pr|pull\s+request|issue|unit)s?\s*#?\d+\b/i;

/** A reference elsewhere (`#n`, `pull/n`, `issues/n`) rejects only beside a
 *  delivery predicate in the same clause — a citation inside a lesson ("the
 *  staged rebuild (issue 170) must budget the swap") is not status. */
const REFERENCE_IN_CLAUSE = /#\d+|\b(?:pull|issues)\/\d+/i;

/** A commit sha: 7–40 hex chars with at least one digit AND one letter, bounded
 *  by non-alphanumerics — the letter keeps a timestamp or a plain count out,
 *  the digit keeps "defaced" and "accede" out. An all-digit or all-letter sha
 *  is missed and accepted as the cost. */
const COMMIT_SHA = /(?<![a-z0-9])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![a-z0-9])/i;

/** A run id (`run` + 8 hex chars) or a branch by its path-like name. */
const RUN_OR_BRANCH = /\brun\s+[0-9a-f]{8}\b|\bbranch\s+\S*\/\S+/i;

/** `now` + a present-tense verb (one intervening word allowed): what a change
 *  "now does" is a change description, not a lesson. */
const NOW_VERB =
  /\bnow\s+(?:\w+\s+)?(?:documents|preserves|displays|includes|carries|has|is|supports|shows|maps|controls|applies|uses)\b/i;

/** A passive change participle: "was implemented", "has been fixed", … */
const CHANGE_PARTICIPLE =
  /\b(?:was|were|has\s+been|have\s+been)\s+(?:implemented|added|updated|fixed|documented|removed|renamed|introduced|extended)\b/i;

/** A plan-unit reference. */
const PLAN_UNIT = /\bunit\s+u?\d+\b/i;

/** "spec row" / "spec rows": what a spec row documents is the spec's to say. */
const SPEC_ROW = /\bspec\s+rows?\b/i;

/** The words that make a nearby number a test/check count… */
const COUNT_NOUNS = new Set(["test", "tests", "checks", "rows"]);
/** …and the outcome words that make that count status. */
const COUNT_OUTCOME = /\b(?:pass(?:es|ing|ed)?|green|fail(?:s|ing|ed)?)\b/i;

/** A clause: the unit within which the reference and count markers look for
 *  their second half. */
function clausesOf(text: string): string[] {
  return text.split(/[;.!?\n—]+/);
}

/** A number within three words of a count noun, with an outcome word in the
 *  same clause — in either order ("all 12 tests passing", "green across 12
 *  checks"). */
function hasCountMarker(clause: string): boolean {
  if (!COUNT_OUTCOME.test(clause)) return false;
  const words = clause
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some(
    (w, i) => /^\d+$/.test(w) && words.slice(Math.max(0, i - 3), i + 4).some((neighbour) => COUNT_NOUNS.has(neighbour)),
  );
}

/** The status and change-description markers a fact text carries, by name —
 *  a table of named patterns, each firing independently. A non-empty answer
 *  rejects the fact (`parseReflection`) and, later, sweeps the stored row; the
 *  names are safe to log (never the text). Pure and total: never throws, and
 *  empty text carries no markers (it is rejected upstream as empty). */
export function rejectionMarkers(text: string): string[] {
  const clauses = clausesOf(text);
  const table: Array<[name: string, hit: boolean]> = [
    [
      "reference",
      REFERENCE_SUBJECT.test(text) || clauses.some((c) => REFERENCE_IN_CLAUSE.test(c) && DELIVERY_PREDICATE.test(c)),
    ],
    ["sha", COMMIT_SHA.test(text)],
    ["count", clauses.some(hasCountMarker)],
    ["delivery", DELIVERY_PREDICATE.test(text)],
    ["identifier", RUN_OR_BRANCH.test(text)],
    ["now", NOW_VERB.test(text)],
    ["changed", CHANGE_PARTICIPLE.test(text)],
    ["unit", PLAN_UNIT.test(text)],
    ["spec-row", SPEC_ROW.test(text)],
  ];
  return table.filter(([, hit]) => hit).map(([name]) => name);
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
