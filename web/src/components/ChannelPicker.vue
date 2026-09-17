<script setup lang="ts">
import { computed } from "vue";
import type { PickableChannel } from "@core/core/commands/config.js";

// The one way a person picks a channel on the dashboard (settings-page.md item
// 7): a combobox over the channels they may read — type a few letters of the
// name (or the id), the list narrows, Enter or a click picks. The picked value
// is the channel's id; the name is what the row shows, the id sits under it.
// A channel the list does not carry (an open one from the URL) is offered too,
// so the field never shows a blank for a channel the page is already on.

const props = defineProps<{
  channels: readonly PickableChannel[];
  modelValue: string;
  /** A channel to offer even when the list lacks it (the page's open channel). */
  extra?: string;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

interface Item {
  label: string;
  value: string;
  suffix?: string;
}

const items = computed((): Item[] => {
  const listed = props.channels.map((c) => ({
    label: c.channelName ? `#${c.channelName}` : c.channelId,
    value: c.channelId,
    suffix: c.visibility === "private" ? "private" : c.channelName ? c.channelId : undefined,
  }));
  if (props.extra && !listed.some((i) => i.value === props.extra))
    listed.push({ label: props.extra, value: props.extra, suffix: "not in the list" });
  return listed;
});

function pick(value: unknown): void {
  emit("update:modelValue", typeof value === "string" ? value : "");
}
</script>

<template>
  <UInputMenu
    :id="id"
    :model-value="modelValue"
    :items="items"
    value-key="value"
    :filter-fields="['label', 'value']"
    :placeholder="placeholder ?? 'Search channels…'"
    :disabled="disabled"
    :aria-label="ariaLabel"
    size="sm"
    class="channel-picker font-mono text-xs"
    @update:model-value="pick"
  >
    <template #item-trailing="{ item }">
      <span v-if="item.suffix" class="ml-2 text-[0.6875rem] text-dimmed">{{ item.suffix }}</span>
    </template>
  </UInputMenu>
</template>
