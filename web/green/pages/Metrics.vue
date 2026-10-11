<script setup lang="ts">
defineOptions({ name: "GreenMetricsPage" });
import { computed } from "vue";
import PageHeading from "../components/PageHeading.vue";
import StatTiles from "../components/StatTiles.vue";
import EmptyState from "../components/EmptyState.vue";
import CostChart from "../../src/components/costs/CostChart.vue";
import TrendLineChart from "../../src/components/metrics/TrendLineChart.vue";
import ReviewFeedback from "../../src/components/metrics/ReviewFeedback.vue";
import { useSeed } from "../../src/lib/seed";
import { monthDayOf, SERIES_SWATCH, usd } from "../../src/lib/costs";
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
} from "../../src/lib/metrics";

// The run trend (docs/reference/specs/run-metrics.md item 10): the report the
// `metrics trend` command answers, in the costs page's tokens and layout — the
// tiles, a runs-per-day chart stacked by status, a failure-rate line, a
// p50-wall line per agent, the by-agent table, and a footer naming the bucket,
// the pricing, the completeness and the retention. Everything on the page is
// the seed's report: the JSON twin (`/metrics.json`) carries exactly the same.

const seed = useSeed("metrics");
const report = computed(() => seed?.report ?? null);
const range = computed(() => report.value?.range ?? null);
const tiles = computed(() =>
  report.value ? metricsTilesOf(report.value).map((tile) => ({ ...tile, note: tile.sub })) : [],
);
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
  <PageHeading title="Metrics" description="Track execution quality, duration, and usage across finished runs." />
  <nav class="green-tabs" aria-label="Metrics sections">
    <RouterLink to="/metrics" aria-current="page">Usage</RouterLink
    ><RouterLink to="/metrics/health">System health</RouterLink>
  </nav>
  <template v-if="report && range">
    <div class="green-toolbar">
      <nav class="flex gap-1" aria-label="Metrics range">
        <RouterLink
          v-for="days in RANGES"
          :key="days"
          class="green-button"
          :to="metricsHrefOf(days, currentAgent)"
          :aria-current="days === range.days ? 'page' : undefined"
          >{{ days }}d</RouterLink
        >
      </nav>
      <label class="text-xs text-muted"
        >Agent<select
          class="green-input ml-2"
          :value="currentAgent ?? ''"
          @change="$router.push(metricsHrefOf(range.days, ($event.target as HTMLSelectElement).value || undefined))"
        >
          <option value="">All agents</option>
          <option v-for="agent in agents" :key="agent" :value="agent">{{ agent }}</option>
        </select></label
      >
    </div>
    <p class="text-xs text-muted mb-4">
      {{ monthDayOf(dayOf(range.sinceMs)) }} – {{ monthDayOf(dayOf(range.untilMs - 1)) }} · {{ range.days }} days
    </p>
    <StatTiles :tiles="tiles" data-metrics-tiles />
    <ReviewFeedback v-if="report.feedback" :report="report.feedback" />
    <div class="grid gap-5 xl:grid-cols-2">
      <section class="green-section">
        <div class="green-section-heading"><h2>Runs by outcome</h2></div>
        <div class="green-section-content">
          <CostChart
            v-if="runsModel"
            :model="runsModel"
            :format="countText"
            label="Finished runs per day, stacked by outcome"
          />
          <div class="flex gap-3 flex-wrap text-xs text-muted mt-3">
            <span v-for="(status, index) in statuses" :key="status" class="inline-flex items-center gap-2"
              ><span class="size-2 rounded-sm" :class="SERIES_SWATCH[index % SERIES_SWATCH.length]" />{{ status }}</span
            >
          </div>
        </div>
      </section>
      <section class="green-section">
        <div class="green-section-heading"><h2>Failure rate</h2></div>
        <div class="green-section-content">
          <TrendLineChart v-if="failureModel" :model="failureModel" label="Daily failure rate" />
        </div>
      </section>
    </div>
    <section class="green-section">
      <div class="green-section-heading">
        <div>
          <h2>Median run duration</h2>
          <p>By agent · empty days remain gaps</p>
        </div>
      </div>
      <div class="green-section-content">
        <TrendLineChart v-if="p50Model" :model="p50Model" label="Median wall duration by agent per day" />
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading"><h2>By agent</h2></div>
      <div class="green-table-scroll">
        <table class="green-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Runs</th>
              <th>Failed</th>
              <th>p50 duration</th>
              <th>p95 duration</th>
              <th>Model cost</th>
              <th>Turns</th>
              <th>Unpriced tokens</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="agent in report.byAgent" :key="agent.agent">
              <td>{{ agent.agent }}</td>
              <td class="numeric">{{ countText(agent.runs) }}</td>
              <td class="numeric">
                {{ countText(agent.failed) }} ({{ pctText(agent.runs ? agent.failed / agent.runs : 0) }})
              </td>
              <td>{{ wallText(agent.p50WallMs) }}</td>
              <td>{{ wallText(agent.p95WallMs) }}</td>
              <td>{{ usd(agent.usd) }}</td>
              <td>{{ countText(agent.turns) }}</td>
              <td>{{ countText(agent.unpricedTokens) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <details class="text-xs text-muted">
      <summary>Data and method</summary>
      <p v-for="line in footer" :key="line" class="mt-2">{{ line }}</p>
      <p class="mt-2">Dataset: {{ report.dataset }}</p>
      <a
        class="block text-primary mt-2"
        :href="`/metrics.json?days=${range.days}${currentAgent ? `&agent=${encodeURIComponent(currentAgent)}` : ''}`"
        >Download report as JSON</a
      >
    </details>
  </template>
  <EmptyState
    v-else
    title="Metrics could not be loaded"
    description="The data source is unavailable. No usage totals are shown."
  />
</template>
