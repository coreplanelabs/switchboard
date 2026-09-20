// The checked-in door set of `load:route` (docs/reference/specs/load-harness.md
// item 17; issue 2043): the plain-words docs asks the operator falsely refused
// as "privileged administrative updates to control plane records" — a request
// naming a decision record or a plan by number ("record NNNN", "plan
// YYYY-MM-DD-NNN") is an ordinary docs write in the named repository, so the
// door's one right answer is a bind of the write preset on the request's own
// words, never a refusal the policy did not make. Three such asks were refused
// in one hour while five asks the same evening that wrote records without
// naming one by number routed to ship; each shape here is that miss, replayed
// on every run of the command. Neutral names only (acme/…, plan dates outside
// the hygiene window): the public tree carries no private references.

/** One door fixture: the text as typed and the preset the bind must name —
 *  the table's write door. The replay asks the OPERATOR (never the router)
 *  and a hit is a binds decision whose first bind is `agent:<preset>` on the
 *  request. */
export interface RouteDoorFixture {
  id: string;
  text: string;
  preset: string;
}

const d = (id: string, text: string): RouteDoorFixture => ({ id, text, preset: "ship" });

export const ROUTE_DOOR_FIXTURES: readonly RouteDoorFixture[] = [
  // The refused shape verbatim except the names: a record accepted by the
  // maintainer, its status flipped, the decisions written into a plan's unit.
  d(
    "d01",
    "in acme/api: record 0070 (the panel pins a chat beside the reports) is accepted by the maintainer. Flip the record's status to accepted with a dated acceptance note, and write the same three decisions into plan 1999-01-02-004's first unit contract. Docs only: decisions:check and the docs site build are the gates.",
  ),
  // The second instance's shape: pressure-test a record and write the
  // comparison into it as an amendment.
  d(
    "d02",
    "in acme/api: pressure-test record 0069 against the last day's incidents and write the comparison into the record as an appended amendment. Docs only.",
  ),
  // The terse form: a status flip alone, the gates named.
  d(
    "d03",
    "in acme/api: flip record 0071's status to accepted with a dated acceptance note; decisions:check is the gate.",
  ),
  // A plan named by id alone: the same fact — a plan is a markdown file a
  // ship unit edits.
  d(
    "d04",
    "in acme/api: amend plan 1999-01-02-001 with one follow-up unit covering the door fixtures, and keep every other section as it stands.",
  ),
];
