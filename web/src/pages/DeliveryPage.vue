<script setup lang="ts">
import { computed } from "vue";
import { snapshotAgeText, weekIncomplete } from "@core/core/delivery.js";
import AppShell from "../components/AppShell.vue";
import { useSeed } from "../lib/seed";
import {
  ciCell,
  coverageNote,
  findingsCell,
  freshHref,
  hours,
  monthDay,
  pct,
  ratio,
  snapshotTime,
  tilesOf,
} from "../lib/delivery";
import { useWallClock } from "../lib/wallClock";

// The delivery page: how work reaches `main` in one repository, per week and
// per unit, from the repository's snapshot of GitHub's facts (its age in the
// footer; `?fresh=1` reads GitHub now) and the run history. The costs page's
// shape — tiles, a table per grouping, the method one click away — on the same
// shell and tokens; no chart, the numbers are the picture. A read that stopped
// at its cap says so where the numbers are: over the tiles, and on each week
// row that holds the newest pull requests only.

const seed = useSeed("delivery");
const report = computed(() => seed?.report ?? null);
const repos = computed(() => seed?.repos ?? []);
const tiles = computed(() => (report.value ? tilesOf(report.value) : []));
const coverage = computed(() => (report.value ? coverageNote(report.value) : undefined));
const incomplete = (week: string): boolean => (report.value ? weekIncomplete(report.value, week) : false);
const anyIncomplete = computed(() => report.value?.weeks.some((w) => incomplete(w.week)) ?? false);
const ranges = [1, 2, 4, 8, 13];
/** The snapshot's age ticks by the minute while the page is open. */
const now = useWallClock(undefined, 60_000);
const search = typeof window === "undefined" ? "" : window.location.search;
const th = "border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-xs font-medium text-muted whitespace-nowrap";
const td = "border-b border-muted px-2.5 py-1.5";
</script>

<template>
  <AppShell v-if="report" :title="`${report.repo} delivery`" nav="delivery">
    <template #actions>
      <span class="text-xs text-muted">
        <template v-for="(n, i) in ranges" :key="n">
          <template v-if="i > 0"> · </template>
          <b v-if="n === report.range.weeks" class="text-highlighted">{{ n }}w</b>
          <a v-else class="text-primary hover:underline" :href="`/delivery/${report.repo}?weeks=${n}`">{{ n }}w</a>
        </template>
      </span>
    </template>

    <!-- One glance: which repository, which window. Repositories are a pill
         switcher (the current one solid), the range a short human line. -->
    <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <nav v-if="repos.length > 1" class="flex items-center gap-1" aria-label="Repositories">
        <template v-for="r in repos" :key="r">
          <span
            v-if="r === report.repo"
            class="rounded-md bg-accented px-2.5 py-1 text-xs font-medium text-highlighted"
            aria-current="page"
            >{{ r }}</span
          >
          <a
            v-else
            class="rounded-md px-2.5 py-1 text-xs text-muted no-underline hover:bg-elevated hover:text-highlighted"
            :href="`/delivery/${r}`"
            >{{ r }}</a
          >
        </template>
      </nav>
      <p class="font-mono text-sm tabular-nums text-muted">
        {{ monthDay(report.range.since) }} → {{ monthDay(report.range.until) }} · {{ report.range.weeks }}w · weeks
        start Monday, UTC
      </p>
    </div>

    <!-- A read that stopped at its cap: say what the tiles cover before the numbers, not in a footnote. -->
    <section class="mb-5 grid gap-3">
      <p v-if="coverage" class="text-sm text-muted">{{ coverage }}</p>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
        <div
          v-for="tile in tiles"
          :key="tile.label"
          class="grid gap-0.5 rounded-lg border border-default bg-elevated px-4 py-3.5"
        >
          <span class="font-mono text-[0.6875rem] font-medium uppercase tracking-widest text-dimmed">{{
            tile.label
          }}</span>
          <span class="font-mono text-2xl font-medium tabular-nums">{{ tile.value }}</span>
          <span class="text-xs text-muted">{{ tile.note }}</span>
        </div>
      </div>
    </section>

    <section class="mb-5 grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4">
      <div>
        <h2 class="text-[0.9375rem] font-medium">By week</h2>
        <p class="text-sm text-muted">One row per Monday-start week · merged pull requests only</p>
      </div>
      <div class="overflow-x-auto">
        <table
          class="weeks w-full min-w-[52rem] border-collapse whitespace-nowrap font-mono text-[0.8125rem] tabular-nums"
        >
          <thead>
            <tr>
              <th :class="[th, 'text-left']">Week</th>
              <th :class="[th, 'text-right']">Merged</th>
              <th :class="[th, 'text-right']">Agent-authored</th>
              <th :class="[th, 'text-right']">Issue → merge</th>
              <th :class="[th, 'text-right']">First-pass CI</th>
              <th :class="[th, 'text-right']">Rounds / PR</th>
              <th :class="[th, 'text-right']">Findings</th>
              <th :class="[th, 'text-right']">No human edit</th>
              <th :class="[th, 'text-right']">Agent run min</th>
            </tr>
          </thead>
          <tbody>
            <!-- A week the read did not cover whole is muted and says so: its numbers are the newest rows, not the week's. -->
            <tr v-for="w in report.weeks" :key="w.week" :class="incomplete(w.week) ? 'text-dimmed' : ''">
              <td :class="td" :title="`${w.week} → ${w.until}`">
                {{ monthDay(w.week) }} – {{ monthDay(w.until) }}
                <span v-if="incomplete(w.week)" class="ml-1 text-xs">(incomplete)</span>
              </td>
              <td :class="[td, 'text-right font-medium']">{{ w.prsMerged }}</td>
              <td :class="[td, 'text-right']">{{ w.agentAuthoredPrs }}</td>
              <td :class="[td, 'text-right']">{{ hours(w.leadTimeHours.median) }}</td>
              <td :class="[td, 'text-right']">{{ ciCell(w) }}</td>
              <td :class="[td, 'text-right']">{{ ratio(w.reviewRounds.perPr) }}</td>
              <td :class="[td, 'text-right']">{{ findingsCell(w) }}</td>
              <td :class="[td, 'text-right']">{{ pct(w.findings.noHumanEditShare) }}</td>
              <td :class="[td, 'text-right']">{{ w.agentRuns.minutes.toFixed(0) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="anyIncomplete && report.completeFrom" class="text-xs text-muted">
        Incomplete weeks hold the newest pull requests the read reached — it is complete from
        {{ snapshotTime(report.completeFrom) }} — so their numbers are a floor on the merges, not the week's.
      </p>
    </section>

    <section class="mb-5 grid gap-3 rounded-lg border border-default bg-elevated px-5 py-4">
      <div>
        <h2 class="text-[0.9375rem] font-medium">By unit</h2>
        <p class="text-sm text-muted">
          One row per board issue the pull requests link · the issue's opening starts the clock
        </p>
      </div>
      <p v-if="report.units.length === 0" class="text-sm text-muted">Nothing merged in range.</p>
      <div v-else class="overflow-x-auto">
        <table class="units w-full min-w-[52rem] border-collapse font-mono text-[0.8125rem] tabular-nums">
          <thead>
            <tr>
              <th :class="[th, 'text-left']">Issue</th>
              <th :class="[th, 'text-left']">Unit</th>
              <th :class="[th, 'text-left']">PRs</th>
              <th :class="[th, 'text-right']">Issue → merge</th>
              <th :class="[th, 'text-right']">First-pass CI</th>
              <th :class="[th, 'text-right']">Rounds</th>
              <th :class="[th, 'text-right']">Findings</th>
              <th :class="[th, 'text-right']">No human edit</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in report.units" :key="u.issue ?? 'none'">
              <td :class="[td, 'whitespace-nowrap']">
                <a
                  v-if="u.issue !== null"
                  class="text-primary hover:underline"
                  :href="`https://github.com/${report.repo}/issues/${u.issue}`"
                  >#{{ u.issue }}</a
                >
                <span v-else class="text-dimmed">—</span>
              </td>
              <td :class="[td, 'max-w-[28rem] truncate font-sans']" :title="u.title">{{ u.title }}</td>
              <td :class="[td, 'whitespace-nowrap']">
                <template v-for="(n, i) in u.prs" :key="n">
                  <template v-if="i > 0">, </template>
                  <a class="text-primary hover:underline" :href="`https://github.com/${report.repo}/pull/${n}`">{{
                    n
                  }}</a>
                </template>
              </td>
              <td :class="[td, 'text-right']">{{ hours(u.leadTimeHours.median) }}</td>
              <td :class="[td, 'text-right']">{{ ciCell(u) }}</td>
              <td :class="[td, 'text-right']">{{ u.reviewRounds.verdicts }}</td>
              <td :class="[td, 'text-right']">{{ findingsCell(u) }}</td>
              <td :class="[td, 'text-right']">{{ pct(u.findings.noHumanEditShare) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-xs text-muted">
        Machine-readable twin:
        <code class="rounded bg-accented px-1 py-0.5">GET /delivery/{{ report.repo }}.json</code> (same gate).
      </p>
    </section>

    <!-- When the facts were read, always in view; the method one click away instead of standing prose. -->
    <footer class="border-t border-default pt-3.5 text-xs text-dimmed">
      <p v-if="report.snapshotAt" class="mb-2 font-mono tabular-nums text-muted">
        As of {{ snapshotTime(report.snapshotAt) }}, {{ snapshotAgeText(report.snapshotAt, now) }} ·
        <a class="text-primary hover:underline" :href="freshHref(search)">read GitHub now</a>
      </p>
      <details>
        <summary class="cursor-pointer text-muted">How these numbers are computed</summary>
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
            (<code>pull_request</code>, <code>pull_request_target</code>) on the first head succeeded at its first
            attempt — a rerun or a red run fails it; a head with no such run is not counted. <b>Review rounds</b> are
            the review agent's verdicts; a <i>fix round</i> is a verdict that followed a push. <b>No human edit</b> is
            the share of the agent's findings on pull requests where every push after the first verdict was an agent's:
            a bot login, or a commit co-authored by an agent. <b>Agent run minutes</b> are the finished runs of this
            repository that named a pull request.
          </div>
          <div>
            <b>Identities.</b> Verdicts by
            <code>{{ report.identities.reviewers.join(", ") || "(none configured)" }}</code
            >; agent logins end in <code>[bot]</code
            ><template v-if="report.identities.agentLogins.length"
              >, plus <code>{{ report.identities.agentLogins.join(", ") }}</code></template
            >; agent co-authors named <code>{{ report.identities.agentCoauthors.join(", ") || "(none)" }}</code
            >.
          </div>
        </div>
      </details>
    </footer>
  </AppShell>
</template>
