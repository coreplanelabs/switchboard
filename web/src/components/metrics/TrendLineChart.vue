<script setup lang="ts">
import { DOT_FILL, SERIES_STROKE, type TrendChartModel } from "../../lib/metrics";

// A per-day line chart as inline SVG (docs/reference/specs/run-metrics.md
// item 10): the failure-rate line and the p50-wall-per-agent lines. Geometry
// comes prebuilt (lib/metrics.ts `trendChartModelOf`) — the component does
// layout only. A day without a value is a gap in its line, never a zero; every
// point carries a dot whose <title> names the day, the series and the value,
// so a lone day is still visible and hoverable.

defineProps<{ model: TrendChartModel; label: string }>();
</script>

<template>
  <div class="overflow-x-auto">
    <svg
      class="block h-auto w-full font-mono"
      :viewBox="`0 0 ${model.width} ${model.height}`"
      role="img"
      :aria-label="label"
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
      <template v-for="line in model.lines" :key="line.name">
        <polyline
          v-for="(points, i) in line.segments"
          :key="`${line.name}-${i}`"
          class="trend-line fill-none"
          :class="SERIES_STROKE[line.seriesIndex % SERIES_STROKE.length]"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
          :points="points"
        />
        <circle
          v-for="(d, i) in line.dots"
          :key="`${line.name}-d${i}`"
          class="trend-dot"
          :class="DOT_FILL[line.seriesIndex % DOT_FILL.length]"
          :cx="d.x"
          :cy="d.y"
          r="2.5"
        >
          <title>{{ d.title }}</title>
        </circle>
      </template>
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
