// The checked-in imperative set of `load:route` (docs/reference/specs/
// load-harness.md item 17): the orders a person types into a channel or
// thread that the router must read as a request to change code (the table's
// write preset is `ship`: a routed write ask runs the coding → review loop,
// its generated plan merged by a person), the read-only look-alikes that must
// never reach a write preset, and the review-shaped asks that are a review,
// not an order. Three shapes of order: twenty terse imperatives — one short
// line, no file, cause or repository named — three spec-shaped asks — longer,
// on a named repository, saying how something should behave and asking for it
// to be done, one of them the production ask that routed to `explore` because
// it named no verb like "fix" — and two that point at a conversation whose
// quoted thread carries the task ("in <repo> ship <thread link>", the
// production ask that routed to `general` because the link read as something
// to read first). Eight decoys: five read-only asks about the same failures,
// a question about the repository in the spec-shaped voice, an ask that only a
// sandbox answers (a timing) and a read-only ask about a linked thread. Six
// review-shaped asks that name a pull request, one with a note about the
// request's own history ("retry at head …: the run died"), the shape the
// replay routed to `ship` once `ship` held the write seat. The set exists
// because the replay over the run history has almost no such requests: each
// shape here is a router miss production found once. Neutral names only
// (acme/…, PR NNNN, a permalink on acme's own workspace): the public tree
// carries no private references.

/** One example: the text as typed and the presets that count as a right
 *  answer — the table's write preset (`ship`) for an imperative, a read-only
 *  preset that answers a question for a decoy, the review preset for a
 *  review-shaped ask. */
export interface RouteImperativeFixture {
  id: string;
  kind: "imperative" | "decoy" | "review";
  text: string;
  presets: readonly string[];
  /** How many conversations the text links that the bot could quote (record
   *  0037) — what the route stage counts off the request's own URLs, no
   *  adapter asked, and puts on the router's user turn as a fact; the replay
   *  hands the same count to `route()`. Absent: the text links none. */
  references?: number;
}

const SHIP = ["ship"];
const READ_ONLY = ["research", "general"];
const REVIEW = ["review"];
/** A permalink in acme's own workspace, the shape the Slack reader parses. */
const THREAD = "https://acme.slack.com/archives/C1ABCDEF/p1700000000000000";

export const ROUTE_IMPERATIVE_FIXTURES: readonly RouteImperativeFixture[] = [
  // Imperatives: an order to change code or repair a failure, terse.
  { id: "i01", kind: "imperative", text: "looks like the ci failed, fix it", presets: SHIP },
  { id: "i02", kind: "imperative", text: "fix it", presets: SHIP },
  { id: "i03", kind: "imperative", text: "make it pass", presets: SHIP },
  { id: "i04", kind: "imperative", text: "make the tests green", presets: SHIP },
  { id: "i05", kind: "imperative", text: "ci is red again, make it pass", presets: SHIP },
  { id: "i06", kind: "imperative", text: "add a --json flag to runs list", presets: SHIP },
  { id: "i07", kind: "imperative", text: "rename formatLabel to formatLine", presets: SHIP },
  { id: "i08", kind: "imperative", text: "bump pnpm to 10.18", presets: SHIP },
  { id: "i09", kind: "imperative", text: "the lint is failing on main, fix", presets: SHIP },
  { id: "i10", kind: "imperative", text: "typecheck broke, fix it please", presets: SHIP },
  { id: "i11", kind: "imperative", text: "add a test for the empty-input case", presets: SHIP },
  { id: "i12", kind: "imperative", text: "delete the dead flag in config.ts", presets: SHIP },
  { id: "i13", kind: "imperative", text: "update the README example to the new flag", presets: SHIP },
  { id: "i14", kind: "imperative", text: "fix the flaky admission test", presets: SHIP },
  { id: "i15", kind: "imperative", text: "make the build pass on node 22", presets: SHIP },
  { id: "i16", kind: "imperative", text: "bump the version to 1.4.0", presets: SHIP },
  { id: "i17", kind: "imperative", text: "fix the typo in the error message ('recieve')", presets: SHIP },
  { id: "i18", kind: "imperative", text: "add retries to the webhook call", presets: SHIP },
  { id: "i19", kind: "imperative", text: "the docs check is red, sort it out", presets: SHIP },
  { id: "i20", kind: "imperative", text: "get ci green", presets: SHIP },
  // Imperatives in the shape of a specification: how something should behave,
  // on a named repository, and an ask for it to be done — no "fix" or
  // "implement" anywhere. s01 is the production ask that routed to `explore`,
  // verbatim except the repository (the bot mention is not part of the text
  // the router sees).
  {
    id: "s01",
    kind: "imperative",
    text: [
      "my boi I put all my hopes on your right now",
      "",
      "I need you to do this for me and send me screenshots",
      "",
      "*On the acme repo:* the topology screen should show connect github single button if there's nothing connected (currently shows the install script)",
      "",
      "if github is connected but no cloud is connected, it should not show the topology of just the repos, it should show connect cloud accounts",
    ].join("\n"),
    presets: SHIP,
  },
  {
    id: "s02",
    kind: "imperative",
    text: "in acme/web: the settings page should default to the dark theme when the OS is dark, and the toggle should remember the choice across reloads. Need this done today, ping me with before/after screenshots",
    presets: SHIP,
  },
  {
    id: "s03",
    kind: "imperative",
    text: "for acme/api — when a request has no auth header the response should be a 401 with a JSON body, not the HTML error page it returns now. Please take care of it",
    presets: SHIP,
  },
  // Imperatives whose task is in a linked conversation: the sentence's verb is
  // the order, the quoted thread carries what to do. t01 is the production ask
  // that routed to `general`, verbatim except the repository and the permalink.
  {
    id: "t01",
    kind: "imperative",
    text: `in acme ship ${THREAD} - this, (read the whole thread)`,
    presets: SHIP,
    references: 1,
  },
  {
    id: "t02",
    kind: "imperative",
    text: `do the above ${THREAD}?thread_ts=1700000000.000000 — the thread has the spec, option B`,
    presets: SHIP,
    references: 1,
  },
  // Decoys: read-only asks about the same failures — a question, a check, a list.
  { id: "d01", kind: "decoy", text: "check whether ci is red", presets: READ_ONLY },
  { id: "d02", kind: "decoy", text: "tell me why the build failed", presets: READ_ONLY },
  { id: "d03", kind: "decoy", text: "list the failing tests", presets: READ_ONLY },
  { id: "d04", kind: "decoy", text: "why did ci fail?", presets: READ_ONLY },
  { id: "d05", kind: "decoy", text: "what broke in the last run?", presets: READ_ONLY },
  // Decoys in the shapes above: a question about the repository in the
  // spec-shaped voice, an ask only a sandbox answers, a read-only ask about a
  // linked thread — each a look-alike of an order, none an order.
  {
    id: "d06",
    kind: "decoy",
    text: "on the acme repo: does the topology screen show the install script when nothing is connected? just tell me what it does today, change nothing",
    presets: READ_ONLY,
  },
  {
    id: "d07",
    kind: "decoy",
    text: "in acme/api: how long does `npm run typecheck` take on a fresh checkout? time it once",
    presets: ["explore"],
  },
  {
    id: "d08",
    kind: "decoy",
    text: `what did we decide in ${THREAD} ? summarize it for me`,
    presets: READ_ONLY,
    references: 1,
  },
  // Review-shaped: a pull request to look at, never an order to change it.
  { id: "r01", kind: "review", text: "look at PR 42", presets: REVIEW },
  { id: "r02", kind: "review", text: "anything wrong with this PR?", presets: REVIEW },
  { id: "r03", kind: "review", text: "review https://github.com/acme/api/pull/1080", presets: REVIEW },
  { id: "r04", kind: "review", text: "take a look at PR 1077 before I merge it", presets: REVIEW },
  { id: "r05", kind: "review", text: "does PR 91 look right to you?", presets: REVIEW },
  {
    id: "r06",
    kind: "review",
    text: "https://github.com/acme/api/pull/3179 (retry at head c6583d2: the run died)",
    presets: REVIEW,
  },
];
