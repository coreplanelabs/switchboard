<script setup lang="ts">
import { computed } from "vue";
import AppShell from "../components/AppShell.vue";
import ChannelsPanel from "../components/settings/ChannelsPanel.vue";
import InstallationPanel from "../components/settings/InstallationPanel.vue";
import McpServersPanel from "../components/settings/McpServersPanel.vue";
import SettingsTabs from "../components/settings/SettingsTabs.vue";
import { useSeed } from "../lib/seed";

// The settings page (record 0041): three tabs over one seed each, the server
// having invoked the registry commands as the viewer. The page decides
// nothing about who may do what — `canWrite` on the seed disables controls,
// and every write is one POST to `/api/<group>.<verb>` whose refusal is shown as is.

const seed = useSeed("settings");
const tab = computed(() => seed?.tab ?? "channels");
</script>

<template>
  <AppShell v-if="seed" title="Settings" nav="settings">
    <SettingsTabs :current="tab" />
    <McpServersPanel
      v-if="tab === 'mcps' && seed.mcps"
      :mcps="seed.mcps"
      :vocabulary="seed.vocabulary"
      :viewer="seed.viewer"
    />
    <ChannelsPanel
      v-else-if="tab === 'channels' && seed.channels"
      :channels="seed.channels"
      :vocabulary="seed.vocabulary"
    />
    <InstallationPanel v-else-if="tab === 'installation' && seed.installation" :installation="seed.installation" />
  </AppShell>
  <AppShell v-else title="Settings" nav="settings">
    <p class="empty py-8 text-center text-sm text-muted">
      Settings are unavailable: the page was served without its data.
    </p>
  </AppShell>
</template>
