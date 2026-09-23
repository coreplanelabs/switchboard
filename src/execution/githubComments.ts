import { resolveGithubToken } from "./githubApp.js";
import { redactAndCap } from "../core/redact.js";
import { MAX_REVIEW_POST_CODE_POINTS } from "../core/reviewVerdict.js";

// Posting a review back to a PR. The bot process posts the comment
// itself over the GitHub REST API with the App installation token — never a
// `gh` shell-out and never from inside the sandbox/resident (AGENTS.md
// invariant 5). The App needs `pull_requests:write`. This is the SAME
// REST-with-App-token path repoContext.ts uses to resolve PR head refs, so it
// works uniformly for sandbox and resident runs: the post happens in the bot,
// after the run, regardless of where the run executed.
//
// The post is a pull-request REVIEW with `event: "COMMENT"`
// (`POST /repos/{repo}/pulls/{n}/reviews`) — a comment-state review, never an
// APPROVE or REQUEST_CHANGES event, never a merge. A review (rather than an
// issue comment) is what the org's auto-approve workflow listens to
// (`pull_request_review` → state `commented`, body starting with `LGTM:`), and
// it carries `commit_id`, which lets that workflow refuse to approve a review
// pinned to a commit that is no longer the PR head.

// GitHub rejects a review body over 65,536 characters. reviewVerdict.ts fits
// only the prose while preserving every structured verdict section. This
// publication boundary refuses anything still oversized: clipping an assembled
// review could retain `LGTM:` while deleting the authoritative typed marker.

export interface ReviewCommentTarget {
  /** `owner/name` */
  repo: string;
  /** PR number */
  number: number;
  /** Head SHA the review looked at; pins the review so a later push cannot
   *  inherit its verdict. Omitted → GitHub pins to the head at post time. */
  commitId?: string;
}

/**
 * Post a plain comment to a PR. Throws on missing credential or a non-2xx
 * response so the caller can log a receipt/failure; callers treat it as
 * best-effort (the Slack reply is the primary delivery).
 */
export async function postReviewComment(target: ReviewCommentTarget, body: string): Promise<void> {
  const codePoints = [...body].length;
  if (codePoints > MAX_REVIEW_POST_CODE_POINTS) {
    throw new Error(
      `PR review body is ${codePoints} Unicode code points, over the ${MAX_REVIEW_POST_CODE_POINTS} limit; refusing to clip the structured verdict`,
    );
  }
  const token = await resolveGithubToken();
  if (!token) {
    throw new Error("no GitHub credential available to post the PR review comment");
  }
  const payload: Record<string, string> = { event: "COMMENT", body };
  if (target.commitId) payload.commit_id = target.commitId;
  const res = await fetch(`https://api.github.com/repos/${target.repo}/pulls/${target.number}/reviews`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "switchboard",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PR comment post failed: HTTP ${res.status} ${redactAndCap(text, 300)}`);
  }
}
