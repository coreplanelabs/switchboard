// The hand-back line's one prefix (docs/decisions/0039-the-front-door-writes-nothing-from-prose-and-never-routes-twice.md):
// a routed `effect: write` command is answered `To run this: <chat form>` and
// nothing runs; the paste is the confirmation. A pure module of its own so the
// web bundle can recognize the line (the home page fills its composer with the
// command, docs/reference/specs/web-chat.md) without importing the route stage.
export const HAND_BACK_PREFIX = "To run this:";
