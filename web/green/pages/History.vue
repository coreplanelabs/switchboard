<script setup lang="ts">
defineOptions({ name: "GreenHistoryPage" });
import { inject } from "vue";
import type { HomeHistorySeed } from "@core/channels/homeSeed.js";
import { SeedKey } from "../../src/lib/seed";
import { githubPrUrl } from "../../src/lib/githubLinks";
import { endingWordOf } from "@core/core/pipelineStanding.js";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
const seed = inject(SeedKey, null) as unknown as HomeHistorySeed | null;
const history = seed?.history;
</script>
<template>
  <PageHeading title="Completed work" description="Completed units are separate from the unresolved work on Home."
    ><RouterLink class="green-button" to="/home"><UIcon name="i-lucide-arrow-left" />Home</RouterLink></PageHeading
  >
  <p v-if="history?.status === 'partial'" class="green-notice green-warning" role="status">
    Some history could not be loaded. This view is incomplete.
  </p>
  <p class="text-xs text-muted mb-4">Only work available under your current access is shown.</p>
  <section class="green-section">
    <div class="green-section-heading"><h2>Completed units</h2></div>
    <ul v-if="history?.units.length" class="list-none p-0 m-0">
      <li v-for="row in history.units" :key="row.unit.unit" class="p-5 border-b border-muted last:border-0">
        <div class="flex justify-between gap-3">
          <RouterLink
            class="font-medium text-highlighted break-words"
            :to="`/runs/unit/${encodeURIComponent(row.unit.unit)}`"
            >{{ row.unit.title ?? `Unit ${row.unit.id}` }}</RouterLink
          ><span class="green-badge self-start">{{
            row.unit.ending ? endingWordOf(row.unit.ending.kind) : "Completed"
          }}</span>
        </div>
        <p class="text-xs text-muted mt-2 break-all">
          {{ row.instance.repo }} · {{ row.unit.branch
          }}<a
            v-if="row.unit.pr"
            class="text-primary ml-2"
            :href="githubPrUrl(row.instance.repo, row.unit.pr.number) ?? undefined"
            >#{{ row.unit.pr.number }}</a
          >
        </p>
      </li>
    </ul>
    <EmptyState
      v-else
      :title="
        !history || history.status === 'unavailable' ? 'History is unavailable' : 'No completed work in this view'
      "
      :description="
        !history || history.status === 'unavailable'
          ? 'The server did not supply a complete history result.'
          : 'No completed units were returned for this authorized page.'
      "
    />
  </section>
  <RouterLink
    v-if="history?.cursor"
    class="green-button"
    :to="`/home/history?cursor=${encodeURIComponent(history.cursor)}`"
    >Older work <UIcon name="i-lucide-arrow-right"
  /></RouterLink>
</template>
