<script setup lang="ts">
defineOptions({ name: "GreenSettingsPage" });
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useSeed } from "../../src/lib/seed";
import { browser } from "../../src/lib/browser";
import ChannelsPanel from "../../src/components/settings/ChannelsPanel.vue";
import InstallationPanel from "../../src/components/settings/InstallationPanel.vue";
import McpServersPanel from "../../src/components/settings/McpServersPanel.vue";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
const seed = useSeed("settings");
const route = useRoute();
const tab = computed(() => seed?.tab ?? String(route.params.tab ?? "channels"));
const tabs = computed(() => [
  { id: "channels", label: "Channels" },
  ...(seed?.capabilities.mcp || tab.value === "mcps" ? [{ id: "mcps", label: "MCP servers" }] : []),
  { id: "identities", label: "Identities" },
  ...(seed?.capabilities.residents ? [{ id: "runtime", label: "Runtime" }] : []),
  { id: "installation", label: "Installation" },
]);
</script>
<template>
  <PageHeading title="Settings" description="Manage shared configuration, connected identities, and the runtime."
    ><a class="green-button" href="/settings/connect"><UIcon name="i-lucide-plug" />Connect a client</a></PageHeading
  >
  <nav class="green-tabs" aria-label="Settings sections">
    <RouterLink
      v-for="item in tabs"
      :key="item.id"
      :to="`/settings/${item.id}`"
      :aria-current="tab === item.id ? 'page' : undefined"
      >{{ item.label }}</RouterLink
    >
  </nav>
  <section v-if="seed" class="min-w-0">
    <McpServersPanel
      v-if="tab === 'mcps' && seed.mcps"
      :mcps="seed.mcps"
      :vocabulary="seed.vocabulary"
      :viewer="seed.viewer"
      :as-user="seed.asUser"
    /><ChannelsPanel
      v-else-if="tab === 'channels' && seed.channels"
      :channels="seed.channels"
      :vocabulary="seed.vocabulary"
    /><InstallationPanel
      v-else-if="tab === 'installation' && seed.installation"
      :installation="seed.installation"
    /><slot v-else />
  </section>
  <EmptyState
    v-else
    title="Settings could not be loaded"
    description="Configuration is unavailable for this address."
    icon="i-lucide-circle-alert"
  >
    <button type="button" class="green-button" aria-label="Reload settings" @click="browser.reload()">
      <UIcon name="i-lucide-rotate-cw" />Reload
    </button>
  </EmptyState>
</template>
