<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import AppShell from "../components/AppShell.vue";
import ResidentRow from "../components/residents/ResidentRow.vue";
import StatusDot from "../components/StatusDot.vue";
import { useSeed } from "../lib/seed";
import { useWallClock } from "../lib/wallClock";
import { browser } from "../lib/browser";
import { EVENT_SOURCE_CLOSED, useEventSourceFactory, type EventSourceLike } from "../lib/eventSource";
import {
  applyResidentsFrame,
  residentSlug,
  residentsFleetTone,
  runsOnResident,
  str,
  type ResidentRecordView,
  type ResidentsIndexState,
} from "@core/channels/residentsModel.js";
import { FAVICON_BY_TONE } from "@core/channels/favicon.js";
import type { ResidentsFeedFrame } from "@core/channels/webSeed.js";

// The residents index (resident-repos item 42): every onboarded repo, its
// lifecycle state and why, what it is warm on — and, folded open, the runs on
// it right now with their worktrees and the disk they take. The seed is the
// admin /residents listing (read live by the server) plus the registry's live
// repo runs; the `/residents?stream=1` feed then keeps both current: run rows
// as the registry publishes them, the listing whenever a tree changes hands
// (a run's attach ended, a run's stream sealed). No timer re-reads anything;
// the stopwatches tick from the shared wall clock.

const seed = useSeed("residents");

const state = reactive<ResidentsIndexState>({
  cap: seed?.cap,
  count: seed?.count,
  residents: seed?.residents ?? [],
  runs: new Map((seed?.runs ?? []).map((r) => [r.id, r])),
});

const now = useWallClock(seed?.now);
const conn = ref<{ tone: "green" | "amber" | "red"; text: string }>({ tone: "amber", text: "connecting…" });

// `?open=<slug>` opens that resident's fold on first paint.
const openSlug = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("open") : null;

const rows = computed(() =>
  state.residents.map((raw, i) => {
    const record = raw as ResidentRecordView;
    const slug = residentSlug(record);
    return {
      key: `${slug || "?"}-${i}`,
      record,
      slug,
      runs: runsOnResident(state.runs.values(), slug),
    };
  }),
);
const cap = computed(() => str(state.cap) || "?");
const count = computed(() => str(state.count) || String(rows.value.length));
/** Runs on the residents listed — a repo run whose resident is not (yet) listed is not counted. */
const running = computed(() => rows.value.reduce((n, r) => n + r.runs.length, 0));

// The tab carries the count and the fleet's tone (live-view item 21): the
// same worst-of rule the shell painted from the seed, repainted from each
// listing frame — the page is no longer a snapshot.
const title = "Resident repos";
watch(
  [running, () => state.residents],
  ([live, residents]) => {
    browser.setTitle((live > 0 ? `(${live}) ` : "") + title);
    browser.setFavicon(FAVICON_BY_TONE[residentsFleetTone(residents as ResidentRecordView[])]);
  },
  { immediate: true },
);

const makeEventSource = useEventSourceFactory();
let es: EventSourceLike | null = null;

onMounted(() => {
  es = makeEventSource("/residents?stream=1");
  // A RE-connect means the backend may have restarted: run rows this page
  // holds may no longer exist there, and nothing will ever send their
  // `removed` events. Reload for a fresh server snapshot instead of drifting.
  let everOpened = false;
  es.onopen = () => {
    if (everOpened) {
      browser.reload();
      return;
    }
    everOpened = true;
    conn.value = { tone: "green", text: "live" };
  };
  es.onmessage = (m) => {
    let frame: ResidentsFeedFrame;
    try {
      frame = JSON.parse(m.data) as ResidentsFeedFrame;
    } catch {
      return;
    }
    applyResidentsFrame(state, frame);
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
  <AppShell :title="title" nav="residents">
    <template #status>
      <UTooltip text="runs arrive from the registry feed; the listing is re-read when a run attaches or ends">
        <span class="conn flex items-center gap-1.5">
          <StatusDot :tone="conn.tone" :label="conn.text" />
          <span id="state" class="text-xs text-muted">{{ conn.text }}</span>
        </span>
      </UTooltip>
    </template>

    <template v-if="rows.length > 0">
      <p class="mb-2 text-xs text-muted">
        {{ `${count}/${cap} resident slots in use · `
        }}<span id="running" class="font-mono tabular-nums">{{ running }} running</span>
      </p>
      <ul id="residents" class="m-0 list-none p-0">
        <ResidentRow
          v-for="row in rows"
          :key="row.key"
          :record="row.record"
          :runs="row.runs"
          :now="now"
          :open="openSlug !== null && openSlug === row.slug"
        />
      </ul>
    </template>
    <p v-else class="px-2 py-1.5 text-muted">
      No repos onboarded (0/{{ cap }}). Onboard one from chat:
      <code class="rounded bg-elevated px-1.5 py-0.5">repo onboard &lt;owner/name&gt;</code>.
    </p>
  </AppShell>
</template>
