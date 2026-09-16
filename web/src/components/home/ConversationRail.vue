<script setup lang="ts">
import { computed, ref } from "vue";
import type { HomeConversationRowSeed } from "@core/channels/webSeed.js";
import { formatRelative } from "../../lib/format";
import { filterRows } from "../../lib/homeModel";

// The rail (docs/reference/specs/web-chat.md item 7): the person's RECENT
// conversations, each the runs of one `web:` thread, newest first, titled by
// its first request. Bounded by the seed (the bot caps it), so there is nothing
// to page: the way to everything is the `All runs` link at the foot. A filter
// (⌘K) narrows the rows by a fuzzy match; the new-thread CTA carries its
// shortcut (⇧⌘O). A full page load per conversation, like every section.

const props = defineProps<{
  rows: HomeConversationRowSeed[];
  current: string;
  now: number;
  retention: string;
}>();

const query = ref("");
const filter = ref<HTMLInputElement | null>(null);
const shown = computed(() => filterRows(props.rows, query.value));

/** ⌘K lands here (the page routes the shortcut). */
function focusFilter(): void {
  filter.value?.focus();
  filter.value?.select();
}
function onFilterKey(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    query.value = "";
    filter.value?.blur();
  }
}
defineExpose({ focusFilter });
</script>

<template>
  <nav class="rail flex flex-col gap-1 text-[0.8rem]" aria-label="Recent threads">
    <!-- The CTA: the one solid control on the rail, with its shortcut in view. -->
    <a
      class="new group mb-3 flex items-center gap-2 rounded-xl bg-inverted px-3 py-2 font-medium text-inverted no-underline transition-[transform,opacity] duration-150 ease-out hover:-translate-y-px hover:opacity-90 active:translate-y-0 active:opacity-100"
      href="/threads"
      :aria-current="current === '' ? 'page' : undefined"
      data-testid="new-thread"
    >
      <UIcon
        name="i-lucide-plus"
        class="size-4 shrink-0 transition-transform duration-150 ease-out group-hover:rotate-90"
        aria-hidden="true"
      />
      <span>New thread</span>
      <span class="kbd ml-auto flex gap-0.5 font-mono text-[0.65rem] opacity-70" aria-label="shortcut shift command O">
        <kbd class="rounded border border-current/30 px-1">⇧</kbd
        ><kbd class="rounded border border-current/30 px-1">⌘</kbd
        ><kbd class="rounded border border-current/30 px-1">O</kbd>
      </span>
    </a>

    <!-- The filter: a hairline field that brightens on focus, ⌘K away. -->
    <label
      class="filter mb-2 flex items-center gap-2 rounded-lg border border-default px-2.5 py-1.5 transition-colors duration-150 ease-out focus-within:border-primary hover:border-accented"
    >
      <UIcon name="i-lucide-search" class="size-3.5 shrink-0 text-dimmed" aria-hidden="true" />
      <input
        ref="filter"
        v-model="query"
        class="min-w-0 flex-1 bg-transparent text-[0.8rem] text-highlighted outline-none placeholder:text-dimmed"
        type="text"
        placeholder="Filter recent"
        aria-label="Filter recent threads"
        autocomplete="off"
        @keydown="onFilterKey"
      />
      <kbd v-if="!query" class="rounded border border-default px-1 font-mono text-[0.65rem] text-dimmed">⌘K</kbd>
    </label>

    <p class="label px-3 pb-1 font-mono text-[0.65rem] font-medium uppercase tracking-wider text-dimmed">Recent</p>
    <p v-if="rows.length === 0" class="empty px-3 py-1 text-xs text-dimmed">Nothing yet. Ask something.</p>
    <p v-else-if="shown.length === 0" class="nomatch px-3 py-1 text-xs text-dimmed">Nothing matches "{{ query }}".</p>
    <TransitionGroup name="sb-rise" tag="div" class="rows flex flex-col gap-0.5">
      <a
        v-for="row in shown"
        :key="row.id"
        class="row group relative flex items-baseline gap-2 rounded-lg px-3 py-1.5 no-underline transition-colors duration-150 ease-out hover:bg-(--ui-bg-muted) aria-[current=page]:bg-(--ui-bg-accented)"
        :href="`/threads/${encodeURIComponent(row.id)}`"
        :aria-current="row.id === current ? 'page' : undefined"
        :title="`${row.runs} run${row.runs === 1 ? '' : 's'}`"
      >
        <!-- The active row's ink bar at the left edge. -->
        <span
          class="bar absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary opacity-0 transition-opacity duration-150 ease-out group-aria-[current=page]:opacity-100"
          aria-hidden="true"
        />
        <span
          v-if="row.live"
          class="dot mt-px size-1.5 shrink-0 self-center rounded-full bg-ok motion-safe:animate-pulse"
          aria-label="a run is in flight"
        />
        <span
          class="title min-w-0 flex-1 truncate text-toned group-hover:text-highlighted group-aria-[current=page]:text-highlighted"
          >{{ row.title }}</span
        >
        <span class="when shrink-0 font-mono text-[0.7rem] tabular-nums text-dimmed">{{
          formatRelative(row.lastAt, now)
        }}</span>
      </a>
    </TransitionGroup>

    <a
      class="all mt-3 flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-muted no-underline transition-colors duration-150 ease-out hover:text-highlighted"
      href="/runs"
      data-testid="all-runs"
    >
      All runs
      <UIcon
        name="i-lucide-arrow-right"
        class="size-3 transition-transform duration-150 ease-out group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </a>
    <p class="retention px-3 pt-1 text-[0.7rem] leading-relaxed text-dimmed">{{ retention }}</p>
  </nav>
</template>
