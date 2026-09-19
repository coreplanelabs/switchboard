<script setup lang="ts">
import { computed } from "vue";
import type { HomeParentTurnSeed } from "@core/channels/webSeed.js";
import { formatDateTime, formatLocalIso } from "../../lib/format";

// The hosted ship parent's word in a unit's thread (docs/reference/specs/web-chat.md
// item 2; record 0060): a `ship_unit` event of the parent run naming this
// thread — the pipeline said something about this unit here. One muted line
// linked to the parent's run page; never the thread's own run, so the composer
// ignores it.

const props = defineProps<{ turn: HomeParentTurnSeed; now: number }>();
const when = computed(() => formatDateTime(props.turn.at, props.now));
// A live parent's page 404s a tokenless read, so the seed's token rides the
// link (`?t=…`) while the pipeline runs; a finished parent's href is bare.
const href = computed(
  () =>
    `/runs/${encodeURIComponent(props.turn.runId)}` +
    (props.turn.token !== undefined ? `?t=${encodeURIComponent(props.turn.token)}` : ""),
);
/** The line the parent said: the ending's report, the start's lead, else the bare state. */
const line = computed(() => props.turn.report ?? props.turn.lead ?? `unit ${props.turn.unit} — ${props.turn.state}`);
</script>

<template>
  <div
    class="turn parent flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 font-mono text-[0.7rem] text-dimmed"
    data-testid="parent-word"
  >
    <span class="glyph select-none" aria-hidden="true">⇡</span>
    <a :href="href" class="label text-toned underline decoration-dotted underline-offset-2">Pipeline</a>
    <span class="line text-muted">— {{ line }}</span>
    <span v-if="turn.pr !== undefined" class="pr text-muted">#{{ turn.pr }}</span>
    <span class="ts ml-auto select-none" :title="formatLocalIso(turn.at)">{{ when }}</span>
  </div>
</template>
