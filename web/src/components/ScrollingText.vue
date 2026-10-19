<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useResizeObserver } from "@vueuse/core";

const props = defineProps<{ text: string }>();
const viewport = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const distance = ref(0);
const manual = ref(false);
function measure() {
  distance.value = Math.max(0, (content.value?.scrollWidth ?? 0) - (viewport.value?.clientWidth ?? 0));
}
useResizeObserver([viewport, content], measure);
watch(
  () => props.text,
  async () => {
    manual.value = false;
    if (viewport.value) viewport.value.scrollLeft = 0;
    await nextTick();
    measure();
  },
);
</script>
<template>
  <span
    ref="viewport"
    class="scrolling-text"
    :class="{ 'has-overflow': distance > 0, 'manual-scroll': manual }"
    :style="{ '--text-travel': `${-distance}px`, '--text-period': `${Math.max(8, distance / 32 + 4)}s` }"
    @scroll="manual = true"
    ><span ref="content" class="scrolling-text-content">{{ text }}</span></span
  >
</template>
<style scoped>
.scrolling-text {
  display: block;
  overflow-x: auto;
  white-space: nowrap;
}
.scrolling-text-content {
  display: inline-block;
}
@media (hover: hover) and (pointer: fine) {
  .has-overflow:hover:not(.manual-scroll):not(:focus) .scrolling-text-content {
    animation: text-travel var(--text-period) linear infinite alternate;
  }
}
@keyframes text-travel {
  0%,
  15% {
    transform: translateX(0);
  }
  85%,
  100% {
    transform: translateX(var(--text-travel));
  }
}
@media (prefers-reduced-motion: reduce) {
  .has-overflow:hover:not(.manual-scroll):not(:focus) .scrolling-text-content {
    animation: none;
  }
}
</style>
