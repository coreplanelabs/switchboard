<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";
import { pullRequestNumberOf } from "@core/core/runRecord.js";
import GithubMark from "../GithubMark.vue";
import PrReviewSlideover from "../PrReviewSlideover.vue";
import { githubPrUrl } from "../../lib/githubLinks";
import { runHref, type IndexRow } from "../../lib/indexRow";
import { fetchSeed, useViewingAs } from "../../lib/seed";
import { createPrReviewCollector } from "../../lib/prReviewCollector";
import { createReviewAbridge, type ReviewAbridge } from "../../lib/reviewAbridge";
import { attachRunStream, type RunStream } from "../../lib/runStream";
import { createRunPageModel } from "../../lib/runPageModel";
import { useEventSourceFactory } from "../../lib/eventSource";

const props = defineProps<{ run: IndexRow }>();
const route = useRoute();
const viewingAs = useViewingAs();
const number = computed(() => pullRequestNumberOf(props.run));
const href = computed(() => githubPrUrl(props.run.repo, number.value));
const reference = computed(() => ({ repo: props.run.repo, number: number.value }));
const open = ref(false);
const loading = ref(false);
const message = ref("");
const checksRunId = ref<string>();
const collector = shallowRef(createPrReviewCollector());
const abridge = shallowRef<ReviewAbridge>();
const data = computed(() => ({ ...collector.value.state, pr: { ...collector.value.state.pr, ...reference.value } }));
const makeSource = useEventSourceFactory();
let generation = 0;
let stream: RunStream | undefined;
function dispose() {
  generation++;
  checksRunId.value = undefined;
  stream?.close();
  stream = undefined;
  abridge.value?.dispose();
  abridge.value = undefined;
}
function show(event: MouseEvent) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  open.value = true;
}
watch(open, async (value) => {
  dispose();
  if (!value) return;
  const mine = generation;
  collector.value = createPrReviewCollector();
  loading.value = true;
  message.value = "";
  // Preserve the page's data-view scope. The run route applies its own read decision.
  const address = new URL(runHref(props.run), window.location.origin);
  for (const [key, value] of Object.entries(route.query)) {
    if (key === "t" || value == null) continue;
    for (const part of Array.isArray(value) ? value : [value])
      if (part !== null) address.searchParams.append(key, part);
  }
  const seed = await fetchSeed(`${address.pathname}${address.search}`);
  if (mine !== generation) return;
  loading.value = false;
  if (seed?.page !== "run") {
    message.value = "Could not load the recorded diff.";
    return;
  }
  const current = collector.value;
  const matching = () =>
    current.state.pr.repo === reference.value.repo && current.state.pr.number === reference.value.number;
  const update = (event: unknown) => {
    current.handle(event);
    if (matching()) checksRunId.value = seed.id;
    message.value = current.state.ready && matching() ? "" : "No diff was recorded for this pull request in this run.";
  };
  if (seed.mode === "history") {
    for (const event of seed.events) update(event);
    if (!current.state.ready || !matching()) message.value = "No diff was recorded for this pull request in this run.";
    if (
      matching() &&
      seed.capabilities.readingDiffAbridge &&
      !viewingAs &&
      !seed.viewingAs &&
      seed.dataView?.mode !== "person"
    ) {
      abridge.value = createReviewAbridge(seed.id, update);
    }
  } else {
    loading.value = true;
    stream = attachRunStream({
      url: seed.eventsUrl,
      factory: makeSource,
      model: createRunPageModel(),
      handle: (event) => {
        update(event);
        if (matching()) loading.value = false;
      },
      onEnd: () => {
        loading.value = false;
        if (!current.state.ready || !matching())
          message.value = "No diff was recorded for this pull request in this run.";
      },
      onDisconnected: () => {
        loading.value = false;
        message.value = "Could not load the recorded diff stream.";
      },
    });
  }
});
watch(
  () => [props.run.id, props.run.repo, number.value, props.run.token, route.fullPath],
  () => {
    open.value = false;
    dispose();
  },
);
onBeforeUnmount(dispose);
</script>

<template>
  <UTooltip v-if="href" :text="`View ${run.repo}#${number} diff. Ctrl/Cmd-click or middle-click opens GitHub.`">
    <a
      class="run-pr pointer-events-auto inline-flex min-w-0 items-center gap-1.5 rounded text-xs text-dimmed hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary"
      :href="href"
      target="_blank"
      rel="noopener noreferrer"
      :aria-label="`View pull request ${run.repo}#${number} diff`"
      aria-haspopup="dialog"
      @click="show"
    >
      <GithubMark class="shrink-0" />
      <span class="truncate">{{ run.repo }} #{{ number }}</span>
    </a>
  </UTooltip>
  <PrReviewSlideover
    v-if="open"
    v-model:open="open"
    :data="data"
    :run-id="checksRunId"
    :abridge="abridge"
    :loading="loading"
    :message="message"
  />
</template>
