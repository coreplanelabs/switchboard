<script setup lang="ts">
defineOptions({ name: "GreenWeekOverWeekPage" });
import { computed } from "vue";
import { useSeed } from "../../src/lib/seed";
import PageHeading from "../components/PageHeading.vue";
import StatTiles from "../components/StatTiles.vue";
import ReviewTabs from "../components/ReviewTabs.vue";
import EmptyState from "../components/EmptyState.vue";
import {
  comparisonDays,
  comparisonRequesters,
  comparisonRows,
  comparisonTiles,
  countText,
  reviewDays,
  reviewsHref,
  shiftHeading,
  shiftText,
  windowText,
} from "../lib/reviews";
const seed = useSeed("reviewsMetrics");
const report = computed(() => seed?.report ?? null);
const days = computed(() => (report.value ? reviewDays(report.value) : null));
const comparison = computed(() => seed?.comparison ?? null);
const both = computed(() => (comparison.value && "previous" in comparison.value ? comparison.value : null));
const sampled = computed(() =>
  both.value ? Math.max(both.value.current.maxSampleInterval, both.value.previous.maxSampleInterval) : 1,
);
</script>
<template>
  <PageHeading title="Metrics" description="Recorded review usage and system outcomes." />
  <ReviewTabs current="week" :report="report" />
  <template v-if="report && days && comparison">
    <form class="green-toolbar flex-wrap" method="get" action="/metrics/week" aria-label="Review date range">
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
    <template v-if="both">
      <dl class="text-xs text-muted mb-4 grid gap-1" data-windows>
        <div>
          <dt class="inline">This range:</dt>
          <dd class="inline ms-1">{{ windowText(both.current) }}</dd>
        </div>
        <div>
          <dt class="inline">Compared with:</dt>
          <dd class="inline ms-1">{{ windowText(both.previous) }}, {{ shiftText(both.shiftDays) }}</dd>
        </div>
      </dl>
      <p class="text-xs text-muted mb-4">
        A range that includes today is cut at the same time in both windows, so the same weekdays and hours line up.
      </p>
      <p v-if="sampled > 1" class="text-xs text-muted mb-4">
        Sampled rows; counts are weighted. Largest sample interval: {{ sampled }}.
      </p>
      <StatTiles :tiles="comparisonTiles(both)" />
      <section class="green-section">
        <div class="green-section-heading"><h2>Side by side</h2></div>
        <div class="green-table-scroll">
          <table class="green-table" data-table="comparison">
            <thead>
              <tr>
                <th>Measure</th>
                <th>This range</th>
                <th>{{ shiftHeading(both.shiftDays) }}</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in comparisonRows(both)" :key="row.label">
                <td>{{ row.label }}</td>
                <td class="numeric">{{ row.now }}</td>
                <td class="numeric">{{ row.before }}</td>
                <td class="numeric">{{ row.change }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <div class="grid gap-5 xl:grid-cols-2">
        <section class="green-section">
          <div class="green-section-heading"><h2>Review runs by day</h2></div>
          <div class="green-table-scroll">
            <table class="green-table" data-table="days">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Runs</th>
                  <th>Earlier day</th>
                  <th>Runs</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in comparisonDays(both)" :key="row.day">
                  <td>{{ row.day }}</td>
                  <td class="numeric">{{ row.runs }}</td>
                  <td>{{ row.earlierDay }}</td>
                  <td class="numeric">{{ row.earlierRuns }}</td>
                  <td class="numeric">{{ row.change }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section class="green-section">
          <div class="green-section-heading"><h2>Review runs by requester</h2></div>
          <div class="green-table-scroll">
            <table class="green-table" data-table="requesters">
              <thead>
                <tr>
                  <th>Requester</th>
                  <th>This range</th>
                  <th>{{ shiftHeading(both.shiftDays) }}</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in comparisonRequesters(both)" :key="row.requester">
                  <td>{{ seed?.requesterNames?.[row.requester] ?? (row.requester || "Not recorded") }}</td>
                  <td class="numeric">{{ countText(row.now) }}</td>
                  <td class="numeric">{{ countText(row.before) }}</td>
                  <td class="numeric">{{ row.change }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="!comparisonRequesters(both).length" class="green-section-content text-muted">
              No recorded requesters in either range.
            </p>
          </div>
        </section>
      </div>
    </template>
    <EmptyState
      v-else
      title="No earlier range to compare"
      :description="`The range ${shiftText(comparison.shiftDays)} starts before the 90 days the metrics dataset keeps.`"
    />
    <details class="text-xs text-muted">
      <summary>Data and method</summary>
      <p class="mt-2">
        Both windows are review reports over the same recorded rows, grouped by UTC finish time. The earlier window is
        whole weeks back, so each day lines up with the same weekday.
      </p>
      <p class="mt-2">Ratios change in percentage points; counts and run time change in percent.</p>
      <a class="block text-primary mt-2" :href="reviewsHref('/metrics/week.json', report)"
        >Download comparison as JSON</a
      >
    </details>
  </template>
  <EmptyState
    v-else
    title="Metrics could not be loaded"
    description="The review comparison is unavailable. No week over week change is shown."
  />
</template>
