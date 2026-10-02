import type { ContextDependencies } from "../references/contextDependencies.js";
import { childHandoffRunIds, type ChildHandoff } from "../dispatch/handoff.js";

/** A storage index over an admitted, validated handoff. It grants no access;
 * reads still check the consumer and source audience. */
export interface ContextReference {
  holderRunId: string;
  sourceRunId: string;
  sessionKey?: string;
}

export function contextReferencesOf(
  holderRunId: string,
  handoff?: ChildHandoff,
  context?: ContextDependencies,
): ContextReference[] {
  const refs = new Map<string, ContextReference>();
  const add = (sourceRunId: string, sessionKey?: string) => {
    refs.set(`${sourceRunId}:${sessionKey ?? ""}`, { holderRunId, sourceRunId, ...(sessionKey ? { sessionKey } : {}) });
  };
  for (const source of handoff ? [handoff, ...(handoff.ancestors ?? [])] : [])
    add(source.source.runId, source.session.key);
  const runIds = [
    ...(handoff ? childHandoffRunIds(handoff) : []),
    ...(context?.origins ?? []).map((o) => o.runId),
    ...(context?.mcp ?? []).map((r) => r.runId),
  ];
  for (const runId of runIds) {
    if (runId === holderRunId) continue;
    if (![...refs.values()].some((ref) => ref.sourceRunId === runId)) add(runId);
  }
  return [...refs.values()];
}

/** Ordinary retention chooses the roots first. Their bounded flat manifests
 * name every needed ancestor; a pinned source is not itself a new root.
 * Filtering the existing items prevents a reference from resurrecting data
 * removed by retention, explicit deletion or revocation. */
export function retainContextSources<T extends { id: string }>(
  items: readonly T[],
  ordinaryKept: readonly T[],
  references: readonly ContextReference[],
  liveHolderIds: readonly string[] = [],
): T[] {
  const roots = new Set([...ordinaryKept.map((item) => item.id), ...liveHolderIds]);
  const kept = new Set(ordinaryKept.map((item) => item.id));
  for (const reference of references) {
    if (roots.has(reference.holderRunId)) kept.add(reference.sourceRunId);
  }
  return items.filter((item) => kept.has(item.id));
}
