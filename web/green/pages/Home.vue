<script setup lang="ts">
defineOptions({ name: "GreenHomePage" });
import { computed, inject } from "vue";
import type { HomeFleetSeed } from "@core/channels/homeSeed.js";
import { SeedKey } from "../../src/lib/seed";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
import UnitList from "../components/UnitList.vue";
const seed = inject(SeedKey, null) as unknown as HomeFleetSeed | null;
const snapshot = computed(() => seed?.snapshot ?? null);
const count = computed(() =>
  snapshot.value ? snapshot.value.needsYou.length + snapshot.value.moving.length + snapshot.value.waiting.length : 0,
);
</script>
<template>
  <PageHeading title="Home" description="What needs you, what is moving, and what happens next."
    ><RouterLink class="green-button" to="/home/history"><UIcon name="i-lucide-history" />Completed work</RouterLink
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
        label="Needs you"
        urgent
        :attention-recipient="seed?.attentionRecipient" /><UnitList
        :rows="snapshot.moving"
        label="Moving"
        :attention-recipient="seed?.attentionRecipient"
        activity="moving" /><UnitList
        :rows="snapshot.waiting"
        label="Other waits"
        :attention-recipient="seed?.attentionRecipient"
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
    <section v-if="snapshot.pipelines.length" class="green-section">
      <div class="green-section-heading">
        <div>
          <h2>Pipelines</h2>
          <p>Pipelines group durable units. Each unit retains its branch and evidence.</p>
        </div>
      </div>
      <div class="green-table-scroll">
        <table class="green-table">
          <thead>
            <tr>
              <th>Pipeline</th>
              <th>Repository</th>
              <th>Needs you</th>
              <th>Moving</th>
              <th>Waiting</th>
              <th>Unresolved</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pipeline in snapshot.pipelines" :key="pipeline.instance.id">
              <td>
                <RouterLink :to="`/pipelines/${encodeURIComponent(pipeline.instance.id)}`">{{
                  pipeline.instance.label ?? pipeline.instance.plan?.id ?? pipeline.instance.id
                }}</RouterLink>
              </td>
              <td>{{ pipeline.instance.repo }}</td>
              <td>{{ pipeline.needsYou }}</td>
              <td>{{ pipeline.moving }}</td>
              <td>{{ pipeline.waiting }}</td>
              <td>{{ pipeline.unresolved }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
  <EmptyState
    v-else
    title="Work could not be loaded"
    description="The page has no work projection. Attention and progress cannot be confirmed."
  />
</template>
