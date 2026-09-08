<script setup lang="ts">
// A streamed span that is a step of its own (docs/reference/specs/tracing.md): its display
// name, its duration once it ended, a pulse while open. One markup for the rows
// of the log and the rows under a phase head. The row's id (`span-<id>`) is
// what the timeline's Longest steps scroll to.
import type { SpanRowVm } from "../../lib/runPageModel";
import { formatClock, formatDuration, formatLocalIso } from "../../lib/format";

defineProps<{ item: SpanRowVm }>();
</script>

<template>
  <li :id="`span-${item.spanId}`" class="span flex items-baseline gap-2 py-0.5 pr-(--sb-gutter) text-xs text-muted">
    <span class="glyph select-none" :class="item.status === 'error' ? 'text-bad' : 'text-dimmed'">{{
      item.open ? "◌" : item.status === "error" ? "✗" : "◷"
    }}</span>
    <span class="what">{{ item.text }}</span>
    <span v-if="item.open" class="text-dimmed">…</span>
    <span v-else-if="item.durationMs !== undefined" class="dur tabular-nums text-dimmed">{{
      formatDuration(item.durationMs, "precise")
    }}</span>
    <span v-if="item.at !== undefined" class="ts ml-auto select-none text-dimmed" :title="formatLocalIso(item.at)">{{
      formatClock(item.at)
    }}</span>
  </li>
</template>
