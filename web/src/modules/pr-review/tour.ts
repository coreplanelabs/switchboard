import type { PrDescriptionData, TourAnchor } from "./types";

// The Tour's pure half (docs/reference/specs/reading-diff.md item 12): how a step's anchor
// reads, whether it points into the head under review, where its file sits
// relative to the diffs the panel holds, and the one note a parsed
// description carries. Nothing here touches the DOM.

/** `path:from–to`, or `path:line` for a single line. */
export function anchorLabel(anchor: TourAnchor): string {
  return anchor.from === anchor.to ? `${anchor.path}:${anchor.from}` : `${anchor.path}:${anchor.from}–${anchor.to}`;
}

/** The anchor was rendered at another head than the one under review — its
 *  lines may have moved. Unknown on either side is not stale; a short sha
 *  that prefixes the reviewed head names the same head. */
export function staleAnchor(anchor: TourAnchor, reviewedSha: string | undefined): boolean {
  if (!anchor.sha || !reviewedSha) return false;
  return !reviewedSha.startsWith(anchor.sha) && !anchor.sha.startsWith(reviewedSha);
}

/** The stale badge's tooltip. */
export function staleExplanation(anchorSha: string, reviewedSha: string): string {
  return `anchored at ${anchorSha.slice(0, 7)}, the review is at ${reviewedSha.slice(0, 7)}; lines may have moved`;
}

/** The muted note under a description read back from the PR body that came
 *  up short — and, when the body had no Tour, that there is none to render.
 *  A submitted or complete description needs no note. */
export function originNote(description: Pick<PrDescriptionData, "origin" | "complete" | "tour">): string | undefined {
  if (description.origin !== "parsed" || description.complete) return undefined;
  return description.tour.length === 0
    ? "description read from the PR body; no Tour"
    : "description read from the PR body";
}

/** Where a step's file is: in the diff on screen, only in the full diff
 *  (the abridgement dropped it), or in neither (past the cap, or moved). */
export type Placement = "shown" | "full" | "absent";

export function placementOf(path: string, shown: ReadonlySet<string>, full: ReadonlySet<string>): Placement {
  if (shown.has(path)) return "shown";
  if (full.has(path)) return "full";
  return "absent";
}
