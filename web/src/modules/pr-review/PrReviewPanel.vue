<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import type { AbridgeControl, PrReviewData, ReadingDiff } from "./types";
import {
  panelTitle,
  poweredByExplanation,
  poweredByLabel,
  preferredDiff,
  prLinks,
  truncatedExplanation,
} from "./types";
import { countFiles, filePaths, parseFiles } from "./files";
import DescriptionBlock from "./DescriptionBlock.vue";
import FileList from "./FileList.vue";
import LabelTip from "./LabelTip.vue";
import ReadingDiffView from "./ReadingDiffView.vue";
import TourList from "./TourList.vue";

// The PR-review panel: the change as a reviewer reads it, under the PR's own
// title. Props-only (see README.md) — the host app decides where it lives
// (Switchboard: a slideout on review-run pages) and adapts its own data.
//
// Shape: a header (the title linking to the PR; one compact line of facts —
// the reference, the head, the base, the counts, the producer; the tabs — or
// the abridge control when the host offers one and the full diff stands alone
// —, the wrap toggle and, for a host that asks, the close control) over two
// columns that scroll on their own — the left one opens on the PR's
// description and its Tour, then lists the files; the right one is the diff.
// The panel owns what both columns share: the current file (the list's click,
// the view's scroll-spy), the viewed marks, kept per path for the panel's
// lifetime, and the Tour's active step — a jump switches to the full diff
// when the shown one lacks the step's file or its lines.

const props = withDefaults(
  defineProps<{
    data: PrReviewData;
    /** Render a close control that emits `close` — for a host that puts the
     *  panel in a dialog of its own and hides the dialog's chrome. */
    closable?: boolean;
    /** The abridging of the full diff, when the host can ask for one; absent
     *  when the deployment cannot — nothing then renders. */
    abridge?: AbridgeControl;
  }>(),
  { closable: false, abridge: undefined },
);
const emit = defineEmits<{ close: [] }>();

const links = computed(() => prLinks(props.data.pr));
const title = computed(() => panelTitle(props.data));
const diffs = computed(() => props.data.readingDiffs);
const description = computed(() => props.data.description);
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
const gitTab = computed(() => tabs.value.findIndex((d) => d.poweredBy === "git"));
/** The full diff's file count while the abridged one is shown (the footer's
 *  "N of M files shown"); undefined when there is nothing to compare against. */
const fullFileCount = computed(() => {
  const git = tabs.value[gitTab.value];
  return shown.value?.poweredBy === "meat" && git ? countFiles(git.diff) : undefined;
});
const totals = computed(() => ({
  added: files.value.reduce((n, f) => n + f.added, 0),
  deleted: files.value.reduce((n, f) => n + f.deleted, 0),
}));
const shortSha = computed(() => props.data.pr.headSha?.slice(0, 7));

/** The abridge control shows while the full diff stands alone and the host
 *  offers one; once the abridged diff arrives the tabs take its place. */
const abridgeShown = computed(
  () =>
    props.abridge !== undefined &&
    props.abridge.state.state !== "done" &&
    tabs.value.length === 1 &&
    shown.value?.poweredBy === "git",
);
const ABRIDGE_EXPLANATION =
  "Abridge the full diff with meat.dev: a model keeps the concepts and drops what a reviewer need not read. One model call; usually a minute or three.";

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

// The Tour. Each step is placed against the shown diff and the full one; a
// jump brings the step's file on screen — switching to the full diff when the
// abridgement dropped the file, or dropped the lines — then lights the range.
const shownPaths = computed(() => new Set(files.value.map((f) => f.path)));
const fullPaths = computed(() => {
  const git = tabs.value[gitTab.value];
  return git ? new Set(filePaths(git.diff)) : shownPaths.value;
});
/** The fullest diff on record was cut at its cap: a file no diff carries may
 *  lie past the cut, so a step there says "beyond", never "not in this diff". */
const fullTruncated = computed(() => (tabs.value[gitTab.value] ?? shown.value)?.truncated === true);
const activeStep = ref<number | null>(null);
const missedStep = ref<number | null>(null);
watch(description, () => {
  activeStep.value = null;
  missedStep.value = null;
});

/** Bring a file's diff on screen: already shown, or in the full diff (switch
 *  the tab and wait for the render). False when no diff carries it. */
async function showFile(path: string): Promise<boolean> {
  if (shownPaths.value.has(path)) return true;
  if (gitTab.value < 0 || !fullPaths.value.has(path)) return false;
  active.value = gitTab.value;
  await nextTick();
  return true;
}

async function jumpTo(index: number): Promise<void> {
  const step = description.value?.tour[index];
  if (!step || !(await showFile(step.anchor.path))) return;
  const { path, from, to } = step.anchor;
  activeStep.value = index;
  current.value = path;
  let hit = (await view.value?.scrollTo(path, from, to)) ?? false;
  // The abridged diff carries the file but not these lines: the full diff may.
  if (!hit && active.value !== gitTab.value && gitTab.value >= 0) {
    active.value = gitTab.value;
    await nextTick();
    current.value = path;
    hit = (await view.value?.scrollTo(path, from, to)) ?? false;
  }
  missedStep.value = hit ? null : index;
  if (!hit) view.value?.scrollToFile(path);
}

async function openPath(path: string): Promise<void> {
  if (await showFile(path)) select(path);
}

const wrap = ref(false);
</script>

<template>
  <div class="pr-review-panel flex h-full min-h-0 min-w-0 flex-col" data-testid="pr-review-panel">
    <header class="header flex shrink-0 flex-col gap-1 border-b border-default px-4 py-2.5">
      <div class="flex items-center gap-2">
        <h2 class="m-0 min-w-0 flex-1 truncate text-sm font-medium text-highlighted" data-testid="pr-title">
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
                  ? 'bg-default font-medium text-highlighted shadow-sm ring-1 ring-default'
                  : 'font-medium text-muted hover:bg-default/60 hover:text-default'
              "
              :aria-selected="i === active"
              @click="active = i"
            >
              {{ d.poweredBy === "meat" ? "Reading diff" : "Full diff" }}
            </button>
          </LabelTip>
        </div>
        <!-- Where the tabs would be: the abridge control, while only the full
             diff exists and the host can produce the abridged one. -->
        <template v-else-if="abridgeShown && abridge">
          <LabelTip v-if="abridge.state.state === 'absent'" :text="ABRIDGE_EXPLANATION">
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-scissors"
              label="Abridge with meat"
              data-testid="abridge-button"
              @click="abridge.start()"
            />
          </LabelTip>
          <span
            v-else-if="abridge.state.state === 'running'"
            class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted"
            data-testid="abridge-running"
          >
            <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
            Abridging… usually 1–3 minutes
          </span>
          <span
            v-else-if="abridge.state.state === 'failed'"
            class="inline-flex min-w-0 shrink items-center gap-1.5 text-xs text-error"
            data-testid="abridge-failed"
          >
            <UIcon name="i-lucide-circle-alert" class="size-3.5 shrink-0" />
            <span class="truncate" :title="abridge.state.reason">Abridging failed: {{ abridge.state.reason }}</span>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              label="Retry"
              data-testid="abridge-retry"
              @click="abridge.start()"
            />
          </span>
        </template>
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
      <!-- Wide enough that a two-line step title and a path with its file
           name read at a glance; the column never squeezes for the diff. -->
      <aside class="hidden w-[19rem] shrink-0 overflow-y-auto border-r border-default md:block">
        <FileList :files="files" :current="current" :viewed="viewed" @select="select" @toggle-viewed="toggleViewed">
          <template #description>
            <slot name="description">
              <DescriptionBlock v-if="description" :description="description" />
            </slot>
          </template>
          <template #tour>
            <slot name="tour">
              <TourList
                v-if="description && (description.tour.length > 0 || description.remaining.length > 0)"
                :steps="description.tour"
                :remaining="description.remaining"
                :shown-paths="shownPaths"
                :full-paths="fullPaths"
                :full-truncated="fullTruncated"
                :pr="data.pr"
                :reviewed-sha="data.pr.headSha ?? description.headSha"
                :active="activeStep"
                :missed="missedStep"
                @jump="jumpTo"
                @open="openPath"
              />
            </slot>
          </template>
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
/* The three hues every part of the panel shares — the list's counts and
 * icons, the diff's tints, and the mark a Tour jump leaves on its rows and
 * its step; the host may retune them on `.pr-review-panel`. The mark is a
 * third hue on purpose: a range of added lines lit in the insertion green
 * would vanish into them. */
.pr-review-panel {
  --pr-review-ins: var(--ui-success, #3d7346);
  --pr-review-del: var(--ui-error, #b84a42);
  --pr-review-mark: var(--ui-info, #3a68a0);
}
.pr-review-panel .text-ins {
  color: var(--pr-review-ins);
}
.pr-review-panel .text-del {
  color: var(--pr-review-del);
}
</style>
