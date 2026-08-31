<script setup lang="ts">
import { inject } from "vue";
import RunPage from "./RunPage.vue";
import NotFoundPage from "./NotFoundPage.vue";
import { SeedKey } from "../lib/seed";

// /runs/:id serves two pages from one path: the run (live or history) or the
// non-revealing 404 — the SEED says which (the router only knows the path,
// and an unknown/expired/wrong-token run must render the 404, never an empty
// live scaffold).

const seed = inject(SeedKey, null);
</script>

<template>
  <NotFoundPage v-if="!seed || seed.page === 'runNotFound'" />
  <RunPage v-else />
</template>
