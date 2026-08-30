<script setup lang="ts">
import { computed, reactive } from "vue";
import StatusDot from "../StatusDot.vue";
import SourceMark from "./SourceMark.vue";
import { browser } from "../../lib/browser";
import { formatDateTime, formatLocalIso, formatRelative, splitRunLabel } from "../../lib/format";
import {
  agentHue,
  dotTip,
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
const outcome = computed(() => (props.run.finished && props.run.status && props.run.status !== "completed" ? statusLabel(props.run.status) : ""));
// The stop badge while a stop is in flight — and for a finished row with no
// record status yet (a registry summary), where it is the outcome.
const stopBadge = computed(() => (props.run.stop && !(props.run.finished && props.run.status) ? stopLabel(props.run.stop) : ""));

const AGENT_HUE: Record<ReturnType<typeof agentHue>, string> = {
  coding: "text-ok bg-ok/8 border-ok/25",
  review: "text-review bg-review/8 border-review/25",
  research: "text-research bg-research/8 border-research/25",
  general: "text-info bg-info/8 border-info/25",
  other: "text-toned bg-accented/60 border-accented",
};

const disabled = reactive({ soft: false, hard: false });

function requestStop(mode: "soft" | "hard"): void {
  if (mode === "hard" && !browser.confirm("Hard stop: abort this run now with no summary and free its sandbox?")) return;
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
    <div
      class="body pointer-events-none relative z-[1] flex min-w-0 items-center gap-2.5 px-2 py-2"
      :class="[run.finished ? 'text-muted' : '', leaving ? 'opacity-85' : '']"
    >
      <span class="pointer-events-auto flex items-center">
        <StatusDot :tone="tone" :label="statusWord(run)" :tip="dotTip(run)" :pulse="!run.finished" />
      </span>
      <UTooltip :text="whenTip(run)" :ui="{ text: 'whitespace-pre-line' }">
        <span class="when pointer-events-auto min-w-[8.5em] shrink-0 text-[0.8rem] tabular-nums" :class="run.finished ? 'text-dimmed' : 'text-muted'">
          {{ formatRelative(run.startedAt, now) }}
        </span>
      </UTooltip>
      <span
        v-if="parts.agent"
        class="agent shrink-0 rounded border px-1.5 text-[0.68rem] font-semibold uppercase tracking-wider"
        :class="[AGENT_HUE[agentHue(parts.agent)], run.finished ? 'opacity-55' : '']"
        :data-agent-hue="agentHue(parts.agent)"
        >{{ parts.agent }}</span
      >
      <UTooltip v-if="repo" :text="repo">
        <a
          class="repo pointer-events-auto shrink-0 rounded border border-accented bg-accented/50 px-1.5 text-[0.72rem] font-semibold leading-normal text-toned no-underline hover:border-(--ui-text-dimmed) hover:text-highlighted"
          :href="`https://github.com/${repo}`"
          target="_blank"
          rel="noopener noreferrer"
          >{{ repo.slice(repo.indexOf("/") + 1) }}</a
        >
      </UTooltip>
      <span v-else class="scope shrink-0 font-semibold" :class="run.finished ? 'text-toned' : 'text-highlighted'">{{ parts.scope }}</span>
      <span v-if="parts.snippet !== undefined" class="snippet min-w-0 flex-1 truncate text-muted">{{ parts.snippet }}</span>
      <span v-if="outcome" class="outcome shrink-0 rounded border px-1.5 text-[0.7rem]" :class="tone === 'red' ? 'border-bad/30 text-bad' : 'border-warn/30 text-warn'">{{ outcome }}</span>
      <span
        v-if="stopBadge"
        class="stopbadge shrink-0 rounded border px-1.5 text-[0.7rem]"
        :class="run.stop?.state === 'stopped' ? 'border-accented text-muted' : 'border-warn/30 text-warn'"
        >{{ stopBadge }}</span
      >
      <SourceMark :kind="src.kind" :tip="sourceTip(run)" :url="sourceUrl || undefined" />
      <UTooltip v-if="leaving && expires !== undefined" :text="`removed at ${formatLocalIso(expires)}`">
        <span class="expires pointer-events-auto shrink-0 text-xs tabular-nums text-warn">gone {{ formatDateTime(expires, now) }}</span>
      </UTooltip>
      <span class="facts ml-auto flex shrink-0 gap-4 text-xs tabular-nums text-muted">
        <UTooltip :text="run.finished ? 'start to finish' : 'running for'">
          <span class="elapsed pointer-events-auto min-w-[4.5em] text-right" :class="run.finished ? 'text-muted' : 'text-ok'">{{
            elapsedText(run, now)
          }}</span>
        </UTooltip>
        <span class="count min-w-[6em] text-right">{{ run.eventCount }} event{{ run.eventCount === 1 ? "" : "s" }}</span>
      </span>
      <span class="actions flex min-w-[7.6em] shrink-0 justify-end gap-1.5 whitespace-nowrap">
        <template v-if="stoppable">
          <UTooltip text="Soft stop: no new steps, the agent writes up what it has">
            <UButton class="pointer-events-auto" size="xs" color="neutral" variant="outline" label="Stop" :disabled="disabled.soft" @click="requestStop('soft')" />
          </UTooltip>
          <UTooltip text="Hard stop: abort now, no summary, free the sandbox">
            <UButton class="pointer-events-auto" size="xs" color="error" variant="outline" label="Kill" :disabled="disabled.hard" @click="requestStop('hard')" />
          </UTooltip>
        </template>
      </span>
    </div>
  </li>
</template>
