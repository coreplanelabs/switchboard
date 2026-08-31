<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { PrReviewData, ReadingDiff } from "./types";
import { preferredDiff, prLinks } from "./types";
import ReadingDiffView from "./ReadingDiffView.vue";

// The PR-review panel: the change as a reviewer reads it, next to links back
// to the PR itself. Props-only (see README.md) — the host app decides where it
// lives (Switchboard: a slideout on review-run pages) and adapts its own data.

const props = defineProps<{ data: PrReviewData }>();

const links = computed(() => prLinks(props.data.pr));
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
const shortSha = computed(() => props.data.pr.headSha?.slice(0, 7));
</script>

<template>
  <div class="pr-review-panel flex min-w-0 flex-col gap-3" data-testid="pr-review-panel">
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <a v-if="links.pr" :href="links.pr" target="_blank" rel="noopener noreferrer" class="font-medium text-primary hover:underline" data-testid="pr-link">
        {{ data.pr.repo }}#{{ data.pr.number }}
      </a>
      <span v-else-if="data.pr.repo" class="font-medium">{{ data.pr.repo }}</span>
      <a v-if="links.commit" :href="links.commit" target="_blank" rel="noopener noreferrer" class="font-mono text-xs text-muted hover:underline" data-testid="commit-link">
        {{ shortSha }}
      </a>
      <a v-if="links.files" :href="links.files" target="_blank" rel="noopener noreferrer" class="text-xs text-muted hover:underline" data-testid="files-link">
        all files on GitHub ↗
      </a>
    </div>

    <div v-if="tabs.length > 1" class="flex gap-1" role="tablist" data-testid="diff-tabs">
      <UButton
        v-for="(d, i) in tabs"
        :key="d.poweredBy"
        role="tab"
        size="xs"
        :variant="i === active ? 'solid' : 'outline'"
        color="neutral"
        :label="d.poweredBy === 'meat' ? 'Reading diff' : 'Full diff'"
        :aria-selected="i === active"
        @click="active = i"
      />
    </div>

    <ReadingDiffView v-if="shown" :diff="shown" />
    <p v-else class="text-sm text-muted" data-testid="no-diff">No reading diff was produced for this review.</p>
  </div>
</template>
