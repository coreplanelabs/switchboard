<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, provide, watch } from "vue";
import { useRoute } from "vue-router";
import SeedScope from "../src/components/SeedScope.vue";
import { SeedRoutingKey, pageAddress } from "../src/lib/seedRouting";
import { useEventSourceFactory } from "../src/lib/eventSource";
import Shell from "./components/Shell.vue";
import ConversationDock from "./components/ConversationDock.vue";
import { createHomeSession, HomeSessionKey } from "./lib/homeSession";
const route = useRoute();
const routing = inject(SeedRoutingKey);
if (!routing) throw new Error("Green app needs seed routing");
const home = createHomeSession(fetch, useEventSourceFactory());
provide(HomeSessionKey, home);
const hasDock = computed(
  () => /^(\/home|\/threads\/|\/runs\/|\/pipelines\/)/.test(route.path) && route.path !== "/runs/scheduled",
);
watch(
  () => pageAddress(route),
  (path) => home.routeChanged(path),
  { immediate: true },
);
onMounted(() => {
  void home.load();
});
onBeforeUnmount(() => home.dispose());
</script>
<template>
  <UApp
    ><div
      v-if="routing.loading.value"
      class="fixed inset-x-0 top-0 h-0.5 z-50 bg-primary"
      role="progressbar"
      aria-label="Loading page" />
    <SeedScope :key="pageAddress(route)" :seed="routing.seedAt(pageAddress(route))"
      ><Shell
        ><div class="green-content-layout" :class="{ 'has-dock': hasDock }">
          <div class="green-page-content"><RouterView /></div>
          <ConversationDock v-if="hasDock" /></div></Shell></SeedScope
  ></UApp>
</template>
<style>
.green-page-content {
  min-width: 0;
}
.green-content-layout.has-dock {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  align-items: start;
  gap: 24px;
}
.green-evidence-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.green-page-content #findings .where,
.green-page-content #findings .title {
  max-width: 100%;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .green-page-content #findings .title {
    flex-basis: 100%;
  }
}
@media (max-width: 1100px) {
  .green-content-layout.has-dock {
    display: block;
    padding-bottom: 230px;
  }
}
</style>
