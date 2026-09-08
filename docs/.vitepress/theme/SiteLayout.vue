<script setup lang="ts">
// The default layout, with the landing page in front of the home route's
// content. config.ts marks the root README as `layout: home`, so the default
// theme renders it as a home page: this slot is the landing, and the README's
// own text — the docs hub that GitHub shows for the directory — follows it.
import DefaultTheme from "vitepress/theme-without-fonts";
import LandingPage from "./LandingPage.vue";
</script>

<template>
  <DefaultTheme.Layout>
    <template #home-hero-before>
      <LandingPage />
    </template>
  </DefaultTheme.Layout>
</template>
