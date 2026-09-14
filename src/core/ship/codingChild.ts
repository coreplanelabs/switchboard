// The coding child's prompt blocks (docs/reference/specs/agent-ship.md items 7
// and 13): what a coding round of the ship pipeline is told beyond a plain
// coding run. The child itself is an ordinary `dispatch()` run the plan
// runner's spawn route starts as the requesting user (coordinator/briefs.ts
// composes the turn from these); the fix turn carries the review's findings
// and the loop contract, and the unit's contract enters the first user turn.

import type { ChatMessage } from "../../providers/types.js";
import { formatFinding, type Finding } from "../reviewVerdict.js";

/** The fix round's one user turn: the findings payload verbatim (ids, severity,
 *  file:line, title) plus the review prose, and the loop contract — every
 *  severity gets a disposition, description resubmitted, branch repushed. */
export function buildShipFixTurn(input: { where: string; findings: Finding[]; review: string }): string {
  const findings =
    input.findings.map(formatFinding).join("\n") || "(the review listed no structured findings — address its prose)";
  return (
    `The review of ${input.where} requested changes. Load the \`address-review-findings\` skill and address EVERY finding below, nits included: ` +
    `record one disposition per finding with submit_dispositions (fixed|declined, with a note), squash to coherent commits, ` +
    `resubmit the PR description with submit_pr_description, and push the branch. Never merge and never approve.\n\n` +
    `Findings:\n${findings}\n\nReview:\n${input.review}`
  );
}

/** The unit contract enters the child's FIRST user turn (docs/reference/specs/agent-ship.md
 *  item 13): appended as its own text part after the request's text, so the
 *  human's words stay first and the block is the same bytes the review child
 *  reads after its REVIEW TARGET block. A transcript with no user turn gets one. */
export function withContractInFirstUserTurn(messages: ChatMessage[], block: string): ChatMessage[] {
  const at = messages.findIndex((m) => m.role === "user");
  if (at < 0) return [...messages, { role: "user", content: [{ type: "text", text: block }] }];
  return messages.map((m, i) => (i === at ? { ...m, content: [...m.content, { type: "text", text: block }] } : m));
}
