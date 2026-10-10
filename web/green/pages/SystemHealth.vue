<script setup lang="ts">
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
</script>
<template>
  <PageHeading title="Metrics" description="Track usage and inspect system health." />
  <nav class="green-tabs" aria-label="Metrics sections">
    <RouterLink to="/metrics">Usage</RouterLink
    ><RouterLink to="/metrics/health" aria-current="page">System health</RouterLink>
  </nav>
  <section class="green-section">
    <EmptyState
      title="System health is unavailable"
      description="This server has not supplied a system health report. No health status is inferred from run activity."
      icon="i-lucide-heart-pulse"
    />
  </section>
</template>
