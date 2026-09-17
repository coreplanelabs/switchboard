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
