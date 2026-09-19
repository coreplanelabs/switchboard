<script setup lang="ts">
import { computed } from "vue";
import { formatDateTime, formatLocalIso } from "../../lib/format";

// A silent intake receipt (docs/reference/specs/web-chat.md item 12; record
// 0058): the gate read a message in this thread and answered nothing — the
// thread view says so where the run would have been, with the verdict's
// reason, so a silence is never a blank gap. One muted line, no bubble: the
// message's text was never stored, only the receipt.

const props = defineProps<{ reason: string; decidedAt: number; now: number }>();
const when = computed(() => formatDateTime(props.decidedAt, props.now));
</script>

<template>
  <div
    class="turn silent flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 font-mono text-[0.7rem] text-dimmed"
    data-testid="silent-receipt"
  >
    <span class="glyph select-none" aria-hidden="true">◌</span>
    <span class="label">Read, not answered</span>
    <span class="reason text-muted">— {{ reason }}</span>
    <span class="ts ml-auto select-none" :title="formatLocalIso(decidedAt)">{{ when }}</span>
  </div>
</template>
