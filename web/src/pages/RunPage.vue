<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from "vue";
import AppShell from "../components/AppShell.vue";
import MarkdownText from "../components/MarkdownText.vue";
import SlackMark from "../components/SlackMark.vue";
import GithubMark from "../components/GithubMark.vue";
import StepBlock from "../components/run/StepBlock.vue";
import TimelineSection from "../components/run/TimelineSection.vue";
import { buildTimeline, type TimelinePhase } from "../lib/timelineVm";
import { runOwnerOf } from "@core/core/runOwner.js";
import { useSeed } from "../lib/seed";
import { useWallClock } from "../lib/wallClock";
import { browser } from "../lib/browser";
import { EVENT_SOURCE_CLOSED, useEventSourceFactory, type EventSourceLike } from "../lib/eventSource";
import {
  createRunClock,
  createRunPageModel,
  liveWait,
  modelName,
  deliveryCaption,
  parseEndFrame,
  parseFinishedFrame,
  parseReplayElided,
  runnerNow,
  RunnerClockKey,
} from "../lib/runPageModel";
import { createPrReviewCollector } from "../lib/prReviewCollector";
import PrReviewPanel from "../modules/pr-review/PrReviewPanel.vue";
import { durationTone, heatStyle } from "../lib/durationTone";
import { formatClock, formatDateTime, formatDuration, formatLocalIso } from "../lib/format";
import { statusLabel } from "../lib/indexRow";
import { FAVICON_IDLE, FAVICON_LIVE } from "@core/channels/favicon.js";

// The per-run page: one timeline of the whole run, LIVE (follows the
// token-scoped SSE stream) or HISTORY (seeded from the stored record, no
// stream). ONE fold for both — every frame goes through model.handle, so a
// seeded page and a live page render identically by construction. The header
// speaks the index's vocabulary (item 22): `running · <stopwatch>` while
// live, the outcome chip + duration once ended.

const seed = useSeed("run");
const isHistory = seed?.mode === "history";
const title = isHistory ? "Run" : "Live run";

const openParam = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("open") : null;
const model = createRunPageModel({
  openTags: openParam
    ? openParam
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined,
});
const state = model.state;

// ---- header state ----------------------------------------------------------
/** `finished`: the agent stopped (the `finished` frame); the reply is on its way
 *  and the stream stays open until `end` (features/tracing.md). */
type Phase = "connecting" | "running" | "stopping" | "finished" | "disconnected" | "ended";
const phase = ref<Phase>(isHistory ? "ended" : "connecting");
const stopError = ref("");
const nowWall = useWallClock();
// The header's one duration (live-view item 22): the run's stamps from the seed,
// projected arrival-relative from the server clock the seed carried — never a
// server stamp minus the browser's clock. Frozen at `end` at the value it had.
const runClock = seed?.mode === "live" ? createRunClock(seed, nowWall.value) : null;
const frozenMs = ref<number | undefined>(undefined);
/** The stamps a live page learns from the `finished` and `end` frames — the
 *  delivery caption's inputs. A history page reads the seed's. */
const liveStamps = ref<{ finishedAt?: number; sealedAt?: number; replyOk?: boolean }>({});

/** The outcome chip once ended: the history seed's record status, or — on a
 *  live page — the stop the viewer knows about; an unstopped end is the honest
 *  grey `ended` (an inline ⚠️ reply is still an `answer`, so "succeeded" would
 *  be a guess). */
const endChip = computed(() => {
  if (isHistory && seed?.mode === "history") {
    if (seed.status === "completed") return { ok: true, cls: "", word: "succeeded" };
    const cls =
      seed.status === "failed" || seed.status === "stopped_hard" || seed.status === "interrupted"
        ? "red"
        : seed.status === "stopped_soft"
          ? "amber"
          : "grey";
    return { ok: false, cls, word: seed.status ? statusLabel(seed.status) : "ended" };
  }
  const mode = state.stopMode;
  return {
    ok: false,
    cls: mode === "hard" ? "red" : mode === "soft" ? "amber" : "grey",
    word: mode === "hard" ? "killed" : mode === "soft" ? "stopped early" : "ended",
  };
});
const endMs = computed(() => (isHistory && seed?.mode === "history" ? seed.durationMs : frozenMs.value));
/** `delivered in 2s` / `reply failed` / nothing (live-view item 22; tracing.md). */
const delivery = computed(() =>
  deliveryCaption(
    isHistory && seed?.mode === "history"
      ? { finishedAt: seed.finishedAt, sealedAt: seed.sealedAt, replyOk: seed.replyOk }
      : liveStamps.value,
  ),
);
const endDuration = computed(() => (endMs.value === undefined ? "" : formatDuration(endMs.value, "clock")));
// The header's total is painted on the run scale (item 24): a 40-minute run
// announces itself before the reader scrolls to find where the time went.
const endHeat = computed(() => durationTone(endMs.value, "run"));
const endPaint = computed(() => heatStyle(endHeat.value));
const CHIP_CLS: Record<string, string> = {
  red: "border-bad/30 text-bad",
  amber: "border-warn/30 text-warn",
  grey: "border-accented text-muted",
};

const headerText = computed(() => {
  if (stopError.value) return stopError.value;
  if (phase.value === "connecting") return "connecting…";
  if (phase.value === "disconnected") return "disconnected";
  if (phase.value === "stopping") return `stopping (${state.stopMode ?? "soft"})`;
  // The agent stopped: the total is frozen at the finish stamp; the reply is in flight.
  if (phase.value === "finished")
    return frozenMs.value === undefined ? "delivering…" : `delivering… · ${formatDuration(frozenMs.value, "clock")}`;
  return runClock ? `running · ${formatDuration(runClock.elapsedMs(nowWall.value), "clock")}` : "running";
});
const pulseCls = computed(() =>
  stopError.value || phase.value === "disconnected"
    ? "text-bad"
    : phase.value === "running"
      ? "text-ok motion-safe:animate-pulse"
      : phase.value === "finished"
        ? "text-ok" // connected, nothing running: the pulse stops
        : "text-warn motion-safe:animate-pulse",
);

// ---- the timeline (live-view item 25) --------------------------------------------
// The run's shape from its spans and stamps alone, on the header's own window —
// `receivedAt` (else `startedAt`) to the finish stamp, or to the projected server
// clock while live — so its lede closes to the header's total by construction.
// Recomputed on every frame the fold saw (`traceVersion`) and every tick while live.
const timeline = computed(() => {
  if (!seed || (seed.mode !== "live" && seed.mode !== "history")) return null;
  void state.traceVersion;
  const start = seed.receivedAt ?? seed.startedAt;
  const owner = runOwnerOf(state.meta?.agent);
  if (seed.mode === "history") {
    // The record's one duration; a seed from before it carried one reads its stamps.
    const totalMs = seed.durationMs ?? (seed.finishedAt !== undefined ? Math.max(0, seed.finishedAt - start) : 0);
    return buildTimeline({
      spans: model.spanSet(),
      losses: model.losses(start),
      window: { start, end: start + totalMs },
      owner,
      totalMs,
      phase: "ended",
      delivery: { finishedAt: seed.finishedAt, sealedAt: seed.sealedAt, replyOk: seed.replyOk },
      ...(seed.truncated !== undefined ? { truncated: seed.truncated } : {}),
    });
  }
  if (!runClock) return null;
  const tlPhase: TimelinePhase = phase.value === "ended" ? "ended" : phase.value === "finished" ? "delivering" : "live";
  const totalMs =
    tlPhase === "live" ? runClock.elapsedMs(nowWall.value) : (frozenMs.value ?? runClock.elapsedMs(nowWall.value));
  return buildTimeline({
    spans: model.spanSet(),
    losses: model.losses(start),
    window: { start, end: start + totalMs },
    owner,
    totalMs,
    phase: tlPhase,
    delivery: liveStamps.value,
  });
});
/** The stored events as JSON lines — history mode only (a live page's URL carries its token). */
const eventsHref = isHistory && seed?.mode === "history" ? `/runs/${encodeURIComponent(seed.id)}/events` : undefined;

// ---- stop control (#101) -----------------------------------------------------
const actionsHidden = ref(isHistory);
const stopDisabled = ref(false);

function requestStop(mode: "soft" | "hard"): void {
  if (seed?.mode !== "live") return;
  if (mode === "hard" && !browser.confirm("Hard stop: abort the run now with no summary and free its sandbox?")) return;
  stopDisabled.value = true;
  fetch(`${seed.stopUrl}&mode=${encodeURIComponent(mode)}`, { method: "POST", credentials: "same-origin" })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      markStopping(mode);
    })
    .catch((err: unknown) => {
      stopDisabled.value = false;
      stopError.value = `stop failed: ${err instanceof Error ? err.message : "error"}`;
    });
}

function markStopping(mode: "soft" | "hard"): void {
  model.markStopping(mode);
  actionsHidden.value = true; // one request is enough; the stream shows the outcome
  if (phase.value === "connecting" || phase.value === "running") phase.value = "stopping";
}

// A stop can arrive from the stream too (a viewer who didn't click sees it).
watch(
  () => state.stopMode,
  (mode) => {
    if (mode && phase.value !== "ended" && phase.value !== "disconnected" && phase.value !== "finished")
      markStopping(mode);
  },
);

// The tab's dot speaks run state (item 21): green while this run is going,
// gray once it ended or the stream dropped. A history page is idle by
// definition — the shell's gray dot already says so.
if (!isHistory) {
  watch(
    phase,
    (p) => browser.setFavicon(p === "ended" || p === "disconnected" || p === "finished" ? FAVICON_IDLE : FAVICON_LIVE),
    { immediate: true },
  );
}

// ---- what is happening now ------------------------------------------------------
// In-progress work draws where it will end up: a running card ticks its
// elapsed in its own facts slot (it reads the clock provided here), and a
// pending model turn — the model silent, nothing running — is a pending-turn
// ROW at the foot of the log (∿ · `model` · a rotating verb · elapsed since
// the last stamped event) that the real step replaces when the turn lands.
// The header times the WHOLE run. There is no separate "tail": the timeline
// is live, and its last row is now.
const live = computed(
  () => !isHistory && phase.value !== "ended" && phase.value !== "disconnected" && phase.value !== "finished",
);
const runnerClock = computed(() => (live.value ? runnerNow(state, nowWall.value) : null));
provide(RunnerClockKey, runnerClock);
const waiting = computed(() => (live.value ? liveWait(state, model.pendingCall(), nowWall.value) : null));
// The silent model's verbs: a fixed list, a new word every 6 s in order —
// predictable, not twitchy — so the row is visibly alive without a spinner.
// The word is DERIVED from how long this silence has lasted, so every silence
// starts at "Thinking" and nothing rotates while no one is waiting.
const THINKING = [
  "Thinking",
  "Pondering",
  "Mulling it over",
  "Reasoning",
  "Cogitating",
  "Weighing options",
  "Puzzling",
  "Deliberating",
  "Noodling",
  "Chewing on it",
  "Ruminating",
  "Reticulating splines",
];
const verb = computed(() =>
  waiting.value?.kind === "thinking" ? THINKING[Math.floor(waiting.value.elapsedMs / 6000) % THINKING.length] : "",
);

// ---- fold toggle ---------------------------------------------------------------
function toggleAll(): void {
  model.setAllOpen(!state.allOpen);
}

// ---- follow the stream only when the viewer is already at the tail -------------
const logEnd = ref<HTMLElement | null>(null);
function atTail(): boolean {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 60;
}
// PR-review panel (features/reading-diff.md item 6): the collector is the
// runs→module adapter — it reads the same frames the timeline gets and, when
// this run is a PR review carrying reading-diff artifacts, gates the button.
const prReview = createPrReviewCollector();
const prPanelOpen = ref(false);

function handle(e: unknown): void {
  const wasAtTail = atTail();
  model.handle(e);
  prReview.handle(e);
  if (wasAtTail) requestAnimationFrame(() => logEnd.value?.scrollIntoView?.({ block: "nearest" }));
}

// ---- the stream / the seed -----------------------------------------------------
const makeEventSource = useEventSourceFactory();
let es: EventSourceLike | null = null;

// History seeds synchronously: the seed IS the stream, and feeding it before
// the first render keeps the paint complete (no flash of an empty page).
if (seed?.mode === "history") {
  for (const e of seed.events) {
    model.handle(e);
    prReview.handle(e);
  }
}

onMounted(() => {
  if (seed?.mode !== "live") return;
  es = makeEventSource(seed.eventsUrl);
  es.onopen = () => {
    if (!state.stopMode) phase.value = "running";
  };
  let lastSeq = 0;
  es.onmessage = (m) => {
    let e: { type?: string };
    try {
      e = JSON.parse(m.data) as typeof e;
    } catch {
      return;
    }
    // Run-event frames carry their stream position as the SSE id; anything at
    // or before the last applied position is dropped (a proxy that strips
    // Last-Event-ID would make the server replay from the start). A transport
    // notice (replay_note) has no id of its own — exempt.
    if (e.type !== "replay_note") {
      const sid = Number(m.lastEventId);
      if (sid > 0) {
        if (sid <= lastSeq) return;
        lastSeq = sid;
      }
    }
    handle(e);
  };
  es.addEventListener("replay_elided", (data) => {
    const range = parseReplayElided(data);
    if (range) model.noteElided(range);
  });
  // The agent stopped: the header's duration freezes at the server's finish
  // stamp (features/tracing.md), the stream stays open for the span records
  // until `end`.
  es.addEventListener("finished", (data) => {
    const frame = parseFinishedFrame(data);
    if (frame && runClock) frozenMs.value = runClock.elapsedAt(frame.finishedAt);
    if (frame) liveStamps.value = { ...liveStamps.value, finishedAt: frame.finishedAt };
    // The agent stopped: nothing runs, the actions go, the reply is on its way.
    // A stop in flight keeps its word (like `markStopping`).
    actionsHidden.value = true;
    if (phase.value === "connecting" || phase.value === "running") phase.value = "finished";
  });
  es.addEventListener("end", (data) => {
    model.flushPendingTurn("the run ended here"); // a run that ended without an answer still shows its last turn
    actionsHidden.value = true;
    frozenMs.value ??= runClock?.elapsedMs(nowWall.value); // an `end` with no `finished` before it (a stored stream) freezes here
    liveStamps.value = { ...liveStamps.value, ...parseEndFrame(data) };
    phase.value = "ended";
    es?.close();
  });
  es.onerror = () => {
    if (es && es.readyState === EVENT_SOURCE_CLOSED) phase.value = "disconnected";
  };
});

onUnmounted(() => {
  es?.close();
});

// ---- request source / meta -------------------------------------------------------
/** Only an http(s) source URL becomes a link — anything else stays text. */
function httpsUrl(url: string | undefined): string {
  return url && /^https?:\/\//.test(url) ? url : "";
}
const sourceUrl = computed(() => httpsUrl(state.request?.source?.url));
const metaRepoOk = computed(() => !!state.meta?.repo && /^[\w.-]+\/[\w.-]+$/.test(state.meta.repo));

/** Block headers (Request/Context/Answer) read a human moment — `Aug 30,
 *  3:06 PM` — with the exact ISO stamp on hover; the timeline's meta rows
 *  read the wall clock (`5:19:57 PM PDT`, formatClock). */
function fmtTime(at: number | undefined): string {
  return typeof at === "number" ? formatDateTime(at, nowWall.value) : "";
}
function fmtTimeTitle(at: number | undefined): string | undefined {
  return typeof at === "number" ? formatLocalIso(at) : undefined;
}
</script>

<template>
  <AppShell :title="title" nav="runs">
    <template #leading>
      <a class="back text-sm text-primary no-underline hover:underline" href="/runs">← All runs</a>
    </template>
    <template #status>
      <span class="conn flex items-center gap-2">
        <template v-if="phase === 'ended'">
          <span v-if="endChip.ok" class="ok text-ok" role="img" aria-label="succeeded">✓</span>
          <span v-else class="chip rounded border px-1.5 text-[0.7rem]" :class="CHIP_CLS[endChip.cls]">{{
            endChip.word
          }}</span>
          <span
            id="state"
            class="dur text-xs tabular-nums"
            :class="[endPaint ? 'heat' : 'text-muted', endHeat.level >= 2 ? 'font-medium' : '']"
            :style="endPaint"
            :data-heat="endHeat.level"
            >{{ endDuration }}</span
          >
          <span v-if="delivery" id="delivery" class="text-xs text-muted">· {{ delivery }}</span>
        </template>
        <template v-else>
          <span id="statedot" class="pulse text-[1.1em] leading-none" :class="pulseCls">∿</span>
          <span
            id="state"
            class="text-xs tabular-nums"
            :class="stopError ? 'text-bad' : 'text-muted'"
            :title="
              phase === 'running' && !stopError
                ? 'the whole run, since we received the message'
                : phase === 'finished'
                  ? 'the agent stopped; the reply is being posted'
                  : undefined
            "
            >{{ headerText }}</span
          >
        </template>
      </span>
    </template>
    <template #actions>
      <span v-if="!actionsHidden" id="actions" class="actions flex gap-1.5">
        <UTooltip text="Soft stop: no new steps, the agent writes up what it has">
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            label="Stop"
            :disabled="stopDisabled"
            @click="requestStop('soft')"
          />
        </UTooltip>
        <UTooltip text="Hard stop: abort now, no summary, free the sandbox">
          <UButton
            size="xs"
            color="error"
            variant="outline"
            label="Kill"
            :disabled="stopDisabled"
            @click="requestStop('hard')"
          />
        </UTooltip>
      </span>
    </template>

    <div class="mx-auto max-w-6xl">
      <!-- Request -->
      <!-- The card's spacing states the hierarchy: the frame (label, meta)
           and the framed prose breathe by the same rhythm — the meta row is
           small type, so it gets MORE air, not less (gap-y for the phone
           where it wraps to two lines). -->
      <section
        v-if="state.request"
        id="request"
        class="block mb-5 rounded-lg border border-default bg-(--ui-bg-muted) px-3.5 py-3"
      >
        <h2 class="mb-2 flex items-baseline gap-2.5 text-xs font-semibold uppercase tracking-wider text-muted">
          <span>Request</span>
          <span
            class="ts select-none text-xs normal-case tracking-normal text-dimmed"
            :title="fmtTimeTitle(state.request.at)"
            >{{ fmtTime(state.request.at) }}</span
          >
          <span
            v-if="state.request.source"
            class="source ml-auto flex items-center gap-2 font-normal normal-case tracking-normal text-muted"
          >
            <template v-if="state.request.source.channel">
              <SlackMark />
              <a
                v-if="sourceUrl"
                class="text-toned no-underline hover:text-primary hover:underline"
                :href="sourceUrl"
                target="_blank"
                rel="noopener noreferrer"
                title="open the thread"
                >#{{ state.request.source.channel }}</a
              >
              <span v-else>#{{ state.request.source.channel }}</span>
            </template>
            <span v-if="state.request.source.user">{{ state.request.source.user }}</span>
          </span>
        </h2>
        <MarkdownText :text="state.request.text" />
        <!-- What the run is about (item 19/21): agent · model · effort · linked
             repo · branch tag · GitHub-marked #PR. The branch is a fact, not a
             destination; the sha is gone for the same reason. -->
        <div
          v-if="state.meta"
          id="runmeta"
          class="runmeta mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1.5 border-t border-default pt-2.5 text-xs text-muted"
        >
          <span class="agent text-[0.68rem] font-semibold uppercase tracking-wider text-toned">{{
            state.meta.agent
          }}</span>
          <span class="model">{{ state.meta.model }}</span>
          <span v-if="state.meta.effort" class="effort text-toned">{{ state.meta.effort }} effort</span>
          <template v-if="metaRepoOk">
            <a
              class="text-primary no-underline hover:underline"
              :href="`https://github.com/${state.meta.repo}`"
              target="_blank"
              rel="noopener noreferrer"
              >{{ state.meta.repo }}</a
            >
            <span
              v-if="state.meta.ref"
              class="reftag rounded border border-accented px-1.5 text-[0.75rem] text-toned"
              >{{ state.meta.ref }}</span
            >
            <a
              v-if="state.meta.pr"
              class="prlink whitespace-nowrap text-primary no-underline hover:underline"
              :href="`https://github.com/${state.meta.repo}/pull/${state.meta.pr}`"
              target="_blank"
              rel="noopener noreferrer"
            >
              <GithubMark class="mr-1 align-[-0.125em]" />#{{ state.meta.pr }}
            </a>
          </template>
          <!-- The review's reading diff (features/reading-diff.md item 6):
               present exactly when the run published reading-diff artifacts. -->
          <UButton
            v-if="prReview.state.ready"
            class="ml-auto"
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-diff"
            label="Reading diff"
            data-testid="reading-diff-button"
            @click="prPanelOpen = true"
          />
        </div>
      </section>

      <!-- Timeline (live-view item 25): the run's shape from its spans and stamps alone. -->
      <TimelineSection v-if="timeline" :vm="timeline" :events-href="eventsHref" />

      <!-- The log's toolbar: the Context fold (when the run has context) and
           the one ghost toggle share ONE line — the button stays pinned to the
           first line when the fold opens downward. -->
      <div class="logbar mb-1.5 flex items-start gap-4 px-3">
        <!-- Context: the thread turns the model was given, collapsed by default.
             The chevron says "this opens" — the same fold grammar as the cards. -->
        <details v-if="state.context.length > 0" id="context" class="group min-w-0 flex-1">
          <summary
            class="flex min-h-6 cursor-pointer list-none items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted hover:text-toned [&::-webkit-details-marker]:hidden"
          >
            <span
              class="chev select-none text-xs text-dimmed transition-transform group-open:rotate-90 motion-reduce:transition-none"
              >❯</span
            >
            <span>Context</span>
            <span class="count font-normal normal-case tracking-normal"
              >({{ state.context.length }} turn{{ state.context.length === 1 ? "" : "s" }})</span
            >
          </summary>
          <div id="contextturns" class="pb-3">
            <div
              v-for="turn in state.context"
              :key="turn.key"
              class="turn flex items-baseline gap-3 border-t border-default py-1.5 opacity-85 first-of-type:border-t-0"
            >
              <span class="ts select-none text-xs text-dimmed" :title="fmtTimeTitle(turn.at)">{{
                fmtTime(turn.at)
              }}</span>
              <MarkdownText :text="turn.text" />
            </div>
          </div>
        </details>
        <UButton
          id="fold"
          class="ml-auto shrink-0"
          size="xs"
          color="neutral"
          variant="ghost"
          :label="state.allOpen ? 'Collapse all' : 'Expand all'"
          :icon="state.allOpen ? 'i-lucide-square-minus' : 'i-lucide-square-plus'"
          :aria-pressed="state.allOpen ? 'true' : 'false'"
          :data-open="state.allOpen ? '1' : '0'"
          :title="state.allOpen ? 'Close every call card' : 'Open every call card'"
          @click="toggleAll"
        />
      </div>

      <!-- The timeline -->
      <ol id="log" class="m-0 list-none p-0">
        <li v-if="state.placeholder" id="placeholder" class="empty text-muted">Waiting for activity…</li>
        <template v-for="item in state.log" :key="item.key">
          <StepBlock
            v-if="item.kind === 'step'"
            :step="item"
            class="mt-5 first:mt-0"
            @toggle-group="model.toggleGroup(item)"
          />
          <li
            v-else-if="item.kind === 'turn'"
            class="turn mt-5 border-l-2 border-(--ui-border-accented)/50 pb-3 pl-3 pt-2"
          >
            <!-- A turn that produced no step: the same ONE meta row a step heads with. -->
            <div class="meta flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 pr-3 text-xs tabular-nums text-dimmed">
              <span class="thought" :class="item.turn.quick ? '' : 'text-warn'" :title="item.turn.label"
                >thought {{ item.turn.chip }}</span
              >
              <span
                v-if="item.turn.switched"
                class="model-switch order-first rounded border border-warn/40 bg-warn/10 px-1.5 font-semibold text-warn"
                :title="`model changed: this turn ran on ${item.turn.model}`"
                >⇄ {{ modelName(item.turn.model) }}</span
              >
              <span
                v-else-if="item.turn.model"
                class="model-badge order-first rounded bg-accented px-1.5 text-[0.68rem] font-semibold leading-normal tracking-wider text-muted"
                :title="item.turn.model"
                >{{ modelName(item.turn.model) }}</span
              >
              <span v-for="(f, i) in item.turn.facts" :key="i" class="fact">{{ f }}</span>
              <span v-if="item.note" class="nonar font-sans italic">{{ item.note }}</span>
              <span
                v-if="item.turn.at !== undefined"
                class="ts ml-auto select-none"
                :title="formatLocalIso(item.turn.at)"
                >{{ formatClock(item.turn.at) }}</span
              >
            </div>
          </li>
          <!-- A streamed span that is a step of its own (features/tracing.md):
               its display name, its duration once it ended, a pulse while open. -->
          <li v-else-if="item.kind === 'span'" class="span flex items-baseline gap-2 py-0.5 text-xs text-muted">
            <span class="glyph select-none" :class="item.status === 'error' ? 'text-bad' : 'text-dimmed'">{{
              item.open ? "◌" : item.status === "error" ? "✗" : "◷"
            }}</span>
            <span class="what">{{ item.text }}</span>
            <span v-if="item.open" class="text-dimmed">…</span>
            <span v-else-if="item.durationMs !== undefined" class="dur tabular-nums text-dimmed">{{
              formatDuration(item.durationMs, "precise")
            }}</span>
            <span v-if="item.at !== undefined" class="ts ml-auto select-none" :title="formatLocalIso(item.at)">{{
              formatClock(item.at)
            }}</span>
          </li>
          <!-- A follow-up steered into this run (features/thread-admission.md
               item 2): the same run, more input — the Request's treatment,
               at the moment the run read it, with who sent it and when. -->
          <li
            v-else-if="item.kind === 'followup'"
            class="followup block mt-5 rounded-lg border border-default bg-(--ui-bg-muted) px-3.5 py-3"
          >
            <h2 class="mb-2 flex items-baseline gap-2.5 text-xs font-semibold uppercase tracking-wider text-muted">
              <span>↪ Follow-up</span>
              <span
                class="ts select-none text-xs normal-case tracking-normal text-dimmed"
                :title="fmtTimeTitle(item.input.at)"
                >{{ fmtTime(item.input.at) }}</span
              >
              <span
                v-if="item.input.source?.user"
                class="source ml-auto flex items-center gap-2 font-normal normal-case tracking-normal text-muted"
              >
                <a
                  v-if="httpsUrl(item.input.source.url)"
                  class="text-toned no-underline hover:text-primary hover:underline"
                  :href="item.input.source.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="open the message"
                  >{{ item.input.source.user }}</a
                >
                <span v-else>{{ item.input.source.user }}</span>
              </span>
            </h2>
            <MarkdownText :text="item.input.text" />
          </li>
          <li
            v-else
            class="note mt-4 flex items-baseline gap-3 rounded-md px-3 py-1.5"
            :class="item.replay ? 'text-dimmed' : 'bg-warn/10 text-warn'"
          >
            <span>{{ (item.replay ? "… " : "⏱ ") + item.text }}</span>
            <span
              v-if="item.at !== undefined"
              class="ts ml-auto select-none text-xs text-dimmed"
              :title="formatLocalIso(item.at)"
              >{{ formatClock(item.at) }}</span
            >
          </li>
        </template>
        <!-- A pending model turn: the model is silent and nothing is running.
             It reads as a ROW like the others — the dashed outline of the
             card that has not landed yet — and says plainly whose silence it
             is: the ∿ pulse, a `model` badge, a rotating verb, and the time
             since the last stamped event on the runner clock. A running
             command needs nothing here: its card ticks. -->
        <li
          v-if="waiting?.kind === 'thinking'"
          id="thinking"
          class="pending ml-3.5 mr-3 mt-5 flex items-center gap-3 rounded-md border border-dashed border-accented px-3 py-2 text-sm first:mt-0"
          aria-live="off"
          title="the model is working on its next turn — nothing back yet (since the last event, runner clock)"
        >
          <span class="pulse text-[1.1em] leading-none text-info motion-safe:animate-pulse">∿</span>
          <span
            class="badge shrink-0 rounded bg-accented px-1.5 text-[0.68rem] font-semibold leading-normal tracking-wider text-muted"
            :title="state.model ?? undefined"
            >{{ modelName(state.model) }}</span
          >
          <span class="verb min-w-0 truncate text-toned">{{ verb }}…</span>
          <span
            class="since ml-auto shrink-0 text-xs tabular-nums"
            :class="waiting.slow ? 'text-warn' : 'text-dimmed'"
            >{{ formatDuration(waiting.elapsedMs, "clock") }}</span
          >
        </li>
        <li ref="logEnd" aria-hidden="true" />
      </ol>

      <!-- Answer -->
      <section
        v-if="state.answer"
        id="answer"
        class="block mt-6 rounded-lg border border-ok/40 bg-(--ui-bg-muted) px-3.5 py-3"
      >
        <h2 class="mb-2 flex items-baseline gap-2.5 text-xs font-semibold uppercase tracking-wider text-ok">
          <span>Answer</span>
          <span
            class="ts select-none text-xs normal-case tracking-normal text-dimmed"
            :title="fmtTimeTitle(state.answer.at)"
            >{{ fmtTime(state.answer.at) }}</span
          >
        </h2>
        <MarkdownText :text="state.answer.text" />
      </section>
    </div>

    <!-- The PR-review slideout: the pr-review module rendering the adapter's
         state. Wide, because a diff is the content. -->
    <USlideover v-model:open="prPanelOpen" title="PR review" :ui="{ content: 'max-w-3xl' }">
      <template #body>
        <PrReviewPanel :data="prReview.state" />
      </template>
    </USlideover>
  </AppShell>
</template>
