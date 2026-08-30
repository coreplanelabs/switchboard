import { parseModelRef, type Provider } from "../../providers/types.js";
import type { HistoryItem } from "../types.js";
import type { MemoryConfig, MemoryStore } from "./types.js";
import { applyBudget, DEFAULT_MEMORY_LIMIT, DEFAULT_MEMORY_TOKENS, renderMemoryBlock, scoreRecord } from "./scorer.js";
import { listScopeKeys, requestScopeKeys } from "./scope.js";
import { selectMemoryStore } from "./stores.js";
import { reflect, shouldReflect, trackReflection, type ReflectGateInput } from "./reflection.js";

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
export { deriveScopeKey, requestScopeKeys, listScopeKeys, ORG_RESOURCE, type ScopeContext, type RequestScopeKeys } from "./scope.js";
export { NullMemoryStore, InMemoryMemoryStore, selectMemoryStore } from "./stores.js";
export { normalizeText, rankRecords, planWrite, planEviction, mintRecord, DEFAULT_SCOPE_CAP, type WritePlan } from "./engine.js";
export { WorkerMemoryStore, MEMORY_WORKER_TIMEOUT_MS, type WorkerMemoryStoreOptions } from "./workerStore.js";
export { buildMemoryStore, DEFAULT_MEMORY_TOKEN_ENV } from "./buildStore.js";
export {
  REFLECT_MIN_TURNS,
  NO_REFLECT_AGENTS,
  MAX_REFLECTION_FACTS,
  MIN_REFLECTION_CONFIDENCE,
  REFLECTION_SYSTEM,
  shouldReflect,
  buildReflectionInput,
  parseReflection,
  reflect,
  trackReflection,
  pendingReflectionCount,
  drainReflections,
  type ReflectGateInput,
  type ReflectionInput,
  type ReflectionProvenance,
  type ParsedReflection,
  type ReflectDeps,
  type MemoryAudience,
  type RoutedCandidate,
} from "./reflection.js";

/**
 * The dispatcher-facing write path: fire-and-forget. Returns immediately after
 * deciding whether this run qualifies; when it does, the reflection promise is
 * tracked for the shutdown drain (`drainReflections`) and never awaited by the
 * caller, so its latency and failures cannot reach the user reply. Memory off
 * → returns without doing anything (zero behavior change). The model comes from
 * `memory.model`, falling back to the run's own resolved ref — both are config-
 * resolved `<provider>/<model>` strings (AGENTS.md invariant 7). Records are
 * written to the org scope and — for `user`-audience facts — the requesting
 * user's own scope (#107 PR B).
 */
export function scheduleReflection(input: {
  cfg: MemoryConfig | undefined;
  store: MemoryStore | undefined;
  providers: { get(name: string): Provider };
  /** The run's resolved model ref — the fallback when `memory.model` is unset. */
  runModelRef: string;
  gate: ReflectGateInput;
  threadKey: string;
  runId: string;
  /** The requesting user's namespaced id (`slack:U…`) → their memory scope. */
  userId?: string;
  history: HistoryItem[];
  request: string;
  answer: string;
}): void {
  if (!input.cfg?.enabled || !shouldReflect(input.gate)) return;
  const warn = (m: string) => console.warn(`[memory] ${input.threadKey} ${m}`);
  let provider: Provider;
  let model: string;
  try {
    const ref = parseModelRef(input.cfg.model ?? input.runModelRef);
    provider = input.providers.get(ref.provider);
    model = ref.model;
  } catch (err) {
    warn(`reflection skipped: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  trackReflection(
    reflect({
      provider,
      model,
      store: selectMemoryStore(input.cfg, input.store),
      scopeKeys: requestScopeKeys(input.userId),
      history: input.history,
      request: input.request,
      answer: input.answer,
      sourceThreadKey: input.threadKey,
      sourceRunId: input.runId,
      onWarn: warn,
    }),
  );
}

/**
 * The dispatcher-facing read path: select the store (NullMemoryStore when
 * disabled), derive the request's scope keys (org + the requesting user's own
 * scope, #107 PR B), retrieve each, merge into ONE ranked pool, apply the hard
 * budget, and render the dedicated advisory context block. Returns `undefined`
 * when memory is off or nothing matches — the caller then injects nothing,
 * leaving the model input byte-identical to memory-off.
 *
 * Isolation is by construction: the only user scope ever queried is the one
 * derived from `userId`, so another person's records cannot be returned.
 */
export async function memoryContextBlock(
  cfg: MemoryConfig | undefined,
  injected: MemoryStore | undefined,
  query: string,
  userId?: string,
): Promise<string | undefined> {
  const store = selectMemoryStore(cfg, injected);
  const scopeKeys = listScopeKeys(requestScopeKeys(userId));
  const limit = cfg?.limit ?? DEFAULT_MEMORY_LIMIT;
  const perScope = await Promise.all(scopeKeys.map((scopeKey) => store.retrieve({ scopeKey, query, limit })));
  // Each store call returns its scope's top `limit`, already ranked; re-scoring
  // the union with the same pure scorer gives one cross-scope order so the
  // budget applies to the pool, not per scope. Because `retrieve` has just
  // bumped `lastUsedAt` on every returned record, their recency terms are all
  // ≈1 here and the merge order is decided by keyword match — recency did its
  // work inside each scope's own ranking. Stable sort: ties keep org first.
  const t = Date.now();
  const merged = perScope
    .flat()
    .map((r) => ({ r, score: scoreRecord(r, query, t) }))
    .sort((a, b) => b.score - a.score)
    .map(({ r }) => r);
  const budgeted = applyBudget(merged, {
    maxRecords: limit,
    maxTokens: cfg?.maxTokens ?? DEFAULT_MEMORY_TOKENS,
  });
  if (budgeted.length === 0) return undefined;
  return renderMemoryBlock(scopeKeys.join(" + "), budgeted);
}
