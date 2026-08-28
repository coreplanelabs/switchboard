import type { MemoryScope } from "./types.js";

// Scope derivation: a pure function config → a single opaque scope key,
// namespaced exactly like switchboard's existing IDs (AGENTS.md invariant 4).
// The store partitions rows by this key and is otherwise scope-agnostic, so
// widening/narrowing scope later is a deriver change, not a schema change.

/** The org resource for PR1 — the whole org is the memory resource. */
export const ORG_RESOURCE = "coreplanelabs";

/** Derive the scope key for a request. PR1 implements `org` only; `repo`/
 *  `channel` scoping is a PR4 gap (features/memory.md). */
export function deriveScopeKey(scope: MemoryScope): string {
  switch (scope) {
    case "org":
      return `org:${ORG_RESOURCE}`;
  }
}
