// The hand-back line's one prefix (docs/decisions/0039-the-front-door-writes-nothing-from-prose-and-never-routes-twice.md):
// a routed `effect: write` command is answered `To run this: <chat form>` and
// nothing runs; the paste is the confirmation. A pure module of its own so the
// web bundle can recognize the line (the home page fills its composer with the
// command, docs/reference/specs/web-chat.md) without importing the route stage.
export const HAND_BACK_PREFIX = "To run this:";

/** The plain text form of a handed-back line — the prefix, then the line as
 *  one code span — for the surfaces where no channel can show a click (the
 *  CLI, HTTP): the operator's hand-backs render through this one function
 *  (routing-and-config item 29), never a per-site template. */
export function renderHandBackLine(line: string): string {
  return `${HAND_BACK_PREFIX}\n\`${line}\``;
}
