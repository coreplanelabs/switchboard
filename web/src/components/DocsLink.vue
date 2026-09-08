<script lang="ts">
// The docs link in every page's header (/runs, /residents, /costs).
//
// It points at `/docs` on this origin, not at the docs hostname: the app knows
// one stable path and the server owns where it resolves to (src/core/docsLink.ts
// → the project's published site, the same on every installation). Opens in a
// new tab — the dashboards are something you watch, and looking a command up
// should not take the live page away.
export const DOCS_HREF = "/docs";
export const DOCS_LABEL = "Docs";
export const DOCS_ICON = "i-lucide-book-open";
</script>

<script setup lang="ts">
defineProps<{ size?: "xs" | "md" }>();
</script>

<template>
  <UButton
    class="docs-link"
    :href="DOCS_HREF"
    target="_blank"
    rel="noopener"
    color="neutral"
    variant="ghost"
    :size="size ?? 'xs'"
    :icon="DOCS_ICON"
    :aria-label="DOCS_LABEL"
    title="Docs (opens in a new tab)"
  />
</template>
