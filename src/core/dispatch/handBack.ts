// The typed-form refusal's one prefix (docs/decisions/0039-the-front-door-writes-nothing-from-prose-and-never-routes-twice.md,
// as amended; record 0069): on a TYPED surface — the CLI, HTTP — a routed
// `effect: write` command is answered `To run this: <chat form>` and nothing
// runs; typing the line is that surface's native act. No chat surface renders
// this prefix: a chat surface is offered record 0044's click, and a mint
// failure there is a refusal naming why. A pure module of its own so the one
// prefix has one home.
export const HAND_BACK_PREFIX = "To run this:";

/** The plain text form of a typed surface's refusal — the prefix, then the
 *  line as one code span — for the surfaces where no channel can show a click
 *  (the CLI, HTTP): the operator's hand-backs render through this one function
 *  (routing-and-config item 29), never a per-site template. */
export function renderHandBackLine(line: string): string {
  return `${HAND_BACK_PREFIX}\n\`${line}\``;
}
