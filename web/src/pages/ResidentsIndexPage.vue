<script setup lang="ts">
import { computed } from "vue";
import AppShell from "../components/AppShell.vue";
import StatusDot from "../components/StatusDot.vue";
import { useSeed } from "../lib/seed";
import {
  RESIDENT_SLUG_RE,
  residentDisk,
  residentLive,
  residentSlug,
  residentStateTone,
  str,
  type ResidentRecordView,
} from "@core/channels/residentsModel.js";
import { formatDiskGauge } from "@core/execution/residentDiskBudget.js";
import { formatRelative } from "../lib/format";
import { wallNow } from "../lib/wallClock";

// The residents index: every onboarded repo, its lifecycle state and why,
// what it is warm on, each row linking to its detail page. The seed is the
// admin /residents listing, read live per request by the server.

const seed = useSeed("residents");

const now = wallNow(); // a snapshot page — one clock reading is the honest one

const rows = computed(() =>
  (seed?.residents ?? []).map((raw, i) => {
    const record = raw as ResidentRecordView;
    const slug = residentSlug(record);
    const live = residentLive(record);
    const sha = str(live.sha);
    const refreshed = str(live.lastRefreshAt);
    // "refreshed 3 hours ago" reads in a second; the exact stamp rides the hover.
    const refreshedAt = refreshed ? Date.parse(refreshed) : Number.NaN;
    // Item 55: the last disk sample's gauge — the same used/total (pct) reading
    // as `repo list` and the watchdog line; absent until the resident measures.
    const disk = residentDisk(record);
    return {
      key: `${slug || "?"}-${i}`,
      display: slug || str(record.resource) || "?",
      state: live.state,
      tone: residentStateTone(live.state),
      reason: live.reason,
      ref: str(record.defaultRef) || "?",
      sha: sha ? sha.slice(0, 8) : "",
      refreshed,
      refreshedLabel: Number.isFinite(refreshedAt) ? formatRelative(refreshedAt, now) : refreshed,
      disk: disk ? formatDiskGauge(disk) : "",
      diskAt: disk?.at ?? "",
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
      <p class="mb-2 text-xs text-muted">
        {{ count }}/{{ cap }} resident slots in use · live registry read, not cached
      </p>
      <ul class="m-0 list-none p-0">
        <li v-for="row in rows" :key="row.key" class="border-b border-muted first:border-t">
          <component
            :is="row.href ? 'a' : 'span'"
            class="row flex flex-wrap items-center gap-2.5 rounded-md px-2 py-1.5 text-inherit no-underline"
            :class="row.href ? 'hover:bg-elevated' : ''"
            :href="row.href ?? undefined"
          >
            <StatusDot :tone="row.tone" :label="row.state" :tip="row.state" />
            <span class="font-mono font-medium text-primary">{{ row.display }}</span>
            <span class="font-medium">{{ row.state }}</span>
            <!-- The facts wrap to their own indented line on a phone instead of
                 breaking mid-token at the left edge. -->
            <span
              class="font-mono text-xs text-muted max-sm:basis-full max-sm:pl-5"
              :title="row.refreshed || undefined"
            >
              ref {{ row.ref }}<template v-if="row.sha"> · sha {{ row.sha }}</template
              ><template v-if="row.refreshedLabel"> · refreshed {{ row.refreshedLabel }}</template
              ><template v-if="row.disk">
                · <span :title="row.diskAt ? `measured ${row.diskAt}` : undefined">disk {{ row.disk }}</span></template
              >
            </span>
            <span v-if="row.reason" class="basis-full pl-5 text-xs text-warn">{{ row.reason }}</span>
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
