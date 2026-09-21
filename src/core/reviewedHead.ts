// Reviewed-head guard for the review post-step (docs/reference/specs/agent-review.md item 8).
//
// A review may only be posted to a PR when the commit the agent ACTUALLY
// reviewed is the PR head resolved for the run (`RepoContext.headSha`). The
// failure this guards against: the agent's own worktree is on the right
// branch, but it fetches and checks out another PR's branch because the PR
// body references it, reviews that, calls `submit_verdict approve`, and the
// deterministic post-step puts `LGTM:` on the PR under review — which an
// auto-approve workflow then approves. Every layer has done its job except the
// one that asks "is this review OF this PR?".
//
// Two sources for the reviewed head, in authority order:
//   observed — `git rev-parse HEAD` run by the dispatcher in the run's
//              workspace AFTER the model finished and BEFORE the workspace is
//              released (a resident worktree; authoritative). Absent when the
//              cwd is not a git repo (the cold sandbox's workspace root — the
//              clone lives in a subdirectory the agent chose).
//   reported — the `head` the agent passed to `submit_verdict` (it is told to
//              run `git rev-parse HEAD` in the checkout it reviewed). Consulted
//              only when nothing was observed; an observed mismatch is never
//              rescued by a matching report.
//
// Fail-closed: unknown PR head, or no head from either source → no post.

export type HeadCheck = { ok: true; head: string; source: "observed" | "reported" } | { ok: false; reason: string };

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA_PREFIX = /^[0-9a-f]{7,40}$/;

/** Normalize a reported/observed head: trimmed, lowercased, 7–40 hex; else undefined. */
export function normalizeHead(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const h = value.trim().toLowerCase();
  return SHA_PREFIX.test(h) ? h : undefined;
}

/** The 40-hex commit from `git rev-parse HEAD` output, or undefined when the
 *  command failed (not a git repo, git missing) or printed nothing usable. */
export function parseRevParseOutput(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim().toLowerCase();
    if (FULL_SHA.test(t)) return t;
  }
  return undefined;
}

/** Two normalized heads name the same commit when one is a ≥7-hex prefix of
 *  the other (the dispatcher's pre-run attach check reuses this). */
export function sameCommit(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}

/** A mismatch sentence that cannot print two identical accepted-looking
 * prefixes: it names the authoritative source, both values and their first
 * differing hex position. */
function mismatchReason(source: "workspace-observed" | "model-reported", reviewed: string, expected: string): string {
  const compared = Math.min(reviewed.length, expected.length);
  let at = 0;
  while (at < compared && reviewed[at] === expected[at]) at += 1;
  const divergence =
    at < compared
      ? `they first differ at hex ${at + 1} (${reviewed[at]} ≠ ${expected[at]})`
      : `the ${reviewed.length}-hex reviewed value ends before the ${expected.length}-hex PR head`;
  return `${source} reviewed head ${reviewed} is not the PR head ${expected}; ${divergence}`;
}

/**
 * Decide whether the reviewed head is the PR head. `expected` is the PR head
 * from repo resolution; `observed` the dispatcher's own `git rev-parse HEAD`
 * (40-hex or undefined); `reported` whatever the agent passed to submit_verdict.
 */
export function checkReviewedHead(input: { expected?: string; observed?: string; reported?: string }): HeadCheck {
  const expected = normalizeHead(input.expected);
  if (!expected) return { ok: false, reason: "PR head unknown at resolution time — cannot verify what was reviewed" };
  const observed = normalizeHead(input.observed);
  if (observed) {
    return sameCommit(observed, expected)
      ? { ok: true, head: observed, source: "observed" }
      : { ok: false, reason: mismatchReason("workspace-observed", observed, expected) };
  }
  const reported = normalizeHead(input.reported);
  if (!reported)
    return {
      ok: false,
      reason: "reviewed head unknown — the workspace HEAD could not be read and no head was reported with the verdict",
    };
  return sameCommit(reported, expected)
    ? { ok: true, head: reported, source: "reported" }
    : { ok: false, reason: mismatchReason("model-reported", reported, expected) };
}
