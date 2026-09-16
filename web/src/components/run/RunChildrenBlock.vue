<script setup lang="ts">
import RunFoldRow from "../runs/RunFoldRow.vue";
import type { UnitRunRowSeed } from "@core/channels/webSeed.js";

// A conductor's run page lists the runs it spawned (agent-conductor item 11)
// the way the unit page lists a unit's runs: one row each in start order, a
// finished one opening to its own timeline in place, a live one ticking and
// linking to its live page.

defineProps<{ children: UnitRunRowSeed[]; now: number }>();
</script>

<template>
  <section id="children" class="block mb-4 px-(--sb-gutter)">
    <h2 class="mb-1 flex items-baseline gap-2.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">
      <span>Spawned runs</span>
      <span class="count font-normal normal-case tracking-normal text-dimmed"
        >· {{ children.length }} run{{ children.length === 1 ? "" : "s" }}, in the order they started</span
      >
    </h2>
    <ol class="m-0 list-none border-t border-muted p-0">
      <RunFoldRow v-for="child in children" :key="child.id" :run="child" :now="now" />
    </ol>
  </section>
</template>
