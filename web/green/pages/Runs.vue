<script setup lang="ts">
defineOptions({ name: "GreenRunsPage" });
import { DAY_MS } from "@core/core/budgets.js";
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
import RunRow from "../../src/components/runs/RunRow.vue";
import StatusDot from "../../src/components/StatusDot.vue";
import { useSeed } from "../../src/lib/seed";
import { useWallClock } from "../../src/lib/wallClock";
import { browser } from "../../src/lib/browser";
import { EVENT_SOURCE_CLOSED, useEventSourceFactory, type EventSourceLike } from "../../src/lib/eventSource";
import {
  expiresAt,
  feedAction,
  groupRuns,
  LEAVING_WINDOW_MS,
  mergeRow,
  RUNS_PREF,
  type IndexRow,
} from "../../src/lib/indexRow";
import { formatDateTime } from "../../src/lib/format";
import { retentionSentence } from "@core/channels/webSeed.js";
import { FAVICON_IDLE, FAVICON_LIVE } from "@core/channels/favicon.js";

// The runs index: the server-seeded snapshot kept live by the index SSE feed.
// The default view is the live registry only; ?all=1 merges finished +
// persisted rows in and pages by the service cursor. Reconciliation and the
// repaint merge live in lib/indexRow.ts (feedAction / mergeRow).

const seed = useSeed("runs");
const showAll = seed?.all ?? false;
const params = new URLSearchParams(browser.search());
if (!params.has("all") && seed && browser.readPref(RUNS_PREF.all) === "1") browser.navigate("/runs?all=1");
function viewHref(all: boolean): string {
  return all ? "/runs?all=1" : "/runs";
}
const paged = seed?.olderThan !== undefined;
const retentionDays = seed?.retentionDays ?? null;
const retentionMs = retentionDays !== null ? retentionDays * DAY_MS : undefined;
const retention = retentionSentence(retentionDays);

const rows = reactive(new Map<string, IndexRow>());
for (const r of seed?.rows ?? []) rows.set(r.id, r);

const now = useWallClock(seed?.now);
const conn = ref<{ tone: "green" | "amber" | "red"; text: string }>({ tone: "amber", text: "connecting…" });

// The index's order (live-view items 32 and 33): a pipeline's runs nest under
// their parent's row (`groupRuns`); stalled groups first — a run with no tool
// call for the whole pace window is the row to look at, so it never hides
// below newer healthy ones — then newest-first by the head's start stamp
// (immutable; the sort is stable, so a repaint only reorders when a row's
// stall state changes).
const showBookkeeping = ref(false);
const visibleRows = computed(() =>
  [...rows.values()].filter((r) => showBookkeeping.value || (r.agent !== "command" && r.agent !== "door")),
);
const groups = computed(() => groupRuns(visibleRows.value, now.value));
const liveCount = computed(() => visibleRows.value.filter((r) => !r.finished).length);

// The expiry cut (item 20): one divider before the first group whose HEAD
// leaves within a day — heads are newest-first, so every head under it leaves
// too; a nested row leaving on its own schedule wears its own `gone …` cell.
const dividerIndex = computed(() => {
  if (retentionMs === undefined) return -1;
  return groups.value.findIndex((g) => {
    const e = expiresAt(g.head, retentionMs);
    return e !== undefined && e - now.value <= LEAVING_WINDOW_MS;
  });
});
const beforeDivider = computed(() =>
  dividerIndex.value === -1 ? groups.value : groups.value.slice(0, dividerIndex.value),
);
const afterDivider = computed(() => (dividerIndex.value === -1 ? [] : groups.value.slice(dividerIndex.value)));

// The tab bar carries the live count too (item 21): "(n) <title>" and the
// green/idle dot favicon, from the same count the toolbar shows.
const title = showAll ? "All runs" : "Live runs";
watch(
  liveCount,
  (live) => {
    browser.setTitle((live > 0 ? `(${live}) ` : "") + title);
    browser.setFavicon(live > 0 ? FAVICON_LIVE : FAVICON_IDLE);
  },
  { immediate: true },
);

function onToggleCompleted(ev: Event): void {
  // The toggles switch the server view: a change is remembered and navigates, keeping the other toggle.
  const on = (ev.target as HTMLInputElement).checked;
  browser.writePref(RUNS_PREF.all, on ? "1" : "0");
  browser.navigate(viewHref(on));
}
const olderThanLabel = computed(() => (seed?.olderThan !== undefined ? formatDateTime(seed.olderThan, now.value) : ""));

const makeEventSource = useEventSourceFactory();
let es: EventSourceLike | null = null;

onMounted(() => {
  if (!seed) return;
  es = makeEventSource(`/runs?stream=1${showAll ? "&all=1" : ""}`);
  // A RE-connect means the backend may have restarted: rows this page holds
  // may no longer exist there, and nothing will ever send their `removed`
  // events. Reload for a fresh server snapshot instead of drifting.
  let everOpened = false;
  es.onopen = () => {
    if (everOpened) {
      browser.reload();
      return;
    }
    everOpened = true;
    conn.value = { tone: "green", text: "connected" };
  };
  es.onmessage = (m) => {
    let ev: { type?: string; run?: IndexRow; id?: string };
    try {
      ev = JSON.parse(m.data) as typeof ev;
    } catch {
      return;
    }
    const id = ev.type === "removed" ? ev.id : ev.run?.id;
    const existing = id ? rows.get(id) : undefined;
    // A cursor page only repaints rows it already has — a run starting or
    // finishing now belongs on the newest page.
    if (paged && !existing) return;
    const act = feedAction(ev, showAll, existing?.persisted === true);
    if (act.op === "upsert") rows.set(act.run.id, mergeRow(rows.get(act.run.id), act.run));
    else if (act.op === "remove") rows.delete(act.id);
  };
  es.onerror = () => {
    if (es && es.readyState === EVENT_SOURCE_CLOSED) conn.value = { tone: "red", text: "disconnected" };
    else conn.value = { tone: "amber", text: "connecting…" };
  };
});

onUnmounted(() => {
  es?.close();
});
</script>
<template>
  <PageHeading title="Run details" description="Inspect live execution and retained run evidence."
    ><span class="green-badge"><StatusDot :tone="conn.tone" :label="conn.text" />{{ conn.text }}</span></PageHeading
  >
  <div class="green-toolbar">
    <span class="text-xs text-muted">{{ liveCount }} running</span
    ><label class="text-xs flex items-center gap-2 min-h-10"
      ><input type="checkbox" :checked="showAll" @change="onToggleCompleted" />Include completed</label
    ><label class="text-xs flex items-center gap-2 min-h-10"
      ><input v-model="showBookkeeping" type="checkbox" />Include system runs</label
    >
  </div>
  <p v-if="seed?.storeUnavailable" class="green-notice green-warning" role="status">{{ seed.storeUnavailable }}</p>
  <p v-if="paged" class="text-xs text-muted mb-4">Finished before {{ olderThanLabel }}</p>
  <section class="green-section">
    <div class="green-section-heading">
      <h2>{{ showAll ? "Live and completed" : "Live execution" }}</h2>
    </div>
    <EmptyState
      v-if="!seed"
      title="Run data is unavailable"
      description="This view cannot confirm live or retained execution."
    />
    <ul v-else-if="groups.length" id="runs" class="list-none p-0 m-0">
      <template v-for="group in beforeDivider" :key="group.head.id"
        ><RunRow :run="group.head" :now="now" :retention-ms="retentionMs" :children="group.children" /><RunRow
          v-for="child in group.children"
          :key="child.id"
          :run="child"
          :now="now"
          :retention-ms="retentionMs"
          :nested-under="group.head.id"
      /></template>
      <li v-if="afterDivider.length" class="p-4 text-xs text-warn">
        The following retained runs expire within one day.
      </li>
      <template v-for="group in afterDivider" :key="group.head.id"
        ><RunRow :run="group.head" :now="now" :retention-ms="retentionMs" :children="group.children" /><RunRow
          v-for="child in group.children"
          :key="child.id"
          :run="child"
          :now="now"
          :retention-ms="retentionMs"
          :nested-under="group.head.id"
      /></template>
    </ul>
    <EmptyState
      v-else
      :title="showAll ? 'No retained runs in this view' : 'No runs are live'"
      description="Durable unresolved work remains visible on Home even when its latest run has ended."
    />
  </section>
  <RouterLink v-if="seed?.olderHref" class="green-button" :to="seed.olderHref"
    >Older runs <UIcon name="i-lucide-arrow-right"
  /></RouterLink>
  <p class="text-xs text-muted mt-5">{{ retention }}</p>
</template>
