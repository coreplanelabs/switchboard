<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import TimelineSection from "./TimelineSection.vue";
import { buildTimeline } from "../../lib/timelineVm";
import { createRunPageModel } from "../../lib/runPageModel";
import { parseSseReplay } from "../../lib/sseReplay";
import { browser } from "../../lib/browser";
import { runOwnerOf } from "@core/core/runOwner.js";
import { runDurationMs } from "@core/core/runDuration.js";
import { normalizeSpans, SPAN_SCHEMA } from "@core/core/normalizeSpans.js";
import type { RunEvent } from "@core/core/runEvents.js";
import type { UnitRunRowSeed } from "@core/channels/webSeed.js";

// Another run's timeline, in place (live-view item 28): a finished run listed
// on the unit page or under a conductor opens to the same "Where the time
// went" card its own page shows — the stored replay read once from
// `/runs/:id/events`, folded through the run page's one model and drawn by
// the run page's one timeline component, so the two pages cannot disagree.
// The page only ever hands a FINISHED run here: a live run's replay is its
// token-gated stream, and its row links to its live page instead.

const props = defineProps<{ run: UnitRunRowSeed; fetch?: typeof globalThis.fetch }>();

const state = ref<"loading" | "failed" | "ready">("loading");
const model = createRunPageModel();

const timeline = computed(() => {
  if (state.value !== "ready") return null;
  void model.state.traceVersion;
  const run = props.run;
  const start = run.receivedAt ?? run.startedAt;
  const totalMs = runDurationMs(run) ?? (run.finishedAt !== undefined ? Math.max(0, run.finishedAt - start) : 0);
  return buildTimeline({
    spans: model.spanSet(),
    losses: model.losses(start),
    window: { start, end: start + totalMs },
    owner: runOwnerOf(run.agent),
    totalMs,
    phase: "ended",
    delivery: { finishedAt: run.finishedAt, sealedAt: run.sealedAt, replyOk: run.replyOk },
    ...(run.truncated !== undefined ? { truncated: run.truncated } : {}),
    // A stored record from before span schema carries no timing (tracing.md),
    // the same rule the history page's seed applies.
    ...((run.schema ?? 0) >= SPAN_SCHEMA ? {} : { untimed: true }),
    callTitle: model.callHeadline,
  });
});

const eventsHref = computed(() => `/runs/${encodeURIComponent(props.run.id)}/events`);

/** A Longest-steps link names a row of the run's own page: open it there. */
function reveal(anchor: string): void {
  browser.navigate(`/runs/${encodeURIComponent(props.run.id)}#${anchor}`);
}

onMounted(async () => {
  const fetchFn = props.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));
  try {
    const res = await fetchFn(eventsHref.value, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const frames = parseSseReplay(await res.text());
    // The omission notices are the log's rows, not the timeline's: the fold
    // reads the record's `seq` gaps for what was not recorded.
    const events = frames.filter((f) => (f as { type: string }).type !== "replay_note") as RunEvent[];
    for (const e of (props.run.schema ?? 0) >= SPAN_SCHEMA ? normalizeSpans(events) : events) model.handle(e);
    model.closePhases();
    state.value = "ready";
  } catch {
    state.value = "failed";
  }
});
</script>

<template>
  <div class="runtimeline pl-5" :data-state="state">
    <p v-if="state === 'loading'" class="loading py-2 font-mono text-xs text-dimmed">reading the run's record…</p>
    <p v-else-if="state === 'failed'" class="failed py-2 font-mono text-xs text-warn">
      the run's record could not be read —
      <a class="text-primary no-underline hover:underline" :href="`/runs/${encodeURIComponent(run.id)}`"
        >open the run</a
      >
    </p>
    <TimelineSection v-else-if="timeline" :vm="timeline" :events-href="eventsHref" @reveal="reveal" />
  </div>
</template>
