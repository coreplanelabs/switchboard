<script setup lang="ts">
defineOptions({ name: "GreenPipelinePage" });
import { inject } from "vue";
import type { HomePipelineSeed } from "@core/channels/homeSeed.js";
import { SeedKey } from "../../src/lib/seed";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
import UnitList from "../components/UnitList.vue";
import { githubRepoUrl } from "../../src/lib/githubLinks";
const seed = inject(SeedKey, null) as unknown as HomePipelineSeed | null;
const pipeline = seed?.pipeline;
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
      <div class="green-section-content text-xs">
        <p v-if="pipeline.instance.plan">{{ pipeline.instance.plan.id }} · {{ pipeline.instance.plan.path }}</p>
        <p v-else class="text-muted">No plan address was recorded.</p>
        <p class="mt-3 text-muted">Open a unit for its next action, threads, pull request, and recorded changes.</p>
        <a
          v-if="pipeline.instance.sourceUrl && /^https?:\/\//.test(pipeline.instance.sourceUrl)"
          class="inline-flex text-primary min-h-10 items-center"
          :href="pipeline.instance.sourceUrl"
          target="_blank"
          rel="noopener noreferrer"
          >Asking thread ↗</a
        >
      </div>
    </section>
    <UnitList
      :rows="pipeline.units"
      label="Units"
      :attention-recipient="seed?.attentionRecipient"
      :attention-recipients="seed?.attentionRecipients" /></template
  ><EmptyState
    v-else
    title="Pipeline is unavailable"
    description="This pipeline is unknown or cannot be read under your current access."
  />
</template>
