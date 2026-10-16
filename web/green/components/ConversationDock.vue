<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useSeed, useViewingAs } from "../../src/lib/seed";
import ConfirmationPrompt from "./ConfirmationPrompt.vue";
import MarkdownText from "../../src/components/MarkdownText.vue";
import AssistantTurn from "../../src/components/home/AssistantTurn.vue";
import type { HomeTurnSeed } from "@core/channels/webSeed.js";
import { useWallClock } from "../../src/lib/wallClock";
import { useHomeSession, type AttachedContext } from "../lib/homeSession";
const home = useHomeSession();
const now = useWallClock();
const historyLine = computed(() => {
  const history = home?.session.value?.history;
  if (!history) return "Conversation coverage is unknown. This page cannot confirm the full retained history.";
  if (history.status === "unavailable")
    return "Conversation history is unavailable. The messages shown do not establish completeness.";
  if (history.status === "partial") return "Conversation history is incomplete. Only the loaded messages are shown.";
  if (history.hasMore) return "More retained messages exist beyond this page.";
  return "This page includes the complete retained conversation available to you.";
});
const liveTurns = computed(
  () => home?.session.value?.turns?.filter((turn): turn is HomeTurnSeed => !("kind" in turn) && !turn.finished) ?? [],
);
const commands = computed(() =>
  home?.text.value.startsWith("/")
    ? (home.session.value?.commands
        .filter((command) => command.chat.startsWith(home.text.value.slice(1)))
        .slice(0, 6) ?? [])
    : [],
);
const route = useRoute();
const seed = useSeed("unit");
const viewingAs = useViewingAs();
const composer = ref<HTMLTextAreaElement | null>(null);
const transcript = ref<HTMLElement | null>(null);
const expanded = ref(false);
const destinationKey = computed(() => {
  const session = home?.session.value;
  return session
    ? `${session.actor}\u0000${session.organization}\u0000${session.stream}\u0000${session.bindingRevision}\u0000${session.destination.kind}\u0000${session.destination.thread ?? ""}`
    : null;
});
const currentContext = computed<AttachedContext | null>(() => {
  if (route.path.startsWith("/runs/unit/") && route.params.key)
    return {
      kind: "unit",
      key: String(route.params.key),
      label: seed?.view.title ?? `Unit ${seed?.view.id ?? route.params.key}`,
    };
  if (route.path.startsWith("/runs/") && route.params.id)
    return { kind: "run", key: String(route.params.id), label: "This run" };
  if (route.path.startsWith("/threads/") && route.params.id)
    return { kind: "thread", key: String(route.params.id), label: "This thread" };
  return null;
});
watch(
  () => home?.session.value?.destination.thread,
  async () => {
    await nextTick();
    composer.value?.focus();
  },
);
watch(
  () => home?.session.value?.entries.length,
  async () => {
    if (!transcript.value) return;
    const nearEnd = transcript.value.scrollHeight - transcript.value.scrollTop - transcript.value.clientHeight < 100;
    if (nearEnd) {
      const element = transcript.value;
      await nextTick();
      if (transcript.value === element && element) element.scrollTop = element.scrollHeight;
    }
  },
);
async function restoreScroll() {
  const key = destinationKey.value;
  const position = home?.scroll.value ?? 0;
  await nextTick();
  if (transcript.value && key === destinationKey.value) transcript.value.scrollTop = position;
}
function captureScroll(event: Event) {
  const element = event.currentTarget as HTMLElement;
  if (home && element === transcript.value && element.dataset.destination === destinationKey.value)
    home.scroll.value = element.scrollTop;
}
onMounted(() => {
  void restoreScroll();
});
watch([destinationKey, transcript], () => {
  void restoreScroll();
});
function keydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void home?.submit();
  }
}
</script>
<template>
  <aside v-if="home" class="green-dock" :class="{ 'is-expanded': expanded }" aria-label="Conversation">
    <div class="green-dock-heading">
      <div>
        <h2>{{ home.focused.value ? "Thread reply" : "Switchboard" }}</h2>
        <p>
          {{ home.focused.value ? "Only this thread receives your reply" : "Your private organization conversation" }}
        </p>
      </div>
      <button
        class="green-dock-expand green-icon-button"
        type="button"
        :aria-expanded="expanded"
        :aria-label="expanded ? 'Collapse conversation' : 'Expand conversation'"
        @click="expanded = !expanded"
      >
        <UIcon :name="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'" />
      </button>
    </div>
    <div v-if="home.status.value === 'loading'" class="green-dock-transcript p-5 text-xs text-muted" role="status">
      Loading your conversation…
    </div>
    <div v-else-if="home.status.value === 'unavailable'" class="p-5 text-xs text-muted" role="alert">
      <p>{{ home.notice.value }}</p>
      <button class="green-button mt-3" type="button" @click="home.load()">Load conversation</button>
    </div>
    <template v-else-if="home.session.value">
      <div
        ref="transcript"
        class="green-dock-transcript"
        aria-label="Conversation transcript"
        :data-destination="destinationKey"
        tabindex="0"
        @scroll="captureScroll"
      >
        <p class="green-history-status" role="status">{{ historyLine }}</p>
        <div v-if="!home.session.value.entries.length" class="green-dock-welcome">
          <UIcon name="i-lucide-sparkles" />
          <h3>
            {{
              home.session.value.history?.hasMore
                ? "No readable messages in this page"
                : home.session.value.history?.status === "complete"
                  ? "One place to direct the work"
                  : "No messages in this loaded page"
            }}
          </h3>
          <p>Ask about the fleet, start work, or attach the page you are viewing as context.</p>
        </div>
        <ol v-else class="list-none m-0 p-0">
          <li
            v-for="entry in home.session.value.entries"
            :key="entry.id"
            class="green-message"
            :class="`green-message-${entry.role}`"
          >
            <div class="green-message-label">
              {{
                entry.isViewer
                  ? "You"
                  : (entry.authorLabel ?? (entry.role === "receipt" ? "Receipt" : "Unknown author"))
              }}<span class="text-muted">{{ entry.source }}</span>
            </div>
            <MarkdownText :text="entry.content" />
          </li>
        </ol>
        <AssistantTurn
          v-for="turn in liveTurns"
          :key="turn.id"
          :turn="turn"
          :now="now"
          :live="{
            eventsUrl: `/runs/${encodeURIComponent(turn.id)}/events${turn.token ? `?t=${encodeURIComponent(turn.token)}` : ''}`,
            stopUrl: `/runs/${encodeURIComponent(turn.id)}/stop${turn.token ? `?t=${encodeURIComponent(turn.token)}` : ''}`,
          }"
        />
      </div>
      <div class="green-dock-composer">
        <p class="green-destination" aria-live="polite" aria-atomic="true">
          <UIcon :name="home.focused.value ? 'i-lucide-message-square' : 'i-lucide-lock-keyhole'" />{{
            home.session.value.destination.label
          }}
        </p>
        <button
          v-if="home.focused.value && !viewingAs"
          class="text-xs text-primary min-h-10 mb-1"
          type="button"
          @click="home.exitFocus()"
        >
          Return to your messages
        </button>
        <div
          v-if="home.context.value.length && !viewingAs"
          class="flex flex-wrap gap-1 mb-2"
          aria-label="Attached context"
        >
          <span v-for="item in home.context.value" :key="`${item.kind}:${item.key}`" class="green-context-chip"
            >{{ item.label
            }}<button
              type="button"
              :aria-label="`Remove context: ${item.label}`"
              @click="home.context.value = home.context.value.filter((value) => value !== item)"
            >
              <UIcon name="i-lucide-x" /></button
          ></span>
        </div>
        <button
          v-if="
            !viewingAs &&
            currentContext &&
            !home.context.value.some((item) => item.kind === currentContext?.kind && item.key === currentContext.key)
          "
          type="button"
          class="green-context-attach"
          @click="home.attach(currentContext)"
        >
          <UIcon name="i-lucide-paperclip" />Attach this {{ currentContext.kind }}
        </button>
        <ul v-if="commands.length && !viewingAs" class="list-none m-0 p-0 mb-2" aria-label="Command suggestions">
          <li v-for="command in commands" :key="command.chat">
            <button
              class="w-full text-left p-2 text-xs min-h-10 rounded hover:bg-elevated"
              type="button"
              @click="
                home.text.value = command.chat + ' ';
                composer?.focus();
              "
            >
              <strong>{{ command.chat }}</strong
              ><span class="block text-muted">{{ command.describe }}</span>
            </button>
          </li>
        </ul>
        <ConfirmationPrompt
          v-if="home.offer.value && home.session.value.destination.canWrite && !viewingAs"
          :key="home.offer.value?.id"
          :offer="home.offer.value"
          :busy="home.sending.value"
          @choose="home.submitConfirmation"
        />
        <form
          v-if="home.session.value.destination.canWrite && !viewingAs"
          class="green-composer-box"
          @submit.prevent="home.submit()"
        >
          <label for="green-message" class="sr-only">Message to {{ home.session.value.destination.label }}</label
          ><textarea
            id="green-message"
            ref="composer"
            v-model="home.text.value"
            rows="3"
            :disabled="home.sending.value"
            placeholder="Ask Switchboard…"
            maxlength="32768"
            @keydown="keydown"
          />
          <div class="green-composer-actions">
            <span>Enter to send · Shift Enter for a new line</span
            ><button
              class="green-send"
              type="submit"
              aria-label="Send message"
              :disabled="!home.text.value.trim() || home.sending.value"
            >
              <UIcon :name="home.sending.value ? 'i-lucide-loader-circle' : 'i-lucide-arrow-up'" />
            </button>
          </div>
        </form>
        <p v-else class="text-xs text-muted py-3">
          {{ viewingAs ? "This view is read-only." : "This destination is read-only with your current permissions." }}
        </p>
        <p v-if="home.notice.value" class="text-xs text-muted mt-2" role="status">{{ home.notice.value }}</p>
      </div>
    </template>
  </aside>
</template>
<style scoped>
.green-dock {
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--green-sidebar);
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 24px;
  height: calc(100dvh - 110px);
  min-height: 460px;
  max-height: 900px;
  min-width: 0;
}
.green-dock-heading {
  padding: 16px;
  border-bottom: 1px solid var(--ui-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.green-dock-heading h2 {
  font-weight: 600;
  font-size: 14px;
}
.green-dock-heading p {
  color: var(--ui-text-muted);
  font-size: 11px;
  margin-top: 3px;
}
.green-dock-transcript {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 16px;
}
.green-history-status {
  font-size: 11px;
  color: var(--ui-text-muted);
  padding-bottom: 12px;
}
.green-dock-welcome {
  padding: 32px 8px;
  text-align: center;
}
.green-dock-welcome > .iconify {
  width: 26px;
  height: 26px;
  color: var(--ui-primary);
}
.green-dock-welcome h3 {
  font-size: 14px;
  font-weight: 500;
  margin-top: 16px;
}
.green-dock-welcome p {
  font-size: 12px;
  color: var(--ui-text-muted);
  margin-top: 8px;
}
.green-message {
  padding: 12px 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.green-message-user {
  background: var(--ui-bg-accented);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.green-message-receipt {
  font-size: 11px;
  color: var(--ui-text-muted);
}
.green-message-label {
  display: flex;
  justify-content: space-between;
  font-weight: 500;
  font-size: 11px;
  margin-bottom: 8px;
}
.green-message-label span {
  font-weight: 400;
}
.green-dock-composer {
  padding: 12px;
  border-top: 1px solid var(--ui-border);
}
.green-destination {
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-toned);
  margin-bottom: 8px;
}
.green-composer-box {
  border: 1px solid var(--ui-border-accented);
  border-radius: 8px;
  background: var(--ui-bg);
  padding: 10px;
}
.green-composer-box:focus-within {
  border-color: var(--ui-primary);
}
.green-composer-box textarea {
  width: 100%;
  border: 0;
  outline: 0;
  resize: vertical;
  max-height: 180px;
  min-height: 60px;
  font-size: 13px;
  background: transparent;
  color: var(--ui-text);
}
.green-composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.green-composer-actions span {
  font-size: 9px;
  color: var(--ui-text-muted);
}
.green-send {
  width: 36px;
  height: 36px;
  border-radius: 7px;
  background: #a8e840;
  color: #212c12;
  display: grid;
  place-items: center;
}
.green-context-attach {
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-muted);
  font-size: 11px;
}
.green-context-chip {
  display: flex;
  gap: 5px;
  align-items: center;
  font-size: 10px;
  max-width: 100%;
  overflow-wrap: anywhere;
  background: var(--ui-bg-accented);
  border-radius: 5px;
  padding: 2px 6px;
}
.green-context-chip button {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
}
.green-dock-expand {
  display: none;
}
@media (max-width: 1100px) {
  .green-dock {
    position: fixed;
    inset: auto 12px 12px 236px;
    z-index: 25;
    height: auto;
    min-height: 0;
    max-height: 80dvh;
    box-shadow: 0 8px 32px rgb(0 0 0 / 13.333333%);
  }
  .green-dock-transcript {
    display: none;
  }
  .green-dock.is-expanded .green-dock-transcript {
    display: block;
    max-height: 45dvh;
  }
  .green-dock-heading {
    padding: 9px 12px;
  }
  .green-dock-heading p {
    display: none;
  }
  .green-dock-expand {
    display: inline-flex;
  }
  .green-dock-composer {
    padding: 8px 12px;
  }
  .green-composer-box textarea {
    min-height: 40px;
    height: 40px;
  }
  .green-composer-actions span {
    display: none;
  }
  .green-composer-box {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .green-composer-actions {
    flex: none;
  }
  .green-destination {
    margin-bottom: 4px;
  }
}
@media (max-width: 767px) {
  .green-dock {
    left: 12px;
    bottom: max(8px, env(safe-area-inset-bottom));
  }
}
</style>
