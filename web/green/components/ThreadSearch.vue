<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { unwrapUntrusted } from "@core/core/untrusted.js";
import type { SessionSearchHit } from "@core/core/runsService.js";
import type { UnitRunRowSeed } from "@core/channels/webSeed.js";
import type { UnitThread } from "@core/core/unitRuns.js";
export interface SearchSession {
  thread: UnitThread;
  key: string;
}
const props = defineProps<{
  sessions: SearchSession[];
  runs: UnitRunRowSeed[];
  initial?: { thread?: string; q?: string };
  fetch?: typeof globalThis.fetch;
}>();
const emit = defineEmits<{ open: [runId: string, turn: number] }>();
const selected = ref<UnitThread>(
  props.sessions.find((row) => row.thread === props.initial?.thread)?.thread ?? props.sessions[0]?.thread ?? "coding",
);
const words = ref(props.initial?.q ?? "");
const state = ref<"idle" | "searching" | "done" | "unavailable">("idle");
const hits = ref<SessionSearchHit[]>([]);
const searched = ref("");
const runById = computed(() => new Map(props.runs.map((run) => [run.id, run])));
let generation = 0;
const label = (kind: UnitThread) => (kind === "coding" ? "Code thread" : "Review thread");
function place(hit: SessionSearchHit) {
  const run = hit.runId ? runById.value.get(hit.runId) : undefined;
  if (!run) return hit.runId ? "A run outside this unit" : "Before any recorded run";
  return run.round !== undefined && run.thread ? `Round ${run.round} · ${label(run.thread)}` : "Run details";
}
watch(selected, () => {
  generation++;
  hits.value = [];
  state.value = "idle";
});
onBeforeUnmount(() => {
  generation++;
  hits.value = [];
});
async function search() {
  const query = words.value.trim();
  const source = props.sessions.find((row) => row.thread === selected.value)?.key;
  if (!source || !query) return;
  const request = ++generation;
  state.value = "searching";
  try {
    const parameters = new URLSearchParams({ session: source, query, limit: "20" });
    const response = await (props.fetch ?? globalThis.fetch)(`/api/runs.search?${parameters}`, {
      credentials: "same-origin",
    });
    const result = (await response.json()) as { hits?: SessionSearchHit[] };
    if (request !== generation) return;
    if (!response.ok || !Array.isArray(result.hits)) {
      state.value = "unavailable";
      hits.value = [];
      return;
    }
    hits.value = result.hits.map((hit) => ({ ...hit, snippet: unwrapUntrusted(String(hit.snippet ?? "")) }));
    searched.value = query;
    state.value = "done";
  } catch {
    if (request === generation) {
      state.value = "unavailable";
      hits.value = [];
    }
  }
}
onMounted(() => {
  if (props.initial?.q) void search();
});
</script>
<template>
  <section v-if="sessions.length" aria-label="Thread search">
    <form class="green-toolbar" @submit.prevent="search">
      <label
        ><span class="sr-only">Thread search</span
        ><select v-model="selected" class="green-input" aria-label="Thread search">
          <option v-for="row in sessions" :key="row.thread" :value="row.thread">{{ label(row.thread) }}</option>
        </select></label
      ><label class="flex-1 min-w-40"
        ><span class="sr-only">Search words</span
        ><input
          v-model="words"
          class="green-input w-full"
          type="search"
          aria-label="Search words"
          placeholder="Find a file, error, or decision…" /></label
      ><button class="green-button" type="submit" :disabled="state === 'searching' || !words.trim()">
        <UIcon name="i-lucide-search" />Search
      </button>
    </form>
    <p v-if="state === 'searching'" class="text-xs text-muted" role="status">
      Searching the {{ label(selected).toLowerCase() }}…
    </p>
    <p v-else-if="state === 'unavailable'" class="text-xs text-warn" role="status">
      Thread search is unavailable. No result count can be confirmed.
    </p>
    <p v-else-if="state === 'done' && !hits.length" class="text-xs text-muted" role="status">
      No matches in this authorized {{ label(selected).toLowerCase() }} for “{{ searched }}”.
    </p>
    <ol v-else-if="state === 'done'" class="list-none p-0 m-0">
      <li v-for="hit in hits" :key="`${hit.turn}:${hit.runId ?? ''}`" class="border-t border-muted py-3">
        <div class="flex flex-wrap gap-2 text-xs text-muted">
          <span>Turn {{ hit.turn }}</span
          ><span v-if="hit.role">{{ hit.role }}</span
          ><button
            v-if="hit.runId && runById.has(hit.runId)"
            class="text-primary min-h-10"
            type="button"
            @click="emit('open', hit.runId, hit.turn)"
          >
            {{ place(hit) }} →</button
          ><span v-else>{{ place(hit) }}</span>
        </div>
        <p class="text-sm break-words">{{ hit.snippet }}</p>
        <p v-if="hit.gap !== undefined" class="text-xs text-warn mt-2">
          The earlier conversation was compacted at turn {{ hit.gap }}. This result follows that gap.
        </p>
      </li>
    </ol>
  </section>
</template>
