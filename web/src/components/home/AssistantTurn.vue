<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from "vue";
import type { HomeTurnSeed } from "@core/channels/webSeed.js";
import type { RunEvent } from "@core/core/runEvents.js";
import { normalizeSpans, SPAN_SCHEMA } from "@core/core/normalizeSpans.js";
import MarkdownText from "../MarkdownText.vue";
import StepBlock from "../run/StepBlock.vue";
import ReceiptChip from "./ReceiptChip.vue";
import { formatDuration } from "../../lib/format";
import { AGENT_HUE, agentHue, statusLabel } from "../../lib/indexRow";
import { durationTone, heatStyle } from "../../lib/durationTone";
import { parseSseReplay } from "../../lib/sseReplay";
import { useEventSourceFactory } from "../../lib/eventSource";
import { attachRunStream, type StreamPhase } from "../../lib/runStream";
import { thinkingVerb } from "../../lib/thinkingVerbs";
import PendingTurnRow from "../run/PendingTurnRow.vue";
import {
  createRunClock,
  createRunPageModel,
  liveWait,
  modelName,
  runnerNow,
  RunnerClockKey,
  ArtifactLinksKey,
  ReplyLandedKey,
} from "../../lib/runPageModel";

// An assistant turn IS a run (docs/reference/specs/web-chat.md items 4–6; record
// 0043, "A turn is a run"): one `createRunPageModel`, the run page's own fold,
// fed by the run's live stream while the run works and by its stored replay
// when a finished turn's work is opened. In-progress draws where it ends up
// (rule 4): the turn is the pending row from its first frame — ∿, the model's
// real name, a rotating verb, the elapsed — and becomes the finished turn in
// place as the reply lands. Closed, a finished turn is the receipt, the reply
// and one line of facts; its work folds open under it as the run page's own
// step blocks. No status word of the chat's own appears here.

const props = defineProps<{
  turn: HomeTurnSeed;
  /** The page's ticking wall clock. */
  now: number;
  /** A live turn's stream and stop routes (from the seed's token or a `202`). */
  live?: { eventsUrl: string; stopUrl: string; serverNow?: number } | null;
  fetch?: typeof globalThis.fetch;
}>();
const emit = defineEmits<{
  /** The stream reached `end` (or dropped): the conversation has no live run in this turn any more. */
  ended: [];
  /** A follow-up the run drained from its inbox (the `input` event): its text and when. */
  input: [text: string, at: number | undefined];
  /** The stop route to call while this turn is live. */
  stop: [url: string];
}>();

const model = createRunPageModel();
const state = model.state;
const phase = ref<StreamPhase>(props.live ? "connecting" : "ended");
const route = ref<{ preset: string; reason: string } | null>(props.turn.route ?? null);
const firstInput = ref(true);

/** The reply: the stream's, else the seed's. */
const answer = computed(() => state.reply?.text ?? props.turn.answer ?? "");
const agentLabel = computed(() => state.meta?.agent ?? props.turn.agent ?? "");
/** The model's real name once the run has said it (`run_meta`) or the record carries it; nothing before. */
const model_ = computed(() => {
  const ref = state.meta?.model ?? props.turn.model;
  return ref ? modelName(ref) : "";
});
/** The run is still the conversation's live one until its stream says `end`: a
 *  dropped stream (`disconnected`) keeps the turn live, so the composer stays
 *  `steer` and the page never treats a working run as over (record 0043, "A
 *  turn is a run", failure modes). */
const live = computed(() => props.live !== null && props.live !== undefined && phase.value !== "ended");
const disconnected = computed(() => phase.value === "disconnected");

// The turn's one clock: the run page's projected runner clock while live, the
// record's duration once over (one ticking number per in-flight thing).
const runClock = props.live?.serverNow
  ? createRunClock(
      { startedAt: props.turn.startedAt, receivedAt: props.turn.receivedAt, serverNow: props.live.serverNow },
      props.now,
    )
  : null;
const sentAt = props.now;
const frozenMs = ref<number | undefined>(undefined);
const elapsedMs = computed(() => {
  if (props.turn.finished && props.turn.finishedAt !== undefined)
    return Math.max(0, props.turn.finishedAt - (props.turn.receivedAt ?? props.turn.startedAt));
  if (frozenMs.value !== undefined) return frozenMs.value;
  return runClock ? runClock.elapsedMs(props.now) : Math.max(0, props.now - sentAt);
});
const elapsedText = computed(() => formatDuration(elapsedMs.value, "clock"));
const heat = computed(() => durationTone(live.value ? undefined : elapsedMs.value, "run"));
const heatPaint = computed(() => heatStyle(heat.value));

const runnerClock = computed(() => (live.value ? runnerNow(state, props.now) : null));
provide(RunnerClockKey, runnerClock);
provide(ArtifactLinksKey, null);
provide(
  ReplyLandedKey,
  computed(() => state.reply !== null),
);

// The pending row (the run page's own, PendingTurnRow) shows while the model is
// silent and nothing runs; its word is the shared list walked by the silence's length.
const waiting = computed(() => (live.value ? liveWait(state, model.pendingCall(), props.now) : null));
/** The pending row shows while the model is silent and nothing runs: before the
 *  first stamped event (`starting`) and between calls (`thinking`). A running
 *  call ticks in its own card instead. */
const pendingRow = computed(() => {
  const w = waiting.value;
  if (disconnected.value || !w || w.kind === "call") return null;
  if (w.kind === "starting") return { verb: "Starting", elapsedMs: elapsedMs.value, slow: false };
  return { verb: thinkingVerb(w.elapsedMs), elapsedMs: w.elapsedMs, slow: w.slow };
});

const steps = computed(() => state.log.filter((i) => i.kind === "step"));
const stepCount = computed(() => (steps.value.length > 0 ? steps.value.length : (props.turn.stepCount ?? 0)));
const outcome = computed(() =>
  props.turn.finished && props.turn.status && props.turn.status !== "completed" ? statusLabel(props.turn.status) : "",
);
const runHref = computed(() => `/runs/${encodeURIComponent(props.turn.id)}`);

// ---- the stream (live): the run page's own attach (web/src/lib/runStream.ts) ------
const makeEventSource = useEventSourceFactory();
let stream: ReturnType<typeof attachRunStream> | null = null;

function handle(e: unknown): void {
  const ev = e as { type?: string; text?: string; at?: number; preset?: string; reason?: string };
  if (ev.type === "route" && typeof ev.preset === "string") {
    route.value = { preset: ev.preset, reason: typeof ev.reason === "string" ? ev.reason : "" };
  }
  // The request's own `input` is the turn the page drew; every later one is a
  // follow-up the run drained (thread-admission.md item 2), which confirms the
  // person's turn already standing.
  if (ev.type === "input" && typeof ev.text === "string") {
    if (firstInput.value) firstInput.value = false;
    else emit("input", ev.text, ev.at);
  }
  model.handle(e);
}

onMounted(() => {
  if (!props.live) return;
  emit("stop", props.live.stopUrl);
  stream = attachRunStream({
    url: props.live.eventsUrl,
    factory: makeEventSource,
    model,
    handle,
    // The agent stopped: the clock freezes at the server's stamp, or where it
    // stands for a turn a `202` mounted without a server clock.
    onFinished: (frame) => {
      frozenMs.value = runClock && frame ? runClock.elapsedAt(frame.finishedAt) : elapsedMs.value;
    },
    onEnd: () => {
      frozenMs.value ??= elapsedMs.value;
      emit("ended");
    },
    // The browser gave up reconnecting: the run may still be working, so the
    // turn stays live for the conversation, its clock freezes where the stream
    // dropped, and the row says so with the run's own page as the way on.
    onDisconnected: () => {
      frozenMs.value ??= elapsedMs.value;
    },
  });
  watch(stream.phase, (p) => (phase.value = p), { immediate: true });
});
onUnmounted(() => stream?.close());

// ---- the work (the fold) --------------------------------------------------------
// Open by default while live (the work is what is happening); closed once over.
// A finished turn from the seed holds no events: its replay is read once, on
// first open, from the same route the run page and the unit fold read.
const workOpen = ref(props.live !== null && props.live !== undefined);
const replay = ref<"none" | "loading" | "ready" | "failed">(props.live ? "ready" : "none");
watch(live, (l) => {
  if (!l) workOpen.value = false;
});
async function onToggleWork(ev: Event): Promise<void> {
  workOpen.value = (ev.target as HTMLDetailsElement).open;
  if (!workOpen.value || replay.value !== "none") return;
  replay.value = "loading";
  const fetchFn = props.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));
  try {
    const res = await fetchFn(`/runs/${encodeURIComponent(props.turn.id)}/events`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const frames = parseSseReplay(await res.text());
    const events = frames.filter((f) => (f as { type: string }).type !== "replay_note") as RunEvent[];
    for (const e of (props.turn.schema ?? 0) >= SPAN_SCHEMA ? normalizeSpans(events) : events) model.handle(e);
    model.closePhases();
    replay.value = "ready";
  } catch {
    replay.value = "failed";
  }
}
/** The fold's one line: the step count. While live the head carries the turn's
 *  one ticking number, so the summary never adds a second. */
const workSummary = computed(() => {
  const n = stepCount.value;
  return n > 0 ? `${n} step${n === 1 ? "" : "s"}` : live.value ? "starting" : "no steps recorded";
});
</script>

<template>
  <div
    class="turn assistant flex flex-col gap-2"
    :data-phase="phase"
    :data-run-id="turn.id"
    :data-live="live ? '1' : undefined"
  >
    <!-- The receipt line: the front door's decision, the agent when it was not routed. -->
    <div class="head flex flex-wrap items-baseline gap-2 font-mono text-[0.7rem] text-dimmed">
      <Transition name="sb-rise">
        <ReceiptChip v-if="route" key="receipt" :route="route" />
        <span
          v-else-if="agentLabel"
          key="agent"
          class="agent rounded border px-1.5 py-px font-medium"
          :class="AGENT_HUE[agentHue(agentLabel)]"
          >{{ agentLabel }}</span
        >
      </Transition>
      <span v-if="model_" class="model">{{ model_ }}</span>
      <span v-if="live" class="elapsed ml-auto tabular-nums" data-testid="elapsed">{{ elapsedText }}</span>
    </div>

    <!-- The pending row: the model silent, nothing running — visibly alive and obviously the model. -->
    <Transition name="sb-fade">
      <PendingTurnRow
        v-if="live && pendingRow"
        tag="div"
        :verb="pendingRow.verb"
        :elapsed-ms="pendingRow.elapsedMs"
        :slow="pendingRow.slow"
        :model="state.meta?.model ?? turn.model ?? null"
      />
    </Transition>

    <!-- The stream dropped (the run page's disconnected phase): the run may still
         be working; its page is the way on. The composer stays `steer` meanwhile. -->
    <p
      v-if="disconnected"
      class="disconnected flex items-baseline gap-2 rounded-lg border border-dashed border-bad/40 px-3 py-2 font-mono text-xs text-bad"
      data-testid="disconnected"
    >
      <span>stream disconnected · the run may still be working</span>
      <RouterLink class="ml-auto text-primary no-underline hover:underline" :to="runHref">open the run</RouterLink>
    </p>

    <!-- The work: the run page's own step blocks, open while live, folded once over. -->
    <details
      v-if="live || stepCount > 0 || replay !== 'none'"
      class="work group"
      :open="workOpen"
      data-testid="work"
      @toggle="onToggleWork"
    >
      <summary
        class="flex min-h-6 cursor-pointer list-none items-baseline gap-2 font-mono text-[0.7rem] text-dimmed hover:text-toned [&::-webkit-details-marker]:hidden"
      >
        <span
          class="chev select-none transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none"
          >❯</span
        >
        <span class="summary">{{ workSummary }}</span>
      </summary>
      <div class="pl-1 pt-1">
        <p v-if="replay === 'loading'" class="py-2 font-mono text-xs text-dimmed">reading the run's record…</p>
        <p v-else-if="replay === 'failed'" class="py-2 font-mono text-xs text-warn">
          the run's record could not be read —
          <RouterLink class="text-primary no-underline hover:underline" :to="runHref">open the run</RouterLink>
        </p>
        <ol v-else class="m-0 list-none p-0">
          <TransitionGroup name="sb-rise">
            <StepBlock
              v-for="item in steps"
              :key="item.key"
              :step="item"
              class="mt-3 first:mt-0"
              @toggle-group="model.toggleGroup(item)"
            />
          </TransitionGroup>
        </ol>
      </div>
    </details>

    <!-- The reply: whole, when it lands (the harness drops deltas — no typewriter over a whole reply). -->
    <Transition name="sb-rise">
      <div v-if="answer" class="reply" data-testid="reply">
        <MarkdownText :text="answer" />
      </div>
      <p v-else-if="outcome" class="outcome font-mono text-xs text-warn" data-testid="outcome">{{ outcome }}</p>
    </Transition>

    <!-- One line of facts once over: duration on the heat scale, the run's page. -->
    <div v-if="!live" class="facts flex flex-wrap items-baseline gap-x-3 font-mono text-[0.7rem] text-dimmed">
      <span class="dur tabular-nums" :class="heatPaint ? 'heat' : ''" :style="heatPaint">{{ elapsedText }}</span>
      <RouterLink class="open text-dimmed no-underline hover:text-primary hover:underline" :to="runHref"
        >open run</RouterLink
      >
    </div>
  </div>
</template>
