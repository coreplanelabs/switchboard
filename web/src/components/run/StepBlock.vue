<script setup lang="ts">
import { computed } from "vue";
import StepItems from "./StepItems.vue";
import MarkdownText from "../MarkdownText.vue";
import { durationTone, heatStyle } from "../../lib/durationTone";
import { formatClock, formatDuration, formatLocalIso } from "../../lib/format";
import { callSummary, modelName, type StepVm } from "../../lib/runPageModel";

// ONE STEP = ONE BLOCK, read top to bottom (item 18): a rail marks where it
// starts and ends. Its head is ONE meta row — `thought <span> · <token facts>`
// on the left, the viewer's clock on the right — so every step's prose starts
// flush left at the same rhythm. Under the prose, the calls it explains; from
// the 2nd non-quiet call the cards fold into ONE group whose summary reads
// the tally as a sentence (the fold rules live in runPageModel).
//
// The timeline speaks TWO text sizes: `text-xs` for metadata (this head row,
// card facts, quiet rows, the group summary) and the body size for everything
// a person reads. Every secondary fact is `text-dimmed`.
//
// Both durations on this block, the turn's thinking time and the group's
// tallied tool time, are painted by the duration heat scale (item 24), so a
// step that ate the run reads warm before anyone opens it.
//
// The block carries the id of its turn's span (`span-<id>`) so the timeline's
// Longest steps can scroll to it.

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
const summary = computed(() => callSummary(tally.value));
const timedOut = computed(() => cards.value.some((i) => i.kind === "call" && i.call.timedOut));
const tallyHeat = computed(() => durationTone(tally.value.ms, "tool", timedOut.value));
const tallyPaint = computed(() => heatStyle(tallyHeat.value));
const turnHeat = computed(() => (props.step.turn ? durationTone(props.step.turn.durationMs, "turn") : undefined));
const turnPaint = computed(() => (turnHeat.value ? heatStyle(turnHeat.value) : undefined));

const firstCallAt = computed(() => {
  const first = cards.value[0];
  return first?.kind === "call" ? first.call.startedAt : undefined;
});
</script>

<template>
  <li
    :id="step.turn ? `span-${step.turn.spanId}` : undefined"
    class="step relative border-l-2 pb-3 pl-3 pt-2"
    :class="step.live ? 'border-ok/40' : 'border-(--ui-border-accented)/50'"
    :data-live="step.live ? '1' : undefined"
  >
    <!-- The head: ONE row — the turn's cost (or, with no turn, the prose
         itself) on the left, WHEN on the right; a wide gap keeps long text
         clear of the clock. -->
    <div class="head flex items-baseline gap-x-6 pb-1.5 pr-(--sb-gutter)">
      <div class="min-w-0 flex-1">
        <div
          v-if="step.turn"
          class="meta flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 font-mono text-xs tabular-nums text-dimmed"
        >
          <span
            class="thought"
            :class="[turnPaint ? 'heat' : '', turnHeat && turnHeat.level >= 2 ? 'font-medium' : '']"
            :style="turnPaint"
            :data-heat="turnHeat?.level"
            :title="step.turn.label"
            >thought {{ step.turn.chip }}</span
          >
          <!-- The model is named where a reader learns something: the run's
               first head, and every head where it CHANGED — a loud ⇄ chip. A
               run on one model says it once. -->
          <span
            v-if="step.turn.switched"
            class="model-switch order-first rounded border border-warn/40 bg-warn/10 px-1.5 font-medium text-warn"
            :title="`model changed: this turn ran on ${step.turn.model}`"
            >⇄ {{ modelName(step.turn.model) }}</span
          >
          <span
            v-else-if="step.turn.showModel"
            class="model-badge order-first rounded bg-accented px-1.5 text-[0.68rem] font-medium leading-normal tracking-wider text-muted"
            :title="step.turn.model"
            >{{ modelName(step.turn.model) }}</span
          >
          <span v-for="(f, i) in step.turn.facts" :key="i" class="fact">{{ f }}</span>
        </div>
        <MarkdownText v-else-if="step.narration !== null" :text="step.narration" />
        <!-- Neither a turn nor prose to head the row: the filler says why. -->
        <span v-else class="nonar font-sans text-sm italic text-dimmed">{{ step.note }}</span>
      </div>
      <span
        v-if="step.at !== undefined"
        class="ts shrink-0 select-none font-mono text-xs tabular-nums text-dimmed"
        :title="formatLocalIso(step.at)"
        >{{ formatClock(step.at) }}</span
      >
    </div>
    <!-- Prose that follows a cost head sits flush left under it. -->
    <div
      v-if="step.turn && step.narration !== null"
      class="narration flex items-baseline gap-3 pb-1.5 pr-(--sb-gutter)"
    >
      <MarkdownText :text="step.narration" />
    </div>
    <div
      v-else-if="step.turn && step.narration === null && !step.turn.facts.length"
      class="narration flex items-baseline gap-3 pb-1.5 pr-(--sb-gutter)"
    >
      <span class="nonar flex-1 font-sans text-sm italic text-dimmed">{{ step.note }}</span>
    </div>

    <!-- The cards run to the container's edge; their facts end on the page's
         one gutter (the card pads for its own border). -->
    <div class="calls flex flex-col gap-2">
      <StepItems v-if="!grouped" :items="step.items" />
      <details v-else class="grp" :open="step.groupOpen" :data-group-open="step.groupOpen ? '1' : '0'">
        <!-- The group's summary is a muted line, not a header: the cards are
             the work, this is their count as a reader says it. -->
        <summary
          class="gsummary flex cursor-pointer list-none items-baseline gap-3 rounded-md pl-3 pr-(--sb-gutter) py-1 font-mono text-xs text-dimmed hover:bg-accented/40 hover:text-muted focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden"
          :title="typeof firstCallAt === 'number' ? `calls began ${formatLocalIso(firstCallAt)}` : undefined"
          @click.prevent="emit('toggleGroup')"
        >
          <span
            class="gchev shrink-0 select-none transition-transform motion-reduce:transition-none"
            :class="step.groupOpen ? 'rotate-90' : ''"
            >❯</span
          >
          <span
            class="gcount"
            :class="tally.bad || tally.infra ? 'text-bad' : ''"
            :data-ok="tally.ok"
            :data-bad="tally.bad"
            :data-infra="tally.infra"
            :data-running="tally.running"
            >{{ summary }}</span
          >
          <span
            v-if="tally.ms > 0"
            class="gtime ml-auto tabular-nums"
            :class="[
              tallyPaint ? 'heat' : '',
              tallyHeat.over ? 'font-medium text-bad' : tallyHeat.level >= 2 ? 'font-medium' : '',
            ]"
            :style="tallyPaint"
            :data-heat="tallyHeat.level"
            ><template v-if="tallyHeat.over">timed out · </template>{{ formatDuration(tally.ms, "clock") }}</span
          >
        </summary>
        <div class="gbody flex flex-col gap-2 pb-1 pt-1.5">
          <StepItems :items="step.items" />
        </div>
      </details>
    </div>
  </li>
</template>
