import { reactive } from "vue";
import { SHA_RE, type PrDescriptionData, type PrReviewData, type ReadingDiff } from "../modules/pr-review/types";

// Switchboard's adapter from run events to the pr-review module's contract
// (docs/reference/specs/reading-diff.md item 12). This is the runs-specific half the module
// deliberately does not know about: `run_meta` carries which PR the review is
// of, `review_artifact` events carry the reading diffs and the PR's
// description (item 7: its title names the panel, its prose fills the
// Description tab). Runs stay unique to Switchboard; another host of the
// module writes its own adapter.

export interface PrReviewState extends PrReviewData {
  /** True once the stream identified a PR review with at least one diff —
   *  what the page gates the panel button on. */
  ready: boolean;
}

export interface PrReviewCollector {
  state: PrReviewState;
  /** Fold one stream frame (seeded history or live SSE — same shapes). A
   *  malformed or irrelevant frame changes nothing; never throws. */
  handle(e: unknown): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** The body's first paragraph that is not a heading — the TL;DR of a
 *  description whose body has no `## TL;DR` section. */
export function firstParagraph(body: string): string | undefined {
  for (const paragraph of body.split(/\n\s*\n/)) {
    const lines = paragraph
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (lines.length === 0 || lines.every((l) => l.startsWith("#"))) continue;
    return lines.join("\n");
  }
  return undefined;
}

/** One `## <heading>` section's text (the renderer's fixed headings,
 *  case-insensitive) up to the next `## ` heading, fences respected — a `##`
 *  inside a code block is code. An absent or empty section is none. */
export function markdownSection(body: string, heading: string): string | undefined {
  const wanted = heading.trim().toLowerCase();
  const out: string[] = [];
  let inFence = false;
  let inside = false;
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = !inFence ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (h) {
      if (inside) break;
      inside = h[1].toLowerCase() === wanted;
      continue;
    }
    if (inside) out.push(line);
  }
  const text = out.join("\n").trim();
  return text === "" ? undefined : text;
}

/** The `pr_description` artifact projected onto the module's shape — the
 *  title, the prose and what kind of copy it is — or undefined when its title
 *  or origin is malformed (the frame then changes nothing). The artifact's
 *  Tour rides along in the record for the PR body; the panel does not render it. */
export function descriptionFrom(o: Record<string, unknown>): PrDescriptionData | undefined {
  if (!nonEmpty(o.title) || (o.origin !== "submitted" && o.origin !== "parsed")) return undefined;
  const body = typeof o.body === "string" ? o.body : "";
  const tldr = nonEmpty(o.tldr) ? o.tldr : firstParagraph(body);
  const whatWhy = markdownSection(body, "What & why");
  return {
    title: o.title,
    ...(tldr !== undefined ? { tldr } : {}),
    ...(whatWhy !== undefined ? { whatWhy } : {}),
    origin: o.origin,
    complete: o.complete === true,
    truncated: o.truncated === true,
  };
}

export function createPrReviewCollector(): PrReviewCollector {
  const state = reactive<PrReviewState>({ pr: {}, readingDiffs: [], ready: false });
  return {
    state,
    handle(e: unknown): void {
      if (!isRecord(e)) return;
      const o = e;
      if (o.type === "run_meta") {
        // The PR identity; the base branch rides the artifact, not run_meta.
        if (nonEmpty(o.repo)) state.pr.repo = o.repo;
        if (positiveInt(o.pr)) state.pr.number = o.pr;
        if (typeof o.headSha === "string" && SHA_RE.test(o.headSha)) state.pr.headSha = o.headSha;
      } else if (o.type === "review_artifact" && o.artifact === "reading_diff") {
        if (!nonEmpty(o.diff) || (o.poweredBy !== "git" && o.poweredBy !== "meat")) return;
        const diff: ReadingDiff = {
          poweredBy: o.poweredBy,
          baseRef: nonEmpty(o.baseRef) ? o.baseRef : "HEAD",
          diff: o.diff,
          truncated: o.truncated === true,
          ...(nonEmpty(o.summary) ? { summary: o.summary } : {}),
        };
        // One diff per producer: a later artifact from the same producer (a
        // re-review in the same run, or an abridging asked for after it)
        // replaces the earlier one.
        const i = state.readingDiffs.findIndex((d) => d.poweredBy === diff.poweredBy);
        if (i >= 0) state.readingDiffs.splice(i, 1, diff);
        else state.readingDiffs.push(diff);
        state.ready = true;
      } else if (o.type === "review_artifact" && o.artifact === "pr_description") {
        // The PR's description (docs/reference/specs/reading-diff.md item 7). A later
        // artifact wins, like a re-review's diff. A description alone lights nothing.
        const description = descriptionFrom(o);
        if (description) state.description = description;
      }
    },
  };
}
