import { mapStringLeaves, type PrDescription } from "./prDescription.js";
import { redactSecrets, stripAnsi, type PrDescriptionArtifact } from "./runEvents.js";

// The PR's description as data on the run stream (docs/reference/specs/reading-diff.md
// item 7): the `pr_description` review artifact — the TL;DR, the Tour's steps
// with their anchors, the Remaining-changes list and the decisions — so the
// run page's panel can render a collapsed description and a Tour that jumps
// to files and lines in the diff. Two sources, one shape:
//   - `submitted`: the typed object a coding run submitted, published by the
//     coding PR post-step at the moment the PR is opened or edited, with the
//     head the body was rendered at (`submittedPrDescriptionArtifact`).
//   - `parsed`: the body GitHub holds, read back through the inverse parser
//     by a review run when no submitted object exists for the reviewed head.
// Every string that leaves this module honors the stream's hygiene contract
// (the registry publishes events as-is): control-stripped and redacted like
// the reading diff.

/** The stream's hygiene contract, the same as the reading diff's `sanitize`. */
function sanitize(text: string): string {
  return redactSecrets(stripAnsi(text));
}

/** The artifact a coding run publishes when its post-step opens or edits the
 *  PR from the submitted object: exact and complete by construction, every
 *  anchor stamped with `headSha` (the head `body` was rendered at), every
 *  string leaf sanitized. */
export function submittedPrDescriptionArtifact(
  description: PrDescription,
  ctx: { repo: string; pr: number; headSha: string; body: string },
): PrDescriptionArtifact {
  const clean = mapStringLeaves(description, sanitize) as PrDescription;
  return {
    artifact: "pr_description",
    origin: "submitted",
    repo: ctx.repo,
    pr: ctx.pr,
    headSha: ctx.headSha,
    title: clean.title,
    body: sanitize(ctx.body),
    tldr: clean.tldr,
    tour: clean.tour.map((s) => ({ ...s, anchor: { ...s.anchor, sha: ctx.headSha } })),
    remaining: clean.remaining,
    decisions: clean.decisions,
    complete: true,
    problems: [],
    truncated: false,
  };
}
