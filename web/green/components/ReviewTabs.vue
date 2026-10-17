<script setup lang="ts">
import type { ReviewsReport } from "@core/core/reviewsReport.js";
import { reviewsHref } from "../lib/reviews";
defineProps<{ current: "usage" | "health" | "week"; report: ReviewsReport | null }>();
const TABS = [
  { key: "usage", path: "/metrics", label: "Usage" },
  { key: "health", path: "/metrics/health", label: "System health" },
  { key: "week", path: "/metrics/week", label: "Week over week" },
] as const;
</script>
<template>
  <nav class="green-tabs" aria-label="Metrics sections">
    <RouterLink
      v-for="tab in TABS"
      :key="tab.key"
      :to="reviewsHref(tab.path, report)"
      :aria-current="tab.key === current ? 'page' : undefined"
      >{{ tab.label }}</RouterLink
    >
  </nav>
</template>
