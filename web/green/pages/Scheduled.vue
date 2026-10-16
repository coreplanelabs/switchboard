<script setup lang="ts">
defineOptions({ name: "GreenScheduledPage" });
import { formatLocalIso } from "../../src/lib/format";
import { useSeed } from "../../src/lib/seed";
import { formatRelative, OUTCOME_LABEL, ACTION_LABEL } from "@core/channels/scheduledPanel.js";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
const seed = useSeed("scheduled");
</script>
<template>
  <PageHeading title="Scheduled work" description="See armed schedules, their next firing, and the last result." />
  <p v-if="seed?.firingsUnavailable" class="green-notice green-warning" role="status">{{ seed.firingsUnavailable }}</p>
  <section class="green-section">
    <div class="green-section-heading"><h2>Schedules</h2></div>
    <ul v-if="seed?.rows?.length" class="list-none p-0 m-0">
      <li v-for="row in seed.rows" :key="row.name" class="p-5 border-b border-muted last:border-0">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-sm font-medium">{{ row.name }}</h3>
          <span class="green-badge">{{ row.worker }}</span>
        </div>
        <p class="text-xs text-muted mt-1">{{ row.description }}</p>
        <dl class="grid sm:grid-cols-[130px_minmax(0,1fr)] text-xs gap-2 mt-4">
          <dt class="text-muted">Schedule</dt>
          <dd class="font-mono">{{ row.cron }} UTC</dd>
          <dt class="text-muted">Next</dt>
          <dd>
            <time
              v-if="row.nextFireAt !== undefined"
              :datetime="new Date(row.nextFireAt).toISOString()"
              :title="formatLocalIso(row.nextFireAt)"
              >{{ formatRelative(row.nextFireAt, seed.now) }}</time
            ><span v-else>No next firing</span>
          </dd>
          <dt class="text-muted">Action</dt>
          <dd>
            {{
              row.action.type === "run"
                ? `${row.action.command} · ${row.action.identity}`
                : ACTION_LABEL[row.action.type]
            }}
          </dd>
          <template v-if="row.last"
            ><dt class="text-muted">Last result</dt>
            <dd>
              {{ OUTCOME_LABEL[row.last.outcome] }} ·
              <time :datetime="new Date(row.last.firedAt).toISOString()" :title="formatLocalIso(row.last.firedAt)">{{
                formatRelative(row.last.firedAt, seed.now)
              }}</time
              ><RouterLink v-if="row.last.runHref" class="text-primary ml-2" :to="row.last.runHref"
                >Run details →</RouterLink
              >
              <span v-else-if="row.last.runId" class="block font-mono break-all">Run {{ row.last.runId }}</span>
              <p v-if="row.last.detail" class="mt-1 whitespace-pre-wrap">{{ row.last.detail }}</p>
              <span v-if="row.last.traceId" class="block font-mono mt-1 text-muted">Trace {{ row.last.traceId }}</span>
            </dd></template
          ><template v-else
            ><dt class="text-muted">Last result</dt>
            <dd>
              {{ seed.firingsUnavailable ? "Unknown: firing history is unavailable" : "No firing recorded" }}
            </dd></template
          >
        </dl>
      </li>
    </ul>
    <EmptyState v-else :title="!seed || seed.rows === null ? 'Schedule registry unavailable' : 'No schedules'" />
  </section>
</template>
