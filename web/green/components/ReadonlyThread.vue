<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { HomeSeed } from "@core/channels/webSeed.js";
import { fetchSeed, useViewingAs } from "../../src/lib/seed";
import { useWallClock } from "../../src/lib/wallClock";
import AssistantTurn from "../../src/components/home/AssistantTurn.vue";
import PersonTurn from "../../src/components/home/PersonTurn.vue";
import SilentTurn from "../../src/components/home/SilentTurn.vue";
import ParentTurn from "../../src/components/home/ParentTurn.vue";
import EmptyState from "./EmptyState.vue";
import { useHomeSession } from "../lib/homeSession";
const props = defineProps<{ thread: string }>();
const home = useHomeSession();
const viewingAs = useViewingAs();
const seed = ref<HomeSeed | null>(null);
const status = ref<"loading" | "ready" | "unavailable">("loading");
const busy = ref(false);
const now = useWallClock();
let alive = true;
onMounted(async () => {
  const value = await fetchSeed(`/threads/${encodeURIComponent(props.thread)}`);
  if (!alive) return;
  if (value?.page === "home") {
    seed.value = value;
    status.value = "ready";
  } else status.value = "unavailable";
});
onBeforeUnmount(() => {
  alive = false;
  seed.value = null;
});
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
        <p>Read the durable thread. Replies require an explicit destination change.</p>
      </div>
      <button
        v-if="home && !viewingAs && !home.focused.value && status === 'ready'"
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
      <ol v-else-if="seed?.turns.length" class="list-none m-0 p-0 grid gap-6">
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
      <EmptyState v-else title="No retained conversation yet" />
    </div>
  </section>
</template>
