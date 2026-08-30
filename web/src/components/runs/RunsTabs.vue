<script setup lang="ts">
// The two tabs of the /runs page: Runs (live list) · Scheduled. Full page
// loads; underline = current, aria-current is both the styling hook and the
// accessible signal.

defineProps<{ current: "runs" | "scheduled" }>();

const TABS = [
  { id: "runs", href: "/runs", label: "Runs" },
  { id: "scheduled", href: "/runs/scheduled", label: "Scheduled" },
] as const;
</script>

<template>
  <nav class="tabs mb-3.5 flex gap-5 border-b border-muted px-2 text-[0.8rem]" aria-label="Runs views">
    <a
      v-for="t in TABS"
      :key="t.id"
      :href="t.href"
      :aria-current="t.id === current ? 'page' : undefined"
      class="-mb-px border-b-2 border-transparent pb-2 pt-1.5 text-muted no-underline hover:text-default aria-[current=page]:border-primary aria-[current=page]:font-semibold aria-[current=page]:text-highlighted"
    >
      {{ t.label }}
    </a>
  </nav>
</template>
