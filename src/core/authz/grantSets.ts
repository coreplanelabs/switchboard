import type { Grants, GrantSet, RepoAccess } from "./types.js";

/** Does an action grant set hold `action`, literally or through a `<prefix>:*` wildcard? */
export function hasAction(actions: GrantSet, action: string): boolean {
  if (actions === "all") return true;
  if (actions.has(action)) return true;
  for (let i = action.lastIndexOf(":"); i > 0; i = action.lastIndexOf(":", i - 1)) {
    if (actions.has(`${action.slice(0, i)}:*`)) return true;
  }
  return false;
}

/** Does a literal id set (channels, repos) hold `id`? */
export function holds(set: GrantSet, id: string): boolean {
  return set === "all" || set.has(id);
}

export function intersectSets(a: GrantSet, b: GrantSet, covers: (set: GrantSet, member: string) => boolean): GrantSet {
  if (a === "all") return b;
  if (b === "all") return a;
  const out = new Set<string>();
  for (const member of a) if (covers(b, member)) out.add(member);
  for (const member of b) if (covers(a, member)) out.add(member);
  return out;
}

export function unionSet(a: GrantSet, b: GrantSet): GrantSet {
  if (a === "all" || b === "all") return "all";
  return new Set([...a, ...b]);
}

/** Repository names are case-insensitive on every policy path. */
export function normalizedRepos(repos: GrantSet): GrantSet {
  return repos === "all" ? repos : new Set([...repos].map((r) => r.toLowerCase()));
}
export function repoAccessOf(grants: Grants): RepoAccess {
  return grants.repoAccess ?? normalizedRepos(grants.repos);
}
function isComplement(access: RepoAccess): access is { readonly except: ReadonlySet<string> } {
  return typeof access === "object" && "except" in access;
}
export function holdsRepo(access: RepoAccess, repo: string): boolean {
  const lower = repo.toLowerCase();
  if (access === "all") return true;
  const names = isComplement(access) ? access.except : access;
  const present = [...names].some((r) => r.toLowerCase() === lower);
  return isComplement(access) ? !present : present;
}
function normalizedAccess(access: RepoAccess): RepoAccess {
  return isComplement(access)
    ? { except: normalizedRepos(access.except) as ReadonlySet<string> }
    : normalizedRepos(access);
}
/** Finite/complement arithmetic preserves both sides of delegation and human baselines. */
export function intersectRepoAccess(a: RepoAccess, b: RepoAccess): RepoAccess {
  a = normalizedAccess(a);
  b = normalizedAccess(b);
  if (a === "all") return b;
  if (b === "all") return a;
  if (isComplement(a) && isComplement(b)) return { except: new Set([...a.except, ...b.except]) };
  if (isComplement(a)) return new Set([...(b as ReadonlySet<string>)].filter((r) => holdsRepo(a, r)));
  return new Set([...a].filter((r) => holdsRepo(b, r)));
}
export function unionRepoAccess(a: RepoAccess, b: RepoAccess): RepoAccess {
  a = normalizedAccess(a);
  b = normalizedAccess(b);
  if (a === "all" || b === "all") return "all";
  if (isComplement(a) && isComplement(b)) return { except: new Set([...a.except].filter((r) => b.except.has(r))) };
  if (isComplement(b)) return unionRepoAccess(b, a);
  if (isComplement(a)) return { except: new Set([...a.except].filter((r) => !holdsRepo(b, r))) };
  return new Set([...a, ...b]);
}
/** Keep the historical grant shape when explicit ownership already describes code access. */
export function withRepoAccess(grants: Grants, access: RepoAccess): Grants {
  const own = normalizedRepos(grants.repos);
  if (
    access === own ||
    (access !== "all" &&
      own !== "all" &&
      !isComplement(access) &&
      access.size === own.size &&
      [...access].every((r) => own.has(r)))
  )
    return grants;
  return { ...grants, repoAccess: access };
}
