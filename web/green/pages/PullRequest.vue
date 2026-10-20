<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { useRoute } from "vue-router";
import { useSeed, useViewingAs } from "../../src/lib/seed";
import { createPrReviewCollector } from "../../src/lib/prReviewCollector";
import { createReviewAbridge } from "../../src/lib/reviewAbridge";
import { createRunPageModel } from "../../src/lib/runPageModel";
import { attachRunStream } from "../../src/lib/runStream";
import { useEventSourceFactory } from "../../src/lib/eventSource";
import PrReviewPanel from "../../src/modules/pr-review/PrReviewPanel.vue";
import { usePrChecks } from "../../src/lib/prChecks";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
const seed = useSeed("run");
const route = useRoute();
const runQuery = computed(() => Object.fromEntries(Object.entries(route.query).filter(([key]) => key !== "view")));
const viewingAs = useViewingAs();
const collector = createPrReviewCollector();
const checks = usePrChecks(
  () => (seed?.capabilities.github ? seed.id : undefined),
  () => collector.state.pr,
);
const model = createRunPageModel();
const unavailable = ref(false);
const ended = ref(false);
const makeSource = useEventSourceFactory();
let stream: ReturnType<typeof attachRunStream> | null = null;
if (seed?.mode === "history") for (const event of seed.events) collector.handle(event);
const abridge =
  seed?.mode === "history" && seed.capabilities.readingDiffAbridge && !viewingAs
    ? createReviewAbridge(seed.id, (event) => collector.handle(event))
    : undefined;
const unitHref = computed(() =>
  seed?.lineage?.unit
    ? `/runs/unit/${encodeURIComponent(seed.lineage.unit.key)}`
    : seed?.mode === "history" && seed.findingsLedger
      ? `/runs/unit/${encodeURIComponent(seed.findingsLedger.unit)}`
      : null,
);
onMounted(() => {
  if (seed?.mode !== "live") return;
  stream = attachRunStream({
    url: seed.eventsUrl,
    factory: makeSource,
    model,
    handle: (event) => collector.handle(event),
    onEnd: () => {
      ended.value = true;
    },
    onDisconnected: () => {
      unavailable.value = true;
    },
  });
});
onBeforeUnmount(() => {
  stream?.close();
  abridge?.dispose();
});
</script>
<template>
  <div class="green-toolbar">
    <RouterLink v-if="seed" class="green-button" :to="{ path: `/runs/${encodeURIComponent(seed.id)}`, query: runQuery }"
      ><UIcon name="i-lucide-arrow-left" />Run details</RouterLink
    ><RouterLink v-if="unitHref" class="green-button" :to="unitHref">Unit context</RouterLink
    ><span v-if="collector.state.pr.headSha" class="text-xs text-muted break-all"
      >Recorded head {{ collector.state.pr.headSha }}</span
    >
  </div>
  <p v-if="unavailable" class="green-notice green-warning" role="status">
    The diff stream is unavailable. The last confirmed artifacts are shown.
  </p>
  <section v-if="collector.state.ready || checks" class="green-pr-pane">
    <PrReviewPanel :data="collector.state" :abridge="abridge" :checks="checks" />
  </section>
  <template v-else
    ><PageHeading title="Pull request evidence" description="Read the diff recorded by this authorized run." />
    <section class="green-section">
      <EmptyState
        :title="
          seed?.mode === 'live' && !unavailable && !ended
            ? 'Waiting for a recorded diff'
            : 'No readable diff was recorded'
        "
        description="The run has not supplied a reading-diff artifact. Run details remains available."
        icon="i-lucide-git-pull-request"
      /></section
  ></template>
</template>
<style scoped>
.green-pr-pane {
  height: calc(100dvh - 210px);
  min-height: 520px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--ui-bg);
}
@media (max-width: 1100px) {
  .green-pr-pane {
    height: calc(100dvh - 300px);
    min-height: 500px;
  }
}
</style>
