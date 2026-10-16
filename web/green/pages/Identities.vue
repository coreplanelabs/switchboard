<script setup lang="ts">
defineOptions({ name: "GreenIdentitiesPage" });
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
</script>
<template>
  <PageHeading
    title="Identities"
    description="Explicit account links can join your future private activity across surfaces."
  />
  <nav class="green-tabs" aria-label="Settings sections">
    <RouterLink to="/settings/channels">Channels</RouterLink><RouterLink to="/settings/mcps">MCP servers</RouterLink
    ><RouterLink to="/settings/identities" aria-current="page">Identities</RouterLink
    ><RouterLink to="/settings/runtime">Runtime</RouterLink
    ><RouterLink to="/settings/installation">Installation</RouterLink>
  </nav>
  <section class="green-section">
    <EmptyState
      title="Identity linking is unavailable"
      description="This server has not enabled a trusted account verification flow. Matching names, email addresses, or organization membership do not link identities."
      icon="i-lucide-shield-check"
    />
  </section>
</template>
