/** The "is the mirror fresh enough for this attach?" decision of the resident
 *  Worker's `attachThread` (deploy/cloudflare-resident/worker.ts), kept pure
 *  and dependency-free so it is unit-testable from src/ and imported across
 *  packages by the Worker (like residentReadonly / residentRefresh) — the
 *  tested code IS the shipped code.
 *
 *  The resident's mirror is fetched on its refresh cycle and, on attach, when
 *  the bound ref is missing from it. A ref that exists but is STALE — pushed
 *  to since the last cycle — would be cloned at the old tip, and a review of
 *  it refused by the reviewed-head guard (agent-review.md item 8) on a head
 *  the bot had already resolved (`RepoContext.headSha`). So `/attach` carries
 *  that head as `sha`, and a mirror whose ref tip is not that commit is
 *  fetched before the clone (features/resident-repos.md item 51). */

export type ParsedWantSha = { sha: string | null } | { error: string };

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** `/attach` body field `sha` — the commit the caller expects the ref to be at
 *  (a PR head). Absent → null (older bots never send it; coding runs have no
 *  expected commit); a full 40-hex lowercase sha → itself (a full sha names
 *  exactly one commit — no prefix ambiguity); anything else → a 400-shaped
 *  error. Validated BEFORE it can become a git argument (P1). */
export function parseWantSha(value: unknown): ParsedWantSha {
  if (value === undefined) return { sha: null };
  if (typeof value === "string" && FULL_SHA_RE.test(value)) return { sha: value };
  return { error: "sha must be a full 40-character lowercase hex commit when present" };
}

/** The expected head applies to the ref the caller resolved it FOR (`refHint`,
 *  the PR's head branch). A thread whose sticky binding is another branch
 *  (the binding wins over a differing refHint) can never have that
 *  branch's tip at the PR head, so the sha is dropped rather than forcing a
 *  fetch on every attach of a permanently mismatched thread. No refHint (a
 *  follow-up that named no branch) → the caller means the bound ref. */
export function wantShaForBinding(input: {
  boundRef: string;
  refHint: string | null;
  wantSha: string | null;
}): string | null {
  if (input.refHint !== null && input.refHint !== input.boundRef) return null;
  return input.wantSha;
}

/** Whether the attach must fetch the mirror before cloning the thread tree.
 *  - the ref is not in the mirror → fetch (the only pre-existing rule);
 *  - a `wantSha` was named and the mirror's tip of the ref is not that
 *    commit → fetch;
 *  - otherwise the mirror is good enough as it stands.
 *  A fetch that STILL leaves the tip elsewhere (a push racing this attach, or
 *  a force-push) is not this function's concern: the attach proceeds on the
 *  fetched tip and reports it, and the reviewed-head guard decides what a
 *  review of it may do. */
export function mirrorNeedsFetch(input: { refExists: boolean; mirrorSha?: string; wantSha: string | null }): boolean {
  if (!input.refExists) return true;
  if (input.wantSha === null) return false;
  return input.mirrorSha !== input.wantSha;
}
