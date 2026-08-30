<script setup lang="ts">
// The one page chrome every section shares: header (leading slot · title ·
// status slot · actions · site nav) over the page body. This is the
// normalization the port buys — the four hand-rolled shells (runs, run page,
// residents, costs) collapse into this component.
import AppNav from "./AppNav.vue";
import ThemeToggle from "./ThemeToggle.vue";
import type { NavSection } from "./AppNav.vue";

defineProps<{ title: string; nav: NavSection }>();
</script>

<template>
  <div class="mx-auto max-w-[80rem] px-5 pb-16 pt-4">
    <header class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-default pb-3">
      <slot name="leading" />
      <h1 class="text-base font-semibold text-highlighted">{{ title }}</h1>
      <slot name="status" />
      <span class="ml-auto flex items-center gap-4">
        <slot name="actions" />
        <AppNav :current="nav" />
        <ThemeToggle />
      </span>
    </header>
    <slot />
  </div>
</template>
