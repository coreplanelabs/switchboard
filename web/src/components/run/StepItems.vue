<script setup lang="ts">
import CallCard from "./CallCard.vue";
import { formatLocalIso } from "../../lib/format";
import type { StepItem } from "../../lib/runPageModel";

// The rows inside a step, in arrival order: call cards, quiet bookkeeping
// lines (update_status), and loaded-skill rows (features/skills.md — a skill
// is its own row, set apart by a violet mark, never a call card).

defineProps<{ items: StepItem[] }>();

function stamp(at: number | undefined): string {
  return typeof at === "number" ? `[${formatLocalIso(at).slice(11, 19)}]` : "";
}

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
    <div v-else-if="item.kind === 'quiet'" class="quiet flex items-baseline gap-3 px-3 py-0.5 text-[0.8rem] text-dimmed">
      <span v-if="item.at !== undefined" class="ts select-none text-xs text-dimmed" :title="formatLocalIso(item.at)">{{ stamp(item.at) }}</span>
      <span>{{ item.text }}</span>
    </div>
    <div v-else class="skill flex items-baseline gap-2.5 rounded-r-md border-l-2 border-skill bg-skill/8 px-3 py-1 text-[0.85rem]">
      <span v-if="item.skill.at !== undefined" class="ts select-none text-xs text-dimmed" :title="formatLocalIso(item.skill.at)">{{
        stamp(item.skill.at)
      }}</span>
      <span class="skillmark shrink-0">📚</span>
      <span class="skillname whitespace-nowrap font-semibold text-highlighted">skill {{ item.skill.name }}</span>
      <span v-if="item.skill.description" class="skilldesc min-w-0 flex-1 truncate text-muted">{{ item.skill.description }}</span>
      <span class="facts ml-auto flex shrink-0 gap-2.5 text-xs text-muted">
        <a v-if="item.skill.source" class="fact text-primary hover:underline" :href="item.skill.source" target="_blank" rel="noopener noreferrer"
          >source</a
        >
        <span class="fact">{{ fmtBytes(item.skill.bodyBytes) }} into context</span>
      </span>
    </div>
  </template>
</template>
