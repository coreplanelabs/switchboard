// Deterministic "post the review back to the PR" decision.
//
// A review of a resolved PR posts its findings to that PR by default — the user
// never has to add "and post to the PR". The decision is made by code here (not
// by the model remembering), so it is uniform across the sandbox and resident
// paths: the dispatcher runs the post-step in the bot process via the GitHub
// REST API with the App token (AGENTS.md invariant 5 — no `gh` shell-out from
// the bot), never inside the sandbox/resident. Posting is a PR *comment* only,
// never an approval or a merge.

/** Where a review comment should land: `owner/name` + PR number. */
export interface ReviewPostTarget {
  repo: string;
  number: number;
}

// Opt-out phrasings: an explicit "don't post" / "slack only" intent in the
// request suppresses the GitHub post (Slack still gets the review). Deliberately
// small and predictable — a negation right before "post"/"comment", the
// "slack only" phrase, or a directive-style `post:off` token.
const OPT_OUT_PATTERNS: RegExp[] = [
  /\bslack[\s-]?only\b/i,
  /\bpost\s*[:=]\s*(?:off|no|false|none)\b/i,
  /\bno[\s-]post\b/i,
  /\b(?:don['’]?t|do\s+not|never|skip|without)\s+(?:\w+\s+){0,2}?(?:post|comment)(?:ing|s)?\b/i,
  /\bno\s+need\s+to\s+(?:post|comment)\b/i,
];

/** True when the request explicitly asks NOT to post the review to GitHub. */
export function reviewPostOptedOut(text: string): boolean {
  return OPT_OUT_PATTERNS.some((re) => re.test(text));
}

/**
 * The default post decision: a `review` run against a resolved PR posts to that
 * PR unless the request opted out. Returns the target, or null when posting
 * must not happen — a non-review agent, no resolved PR (repo-only or pasted
 * code), or an explicit opt-out. Callers treat null as "Slack reply only".
 */
export function decideReviewPost(input: {
  agentName: string;
  repo?: string;
  pr?: number;
  requestText: string;
}): ReviewPostTarget | null {
  if (!reviewPostIntended(input)) return null;
  if (!input.repo || input.pr === undefined) return null;
  return { repo: input.repo, number: input.pr };
}

/**
 * Is this a run whose verdict is MEANT to be posted to a PR — a `review` run
 * the request did not opt out of? The one place that knows which agent posts
 * and what an opt-out looks like: `decideReviewPost` (after the run) and the
 * dispatcher's unknown-head refusal (before it, agent-review.md item 11) both
 * ask here, so a review-like agent or a new opt-out phrasing changes both at once.
 */
export function reviewPostIntended(input: { agentName: string; requestText: string }): boolean {
  return input.agentName === "review" && !reviewPostOptedOut(input.requestText);
}
