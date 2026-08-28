import type { MemoryConfig, MemoryStore } from "./types.js";
import { applyBudget, DEFAULT_MEMORY_LIMIT, DEFAULT_MEMORY_TOKENS, renderMemoryBlock } from "./scorer.js";
import { deriveScopeKey } from "./scope.js";
import { selectMemoryStore } from "./stores.js";

export type {
  MemoryRecord,
  MemoryCandidate,
  MemoryQuery,
  MemoryStore,
  MemoryScope,
  MemoryConfig,
} from "./types.js";
export {
  DEFAULT_WEIGHTS,
  RECENCY_TAU_MS,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_MEMORY_TOKENS,
  tokenize,
  keywordMatch,
  recencyScore,
  scoreRecord,
  estimateTokens,
  applyBudget,
  memoryBlockPrefix,
  renderMemoryBlock,
  type ScoreWeights,
  type MemoryBudget,
} from "./scorer.js";
export { deriveScopeKey, ORG_RESOURCE } from "./scope.js";
export { NullMemoryStore, InMemoryMemoryStore, selectMemoryStore } from "./stores.js";

/**
 * The dispatcher-facing read path: select the store (NullMemoryStore when
 * disabled), derive the scope key, retrieve, apply the hard budget, and render
 * the dedicated advisory context block. Returns `undefined` when memory is off
 * or nothing matches — the caller then injects nothing, leaving the model input
 * byte-identical to memory-off.
 */
export async function memoryContextBlock(
  cfg: MemoryConfig | undefined,
  injected: MemoryStore | undefined,
  query: string,
): Promise<string | undefined> {
  const store = selectMemoryStore(cfg, injected);
  const scopeKey = deriveScopeKey(cfg?.scope ?? "org");
  const limit = cfg?.limit ?? DEFAULT_MEMORY_LIMIT;
  const records = await store.retrieve({ scopeKey, query, limit });
  const budgeted = applyBudget(records, {
    maxRecords: limit,
    maxTokens: cfg?.maxTokens ?? DEFAULT_MEMORY_TOKENS,
  });
  if (budgeted.length === 0) return undefined;
  return renderMemoryBlock(scopeKey, budgeted);
}
