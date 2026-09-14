// The checked-in imperative set of `load:route` (docs/reference/specs/
// load-harness.md item 17): twenty terse imperatives a person types into a
// channel or thread that is bound to a repository — an order to change
// something or to make a failure go away, with no file, cause or repository
// named — which the router must read as a request to change code; five decoys
// that look imperative but are read-only (a question or a check about the same
// failure), which must never reach a write preset; and five review-shaped asks
// that name a pull request, which are a review, not an order to change it. The
// set exists because the replay over the run history has almost no such
// requests: the one it had was the router's one real coding misroute. Neutral
// names only (acme/…, PR NNNN): the public tree carries no private references.

/** One example: the text as typed and the presets that count as a right
 *  answer — one write preset for an imperative, either read-only preset that
 *  answers a question for a decoy, the review preset for a review-shaped ask. */
export interface RouteImperativeFixture {
  id: string;
  kind: "imperative" | "decoy" | "review";
  text: string;
  presets: readonly string[];
}

const CODING = ["coding"];
const READ_ONLY = ["research", "general"];
const REVIEW = ["review"];

export const ROUTE_IMPERATIVE_FIXTURES: readonly RouteImperativeFixture[] = [
  // Imperatives: an order to change code or repair a failure, terse.
  { id: "i01", kind: "imperative", text: "looks like the ci failed, fix it", presets: CODING },
  { id: "i02", kind: "imperative", text: "fix it", presets: CODING },
  { id: "i03", kind: "imperative", text: "make it pass", presets: CODING },
  { id: "i04", kind: "imperative", text: "make the tests green", presets: CODING },
  { id: "i05", kind: "imperative", text: "ci is red again, make it pass", presets: CODING },
  { id: "i06", kind: "imperative", text: "add a --json flag to runs list", presets: CODING },
  { id: "i07", kind: "imperative", text: "rename formatLabel to formatLine", presets: CODING },
  { id: "i08", kind: "imperative", text: "bump pnpm to 10.18", presets: CODING },
  { id: "i09", kind: "imperative", text: "the lint is failing on main, fix", presets: CODING },
  { id: "i10", kind: "imperative", text: "typecheck broke, fix it please", presets: CODING },
  { id: "i11", kind: "imperative", text: "add a test for the empty-input case", presets: CODING },
  { id: "i12", kind: "imperative", text: "delete the dead flag in config.ts", presets: CODING },
  { id: "i13", kind: "imperative", text: "update the README example to the new flag", presets: CODING },
  { id: "i14", kind: "imperative", text: "fix the flaky admission test", presets: CODING },
  { id: "i15", kind: "imperative", text: "make the build pass on node 22", presets: CODING },
  { id: "i16", kind: "imperative", text: "bump the version to 1.4.0", presets: CODING },
  { id: "i17", kind: "imperative", text: "fix the typo in the error message ('recieve')", presets: CODING },
  { id: "i18", kind: "imperative", text: "add retries to the webhook call", presets: CODING },
  { id: "i19", kind: "imperative", text: "the docs check is red, sort it out", presets: CODING },
  { id: "i20", kind: "imperative", text: "get ci green", presets: CODING },
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
];
