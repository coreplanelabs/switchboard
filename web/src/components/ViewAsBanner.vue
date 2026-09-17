<script setup lang="ts">
import { ref } from "vue";
import type { ViewablePerson } from "@core/channels/webSeed.js";
import { exitViewAs } from "../lib/viewAs";

// The view-as banner (record 0053): who the page is shown as, that it is
// read-only, and the one way back. Drawn by AppShell on every page while the
// seed carries `viewingAs`; it never decides anything — the server narrowed the
// page and refuses the writes, this only says so.

defineProps<{ person: ViewablePerson }>();
const busy = ref(false);
const error = ref("");

async function exit(): Promise<void> {
  busy.value = true;
  error.value = "";
  const r = await exitViewAs();
  if (!r.ok) {
    busy.value = false;
    error.value = r.message;
  }
}
</script>

<template>
  <div
    id="view-as"
    class="view-as mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-toned"
    role="status"
  >
    <UIcon name="i-lucide-eye" class="size-4 shrink-0 text-warn" aria-hidden="true" />
    <span class="who">
      Viewing as <strong class="font-medium text-highlighted">{{ person.name ?? person.id }}</strong>
      <span v-if="person.name" class="ml-1 font-mono text-[0.6875rem] text-dimmed">{{ person.id }}</span>
    </span>
    <span class="readonly text-muted">· read-only: writes are your own to make.</span>
    <UButton
      id="view-as-exit"
      class="ml-auto"
      size="xs"
      color="neutral"
      variant="outline"
      icon="i-lucide-log-out"
      :loading="busy"
      @click="exit"
    >
      Exit view-as
    </UButton>
    <span v-if="error" class="basis-full text-bad">{{ error }}</span>
  </div>
</template>
