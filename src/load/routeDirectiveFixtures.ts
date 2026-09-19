// The directive words of `load:route` (docs/reference/specs/load-harness.md
// item 17): the six words a request may carry inline — ported from the parse's
// own tests (src/directives.test.ts) — each in first position and
// mid-sentence, each with the bind the word's sentence meant. The directive
// row holds the router to reading the words as words: the sentence around the
// token decides the bind, and the token itself derails nothing. (`renewals:`
// is not on the set: it becomes an argument of the plan bind, not a word the
// router reads.) Neutral names only (acme/…): the public tree carries no
// private references.

/** The six words, in the parse's order. */
export const DIRECTIVE_WORDS = ["agent", "model", "effort", "budget", "severity", "verbosity"] as const;

/** One example: the text as typed with its directive token intact, which word
 *  it carries and where, and the presets that count as the bind the word's
 *  sentence meant. */
export interface RouteDirectiveFixture {
  id: string;
  word: (typeof DIRECTIVE_WORDS)[number];
  position: "first" | "mid";
  text: string;
  presets: readonly string[];
}

const d = (
  id: string,
  word: RouteDirectiveFixture["word"],
  position: RouteDirectiveFixture["position"],
  text: string,
  presets: readonly string[],
): RouteDirectiveFixture => ({ id, word, position, text, presets });

export const ROUTE_DIRECTIVE_FIXTURES: readonly RouteDirectiveFixture[] = [
  d("da1", "agent", "first", "agent:review look at the failing test on acme/api pull 12", ["review"]),
  d("da2", "agent", "mid", "please agent:ship fix the bug in acme/api now", ["ship"]),
  d("dm1", "model", "first", "model:openai/gpt-5 what changed in acme/api this week?", ["research", "general"]),
  d("dm2", "model", "mid", "summarize this thread model:anthropic/claude-opus-5 please", ["general"]),
  d("de1", "effort", "first", "effort:low fix the flaky test in acme/web", ["ship"]),
  d("de2", "effort", "mid", "think hard effort:max and fix the race in the run loop", ["ship"]),
  d("db1", "budget", "first", "budget:30 the ci is red on acme/api, make it pass", ["ship"]),
  d("db2", "budget", "mid", "fix the lint on main budget:15 and nothing else", ["ship"]),
  d("ds1", "severity", "first", "severity:minor ship the retry fix for acme/api", ["ship"]),
  d("ds2", "severity", "mid", "ship the config cleanup severity:major in acme/web", ["ship"]),
  d("dv1", "verbosity", "first", "verbosity:quiet how did the last deploy go?", ["general"]),
  d("dv2", "verbosity", "mid", "give me a short status of the fleet verbosity:debug from now on", ["general"]),
];
