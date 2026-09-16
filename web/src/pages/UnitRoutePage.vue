<script setup lang="ts">
import { inject } from "vue";
import UnitPage from "./UnitPage.vue";
import NotFoundPage from "./NotFoundPage.vue";
import { SeedKey } from "../lib/seed";

// /runs/unit/:key serves two pages from one path: the unit, or the run 404
// (the same one the run page gives — a unit the viewer may not see and one
// that does not exist read alike) — the SEED says which.

const seed = inject(SeedKey, null);
</script>

<template>
  <NotFoundPage v-if="!seed || seed.page !== 'unit'" />
  <UnitPage v-else />
</template>
