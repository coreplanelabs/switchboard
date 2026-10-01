import {
  isContextDependencies,
  mergeContextDependencies,
  type ContextDependencies,
} from "../references/contextDependencies.js";
import { sourceHash } from "../references/receipts.js";
import { tokenize } from "./scorer.js";
import type { MemoryCandidate, MemoryProvenance, MemoryRecord } from "./types.js";

/** These fields are immutable through usage bumps and dependency unions. */
export function memoryContent(scopeKey: string, value: MemoryCandidate) {
  return {
    scopeKey,
    kind: value.kind,
    text: value.text,
    keywords: value.keywords ?? tokenize(value.text),
    sourceThreadKey: value.sourceThreadKey,
    sourceRunId: value.sourceRunId ?? null,
  };
}

export function isMemoryProvenance(value: unknown): value is MemoryProvenance {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.scopeKey === "string" &&
    v.scopeKey.length > 0 &&
    v.scopeKey.length <= 512 &&
    typeof v.contentHash === "string" &&
    /^[a-f0-9]{64}$/.test(v.contentHash) &&
    isContextDependencies(v.dependencies)
  );
}

/** Hash before entering the store's synchronous transaction. The read path
 * rechecks the stored content, so a malformed transport cannot launder it. */
export async function sealMemoryCandidate(
  scopeKey: string,
  value: MemoryCandidate,
  dependencies: ContextDependencies | undefined,
): Promise<MemoryCandidate> {
  const candidate = structuredClone(value);
  const context = structuredClone(mergeContextDependencies(dependencies));
  candidate.keywords ??= tokenize(candidate.text);
  candidate.provenance = {
    version: 1,
    scopeKey,
    contentHash: await sourceHash(memoryContent(scopeKey, candidate)),
    dependencies: context,
  };
  return candidate;
}

/** Absent or invalid metadata is unknown, never an empty dependency list. */
export function storedMemoryProvenance(
  scopeKey: string,
  provenance: MemoryProvenance | undefined,
): MemoryProvenance | undefined {
  return isMemoryProvenance(provenance) && provenance.scopeKey === scopeKey ? structuredClone(provenance) : undefined;
}

export function mergeMemoryProvenance(
  scopeKey: string,
  original: MemoryProvenance | undefined,
  incoming: MemoryProvenance | undefined,
): MemoryProvenance | undefined {
  const target = storedMemoryProvenance(scopeKey, original);
  if (!target) return undefined;
  target.dependencies = mergeContextDependencies(
    target.dependencies,
    storedMemoryProvenance(scopeKey, incoming)?.dependencies,
  );
  return target;
}

export async function validMemoryProvenance(record: MemoryRecord): Promise<boolean> {
  return (
    isMemoryProvenance(record.provenance) &&
    record.provenance.scopeKey === record.scopeKey &&
    record.provenance.contentHash === (await sourceHash(memoryContent(record.scopeKey, record)))
  );
}

/** The callback authorizes this snapshot, not an object storage may mutate
 * while awaiting the current source check. */
export function frozenMemoryRecord(record: MemoryRecord): MemoryRecord {
  const snapshot = structuredClone(record);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}
