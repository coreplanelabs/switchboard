<script setup lang="ts">
import { computed } from "vue";
import AppShell from "../components/AppShell.vue";
import RunsTabs from "../components/runs/RunsTabs.vue";
import { useSeed } from "../lib/seed";
import {
  ACTION_LABEL,
  firingDetailSummary,
  formatRelative,
  formatUtc,
  OUTCOME_CLASS,
  OUTCOME_LABEL,
} from "@core/channels/scheduledPanel.js";

// The Scheduled tab (#244): the registry's schedules with each one's last
// firing — a snapshot per load, no feed. The rows arrive prebuilt from the
// server (buildScheduledRows), including token'd run hrefs for live firings.

const seed = useSeed("scheduled");
const now = computed(() => seed?.now ?? Date.now());
const rows = computed(() => seed?.rows ?? null);

const OUTCOME_TONE: Record<"ok" | "bad" | "warn", string> = {
  ok: "text-ok",
  bad: "text-bad",
  warn: "text-warn",
};
</script>

<template>
  <AppShell title="Scheduled runs" nav="runs">
    <RunsTabs current="scheduled" />
    <p v-if="rows === null" class="px-2 py-1.5 text-muted">No schedule registry configured.</p>
    <section v-else id="scheduled" aria-label="Scheduled jobs">
      <ul class="m-0 list-none p-0">
        <li v-for="r in rows" :key="r.name" class="border-b border-muted px-2 pb-3 pt-2.5" :data-schedule="r.name">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.8rem] text-toned">
            <UTooltip :text="r.description">
              <span class="font-semibold text-highlighted">{{ r.name }}</span>
            </UTooltip>
            <span class="text-accented">·</span>
            <code class="rounded-xs bg-accented px-1.5 py-0.5 text-toned">{{ r.cron }}</code>
            <span class="text-dimmed">UTC</span>
            <span class="text-accented">·</span>
            <span><span class="mr-1 text-[0.62rem] uppercase tracking-wider text-dimmed">on</span> <code class="rounded-xs bg-accented px-1.5 py-0.5 text-toned">{{ r.worker }}</code></span>
            <span class="text-accented">·</span>
            <template v-if="r.action.type === 'run'">
              <code class="rounded-xs bg-accented px-1.5 py-0.5 text-toned">{{ r.action.command }}</code>
              <span class="text-dimmed">as</span>
              <code class="rounded-xs bg-accented px-1.5 py-0.5 text-toned">{{ r.action.identity }}</code>
            </template>
            <span v-else class="text-dimmed">{{ ACTION_LABEL[r.action.type] }} — not a run</span>
            <span class="text-accented">·</span>
            <span class="tabular-nums">
              <span class="mr-1 text-[0.62rem] uppercase tracking-wider text-dimmed">next</span>
              <template v-if="r.nextFireAt !== undefined">
                <b class="font-medium text-highlighted">{{ formatUtc(r.nextFireAt) }}</b>
                <span class="text-dimmed"> ({{ formatRelative(r.nextFireAt, now) }})</span>
              </template>
              <span v-else class="text-dimmed">never</span>
            </span>
          </div>
          <div class="mt-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted">
            <span class="mr-1 text-[0.62rem] uppercase tracking-wider text-dimmed">last</span>
            <template v-if="r.last">
              <span class="outcome" :class="OUTCOME_TONE[OUTCOME_CLASS[r.last.outcome]]">{{ OUTCOME_LABEL[r.last.outcome] }}</span>
              <span class="mx-1.5 text-accented">·</span>
              <span class="text-toned" :title="formatUtc(r.last.firedAt)">{{ formatRelative(r.last.firedAt, now) }}</span>
              <template v-if="r.last.runId">
                <span class="mx-1.5 text-accented">·</span>
                <a v-if="r.last.runHref" class="text-primary hover:underline" :href="r.last.runHref">run {{ r.last.runId.slice(0, 8) }}</a>
                <template v-else>run {{ r.last.runId.slice(0, 8) }}</template>
              </template>
              <template v-if="r.last.detail && firingDetailSummary(r.last.detail)">
                <span class="mx-1.5 text-accented">·</span>
                <span class="detail" :title="r.last.detail">{{ firingDetailSummary(r.last.detail) }}</span>
              </template>
            </template>
            <span v-else class="text-dimmed">{{ seed?.firingsUnavailable ? "unknown" : "never fired" }}</span>
          </div>
        </li>
      </ul>
      <p v-if="seed?.firingsUnavailable" class="mt-2.5 px-2 text-xs text-muted">
        Firing history unavailable: {{ seed.firingsUnavailable }}
      </p>
    </section>
  </AppShell>
</template>
