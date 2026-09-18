<script setup lang="ts">
// The app: one page at a time, mounted fresh per address with the seed loaded
// for it (lib/seedRouting.ts) — a full load and an in-app navigation give the
// same mount. While the next page's seed is on its way the current page stays,
// and a thin bar at the top of the viewport says a page is loading.
import { inject } from "vue";
import { useRoute } from "vue-router";
import SeedScope from "./components/SeedScope.vue";
import { pageAddress, SeedRoutingKey } from "./lib/seedRouting";

const route = useRoute();
const routing = inject(SeedRoutingKey);
if (!routing) throw new Error("App needs the seed routing main.ts installs");
</script>

<template>
  <UApp>
    <div
      v-if="routing.loading.value"
      class="sb-nav-progress fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden"
      role="progressbar"
      aria-label="Loading page"
      data-testid="nav-progress"
    >
      <div
        class="h-full w-1/3 bg-(--ui-text-highlighted) motion-safe:animate-[sb-nav-progress_1s_ease-in-out_infinite]"
      />
    </div>
    <RouterView v-slot="{ Component }">
      <SeedScope v-if="Component" :key="pageAddress(route)" :seed="routing.seedAt(pageAddress(route))">
        <component :is="Component" />
      </SeedScope>
    </RouterView>
  </UApp>
</template>

<style>
@keyframes sb-nav-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}
</style>
