import { describe, expect, it } from "vitest";
import { createPrReviewCollector, firstParagraph, mapField, markdownSection } from "./prReviewCollector";

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
  pointers: [
    {
      label: "The retry loop",
      text: "Five attempts, never on a 4xx.",
      risk: "the 4xx early return",
      anchor: { path: "src/webhooks/sender.ts", from: 31, to: 40, sha: "e".repeat(40) },
    },
    {
      label: "The schedule",
      text: "",
      anchor: { path: "src/webhooks/retry.ts", from: 1, to: 7, sha: "e".repeat(40) },
    },
  ],
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

  it("folds a pr_description artifact into the description: title, TL;DR, the why (the artifact's, else the body's `**Why:**`, else a legacy body's `## What & why`), origin, completeness, the cut — the pointers stay on the record, unread; a later artifact replaces the earlier", () => {
    const c = createPrReviewCollector();
    c.handle(description()); // a body under the previous contract: the why is its What & why section
    expect(c.state.ready).toBe(false); // a description alone is not a panel
    expect(c.state.description).toEqual({
      title: "Retry webhook deliveries",
      tldr: "Deliveries are tried once today.",
      why: "A flaky receiver loses the event.\n\nThe policy is bounded.",
      origin: "parsed",
      complete: false,
      truncated: false,
    });
    c.handle(
      description({
        body: "Tldr line.\n\n**Why:** Map why.\n\n**Where to look**\n\n1. [x](https://github.com/acme/api/blob/e/a.ts#L1) t\n",
      }),
    );
    expect(c.state.description?.why).toBe("Map why.");
    c.handle(description({ why: "The artifact's why." }));
    expect(c.state.description?.why).toBe("The artifact's why.");
    c.handle(
      description({ origin: "submitted", title: "Retry webhooks (v2)", pointers: [], complete: true, truncated: true }),
    );
    expect(c.state.description?.title).toBe("Retry webhooks (v2)"); // the later artifact wins, like the diffs
    expect(c.state.description?.origin).toBe("submitted");
    expect(c.state.description?.complete).toBe(true);
    expect(c.state.description?.truncated).toBe(true);
  });

  it("the TL;DR falls back to the body's first paragraph; no why in the artifact or the body → none; a body that is not a string is no prose", () => {
    const c = createPrReviewCollector();
    c.handle(
      description({
        tldr: undefined,
        body: "# Heading\n\nFirst paragraph\nstill the first.\n\nSecond paragraph.",
      }),
    );
    expect(c.state.description?.tldr).toBe("First paragraph\nstill the first.");
    expect(c.state.description?.why).toBeUndefined();
    c.handle(description({ tldr: undefined, body: 42 }));
    expect(c.state.description?.tldr).toBeUndefined();
    expect(c.state.description?.why).toBeUndefined();
  });

  it("a malformed description changes nothing: a bad title or origin; pointers of any shape are not read and land the description regardless", () => {
    const c = createPrReviewCollector();
    c.handle(description());
    const before = JSON.parse(JSON.stringify(c.state.description));
    for (const bad of [description({ title: "" }), description({ title: 42 }), description({ origin: "guessed" })]) {
      c.handle(bad);
    }
    expect(c.state.description).toEqual(before);
    c.handle(description({ title: "Pointer-less", pointers: "rows" }));
    expect(c.state.description?.title).toBe("Pointer-less");
  });

  it("the body helpers: firstParagraph skips headings and blank lines; markdownSection returns one ## section's text, case-insensitively, up to the next ## and without a fenced ##; mapField returns one bold label's text up to the next label, list or fold", () => {
    expect(firstParagraph("")).toBeUndefined();
    expect(firstParagraph("## TL;DR\n\nOne.\nTwo.\n\nThree.")).toBe("One.\nTwo.");
    expect(firstParagraph("\n\n# Only headings\n## And more")).toBeUndefined();
    const body = "## TL;DR\n\nx\n\n## what & WHY\n\nWhy line.\n\n```\n## not a heading\n```\n\n## Tour\n\nsteps";
    expect(markdownSection(body, "What & why")).toBe("Why line.\n\n```\n## not a heading\n```");
    expect(markdownSection(body, "Decisions")).toBeUndefined();
    expect(markdownSection("## What & why\n\n\n", "What & why")).toBeUndefined(); // an empty section is none
    const map =
      "Tldr.\n\n**Why:** Line one.\nLine two.\n\n```\n**Risk:** fenced\n```\n\n**Where to look**\n\n1. row\n\n**Risk:** r.\n\n<details>\n<summary>Decisions (1)</summary>\n\n- **d.** r\n\n</details>";
    expect(mapField(map, "Why")).toBe("Line one.\nLine two.\n\n```\n**Risk:** fenced\n```");
    expect(mapField(map, "Risk")).toBe("r.");
    expect(mapField(map, "Verified")).toBeUndefined();
    expect(mapField("**Why:**\n\n", "Why")).toBeUndefined(); // an empty field is none
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
