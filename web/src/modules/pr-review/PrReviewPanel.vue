<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import MarkdownText from "../../components/MarkdownText.vue";
import FilesChanged from "./FilesChanged.vue";
import LabelTip from "./LabelTip.vue";
import type { AbridgeControl, PrReviewData, ReadingDiff } from "./types";
import {
  descriptionNote,
  panelTitle,
  poweredByExplanation,
  poweredByLabel,
  preferredDiff,
  prLinks,
  truncatedExplanation,
} from "./types";

// The PR-review panel: the change as a reviewer reads it, under the PR's own
// title. Props-only (see README.md) — the host app decides where it lives
// (Switchboard: a slideout on review-run pages) and adapts its own data.
//
// Shape, top to bottom: a header (the title; one line of facts — the
// reference, the head, the base, the producer; the actions — View on GitHub,
// the abridge control when the host offers one and the full diff stands
// alone, the close control for a host that asks), a tab row (one tab per
// diff on record, the Description when the host knows it; at the right, the
// Inline / Side by side choice, remembered per browser), then the tab's
// content: the Files changed view for a diff, the prose for the description.

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
const gitDiff = computed(() => diffs.value.find((d) => d.poweredBy === "git"));
const meatDiff = computed(() => diffs.value.find((d) => d.poweredBy === "meat"));
const shortSha = computed(() => props.data.pr.headSha?.slice(0, 7));

type Tab = "files" | "reading" | "description";
const tabs = computed<Array<{ label: string; value: Tab }>>(() => {
  const items: Array<{ label: string; value: Tab }> = [];
  if (gitDiff.value) items.push({ label: "Files changed", value: "files" });
  if (meatDiff.value) items.push({ label: "Reading diff", value: "reading" });
  if (description.value?.tldr || description.value?.whatWhy) items.push({ label: "Description", value: "description" });
  return items;
});
/** The abridged diff is the reader's first stop when a producer made one. */
const preferredTab = (): Tab => (preferredDiff(diffs.value)?.poweredBy === "meat" ? "reading" : "files");
const tab = ref<Tab>(preferredTab());
watch(
  () => preferredDiff(diffs.value),
  () => (tab.value = preferredTab()), // new data → back to the preferred view
);
watch(
  tabs,
  (items) => {
    if (!items.some((item) => item.value === tab.value)) tab.value = items[0]?.value ?? "files";
  },
  { immediate: true },
);

/** The diff the current tab shows; none on the Description tab. */
const shown = computed<ReadingDiff | undefined>(() =>
  tab.value === "files" ? gitDiff.value : tab.value === "reading" ? meatDiff.value : undefined,
);
/** The lines over the diff: the producer's summary, then the cut's notice. */
const notes = computed(() => {
  const d = shown.value;
  if (!d) return [];
  const out: string[] = [];
  if (d.summary) out.push(d.summary);
  if (d.truncated) out.push(`${truncatedExplanation(d.diff.length)}.`);
  return out;
});
const note = computed(() => (description.value ? descriptionNote(description.value) : undefined));

// Inline or side by side, the reader's choice, kept per browser.
const DIFF_STYLE_KEY = "switchboard:diffStyle";
const DIFF_STYLES = [
  { label: "Inline", value: "unified", icon: "i-lucide-rows-3" },
  { label: "Side by side", value: "split", icon: "i-lucide-columns-2" },
];
const diffStyle = ref<"unified" | "split">("unified");
onMounted(() => {
  try {
    if (localStorage.getItem(DIFF_STYLE_KEY) === "split") diffStyle.value = "split";
  } catch {
    // Storage can be blocked; the default view stands.
  }
});
function setDiffStyle(style: string | number) {
  diffStyle.value = style === "split" ? "split" : "unified";
  try {
    localStorage.setItem(DIFF_STYLE_KEY, diffStyle.value);
  } catch {
    // Storage can be blocked; the choice lasts for this panel.
  }
}

/** The abridge control shows while the full diff stands alone and the host
 *  offers one; once the abridged diff arrives its tab takes the control's place. */
const abridgeShown = computed(
  () =>
    props.abridge !== undefined &&
    props.abridge.state.state !== "done" &&
    gitDiff.value !== undefined &&
    !meatDiff.value,
);
const ABRIDGE_EXPLANATION =
  "Abridge the full diff with meat.dev: a model keeps the concepts and drops what a reviewer need not read. One model call; usually a minute or three.";
</script>

<template>
  <div class="pr-review-panel @container flex h-full min-h-0 min-w-0 flex-col" data-testid="pr-review-panel">
    <header class="shrink-0 border-b border-(--ui-border) px-4 pt-5 pb-4 sm:px-6">
      <div class="flex flex-col gap-3 @2xl:flex-row @2xl:items-start @2xl:justify-between @2xl:gap-4">
        <div class="min-w-0">
          <h1
            class="line-clamp-2 text-lg leading-snug font-semibold text-(--ui-text) @2xl:line-clamp-none @2xl:truncate"
            data-testid="pr-title"
          >
            {{ title }}
          </h1>
          <div
            class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--ui-text-muted)"
            data-testid="pr-facts"
          >
            <a
              v-if="links.pr"
              :href="links.pr"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1.5 hover:text-(--ui-text)"
              data-testid="pr-link"
            >
              <UIcon name="i-simple-icons-github" class="size-3.5 shrink-0" />
              <span>{{ data.pr.repo }}#{{ data.pr.number }}</span>
            </a>
            <span v-else-if="data.pr.repo" class="inline-flex items-center gap-1.5">
              <UIcon name="i-simple-icons-github" class="size-3.5 shrink-0" />
              <span>{{ data.pr.repo }}</span>
            </span>
            <a
              v-if="links.commit"
              :href="links.commit"
              target="_blank"
              rel="noopener noreferrer"
              class="font-mono hover:text-(--ui-text)"
              data-testid="commit-link"
              >{{ shortSha }}</a
            >
            <template v-if="shown">
              <span title="the base the diff is against">against origin/{{ shown.baseRef }}</span>
              <LabelTip :text="poweredByExplanation(shown.poweredBy)">
                <span data-testid="producer-label">{{ poweredByLabel(shown.poweredBy) }}</span>
              </LabelTip>
              <LabelTip v-if="shown.truncated" :text="truncatedExplanation(shown.diff.length)">
                <span class="inline-flex items-center gap-1 text-(--ui-warning)" data-testid="truncated-label">
                  <UIcon name="i-lucide-scissors" class="size-3.5" />truncated
                </span>
              </LabelTip>
            </template>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <UButton
            v-if="links.pr"
            label="View on GitHub"
            icon="i-simple-icons-github"
            color="neutral"
            variant="ghost"
            size="sm"
            :to="links.pr"
            target="_blank"
            data-testid="github-button"
          />
          <template v-if="abridgeShown && abridge">
            <LabelTip v-if="abridge.state.state === 'absent'" :text="ABRIDGE_EXPLANATION">
              <UButton
                label="Abridge with meat"
                icon="i-lucide-scissors"
                size="sm"
                data-testid="abridge-button"
                @click="abridge.start()"
              />
            </LabelTip>
            <span
              v-else-if="abridge.state.state === 'running'"
              class="inline-flex shrink-0 items-center gap-1.5 text-xs text-(--ui-text-muted)"
              data-testid="abridge-running"
            >
              <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
              Abridging… usually 1–3 minutes
            </span>
            <span
              v-else-if="abridge.state.state === 'failed'"
              class="inline-flex min-w-0 shrink items-center gap-1.5 text-xs text-(--ui-error)"
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
            v-if="closable"
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="Close"
            data-testid="panel-close"
            @click="emit('close')"
          />
        </div>
      </div>
    </header>
    <div
      v-if="tabs.length > 0"
      class="flex shrink-0 items-center justify-between gap-3 border-b border-(--ui-border) px-4 py-2 sm:px-6"
    >
      <div class="tabs-scroll min-w-0 overflow-x-auto">
        <UTabs v-model="tab" :items="tabs" size="sm" class="w-fit gap-0" :content="false" data-testid="panel-tabs" />
      </div>
      <UTabs
        v-if="shown"
        :model-value="diffStyle"
        :items="DIFF_STYLES"
        color="neutral"
        size="xs"
        :content="false"
        class="hidden w-fit @2xl:flex"
        data-testid="diff-style"
        @update:model-value="setDiffStyle"
      />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <FilesChanged v-if="shown" :key="shown.poweredBy" :diff="shown.diff" :notes="notes" :diff-style="diffStyle" />
      <div
        v-else-if="tab === 'description' && description"
        class="mx-auto max-w-3xl p-4 sm:p-6"
        data-testid="pr-description"
      >
        <div class="mb-2 text-xs font-medium text-(--ui-text-dimmed)">What the pull request says about itself</div>
        <MarkdownText v-if="description.tldr" :text="description.tldr" class="text-sm" data-testid="description-tldr" />
        <template v-if="description.whatWhy">
          <div class="mt-4 mb-2 text-xs font-medium text-(--ui-text-dimmed)">What &amp; why</div>
          <MarkdownText :text="description.whatWhy" class="text-sm" data-testid="description-what-why" />
        </template>
        <p v-if="note" class="mt-4 text-xs text-(--ui-text-dimmed) italic" data-testid="description-origin">
          {{ note }}
        </p>
      </div>
      <p v-else class="px-4 py-3 text-sm text-(--ui-text-muted) sm:px-6" data-testid="no-diff">
        No reading diff was produced for this review.
      </p>
    </div>
  </div>
</template>

<style>
/* The tab row scrolls sideways on a narrow panel without showing a scrollbar. */
.pr-review-panel .tabs-scroll {
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.pr-review-panel .tabs-scroll::-webkit-scrollbar {
  display: none;
}
</style>
