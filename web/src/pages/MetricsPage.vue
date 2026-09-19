<script setup lang="ts">
import { computed } from "vue";
import AppShell from "../components/AppShell.vue";
import CostChart from "../components/costs/CostChart.vue";
import TrendLineChart from "../components/metrics/TrendLineChart.vue";
import { useSeed } from "../lib/seed";
import { monthDayOf, SERIES_SWATCH, usd } from "../lib/costs";
import {
  countText,
  failureRateChartOf,
  footerSentencesOf,
  metricsHrefOf,
  metricsTilesOf,
  pctText,
  runsChartModelOf,
  statusSeriesOf,
  p50ChartOf,
  wallText,
} from "../lib/metrics";

// The run trend (docs/reference/specs/run-metrics.md item 10): the report the
// `metrics trend` command answers, in the costs page's tokens and layout — the
// tiles, a runs-per-day chart stacked by status, a failure-rate line, a
// p50-wall line per agent, the by-agent table, and a footer naming the bucket,
// the pricing, the completeness and the retention. Everything on the page is
// the seed's report: the JSON twin (`/metrics.json`) carries exactly the same.

const seed = useSeed("metrics");
const report = computed(() => seed?.report ?? null);
const range = computed(() => report.value?.range ?? null);
const tiles = computed(() => (report.value ? metricsTilesOf(report.value) : []));
const statuses = computed(() => (report.value ? statusSeriesOf(report.value.byDay) : []));
const runsModel = computed(() => (report.value ? runsChartModelOf(report.value.byDay, statuses.value) : null));
const failureModel = computed(() => (report.value ? failureRateChartOf(report.value.byDay) : null));
const p50Model = computed(() =>
  report.value ? p50ChartOf(report.value.byDay, report.value.byAgent, report.value.p50ByDayAgent) : null,
);
const footer = computed(() => (range.value ? footerSentencesOf(range.value) : []));

/** The range pills: the three windows the plan names, the current one solid. */
const RANGES = [7, 30, 90];
/** The agent pills: every agent in range, `All` first; the open filter survives a range switch. */
const agents = computed(() => (report.value ? report.value.byAgent.map((r) => r.agent) : []));
const currentAgent = computed(() => range.value?.agent);
/** An ISO day out of the range's stamps: the header line reads at a glance. */
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
</script>

<template>
  <AppShell v-if="report && range" title="Run metrics" nav="metrics">
    <!-- One glance: which window, which agent. Range and agent are pill
         switchers (the current one solid), plus a short human line. -->
    <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <nav class="flex items-center gap-1" aria-label="Range">
        <template v-for="n in RANGES" :key="n">
          <span
            v-if="n === range.days"
            class="rounded-md bg-accented px-2.5 py-1 font-mono text-xs font-medium tabular-nums text-highlighted"
            aria-current="page"
            >{{ n }}d</span
          >
          <RouterLink
            v-else
            class="rounded-md px-2.5 py-1 font-mono text-xs tabular-nums text-muted no-underline hover:bg-elevated hover:text-highlighted"
            :to="metricsHrefOf(n, currentAgent)"
            >{{ n }}d</RouterLink
          >
        </template>
      </nav>
      <nav v-if="agents.length > 0" class="flex items-center gap-1" aria-label="Agent">
        <span
          v-if="currentAgent === undefined"
          class="rounded-md bg-accented px-2.5 py-1 text-xs font-medium text-highlighted"
          aria-current="page"
          >all agents</span
        >
        <RouterLink
          v-else
          class="rounded-md px-2.5 py-1 text-xs text-muted no-underline hover:bg-elevated hover:text-highlighted"
          :to="metricsHrefOf(range.days)"
          >all agents</RouterLink
        >
        <template v-for="a in agents" :key="a">
          <span
            v-if="a === currentAgent"
            class="rounded-md bg-accented px-2.5 py-1 text-xs font-medium text-highlighted"
            aria-current="page"
            >{{ a }}</span
          >
          <RouterLink
            v-else
            class="rounded-md px-2.5 py-1 text-xs text-muted no-underline hover:bg-elevated hover:text-highlighted"
            :to="metricsHrefOf(range.days, a)"
            >{{ a }}</RouterLink
          >
        </template>
      </nav>
      <p class="font-mono text-sm tabular-nums text-muted" data-metrics-range>
        {{ monthDayOf(dayOf(range.sinceMs)) }} → {{ monthDayOf(dayOf(range.untilMs - 1)) }} · {{ range.days }}d ·
        dataset {{ report.dataset }}
      </p>
    </div>

    <section class="mb-5 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3" data-metrics-tiles>
      <div
        v-for="t in tiles"
        :key="t.label"
        class="grid gap-0.5 rounded-lg border border-default bg-elevated px-4 py-3.5"
      >
        <span class="font-mono text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed">{{ t.label }}</span>
        <span class="font-mono text-2xl font-medium tabular-nums">{{ t.value }}</span>
        <span class="text-xs text-muted">{{ t.sub }}</span>
      </div>
    </section>

    <section class="mb-5 grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <h2 class="text-[0.9375rem] font-medium">Runs per day</h2>
          <p class="text-sm text-muted">Stacked by status · one point per finished run, weighted for sampling</p>
        </div>
        <div class="legend flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
          <span v-for="(s, i) in statuses" :key="s" class="inline-flex items-center gap-1.5">
            <i class="inline-block size-2.5 rounded-xs" :class="SERIES_SWATCH[i % SERIES_SWATCH.length]" />{{ s }}
          </span>
        </div>
      </div>
      <CostChart v-if="runsModel" :model="runsModel" label="Runs per day, stacked by status" :format="countText" />
    </section>

    <section class="mb-5 grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4">
      <div>
        <h2 class="text-[0.9375rem] font-medium">Failure rate per day</h2>
        <p class="text-sm text-muted">Failed share of the day's runs · a day with no runs draws a gap</p>
      </div>
      <TrendLineChart v-if="failureModel" :model="failureModel" label="Failure rate per day" />
    </section>

    <section class="mb-5 grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <h2 class="text-[0.9375rem] font-medium">Median wall per day</h2>
          <p class="text-sm text-muted">p50 wall-clock per agent, weighted for sampling</p>
        </div>
        <div class="legend flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
          <span v-for="line in p50Model?.lines ?? []" :key="line.name" class="inline-flex items-center gap-1.5">
            <i
              class="inline-block size-2.5 rounded-xs"
              :class="SERIES_SWATCH[line.seriesIndex % SERIES_SWATCH.length]"
            />{{ line.name }}
          </span>
        </div>
      </div>
      <TrendLineChart v-if="p50Model" :model="p50Model" label="Median wall-clock per day per agent" />
    </section>

    <section class="mb-5 grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4">
      <div>
        <h2 class="text-[0.9375rem] font-medium">By agent</h2>
        <p class="text-sm text-muted">Largest first · the whole range's runs per agent</p>
      </div>
      <div class="overflow-x-auto">
        <table
          class="data w-full min-w-[38rem] border-collapse whitespace-nowrap font-mono text-[0.8125rem] tabular-nums"
          data-metrics-agents
        >
          <thead>
            <tr>
              <th
                class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-left text-xs font-medium text-muted"
              >
                Agent
              </th>
              <th
                v-for="h in [
                  'Runs',
                  'Failed',
                  'Failure rate',
                  'p50 wall',
                  'p95 wall',
                  'LLM',
                  'Unpriced tokens',
                  'Turns',
                ]"
                :key="h"
                class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-right text-xs font-medium text-muted"
              >
                {{ h }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in report.byAgent" :key="r.agent">
              <td class="border-b border-muted px-2.5 py-1.5">
                <RouterLink
                  class="no-underline hover:text-highlighted hover:underline"
                  :to="metricsHrefOf(range.days, r.agent)"
                  >{{ r.agent }}</RouterLink
                >
              </td>
              <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ countText(r.runs) }}</td>
              <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ countText(r.failed) }}</td>
              <td class="border-b border-muted px-2.5 py-1.5 text-right">
                {{ pctText(r.runs > 0 ? r.failed / r.runs : 0) }}
              </td>
              <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ wallText(r.p50WallMs) }}</td>
              <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ wallText(r.p95WallMs) }}</td>
              <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ usd(r.usd) }}</td>
              <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ countText(r.unpricedTokens) }}</td>
              <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ countText(r.turns) }}</td>
            </tr>
            <tr v-if="report.byAgent.length === 0">
              <td class="px-2.5 py-1.5 text-muted" colspan="9">No runs in this range.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-xs text-muted">
        Machine-readable twin: <code class="rounded bg-accented px-1 py-0.5">GET /metrics.json</code> (same Access
        gate); the same report is <code class="rounded bg-accented px-1 py-0.5">metrics trend</code> on every command
        surface.
      </p>
    </section>

    <!-- What these numbers ARE: the report's own provenance words, one sentence each. -->
    <footer class="border-t border-default pt-3.5 text-xs text-dimmed" data-metrics-footer>
      <p v-for="s in footer" :key="s">{{ s }}</p>
    </footer>
  </AppShell>
  <!-- Without a seed there is nothing to draw: the handler answers the off/error
       words as plain text before this page is ever served, so this state is a
       mismatched seed, not the off state. -->
  <AppShell v-else title="Run metrics" nav="metrics">
    <section class="mb-5 grid gap-2 rounded-lg border border-default bg-elevated px-5 py-4">
      <h2 class="text-sm font-medium text-highlighted">Nothing to show</h2>
      <p class="text-xs text-dimmed">This page did not receive its report; reload to ask again.</p>
    </section>
  </AppShell>
</template>
