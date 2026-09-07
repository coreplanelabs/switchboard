<script setup lang="ts">
import { computed } from "vue";
import { html as diff2html } from "diff2html";
import type { ReadingDiff } from "./types";
import { poweredByLabel } from "./types";

// One reading diff, rendered with diff2html (line-by-line): the best-in-class
// unified-diff renderer, reused rather than reinvented. diff2html escapes the
// diff's content itself, so v-html here renders library markup over escaped
// text — never raw diff text as HTML.

const props = defineProps<{ diff: ReadingDiff }>();

/** Above this many chars a diff likely spans several files — show diff2html's
 *  file list as a table of contents; below it the list is just noise. */
const FILE_LIST_THRESHOLD = 4000;

const rendered = computed(() =>
  diff2html(props.diff.diff, {
    drawFileList: props.diff.diff.length > FILE_LIST_THRESHOLD,
    outputFormat: "line-by-line",
    matching: "lines",
  }),
);
</script>

<template>
  <div class="reading-diff min-w-0" data-testid="reading-diff">
    <div class="mb-2 flex items-center gap-2 text-xs">
      <UBadge
        :color="diff.poweredBy === 'meat' ? 'primary' : 'neutral'"
        variant="subtle"
        :label="poweredByLabel(diff.poweredBy)"
      />
      <span class="text-muted">against origin/{{ diff.baseRef }}</span>
      <UBadge v-if="diff.truncated" color="warning" variant="subtle" label="truncated" />
    </div>
    <p v-if="diff.summary" class="mb-2 text-sm text-muted" data-testid="diff-summary">{{ diff.summary }}</p>
    <!-- eslint-disable-next-line vue/no-v-html — diff2html output over its own escaping -->
    <div class="d2h-host overflow-x-auto text-xs" v-html="rendered" />
  </div>
</template>

<style>
/* diff2html's stylesheet, scoped by the host class and reduced to what the
 * line-by-line view needs; colors ride the app's tokens so both themes work. */
.d2h-host .d2h-wrapper {
  text-align: left;
}
.d2h-host .d2h-file-header {
  display: flex;
  align-items: center;
  padding: 0.35rem 0.5rem;
  font-family: var(--font-mono, monospace);
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
  border-bottom: 0;
  border-radius: 0.375rem 0.375rem 0 0;
}
.d2h-host .d2h-file-wrapper {
  margin-bottom: 1rem;
}
.d2h-host .d2h-diff-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono, monospace);
  font-size: 0.75rem;
  line-height: 1.4;
}
.d2h-host .d2h-diff-tbody {
  border: 1px solid var(--ui-border);
}
.d2h-host .d2h-code-linenumber,
.d2h-host .d2h-code-side-linenumber {
  color: var(--ui-text-dimmed);
  padding: 0 0.5rem;
  text-align: right;
  user-select: none;
  white-space: nowrap;
}
.d2h-host .d2h-code-line,
.d2h-host .d2h-code-side-line {
  padding: 0 0.5rem;
  white-space: pre;
}
.d2h-host .d2h-ins {
  background: color-mix(in srgb, var(--ui-success, #22c55e) 12%, transparent);
}
.d2h-host .d2h-del {
  background: color-mix(in srgb, var(--ui-error, #ef4444) 12%, transparent);
}
.d2h-host .d2h-ins .d2h-code-line ins {
  background: color-mix(in srgb, var(--ui-success, #22c55e) 28%, transparent);
  text-decoration: none;
}
.d2h-host .d2h-del .d2h-code-line del {
  background: color-mix(in srgb, var(--ui-error, #ef4444) 28%, transparent);
  text-decoration: none;
}
.d2h-host .d2h-info {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-dimmed);
}
.d2h-host .d2h-file-list-wrapper {
  margin-bottom: 0.75rem;
  font-size: 0.75rem;
}
.d2h-host .d2h-file-list-title {
  font-weight: 600;
}
.d2h-host .d2h-file-list > li {
  list-style: none;
}
.d2h-host .d2h-file-name {
  color: inherit;
}
.d2h-host .d2h-tag {
  display: none;
}
.d2h-host .d2h-moved-tag {
  display: none;
}
</style>
