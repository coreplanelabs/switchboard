<script setup lang="ts">
import { computed } from "vue";
import { residentLive, type ResidentRecordView } from "@core/channels/residentsModel.js";

const props = defineProps<{ record: ResidentRecordView }>();
const live = computed(() => residentLive(props.record));
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const spent = computed(() => count(live.value.poolUsersSpent));
const total = computed(() => {
  const value = count(live.value.poolUsersTotal);
  return value !== null && value > 0 ? value : null;
});
const tone = computed(() => {
  if (spent.value === null || total.value === null) return "text-muted";
  if (spent.value >= total.value) return "text-error";
  return spent.value / total.value >= 0.75 ? "text-warn" : "text-muted";
});
const tip =
  "UIDs are Linux user IDs that isolate workspaces. Each ID stays with its first owner until the VM is safely replaced. Spent IDs include ended runs, so this is not the active run count. A full pool needs all workspaces safely released before it can reset.";
</script>

<template>
  <UTooltip :text="tip">
    <span
      tabindex="0"
      class="uid-count shrink-0 rounded border border-current/25 px-1.5 font-mono text-xs tabular-nums"
      :class="tone"
      :aria-label="`UIDs ${spent ?? 'unknown'}/${total ?? 'unknown'} spent. ${tip}`"
      >UIDs {{ spent ?? "—" }}/{{ total ?? "?" }} spent</span
    >
  </UTooltip>
</template>
