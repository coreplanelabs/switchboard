<script setup lang="ts">
import { computed } from "vue";
import LabelTip from "./LabelTip.vue";
import { anchorLabel, placementOf, staleAnchor, staleExplanation, type Placement } from "./tour";
import type { TourStep } from "./types";

// The PR description's Tour in the left column: the steps in reading order —
// number, title, the one-line explanation (two lines folded, whole on hover
// or when active), the "Look for" pointer, the anchor as `path:from–to` — and
// under them the Remaining changes, path and note each. A step is a button:
// the panel jumps the diff to its lines. Each step is placed against the
// diffs the panel holds — in the shown diff, only in the full one (the
// abridgement dropped the file: a muted affordance says the jump opens the
// full diff), or in neither (muted, inert). A step anchored at another head
// than the reviewed one carries a warning badge with the two shas.

const props = defineProps<{
  steps: readonly TourStep[];
  remaining: readonly { path: string; note: string }[];
  /** The files of the diff on screen, and of the full diff. */
  shownPaths: ReadonlySet<string>;
  fullPaths: ReadonlySet<string>;
  /** The head under review, for the stale check. */
  reviewedSha?: string;
  /** The step the reader jumped to last, and the one whose lines no diff had. */
  active: number | null;
  missed: number | null;
}>();
const emit = defineEmits<{ jump: [index: number]; open: [path: string] }>();

const placements = computed<Placement[]>(() =>
  props.steps.map((s) => placementOf(s.anchor.path, props.shownPaths, props.fullPaths)),
);

function note(i: number): string | undefined {
  const placement = placements.value[i];
  if (placement === "full") return "not in the reading diff · open full diff";
  if (placement === "absent") return "not in this diff";
  if (props.missed === i) return "lines not in this diff";
  return undefined;
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
</script>

<template>
  <section class="tour border-b border-default text-xs" data-testid="tour">
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
          <button
            type="button"
            class="group flex w-full gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary motion-reduce:transition-none"
            :class="[
              active === i ? 'is-active bg-accented' : '',
              placements[i] === 'absent' ? 'is-muted text-dimmed' : 'text-default',
            ]"
            :data-placement="placements[i]"
            :aria-current="active === i ? 'step' : undefined"
            data-testid="tour-step"
            @click="placements[i] === 'absent' ? undefined : emit('jump', i)"
          >
            <span
              class="step-number mt-px flex size-4 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-semibold tabular-nums"
              :class="active === i ? 'bg-primary text-inverted' : 'bg-accented text-muted'"
              >{{ i + 1 }}</span
            >
            <span class="flex min-w-0 flex-1 flex-col gap-0.5 font-sans text-[0.8rem]">
              <span class="flex items-center gap-1.5">
                <span
                  class="step-title min-w-0 flex-1 font-medium leading-snug"
                  :class="placements[i] === 'absent' ? '' : 'text-highlighted'"
                  >{{ step.title }}</span
                >
                <LabelTip v-if="staleText(step)" :text="staleText(step) ?? ''">
                  <span
                    class="inline-flex shrink-0 items-center rounded bg-warning/15 px-1 text-warning"
                    :aria-label="staleText(step)"
                    data-testid="tour-step-stale"
                  >
                    <UIcon name="i-lucide-triangle-alert" class="size-3" />
                  </span>
                </LabelTip>
              </span>
              <span
                v-if="step.description"
                class="step-description leading-snug text-muted"
                :class="active === i ? '' : 'line-clamp-2 group-hover:line-clamp-none'"
                >{{ step.description }}</span
              >
              <span v-if="step.lookFor" class="step-look-for leading-snug text-muted"
                ><span class="font-medium text-default">Look for:</span> {{ step.lookFor }}</span
              >
              <span class="flex flex-wrap items-baseline gap-x-2">
                <span class="step-anchor truncate font-mono text-[0.7rem] text-dimmed">{{
                  anchorLabel(step.anchor)
                }}</span>
                <span v-if="note(i)" class="text-[0.7rem] italic text-dimmed" data-testid="tour-step-note">{{
                  note(i)
                }}</span>
              </span>
            </span>
          </button>
        </li>
      </ol>
    </template>
    <div v-if="remaining.length > 0" class="px-3 py-1.5" data-testid="tour-remaining">
      <h4 class="m-0 mb-1 text-[0.68rem] font-semibold uppercase tracking-wider text-muted">Remaining changes</h4>
      <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
        <li v-for="r in remaining" :key="r.path" class="min-w-0 leading-snug" data-testid="tour-remaining-entry">
          <button
            type="button"
            class="font-mono text-[0.7rem] hover:underline focus-visible:outline-2 focus-visible:outline-primary"
            :class="known(r.path) ? 'text-default' : 'is-muted text-dimmed'"
            :title="known(r.path) ? r.path : `${r.path} — not in this diff`"
            @click="known(r.path) ? emit('open', r.path) : undefined"
          >
            {{ r.path }}
          </button>
          <span class="font-sans text-[0.8rem] text-muted"> — {{ r.note }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>
