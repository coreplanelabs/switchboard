<script setup lang="ts">
defineOptions({ name: "GreenRuntimePage" });
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
import ResidentRow from "../../src/components/residents/ResidentRow.vue";
import StatusDot from "../../src/components/StatusDot.vue";
import { useSeed } from "../../src/lib/seed";
import { useWallClock } from "../../src/lib/wallClock";
import { browser } from "../../src/lib/browser";
import { EVENT_SOURCE_CLOSED, useEventSourceFactory, type EventSourceLike } from "../../src/lib/eventSource";
import {
  applyResidentsFrame,
  rec,
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
  draining: seed?.draining ?? null,
  residents: seed?.residents ?? [],
  repositories: seed?.repositories ?? [],
  runs: new Map((seed?.runs ?? []).map((r) => [r.id, r])),
});

const now = useWallClock(seed?.now);
const conn = ref<{ tone: "green" | "amber" | "red"; text: string }>({ tone: "amber", text: "connecting…" });

// `?open=<slug>` opens that resident's fold on first paint.
const openSlug = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("open") : null;

const rows = computed(() =>
  [...state.residents, ...(state.repositories ?? [])].map((raw, i) => {
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
const drain = computed(() => (state.draining && typeof state.draining === "object" ? rec(state.draining) : null));
const drainHolds = computed(() =>
  Array.isArray(drain.value?.holds)
    ? drain.value.holds
        .filter((hold): hold is string => typeof hold === "string")
        .map((hold) => hold.replace(/^repo:/, ""))
    : [],
);
/** Runs on the residents listed — a repo run whose resident is not (yet) listed is not counted. */
const running = computed(() => rows.value.reduce((n, r) => n + r.runs.length, 0));

// The tab carries the count and the fleet's tone (live-view item 21): the
// same worst-of rule the shell painted from the seed, repainted from each
// listing frame — the page is no longer a snapshot.
const title = "Repositories";
watch(
  [running, () => state.residents],
  ([live, residents]) => {
    if (!seed) return;
    browser.setTitle((live > 0 ? `(${live}) ` : "") + title);
    browser.setFavicon(FAVICON_BY_TONE[residentsFleetTone(residents as ResidentRecordView[])]);
  },
  { immediate: true },
);

const makeEventSource = useEventSourceFactory();
let es: EventSourceLike | null = null;

onMounted(() => {
  if (!seed) return;
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
  <PageHeading title="Runtime" description="Inspect repository environments, active worktrees, and recovery state."
    ><span v-if="seed" class="green-badge"
      ><StatusDot :tone="conn.tone" :label="conn.text" />{{ conn.text }}</span
    ></PageHeading
  >
  <nav class="green-tabs" aria-label="Settings sections">
    <RouterLink to="/settings/channels">Channels</RouterLink><RouterLink to="/settings/mcps">MCP servers</RouterLink
    ><RouterLink to="/settings/identities">Identities</RouterLink
    ><RouterLink to="/settings/runtime" aria-current="page">Runtime</RouterLink
    ><RouterLink to="/settings/installation">Installation</RouterLink>
  </nav>
  <template v-if="seed">
    <p v-if="drain" class="green-notice green-warning" role="status">
      Deployment drain · {{ str(drain.reason) || "New work waits until the runtime reopens."
      }}<span v-if="drainHolds.length"> · Waiting for images: {{ drainHolds.join(", ") }}</span
      ><span v-if="str(drain.holdsUntil)"> · Hold ends by {{ str(drain.holdsUntil) }}</span>
    </p>
    <div class="green-stat-grid">
      <div class="green-stat">
        <span class="text-xs text-muted">Environment slots</span>
        <p class="text-2xl text-highlighted mt-2">{{ count }} / {{ cap }}</p>
      </div>
      <div class="green-stat">
        <span class="text-xs text-muted">Active runs</span>
        <p class="text-2xl text-highlighted mt-2">{{ running }}</p>
      </div>
      <div class="green-stat">
        <span class="text-xs text-muted">Cold repositories</span>
        <p class="text-2xl text-highlighted mt-2">{{ state.repositories?.length ?? 0 }}</p>
      </div>
    </div>
    <section class="green-section">
      <div class="green-section-heading"><h2>Repository environments</h2></div>
      <ul v-if="rows.length" class="list-none p-0 m-0">
        <ResidentRow
          v-for="row in rows"
          :key="row.key"
          :record="row.record"
          :runs="row.runs"
          :now="now"
          :open="openSlug === row.slug"
        />
      </ul>
      <EmptyState
        v-else
        title="No repositories onboarded"
        description="Onboard a repository to give its units a retained work environment."
      />
    </section>
  </template>
  <section v-else class="green-section">
    <EmptyState
      title="Runtime unavailable"
      description="Runtime data could not be loaded. Repository and run counts cannot be confirmed."
    />
  </section>
</template>
