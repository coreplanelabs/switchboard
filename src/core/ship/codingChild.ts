// The coding child's prompt block (docs/reference/specs/agent-ship.md item 13):
// where a unit's contract enters a coding round of the ship pipeline. The child
// itself is an ordinary `dispatch()` run the plan runner's spawn route starts as
// the requesting user (coordinator/briefs.ts composes the turn). A review's
// findings are no block of this module: the runner dispatches them into the
// unit thread as a message of their own (item 7), so the coding session there
// continues with them.

import type { ChatMessage } from "../../providers/types.js";

/** The unit contract enters the child's FIRST user turn (docs/reference/specs/agent-ship.md
 *  item 13): appended as its own text part after the request's text, so the
 *  human's words stay first and the block is the same bytes the review child
 *  reads after its REVIEW TARGET block. A transcript with no user turn gets one. */
export function withContractInFirstUserTurn(messages: ChatMessage[], block: string): ChatMessage[] {
  const at = messages.findIndex((m) => m.role === "user");
  if (at < 0) return [...messages, { role: "user", content: [{ type: "text", text: block }] }];
  return messages.map((m, i) => (i === at ? { ...m, content: [...m.content, { type: "text", text: block }] } : m));
}
