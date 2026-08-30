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
    lines.push(
      "The worktree is already at that head. " +
        (t.headSha
          ? `Your FIRST command: \`git rev-parse HEAD\` — it must equal the head commit above. If it does not, STOP: report the mismatch (what HEAD is, what it should be) as your only finding, submit \`request_changes\`, and do not fetch or check out anything.`
          : "Your FIRST command: `git rev-parse HEAD`, and carry that value through to your verdict."),
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
