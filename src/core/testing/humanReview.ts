import type { HumanFinding } from "../reviewHumanFindings.js";

/** Complete human input for tests of the independent verdict/history gates. */
export function humanReview(...ids: string[]): HumanFinding[] {
  return ids.map((findingId) => ({
    findingId,
    problem: "Retry discards the replacement write.",
    scenario: "A retry overlaps a new write.",
    impact: "The new value is lost.",
    evidence: { basis: "code_trace", detail: "Read the retry and storage branches; not reproduced live." },
    requestedChange: "Keep the replacement when completing the retry.",
    location: { file: "src/store.ts", line: 7 },
  }));
}
