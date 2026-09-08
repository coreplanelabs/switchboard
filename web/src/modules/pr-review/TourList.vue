<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import LabelTip from "./LabelTip.vue";
import {
  anchorLabel,
  placementNote,
  placementOf,
  staleAnchor,
  staleExplanation,
  stepTip,
  type Placement,
} from "./tour";
import { fileLink, type PrRef, type TourStep } from "./types";

// The PR description's Tour in the left column: the steps in reading order —
// number, title, the one-line explanation, the "Look for" pointer, the anchor
// as `path:from–to` — and under them the Remaining changes, path and note
// each. A step is a button: the panel jumps the diff to its lines and the
// step takes the same accent the lit rows carry.
//
// The list holds still. Title and description are clamped to two lines and
// the anchor to one, and nothing — hover, focus, the active mark — changes an
// element's size, so clicking through the steps never moves the list under
// the pointer. What a clamp hides rides ONE tooltip per step, on the step
// element itself: a native button (or link), so Tab reaches it and focus
// opens it for a keyboard reader as hover does for a pointer. The tooltip
// says only what the step cannot show — the title and description whole when
// their clamp hides lines, the full `path:from–to` when the anchor is cut,
// and the stale explanation for an anchor rendered at another head — and is
// disabled when there is nothing to add. The clamp is visual: the accessible
// name already carries the whole text. The anchor truncates from the left so
// the file name, the part the reader scans for, is the part that stays.
//
// Each step is placed against the diffs the panel holds — in the shown diff;
// only in the full one (the abridgement dropped the file: a muted affordance
// says the jump opens the full diff); beyond the recorded diff (the full
// diff was cut at its cap and no diff here has the file — the step links to
// the file on GitHub at the reviewed head instead of pretending the change
// lacks it); or in neither with the whole diff on record (muted, inert). A
// step anchored at another head than the reviewed one carries a warning
// badge; its explanation is in the step's tooltip and the badge's label.

const props = defineProps<{
  steps: readonly TourStep[];
  remaining: readonly { path: string; note: string }[];
  /** The files of the diff on screen, and of the full diff. */
  shownPaths: ReadonlySet<string>;
  fullPaths: ReadonlySet<string>;
  /** The full diff on record was cut at its cap: a file in no diff may lie past the cut. */
  fullTruncated: boolean;
  /** The PR, for the GitHub link a step past the cut falls back to. */
  pr: PrRef;
  /** The head under review, for the stale check. */
  reviewedSha?: string;
  /** The step the reader jumped to last, and the one whose lines no diff had. */
  active: number | null;
  missed: number | null;
}>();
const emit = defineEmits<{ jump: [index: number]; open: [path: string] }>();

const placements = computed<Placement[]>(() =>
  props.steps.map((s) => placementOf(s.anchor.path, props.shownPaths, props.fullPaths, props.fullTruncated)),
);

/** The GitHub link a step beyond the recorded diff opens; none for a step the
 *  diffs place, or when the PR's repo or head is unknown. */
const links = computed<(string | undefined)[]>(() =>
  props.steps.map((s, i) => (placements.value[i] === "beyond" ? fileLink(props.pr, s.anchor) : undefined)),
);

function note(i: number): string | undefined {
  return placementNote(placements.value[i], links.value[i] !== undefined, props.missed === i);
}

/** A step the reader can act on: a jump, or the GitHub link. */
function actionable(i: number): boolean {
  const placement = placements.value[i];
  return placement === "shown" || placement === "full" || links.value[i] !== undefined;
}

function activate(i: number): void {
  if (placements.value[i] === "shown" || placements.value[i] === "full") emit("jump", i);
}

/** The stale badge's text, when the step's anchor is at another head. */
function staleText(step: TourStep): string | undefined {
  const { sha } = step.anchor;
  return sha && props.reviewedSha && staleAnchor(step.anchor, props.reviewedSha)
    ? staleExplanation(sha, props.reviewedSha)
    : undefined;
}

/** Some diff the panel holds carries the path. */
function known(path: string): boolean {
  return props.shownPaths.has(path) || props.fullPaths.has(path);
}

/** A Remaining path in no diff: GitHub has it when the recorded diff was cut. */
function remainingLink(path: string): string | undefined {
  return !known(path) && props.fullTruncated ? fileLink(props.pr, { path }) : undefined;
}

function remainingTitle(path: string): string {
  if (known(path)) return path;
  return remainingLink(path) ? `${path} — beyond the recorded diff · open on GitHub` : `${path} — not in this diff`;
}

// Which clamps hide text: measured, not assumed, so a step that fits carries
// no tooltip repeating what is already visible. Remeasured when the steps'
// words change (an in-place edit included — the watch is deep, not on the
// array's identity) and, through one observer over the list, on a resize
// (the column's width is the host's).
const root = ref<HTMLElement | null>(null);
const proseEls = new Map<number, HTMLElement>();
const anchorEls = new Map<number, HTMLElement>();
function bind(map: Map<number, HTMLElement>, i: number, el: unknown): void {
  if (el instanceof HTMLElement) map.set(i, el);
  else map.delete(i);
}
const overflowing = ref<ReadonlySet<string>>(new Set());
const hidesLines = (el: Element) => el.scrollHeight > el.clientHeight + 1;
function measure(): void {
  const next = new Set<string>();
  for (const [i, el] of proseEls) {
    if (Array.from(el.querySelectorAll(".step-title, .step-description")).some(hidesLines)) next.add(`prose:${i}`);
  }
  for (const [i, el] of anchorEls) if (el.scrollWidth > el.clientWidth + 1) next.add(`anchor:${i}`);
  overflowing.value = next;
}
let observer: ResizeObserver | null = null;
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== "undefined" && root.value) {
    observer = new ResizeObserver(() => measure());
    observer.observe(root.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());
watch(
  () => props.steps,
  () => void nextTick(measure),
  { deep: true },
);

/** The step's tooltip: only what the step cannot show. Empty → disabled. */
function tip(i: number): string {
  const step = props.steps[i];
  const parts = [
    overflowing.value.has(`prose:${i}`) ? stepTip(step) : undefined,
    overflowing.value.has(`anchor:${i}`) ? anchorLabel(step.anchor) : undefined,
    staleText(step),
  ];
  return parts.filter((p): p is string => p !== undefined).join(" · ");
}
</script>

<template>
  <section ref="root" class="tour border-b border-default text-xs" data-testid="tour">
    <template v-if="steps.length > 0">
      <h3
        class="m-0 flex items-baseline gap-1.5 border-b border-muted px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-muted"
      >
        Tour
        <span class="normal-case tracking-normal text-dimmed"
          >· {{ steps.length }} {{ steps.length === 1 ? "step" : "steps" }}</span
        >
      </h3>
      <ol class="m-0 list-none p-0">
        <li v-for="(step, i) in steps" :key="i" class="border-b border-muted">
          <!-- One tooltip per step, on the step itself — a focusable element,
               so a keyboard reader gets it too. A step past the recorded diff
               is a link to GitHub; every other step is a button the panel
               answers. Same box either way. -->
          <LabelTip :text="tip(i)" :disabled="tip(i) === ''">
            <component
              :is="links[i] ? 'a' : 'button'"
              :type="links[i] ? undefined : 'button'"
              :href="links[i]"
              :target="links[i] ? '_blank' : undefined"
              :rel="links[i] ? 'noopener noreferrer' : undefined"
              class="step flex w-full gap-2 px-3 py-1.5 text-left no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary motion-reduce:transition-none"
              :class="[
                active === i ? 'is-active' : 'hover:bg-muted',
                actionable(i) ? 'text-default' : 'is-muted text-dimmed',
                links[i] ? 'is-beyond' : '',
              ]"
              :data-placement="placements[i]"
              :aria-current="active === i ? 'step' : undefined"
              data-testid="tour-step"
              @click="activate(i)"
            >
              <span
                class="step-number mt-px flex size-4 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-semibold tabular-nums"
                :class="active === i ? 'bg-(--pr-review-mark) text-inverted' : 'bg-accented text-muted'"
                >{{ i + 1 }}</span
              >
              <span class="flex min-w-0 flex-1 flex-col gap-0.5 font-sans text-[0.8rem]">
                <span
                  :ref="(el) => bind(proseEls, i, el)"
                  class="step-prose flex min-w-0 flex-col gap-0.5"
                  data-testid="tour-step-prose"
                >
                  <span
                    class="step-title line-clamp-2 min-w-0 font-medium leading-snug"
                    :class="actionable(i) ? 'text-highlighted' : ''"
                    >{{ step.title }}</span
                  >
                  <span v-if="step.description" class="step-description line-clamp-2 leading-snug text-muted">{{
                    step.description
                  }}</span>
                </span>
                <span v-if="step.lookFor" class="step-look-for leading-snug text-muted"
                  ><span class="font-medium text-default">Look for:</span> {{ step.lookFor }}</span
                >
                <span class="flex min-w-0 items-baseline gap-x-2">
                  <span
                    :ref="(el) => bind(anchorEls, i, el)"
                    class="step-anchor min-w-0 shrink truncate font-mono text-[0.7rem] text-dimmed"
                    dir="rtl"
                    ><bdi>{{ anchorLabel(step.anchor) }}</bdi></span
                  >
                  <span
                    v-if="staleText(step)"
                    class="inline-flex shrink-0 items-center self-center rounded bg-warning/15 px-1 text-warning"
                    :aria-label="staleText(step)"
                    data-testid="tour-step-stale"
                  >
                    <UIcon name="i-lucide-triangle-alert" class="size-3" />
                  </span>
                </span>
                <!-- Its own line: beside the anchor it would squeeze the path to nothing. -->
                <span
                  v-if="note(i)"
                  class="text-[0.7rem] italic leading-snug text-dimmed"
                  data-testid="tour-step-note"
                  >{{ note(i) }}</span
                >
              </span>
            </component>
          </LabelTip>
        </li>
      </ol>
    </template>
    <div v-if="remaining.length > 0" class="px-3 py-1.5" data-testid="tour-remaining">
      <h4 class="m-0 mb-1 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Remaining changes</h4>
      <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
        <li v-for="r in remaining" :key="r.path" class="min-w-0 leading-snug" data-testid="tour-remaining-entry">
          <component
            :is="remainingLink(r.path) ? 'a' : 'button'"
            :type="remainingLink(r.path) ? undefined : 'button'"
            :href="remainingLink(r.path)"
            :target="remainingLink(r.path) ? '_blank' : undefined"
            :rel="remainingLink(r.path) ? 'noopener noreferrer' : undefined"
            class="font-mono text-[0.7rem] no-underline hover:underline focus-visible:outline-2 focus-visible:outline-primary"
            :class="known(r.path) || remainingLink(r.path) ? 'text-default' : 'is-muted text-dimmed'"
            :title="remainingTitle(r.path)"
            @click="known(r.path) ? emit('open', r.path) : undefined"
          >
            {{ r.path }}
          </component>
          <span class="font-sans text-[0.8rem] text-muted"> — {{ r.note }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style>
/* The active step wears the mark the lit rows wear in the diff (the same
 * bar, the same tint — ReadingDiffView.vue's `tr.is-focus`; the hue is the
 * panel's `--pr-review-mark`), so the eye pairs the two across the columns.
 * Color only: the box never changes size. */
.tour .step.is-active {
  background-image: linear-gradient(
    color-mix(in srgb, var(--pr-review-mark) 10%, transparent),
    color-mix(in srgb, var(--pr-review-mark) 10%, transparent)
  );
  box-shadow: inset 3px 0 0 var(--pr-review-mark);
}
</style>
