<script setup lang="ts">
import CallCard from "./CallCard.vue";
import { formatLocalIso } from "../../lib/format";
import type { StepItem } from "../../lib/runPageModel";

// The rows inside a step, in arrival order: call cards, quiet bookkeeping
// lines (update_status), and loaded-skill rows (docs/reference/specs/skills.md). Two row
// shapes only: calls are CARDS; everything else is a FLAT line — no borders,
// no backgrounds — so the cards read as the work and the flat lines as asides.
// The step's meta row owns the clock; flat rows keep their exact local time
// on their hover title.

defineProps<{ items: StepItem[] }>();

function fmtBytes(n: number): string {
  if (!(n > 0)) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(Math.round(n / 102.4) / 10).toFixed(1)} KB`;
  return `${(Math.round(n / 104_857.6) / 10).toFixed(1)} MB`;
}
</script>

<template>
  <template v-for="(item, i) in items" :key="i">
    <CallCard v-if="item.kind === 'call'" :call="item.call" />
    <div
      v-else-if="item.kind === 'quiet'"
      class="quiet flex items-baseline gap-3 pl-3 pr-(--sb-gutter) py-0.5 text-xs text-dimmed"
      :title="item.at !== undefined ? formatLocalIso(item.at) : undefined"
    >
      <span>{{ item.text }}</span>
    </div>
    <div
      v-else
      class="skill flex items-baseline gap-2.5 pl-3 pr-(--sb-gutter) py-0.5"
      :title="item.skill.at !== undefined ? formatLocalIso(item.skill.at) : undefined"
    >
      <span class="skillmark shrink-0 select-none text-xs">📚</span>
      <span class="skillname whitespace-nowrap font-semibold text-skill">skill {{ item.skill.name }}</span>
      <span v-if="item.skill.description" class="skilldesc min-w-0 flex-1 truncate text-xs text-muted">{{
        item.skill.description
      }}</span>
      <span class="facts ml-auto flex shrink-0 gap-2.5 text-xs text-muted">
        <a
          v-if="item.skill.source"
          class="fact text-primary hover:underline"
          :href="item.skill.source"
          target="_blank"
          rel="noopener noreferrer"
          >source</a
        >
        <span class="fact">{{ fmtBytes(item.skill.bodyBytes) }} into context</span>
      </span>
    </div>
  </template>
</template>
