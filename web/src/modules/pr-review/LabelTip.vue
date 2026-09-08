<script setup lang="ts">
// A tooltip for a label the reader cannot name (the producer, `truncated`) or
// cannot read whole (a clamped Tour step, a truncated path): one setting for
// every place it appears — a sentence, so it wraps at a measure instead of
// running off the panel; it opens below and slides along the edge when it
// would clip; a short delay so a sweep across the header does not flash every
// explanation. `disabled` keeps a tooltip quiet while its text is already
// visible whole (a step that fits its clamp).
withDefaults(defineProps<{ text: string; disabled?: boolean }>(), { disabled: false });
</script>

<template>
  <UTooltip
    :text="text"
    :disabled="disabled"
    :delay-duration="250"
    :content="{ side: 'bottom', align: 'end', sideOffset: 6, collisionPadding: 8 }"
    :ui="{ content: 'h-auto max-w-[28rem] px-2.5 py-1.5', text: 'text-clip whitespace-normal leading-snug' }"
  >
    <slot />
  </UTooltip>
</template>
