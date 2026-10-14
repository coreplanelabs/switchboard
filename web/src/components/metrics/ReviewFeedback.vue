<script setup lang="ts">
import { computed } from "vue";
import type { FeedbackState, ReviewFeedbackReport } from "@core/core/reviewFeedbackReport.js";
import { DAY_MS, MINUTE_MS } from "@core/core/budgets.js";

const props = defineProps<{ report: ReviewFeedbackReport }>();
const data = computed(() => (props.report.status === "available" ? props.report : null));
const counts = computed(() => data.value?.total);
const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const hours = (ms: number) => ms / MINUTE_MS / 60;
const time = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const stamp = (ms?: number) => (ms === undefined ? "Never" : time.format(ms));
const states: Record<FeedbackState, string> = {
  complete: "Current",
  missing_identity: "Missing review link",
  pending: "Awaiting first read",
  stale: "Read is old",
  unavailable: "Read failed",
  content_changed: "Review was edited",
};
const sections = computed(() =>
  data.value
    ? [
        {
          title: "By publication week (UTC)",
          rows: data.value.weekly,
          note: "Current ratings of reviews published in each week. Later votes and removals revise these rows.",
        },
        {
          title: "With and without findings",
          rows: data.value.byKind.map((g) => ({ ...g, key: g.key === "clean" ? "No findings" : "With findings" })),
          note: "Each review counts once.",
        },
        { title: "By repository", rows: data.value.byRepository, note: "Grouped by repository and review format." },
      ]
    : [],
);
</script>

<template>
  <section
    class="mb-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-lg border border-default bg-elevated px-5 py-4"
    data-review-feedback
  >
    <div>
      <h2 class="text-[0.9375rem] font-medium">Did the review help people decide what to change?</h2>
      <p class="text-sm text-muted">Native review-body 👍 / 👎 ratings from human accounts.</p>
    </div>
    <p v-if="report.status === 'unavailable'" class="text-sm text-muted">Human review feedback is unavailable.</p>
    <p v-else-if="report.status === 'not_applicable'" class="text-sm text-muted">
      Human review feedback applies to the review agent. Select all agents or review to see it.
    </p>
    <template v-else-if="data && counts">
      <p v-if="counts.eligible === 0" class="text-sm text-muted">No tracked reviews in this range.</p>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3" data-feedback-distribution>
        <div
          v-for="item in [
            { label: 'Positive only', value: counts.positiveOnly },
            { label: 'Negative only', value: counts.negativeOnly },
            { label: 'Mixed', value: counts.mixed },
          ]"
          :key="item.label"
          class="rounded-md border border-default px-3 py-2"
        >
          <p class="text-xs text-muted">{{ item.label }}</p>
          <p class="font-mono text-2xl tabular-nums">{{ item.value }}</p>
        </div>
      </div>
      <p class="text-sm" data-feedback-score>
        Helpful among clear ratings: {{ percent(counts.helpfulClearShare) }} ({{ counts.positiveOnly }} of
        {{ counts.positiveOnly + counts.negativeOnly }} reviews). Mixed: {{ counts.mixed }}.
      </p>
      <p class="text-xs text-muted">{{ counts.distinctPrs }} PRs · {{ counts.distinctRaters }} raters</p>
      <div class="grid gap-1 text-sm" data-feedback-coverage>
        <p>
          Rating coverage: {{ counts.ratedReviews }} / {{ counts.freshComplete }} fully checked reviews ({{
            percent(counts.ratingCoverage)
          }}).
        </p>
        <p>
          Ratings checked recently: {{ counts.freshComplete }} / {{ counts.eligible }} tracked reviews ({{
            percent(counts.syncCoverage)
          }}).
        </p>
      </div>
      <details class="text-sm">
        <summary class="cursor-pointer text-muted">Trends, data coverage and review details</summary>
        <p class="mt-3 text-xs text-muted">
          Native review links: {{ counts.registered }} / {{ counts.eligible }} tracked reviews ({{
            percent(counts.trackingCoverage)
          }}).
        </p>
        <p class="mt-2 text-xs text-muted">
          Helpful votes: {{ counts.positiveVotes }} / {{ counts.positiveVotes + counts.negativeVotes }} ({{
            percent(counts.helpfulVoteShare)
          }}). A person using both signs on one review supplies no effective vote.
        </p>
        <p class="mt-2 text-xs text-muted">
          {{ counts.unrated }} unrated · {{ counts.ambiguousOnly }} ambiguous-only ·
          {{ counts.unknownOnly }} unknown-only. {{ counts.ambiguousPairs }} ambiguous pairs ·
          {{ counts.unknownReactions }} unknown-actor reactions · {{ counts.excludedReactions }} automation reactions
          excluded.
        </p>
        <p class="text-xs text-muted" data-feedback-gaps>
          {{ counts.missingIdentity }} missing review links · {{ counts.pending }} awaiting first read ·
          {{ counts.stale }} old reads · {{ counts.unavailable }} failed reads · {{ counts.contentChanged }} edited
          reviews. {{ counts.lastKnownRated }} other reviews retain last-known ratings, excluded from the scores.
        </p>
        <div v-for="section in sections" :key="section.title" class="mt-4 grid gap-2">
          <h3 class="font-medium">{{ section.title }}</h3>
          <p class="text-xs text-muted">{{ section.note }}</p>
          <div class="overflow-x-auto">
            <table
              class="data w-full min-w-[42rem] border-collapse font-mono text-xs tabular-nums"
              data-feedback-groups
            >
              <thead>
                <tr>
                  <th
                    v-for="h in ['Group', 'Positive only', 'Negative only', 'Mixed', 'Rated', 'Checked', 'Tracked']"
                    :key="h"
                    class="border-b border-muted px-2 py-1 text-left text-muted"
                  >
                    {{ h }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="group in section.rows" :key="group.key">
                  <td class="border-b border-muted px-2 py-1">{{ group.key }}</td>
                  <td class="border-b border-muted px-2 py-1">{{ group.counts.positiveOnly }}</td>
                  <td class="border-b border-muted px-2 py-1">{{ group.counts.negativeOnly }}</td>
                  <td class="border-b border-muted px-2 py-1">{{ group.counts.mixed }}</td>
                  <td class="border-b border-muted px-2 py-1">{{ group.counts.ratedReviews }}</td>
                  <td class="border-b border-muted px-2 py-1">{{ group.counts.freshComplete }}</td>
                  <td class="border-b border-muted px-2 py-1">{{ group.counts.eligible }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="mt-4 overflow-x-auto">
          <p class="mb-2 text-xs text-muted">
            Showing {{ data.reviews.length }} latest reviews of {{ counts.eligible }} tracked reviews. Totals include
            the full range.
          </p>
          <table class="data w-full min-w-[42rem] border-collapse font-mono text-xs tabular-nums" data-feedback-reviews>
            <thead>
              <tr>
                <th
                  v-for="h in ['Review', 'Findings', 'State', 'Last complete read', 'Positive votes', 'Negative votes']"
                  :key="h"
                  class="border-b border-muted px-2 py-1 text-left text-muted"
                >
                  {{ h }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="review in data.reviews" :key="review.runId">
                <td class="border-b border-muted px-2 py-1">
                  <a v-if="review.url" :href="review.url" class="underline">{{ review.repo }}#{{ review.pr }}</a
                  ><span v-else>{{ review.repo }}#{{ review.pr }}</span>
                </td>
                <td class="border-b border-muted px-2 py-1">{{ review.findings }}</td>
                <td class="border-b border-muted px-2 py-1">{{ states[review.state] }}</td>
                <td class="border-b border-muted px-2 py-1">{{ stamp(review.lastCompleteAt) }}</td>
                <td class="border-b border-muted px-2 py-1">{{ review.positiveVotes }}</td>
                <td class="border-b border-muted px-2 py-1">{{ review.negativeVotes }}</td>
              </tr>
            </tbody>
          </table>
          <p class="mt-2 text-xs text-muted">
            Votes on old, failed or edited reads are last-known values and stay outside the scores.
          </p>
        </div>
      </details>
      <p class="border-t border-default pt-2 text-xs text-dimmed">
        Report as of {{ stamp(data.asOf) }}. Complete reads count for {{ hours(data.freshness.recentMaxAgeMs) }} hours
        on reviews published within {{ data.freshness.recentWindowMs / DAY_MS }} days, and
        {{ hours(data.freshness.olderMaxAgeMs) }} hours on older reviews.
        <template v-if="data.collectionStartedAt">Collection began {{ stamp(data.collectionStartedAt) }}.</template>
        <template v-else>Collection starts with the first tracked review.</template>
        Earlier review formats are outside this report. Feedback measures perceived usefulness.
      </p>
    </template>
  </section>
</template>
