<script setup lang="ts">
defineOptions({ name: "GreenRunPage" });
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useResizeObserver } from "@vueuse/core";
import RunScrollControls from "../../src/components/run/RunScrollControls.vue";
import ExpandableText from "../../src/components/ExpandableText.vue";
import MarkdownText from "../../src/components/MarkdownText.vue";
import SlackMark from "../../src/components/SlackMark.vue";
import GithubMark from "../../src/components/GithubMark.vue";
import StepBlock from "../../src/components/run/StepBlock.vue";
import SpanRow from "../../src/components/run/SpanRow.vue";
import TimelineSection from "../../src/components/run/TimelineSection.vue";
import ReplyBlock from "../../src/components/run/ReplyBlock.vue";
import MessageFiles from "../../src/components/run/MessageFiles.vue";
import RunUnitsBlock from "../../src/components/run/RunUnitsBlock.vue";
import RunChildrenBlock from "../../src/components/run/RunChildrenBlock.vue";
import { buildTimeline, type TimelinePhase } from "../../src/lib/timelineVm";
import { runOwnerOf } from "@core/core/runOwner.js";
import { useSeed, useViewingAs } from "../../src/lib/seed";
import { useWallClock } from "../../src/lib/wallClock";
import { browser } from "../../src/lib/browser";
import { useEventSourceFactory } from "../../src/lib/eventSource";
import { attachRunStream, type StreamPhase } from "../../src/lib/runStream";
import { thinkingVerb } from "../../src/lib/thinkingVerbs";
import PendingTurnRow from "../../src/components/run/PendingTurnRow.vue";
import {
  createRunClock,
  createRunPageModel,
  liveWait,
  modelName,
  deliveryCaption,
  phaseHeadText,
  replyCaption,
  runnerNow,
  RunnerClockKey,
  ArtifactLinksKey,
  ReplyLandedKey,
  quotedLines,
  type NoteVm,
} from "../../src/lib/runPageModel";
import { createPrReviewCollector } from "../../src/lib/prReviewCollector";
import { createReviewAbridge } from "../../src/lib/reviewAbridge";
import PrReviewSlideover from "../../src/components/PrReviewSlideover.vue";
import { durationTone, heatStyle } from "../../src/lib/durationTone";
import { formatClock, formatDateTime, formatDuration, formatLocalIso, formatUsd } from "../../src/lib/format";
import { githubCommitUrl, githubPrUrl, githubRepoUrl, githubTreeUrl, shortSha } from "../../src/lib/githubLinks";
import { phasePaint } from "../../src/lib/termPaint";
import { AGENT_HUE, agentHue, threadHref, statusLabel, PROVISIONAL_LABEL } from "../../src/lib/indexRow";
import { FAVICON_IDLE, FAVICON_LIVE } from "@core/channels/favicon.js";

// The per-run page: one timeline of the whole run, LIVE (follows the
// token-scoped SSE stream) or HISTORY (seeded from the stored record, no
// stream). ONE fold for both — every frame goes through model.handle, so a
// seeded page and a live page render identically by construction. The header
// speaks the index's vocabulary (item 22): `running · <stopwatch>` while
// live, the outcome chip + duration once ended.

const seed = useSeed("run");
const isHistory = seed?.mode === "history";
/** A finished run's page leads with its outcome: the Reply sits under the
 *  Request, above the work. A live page keeps the Reply last — it lands there
 *  as it arrives, and nothing on a live page jumps. */
const replyFirst = isHistory;
/** Where the run's files are served from (item 26); null → no store, rows are text. */
const artifactLinks = seed?.artifacts ?? null;
/** What this run is the parent of (item 28): the runs it spawned, and — on the
 *  pipeline's own record — the units of the instance it stands for. */
const children = seed?.children ?? [];
const units = (seed?.mode === "history" ? seed.units : undefined) ?? [];
/** Where the findings ledger of the pull request this run names lives
 *  (agent-ship item 18): the unit page's Findings block, when the seed names it. */
const findingsLedger = seed?.mode === "history" ? seed.findingsLedger : undefined;
const findingsHref = computed(() =>
  findingsLedger ? `/runs/unit/${encodeURIComponent(findingsLedger.unit)}#findings` : undefined,
);

const openParam = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("open") : null;
const model = createRunPageModel({
  openTags: openParam
    ? openParam
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined,
});
// The runner clock's anchor (live-view item 18): the seed's server clock, so
// the replay's open spans are timed by their real start, not the page load.
if (seed?.mode === "live") model.seedClock(seed.serverNow);
const state = model.state;

// ---- header state ----------------------------------------------------------
/** `finished`: the agent stopped (the `finished` frame); the reply is on its way
 *  and the stream stays open until `end` (docs/reference/specs/tracing.md). */
type Phase = StreamPhase;
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
    // A queued ask (record 0064, "The queue"): no outcome yet — the chip says
    // the position and what the row waits on, in the queued reply's own words.
    if (seed.queued)
      return {
        ok: false,
        cls: "amber",
        word:
          seed.queued.state === "waiting"
            ? `queued at position ${seed.queued.position} — waiting on ${seed.queued.waiting}`
            : seed.queued.state,
      };
    if (seed.status === "completed") return { ok: true, cls: "", word: "succeeded" };
    // A provisional record: the tombstone-first start marker still in its window —
    // rendered as "unfinished — no finish recorded", amber (not red), because the
    // run may still be live in a registry the store-only reader cannot see.
    if (seed.provisional) return { ok: false, cls: "amber", word: PROVISIONAL_LABEL };
    const cls = seed.status === "failed" || seed.status === "interrupted" ? "red" : "grey";
    return { ok: false, cls, word: seed.status ? statusLabel(seed.status) : "ended" };
  }
  const mode = state.stopMode;
  return {
    ok: false,
    cls: "grey",
    word: mode ? "stopped by user" : "ended",
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
/** The run's dollars beside its duration (costs.md item 4c): the record's cost through the
 *  price table, `unpriced` when a model it ran on has no price, nothing for a record without
 *  usage; each model's figure is the hover text. A live page has none — usage is summed at finish. */
const cost = computed(() => (isHistory && seed?.mode === "history" ? seed.cost : undefined));
const dollars = (usd: number | null): string => (usd === null ? "unpriced" : formatUsd(usd));
const costText = computed(() => (cost.value ? dollars(cost.value.usd) : ""));
const costTitle = computed(() =>
  cost.value
    ? Object.entries(cost.value.byModel)
        .map(([ref, m]) => `${ref} ${dollars(m.usd)}`)
        .join("\n")
    : undefined,
);
// The header's total is painted on the run scale (item 24): a 40-minute run
// announces itself before the reader scrolls to find where the time went.
const endHeat = computed(() => durationTone(endMs.value, "run"));
const endPaint = computed(() => heatStyle(endHeat.value));
const CHIP_CLS: Record<string, string> = {
  red: "border-bad/30 text-bad",
  amber: "border-warn/30 text-warn",
  grey: "border-accented text-muted",
};
const contextRecoveryHeld = computed(() => {
  if (isHistory || phase.value === "ended" || phase.value === "finished") return false;
  if (state.recoveryHold !== undefined) return state.recoveryHold === "private_context";
  for (let i = state.log.length - 1; i >= 0; i--) {
    const item = state.log[i];
    if (item.kind !== "note") continue;
    if (item.noteKind === "context_recovery_held") return true;
    if (item.noteKind === "resumed") return false;
  }
  return seed?.mode === "live" && seed.recoveryHold === "private_context";
});

const headerText = computed(() => {
  if (stopError.value) return stopError.value;
  if (contextRecoveryHeld.value && phase.value !== "stopping") return "held · private context could not be verified";
  if (phase.value === "connecting") return "connecting…";
  if (phase.value === "disconnected") return "disconnected";
  if (phase.value === "stopping") return "stopping";
  // The agent stopped: the total is frozen at the finish stamp; the reply is in flight.
  if (phase.value === "finished")
    return frozenMs.value === undefined ? "delivering…" : `delivering… · ${formatDuration(frozenMs.value, "clock")}`;
  return runClock ? `running · ${formatDuration(runClock.elapsedMs(nowWall.value), "clock")}` : "running";
});
const pulseCls = computed(() =>
  contextRecoveryHeld.value
    ? "text-warn"
    : stopError.value || phase.value === "disconnected"
      ? "text-bad"
      : phase.value === "running"
        ? "text-ok motion-safe:animate-pulse"
        : phase.value === "finished"
          ? "text-ok" // connected, nothing running: the pulse stops
          : "text-info motion-safe:animate-pulse",
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
      // The record's terminal status: what a step still open at the run's
      // terminal event is marked cut by (live-view item 25).
      ...(seed.status ? { endedBy: seed.status } : {}),
      ...(seed.truncated !== undefined ? { truncated: seed.truncated } : {}),
      ...(seed.untimed ? { untimed: true } : {}),
      callTitle: model.callHeadline,
    });
  }
  if (!runClock) return null;
  const tlPhase: TimelinePhase = contextRecoveryHeld.value
    ? "held"
    : phase.value === "ended"
      ? "ended"
      : phase.value === "finished"
        ? "delivering"
        : "live";
  const totalMs =
    tlPhase === "held"
      ? Math.max(0, (state.lastAt ?? seed.serverNow) - start)
      : tlPhase === "live" && phase.value !== "disconnected"
        ? runClock.elapsedMs(nowWall.value)
        : (frozenMs.value ?? runClock.elapsedMs(nowWall.value));
  return buildTimeline({
    spans: model.spanSet(),
    losses: model.losses(start),
    window: { start, end: start + totalMs },
    owner,
    totalMs,
    phase: tlPhase,
    delivery: liveStamps.value,
    // A live page past `end` knows the stop the viewer saw; anything else that
    // left a step open gets the generic cut mark.
    ...(tlPhase === "ended" && state.stopMode ? { endedBy: `stopped_${state.stopMode}` } : {}),
    callTitle: model.callHeadline,
  });
});
/** The stored events as JSON lines — history mode only (a live page's URL carries its token). */
const eventsHref = isHistory && seed?.mode === "history" ? `/runs/${encodeURIComponent(seed.id)}/events` : undefined;

/** A Longest-steps link: the model opens whatever folds the row, then the page
 *  scrolls there and flashes it once (the `revealed` class, web/src/style.css). */
function reveal(anchor: string): void {
  if (!model.reveal(anchor)) return;
  outputNavigation.value?.pause();
  summaryPreviewOpen.value = false;
  void nextTick().then(() => {
    const el = document.getElementById(anchor);
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    el.classList.add("revealed");
    setTimeout(() => el.classList.remove("revealed"), 1500);
  });
}

// ---- stop control -----------------------------------------------------------
// No control without a stop URL: a hosted ship parent's seed carries none
// (record 0060) — its units run elsewhere, so a stop here could only fail.
const actionsHidden = ref(!!useViewingAs() || isHistory || seed?.mode !== "live" || seed.stopUrl === undefined);
const stopDisabled = ref(false);

function requestStop(mode: "stop" | "kill"): void {
  if (stopDisabled.value || seed?.mode !== "live" || seed.stopUrl === undefined) return;
  if (mode === "kill" && !browser.confirm("Kill this run and delete its row? This action is destructive.")) return;
  stopDisabled.value = true;
  stopError.value = "";
  fetch(`${seed.stopUrl}${seed.stopUrl.includes("?") ? "&" : "?"}mode=${encodeURIComponent(mode)}`, {
    method: "POST",
    credentials: "same-origin",
  })
    .then(async (r) => {
      if (!r.ok) {
        // A refusal carries its reason (a view-as session is told the writes are its own to make,
        // record 0053); a bare failure keeps the status.
        const parsed = (await r.json?.().catch(() => null)) as { message?: unknown } | null;
        throw new Error(typeof parsed?.message === "string" ? parsed.message : `HTTP ${r.status}`);
      }
      if (mode === "kill") {
        browser.leave("/runs");
        return;
      }
      markStopping("hard");
    })
    .catch((err: unknown) => {
      stopError.value = `stop failed: ${err instanceof Error ? err.message : "error"}`;
    })
    .finally(() => {
      stopDisabled.value = false;
    });
}

function markStopping(mode: "soft" | "hard"): void {
  model.markStopping(mode);
  if (phase.value === "connecting" || phase.value === "running") phase.value = "stopping";
}

if (seed?.mode === "live" && seed.stop) markStopping(seed.stop.mode);

// A stop can arrive from the stream too.
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
  () =>
    !contextRecoveryHeld.value &&
    !isHistory &&
    phase.value !== "ended" &&
    phase.value !== "disconnected" &&
    phase.value !== "finished",
);
const runnerClock = computed(() => (live.value ? runnerNow(state, nowWall.value) : null));
provide(RunnerClockKey, runnerClock);
// The files' links and whether the Reply has landed, for every card that lists
// files (live-view.md item 26): the Request, a Follow-up, the Reply, an attach call.
provide(ArtifactLinksKey, artifactLinks);
provide(
  ReplyLandedKey,
  computed(() => state.reply !== null),
);
const waiting = computed(() => (live.value ? liveWait(state, model.pendingCall(), nowWall.value) : null));
// The tail names the deepest open counted span when the timeline knows one —
// `a model turn…`, the same span the lede's `currently thinking …` drills into
// (docs/reference/specs/live-view.md item 25). Before any span, the silent model's verbs:
// a fixed list, a new word every 6 s in order — predictable, not twitchy — so
// the row is visibly alive without a spinner. The word is DERIVED from how
// long this silence has lasted, so every silence starts at "Thinking" and
// nothing rotates while no one is waiting.
const verb = computed(() => {
  if (waiting.value?.kind !== "thinking") return "";
  return timeline.value?.openStep || thinkingVerb(waiting.value.elapsedMs);
});

// ---- fold toggle ---------------------------------------------------------------
function toggleAll(): void {
  model.setAllOpen(!state.allOpen);
}
/** The THIS RUN heading's count: the model's steps (one per narrated or tool-only turn). */
const stepCount = computed(() => state.log.filter((i) => i.kind === "step").length);
/** The newest notepad write (session-log.md item 10): the notepad is replaced
 *  whole on every write, so this is the one that stands open; the earlier
 *  writes are history, folded under their clocks. */
const newestNotepadKey = computed(() => {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const item = state.log[i];
    if (item.kind === "note" && item.noteKind === "notes") return item.key;
  }
  return undefined;
});

function noteClass(note: NoteVm): string {
  if (note.replay) return "text-dimmed";
  // Older records used harness_error for these same bounded local retries.
  const legacyRetry =
    note.noteKind === "harness_error" &&
    /^pi(?:'s (?:follow-up )?model stream ended early| cancelled the (?:follow-up )?model call locally); the turn is held and retry \d+ waits \d+(?:\.\d+)?s inside this run's lease$/.test(
      note.text,
    );
  const routine = [
    "compacted",
    "resumed",
    "model_retry",
    "drain_wait",
    "stop_requested",
    "stopped",
    "stop_landed",
    "head_moved",
    "redispatch",
    "ask_withdrawn",
    "settle_set_aside",
    "tool_unnamed",
    "directory_reached",
    "decline_cascade",
  ].includes(note.noteKind ?? "");
  return routine || legacyRetry ? "bg-info/10 text-info" : "bg-warn/10 text-warn";
}

const runHeader = ref<HTMLElement | null>(null);
const headerHeight = ref(0);
const outputNavigation = ref<InstanceType<typeof RunScrollControls> | null>(null);
const requestPreviewOpen = ref(false);
const summaryPreviewOpen = ref(false);
useResizeObserver(runHeader, () => {
  headerHeight.value = runHeader.value?.getBoundingClientRect().height ?? 0;
});
function jumpToBlock(id: string): void {
  outputNavigation.value?.pause();
  requestPreviewOpen.value = false;
  summaryPreviewOpen.value = false;
  void nextTick().then(() => {
    const target = document.getElementById(id);
    if (target && runHeader.value?.parentElement?.contains(target))
      target.scrollIntoView?.({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
  });
}

// PR-review panel (docs/reference/specs/reading-diff.md item 12): the collector is the
// runs→module adapter — it reads the same frames the timeline gets and, when
// this run is a PR review carrying reading-diff artifacts, gates the button.
const prReview = createPrReviewCollector();
const route = useRoute();
const prPanelOpen = ref(false);
// The panel's "Abridge with meat" control: only when this deployment can
// abridge (`readingDiffAbridge`) and the run is a stored one — the command
// appends to the record. The panel shows it while the git diff stands alone;
// the abridged diff lands through the collector like any other frame.
const abridge =
  seed?.mode === "history" && seed.capabilities.readingDiffAbridge && !useViewingAs()
    ? createReviewAbridge(seed.id, (e) => prReview.handle(e))
    : undefined;
onUnmounted(() => abridge?.dispose());

function handle(e: unknown): void {
  model.handle(e);
  prReview.handle(e);
}

// ---- the stream / the seed -----------------------------------------------------
const makeEventSource = useEventSourceFactory();
let stream: ReturnType<typeof attachRunStream> | null = null;

// History seeds synchronously: the seed IS the stream, and feeding it before
// the first render keeps the paint complete (no flash of an empty page).
if (seed?.mode === "history") {
  for (const e of seed.events) {
    model.handle(e);
    prReview.handle(e);
  }
  model.closePhases(); // a record is over: nothing is in progress under a phase head
}

// The stream attach is the ONE shared with a thread's assistant turn
// (web/src/lib/runStream.ts): the dedupe, the named frames and the phases live
// there; what this page does with each is here. A stop in flight keeps its word:
// the composable moves to `running` only while no stop is asked, and this
// page's `stopping` is mirrored from the stream's phase for every other move.
onMounted(() => {
  if (seed?.mode !== "live") return;
  stream = attachRunStream({
    url: seed.eventsUrl,
    factory: makeEventSource,
    model,
    handle,
    // The agent stopped: the header's duration freezes at the server's finish
    // stamp (docs/reference/specs/tracing.md), the stream stays open for the span
    // records until `end`; nothing runs, the actions go, the reply is on its way.
    onFinished: (frame) => {
      // The actions go whether or not the frame parsed: the run is over either way.
      actionsHidden.value = true;
      if (!frame) return;
      if (runClock) frozenMs.value = runClock.elapsedAt(frame.finishedAt);
      liveStamps.value = { ...liveStamps.value, finishedAt: frame.finishedAt };
    },
    onDisconnected: () => {
      frozenMs.value ??= runClock?.elapsedMs(nowWall.value);
    },
    onEnd: (frame) => {
      actionsHidden.value = true;
      frozenMs.value ??= runClock?.elapsedMs(nowWall.value); // an `end` with no `finished` before it (a stored stream) freezes here
      liveStamps.value = { ...liveStamps.value, ...frame };
    },
  });
  watch(
    stream.phase,
    (p) => {
      // The viewer's own stop keeps `stopping` until the stream says finished or ended.
      if (phase.value === "stopping" && (p === "running" || p === "connecting")) return;
      phase.value = p;
    },
    { immediate: true },
  );
});

onUnmounted(() => {
  stream?.close();
});

// ---- request source / meta -------------------------------------------------------
/** Only an http(s) source URL becomes a link — anything else stays text. */
function httpsUrl(url: string | undefined): string {
  return url && /^https?:\/\//.test(url) ? url : "";
}
const sourceUrl = computed(() => httpsUrl(state.request?.source?.url));
/** The thread this run is a turn of, as a page here (web-chat.md item 4): a run is one
 *  message's work, the thread is the conversation it belongs to. */
const threadLink = computed(() =>
  seed && (seed.mode === "live" || seed.mode === "history") && seed.threadKey ? threadHref(seed.threadKey) : null,
);
/** The way up (live-view item 33): the pipeline or conductor run this one was
 *  spawned by, and — for a ship unit's thread run — the unit it belongs to,
 *  each opening its own page. Nothing drawn when the seed carries none. */
const lineage = seed && (seed.mode === "live" || seed.mode === "history") ? (seed.lineage ?? null) : null;
// A live parent's link keeps its capability token (a hosted ship parent is
// live for the pipeline's whole life, so a tokenless link could only 404).
const lineageParentHref = lineage?.parent
  ? `/runs/${encodeURIComponent(lineage.parent.id)}${lineage.parent.token ? `?t=${encodeURIComponent(lineage.parent.token)}` : ""}`
  : "";
const lineageUnitHref = lineage?.unit ? `/runs/unit/${encodeURIComponent(lineage.unit.key)}` : "";
/** The REVIEW/CODING row's links (item 19): the repo, the branch, the head
 *  commit and the PR, each built only from a value whose shape was verified
 *  (`githubLinks.ts`) — an odd value renders as text, never as a link. */
const prReference = computed(() => ({
  repo: state.meta?.repo ?? prReview.state.pr.repo,
  number: state.meta?.pr ?? state.prOpened?.number ?? prReview.state.pr.number,
}));
const hasPrContext = computed(() => prReference.value.number !== undefined || prReview.state.ready);
const prDetailsText = computed(() =>
  [state.meta?.ref ? "Branch: " + state.meta.ref : "", state.meta?.headSha ? "Commit: " + state.meta.headSha : ""]
    .filter(Boolean)
    .join("\n"),
);
const links = computed(() => {
  const m = state.meta;
  return {
    repo: githubRepoUrl(prReference.value.repo),
    tree: githubTreeUrl(prReference.value.repo, m?.ref),
    commit: githubCommitUrl(prReference.value.repo, m?.headSha),
    pr: githubPrUrl(prReference.value.repo, prReference.value.number),
  };
});
/** The harness and whose word put the run there (harness.md item 10) — `opencode
 *  harness (user scope)`; the bare harness when no scope named the preset. */
const harnessFact = computed(() => {
  const m = state.meta;
  if (!m?.harness) return "";
  const scope = m.harnessScope === "defaults" ? "defaults" : m.harnessScope ? `${m.harnessScope} scope` : "";
  return scope ? `${m.harness} harness (${scope})` : `${m.harness} harness`;
});
/** What the Reply is, from the run's facts (`replyCaption`). */
const reply = computed(() =>
  replyCaption({ meta: state.meta, requestText: state.request?.text ?? "", prOpened: state.prOpened }),
);

/** Block headers (Request / Earlier in this thread / Reply) read a human moment
 *  — `Aug 30, 3:06 PM` — with the exact ISO stamp on hover; the timeline's
 *  meta rows read the wall clock (`5:19:57 PM PDT`, formatClock). */
function fmtTime(at: number | undefined): string {
  return typeof at === "number" ? formatDateTime(at, nowWall.value) : "";
}
function fmtTimeTitle(at: number | undefined): string | undefined {
  return typeof at === "number" ? formatLocalIso(at) : undefined;
}
</script>

<template>
  <div class="green-run-evidence" :style="{ '--run-header-height': headerHeight + 'px' }">
    <header ref="runHeader" class="run-header mx-auto max-w-6xl">
      <div class="run-heading">
        <div class="run-title">
          <RouterLink class="back run-back" to="/runs" aria-label="All runs"
            ><UIcon name="i-lucide-arrow-left" aria-hidden="true"
          /></RouterLink>
          <h1>{{ state.title ?? seed?.runTitle ?? "Run details" }}</h1>
        </div>
        <div v-if="hasPrContext" class="run-pr-context">
          <a v-if="links.pr" class="prlink" :href="links.pr" target="_blank" rel="noopener noreferrer">
            <GithubMark /><span class="truncate">{{ prReference.repo }} #{{ prReference.number }}</span>
          </a>
          <span v-else-if="prReference.number" class="prlink"
            ><GithubMark /><span class="truncate">{{ prReference.repo }} #{{ prReference.number }}</span></span
          >
          <UPopover v-if="state.meta?.ref || state.meta?.headSha" :content="{ align: 'end' }">
            <UTooltip :text="prDetailsText"
              ><button type="button" class="run-info" aria-label="Pull request details">
                <UIcon name="i-lucide-info" aria-hidden="true" /></button
            ></UTooltip>
            <template #content>
              <div class="run-preview run-pr-details">
                <p class="run-preview-label">Pull request details</p>
                <a v-if="links.repo" class="repo" :href="links.repo" target="_blank" rel="noopener noreferrer">{{
                  prReference.repo
                }}</a>
                <span v-else class="repo">{{ prReference.repo }}</span>
                <span class="run-preview-label mt-3">Branch</span>
                <a v-if="links.tree" class="reftag" :href="links.tree" target="_blank" rel="noopener noreferrer">{{
                  state.meta?.ref
                }}</a>
                <span v-else class="reftag">{{ state.meta?.ref ?? "Not recorded" }}</span>
                <span class="run-preview-label mt-3">Commit</span>
                <a
                  v-if="links.commit && state.meta?.headSha"
                  class="sha"
                  :href="links.commit"
                  :title="state.meta.headSha"
                  target="_blank"
                  rel="noopener noreferrer"
                  >{{ shortSha(state.meta.headSha) }}</a
                >
                <span v-else class="sha">{{
                  state.meta?.headSha ? shortSha(state.meta.headSha) : "Not recorded"
                }}</span>
              </div>
            </template>
          </UPopover>
          <button
            v-if="prReview.state.ready"
            type="button"
            class="reading-diff inline-flex cursor-pointer items-center gap-1 whitespace-nowrap text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
            data-testid="reading-diff-button"
            @click="prPanelOpen = true"
          >
            <UIcon name="i-lucide-git-compare" class="size-3.5 shrink-0" aria-hidden="true" />Reading diff
          </button>
          <RouterLink
            v-if="findingsHref && findingsLedger"
            class="findings"
            :to="findingsHref"
            title="the pull request's findings ledger on its unit's page"
            >Findings · {{ findingsLedger.rows }}</RouterLink
          >
        </div>
      </div>
      <div class="run-statusline">
        <span class="conn flex items-center gap-2 font-mono">
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
            <span v-if="costText" id="cost" class="cost text-xs tabular-nums text-muted" :title="costTitle"
              >· {{ costText }}</span
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
        <span v-if="!actionsHidden" id="actions" class="actions flex gap-1.5">
          <UTooltip
            v-if="!state.stopMode && phase !== 'disconnected'"
            text="End the current turn, clean up resources, and keep the stopped run"
          >
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              label="Stop"
              :disabled="stopDisabled"
              @click="requestStop('stop')"
            />
          </UTooltip>
          <UTooltip text="Kill immediately and delete the run row">
            <UButton
              size="xs"
              color="error"
              variant="outline"
              label="Kill"
              :disabled="stopDisabled"
              @click="requestStop('kill')"
            />
          </UTooltip>
        </span>
      </div>
      <div v-if="state.meta" id="runmeta" class="runmeta run-runtime-facts">
        <span
          class="agent shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.65rem] font-medium leading-none uppercase tracking-wide"
          :class="AGENT_HUE[agentHue(state.meta.agent)]"
          :data-agent-hue="agentHue(state.meta.agent)"
          >{{ state.meta.agent }}</span
        >
        <span class="model">{{ state.meta.model }}</span>
        <span v-if="state.meta.effort" class="effort">{{ state.meta.effort }} effort</span>
        <span v-if="harnessFact" class="harness">{{ harnessFact }}</span>
      </div>
      <nav class="run-quick-nav" aria-label="Run context">
        <UPopover v-if="state.request" v-model:open="requestPreviewOpen" :content="{ align: 'start' }">
          <button type="button" class="run-quick-button" data-testid="request-preview-trigger">
            <UIcon name="i-lucide-message-square" aria-hidden="true" />Request<UIcon
              name="i-lucide-chevron-down"
              class="run-quick-chevron"
              aria-hidden="true"
            />
          </button>
          <template #content
            ><div class="run-preview">
              <p class="run-preview-label">Initial request</p>
              <MarkdownText :text="state.request.text" /><button
                type="button"
                class="run-preview-jump"
                @click="jumpToBlock('request')"
              >
                Open full request<UIcon name="i-lucide-arrow-up-right" aria-hidden="true" />
              </button></div
          ></template>
        </UPopover>
        <UPopover v-if="timeline" v-model:open="summaryPreviewOpen" :content="{ align: 'start' }">
          <button type="button" class="run-quick-button" data-testid="summary-preview-trigger">
            <UIcon name="i-lucide-chart-no-axes-combined" aria-hidden="true" /><span class="run-summary-prefix"
              >Run </span
            >summary<UIcon name="i-lucide-chevron-down" class="run-quick-chevron" aria-hidden="true" />
          </button>
          <template #content>
            <div class="run-preview">
              <p class="run-preview-label">Run summary</p>
              <p>{{ timeline.lede }}</p>
              <ol v-if="timeline.ranked.length" class="run-summary-steps">
                <li v-for="item in timeline.ranked" :key="item.anchor">
                  <button type="button" @click="reveal(item.anchor)">
                    <span class="tabular-nums">{{ formatDuration(item.ms, "clock") }}</span
                    ><span class="truncate">{{ item.label }}</span
                    ><UIcon name="i-lucide-arrow-up-right" aria-hidden="true" />
                  </button>
                </li>
              </ol>
              <button type="button" class="run-preview-jump" @click="jumpToBlock('timeline')">
                Open full summary<UIcon name="i-lucide-arrow-up-right" aria-hidden="true" />
              </button>
            </div>
          </template>
        </UPopover>
        <RunScrollControls ref="outputNavigation" :live="live" />
      </nav>
    </header>

    <div class="run-body mx-auto max-w-6xl">
      <!-- The page is FOUR blocks a first-time reader can name, each headed
           the same way (small caps label · muted facts · the moment at the
           right edge): REQUEST — what came in; EARLIER IN THIS THREAD — the
           turns the model was given, folded; THIS RUN — the timeline's summary
           card and then the steps; REPLY — what went back. -->

      <!-- The way up (item 33): a spawned run names its pipeline (or parent)
           run and — a ship unit's thread run — its unit, each a page here. -->
      <div
        v-if="lineage"
        id="lineage"
        class="lineage facts mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-(--sb-gutter) font-mono text-xs text-dimmed"
      >
        <span class="text-[0.68rem] font-medium uppercase tracking-wider">part of</span>
        <RouterLink
          v-if="lineageParentHref && lineage.parent"
          class="parent text-primary no-underline hover:underline"
          :to="lineageParentHref"
          data-testid="lineage-parent"
          :title="lineage.unit ? 'the pipeline this run belongs to' : 'the run that spawned this one'"
          >{{ lineage.unit ? "pipeline" : "parent run" }} ›</RouterLink
        >
        <RouterLink
          v-if="lineageUnitHref && lineage.unit"
          class="unit text-primary no-underline hover:underline"
          :to="lineageUnitHref"
          data-testid="lineage-unit"
          title="the unit this run's thread belongs to"
          >unit {{ lineage.unit.id }}{{ lineage.unit.title ? ` · ${lineage.unit.title}` : "" }} ›</RouterLink
        >
        <span v-if="lineage.unit?.thread" class="threadkind">{{ lineage.unit.thread }} thread</span>
      </div>

      <!-- Request -->
      <!-- The card's spacing states the hierarchy: the frame (label, meta)
           and the framed prose breathe by the same rhythm — the meta row is
           small type, so it gets MORE air, not less (gap-y for the phone
           where it wraps to two lines). -->
      <section
        v-if="state.request"
        id="request"
        class="block mb-4 rounded-lg border border-default bg-(--ui-bg-muted) px-(--sb-gutter) py-3"
      >
        <h2 class="mb-2 flex items-baseline gap-2.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">
          <span>Request</span>
          <span
            v-if="state.request.source"
            class="source flex items-center gap-2 font-normal normal-case tracking-normal text-dimmed"
          >
            <template v-if="state.request.source.channel">
              <SlackMark />
              <a
                v-if="sourceUrl"
                class="text-muted no-underline hover:text-primary hover:underline"
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
          <a
            v-if="threadLink"
            class="thread font-normal normal-case tracking-normal text-muted no-underline hover:text-primary hover:underline"
            :href="threadLink"
            title="the thread this run is a turn of"
            data-testid="thread-link"
            >in thread ›</a
          >
          <span
            class="ts ml-auto select-none text-xs font-normal normal-case tracking-normal text-dimmed"
            :title="fmtTimeTitle(state.request.at)"
            >{{ fmtTime(state.request.at) }}</span
          >
        </h2>
        <!-- A long request folds to its first lines (item 12); the fade takes this card's ground. -->
        <ExpandableText :lines="3">
          <MarkdownText :text="state.request.text" />
        </ExpandableText>
        <!-- The files that came with the request (item 26), outside the fold so they stay in view. -->
        <MessageFiles v-if="state.request.files.length > 0" :files="state.request.files" />
      </section>

      <!-- Reply, on a finished run's page: the outcome before the work. -->
      <ReplyBlock
        v-if="state.reply && replyFirst"
        position="first"
        :text="state.reply.text"
        :caption="reply"
        :when="fmtTime(state.reply.at)"
        :when-title="fmtTimeTitle(state.reply.at)"
        :files="state.reply.files"
      />

      <!-- What this run is the parent of (item 28): a ship record's units, each
           opening its unit page; a conductor's spawned runs, each opening to
           its own timeline here — in the plan's order and in start order. -->
      <RunUnitsBlock v-if="units.length > 0" :units="units" />
      <RunChildrenBlock v-if="children.length > 0" :children="children" :now="nowWall" />

      <!-- Referenced threads (record 0037): the conversations the request
           pointed at and the run quoted, as the model saw them — the same fold
           grammar as the Context block below, one row per thread with its
           channel, count and permalink, the quoted lines under it. -->
      <details v-if="state.references.length > 0" id="references" class="group mb-4 px-(--sb-gutter)">
        <summary
          class="flex min-h-6 cursor-pointer list-none items-baseline gap-2.5 font-mono text-xs font-medium uppercase tracking-wider text-muted hover:text-toned [&::-webkit-details-marker]:hidden"
        >
          <span
            class="chev select-none text-xs text-dimmed transition-transform group-open:rotate-90 motion-reduce:transition-none"
            >❯</span
          >
          <span>Referenced thread{{ state.references.length === 1 ? "" : "s" }}</span>
          <span class="count font-normal normal-case tracking-normal text-dimmed"
            >· {{ state.references.length }} thread{{ state.references.length === 1 ? "" : "s" }}</span
          >
        </summary>
        <div id="referencedthreads" class="pb-1 pl-5">
          <div
            v-for="thread in state.references"
            :key="thread.key"
            class="reference border-t border-default py-1.5 first-of-type:border-t-0"
          >
            <div class="flex items-baseline gap-2 font-mono text-xs text-dimmed">
              <a
                class="text-muted no-underline hover:text-primary hover:underline"
                :href="thread.url"
                target="_blank"
                rel="noopener noreferrer"
                >#{{ thread.channelName }}</a
              >
              <span>· {{ thread.messages }} message{{ thread.messages === 1 ? "" : "s" }}</span>
              <span class="ts ml-auto shrink-0 select-none" :title="fmtTimeTitle(thread.at)">{{
                fmtTime(thread.at)
              }}</span>
            </div>
            <div class="quoted mt-1 whitespace-pre-wrap break-words font-mono text-xs opacity-85">
              <div v-for="(line, i) in quotedLines(thread.text)" :key="i">{{ line }}</div>
            </div>
          </div>
        </div>
      </details>

      <!-- Earlier in this thread: the turns the model was given as context,
           collapsed by default. The chevron says "this opens" — the same fold
           grammar as the cards. -->
      <details v-if="state.context.length > 0" id="context" class="group mb-4 px-(--sb-gutter)">
        <summary
          class="flex min-h-6 cursor-pointer list-none items-baseline gap-2.5 font-mono text-xs font-medium uppercase tracking-wider text-muted hover:text-toned [&::-webkit-details-marker]:hidden"
        >
          <span
            class="chev select-none text-xs text-dimmed transition-transform group-open:rotate-90 motion-reduce:transition-none"
            >❯</span
          >
          <span>Earlier in this thread</span>
          <span class="count font-normal normal-case tracking-normal text-dimmed"
            >· {{ state.context.length }} turn{{ state.context.length === 1 ? "" : "s" }}</span
          >
        </summary>
        <div id="contextturns" class="pb-1 pl-5">
          <div
            v-for="turn in state.context"
            :key="turn.key"
            class="turn flex items-baseline gap-3 border-t border-default py-1.5 opacity-85 first-of-type:border-t-0"
          >
            <MarkdownText :text="turn.text" />
            <span
              class="ts ml-auto shrink-0 select-none font-mono text-xs text-dimmed"
              :title="fmtTimeTitle(turn.at)"
              >{{ fmtTime(turn.at) }}</span
            >
          </div>
        </div>
      </details>

      <!-- This run: the heading over the summary card and the steps, with the
           one fold control at the right edge — a text button in the heading's
           own row, at the same weight as the card's controls. -->
      <h2
        id="thisrun"
        class="mb-2 flex items-baseline gap-2.5 px-(--sb-gutter) font-mono text-xs font-medium uppercase tracking-wider text-muted"
      >
        <span>This run</span>
        <span v-if="stepCount > 0" class="count font-normal normal-case tracking-normal text-dimmed"
          >· {{ stepCount }} step{{ stepCount === 1 ? "" : "s" }}</span
        >
        <button
          id="fold"
          type="button"
          class="ml-auto cursor-pointer font-normal normal-case tracking-normal text-dimmed hover:text-toned focus-visible:outline-2 focus-visible:outline-primary"
          :aria-pressed="state.allOpen ? 'true' : 'false'"
          :data-open="state.allOpen ? '1' : '0'"
          :title="state.allOpen ? 'Close every call card' : 'Open every call card'"
          @click="toggleAll"
        >
          {{ state.allOpen ? "Collapse all" : "Expand all" }}
        </button>
      </h2>

      <!-- Where the time went (live-view item 25): the run's shape from its spans and stamps alone. -->
      <TimelineSection v-if="timeline" :vm="timeline" :events-href="eventsHref" @reveal="reveal" />

      <!-- The steps -->
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
            :id="`span-${item.turn.spanId}`"
            class="turn mt-5 border-l-2 border-(--ui-border-accented)/50 pb-3 pl-3 pt-2"
          >
            <!-- A turn that produced no step: the same ONE meta row a step heads with. -->
            <div
              class="meta flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 pr-(--sb-gutter) font-mono text-xs tabular-nums text-dimmed"
            >
              <span class="thought" :class="item.turn.quick ? '' : 'text-warn'" :title="item.turn.label"
                >thought {{ item.turn.chip }}</span
              >
              <span
                v-if="item.turn.switched"
                class="model-switch order-first rounded border border-info/40 bg-info/10 px-1.5 font-medium text-info"
                :title="`model changed: this turn ran on ${item.turn.model}`"
                >⇄ {{ modelName(item.turn.model) }}</span
              >
              <span
                v-else-if="item.turn.showModel"
                class="model-badge order-first rounded bg-accented px-1.5 text-[0.68rem] font-medium leading-normal tracking-wider text-muted"
                :title="item.turn.model"
                >{{ modelName(item.turn.model) }}</span
              >
              <span v-for="(f, i) in item.turn.facts" :key="i" class="fact">{{ f }}</span>
              <a
                v-if="item.note && item.noteHref"
                class="nonar font-sans italic text-dimmed no-underline hover:text-primary hover:underline"
                :href="item.noteHref"
                >{{ item.note }}</a
              >
              <span v-else-if="item.note" class="nonar font-sans italic">{{ item.note }}</span>
              <span
                v-if="item.turn.at !== undefined"
                class="ts ml-auto select-none"
                :title="formatLocalIso(item.turn.at)"
                >{{ formatClock(item.turn.at) }}</span
              >
            </div>
          </li>
          <!-- A streamed span that is a step of its own (docs/reference/specs/tracing.md). -->
          <SpanRow v-else-if="item.kind === 'span'" :item="item" />
          <!-- A phase of the bar as a group of rows under one head — GETTING
               READY, FINISHING UP — in the bar's own words (live-view item 25):
               open while the phase is in progress, closed once the next begins,
               the reader's toggle winning from then on. -->
          <li v-else-if="item.kind === 'phase'" class="phase py-0.5 font-mono text-xs" :data-phase="item.phase">
            <button
              type="button"
              class="phase-head flex w-full cursor-pointer items-baseline gap-2 text-left text-muted hover:text-toned"
              :aria-expanded="item.open"
              @click.prevent="model.togglePhase(item)"
            >
              <span class="glyph select-none text-dimmed">{{ item.open ? "▾" : "▸" }}</span>
              <!-- The bar's swatch for this phase: the head IS that segment's rows. -->
              <span
                class="swatch inline-block size-2 shrink-0 self-center rounded-[2px]"
                :class="phasePaint(item.phase)"
                aria-hidden="true"
              />
              <span class="what">{{ phaseHeadText(item) }}</span>
            </button>
            <ul v-if="item.open" class="m-0 list-none p-0 pl-4">
              <SpanRow v-for="row in item.rows" :key="row.key" :item="row" />
            </ul>
          </li>
          <!-- A follow-up steered into this run (docs/reference/specs/thread-admission.md
               item 2): the same run, more input — the Request's treatment,
               at the moment the run read it, with who sent it and when. -->
          <li
            v-else-if="item.kind === 'followup'"
            class="followup block mt-5 rounded-lg border border-default bg-(--ui-bg-muted) px-(--sb-gutter) py-3"
          >
            <h2
              class="mb-2 flex items-baseline gap-2.5 font-mono text-xs font-medium uppercase tracking-wider text-muted"
            >
              <span>↪ Follow-up</span>
              <span
                v-if="item.input.source?.user"
                class="source flex items-center gap-2 font-normal normal-case tracking-normal text-dimmed"
              >
                <a
                  v-if="httpsUrl(item.input.source.url)"
                  class="text-muted no-underline hover:text-primary hover:underline"
                  :href="item.input.source.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="open the message"
                  >{{ item.input.source.user }}</a
                >
                <span v-else>{{ item.input.source.user }}</span>
              </span>
              <span
                class="ts ml-auto select-none text-xs font-normal normal-case tracking-normal text-dimmed"
                :title="fmtTimeTitle(item.input.at)"
                >{{ fmtTime(item.input.at) }}</span
              >
            </h2>
            <MarkdownText :text="item.input.text" />
            <!-- The files dropped with this follow-up (item 26). -->
            <MessageFiles v-if="item.input.files.length > 0" :files="item.input.files" />
          </li>
          <!-- The notepad the `notes` tool wrote (docs/reference/specs/session-log.md
               item 10): the document the agent keeps for the next run in this
               thread — what is done, in progress, next, and the facts — so it
               reads as one, its Markdown rendered, under the clock of its
               write. The notepad is replaced whole on every write: the newest
               stands open, an earlier write folds as superseded. -->
          <li v-else-if="item.noteKind === 'notes'" class="mt-5">
            <details
              class="notepad group rounded-lg border border-default bg-(--ui-bg-muted) px-(--sb-gutter) py-2"
              :open="item.key === newestNotepadKey"
            >
              <summary
                class="flex min-h-6 cursor-pointer list-none items-baseline gap-2.5 font-mono text-xs font-medium uppercase tracking-wider text-muted hover:text-toned [&::-webkit-details-marker]:hidden"
              >
                <span
                  class="chev select-none text-xs text-dimmed transition-transform group-open:rotate-90 motion-reduce:transition-none"
                  >❯</span
                >
                <span>📝 Notes for this thread</span>
                <span v-if="item.key !== newestNotepadKey" class="font-normal normal-case tracking-normal text-dimmed"
                  >· superseded</span
                >
                <span
                  v-if="item.at !== undefined"
                  class="ts ml-auto select-none font-normal normal-case tracking-normal text-dimmed"
                  :title="formatLocalIso(item.at)"
                  >{{ formatClock(item.at) }}</span
                >
              </summary>
              <!-- The notepad's section headings in the page's label voice (the
                   summary row's), not the prose scale: a heading here names a
                   list, it is not a title. -->
              <MarkdownText
                :text="item.text"
                class="mt-1 [&_h1]:mb-1.5 [&_h1]:mt-4 [&_h1]:font-mono [&_h1]:text-xs [&_h1]:font-medium [&_h1]:uppercase [&_h1]:tracking-wider [&_h1]:text-muted [&_h2]:mb-1.5 [&_h2]:mt-4 [&_h2]:font-mono [&_h2]:text-xs [&_h2]:font-medium [&_h2]:uppercase [&_h2]:tracking-wider [&_h2]:text-muted [&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:font-mono [&_h3]:text-xs [&_h3]:font-medium [&_h3]:uppercase [&_h3]:tracking-wider [&_h3]:text-muted [&>:first-child]:mt-1"
              />
            </details>
          </li>
          <li
            v-else
            class="note mt-4 flex items-baseline gap-3 rounded-md pl-3 pr-(--sb-gutter) py-1.5"
            :class="noteClass(item)"
          >
            <span>{{ (item.replay ? "… " : "⏱ ") + item.text }}</span>
            <span
              v-if="item.at !== undefined"
              class="ts ml-auto select-none font-mono text-xs text-dimmed"
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
        <PendingTurnRow
          v-if="waiting?.kind === 'thinking'"
          id="thinking"
          class="ml-3.5 mt-5 first:mt-0"
          :verb="verb"
          :elapsed-ms="waiting.elapsedMs"
          :slow="waiting.slow"
          :model="state.model"
        />
      </ol>

      <!-- Reply, on a live page: it lands last, as it arrives. -->
      <ReplyBlock
        v-if="state.reply && !replyFirst"
        position="last"
        :text="state.reply.text"
        :caption="reply"
        :when="fmtTime(state.reply.at)"
        :when-title="fmtTimeTitle(state.reply.at)"
        :files="state.reply.files"
      />
    </div>

    <!-- The shared portal keeps the diff above the navigation at every width. -->
    <PrReviewSlideover v-model:open="prPanelOpen" :data="prReview.state" :abridge="abridge">
      <template #actions="{ close }">
        <RouterLink
          v-if="seed"
          class="green-button"
          :to="{ path: `/runs/${encodeURIComponent(seed.id)}`, query: { ...route.query, view: 'pull-request' } }"
          @click="close()"
          ><UIcon name="i-lucide-panel-top" />Open pull request in main pane</RouterLink
        >
      </template>
    </PrReviewSlideover>
  </div>
</template>

<style scoped>
.green-run-evidence {
  padding-bottom: 80px;
}
.green-run-evidence :deep([id]) {
  scroll-margin-top: calc(var(--run-header-height, 160px) + 12px);
}
.run-header {
  position: sticky;
  top: 0;
  z-index: 20;
  padding: 10px 0 12px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.run-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 16px;
}
.run-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.run-title h1 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 22px;
  line-height: 1.35;
  font-weight: 600;
  letter-spacing: -0.03em;
}
.run-back,
.run-info {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.run-back:hover,
.run-info:hover {
  color: var(--ui-text-highlighted);
  background: var(--ui-bg-muted);
}
.run-back .iconify,
.run-info .iconify {
  width: 17px;
  height: 17px;
}
.run-pr-context {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}
.prlink {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--ui-primary);
  text-decoration: none;
}
.prlink:hover {
  text-decoration: underline;
}
.run-statusline {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px 16px;
  margin: 8px 0;
  min-height: 28px;
}
.conn {
  min-width: 0;
  flex-wrap: wrap;
}
.run-runtime-facts {
  display: flex;
  align-items: center;
  gap: 12px;
  overflow-x: auto;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
  padding-bottom: 3px;
}
.run-quick-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  min-width: 0;
  overflow-x: auto;
}
.run-quick-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 8px;
  flex-shrink: 0;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  color: var(--ui-text-toned);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.run-quick-button:hover {
  border-color: var(--ui-border-accented);
  background: var(--ui-bg-muted);
}
.run-quick-button .iconify {
  width: 14px;
  height: 14px;
}
.run-preview {
  width: min(460px, calc(100vw - 32px));
  max-height: min(480px, 60dvh);
  overflow: auto;
  padding: 16px;
  font-size: 13px;
}
.run-preview-label {
  display: block;
  margin-bottom: 8px;
  color: var(--ui-text-muted);
  font-size: 12px;
  font-weight: 500;
}
.run-pr-details > a,
.run-pr-details > .reftag,
.run-pr-details > .sha {
  display: block;
  overflow-wrap: anywhere;
}
.run-pr-details a {
  color: var(--ui-primary);
}
.run-preview-jump {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  margin-top: 12px;
  color: var(--ui-primary);
  cursor: pointer;
}
.run-preview-jump .iconify {
  width: 14px;
  height: 14px;
}
.run-summary-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;
}
.run-summary-steps button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  cursor: pointer;
  text-align: left;
}
.run-summary-steps button > span:first-child {
  flex-shrink: 0;
  color: var(--ui-text-muted);
}
.run-summary-steps .iconify {
  width: 14px;
  height: 14px;
  margin-left: auto;
  flex-shrink: 0;
}
@media (max-width: 767px) {
  .run-header {
    padding-top: 8px;
  }
  .run-heading {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
  .run-title h1 {
    font-size: 20px;
  }
  .run-pr-context {
    min-height: 36px;
  }
  .run-pr-context .prlink {
    flex: 1;
  }
  .run-back,
  .run-info {
    min-width: 44px;
    height: 44px;
  }
  .run-quick-button {
    min-height: 44px;
    gap: 4px;
    padding: 0 6px;
  }
  .run-summary-prefix,
  .run-quick-chevron {
    display: none;
  }
  .run-preview-jump,
  .run-summary-steps button {
    min-height: 44px;
  }
}
</style>
