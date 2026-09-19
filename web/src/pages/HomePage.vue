<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, provide, reactive, ref, watch } from "vue";
import type { HomeTurnSeed } from "@core/channels/webSeed.js";
import { retentionSentence } from "@core/channels/webSeed.js";
import { FAVICON_IDLE, FAVICON_LIVE } from "@core/channels/favicon.js";
import AppShell from "../components/AppShell.vue";
import ChatComposer from "../components/home/ChatComposer.vue";
import ConversationRail from "../components/home/ConversationRail.vue";
import EmptyState from "../components/home/EmptyState.vue";
import PersonTurn from "../components/home/PersonTurn.vue";
import AssistantTurn from "../components/home/AssistantTurn.vue";
import SilentTurn from "../components/home/SilentTurn.vue";
import MarkdownText from "../components/MarkdownText.vue";
import { browser } from "../lib/browser";
import { useSeed } from "../lib/seed";
import { useWallClock } from "../lib/wallClock";
import { MarkPulseKey } from "../lib/markPulse";
import {
  clampRailWidth,
  classifyReply,
  composerMode,
  conversationTitle,
  liveUrls,
  matchSteer,
  RAIL_PREF,
  RAIL_WIDTH,
  railPrefs,
  shortcutFor,
  shouldFollow,
} from "../lib/homeModel";
import { formatDuration } from "../lib/format";
import { SURFACE_NAME } from "../lib/indexRow";
import { stripSlash } from "../lib/slashCompleter";
import { useEventSourceFactory, type EventSourceLike } from "../lib/eventSource";
import { applyIndexEvent, liveRailRows, railLiveState } from "../lib/railLive";

// The home page (docs/reference/specs/web-chat.md; record 0043): a conversation
// is the runs of one thread, drawn as the person's turns and the runs they
// started; the composer POSTs a message and the page learns what happened from
// the run's own events, never from the adapter's reply. The page holds no rule
// the pipeline does not: a `202` mounts a live turn on the run's stream, a
// `200` is a hand-back (fills the composer), a steer acknowledgement (the live
// turn's `input` event confirms the turn already drawn) or an inline turn.

const seed = useSeed("home");
const now = useWallClock(seed?.now);
const conversation = seed?.conversation ?? "";
const retention = retentionSentence(seed?.retentionDays ?? null);

type Item =
  | { key: string; kind: "person"; text: string; at: number; pending: boolean; folded?: string; failed?: string }
  | {
      key: string;
      kind: "assistant";
      turn: HomeTurnSeed;
      live: { eventsUrl: string; stopUrl: string; serverNow?: number } | null;
      ended: boolean;
    }
  | { key: string; kind: "silent"; reason: string; at: number }
  | { key: string; kind: "inline"; text: string };

let seq = 0;
const key = (k: string) => `${k}-${++seq}`;
const items = reactive<Item[]>([]);
for (const t of seed?.turns ?? []) {
  // A silent intake receipt (item 12): the gate read a message and answered
  // nothing — one read-not-answered line where the run would have been.
  if ("kind" in t) {
    items.push({ key: key("s"), kind: "silent", reason: t.reason, at: t.decidedAt });
    continue;
  }
  items.push({ key: key("p"), kind: "person", text: t.request, at: t.receivedAt ?? t.startedAt, pending: false });
  const live =
    !t.finished && t.token
      ? {
          eventsUrl: `/runs/${encodeURIComponent(t.id)}/events?t=${t.token}`,
          stopUrl: `/runs/${encodeURIComponent(t.id)}/stop?t=${t.token}`,
          serverNow: seed?.now,
        }
      : null;
  items.push({ key: key("a"), kind: "assistant", turn: t, live, ended: t.finished });
}

/** The assistant turn whose run is live in this conversation, if any (one live
 *  run per thread). A hosted ship parent (record 0060) is skipped: it occupies
 *  no thread — its units run elsewhere — so the composer keeps reading `send`
 *  while its turn still streams. */
const liveItem = computed(() => {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "assistant" && it.live && !it.ended && it.turn.hosted !== true) return it;
  }
  return null;
});
const stopUrl = ref<string | null>(null);

// ---- the mark's pulse (rule 6): every send plays the route once ----------------
const pulse = ref(0);
provide(MarkPulseKey, pulse);

// ---- the composer ----------------------------------------------------------------
const text = ref("");
const hint = ref<string | undefined>(undefined);
const mode = computed(() => composerMode(liveItem.value !== null, text.value));
const sending = ref(false);
watch(text, () => {
  if (hint.value && text.value === "") hint.value = undefined;
});

/** A chip sends its words: one click, no Enter (rule 7). */
function pick(s: string): void {
  text.value = s;
  void submit();
}

async function submit(): Promise<void> {
  if (!seed || sending.value) return;
  // A command typed through the palette keeps its slash while it is being
  // completed; the bot reads `<group> <verb>` at the start of a message.
  const body = stripSlash(text.value.trim(), seed.commands);
  if (body === "") return;
  // The reactive proxy, not the raw object: the turn is mutated after the POST answers.
  const person = reactive<Item & { kind: "person" }>({
    key: key("p"),
    kind: "person",
    text: body,
    at: now.value,
    pending: true,
  });
  items.push(person);
  text.value = "";
  hint.value = undefined;
  sending.value = true;
  pulse.value++;
  try {
    const res = await fetch(seed.sendUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      runId?: string;
      viewPath?: string;
      reply?: string;
      error?: string;
    };
    if (res.status === 202 && typeof payload.viewPath === "string" && typeof payload.runId === "string") {
      const urls = liveUrls(payload.viewPath);
      if (!urls) throw new Error("the run's view path was not one");
      person.pending = false;
      // A fresh conversation exists on the server now: the address names it,
      // so a reload finds it, without a load or a history entry (rule 3).
      if (browser.pathname() === "/threads") browser.replaceUrl(`/threads/${encodeURIComponent(conversation)}`);
      items.push({
        key: key("a"),
        kind: "assistant",
        turn: {
          id: payload.runId,
          request: body,
          startedAt: now.value,
          receivedAt: now.value,
          finished: false,
          eventCount: 0,
        },
        live: { eventsUrl: urls.eventsUrl, stopUrl: urls.stopUrl },
        ended: false,
      });
      return;
    }
    if (res.ok && typeof payload.reply === "string") {
      person.pending = false;
      const reply = classifyReply(payload.reply);
      if (reply.kind === "handBack") {
        text.value = reply.command;
        // A second line (the cut note, the store-unreachable note) is shown as
        // the hint beside the box, never as part of the command to run.
        hint.value = reply.note ?? "Enter runs it";
      } else if (reply.kind === "inline") {
        items.push({ key: key("i"), kind: "inline", text: reply.text });
      }
      // A steer acknowledgement paints nothing: the live turn's `input` event confirms the turn.
      return;
    }
    throw new Error(payload.error ?? `HTTP ${res.status}`);
  } catch (err) {
    person.pending = false;
    person.failed = `not sent: ${err instanceof Error ? err.message : "error"}`;
  } finally {
    sending.value = false;
  }
}

function stop(): void {
  const url = stopUrl.value;
  if (!url) return;
  void fetch(`${url}${url.includes("?") ? "&" : "?"}mode=soft`, { method: "POST", credentials: "same-origin" });
}

/** The live turn drained a follow-up: stamp the person's turn it confirms. */
function onInput(item: Item & { kind: "assistant" }, inputText: string, at: number | undefined): void {
  const persons = items.filter((i): i is Item & { kind: "person" } => i.kind === "person");
  const hit = matchSteer(
    persons.map((p) => ({ text: p.text, folded: p.folded !== undefined, ref: p })),
    inputText,
  );
  if (!hit) return;
  const start = item.turn.receivedAt ?? item.turn.startedAt;
  hit.ref.folded = at !== undefined ? `at ${formatDuration(Math.max(0, at - start), "clock")}` : "";
}
function onEnded(item: Item & { kind: "assistant" }): void {
  item.ended = true;
  stopUrl.value = null;
}

// ---- the rail: a column from md up, a sheet on a phone; two shortcuts ------------
// The column's width is the person's — dragged on the handle at its edge,
// stepped with the arrows, reset with a double-click — and whether it is shown
// is theirs too (the header's panel button); both are remembered by this
// browser (item 7). The phone's sheet has neither: it is closed until opened and
// its width is the sheet's.
/** Tailwind's `md`: the rail is a column from here up. */
const MD_UP = "(min-width: 48rem)";
const remembered = railPrefs({
  width: browser.readPref(RAIL_PREF.width),
  collapsed: browser.readPref(RAIL_PREF.collapsed),
});
const railWidth = ref(remembered.width);
const railHidden = ref(remembered.collapsed);
/** The phone's sheet. */
const railOpen = ref(false);
/** Whether the viewport is a column's (the header button's label follows it, across a resize too). */
const wide = ref(browser.mediaMatches(MD_UP));
const stopFollowingWidth = browser.onMediaChange(MD_UP, (matches) => {
  wide.value = matches;
});
const rail = ref<InstanceType<typeof ConversationRail> | null>(null);
const sheetRail = ref<InstanceType<typeof ConversationRail> | null>(null);
const toggleLabel = computed(() =>
  !wide.value ? "Recent threads" : railHidden.value ? "Show recent threads" : "Hide recent threads",
);
function toggleRail(): void {
  wide.value = browser.mediaMatches(MD_UP);
  if (wide.value) {
    railHidden.value = !railHidden.value;
    browser.writePref(RAIL_PREF.collapsed, railHidden.value ? "1" : "0");
    return;
  }
  railOpen.value = true;
}
function setRailWidth(px: number, remember: boolean): void {
  railWidth.value = clampRailWidth(px);
  if (remember) browser.writePref(RAIL_PREF.width, String(railWidth.value));
}
let drag: { startX: number; startWidth: number } | null = null;
function onHandleMove(ev: PointerEvent): void {
  if (!drag) return;
  setRailWidth(drag.startWidth + (ev.clientX - drag.startX), false);
}
function onHandleUp(): void {
  window.removeEventListener("pointermove", onHandleMove);
  if (!drag) return;
  drag = null;
  browser.writePref(RAIL_PREF.width, String(railWidth.value));
}
function onHandleDown(ev: PointerEvent): void {
  if (ev.button !== 0) return;
  ev.preventDefault();
  drag = { startX: ev.clientX, startWidth: railWidth.value };
  (ev.currentTarget as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
  window.addEventListener("pointermove", onHandleMove);
  window.addEventListener("pointerup", onHandleUp, { once: true });
}
function onHandleKey(ev: KeyboardEvent): void {
  if (ev.key === "ArrowRight") setRailWidth(railWidth.value + RAIL_WIDTH.step, true);
  else if (ev.key === "ArrowLeft") setRailWidth(railWidth.value - RAIL_WIDTH.step, true);
  else if (ev.key === "Home") setRailWidth(RAIL_WIDTH.min, true);
  else if (ev.key === "End") setRailWidth(RAIL_WIDTH.max, true);
  else return;
  ev.preventDefault();
}
onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onHandleMove);
  window.removeEventListener("pointerup", onHandleUp);
  stopFollowingWidth();
});
function onKey(ev: KeyboardEvent): void {
  const shortcut = shortcutFor(ev);
  if (!shortcut) return;
  ev.preventDefault();
  if (shortcut === "newThread") {
    browser.navigate("/threads");
    return;
  }
  // ⌘K: the filter — in the column (shown again if it was hidden), or in the sheet once it has opened.
  if (rail.value) {
    rail.value.focusFilter();
    return;
  }
  if (railHidden.value && browser.mediaMatches(MD_UP)) {
    railHidden.value = false;
    browser.writePref(RAIL_PREF.collapsed, "0");
    void nextTick().then(() => rail.value?.focusFilter());
    return;
  }
  railOpen.value = true;
  void nextTick().then(() => sheetRail.value?.focusFilter());
}

// ---- following the transcript (rule 2) -------------------------------------------
const end = ref<HTMLElement | null>(null);
const unseen = ref(false);
function distanceFromBottom(): number {
  return document.body.scrollHeight - (window.innerHeight + window.scrollY);
}
watch(
  () => items.length,
  () => {
    const follow = shouldFollow(distanceFromBottom());
    void nextTick().then(() => {
      if (follow) end.value?.scrollIntoView?.({ block: "end" });
      else unseen.value = true;
    });
  },
);
function onScroll(): void {
  if (shouldFollow(distanceFromBottom())) unseen.value = false;
}
function jumpToNew(): void {
  end.value?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  unseen.value = false;
}
onMounted(() => {
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("keydown", onKey);
  if (seed) openFeed();
});
onUnmounted(() => {
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("keydown", onKey);
  feed?.close();
});

// ---- the rail's live truth (item 7): the runs index's feed, narrowed to the viewer ----------
// The seed's `live` flags are the picture at load; the feed keeps the dots, the
// counts and the tab's live count current — every run of the viewer's in
// flight anywhere, not only the open conversation's — and a thread started
// since the page loaded gets a row.
const liveState = reactive(railLiveState());
const railRows = computed(() => liveRailRows(seed?.conversations ?? [], liveState, seed?.lane ?? ""));
/** Live runs of the viewer's: the feed's, plus the open conversation's own if the feed has not named it yet. */
const liveCount = computed(() => {
  const own = liveItem.value?.turn.id;
  return liveState.runs.size + (own && !liveState.runs.has(own) ? 1 : 0);
});
const makeEventSource = useEventSourceFactory();
let feed: EventSourceLike | null = null;
function openFeed(): void {
  feed = makeEventSource("/runs?stream=1&mine=1");
  let everOpened = false;
  feed.onopen = () => {
    // A reconnect replays the active set: forget the old picture so a finish the
    // page missed while away does not stay live.
    if (everOpened) liveState.runs.clear();
    everOpened = true;
    liveState.connected = true;
  };
  feed.onmessage = (m) => {
    let ev: { type?: string; run?: import("@core/channels/webSeed.js").RunIndexRowSeed; id?: string };
    try {
      ev = JSON.parse(m.data) as typeof ev;
    } catch {
      return;
    }
    applyIndexEvent(liveState, ev);
  };
}

// ---- the chrome --------------------------------------------------------------------
const title = computed(() => {
  const first = items.find((i) => i.kind === "person");
  return first ? conversationTitle(first.text) : "Switchboard";
});
watch(
  [title, liveCount],
  ([t, n]) => {
    browser.setTitle(n > 0 ? `(${n}) ${t}` : t);
    browser.setFavicon(n > 0 ? FAVICON_LIVE : FAVICON_IDLE);
  },
  { immediate: true },
);
/** The browser's local hour, from the page's ticking clock, so a tab left open across a day part greets the new one. */
const hour = computed(() => new Date(now.value).getHours());
const empty = computed(() => items.length === 0);
/** A thread from another channel opens read-only (item 7): no composer; a reply belongs where the thread is.
 *  Another person's `web:` lane (an all-channels holder reading it) is nobody's channel to reply in. */
const elsewhere = seed?.elsewhere;
const elsewhereLine = !elsewhere
  ? ""
  : elsewhere.surface === "web"
    ? "This thread is another person's conversation. You can read it here."
    : `This thread lives in ${SURFACE_NAME[elsewhere.surface] ?? elsewhere.surface}.`;
</script>

<template>
  <AppShell title="Threads" nav="home">
    <template #leading>
      <!-- The rail's one button: hides and shows the column from md up; opens the sheet on a phone. -->
      <UButton
        class="rail-toggle -ml-1"
        size="xs"
        color="neutral"
        variant="ghost"
        :icon="wide && !railHidden ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left'"
        :aria-label="toggleLabel"
        :aria-expanded="wide ? !railHidden : undefined"
        @click="toggleRail"
      />
    </template>
    <div v-if="!seed" class="mx-auto my-12 max-w-xl text-center text-toned">This page needs its seed.</div>
    <div
      v-else
      class="home gap-8 md:grid"
      :class="railHidden ? 'md:grid-cols-[minmax(0,1fr)]' : 'md:grid-cols-[var(--rail-w)_minmax(0,1fr)]'"
      :style="{ '--rail-w': `${railWidth}px` }"
      :data-rail="railHidden ? 'hidden' : 'shown'"
    >
      <aside v-if="!railHidden" class="relative hidden md:block">
        <ConversationRail
          ref="rail"
          class="sticky top-20"
          :rows="railRows"
          :current="conversation"
          :now="now"
          :retention="retention"
        />
        <!-- The handle: the column's right edge, sitting in the gap. A drag follows the pointer within
             the band, the arrows step it, Home and End are the edges, a double-click resets; its
             hairline shows on hover and focus. Nothing here transitions the width: it follows the hand. -->
        <div
          class="handle group/handle absolute inset-y-0 -right-5 flex w-3 cursor-col-resize touch-none select-none justify-center outline-none"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the recent threads column"
          :aria-valuemin="RAIL_WIDTH.min"
          :aria-valuemax="RAIL_WIDTH.max"
          :aria-valuenow="railWidth"
          tabindex="0"
          data-testid="rail-handle"
          @pointerdown="onHandleDown"
          @keydown="onHandleKey"
          @dblclick="setRailWidth(RAIL_WIDTH.default, true)"
        >
          <span
            class="w-px rounded-full bg-(--ui-border-accented) opacity-0 transition-opacity duration-150 ease-out group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100"
            aria-hidden="true"
          />
        </div>
      </aside>
      <USlideover v-model:open="railOpen" side="left" title="Recent threads" :ui="{ content: 'max-w-xs' }">
        <template #body>
          <ConversationRail
            ref="sheetRail"
            :rows="railRows"
            :current="conversation"
            :now="now"
            :retention="retention"
          />
        </template>
      </USlideover>

      <section class="thread mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-3xl flex-col">
        <!-- The empty state: the mark, the greeting, the composer, the chips — hung from the top at a
             capped offset (a share of the viewport, never more than a hand's height), so a tall
             screen does not sink it to the middle of nowhere; a short one keeps it in reach. -->
        <EmptyState
          v-if="empty"
          class="mb-auto mt-[clamp(1.5rem,14vh,9rem)]"
          :name="seed.viewer.name"
          :hour="hour"
          :suggestions="seed.suggestions"
          @pick="pick"
        >
          <ChatComposer
            v-model="text"
            :mode="mode"
            :hint="hint"
            :commands="seed.commands"
            autofocus
            sweep-on-mount
            @submit="submit"
            @stop="stop"
          />
        </EmptyState>

        <!-- The transcript: the person's turns and the runs they started, in order. -->
        <TransitionGroup
          v-else
          name="sb-rise"
          move-class="sb-move-move"
          tag="ol"
          class="transcript m-0 flex list-none flex-col gap-6 p-0 pb-32 pt-2"
        >
          <li v-for="item in items" :key="item.key">
            <PersonTurn
              v-if="item.kind === 'person'"
              :text="item.text"
              :at="item.at"
              :now="now"
              :pending="item.pending"
              :folded="item.folded"
              :failed="item.failed"
            />
            <AssistantTurn
              v-else-if="item.kind === 'assistant'"
              :turn="item.turn"
              :live="item.live"
              :now="now"
              @input="(t, at) => onInput(item, t, at)"
              @ended="onEnded(item)"
              @stop="(url) => (stopUrl = url)"
            />
            <SilentTurn v-else-if="item.kind === 'silent'" :reason="item.reason" :decided-at="item.at" :now="now" />
            <div v-else class="inline text-[0.875rem] text-toned" data-testid="inline">
              <MarkdownText :text="item.text" />
            </div>
          </li>
        </TransitionGroup>
        <div ref="end" class="end" aria-hidden="true" />

        <!-- A thread from another channel: read here, answered there. -->
        <p
          v-if="!empty && elsewhere"
          class="elsewhere sticky bottom-0 z-10 -mx-3 mt-auto bg-default/85 px-3 py-4 text-center text-[0.8rem] text-toned backdrop-blur sm:-mx-5 sm:px-5"
          data-testid="elsewhere"
        >
          {{ elsewhereLine }}
          <a v-if="elsewhere.url" :href="elsewhere.url" target="_blank" rel="noopener" class="text-highlighted"
            >Reply there ↗</a
          >
          <template v-else-if="elsewhere.surface !== 'web'">Reply there.</template>
        </p>
        <!-- With a transcript, the composer stays at the foot; the page scrolls under it. -->
        <div
          v-else-if="!empty"
          class="composer-dock sticky bottom-0 z-10 -mx-3 mt-auto bg-default/85 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:-mx-5 sm:px-5"
        >
          <Transition name="sb-rise">
            <button
              v-if="unseen"
              type="button"
              class="new-pill absolute -top-9 left-1/2 -translate-x-1/2 rounded-full border border-default bg-(--ui-bg-elevated) px-3 py-1 font-mono text-[0.7rem] text-toned shadow-sm hover:text-highlighted"
              @click="jumpToNew"
            >
              ↓ new
            </button>
          </Transition>
          <ChatComposer
            v-model="text"
            :mode="mode"
            :hint="hint"
            :commands="seed.commands"
            autofocus
            @submit="submit"
            @stop="stop"
          />
        </div>
      </section>
    </div>
  </AppShell>
</template>
