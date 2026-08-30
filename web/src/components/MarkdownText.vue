<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { renderMarkdownInto, type MdElement } from "@core/channels/markdownLite.js";

// Every markdown surface renders through the shared safe-subset renderer
// (markdownLite: DOM built via createElement/textContent only — model text can
// never become markup) behind a guard: on any renderer throw the text shows
// verbatim, so a bug costs at most the formatting of ONE event. `v-html`
// never appears anywhere in this app.

const props = defineProps<{ text: string }>();
const root = ref<HTMLElement | null>(null);

function render(): void {
  const el = root.value;
  if (!el) return;
  try {
    renderMarkdownInto(el as unknown as MdElement, props.text);
  } catch {
    el.textContent = props.text;
  }
}

onMounted(render);
watch(() => props.text, render);
</script>

<template>
  <div
    ref="root"
    class="md prose prose-sm dark:prose-invert min-w-0 max-w-none flex-1 whitespace-pre-wrap break-words font-sans text-[15px] leading-relaxed [&_li]:whitespace-pre-wrap [&_ol]:whitespace-normal [&_pre]:whitespace-pre [&_table]:whitespace-normal [&_ul]:whitespace-normal"
  />
</template>
