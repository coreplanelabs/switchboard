// The checked-in imperative set of `load:route` (docs/reference/specs/
// load-harness.md item 17): twenty terse imperatives a person types into a
// channel or thread that is bound to a repository — an order to change
// something or to make a failure go away, with no file, cause or repository
// named — which the router must read as a request to change code (the table's
// write preset is `ship`: a routed write ask runs the coding → review loop,
// its generated plan merged by a person); five decoys
// that look imperative but are read-only (a question or a check about the same
// failure), which must never reach a write preset; and six review-shaped asks
// that name a pull request, which are a review, not an order to change it —
// one of them with a note about the request's own history ("retry at head …:
// the run died"), the shape the replay routed to `ship` once `ship` held the
// write seat. The
// set exists because the replay over the run history has almost no such
// requests: the one it had was the router's one real coding misroute. Neutral
// names only (acme/…, PR NNNN): the public tree carries no private references.

/** One example: the text as typed and the presets that count as a right
 *  answer — the table's write preset (`ship`) for an imperative, either read-only preset that
 *  answers a question for a decoy, the review preset for a review-shaped ask. */
export interface RouteImperativeFixture {
  id: string;
  kind: "imperative" | "decoy" | "review";
  text: string;
  presets: readonly string[];
}

const SHIP = ["ship"];
const READ_ONLY = ["research", "general"];
const REVIEW = ["review"];

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
  // Decoys: read-only asks about the same failures — a question, a check, a list.
  { id: "d01", kind: "decoy", text: "check whether ci is red", presets: READ_ONLY },
  { id: "d02", kind: "decoy", text: "tell me why the build failed", presets: READ_ONLY },
  { id: "d03", kind: "decoy", text: "list the failing tests", presets: READ_ONLY },
  { id: "d04", kind: "decoy", text: "why did ci fail?", presets: READ_ONLY },
  { id: "d05", kind: "decoy", text: "what broke in the last run?", presets: READ_ONLY },
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
