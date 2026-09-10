import { mapStringLeaves, parsePrDescriptionMarkdown, type PrDescription } from "./prDescription.js";
import { PR_BODY_CAP, type PrFacts, type RepoContext } from "./repoContext.js";
import { redactSecrets, stripAnsi, type PrDescriptionArtifact, type RunEvent } from "./runEvents.js";
import type { RunStore } from "./runStore.js";
import { systemClock } from "./trace/clock.js";

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

/** The artifact a review run publishes when no submitted object exists for
 *  the head it reviews: the body GitHub holds, sanitized FIRST and then read
 *  back through the inverse parser — so every parsed leaf is redacted by
 *  construction. A body the resolver cut at `PR_BODY_CAP` is parsed as it is,
 *  with the cut named as the first problem. */
export function parsedPrDescriptionArtifact(
  facts: PrFacts,
  ctx: { repo: string; pr: number; headSha?: string },
): PrDescriptionArtifact {
  const body = sanitize(facts.body);
  const parsed = parsePrDescriptionMarkdown(body);
  const d = parsed.description;
  const problems = facts.truncated
    ? [`body truncated at ${PR_BODY_CAP} chars before parsing`, ...parsed.problems]
    : parsed.problems;
  return {
    artifact: "pr_description",
    origin: "parsed",
    repo: ctx.repo,
    pr: ctx.pr,
    ...(ctx.headSha ? { headSha: ctx.headSha } : {}),
    title: sanitize(facts.title),
    body,
    ...(d.tldr !== undefined ? { tldr: d.tldr } : {}),
    tour: d.tour,
    remaining: d.remaining ?? [],
    decisions: d.decisions ?? [],
    complete: problems.length === 0,
    problems,
    truncated: facts.truncated,
  };
}

/** How many of the repo's newest records `findSubmittedPrDescription` reads
 *  before answering "none" — the lookup's bound. */
export const SUBMITTED_LOOKUP_LIMIT = 10;

/** The submitted description a coding run published for exactly this PR at
 *  exactly this head, from the run store (docs/reference/specs/run-history.md item 42):
 *  the repo's newest records first (`list` filtered by repo — the review is
 *  authorized for that repo and reads no other), each record's events newest
 *  first, the first `submitted` `pr_description` artifact whose repo, PR and
 *  head all match. At most `limit` records are read. A record's copy on a
 *  review run counts too (it IS the submitted object); its `fromRunId` keeps
 *  the original coding run. Throws only what the store throws — callers
 *  degrade to the parsed body. */
export async function findSubmittedPrDescription(
  store: RunStore,
  key: { repo: string; pr: number; headSha: string },
  limit = SUBMITTED_LOOKUP_LIMIT,
): Promise<{ artifact: PrDescriptionArtifact; runId: string } | undefined> {
  const rows = await store.list({ limit, visibleTo: { kind: "repos-in", repos: [key.repo] } });
  for (const row of rows) {
    const record = await store.get(row.id);
    if (!record) continue;
    for (let i = record.events.length - 1; i >= 0; i--) {
      const ev = record.events[i];
      if (
        ev.type === "review_artifact" &&
        ev.artifact === "pr_description" &&
        ev.origin === "submitted" &&
        ev.repo === key.repo &&
        ev.pr === key.pr &&
        ev.headSha === key.headSha
      ) {
        const { type: _type, seq: _seq, at: _at, ...artifact } = ev;
        return { artifact: { ...artifact, fromRunId: artifact.fromRunId ?? record.id }, runId: record.id };
      }
    }
  }
  return undefined;
}

/** The dispatcher's one call for a PR review (reading-diff.md item 7): publish
 *  ONE `pr_description` artifact — the submitted object when the store holds
 *  one for the reviewed head (its `at` re-stamped, `fromRunId` naming the
 *  coding run), else the PR body parsed, else nothing (no facts: the head
 *  fetch failed). The store read runs in the background; the dispatcher joins
 *  the promise before the answer publish so the artifact is in the record
 *  deterministically. Resolves `true` iff published; never rejects. */
export function startReviewDescription(args: {
  store: RunStore;
  repoCtx: Pick<RepoContext, "repo" | "pr" | "headSha" | "prDescription">;
  publish: (event: RunEvent) => void;
}): Promise<boolean> {
  const { repo, pr, headSha, prDescription } = args.repoCtx;
  if (repo === undefined || pr === undefined) return Promise.resolve(false);
  const run = async (): Promise<boolean> => {
    const found = headSha
      ? await findSubmittedPrDescription(args.store, { repo, pr, headSha }).catch(() => undefined)
      : undefined;
    if (found) {
      args.publish({ type: "review_artifact", ...found.artifact, at: systemClock() });
      return true;
    }
    if (!prDescription) return false;
    args.publish({
      type: "review_artifact",
      ...parsedPrDescriptionArtifact(prDescription, { repo, pr, ...(headSha ? { headSha } : {}) }),
      at: systemClock(),
    });
    return true;
  };
  return run().catch(() => false);
}
