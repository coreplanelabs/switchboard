// The PrDescription SHAPE, dependency-free. runEvents.ts (the node-free
// run-event contract compiled by the memory Worker's and web app's own
// tsconfigs) carries a PrDescription on the `pr_description` event, so the
// type must be importable without dragging zod into those compile graphs —
// the schema and validation live in prDescription.ts, which imports these
// types and enforces (via its annotated parse return) that the zod output
// stays assignable to them. Add a field here first, then to the schema.

/** The lines a pointer sends the reader to: a path + inclusive 1-based line
 *  range in the PR head. The sha is NOT stored here — it is supplied at render
 *  time. */
export interface PrAnchor {
  path: string;
  from: number;
  to: number;
}

/** One row of the map's "Where to look": a linked label, one sentence, an
 *  optional risk (rendered as ⚠), and the lines the label links to. */
export interface Pointer {
  label: string;
  text: string;
  risk?: string;
  anchor: PrAnchor;
}

/** An anchor with the sha its permalink was rendered at — what a reader gets
 *  back from a rendered body (or from a submitted object at the head it was
 *  rendered for), so a surface can tell whether the pointers are at the head
 *  it is looking at. */
export interface RenderedPrAnchor extends PrAnchor {
  sha: string;
}

/** A pointer whose anchor carries its render sha. Assignable to `Pointer`. */
export interface RenderedPointer extends Pointer {
  anchor: RenderedPrAnchor;
}

/** One reason a submitted description was refused, as the refusal and the
 *  `description_refused` run note carry it: the zod path (`risk`,
 *  `pointers.0.text`) and the schema's message; on a cap issue also the
 *  characters to remove (visible ones — raw for the title) and the longest
 *  prefix of the field that fits, cut at a word boundary (`fitToCap`), absent
 *  when no word of it fits. */
export interface DescriptionIssue {
  path: string;
  message: string;
  remove?: number;
  prefix?: string;
}

/** The refused object as the `description_refused` note records it: JSON,
 *  nested at most four objects deep, and nothing else. The record crosses the
 *  run store's RPC boundary, whose typing walks every field: a field of
 *  `unknown` types the whole record `never`, and a recursive alias is
 *  "excessively deep" to it, so the nesting is spelled out level by level
 *  (as `RouteInputValue` is). A description is three deep at most —
 *  `pointers[i].anchor` — so one level is to spare; `recordedJson` stores a
 *  deeper value as its JSON text. */
export type RecordedJsonLeaf = string | number | boolean | null;
export type RecordedJsonObject1 = { readonly [key: string]: RecordedJsonLeaf | ReadonlyArray<RecordedJsonLeaf> };
export type RecordedJson1 =
  RecordedJsonLeaf | RecordedJsonObject1 | ReadonlyArray<RecordedJsonLeaf | RecordedJsonObject1>;
export type RecordedJsonObject2 = { readonly [key: string]: RecordedJson1 };
export type RecordedJson2 =
  RecordedJsonLeaf | RecordedJsonObject2 | ReadonlyArray<RecordedJsonLeaf | RecordedJsonObject2>;
export type RecordedJsonObject3 = { readonly [key: string]: RecordedJson2 };
export type RecordedJson3 =
  RecordedJsonLeaf | RecordedJsonObject3 | ReadonlyArray<RecordedJsonLeaf | RecordedJsonObject3>;
export type RecordedJsonObject4 = { readonly [key: string]: RecordedJson3 };
export type RecordedJson =
  RecordedJsonLeaf | RecordedJsonObject4 | ReadonlyArray<RecordedJsonLeaf | RecordedJsonObject4>;

/** The PR description as data (docs/decisions/0050): the map above the fold
 *  (tldr, why, pointers, feedbackWanted, risk, verified), every field capped
 *  so the map's size does not grow with the diff, and the collapsed half
 *  (decisions, validation, agentNotes) below it. */
export interface PrDescription {
  /** The PR title's single source. Metadata for the PR's own title field —
   *  never rendered into the body (GitHub shows the title itself). */
  title: string;
  tldr: string;
  why: string;
  pointers: Pointer[];
  feedbackWanted: string;
  risk: string;
  verified: string;
  decisions: { title: string; rationale: string }[];
  validation: {
    criteria: { criterion: string; proof: string }[];
  };
  agentNotes?: string;
}
