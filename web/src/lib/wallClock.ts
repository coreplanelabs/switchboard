import { onMounted, onUnmounted, ref, type Ref } from "vue";

// The browser's wall clock, read here and nowhere else in the web app
// (docs/reference/specs/tracing.md item 8, the clock ratchet): the one web file the
// `clock-ban` lint and the allowlist scanner exempt. Every page that ticks or
// stamps "now" goes through these two, so a test can pin time by faking the
// browser's timers in one place.

/** One reading of the browser's clock. */
export function wallNow(): number {
  return Date.now();
}

/** A ref that reads `initial` (else the clock) at setup and ticks every
 *  `intervalMs` while the component is mounted — the stopwatch every live page
 *  keeps. The interval is cleared on unmount. */
export function useWallClock(initial?: number, intervalMs = 1000): Ref<number> {
  const now = ref(initial ?? wallNow());
  let handle: ReturnType<typeof setInterval> | null = null;
  onMounted(() => {
    handle = setInterval(() => {
      now.value = wallNow();
    }, intervalMs);
  });
  onUnmounted(() => {
    if (handle) clearInterval(handle);
  });
  return now;
}
