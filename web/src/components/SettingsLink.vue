<script lang="ts">
// The settings cog in every page's header, beside the docs link and the theme
// toggle: settings are chrome, not a section of the dashboard, so the way
// there is the conventional icon rather than a fifth word in the site nav.
// Every installation has channel scopes, so the cog needs no capability. A
// full page load, like the nav: the server seeds the settings page.
export const SETTINGS_HREF = "/settings";
export const SETTINGS_LABEL = "Settings";
export const SETTINGS_ICON = "i-lucide-settings";
</script>

<script setup lang="ts">
defineProps<{ size?: "xs" | "md"; current?: boolean }>();
</script>

<template>
  <UButton
    class="settings-link"
    :href="SETTINGS_HREF"
    color="neutral"
    variant="ghost"
    :size="size ?? 'xs'"
    :icon="SETTINGS_ICON"
    :aria-label="SETTINGS_LABEL"
    :aria-current="current ? 'page' : undefined"
    :title="SETTINGS_LABEL"
  />
</template>
