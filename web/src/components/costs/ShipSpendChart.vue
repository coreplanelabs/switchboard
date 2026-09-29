<script setup lang="ts">
import { computed } from "vue";
import type { ShipSpendReport } from "@core/core/shipSpend.js";
import { usd } from "../../lib/costs";

const props = defineProps<{ unit: ShipSpendReport["units"][number] }>();
const width = 900;
const height = 250;
const left = 58;
const right = 18;
const top = 18;
const bottom = 36;
const plotHeight = height - top - bottom;
const geometry = computed(() => {
  const runs = props.unit.runs;
  const first = runs[0]?.finishedAt ?? 0;
  const last = runs.at(-1)?.finishedAt ?? first;
  const peak = Math.max(1, props.unit.capUsd ?? 0, ...runs.map((r) => r.cumulativeUsd ?? 0)) * 1.08;
  const x = (at: number) =>
    left + (last === first ? (width - left - right) / 2 : ((at - first) / (last - first)) * (width - left - right));
  const y = (value: number) => top + plotHeight * (1 - value / peak);
  return {
    capY: props.unit.capUsd === null ? null : y(props.unit.capUsd),
    points: runs.map((r) => ({ ...r, x: x(r.finishedAt), y: r.cumulativeUsd === null ? null : y(r.cumulativeUsd) })),
    axisY: y(0),
    peak,
  };
});
const line = computed(() =>
  geometry.value.points
    .filter((p) => p.y !== null)
    .map((p) => `${p.x},${p.y}`)
    .join(" "),
);
const stamp = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
</script>

<template>
  <div class="overflow-x-auto">
    <svg
      class="block h-auto w-full min-w-[36rem] font-mono"
      :viewBox="`0 0 ${width} ${height}`"
      role="img"
      :aria-label="`Ship unit spend shown in this date range for ${unit.key}`"
    >
      <line :x1="left" :x2="width - right" :y1="geometry.axisY" :y2="geometry.axisY" class="stroke-(--ui-border)" />
      <template v-if="geometry.capY !== null">
        <line
          :x1="left"
          :x2="width - right"
          :y1="geometry.capY"
          :y2="geometry.capY"
          class="stroke-(--ui-text-muted)"
          stroke-width="1.5"
          stroke-dasharray="6 4"
          data-ship-cap-line
        />
        <text :x="left + 4" :y="geometry.capY - 6" class="fill-(--ui-text-muted) text-[11px]">
          Unit cap {{ usd(unit.capUsd!) }}
        </text>
      </template>
      <polyline
        v-if="line"
        :points="line"
        fill="none"
        stroke-width="2"
        class="stroke-[#4478b8] dark:stroke-[#7aa7e0]"
      />
      <template v-for="p in geometry.points" :key="p.id">
        <a v-if="p.y !== null" :href="`/runs/${encodeURIComponent(p.id)}`">
          <circle :cx="p.x" :cy="p.y" r="4" class="fill-[#4478b8] dark:fill-[#7aa7e0]">
            <title>
              {{ stamp(p.finishedAt) }} · run {{ p.id }} · {{ usd(p.usd!) }} · cumulative {{ usd(p.cumulativeUsd!) }}
            </title>
          </circle>
        </a>
      </template>
      <text :x="left" :y="height - 8" class="fill-(--ui-text-dimmed) text-[11px]" text-anchor="start">
        {{ stamp(unit.runs[0]!.finishedAt) }}
      </text>
      <text :x="width - right" :y="height - 8" class="fill-(--ui-text-dimmed) text-[11px]" text-anchor="end">
        {{ stamp(unit.runs.at(-1)!.finishedAt) }}
      </text>
    </svg>
  </div>
</template>
