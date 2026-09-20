<script setup lang="ts">
import GithubMark from "../GithubMark.vue";
import { endingWordOf } from "@core/core/pipelineStanding.js";
import type { UnitFacts } from "@core/core/unitRuns.js";

// The pipeline's own record lists the units its instance ran (agent-ship item
// 17): one row per unit in the plan's order — its id, the plan's title for it,
// how it ended, its pull request — each opening the unit's page, where the
// unit's runs read in round order. Present on the ship record alone.

defineProps<{ units: UnitFacts[] }>();

const ENDING_CLS: Record<string, string> = {
  merged: "border-ok/30 text-ok",
  merge_ready: "border-ok/30 text-ok",
  done: "border-ok/30 text-ok",
};

/** How a unit stands: its ending in the user's words (record 0066 —
 *  `merge-ready`, never `merge_ready`), else `idle · <why>` while it idles
 *  (record 0051), else whether it has started. */
function standing(u: UnitFacts): string {
  if (u.ending) return endingWordOf(u.ending.kind);
  if (u.idle) return `idle · ${endingWordOf(u.idle.why)}`;
  return u.threads.coding !== undefined
    ? `round ${u.rounds.at(-1)?.index ?? 0} · ${u.rounds.at(-1)?.agent ?? "in flight"}`
    : "not started";
}
</script>

<template>
  <section id="units" class="block mb-4 rounded-lg border border-default bg-(--ui-bg-muted) px-(--sb-gutter) py-3">
    <h2 class="mb-2 flex items-baseline gap-2.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">
      <span>Units</span>
      <span class="count font-normal normal-case tracking-normal text-dimmed"
        >· {{ units.length }} unit{{ units.length === 1 ? "" : "s" }} — each opens to its runs in round order</span
      >
    </h2>
    <ol class="m-0 list-none p-0">
      <li
        v-for="u in units"
        :key="u.unit"
        class="unit flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-t border-default py-1.5 first:border-t-0"
        :data-unit="u.unit"
      >
        <RouterLink
          class="key shrink-0 rounded border border-accented px-1.5 font-mono text-[0.72rem] font-medium text-toned no-underline hover:border-primary hover:text-primary"
          :to="`/runs/unit/${encodeURIComponent(u.unit)}`"
          >{{ u.id }}</RouterLink
        >
        <RouterLink
          class="title min-w-0 flex-1 truncate text-sm text-highlighted no-underline hover:underline"
          :to="`/runs/unit/${encodeURIComponent(u.unit)}`"
          >{{ u.title ?? u.branch }}</RouterLink
        >
        <span
          class="standing shrink-0 rounded border px-1.5 font-mono text-[0.7rem]"
          :class="ENDING_CLS[u.ending?.kind ?? ''] ?? 'border-accented text-muted'"
          >{{ standing(u) }}</span
        >
        <a
          v-if="u.pr"
          class="prlink shrink-0 whitespace-nowrap font-mono text-xs text-primary no-underline hover:underline"
          :href="u.pr.url"
          target="_blank"
          rel="noopener noreferrer"
          ><GithubMark class="mr-1 align-[-0.125em]" />#{{ u.pr.number }}</a
        >
      </li>
    </ol>
  </section>
</template>
