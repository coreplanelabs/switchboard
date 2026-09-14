// The review child's prompt block (docs/reference/specs/agent-ship.md item 5):
// the one user turn a review round of the ship pipeline is given. The child
// itself is an ordinary `dispatch()` review run the plan runner's spawn route
// starts as the requesting user, pinned to the pull request's head like any
// review (coordinator/briefs.ts composes the turn from this); a re-review round
// carries the previous round's findings and the dispositions the coding run
// recorded against them.

import { formatFinding, type Finding, type FindingDisposition } from "../reviewVerdict.js";

/** The review child's one user turn. Re-review rounds carry the prior findings
 *  and the coding run's dispositions as the runner matched them (`dropped`: the
 *  ids the run named that the review never issued); the `re-review-delta` skill
 *  (scoped to the review agent) narrows READING only — the verdict still covers
 *  the full diff. */
export function buildShipReviewTurn(input: {
  where: string;
  round: number;
  headSha?: string;
  prior?: { findings: Finding[]; dispositions: FindingDisposition[]; dropped?: string[] };
}): string {
  const at = input.headSha ? ` at head \`${input.headSha}\`` : "";
  if (input.round <= 1 || !input.prior) {
    return `Review pull request ${input.where}${at}. Submit your verdict with findings via submit_verdict before your final message.`;
  }
  const findings = input.prior.findings.map(formatFinding).join("\n") || "(none recorded)";
  const dispositions =
    input.prior.dispositions.map((d) => `${d.findingId}: ${d.disposition}${d.note ? ` — ${d.note}` : ""}`).join("\n") ||
    "(none recorded)";
  const dropped =
    input.prior.dropped !== undefined && input.prior.dropped.length > 0
      ? `\nDispositions naming no finding of the previous round (dropped): ${input.prior.dropped.join(", ")}`
      : "";
  return (
    `Re-review pull request ${input.where}${at} — review round ${input.round} of this ship pipeline. ` +
    `Load the \`re-review-delta\` skill: narrow your READING to the delta since the previously reviewed head and verify each prior finding's disposition, ` +
    `but your verdict still covers the full diff against base. Carry every unresolved prior finding forward under its existing id.\n\n` +
    `Previous round's findings:\n${findings}\n\nFix round's dispositions:\n${dispositions}${dropped}`
  );
}
