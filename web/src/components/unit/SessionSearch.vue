<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { unwrapUntrusted } from "@core/core/untrusted.js";
import type { SessionSearchHit } from "@core/core/runsService.js";
import type { UnitRunRowSeed } from "@core/channels/webSeed.js";
import type { UnitThread } from "@core/core/unitRuns.js";

// The unit page's search (session-log item 11; record 0035): one session's
// log at a time — the coding thread's or the review thread's, since the index
// is per session and no cross-session index exists — through the same read
// the model's `recall` makes, `GET /api/runs.search`. Each hit names its turn,
// who spoke, a one-line snippet (the route wraps it as untrusted content for
// machine callers; a page renders text as text, so the fence comes off) and
// the run whose recorded range holds the turn — a link that opens that run's
// fold on this page. A hit past a compaction gap says so: the words were
// found, but the log before that turn was folded into a summary.

export interface SearchSession {
  thread: UnitThread;
  key: string;
}

const props = defineProps<{
  sessions: SearchSession[];
  runs: UnitRunRowSeed[];
  /** A search to run on first paint (`?session=coding&q=…`): a shareable search. */
  initial?: { thread?: string; q?: string };
  fetch?: typeof globalThis.fetch;
}>();
const emit = defineEmits<{ open: [runId: string] }>();

/** Hits the page asks for — a person reads a short list; the route caps at its own maximum. */
const PAGE_HITS = 20;

const thread = ref<UnitThread>(
  props.sessions.find((s) => s.thread === props.initial?.thread)?.thread ?? props.sessions[0]?.thread ?? "coding",
);
const q = ref(props.initial?.q ?? "");
const state = ref<"idle" | "searching" | "done" | "failed">("idle");
const hits = ref<SessionSearchHit[]>([]);
const searched = ref("");

const session = computed(() => props.sessions.find((s) => s.thread === thread.value));
const runById = computed(() => new Map(props.runs.map((r) => [r.id, r])));

/** Where a hit sits: its run's round and thread when a run's range holds it. */
function place(hit: SessionSearchHit): string {
  const run = hit.runId !== undefined ? runById.value.get(hit.runId) : undefined;
  if (!run) return hit.runId !== undefined ? "a run outside this unit" : "before any recorded run";
  return run.round !== undefined && run.thread ? `round ${run.round} · ${run.thread}` : (run.agent ?? "its run");
}

async function search(): Promise<void> {
  const words = q.value.trim();
  const key = session.value?.key;
  if (!key || words === "") return;
  state.value = "searching";
  const fetchFn = props.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));
  try {
    const query = `session=${encodeURIComponent(key)}&query=${encodeURIComponent(words)}&limit=${PAGE_HITS}`;
    const res = await fetchFn(`/api/runs.search?${query}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { hits?: SessionSearchHit[] };
    hits.value = (body.hits ?? []).map((h) => ({ ...h, snippet: unwrapUntrusted(String(h.snippet ?? "")) }));
    searched.value = words;
    state.value = "done";
  } catch {
    hits.value = [];
    state.value = "failed";
  }
}

onMounted(() => {
  if (props.initial?.q && session.value) void search();
});
</script>

<template>
  <section
    v-if="sessions.length > 0"
    id="search"
    class="block mb-4 rounded-lg border border-default bg-(--ui-bg-muted) px-(--sb-gutter) py-3"
  >
    <h2 class="mb-2 flex items-baseline gap-2.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">
      <span>Search the conversation</span>
      <span class="font-normal normal-case tracking-normal text-dimmed">· one thread's log at a time</span>
    </h2>
    <form class="flex flex-wrap items-center gap-2" @submit.prevent="search">
      <select
        id="search-session"
        v-model="thread"
        class="session rounded border border-accented bg-default px-2 py-1 font-mono text-xs text-toned"
        aria-label="which thread's log to search"
      >
        <option v-for="s in sessions" :key="s.key" :value="s.thread">{{ s.thread }} thread</option>
      </select>
      <input
        id="search-words"
        v-model="q"
        type="search"
        class="words min-w-0 flex-1 rounded border border-accented bg-default px-2 py-1 text-sm text-highlighted placeholder:text-dimmed"
        placeholder="words the conversation used — a file, an error, a decision"
        aria-label="words to search for"
      />
      <UButton
        type="submit"
        size="xs"
        color="neutral"
        variant="outline"
        label="Search"
        :disabled="state === 'searching'"
      />
    </form>
    <p v-if="state === 'searching'" class="state mt-2 font-mono text-xs text-dimmed">searching…</p>
    <p v-else-if="state === 'failed'" class="state mt-2 font-mono text-xs text-warn">the search could not be run</p>
    <p v-else-if="state === 'done' && hits.length === 0" class="state mt-2 font-mono text-xs text-dimmed">
      nothing in the {{ thread }} thread's log says “{{ searched }}”
    </p>
    <ol v-else-if="state === 'done'" class="hits mt-2 flex list-none flex-col gap-1.5 p-0">
      <li
        v-for="hit in hits"
        :key="`${hit.turn}-${hit.runId ?? ''}`"
        class="hit flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-default pt-1.5 first:border-t-0 first:pt-0"
        :data-turn="hit.turn"
        :data-run-id="hit.runId"
        :data-gap="hit.gap"
      >
        <span class="turn shrink-0 font-mono text-xs tabular-nums text-dimmed">turn {{ hit.turn }}</span>
        <span v-if="hit.role" class="role shrink-0 font-mono text-xs text-muted">{{ hit.role }}</span>
        <span class="snippet min-w-0 flex-1 truncate text-sm text-toned">{{ hit.snippet }}</span>
        <a
          v-if="hit.runId && runById.has(hit.runId)"
          class="place shrink-0 font-mono text-xs text-primary no-underline hover:underline"
          :href="`#run-${hit.runId}`"
          @click.prevent="emit('open', hit.runId)"
          >{{ place(hit) }} ↓</a
        >
        <span v-else class="place shrink-0 font-mono text-xs text-dimmed">{{ place(hit) }}</span>
        <span
          v-if="hit.gap !== undefined"
          class="gap basis-full font-mono text-xs text-warn"
          :title="`the log before turn ${hit.gap} was folded into a summary; this turn is after it`"
          >past a compaction gap at turn {{ hit.gap }}</span
        >
      </li>
    </ol>
  </section>
</template>
