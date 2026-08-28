import { parseModelRef, type Provider } from "../../providers/types.js";
import type { HistoryItem } from "../types.js";
import type { MemoryConfig, MemoryStore } from "./types.js";
import { applyBudget, DEFAULT_MEMORY_LIMIT, DEFAULT_MEMORY_TOKENS, renderMemoryBlock } from "./scorer.js";
import { deriveScopeKey } from "./scope.js";
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
export { deriveScopeKey, ORG_RESOURCE } from "./scope.js";
export { NullMemoryStore, InMemoryMemoryStore, selectMemoryStore } from "./stores.js";
export {
  REFLECT_MIN_TURNS,
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
} from "./reflection.js";

/**
 * The dispatcher-facing write path: fire-and-forget. Returns immediately after
 * deciding whether this run qualifies; when it does, the reflection promise is
 * tracked for the shutdown drain (`drainReflections`) and never awaited by the
 * caller, so its latency and failures cannot reach the user reply. Memory off
 * → returns without doing anything (zero behavior change). The model comes from
 * `memory.model`, falling back to the run's own resolved ref — both are config-
 * resolved `<provider>/<model>` strings (AGENTS.md invariant 7).
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
      scopeKey: deriveScopeKey(input.cfg.scope ?? "org"),
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
