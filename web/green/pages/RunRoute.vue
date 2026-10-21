<script setup lang="ts">
import { useRoute } from "vue-router";
import PullRequest from "./PullRequest.vue";
import { useSeed } from "../../src/lib/seed";
import RunDetails from "./Run.vue";
import RunAdmission from "./RunAdmission.vue";
import NotFound from "./NotFound.vue";
const seed = useSeed("run");
const admission = useSeed("runAdmission");
const route = useRoute();
</script>
<template>
  <PullRequest v-if="seed && route.query.view === 'pull-request'" /><RunDetails v-else-if="seed" /><RunAdmission
    v-else-if="admission"
  /><NotFound v-else />
</template>
