// Verbosity: how much of itself the bot says in the conversation
// (docs/reference/specs/routing-and-config.md item 28). Three levels on the
// log-level pattern — each level shows everything the ones below it show:
//
//   quiet    (default)  only what needs the person: answers, results, verdicts,
//                       refusals, questions, and the card's own progress.
//   verbose             plus every acknowledgement of what the system is doing
//                       for the person — a follow-up folded into a live run,
//                       a plan handed to the runner, the workspace the run is
//                       on, a budget clipped by a boundary.
//   debug               plus what an operator debugging the bot reads — the
//                       router's reason, the ledger's word on the run.
//
// A config dimension resolved through the same layers as `effort` (item 2):
// a `verbosity:<level>` directive on the request (sticky in the thread from
// the user's turns, item 3) > the user's scope > the channel's > `defaults`.
// Nothing here decides WHAT a message is; each message site names the level
// it belongs to, and the spec's table is the one list of them.

export const VERBOSITY_LEVELS = ["quiet", "verbose", "debug"] as const;
export type Verbosity = (typeof VERBOSITY_LEVELS)[number];

/** The level a request runs at when no layer sets one. */
export const DEFAULT_VERBOSITY: Verbosity = "quiet";

/** The valid levels, for error messages: `quiet, verbose, debug`. */
export const VERBOSITY_LEVELS_HINT = VERBOSITY_LEVELS.join(", ");

export function isVerbosity(value: unknown): value is Verbosity {
  return typeof value === "string" && (VERBOSITY_LEVELS as readonly string[]).includes(value);
}

/** Whether a message that belongs at `floor` is shown at `level`: a level
 *  shows its own messages and every lower level's. */
export function shows(level: Verbosity, floor: Verbosity): boolean {
  return VERBOSITY_LEVELS.indexOf(level) >= VERBOSITY_LEVELS.indexOf(floor);
}

/** The level for a request through the layers, most specific first; the
 *  default when no layer sets one. */
export function resolveVerbosity(layers: {
  request?: Verbosity;
  user?: Verbosity;
  channel?: Verbosity;
  defaults?: Verbosity;
}): Verbosity {
  return layers.request ?? layers.user ?? layers.channel ?? layers.defaults ?? DEFAULT_VERBOSITY;
}
