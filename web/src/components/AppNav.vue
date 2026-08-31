<script lang="ts">
// Site navigation shared by every page (/runs, /residents, /costs). One list,
// one place to add the next section. Full page loads (plain anchors): the
// server renders a fresh shell + seed per section.

export type NavSection = "runs" | "residents" | "costs";

export const NAV_SECTIONS: ReadonlyArray<{ id: NavSection; label: string; href: string; icon: string }> = [
  { id: "runs", label: "Runs", href: "/runs", icon: "i-lucide-list" },
  { id: "residents", label: "Residents", href: "/residents", icon: "i-lucide-server" },
  { id: "costs", label: "Costs", href: "/costs", icon: "i-lucide-circle-dollar-sign" },
];
</script>

<script setup lang="ts">
defineProps<{ current: NavSection }>();
</script>

<template>
  <nav class="site flex items-center gap-3.5 text-[0.8rem]" aria-label="Sections">
    <a
      v-for="s in NAV_SECTIONS"
      :key="s.id"
      :href="s.href"
      :aria-current="s.id === current ? 'page' : undefined"
      class="text-muted no-underline underline-offset-4 hover:text-highlighted hover:underline aria-[current=page]:font-semibold aria-[current=page]:text-highlighted aria-[current=page]:underline"
    >
      {{ s.label }}
    </a>
  </nav>
</template>
