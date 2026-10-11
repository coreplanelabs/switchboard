<script setup lang="ts">
import { computed, ref } from "vue";
import { useSeed } from "../../src/lib/seed";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
const seed = useSeed("home");
const query = ref("");
const rows = computed(() =>
  (seed?.conversations ?? []).filter((row) =>
    `${row.title} ${row.id}`.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
</script>
<template>
  <PageHeading
    title="Threads"
    description="Search recent conversations loaded in this browser. Opening a thread does not change your reply destination."
    ><RouterLink class="green-button" to="/home"><UIcon name="i-lucide-arrow-left" />Home</RouterLink></PageHeading
  >
  <p v-if="seed" class="green-notice" role="status">
    <template v-if="seed.discovery?.status === 'unavailable'"
      >Thread discovery is unavailable. An empty list cannot confirm that no threads exist.</template
    >
    <template v-else-if="seed.discovery?.status === 'partial'"
      >Thread discovery is incomplete. Only the loaded conversations are shown.</template
    >
    <template v-else-if="seed.discovery?.status === 'available'"
      >Recent authorized conversations are available.</template
    >
    <template v-else>Coverage is unknown; the full retained history cannot be confirmed.</template>
    <template v-if="seed.discovery?.filtered"> Only conversations allowed by your current access are listed.</template>
    <template v-if="seed.discovery"> This is a bounded recent window, not the full retained history.</template>
  </p>
  <div v-if="seed" class="green-toolbar">
    <label class="w-full max-w-md"
      ><span class="sr-only">Filter the loaded browser list</span
      ><input v-model="query" class="green-input w-full" placeholder="Find in loaded list…"
    /></label>
  </div>
  <section v-if="seed" class="green-section">
    <div class="green-section-heading">
      <h2>Loaded browser conversations</h2>
      <span class="text-xs text-muted">{{ rows.length }} in loaded list</span>
    </div>
    <ul v-if="rows.length" class="list-none m-0 p-0">
      <li v-for="row in rows" :key="row.id" class="border-b border-muted last:border-0">
        <RouterLink
          class="flex gap-3 justify-between p-5 hover:bg-elevated"
          :to="`/threads/${encodeURIComponent(row.id)}`"
          ><span class="min-w-0"
            ><span class="block text-sm text-highlighted break-words">{{ row.title }}</span
            ><span class="block text-xs text-muted mt-1">{{ row.id }}</span></span
          ><span v-if="row.live" class="green-badge self-start">Running</span
          ><UIcon v-else name="i-lucide-chevron-right" class="text-muted shrink-0"
        /></RouterLink>
      </li>
    </ul>
    <EmptyState
      v-else
      :title="
        seed.discovery?.status === 'unavailable'
          ? 'Threads unavailable'
          : seed.discovery?.status === 'partial'
            ? 'No threads in the incomplete loaded list'
            : query
              ? 'No matches in the loaded browser list'
              : 'No threads in the loaded browser list'
      "
      description="This result covers only the loaded list. Full retained history cannot be confirmed."
    />
  </section>
  <section v-else class="green-section">
    <EmptyState
      title="Threads unavailable"
      description="The browser conversation list could not be loaded. Thread history cannot be confirmed."
    />
  </section>
</template>
