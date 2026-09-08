<script setup lang="ts">
import { computed, reactive } from "vue";
import StatusDot from "../StatusDot.vue";
import SourceMark from "./SourceMark.vue";
import { browser } from "../../lib/browser";
import { durationTone, heatStyle } from "../../lib/durationTone";
import { formatDateTime, formatLocalIso, formatRelative, splitRunLabel } from "../../lib/format";
import {
  agentHue,
  dotTip,
  SURFACE_NAME,
  elapsedText,
  expiresAt,
  LEAVING_WINDOW_MS,
  repoOf,
  runHref,
  safeSourceUrl,
  shortId,
  sourceTip,
  statusDot,
  statusLabel,
  statusWord,
  stopHref,
  stopLabel,
  surfaceOf,
  whenTip,
  type IndexRow,
  countTip,
  countText,
} from "../../lib/indexRow";

// One runs-index row — the ONE renderer for seed rows and live feed repaints
// (the component replaces the old isomorphic `indexRowRenderer`). The row is a
// stretched link: the anchor covers the <li>, the body lets clicks fall
// through except on its own links, buttons and tooltip cells (a click on a
// tooltip cell goes where the row goes, via the li handler).

const props = defineProps<{
  run: IndexRow;
  now: number;
  retentionMs?: number;
}>();

const parts = computed(() => splitRunLabel(props.run.label || shortId(props.run.id)));
const repo = computed(() => repoOf(props.run, parts.value.scope));
const tone = computed(() => statusDot(props.run));
const href = computed(() => runHref(props.run));
const src = computed(() => surfaceOf(props.run));
const sourceUrl = computed(() => safeSourceUrl(props.run));
const expires = computed(() => expiresAt(props.run, props.retentionMs));
const leaving = computed(() => expires.value !== undefined && expires.value - props.now <= LEAVING_WINDOW_MS);
const stoppable = computed(() => !props.run.finished && !props.run.stop);
// A finished row's stopwatch is painted by the duration heat scale (item 24) on
// the run scale, so a 40-minute run stands out of a page of 3-minute ones; a
// live row stays green — its clock is still moving.
const elapsedHeat = computed(() =>
  durationTone(
    props.run.finished && typeof props.run.finishedAt === "number"
      ? props.run.finishedAt - props.run.startedAt
      : undefined,
    "run",
  ),
);
const elapsedPaint = computed(() => heatStyle(elapsedHeat.value));
const outcome = computed(() =>
  props.run.finished && props.run.status && props.run.status !== "completed" ? statusLabel(props.run.status) : "",
);
// The stop badge while a stop is in flight — and for a finished row with no
// record status yet (a registry summary), where it is the outcome.
const stopBadge = computed(() =>
  props.run.stop && !(props.run.finished && props.run.status) ? stopLabel(props.run.stop) : "",
);

const AGENT_HUE: Record<ReturnType<typeof agentHue>, string> = {
  coding: "text-ok bg-ok/8 border-ok/25",
  review: "text-review bg-review/8 border-review/25",
  research: "text-research bg-research/8 border-research/25",
  general: "text-info bg-info/8 border-info/25",
  other: "text-toned bg-accented/60 border-accented",
};

const disabled = reactive({ soft: false, hard: false });

/** The phone's run-actions menu: everything the desktop grid offers through
 *  hover states, as finger-sized menu items — the thread link (the desktop
 *  source mark is hover-revealed) and Stop/Kill. */
const stopMenuItems = computed(() => [
  ...(sourceUrl.value
    ? [
        {
          label: `Open ${SURFACE_NAME[src.value.kind] ?? src.value.kind} thread`,
          icon: "i-lucide-external-link",
          to: sourceUrl.value,
          target: "_blank",
        },
      ]
    : []),
  ...(stoppable.value
    ? [
        { label: "Stop (soft)", icon: "i-lucide-octagon-pause", onSelect: () => requestStop("soft") },
        {
          label: "Kill (hard)",
          icon: "i-lucide-octagon-x",
          color: "error" as const,
          onSelect: () => requestStop("hard"),
        },
      ]
    : []),
]);

function requestStop(mode: "soft" | "hard"): void {
  if (mode === "hard" && !browser.confirm("Hard stop: abort this run now with no summary and free its sandbox?"))
    return;
  disabled[mode] = true;
  fetch(stopHref(props.run, mode), { method: "POST", credentials: "same-origin" })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    })
    .catch(() => {
      disabled[mode] = false;
    });
}

// A click that landed on a tooltip cell (pointer-events re-enabled for its
// hover) would otherwise go nowhere: send it where the row goes.
function onRowClick(ev: MouseEvent): void {
  const target = ev.target as Element | null;
  if (target?.closest("a, button")) return;
  browser.navigate(href.value);
}
</script>

<template>
  <li
    class="run group relative rounded-md border-b border-muted hover:bg-(--ui-bg-muted) focus-within:bg-(--ui-bg-muted)"
    :class="[run.finished ? 'finished' : 'live', leaving ? 'leaving' : '']"
    :data-run-id="run.id"
    :data-started-at="String(run.startedAt)"
    :data-persisted="run.persisted ? '1' : undefined"
    :data-expires-at="expires !== undefined ? String(expires) : undefined"
    @click="onRowClick"
  >
    <a
      class="row absolute inset-0 rounded-md focus-visible:outline-2 focus-visible:outline-primary"
      :href="href"
      :aria-label="`open run ${run.label || shortId(run.id)}`"
    ></a>
    <!-- ONE responsive body (no per-breakpoint DOM): from sm it is the
         one-line grid — dot · started · chip · scope · snippet · badges ·
         source · facts · actions. Below sm the SAME cells wrap into a card via
         max-sm order/basis overrides: line 1 = dot · chip · scope · stopwatch
         · a finger-sized ⋯ menu; line 2 = the snippet (clamped); line 3 =
         started · events · badges. Only the leaf control swaps (hover-sized
         buttons ↔ the touch menu, which also carries the hover-only thread
         link). -->
    <div
      class="body pointer-events-none relative z-[1] flex min-w-0 flex-wrap items-center gap-x-2.5 px-2 max-sm:gap-y-1.5 max-sm:py-3 sm:flex-nowrap sm:py-2"
      :class="[run.finished ? 'text-muted' : '', leaving ? 'opacity-85' : '']"
    >
      <span class="pointer-events-auto flex items-center max-sm:order-1">
        <StatusDot :tone="tone" :label="statusWord(run)" :tip="dotTip(run)" :pulse="!run.finished" />
      </span>
      <UTooltip :text="whenTip(run)" :ui="{ text: 'whitespace-pre-line' }">
        <span
          class="when pointer-events-auto shrink-0 tabular-nums max-sm:order-7 max-sm:pl-5 max-sm:text-xs max-sm:text-dimmed sm:min-w-[8.5em] sm:text-[0.8rem]"
          :class="run.finished ? 'text-dimmed' : 'text-muted'"
        >
          {{ formatRelative(run.startedAt, now) }}
        </span>
      </UTooltip>
      <span
        v-if="parts.agent"
        class="agent shrink-0 rounded border px-1.5 text-[0.68rem] font-semibold uppercase tracking-wider max-sm:order-2"
        :class="[AGENT_HUE[agentHue(parts.agent)], run.finished ? 'opacity-55' : '']"
        :data-agent-hue="agentHue(parts.agent)"
        >{{ parts.agent }}</span
      >
      <UTooltip v-if="repo" :text="repo">
        <a
          class="repo pointer-events-auto min-w-0 shrink-0 rounded border border-accented bg-accented/50 px-1.5 text-[0.72rem] font-semibold leading-normal text-toned no-underline hover:border-(--ui-text-dimmed) hover:text-highlighted max-sm:order-3"
          :href="`https://github.com/${repo}`"
          target="_blank"
          rel="noopener noreferrer"
          >{{ repo.slice(repo.indexOf("/") + 1) }}</a
        >
      </UTooltip>
      <span
        v-else
        class="scope min-w-0 shrink-0 truncate font-semibold max-sm:order-3"
        :class="run.finished ? 'text-toned' : 'text-highlighted'"
        >{{ parts.scope }}</span
      >
      <span
        v-if="parts.snippet !== undefined"
        class="snippet min-w-0 truncate text-muted max-sm:order-6 max-sm:basis-full max-sm:whitespace-normal max-sm:pl-5 max-sm:text-[0.8rem] max-sm:leading-snug max-sm:line-clamp-2 sm:flex-1"
        >{{ parts.snippet }}</span
      >
      <span
        v-if="outcome"
        class="outcome shrink-0 rounded border px-1.5 text-[0.7rem] max-sm:order-10"
        :class="tone === 'red' ? 'border-bad/30 text-bad' : 'border-warn/30 text-warn'"
        >{{ outcome }}</span
      >
      <span
        v-if="stopBadge"
        class="stopbadge shrink-0 rounded border px-1.5 text-[0.7rem] max-sm:order-10"
        :class="run.stop?.state === 'stopped' ? 'border-accented text-muted' : 'border-warn/30 text-warn'"
        >{{ stopBadge }}</span
      >
      <!-- The source mark is a hover affordance — pointer devices only; the touch menu carries the same link. -->
      <span class="hidden sm:contents">
        <SourceMark :kind="src.kind" :tip="sourceTip(run)" :url="sourceUrl || undefined" />
      </span>
      <UTooltip v-if="leaving && expires !== undefined" :text="`removed at ${formatLocalIso(expires)}`">
        <span class="expires pointer-events-auto shrink-0 text-xs tabular-nums text-warn max-sm:order-11"
          >gone {{ formatDateTime(expires, now) }}</span
        >
      </UTooltip>
      <UTooltip :text="run.finished ? 'start to finish' : 'running for'">
        <span
          class="elapsed pointer-events-auto ml-auto shrink-0 text-right text-xs tabular-nums max-sm:order-4 sm:min-w-[4.5em]"
          :class="
            run.finished
              ? [elapsedPaint ? 'heat' : 'text-muted', elapsedHeat.level >= 2 ? 'font-medium' : '']
              : 'text-ok'
          "
          :style="run.finished ? elapsedPaint : undefined"
          :data-heat="run.finished ? elapsedHeat.level : undefined"
          >{{ elapsedText(run, now) }}</span
        >
      </UTooltip>
      <span class="hidden text-xs text-dimmed max-sm:order-8 max-sm:inline" aria-hidden="true">·</span>
      <UTooltip :text="countTip(run)">
        <span
          class="count shrink-0 text-right text-xs tabular-nums max-sm:order-9 max-sm:text-dimmed sm:min-w-[6em] sm:text-muted"
        >
          {{ countText(run) }}
        </span>
      </UTooltip>
      <span class="actions hidden min-w-[7.6em] shrink-0 justify-end gap-1.5 whitespace-nowrap sm:flex">
        <template v-if="stoppable">
          <UTooltip text="Soft stop: no new steps, the agent writes up what it has">
            <UButton
              class="pointer-events-auto"
              size="xs"
              color="neutral"
              variant="outline"
              label="Stop"
              :disabled="disabled.soft"
              @click="requestStop('soft')"
            />
          </UTooltip>
          <UTooltip text="Hard stop: abort now, no summary, free the sandbox">
            <UButton
              class="pointer-events-auto"
              size="xs"
              color="error"
              variant="outline"
              label="Kill"
              :disabled="disabled.hard"
              @click="requestStop('hard')"
            />
          </UTooltip>
        </template>
      </span>
      <UDropdownMenu v-if="stopMenuItems.length > 0" :items="stopMenuItems" :content="{ align: 'end' }">
        <UButton
          class="pointer-events-auto -my-1.5 -mr-1 max-sm:order-5 sm:hidden"
          size="md"
          color="neutral"
          variant="ghost"
          icon="i-lucide-ellipsis-vertical"
          aria-label="Run actions"
        />
      </UDropdownMenu>
    </div>
  </li>
</template>
