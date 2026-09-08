<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import AppShell from "../components/AppShell.vue";
import RunsTabs from "../components/runs/RunsTabs.vue";
import RunRow from "../components/runs/RunRow.vue";
import StatusDot from "../components/StatusDot.vue";
import { useSeed } from "../lib/seed";
import { useWallClock } from "../lib/wallClock";
import { browser } from "../lib/browser";
import { EVENT_SOURCE_CLOSED, useEventSourceFactory, type EventSourceLike } from "../lib/eventSource";
import { expiresAt, feedAction, LEAVING_WINDOW_MS, mergeRow, type IndexRow } from "../lib/indexRow";
import { formatDateTime } from "../lib/format";
import { retentionSentence } from "@core/channels/webSeed.js";
import { FAVICON_IDLE, FAVICON_LIVE } from "@core/channels/favicon.js";

// The runs index: the server-seeded snapshot kept live by the index SSE feed.
// The default view is the live registry only (R11); ?all=1 merges finished +
// persisted rows in and pages by the service cursor. Reconciliation and the
// repaint merge live in lib/indexRow.ts (feedAction / mergeRow).

const seed = useSeed("runs");
const showAll = seed?.all ?? false;
const paged = seed?.olderThan !== undefined;
const retentionDays = seed?.retentionDays ?? null;
const retentionMs = retentionDays !== null ? retentionDays * 86_400_000 : undefined;
const retention = retentionSentence(retentionDays);

const rows = reactive(new Map<string, IndexRow>());
for (const r of seed?.rows ?? []) rows.set(r.id, r);

const now = useWallClock(seed?.now);
const conn = ref<{ tone: "green" | "amber" | "red"; text: string }>({ tone: "amber", text: "connecting…" });

// Newest-first by start stamp — startedAt is immutable, so an update never
// reorders the list (the sort is stable).
const ordered = computed(() => [...rows.values()].sort((a, b) => b.startedAt - a.startedAt));
const liveCount = computed(() => ordered.value.filter((r) => !r.finished).length);

// The expiry cut (item 20): one divider before the first row leaving within a
// day — rows are newest-first, so everything under it leaves too.
const dividerIndex = computed(() => {
  if (retentionMs === undefined) return -1;
  return ordered.value.findIndex((r) => {
    const e = expiresAt(r, retentionMs);
    return e !== undefined && e - now.value <= LEAVING_WINDOW_MS;
  });
});
const beforeDivider = computed(() =>
  dividerIndex.value === -1 ? ordered.value : ordered.value.slice(0, dividerIndex.value),
);
const afterDivider = computed(() => (dividerIndex.value === -1 ? [] : ordered.value.slice(dividerIndex.value)));

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
  // The completed toggle switches the server view (R11): a change navigates.
  browser.navigate((ev.target as HTMLInputElement).checked ? "/runs?all=1" : "/runs");
}

const olderThanLabel = computed(() => (seed?.olderThan !== undefined ? formatDateTime(seed.olderThan, now.value) : ""));

const makeEventSource = useEventSourceFactory();
let es: EventSourceLike | null = null;

onMounted(() => {
  es = makeEventSource(showAll ? "/runs?stream=1&all=1" : "/runs?stream=1");
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
  <AppShell :title="title" nav="runs">
    <template #status>
      <span class="conn flex items-center gap-1.5">
        <StatusDot :tone="conn.tone" :label="conn.text" />
        <span id="state" class="text-xs text-muted">{{ conn.text }}</span>
      </span>
    </template>

    <RunsTabs current="runs" />

    <div class="toolbar mb-1.5 flex items-center gap-4 px-2 text-xs text-muted">
      <span id="livecount" class="count tabular-nums">{{ liveCount }} running</span>
      <span class="filter ml-auto inline-flex items-center gap-1.5">
        <label
          class="toggle inline-flex cursor-pointer select-none items-center gap-1.5 text-toned hover:text-highlighted"
        >
          <input
            id="showdone"
            type="checkbox"
            class="accent-green-600"
            :checked="showAll"
            aria-describedby="retention"
            @change="onToggleCompleted"
          />
          Show completed
        </label>
        <UTooltip :text="retention">
          <span
            class="help inline-flex size-[1.1em] cursor-help items-center justify-center rounded-full border border-accented text-[0.7rem] leading-none text-dimmed hover:border-(--ui-text-dimmed) hover:text-toned"
            tabindex="0"
            >?</span
          >
        </UTooltip>
        <span id="retention" class="sr-only">{{ retention }}</span>
      </span>
    </div>

    <p
      v-if="seed?.storeUnavailable"
      class="banner mb-3 rounded-md border border-warn px-2.5 py-1.5 text-[0.8rem] text-warn"
      role="status"
    >
      {{ seed.storeUnavailable }}
    </p>

    <ul id="runs" class="m-0 list-none border-t border-muted p-0">
      <RunRow v-for="run in beforeDivider" :key="run.id" :run="run" :now="now" :retention-ms="retentionMs" />
      <li
        v-if="afterDivider.length > 0"
        id="leaving"
        class="divider flex items-baseline gap-2 border-b border-dashed border-warn/40 px-2 pb-1.5 pt-3 text-[0.72rem] uppercase tracking-wider text-warn"
        role="separator"
      >
        <span aria-hidden="true" class="text-sm tracking-normal">⏳</span>
        <span class="whitespace-nowrap">Leaving within a day</span>
        <span class="normal-case tracking-normal text-dimmed max-sm:hidden">— each row says when it is removed</span>
      </li>
      <RunRow v-for="run in afterDivider" :key="run.id" :run="run" :now="now" :retention-ms="retentionMs" />
      <li v-if="ordered.length === 0" id="empty" class="empty px-2 py-2 text-muted">
        {{ showAll ? "No runs." : "No active runs." }}
      </li>
    </ul>

    <nav
      v-if="showAll && (seed?.olderHref || seed?.olderThan !== undefined)"
      class="pager mt-3 flex items-baseline gap-2 px-2 text-[0.8rem] text-muted"
      aria-label="Completed runs pages"
    >
      <template v-if="seed?.olderThan !== undefined">
        <a class="text-primary hover:underline" href="/runs?all=1">← Newest runs</a>
        <span class="range tabular-nums text-dimmed">· runs finished before {{ olderThanLabel }}</span>
      </template>
      <a v-if="seed?.olderHref" class="older ml-auto text-primary hover:underline" :href="seed.olderHref"
        >Older runs →</a
      >
    </nav>
  </AppShell>
</template>
