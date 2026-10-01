import type { Span } from "../trace/types.js";
import type { AudienceCheck } from "../audienceDecision.js";
import { memoryContextBlock } from "../memory/index.js";
import { listScopeKeys, requestScopeKeys } from "../memory/scope.js";
import { NullMemoryStore } from "../memory/stores.js";
import type { MemoryConfig, MemoryRecord, MemoryStore } from "../memory/types.js";
import { frozenMemoryRecord, validMemoryProvenance } from "../memory/provenance.js";
import {
  memoryScopeDependencies,
  mergeContextDependencies,
  type ContextDependencies,
} from "../references/contextDependencies.js";

export interface OperatorMemorySource {
  runId: string;
  threadKey: string;
  scopeKey: string;
  candidate: MemoryRecord;
  dependencies: ContextDependencies;
}

export interface OperatorMemoryInput {
  span?: Span;
  organization: string;
  requester: string;
  channelId: string;
  text: string;
  repo?: string;
  memoryConfig?: MemoryConfig;
  memory?: MemoryStore;
  /** Current scope admission, supplied by the request's authorization owner. */
  canReadScope(scopeKey: string): boolean;
  /** Authorize the exact source run and its derived content for the current
   * requester/destination. Scope membership alone cannot admit source text. */
  authorizeSource(source: OperatorMemorySource): Promise<AudienceCheck>;
}

export interface OperatorMemoryContext {
  memory?: string;
  context?: ContextDependencies;
  unavailable: string[];
}

/** Keep the existing ranking, repository window and token budget, while
 * ensuring neither read path can inject content before its source is admitted.
 * The filtered facade is local to this read and offers no write capability. */
export async function readOperatorMemory(input: OperatorMemoryInput): Promise<OperatorMemoryContext> {
  if (!input.memoryConfig?.enabled) return { unavailable: [] };
  if (!input.memory) return { unavailable: ["Saved memory storage is unavailable."] };
  const memory = input.memory;
  const unavailable = new Set<string>();
  const dependencies: ContextDependencies[] = [];
  const scopes = new Set(
    listScopeKeys(
      requestScopeKeys(input.organization, input.requester, {
        channelId: input.channelId,
        repo: input.repo,
      }),
    ),
  );
  const admittedScope = (scope: string) => scopes.has(scope) && input.canReadScope(scope);
  const omit = (scope: string, reason: string) => {
    unavailable.add(`Some saved memory in ${scope} is unavailable: ${reason}.`);
  };
  const filter = async (scope: string, records: readonly MemoryRecord[]) => {
    const checked = await Promise.all(
      records.map(async (record) => {
        // Capture source identity and text together before the asynchronous check.
        const candidate = frozenMemoryRecord(record);
        if (candidate.scopeKey !== scope || !admittedScope(scope)) {
          omit(scope, "scope access was not verified");
          return undefined;
        }
        if (!candidate.sourceRunId?.trim() || !candidate.sourceThreadKey.trim()) {
          omit(scope, "source provenance is missing");
          return undefined;
        }
        try {
          if (!(await validMemoryProvenance(candidate)) || candidate.provenance?.dependencies.status !== "known") {
            omit(scope, "memory revision dependencies are unproved");
            return undefined;
          }
          const decision = await input.authorizeSource({
            runId: candidate.sourceRunId,
            threadKey: candidate.sourceThreadKey,
            scopeKey: candidate.scopeKey,
            candidate,
            dependencies: candidate.provenance.dependencies,
          });
          if (!decision.ok) {
            omit(scope, decision.code);
            return undefined;
          }
          if (!admittedScope(scope)) {
            omit(scope, "scope access changed");
            return undefined;
          }
          dependencies.push(
            mergeContextDependencies(candidate.provenance.dependencies, memoryScopeDependencies([candidate.scopeKey])),
          );
          return candidate;
        } catch {
          omit(scope, "the current source check could not complete");
          return undefined;
        }
      }),
    );
    return checked.filter((record): record is MemoryRecord => record !== undefined);
  };
  const filtered: MemoryStore = new NullMemoryStore();
  filtered.retrieve = async (query, trace) => {
    if (!admittedScope(query.scopeKey)) return [];
    try {
      return await filter(query.scopeKey, await memory.retrieve(query, trace));
    } catch {
      omit(query.scopeKey, "storage could not be read");
      return [];
    }
  };
  filtered.list = async (scope, limit, options) => {
    if (!admittedScope(scope)) return [];
    try {
      return await filter(scope, await memory.list(scope, limit, options));
    } catch {
      omit(scope, "storage could not be read");
      return [];
    }
  };
  const block = await memoryContextBlock(
    input.organization,
    input.memoryConfig,
    filtered,
    input.text,
    input.requester,
    { channelId: input.channelId, repo: input.repo },
    input.span,
  );
  return {
    ...(block ? { memory: block } : {}),
    context: mergeContextDependencies(
      { version: 1, status: "known", revision: 0, origins: [], slack: [], mcp: [] },
      ...dependencies,
    ),
    unavailable: [...unavailable],
  };
}
