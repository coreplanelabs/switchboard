// Feature: docs/reference/specs/browser-home.md — artifact-proven PR navigation.
import { describe, expect, it } from "vitest";
import type { UnitRunRowSeed, WebSeed } from "@core/channels/webSeed.js";
import { ALL_ON } from "../../src/testing/mount";
import { recordedPullRequestRun } from "./pullRequest";
const head = "abc1234";
const rows: UnitRunRowSeed[] = [
  { id: "actual-code-child", agent: "code", finished: true, startedAt: 1, eventCount: 3 },
  { id: "review-with-no-diff", agent: "review", finished: true, startedAt: 2, eventCount: 2 },
];
function seed(id: string, number: number, diff: boolean): WebSeed {
  return {
    title: "Run",
    capabilities: ALL_ON,
    page: "run",
    mode: "history",
    id,
    startedAt: 1,
    eventCount: 2,
    events: [
      { type: "run_meta", repo: "sample/api", pr: number, headSha: head },
      ...(diff
        ? [
            {
              type: "review_artifact",
              artifact: "reading_diff",
              poweredBy: "git",
              baseRef: "main",
              diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
              truncated: false,
            },
          ]
        : []),
    ] as never,
  };
}
describe("Recorded pull request destination", () => {
  it("selects a child only from matching recorded diff provenance regardless of its agent label", async () => {
    const visited: string[] = [];
    const result = await recordedPullRequestRun(rows, "sample/api", 42, async (address) => {
      visited.push(address);
      return address.includes("review-with-no-diff")
        ? seed("review-with-no-diff", 42, false)
        : seed("actual-code-child", 42, true);
    });
    expect(result).toEqual({ kind: "found", href: "/runs/actual-code-child?view=pull-request", head: "abc1234" });
    expect(visited).toEqual(["/runs/review-with-no-diff", "/runs/actual-code-child"]);
  });
  it("refuses artifacts for another PR and exposes unavailable reads without inventing a diff", async () => {
    expect(await recordedPullRequestRun(rows, "sample/api", 42, async (address) => seed(address, 99, true))).toEqual({
      kind: "missing",
      searched: 2,
    });
    expect(await recordedPullRequestRun(rows, "sample/api", 42, async () => null)).toEqual({
      kind: "unavailable",
      searched: 2,
    });
  });
});
