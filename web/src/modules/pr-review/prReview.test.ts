import { describe, expect, it, vi } from "vitest";
import { h } from "vue";
import PrReviewPanel from "./PrReviewPanel.vue";
import ReadingDiffView from "./ReadingDiffView.vue";
import viewSource from "./ReadingDiffView.vue?raw";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mountApp } from "../../testing/mount";
import { currentFileAt, parseFiles, rowsInRange, splitPath } from "./files";
import { panelTitle, poweredByExplanation, preferredDiff, prLinks, truncatedExplanation } from "./types";
import type { PrReviewData, ReadingDiff } from "./types";

// Feature: docs/reference/specs/reading-diff.md item 6 — the pr-review module renders the
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
    expect(panelTitle({ pr: { repo: "acme/api", number: 42 }, title: "Retry webhooks" })).toBe("Retry webhooks");
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
    const w = mountApp(PrReviewPanel, { props: { data: data({ title: "Retry webhook deliveries" }), closable: true } });
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
