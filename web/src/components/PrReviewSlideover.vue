<script setup lang="ts">
import PrReviewPanel from "../modules/pr-review/PrReviewPanel.vue";
import { watch } from "vue";
import { POPUP_LAYER } from "../lib/uiTheme";
import { panelTitle, prLinks, type AbridgeControl, type PrReviewData } from "../modules/pr-review/types";

defineProps<{ data: PrReviewData; abridge?: AbridgeControl; loading?: boolean; message?: string }>();
const open = defineModel<boolean>("open", { default: false });
let trigger: HTMLElement | null = null;
watch(
  open,
  (value) => {
    if (value) trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  },
  { immediate: true, flush: "sync" },
);
function restoreFocus(event: Event) {
  if (trigger?.isConnected) {
    event.preventDefault();
    trigger.focus();
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="panelTitle(data)"
    :content="{ onCloseAutoFocus: restoreFocus }"
    :ui="{ overlay: POPUP_LAYER, content: `${POPUP_LAYER} w-full max-w-none sm:w-[min(96vw,90rem)]` }"
  >
    <template #content="{ close }">
      <div class="flex h-full min-h-0 min-w-0 flex-col">
        <div v-if="$slots.actions" class="shrink-0 border-b border-default p-3">
          <slot name="actions" :close="close" />
        </div>
        <template v-if="loading || message">
          <header class="flex shrink-0 items-start justify-between gap-3 border-b border-default p-4 sm:p-6">
            <h2 class="min-w-0 break-words text-lg font-semibold">{{ panelTitle(data) }}</h2>
            <UButton icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Close" @click="close()" />
          </header>
          <div class="min-h-0 overflow-auto p-4 sm:p-6" role="status" :aria-busy="loading">
            <p class="flex items-center gap-2 text-sm text-muted">
              <UIcon v-if="loading" name="i-lucide-loader-circle" class="size-4 shrink-0 animate-spin" />
              {{ loading ? "Loading recorded diff…" : message }}
            </p>
            <a
              v-if="prLinks(data.pr).pr"
              :href="prLinks(data.pr).pr"
              target="_blank"
              rel="noopener noreferrer"
              class="mt-4 inline-flex items-center gap-2 text-sm underline"
            >
              <UIcon name="i-simple-icons-github" class="size-4" />View on GitHub
            </a>
          </div>
        </template>
        <PrReviewPanel v-else :data="data" :abridge="abridge" closable @close="close()" />
      </div>
    </template>
  </USlideover>
</template>
