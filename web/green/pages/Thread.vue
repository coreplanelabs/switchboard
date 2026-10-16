<script setup lang="ts">
defineOptions({ name: "GreenThreadPage" });
import { computed, inject, ref } from "vue";
import { SeedKey, useSeed, useViewingAs } from "../../src/lib/seed";
import { useWallClock } from "../../src/lib/wallClock";
import AssistantTurn from "../../src/components/home/AssistantTurn.vue";
import PersonTurn from "../../src/components/home/PersonTurn.vue";
import SilentTurn from "../../src/components/home/SilentTurn.vue";
import ParentTurn from "../../src/components/home/ParentTurn.vue";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
import { useHomeSession } from "../lib/homeSession";
import { useReadonlyThread } from "../lib/readonlyThread";
import { formatDateTime, formatLocalIso } from "../../src/lib/format";
import MarkdownText from "../../src/components/MarkdownText.vue";
const seed = useSeed("home");
const viewingAs = useViewingAs();
const globalSeed = inject(SeedKey, null);
const canReply = !viewingAs && (!globalSeed?.dataView || globalSeed.dataView.mode !== "person");
const home = useHomeSession();
const now = useWallClock(seed?.now);
const busy = ref(false);
const threadKey = computed(() =>
  seed
    ? !seed.conversation.includes(":") && seed.lane.startsWith("web:") && !seed.elsewhere
      ? `${seed.lane}:${seed.conversation}`
      : seed.conversation
    : null,
);
const { session, status, canWrite } = useReadonlyThread(() => threadKey.value);
const sourceUrl = computed(() =>
  seed?.elsewhere?.url && /^https?:\/\//.test(seed.elsewhere.url) ? seed.elsewhere.url : null,
);
const title = computed(() => {
  const first = session.value?.turns?.find((turn) => !("kind" in turn));
  return first && "request" in first ? first.request.slice(0, 100) : (session.value?.destination.label ?? "Thread");
});
async function reply() {
  if (!seed || !home || busy.value) return;
  busy.value = true;
  try {
    if (threadKey.value) await home.focus(threadKey.value);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <PageHeading
    :title="title"
    description="This transcript is read-only until you choose to reply here."
    eyebrow="THREAD"
    ><button
      v-if="seed && home && canReply && !home.focused.value && status === 'ready' && canWrite"
      class="green-button green-button-primary"
      :disabled="busy || home.status.value !== 'ready'"
      type="button"
      @click="reply"
    >
      <UIcon name="i-lucide-reply" />{{ busy ? "Checking access…" : "Reply in this thread" }}
    </button></PageHeading
  >
  <p v-if="seed?.elsewhere && status === 'ready'" class="green-notice" role="status">
    Source: {{ seed.elsewhere.surface
    }}<a v-if="sourceUrl" class="text-primary ml-3" :href="sourceUrl" target="_blank" rel="noopener noreferrer"
      >Open source ↗</a
    >. Browser replies keep their own source identity.
  </p>
  <section class="green-section">
    <div class="green-section-heading">
      <h2>Conversation</h2>
      <span v-if="home?.focused.value" class="green-badge">Replying here</span>
    </div>
    <div class="green-section-content">
      <EmptyState
        v-if="!seed"
        title="Thread unavailable"
        description="The thread is unknown or cannot be read with your current access."
      />
      <p v-else-if="status === 'loading'" class="text-xs text-muted" role="status">Checking current thread access…</p>
      <EmptyState
        v-else-if="status === 'unavailable'"
        title="Conversation is unavailable"
        description="The thread is unknown or cannot be read with your current access."
      />
      <ol v-else-if="session?.turns?.length" class="list-none m-0 p-0 grid gap-6">
        <li v-for="(turn, index) in session.turns" :key="index">
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
      <EmptyState
        v-else
        title="No messages in the loaded thread window"
        description="The loaded window contains no readable retained turns. Full history coverage is unknown."
      />
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
