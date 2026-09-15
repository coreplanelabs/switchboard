<script setup lang="ts">
import { computed } from "vue";
import type { CostReport } from "@core/core/costs.js";
import { chartModelOf, SERIES_FILL } from "../../lib/costs";

// The daily-cost stacked bars as inline SVG. Hover is per DAY, not per
// segment: one transparent column over each bar whose <title> is that day's
// whole breakdown (every series and the total), with no script. The segments
// carry no <title> of their own — the column above them would take the
// pointer anyway, and a one-value tooltip under a whole-day one was noise.

const props = defineProps<{ report: CostReport; series: string[] }>();
const model = computed(() => chartModelOf(props.report, props.series));
</script>

<template>
  <div class="overflow-x-auto">
    <svg
      class="block h-auto w-full font-mono"
      :viewBox="`0 0 ${model.width} ${model.height}`"
      role="img"
      aria-label="Daily cost, stacked by component"
    >
      <template v-for="(g, i) in model.gridLines" :key="`g${i}`">
        <line
          class="stroke-(--ui-border-muted)"
          :x1="model.marginLeft"
          :x2="model.width - model.marginRight"
          :y1="g.y"
          :y2="g.y"
        />
        <text
          class="fill-(--ui-text-dimmed) text-[11px] tabular-nums"
          :x="model.marginLeft - 8"
          :y="g.y + 4"
          text-anchor="end"
        >
          {{ g.label }}
        </text>
      </template>
      <rect
        v-for="(s, i) in model.segments"
        :key="`s${i}`"
        class="seg hover:opacity-85"
        :class="SERIES_FILL[s.seriesIndex % SERIES_FILL.length]"
        :x="s.x"
        :y="s.y"
        :width="s.width"
        :height="s.height"
      />
      <rect
        v-for="(d, i) in model.dayHovers"
        :key="`h${i}`"
        class="day fill-transparent"
        :x="d.x"
        :y="d.y"
        :width="d.width"
        :height="d.height"
      >
        <title>{{ d.title }}</title>
      </rect>
      <text
        v-for="(d, i) in model.dayLabels"
        :key="`d${i}`"
        class="fill-(--ui-text-dimmed) text-[11px]"
        :x="d.x"
        :y="model.height - 10"
        text-anchor="middle"
      >
        {{ d.label }}
      </text>
      <line
        class="stroke-(--ui-border)"
        :x1="model.marginLeft"
        :x2="model.width - model.marginRight"
        :y1="model.axisY"
        :y2="model.axisY"
      />
    </svg>
  </div>
</template>
