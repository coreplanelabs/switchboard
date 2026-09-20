<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import type { HomeParentTurnSeed, HomeTurnSeed, PlaneChatSeed } from "@core/channels/webSeed.js";
import ChatComposer from "../home/ChatComposer.vue";
import PersonTurn from "../home/PersonTurn.vue";
import AssistantTurn from "../home/AssistantTurn.vue";
import ParentTurn from "../home/ParentTurn.vue";
import SilentTurn from "../home/SilentTurn.vue";
import MarkdownText from "../MarkdownText.vue";
import { stripSlash } from "../../lib/slashCompleter";
import { classifyReply, composerMode, liveUrls, matchSteer, offerFill, shouldFollow } from "../../lib/homeModel";
import { formatDuration } from "../../lib/format";

// The plane's chat column (record 0070; orchestration-plane.md item 11): the
// existing web chat — the same composer, turns and cards `/threads` mounts —
// bound to the viewer's orchestrator thread. The column holds no rule the home
// page does not: a `202` mounts a live turn on the run's stream, a `200` is a
// click row's offer (fills the composer), a steer acknowledgement or an
// inline turn.
// The clock is the page's: both halves read the seed's one `at`, so a row the
// chat cites is the row the panel paints.

const props = defineProps<{
  chat: PlaneChatSeed;
  /** The seed's clock: the table's `at`, as the server stamped it — the anchor
   *  a seeded live turn's run clock starts from, as `seed.now` is on `/threads`. */
  at: number;
  /** The page's clock: the table's `at`, ticking while the page is open. */
  now: number;
}>();

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
  | { key: string; kind: "parent"; turn: HomeParentTurnSeed }
  | { key: string; kind: "inline"; text: string };

let seq = 0;
const key = (k: string) => `${k}-${++seq}`;
const items = reactive<Item[]>([]);
for (const t of props.chat.turns) {
  if ("kind" in t) {
    if (t.kind === "receipt") items.push({ key: key("s"), kind: "silent", reason: t.reason, at: t.decidedAt });
    else items.push({ key: key("w"), kind: "parent", turn: t });
    continue;
  }
  items.push({ key: key("p"), kind: "person", text: t.request, at: t.receivedAt ?? t.startedAt, pending: false });
  const live =
    !t.finished && t.token
      ? {
          eventsUrl: `/runs/${encodeURIComponent(t.id)}/events?t=${t.token}`,
          stopUrl: `/runs/${encodeURIComponent(t.id)}/stop?t=${t.token}`,
          serverNow: props.at,
        }
      : null;
  items.push({ key: key("a"), kind: "assistant", turn: t, live, ended: t.finished });
}

/** The assistant turn whose run is live, if any (one live run per thread);
 *  a hosted ship parent occupies no thread and is skipped, as on `/threads`. */
const liveItem = computed(() => {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "assistant" && it.live && !it.ended && it.turn.hosted !== true) return it;
  }
  return null;
});
const stopUrl = ref<string | null>(null);

const text = ref("");
const hint = ref<string | undefined>(undefined);
const mode = computed(() => composerMode(liveItem.value !== null, text.value));
const sending = ref(false);
watch(text, () => {
  if (hint.value && text.value === "") hint.value = undefined;
});

async function submit(): Promise<void> {
  if (sending.value) return;
  const body = stripSlash(text.value.trim(), props.chat.commands);
  if (body === "") return;
  const person = reactive<Item & { kind: "person" }>({
    key: key("p"),
    kind: "person",
    text: body,
    at: props.now,
    pending: true,
  });
  items.push(person);
  text.value = "";
  hint.value = undefined;
  sending.value = true;
  try {
    const res = await fetch(props.chat.sendUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      runId?: string;
      viewPath?: string;
      reply?: string;
      offer?: { line?: string; risk?: string; question?: string };
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
          startedAt: props.now,
          receivedAt: props.now,
          finished: false,
          eventCount: 0,
        },
        live: { eventsUrl: urls.eventsUrl, stopUrl: urls.stopUrl },
        ended: false,
      });
      return;
    }
    if (res.ok && payload.offer && typeof payload.offer.line === "string") {
      // The click row (record 0044): the offered line fills the composer —
      // the box is the affordance, and sending the line runs it as typed.
      person.pending = false;
      const fill = offerFill({ line: payload.offer.line, ...payload.offer });
      text.value = fill.command;
      hint.value = fill.hint;
      return;
    }
    if (res.ok && typeof payload.reply === "string") {
      person.pending = false;
      const reply = classifyReply(payload.reply);
      if (reply.kind === "inline") {
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

// The column scrolls itself (the page's own scroll is the panels'): a new
// turn keeps the newest in view only when the reader was already at the
// bottom (web-chat rule 2) — scrolled up through history, they stay put.
const scroller = ref<HTMLElement | null>(null);
watch(
  () => items.length,
  () => {
    const el = scroller.value;
    const follow = !el || shouldFollow(el.scrollHeight - (el.clientHeight + el.scrollTop));
    void nextTick().then(() => {
      const target = scroller.value;
      if (follow && target) target.scrollTop = target.scrollHeight;
    });
  },
);
</script>

<template>
  <div class="plane-chat flex h-full min-h-0 flex-col" data-plane-chat :data-conversation="chat.conversation">
    <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="chat-scroller">
      <p v-if="items.length === 0" class="mt-6 text-center text-sm text-toned" data-testid="chat-empty">
        Ask about the fleet — the rows on this page are what it reads.
      </p>
      <ol v-else class="m-0 flex list-none flex-col gap-5 p-0 pb-4 pt-2">
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
          <ParentTurn v-else-if="item.kind === 'parent'" :turn="item.turn" :now="now" />
          <div v-else class="inline text-[0.875rem] text-toned" data-testid="inline">
            <MarkdownText :text="item.text" />
          </div>
        </li>
      </ol>
    </div>
    <div class="pt-2">
      <ChatComposer v-model="text" :mode="mode" :hint="hint" :commands="chat.commands" @submit="submit" @stop="stop" />
    </div>
  </div>
</template>
