<script setup lang="ts">
import { computed } from "vue";
import { AGENT_HUE, agentHue } from "../../lib/indexRow";

// The receipt chip (docs/reference/specs/web-chat.md item 6): the front door's
// decision as the run's own `route` event carries it — the preset and its
// reason — painted in the preset's data colour, the same hue the runs index
// gives that agent's chip. Colour is data: a preset without a hue is ink.

const props = defineProps<{ route: { preset: string; reason: string } }>();
const hue = computed(() => AGENT_HUE[agentHue(props.route.preset)]);
</script>

<template>
  <span
    class="receipt inline-flex max-w-full items-baseline gap-1.5 rounded border px-1.5 py-px font-mono text-[0.7rem] leading-relaxed"
    :class="hue"
    :title="`routed: ${route.reason}`"
    data-testid="receipt"
  >
    <span class="preset font-medium">{{ route.preset }}</span>
    <span class="reason truncate font-normal opacity-80">· {{ route.reason }}</span>
  </span>
</template>
