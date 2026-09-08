import type { MemoryRecord } from "./types.js";

// Pure retrieval scoring, budgeting, and rendering. No I/O, no clock of its own
// (the caller passes `now`) — so every branch is unit-testable in isolation.
// MVP score = α·keywordMatch + β·recency (Generative-Agents-style, minus the
// embedding-relevance term): keyword+recency is a legitimate MVP; vectors are an
// upgrade behind the unchanged seam ("do you even need vectors at MVP?").

/** Relative weights of the two scoring terms. */
export interface ScoreWeights {
  keyword: number;
  recency: number;
}

/** α (keyword) dominates; β (recency) breaks ties and sinks stale records. */
export const DEFAULT_WEIGHTS: ScoreWeights = { keyword: 0.7, recency: 0.3 };

/** Exponential-decay time constant for the recency term (~1 week). A record
 *  one τ old scores 1/e on recency; the decay makes stale facts sink without a
 *  sweeper job (decay lives in the score). */
export const RECENCY_TAU_MS = 7 * 24 * 60 * 60 * 1000;

/** Default read budget: at most 8 records / ~800 tokens injected, regardless of
 *  store size — context never bloats. */
export const DEFAULT_MEMORY_LIMIT = 8;
export const DEFAULT_MEMORY_TOKENS = 800;

export interface MemoryBudget {
  maxRecords: number;
  maxTokens: number;
}

/** Split text into lowercased alphanumeric tokens for keyword matching. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Fraction of the query's word-tokens that appear as a word in the record (its
 *  keyword set or its text). 0 when the query has no tokens. Whole-token
 *  matching, not raw substring: substring matching lets a one-letter query token
 *  ("a") match inside an unrelated word ("comm-a-nd") and pollute retrieval. */
export function keywordMatch(record: MemoryRecord, query: string | readonly string[]): number {
  const queryTokens = typeof query === "string" ? tokenize(query) : query;
  if (queryTokens.length === 0) return 0;
  const recordTokens = new Set([...tokenize(record.keywords.join(" ")), ...tokenize(record.text)]);
  let hits = 0;
  for (const token of queryTokens) {
    if (recordTokens.has(token)) hits++;
  }
  return hits / queryTokens.length;
}

/** Exponential recency decay over `lastUsedAt ?? createdAt`, in (0, 1]. */
export function recencyScore(record: MemoryRecord, now: number, tau: number = RECENCY_TAU_MS): number {
  const ts = record.lastUsedAt ?? record.createdAt;
  const age = Math.max(0, now - ts);
  return Math.exp(-age / tau);
}

/** score = α·keywordMatch + β·recency. Pure; the caller supplies `now`. */
export function scoreRecord(
  record: MemoryRecord,
  query: string | readonly string[],
  now: number,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  tau: number = RECENCY_TAU_MS,
): number {
  return weights.keyword * keywordMatch(record, query) + weights.recency * recencyScore(record, now, tau);
}

/** Rough token estimate (~4 chars/token) for the budget cap. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Apply the hard budget: at most `maxRecords`, and stop before the running
 *  token estimate would exceed `maxTokens` (the first record is always kept so a
 *  single large record is never silently dropped). Input is assumed already
 *  ranked; order is preserved. Each record is costed at its *rendered* bullet
 *  (`renderMemoryBullet`) — sanitized/escaped text plus the `- … (source: …)`
 *  boilerplate — not the raw `record.text`. `sanitizeMemoryField` can lengthen
 *  text (`<`→`&lt;` is +3 chars each), so budgeting the raw text would
 *  under-count and let the rendered block exceed `maxTokens`; costing the
 *  rendered bullet keeps the estimate an upper bound on the injected records. */
export function applyBudget(records: MemoryRecord[], budget: MemoryBudget): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  let tokens = 0;
  for (const record of records) {
    if (out.length >= budget.maxRecords) break;
    const cost = estimateTokens(renderMemoryBullet(record));
    if (out.length > 0 && tokens + cost > budget.maxTokens) break;
    out.push(record);
    tokens += cost;
  }
  return out;
}

/** The exact prefix line of the injected context block. */
export function memoryBlockPrefix(resource: string): string {
  return `Background memory for ${resource} (may be outdated — verify before acting):`;
}

/** Neutralize a memory record field before it is spliced into the system
 *  prompt: strip control characters and any newline/line-separator (so a
 *  record can never inject extra lines or fake role turns), collapse the
 *  resulting whitespace, then escape `&`\u2192`&amp;` FIRST, then `<`\u2192`&lt;` and
 *  `>`\u2192`&gt;`. Escaping `&` before the angle brackets keeps the escaping
 *  complete and unambiguous: a record's literal `&lt;` becomes `&amp;lt;`, so it
 *  no longer renders identically to an escaped `<`. Escaping angle brackets means
 *  a record field can contain no literal `<` or `>`, so it can never forge the
 *  `<background_memory>`/`</background_memory>` fence delimiter \u2014 or any other
 *  tag \u2014 inline within a bullet. This is the anti-poisoning containment for the
 *  memory block (see docs/reference/specs/memory.md). */
export function sanitizeMemoryField(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
      .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  );
}

/** The exact rendered bullet for one record — the single source of truth shared
 *  by `renderMemoryBlock` (what is injected) and `applyBudget` (what is costed),
 *  so the budget estimate can never diverge from what is actually rendered. Both
 *  record fields pass through `sanitizeMemoryField` (control/newline strip +
 *  `&`/`<`/`>` escape). */
function renderMemoryBullet(record: MemoryRecord): string {
  return `- ${sanitizeMemoryField(record.text)} (source: ${sanitizeMemoryField(record.sourceThreadKey)})`;
}

/** Render the dedicated advisory context block: the exact prefix line, then one
 *  bullet per record with its provenance, fenced by an unambiguous
 *  `<background_memory>` delimiter. Framed as advisory ("may be outdated —
 *  verify") — memory is context, never instructions. The fence lines are
 *  written here literally; the record-derived fields pass through
 *  `sanitizeMemoryField` (control/newline strip + `&`/`<`/`>` escape), so a
 *  record can neither inject extra lines / fake role turns nor forge the fence
 *  delimiter — or any tag — from within a bullet (anti-poisoning). */
export function renderMemoryBlock(resource: string, records: MemoryRecord[]): string {
  const bullets = records.map(renderMemoryBullet);
  return [memoryBlockPrefix(resource), "<background_memory>", ...bullets, "</background_memory>"].join("\n");
}
