<script setup lang="ts">
import { useRoute } from "vue-router";
import PullRequest from "./PullRequest.vue";
import { useSeed } from "../../src/lib/seed";
import RunDetails from "./Run.vue";
import NotFound from "./NotFound.vue";
const seed = useSeed("run");
const route = useRoute();
</script>
<template>
  <PullRequest v-if="seed && route.query.view === 'pull-request'" /><RunDetails v-else-if="seed" /><NotFound v-else />
</template>
