<script setup lang="ts">
import { inject, ref } from "vue";
import { SeedKey, useViewingAs } from "../../src/lib/seed";
import { useWallClock } from "../../src/lib/wallClock";
import AssistantTurn from "../../src/components/home/AssistantTurn.vue";
import PersonTurn from "../../src/components/home/PersonTurn.vue";
import SilentTurn from "../../src/components/home/SilentTurn.vue";
import ParentTurn from "../../src/components/home/ParentTurn.vue";
import EmptyState from "./EmptyState.vue";
import { useHomeSession } from "../lib/homeSession";
import { useReadonlyThread } from "../lib/readonlyThread";
import { formatDateTime, formatLocalIso } from "../../src/lib/format";
import MarkdownText from "../../src/components/MarkdownText.vue";
const props = defineProps<{ thread: string }>();
const home = useHomeSession();
const viewingAs = useViewingAs();
const globalSeed = inject(SeedKey, null);
const canReply = !viewingAs && (!globalSeed?.dataView || globalSeed.dataView.mode !== "person");
const { session, status, canWrite } = useReadonlyThread(() => props.thread);
const busy = ref(false);
const now = useWallClock();
async function reply() {
  if (!home || busy.value) return;
  busy.value = true;
  try {
    await home.focus(props.thread);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="green-section">
    <div class="green-section-heading">
      <div>
        <h2>Unit conversation</h2>
        <p>Read the original thread. Choose Reply to send here.</p>
      </div>
      <button
        v-if="home && canReply && !home.focused.value && status === 'ready' && canWrite"
        class="green-button green-button-primary"
        type="button"
        :disabled="busy || home.status.value !== 'ready'"
        @click="reply"
      >
        <UIcon name="i-lucide-reply" />Reply in this thread
      </button>
    </div>
    <div class="green-section-content">
      <p v-if="status === 'loading'" class="text-xs text-muted" role="status">Loading conversation…</p>
      <EmptyState
        v-else-if="status === 'unavailable'"
        title="Conversation is unavailable"
        description="The thread is unknown or cannot be read with your current access."
      />
      <ol v-else-if="session?.turns?.length" class="list-none m-0 p-0 grid grid-cols-1 gap-6">
        <li v-for="(turn, index) in session.turns" :key="index" class="min-w-0">
          <template v-if="'kind' in turn"
            ><SilentTurn
              v-if="turn.kind === 'receipt'"
              :reason="turn.reason"
              :decided-at="turn.decidedAt"
              :now="now" /><ParentTurn v-else :turn="turn" :now="now" /></template
          ><template v-else
            ><p class="text-xs text-muted mb-2">
              {{ session.entries.find((entry) => entry.id === `${turn.id}:request`)?.authorLabel ?? "Unknown author" }}
            </p>
            <PersonTurn :text="turn.request" :at="turn.receivedAt ?? turn.startedAt" :now="now" /><AssistantTurn
              class="mt-3"
              :turn="turn"
              :live="
                !turn.finished
                  ? {
                      eventsUrl: `/runs/${encodeURIComponent(turn.id)}/events${turn.token ? `?t=${encodeURIComponent(turn.token)}` : ''}`,
                      stopUrl: `/runs/${encodeURIComponent(turn.id)}/stop${turn.token ? `?t=${encodeURIComponent(turn.token)}` : ''}`,
                    }
                  : null
              "
              :now="now"
          /></template>
        </li>
      </ol>
      <ol v-else-if="session?.entries.length" class="list-none m-0 p-0 grid gap-6">
        <li
          v-for="entry in session.entries"
          :key="entry.id"
          class="min-w-0"
          :class="{ 'green-notice': entry.role === 'receipt' }"
        >
          <div class="flex justify-between flex-wrap gap-2 text-xs text-muted mb-2">
            <span
              >{{
                entry.authorLabel ??
                (entry.isViewer ? "You" : entry.role === "assistant" ? "Switchboard" : "Unknown author")
              }}<template v-if="entry.source"> · {{ entry.source }}</template></span
            >
            <time
              v-if="entry.at !== undefined"
              :datetime="new Date(entry.at).toISOString()"
              :title="formatLocalIso(entry.at)"
              >{{ formatDateTime(entry.at, now) }}</time
            >
          </div>
          <MarkdownText :text="entry.content" />
        </li>
      </ol>
      <EmptyState v-else title="No messages in the loaded thread window" />
      <template v-if="session?.turns?.length">
        <div
          v-for="entry in session?.entries.filter((entry) => entry.id.startsWith('question:')) ?? []"
          :key="entry.id"
          class="green-notice mt-4"
        >
          <h3 class="text-xs font-semibold mb-2">{{ entry.authorLabel }}</h3>
          <MarkdownText :text="entry.content" />
        </div>
      </template>
      <p v-if="status === 'ready'" class="text-xs text-muted mt-4">
        Only the loaded retained thread window is shown. Full history coverage is unknown.
      </p>
    </div>
  </section>
</template>
