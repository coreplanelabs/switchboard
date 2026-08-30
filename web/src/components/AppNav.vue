<script setup lang="ts">
// Site navigation shared by every page (/runs, /residents, /costs). One list,
// one place to add the next section. Full page loads (plain anchors): the
// server renders a fresh shell + seed per section.

export type NavSection = "runs" | "residents" | "costs";

const SECTIONS: ReadonlyArray<{ id: NavSection; label: string; href: string }> = [
  { id: "runs", label: "Runs", href: "/runs" },
  { id: "residents", label: "Residents", href: "/residents" },
  { id: "costs", label: "Costs", href: "/costs" },
];

defineProps<{ current: NavSection }>();
</script>

<template>
  <nav class="site flex items-center gap-3.5 text-[0.8rem]" aria-label="Sections">
    <a
      v-for="s in SECTIONS"
      :key="s.id"
      :href="s.href"
      :aria-current="s.id === current ? 'page' : undefined"
      class="text-muted no-underline underline-offset-4 hover:text-highlighted hover:underline aria-[current=page]:font-semibold aria-[current=page]:text-highlighted aria-[current=page]:underline"
    >
      {{ s.label }}
    </a>
  </nav>
</template>
