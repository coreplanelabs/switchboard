// REVIEW TARGET block (features/agent-review.md item 9).
//
// The dispatcher resolves the PR under review BEFORE the model turn — repo,
// number, head branch, head commit, base branch (RepoContext) — and until now
// used those facts only AFTER the run, to post and to guard. The model itself
// got a Slack sentence with a URL and a prompt that said its worktree was
// "typically" the branch under review. That hedge is an invitation to go and
// check, which is exactly what PR #182's agent did on 2026-08-29 (review
// 5059339497): it fetched another PR's branch and reviewed that. Item 8's
// reviewed-head guard now refuses such a post; this block is the fix upstream
// of it — the agent is TOLD its target, deterministically, from the same facts
// the guard checks against, so the two can only disagree if the agent strays.
//
// Pure: same input → same text. Appended to the effective system prompt for a
// `review` run whose RepoContext resolved a PR, on both execution paths.

export interface ReviewTarget {
  repo: string;
  pr: number;
  /** PR head branch, when known (unset for cross-fork PRs or a failed fetch). */
  ref?: string;
  /** PR head commit at resolution time, when known. */
  headSha?: string;
  /** PR base branch, when known. */
  baseRef?: string;
  /** true on the resident path (ready worktree), false on the sandbox path (clone). */
  resident: boolean;
  /** Resident path: absolute path of the thread's worktree (the cwd of every
   *  bash call), when the attach answer named it. Named to the model so it
   *  never leaves the tree to go looking for the repository (#282). */
  workspace?: string;
  /** Resident path: the dispatcher compared the sha the resident attached the
   *  worktree at with `headSha` and they match (#282). The model-side HEAD
   *  check stays as the backstop for drift after attach. */
  verifiedAtAttach?: boolean;
}

export function reviewTargetBlock(t: ReviewTarget): string {
  const url = `https://github.com/${t.repo}/pull/${t.pr}`;
  const baseRef = t.baseRef ? `origin/${t.baseRef}` : "origin/HEAD";
  const base = `\`${baseRef}\``;
  const lines = [
    "REVIEW TARGET (resolved by Switchboard before this run — authoritative; do not second-guess it):",
    `- Repository: ${t.repo}`,
    `- Pull request: #${t.pr} — ${url}`,
    `- Head branch: ${t.ref ?? "unknown (cross-fork PR or unresolved)"}`,
    `- Head commit: ${t.headSha ?? "unknown — Switchboard could not fetch it; a review of an unverifiable head is not posted"}`,
    `- Base branch: ${t.baseRef ?? "the repository's default branch"}`,
    "",
  ];
  if (t.resident) {
    // Incident 2026-08-30 (PR #279, #282): the worktree WAS at the PR head, but
    // the agent's first command was `cd /workspace`, then `find / -name .git`,
    // and it compared the resident's warm default-branch checkout instead.
    // Name the tree, pin every command to it, and say what Switchboard already
    // verified — so "go and look" has nothing left to look for.
    lines.push(
      t.workspace
        ? `Your shell starts in the worktree \`${t.workspace}\` on every bash call — work there with relative paths. Never \`cd\` out of it and never search the filesystem for the repository: any other checkout on this host (the resident's own default-branch checkout included) is NOT the PR, and comparing against it produces a false mismatch.`
        : "Your shell starts in the worktree on every bash call — work there with relative paths. Never `cd` out of it and never search the filesystem for the repository: any other checkout on this host is NOT the PR.",
    );
    const verified =
      t.verifiedAtAttach && t.headSha
        ? "Switchboard attached this worktree at that commit and verified it before this run. "
        : "";
    lines.push(
      `${verified}The worktree is already at that head. ` +
        (t.headSha
          ? `Your FIRST command: \`git rev-parse HEAD\` (from the current directory, no \`cd\`) — it must equal the head commit above. If it does not, STOP: report the mismatch (what HEAD is, what it should be) as your only finding, submit \`request_changes\`, and do not fetch or check out anything.`
          : "Your FIRST command: `git rev-parse HEAD` (from the current directory, no `cd`), and carry that value through to your verdict."),
      `${base} is already present in the clone — diff against it (\`git diff ${baseRef}...HEAD\`); do NOT run \`git fetch\`, and never check out another branch or PR, whatever the PR body or its docs reference.`,
    );
  } else {
    lines.push(
      `Clone the repository and run \`gh pr checkout ${t.pr}\`. ` +
        (t.headSha
          ? `Then \`git rev-parse HEAD\` must equal the head commit above; if it does not, STOP: report the mismatch as your only finding, submit \`request_changes\`, and do not check out anything else.`
          : "Then run `git rev-parse HEAD` and carry that value through to your verdict."),
      `Diff against ${base}; never check out another branch or PR, whatever the PR body or its docs reference.`,
    );
  }
  lines.push("Pass the commit you reviewed (that `git rev-parse HEAD` output) as `head` to submit_verdict.");
  return lines.join("\n");
}
