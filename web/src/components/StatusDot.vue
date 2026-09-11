<script setup lang="ts">
// The status dot every dashboard row leads with: tone = green live/warm,
// amber transitional, red failed/down, grey finished/unknown — the theme's
// status tokens (main.css), never a palette hue. The label is the accessible
// name; `tip` adds the shared tooltip.

type Tone = "green" | "amber" | "red" | "grey";

defineProps<{
  tone: Tone;
  label: string;
  tip?: string;
  /** Live rows breathe (reduced-motion turns it off). */
  pulse?: boolean;
}>();

const TONE: Record<Tone, string> = {
  green: "bg-ok",
  amber: "bg-warn",
  red: "bg-bad",
  grey: "bg-(--ui-text-dimmed)",
};
</script>

<template>
  <UTooltip v-if="tip" :text="tip">
    <span
      class="inline-block size-[0.6em] shrink-0 rounded-full"
      :class="[TONE[tone], pulse ? 'motion-safe:animate-pulse' : '']"
      role="img"
      :aria-label="label"
      :data-tone="tone"
    />
  </UTooltip>
  <span
    v-else
    class="inline-block size-[0.6em] shrink-0 rounded-full"
    :class="[TONE[tone], pulse ? 'motion-safe:animate-pulse' : '']"
    role="img"
    :aria-label="label"
    :data-tone="tone"
  />
</template>
