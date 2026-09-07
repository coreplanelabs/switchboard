<script setup lang="ts">
import { formatLocalIso } from "../../lib/format";
import type { CallVm } from "../../lib/runPageModel";

// A call card: <details> — header row is the summary (status glyph, $ or tool
// chip, the command with a one-line collapsed headline, right-hand facts,
// chevron), the redacted output inside. The call's start time is pacing
// information, not a headline: it rides on the card's hover.

const props = defineProps<{ call: CallVm }>();

function toggle(): void {
  props.call.open = !props.call.open;
}
</script>

<template>
  <details
    class="call rounded-md border border-default bg-elevated open:bg-accented/40"
    :class="call.status"
    :open="call.open"
    :title="typeof call.startedAt === 'number' ? `started ${formatLocalIso(call.startedAt)}` : undefined"
    :data-status="call.status"
  >
    <!-- Open on a phone, the full command takes its own line under the glyph
         row (an inline pre-wrap column would wrap character by character). -->
    <summary
      class="flex min-w-0 cursor-pointer list-none items-baseline gap-3 rounded-md px-3 py-2 hover:bg-accented/60 focus-visible:outline-2 focus-visible:outline-primary max-sm:flex-wrap [&::-webkit-details-marker]:hidden"
      :class="call.open ? 'rounded-b-none border-b border-default' : ''"
      @click.prevent="toggle"
    >
      <span
        v-if="call.status === 'running'"
        class="spin inline-block size-[0.7em] shrink-0 animate-spin self-center rounded-full border-2 border-accented border-t-info motion-reduce:animate-none"
        role="img"
        aria-label="running"
      />
      <span
        v-else
        class="glyph w-[1em] shrink-0 text-center font-bold"
        :class="call.status === 'ok' ? 'text-ok' : call.status === 'failed' ? 'text-bad' : 'text-warn'"
        >{{ call.status === "ok" ? "✓" : call.status === "failed" ? "✗" : "⚠" }}</span
      >
      <span v-if="call.shell" class="dollar shrink-0 select-none text-dimmed">$</span>
      <span v-else class="tool shrink-0 rounded bg-accented px-1.5 text-xs leading-normal text-muted">{{
        call.tool
      }}</span>
      <template v-if="!call.chipOnly">
        <!-- Collapsed: the command's first line only (ellipsized); open: all of it. -->
        <code v-if="!call.open" class="cmd brief min-w-0 flex-1 truncate text-info">{{ call.headline }}</code>
        <code
          v-else
          class="cmd full min-w-0 flex-1 whitespace-pre-wrap break-words text-info max-sm:order-last max-sm:basis-full"
          >{{ call.title }}</code
        >
      </template>
      <span v-else class="cmd min-w-0 flex-1" />
      <span class="facts ml-auto flex shrink-0 gap-2.5 text-xs tabular-nums text-muted">
        <span
          v-for="(fact, i) in call.facts"
          :key="i"
          class="fact"
          :class="call.status !== 'ok' && i === 0 ? 'text-bad' : ''"
          >{{ fact }}</span
        >
      </span>
      <span
        class="chev shrink-0 text-xs text-dimmed transition-transform motion-reduce:transition-none"
        :class="call.open ? 'rotate-90' : ''"
        >❯</span
      >
    </summary>
    <div class="body">
      <pre
        v-if="call.hasResult && call.output"
        class="out max-h-[28rem] overflow-auto whitespace-pre-wrap break-words px-3.5 py-2.5 font-mono leading-normal"
        :class="call.status === 'failed' ? 'text-bad' : 'text-toned'"
        >{{ call.output }}</pre>
      <div v-else-if="call.hasResult" class="none px-3 py-1.5 text-xs italic text-dimmed">no output</div>
      <div v-else class="none px-3 py-1.5 text-xs italic text-dimmed">running…</div>
    </div>
  </details>
</template>
