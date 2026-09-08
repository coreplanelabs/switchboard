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

<!-- The app's ONE prose role. The type scale has three voices — mono body
     0.8125rem (data), prose 0.875rem (what a person reads), meta text-xs
     (labels, facts, clocks) — so prose sits a step above the data around it
     instead of shouting over it (it was 0.9375rem × relaxed leading, which
     read as display text, worst on phones where the root scales up). Block
     rhythm is tightened to match: half the prose-sm defaults, nested list
     items tighter still — nested content is subordinate, its spacing says so. -->
<template>
  <div
    ref="root"
    class="md prose prose-sm dark:prose-invert min-w-0 max-w-none flex-1 whitespace-pre-wrap break-words font-sans text-[0.875rem] leading-normal [&_blockquote]:my-1.5 [&_li>ol]:my-0.5 [&_li>ul]:my-0.5 [&_li]:my-0.5 [&_li]:whitespace-pre-wrap [&_ol]:my-1.5 [&_ol]:whitespace-normal [&_p]:my-1.5 [&_pre]:my-2 [&_pre]:whitespace-pre [&_table]:whitespace-normal [&_ul]:my-1.5 [&_ul]:whitespace-normal"
  />
</template>
