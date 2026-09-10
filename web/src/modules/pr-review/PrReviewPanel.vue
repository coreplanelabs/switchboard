<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { PrReviewData, ReadingDiff } from "./types";
import {
  panelTitle,
  poweredByExplanation,
  poweredByLabel,
  preferredDiff,
  prLinks,
  truncatedExplanation,
} from "./types";
import { countFiles, parseFiles } from "./files";
import FileList from "./FileList.vue";
import LabelTip from "./LabelTip.vue";
import ReadingDiffView from "./ReadingDiffView.vue";

// The PR-review panel: the change as a reviewer reads it, under the PR's own
// title. Props-only (see README.md) — the host app decides where it lives
// (Switchboard: a slideout on review-run pages) and adapts its own data.
//
// Shape: a header (the title linking to the PR; one compact line of facts —
// the reference, the head, the base, the counts, the producer; the tabs, the
// wrap toggle and, for a host that asks, the close control) over two columns
// that scroll on their own — the file list (a Tour seat, then the files) and
// the diff. The panel owns what both columns share: the current file (the
// list's click, the view's scroll-spy) and the viewed marks, kept per path
// for the panel's lifetime.

const props = withDefaults(
  defineProps<{
    data: PrReviewData;
    /** Render a close control that emits `close` — for a host that puts the
     *  panel in a dialog of its own and hides the dialog's chrome. */
    closable?: boolean;
  }>(),
  { closable: false },
);
const emit = defineEmits<{ close: [] }>();

const links = computed(() => prLinks(props.data.pr));
const title = computed(() => panelTitle(props.data));
const diffs = computed(() => props.data.readingDiffs);
/** One tab per producer, abridged first; a lone diff renders without tabs. */
const tabs = computed(() => {
  const meat = diffs.value.find((d) => d.poweredBy === "meat");
  const git = diffs.value.find((d) => d.poweredBy === "git");
  return [meat, git].filter((d): d is ReadingDiff => d !== undefined);
});
const active = ref(0);
watch(
  () => preferredDiff(diffs.value),
  () => (active.value = 0), // new data → back to the preferred view
);
const shown = computed(() => tabs.value[active.value] ?? tabs.value[0] ?? null);
const files = computed(() => (shown.value ? parseFiles(shown.value.diff) : []));
/** The full diff's file count while the abridged one is shown (the footer's
 *  "N of M files shown"); undefined when there is nothing to compare against. */
const fullFileCount = computed(() => {
  const git = diffs.value.find((d) => d.poweredBy === "git");
  return shown.value?.poweredBy === "meat" && git ? countFiles(git.diff) : undefined;
});
const totals = computed(() => ({
  added: files.value.reduce((n, f) => n + f.added, 0),
  deleted: files.value.reduce((n, f) => n + f.deleted, 0),
}));
const shortSha = computed(() => props.data.pr.headSha?.slice(0, 7));

const viewed = reactive(new Set<string>());
function toggleViewed(path: string): void {
  if (viewed.has(path)) viewed.delete(path);
  else viewed.add(path);
}

const current = ref<string | null>(null);
watch(files, (fs) => (current.value = fs[0]?.path ?? null), { immediate: true });
const view = ref<InstanceType<typeof ReadingDiffView> | null>(null);
function select(path: string): void {
  current.value = path;
  view.value?.scrollToFile(path);
}

const wrap = ref(false);
</script>

<template>
  <div class="pr-review-panel flex h-full min-h-0 min-w-0 flex-col" data-testid="pr-review-panel">
    <header class="header flex shrink-0 flex-col gap-1 border-b border-default px-4 py-2.5">
      <div class="flex items-center gap-2">
        <h2 class="m-0 min-w-0 flex-1 truncate text-sm font-semibold text-highlighted" data-testid="pr-title">
          <a v-if="links.pr" :href="links.pr" target="_blank" rel="noopener noreferrer" class="hover:underline">{{
            title
          }}</a>
          <template v-else>{{ title }}</template>
        </h2>
        <!-- The producer tabs, a segmented control: the selected one is ink on
             the page's own ground cut into an accented track, the other is
             muted text with a hover — both legible on either theme. With one
             producer there is no tab bar; the facts line's badge names it. -->
        <div
          v-if="tabs.length > 1"
          class="flex shrink-0 gap-0.5 rounded-md bg-accented p-0.5"
          role="tablist"
          aria-label="Diff producer"
          data-testid="diff-tabs"
        >
          <LabelTip v-for="(d, i) in tabs" :key="d.poweredBy" :text="poweredByExplanation(d.poweredBy)">
            <button
              type="button"
              role="tab"
              class="rounded px-2 py-0.5 text-xs leading-normal transition-colors motion-reduce:transition-none"
              :class="
                i === active
                  ? 'bg-default font-semibold text-highlighted shadow-sm ring-1 ring-default'
                  : 'font-medium text-muted hover:bg-default/60 hover:text-default'
              "
              :aria-selected="i === active"
              @click="active = i"
            >
              {{ d.poweredBy === "meat" ? "Reading diff" : "Full diff" }}
            </button>
          </LabelTip>
        </div>
        <UButton
          v-if="shown"
          size="xs"
          color="neutral"
          :variant="wrap ? 'soft' : 'ghost'"
          icon="i-lucide-wrap-text"
          :aria-pressed="wrap"
          aria-label="Wrap long lines"
          title="Wrap long lines"
          data-testid="wrap-toggle"
          @click="wrap = !wrap"
        />
        <UButton
          v-if="closable"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          aria-label="Close"
          data-testid="panel-close"
          @click="emit('close')"
        />
      </div>
      <div class="facts flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted" data-testid="pr-facts">
        <a
          v-if="links.pr"
          :href="links.pr"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-primary hover:underline"
          data-testid="pr-link"
          >{{ data.pr.repo }}#{{ data.pr.number }}</a
        >
        <span v-else-if="data.pr.repo" class="font-medium">{{ data.pr.repo }}</span>
        <template v-if="links.commit">
          <span aria-hidden="true">·</span>
          <a
            :href="links.commit"
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono hover:underline"
            data-testid="commit-link"
            >{{ shortSha }}</a
          >
        </template>
        <template v-if="shown">
          <span aria-hidden="true">·</span>
          <span title="the base the diff is against">against origin/{{ shown.baseRef }}</span>
          <span aria-hidden="true">·</span>
          <span class="inline-flex gap-1 tabular-nums" data-testid="pr-totals">
            <span>{{ files.length }} {{ files.length === 1 ? "file" : "files" }},</span>
            <span class="text-ins">+{{ totals.added }}</span>
            <span class="text-del">−{{ totals.deleted }}</span>
          </span>
          <span aria-hidden="true">·</span>
          <LabelTip :text="poweredByExplanation(shown.poweredBy)">
            <UBadge
              :color="shown.poweredBy === 'meat' ? 'primary' : 'neutral'"
              variant="subtle"
              size="sm"
              :label="poweredByLabel(shown.poweredBy)"
              data-testid="producer-badge"
            />
          </LabelTip>
          <LabelTip v-if="shown.truncated" :text="truncatedExplanation(shown.diff.length)">
            <UBadge color="warning" variant="subtle" size="sm" label="truncated" data-testid="truncated-badge" />
          </LabelTip>
        </template>
        <template v-if="links.files">
          <span aria-hidden="true">·</span>
          <a
            :href="links.files"
            target="_blank"
            rel="noopener noreferrer"
            class="hover:underline"
            data-testid="files-link"
          >
            all files on GitHub ↗
          </a>
        </template>
      </div>
    </header>

    <div v-if="shown" class="body flex min-h-0 flex-1">
      <aside class="hidden w-[17.5rem] shrink-0 overflow-y-auto border-r border-default md:block">
        <FileList :files="files" :current="current" :viewed="viewed" @select="select" @toggle-viewed="toggleViewed">
          <template #description><slot name="description" /></template>
          <template #tour><slot name="tour" /></template>
        </FileList>
      </aside>
      <ReadingDiffView
        ref="view"
        class="flex-1"
        :diff="shown"
        :files="files"
        :current="current"
        :viewed="viewed"
        :wrap="wrap"
        :full-file-count="fullFileCount"
        @reached="current = $event"
        @toggle-viewed="toggleViewed"
      />
    </div>
    <p v-else class="px-4 py-3 text-sm text-muted" data-testid="no-diff">
      No reading diff was produced for this review.
    </p>
  </div>
</template>

<style>
/* The two hues every part of the panel shares — the list's counts and icons,
 * the diff's tints; the host may retune them on `.pr-review-panel`. */
.pr-review-panel {
  --pr-review-ins: var(--ui-success, #1a7f37);
  --pr-review-del: var(--ui-error, #c93c37);
}
.pr-review-panel .text-ins {
  color: var(--pr-review-ins);
}
.pr-review-panel .text-del {
  color: var(--pr-review-del);
}
</style>
