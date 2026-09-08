<script setup lang="ts">
import { computed } from "vue";
import AppShell from "../components/AppShell.vue";
import { wallNow } from "../lib/wallClock";
import RunsTabs from "../components/runs/RunsTabs.vue";
import { useSeed } from "../lib/seed";
import { formatDateTime, formatLocalIso } from "../lib/format";
import {
  ACTION_LABEL,
  firingDetailSummary,
  formatRelative,
  OUTCOME_CLASS,
  OUTCOME_LABEL,
} from "@core/channels/scheduledPanel.js";

// The Scheduled tab: the registry's schedules with each one's last
// firing — a snapshot per load, no feed. The rows arrive prebuilt from the
// server (buildScheduledRows), including token'd run hrefs for live firings.
//
// One DOM, two readings: from sm each schedule is two flowing ·-separated
// lines (definition, then the last firing); below sm the SAME cells stack into
// labeled lines (`sm:contents` wrappers group them, the separators are
// desktop-only, and the absolute next-fire stamp yields to its relative form).
//
// Every stamp reads in the viewer's timezone (the exact local ISO on hover);
// only the cron chip keeps its UTC label — the expression is defined in UTC.

const seed = useSeed("scheduled");
const now = computed(() => seed?.now ?? wallNow());
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
          <div class="def flex flex-wrap items-baseline gap-x-2 gap-y-1.5 text-[0.8rem] text-toned">
            <UTooltip :text="r.description">
              <span class="name font-semibold text-highlighted max-sm:text-[0.9rem]">{{ r.name }}</span>
            </UTooltip>
            <span class="hidden text-accented sm:inline" aria-hidden="true">·</span>
            <span class="max-sm:ml-auto">
              <span class="mr-1 text-[0.62rem] uppercase tracking-wider text-dimmed">on</span>
              <code class="rounded-xs bg-accented px-1.5 py-0.5 text-toned">{{ r.worker }}</code>
            </span>
            <span class="hidden text-accented sm:inline" aria-hidden="true">·</span>
            <span class="max-sm:flex max-sm:basis-full max-sm:flex-wrap max-sm:items-baseline max-sm:gap-2 sm:contents">
              <template v-if="r.action.type === 'run'">
                <code class="rounded-xs bg-accented px-1.5 py-0.5 text-toned">{{ r.action.command }}</code>
                <span class="text-dimmed">as</span>
                <code class="rounded-xs bg-accented px-1.5 py-0.5 text-toned">{{ r.action.identity }}</code>
              </template>
              <span v-else class="text-dimmed">{{ ACTION_LABEL[r.action.type] }} — not a run</span>
            </span>
            <span class="hidden text-accented sm:inline" aria-hidden="true">·</span>
            <span class="max-sm:flex max-sm:basis-full max-sm:flex-wrap max-sm:items-baseline max-sm:gap-2 sm:contents">
              <code class="rounded-xs bg-accented px-1.5 py-0.5 text-toned">{{ r.cron }}</code>
              <span class="text-dimmed">UTC</span>
              <span class="hidden text-accented sm:inline" aria-hidden="true">·</span>
              <span
                class="next tabular-nums max-sm:ml-auto"
                :title="r.nextFireAt !== undefined ? formatLocalIso(r.nextFireAt) : undefined"
              >
                <span class="mr-1 text-[0.62rem] uppercase tracking-wider text-dimmed">next</span>
                <template v-if="r.nextFireAt !== undefined">
                  <!-- The absolute stamp is a wide-screen luxury; the phone reads the relative form (exact local time on the title). -->
                  <span class="max-sm:hidden">
                    <b class="font-medium text-highlighted">{{ formatDateTime(r.nextFireAt, now) }}</b>
                    <span class="text-dimmed"> ({{ formatRelative(r.nextFireAt, now) }})</span>
                  </span>
                  <span class="text-toned sm:hidden">{{ formatRelative(r.nextFireAt, now) }}</span>
                </template>
                <span v-else class="text-dimmed">never</span>
              </span>
            </span>
          </div>
          <div
            class="fire mt-1.5 text-xs text-muted max-sm:flex max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-1.5 max-sm:gap-y-1 sm:overflow-hidden sm:text-ellipsis sm:whitespace-nowrap"
          >
            <span class="mr-1 text-[0.62rem] uppercase tracking-wider text-dimmed">last</span>
            <template v-if="r.last">
              <span class="outcome" :class="OUTCOME_TONE[OUTCOME_CLASS[r.last.outcome]]">{{
                OUTCOME_LABEL[r.last.outcome]
              }}</span>
              <span class="mx-1.5 text-accented max-sm:mx-0" aria-hidden="true">·</span>
              <span class="when text-toned" :title="formatLocalIso(r.last.firedAt)">{{
                formatRelative(r.last.firedAt, now)
              }}</span>
              <template v-if="r.last.runId">
                <span class="mx-1.5 text-accented max-sm:mx-0" aria-hidden="true">·</span>
                <a v-if="r.last.runHref" class="text-primary hover:underline" :href="r.last.runHref"
                  >run {{ r.last.runId.slice(0, 8) }}</a
                >
                <template v-else>run {{ r.last.runId.slice(0, 8) }}</template>
              </template>
              <template v-if="r.last.traceId">
                <span class="mx-1.5 text-accented max-sm:mx-0" aria-hidden="true">·</span>
                <!-- The firing's trace id: what the shim's cron root line and the run's meta share (docs/reference/specs/tracing.md item 22). -->
                <span class="trace font-mono text-dimmed" :title="`trace ${r.last.traceId}`"
                  >trace {{ r.last.traceId.slice(0, 8) }}</span
                >
              </template>
              <template v-if="r.last.detail && firingDetailSummary(r.last.detail)">
                <span class="mx-1.5 text-accented max-sm:hidden" aria-hidden="true">·</span>
                <!-- The reply's facts: one ellipsized line on desktop, a clamped block of its own on phones. -->
                <span
                  class="detail max-sm:line-clamp-2 max-sm:basis-full max-sm:whitespace-normal"
                  :title="r.last.detail"
                  >{{ firingDetailSummary(r.last.detail) }}</span
                >
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
