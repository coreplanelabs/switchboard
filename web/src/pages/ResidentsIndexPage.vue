<script setup lang="ts">
import { computed } from "vue";
import AppShell from "../components/AppShell.vue";
import StatusDot from "../components/StatusDot.vue";
import { useSeed } from "../lib/seed";
import {
  RESIDENT_SLUG_RE,
  residentLive,
  residentSlug,
  residentStateTone,
  str,
  type ResidentRecordView,
} from "@core/channels/residentsModel.js";

// The residents index: every onboarded repo, its lifecycle state and why,
// what it is warm on, each row linking to its detail page. The seed is the
// admin /residents listing, read live per request by the server.

const seed = useSeed("residents");

const rows = computed(() =>
  (seed?.residents ?? []).map((raw, i) => {
    const record = raw as ResidentRecordView;
    const slug = residentSlug(record);
    const live = residentLive(record);
    const sha = str(live.sha);
    return {
      key: `${slug || "?"}-${i}`,
      display: slug || str(record.resource) || "?",
      state: live.state,
      tone: residentStateTone(live.state),
      reason: live.reason,
      ref: str(record.defaultRef) || "?",
      sha: sha ? sha.slice(0, 8) : "",
      refreshed: str(live.lastRefreshAt),
      href: RESIDENT_SLUG_RE.test(slug) ? `/residents/${slug}` : null,
    };
  }),
);

const cap = computed(() => str(seed?.cap) || "?");
const count = computed(() => str(seed?.count) || String(rows.value.length));
</script>

<template>
  <AppShell title="Resident repos" nav="residents">
    <template v-if="rows.length > 0">
      <p class="mb-2 text-xs text-muted">{{ count }}/{{ cap }} resident slots in use · live registry read, not cached</p>
      <ul class="m-0 list-none p-0">
        <li v-for="row in rows" :key="row.key" class="border-b border-muted first:border-t">
          <component
            :is="row.href ? 'a' : 'span'"
            class="row flex flex-wrap items-center gap-2.5 rounded-md px-2 py-1.5 text-inherit no-underline"
            :class="row.href ? 'hover:bg-elevated' : ''"
            :href="row.href ?? undefined"
          >
            <StatusDot :tone="row.tone" :label="row.state" :tip="row.state" />
            <span class="font-semibold text-primary">{{ row.display }}</span>
            <span class="font-semibold">{{ row.state }}</span>
            <span class="text-xs text-muted">
              ref {{ row.ref }}<template v-if="row.sha"> · sha {{ row.sha }}</template
              ><template v-if="row.refreshed"> · refreshed {{ row.refreshed }}</template>
            </span>
            <span v-if="row.reason" class="basis-full pl-5 text-xs text-warning">{{ row.reason }}</span>
          </component>
        </li>
      </ul>
    </template>
    <p v-else class="px-2 py-1.5 text-muted">
      No repos onboarded (0/{{ cap }}). Onboard one from chat:
      <code class="rounded bg-elevated px-1.5 py-0.5">repo onboard &lt;owner/name&gt;</code>.
    </p>
  </AppShell>
</template>
