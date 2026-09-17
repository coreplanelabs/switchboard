<script setup lang="ts">
import { formatDuration } from "../../lib/format";
import { modelName } from "../../lib/runPageModel";

// A pending model turn (live-view item 18): the model is silent and nothing is
// running. It reads as a ROW like the others — the dashed outline of the card
// that has not landed yet — and says plainly whose silence it is: the ∿ pulse,
// a `model` badge with the model's real name, a rotating verb, and the time
// since the last stamped event on the runner clock. ONE component for the run
// page's log and a thread's assistant turn, so the two never say it differently.
// A running command needs nothing here: its card ticks.

defineProps<{
  /** The rotating verb, or the open step's own words. */
  verb: string;
  /** How long this silence has lasted, on the runner clock. */
  elapsedMs: number;
  /** The silence has gone on long enough to read as slow. */
  slow?: boolean;
  /** The model's ref, badged by its short name; absent until the run has said it. */
  model?: string | null;
  /** The row's element: `li` in the run page's log, `div` in a turn. */
  tag?: "li" | "div";
  /** The element id the run page's log anchors on (`thinking`); a turn's row, of which
   *  a page may hold several, has none. */
  id?: string;
}>();
</script>

<template>
  <component
    :is="tag ?? 'li'"
    :id="id"
    class="pending flex items-center gap-3 rounded-md border border-dashed border-accented pl-3 pr-[calc(var(--sb-gutter)-1px)] py-2 text-sm"
    aria-live="off"
    title="the model is working on its next turn — nothing back yet (since the last event, runner clock)"
    data-testid="pending"
  >
    <span class="pulse text-[1.1em] leading-none text-info motion-safe:animate-pulse">∿</span>
    <span
      v-if="model"
      class="badge shrink-0 rounded bg-accented px-1.5 font-mono text-[0.68rem] font-medium leading-normal tracking-wider text-muted"
      :title="model"
      >{{ modelName(model) }}</span
    >
    <span class="verb min-w-0 truncate text-toned">{{ verb }}…</span>
    <span class="since ml-auto shrink-0 font-mono text-xs tabular-nums" :class="slow ? 'text-warn' : 'text-dimmed'">{{
      formatDuration(elapsedMs, "clock")
    }}</span>
  </component>
</template>
