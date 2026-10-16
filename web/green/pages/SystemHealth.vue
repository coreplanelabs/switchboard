<script setup lang="ts">
defineOptions({ name: "GreenSystemHealthPage" });
import { computed } from "vue";
import { useSeed } from "../../src/lib/seed";
import CostChart from "../../src/components/costs/CostChart.vue";
import PageHeading from "../components/PageHeading.vue";
import StatTiles from "../components/StatTiles.vue";
import ReviewTabs from "../components/ReviewTabs.vue";
import EmptyState from "../components/EmptyState.vue";
import { SERIES_SWATCH } from "../../src/lib/costs";
import {
  countText,
  durationText,
  outcomeText,
  reviewDays,
  reviewDayChart,
  reviewHealthTiles,
  reviewMethod,
  reviewsHref,
  workspaceText,
} from "../lib/reviews";
const seed = useSeed("reviewsMetrics");
const report = computed(() => seed?.report ?? null);
const days = computed(() => (report.value ? reviewDays(report.value) : null));
const chart = computed(() =>
  report.value
    ? reviewDayChart(
        report.value.system.byDay.map((row) => ({ day: row.day, values: row.byWorkspace })),
        workspaceText,
      )
    : null,
);
const method = computed(() => (report.value ? reviewMethod(report.value) : []));
</script>
<template>
  <PageHeading title="Metrics" description="Recorded review usage and system outcomes." />
  <ReviewTabs current="health" :report="report" />
  <template v-if="report && days">
    <form class="green-toolbar flex-wrap" method="get" action="/metrics/health" aria-label="Review date range">
      <label class="text-xs"
        >From (UTC)<input
          class="green-input block"
          type="date"
          name="from"
          :value="days.from"
          :max="days.to"
          required /></label
      ><label class="text-xs"
        >To (UTC, included)<input
          class="green-input block"
          type="date"
          name="to"
          :value="days.to"
          :min="days.from"
          required /></label
      ><button class="green-button" type="submit">Apply range</button
      ><span class="text-xs text-muted">Up to 90 days</span>
    </form>
    <p class="text-xs text-muted mb-4">
      {{ days.from }} – {{ days.to }} · {{ report.range.days }} UTC days. Recorded outcomes, not service uptime.
    </p>
    <p v-if="report.maxSampleInterval > 1" class="text-xs text-muted mb-4">
      Sampled rows; counts are weighted. Largest sample interval: {{ report.maxSampleInterval }}.
    </p>
    <StatTiles :tiles="reviewHealthTiles(report)" />
    <section class="green-section">
      <div class="green-section-heading"><h2>Review workspaces by day</h2></div>
      <div class="green-section-content">
        <CostChart v-if="chart" :model="chart.model" :format="countText" label="Review workspaces by day" />
        <div class="flex flex-wrap gap-3 text-xs text-muted mt-3">
          <span v-for="(label, index) in chart?.labels" :key="label" class="inline-flex gap-2 items-center"
            ><span class="size-2 rounded-sm" :class="SERIES_SWATCH[index % SERIES_SWATCH.length]" />{{ label }}</span
          >
        </div>
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading"><h2>By workspace</h2></div>
      <div class="green-table-scroll">
        <table class="green-table">
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Runs</th>
              <th>Median duration</th>
              <th>Median time to ready</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.system.byWorkspace" :key="row.workspace">
              <td>{{ workspaceText(row.workspace) }}</td>
              <td class="numeric">{{ countText(row.runs) }}</td>
              <td>{{ durationText(row.p50Ms, row.runs) }}</td>
              <td>{{ durationText(row.p50ReadyMs, row.runs) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!report.system.byWorkspace.length" class="green-section-content text-muted">
          No recorded workspace samples.
        </p>
      </div>
    </section>
    <div class="grid gap-5 xl:grid-cols-2">
      <section class="green-section">
        <div class="green-section-heading"><h2>Run outcomes</h2></div>
        <div class="green-table-scroll">
          <table class="green-table">
            <thead>
              <tr>
                <th>Outcome</th>
                <th>Runs</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(runs, outcome) in report.system.outcomes" :key="outcome">
                <td>{{ outcomeText(String(outcome)) }}</td>
                <td class="numeric">{{ countText(runs) }}</td>
              </tr>
            </tbody>
          </table>
          <dl class="green-section-content grid grid-cols-2 gap-3 text-sm">
            <dt>Outcome not recorded</dt>
            <dd>{{ countText(report.system.outcomeNotRecorded) }}</dd>
            <dt>Unclassified system errors</dt>
            <dd>{{ countText(report.system.unclassified) }}</dd>
          </dl>
        </div>
      </section>
      <section class="green-section">
        <div class="green-section-heading"><h2>System errors</h2></div>
        <div class="green-table-scroll">
          <table class="green-table">
            <thead>
              <tr>
                <th>Error type</th>
                <th>Runs</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in report.system.errorTypes" :key="row.errorType">
                <td class="break-all">{{ row.errorType }}</td>
                <td class="numeric">{{ countText(row.runs) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!report.system.errorTypes.length" class="green-section-content text-muted">
            No recorded system errors.
          </p>
        </div>
      </section>
    </div>
    <section class="green-section">
      <div class="green-section-heading"><h2>Setup reasons</h2></div>
      <div class="green-table-scroll">
        <table class="green-table">
          <thead>
            <tr>
              <th>Reason</th>
              <th>Recorded class</th>
              <th>Runs</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.system.setupReasons" :key="row.reason">
              <td class="break-all">{{ row.reason }}</td>
              <td>{{ row.class }}</td>
              <td class="numeric">{{ countText(row.runs) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!report.system.setupReasons.length" class="green-section-content text-muted">
          No recorded setup reasons.
        </p>
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading"><h2>Recording coverage</h2></div>
      <dl class="green-section-content grid grid-cols-2 gap-3 text-sm">
        <dt>Write failures</dt>
        <dd>Unavailable</dd>
        <dt>First fully recorded outcome day</dt>
        <dd>Unavailable</dd>
      </dl>
      <p class="green-section-content text-xs text-muted">
        This report supplies no scoped recording-failure counters or rollout date.
      </p>
    </section>
    <details class="text-xs text-muted">
      <summary>Data and method</summary>
      <p v-for="line in method" :key="line" class="mt-2">{{ line }}</p>
      <a class="block text-primary mt-2" :href="reviewsHref('/metrics.json', report)">Download report as JSON</a>
    </details>
  </template>
  <EmptyState
    v-else
    title="System health is unavailable"
    description="The review report is unavailable. No health status is inferred from run activity."
    icon="i-lucide-heart-pulse"
  />
</template>
