<script setup lang="ts">
import { computed } from "vue";
import StepItems from "./StepItems.vue";
import MarkdownText from "../MarkdownText.vue";
import { formatClock, formatElapsed, formatLocalIso } from "../../lib/format";
import type { StepVm } from "../../lib/runPageModel";

// ONE STEP = ONE BLOCK, read top to bottom (item 18): a rail marks where it
// starts and ends. Its head is ONE meta row — `thought <span> · <token facts>`
// on the left, the viewer's clock on the right — so every step's prose starts
// flush left at the same rhythm. Under the prose, the calls it explains; from
// the 2nd non-quiet call the cards fold into ONE group whose summary tallies
// them (the fold rules live in runPageModel).
//
// The timeline speaks TWO text sizes: `text-xs` for metadata (this head row,
// card facts, quiet rows) and the body size for everything a person reads.

const props = defineProps<{ step: StepVm }>();
const emit = defineEmits<{ toggleGroup: [] }>();

const cards = computed(() => props.step.items.filter((i) => i.kind === "call"));
const grouped = computed(() => cards.value.length >= 2);
const tally = computed(() => {
  let ok = 0;
  let bad = 0;
  let infra = 0;
  let running = 0;
  let ms = 0;
  for (const item of cards.value) {
    if (item.kind !== "call") continue;
    const c = item.call;
    if (c.status === "ok") ok++;
    else if (c.status === "failed") bad++;
    else if (c.status === "infra") infra++;
    else running++;
    if (typeof c.durationMs === "number") ms += c.durationMs;
  }
  return { n: ok + bad + infra + running, ok, bad, infra, running, ms };
});

const firstCallAt = computed(() => {
  const first = cards.value[0];
  return first?.kind === "call" ? first.call.startedAt : undefined;
});
</script>

<template>
  <li
    class="step relative border-l-2 pb-3 pl-3 pt-2"
    :class="step.live ? 'border-ok/40' : 'border-(--ui-border-accented)/50'"
    :data-live="step.live ? '1' : undefined"
  >
    <!-- The head: ONE row — the turn's cost (or, with no turn, the prose
         itself) on the left, WHEN on the right; a wide gap keeps long text
         clear of the clock. -->
    <div class="head flex items-baseline gap-x-6 pb-1.5 pr-3">
      <div class="min-w-0 flex-1">
        <div v-if="step.turn" class="meta flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-xs tabular-nums text-dimmed">
          <span class="thought" :class="step.turn.quick ? '' : 'text-warn'" :title="step.turn.label">thought {{ step.turn.chip }}</span>
          <span v-for="(f, i) in step.turn.facts" :key="i" class="fact">{{ f }}</span>
        </div>
        <MarkdownText v-else-if="step.narration !== null" :text="step.narration" />
        <!-- Neither a turn nor prose to head the row: the filler says why. -->
        <span v-else class="nonar font-sans text-sm italic text-dimmed">{{ step.note }}</span>
      </div>
      <span v-if="step.at !== undefined" class="ts shrink-0 select-none text-xs tabular-nums text-dimmed" :title="formatLocalIso(step.at)">{{
        formatClock(step.at)
      }}</span>
    </div>
    <!-- Prose that follows a cost head sits flush left under it. -->
    <div v-if="step.turn && step.narration !== null" class="narration flex items-baseline gap-3 pb-1.5 pr-3">
      <MarkdownText :text="step.narration" />
    </div>
    <div v-else-if="step.turn && step.narration === null && !step.turn.facts.length" class="narration flex items-baseline gap-3 pb-1.5 pr-3">
      <span class="nonar flex-1 font-sans text-sm italic text-dimmed">{{ step.note }}</span>
    </div>

    <div class="calls flex flex-col gap-2 pr-3">
      <StepItems v-if="!grouped" :items="step.items" />
      <details v-else class="grp" :open="step.groupOpen" :data-group-open="step.groupOpen ? '1' : '0'">
        <summary
          class="gsummary flex cursor-pointer list-none items-baseline gap-4 rounded-md border border-default bg-elevated px-3 py-2 hover:bg-accented/60 focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden"
          :title="typeof firstCallAt === 'number' ? `calls began ${formatLocalIso(firstCallAt)}` : undefined"
          @click.prevent="emit('toggleGroup')"
        >
          <span
            class="gchev order-9 shrink-0 text-xs text-dimmed transition-transform motion-reduce:transition-none"
            :class="step.groupOpen ? 'rotate-90' : ''"
            >❯</span
          >
          <span class="gcount font-semibold text-highlighted">{{ tally.n }} {{ tally.n === 1 ? "call" : "calls" }}</span>
          <span v-if="tally.ok" class="gok text-ok">✓ {{ tally.ok }}</span>
          <span v-if="tally.bad" class="gbad text-bad">✗ {{ tally.bad }}</span>
          <span v-if="tally.infra" class="ginfra text-warn">⚠ {{ tally.infra }}</span>
          <span v-if="tally.running" class="grun text-info">{{ tally.running }} running</span>
          <span v-if="tally.ms > 0" class="gtime ml-auto text-xs tabular-nums text-muted">{{ formatElapsed(tally.ms) }}</span>
        </summary>
        <div class="gbody flex flex-col gap-2 pb-1 pt-2">
          <StepItems :items="step.items" />
        </div>
      </details>
    </div>
  </li>
</template>
