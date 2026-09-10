import { describe, expect, it } from "vitest";
import { createPrReviewCollector, firstParagraph, markdownSection } from "./prReviewCollector";

// Feature: docs/reference/specs/reading-diff.md item 12 — the runs→module adapter: run_meta
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

/** A parsed description the way a review run records one (docs/reference/specs/reading-diff.md item 7). */
const description = (over: Record<string, unknown> = {}) => ({
  type: "review_artifact",
  artifact: "pr_description",
  origin: "parsed",
  repo: "acme/api",
  pr: 42,
  headSha: "e".repeat(40),
  title: "Retry webhook deliveries",
  body: "## TL;DR\n\nDeliveries are tried once today.\n\n## What & why\n\nA flaky receiver loses the event.\n\nThe policy is bounded.\n\n## Tour\n\n### 1. The retry loop\n",
  tldr: "Deliveries are tried once today.",
  tour: [
    {
      title: "The retry loop",
      description: "Five attempts, never on a 4xx.",
      lookFor: "the 4xx early return",
      anchor: { path: "src/webhooks/sender.ts", from: 31, to: 40, sha: "e".repeat(40) },
    },
    {
      title: "The schedule",
      description: "",
      anchor: { path: "src/webhooks/retry.ts", from: 1, to: 7, sha: "e".repeat(40) },
    },
  ],
  remaining: [{ path: "CHANGELOG.md", note: "the entry" }],
  decisions: [],
  complete: false,
  problems: ["no Decisions section in the body"],
  truncated: false,
  ...over,
});

describe("createPrReviewCollector", () => {
  it("folds run_meta into the PR ref and artifacts into diffs; ready once a diff exists", () => {
    const c = createPrReviewCollector();
    expect(c.state.ready).toBe(false);
    c.handle({
      type: "run_meta",
      agent: "review",
      model: "m",
      repo: "acme/api",
      ref: "patch-1",
      pr: 42,
      headSha: "e".repeat(40),
    });
    expect(c.state.pr).toEqual({ repo: "acme/api", number: 42, headSha: "e".repeat(40) });
    expect(c.state.ready).toBe(false); // identity alone is not a panel
    c.handle(artifact());
    expect(c.state.ready).toBe(true);
    expect(c.state.readingDiffs).toEqual([
      { poweredBy: "git", baseRef: "main", diff: "diff --git a/f b/f\n+x", truncated: false },
    ]);
  });

  it("a later run_meta replaces the head — the dispatcher re-publishes it when the attach adopts a moved PR head (live-view item 19), so the panel names the head actually reviewed", () => {
    const c = createPrReviewCollector();
    c.handle({ type: "run_meta", agent: "review", model: "m", repo: "acme/api", pr: 42, headSha: "e".repeat(40) });
    c.handle({ type: "run_meta", agent: "review", model: "m", repo: "acme/api", pr: 42, headSha: "d".repeat(40) });
    expect(c.state.pr).toEqual({ repo: "acme/api", number: 42, headSha: "d".repeat(40) });
  });

  it("folds a pr_description artifact into the description: title, TL;DR, the What & why section, the Tour with its anchors' shas, the remaining files, origin, completeness; a later artifact replaces the earlier", () => {
    const c = createPrReviewCollector();
    c.handle(description());
    expect(c.state.ready).toBe(false); // a description alone is not a panel
    expect(c.state.description).toEqual({
      title: "Retry webhook deliveries",
      tldr: "Deliveries are tried once today.",
      whatWhy: "A flaky receiver loses the event.\n\nThe policy is bounded.",
      tour: [
        {
          title: "The retry loop",
          description: "Five attempts, never on a 4xx.",
          lookFor: "the 4xx early return",
          anchor: { path: "src/webhooks/sender.ts", from: 31, to: 40, sha: "e".repeat(40) },
        },
        {
          title: "The schedule",
          description: "",
          anchor: { path: "src/webhooks/retry.ts", from: 1, to: 7, sha: "e".repeat(40) },
        },
      ],
      remaining: [{ path: "CHANGELOG.md", note: "the entry" }],
      origin: "parsed",
      complete: false,
      truncated: false,
      headSha: "e".repeat(40),
    });
    c.handle(description({ origin: "submitted", title: "Retry webhooks (v2)", tour: [], complete: true }));
    expect(c.state.description?.title).toBe("Retry webhooks (v2)"); // the later artifact wins, like the diffs
    expect(c.state.description?.origin).toBe("submitted");
    expect(c.state.description?.tour).toEqual([]);
    expect(c.state.description?.complete).toBe(true);
  });

  it("the TL;DR falls back to the body's first paragraph; no What & why section → none; a bad head sha is dropped, a step's sha is optional", () => {
    const c = createPrReviewCollector();
    c.handle(
      description({
        tldr: undefined,
        body: "# Heading\n\nFirst paragraph\nstill the first.\n\nSecond paragraph.",
        headSha: "not a sha",
        tour: [{ title: "T", description: "D", anchor: { path: "a.ts", from: 1, to: 1 } }],
      }),
    );
    expect(c.state.description?.tldr).toBe("First paragraph\nstill the first.");
    expect(c.state.description?.whatWhy).toBeUndefined();
    expect(c.state.description?.headSha).toBeUndefined();
    expect(c.state.description?.tour[0].anchor).toEqual({ path: "a.ts", from: 1, to: 1 });
  });

  it("a malformed description changes nothing: a bad title, origin, a step without a title or with an inverted or non-positive range, a remaining entry without a note, a tour that is not a list", () => {
    const c = createPrReviewCollector();
    c.handle(description());
    const before = JSON.parse(JSON.stringify(c.state.description));
    const step = (anchor: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
      title: "T",
      description: "D",
      anchor,
      ...over,
    });
    for (const bad of [
      description({ title: "" }),
      description({ title: 42 }),
      description({ origin: "guessed" }),
      description({ tour: "steps" }),
      description({ tour: [step({ path: "a.ts", from: 1, to: 2 }, { title: "" })] }),
      description({ tour: [step({ path: "a.ts", from: 5, to: 2 })] }),
      description({ tour: [step({ path: "a.ts", from: 0, to: 2 })] }),
      description({ tour: [step({ path: "", from: 1, to: 2 })] }),
      description({ tour: [step({ path: "a.ts", from: 1, to: 2, sha: "nope" })] }),
      description({ remaining: [{ path: "x" }] }),
      description({ remaining: "x" }),
    ]) {
      c.handle(bad);
    }
    expect(c.state.description).toEqual(before);
  });

  it("the body helpers: firstParagraph skips headings and blank lines; markdownSection returns one ## section's text, case-insensitively, up to the next ## and without a fenced ##", () => {
    expect(firstParagraph("")).toBeUndefined();
    expect(firstParagraph("## TL;DR\n\nOne.\nTwo.\n\nThree.")).toBe("One.\nTwo.");
    expect(firstParagraph("\n\n# Only headings\n## And more")).toBeUndefined();
    const body = "## TL;DR\n\nx\n\n## what & WHY\n\nWhy line.\n\n```\n## not a heading\n```\n\n## Tour\n\nsteps";
    expect(markdownSection(body, "What & why")).toBe("Why line.\n\n```\n## not a heading\n```");
    expect(markdownSection(body, "Decisions")).toBeUndefined();
    expect(markdownSection("## What & why\n\n\n", "What & why")).toBeUndefined(); // an empty section is none
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
    for (const junk of [
      null,
      "x",
      42,
      {},
      { type: "tool_call" },
      artifact({ poweredBy: "carrier-pigeon" }),
      artifact({ diff: "" }),
      artifact({ diff: 7 }),
      { type: "review_artifact", artifact: "other" },
    ]) {
      c.handle(junk);
    }
    c.handle({ type: "run_meta", agent: "review", model: "m", repo: "", pr: -1, headSha: "not a sha" });
    expect(c.state.readingDiffs).toEqual([]);
    expect(c.state.pr).toEqual({});
    expect(c.state.ready).toBe(false);
  });
});
