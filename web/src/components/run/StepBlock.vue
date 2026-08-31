<script setup lang="ts">
import { computed } from "vue";
import StepItems from "./StepItems.vue";
import MarkdownText from "../MarkdownText.vue";
import { formatElapsed, formatLocalIso } from "../../lib/format";
import type { StepVm } from "../../lib/runPageModel";

// ONE STEP = ONE BLOCK, read top to bottom (item 18): a rail marks where it
// starts and ends; its first row is the head — [when] 💭 how long the model
// thought → what it then said (the token facts ride a small line ABOVE the
// prose, item 21) — and under it, the calls that prose explains. From the 2nd
// non-quiet call the cards fold into ONE group whose summary tallies them
// (open while anything runs or failed; the fold rules live in runPageModel).

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

function stamp(at: number | undefined): string {
  return typeof at === "number" ? `[${formatLocalIso(at).slice(11, 19)}]` : "";
}
</script>

<template>
  <li
    class="step relative border-l-2 pb-3 pl-3 pt-2 sm:pl-[9.5rem]"
    :class="step.live ? 'border-ok/40' : 'border-(--ui-border-accented)/50'"
    :data-live="step.live ? '1' : undefined"
  >
    <!-- The gutter stamp: the short local clock, the full ISO on hover. The
         gutter is a wide-screen luxury — on a phone the stamp is hidden. -->
    <span
      v-if="step.at !== undefined"
      class="ts absolute left-3 top-2.5 hidden select-none text-xs text-dimmed sm:block"
      :title="formatLocalIso(step.at)"
      >{{ stamp(step.at) }}</span
    >

    <!-- Above the prose: the turn's token facts as a small tight metadata line (item 21). -->
    <div
      v-if="step.narration !== null && step.turn && step.turn.facts.length"
      class="turnfacts -mb-0.5 flex gap-2.5 pl-2 pr-3 text-[0.7rem] tabular-nums text-dimmed"
    >
      <span v-for="(f, i) in step.turn.facts" :key="i" class="fact">{{ f }}</span>
    </div>

    <div class="narration flex items-baseline gap-3 pb-1.5 pr-3">
      <span
        v-if="step.turn"
        class="think shrink-0 whitespace-nowrap rounded px-2 text-[0.8rem] leading-relaxed"
        :class="step.turn.quick ? 'bg-accented text-muted' : 'bg-warn/10 text-warn'"
        :title="step.turn.label"
        >{{ step.turn.chip }}</span
      >
      <MarkdownText v-if="step.narration !== null" :text="step.narration" />
      <!-- No prose to head the step: the facts ARE the head — one row, no filler. -->
      <span v-else-if="step.turn && step.turn.facts.length" class="turnfacts flex gap-2.5 self-center text-xs tabular-nums text-muted">
        <span v-for="(f, i) in step.turn.facts" :key="i" class="fact">{{ f }}</span>
      </span>
      <span v-else class="nonar flex-1 font-sans text-sm italic text-dimmed">{{ step.note }}</span>
    </div>

    <div class="calls flex flex-col gap-2 pr-3">
      <StepItems v-if="!grouped" :items="step.items" />
      <details v-else class="grp" :open="step.groupOpen" :data-group-open="step.groupOpen ? '1' : '0'">
        <summary
          class="gsummary flex cursor-pointer list-none items-baseline gap-4 rounded-md border border-default bg-elevated px-3 py-2 text-[0.85rem] hover:bg-accented/60 focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden"
          :title="typeof firstCallAt === 'number' ? `calls began ${formatLocalIso(firstCallAt)}` : undefined"
          @click.prevent="emit('toggleGroup')"
        >
          <span
            class="gchev order-9 shrink-0 text-[0.7rem] text-dimmed transition-transform motion-reduce:transition-none"
            :class="step.groupOpen ? 'rotate-90' : ''"
            >❯</span
          >
          <span class="gcount font-semibold text-highlighted">{{ tally.n }} {{ tally.n === 1 ? "call" : "calls" }}</span>
          <span v-if="tally.ok" class="gok text-ok">✓ {{ tally.ok }}</span>
          <span v-if="tally.bad" class="gbad text-bad">✗ {{ tally.bad }}</span>
          <span v-if="tally.infra" class="ginfra text-warn">⚠ {{ tally.infra }}</span>
          <span v-if="tally.running" class="grun text-info">{{ tally.running }} running</span>
          <span v-if="tally.ms > 0" class="gtime ml-auto text-[0.8rem] tabular-nums text-muted">{{ formatElapsed(tally.ms) }}</span>
        </summary>
        <div class="gbody flex flex-col gap-2 pb-1 pt-2">
          <StepItems :items="step.items" />
        </div>
      </details>
    </div>
  </li>
</template>
