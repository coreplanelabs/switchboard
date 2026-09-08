import { parseModelRef, type Provider } from "../../providers/types.js";
import type { Actor, ChannelVisibility } from "../authz/types.js";
import type { HistoryItem } from "../types.js";
import type { MemoryConfig, MemoryStore } from "./types.js";
import type { Span } from "../trace/types.js";
import { applyBudget, DEFAULT_MEMORY_LIMIT, DEFAULT_MEMORY_TOKENS, renderMemoryBlock, scoreRecord } from "./scorer.js";
import { listScopeKeys, requestScopeKeys } from "./scope.js";
import { selectMemoryStore } from "./stores.js";
import { reflect, reflectionActor, shouldReflect, trackReflection, type ReflectGateInput } from "./reflection.js";
import { systemClock } from "../trace/clock.js";

export type { MemoryRecord, MemoryCandidate, MemoryQuery, MemoryStore, MemoryScope, MemoryConfig } from "./types.js";
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
export { deriveScopeKey, requestScopeKeys, listScopeKeys, type ScopeContext, type RequestScopeKeys } from "./scope.js";
export { NullMemoryStore, InMemoryMemoryStore, selectMemoryStore } from "./stores.js";
export {
  normalizeText,
  rankRecords,
  planWrite,
  planEviction,
  mintRecord,
  DEFAULT_SCOPE_CAP,
  type WritePlan,
} from "./engine.js";
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
  reflectionActor,
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
 * written to the org scope and — per the extractor's `audience` — the
 * requesting user's own scope or the run's repo / channel scope, each write
 * decided by the authorization policy for the run's principal under the run's
 * stamped channel visibility (a private or DM origin never writes org; the
 * fact is narrowed, never widened — docs/decisions/0017-memory-off-by-default.md).
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
  /** The run's principal — the actor the writes are decided for (authorization.md item 8). */
  actor: Actor;
  /** The run's stamped `channelVisibility`: the origin of every fact. */
  originChannelVisibility: ChannelVisibility;
  /** The config's `organization` → the shared org scope (`org:<organization>`). */
  organization: string;
  /** The requesting user's namespaced id (`slack:U…`) → their memory scope. */
  userId?: string;
  /** The message's namespaced channel id (`slack:C…`) → the channel scope. */
  channelId?: string;
  /** The run's resolved repo slug (`owner/name`) → the repo scope. */
  repo?: string;
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
      scopeKeys: requestScopeKeys(input.organization, input.userId, { channelId: input.channelId, repo: input.repo }),
      actor: reflectionActor(input.actor, { channelId: input.channelId, repo: input.repo }),
      originChannelVisibility: input.originChannelVisibility,
      history: input.history,
      request: input.request,
      answer: input.answer,
      sourceThreadKey: input.threadKey,
      sourceRunId: input.runId,
      onWarn: warn,
    }),
  );
}

/** The shared scopes a request may carry beyond org + user: the
 *  message's channel, and the run's repo — which may still be resolving. */
export interface MemoryScopeInputs {
  channelId?: string;
  repo?: string | Promise<string | undefined>;
}

/**
 * The dispatcher-facing read path: select the store (NullMemoryStore when
 * disabled), derive the request's scope keys (org + the requesting user's own
 * scope), retrieve each, merge into ONE ranked pool, apply the hard
 * budget, and render the dedicated advisory context block. Returns `undefined`
 * when memory is off or nothing matches — the caller then injects nothing,
 * leaving the model input byte-identical to memory-off.
 *
 * Isolation is by construction: the only user scope ever queried is the one
 * derived from `userId`, so another person's records cannot be returned.
 */
export async function memoryContextBlock(
  /** The config's `organization` → the shared org scope every request reads. */
  organization: string,
  cfg: MemoryConfig | undefined,
  injected: MemoryStore | undefined,
  query: string,
  userId?: string,
  scopes: MemoryScopeInputs = {},
  /** The caller's span — the dispatcher's `dispatch.memory_read` — under which
   *  every scope's retrieve becomes an `http.client` span (docs/reference/specs/tracing.md item 24). */
  span?: Span,
): Promise<string | undefined> {
  const store = selectMemoryStore(cfg, injected);
  const trace = span ? { span } : undefined;
  const limit = cfg?.limit ?? DEFAULT_MEMORY_LIMIT;
  // Org/channel/user are known up front and fetched immediately; the repo may
  // still be resolving (the dispatcher starts this read before its GitHub
  // round trip finishes), so that scope is fetched once the promise settles.
  // A repo resolution failure is the run's problem to report, not memory's:
  // here it just means no repo scope.
  const immediate = requestScopeKeys(organization, userId, { channelId: scopes.channelId });
  const immediateKeys = listScopeKeys(immediate);
  const immediateP = Promise.all(immediateKeys.map((scopeKey) => store.retrieve({ scopeKey, query, limit }, trace)));
  const repo = await Promise.resolve(scopes.repo).catch(() => undefined);
  const keys = requestScopeKeys(organization, userId, { channelId: scopes.channelId, repo });
  const scopeKeys = listScopeKeys(keys);
  const repoRecords = keys.repo ? await store.retrieve({ scopeKey: keys.repo, query, limit }, trace) : [];
  const perScope = [...(await immediateP), repoRecords];
  // Each store call returns its scope's top `limit`, already ranked; re-scoring
  // the union with the same pure scorer gives one cross-scope order so the
  // budget applies to the pool, not per scope. Because `retrieve` has just
  // bumped `lastUsedAt` on every returned record, their recency terms are all
  // ≈1 here and the merge order is decided by keyword match — recency did its
  // work inside each scope's own ranking. Stable sort: ties keep org first.
  const t = systemClock();
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
