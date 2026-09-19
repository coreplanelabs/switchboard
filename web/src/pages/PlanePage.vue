<script setup lang="ts">
import { computed } from "vue";
import type { PlanePullRequestRow, PlaneRunRow, PlaneUnitRow } from "@core/core/plane/table.js";
import AppShell from "../components/AppShell.vue";
import { useSeed } from "../lib/seed";
import { useWallClock } from "../lib/wallClock";
import {
  runHref,
  rowBound,
  rowPace,
  shortId,
  statusDot,
  statusWord,
  threadHref,
  whoText,
  type IndexRow,
} from "../lib/indexRow";
import { formatDuration } from "../lib/format";
import { runDurationMs } from "@core/core/runDuration.js";

// The plane's table (docs/reference/specs/orchestration-plane.md item 5; record 0064):
// what is happening, as one page — every live and recently ended run, every ship
// unit and every tracked pull request, each with its owner and its health flags.
// Every word comes from the seed the server built under the viewer's own
// predicate; the page paints and links, it decides nothing. A run row reads as
// it does on the runs index (the same helpers), so the two never disagree.

const seed = useSeed("plane");
const table = computed(() => seed?.table ?? null);
/** The clock the rows age against: the seed's `at` first, then the wall clock while the page is open. */
const now = useWallClock(seed?.table.at, 30_000);

/** A run row as the index row helpers read it: the view plus its token, when this process holds the run live. */
const indexRow = (row: PlaneRunRow): IndexRow => ({
  ...row.run,
  ...(seed?.tokens[row.run.id] ? { token: seed.tokens[row.run.id] } : {}),
});

const liveCount = computed(() => table.value?.runs.filter((r) => !r.run.finished).length ?? 0);
const recentCount = computed(() => (table.value ? table.value.runs.length - liveCount.value : 0));

const ownerOf = (row: PlaneRunRow): string => {
  const who = row.owner.name ?? whoText(indexRow(row)) ?? row.owner.id ?? "";
  return row.owner.generation ? `${who || "run"} · on ${row.owner.generation}` : who;
};
/** The one duration definition every surface prints (tracing.md item 13). */
const durationOf = (row: PlaneRunRow): string => {
  const r = row.run;
  return formatDuration(
    runDurationMs({ startedAt: r.startedAt, receivedAt: r.receivedAt, finishedAt: r.finishedAt }, now.value),
    "clock",
  );
};
const paceOf = (row: PlaneRunRow): string => rowBound(indexRow(row), now.value) ?? rowPace(indexRow(row), now.value);

const unitHref = (row: PlaneUnitRow): string => `/runs/unit/${encodeURIComponent(row.unit.unit)}`;
const prName = (row: PlanePullRequestRow): string => `${row.pr.repo}#${row.pr.number}`;
const prOwner = (row: PlanePullRequestRow): string =>
  row.owner.unitKey ?? (row.owner.runId ? `run ${shortId(row.owner.runId)}` : "a person");

/** Health words a stranger can read; the flag ids stay in `data-health` for tests and styling. */
const HEALTH_WORD: Record<string, string> = {
  stalled: "stalled",
  "bound-exceeded": "past its bound",
  "no-signal": "no signal",
  provisional: "unfinished",
  interrupted: "interrupted",
  failed: "failed",
  approved: "approved",
  dirty: "conflicts",
  red: "checks red",
  pending: "checks pending",
  mistitled: "title fails the rule",
  merged: "merged",
  closed: "closed",
  unknown: "unread",
  live: "live",
  waiting: "waiting",
  idle: "idle",
  "merge-ready": "merge-ready",
  ended: "ended",
  "owner-gap": "approved, open, nobody's",
};
const word = (flag: string): string => HEALTH_WORD[flag] ?? flag;
const tone = (flag: string): string =>
  ["stalled", "bound-exceeded", "red", "dirty", "mistitled", "owner-gap", "failed", "interrupted"].includes(flag)
    ? "border-error/40 text-error"
    : ["pending", "idle", "waiting", "no-signal", "provisional", "unknown"].includes(flag)
      ? "border-warning/40 text-warning"
      : "border-default text-muted";
</script>

<template>
  <AppShell v-if="table" title="Plane" nav="plane">
    <p class="mb-4 font-mono text-sm tabular-nums text-muted" data-plane-head>
      {{ liveCount }} live · {{ recentCount }} recent · {{ table.units.length }} units ·
      {{ table.pullRequests.length }} pull requests
    </p>

    <section class="mb-6" aria-labelledby="plane-runs">
      <h2 id="plane-runs" class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">Runs</h2>
      <p v-if="table.runs.length === 0" class="text-sm text-muted">No run is live or ended in the last hour.</p>
      <ul v-else class="divide-y divide-default rounded-md border border-default">
        <li
          v-for="row in table.runs"
          :key="row.run.id"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
          :data-run="row.run.id"
          :data-health="row.health.join(' ')"
        >
          <span
            class="inline-block size-2 rounded-full"
            :class="{
              'bg-success': statusDot(indexRow(row)) === 'green',
              'bg-error': statusDot(indexRow(row)) === 'red',
              'bg-warning': statusDot(indexRow(row)) === 'amber',
              'bg-dimmed': statusDot(indexRow(row)) === 'grey',
            }"
            aria-hidden="true"
          />
          <RouterLink class="font-mono text-highlighted" :to="runHref(indexRow(row))">{{
            shortId(row.run.id)
          }}</RouterLink>
          <span class="text-muted">{{ row.run.agent ?? "-" }}</span>
          <span class="font-mono tabular-nums">{{ statusWord(indexRow(row)) }}</span>
          <span class="font-mono tabular-nums text-muted">{{ durationOf(row) }}</span>
          <span v-if="paceOf(row)" class="font-mono text-xs tabular-nums text-muted">{{ paceOf(row) }}</span>
          <span class="text-muted" data-owner>{{ ownerOf(row) }}</span>
          <RouterLink
            v-if="row.unit"
            class="font-mono text-xs text-muted"
            :to="`/runs/unit/${encodeURIComponent(row.unit.key)}`"
            >{{ row.unit.key }}</RouterLink
          >
          <a
            v-if="row.run.threadKey"
            class="text-xs text-dimmed"
            :href="threadHref(row.run.threadKey)"
            target="_blank"
            rel="noreferrer"
            >thread</a
          >
          <span
            v-for="flag in row.health"
            :key="flag"
            class="rounded border px-1.5 py-0.5 text-xs"
            :class="tone(flag)"
            :data-flag="flag"
            >{{ word(flag) }}</span
          >
        </li>
      </ul>
    </section>

    <section class="mb-6" aria-labelledby="plane-units">
      <h2 id="plane-units" class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">Units</h2>
      <p v-if="table.units.length === 0" class="text-sm text-muted">No ship unit has a run on the table.</p>
      <ul v-else class="divide-y divide-default rounded-md border border-default">
        <li
          v-for="row in table.units"
          :key="row.unit.unit"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
          :data-unit="row.unit.unit"
          :data-health="row.health.join(' ')"
        >
          <RouterLink class="font-mono text-highlighted" :to="unitHref(row)">{{ row.unit.unit }}</RouterLink>
          <span class="text-muted">{{ row.instance.repo }}</span>
          <span>{{ row.unit.title ?? row.unit.id }}</span>
          <a
            v-if="row.unit.pr"
            class="font-mono text-xs text-muted"
            :href="row.unit.pr.url"
            target="_blank"
            rel="noreferrer"
            >#{{ row.unit.pr.number }}</a
          >
          <span
            v-for="flag in row.health"
            :key="flag"
            class="rounded border px-1.5 py-0.5 text-xs"
            :class="tone(flag)"
            :data-flag="flag"
            >{{ word(flag) }}</span
          >
        </li>
      </ul>
    </section>

    <section aria-labelledby="plane-prs">
      <h2 id="plane-prs" class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">Pull requests</h2>
      <p v-if="table.pullRequests.length === 0" class="text-sm text-muted">No pull request is tracked.</p>
      <ul v-else class="divide-y divide-default rounded-md border border-default">
        <li
          v-for="row in table.pullRequests"
          :key="prName(row)"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
          :data-pr="prName(row)"
          :data-health="row.health.join(' ')"
        >
          <a v-if="row.pr.url" class="font-mono text-highlighted" :href="row.pr.url" target="_blank" rel="noreferrer">{{
            prName(row)
          }}</a>
          <span v-else class="font-mono text-highlighted">{{ prName(row) }}</span>
          <span v-if="row.pr.title" class="truncate text-muted">{{ row.pr.title }}</span>
          <span class="text-xs text-dimmed" data-owner>{{ prOwner(row) }}</span>
          <span
            v-for="flag in row.health"
            :key="flag"
            class="rounded border px-1.5 py-0.5 text-xs"
            :class="tone(flag)"
            :data-flag="flag"
            >{{ word(flag) }}</span
          >
        </li>
      </ul>
    </section>
  </AppShell>
  <AppShell v-else title="Plane" nav="plane">
    <p class="text-sm text-muted">The table could not be read.</p>
  </AppShell>
</template>
