<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import AppShell from "../components/AppShell.vue";
import MarkdownText from "../components/MarkdownText.vue";
import SlackMark from "../components/SlackMark.vue";
import GithubMark from "../components/GithubMark.vue";
import StepBlock from "../components/run/StepBlock.vue";
import { useSeed } from "../lib/seed";
import { browser } from "../lib/browser";
import { EVENT_SOURCE_CLOSED, useEventSourceFactory, type EventSourceLike } from "../lib/eventSource";
import { createRunPageModel, runningHeader, runSpan } from "../lib/runPageModel";
import { formatDateTime, formatElapsed, formatLocalIso } from "../lib/format";
import { statusLabel } from "../lib/indexRow";

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
  openTags: openParam ? openParam.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
});
const state = model.state;

// ---- header state ----------------------------------------------------------
type Phase = "connecting" | "running" | "stopping" | "disconnected" | "ended";
const phase = ref<Phase>(isHistory ? "ended" : "connecting");
const stopError = ref("");
const nowWall = ref(Date.now());

/** The outcome chip once ended: the history seed's record status, or — on a
 *  live page — the stop the viewer knows about; an unstopped end is the honest
 *  grey `ended` (an inline ⚠️ reply is still an `answer`, so "succeeded" would
 *  be a guess). */
const endChip = computed(() => {
  if (isHistory && seed?.mode === "history") {
    if (seed.status === "completed") return { ok: true, cls: "", word: "succeeded" };
    const cls = seed.status === "failed" || seed.status === "stopped_hard" || seed.status === "interrupted" ? "red" : seed.status === "stopped_soft" ? "amber" : "grey";
    return { ok: false, cls, word: seed.status ? statusLabel(seed.status) : "ended" };
  }
  const mode = state.stopMode;
  return {
    ok: false,
    cls: mode === "hard" ? "red" : mode === "soft" ? "amber" : "grey",
    word: mode === "hard" ? "killed" : mode === "soft" ? "stopped early" : "ended",
  };
});
const endDuration = computed(() =>
  isHistory && seed?.mode === "history" ? (seed.durationMs !== undefined ? formatElapsed(seed.durationMs) : "") : runSpan(state),
);
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
  return runningHeader(state, nowWall.value) ?? "running";
});
const pulseCls = computed(() =>
  stopError.value || phase.value === "disconnected" ? "text-bad" : phase.value === "running" ? "text-ok motion-safe:animate-pulse" : "text-warn motion-safe:animate-pulse",
);

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
    if (mode && phase.value !== "ended" && phase.value !== "disconnected") markStopping(mode);
  },
);

// ---- the live tail -----------------------------------------------------------
const THINKING = ["Thinking", "Pondering", "Mulling it over", "Reasoning", "Cogitating", "Weighing options", "Puzzling", "Deliberating", "Noodling", "Chewing on it", "Ruminating", "Reticulating splines"];
const verbIndex = ref(0);
let verbSince = Date.now();
const tailVisible = computed(() => !isHistory && phase.value !== "ended" && phase.value !== "disconnected");
const tailSince = computed(() => nowWall.value - state.lastEventAt);
const SLOW_MS = 120_000;

// ---- fold toggle ---------------------------------------------------------------
function toggleAll(): void {
  model.setAllOpen(!state.allOpen);
}

// ---- follow the stream only when the viewer is already at the tail -------------
const logEnd = ref<HTMLElement | null>(null);
function atTail(): boolean {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 60;
}
function handle(e: unknown): void {
  const wasAtTail = atTail();
  model.handle(e);
  if (wasAtTail) requestAnimationFrame(() => logEnd.value?.scrollIntoView?.({ block: "nearest" }));
}

// ---- the stream / the seed -----------------------------------------------------
const makeEventSource = useEventSourceFactory();
let es: EventSourceLike | null = null;
let tick: ReturnType<typeof setInterval> | null = null;

// History seeds synchronously: the seed IS the stream, and feeding it before
// the first render keeps the paint complete (no flash of an empty page).
if (seed?.mode === "history") {
  for (const e of seed.events) model.handle(e);
}

onMounted(() => {
  tick = setInterval(() => {
    nowWall.value = Date.now();
    // A new word every 6 s, in order — predictable, not twitchy.
    if (nowWall.value - verbSince > 6000) {
      verbIndex.value = (verbIndex.value + 1) % THINKING.length;
      verbSince = nowWall.value;
    }
  }, 1000);

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
  es.addEventListener("end", () => {
    model.flushPendingTurn("the run ended here"); // a run that ended without an answer still shows its last turn
    actionsHidden.value = true;
    phase.value = "ended";
    es?.close();
  });
  es.onerror = () => {
    if (es && es.readyState === EVENT_SOURCE_CLOSED) phase.value = "disconnected";
  };
});

onUnmounted(() => {
  if (tick) clearInterval(tick);
  es?.close();
});

// ---- request source / meta -------------------------------------------------------
const sourceUrl = computed(() => {
  const url = state.request?.source?.url;
  return url && /^https?:\/\//.test(url) ? url : "";
});
const metaRepoOk = computed(() => !!state.meta?.repo && /^[\w.-]+\/[\w.-]+$/.test(state.meta.repo));

/** Block headers (Request/Context/Answer) read a human moment — `Aug 30,
 *  3:06 PM` — with the exact ISO stamp on hover; the log gutter keeps its
 *  `[HH:MM:SS]` grammar. */
function fmtTime(at: number | undefined): string {
  return typeof at === "number" ? formatDateTime(at, nowWall.value) : "";
}
function fmtTimeTitle(at: number | undefined): string | undefined {
  return typeof at === "number" ? formatLocalIso(at) : undefined;
}
function stamp(at: number | undefined): string {
  return typeof at === "number" ? `[${formatLocalIso(at).slice(11, 19)}]` : "";
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
          <span v-else class="chip rounded border px-1.5 text-[0.7rem]" :class="CHIP_CLS[endChip.cls]">{{ endChip.word }}</span>
          <span id="state" class="dur text-xs tabular-nums text-muted">{{ endDuration }}</span>
        </template>
        <template v-else>
          <span class="pulse text-[1.1em] leading-none" :class="pulseCls" id="statedot">∿</span>
          <span id="state" class="text-xs tabular-nums" :class="stopError ? 'text-bad' : 'text-muted'">{{ headerText }}</span>
        </template>
      </span>
    </template>
    <template #actions>
      <span v-if="!actionsHidden" class="actions flex gap-1.5" id="actions">
        <UTooltip text="Soft stop: no new steps, the agent writes up what it has">
          <UButton size="xs" color="neutral" variant="outline" label="Stop" :disabled="stopDisabled" @click="requestStop('soft')" />
        </UTooltip>
        <UTooltip text="Hard stop: abort now, no summary, free the sandbox">
          <UButton size="xs" color="error" variant="outline" label="Kill" :disabled="stopDisabled" @click="requestStop('hard')" />
        </UTooltip>
      </span>
    </template>

    <div class="mx-auto max-w-6xl">
      <!-- Request -->
      <section v-if="state.request" id="request" class="block mb-5 rounded-lg border border-default bg-(--ui-bg-muted) px-3 py-2.5">
        <h2 class="mb-2 flex items-baseline gap-2.5 text-xs font-semibold uppercase tracking-wider text-muted">
          <span>Request</span>
          <span class="ts select-none text-xs normal-case tracking-normal text-dimmed" :title="fmtTimeTitle(state.request.at)">{{ fmtTime(state.request.at) }}</span>
          <span v-if="state.request.source" class="source ml-auto flex items-center gap-2 font-normal normal-case tracking-normal text-muted">
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
        <div v-if="state.meta" class="runmeta mt-2.5 flex flex-wrap items-baseline gap-2 border-t border-default pt-2 text-xs text-muted" id="runmeta">
          <span class="agent text-[0.68rem] font-semibold uppercase tracking-wider text-toned">{{ state.meta.agent }}</span>
          <span class="model">{{ state.meta.model }}</span>
          <span v-if="state.meta.effort" class="effort text-toned">{{ state.meta.effort }} effort</span>
          <template v-if="metaRepoOk">
            <a class="text-primary no-underline hover:underline" :href="`https://github.com/${state.meta.repo}`" target="_blank" rel="noopener noreferrer">{{
              state.meta.repo
            }}</a>
            <span v-if="state.meta.ref" class="reftag rounded border border-accented px-1.5 text-[0.75rem] text-toned">{{ state.meta.ref }}</span>
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
        </div>
      </section>

      <!-- Context: the thread turns the model was given, collapsed by default. -->
      <details v-if="state.context.length > 0" id="context" class="mb-5">
        <summary class="cursor-pointer list-none text-xs font-semibold uppercase tracking-wider text-muted [&::-webkit-details-marker]:hidden">
          Context <span class="count font-normal normal-case tracking-normal">({{ state.context.length }} turn{{ state.context.length === 1 ? "" : "s" }})</span>
        </summary>
        <div id="contextturns">
          <div v-for="turn in state.context" :key="turn.key" class="turn flex items-baseline gap-3 border-t border-default py-1.5 opacity-85 first-of-type:border-t-0">
            <span class="ts select-none text-xs text-dimmed" :title="fmtTimeTitle(turn.at)">{{ fmtTime(turn.at) }}</span>
            <MarkdownText :text="turn.text" />
          </div>
        </div>
      </details>

      <!-- The log's own toolbar: one ghost toggle, right-aligned above the timeline. -->
      <div class="logbar mb-1.5 flex justify-end pl-3 pr-3 sm:pl-[9.5rem]">
        <UButton
          id="fold"
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
        <li v-if="state.placeholder && !tailVisible" id="placeholder" class="empty text-muted">Waiting for activity…</li>
        <template v-for="item in state.log" :key="item.key">
          <StepBlock v-if="item.kind === 'step'" :step="item" class="mt-5 first:mt-0" @toggle-group="model.toggleGroup(item)" />
          <li v-else-if="item.kind === 'turn'" class="turn relative mt-5 border-l-2 border-(--ui-border-accented)/50 pb-3 pl-3 pt-2 sm:pl-[9.5rem]">
            <span v-if="item.turn.at !== undefined" class="ts absolute left-3 top-2.5 hidden select-none text-xs text-dimmed sm:block" :title="formatLocalIso(item.turn.at)">{{
              stamp(item.turn.at)
            }}</span>
            <div class="narration flex items-baseline gap-3 pr-3">
              <span
                class="think shrink-0 whitespace-nowrap rounded px-2 text-[0.8rem] leading-relaxed"
                :class="item.turn.quick ? 'bg-accented text-muted' : 'bg-warn/10 text-warn'"
                :title="item.turn.label"
                >{{ item.turn.chip }}</span
              >
              <span v-if="item.turn.facts.length" class="turnfacts flex gap-2.5 self-center text-xs tabular-nums text-muted">
                <span v-for="(f, i) in item.turn.facts" :key="i" class="fact">{{ f }}</span>
              </span>
              <span v-if="item.note" class="nonar font-sans text-sm italic text-dimmed">{{ item.note }}</span>
            </div>
          </li>
          <li v-else class="note mt-4 flex items-baseline gap-3 rounded-md px-3 py-1.5" :class="item.replay ? 'text-dimmed' : 'bg-warn/10 text-warn'">
            <span v-if="item.at !== undefined" class="ts select-none text-xs text-dimmed">{{ stamp(item.at) }}</span>
            <span>{{ (item.replay ? "… " : "⏱ ") + item.text }}</span>
          </li>
        </template>
        <!-- The live tail: what is happening right now, always last while connected. -->
        <li
          v-if="tailVisible"
          class="tail mt-10 flex items-center gap-3 border-t border-dashed border-accented py-3 pl-6 pr-8 text-[0.8rem] text-muted"
          id="tail"
        >
          <span class="pulse text-[1.1em] leading-none text-info motion-safe:animate-pulse">∿</span>
          <span class="verb text-toned">{{ THINKING[verbIndex] }}…</span>
          <span class="since ml-auto shrink-0 tabular-nums" :class="tailSince >= SLOW_MS ? 'text-warn' : 'text-dimmed'" title="since the last event arrived">{{
            formatElapsed(tailSince)
          }}</span>
        </li>
        <li ref="logEnd" aria-hidden="true" />
      </ol>

      <!-- Answer -->
      <section v-if="state.answer" id="answer" class="block mt-6 rounded-lg border border-ok/40 bg-(--ui-bg-muted) px-3 py-2.5">
        <h2 class="mb-2 flex items-baseline gap-2.5 text-xs font-semibold uppercase tracking-wider text-ok">
          <span>Answer</span>
          <span class="ts select-none text-xs normal-case tracking-normal text-dimmed" :title="fmtTimeTitle(state.answer.at)">{{ fmtTime(state.answer.at) }}</span>
        </h2>
        <MarkdownText :text="state.answer.text" />
      </section>
    </div>
  </AppShell>
</template>
