<script setup lang="ts">
import { computed } from "vue";
import { useColorMode } from "@vueuse/core";
const mode = useColorMode({ emitAuto: true });
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
