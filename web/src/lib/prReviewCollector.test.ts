import { describe, expect, it } from "vitest";
import { createPrReviewCollector } from "./prReviewCollector";

// Feature: features/reading-diff.md item 6 — the runs→module adapter: run_meta
// carries the PR identity, review_artifact the diffs; everything else (and
// every malformed frame) is ignored. This file is the ONLY place run shapes
// and the pr-review module meet.

const artifact = (over: Record<string, unknown> = {}) => ({
  type: "review_artifact",
  artifact: "reading_diff",
  poweredBy: "git",
  baseRef: "main",
  diff: "diff --git a/f b/f\n+x",
  truncated: false,
  ...over,
});

describe("createPrReviewCollector", () => {
  it("folds run_meta into the PR ref and artifacts into diffs; ready once a diff exists", () => {
    const c = createPrReviewCollector();
    expect(c.state.ready).toBe(false);
    c.handle({ type: "run_meta", agent: "review", model: "m", repo: "acme/api", ref: "patch-1", pr: 42, headSha: "e".repeat(40) });
    expect(c.state.pr).toEqual({ repo: "acme/api", number: 42, headSha: "e".repeat(40) });
    expect(c.state.ready).toBe(false); // identity alone is not a panel
    c.handle(artifact());
    expect(c.state.ready).toBe(true);
    expect(c.state.readingDiffs).toEqual([{ poweredBy: "git", baseRef: "main", diff: "diff --git a/f b/f\n+x", truncated: false }]);
  });

  it("keeps one diff per producer — a re-review's later artifact replaces the earlier one; meat and git coexist", () => {
    const c = createPrReviewCollector();
    c.handle(artifact());
    c.handle(artifact({ poweredBy: "meat", summary: "s", truncated: true }));
    c.handle(artifact({ diff: "diff --git a/g b/g\n+y" })); // second git artifact
    expect(c.state.readingDiffs.map((d) => d.poweredBy)).toEqual(["git", "meat"]);
    expect(c.state.readingDiffs[0].diff).toContain("a/g b/g");
  });

  it("ignores malformed frames, unknown producers, empty diffs, bad meta values — never throws", () => {
    const c = createPrReviewCollector();
    for (const junk of [null, "x", 42, {}, { type: "tool_call" }, artifact({ poweredBy: "carrier-pigeon" }), artifact({ diff: "" }), artifact({ diff: 7 }), { type: "review_artifact", artifact: "other" }]) {
      c.handle(junk);
    }
    c.handle({ type: "run_meta", agent: "review", model: "m", repo: "", pr: -1, headSha: "not a sha" });
    expect(c.state.readingDiffs).toEqual([]);
    expect(c.state.pr).toEqual({});
    expect(c.state.ready).toBe(false);
  });
});
