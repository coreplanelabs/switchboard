<script setup lang="ts">
import { computed, ref } from "vue";
import StatusDot from "../StatusDot.vue";
import SourceMark from "./SourceMark.vue";
import { browser } from "../../lib/browser";
import { durationTone, heatStyle } from "../../lib/durationTone";
import { formatDateTime, formatLocalIso, formatRelative, splitRunLabel } from "../../lib/format";
import {
  AGENT_HUE,
  agentHue,
  dotTip,
  SURFACE_NAME,
  threadHref,
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
  whoText,
  type IndexRow,
  countTip,
  countText,
  paceTip,
  rowBound,
  rowPace,
  rowStalled,
  inheritedPace,
  inheritedPaceTip,
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
  /** The head row this one nests under (live-view item 33): a pipeline's run
   *  indents below its parent's row instead of interleaving with the rest. */
  nestedUnder?: string;
  /** End the branch rail at the final child's status dot. */
  lastNested?: boolean;
  /** The rows nested under this head (live-view item 32): a hosted head's pace
   *  cell borrows its newest live child's pace from them. */
  children?: IndexRow[];
}>();

const parts = computed(() => {
  const label = splitRunLabel(props.run.label || shortId(props.run.id));
  return {
    ...label,
    agent: label.agent ?? props.run.agent,
    snippet: label.snippet ?? props.run.activity,
  };
});
const repo = computed(() => repoOf(props.run, parts.value.scope));
const tone = computed(() => statusDot(props.run));
const href = computed(() => runHref(props.run));
const src = computed(() => surfaceOf(props.run));
const who = computed(() => whoText(props.run));
const sourceUrl = computed(() => safeSourceUrl(props.run));
/** The run's thread as a page here (web-chat.md item 4), beside the source's own link. */
const threadLink = computed(() => (props.run.threadKey ? threadHref(props.run.threadKey) : null));
const expires = computed(() => expiresAt(props.run, props.retentionMs));
const leaving = computed(() => expires.value !== undefined && expires.value - props.now <= LEAVING_WINDOW_MS);
const stopRequested = ref(false);
const stoppable = computed(() => !props.run.finished && !props.run.stop && !stopRequested.value);
const killable = computed(() => !props.run.finished);
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
// Keep warnings on the row. Event rate is available on the details page.
const bound = computed(() => rowBound(props.run, props.now));
// A hosted head borrows its newest live child's warning. Between children it
// reads `waiting on the runner`. Healthy event rates stay off the row.
// The `children` prop arrives only on the head rendering; a nested hosted row
// (children absent) shows no signal rather than a false `waiting`.
const inherited = computed(() =>
  props.run.hosted && props.children !== undefined
    ? inheritedPace({ head: props.run, children: props.children }, props.now)
    : undefined,
);
const pace = computed(() => {
  if (bound.value) return bound.value;
  const child = inherited.value?.child;
  if (inherited.value && (!child || rowBound(child, props.now) || rowStalled(child, props.now))) {
    return inherited.value.text;
  }
  return rowStalled(props.run, props.now) ? rowPace(props.run, props.now) : undefined;
});
const stalled = computed(() => rowStalled(props.run, props.now));

const pending = ref(false);
const stopError = ref("");

/** The row's actions menu, the one control at every width (a pair of Stop and
 *  Kill buttons per row cost 7.6em of every line for two rarely used actions):
 *  the thread link and Stop/Kill, each disabled while its POST is in flight. */
const actionItems = computed(() => [
  ...(threadLink.value ? [{ label: "Open thread", icon: "i-lucide-messages-square", to: threadLink.value }] : []),
  ...(sourceUrl.value
    ? [
        {
          label: `Open in ${SURFACE_NAME[src.value.kind] ?? src.value.kind}`,
          icon: "i-lucide-external-link",
          to: sourceUrl.value,
          target: "_blank",
        },
      ]
    : []),
  ...(stoppable.value
    ? [
        {
          label: "Stop",
          icon: "i-lucide-octagon-pause",
          disabled: pending.value,
          onSelect: () => requestStop("stop"),
        },
      ]
    : []),
  ...(killable.value
    ? [
        {
          label: "Kill",
          icon: "i-lucide-octagon-x",
          color: "error" as const,
          disabled: pending.value,
          onSelect: () => requestStop("kill"),
        },
      ]
    : []),
]);

function requestStop(mode: "stop" | "kill"): void {
  if (pending.value) return;
  if (mode === "kill" && !browser.confirm("Kill this run and delete its row? This action is destructive.")) return;
  pending.value = true;
  stopError.value = "";
  fetch(stopHref(props.run, mode), { method: "POST", credentials: "same-origin" })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      stopRequested.value = true;
    })
    .catch(() => {
      stopError.value = `Could not confirm ${mode === "kill" ? "Kill" : "Stop"}. This run is still listed.`;
    })
    .finally(() => {
      pending.value = false;
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
    class="run group relative isolate border-b hover:bg-(--ui-bg-muted) focus-within:bg-(--ui-bg-muted)"
    :class="[
      run.finished ? 'finished' : 'live',
      leaving ? 'leaving' : '',
      nestedUnder
        ? ['nested bg-muted/20', lastNested ? 'rounded-b-md border-muted' : 'border-transparent']
        : [children?.length ? 'rounded-t-md border-transparent' : 'rounded-md border-muted'],
    ]"
    :data-run-id="run.id"
    :data-parent-id="nestedUnder"
    :data-started-at="String(run.startedAt)"
    :data-persisted="run.persisted ? '1' : undefined"
    :data-stalled="stalled ? '1' : undefined"
    :data-expires-at="expires !== undefined ? String(expires) : undefined"
    @click="onRowClick"
  >
    <span
      v-if="children?.length"
      class="parent-rail pointer-events-none absolute bottom-0 left-[17px] top-7 w-px bg-accented"
      aria-hidden="true"
    />
    <template v-if="nestedUnder">
      <span
        v-if="!lastNested"
        class="child-rail pointer-events-none absolute bottom-0 left-[17px] top-0 w-px bg-accented"
        aria-hidden="true"
      />
      <span
        class="child-branch pointer-events-none absolute left-[17px] top-0 h-6 w-4 rounded-bl-lg border-b border-l border-accented"
        aria-hidden="true"
      />
    </template>
    <RouterLink
      class="row absolute inset-0 rounded-md focus-visible:outline-2 focus-visible:outline-primary"
      :to="href"
      :aria-label="`open run ${run.label || shortId(run.id)}`"
    ></RouterLink>
    <div
      class="body pointer-events-none relative z-[1] grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-start gap-x-3 px-3 py-3 sm:gap-x-4"
      :class="[run.finished ? 'text-muted' : '', leaving ? 'opacity-85' : '', nestedUnder ? 'pl-10' : '']"
    >
      <span class="pointer-events-auto mt-1.5 flex items-center">
        <StatusDot :tone="tone" :label="statusWord(run)" :tip="dotTip(run)" :pulse="!run.finished" />
      </span>
      <div class="min-w-0">
        <div class="primary flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            class="snippet min-w-0 text-sm leading-6 text-highlighted [overflow-wrap:anywhere] max-sm:line-clamp-2 sm:truncate"
            >{{ parts.snippet ?? (repo ? repo.slice(repo.indexOf("/") + 1) : parts.scope) }}</span
          >
          <span
            v-if="outcome"
            class="outcome shrink-0 rounded border px-1.5 text-[0.7rem]"
            :class="
              tone === 'red'
                ? 'border-bad/30 text-bad'
                : tone === 'amber'
                  ? 'border-warn/30 text-warn'
                  : 'border-accented text-muted'
            "
            >{{ outcome }}</span
          >
          <span
            v-if="stopBadge"
            class="stopbadge shrink-0 rounded border px-1.5 text-[0.7rem]"
            :class="run.stop?.state === 'stopped' ? 'border-accented text-muted' : 'border-info/30 text-info'"
            >{{ stopBadge }}</span
          >
          <span
            v-if="stalled"
            class="stalled shrink-0 rounded border px-1.5 text-[0.7rem]"
            :class="bound ? 'border-bad/30 text-bad' : 'border-warn/30 text-warn'"
            >stalled</span
          >
        </div>
        <div class="metadata mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5 text-dimmed">
          <span
            v-if="parts.agent"
            class="agent shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.65rem] font-medium leading-none uppercase tracking-wide"
            :class="AGENT_HUE[agentHue(parts.agent)]"
            :data-agent-hue="agentHue(parts.agent)"
            >{{ parts.agent }}</span
          >
          <span class="inline-flex min-w-0 max-w-full items-center gap-1.5">
            <SourceMark :kind="src.kind" :tip="sourceTip(run)" :url="sourceUrl || undefined" />
            <UTooltip v-if="who" :text="who">
              <span class="who pointer-events-auto min-w-0 truncate" :data-user-id="run.userId" :data-surface="src.kind"
                ><span class="name">{{ who }}</span></span
              >
            </UTooltip>
          </span>
          <UTooltip v-if="repo" :text="repo">
            <a
              class="repo pointer-events-auto inline-flex min-w-0 max-w-full items-center gap-1 text-dimmed no-underline hover:text-highlighted"
              :href="`https://github.com/${repo}`"
              target="_blank"
              rel="noopener noreferrer"
            >
              <UIcon name="i-lucide-git-branch" class="size-3 shrink-0" />
              <span class="truncate"
                ><span class="owner text-dimmed">{{ repo.slice(0, repo.indexOf("/") + 1) }}</span
                ><span class="name">{{ repo.slice(repo.indexOf("/") + 1) }}</span></span
              >
            </a>
          </UTooltip>
          <span v-else class="scope min-w-0 truncate">{{ parts.scope }}</span>
          <UTooltip :text="whenTip(run)" :ui="{ text: 'whitespace-pre-line' }">
            <span class="when pointer-events-auto shrink-0 tabular-nums">{{ formatRelative(run.startedAt, now) }}</span>
          </UTooltip>
          <UTooltip :text="countTip(run)"
            ><span class="count shrink-0 tabular-nums">{{ countText(run) }}</span></UTooltip
          >
          <UTooltip v-if="pace" :text="inherited && !bound ? inheritedPaceTip(inherited) : paceTip(run, now)">
            <span
              class="pace pointer-events-auto min-w-0 [overflow-wrap:anywhere]"
              :class="bound ? 'text-bad font-medium' : 'text-warn'"
              :data-inherited="inherited && !bound ? (inherited.child ? 'child' : 'waiting') : undefined"
              >{{ pace }}</span
            >
          </UTooltip>
          <UTooltip v-if="leaving && expires !== undefined" :text="`removed at ${formatLocalIso(expires)}`">
            <span class="expires pointer-events-auto shrink-0 tabular-nums text-warn"
              >gone {{ formatDateTime(expires, now) }}</span
            >
          </UTooltip>
        </div>
      </div>
      <UTooltip :text="run.finished ? 'start to finish' : 'running for'">
        <span
          class="elapsed pointer-events-auto mt-0.5 shrink-0 text-right font-mono text-xs leading-5 tabular-nums sm:min-w-[5.5em]"
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
      <span class="actions flex w-5 shrink-0 justify-end sm:w-[2em]">
        <UDropdownMenu v-if="actionItems.length > 0" :items="actionItems" :content="{ align: 'end' }">
          <UButton
            class="pointer-events-auto -my-1 -mr-1"
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-ellipsis-vertical"
            aria-label="Run actions"
          />
        </UDropdownMenu>
      </span>
    </div>
    <p v-if="stopError && !run.finished" class="relative z-[1] px-2 pb-2 text-xs text-warn" role="alert">
      {{ stopError }}
    </p>
  </li>
</template>
