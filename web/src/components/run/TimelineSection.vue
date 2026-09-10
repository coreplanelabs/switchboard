<script setup lang="ts">
import { browser } from "../../lib/browser";
import { formatDuration } from "../../lib/format";
import { TERM_PAINT } from "../../lib/termPaint";
import type { BarSegment, TimelineVm } from "../../lib/timelineVm";

// Where the time went (live-view item 25): the summary of THIS RUN as one
// object — the total, a bar of the run's shape, a legend that labels the
// bar's segments in the bar's own words (each word defined on hover), and the
// three steps that took the most of their own time, each a link to its row.
// Everything here is the view-model's text — the component paints, it never
// computes a duration. Raw span names live behind Copy debug JSON only.
//
// The legend's words are the words the rows below use — `Getting ready` and
// `Finishing up` head the phase groups, `thought …` heads every model turn,
// the tool calls are the cards — so a reader can correlate the two. The paint
// is `TERM_PAINT` (web/src/lib/termPaint.ts): one class per word, shared by
// the segments, the swatches and the phase heads' markers.

const props = defineProps<{ vm: TimelineVm; eventsHref?: string }>();
const emit = defineEmits<{ reveal: [anchor: string] }>();

function segTitle(seg: BarSegment): string {
  return `${formatDuration(seg.ms, "clock")} ${seg.term}${seg.hatched ? " (in flight)" : ""}`;
}

function copyDebug(): void {
  void browser.copyText(JSON.stringify(props.vm.debug, null, 2));
}
</script>

<template>
  <section
    id="timeline"
    class="block mb-4 rounded-lg border border-default bg-(--ui-bg-muted) px-(--sb-gutter) py-3"
    data-testid="timeline"
  >
    <h2 class="mb-2 flex items-baseline gap-2.5 text-xs font-semibold uppercase tracking-wider text-muted">
      <span>Where the time went</span>
      <span class="ml-auto flex items-baseline gap-3 font-normal normal-case tracking-normal">
        <a
          v-if="eventsHref"
          class="text-dimmed no-underline hover:text-primary hover:underline"
          :href="eventsHref"
          title="the stored events, as JSON lines"
          >raw events</a
        >
        <button
          type="button"
          class="debug cursor-pointer text-dimmed hover:text-toned"
          title="the partition and the raw span names, for a bug report"
          @click="copyDebug"
        >
          Copy debug JSON
        </button>
      </span>
    </h2>
    <!-- The lede: the total (the header's, to the second) and what is happening
         now; below the gate the total and the one dominant word instead. -->
    <p class="lede text-sm text-toned">
      <span class="shape tabular-nums">{{ vm.shown ? vm.total : vm.lede }}</span>
      <span v-if="vm.current" class="current text-muted"> · {{ vm.current }}</span>
    </p>
    <p v-for="caption in vm.captions" :key="caption" class="caption mt-0.5 text-xs text-muted">{{ caption }}</p>
    <p v-if="vm.note" class="note mt-0.5 text-xs text-muted">{{ vm.note }}</p>
    <template v-if="vm.shown">
      <div class="bar mt-2.5 flex h-2 w-full overflow-hidden rounded-sm" role="img" :aria-label="vm.lede">
        <div
          v-for="(seg, i) in vm.bar"
          :key="i"
          class="seg h-full"
          :class="[TERM_PAINT[seg.term], seg.hatched ? 'paint-hatched hatched' : '']"
          :style="{ width: `${seg.pct}%` }"
          :title="segTitle(seg)"
          :data-term="seg.term"
        />
      </div>
      <!-- The legend: the bar's segments, labelled — swatch · word · time, the
           word's definition on hover. Same numbers, same order as the bar. -->
      <ul class="legend mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <li
          v-for="item in vm.legend"
          :key="item.term"
          class="flex items-baseline gap-1.5 cursor-help"
          :title="item.definition"
          :data-term="item.term"
        >
          <span class="swatch inline-block size-2 shrink-0 self-center rounded-[2px]" :class="TERM_PAINT[item.term]" />
          <span class="term text-muted">{{ item.term }}</span>
          <span class="ms tabular-nums text-toned">{{ item.text }}</span>
        </li>
      </ul>
      <template v-if="vm.ranked.length > 0">
        <h3
          class="ranked-head mt-3 inline-block cursor-help text-xs font-semibold text-muted underline decoration-dotted decoration-(--ui-border-accented) underline-offset-2"
          :title="vm.rankedNote"
        >
          Longest steps
        </h3>
        <ol class="ranked mt-1 flex flex-col gap-1 text-xs">
          <li v-for="(item, i) in vm.ranked" :key="i" class="flex items-baseline gap-2">
            <span class="ms w-14 shrink-0 tabular-nums text-toned">{{ formatDuration(item.ms, "clock") }}</span>
            <a
              class="label min-w-0 truncate text-muted no-underline hover:text-primary hover:underline"
              :href="`#${item.anchor}`"
              :data-anchor="item.anchor"
              title="scroll to this step"
              @click.prevent="emit('reveal', item.anchor)"
              >{{ item.label }}</a
            >
            <span
              v-for="fact in item.facts"
              :key="fact"
              class="fact shrink-0 rounded border border-accented px-1 text-dimmed"
              >{{ fact }}</span
            >
          </li>
        </ol>
      </template>
    </template>
  </section>
</template>
