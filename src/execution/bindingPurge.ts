// The resident keeps a thread binding after eviction by design
// (docs/reference/specs/resident-repos.md item 23): the ref stays sticky for the next
// attach. A load run that attaches fifty synthetic threads therefore leaves
// fifty evicted rows on the resident's detail page forever. `POST /debug
// {op: "purge-bindings", prefix}` (item 60) deletes exactly the bindings a
// harness created and no longer needs. This is its decision, pure and
// imported by the resident Worker like `residentDiskBudget.ts`.

export interface PurgeableBinding {
  threadKey: string;
  evicted?: boolean;
}

export type PurgeDecision = { ok: true; purge: string[]; keptLive: string[] } | { ok: false; error: string };

/** Thread-key namespaces real channels mint (docs/reference/specs/http-ingress.md item 1,
 *  slack, mcp, the CLI). A purge is for synthetic keys only. */
const PRODUCTION_NAMESPACES = new Set(["slack", "http", "mcp", "cli"]);

/** A prefix must be a whole namespace (`load:`) or longer (`load:r1:`), never
 *  empty, never a bare partial namespace, never a production namespace. */
export function selectBindingsToPurge(bindings: readonly PurgeableBinding[], prefix: string): PurgeDecision {
  const m = /^([a-z][a-z0-9-]{0,31}):/.exec(prefix);
  if (!m)
    return {
      ok: false,
      error: `prefix must name a whole thread-key namespace, like "load:" (got ${JSON.stringify(prefix)})`,
    };
  if (PRODUCTION_NAMESPACES.has(m[1])) {
    return {
      ok: false,
      error: `prefix ${JSON.stringify(prefix)} is a production namespace; a purge is for synthetic thread keys only`,
    };
  }
  const purge: string[] = [];
  const keptLive: string[] = [];
  for (const b of bindings) {
    if (!b.threadKey.startsWith(prefix)) continue;
    if (b.evicted === true) purge.push(b.threadKey);
    else keptLive.push(b.threadKey);
  }
  return { ok: true, purge, keptLive };
}
