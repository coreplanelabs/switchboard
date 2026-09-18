<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import StepBlock from "./StepBlock.vue";
import TimelineSection from "./TimelineSection.vue";
import { buildTimeline } from "../../lib/timelineVm";
import { createRunPageModel, type StepVm } from "../../lib/runPageModel";
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
//
// A search hit lands on its step (session-log item 11): handed the log turn
// the hit names (`land`), the fold draws that one step under the timeline
// with the run page's own StepBlock — anchored as the run page anchors it,
// `span-<turn span>` or `call-<id>` — scrolls to it and links to the run's
// page at the same anchor. The request row and the reply's are named, not
// drawn. A record whose events carry no log rows (one from before the stamp)
// lands nowhere: the fold opens as it always did.

const props = defineProps<{
  run: UnitRunRowSeed;
  /** The session-log turn to land on once the record is read (a search hit's, `?turn=`). */
  land?: number;
  fetch?: typeof globalThis.fetch;
}>();

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
const pageHref = (anchor: string) => `/runs/${encodeURIComponent(props.run.id)}#${anchor}`;

/** A Longest-steps link names a row of the run's own page: open it there. */
function reveal(anchor: string): void {
  browser.navigate(pageHref(anchor));
}

interface Landing {
  anchor: string;
  /** What the turn is, in the fold's words: the request, the reply, or the step's head. */
  what: string;
  step?: StepVm;
}

/** Where the turn lives in this run: the request row and the reply's by the
 *  seed's own range (the reply is the range's last row, when the run replied),
 *  every other row by the record's stamps through the model. */
const landing = computed<Landing | null>(() => {
  if (state.value !== "ready" || props.land === undefined) return null;
  void model.state.traceVersion;
  const turn = props.land;
  const session = props.run.session;
  if (session && turn === session.request) return { anchor: "request", what: "the request" };
  const last = session && session.range !== "broken" ? session.range.to : undefined;
  if (last !== undefined && turn === last && model.state.reply) return { anchor: "reply", what: "the reply" };
  const at = model.landing(turn);
  if (!at) return null;
  return { anchor: at.anchor, what: stepWords(at.step), step: at.step };
});

/** A step in the words its head and its cards use: the turn's chip, the first card's headline. */
function stepWords(step: StepVm): string {
  const first = step.items.find((i) => i.kind === "call");
  const call = first?.kind === "call" ? first.call.headline : undefined;
  const thought = step.turn ? `thought ${step.turn.chip}` : undefined;
  return [thought, call].filter((w) => w !== undefined).join(" · ") || `step ${step.index + 1}`;
}

const landingEl = ref<HTMLElement | null>(null);

/** The landing's identity — the turn and where it landed. The scroll keys on
 *  this, never on the computed's object, so a re-evaluation that moves nothing
 *  (a toggle inside the landed step, a late frame) scrolls and flashes nothing. */
const landedAt = computed(() => (landing.value ? `${props.land}@${landing.value.anchor}` : null));

/** Scroll to the landed step and flash it once (`revealed`, web/src/style.css);
 *  the request and the reply, drawn nowhere in the fold, flash the landing line.
 *  The step is the landing's one `li.step`, found by its class and never by a
 *  selector built from the anchor: a provider's call id can carry characters
 *  no CSS selector accepts. */
watch(landedAt, (key) => {
  if (key === null) return;
  void nextTick().then(() => {
    const block = landing.value?.step ? landingEl.value?.querySelector<HTMLElement>("li.step") : null;
    const el = block ?? landingEl.value;
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    el.classList.add("revealed");
    setTimeout(() => el.classList.remove("revealed"), 1500);
  });
});

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
      <RouterLink class="text-primary no-underline hover:underline" :to="`/runs/${encodeURIComponent(run.id)}`"
        >open the run</RouterLink
      >
    </p>
    <template v-else-if="timeline">
      <TimelineSection :vm="timeline" :events-href="eventsHref" @reveal="reveal" />
      <!-- The step a search hit landed on: the run page's own block, at the run page's own anchor. -->
      <div
        v-if="landing"
        ref="landingEl"
        class="landing mb-4 rounded-lg border border-default px-(--sb-gutter) py-2"
        :data-turn="land"
        :data-anchor="landing.anchor"
      >
        <p class="landing-head flex flex-wrap items-baseline gap-x-2 font-mono text-xs text-muted">
          <span class="turn tabular-nums">turn {{ land }}</span>
          <span class="what min-w-0 truncate text-toned">· {{ landing.what }}</span>
          <RouterLink
            class="page ml-auto shrink-0 text-primary no-underline hover:underline"
            :to="pageHref(landing.anchor)"
            title="the same step on the run's own page"
            >open on the run's page ↗</RouterLink
          >
        </p>
        <ol v-if="landing.step" class="m-0 mt-1 list-none p-0">
          <StepBlock :step="landing.step" @toggle-group="model.toggleGroup(landing.step)" />
        </ol>
      </div>
    </template>
  </div>
</template>
