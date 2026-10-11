<script setup lang="ts">
defineOptions({ name: "GreenHistoryPage" });
import { computed, inject } from "vue";
import type { HomeHistorySeed } from "@core/channels/homeSeed.js";
import { DAY_MS, MINUTE_MS } from "@core/core/budgets.js";
import { SeedKey } from "../../src/lib/seed";
import { useWallClock } from "../../src/lib/wallClock";
import { githubPrUrl, githubRepoUrl, githubTreeUrl } from "../../src/lib/githubLinks";
import { endingWordOf } from "@core/core/pipelineStanding.js";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
const seed = inject(SeedKey, null) as unknown as HomeHistorySeed | null;
const history = seed?.page === "fleetHistory" ? seed.history : undefined;
const now = useWallClock(history?.now);
const zone = history?.week?.timeZone ?? "UTC";
function relative(at: number) {
  const elapsed = Math.max(0, now.value - at);
  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes === 0) return "Just now";
  const unit = minutes < 60 ? "minute" : elapsed < DAY_MS ? "hour" : "day";
  const count = unit === "minute" ? minutes : unit === "hour" ? Math.floor(minutes / 60) : Math.floor(elapsed / DAY_MS);
  return new Intl.RelativeTimeFormat("en", { numeric: "always" }).format(-count, unit);
}
const groups = computed(() => {
  const days = new Map<string, { label: string; rows: NonNullable<typeof history>["units"] }>();
  for (const row of history?.units ?? []) {
    const at = row.unit.mergeCompletion?.at ?? row.unit.ending?.at;
    const label =
      at === undefined
        ? "Completion time not recorded"
        : new Intl.DateTimeFormat("en", { weekday: "long", month: "short", day: "numeric", timeZone: zone }).format(at);
    const key =
      at === undefined
        ? "unknown"
        : new Intl.DateTimeFormat("en-CA", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            timeZone: zone,
          }).format(at);
    if (!days.has(key)) days.set(key, { label, rows: [] });
    days.get(key)!.rows.push(row);
  }
  return [...days.entries()].map(([key, value]) => ({ key, ...value }));
});
const olderHref = computed(() => {
  if (!history?.cursor) return undefined;
  const params = new URLSearchParams();
  if (history.week) {
    params.set("week", history.week.startDate);
    params.set("tz", history.week.timeZone);
  }
  params.set("cursor", history.cursor);
  return `/home/history?${params}`;
});
</script>
<template>
  <PageHeading title="Completed work" description="Retained work in this view, by completion time."
    ><RouterLink class="green-button" to="/home"><UIcon name="i-lucide-arrow-left" />Home</RouterLink></PageHeading
  >
  <nav v-if="history?.week" class="green-week-navigation" aria-label="Completed work weeks">
    <RouterLink
      class="green-icon-button"
      :to="history.week.previousUrl"
      aria-label="Previous week"
      title="Previous week"
      ><UIcon name="i-lucide-chevron-left"
    /></RouterLink>
    <div>
      <h2>{{ history.week.label }}</h2>
      <p class="text-xs text-muted">Sunday–Saturday · {{ history.week.timeZone }}</p>
    </div>
    <RouterLink
      v-if="history.week.nextUrl"
      class="green-icon-button"
      :to="history.week.nextUrl"
      aria-label="Next week"
      title="Next week"
      ><UIcon name="i-lucide-chevron-right"
    /></RouterLink>
  </nav>
  <p v-if="history?.status === 'partial'" class="green-notice green-warning" role="status">
    Some history could not be loaded. This view is incomplete.
  </p>
  <p class="text-xs text-muted mb-4">Up to 100 per page. Only retained work in your selected view is shown.</p>
  <section v-for="group in groups" :key="group.key" class="green-section">
    <div class="green-section-heading">
      <h2>{{ group.label }}</h2>
    </div>
    <ol class="green-history-timeline">
      <li v-for="row in group.rows" :key="row.unit.unit">
        <div class="flex justify-between gap-3 flex-wrap">
          <RouterLink
            class="font-medium text-highlighted break-words"
            :to="`/runs/unit/${encodeURIComponent(row.unit.unit)}`"
            >{{ row.unit.title ?? `Unit ${row.unit.id}` }}</RouterLink
          >
          <span
            class="green-badge"
            :data-state="
              row.unit.mergeCompletion ? 'merged' : row.unit.ending ? endingWordOf(row.unit.ending.kind) : undefined
            "
            >{{
              row.unit.mergeCompletion ? "Merged" : row.unit.ending ? endingWordOf(row.unit.ending.kind) : "Completed"
            }}</span
          >
        </div>
        <time
          v-if="row.unit.ending"
          class="text-xs text-muted"
          :datetime="new Date(row.unit.mergeCompletion?.at ?? row.unit.ending.at).toISOString()"
          :title="
            new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'long', timeZone: zone }).format(
              row.unit.mergeCompletion?.at ?? row.unit.ending.at,
            )
          "
          >{{ relative(row.unit.mergeCompletion?.at ?? row.unit.ending.at) }}</time
        >
        <p v-else class="text-xs text-muted">Completion time not recorded</p>
        <p class="text-xs text-muted mt-2 break-words">
          <a
            v-if="githubRepoUrl(row.instance.repo)"
            :href="githubRepoUrl(row.instance.repo)"
            target="_blank"
            rel="noopener noreferrer"
            >{{ row.instance.repo }}</a
          ><span v-else>{{ row.instance.repo }}</span> ·
          <a
            v-if="githubTreeUrl(row.instance.repo, row.unit.branch)"
            :href="githubTreeUrl(row.instance.repo, row.unit.branch)"
            target="_blank"
            rel="noopener noreferrer"
            >{{ row.unit.branch }}</a
          ><span v-else>{{ row.unit.branch }}</span>
          <a
            v-if="row.unit.pr"
            class="text-primary ml-2"
            :href="githubPrUrl(row.instance.repo, row.unit.pr.number) ?? undefined"
            target="_blank"
            rel="noopener noreferrer"
            >#{{ row.unit.pr.number }}</a
          >
        </p>
      </li>
    </ol>
  </section>
  <EmptyState
    v-if="!groups.length"
    :title="
      !history || history.status === 'unavailable'
        ? 'History is unavailable'
        : history.week
          ? 'No completed work in this week'
          : 'No completed work in this view'
    "
    :description="
      !history || history.status === 'unavailable'
        ? 'Completion history could not be loaded.'
        : 'No completed work was returned for this page.'
    "
  />
  <RouterLink v-if="olderHref" class="green-button" :to="olderHref" aria-label="Older work in this week"
    >Older work <UIcon name="i-lucide-arrow-right"
  /></RouterLink>
</template>
<style scoped>
.green-week-navigation {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}
.green-week-navigation h2 {
  font-size: 16px;
  font-weight: 600;
}
.green-history-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
}
.green-history-timeline li {
  padding: 18px 20px 18px 28px;
  border-bottom: 1px solid var(--ui-border);
  border-left: 3px solid var(--ui-primary);
  min-width: 0;
}
.green-history-timeline li:last-child {
  border-bottom: 0;
}
.green-history-timeline li a:hover {
  color: var(--ui-primary);
}
</style>
