<script setup lang="ts">
import { browser } from "../../lib/browser";
import { formatDuration } from "../../lib/format";
import type { BarSegment, TimelineVm } from "../../lib/timelineVm";

// The run's shape (live-view item 25): the lede is the header's total split
// into the five words; under the gate's pass, an unlabelled bar of the same
// numbers, the gloss, and the three steps that took the most of their own
// time. Everything here is the view-model's text — the component paints, it
// never computes a duration. Raw span names live behind Copy debug JSON only.

const props = defineProps<{ vm: TimelineVm; eventsHref?: string }>();

const TERM_CLASS: Record<BarSegment["term"], string> = {
  "getting ready": "seg-ready",
  thinking: "seg-thinking",
  "in tools": "seg-tools",
  "finishing up": "seg-finishing",
  "Switchboard overhead": "seg-overhead",
  "not recorded": "seg-lost",
  "not loaded": "seg-elided",
};

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
    class="block mb-5 rounded-lg border border-default bg-(--ui-bg-muted) px-3.5 py-3"
    data-testid="timeline"
  >
    <h2 class="mb-2 flex items-baseline gap-2.5 text-xs font-semibold uppercase tracking-wider text-muted">
      <span>Timeline</span>
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
    <p class="lede text-sm text-toned">
      <span class="shape">{{ vm.lede }}</span>
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
          :class="[TERM_CLASS[seg.term], seg.hatched ? 'hatched' : '']"
          :style="{ width: `${seg.pct}%` }"
          :title="segTitle(seg)"
          :data-term="seg.term"
        />
      </div>
      <p class="gloss mt-1.5 text-xs text-dimmed">{{ vm.gloss }}</p>
      <ol v-if="vm.ranked.length > 0" class="ranked mt-2.5 flex flex-col gap-1 text-xs">
        <li v-for="(item, i) in vm.ranked" :key="i" class="flex items-baseline gap-2">
          <span class="ms tabular-nums text-toned">{{ formatDuration(item.ms, "clock") }}</span>
          <span class="label text-muted">{{ item.label }}</span>
          <span v-for="fact in item.facts" :key="fact" class="fact rounded border border-accented px-1 text-dimmed">{{
            fact
          }}</span>
        </li>
      </ol>
      <p v-if="vm.ranked.length > 0" class="ranked-note mt-1 text-xs text-dimmed">{{ vm.rankedNote }}</p>
    </template>
  </section>
</template>

<style scoped>
/* The bar's five words, painted from the theme's own tokens — one colour per
   term, the two loss terms and the residual visibly "not work" (striped or
   hollow), the in-flight tail hatched over its bucket's colour. */
.seg-ready {
  background: var(--ui-info);
}
.seg-thinking {
  background: var(--ui-primary);
}
.seg-tools {
  background: var(--ui-success);
}
.seg-finishing {
  background: var(--ui-secondary);
}
.seg-overhead {
  background: repeating-linear-gradient(135deg, var(--ui-border-accented) 0 3px, transparent 3px 6px);
}
.seg-lost {
  background: repeating-linear-gradient(135deg, var(--ui-warning) 0 3px, transparent 3px 6px);
}
.seg-elided {
  box-shadow: inset 0 0 0 1px var(--ui-border-accented);
  background: transparent;
}
.hatched {
  background-image: repeating-linear-gradient(135deg, rgb(255 255 255 / 0.45) 0 2px, transparent 2px 5px);
}
</style>
