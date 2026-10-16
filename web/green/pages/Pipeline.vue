<script setup lang="ts">
defineOptions({ name: "GreenPipelinePage" });
import { computed, inject, ref } from "vue";
import type { HomePipelineSeed } from "@core/channels/homeSeed.js";
import { SeedKey } from "../../src/lib/seed";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
import UnitList from "../components/UnitList.vue";
import { githubFileUrl, githubRepoUrl } from "../../src/lib/githubLinks";
const seed = inject(SeedKey, null) as unknown as HomePipelineSeed | null;
const pipeline = seed?.page === "fleetPipeline" ? seed.pipeline : undefined;
const active = computed(() => pipeline?.units.filter((row) => row.completion !== "complete") ?? []);
const completed = computed(() => pipeline?.units.filter((row) => row.completion === "complete") ?? []);
const unknown = computed(() => active.value.filter((row) => !row.completion || row.completion === "unknown"));
const recipients = seed?.attentionRecipients ?? (seed?.attentionRecipient ? [seed.attentionRecipient] : []);
const needsYou = computed(() =>
  active.value.filter((row) =>
    row.conditions.some(
      (condition) =>
        condition.state === "open" && condition.owner.kind === "person" && recipients.includes(condition.owner.id),
    ),
  ),
);
const nextActions = computed(() => active.value.filter((row) => row.nextAction.kind === "recorded"));
const planHref = githubFileUrl(pipeline?.instance.repo, pipeline?.instance.base, pipeline?.instance.plan?.path);
const selected = ref<"active" | "completed">("active");
const tabs = computed(() => [
  { id: "active" as const, label: "Active", count: active.value.length },
  { id: "completed" as const, label: "Completed", count: completed.value.length },
]);
function onTabKeydown(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  selected.value =
    event.key === "Home"
      ? "active"
      : event.key === "End"
        ? "completed"
        : selected.value === "active"
          ? "completed"
          : "active";
  (event.currentTarget as HTMLElement).parentElement
    ?.querySelector<HTMLButtonElement>(`#pipeline-${selected.value}-tab`)
    ?.focus();
}
</script>
<template>
  <template v-if="pipeline"
    ><PageHeading :title="pipeline.instance.label ?? pipeline.instance.plan?.id ?? 'Pipeline'" eyebrow="PIPELINE"
      ><a
        v-if="githubRepoUrl(pipeline.instance.repo)"
        class="green-button"
        :href="githubRepoUrl(pipeline.instance.repo)!"
        target="_blank"
        rel="noopener noreferrer"
        ><UIcon name="i-lucide-folder-git-2" />{{ pipeline.instance.repo }}</a
      ><RouterLink class="green-button" to="/home"><UIcon name="i-lucide-arrow-left" />Home</RouterLink></PageHeading
    >
    <p v-if="seed?.status === 'partial'" class="green-notice green-warning" role="status">
      Some work details could not be loaded. This view is incomplete.
    </p>
    <p v-else-if="seed?.status !== 'complete'" class="green-notice green-warning" role="status">
      Unit coverage is unknown. The list cannot confirm all work.
    </p>
    <section class="green-section">
      <div class="green-section-heading"><h2>Plan</h2></div>
      <div class="green-section-content text-xs break-words">
        <template v-if="pipeline.instance.plan">
          <a
            v-if="planHref"
            :href="planHref"
            aria-label="Open recorded plan"
            :title="`Recorded base: ${pipeline.instance.base}`"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex min-h-10 max-w-full items-center gap-2 break-all text-primary"
          >
            <UIcon name="i-lucide-file-text" aria-hidden="true" />{{ pipeline.instance.plan.id }} ·
            {{ pipeline.instance.plan.path }}
          </a>
          <template v-else
            ><p>{{ pipeline.instance.plan.id }} · {{ pipeline.instance.plan.path }}</p>
            <p class="text-muted">Plan link unavailable.</p></template
          >
        </template>
        <p v-else class="text-muted">No plan address was recorded.</p>
        <p class="mt-3 text-muted">Open a unit for its next action, threads, pull request, and recorded changes.</p>
        <a
          v-if="pipeline.instance.sourceUrl && /^https?:\/\//.test(pipeline.instance.sourceUrl)"
          class="inline-flex text-primary min-h-10 items-center"
          :href="pipeline.instance.sourceUrl"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Asking thread"
          >Asking thread ↗</a
        >
      </div>
    </section>
    <section class="green-section" aria-label="Pipeline attention">
      <div class="green-section-heading">
        <h2>
          Needs you <span class="green-badge ml-2">{{ needsYou.length }}</span>
        </h2>
      </div>
      <div class="green-section-content text-xs">
        <p>{{ active.length }} active · {{ completed.length }} completed</p>
        <h3 class="mt-3 font-medium">Next actions</h3>
        <ul v-if="nextActions.length" class="mt-2 space-y-2">
          <li v-for="row in nextActions.slice(0, 3)" :key="row.unit.unit" class="break-words">
            <RouterLink :to="`/runs/unit/${encodeURIComponent(row.unit.unit)}`" class="text-primary">{{
              row.unit.title ?? `Unit ${row.unit.id}`
            }}</RouterLink>
            · {{ row.nextAction.kind === "recorded" ? row.nextAction.text : "Next action not recorded" }}
          </li>
        </ul>
        <p v-else class="mt-2 text-muted">Next action not recorded.</p>
        <p v-if="nextActions.length > 3" class="mt-2 text-muted">
          {{ nextActions.length - 3 }} more recorded actions in Active.
        </p>
      </div>
    </section>
    <div class="green-tabs" role="tablist" aria-label="Pipeline work">
      <button
        v-for="tab in tabs"
        :id="`pipeline-${tab.id}-tab`"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="selected === tab.id"
        :tabindex="selected === tab.id ? 0 : -1"
        :aria-controls="`pipeline-${tab.id}-panel`"
        @click="selected = tab.id"
        @keydown="onTabKeydown"
      >
        {{ tab.label }} {{ tab.count }}
      </button>
    </div>
    <section
      v-for="tab in tabs"
      :id="`pipeline-${tab.id}-panel`"
      :key="tab.id"
      role="tabpanel"
      :hidden="selected !== tab.id"
      :aria-labelledby="`pipeline-${tab.id}-tab`"
      tabindex="0"
    >
      <template v-if="selected === tab.id">
        <p v-if="selected === 'active' && unknown.length" class="green-notice green-warning" role="status">
          Completion is unknown for {{ unknown.length }} {{ unknown.length === 1 ? "unit" : "units" }}. They remain in
          Active.
        </p>
        <UnitList
          :rows="tab.id === 'active' ? active : completed"
          :label="tab.id === 'active' ? 'Active units' : 'Completed units'"
          :attention-recipient="seed?.attentionRecipient"
          :attention-recipients="seed?.attentionRecipients"
        />
      </template></section></template
  ><EmptyState
    v-else
    title="Pipeline is unavailable"
    description="This pipeline is unknown or cannot be read under your current access."
  />
</template>
