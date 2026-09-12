import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import PrReviewPanel from "./PrReviewPanel.vue";
import FileDiffs from "./FileDiffs.vue";
import FilesChanged from "./FilesChanged.vue";
import { mountApp } from "../../testing/mount";
import { diffStats, ellipsizeMiddle } from "./files";
import { fileIcon, iconForLanguage, languageFromPath } from "./fileIcons";
import {
  descriptionNote,
  panelTitle,
  poweredByExplanation,
  preferredDiff,
  prLinks,
  truncatedExplanation,
} from "./types";
import type { AbridgeState, PrDescriptionData, PrReviewData, ReadingDiff } from "./types";

// Feature: docs/reference/specs/reading-diff.md item 12 — the pr-review module renders the
// change as a reviewer reads it, from props alone (the module is liftable; the
// host adapts its own data). These tests drive the panel purely through
// PrReviewData fixtures — no seeds, no streams.
//
// The diff itself is @pierre/diffs' work, not the module's: the library's
// renderer is stubbed to write each file's lines into its container and to
// record what it was handed (the theme, the style, the file), so the tests see
// the module's decisions without the highlighter. The parser stays real.

const { renders, failNextRender } = vi.hoisted(() => ({
  renders: [] as { options: Record<string, unknown>; name: string }[],
  failNextRender: { value: false },
}));
vi.mock("@pierre/diffs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs")>();
  class FileDiff {
    constructor(public options: Record<string, unknown>) {}
    render({
      fileDiff,
      fileContainer,
    }: {
      fileDiff: { name: string; deletionLines: string[]; additionLines: string[] };
      fileContainer: HTMLElement;
    }) {
      if (failNextRender.value) {
        failNextRender.value = false;
        throw new Error("no highlighter");
      }
      renders.push({ options: this.options, name: fileDiff.name });
      fileContainer.textContent = [...fileDiff.deletionLines, ...fileDiff.additionLines].join("\n");
    }
    cleanUp() {}
  }
  return { ...actual, FileDiff };
});

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
/** Four files, every shape: a modification, an addition, a rename, a deletion, a binary. */
const manyFiles =
  "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n line one\n-line two\n+line 2\n+line 2b\n line three\n" +
  "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1,2 @@\n+export const b = 1;\n+export const c = 2;\n" +
  "diff --git a/docs/old.md b/docs/new.md\nsimilarity index 80%\nrename from docs/old.md\nrename to docs/new.md\nindex 4444444..5555555 100644\n--- a/docs/old.md\n+++ b/docs/new.md\n@@ -1,1 +1,1 @@\n-# Old\n+# New\n" +
  "diff --git a/gone.py b/gone.py\ndeleted file mode 100644\nindex 6666666..0000000\n--- a/gone.py\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n" +
  "diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..7777777\nBinary files /dev/null and b/img.png differ\n";
const manyDiff: ReadingDiff = { poweredBy: "git", baseRef: "main", diff: manyFiles, truncated: false };

/** Rendered text without its layout whitespace (flex gaps carry the spacing). */
const squash = (s: string) => s.replace(/\s+/g, "");

const data = (over: Partial<PrReviewData> = {}): PrReviewData => ({
  pr: { repo: "acme/api", number: 42, headSha: "e".repeat(40), baseRef: "main" },
  readingDiffs: [gitDiff, meatDiff],
  ...over,
});

const desc = (over: Partial<PrDescriptionData> = {}): PrDescriptionData => ({
  title: "Retry webhook deliveries",
  tldr: "The TL;DR.",
  whatWhy: "Because a flaky receiver loses the event.",
  origin: "parsed",
  complete: false,
  truncated: false,
  ...over,
});

/** Wait until the view has settled: the files counted and, when there are
 *  any, handed to the renderer — both behind a load of the library, which
 *  resolves on its own schedule. */
async function settle(w: ReturnType<typeof mountApp>) {
  await vi.waitFor(() => {
    if (w.find('[data-testid="files-loading"]').exists()) throw new Error("still counting the files");
    const diffs = w.find('[data-testid="file-diffs"]');
    if (diffs.exists() && !diffs.find("diffs-container").exists()) throw new Error("not rendered yet");
  });
  await nextTick();
}

/** The panel, once its files have been counted and handed to the renderer. */
async function mountPanel(props: Record<string, unknown>) {
  const w = mountApp(PrReviewPanel, { props });
  await settle(w);
  return w;
}

/** A tab of the row: reka activates a trigger on a left mousedown. */
async function pickTab(w: ReturnType<typeof mountApp>, testid: string, label: string) {
  const trigger = w
    .find(`[data-testid="${testid}"]`)
    .findAll('[role="tab"]')
    .find((t) => t.text() === label);
  if (!trigger) throw new Error(`no tab ${label}`);
  const before = renders.length;
  await trigger.trigger("mousedown", { button: 0 });
  await flushPromises();
  await nextTick();
  await settle(w);
  // a switch between diffs re-renders; give the renderer its turn
  if (w.find('[data-testid="file-diffs"]').exists())
    await vi.waitFor(() => expect(renders.length).toBeGreaterThan(before));
}
const tabLabels = (w: ReturnType<typeof mountApp>, testid: string) =>
  w
    .find(`[data-testid="${testid}"]`)
    .findAll('[role="tab"]')
    .map((t) => t.text());
const activeTab = (w: ReturnType<typeof mountApp>, testid: string) =>
  w
    .find(`[data-testid="${testid}"]`)
    .findAll('[role="tab"]')
    .find((t) => t.attributes("aria-selected") === "true")
    ?.text();

beforeEach(() => {
  renders.length = 0;
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe("prLinks", () => {
  it("builds PR / files / commit links only from shape-verified values", () => {
    expect(prLinks({ repo: "acme/api", number: 42, headSha: "e".repeat(40) })).toEqual({
      pr: "https://github.com/acme/api/pull/42",
      files: "https://github.com/acme/api/pull/42/files",
      commit: "https://github.com/acme/api/pull/42/commits/" + "e".repeat(40),
    });
    expect(prLinks({ repo: "acme/api", headSha: "abcdef0" })).toEqual({
      commit: "https://github.com/acme/api/commit/abcdef0",
    });
    expect(prLinks({ repo: "acme/api", number: 0 })).toEqual({});
    expect(prLinks({ repo: "acme/../evil", number: 1 })).toEqual({});
    expect(prLinks({ repo: "acme/api?x=<script>", number: 1 })).toEqual({});
    expect(prLinks({ repo: "acme/api", number: 1, headSha: "not a sha" })).toEqual({
      pr: "https://github.com/acme/api/pull/1",
      files: "https://github.com/acme/api/pull/1/files",
    });
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

describe("panelTitle", () => {
  it("is the PR's title when known, else its reference, else the repo, else a generic label", () => {
    expect(panelTitle({ pr: { repo: "acme/api", number: 42 }, description: desc() })).toBe("Retry webhook deliveries");
    expect(panelTitle({ pr: { repo: "acme/api", number: 42 } })).toBe("acme/api#42");
    expect(panelTitle({ pr: { repo: "acme/api" } })).toBe("acme/api");
    expect(panelTitle({ pr: {} })).toBe("PR review");
  });
});

describe("the labels' explanations", () => {
  it("name what a reader cannot: the producer, where a truncated diff was cut, what kind of description this is", () => {
    expect(poweredByExplanation("meat")).toMatch(/abridged/);
    expect(poweredByExplanation("git")).toMatch(/complete change/);
    expect(truncatedExplanation(120000)).toBe(
      "The recorded diff was cut at 120,000 characters; open the full diff on GitHub for the rest",
    );
    expect(descriptionNote({ origin: "parsed", complete: false, truncated: false })).toBe("read back from the PR body");
    expect(descriptionNote({ origin: "parsed", complete: false, truncated: true })).toBe(
      "read back from the PR body; the body was cut before it was read",
    );
    expect(descriptionNote({ origin: "submitted", complete: true, truncated: true })).toBe(
      "the body was cut before it was read",
    );
    expect(descriptionNote({ origin: "parsed", complete: true, truncated: false })).toBeUndefined();
    expect(descriptionNote({ origin: "submitted", complete: true, truncated: false })).toBeUndefined();
  });
});

describe("files", () => {
  it("diffStats counts added and removed lines per file — the new path, or the old one for a deletion — and in total", async () => {
    const stats = await diffStats(manyFiles);
    expect(stats.files).toEqual([
      { path: "src/a.ts", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 2, deletions: 0 },
      { path: "docs/new.md", additions: 1, deletions: 1 },
      { path: "gone.py", additions: 0, deletions: 1 },
      { path: "img.png", additions: 0, deletions: 0 },
    ]);
    expect(stats.additions).toBe(5);
    expect(stats.deletions).toBe(3);
  });

  it("diffStats answers zeros for text that is not a diff", async () => {
    expect(await diffStats("not a diff")).toEqual({ files: [], additions: 0, deletions: 0 });
    expect(await diffStats("")).toEqual({ files: [], additions: 0, deletions: 0 });
  });

  it("ellipsizeMiddle leaves short text alone and cuts the middle of long text to the budget", () => {
    expect(ellipsizeMiddle("src/a.ts", 20)).toBe("src/a.ts");
    const cut = ellipsizeMiddle("apps/api/src/webhooks/stripe.ts", 20);
    expect(cut).toBe("apps/api/s…stripe.ts");
    expect(cut.length).toBe(20);
  });

  it("the language icon: by file name first, then extension, else the plain file", () => {
    expect(languageFromPath("apps/api/src/webhooks/stripe.ts")).toBe("typescript");
    expect(languageFromPath("Dockerfile")).toBe("docker");
    expect(languageFromPath("deploy/Makefile")).toBe("makefile");
    expect(languageFromPath("go.mod")).toBe("go");
    expect(languageFromPath("README")).toBe("text");
    expect(languageFromPath("archive.tar.gz")).toBe("text");
    expect(languageFromPath("Component.VUE")).toBe("vue");
    expect(fileIcon("web/src/App.vue")).toBe("i-simple-icons-vuedotjs");
    expect(fileIcon("src/a.ts")).toBe("i-simple-icons-typescript");
    expect(fileIcon("schema.sql")).toBe("i-lucide-database");
    expect(fileIcon("LICENSE")).toBe("i-lucide-file-text");
    expect(iconForLanguage("klingon")).toBe("i-lucide-file-text");
  });
});

describe("PrReviewPanel", () => {
  it("renders the title, the facts (reference, head, base, producer, truncation), the preferred (reading) diff with its notes, its files with counts, and hands the files to the renderer", async () => {
    const w = await mountPanel({ data: data() });
    expect(w.find('[data-testid="pr-title"]').text()).toBe("acme/api#42");
    expect(w.find('[data-testid="pr-link"]').attributes("href")).toBe("https://github.com/acme/api/pull/42");
    expect(w.find('[data-testid="pr-link"]').text()).toBe("acme/api#42");
    expect(w.find('[data-testid="commit-link"]').text()).toBe("eeeeeee");
    expect(w.find('[data-testid="commit-link"]').attributes("href")).toBe(
      "https://github.com/acme/api/pull/42/commits/" + "e".repeat(40),
    );
    expect(w.find('[data-testid="github-button"]').attributes("href")).toBe("https://github.com/acme/api/pull/42");
    const facts = w.find('[data-testid="pr-facts"]').text();
    expect(facts).toContain("against origin/main");
    expect(w.find('[data-testid="producer-label"]').text()).toBe("reading diff · meat");
    expect(w.find('[data-testid="truncated-label"]').text()).toBe("truncated");
    // the reading diff is the reader's first stop; its summary and the cut lead the diff column
    expect(activeTab(w, "panel-tabs")).toBe("Reading diff");
    expect(w.findAll('[data-testid="diff-note"]').map((n) => n.text())).toEqual([
      "Renames the marker constant.",
      `The recorded diff was cut at ${meatDiff.diff.length} characters; open the full diff on GitHub for the rest.`,
    ]);
    expect(w.find('[data-testid="file-count"]').text()).toBe("1 file");
    expect(squash(w.find('[data-testid="pr-totals"]').text())).toBe("+1−1");
    const entry = w.find('[data-testid="file-entry"]');
    expect(entry.text()).toContain("src/a.ts");
    expect(squash(entry.text())).toContain("+1−1");
    expect(entry.find("svg").exists()).toBe(true); // the language icon (fileIcon picks it; proven above)
    // the renderer got the file, under its path as the anchor
    expect(renders).toEqual([{ options: { themeType: "light", diffStyle: "unified" }, name: "src/a.ts" }]);
    const rendered = w.find('[data-testid="file-diffs"]');
    expect(rendered.find('[data-file="src/a.ts"]').exists()).toBe(true);
    expect(rendered.text()).toContain("NEW_MARKER");
    expect(rendered.text()).toContain("OLD_MARKER");
    expect(rendered.text()).not.toContain("context"); // the abridgement dropped it
    w.unmount();
  });

  it("a known PR title becomes the header; the close control appears only for a closable host and emits close", async () => {
    const w = await mountPanel({ data: data({ description: desc() }), closable: true });
    expect(w.find('[data-testid="pr-title"]').text()).toBe("Retry webhook deliveries");
    await w.find('[data-testid="panel-close"]').trigger("click");
    expect(w.findComponent(PrReviewPanel).emitted("close")).toHaveLength(1);
    w.unmount();

    const plain = await mountPanel({ data: data() });
    expect(plain.find('[data-testid="panel-close"]').exists()).toBe(false);
    plain.unmount();
  });

  it("one tab per diff on record, the Description when the host knows prose; a lone full diff is one tab, Files changed", async () => {
    const both = await mountPanel({ data: data({ description: desc() }) });
    expect(tabLabels(both, "panel-tabs")).toEqual(["Files changed", "Reading diff", "Description"]);
    both.unmount();

    const lone = await mountPanel({ data: data({ readingDiffs: [gitDiff] }) });
    expect(tabLabels(lone, "panel-tabs")).toEqual(["Files changed"]);
    expect(activeTab(lone, "panel-tabs")).toBe("Files changed");
    expect(lone.find('[data-testid="producer-label"]').text()).toBe("full diff · git");
    expect(lone.find('[data-testid="truncated-label"]').exists()).toBe(false);
    lone.unmount();

    const mute = await mountPanel({
      data: data({ readingDiffs: [gitDiff], description: desc({ tldr: undefined, whatWhy: undefined }) }),
    });
    expect(tabLabels(mute, "panel-tabs")).toEqual(["Files changed"]); // a description with no prose has no tab
    mute.unmount();
  });

  it("switching to Files changed shows the full diff: the git producer, no cut, the context line the abridgement dropped", async () => {
    const w = await mountPanel({ data: data() });
    await pickTab(w, "panel-tabs", "Files changed");
    expect(activeTab(w, "panel-tabs")).toBe("Files changed");
    expect(w.find('[data-testid="producer-label"]').text()).toBe("full diff · git");
    expect(w.find('[data-testid="truncated-label"]').exists()).toBe(false);
    expect(w.findAll('[data-testid="diff-note"]')).toHaveLength(0);
    expect(w.find('[data-testid="file-diffs"]').text()).toContain("context");
    expect(renders.at(-1)).toEqual({ options: { themeType: "light", diffStyle: "unified" }, name: "src/a.ts" });
    w.unmount();
  });

  it("the file list is a table of contents: one entry per file with its language icon and counts, the path cut in the middle when long; clicking one marks it current and scrolls its diff into view", async () => {
    const long = manyFiles.replaceAll("src/b.ts", "apps/console/app/components/autofixes/PullRequestFilesChanged.vue");
    const w = await mountPanel({ data: data({ readingDiffs: [{ ...manyDiff, diff: long }] }) });
    const entries = w.findAll('[data-testid="file-entry"]');
    expect(entries.map((e) => e.attributes("title"))).toEqual([
      "src/a.ts",
      "apps/console/app/components/autofixes/PullRequestFilesChanged.vue",
      "docs/new.md",
      "gone.py",
      "img.png",
    ]);
    expect(entries[1].text()).toContain("apps/console/app/…FilesChanged.vue"); // both ends kept, 34 characters
    expect(squash(entries[0].text())).toContain("+2−1");
    expect(squash(entries[4].text())).toContain("+0−0");
    expect(w.find('[data-testid="file-count"]').text()).toBe("5 files");
    expect(squash(w.find('[data-testid="pr-totals"]').text())).toBe("+5−3");
    expect(renders.map((r) => r.name)).toEqual([
      "src/a.ts",
      "apps/console/app/components/autofixes/PullRequestFilesChanged.vue",
      "docs/new.md",
      "gone.py",
      "img.png",
    ]);

    await entries[2].trigger("click");
    expect(entries[2].attributes("aria-current")).toBe("true");
    expect(entries[0].attributes("aria-current")).toBeUndefined();
    const target = w.find('[data-file="docs/new.md"]').element;
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.instances[0]).toBe(target);
    w.unmount();
  });

  it("Inline or Side by side: the choice re-renders the files in that style, is kept per browser, and is read back on the next mount; the Description tab has no toggle", async () => {
    const w = await mountPanel({ data: data({ description: desc() }) });
    expect(tabLabels(w, "diff-style")).toEqual(["Inline", "Side by side"]);
    expect(activeTab(w, "diff-style")).toBe("Inline");
    await pickTab(w, "diff-style", "Side by side");
    expect(renders.at(-1)?.options).toEqual({ themeType: "light", diffStyle: "split" });
    expect(localStorage.getItem("switchboard:diffStyle")).toBe("split");
    await pickTab(w, "panel-tabs", "Description");
    expect(w.find('[data-testid="diff-style"]').exists()).toBe(false);
    w.unmount();

    const again = await mountPanel({ data: data() });
    expect(activeTab(again, "diff-style")).toBe("Side by side");
    expect(renders.at(-1)?.options).toEqual({ themeType: "light", diffStyle: "split" });
    again.unmount();
  });

  it("the Description tab: the TL;DR and the What & why as prose, the note for a copy read back from the PR body; a complete description carries no note", async () => {
    const w = await mountPanel({ data: data({ description: desc() }) });
    await pickTab(w, "panel-tabs", "Description");
    const block = w.find('[data-testid="pr-description"]');
    expect(block.find('[data-testid="description-tldr"]').text()).toBe("The TL;DR.");
    expect(block.find('[data-testid="description-what-why"]').text()).toBe("Because a flaky receiver loses the event.");
    expect(block.find('[data-testid="description-origin"]').text()).toBe("read back from the PR body");
    expect(w.find('[data-testid="file-diffs"]').exists()).toBe(false);
    w.unmount();

    const complete = await mountPanel({ data: data({ description: desc({ origin: "submitted", complete: true }) }) });
    await pickTab(complete, "panel-tabs", "Description");
    expect(complete.find('[data-testid="description-origin"]').exists()).toBe(false);
    complete.unmount();
  });

  it("empty states: no diffs and no description → one sentence; a diff that parses to no files says so; a description alone is its tab", async () => {
    const none = await mountPanel({ data: data({ readingDiffs: [] }) });
    expect(none.find('[data-testid="no-diff"]').text()).toBe("No reading diff was produced for this review.");
    expect(none.find('[data-testid="panel-tabs"]').exists()).toBe(false);
    none.unmount();

    const empty = await mountPanel({ data: data({ readingDiffs: [{ ...gitDiff, diff: "nothing here" }] }) });
    expect(empty.find('[data-testid="no-files"]').text()).toBe("Nothing in this diff parsed as a file.");
    expect(renders).toEqual([]);
    empty.unmount();

    const prose = await mountPanel({ data: data({ readingDiffs: [], description: desc() }) });
    expect(tabLabels(prose, "panel-tabs")).toEqual(["Description"]);
    expect(prose.find('[data-testid="description-tldr"]').text()).toBe("The TL;DR.");
    prose.unmount();
  });

  it("a repo without a valid number renders as text, not a link, and the GitHub button is gone", async () => {
    const w = await mountPanel({ data: data({ pr: { repo: "acme/api" }, readingDiffs: [gitDiff] }) });
    expect(w.find('[data-testid="pr-link"]').exists()).toBe(false);
    expect(w.find('[data-testid="github-button"]').exists()).toBe(false);
    expect(w.find('[data-testid="pr-facts"]').text()).toContain("acme/api");
    w.unmount();
  });
});

describe("FilesChanged — the two columns fold on a narrow panel", () => {
  it("under 672px the list folds above the diff behind a 'N files changed' row, opens on click, closes on a pick, and the diff reads inline whatever the style", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 500,
      height: 800,
      top: 0,
      left: 0,
      right: 500,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const w = mountApp(FilesChanged, { props: { diff: manyFiles, diffStyle: "split" } });
    await settle(w);
    const fold = w.find('[data-testid="files-fold"]');
    expect(fold.text()).toContain("5 files changed");
    expect(fold.attributes("aria-expanded")).toBe("false");
    expect(w.findAll('[data-testid="file-entry"]')).toHaveLength(0);
    expect(renders.at(-1)?.options.diffStyle).toBe("unified");
    await fold.trigger("click");
    expect(w.findAll('[data-testid="file-entry"]')).toHaveLength(5);
    await w.findAll('[data-testid="file-entry"]')[1].trigger("click");
    expect(w.findAll('[data-testid="file-entry"]')).toHaveLength(0); // picking a file closes the fold
    rect.mockRestore();
    w.unmount();
  });

  it("wide, the list is a column beside the diff with the count and totals in its head", async () => {
    const w = mountApp(FilesChanged, { props: { diff: manyFiles, diffStyle: "split" } });
    await settle(w);
    expect(w.find('[data-testid="files-fold"]').exists()).toBe(false);
    expect(w.find('[data-testid="file-count"]').text()).toBe("5 files");
    expect(renders.at(-1)?.options.diffStyle).toBe("split");
    w.unmount();
  });
});

describe("FileDiffs — the renderer's own failure", () => {
  it("shows the diff as plain text when the library cannot render it; hostile text stays text", async () => {
    failNextRender.value = true;
    const hostile = gitDiff.diff.replace("NEW_MARKER = 2", 'x = "<img src=x onerror=alert(1)>"');
    const w = mountApp(FileDiffs, { props: { diff: hostile, theme: "dark" } });
    await vi.waitFor(() => expect(w.find('[data-testid="diff-raw"]').exists()).toBe(true));
    const raw = w.find('[data-testid="diff-raw"]');
    expect(raw.text()).toContain("<img src=x onerror=alert(1)>");
    expect(w.find("img").exists()).toBe(false);
    w.unmount();
  });

  it("re-renders when the diff, the theme or the style changes, and cleans up on unmount", async () => {
    const live = reactive({
      diff: gitDiff.diff,
      theme: "dark" as "dark" | "light",
      diffStyle: "unified" as "unified" | "split",
    });
    const w = mountApp(FileDiffs, { props: live });
    await vi.waitFor(() => expect(renders.at(-1)?.options).toEqual({ themeType: "dark", diffStyle: "unified" }));
    live.theme = "light";
    await vi.waitFor(() => expect(renders.at(-1)?.options).toEqual({ themeType: "light", diffStyle: "unified" }));
    live.diffStyle = "split";
    await vi.waitFor(() => expect(renders.at(-1)?.options).toEqual({ themeType: "light", diffStyle: "split" }));
    live.diff = manyFiles;
    await vi.waitFor(() => expect(w.findAll("diffs-container")).toHaveLength(5));
    expect(renders.slice(-5).map((r) => r.name)).toEqual(["src/a.ts", "src/b.ts", "docs/new.md", "gone.py", "img.png"]);
    w.unmount();
  });
});

describe("the abridge control", () => {
  /** A host's control as the test drives it: the state is written from outside. */
  const control = (state: AbridgeState = { state: "absent" }) => reactive({ state, start: vi.fn() });

  it("without a control nothing renders (the deployment cannot abridge); with both producers nothing renders either", async () => {
    const off = await mountPanel({ data: data({ readingDiffs: [gitDiff] }) });
    expect(off.find('[data-testid^="abridge"]').exists()).toBe(false);
    off.unmount();
    const both = await mountPanel({ data: data(), abridge: control() });
    expect(both.find('[data-testid^="abridge"]').exists()).toBe(false);
    both.unmount();
  });

  it("absent: the Abridge with meat button beside View on GitHub, with a tooltip saying what it does and what it costs; a click starts", async () => {
    const c = control();
    const w = await mountPanel({ data: data({ readingDiffs: [gitDiff] }), abridge: c });
    const button = w.find('[data-testid="abridge-button"]');
    expect(button.text()).toBe("Abridge with meat");
    expect(button.attributes("data-state")).toBe("closed"); // a tooltip trigger
    expect(button.element.previousElementSibling).toBe(w.find('[data-testid="github-button"]').element);
    await button.trigger("click");
    expect(c.start).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("running: a spinner and the wait note, no button; failed: the reason and a Retry that starts again", async () => {
    const running = await mountPanel({
      data: data({ readingDiffs: [gitDiff] }),
      abridge: control({ state: "running" }),
    });
    expect(running.find('[data-testid="abridge-running"]').text()).toContain("Abridging… usually 1–3 minutes");
    expect(running.find('[data-testid="abridge-running"] .animate-spin').exists()).toBe(true);
    expect(running.find('[data-testid="abridge-button"]').exists()).toBe(false);
    running.unmount();

    const c = control({ state: "failed", reason: "meat exited 1: no credential" });
    const failed = await mountPanel({ data: data({ readingDiffs: [gitDiff] }), abridge: c });
    expect(failed.find('[data-testid="abridge-failed"]').text()).toContain("meat exited 1: no credential");
    await failed.find('[data-testid="abridge-retry"]').trigger("click");
    expect(c.start).toHaveBeenCalledTimes(1);
    failed.unmount();
  });

  it("done: the meat artifact arriving on the data replaces the control with a Reading diff tab, selected", async () => {
    const live = reactive(data({ readingDiffs: [gitDiff] }));
    const c = control({ state: "running" });
    const w = await mountPanel({ data: live, abridge: c });
    expect(w.find('[data-testid="abridge-running"]').exists()).toBe(true);
    expect(tabLabels(w, "panel-tabs")).toEqual(["Files changed"]);
    live.readingDiffs.push(meatDiff);
    c.state = { state: "done" };
    await nextTick();
    await settle(w);
    expect(w.find('[data-testid^="abridge"]').exists()).toBe(false);
    expect(tabLabels(w, "panel-tabs")).toEqual(["Files changed", "Reading diff"]);
    expect(activeTab(w, "panel-tabs")).toBe("Reading diff");
    expect(w.find('[data-testid="producer-label"]').text()).toBe("reading diff · meat");
    w.unmount();
  });
});
