<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, reactive, ref, watch } from "vue";
import type { HomeTurnSeed } from "@core/channels/webSeed.js";
import { retentionSentence } from "@core/channels/webSeed.js";
import { FAVICON_IDLE, FAVICON_LIVE } from "@core/channels/favicon.js";
import AppShell from "../components/AppShell.vue";
import ChatComposer from "../components/home/ChatComposer.vue";
import ConversationRail from "../components/home/ConversationRail.vue";
import EmptyState from "../components/home/EmptyState.vue";
import PersonTurn from "../components/home/PersonTurn.vue";
import AssistantTurn from "../components/home/AssistantTurn.vue";
import MarkdownText from "../components/MarkdownText.vue";
import { browser } from "../lib/browser";
import { useSeed } from "../lib/seed";
import { useWallClock } from "../lib/wallClock";
import { MarkPulseKey } from "../lib/markPulse";
import {
  classifyReply,
  composerMode,
  conversationTitle,
  liveUrls,
  matchSteer,
  shortcutFor,
  shouldFollow,
} from "../lib/homeModel";
import { formatDuration } from "../lib/format";

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
  | { key: string; kind: "inline"; text: string };

let seq = 0;
const key = (k: string) => `${k}-${++seq}`;
const items = reactive<Item[]>([]);
for (const t of seed?.turns ?? []) {
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

/** The assistant turn whose run is live in this conversation, if any (one live run per thread). */
const liveItem = computed(() => {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "assistant" && it.live && !it.ended) return it;
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
  const body = text.value.trim();
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
        hint.value = "Enter runs it";
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
const railOpen = ref(false);
const rail = ref<InstanceType<typeof ConversationRail> | null>(null);
const sheetRail = ref<InstanceType<typeof ConversationRail> | null>(null);
function onKey(ev: KeyboardEvent): void {
  const shortcut = shortcutFor(ev);
  if (!shortcut) return;
  ev.preventDefault();
  if (shortcut === "newChat") {
    browser.navigate("/chats");
    return;
  }
  // ⌘K: the filter — in the column, or in the sheet once it has opened.
  if (rail.value) {
    rail.value.focusFilter();
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
});
onUnmounted(() => {
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("keydown", onKey);
});

// ---- the chrome --------------------------------------------------------------------
const title = computed(() => {
  const first = items.find((i) => i.kind === "person");
  return first ? conversationTitle(first.text) : "Switchboard";
});
watch(
  [title, liveItem],
  ([t, live]) => {
    browser.setTitle(live ? `(1) ${t}` : t);
    browser.setFavicon(live ? FAVICON_LIVE : FAVICON_IDLE);
  },
  { immediate: true },
);
/** The browser's local hour, from the page's ticking clock, so a tab left open across a day part greets the new one. */
const hour = computed(() => new Date(now.value).getHours());
const empty = computed(() => items.length === 0);
</script>

<template>
  <AppShell title="Chats" nav="home">
    <template #leading>
      <!-- The phone's way to the rail: a sheet from the left. -->
      <UButton
        class="rail-toggle -ml-1 md:hidden"
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-panel-left"
        aria-label="Recent conversations"
        @click="railOpen = true"
      />
    </template>
    <div v-if="!seed" class="mx-auto my-12 max-w-xl text-center text-toned">This page needs its seed.</div>
    <div v-else class="home gap-8 md:grid md:grid-cols-[14rem_minmax(0,1fr)]">
      <aside class="hidden md:block">
        <ConversationRail
          ref="rail"
          class="sticky top-20"
          :rows="seed.conversations"
          :current="conversation"
          :now="now"
          :retention="retention"
        />
      </aside>
      <USlideover v-model:open="railOpen" side="left" title="Recent conversations" :ui="{ content: 'max-w-xs' }">
        <template #body>
          <ConversationRail
            ref="sheetRail"
            :rows="seed.conversations"
            :current="conversation"
            :now="now"
            :retention="retention"
          />
        </template>
      </USlideover>

      <section class="thread mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-3xl flex-col">
        <!-- The empty state: the mark, the greeting, the composer in the middle, the chips. -->
        <EmptyState
          v-if="empty"
          class="my-auto"
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
            <div v-else class="inline text-[0.875rem] text-toned" data-testid="inline">
              <MarkdownText :text="item.text" />
            </div>
          </li>
        </TransitionGroup>
        <div ref="end" class="end" aria-hidden="true" />

        <!-- With a transcript, the composer stays at the foot; the page scrolls under it. -->
        <div
          v-if="!empty"
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
