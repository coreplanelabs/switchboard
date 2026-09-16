<script setup lang="ts">
import { computed } from "vue";
import { formatDateTime, formatLocalIso } from "../../lib/format";

// The person's turn (docs/reference/specs/web-chat.md item 4): what they typed,
// drawn once, on Enter, at the transcript's right edge in the accented
// surface — the one filled shape on the page, so a reader's eye finds their
// own words at a glance. Under it, its moment; when the message was folded
// into a live run, the fold's stamp (`↪ folded in at 0:40`), the run's own
// `input` event having confirmed it (rule 3: never drawn twice).

const props = defineProps<{
  text: string;
  at: number;
  now: number;
  /** The POST has not answered yet: the turn stands, slightly held back. */
  pending?: boolean;
  /** The steer's stamp, once the live run drained it. */
  folded?: string;
  /** The send failed: the turn stays, with the reason under it. */
  failed?: string;
}>();

const when = computed(() => formatDateTime(props.at, props.now));
</script>

<template>
  <div class="turn person flex flex-col items-end gap-1" :data-pending="pending ? '1' : undefined">
    <div
      class="bubble max-w-[min(42rem,88%)] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-(--ui-bg-accented) px-4 py-2.5 text-[0.875rem] leading-normal text-highlighted transition-opacity duration-150 ease-out"
      :class="pending ? 'opacity-70' : ''"
    >
      {{ text }}
    </div>
    <div class="meta flex items-baseline gap-2 pr-1 font-mono text-[0.7rem] text-dimmed">
      <span v-if="failed" class="failed text-bad">{{ failed }}</span>
      <Transition name="sb-fade">
        <span v-if="folded" class="folded text-muted">↪ folded in {{ folded }}</span>
      </Transition>
      <span class="ts select-none" :title="formatLocalIso(at)">{{ when }}</span>
    </div>
  </div>
</template>
