<script setup lang="ts">
// The status dot every dashboard row leads with: tone = green live/warm,
// amber transitional, red failed/down, grey finished/unknown. The label is the
// accessible name; `tip` adds the shared tooltip.

type Tone = "green" | "amber" | "red" | "grey";

defineProps<{
  tone: Tone;
  label: string;
  tip?: string;
  /** Live rows breathe (reduced-motion turns it off). */
  pulse?: boolean;
}>();

const TONE: Record<Tone, string> = {
  green: "bg-green-600",
  amber: "bg-yellow-600",
  red: "bg-red-500",
  grey: "bg-neutral-500",
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
