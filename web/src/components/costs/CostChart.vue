<script setup lang="ts">
import { computed, ref } from "vue";
import type { CostReport } from "@core/core/costs.js";
import { chartModelOf, type ChartDayHover, SERIES_FILL } from "../../lib/costs";

// The daily-cost stacked bars as inline SVG. Hover is per DAY, not per
// segment: one transparent column over each bar; pointing at it shows a
// tooltip panel with that day's whole breakdown (every series and the total),
// at once and styled — the browser's native SVG <title> tooltip was slow to
// appear and easy to miss, so the breakdown is the column's aria-label for
// assistive tech and the panel for everyone else. The segments carry no title
// of their own: the column above them takes the pointer anyway.

const props = defineProps<{ report: CostReport; series: string[] }>();
const model = computed(() => chartModelOf(props.report, props.series));

const tip = ref<{ x: number; y: number; lines: string[] } | null>(null);
const host = ref<HTMLElement | null>(null);

function showTip(d: ChartDayHover, ev: PointerEvent): void {
  // The panel is positioned inside the host, which scrolls sideways on a
  // narrow screen: add what has scrolled out, or the panel lands short.
  const el = host.value;
  const box = el?.getBoundingClientRect();
  tip.value = {
    x: ev.clientX - (box?.left ?? 0) + (el?.scrollLeft ?? 0) + 12,
    y: ev.clientY - (box?.top ?? 0) + (el?.scrollTop ?? 0) + 12,
    lines: d.title.split("\n"),
  };
}
</script>

<template>
  <div ref="host" class="relative overflow-x-auto">
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
        role="img"
        :aria-label="d.title"
        :x="d.x"
        :y="d.y"
        :width="d.width"
        :height="d.height"
        @pointerenter="showTip(d, $event)"
        @pointermove="showTip(d, $event)"
        @pointerleave="tip = null"
      />
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
    <div
      v-if="tip"
      class="chart-tip pointer-events-none absolute z-10 grid gap-0.5 rounded-md border border-default bg-elevated px-3 py-2 font-mono text-xs tabular-nums shadow-lg"
      role="tooltip"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
    >
      <div class="font-medium text-highlighted">{{ tip.lines[0] }}</div>
      <div v-for="(line, i) in tip.lines.slice(1)" :key="i" class="text-muted">{{ line }}</div>
    </div>
  </div>
</template>
