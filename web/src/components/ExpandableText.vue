<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

// ExpandableText — long prose folded to its first few lines.
//
//   <ExpandableText :lines="5"><MarkdownText :text="request" /></ExpandableText>
//
// Collapsed, the slot is clipped to `lines` lines under a gradient that fades
// into the surface it sits on (the CSS variable `--expandable-surface`; set it
// on a parent to match another ground — the default is the muted card ground,
// in both themes) with a "Show more" affordance; the whole block is the hit
// target, except links inside the prose, which keep working. Expanded, the
// whole text shows with "Show less". The fold appears only when the content
// actually overflows — measured after mount and again on resize — so a short
// text is just text. The button carries `aria-expanded` and `aria-controls`;
// `data-expanded` / `data-overflowing` say the state to tests and styles.
// Generic on purpose: the request uses it today, the PR description next.

const props = withDefaults(defineProps<{ lines?: number }>(), { lines: 5 });

const expanded = ref(false);
const overflowing = ref(false);
const body = ref<HTMLElement | null>(null);
const id = `expandable-${Math.random().toString(36).slice(2, 8)}`;

/** Does the clipped body hide anything? Meaningful only while collapsed — an
 *  expanded body never overflows, and the affordance must not vanish then. */
function measure(): void {
  const el = body.value;
  if (!el || expanded.value) return;
  overflowing.value = el.scrollHeight > el.clientHeight + 1;
}

let observer: ResizeObserver | null = null;
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== "undefined" && body.value) {
    observer = new ResizeObserver(() => measure());
    observer.observe(body.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());
watch(expanded, (open) => {
  if (!open) void Promise.resolve().then(measure);
});

function toggle(): void {
  expanded.value = !expanded.value;
}

/** A click anywhere on the collapsed block expands it — unless it landed on a
 *  link in the prose, which is the reader's to follow. */
function onBlockClick(e: MouseEvent): void {
  if (expanded.value || !overflowing.value) return;
  if ((e.target as Element | null)?.closest?.("a")) return;
  expanded.value = true;
}
</script>

<template>
  <div
    class="expandable group relative"
    :class="!expanded && overflowing ? 'cursor-pointer' : ''"
    :data-expanded="expanded ? '1' : '0'"
    :data-overflowing="overflowing ? '1' : '0'"
    @click="onBlockClick"
  >
    <div
      :id="id"
      ref="body"
      class="body"
      :class="expanded ? '' : 'clamped'"
      :style="expanded ? undefined : { '--expandable-lines': String(props.lines) }"
    >
      <slot />
    </div>
    <!-- The fade sits over the last clipped lines; the surface colour is the
         parent's to set. -->
    <div v-if="!expanded && overflowing" class="fade pointer-events-none absolute inset-x-0 bottom-6 h-10" />
    <div v-if="overflowing || expanded" class="mt-1 flex justify-start">
      <button
        type="button"
        class="more cursor-pointer text-xs text-dimmed group-hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
        :aria-expanded="expanded ? 'true' : 'false'"
        :aria-controls="id"
        @click.stop="toggle"
      >
        {{ expanded ? "Show less" : "Show more" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.clamped {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--expandable-lines, 5);
  line-clamp: var(--expandable-lines, 5);
  overflow: hidden;
}
.fade {
  background: linear-gradient(to bottom, transparent, var(--expandable-surface, var(--ui-bg-muted)));
}
</style>
