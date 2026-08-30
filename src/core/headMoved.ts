// Head-moved note for the review post-step (features/agent-review.md item 10).
//
// A review is posted pinned to the head it examined (`RepoContext.headSha`);
// if a push landed while the run was in flight, the PR head is now a different
// commit, the org's auto-approve workflow will skip the pinned review as stale
// (by design — never an approval of unreviewed code), and GitHub shows it
// against an outdated commit. All correct, all silent: the thread only sees
// "review posted". This note makes the situation visible where the user is
// looking, with the one action that resolves it (re-request).
//
// Pure: given the reviewed head and the PR's current head, decide whether a
// note is due and build it. The dispatcher fetches the current head AFTER the
// post (one REST GET, best-effort — an unknown current head means no note,
// never a false alarm).

/** The thread note when the PR head moved during the run; undefined when the
 *  current head is unknown or is the reviewed commit. Prefix-tolerant so a
 *  7-char and a 40-char form of the same commit compare equal — in production
 *  both sides are 40-hex (`RepoContext.headSha` and `currentPrHeadSha` share
 *  one validator), so the tolerance only matters for injected fetchers; its
 *  one theoretical miss (a 7-char collision hiding a move) errs toward silence,
 *  the side this note is biased to. */
export function headMovedNote(input: { where: string; reviewed: string; current?: string }): string | undefined {
  const reviewed = input.reviewed.trim().toLowerCase();
  const current = input.current?.trim().toLowerCase();
  if (!current || !reviewed) return undefined;
  const n = Math.min(reviewed.length, current.length);
  if (n >= 7 && reviewed.slice(0, n) === current.slice(0, n)) return undefined;
  const r = reviewed.slice(0, 7);
  const c = current.slice(0, 7);
  return (
    `ℹ️ ${input.where} moved during the run: reviewed ${r}, head is now ${c}. ` +
    `The review was posted pinned to ${r} and will not auto-approve — re-request to review ${c}.`
  );
}
