<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { loadDiffs } from "./diffsLibrary";

// Every file of a unified diff, rendered by @pierre/diffs: one `diffs-container`
// per file (the library's own header — change icon, path, counts — over its
// hunks, with the unmodified-lines expanders, the word-level emphasis and the
// syntax highlighting), inline or side by side. Each container carries the
// file's path as `data-file`, the anchor the file list scrolls to. A renderer
// that throws leaves the diff shown as it is, in a plain block.

const props = defineProps<{ diff: string; theme: "dark" | "light"; diffStyle?: "unified" | "split" }>();

const container = ref<HTMLElement | null>(null);
const renderFailed = ref(false);

interface DiffInstance {
  cleanUp: () => void;
}

let instances: DiffInstance[] = [];
let renderToken = 0;

function reset() {
  for (const instance of instances) {
    // A renderer that cannot clean up after itself must not stop the panel
    // from re-rendering or closing; its nodes go with the container's content.
    try {
      instance.cleanUp();
    } catch {
      /* nothing to keep */
    }
  }
  instances = [];
  if (container.value) container.value.innerHTML = "";
}

async function render() {
  const token = ++renderToken;
  renderFailed.value = false;
  try {
    const { FileDiff, parsePatchFiles } = await loadDiffs();
    if (token !== renderToken || !container.value) return;
    reset();
    // Nothing parsed is nothing rendered; the host says so in its own words.
    const files = parsePatchFiles(props.diff).flatMap((patch) => patch.files);
    for (const file of files) {
      const fileContainer = document.createElement("diffs-container");
      fileContainer.dataset.file = file.name;
      container.value.appendChild(fileContainer);
      const instance = new FileDiff({ themeType: props.theme, diffStyle: props.diffStyle ?? "unified" });
      instance.render({ fileDiff: file, fileContainer });
      instances.push(instance);
    }
  } catch {
    if (token === renderToken) renderFailed.value = true;
  }
}

onMounted(render);
watch(() => props.diff, render);
watch(() => props.theme, render);
watch(() => props.diffStyle, render);
onUnmounted(() => {
  renderToken++;
  reset();
});
</script>

<template>
  <pre
    v-if="renderFailed"
    class="overflow-x-auto rounded-lg border border-(--ui-border) p-3 font-mono text-xs whitespace-pre text-(--ui-text)"
    data-testid="diff-raw"
    >{{ diff }}</pre>
  <div v-else ref="container" class="space-y-4" data-testid="file-diffs" />
</template>
