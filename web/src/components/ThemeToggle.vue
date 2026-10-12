<script setup lang="ts">
import { computed, inject } from "vue";
import { useColorMode } from "@vueuse/core";
import { SeedKey } from "../lib/seed";
const access = inject(SeedKey, null)?.pageAccess;
// Missing account scope must not inherit another account's appearance.
const storageKey =
  access?.actor && access.organization ? `sb-appearance:${JSON.stringify([access.actor, access.organization])}` : null;
const mode = useColorMode({ emitAuto: true, storageKey });
const theme = computed<"system" | "light" | "dark">({
  get: () => (mode.value === "auto" ? "system" : mode.value === "dark" ? "dark" : "light"),
  set: (value) => {
    mode.value = value === "system" ? "auto" : value;
  },
});
</script>
<template>
  <label class="green-theme"
    ><UIcon name="i-lucide-sun-moon" /><span class="sr-only">Appearance</span
    ><select v-model="theme" aria-label="Appearance">
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select></label
  >
</template>
