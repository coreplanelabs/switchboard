import { describe, expect, it } from "vitest";
import PrReviewPanel from "./PrReviewPanel.vue";
import { mountApp } from "../../testing/mount";
import { preferredDiff, prLinks } from "./types";
import type { PrReviewData, ReadingDiff } from "./types";

// Feature: features/reading-diff.md item 6 — the pr-review module renders the
// change as a reviewer reads it, from props alone (the module is liftable; the
// host adapts its own data). These tests drive the panel purely through
// PrReviewData fixtures — no seeds, no streams.

const gitDiff: ReadingDiff = {
  poweredBy: "git",
  baseRef: "main",
  diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const OLD_MARKER = 1;\n+const NEW_MARKER = 2;\n context\n",
  truncated: false,
};
const meatDiff: ReadingDiff = {
  poweredBy: "meat",
  baseRef: "main",
  diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const OLD_MARKER = 1;\n+const NEW_MARKER = 2;\n",
  truncated: true,
  summary: "Renames the marker constant.",
};
const data = (over: Partial<PrReviewData> = {}): PrReviewData => ({
  pr: { repo: "acme/api", number: 42, headSha: "e".repeat(40), baseRef: "main" },
  readingDiffs: [gitDiff, meatDiff],
  ...over,
});

describe("prLinks", () => {
  it("builds PR / files / commit links only from shape-verified values", () => {
    expect(prLinks({ repo: "acme/api", number: 42, headSha: "e".repeat(40) })).toEqual({
      pr: "https://github.com/acme/api/pull/42",
      files: "https://github.com/acme/api/pull/42/files",
      commit: `https://github.com/acme/api/pull/42/commits/${"e".repeat(40)}`,
    });
    expect(prLinks({ repo: "acme/api", headSha: "e".repeat(40) })).toEqual({ commit: `https://github.com/acme/api/commit/${"e".repeat(40)}` });
    // hostile shapes never become URLs
    expect(prLinks({ repo: "https://evil.example/x", number: 42 })).toEqual({});
    expect(prLinks({ repo: "acme/api", number: 42, headSha: "not a sha" })).not.toHaveProperty("commit");
    expect(prLinks({})).toEqual({});
  });
});

describe("preferredDiff", () => {
  it("prefers the abridged (meat) diff, falls back to git, else null", () => {
    expect(preferredDiff([gitDiff, meatDiff])?.poweredBy).toBe("meat");
    expect(preferredDiff([gitDiff])?.poweredBy).toBe("git");
    expect(preferredDiff([])).toBeNull();
  });
});

describe("PrReviewPanel", () => {
  it("renders the PR/commit/files links and the preferred (meat) diff with badge, summary, truncation and rendered hunks", () => {
    const w = mountApp(PrReviewPanel, { props: { data: data() } });
    expect(w.find('[data-testid="pr-link"]').attributes("href")).toBe("https://github.com/acme/api/pull/42");
    expect(w.find('[data-testid="pr-link"]').text()).toBe("acme/api#42");
    expect(w.find('[data-testid="commit-link"]').text()).toBe("eeeeeee");
    expect(w.find('[data-testid="files-link"]').attributes("href")).toBe("https://github.com/acme/api/pull/42/files");
    const shown = w.find('[data-testid="reading-diff"]');
    expect(shown.text()).toContain("reading diff · meat");
    expect(shown.text()).toContain("truncated");
    expect(w.find('[data-testid="diff-summary"]').text()).toBe("Renames the marker constant.");
    // diff2html rendered the hunks: both sides of the change are visible, escaped
    expect(shown.html()).toContain("NEW_MARKER");
    expect(shown.html()).toContain("OLD_MARKER");
    w.unmount();
  });

  it("tabs between the reading diff and the full diff when both exist; a lone diff renders without tabs", () => {
    const w = mountApp(PrReviewPanel, { props: { data: data() } });
    const tabs = w.find('[data-testid="diff-tabs"]');
    expect(tabs.exists()).toBe(true);
    const buttons = tabs.findAll("button");
    expect(buttons.map((b) => b.text())).toEqual(["Reading diff", "Full diff"]);
    w.unmount();

    const lone = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [gitDiff] }) } });
    expect(lone.find('[data-testid="diff-tabs"]').exists()).toBe(false);
    expect(lone.find('[data-testid="reading-diff"]').text()).toContain("full diff · git");
    lone.unmount();
  });

  it("switching to the Full diff tab shows the git artifact", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data() } });
    await w.find('[data-testid="diff-tabs"]').findAll("button")[1].trigger("click");
    expect(w.find('[data-testid="reading-diff"]').text()).toContain("full diff · git");
    expect(w.find('[data-testid="reading-diff"]').text()).toContain("against origin/main");
    w.unmount();
  });

  it("empty state when no diffs exist; repo without a valid number renders as text, not a link", () => {
    const w = mountApp(PrReviewPanel, { props: { data: { pr: { repo: "acme/api" }, readingDiffs: [] } } });
    expect(w.find('[data-testid="no-diff"]').text()).toContain("No reading diff");
    expect(w.find('[data-testid="pr-link"]').exists()).toBe(false);
    expect(w.text()).toContain("acme/api");
    w.unmount();
  });

  it("diff content is escaped, never interpreted as markup", () => {
    const hostile: ReadingDiff = {
      poweredBy: "git",
      baseRef: "main",
      diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-<img src=x onerror="alert(1)">\n+<script>alert(2)</script>\n',
      truncated: false,
    };
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [hostile] }) } });
    const shown = w.find('[data-testid="reading-diff"]');
    // never as markup (word-level diff spans may split the text, so assert on
    // the serialized HTML for absence and on textContent for presence) …
    expect(shown.html()).not.toContain("<script>alert(2)");
    expect(shown.html()).not.toContain('<img src=x onerror="alert(1)">');
    // … but visible to the reader as text
    expect(shown.text()).toContain("alert(2)");
    expect(shown.text()).toContain("onerror");
    expect(w.findAll("script")).toHaveLength(0);
    w.unmount();
  });
});
