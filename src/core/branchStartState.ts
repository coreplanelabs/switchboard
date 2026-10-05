/** One exact `(name, email)` pair — the whole identity the rewrite judges. */
export interface IdentityPair {
  name: string;
  email: string;
}

/** One commit of the branch's start state: what was on the branch and not on
 *  its base when the run attached, before the run pushed anything. */
export interface StartCommit {
  sha: string;
  author: IdentityPair;
  /** The author date as GitHub reports it — part of the fingerprint. */
  date: string;
  message: string;
}

/** The branch's start state as the dispatch recorded it at attach or clone:
 *  known (possibly empty — a new branch, or a branch equal to its base);
 *  bounded (`boundary`) — the branch's head before the run's first push, as
 *  the push's own status line named it (possibly abbreviated): everything at
 *  or below that commit in the compare is start state the run did not create
 *  and is never rewritten, and a range that no longer holds it is unreadable;
 *  or unknown, on which the rewrite answers unreadable. `reason` says why it
 *  is unknown when the reader knows more than "the read failed" — e.g. no
 *  read was ever attempted because the dispatch resolved no repository or
 *  branch at attach — so the refusal never claims a read that never ran. */
export type BranchStartState =
  { kind: "known"; commits: StartCommit[] } | { kind: "boundary"; sha: string } | { kind: "unknown"; reason?: string };
