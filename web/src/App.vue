<script setup lang="ts">
import { provide } from "vue";
import { readSeed, SeedKey } from "./lib/seed";

provide(SeedKey, readSeed());
</script>

<template>
  <UApp>
    <RouterView />
  </UApp>
</template>
