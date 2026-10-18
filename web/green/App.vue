<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useRoute } from "vue-router";
import SeedScope from "../src/components/SeedScope.vue";
import { SeedRoutingKey, pageAddress } from "../src/lib/seedRouting";
import { useEventSourceFactory } from "../src/lib/eventSource";
import Shell from "./components/Shell.vue";
import ConversationDock from "./components/ConversationDock.vue";
import EmptyState from "./components/EmptyState.vue";
import { createHomeSession, HomeSessionKey } from "./lib/homeSession";
const route = useRoute();
const routing = inject(SeedRoutingKey);
if (!routing) throw new Error("Green app needs seed routing");
const home = createHomeSession(fetch, useEventSourceFactory());
provide(HomeSessionKey, home);
const pageSeed = computed(() => routing.seedAt(pageAddress(route)));
const accessLost = ref<"global" | "target" | null>(null);
const seedGeneration = ref(0);
const unavailableExplanation = ref<HTMLElement | null>(null);
let address = "",
  previousSeed = pageSeed.value,
  confirmedPrivacy: string | null = null,
  removalCountAtStart = home.contentRemovals.value;
const privacy = () => {
  // A target recovery has no public conversation; only its old invalidation identity remains.
  if (home.recoveringPrivacy.value) return home.recoveringPrivacy.value;
  const value = home.session.value;
  return value
    ? JSON.stringify([value.actor, value.organization, value.stream, value.bindingRevision, value.accessEpoch])
    : null;
};
watch(
  [() => pageAddress(route), pageSeed, privacy, () => home.removing.value],
  ([nextAddress, seed, currentPrivacy, removing], previous) => {
    if (removing && !previous?.[3]) removalCountAtStart = home.contentRemovals.value;
    const removed = !removing && previous?.[3] && home.contentRemovals.value > removalCountAtStart;
    if (
      nextAddress !== address ||
      (seed !== previousSeed && !(seed === null && routing.loading.value)) ||
      (removed && seed)
    ) {
      address = nextAddress;
      previousSeed = seed;
      confirmedPrivacy = null;
      accessLost.value = null;
      seedGeneration.value++;
    }
    if (removing) {
      accessLost.value = "global";
      return;
    }
    const current = home.session.value;
    if (
      current &&
      seed?.pageAccess &&
      (current.actor !== seed.pageAccess.actor ||
        (seed.pageAccess.organization !== undefined && current.organization !== seed.pageAccess.organization))
    ) {
      accessLost.value = "global";
    } else if (confirmedPrivacy !== null && currentPrivacy !== confirmedPrivacy) {
      accessLost.value = "global";
    } else if (currentPrivacy !== null && !accessLost.value) {
      confirmedPrivacy = currentPrivacy;
    }
  },
  { immediate: true, flush: "sync" },
);
const reloadingDashboard = ref(false);
async function reloadDashboard() {
  if (reloadingDashboard.value) return;
  reloadingDashboard.value = true;
  try {
    const currentAddress = pageAddress(route);
    await home.load();
    if (pageAddress(route) === currentAddress) await routing?.refresh?.(currentAddress);
  } finally {
    reloadingDashboard.value = false;
  }
}
watch(
  home.contentRemovals,
  async () => {
    const currentAddress = pageAddress(route);
    const expectedPrivacy = privacy();
    // A successful content deletion changes access. Replace the entire page's
    // source proof rather than lending its old seed to the new session.
    if (!routing.refresh || !(await routing.refresh(currentAddress))) return;
    if (pageAddress(route) !== currentAddress || privacy() !== expectedPrivacy) accessLost.value = "global";
  },
  { flush: "sync" },
);
watch(accessLost, async (lost) => {
  if (!lost) return;
  await nextTick();
  unavailableExplanation.value?.focus();
});
function loseTarget(reference: { kind: "unit" | "thread"; key: string }) {
  const seed = pageSeed.value;
  if (!seed) return;
  const matches =
    reference.kind === "unit" && seed.page === "unit"
      ? seed.view.unit === reference.key
      : reference.kind === "thread" && seed.page === "home"
        ? (!seed.conversation.includes(":") && seed.lane.startsWith("web:") && !seed.elsewhere
            ? `${seed.lane}:${seed.conversation}`
            : seed.conversation) === reference.key
        : false;
  if (!matches) return;
  home.context.value = home.context.value.filter((item) => item.kind !== reference.kind || item.key !== reference.key);
  accessLost.value = "target";
}
const visibleSeed = computed(() => {
  const seed = pageSeed.value;
  if (!accessLost.value) return seed;
  if (!seed) return null;
  if (accessLost.value === "global")
    return {
      page: "runNotFound" as const,
      title: "Dashboard access changed",
      retentionDays: null,
      capabilities: seed.capabilities,
      preview: seed.preview,
    };
  // Keep the authenticated read mode; dropping a Person view must not reveal
  // the viewer's broad private conversation. Entity content is discarded.
  return {
    page: "runNotFound" as const,
    title: "Dashboard access changed",
    retentionDays: null,
    capabilities: seed.capabilities,
    viewingAs: seed.viewingAs,
    dataView: seed.dataView,
    asUser: seed.asUser,
    viewAs: seed.viewAs,
    pageAccess: seed.pageAccess,
    preview: seed.preview,
  };
});
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
    <SeedScope :key="`${pageAddress(route)}:${seedGeneration}:${accessLost ?? 'confirmed'}`" :seed="visibleSeed"
      ><Shell
        ><div class="green-content-layout" :class="{ 'has-dock': hasDock && accessLost !== 'global' }">
          <div class="green-page-content">
            <div v-if="accessLost" ref="unavailableExplanation" tabindex="-1" role="alert">
              <EmptyState
                title="Dashboard access changed"
                :description="
                  home.removing.value
                    ? 'Refreshing current access after message deletion.'
                    : 'This page is unavailable with the current access.'
                "
              />
              <button
                type="button"
                class="green-button mt-3"
                :disabled="reloadingDashboard || !!home.removing.value"
                @click="reloadDashboard"
              >
                Reload dashboard
              </button>
            </div>
            <RouterView v-else v-slot="{ Component }">
              <component
                :is="Component"
                v-on="pageSeed?.page === 'unit' || pageSeed?.page === 'home' ? { accessLost: loseTarget } : {}"
              />
            </RouterView>
          </div>
          <ConversationDock
            v-if="hasDock && accessLost !== 'global'"
            :page-unavailable="!!accessLost"
          /></div></Shell></SeedScope
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
