<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { HomeCommandSeed } from "@core/channels/webSeed.js";
import {
  completeCommand,
  enterSubmits,
  filterCommands,
  placeholderFor,
  slashQuery,
  type ComposerMode,
} from "../../lib/homeModel";

// The composer (docs/reference/specs/web-chat.md rules 5 and 8): one box, one
// control. The box is focused on load and grows with its text to eight lines;
// its hairline brightens to ink on focus and a light sweeps once around the
// ring (the one place the page borrows a little motion from the best chat
// composers — a rotation of a gradient, no element moves). Its placeholder
// guides the hand by state. Enter sends (or steers), Shift+Enter breaks a
// line. `/` at the start opens the PALETTE: the chat commands the viewer may
// run, each with the command's own description, filtered as they type; arrows
// move, Enter or a tap inserts the chat form (the slash never reaches the bot),
// Escape closes. The control is `send` while nothing is live in the
// conversation, `stop` while a run is and the box is empty, `steer` while a run
// is and there is text — never disabled while a run is live; its icon
// crossfades between the three. The hint line under the box is always laid out
// (its height is reserved), so nothing shifts when it appears.

const props = defineProps<{
  modelValue: string;
  mode: ComposerMode;
  /** The hint to show instead of the default (`Enter runs it` after a hand-back). */
  hint?: string;
  /** Focus the box on mount and whenever the value is filled from outside (a hand-back, a chip). */
  autofocus?: boolean;
  /** Sweep the ring once on mount, as the page lands (the empty state). */
  sweepOnMount?: boolean;
  /** The palette's rows (the seed's `commands`); none → no palette. */
  commands?: HomeCommandSeed[];
}>();
const emit = defineEmits<{ "update:modelValue": [value: string]; submit: []; stop: [] }>();

const box = ref<HTMLTextAreaElement | null>(null);
const focused = ref(false);
const sweeping = ref(false);

/** Rows follow the text, one to eight: the box grows, the page never jumps. */
const rows = computed(() => Math.min(8, Math.max(1, props.modelValue.split("\n").length)));

const CONTROL: Record<ComposerMode, { icon: string; label: string }> = {
  send: { icon: "i-lucide-arrow-up", label: "Send" },
  steer: { icon: "i-lucide-corner-down-right", label: "Steer the run" },
  stop: { icon: "i-lucide-square", label: "Stop the run" },
};
const control = computed(() => CONTROL[props.mode]);
const placeholder = computed(() => placeholderFor(props.mode, props.hint));
const hintText = computed(() => {
  if (props.hint) return props.hint;
  if (props.mode === "steer") return "Enter folds this into the run in flight";
  if (props.mode === "stop") return "A run is in flight · type to steer it, or stop it";
  return "Enter to send · Shift+Enter for a new line · / for a command";
});
const hintShown = computed(() => focused.value || props.hint !== undefined || props.mode !== "send");

// ---- the palette ---------------------------------------------------------------------
const query = computed(() => (props.commands && props.commands.length > 0 ? slashQuery(props.modelValue) : null));
const matches = computed(() => (query.value === null ? [] : filterCommands(props.commands ?? [], query.value)));
const open = computed(() => query.value !== null && !dismissed.value);
const dismissed = ref(false);
const index = ref(0);
watch(query, (q) => {
  dismissed.value = false;
  index.value = 0;
  void q;
});
watch(matches, (m) => {
  if (index.value >= m.length) index.value = Math.max(0, m.length - 1);
});
function pick(chat: string): void {
  emit("update:modelValue", completeCommand(chat));
  dismissed.value = true;
  focus();
}

function onInput(ev: Event): void {
  emit("update:modelValue", (ev.target as HTMLTextAreaElement).value);
}
function onKeydown(ev: KeyboardEvent): void {
  if (open.value) {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (matches.value.length > 0) index.value = (index.value + 1) % matches.value.length;
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (matches.value.length > 0) index.value = (index.value - 1 + matches.value.length) % matches.value.length;
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      dismissed.value = true;
      return;
    }
    if ((ev.key === "Enter" && !ev.shiftKey) || ev.key === "Tab") {
      const hit = matches.value[index.value];
      if (hit) {
        ev.preventDefault();
        pick(hit.chat);
        return;
      }
    }
  }
  if (!enterSubmits(ev)) return;
  ev.preventDefault();
  act();
}
function act(): void {
  if (props.mode === "stop") emit("stop");
  else if (props.modelValue.trim() !== "") emit("submit");
}
/** One sweep of light around the ring; restarted on every focus. */
function sweep(): void {
  sweeping.value = false;
  void nextTick().then(() => {
    sweeping.value = true;
  });
}
function onFocus(): void {
  focused.value = true;
  sweep();
}
function focus(): void {
  void nextTick().then(() => {
    const el = box.value;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // A focus the page gave (on load, after a hand-back) counts like the person's:
    // the browser may have focused the box before the listener was bound.
    if (document.activeElement === el && !focused.value) onFocus();
  });
}
watch(
  () => props.hint,
  (h) => {
    if (h) focus();
  },
);
onMounted(() => {
  if (props.autofocus) focus();
  if (props.sweepOnMount) sweep();
});
defineExpose({ focus });
</script>

<template>
  <div class="composer-wrap relative">
    <!-- The palette: above the box, the commands the viewer may run. -->
    <Transition name="sb-rise">
      <div
        v-if="open"
        class="palette absolute bottom-full left-0 right-0 z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border border-default bg-(--ui-bg-elevated) p-1 shadow-sm"
        role="listbox"
        aria-label="Commands"
        data-testid="palette"
      >
        <p v-if="matches.length === 0" class="px-3 py-2 font-mono text-xs text-dimmed">
          No command matches "/{{ query }}".
        </p>
        <button
          v-for="(c, i) in matches"
          :key="c.chat"
          type="button"
          role="option"
          class="item flex w-full items-baseline gap-3 rounded-lg px-3 py-1.5 text-left transition-colors duration-150 ease-out"
          :class="i === index ? 'bg-(--ui-bg-accented)' : 'hover:bg-(--ui-bg-muted)'"
          :aria-selected="i === index ? 'true' : 'false'"
          :data-chat="c.chat"
          @mousedown.prevent
          @click="pick(c.chat)"
          @mouseenter="index = i"
        >
          <span class="chat shrink-0 font-mono text-[0.8rem] font-medium text-highlighted">/{{ c.chat }}</span>
          <span class="describe min-w-0 flex-1 truncate text-[0.8rem] text-muted">{{ c.describe }}</span>
        </button>
      </div>
    </Transition>

    <div class="ring relative rounded-2xl" :class="sweeping ? 'ring-sweep' : ''" @animationend="sweeping = false">
      <form
        class="composer relative flex items-end gap-2 rounded-2xl border bg-default px-3 py-2 transition-colors duration-150 ease-out"
        :class="focused ? 'border-primary' : 'border-default hover:border-accented'"
        :data-mode="mode"
        @submit.prevent="act"
      >
        <textarea
          ref="box"
          class="box min-h-6 flex-1 resize-none bg-transparent py-1 text-[0.875rem] leading-normal text-highlighted outline-none placeholder:text-dimmed"
          :rows="rows"
          :value="modelValue"
          :placeholder="placeholder"
          :autofocus="autofocus"
          aria-label="Message"
          :aria-expanded="open ? 'true' : undefined"
          autocomplete="off"
          spellcheck="true"
          @input="onInput"
          @keydown="onKeydown"
          @focus="onFocus"
          @blur="focused = false"
        />
        <UButton
          type="submit"
          class="control shrink-0 rounded-full transition-transform duration-150 ease-out active:scale-95"
          :color="mode === 'stop' ? 'neutral' : 'primary'"
          :variant="mode === 'stop' ? 'outline' : 'solid'"
          size="sm"
          :aria-label="control.label"
          :title="control.label"
          :disabled="mode === 'send' && modelValue.trim() === ''"
          :data-mode="mode"
        >
          <Transition name="sb-fade" mode="out-in">
            <UIcon :key="control.icon" :name="control.icon" class="size-4" aria-hidden="true" />
          </Transition>
        </UButton>
      </form>
    </div>
    <!-- Always laid out: the line's height is reserved, only its opacity changes (no layout shift). -->
    <p
      class="hint mt-1.5 min-h-[1.1rem] select-none px-3 font-mono text-[0.7rem] text-dimmed transition-opacity duration-150 ease-out"
      :class="hintShown ? 'opacity-100' : 'opacity-0'"
      :aria-hidden="hintShown ? undefined : 'true'"
      :data-hint="hint ? 'handback' : mode"
      :data-shown="hintShown ? '1' : '0'"
    >
      {{ hintText }}
    </p>
  </div>
</template>
