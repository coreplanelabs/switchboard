<script setup lang="ts">
import { useSeed } from "../../src/lib/seed";
import { retentionSentence } from "@core/channels/webSeed.js";
import EmptyState from "../components/EmptyState.vue";
const missingRun = useSeed("runNotFound");
</script>
<template>
  <EmptyState
    title="This page is unavailable"
    description="The address is unknown or cannot be viewed with your current access."
    icon="i-lucide-file-question"
    ><p v-if="missingRun" class="text-xs text-muted">{{ retentionSentence(missingRun.retentionDays) }}</p>
    <RouterLink v-if="missingRun" to="/runs" class="green-button">Runs</RouterLink>
    <RouterLink v-else to="/home" class="green-button">Home</RouterLink></EmptyState
  >
</template>
