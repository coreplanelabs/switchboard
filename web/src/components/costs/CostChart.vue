<script setup lang="ts">
import { computed, ref } from "vue";
import type { CostReport } from "@core/core/costs.js";
import { chartModelOf, type ChartDayHover, type DayTip, SERIES_FILL, usd } from "../../lib/costs";

// The daily-cost stacked bars as inline SVG. Hover is per DAY, not per
// segment: one transparent column over each bar; pointing at it shows a
// tooltip panel with that day's breakdown — the day and its total on top, then
// one row per component, largest first — at once and styled. The browser's
// native SVG <title> tooltip was slow to appear and easy to miss, so the
// breakdown is the column's aria-label for assistive tech and the panel for
// everyone else. The segments carry no title of their own: the column above
// them takes the pointer anyway.
//
// The panel is a child of the HOST, not of the scroll box the SVG sits in: a
// child of the scroll box would extend its scroll area and grow the card with
// scrollbars. It has a fixed width, never wraps, and flips to the left of the
// pointer near the host's right edge and above it near the bottom, so it
// stays inside the card.

const props = defineProps<{ report: CostReport; series: string[] }>();
const model = computed(() => chartModelOf(props.report, props.series));

/** The panel's width in CSS px (`w-64`), and its height from its row count, for the flip. */
const TIP_WIDTH = 256;
const TIP_HEIGHT = (rows: number): number => 44 + rows * 20;
const GAP = 12;

const tip = ref<{ x: number; y: number; data: DayTip } | null>(null);
const host = ref<HTMLElement | null>(null);

function showTip(d: ChartDayHover, ev: PointerEvent): void {
  const el = host.value;
  const box = el?.getBoundingClientRect();
  const relX = ev.clientX - (box?.left ?? 0);
  const relY = ev.clientY - (box?.top ?? 0);
  const w = el?.clientWidth ?? 0;
  const h = el?.clientHeight ?? 0;
  const height = TIP_HEIGHT(d.tip.rows.length);
  // Flip only when the host's size is known and the panel would leave it.
  const flipX = w > 0 && relX + GAP + TIP_WIDTH > w;
  const flipY = h > 0 && relY + GAP + height > h;
  tip.value = {
    x: Math.max(0, flipX ? relX - GAP - TIP_WIDTH : relX + GAP),
    y: Math.max(0, flipY ? relY - GAP - height : relY + GAP),
    data: d.tip,
  };
}
</script>

<template>
  <div ref="host" class="chart-host relative">
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
    </div>
    <div
      v-if="tip"
      class="chart-tip pointer-events-none absolute z-10 w-64 rounded-md border border-default bg-elevated px-3 py-2 font-mono text-xs tabular-nums whitespace-nowrap shadow-lg"
      role="tooltip"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
    >
      <div class="tip-head mb-1.5 flex items-baseline justify-between gap-3 border-b border-muted pb-1.5">
        <span class="font-medium text-highlighted"
          >{{ tip.data.label
          }}<span v-if="tip.data.partial" class="ml-1.5 font-normal text-dimmed">partial day</span></span
        >
        <span class="font-medium text-highlighted">{{ usd(tip.data.total) }}</span>
      </div>
      <div
        v-for="r in tip.data.rows"
        :key="r.series"
        class="tip-row flex items-baseline justify-between gap-3 leading-5"
      >
        <span class="tip-name truncate text-muted">{{ r.series }}</span>
        <span class="text-highlighted"
          ><span class="tip-usd">{{ usd(r.usd) }}</span
          ><span v-if="r.estimated" class="ml-1 text-dimmed">est.</span></span
        >
      </div>
    </div>
  </div>
</template>
