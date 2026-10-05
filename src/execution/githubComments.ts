import { resolveGithubToken } from "./githubApp.js";
import type { GithubWriteResult } from "./githubPulls.js";
import { isPublicationRepo } from "../core/branchPublication.js";
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
 * Post only a pinned review. A positive exact native receipt credits acceptance;
 * ambiguous transport or response bytes retain an uncertain original write.
 */
export async function postReviewComment(target: ReviewCommentTarget, body: string): Promise<GithubWriteResult> {
  if (
    !isPublicationRepo(target.repo) ||
    !Number.isSafeInteger(target.number) ||
    target.number < 1 ||
    typeof target.commitId !== "string" ||
    !/^[a-f0-9]{40}$/.test(target.commitId) ||
    [...body].length > MAX_REVIEW_POST_CODE_POINTS
  )
    return { state: "refused" };
  const token = await resolveGithubToken();
  if (!token) return { state: "refused" };
  const payload: Record<string, string> = { event: "COMMENT", body };
  if (target.commitId) payload.commit_id = target.commitId;
  try {
    const res = await fetch(`https://api.github.com/repos/${target.repo}/pulls/${target.number}/reviews`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "switchboard",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok)
      return res.status >= 400 && res.status < 500 && res.status !== 408
        ? { state: "refused", status: res.status }
        : { state: "uncertain" };
    const receipt: unknown = await res.json();
    if (!receipt || typeof receipt !== "object") return { state: "uncertain" };
    const r = receipt as Record<string, unknown>;
    return Number.isSafeInteger(r.id) &&
      (r.id as number) > 0 &&
      r.state === "COMMENTED" &&
      r.body === body &&
      r.commit_id === target.commitId &&
      typeof r.pull_request_url === "string" &&
      r.pull_request_url.toLowerCase() ===
        `https://api.github.com/repos/${target.repo.toLowerCase()}/pulls/${target.number}`
      ? { state: "accepted" }
      : { state: "uncertain" };
  } catch {
    return { state: "uncertain" };
  }
}
