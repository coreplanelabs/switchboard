// Digest-coverage guard for the review post-step (docs/reference/specs/agent-review.md item 15).
//
// The reviewed-head guard (reviewedHead.ts) proves the review is of the PR's
// head commit; it says nothing about how much of that commit's change the
// review actually read. A review agent handed a digest that undersold the
// diff — the tool had distilled the first 120k characters of a unified diff
// and counted 13 of 41 files — trusted it and approved. This guard asks the
// other question: did the digest the agent oriented with cover the change
// GitHub says the PR carries? When it covered LESS, the verdict is not posted.
//
// Only under-coverage refuses. A local base that lags GitHub's (a mirror not
// yet fetched to the newest default branch) makes the merge-base range wider
// than the PR — the digest then covers MORE, and the review read every file of
// the PR plus some of the base's; that is noise, not a hole.
//
// Tolerances absorb what legitimately differs between git's listing and
// GitHub's PR object — rename detection thresholds, binary files — and
// nothing like 13 of 41.

import type { DigestReport } from "./diffDigest.js";

/** The PR's own size as GitHub reports it (`GET /pulls/{n}`: `changed_files`,
 *  `additions`, `deletions`). */
export interface PrSize {
  changedFiles: number;
  additions: number;
  deletions: number;
}

export type CoverageCheck = { ok: true; compared: boolean } | { ok: false; reason: string };

/** Files: one file plus 5 % of the PR's. Lines: 50 plus 25 % of the PR's. */
export function coverageTolerance(pr: PrSize): { files: number; lines: number } {
  return {
    files: 1 + Math.floor(pr.changedFiles * 0.05),
    lines: 50 + Math.floor((pr.additions + pr.deletions) * 0.25),
  };
}

/**
 * Decide whether the digest the review oriented with covered the PR.
 * - no digest (the agent never called the tool, or the run was resumed past
 *   it) → nothing to compare: ok, `compared: false`;
 * - a digest that could not state its totals (its own output was cut) →
 *   refused: the review may not have read the whole change;
 * - no PR size (GitHub's object lagged the head, or the fields were missing)
 *   → nothing to compare against: ok, `compared: false`;
 * - fewer files, or fewer changed lines, than the PR beyond the tolerance →
 *   refused, naming both sides.
 */
export function checkDigestCoverage(input: {
  digest: DigestReport | undefined;
  pr: PrSize | undefined;
}): CoverageCheck {
  const { digest, pr } = input;
  if (!digest) return { ok: true, compared: false };
  if (!digest.complete) {
    return {
      ok: false,
      reason: `the diff digest could not state its totals (${digest.reason}) — the review may not have read the whole change`,
    };
  }
  if (!pr) return { ok: true, compared: false };
  const tol = coverageTolerance(pr);
  const filesShort = pr.changedFiles - digest.totals.files > tol.files;
  const prLines = pr.additions + pr.deletions;
  const digestLines = digest.totals.additions + digest.totals.deletions;
  const linesShort = prLines - digestLines > tol.lines;
  if (!filesShort && !linesShort) return { ok: true, compared: true };
  return {
    ok: false,
    reason:
      `digest covered ${digest.totals.files} of ${pr.changedFiles} files ` +
      `(+${digest.totals.additions}/−${digest.totals.deletions} against the PR's +${pr.additions}/−${pr.deletions}) ` +
      "— the review may not have read the whole change",
  };
}
