<script setup lang="ts">
import EmptyState from "../components/EmptyState.vue";
</script>
<template>
  <EmptyState
    title="This page is unavailable"
    description="The address is unknown or cannot be viewed with your current access."
    icon="i-lucide-file-question"
    ><RouterLink to="/home" class="green-button">Home</RouterLink></EmptyState
  >
</template>
