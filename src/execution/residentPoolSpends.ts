/** Durable UID ownership within one VM generation. Missing or malformed
 * records are unknown generations, never an empty pool. */
export interface SpentPoolUser {
  user: string;
  owner: string;
}

export function parseSpentPoolUsers(value: unknown, pool: readonly string[]): ReadonlyMap<string, string> | null {
  if (
    !Array.isArray(value) ||
    !value.every(
      (row): row is SpentPoolUser =>
        row !== null &&
        typeof row === "object" &&
        "user" in row &&
        "owner" in row &&
        typeof row.user === "string" &&
        typeof row.owner === "string" &&
        /^(thread|op):\S+$/.test(row.owner),
    )
  )
    return null;
  const spent = new Map(value.map(({ user, owner }) => [user, owner]));
  if (spent.size !== value.length || [...spent.keys()].some((user) => !pool.includes(user))) return null;
  return spent;
}

/** A new owner must get an unused UID; only the exact recorded owner may
 * reclaim its UID. Both paths record ownership before untrusted work. */
export function spendPoolUser(
  value: unknown,
  pool: readonly string[],
  user: string,
  owner: string,
): SpentPoolUser[] | null {
  const spent = parseSpentPoolUsers(value, pool);
  if (!spent || !pool.includes(user) || !/^(thread|op):\S+$/.test(owner)) return null;
  const prior = spent.get(user);
  if (prior && prior !== owner) return null;
  const rows = [...spent].map(([user, owner]) => ({ user, owner }));
  return prior ? rows : [...rows, { user, owner }];
}

/** A UID-scoped command must have exactly one live owner. An old duplicate
 * binding never gains authority merely because its UID is spent. */
export function mayRunAsPoolUser(
  value: unknown,
  pool: readonly string[],
  user: string,
  liveThreadKeys: readonly string[],
  activeOpOwner: string | undefined,
  expectedOwner?: string,
): boolean {
  const recorded = parseSpentPoolUsers(value, pool)?.get(user);
  if (!recorded || (expectedOwner !== undefined && recorded !== expectedOwner)) return false;
  if (activeOpOwner !== undefined) return liveThreadKeys.length === 0 && recorded === activeOpOwner;
  return liveThreadKeys.length === 1 && recorded === `thread:${liveThreadKeys[0]}`;
}

/** One row per UID is rebuilt from primary bindings when a DO starts. A
 * malformed or missing row cannot authorize a shell, even if the spend ledger
 * names the caller. Keep every live claimant so duplicates remain visible. */
export function parsePoolBindings(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((key): key is string => typeof key === "string" && key.length > 0))
    return null;
  if (new Set(value).size !== value.length) return null;
  return value;
}

export function claimPoolBinding(value: unknown, threadKey: string): string[] | null {
  const current = parsePoolBindings(value);
  if (!current || !threadKey || current.includes(threadKey)) return null;
  return [...current, threadKey];
}

export function releasePoolBinding(value: unknown, threadKey: string): string[] | null {
  const current = parsePoolBindings(value);
  if (!current || !threadKey || !current.includes(threadKey)) return null;
  return current.filter((key) => key !== threadKey);
}

export function rebuildPoolBindingIndex(
  bindings: Iterable<{ threadKey: string; user: string; evicted?: boolean }>,
  pool: readonly string[],
): Map<string, string[]> | null {
  const byUser = new Map(pool.map((user) => [user, [] as string[]]));
  for (const binding of bindings) {
    if (binding?.evicted === true) continue;
    if (!binding || typeof binding.threadKey !== "string" || !binding.threadKey) return null;
    if (!binding.user) continue;
    const keys = byUser.get(binding.user);
    if (!keys || keys.includes(binding.threadKey)) return null;
    keys.push(binding.threadKey);
  }
  return byUser;
}
