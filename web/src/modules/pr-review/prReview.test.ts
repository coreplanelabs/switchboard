import { describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { h, reactive } from "vue";
import PrReviewPanel from "./PrReviewPanel.vue";
import ReadingDiffView from "./ReadingDiffView.vue";
import viewSource from "./ReadingDiffView.vue?raw";
import tourSource from "./TourList.vue?raw";
import panelSource from "./PrReviewPanel.vue?raw";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mountApp } from "../../testing/mount";
import { currentFileAt, filePaths, parseFiles, rowsInRange, splitPath } from "./files";
import { anchorLabel, originNote, placementNote, placementOf, staleAnchor, staleExplanation, stepTip } from "./tour";
import { fileLink, panelTitle, poweredByExplanation, preferredDiff, prLinks, truncatedExplanation } from "./types";
import type { AbridgeState, PrDescriptionData, PrReviewData, ReadingDiff } from "./types";

// Feature: docs/reference/specs/reading-diff.md item 12 — the pr-review module renders the
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
/** Four files, every shape: a modification, an addition, a rename, a deletion. */
const manyFiles =
  "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n line one\n-line two\n+line 2\n+line 2b\n line three\n" +
  "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1,2 @@\n+export const b = 1;\n+export const c = 2;\n" +
  "diff --git a/docs/old.md b/docs/new.md\nsimilarity index 80%\nrename from docs/old.md\nrename to docs/new.md\nindex 4444444..5555555 100644\n--- a/docs/old.md\n+++ b/docs/new.md\n@@ -1,1 +1,1 @@\n-# Old\n+# New\n" +
  "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 6666666..0000000\n--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n" +
  "diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..7777777\nBinary files /dev/null and b/img.png differ\n";
const manyDiff: ReadingDiff = { poweredBy: "git", baseRef: "main", diff: manyFiles, truncated: false };

/** Rendered text without its layout whitespace (flex gaps carry the spacing). */
const squash = (s: string) => s.replace(/\s+/g, "");

const data = (over: Partial<PrReviewData> = {}): PrReviewData => ({
  pr: { repo: "acme/api", number: 42, headSha: "e".repeat(40), baseRef: "main" },
  readingDiffs: [gitDiff, meatDiff],
  ...over,
});

/** A description with a Tour over `manyFiles`: a step the abridged diff keeps,
 *  one only the full diff carries, one past every diff, one anchored at an
 *  older head. */
const desc = (over: Partial<PrDescriptionData> = {}): PrDescriptionData => ({
  title: "Retry webhook deliveries",
  tldr: "The TL;DR.",
  whatWhy: "Because a flaky receiver loses the event.",
  tour: [
    {
      title: "The marker",
      description: "Renames the marker constant so the reader sees the new one.",
      lookFor: "the new name",
      anchor: { path: "src/a.ts", from: 2, to: 3, sha: "e".repeat(40) },
    },
    {
      title: "A new module",
      description: "Adds b.",
      anchor: { path: "src/b.ts", from: 1, to: 2, sha: "e".repeat(40) },
    },
    {
      title: "Past the cap",
      description: "Not in any diff.",
      anchor: { path: "src/zzz.ts", from: 1, to: 2, sha: "e".repeat(40) },
    },
    {
      title: "Moved lines",
      description: "Anchored at an older push.",
      anchor: { path: "src/a.ts", from: 1, to: 1, sha: "d".repeat(40) },
    },
  ],
  remaining: [
    { path: "docs/new.md", note: "renamed" },
    { path: "nowhere.md", note: "past the cap" },
  ],
  origin: "parsed",
  complete: false,
  truncated: false,
  headSha: "e".repeat(40),
  ...over,
});

describe("prLinks", () => {
  it("builds PR / files / commit links only from shape-verified values", () => {
    expect(prLinks({ repo: "acme/api", number: 42, headSha: "e".repeat(40) })).toEqual({
      pr: "https://github.com/acme/api/pull/42",
      files: "https://github.com/acme/api/pull/42/files",
      commit: `https://github.com/acme/api/pull/42/commits/${"e".repeat(40)}`,
    });
    expect(prLinks({ repo: "acme/api", headSha: "e".repeat(40) })).toEqual({
      commit: `https://github.com/acme/api/commit/${"e".repeat(40)}`,
    });
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

describe("the labels' explanations (tooltips)", () => {
  it("name what a reader cannot: the producer, and where a truncated diff was cut", () => {
    expect(poweredByExplanation("git")).toBe("The complete change, base…head, as git reports it");
    expect(poweredByExplanation("meat")).toMatch(/^An abridged reading of the change/);
    expect(truncatedExplanation(120_000)).toBe(
      "The recorded diff was cut at 120,000 characters; open the full diff on GitHub for the rest",
    );
  });

  it("ride on the tabs and on the badges as tooltip triggers", () => {
    const w = mountApp(PrReviewPanel, { props: { data: data() } });
    // Reka's TooltipTrigger stamps its state on the wrapped element
    for (const b of w.findAll('[data-testid="diff-tabs"] button')) expect(b.attributes("data-state")).toBe("closed");
    expect(w.find('[data-testid="producer-badge"]').attributes("data-state")).toBe("closed");
    expect(w.find('[data-testid="truncated-badge"]').attributes("data-state")).toBe("closed");
    w.unmount();
  });
});

describe("panelTitle", () => {
  it("is the PR's title when known, else its reference, else the repo, else a generic label", () => {
    expect(panelTitle({ pr: { repo: "acme/api", number: 42 }, description: desc({ title: "Retry webhooks" }) })).toBe(
      "Retry webhooks",
    );
    expect(panelTitle({ pr: { repo: "acme/api", number: 42 } })).toBe("acme/api#42");
    expect(panelTitle({ pr: { repo: "acme/api" } })).toBe("acme/api");
    expect(panelTitle({ pr: {} })).toBe("PR review");
  });
});

describe("files", () => {
  it("parseFiles names each file by its path with status, counts, rename source and binary flag", () => {
    const files = parseFiles(manyFiles);
    expect(files.map((f) => [f.path, f.status, f.added, f.deleted, f.binary, f.from])).toEqual([
      ["src/a.ts", "modified", 2, 1, false, undefined],
      ["src/b.ts", "added", 2, 0, false, undefined],
      ["docs/new.md", "renamed", 1, 1, false, "docs/old.md"],
      ["gone.ts", "deleted", 0, 1, false, undefined],
      ["img.png", "added", 0, 0, true, undefined],
    ]);
    // each file's html is diff2html's own rendering of that file alone
    expect(files[0].html).toContain("d2h-file-wrapper");
    expect(files[0].html).toContain("2b"); // word-level matching may split "line 2b" into spans
    expect(files[0].html).not.toContain("export const b");
    expect(parseFiles("not a diff at all")).toEqual([]);
  });

  it("splitPath dims the directory and keeps the name", () => {
    expect(splitPath("src/webhooks/sender.ts")).toEqual({ dir: "src/webhooks/", name: "sender.ts" });
    expect(splitPath("package.json")).toEqual({ dir: "", name: "package.json" });
  });

  it("currentFileAt: the last file whose top passed the edge; the first before any; the last at the end", () => {
    const tops = [0, 400, 900, 1300];
    expect(currentFileAt(tops, 0, false)).toBe(0);
    expect(currentFileAt(tops, 397, false)).toBe(0);
    expect(currentFileAt(tops, 398, false)).toBe(1); // two pixels of slack: a file at the edge counts
    expect(currentFileAt(tops, 1000, false)).toBe(2);
    expect(currentFileAt(tops, 1000, true)).toBe(3);
    expect(currentFileAt([], 0, false)).toBe(-1);
  });

  it("rowsInRange covers the rows whose new line is in range plus the deletions between them", () => {
    // rows: hunk header, ctx 1, del (no new line), ins 2, ins 3, ctx 4
    const newLines = [null, 1, null, 2, 3, 4];
    expect(rowsInRange(newLines, 2, 3)).toEqual([3, 4]);
    expect(rowsInRange(newLines, 1, 2)).toEqual([1, 2, 3]); // the deletion between 1 and 2 rides along
    expect(rowsInRange(newLines, 3, 1)).toEqual([1, 2, 3, 4]); // order-insensitive
    expect(rowsInRange(newLines, 40, 50)).toEqual([]);
  });
});

describe("the stylesheet", () => {
  it("is diff2html's own, imported whole — the structure tracks upstream", () => {
    expect(viewSource).toContain('import "diff2html/bundles/css/diff2html.min.css";');
    // the stylesheet resolves from this package (vitest loads CSS as empty, so read it)
    const require = createRequire(join(process.cwd(), "package.json"));
    const css = readFileSync(require.resolve("diff2html/bundles/css/diff2html.min.css"), "utf8");
    // the structural rules the hand-reduced copy had lost
    expect(css).toMatch(/\.d2h-code-linenumber\{[^}]*position:absolute/);
    expect(css).toMatch(/\.line-num2\{float:right\}/);
    expect(css).toMatch(/\.d2h-code-line-prefix\{[^}]*display:inline/);
  });
});

describe("PrReviewPanel", () => {
  it("renders the title, the facts line (reference, head, base, counts, producer, truncation, files link) and the preferred (meat) diff", () => {
    const w = mountApp(PrReviewPanel, { props: { data: data() } });
    expect(w.find('[data-testid="pr-title"]').text()).toBe("acme/api#42");
    expect(w.find('[data-testid="pr-title"] a').attributes("href")).toBe("https://github.com/acme/api/pull/42");
    expect(w.find('[data-testid="pr-link"]').attributes("href")).toBe("https://github.com/acme/api/pull/42");
    expect(w.find('[data-testid="pr-link"]').text()).toBe("acme/api#42");
    expect(w.find('[data-testid="commit-link"]').text()).toBe("eeeeeee");
    expect(w.find('[data-testid="files-link"]').attributes("href")).toBe("https://github.com/acme/api/pull/42/files");
    const facts = w.find('[data-testid="pr-facts"]').text();
    expect(facts).toContain("against origin/main");
    expect(facts).toContain("reading diff · meat");
    expect(facts).toContain("truncated");
    expect(squash(w.find('[data-testid="pr-totals"]').text())).toBe("1file,+1−1");
    expect(w.find('[data-testid="diff-summary"]').text()).toBe("Renames the marker constant.");
    expect(w.find('[data-testid="diff-lede"] h3').text()).toBe("Summary · meat");
    // diff2html rendered the hunks: both sides of the change are visible, escaped
    const shown = w.find('[data-testid="reading-diff"]');
    expect(shown.html()).toContain("NEW_MARKER");
    expect(shown.html()).toContain("OLD_MARKER");
    w.unmount();
  });

  it("a known PR title becomes the header; the close control appears only for a closable host and emits close", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ description: desc() }), closable: true } });
    expect(w.find('[data-testid="pr-title"]').text()).toBe("Retry webhook deliveries");
    await w.find('[data-testid="panel-close"]').trigger("click");
    expect(w.findComponent(PrReviewPanel).emitted("close")).toHaveLength(1);
    w.unmount();

    const plain = mountApp(PrReviewPanel, { props: { data: data() } });
    expect(plain.find('[data-testid="panel-close"]').exists()).toBe(false);
    plain.unmount();
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
    expect(lone.find('[data-testid="pr-facts"]').text()).toContain("full diff · git");
    lone.unmount();
  });

  it("switching to the Full diff tab shows the git artifact", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data() } });
    await w.find('[data-testid="diff-tabs"]').findAll("button")[1].trigger("click");
    expect(w.find('[data-testid="pr-facts"]').text()).toContain("full diff · git");
    expect(w.find('[data-testid="pr-facts"]').text()).not.toContain("truncated");
    expect(w.find('[data-testid="reading-diff"]').text()).toContain("context");
    w.unmount();
  });

  it("the file list is a table of contents: one entry per file with counts; clicking one selects it and scrolls the view to it", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff] }) } });
    const entries = w.findAll('[data-testid="file-entry"]');
    expect(entries.map((e) => e.attributes("title"))).toEqual([
      "src/a.ts",
      "src/b.ts",
      "docs/old.md → docs/new.md",
      "gone.ts",
      "img.png",
    ]);
    expect(entries[0].text()).toContain("+2");
    expect(entries[0].text()).toContain("−1");
    expect(entries[4].text()).toContain("bin");
    expect(squash(w.find('[data-testid="pr-totals"]').text())).toBe("5files,+5−3");
    // the first file is current before any scroll
    expect(entries[0].attributes("aria-current")).toBe("true");
    const scrollTo = vi.fn();
    (w.find('[data-testid="reading-diff"]').element as HTMLElement).scrollTo = scrollTo;
    await entries[2].trigger("click");
    expect(w.findAll('[data-testid="file-entry"]')[2].attributes("aria-current")).toBe("true");
    expect(w.findAll('[data-testid="file-entry"]')[0].attributes("aria-current")).toBeUndefined();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // every file section is addressable by its path
    expect(w.findAll('[data-testid="diff-file"]').map((s) => s.attributes("data-path"))).toEqual([
      "src/a.ts",
      "src/b.ts",
      "docs/new.md",
      "gone.ts",
      "img.png",
    ]);
    w.unmount();
  });

  it("the diff column ends with a footer: the counts for a full diff, 'N of M files shown' for the abridged one beside a full one", async () => {
    const both = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff, meatDiff] }) } });
    expect(squash(both.find('[data-testid="diff-end"]').text())).toBe("Endofreadingdiff·1of5filesshown");
    await both.find('[data-testid="diff-tabs"]').findAll("button")[1].trigger("click");
    expect(squash(both.find('[data-testid="diff-end"]').text())).toBe("Endofdiff·5files·+5−3");
    both.unmount();

    const lone = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [meatDiff] }) } });
    expect(squash(lone.find('[data-testid="diff-end"]').text())).toBe("Endofdiff·1file·+1−1"); // nothing to compare against
    lone.unmount();

    const empty = mountApp(PrReviewPanel, {
      props: { data: data({ readingDiffs: [{ ...gitDiff, diff: "…[120 000 more chars]" }] }) },
    });
    expect(empty.find('[data-testid="diff-end"]').exists()).toBe(false);
    empty.unmount();
  });

  it("the left column seats the host's description and tour slots above the files, in that order", () => {
    const w = mountApp(PrReviewPanel, {
      props: { data: data({ readingDiffs: [manyDiff] }) },
      slots: {
        description: () => h("p", { "data-testid": "host-description" }, "the TL;DR"),
        tour: () => h("ol", { "data-testid": "host-tour" }, "the steps"),
      },
    });
    const list = w.find('[data-testid="file-list"]');
    const order = list.findAll('[data-testid="host-description"], [data-testid="host-tour"], .files h3');
    expect(order.map((e) => e.text())).toEqual(["the TL;DR", "the steps", "Files 5"]);
    w.unmount();
  });

  it("viewed folds the file (header stays, body hidden) and marks its entry; unmarking unfolds it", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff] }) } });
    const body = () => w.findAll('[data-testid="file-body"]')[1].element as HTMLElement;
    const entry = () => w.findAll('[data-testid="file-entry"]')[1];
    expect(body().style.display).not.toBe("none");
    await w.findAll('[data-testid="file-viewed"]')[1].setValue(true);
    expect(body().style.display).toBe("none");
    expect(w.findAll('[data-testid="diff-file"]')[1].text()).toContain("src/b.ts"); // the header stays
    expect(entry().classes()).toContain("text-dimmed");
    expect((w.findAll('[data-testid="file-entry-viewed"]')[1].element as HTMLInputElement).checked).toBe(true);
    // the mark is one state for both columns: unmarking from the list unfolds the file
    await w.findAll('[data-testid="file-entry-viewed"]')[1].setValue(false);
    expect(body().style.display).not.toBe("none");
    expect(entry().classes()).not.toContain("text-dimmed");
    w.unmount();
  });

  it("the collapse chevron folds and unfolds a file on its own, and a viewed mark folds a file the chevron had opened", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff] }) } });
    const body = () => w.findAll('[data-testid="file-body"]')[0].element as HTMLElement;
    const chevron = () => w.findAll('[data-testid="file-collapse"]')[0];
    expect(chevron().attributes("aria-expanded")).toBe("true");
    await chevron().trigger("click");
    expect(body().style.display).toBe("none");
    expect(chevron().attributes("aria-expanded")).toBe("false");
    await chevron().trigger("click");
    expect(body().style.display).not.toBe("none");
    await w.findAll('[data-testid="file-viewed"]')[0].setValue(true);
    expect(body().style.display).toBe("none");
    w.unmount();
  });

  it("viewed marks survive a tab switch (kept per path for the panel's lifetime)", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data() } });
    await w.find('[data-testid="file-viewed"]').setValue(true);
    await w.find('[data-testid="diff-tabs"]').findAll("button")[1].trigger("click");
    expect((w.find('[data-testid="file-viewed"]').element as HTMLInputElement).checked).toBe(true);
    expect((w.find('[data-testid="file-body"]').element as HTMLElement).style.display).toBe("none");
    w.unmount();
  });

  it("the wrap toggle flips the view's wrap class", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data() } });
    expect(w.find('[data-testid="reading-diff"]').classes()).not.toContain("wrap");
    await w.find('[data-testid="wrap-toggle"]').trigger("click");
    expect(w.find('[data-testid="reading-diff"]').classes()).toContain("wrap");
    w.unmount();
  });

  it("empty state when no diffs exist; repo without a valid number renders as text, not a link", () => {
    const w = mountApp(PrReviewPanel, { props: { data: { pr: { repo: "acme/api" }, readingDiffs: [] } } });
    expect(w.find('[data-testid="no-diff"]').text()).toContain("No reading diff");
    expect(w.find('[data-testid="pr-link"]').exists()).toBe(false);
    expect(w.find('[data-testid="pr-title"]').text()).toBe("acme/api");
    expect(w.find('[data-testid="file-list"]').exists()).toBe(false);
    w.unmount();
  });

  it("a diff that parses to no files says so instead of rendering nothing", () => {
    const w = mountApp(PrReviewPanel, {
      props: { data: data({ readingDiffs: [{ ...gitDiff, diff: "…[120 000 more chars]" }] }) },
    });
    expect(w.find('[data-testid="no-files"]').exists()).toBe(true);
    expect(squash(w.find('[data-testid="pr-totals"]').text())).toBe("0files,+0−0");
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

describe("ReadingDiffView.scrollTo(path, fromLine, toLine)", () => {
  const mountView = (viewed: Set<string> = new Set()) => {
    const files = parseFiles(manyFiles);
    const w = mountApp(ReadingDiffView, {
      props: { diff: manyDiff, files, current: null, viewed, wrap: false },
    });
    const container = w.find('[data-testid="reading-diff"]').element as HTMLElement;
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;
    const view = w.findComponent(ReadingDiffView).vm as unknown as {
      scrollTo(path: string, from: number, to: number): Promise<boolean>;
      scrollToFile(path: string): boolean;
    };
    return { w, view, scrollTo };
  };
  const rect = (top: number, height = 20) =>
    ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  it("lights the rows of the new-side line range (deletions between them included) and scrolls the container to them", async () => {
    const { w, view, scrollTo } = mountView();
    expect(await view.scrollTo("src/a.ts", 2, 3)).toBe(true);
    const texts = () => w.findAll("tr.is-focus").map((r) => r.text().replace(/\s+/g, " ").trim());
    // new lines 2 and 3 are the two insertions; diff2html interleaves the
    // matched deletion of old line 2 between them, and it rides along
    expect(texts()).toHaveLength(3);
    expect(texts()).toEqual(expect.arrayContaining(["2 + line 2", "2 - line two", "3 + line 2b"]));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // a new call moves the light: the range ends at new line 2 now
    expect(await view.scrollTo("src/a.ts", 1, 2)).toBe(true);
    expect(texts()[0]).toBe("1 1 line one");
    expect(texts().at(-1)).toBe("2 + line 2");
    expect(texts()).not.toContain("3 + line 2b");
    w.unmount();
  });

  it("an unknown file or a range the diff does not carry lights nothing, answers false, and leaves the previous light alone", async () => {
    const { w, view, scrollTo } = mountView();
    expect(await view.scrollTo("src/nowhere.ts", 1, 2)).toBe(false);
    expect(await view.scrollTo("src/a.ts", 400, 410)).toBe(false);
    expect(w.findAll("tr.is-focus")).toHaveLength(0);
    expect(scrollTo).not.toHaveBeenCalled();
    // a lit range survives a miss — a Tour step that points off the abridged
    // diff must not unlight the one the reader is on
    expect(await view.scrollTo("src/a.ts", 2, 3)).toBe(true);
    expect(w.findAll("tr.is-focus")).toHaveLength(3);
    expect(await view.scrollTo("src/nowhere.ts", 1, 2)).toBe(false);
    expect(await view.scrollTo("src/a.ts", 400, 410)).toBe(false);
    expect(w.findAll("tr.is-focus")).toHaveLength(3);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("a folded (viewed) file is unfolded and measured after the unfold renders, so the scroll lands on the row", async () => {
    const { w, view, scrollTo } = mountView(new Set(["src/a.ts"]));
    const section = w.find('[data-testid="diff-file"]');
    const body = section.find('[data-testid="file-body"]').element as HTMLElement;
    expect(body.style.display).toBe("none");
    // Geometry the way a browser reports it: nothing while the body is
    // display:none, real offsets once it renders.
    const measured = () => body.style.display !== "none";
    (section.find("header").element as HTMLElement).getBoundingClientRect = () => rect(0, 32);
    for (const row of section.findAll("tr")) {
      (row.element as HTMLElement).getBoundingClientRect = () => (measured() ? rect(500) : rect(0, 0));
    }
    expect(await view.scrollTo("src/a.ts", 2, 3)).toBe(true);
    expect(body.style.display).not.toBe("none");
    // the row's top (500) minus the sticky header (32) and one line of room (24)
    expect(scrollTo).toHaveBeenCalledWith({ top: 444 });
    w.unmount();
  });

  it("scrollToFile scrolls to a known file and answers false for an unknown one", () => {
    const { view, scrollTo, w } = mountView();
    expect(view.scrollToFile("gone.ts")).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(view.scrollToFile("nope")).toBe(false);
    w.unmount();
  });
});

describe("the Tour's pure helpers", () => {
  it("anchorLabel is path:from–to, one number for a single line", () => {
    expect(anchorLabel({ path: "src/a.ts", from: 31, to: 40 })).toBe("src/a.ts:31–40");
    expect(anchorLabel({ path: "src/a.ts", from: 7, to: 7 })).toBe("src/a.ts:7");
  });

  it("staleAnchor: differs from the reviewed head — a prefix of it is the same head; an unknown sha on either side is not stale", () => {
    const head = "e".repeat(40);
    expect(staleAnchor({ path: "a", from: 1, to: 1, sha: head }, head)).toBe(false);
    expect(staleAnchor({ path: "a", from: 1, to: 1, sha: "eeeeeee" }, head)).toBe(false);
    expect(staleAnchor({ path: "a", from: 1, to: 1, sha: "d".repeat(40) }, head)).toBe(true);
    expect(staleAnchor({ path: "a", from: 1, to: 1 }, head)).toBe(false);
    expect(staleAnchor({ path: "a", from: 1, to: 1, sha: "d".repeat(40) }, undefined)).toBe(false);
    expect(staleExplanation("d".repeat(40), "e".repeat(40))).toBe(
      "anchored at ddddddd, the review is at eeeeeee; lines may have moved",
    );
  });

  it("originNote: a parsed, incomplete description says so, and that there is no Tour when there is none; submitted or complete says nothing", () => {
    expect(originNote(desc())).toBe("description read from the PR body");
    expect(originNote(desc({ tour: [] }))).toBe("description read from the PR body; no Tour");
    expect(originNote(desc({ complete: true }))).toBeUndefined();
    expect(originNote(desc({ origin: "submitted" }))).toBeUndefined();
  });

  it("placementOf: in the shown diff, only in the full one, beyond a full diff cut at its cap, or in neither", () => {
    const shown = new Set(["src/a.ts"]);
    const full = new Set(["src/a.ts", "src/b.ts"]);
    expect(placementOf("src/a.ts", shown, full)).toBe("shown");
    expect(placementOf("src/b.ts", shown, full)).toBe("full");
    expect(placementOf("src/zzz.ts", shown, full)).toBe("absent");
    expect(placementOf("src/zzz.ts", shown, full, true)).toBe("beyond");
    expect(placementOf("src/a.ts", shown, full, true)).toBe("shown");
  });

  it("placementNote says where the jump goes — or that it cannot; stepTip is the title and description whole", () => {
    expect(placementNote("shown", false, false)).toBeUndefined();
    expect(placementNote("shown", false, true)).toBe("lines not in this diff");
    expect(placementNote("full", false, false)).toBe("not in the reading diff · open full diff");
    expect(placementNote("beyond", true, false)).toBe("beyond the recorded diff · open on GitHub ↗");
    expect(placementNote("beyond", false, false)).toBe("beyond the recorded diff");
    expect(placementNote("absent", false, false)).toBe("not in this diff");
    expect(stepTip({ title: "The marker", description: "Renames it." })).toBe("The marker — Renames it.");
    expect(stepTip({ title: "The marker", description: "" })).toBe("The marker");
  });

  it("fileLink: the file on GitHub at the reviewed head with the lines selected, from shape-verified values only", () => {
    const pr = { repo: "acme/api", headSha: "e".repeat(40) };
    const base = `https://github.com/acme/api/blob/${"e".repeat(40)}`;
    expect(fileLink(pr, { path: "src/a b.ts", from: 3, to: 9 })).toBe(`${base}/src/a%20b.ts#L3-L9`);
    expect(fileLink(pr, { path: "src/a.ts", from: 5, to: 5 })).toBe(`${base}/src/a.ts#L5`);
    expect(fileLink(pr, { path: "CHANGELOG.md" })).toBe(`${base}/CHANGELOG.md`);
    for (const path of ["../x.ts", "src//a.ts", "/etc/passwd", "src/./a.ts", "src\\a.ts", "src/a\u0000.ts", ""]) {
      expect(fileLink(pr, { path, from: 1, to: 2 }), path).toBeUndefined();
    }
    expect(fileLink({ repo: "acme/api" }, { path: "src/a.ts" })).toBeUndefined();
    expect(fileLink({ repo: "acme/api", headSha: "not-a-sha" }, { path: "src/a.ts" })).toBeUndefined();
    expect(fileLink({ repo: "javascript:alert(1)//x", headSha: "e".repeat(40) }, { path: "src/a.ts" })).toBeUndefined();
  });

  it("filePaths names a diff's files by the same key parseFiles uses, without rendering", () => {
    expect(filePaths(manyFiles)).toEqual(["src/a.ts", "src/b.ts", "docs/new.md", "gone.ts", "img.png"]);
    expect(filePaths("")).toEqual([]);
  });
});

describe("the PR description in the panel", () => {
  it("no description → no description block and no Tour: the file list starts at the top", () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff] }) } });
    expect(w.find('[data-testid="pr-description"]').exists()).toBe(false);
    expect(w.find('[data-testid="tour"]').exists()).toBe(false);
    expect(w.find('[data-testid="file-list"]').element.firstElementChild?.classList.contains("files")).toBe(true);
    w.unmount();
  });

  it("the description block: the TL;DR in the clamp, What & why after it, the origin note for a parsed incomplete description; a complete one carries no note; a Tour-less description renders the block alone", () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff], description: desc() }) } });
    const block = w.find('[data-testid="pr-description"]');
    // the app's ExpandableText, folded to five lines over the column's ground
    expect((block.find(".expandable .body").element as HTMLElement).style.getPropertyValue("--expandable-lines")).toBe(
      "5",
    );
    expect((block.find(".expandable").element as HTMLElement).style.getPropertyValue("--expandable-surface")).toBe(
      "var(--ui-bg)",
    );
    expect(block.find(".expandable [data-testid='description-tldr']").text()).toBe("The TL;DR.");
    expect(block.find(".expandable [data-testid='description-what-why']").text()).toBe(
      "Because a flaky receiver loses the event.",
    );
    expect(block.find("h4").text()).toBe("What & why");
    expect(block.find('[data-testid="description-origin"]').text()).toBe("description read from the PR body");
    // the block precedes the Tour, which precedes the files
    const order = w
      .find('[data-testid="file-list"]')
      .findAll('[data-testid="pr-description"], [data-testid="tour"], .files h3')
      .map((e) => e.attributes("data-testid") ?? e.text());
    expect(order).toEqual(["pr-description", "tour", "Files 5"]);
    w.unmount();

    const complete = mountApp(PrReviewPanel, {
      props: { data: data({ readingDiffs: [manyDiff], description: desc({ origin: "submitted", complete: true }) }) },
    });
    expect(complete.find('[data-testid="description-origin"]').exists()).toBe(false);
    complete.unmount();

    const tourless = mountApp(PrReviewPanel, {
      props: {
        data: data({ readingDiffs: [manyDiff], description: desc({ tour: [], remaining: [], whatWhy: undefined }) }),
      },
    });
    expect(tourless.find('[data-testid="pr-description"]').exists()).toBe(true);
    expect(tourless.find("h4").exists()).toBe(false);
    expect(tourless.find('[data-testid="tour"]').exists()).toBe(false);
    expect(tourless.find('[data-testid="description-origin"]').text()).toBe(
      "description read from the PR body; no Tour",
    );
    tourless.unmount();
  });

  it("the Tour lists every step — number, title, description, Look for, the anchor in mono — with its placement against the shown and the full diff, and the stale badge on a step anchored at another head", () => {
    const w = mountApp(PrReviewPanel, {
      props: { data: data({ readingDiffs: [manyDiff, meatDiff], description: desc() }) },
    });
    expect(squash(w.find('[data-testid="tour"] h3').text())).toBe("Tour·4steps");
    const steps = w.findAll('[data-testid="tour-step"]');
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => s.attributes("data-placement"))).toEqual(["shown", "full", "absent", "shown"]);
    expect(steps[0].find(".step-number").text()).toBe("1");
    expect(steps[0].find(".step-title").text()).toBe("The marker");
    expect(steps[0].find(".step-title").classes()).toContain("font-medium");
    expect(steps[0].find(".step-description").text()).toBe(
      "Renames the marker constant so the reader sees the new one.",
    );
    expect(steps[0].find(".step-description").classes()).toContain("line-clamp-2");
    expect(steps[0].find(".step-look-for").text()).toBe("Look for: the new name");
    expect(steps[1].find(".step-look-for").exists()).toBe(false);
    expect(steps[0].find(".step-anchor").text()).toBe("src/a.ts:2–3");
    expect(steps[0].find(".step-anchor").classes()).toContain("font-mono");
    expect(steps[1].find('[data-testid="tour-step-note"]').text()).toBe("not in the reading diff · open full diff");
    expect(steps[2].find('[data-testid="tour-step-note"]').text()).toBe("not in this diff");
    expect(steps[0].find('[data-testid="tour-step-note"]').exists()).toBe(false);
    // the stale badge, with its explanation as the accessible name and a tooltip trigger
    expect(steps.map((s) => s.find('[data-testid="tour-step-stale"]').exists())).toEqual([false, false, false, true]);
    const badge = steps[3].find('[data-testid="tour-step-stale"]');
    expect(badge.attributes("aria-label")).toBe("anchored at ddddddd, the review is at eeeeeee; lines may have moved");
    // the step itself is the one tooltip trigger; the stale explanation rides it (no nested trigger on the badge)
    expect(steps[3].attributes("data-state")).toBe("closed");
    expect(badge.attributes("data-state")).toBeUndefined();
    w.unmount();
  });

  it("clicking a step in the shown diff lights its lines, scrolls to them, makes the step active (aria-current, the accent, the clamp kept) and its file current", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff], description: desc() }) } });
    const scrollTo = vi.fn();
    (w.find('[data-testid="reading-diff"]').element as HTMLElement).scrollTo = scrollTo;
    const steps = () => w.findAll('[data-testid="tour-step"]');
    expect(steps()[1].attributes("aria-current")).toBeUndefined();
    await steps()[1].trigger("click");
    await w.vm.$nextTick();
    expect(steps()[1].attributes("aria-current")).toBe("step");
    expect(steps()[1].classes()).toContain("is-active");
    expect(steps()[1].find(".step-description").classes()).toContain("line-clamp-2");
    expect(w.findAll("tr.is-focus").map((r) => r.text().replace(/\s+/g, " ").trim())).toEqual([
      "1 + export const b = 1;",
      "2 + export const c = 2;",
    ]);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(w.findAll('[data-testid="file-entry"]')[1].attributes("aria-current")).toBe("true");
    // another step moves the light and the active mark
    await steps()[0].trigger("click");
    await w.vm.$nextTick();
    expect(steps()[0].attributes("aria-current")).toBe("step");
    expect(steps()[1].attributes("aria-current")).toBeUndefined();
    expect(w.findAll("tr.is-focus")).toHaveLength(3);
    w.unmount();
  });

  it("a step whose file only the full diff carries switches to the full diff, then scrolls; a step whose lines the abridged diff dropped does the same", async () => {
    const w = mountApp(PrReviewPanel, {
      props: { data: data({ readingDiffs: [manyDiff, meatDiff], description: desc() }) },
    });
    const stub = () => ((w.find('[data-testid="reading-diff"]').element as HTMLElement).scrollTo = vi.fn());
    stub();
    expect(w.find('[data-testid="pr-facts"]').text()).toContain("reading diff · meat");
    await w.findAll('[data-testid="tour-step"]')[1].trigger("click");
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    expect(w.find('[data-testid="pr-facts"]').text()).toContain("full diff · git");
    expect(w.findAll('[data-testid="tour-step"]')[1].attributes("aria-current")).toBe("step");
    expect(w.findAll("tr.is-focus")).toHaveLength(2);
    // every step is now in the shown (full) diff except the one past the cap
    expect(w.findAll('[data-testid="tour-step"]').map((s) => s.attributes("data-placement"))).toEqual([
      "shown",
      "shown",
      "absent",
      "shown",
    ]);
    w.unmount();

    const dropped = mountApp(PrReviewPanel, {
      props: { data: data({ readingDiffs: [manyDiff, meatDiff], description: desc() }) },
    });
    (dropped.find('[data-testid="reading-diff"]').element as HTMLElement).scrollTo = vi.fn();
    // step 1 is src/a.ts 2–3: the abridged hunk keeps only line 1 of that file
    await dropped.findAll('[data-testid="tour-step"]')[0].trigger("click");
    await dropped.vm.$nextTick();
    await dropped.vm.$nextTick();
    expect(dropped.find('[data-testid="pr-facts"]').text()).toContain("full diff · git");
    expect(dropped.findAll("tr.is-focus")).toHaveLength(3);
    dropped.unmount();
  });

  it("a step absent from every diff is muted and inert; a Tour whose every anchor is missing still lists every step, all muted; a step whose lines no diff carries lands on the file and says so", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff], description: desc() }) } });
    const scrollTo = vi.fn();
    (w.find('[data-testid="reading-diff"]').element as HTMLElement).scrollTo = scrollTo;
    const absent = w.findAll('[data-testid="tour-step"]')[2];
    expect(absent.classes()).toContain("is-muted");
    await absent.trigger("click");
    await w.vm.$nextTick();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(w.findAll('[data-testid="tour-step"]')[2].attributes("aria-current")).toBeUndefined();
    w.unmount();

    const gone = mountApp(PrReviewPanel, {
      props: {
        data: data({
          readingDiffs: [manyDiff],
          description: desc({
            tour: desc().tour.map((s) => ({ ...s, anchor: { ...s.anchor, path: "elsewhere/" + s.anchor.path } })),
          }),
        }),
      },
    });
    const steps = gone.findAll('[data-testid="tour-step"]');
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.classes().includes("is-muted"))).toBe(true);
    expect(steps.every((s) => s.attributes("data-placement") === "absent")).toBe(true);
    gone.unmount();

    const moved = mountApp(PrReviewPanel, {
      props: {
        data: data({
          readingDiffs: [manyDiff],
          description: desc({ tour: [{ ...desc().tour[0], anchor: { path: "src/a.ts", from: 400, to: 410 } }] }),
        }),
      },
    });
    const movedScroll = vi.fn();
    (moved.find('[data-testid="reading-diff"]').element as HTMLElement).scrollTo = movedScroll;
    await moved.find('[data-testid="tour-step"]').trigger("click");
    await moved.vm.$nextTick();
    expect(moved.find('[data-testid="tour-step"]').attributes("aria-current")).toBe("step");
    expect(moved.find('[data-testid="tour-step-note"]').text()).toBe("lines not in this diff");
    expect(moved.findAll("tr.is-focus")).toHaveLength(0);
    expect(movedScroll).toHaveBeenCalledTimes(1); // the file, at least
    moved.unmount();
  });

  it("Remaining changes list path and note; a path opens its file the same way (switching to the full diff when needed); a path in no diff is muted", async () => {
    const w = mountApp(PrReviewPanel, {
      props: { data: data({ readingDiffs: [manyDiff, meatDiff], description: desc() }) },
    });
    const scrollTo = vi.fn();
    (w.find('[data-testid="reading-diff"]').element as HTMLElement).scrollTo = scrollTo;
    expect(w.find('[data-testid="tour-remaining"] h4').text()).toBe("Remaining changes");
    const entries = w.findAll('[data-testid="tour-remaining-entry"]');
    expect(entries.map((e) => squash(e.text()))).toEqual(["docs/new.md—renamed", "nowhere.md—pastthecap"]);
    expect(entries[0].find("button").classes()).toContain("font-mono");
    expect(entries[1].find("button").classes()).toContain("is-muted");
    await entries[0].find("button").trigger("click");
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    expect(w.find('[data-testid="pr-facts"]').text()).toContain("full diff · git");
    expect(w.findAll('[data-testid="file-entry"]')[2].attributes("aria-current")).toBe("true");
    expect((w.find('[data-testid="reading-diff"]').element as HTMLElement).scrollTo).toHaveBeenCalled();
    w.unmount();
  });

  it("steps are native buttons — Enter and Space activate them — with a visible focus ring", () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff], description: desc() }) } });
    for (const s of w.findAll('[data-testid="tour-step"]')) {
      expect(s.element.tagName).toBe("BUTTON");
      expect(s.attributes("type")).toBe("button");
      expect(s.classes()).toContain("focus-visible:ring-2");
    }
    w.unmount();
  });
});

describe("the Tour holds still, jumps clearly, and says when a file lies past the recorded diff", () => {
  /** The recorded full diff of a change too large for its cap, cut the way
   *  the producer cuts it: `src/a.ts` and the NEW `src/b.ts` whole, the rename
   *  open-ended at the marker — every later file never recorded. */
  const cappedFiles = manyFiles.slice(0, manyFiles.indexOf("@@ -1,1 +1,1 @@\n-# Old")) + "…[9999 more chars]";
  const cappedDiff: ReadingDiff = { poweredBy: "git", baseRef: "main", diff: cappedFiles, truncated: true };
  /** Layout the DOM has none of: every clamp hides lines, every truncate hides text. */
  function overflowEverywhere(): () => void {
    const define = (name: string, value: number) =>
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    define("scrollHeight", 40);
    define("clientHeight", 20);
    define("scrollWidth", 400);
    define("clientWidth", 200);
    return () => {
      for (const name of ["scrollHeight", "clientHeight", "scrollWidth", "clientWidth"]) {
        Reflect.deleteProperty(HTMLElement.prototype, name);
      }
    };
  }
  /** Every element's class list under the Tour, in document order — the layout inputs a hover could touch. */
  const classesUnder = (root: Element) => Array.from(root.querySelectorAll("*")).map((el) => el.className);

  it("hovering a step changes no element's classes and the clamps are fixed: nothing hover- or active-driven changes a size", async () => {
    // No hover-driven size change is even expressible in the template.
    expect(tourSource).not.toMatch(/group-hover:/);
    expect(tourSource).not.toMatch(/hover:(?:line-clamp|h-|max-h|min-h|p[xytblr]?-|text-\[|leading)/);
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff], description: desc() }) } });
    (w.find('[data-testid="reading-diff"]').element as HTMLElement).scrollTo = vi.fn();
    const tour = w.find('[data-testid="tour"]');
    const before = classesUnder(tour.element);
    for (const step of w.findAll('[data-testid="tour-step"]')) {
      await step.trigger("pointerenter");
      await step.trigger("pointermove");
      await step.trigger("mouseenter");
      await step.trigger("mouseover");
      await step.find(".step-prose").trigger("pointermove");
    }
    expect(classesUnder(tour.element)).toEqual(before);
    // Active changes color only: both clamps stay, on the active step as on the rest.
    await w.findAll('[data-testid="tour-step"]')[0].trigger("click");
    await w.vm.$nextTick();
    for (const step of w.findAll('[data-testid="tour-step"]')) {
      expect(step.find(".step-title").classes()).toContain("line-clamp-2");
      if (step.find(".step-description").exists())
        expect(step.find(".step-description").classes()).toContain("line-clamp-2");
      expect(step.find(".step-anchor").classes()).toContain("truncate");
    }
    const active = w.findAll('[data-testid="tour-step"]')[0];
    expect(active.classes()).toContain("is-active");
    expect(active.classes()).not.toContain("hover:bg-muted");
    // The accent the lit rows carry, on the step too — colour, not a box.
    expect(tourSource).toMatch(/\.tour \.step\.is-active \{[^}]*box-shadow: inset 3px 0 0 var\(--pr-review-mark\)/);
    expect(viewSource).toMatch(/tr\.is-focus td \{[^}]*box-shadow:\s*inset 3px 0 0 var\(--pr-review-mark\)/);
    // a third hue, not the insertion green: the panel defines it and a host may retune it
    expect(panelSource).toMatch(/\.pr-review-panel \{[^}]*--pr-review-mark: var\(--ui-info/);
    w.unmount();
  });

  it("what a clamp hides rides the step's own tooltip — the title and description whole, the full path, the stale note — opening on keyboard focus, and only while something is hidden", async () => {
    const tips = () => Array.from(document.body.querySelectorAll('[data-slot="text"]')).map((n) => n.textContent);
    const restore = overflowEverywhere();
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff], description: desc() }) } });
    await w.vm.$nextTick();
    const steps = w.findAll('[data-testid="tour-step"]');
    // The step element (a native button) is the trigger: Tab reaches it, and a focused reka
    // trigger opens at once (no delay) — a keyboard user reads what the clamp hides.
    await steps[0].trigger("focus");
    await w.vm.$nextTick();
    expect(tips()).toEqual(["The marker — Renames the marker constant so the reader sees the new one. · src/a.ts:2–3"]);
    await steps[0].trigger("blur");
    // A step anchored at another head carries the stale explanation in the same tooltip.
    await steps[3].trigger("focus");
    await w.vm.$nextTick();
    expect(tips()).toEqual([
      "Moved lines — Anchored at an older push. · src/a.ts:1 · anchored at ddddddd, the review is at eeeeeee; lines may have moved",
    ]);
    await steps[3].trigger("blur");
    // The anchor truncates from the left: the file name is the part that stays.
    expect(steps[0].find(".step-anchor").attributes("dir")).toBe("rtl");
    expect(steps[0].find(".step-anchor bdi").text()).toBe("src/a.ts:2–3");
    w.unmount();
    restore();

    // Without overflow a step is quiet — no tooltip repeats visible text — except the stale note, always worth one.
    const fits = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff], description: desc() }) } });
    await fits.vm.$nextTick();
    await fits.findAll('[data-testid="tour-step"]')[0].trigger("focus");
    await fits.vm.$nextTick();
    expect(tips()).toEqual([]);
    await fits.findAll('[data-testid="tour-step"]')[3].trigger("focus");
    await fits.vm.$nextTick();
    expect(tips()).toEqual(["anchored at ddddddd, the review is at eeeeeee; lines may have moved"]);
    fits.unmount();
  });

  it("an in-place change to a step's text is remeasured: the tooltip follows the words, not the step's identity", async () => {
    const tips = () => Array.from(document.body.querySelectorAll('[data-slot="text"]')).map((n) => n.textContent);
    const live = reactive(data({ readingDiffs: [manyDiff], description: desc() }));
    const w = mountApp(PrReviewPanel, { props: { data: live } });
    await w.vm.$nextTick();
    // Nothing overflows at mount: the step is quiet.
    await w.findAll('[data-testid="tour-step"]')[1].trigger("focus");
    await w.vm.$nextTick();
    expect(tips()).toEqual([]);
    await w.findAll('[data-testid="tour-step"]')[1].trigger("blur");
    // The text changes in place (same array, same step object) — and now the layout says it overflows.
    const restore = overflowEverywhere();
    live.description!.tour[1].description = "Adds b, and a great deal more than two lines can hold about it.";
    // the deep watch → the post-render remeasure → the tooltip's enabling re-render: three turns
    await flushPromises();
    await w.findAll('[data-testid="tour-step"]')[1].trigger("focus");
    await w.vm.$nextTick();
    expect(tips()).toEqual([
      "A new module — Adds b, and a great deal more than two lines can hold about it. · src/b.ts:1–2",
    ]);
    w.unmount();
    restore();
  });

  it("the jump lands the range in the upper third of the column, keeps the light until the next step, and expands a folded file first", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff], description: desc() }) } });
    const el = w.find('[data-testid="reading-diff"]').element as HTMLElement;
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo;
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 600 });
    el.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    const section = w.find('[data-path="src/b.ts"]');
    const rows = Array.from(section.element.querySelectorAll("tr"));
    const first = rows.find((r) => r.querySelector(".line-num2")?.textContent?.trim() === "1");
    if (!first) throw new Error("fixture: src/b.ts has no row for line 1");
    first.getBoundingClientRect = () => ({ top: 1000 }) as DOMRect;
    await w.findAll('[data-testid="tour-step"]')[1].trigger("click");
    await w.vm.$nextTick();
    // 1000 down the content, minus 30 % of a 600 px column: the row sits at 180 px, its file header above it.
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 820 });
    expect(w.findAll("tr.is-focus")).toHaveLength(2);
    // The light is persistent: scrolling, or picking a file, leaves it alone.
    await w.findAll('[data-testid="file-entry"]')[0].trigger("click");
    await w.vm.$nextTick();
    expect(w.findAll("tr.is-focus")).toHaveLength(2);
    // A folded (viewed) file is unfolded so the landing is measured on rendered rows.
    await w.findAll('[data-testid="file-viewed"]')[1].setValue(true);
    expect(w.findAll('[data-testid="file-body"]')[1].isVisible()).toBe(false);
    await w.findAll('[data-testid="tour-step"]')[1].trigger("click");
    await w.vm.$nextTick();
    expect(w.findAll('[data-testid="file-body"]')[1].isVisible()).toBe(true);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 820 });
    // A short column never puts the row under the sticky header: the header plus a line of room wins.
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 50 });
    await w.findAll('[data-testid="tour-step"]')[1].trigger("click");
    await w.vm.$nextTick();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000 - 24 });
    // The lit rows: the accent bar, a tint over the row's own colour, one pulse on arrival that reduced motion drops.
    expect(viewSource).toMatch(/tr\.is-focus td \{[^}]*box-shadow:\s*inset 3px 0 0/);
    expect(viewSource).toMatch(/tr\.is-focus td \{[^}]*background-image: linear-gradient\(var\(--pr-review-focus\)/);
    // The pulse animates a box-shadow list (interpolable everywhere) — no registered custom property to depend on.
    expect(viewSource).toMatch(/@keyframes pr-review-arrive \{\s*from \{\s*box-shadow:/);
    expect(viewSource).not.toMatch(/@property/);
    expect(viewSource).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.d2h-host tr\.is-focus td \{\s*animation: none/);
    w.unmount();
  });

  it("a step past the recorded diff's cap says so and links to the file on GitHub at the head — never 'not in this diff'; a new file before the cut is found", async () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [cappedDiff], description: desc() }) } });
    const scrollTo = vi.fn();
    (w.find('[data-testid="reading-diff"]').element as HTMLElement).scrollTo = scrollTo;
    expect(w.find('[data-testid="truncated-badge"]').exists()).toBe(true);
    const steps = w.findAll('[data-testid="tour-step"]');
    // the new file (--- /dev/null → +++ b/src/b.ts) is keyed by its new path and found; the file past the cut is beyond
    expect(steps.map((s) => s.attributes("data-placement"))).toEqual(["shown", "shown", "beyond", "shown"]);
    const beyond = steps[2];
    expect(beyond.element.tagName).toBe("A");
    expect(beyond.attributes("href")).toBe(`https://github.com/acme/api/blob/${"e".repeat(40)}/src/zzz.ts#L1-L2`);
    expect(beyond.attributes("target")).toBe("_blank");
    expect(beyond.attributes("rel")).toBe("noopener noreferrer");
    expect(beyond.find('[data-testid="tour-step-note"]').text()).toBe("beyond the recorded diff · open on GitHub ↗");
    expect(beyond.classes()).toContain("is-beyond");
    expect(beyond.classes()).not.toContain("is-muted");
    expect(w.text()).not.toContain("not in this diff");
    await beyond.trigger("click");
    await w.vm.$nextTick();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(w.findAll('[data-testid="tour-step"]')[2].attributes("aria-current")).toBeUndefined();
    // a Remaining path past the cut links the same way
    const remaining = w.findAll('[data-testid="tour-remaining-entry"]')[1].find("a");
    expect(remaining.attributes("href")).toBe(`https://github.com/acme/api/blob/${"e".repeat(40)}/nowhere.md`);
    expect(remaining.attributes("title")).toBe("nowhere.md — beyond the recorded diff · open on GitHub");
    w.unmount();

    // The abridged diff shown, the full one cut: the full diff decides, the step is beyond.
    const both = mountApp(PrReviewPanel, {
      props: { data: data({ readingDiffs: [cappedDiff, meatDiff], description: desc() }) },
    });
    expect(both.findAll('[data-testid="tour-step"]')[2].attributes("data-placement")).toBe("beyond");
    both.unmount();

    // No repo or head to link to: the step says beyond, muted and inert, without a link.
    const unlinked = mountApp(PrReviewPanel, {
      props: { data: data({ pr: {}, readingDiffs: [cappedDiff], description: desc() }) },
    });
    const muted = unlinked.findAll('[data-testid="tour-step"]')[2];
    expect(muted.element.tagName).toBe("BUTTON");
    expect(muted.attributes("href")).toBeUndefined();
    expect(muted.classes()).toContain("is-muted");
    expect(muted.find('[data-testid="tour-step-note"]').text()).toBe("beyond the recorded diff");
    unlinked.unmount();

    // The whole diff on record and the file still missing: the change does not touch it.
    const whole = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff], description: desc() }) } });
    expect(whole.findAll('[data-testid="tour-step"]')[2].find('[data-testid="tour-step-note"]').text()).toBe(
      "not in this diff",
    );
    whole.unmount();
  });

  it("the left column is wide enough to read: 19rem, a two-line title, the path kept to its file name", () => {
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [manyDiff], description: desc() }) } });
    expect(w.find("aside").classes()).toContain("w-[19rem]");
    const step = w.findAll('[data-testid="tour-step"]')[0];
    expect(step.find(".step-title").classes()).toContain("line-clamp-2");
    expect(step.find(".step-anchor").classes()).toEqual(expect.arrayContaining(["truncate", "min-w-0"]));
    w.unmount();
  });
});

describe("the abridge control", () => {
  /** A host's control as the test drives it: the state is written from outside. */
  const control = (state: AbridgeState = { state: "absent" }) => reactive({ state, start: vi.fn() });

  it("without a control nothing renders (the deployment cannot abridge); with both producers nothing renders either", () => {
    const off = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [gitDiff] }) } });
    expect(off.find('[data-testid^="abridge"]').exists()).toBe(false);
    off.unmount();
    const both = mountApp(PrReviewPanel, { props: { data: data(), abridge: control() } });
    expect(both.find('[data-testid^="abridge"]').exists()).toBe(false);
    both.unmount();
  });

  it("absent: the Abridge with meat button, with a tooltip saying what it does and what it costs; a click starts", async () => {
    const c = control();
    const w = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [gitDiff] }), abridge: c } });
    const button = w.find('[data-testid="abridge-button"]');
    expect(button.text()).toBe("Abridge with meat");
    expect(button.attributes("data-state")).toBe("closed"); // a tooltip trigger
    await button.trigger("click");
    expect(c.start).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("running: a spinner and the wait note, no button; failed: the reason and a Retry that starts again", async () => {
    const running = mountApp(PrReviewPanel, {
      props: { data: data({ readingDiffs: [gitDiff] }), abridge: control({ state: "running" }) },
    });
    expect(running.find('[data-testid="abridge-running"]').text()).toContain("Abridging… usually 1–3 minutes");
    expect(running.find('[data-testid="abridge-running"] .animate-spin').exists()).toBe(true);
    expect(running.find('[data-testid="abridge-button"]').exists()).toBe(false);
    running.unmount();

    const c = control({ state: "failed", reason: "meat exited 1: no credential" });
    const failed = mountApp(PrReviewPanel, { props: { data: data({ readingDiffs: [gitDiff] }), abridge: c } });
    expect(failed.find('[data-testid="abridge-failed"]').text()).toContain("meat exited 1: no credential");
    await failed.find('[data-testid="abridge-retry"]').trigger("click");
    expect(c.start).toHaveBeenCalledTimes(1);
    failed.unmount();
  });

  it("done: the meat artifact arriving on the data replaces the control with the tabs, the reading diff selected", async () => {
    const live = reactive(data({ readingDiffs: [gitDiff] }));
    const c = control({ state: "running" });
    const w = mountApp(PrReviewPanel, { props: { data: live, abridge: c } });
    expect(w.find('[data-testid="abridge-running"]').exists()).toBe(true);
    expect(w.find('[data-testid="diff-tabs"]').exists()).toBe(false);
    live.readingDiffs.push(meatDiff);
    c.state = { state: "done" };
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    expect(w.find('[data-testid^="abridge"]').exists()).toBe(false);
    expect(w.find('[data-testid="diff-tabs"]').exists()).toBe(true);
    expect(w.find('[data-testid="pr-facts"]').text()).toContain("reading diff · meat");
    w.unmount();
  });
});
