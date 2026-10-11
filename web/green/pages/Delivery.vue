<script setup lang="ts">
defineOptions({ name: "GreenDeliveryPage" });
import { computed } from "vue";
import { githubPrUrl, githubRepoUrl } from "../../src/lib/githubLinks";
import { useRoute } from "vue-router";
import { useSeed } from "../../src/lib/seed";
import {
  tilesOf,
  coverageNote,
  hours,
  pct,
  ratio,
  ciCell,
  findingsCell,
  monthDay,
  snapshotTime,
} from "../../src/lib/delivery";
import { weekIncomplete, snapshotAgeText } from "@core/core/delivery.js";
import { MINUTE_MS } from "@core/core/budgets.js";
import { useWallClock } from "../../src/lib/wallClock";
import PageHeading from "../components/PageHeading.vue";
import StatTiles from "../components/StatTiles.vue";
import EmptyState from "../components/EmptyState.vue";
const seed = useSeed("delivery");
const route = useRoute();
const now = useWallClock(undefined, MINUTE_MS);
const report = computed(() => seed?.report);
const incompleteWork = computed(
  () => report.value?.workCoverage === "partial" || report.value?.workCoverage === "unavailable",
);
const measuredWork = computed(
  () =>
    report.value?.workCoverage !== "unavailable" &&
    (!incompleteWork.value || (report.value?.totals.prsMerged ?? 0) > 0),
);
const tiles = computed(() =>
  report.value && measuredWork.value
    ? tilesOf(report.value).map((tile) =>
        incompleteWork.value ? { ...tile, note: "Recorded selected work only; coverage is incomplete." } : tile,
      )
    : [],
);
const visibleWeeks = computed(() =>
  (report.value?.weeks ?? []).filter((week) => !incompleteWork.value || week.prsMerged > 0),
);
const freshHref = computed(() => {
  const query = new URLSearchParams();
  for (const key of ["weeks", "since"]) {
    const value = route.query[key];
    if (typeof value === "string") query.set(key, value);
  }
  query.set("fresh", "1");
  return `${route.path}?${query}`;
});
const hasIncompleteWeek = computed(
  () => !!report.value && visibleWeeks.value.some((week) => weekIncomplete(report.value!, week.week)),
);
const coverage = computed(() => (report.value && measuredWork.value ? coverageNote(report.value) : undefined));
const downloadHref = computed(() => {
  if (!report.value) return undefined;
  const query = new URLSearchParams();
  for (const key of ["weeks", "since", "fresh"]) {
    const value = route.query[key];
    if (typeof value === "string") query.set(key, value);
  }
  return `/delivery/${report.value.repo}.json${query.size ? `?${query}` : ""}`;
});
function href(repo: string, weeks: number) {
  return `/delivery/${repo}?weeks=${weeks}`;
}
</script>
<template>
  <PageHeading
    title="Delivery"
    description="See how work reaches main, from the first issue to the merged pull request."
    ><a class="green-button" :href="freshHref"><UIcon name="i-lucide-refresh-cw" />Refresh from GitHub</a></PageHeading
  >
  <template v-if="report">
    <div class="green-toolbar">
      <label class="text-xs text-muted"
        >Repository
        <select
          class="green-input ml-2"
          :value="report.repo"
          @change="$router.push(href(($event.target as HTMLSelectElement).value, report.range.weeks))"
        >
          <option v-for="repo in seed?.repos" :key="repo" :value="repo">{{ repo }}</option>
        </select></label
      >
      <nav class="flex gap-1" aria-label="Delivery range">
        <RouterLink
          v-for="weeks in [1, 2, 4, 8, 13]"
          :key="weeks"
          class="green-button"
          :to="href(report.repo, weeks)"
          :aria-current="weeks === report.range.weeks ? 'page' : undefined"
          >{{ weeks }}w</RouterLink
        >
      </nav>
    </div>
    <p v-if="coverage" class="green-notice green-warning" role="status">{{ coverage }}</p>
    <p v-if="incompleteWork" class="green-notice green-warning" role="status" data-work-coverage>
      {{
        report.workCoverage === "unavailable"
          ? "Selected work coverage is unavailable. Delivery totals cannot be confirmed."
          : "Selected work coverage is incomplete. Figures cover recorded publications only."
      }}
    </p>
    <StatTiles v-if="measuredWork" :tiles="tiles" />
    <section v-if="measuredWork" class="green-section">
      <div class="green-section-heading">
        <div>
          <h2>By week</h2>
          <p>Monday-start weeks · merged pull requests</p>
        </div>
      </div>
      <div class="green-table-scroll">
        <table class="green-table" aria-label="Weekly delivery">
          <thead>
            <tr>
              <th>Week</th>
              <th>Merged</th>
              <th>Agent authored</th>
              <th>Issue → merge</th>
              <th>First-pass CI</th>
              <th>Rounds / PR</th>
              <th>Findings</th>
              <th>No human edit</th>
              <th>Run minutes</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="week in visibleWeeks" :key="week.week">
              <td>
                {{ monthDay(week.week) }} – {{ monthDay(week.until)
                }}<span v-if="weekIncomplete(report, week.week)" class="block text-warn">Incomplete</span>
              </td>
              <td>{{ week.prsMerged }}</td>
              <td>{{ week.agentAuthoredPrs }}</td>
              <td>{{ hours(week.leadTimeHours.median) }}</td>
              <td>{{ ciCell(week) }}</td>
              <td>{{ ratio(week.reviewRounds.perPr) }}</td>
              <td>{{ findingsCell(week) }}</td>
              <td>{{ pct(week.findings.noHumanEditShare) }}</td>
              <td>{{ week.agentRuns.minutes.toFixed(0) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="report.completeFrom && hasIncompleteWeek" class="text-xs text-muted px-5 pb-4">
        Incomplete weeks hold the newest pull requests the read reached — complete from
        {{ snapshotTime(report.completeFrom) }}. Their numbers are a floor on the merges, not the week's total.
      </p>
    </section>
    <section class="green-section">
      <div class="green-section-heading">
        <div>
          <h2>By unit</h2>
          <p>The issue starts the clock. Pull requests provide the merge evidence.</p>
        </div>
      </div>
      <EmptyState
        v-if="!measuredWork || !report.units.length"
        :title="incompleteWork ? 'Selected delivery is not confirmed' : 'No merges in this range'"
        :description="
          incompleteWork ? 'Missing ownership or retained publication data prevents a complete count.' : undefined
        "
      />
      <div v-else class="green-table-scroll">
        <table class="green-table" aria-label="Unit delivery">
          <thead>
            <tr>
              <th>Unit</th>
              <th>Pull requests</th>
              <th>Issue → merge</th>
              <th>First-pass CI</th>
              <th>Rounds</th>
              <th>Findings</th>
              <th>No human edit</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="unit in report.units" :key="unit.issue ?? 'none'">
              <td>
                <a
                  v-if="unit.issue && githubRepoUrl(report.repo)"
                  :href="`${githubRepoUrl(report.repo)}/issues/${unit.issue}`"
                  class="inline-flex items-center gap-1"
                  ><UIcon name="i-lucide-circle-dot" />#{{ unit.issue }} · {{ unit.title }}</a
                ><span v-else>{{ unit.title }}</span>
              </td>
              <td>
                <a
                  v-for="pr in unit.prs"
                  :key="pr"
                  class="mr-2 inline-flex items-center gap-1"
                  :href="githubPrUrl(report.repo, pr)"
                  ><UIcon name="i-lucide-git-pull-request" />#{{ pr }}</a
                >
              </td>
              <td>{{ hours(unit.leadTimeHours.median) }}</td>
              <td>{{ ciCell(unit) }}</td>
              <td>{{ unit.reviewRounds.verdicts }}</td>
              <td>{{ findingsCell(unit) }}</td>
              <td>{{ pct(unit.findings.noHumanEditShare) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <p v-if="report.snapshotAt" class="text-xs text-muted mb-3" data-delivery-snapshot>
      As of {{ snapshotTime(report.snapshotAt) }}, {{ snapshotAgeText(report.snapshotAt, now) }}
    </p>
    <details class="text-xs text-muted">
      <summary>Data and method</summary>
      <div class="mt-2 grid gap-1.5">
        <div>
          <b>Snapshot.</b> GitHub's record of the merged pull requests (each one's timeline and its branch's workflow
          runs, the board issue its body links) is read on an interval and kept as a snapshot the page, its JSON twin
          and <code>delivery report</code> serve; <code>?fresh=1</code> reads GitHub now. The run history you may see
          joins on every load.
        </div>
        <div>
          <b>Issue → merge</b> runs from the linked board issue's opening (a closing keyword or a
          <code>board item</code> reference in the body) to the merge; a pull request that links no issue counts from
          its own opening. <b>First-pass CI</b> is green when every pull-request-triggered workflow run
          (<code>pull_request</code>, <code>pull_request_target</code>) on the first head succeeded at its first attempt
          — a rerun or a red run fails it; a head with no such run is not counted. <b>Review rounds</b> are the review
          agent's verdicts; a <i>fix round</i> is a verdict that followed a push. <b>No human edit</b> is the share of
          the agent's findings on pull requests where every push after the first verdict was an agent's: a bot login, or
          a commit co-authored by an agent. <b>Agent run minutes</b> are the finished runs of this repository that named
          a pull request.
        </div>
        <div>
          <b>Identities.</b> Verdicts by <code>{{ report.identities.reviewers.join(", ") || "(none configured)" }}</code
          >; agent logins end in <code>[bot]</code
          ><template v-if="report.identities.agentLogins.length"
            >, plus <code>{{ report.identities.agentLogins.join(", ") }}</code></template
          >; agent co-authors named <code>{{ report.identities.agentCoauthors.join(", ") || "(none)" }}</code
          >.
        </div>
      </div>
      <a :href="downloadHref" class="block mt-2 text-primary">Download this report as JSON</a>
    </details>
  </template>
  <EmptyState
    v-else
    title="Delivery could not be loaded"
    description="The report is unavailable. No delivery totals are shown."
  />
</template>
