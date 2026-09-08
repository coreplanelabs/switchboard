import type { PrDescriptionData, TourAnchor, TourStep } from "./types";

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

/** Where a step's file is: in the diff on screen; only in the full diff (the
 *  abridgement dropped it); in neither while the recorded full diff was cut at
 *  its cap (`beyond` — the file may well be in the PR, past the cut: GitHub
 *  has it); or in neither with the whole diff on record (`absent` — the step
 *  names a path the change does not touch). */
export type Placement = "shown" | "full" | "beyond" | "absent";

export function placementOf(
  path: string,
  shown: ReadonlySet<string>,
  full: ReadonlySet<string>,
  fullTruncated = false,
): Placement {
  if (shown.has(path)) return "shown";
  if (full.has(path)) return "full";
  return fullTruncated ? "beyond" : "absent";
}

/** The muted note beside a step's anchor: where the jump goes when the shown
 *  diff cannot take it, or that nothing can. `linked` says the beyond note
 *  ends in a link; `missed` that the file is here but the lines are not. */
export function placementNote(placement: Placement, linked: boolean, missed: boolean): string | undefined {
  if (placement === "full") return "not in the reading diff · open full diff";
  if (placement === "beyond")
    return linked ? "beyond the recorded diff · open on GitHub ↗" : "beyond the recorded diff";
  if (placement === "absent") return "not in this diff";
  return missed ? "lines not in this diff" : undefined;
}

/** The tooltip over a step's prose — the title and the description whole,
 *  for the two-line clamps that hold the list still. */
export function stepTip(step: Pick<TourStep, "title" | "description">): string {
  return step.description ? `${step.title} — ${step.description}` : step.title;
}
