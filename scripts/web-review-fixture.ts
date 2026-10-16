import { DAY_MS } from "../src/core/budgets.js";
import { buildReviewsReport } from "../src/core/reviewsReport.js";
import type { ReviewsReportWithDataset } from "../src/core/reviewsService.js";

/** Fictional report for local rendering only; no analytics or provider is called. */
export function reviewReportFixture(fromMs = 0): ReviewsReportWithDataset {
  const day = new Date(fromMs).toISOString().slice(0, 10);
  return {
    dataset: "fixture_reviews",
    ...buildReviewsReport(
      {
        runs: [
          {
            day,
            outcome: "success",
            surface: "slack",
            requester: "access:preview",
            runs: 18,
            wallMs: 18000,
            maxInterval: 1,
          },
          { day, outcome: "error", surface: "mcp", requester: "access:preview", runs: 2, wallMs: 4000, maxInterval: 1 },
          { day, outcome: "", surface: "http", requester: "access:preview", runs: 1, wallMs: 0, maxInterval: 1 },
        ],
        durationByRequester: [{ requester: "access:preview", runs: 18, p50Ms: 1000, p95Ms: 2000 }],
        durationBySurface: [{ surface: "slack", runs: 18, p50Ms: 1000, p95Ms: 2000 }],
        durationOverall: [{ runs: 18, p50Ms: 1000, p95Ms: 2000 }],
        durationHistogram: [
          { minute: 0, runs: 20 },
          { minute: 30, runs: 1 },
        ],
        reviews: [
          {
            repository: "sample/api",
            pr: "1",
            verdict: "approved",
            reviews: 2,
            findings: 4,
            blocking: 1,
            major: 1,
            minor: 1,
            nit: 1,
            maxInterval: 1,
          },
        ],
        setup: [
          { day, workspace: "resident", setupReason: "", errorType: "", runs: 18 },
          { day, workspace: "none", setupReason: "lost_at_setup", errorType: "unclassified", runs: 2 },
          { day, workspace: "", setupReason: "", errorType: "", runs: 1 },
        ],
        byWorkspace: [{ workspace: "resident", runs: 18, p50Ms: 1000, p50ReadyMs: 0 }],
      },
      { fromMs, toMs: fromMs + 7 * DAY_MS },
    ),
  };
}
