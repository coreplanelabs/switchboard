// The PrDescription SHAPE, dependency-free. runEvents.ts (the node-free
// run-event contract compiled by the memory Worker's and web app's own
// tsconfigs) carries a PrDescription on the `pr_description` event, so the
// type must be importable without dragging zod into those compile graphs —
// the schema and validation live in prDescription.ts, which imports these
// types and enforces (via its annotated parse return) that the zod output
// stays assignable to them. Add a field here first, then to the schema.

/** A hunk the reader is pointed at: a path + inclusive 1-based line range in
 *  the PR head. The sha is NOT stored here — it is supplied at render time. */
export interface TourAnchor {
  path: string;
  from: number;
  to: number;
}

/** One Tour step, reader-first: heading (what the change is), the explanation,
 *  an optional "look for" pointer, then the code. */
export interface TourStep {
  title: string;
  description: string;
  lookFor?: string;
  anchor: TourAnchor;
}

/** A Tour anchor with the sha its permalink was rendered at — what a reader
 *  gets back from a rendered body (or from a submitted object at the head it
 *  was rendered for), so a surface can tell whether the anchors are at the
 *  head it is looking at. */
export interface RenderedTourAnchor extends TourAnchor {
  sha: string;
}

/** A Tour step whose anchor carries its render sha. Assignable to `TourStep`. */
export interface RenderedTourStep extends TourStep {
  anchor: RenderedTourAnchor;
}

export interface PrDescription {
  /** The PR title's single source. Metadata for the PR's own title field —
   *  never rendered into the body (GitHub shows the title itself). */
  title: string;
  tldr: string;
  whatWhy: string;
  tour: TourStep[];
  /** Every touched file the Tour steps did not cover, one line each. */
  remaining: { path: string; note: string }[];
  decisions: { title: string; rationale: string }[];
  risks: string;
  validation: {
    summary?: string;
    criteria: { criterion: string; proof: string }[];
  };
}
