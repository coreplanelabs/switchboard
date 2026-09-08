import { reactive } from "vue";
import { SHA_RE, type PrReviewData, type ReadingDiff } from "../modules/pr-review/types";

// Switchboard's adapter from run events to the pr-review module's contract
// (docs/reference/specs/reading-diff.md item 6). This is the runs-specific half the module
// deliberately does not know about: `run_meta` carries which PR the review is
// of, `review_artifact` events carry the reading diffs. Runs stay unique to
// Switchboard; another host of the module writes its own adapter.

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

export function createPrReviewCollector(): PrReviewCollector {
  const state = reactive<PrReviewState>({ pr: {}, readingDiffs: [], ready: false });
  return {
    state,
    handle(e: unknown): void {
      if (!e || typeof e !== "object") return;
      const o = e as Record<string, unknown>;
      if (o.type === "run_meta") {
        // The PR identity; the base branch rides the artifact, not run_meta.
        if (typeof o.repo === "string" && o.repo !== "") state.pr.repo = o.repo;
        if (typeof o.pr === "number" && Number.isInteger(o.pr) && o.pr > 0) state.pr.number = o.pr;
        if (typeof o.headSha === "string" && SHA_RE.test(o.headSha)) state.pr.headSha = o.headSha;
      } else if (o.type === "review_artifact" && o.artifact === "reading_diff") {
        if (typeof o.diff !== "string" || o.diff === "" || (o.poweredBy !== "git" && o.poweredBy !== "meat")) return;
        const diff: ReadingDiff = {
          poweredBy: o.poweredBy,
          baseRef: typeof o.baseRef === "string" && o.baseRef !== "" ? o.baseRef : "HEAD",
          diff: o.diff,
          truncated: o.truncated === true,
          ...(typeof o.summary === "string" && o.summary !== "" ? { summary: o.summary } : {}),
        };
        // One diff per producer: a later artifact from the same producer (a
        // re-review in the same run) replaces the earlier one.
        const i = state.readingDiffs.findIndex((d) => d.poweredBy === diff.poweredBy);
        if (i >= 0) state.readingDiffs.splice(i, 1, diff);
        else state.readingDiffs.push(diff);
        state.ready = true;
      }
    },
  };
}
