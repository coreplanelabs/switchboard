<script setup lang="ts">
// A streamed span that is a step of its own (features/tracing.md): its display
// name, its duration once it ended, a pulse while open. One markup for the rows
// of the log and the rows under the Setup head.
import type { SpanRowVm } from "../../lib/runPageModel";
import { formatClock, formatDuration, formatLocalIso } from "../../lib/format";

defineProps<{ item: SpanRowVm }>();
</script>

<template>
  <li class="span flex items-baseline gap-2 py-0.5 text-xs text-muted">
    <span class="glyph select-none" :class="item.status === 'error' ? 'text-bad' : 'text-dimmed'">{{
      item.open ? "◌" : item.status === "error" ? "✗" : "◷"
    }}</span>
    <span class="what">{{ item.text }}</span>
    <span v-if="item.open" class="text-dimmed">…</span>
    <span v-else-if="item.durationMs !== undefined" class="dur tabular-nums text-dimmed">{{
      formatDuration(item.durationMs, "precise")
    }}</span>
    <span v-if="item.at !== undefined" class="ts ml-auto select-none" :title="formatLocalIso(item.at)">{{
      formatClock(item.at)
    }}</span>
  </li>
</template>
