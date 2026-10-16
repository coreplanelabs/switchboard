<script setup lang="ts">
defineOptions({ name: "GreenHomePage" });
import { computed, inject } from "vue";
import type { HomeUnit } from "@core/core/home/service.js";
import type { HomeFleetSeed } from "@core/channels/homeSeed.js";
import { SeedKey } from "../../src/lib/seed";
import PageHeading from "../components/PageHeading.vue";
import { useHomeSession } from "../lib/homeSession";
import { useViewingAs } from "../../src/lib/seed";
import InlineAnswer from "../components/InlineAnswer.vue";
import EmptyState from "../components/EmptyState.vue";
import UnitList from "../components/UnitList.vue";
import { githubRepoUrl, githubPrUrl, githubTreeUrl } from "../../src/lib/githubLinks";
const globalSeed = inject(SeedKey, null);
const seed = globalSeed as unknown as HomeFleetSeed | null;
const historyHref = (() => {
  try {
    return `/home/history?tz=${encodeURIComponent(new Intl.DateTimeFormat().resolvedOptions().timeZone)}`;
  } catch {
    return "/home/history";
  }
})();
const home = useHomeSession();
const viewingAs = useViewingAs();
const savedReplyOutsideList = computed(
  () =>
    home?.inlineAnswer.value &&
    (home.pendingSubmission.value || !!home.notice.value) &&
    !viewingAs &&
    (!globalSeed?.dataView || globalSeed.dataView.mode !== "person") &&
    ![...(seed?.snapshot?.needsYou ?? []), ...(seed?.snapshot?.moving ?? []), ...(seed?.snapshot?.waiting ?? [])].some(
      (row) => row.unit.unit === home.inlineAnswer.value?.unit,
    ),
);
const snapshot = computed(() => seed?.snapshot ?? null);
const count = computed(() =>
  snapshot.value ? snapshot.value.needsYou.length + snapshot.value.moving.length + snapshot.value.waiting.length : 0,
);
const pipelines = computed(() => {
  const rows = new Map<string, HomeUnit[]>();
  for (const row of [
    ...(snapshot.value?.needsYou ?? []),
    ...(snapshot.value?.moving ?? []),
    ...(snapshot.value?.waiting ?? []),
  ]) {
    const group = rows.get(row.instance.id) ?? [];
    group.push(row);
    rows.set(row.instance.id, group);
  }
  return (snapshot.value?.pipelines ?? []).map((pipeline) => ({
    ...pipeline,
    rows: rows.get(pipeline.instance.id) ?? [],
  }));
});
const replyThread = (row: HomeUnit) => seed?.answers?.[row.unit.unit]?.thread ?? row.unit.threads.coding;
</script>
<template>
  <PageHeading title="Home" description="What needs you, what is moving, and what happens next."
    ><RouterLink class="green-button" :to="historyHref"><UIcon name="i-lucide-history" />Completed work</RouterLink
    ><RouterLink class="green-button" to="/home/threads"
      ><UIcon name="i-lucide-search" />Find a thread</RouterLink
    ></PageHeading
  >
  <template v-if="snapshot">
    <p v-if="snapshot.status === 'partial'" class="green-notice green-warning" role="status">
      Some work could not be loaded. These rows do not prove that all work is accounted for.
    </p>
    <p v-else-if="snapshot.status === 'unavailable'" class="green-notice green-warning" role="alert">
      Work is unavailable. Attention and progress cannot be confirmed.
    </p>
    <p v-if="snapshot.access === 'filtered'" class="text-xs text-muted mb-4">
      This view includes only work you can access.
    </p>
    <template v-if="count"
      ><UnitList
        :rows="snapshot.needsYou"
        :answers="seed?.answers"
        :actions="seed?.actions"
        label="Needs you"
        urgent
        :attention-recipient="seed?.attentionRecipient"
        :attention-recipients="seed?.attentionRecipients" /><UnitList
        :rows="snapshot.moving"
        label="Moving"
        :attention-recipient="seed?.attentionRecipient"
        :attention-recipients="seed?.attentionRecipients"
        activity="moving" /><UnitList
        :rows="snapshot.waiting"
        label="Other waits"
        :attention-recipient="seed?.attentionRecipient"
        :attention-recipients="seed?.attentionRecipients"
    /></template>
    <section v-else-if="snapshot.status === 'complete'" class="green-section">
      <EmptyState
        :title="snapshot.access === 'filtered' ? 'No unresolved work in your view' : 'All caught up'"
        :description="
          snapshot.access === 'filtered'
            ? 'No unresolved units are visible with your current access.'
            : 'There are no unresolved units in the complete work projection.'
        "
        icon="i-lucide-circle-check"
      />
    </section>
    <section v-if="savedReplyOutsideList && home?.inlineAnswer.value" class="green-section" aria-label="Saved reply">
      <div class="green-section-heading">
        <h2>Saved reply · {{ home.inlineAnswer.value.title }}</h2>
        <RouterLink class="green-button" :to="`/threads/${encodeURIComponent(home.inlineAnswer.value.thread)}`"
          >Original thread</RouterLink
        >
      </div>
      <div class="p-4">
        <InlineAnswer v-if="home.pendingSubmission.value" />
        <template v-else
          ><p role="status" class="text-sm">{{ home.notice.value }}</p>
          <button type="button" class="green-button mt-3" @click="home.preserveInlineAnswer()">
            Return to messages
          </button></template
        >
      </div>
    </section>
    <section v-if="snapshot.pipelines.length" class="green-section">
      <div class="green-section-heading">
        <div>
          <h2>Pipelines</h2>
          <p>Open a pipeline to see its work, next actions, threads, pull requests, and changes.</p>
        </div>
      </div>
      <div class="green-pipeline-cards">
        <article v-for="pipeline in pipelines" :key="pipeline.instance.id" class="green-pipeline-card">
          <RouterLink class="green-unit-title" :to="`/pipelines/${encodeURIComponent(pipeline.instance.id)}`">{{
            pipeline.instance.label ?? pipeline.instance.plan?.id ?? pipeline.instance.id
          }}</RouterLink>
          <p class="text-xs text-muted mt-1">
            <a
              v-if="githubRepoUrl(pipeline.instance.repo)"
              :href="githubRepoUrl(pipeline.instance.repo)!"
              target="_blank"
              rel="noopener noreferrer"
              ><UIcon name="i-lucide-folder-git-2" class="mr-1" />{{ pipeline.instance.repo }}</a
            ><span v-else>{{ pipeline.instance.repo }}</span>
          </p>
          <p class="text-xs mt-3">
            {{ pipeline.needsYou }} needs you · {{ pipeline.moving }} moving · {{ pipeline.waiting }} waiting
          </p>
          <ul class="green-pipeline-work" aria-label="Pipeline work links">
            <li v-for="row in pipeline.rows.slice(0, 3)" :key="row.unit.unit">
              <RouterLink class="green-unit-title" :to="`/runs/unit/${encodeURIComponent(row.unit.unit)}`">{{
                row.unit.title ?? `Unit ${row.unit.id}`
              }}</RouterLink>
              <p v-if="row.nextAction.kind === 'recorded'" class="text-xs text-muted mt-1">{{ row.nextAction.text }}</p>
              <div class="green-pipeline-work-links">
                <RouterLink
                  v-if="replyThread(row)"
                  :to="`/threads/${encodeURIComponent(replyThread(row)!)}`"
                  aria-label="Original unit thread"
                  title="Original unit thread"
                >
                  <UIcon name="i-lucide-messages-square" /><span>Thread</span>
                </RouterLink>
                <RouterLink
                  v-if="row.unit.threads.review"
                  :to="`/threads/${encodeURIComponent(row.unit.threads.review)}`"
                  aria-label="Review thread"
                  title="Review thread"
                  ><UIcon name="i-lucide-message-square-check" /><span class="sr-only">Review thread</span></RouterLink
                >
                <a
                  v-if="githubTreeUrl(row.instance.repo, row.unit.branch)"
                  :href="githubTreeUrl(row.instance.repo, row.unit.branch)!"
                  target="_blank"
                  rel="noopener noreferrer"
                  ><UIcon name="i-lucide-git-branch" />{{ row.unit.branch }}</a
                >
                <a
                  v-if="row.unit.pr && githubPrUrl(row.instance.repo, row.unit.pr.number)"
                  :href="githubPrUrl(row.instance.repo, row.unit.pr.number)!"
                  target="_blank"
                  rel="noopener noreferrer"
                  ><UIcon name="i-lucide-git-pull-request" />#{{ row.unit.pr.number }}</a
                >
                <RouterLink
                  v-if="row.unit.pr"
                  :to="`/runs/unit/${encodeURIComponent(row.unit.unit)}#changes`"
                  aria-label="Changes"
                  title="Changes"
                  ><UIcon name="i-lucide-git-compare" /><span>Changes</span></RouterLink
                >
              </div>
            </li>
          </ul>
          <RouterLink
            v-if="pipeline.rows.length > 3"
            class="text-xs text-primary"
            :to="`/pipelines/${encodeURIComponent(pipeline.instance.id)}`"
            >View {{ pipeline.rows.length - 3 }} more</RouterLink
          >
        </article>
      </div>
    </section>
  </template>
  <EmptyState
    v-else
    title="Work could not be loaded"
    description="The page has no work projection. Attention and progress cannot be confirmed."
  />
</template>

<style scoped>
.green-pipeline-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  gap: 16px;
  padding: 16px;
}
.green-pipeline-card {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
}
.green-pipeline-work {
  margin-top: 12px;
}
.green-pipeline-work li {
  padding: 10px 0;
  border-top: 1px solid var(--ui-border-muted);
}
.green-pipeline-work p {
  overflow-wrap: anywhere;
}
.green-pipeline-work-links {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: var(--ui-primary);
  font-size: 11px;
}
.green-pipeline-work-links a {
  min-height: 40px;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  overflow-wrap: anywhere;
}
</style>
