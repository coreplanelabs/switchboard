// The checked-in door set of `load:route` (docs/reference/specs/load-harness.md
// item 17): the door row of twenty-five fixtures — record 0069's fourteen
// defects D1 to D14 from one day under `routing.operator: on` (issues 1993,
// 2010, 2025), the first night's four door failures N1 to N4 (issues 2043,
// 2045, 2046), the one loop's first defect N5 (issue 2088, the write ask a
// read answered) and the plain-words model set M1 to M6 (a person names a
// model in plain words and the run uses it) — each the failure's message
// shape with the amended table's expected outcome and the unit that turns it
// green.
// The replay scores a fixture only once its unit is on `DOOR_MERGED_UNITS`
// and prints the rest as pending, so the row is green at head while the
// units land one pull request at a time. Neutral names only (acme/…, plan
// dates outside the hygiene window, synthetic run ids): the public tree
// carries no private references.

/** The plan units that turn door fixtures green. E2 is the operator loop
 *  (typed tools, the parked question, policy-only refusals, the verifier's
 *  retirement); E3 is the click on every write path; W1 is issue 2088's
 *  write-intent question cell (a write-class intent never executes as a read
 *  command — record 0069's amendment); MW1 is the plain-words model unit (a
 *  model named in plain words rides `bind_preset`'s `model` and the run uses
 *  it at directive precedence). */
export type DoorUnit = "E2" | "E3" | "W1" | "MW1";

/** The units already merged, read by the row's scorer: a fixture whose unit
 *  is not on this list is printed as pending, never replayed and never a
 *  failure. The unit that lands appends itself here in its own pull request,
 *  turning its fixtures from pending to scored. */
export const DOOR_MERGED_UNITS: readonly DoorUnit[] = ["E2", "E3", "W1", "MW1"];

/** The amended table's expected outcome for one fixture — what the door must
 *  do with the message once the fixture's unit is merged.
 *
 *  `bind` and `refusal` are judged over the operator's decision as the replay
 *  already asks it (`operate(text)`); the other kinds — a typed line that
 *  runs, a write offered as one click, a reply folded into the thread's
 *  owner, a parked question's answer rebinding, a no-tool-call turn floored
 *  to the route — need the seam the fixture's unit builds, so that unit
 *  extends the replay's judge when it flips its fixtures to scored. */
export type DoorExpectation =
  /** A binds decision whose first bind names `preset` and carries the
   *  person's words: `carries` must appear in the bound line verbatim and
   *  `forbids` must not (the doubled or re-spelled head). `model` is the ref
   *  the bind must carry — a model the person named in plain words, resolved
   *  through the catalogue (the plain-words model unit) — and `noModel`
   *  holds a bind to carrying none: a request naming no model binds with no
   *  model, never a silent default. */
  | { kind: "bind"; preset: string; carries?: string; forbids?: string; model?: string; noModel?: true }
  /** A refusal from the policy table whose text carries `naming` — the row
   *  it stands on or the remedy — whole, never cut at a quote or bracket. */
  | { kind: "refusal"; naming: string }
  /** The person's own line runs as typed through the ladder. */
  | { kind: "run"; line: string }
  /** One confirmation row minted through record 0044's store, the button
   *  showing the full line — never a `To run this:` beside it. */
  | { kind: "click"; line: string }
  /** The reply folds into the thread's owner (or is refused naming the
   *  thread to reply in) — never a rival run, never a hand-back. */
  | { kind: "fold" }
  /** The parked question's answer rebinds the original request joined with
   *  the question; `carries` must appear in the rebound request. */
  | { kind: "rebind"; carries: string }
  /** A turn that ends with no tool call floors to the readers' route on the
   *  person's own request — never a line to retype. */
  | { kind: "route" }
  /** One question (the write-intent cell, issue 2088; the plain-words model
   *  unit's ambiguous word): the decision is a question — when `proposes` is
   *  set its proposal carries it, a line that would do the asked work, and
   *  never `forbids` (the read that stood in for it); when `names` is set the
   *  question's text carries it — the catalogue's candidate refs for a model
   *  word that matches several refs or none, never a guess. */
  | { kind: "question"; proposes?: string; forbids?: string; names?: string };

/** One door fixture: the failure's message shape, the defect it replays
 *  (record 0069's table), the unit that turns it green and the amended
 *  table's expected outcome. `parent` and `parked` carry the thread context
 *  a fixture's shape needs (a thread parent naming a pull request, a parked
 *  question awaiting its answer); the seam that reads them lands with the
 *  fixture's unit. */
export interface RouteDoorFixture {
  id: string;
  /** Record 0069's defect id (`D1`…`D14`) or the night's (`N1`…`N4`). */
  defect: string;
  /** The plan unit that turns this fixture green. */
  unit: DoorUnit;
  /** The message as the person typed it. */
  text: string;
  /** The thread parent's text, where the shape is a thread reply. */
  parent?: string;
  /** The parked question this message answers, where the shape is an answer
   *  to the loop's own question. */
  parked?: { request: string; question: string };
  expected: DoorExpectation;
}

export const ROUTE_DOOR_FIXTURES: readonly RouteDoorFixture[] = [
  // D1 (issue 1993): a plain-words fix ask bound to a `ship` line without the
  // person's words — the task text gone from every bind. The bind must carry
  // the words.
  {
    id: "d01",
    defect: "D1",
    unit: "E2",
    text: "in acme/api: the retry backoff doubles forever — cap it at five minutes and add a test that proves the cap.",
    expected: { kind: "bind", preset: "ship", carries: "cap it at five minutes" },
  },
  // D2 (issue 1993): `ship` bound with flags the registry does not have
  // (`--repo`, `--issue`, `--branch`…). A flag-rewritten line drops the
  // person's words, so carrying them verbatim rules it out.
  {
    id: "d02",
    defect: "D2",
    unit: "E2",
    text: "in acme/api on the main branch: close out the login-timeout issue — extend the session refresh and open a PR titled after the fix.",
    expected: { kind: "bind", preset: "ship", carries: "extend the session refresh", forbids: "--repo" },
  },
  // D3 (issue 1993): the day's defect was a bare `ship` line handed back to
  // retype that could not run ("Nothing to ship"). Since E3, a chat surface
  // is offered the click instead; the fixture holds the click's line runnable.
  {
    id: "d03",
    defect: "D3",
    unit: "E3",
    text: "ship",
    expected: { kind: "run", line: "ship" },
  },
  // D4 (issue 1993): the seed directive rewritten and doubled
  // (`ship agent:ship in …`) instead of passing through.
  {
    id: "d04",
    defect: "D4",
    unit: "E2",
    text: "agent:ship in acme/api, fix the flaky login test and land it with a regression test.",
    expected: { kind: "bind", preset: "ship", carries: "fix the flaky login test", forbids: "ship agent:ship" },
  },
  // D5 (issue 1993): a preset bind never executed — the right preset bound
  // with the right argument, and no run followed; reads dead as well as
  // writes. The amended table's bind cell runs.
  {
    id: "d05",
    defect: "D5",
    unit: "E2",
    text: "agent:explore acme/api — how long does the typecheck take on a warm checkout? time it once.",
    expected: {
      kind: "run",
      line: "agent:explore acme/api — how long does the typecheck take on a warm checkout? time it once.",
    },
  },
  // D6 (issue 1993): the verifier refusing correct preset binds with misread
  // reasons ("binding is a run, not a fix command"). The verifier retires;
  // the bind stands on the person's words.
  {
    id: "d06",
    defect: "D6",
    unit: "E2",
    text: "in acme/api: amend plan 1999-01-02-001 with one follow-up unit covering the door fixtures, and keep every other section as it stands.",
    expected: { kind: "bind", preset: "ship", carries: "one follow-up unit" },
  },
  // D7 (issue 1993): a reply into a live unit's round bound as prose the
  // registry cannot parse, handed back, the follow-up lost. The owner rule
  // folds it first.
  {
    id: "d07",
    defect: "D7",
    unit: "E2",
    text: "also bump the fixture's date in the same unit, and say so in the handoff.",
    parent: "unit u3 of plan 1999-01-02-002 is running in this thread",
    expected: { kind: "fold" },
  },
  // D8 (issue 1993): the typed line `runs stop <id> --mode hard` re-bound
  // into the MCP spelling, which the chat grammar does not parse — the stop
  // never ran while a runaway run burned. A parseable line runs as typed.
  {
    id: "d08",
    defect: "D8",
    unit: "E2",
    text: "runs stop r-0001 --mode hard",
    expected: { kind: "run", line: "runs stop r-0001 --mode hard" },
  },
  // D9 (issue 2010): an `agent:` directive reply in a live pipeline's seed
  // thread started a rival coding run beside the pipeline instead of folding
  // or being refused naming the unit thread.
  {
    id: "d09",
    defect: "D9",
    unit: "E2",
    text: "agent:coding tighten the new test's assertion to the exact message.",
    parent: "shipping plan 1999-01-02-002 unit u1 in this thread",
    expected: { kind: "fold" },
  },
  // D10 (issue 2025): a typo'd directive word (`adgent:` for `agent:`) drew a
  // refusal instead of the bind the words meant.
  {
    id: "d10",
    defect: "D10",
    unit: "E2",
    text: "adgent:ship in acme/api, fix the failing typecheck on the reports page.",
    expected: { kind: "bind", preset: "ship", carries: "fix the failing typecheck" },
  },
  // D11 (issue 2025): the refusal's text reached the person cut at its first
  // parenthesis. A refusal comes only from the policy table and carries its
  // whole sentence — here, the installation remedy past the cut point.
  {
    id: "d11",
    defect: "D11",
    unit: "E2",
    text: "agent:ship in acme/private-mirror, fix the readme typo (it says 'teh').",
    expected: { kind: "refusal", naming: "install" },
  },
  // D12 (issue 2025): the verifier calling the verbatim line a duplication —
  // the bound preset line put the directive in front of a request already
  // opening with a directive-shaped token, and the mangled line was handed
  // back to type. The bind passes the words through once.
  {
    id: "d12",
    defect: "D12",
    unit: "E2",
    text: "agent:ship acme/api — rename the stale feature flag and delete its dead branch.",
    expected: {
      kind: "bind",
      preset: "ship",
      carries: "rename the stale feature flag",
      forbids: "agent:ship agent:ship",
    },
  },
  // D13 (issue 1993; `operator.ts` beside `route.ts`): the operator's own
  // `To run this:` text beside record 0044's confirmation click — two code
  // paths for one concept. One row is minted through the one path.
  {
    id: "d13",
    defect: "D13",
    unit: "E3",
    text: "set the coding model on this channel to acme/fast-1",
    expected: { kind: "click", line: "config set channel --models.coding acme/fast-1" },
  },
  // D14 (issue 1993): the verifier's failure mode was a hand-back rather than
  // a floor. The verifier retired with the loop unit (`renderVerifierHandBack`
  // deleted); a turn that ends with no tool call floors to the route on the
  // person's own request.
  {
    id: "d14",
    defect: "D14",
    unit: "E2",
    text: "can you sort out the thing from before? same as last time.",
    expected: { kind: "route" },
  },
  // N1 (issue 2043): a plain-words docs ask flipping a record's status was
  // refused as "privileged administrative updates to control plane records" —
  // a record is a markdown file a ship unit edits.
  {
    id: "n01",
    defect: "N1",
    unit: "E2",
    text: "in acme/api: flip record 0071's status to accepted with a dated acceptance note; decisions:check is the gate.",
    expected: { kind: "bind", preset: "ship", carries: "record 0071" },
  },
  // N2 (issue 2043, second instance): a docs ask naming a record and a plan
  // by number binds the same way.
  {
    id: "n02",
    defect: "N2",
    unit: "E2",
    text: "in acme/api: record 0070 (the panel pins a chat beside the reports) is accepted by the maintainer. Flip the record's status to accepted with a dated acceptance note, and write the same three decisions into plan 1999-01-02-004's first unit contract. Docs only: decisions:check and the docs site build are the gates.",
    expected: { kind: "bind", preset: "ship", carries: "record 0070" },
  },
  // N3 (issue 2045): a bare `review` reply in a thread whose parent names a
  // pull request binds `agent:review <that url>` — never "re-send the link"
  // or a sentence about credentials.
  {
    id: "n03",
    defect: "N3",
    unit: "E2",
    text: "review",
    parent: "please review https://github.com/acme/api/pull/12 when you get a chance",
    expected: { kind: "bind", preset: "review", carries: "https://github.com/acme/api/pull/12" },
  },
  // N4 (issue 2046): a free-text answer to the loop's own question rebinds
  // the original request joined with the question and answer — never floored
  // to general, and general never answers a write ask with "post a new
  // message".
  {
    id: "n04",
    defect: "N4",
    unit: "E2",
    text: "acme/api",
    parked: {
      request: "fix the reports page's empty-state crash and add a test",
      question: "which repository?",
    },
    expected: { kind: "rebind", carries: "acme/api" },
  },
  // M1 (the plain-words model unit): "with astra, …" — the person names a
  // model in plain words, so the bind carries the catalogue's ref and the
  // request rides verbatim, the model word stripped from nothing.
  {
    id: "m01",
    defect: "M1",
    unit: "MW1",
    text: "with astra, fix issue 42 in acme/api — the retry never backs off.",
    expected: { kind: "bind", preset: "ship", carries: "fix issue 42", model: "openrouter/openai/gpt-6-astra" },
  },
  // M2 (the same unit): "use astra …" resolves the same way.
  {
    id: "m02",
    defect: "M2",
    unit: "MW1",
    text: "use astra for this: in acme/api add a regression test for the empty-state crash.",
    expected: { kind: "bind", preset: "ship", carries: "empty-state crash", model: "openrouter/openai/gpt-6-astra" },
  },
  // M3 (the same unit): "on astra:" ahead of a review ask — the model word
  // rides any preset, not only the write one.
  {
    id: "m03",
    defect: "M3",
    unit: "MW1",
    text: "on astra: review https://github.com/acme/api/pull/12",
    expected: {
      kind: "bind",
      preset: "review",
      carries: "https://github.com/acme/api/pull/12",
      model: "openrouter/openai/gpt-6-astra",
    },
  },
  // M4 (the same unit): the model word as a trailing courtesy — "astra
  // please" — resolves like the leading forms.
  {
    id: "m04",
    defect: "M4",
    unit: "MW1",
    text: "astra please — in acme/api rename the stale feature flag and delete its dead branch.",
    expected: { kind: "bind", preset: "ship", carries: "stale feature flag", model: "openrouter/openai/gpt-6-astra" },
  },
  // M5 (the same unit): a request naming no model binds with no model —
  // never a silent default the person did not ask for.
  {
    id: "m05",
    defect: "M5",
    unit: "MW1",
    text: "in acme/api: fix the reports page's empty-state crash and add a test.",
    expected: { kind: "bind", preset: "ship", carries: "empty-state crash", noModel: true },
  },
  // M6 (the same unit): a model word that matches several catalogue refs
  // ("gpt") is one question naming the candidates — never a guess.
  {
    id: "m06",
    defect: "M6",
    unit: "MW1",
    text: "use gpt for this: in acme/api fix the flaky login test.",
    expected: { kind: "question", names: "openrouter/openai/gpt" },
  },
  // N5 (issue 2088): a plain-words write ask naming a provider this
  // deployment does not have ("openai" — OpenAI models ride openrouter) was
  // answered with a read (`config show`). The write-intent cell: the outcome
  // is a question whose proposal is the write line built from the providers
  // that exist, never a read standing in for the work. The `intent` argument
  // itself is not asserted here: for a question outcome the decision seam the
  // judge reads carries no command tool call to inspect, so the required
  // `intent` beside `reason` is unit-proven at the parse instead
  // (`src/core/dispatch/operator.test.ts::the write-intent cell (issue 2088)`).
  {
    id: "n05",
    defect: "N5",
    unit: "W1",
    text: "change my default models to openai",
    expected: { kind: "question", proposes: "config set me", forbids: "config show" },
  },
];
