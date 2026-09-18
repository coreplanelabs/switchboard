<script setup lang="ts">
// The page's seed, provided to the page mounted inside (App.vue keys this scope
// by the route's address, so a new address is a fresh scope with its own seed
// and a freshly mounted page — the same mount a full load gives). The document
// title and the favicon are the seed's here, on every mount: what the shell's
// head said on a full load, set again on an in-app one. A page with a live
// count (the runs index, a run, the threads page) repaints both itself.
import { provide } from "vue";
import type { WebSeed } from "@core/channels/webSeed.js";
import { pageFavicon } from "@core/channels/pageFavicon.js";
import { SeedKey } from "../lib/seed";
import { browser } from "../lib/browser";

const props = defineProps<{ seed: WebSeed | null }>();
provide(SeedKey, props.seed);
if (props.seed) {
  browser.setTitle(props.seed.title);
  browser.setFavicon(pageFavicon(props.seed));
}
</script>

<template>
  <slot />
</template>
