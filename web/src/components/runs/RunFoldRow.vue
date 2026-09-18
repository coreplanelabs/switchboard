<script setup lang="ts">
import { computed, ref, watch } from "vue";
import StatusDot from "../StatusDot.vue";
import RunTimeline from "../run/RunTimeline.vue";
import { durationTone, heatStyle } from "../../lib/durationTone";
import { formatDateTime, splitRunLabel } from "../../lib/format";
import {
  AGENT_HUE,
  agentHue,
  countText,
  dotTip,
  elapsedText,
  runHref,
  shortId,
  statusDot,
  statusLabel,
  statusWord,
  whenTip,
} from "../../lib/indexRow";
import type { UnitRunRowSeed } from "@core/channels/webSeed.js";

// One run in a listing that is not the index (live-view item 28): a unit's
// run under its round, a conductor's child. The row speaks the index row's
// vocabulary — the dot, the agent chip, the started column, the outcome, the
// one duration, the count — and folds open to the run's own timeline
// (`RunTimeline`), read once on first open. A LIVE run does not fold: its
// record is its token-gated stream, so the row links to its live page (with
// the token the seed carried) and its duration ticks, exactly as on the index.
// The whole row is a `<details>` so the fold is the browser's own control.

const props = defineProps<{
  run: UnitRunRowSeed;
  now: number;
  /** The words before the run — `round 1 · review` on a unit page; nothing under a conductor. */
  label?: string;
  /** Open on first paint (`?open=<id>`, a search hit). */
  open?: boolean;
  /** The session-log turn the fold lands on once open (a search hit's, `?turn=`). */
  land?: number;
}>();

const opened = ref(props.open === true);
watch(
  () => props.open,
  (o) => {
    if (o) opened.value = true;
  },
);

const parts = computed(() => splitRunLabel(props.run.label || shortId(props.run.id)));
const tone = computed(() => statusDot(props.run));
const href = computed(() => runHref(props.run));
const foldable = computed(() => props.run.finished);
const outcome = computed(() =>
  props.run.finished && props.run.status && props.run.status !== "completed" ? statusLabel(props.run.status) : "",
);
const elapsedHeat = computed(() =>
  durationTone(
    props.run.finished && typeof props.run.finishedAt === "number"
      ? props.run.finishedAt - props.run.startedAt
      : undefined,
    "run",
  ),
);
const elapsedPaint = computed(() => heatStyle(elapsedHeat.value));

function onToggle(ev: Event): void {
  opened.value = (ev.target as HTMLDetailsElement).open;
}
</script>

<template>
  <li
    :id="`run-${run.id}`"
    class="fold group border-b border-muted"
    :class="run.finished ? 'finished' : 'live'"
    :data-run-id="run.id"
    :data-round="run.round"
    :data-thread="run.thread"
  >
    <details v-if="foldable" class="group/fold" :open="opened" @toggle="onToggle">
      <summary
        class="row flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 px-2 py-2 hover:bg-(--ui-bg-muted) [&::-webkit-details-marker]:hidden"
      >
        <span
          class="chev select-none text-xs text-dimmed transition-transform group-open/fold:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
          >❯</span
        >
        <StatusDot :tone="tone" :label="statusWord(run)" :tip="dotTip(run)" />
        <span
          v-if="label"
          class="round shrink-0 rounded border border-accented px-1.5 font-mono text-[0.7rem] font-medium tabular-nums text-toned"
          >{{ label }}</span
        >
        <span
          v-if="parts.agent"
          class="agent shrink-0 rounded border px-1.5 font-mono text-[0.68rem] font-medium uppercase tracking-wider opacity-55"
          :class="AGENT_HUE[agentHue(parts.agent)]"
          >{{ parts.agent }}</span
        >
        <span v-if="parts.snippet !== undefined" class="snippet min-w-0 flex-1 truncate text-muted">{{
          parts.snippet
        }}</span>
        <span v-else class="scope min-w-0 flex-1 truncate text-toned">{{ parts.scope }}</span>
        <span
          v-if="outcome"
          class="outcome shrink-0 rounded border px-1.5 font-mono text-[0.7rem]"
          :class="tone === 'red' ? 'border-bad/30 text-bad' : 'border-warn/30 text-warn'"
          >{{ outcome }}</span
        >
        <span class="when shrink-0 font-mono text-xs tabular-nums text-dimmed" :title="whenTip(run)">{{
          formatDateTime(run.startedAt, now)
        }}</span>
        <span
          class="elapsed shrink-0 text-right font-mono text-xs tabular-nums sm:min-w-[4.5em]"
          :class="[elapsedPaint ? 'heat' : 'text-muted', elapsedHeat.level >= 2 ? 'font-medium' : '']"
          :style="elapsedPaint"
          :data-heat="elapsedHeat.level"
          title="start to finish"
          >{{ elapsedText(run, now) }}</span
        >
        <span class="count shrink-0 text-right font-mono text-xs tabular-nums text-dimmed sm:min-w-[6em]">{{
          countText(run)
        }}</span>
        <RouterLink
          class="open shrink-0 font-mono text-xs text-primary no-underline hover:underline"
          :to="href"
          :aria-label="`open run ${run.label || shortId(run.id)}`"
          @click.stop
          >open ↗</RouterLink
        >
      </summary>
      <RunTimeline v-if="opened" :run="run" :land="land" />
    </details>
    <!-- In progress: the row is drawn where the run will end up, its clock moving; it opens the live page. -->
    <div v-else class="row flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-2 py-2 hover:bg-(--ui-bg-muted)">
      <span class="chev select-none text-xs text-transparent" aria-hidden="true">❯</span>
      <StatusDot :tone="tone" :label="statusWord(run)" :tip="dotTip(run)" pulse />
      <span
        v-if="label"
        class="round shrink-0 rounded border border-accented px-1.5 font-mono text-[0.7rem] font-medium tabular-nums text-toned"
        >{{ label }}</span
      >
      <span
        v-if="parts.agent"
        class="agent shrink-0 rounded border px-1.5 font-mono text-[0.68rem] font-medium uppercase tracking-wider"
        :class="AGENT_HUE[agentHue(parts.agent)]"
        >{{ parts.agent }}</span
      >
      <span v-if="parts.snippet !== undefined" class="snippet min-w-0 flex-1 truncate text-muted">{{
        parts.snippet
      }}</span>
      <span v-else class="scope min-w-0 flex-1 truncate text-highlighted">{{ parts.scope }}</span>
      <span class="when shrink-0 font-mono text-xs tabular-nums text-muted" :title="whenTip(run)">{{
        formatDateTime(run.startedAt, now)
      }}</span>
      <span
        class="elapsed shrink-0 text-right font-mono text-xs tabular-nums text-ok sm:min-w-[4.5em]"
        title="running for"
        >{{ elapsedText(run, now) }}</span
      >
      <span class="count shrink-0 text-right font-mono text-xs tabular-nums text-dimmed sm:min-w-[6em]">{{
        countText(run)
      }}</span>
      <RouterLink
        class="open shrink-0 font-mono text-xs text-primary no-underline hover:underline"
        :to="href"
        :aria-label="`open run ${run.label || shortId(run.id)}`"
        >open ↗</RouterLink
      >
    </div>
  </li>
</template>
