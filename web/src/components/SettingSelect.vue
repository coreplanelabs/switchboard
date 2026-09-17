<script setup lang="ts">
import { computed } from "vue";

// The one select on the dashboard: Nuxt UI's `USelect` (a styled menu, not the
// browser's), fed items as data. A form keeps `""` for "nothing chosen" — the
// setting left to the defaults, the auth left to detection — and the menu
// cannot carry an empty value, so the mapping lives here once: `""` on the
// form is `NONE` in the menu, and back.

export interface SettingSelectItem {
  label: string;
  value: string;
  disabled?: boolean;
}

const NONE = "__none__";

const props = defineProps<{
  modelValue: string;
  items: readonly SettingSelectItem[];
  id?: string;
  name?: string;
  disabled?: boolean;
  ariaLabel?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const menuItems = computed(() => props.items.map((i) => ({ ...i, value: i.value === "" ? NONE : i.value })));
const menuValue = computed(() => (props.modelValue === "" ? NONE : props.modelValue));

function update(value: unknown): void {
  const v = typeof value === "string" ? value : "";
  emit("update:modelValue", v === NONE ? "" : v);
}
</script>

<template>
  <USelect
    :id="id"
    :name="name"
    :model-value="menuValue"
    :items="menuItems"
    value-key="value"
    size="sm"
    class="setting-select font-mono text-xs"
    :disabled="disabled"
    :aria-label="ariaLabel"
    @update:model-value="update"
  />
</template>
