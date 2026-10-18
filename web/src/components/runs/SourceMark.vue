<script setup lang="ts">
import SlackMark from "../SlackMark.vue";
import { SURFACE_NAME } from "../../lib/indexRow";
defineProps<{ kind: string; tip: string; url?: string }>();
const icons: Record<string, string> = {
  mcp: "i-lucide-plug",
  http: "i-lucide-globe",
  cli: "i-lucide-terminal",
  web: "i-lucide-monitor",
};
</script>

<template>
  <UTooltip :text="tip">
    <component
      :is="url ? 'a' : 'span'"
      class="source pointer-events-auto inline-flex size-4 shrink-0 items-center justify-center rounded text-dimmed focus-visible:outline-2 focus-visible:outline-primary"
      :class="url ? 'linked hover:text-primary' : ''"
      :data-kind="kind"
      :aria-label="url ? `open the ${SURFACE_NAME[kind] ?? kind} thread (new tab)` : (SURFACE_NAME[kind] ?? kind)"
      :tabindex="url ? undefined : 0"
      :href="url"
      :target="url ? '_blank' : undefined"
      :rel="url ? 'noopener noreferrer' : undefined"
    >
      <SlackMark v-if="kind === 'slack'" />
      <UIcon v-else :name="icons[kind] ?? 'i-lucide-circle-help'" class="size-3.5" />
    </component>
  </UTooltip>
</template>
