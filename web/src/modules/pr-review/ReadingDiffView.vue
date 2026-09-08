<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import "diff2html/bundles/css/diff2html.min.css";
import type { DiffFileEntry, FileStatus } from "./files";
import { currentFileAt, rowsInRange } from "./files";
import type { ReadingDiff } from "./types";

// One reading diff, file by file: the panel's right column and its scroll
// container. diff2html renders each file's hunks (line-by-line; the library
// escapes the diff's content, so the v-html is library markup over escaped
// text — never raw diff text as HTML) under a file header this component
// draws itself: status, path, counts, collapse, viewed. The library's own
// stylesheet is imported whole — the structure (the two-number gutter, the
// inline prefix, the code cell) tracks upstream — and the colors below ride
// the app's tokens through diff2html's `--d2h-*` variables, so both themes
// come from one rule set.
//
// The view exposes `scrollTo(path, fromLine, toLine)` — the seat for a Tour
// step: it scrolls the file into view and lights the rows the new-side line
// range covers — and `scrollToFile(path)`, which the file list calls.

const props = defineProps<{
  diff: ReadingDiff;
  files: readonly DiffFileEntry[];
  /** The file the panel considers current: lit in the list, not here. */
  current: string | null;
  viewed: ReadonlySet<string>;
  wrap: boolean;
  /** The full diff's file count, when this is the abridged diff and the full
   *  one exists too — the footer then says how many files the abridgement kept. */
  fullFileCount?: number;
}>();
const totals = computed(() => ({
  added: props.files.reduce((n, f) => n + f.added, 0),
  deleted: props.files.reduce((n, f) => n + f.deleted, 0),
}));
const emit = defineEmits<{
  /** The reader scrolled onto a file (scroll-spy). */
  reached: [path: string];
  "toggle-viewed": [path: string];
}>();

const STATUS_ICON: Record<FileStatus, string> = {
  added: "i-lucide-file-plus",
  deleted: "i-lucide-file-minus",
  renamed: "i-lucide-file-symlink",
  modified: "i-lucide-file-pen",
};

const container = ref<HTMLElement | null>(null);
const sections = new Map<string, HTMLElement>();
function bindSection(path: string, el: unknown): void {
  if (el instanceof HTMLElement) sections.set(path, el);
  else sections.delete(path);
}

// Collapse: viewed collapses a file; the chevron is an explicit override in
// either direction (an override is dropped when the viewed mark changes, so
// marking a file viewed always folds it).
const openOverride = reactive(new Map<string, boolean>());
function isOpen(path: string): boolean {
  return openOverride.get(path) ?? !props.viewed.has(path);
}
function toggleOpen(path: string): void {
  openOverride.set(path, !isOpen(path));
}
function toggleViewed(path: string): void {
  openOverride.delete(path);
  emit("toggle-viewed", path);
}
watch(
  () => props.diff,
  () => openOverride.clear(),
);

// Scroll-spy over the container's own scroll: the current file is a pure
// function of the sections' offsets (files.ts).
function onScroll(): void {
  const el = container.value;
  if (!el) return;
  const ordered = props.files.map((f) => sections.get(f.path)).filter((s): s is HTMLElement => s !== undefined);
  const tops = ordered.map((s) => s.offsetTop);
  const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  const i = currentFileAt(tops, el.scrollTop, atEnd);
  const path = ordered[i]?.dataset.path;
  if (path !== undefined && path !== props.current) emit("reached", path);
}
onMounted(() => container.value?.addEventListener("scroll", onScroll, { passive: true }));
onBeforeUnmount(() => container.value?.removeEventListener("scroll", onScroll));

/** Scroll the container so the file's header sits at the top. */
function scrollToFile(path: string): boolean {
  const el = container.value;
  const section = sections.get(path);
  if (!el || !section) return false;
  el.scrollTo({ top: section.offsetTop });
  return true;
}

const FOCUS_CLASS = "is-focus";
/** Where the first lit row lands, as a fraction of the column's height from the top. */
const LANDING = 0.3;
let focused: Element[] = [];
function clearFocus(): void {
  for (const row of focused) row.classList.remove(FOCUS_CLASS);
  focused = [];
}

/** Scroll to a line range of a file (new-side line numbers, inclusive) and
 *  light the rows it covers; a folded file is unfolded first, and measured
 *  only once the unfold has rendered (a hidden row has no geometry). Resolves
 *  false — and leaves the previous light alone — when the file or the range is
 *  not in this diff: a Tour step can point at lines the abridged diff dropped. */
async function scrollTo(path: string, fromLine: number, toLine: number): Promise<boolean> {
  const el = container.value;
  const section = sections.get(path);
  if (!el || !section) return false;
  const rows = Array.from(section.querySelectorAll<HTMLTableRowElement>("tr"));
  const newLines = rows.map((row) => {
    const n = Number.parseInt(row.querySelector(".line-num2")?.textContent?.trim() ?? "", 10);
    return Number.isFinite(n) ? n : null;
  });
  const hit = rowsInRange(newLines, fromLine, toLine);
  if (hit.length === 0) return false;
  clearFocus();
  focused = hit.map((i) => rows[i]);
  for (const row of focused) row.classList.add(FOCUS_CLASS);
  if (!isOpen(path)) {
    openOverride.set(path, true);
    await nextTick();
  }
  const first = focused[0];
  // The range lands in the upper third of the column — not at the very top,
  // where the file's sticky header would cover it and nothing above it gives
  // the reader its context — and never under the header when the column is
  // too short for that.
  const headerHeight = section.querySelector("header")?.getBoundingClientRect().height ?? 0;
  const room = Math.max(headerHeight + 24, Math.round(el.clientHeight * LANDING));
  const top = first.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - room;
  el.scrollTo({ top: Math.max(0, top) });
  return true;
}

defineExpose({ scrollTo, scrollToFile });
</script>

<template>
  <div
    ref="container"
    class="reading-diff d2h-host relative min-w-0 overflow-y-auto overflow-x-hidden"
    :class="{ wrap }"
    data-testid="reading-diff"
  >
    <!-- The lede: the producer's one-line summary of the change (abridged
         diffs) as a labelled block — the same hairline under it as under a
         file header, so the first file follows at the files' own rhythm. -->
    <section v-if="diff.summary" class="lede border-b border-default px-4 py-3" data-testid="diff-lede">
      <h3 class="m-0 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">
        Summary · {{ diff.poweredBy }}
      </h3>
      <p class="m-0 mt-1 max-w-[80ch] font-sans text-sm leading-normal text-default" data-testid="diff-summary">
        {{ diff.summary }}
      </p>
    </section>

    <p v-if="files.length === 0" class="px-4 py-6 text-sm text-muted" data-testid="no-files">
      Nothing in this diff parsed as a file.
    </p>

    <section
      v-for="f in files"
      :key="f.path"
      :ref="(el) => bindSection(f.path, el)"
      :data-path="f.path"
      class="file border-b border-default"
      :class="{ 'is-viewed': viewed.has(f.path) }"
      data-testid="diff-file"
    >
      <header
        class="file-head sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-default bg-elevated px-2 text-xs"
      >
        <button
          type="button"
          class="flex size-5 shrink-0 items-center justify-center rounded text-dimmed hover:bg-accented hover:text-default"
          :aria-expanded="isOpen(f.path)"
          :aria-label="isOpen(f.path) ? 'Collapse file' : 'Expand file'"
          data-testid="file-collapse"
          @click="toggleOpen(f.path)"
        >
          <UIcon :name="isOpen(f.path) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5" />
        </button>
        <UIcon
          :name="STATUS_ICON[f.status]"
          class="size-3.5 shrink-0"
          :class="f.status === 'added' ? 'text-ins' : f.status === 'deleted' ? 'text-del' : 'text-muted'"
        />
        <span
          class="path min-w-0 flex-1 truncate font-mono text-highlighted"
          :title="f.from ? `${f.from} → ${f.path}` : f.path"
        >
          <template v-if="f.from"
            ><span class="text-muted">{{ f.from }}</span> → </template
          >{{ f.path }}
        </span>
        <span v-if="f.binary" class="shrink-0 rounded bg-accented px-1.5 text-[0.68rem] leading-normal text-muted"
          >binary</span
        >
        <span v-else class="counts inline-flex shrink-0 gap-1 font-mono tabular-nums">
          <span class="text-ins">+{{ f.added }}</span>
          <span class="text-del">−{{ f.deleted }}</span>
        </span>
        <label class="viewed flex shrink-0 cursor-pointer select-none items-center gap-1.5 pl-2 text-muted">
          <input
            type="checkbox"
            class="size-3.5 cursor-pointer accent-(--pr-review-ins)"
            :checked="viewed.has(f.path)"
            data-testid="file-viewed"
            @change="toggleViewed(f.path)"
          />
          Viewed
        </label>
      </header>
      <!-- eslint-disable-next-line vue/no-v-html — diff2html output over its own escaping -->
      <div v-show="isOpen(f.path)" class="file-body" data-testid="file-body" v-html="f.html" />
    </section>

    <!-- The end of the column, said: under the last file's hairline, what was
         shown — and for the abridged diff, how much of the full one it kept.
         The room below keeps the last hunk off the panel's edge. -->
    <footer
      v-if="files.length > 0"
      class="footer px-4 pb-24 pt-4 text-center font-sans text-[0.68rem] font-semibold uppercase tracking-wider text-muted"
      data-testid="diff-end"
    >
      <template v-if="fullFileCount !== undefined">
        End of reading diff · {{ files.length }} of {{ fullFileCount }} files shown
      </template>
      <template v-else>
        End of diff · {{ files.length }} {{ files.length === 1 ? "file" : "files" }} ·
        <span class="text-ins">+{{ totals.added }}</span> <span class="text-del">−{{ totals.deleted }}</span>
      </template>
    </footer>
  </div>
</template>

<style>
/* diff2html's colors from the app's tokens (one rule set, both themes); the
 * structure is the library's own stylesheet, imported above. The two hues,
 * `--pr-review-ins/del`, are the panel's (PrReviewPanel.vue sets them). */
.d2h-host {
  --d2h-bg-color: var(--ui-bg);
  --d2h-border-color: var(--ui-border);
  --d2h-dim-color: var(--ui-text-dimmed);
  --d2h-line-border-color: var(--ui-border-muted);
  --d2h-file-header-bg-color: var(--ui-bg-elevated);
  --d2h-file-header-border-color: var(--ui-border);
  --d2h-empty-placeholder-bg-color: var(--ui-bg-muted);
  --d2h-empty-placeholder-border-color: var(--ui-border-muted);
  --d2h-selected-color: var(--ui-bg-accented);
  --d2h-ins-bg-color: color-mix(in srgb, var(--pr-review-ins) 11%, transparent);
  --d2h-ins-border-color: color-mix(in srgb, var(--pr-review-ins) 35%, transparent);
  --d2h-ins-highlight-bg-color: color-mix(in srgb, var(--pr-review-ins) 32%, transparent);
  --d2h-ins-label-color: var(--pr-review-ins);
  --d2h-del-bg-color: color-mix(in srgb, var(--pr-review-del) 11%, transparent);
  --d2h-del-border-color: color-mix(in srgb, var(--pr-review-del) 35%, transparent);
  --d2h-del-highlight-bg-color: color-mix(in srgb, var(--pr-review-del) 32%, transparent);
  --d2h-del-label-color: var(--pr-review-del);
  /* "changed" lines (a deletion paired with an insertion) keep the two hues —
   * no third, yellow one. */
  --d2h-change-del-color: var(--d2h-del-bg-color);
  --d2h-change-ins-color: var(--d2h-ins-bg-color);
  --d2h-info-bg-color: var(--ui-bg-muted);
  --d2h-info-border-color: var(--ui-border-muted);
  --d2h-moved-label-color: var(--ui-text-muted);
}
/* The library's file chrome is replaced by the header above. */
.d2h-host .d2h-file-header,
.d2h-host .d2h-file-list-wrapper {
  display: none;
}
.d2h-host .d2h-file-wrapper {
  border: 0;
  border-radius: 0;
  margin: 0;
}
.d2h-host .d2h-file-diff {
  overflow-x: auto;
}

/* Code: the dashboard's mono face at the call cards' size; numerals tabular. */
.d2h-host .d2h-diff-table {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.8125rem;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}
.d2h-host .d2h-code-linenumber {
  color: var(--ui-text-dimmed);
}
.d2h-host .d2h-code-line {
  /* 8em left for the two-number gutter; a small right margin, not the mirror. */
  padding: 0 1em 0 8em;
  width: calc(100% - 9em);
}
.d2h-host .d2h-code-line-prefix {
  color: var(--ui-text-dimmed);
}
.d2h-host .d2h-ins .d2h-code-line-prefix,
.d2h-host .d2h-ins .d2h-code-line-ctn {
  color: var(--pr-review-ins);
}
.d2h-host .d2h-del .d2h-code-line-prefix,
.d2h-host .d2h-del .d2h-code-line-ctn {
  color: var(--pr-review-del);
}
.d2h-host .d2h-code-line del,
.d2h-host .d2h-code-line ins {
  color: var(--ui-text-highlighted);
}
.d2h-host .d2h-info .d2h-code-line {
  color: var(--ui-text-dimmed);
}
.d2h-host .d2h-tag {
  display: none;
}

/* Wrap: long lines fold inside the code cell instead of scrolling it. The
 * line becomes a flex row — prefix, then the code taking the rest — because
 * the library's inline prefix + full-width inline-block code only share a
 * line while nothing wraps. */
.d2h-host.wrap .d2h-code-line {
  display: flex;
  white-space: normal;
}
.d2h-host.wrap .d2h-code-line-ctn {
  flex: 1;
  min-width: 0;
  width: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

/* A line range a Tour step (or scrollTo) pointed at: an accent bar down the
 * left and a tint laid OVER the row's own colour (a background image, so an
 * added or deleted line keeps its hue under it), held until the next jump.
 * On arrival a second, cell-filling inset shadow pulses once from strong to
 * clear — a cue the eye catches from anywhere in the column, never the only
 * cue. Two shadows in both keyframes, so the list interpolates in every
 * engine (no registered custom property to depend on). */
.d2h-host tr.is-focus td {
  --pr-review-focus: color-mix(in srgb, var(--pr-review-mark) 14%, transparent);
  box-shadow:
    inset 3px 0 0 var(--pr-review-mark),
    inset 0 0 0 100vmax transparent;
  background-image: linear-gradient(var(--pr-review-focus), var(--pr-review-focus));
  animation: pr-review-arrive 900ms ease-out;
}
.d2h-host tr.is-focus td.d2h-code-linenumber {
  color: var(--ui-text-highlighted);
}
@keyframes pr-review-arrive {
  from {
    box-shadow:
      inset 3px 0 0 var(--pr-review-mark),
      inset 0 0 0 100vmax color-mix(in srgb, var(--pr-review-mark) 40%, transparent);
  }
}
@media (prefers-reduced-motion: reduce) {
  .d2h-host tr.is-focus td {
    animation: none;
  }
}
</style>
