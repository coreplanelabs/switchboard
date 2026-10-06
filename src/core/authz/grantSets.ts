import type { GrantSet } from "./types.js";

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
