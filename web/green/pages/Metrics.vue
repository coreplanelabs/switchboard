<script setup lang="ts">
defineOptions({ name: "GreenMetricsPage" });
import { computed } from "vue";
import { useSeed } from "../../src/lib/seed";
import ReviewFeedback from "../../src/components/metrics/ReviewFeedback.vue";
import CostChart from "../../src/components/costs/CostChart.vue";
import PageHeading from "../components/PageHeading.vue";
import StatTiles from "../components/StatTiles.vue";
import EmptyState from "../components/EmptyState.vue";
import { SERIES_SWATCH } from "../../src/lib/costs";
import {
  countText,
  histogramLabel,
  durationText,
  reviewDays,
  reviewDayChart,
  reviewMethod,
  reviewsHref,
  reviewUsageTiles,
  surfaceText,
  wallText,
} from "../lib/reviews";
const seed = useSeed("reviewsMetrics");
const report = computed(() => seed?.report ?? null);
const days = computed(() => (report.value ? reviewDays(report.value) : null));
const chart = computed(() =>
  report.value
    ? reviewDayChart(
        report.value.usage.byDay.map((row) => ({ ...row, values: row.bySurface })),
        surfaceText,
      )
    : null,
);
const method = computed(() => (report.value ? reviewMethod(report.value) : []));
const surfaceDurationRuns = (row: { surface: string; durationRuns?: number }): number | undefined => row.durationRuns;
</script>
<template>
  <PageHeading title="Metrics" description="Recorded review usage and system outcomes." />
  <nav class="green-tabs" aria-label="Metrics sections">
    <RouterLink :to="reviewsHref('/metrics', report)" aria-current="page">Usage</RouterLink>
    <RouterLink :to="reviewsHref('/metrics/health', report)">System health</RouterLink>
  </nav>
  <template v-if="report && days">
    <form class="green-toolbar flex-wrap" method="get" action="/metrics" aria-label="Review date range">
      <label class="text-xs"
        >From (UTC)<input class="green-input block" type="date" name="from" :value="days.from" :max="days.to" required
      /></label>
      <label class="text-xs"
        >To (UTC, included)<input
          class="green-input block"
          type="date"
          name="to"
          :value="days.to"
          :min="days.from"
          required
      /></label>
      <button class="green-button" type="submit">Apply range</button
      ><span class="text-xs text-muted">Up to 90 days</span>
    </form>
    <p class="text-xs text-muted mb-4">{{ days.from }} – {{ days.to }} · {{ report.range.days }} UTC days</p>
    <p v-if="report.maxSampleInterval > 1" class="text-xs text-muted mb-4">
      Sampled rows; counts are weighted. Largest sample interval: {{ report.maxSampleInterval }}.
    </p>
    <StatTiles :tiles="reviewUsageTiles(report)" />
    <ReviewFeedback v-if="report.feedback" :report="report.feedback" />
    <section class="green-section">
      <div class="green-section-heading"><h2>Review runs by day</h2></div>
      <div class="green-section-content">
        <CostChart v-if="chart" :model="chart.model" :format="countText" label="Review runs by day and surface" />
        <div class="flex flex-wrap gap-3 text-xs text-muted mt-3">
          <span v-for="(label, index) in chart?.labels" :key="label" class="inline-flex gap-2 items-center"
            ><span class="size-2 rounded-sm" :class="SERIES_SWATCH[index % SERIES_SWATCH.length]" />{{ label }}</span
          >
        </div>
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading">
        <div>
          <h2>By requester</h2>
          <p>Duration quantiles: successful runs only</p>
        </div>
      </div>
      <div class="green-table-scroll">
        <table class="green-table" data-table="requesters">
          <thead>
            <tr>
              <th>Requester</th>
              <th>Runs</th>
              <th>Succeeded</th>
              <th>Total run time</th>
              <th>p50 duration</th>
              <th>p95 duration</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.usage.byRequester" :key="row.requester">
              <td>{{ seed?.requesterNames?.[row.requester] ?? (row.requester || "Not recorded") }}</td>
              <td class="numeric">{{ countText(row.runs) }}</td>
              <td class="numeric">{{ countText(row.succeeded) }}</td>
              <td>{{ wallText(row.wallMs) }}</td>
              <td>{{ durationText(row.p50Ms, row.succeeded) }}</td>
              <td>{{ durationText(row.p95Ms, row.succeeded) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!report.usage.byRequester.length" class="green-section-content text-muted">
          No recorded requesters in this range.
        </p>
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading">
        <div>
          <h2>By surface</h2>
          <p>Unknown durations have no supplied successful-sample count.</p>
        </div>
      </div>
      <div class="green-table-scroll">
        <table class="green-table" data-table="surfaces">
          <thead>
            <tr>
              <th>Surface</th>
              <th>Runs</th>
              <th>p50 duration</th>
              <th>p95 duration</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.usage.bySurface" :key="row.surface">
              <td>{{ surfaceText(row.surface) }}</td>
              <td class="numeric">{{ countText(row.runs) }}</td>
              <td>{{ durationText(row.p50Ms, surfaceDurationRuns(row)) }}</td>
              <td>{{ durationText(row.p95Ms, surfaceDurationRuns(row)) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <div class="grid gap-5 xl:grid-cols-2">
      <section class="green-section">
        <div class="green-section-heading"><h2>Run duration distribution</h2></div>
        <div class="green-table-scroll">
          <table class="green-table">
            <thead>
              <tr>
                <th>Duration</th>
                <th>Runs</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in report.usage.histogram" :key="row.minute">
                <td>{{ histogramLabel(row.minute) }}</td>
                <td class="numeric">{{ countText(row.runs) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!report.usage.histogram.length" class="green-section-content text-muted">
            No recorded duration samples.
          </p>
        </div>
      </section>
      <section class="green-section">
        <div class="green-section-heading"><h2>Review verdicts and findings</h2></div>
        <dl class="green-section-content grid grid-cols-2 gap-3 text-sm">
          <dt>Approved</dt>
          <dd>{{ countText(report.usage.verdicts.approved) }}</dd>
          <dt>Changes requested</dt>
          <dd>{{ countText(report.usage.verdicts.changes_requested) }}</dd>
          <dt>Total findings</dt>
          <dd>{{ countText(report.usage.findings.total) }}</dd>
          <template v-for="severity in ['blocking', 'major', 'minor', 'nit'] as const" :key="severity"
            ><dt class="capitalize">{{ severity }}</dt>
            <dd>{{ countText(report.usage.findings[severity]) }}</dd></template
          >
        </dl>
      </section>
    </div>
    <section class="green-section">
      <div class="green-section-heading"><h2>Reviews per pull request</h2></div>
      <div v-if="report.usage.reviewsPerPullRequest" class="green-table-scroll">
        <table class="green-table">
          <thead>
            <tr>
              <th>Reviews</th>
              <th>Pull requests</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.usage.reviewsPerPullRequest" :key="row.reviews">
              <td>{{ countText(row.reviews) }}</td>
              <td>{{ countText(row.pullRequests) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!report.usage.reviewsPerPullRequest.length" class="green-section-content text-muted">
          No recorded pull requests in this range.
        </p>
      </div>
      <p v-else class="green-section-content text-muted">Reviews per pull request unavailable for this report.</p>
    </section>
    <details class="text-xs text-muted">
      <summary>Data and method</summary>
      <p v-for="line in method" :key="line" class="mt-2">{{ line }}</p>
      <a class="block text-primary mt-2" :href="reviewsHref('/metrics.json', report)">Download report as JSON</a>
    </details>
  </template>
  <EmptyState
    v-else
    title="Metrics could not be loaded"
    description="The review report is unavailable. No usage totals are shown."
  />
</template>
