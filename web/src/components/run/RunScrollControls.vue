<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ live: boolean }>();
const following = ref(false);
const atTop = ref(true);
const atBottom = ref(false);
let jumping = false;
let frame: number | undefined;
let observer: ResizeObserver | undefined;

function bottom(): number {
  return Math.max(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight);
}
function measure(): void {
  atTop.value = window.scrollY <= 8;
  atBottom.value = window.scrollY >= bottom() - 8;
}
function cancelFrame(): void {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
}
function pause(): void {
  cancelFrame();
  const interrupt = jumping;
  jumping = false;
  following.value = false;
  if (interrupt) window.scrollTo({ top: window.scrollY, behavior: "instant" });
}
function onScroll(): void {
  measure();
  if (jumping && !atBottom.value) return;
  jumping = false;
  following.value = props.live && atBottom.value;
}
function pin(): void {
  if (!props.live || !following.value || frame !== undefined) return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    if (!props.live || !following.value) return;
    window.scrollTo({ top: bottom(), behavior: "instant" });
    measure();
  });
}
function onResize(): void {
  measure();
  pin();
}
function behavior(): "instant" | "smooth" {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
}
function follow(): void {
  cancelFrame();
  following.value = props.live;
  jumping = true;
  window.scrollTo({ top: bottom(), behavior: behavior() });
  measure();
  if (atBottom.value) jumping = false;
}
function top(): void {
  pause();
  window.scrollTo({ top: 0, behavior: behavior() });
}
function interruptJump(): void {
  if (jumping) pause();
}
function onKey(event: KeyboardEvent): void {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) interruptJump();
}
watch(
  () => props.live,
  (live) => {
    if (!live) pause();
  },
);

const label = computed(() => (props.live ? (following.value ? "Following" : "Follow output") : "Latest output"));
const tip = computed(() =>
  props.live
    ? following.value
      ? "Following new output. Scroll up to read earlier activity."
      : "Jump to the latest output and follow new activity."
    : "Jump to the latest recorded output.",
);

onMounted(() => {
  measure();
  following.value = props.live && atBottom.value;
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("wheel", interruptJump, { passive: true });
  window.addEventListener("touchstart", interruptJump, { passive: true });
  window.addEventListener("pointerdown", interruptJump, { passive: true });
  window.addEventListener("keydown", onKey);
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(onResize);
    observer.observe(document.body);
  }
});
onBeforeUnmount(() => {
  cancelFrame();
  observer?.disconnect();
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("wheel", interruptJump);
  window.removeEventListener("touchstart", interruptJump);
  window.removeEventListener("pointerdown", interruptJump);
  window.removeEventListener("keydown", onKey);
});
defineExpose({ pause });
</script>

<template>
  <nav class="run-scroll-controls" aria-label="Output navigation">
    <Transition name="run-scroll-state">
      <UTooltip v-if="!atTop" text="Jump to the start of this run">
        <button type="button" class="scroll-top" aria-label="Jump to top" @click="top">
          <UIcon name="i-lucide-arrow-up-to-line" aria-hidden="true" />
        </button>
      </UTooltip>
    </Transition>
    <UTooltip :text="tip">
      <button
        type="button"
        class="follow-output"
        :class="{ 'is-following': following && live }"
        :data-following="following ? 'true' : 'false'"
        data-testid="follow-output"
        :aria-label="label"
        @click="follow"
      >
        <Transition name="run-scroll-state" mode="out-in">
          <UIcon
            :key="following && live ? 'following' : 'paused'"
            :name="following && live ? 'i-lucide-radio' : 'i-lucide-arrow-down-to-line'"
            aria-hidden="true"
          />
        </Transition>
        <span>{{ label }}</span>
      </button>
    </UTooltip>
    <span class="sr-only" role="status" aria-live="polite">{{
      live ? (following ? "Following new output" : "Automatic following paused") : ""
    }}</span>
  </nav>
</template>

<style scoped>
.run-scroll-controls {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.run-scroll-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 14px;
  border: 1px solid var(--ui-border-accented);
  border-radius: 999px;
  background: var(--ui-bg-elevated);
  color: var(--ui-text);
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color 160ms ease,
    border-color 160ms ease,
    color 160ms ease;
}
.run-scroll-controls button:hover {
  border-color: var(--ui-primary);
}
.run-scroll-controls button:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 3px;
}
.follow-output {
  min-width: 146px;
}
.run-scroll-controls .is-following {
  color: var(--ui-primary);
  border-color: var(--ui-primary);
}
.run-scroll-controls .iconify {
  width: 17px;
  height: 17px;
}
.scroll-top {
  width: 44px;
  padding: 0;
}
.run-scroll-state-enter-active,
.run-scroll-state-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}
.run-scroll-state-enter-from,
.run-scroll-state-leave-to {
  opacity: 0;
  transform: translateY(5px);
}
@media (max-width: 767px) {
  .run-scroll-controls button {
    min-height: 44px;
    width: 44px;
    min-width: 44px;
    padding: 0;
  }
  .follow-output span:not(.iconify) {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .run-scroll-controls button,
  .run-scroll-state-enter-active,
  .run-scroll-state-leave-active {
    transition: none;
  }
}
</style>
