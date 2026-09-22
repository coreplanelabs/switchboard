<script setup lang="ts">
import { computed } from "vue";
import AppShell from "../components/AppShell.vue";
import ChannelsPanel from "../components/settings/ChannelsPanel.vue";
import InstallationPanel from "../components/settings/InstallationPanel.vue";
import McpServersPanel from "../components/settings/McpServersPanel.vue";
import SettingsTabs from "../components/settings/SettingsTabs.vue";
import { useSeed } from "../lib/seed";
import { browser } from "../lib/browser";

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
      :as-user="seed.asUser"
    />
    <ChannelsPanel
      v-else-if="tab === 'channels' && seed.channels"
      :channels="seed.channels"
      :vocabulary="seed.vocabulary"
    />
    <InstallationPanel v-else-if="tab === 'installation' && seed.installation" :installation="seed.installation" />
  </AppShell>
  <AppShell v-else title="Settings" nav="settings">
    <!-- Every installation has settings, so a page without its seed is a fault, not a state (record 0041). -->
    <div class="error mx-auto my-8 max-w-lg rounded-lg border border-err/30 bg-err/10 px-5 py-4 text-sm" role="alert">
      <p class="font-medium text-highlighted">Settings could not be loaded.</p>
      <p class="mt-1 text-muted">
        This is a bug: the page arrived without its data and no automatic reload was scheduled. The bot's log has the
        reason.
      </p>
      <UButton class="mt-3" size="xs" color="neutral" variant="outline" @click="browser.reload()">Reload</UButton>
    </div>
  </AppShell>
</template>
