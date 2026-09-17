<script setup lang="ts">
import { computed } from "vue";
import type { HomeConversationRowSeed } from "@core/channels/webSeed.js";
import SlackMark from "../SlackMark.vue";
import { threadTip } from "../../lib/homeModel";

// A rail row's tooltip (docs/reference/specs/web-chat.md item 7): the row keeps
// only the title and a short distance, so everything else it knows — the first
// request in full, the moment as a date and time, the channel (led by the Slack
// mark for a Slack thread, as the runs index's source tooltip is), the run
// count, a run in flight — reads here after a short hover. The facts are
// `threadTip`'s; this component only lays them out.

const props = defineProps<{ row: HomeConversationRowSeed; now: number }>();
const tip = computed(() => threadTip(props.row, props.now));
</script>

<template>
  <div class="thread-tip flex max-w-xs flex-col gap-1 text-xs">
    <p class="tip-title leading-snug text-highlighted">{{ tip.title }}</p>
    <p class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[0.68rem] text-muted">
      <span class="tip-when tabular-nums">{{ tip.when }}</span>
      <span aria-hidden="true">·</span>
      <span class="tip-source inline-flex items-center gap-1"
        ><SlackMark v-if="row.surface === 'slack'" />{{ tip.source }}</span
      >
      <span aria-hidden="true">·</span>
      <span class="tip-runs">{{ tip.runs }}</span>
      <span v-if="tip.live" class="tip-live inline-flex items-center gap-1 text-toned"
        ><span class="size-1.5 rounded-full bg-ok" aria-hidden="true" />live</span
      >
    </p>
  </div>
</template>
