<script setup lang="ts">
defineOptions({ name: "GreenThreadPage" });
import { computed, ref } from "vue";
import { useSeed, useViewingAs } from "../../src/lib/seed";
import { useWallClock } from "../../src/lib/wallClock";
import AssistantTurn from "../../src/components/home/AssistantTurn.vue";
import PersonTurn from "../../src/components/home/PersonTurn.vue";
import SilentTurn from "../../src/components/home/SilentTurn.vue";
import ParentTurn from "../../src/components/home/ParentTurn.vue";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
import { useHomeSession } from "../lib/homeSession";
const seed = useSeed("home");
const viewingAs = useViewingAs();
const home = useHomeSession();
const now = useWallClock(seed?.now);
const busy = ref(false);
const sourceUrl = computed(() =>
  seed?.elsewhere?.url && /^https?:\/\//.test(seed.elsewhere.url) ? seed.elsewhere.url : null,
);
const title = computed(() => {
  const first = seed?.turns.find((turn) => !("kind" in turn));
  return first && "request" in first ? first.request.slice(0, 100) : "Thread";
});
async function reply() {
  if (!seed || !home || busy.value) return;
  busy.value = true;
  try {
    await home.focus(
      !seed.conversation.includes(":") && seed.lane.startsWith("web:") && !seed.elsewhere
        ? `${seed.lane}:${seed.conversation}`
        : seed.conversation,
    );
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <PageHeading
    :title="title"
    :description="
      seed
        ? 'This transcript is read-only until you choose to reply here.'
        : 'This thread could not be loaded with your current access.'
    "
    eyebrow="THREAD"
    ><button
      v-if="seed && home && !viewingAs && !home.focused.value"
      class="green-button green-button-primary"
      :disabled="busy || home.status.value !== 'ready'"
      type="button"
      @click="reply"
    >
      <UIcon name="i-lucide-reply" />{{ busy ? "Checking access…" : "Reply in this thread" }}
    </button></PageHeading
  >
  <p v-if="seed?.elsewhere" class="green-notice" role="status">
    Source: {{ seed.elsewhere.surface
    }}<a v-if="sourceUrl" class="text-primary ml-3" :href="sourceUrl" target="_blank" rel="noopener noreferrer"
      >Open source ↗</a
    >. Browser replies keep their own source identity.
  </p>
  <section v-if="!seed" class="green-section">
    <EmptyState
      title="Thread unavailable"
      description="The thread could not be read. Its retained turns and reply access cannot be confirmed."
    />
  </section>
  <section v-else class="green-section">
    <div class="green-section-heading">
      <h2>Conversation</h2>
      <span v-if="home?.focused.value" class="green-badge">Replying here</span>
    </div>
    <div class="green-section-content">
      <ol v-if="seed?.turns.length" class="list-none m-0 p-0 grid gap-6">
        <li v-for="(turn, index) in seed.turns" :key="index">
          <template v-if="'kind' in turn"
            ><SilentTurn
              v-if="turn.kind === 'receipt'"
              :reason="turn.reason"
              :decided-at="turn.decidedAt"
              :now="now" /><ParentTurn v-else :turn="turn" :now="now" /></template
          ><template v-else
            ><PersonTurn :text="turn.request" :at="turn.receivedAt ?? turn.startedAt" :now="now" /><AssistantTurn
              class="mt-3"
              :turn="turn"
              :live="
                !turn.finished
                  ? {
                      eventsUrl: `/runs/${encodeURIComponent(turn.id)}/events${turn.token ? `?t=${encodeURIComponent(turn.token)}` : ''}`,
                      stopUrl: `/runs/${encodeURIComponent(turn.id)}/stop${turn.token ? `?t=${encodeURIComponent(turn.token)}` : ''}`,
                      serverNow: seed.now,
                    }
                  : null
              "
              :now="now"
          /></template>
        </li>
      </ol>
      <EmptyState
        v-else
        title="No conversation to show"
        description="This authorized thread contains no retained turns."
      />
    </div>
  </section>
</template>
