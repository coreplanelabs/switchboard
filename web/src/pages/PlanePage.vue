<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { PlanePullRequestRow, PlaneRunRow, PlaneUnitRow } from "@core/core/plane/table.js";
import AppShell from "../components/AppShell.vue";
import PlaneChat from "../components/plane/PlaneChat.vue";
import { browser } from "../lib/browser";
import { useSeed } from "../lib/seed";
import { useWallClock } from "../lib/wallClock";
import {
  runHref,
  rowBound,
  rowPace,
  shortId,
  statusDot,
  statusWord,
  threadHref,
  whoText,
  type IndexRow,
} from "../lib/indexRow";
import { formatDuration } from "../lib/format";
import { runDurationMs } from "@core/core/runDuration.js";

// The plane's table (docs/reference/specs/orchestration-plane.md item 5; record 0064):
// what is happening, as one page — every live and recently ended run, every ship
// unit and every tracked pull request, each with its owner and its health flags.
// Every word comes from the seed the server built under the viewer's own
// predicate; the page paints and links, it decides nothing. A run row reads as
// it does on the runs index (the same helpers), so the two never disagree.

const seed = useSeed("plane");
const table = computed(() => seed?.table ?? null);
/** The clock the rows age against: the seed's `at` first, then the wall clock
 *  while the page is open. Both halves read it — the chat column gets the same
 *  ref — so a row the chat cites is the row the panel paints (record 0070). */
const now = useWallClock(seed?.table.at, 30_000);

// ---- the chat column (record 0070): the viewer's orchestrator thread ------------
// Present only when the seed carries the half: a session-less viewer (or a
// build without the web chat) gets the panels full-width as before. The
// column's width is the person's — 400 px until they drag the divider — and is
// remembered by this browser alone (localStorage; empty or blocked storage
// renders the default). Below the wide breakpoint the chat folds behind a
// floating button that opens it as a sheet, like the app's other fold.
const chat = seed?.chat ?? null;
const CHAT_WIDTH = { min: 320, default: 400, max: 640, step: 16 } as const;
const CHAT_PREF = "sb.plane.chat.width";
function clampChatWidth(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(CHAT_WIDTH.max, Math.max(CHAT_WIDTH.min, v)) : CHAT_WIDTH.default;
}
const storedWidth = browser.readPref(CHAT_PREF);
const chatWidth = ref(storedWidth === null ? CHAT_WIDTH.default : clampChatWidth(storedWidth));
/** The phone's sheet, behind the floating button. */
const chatOpen = ref(false);
/** Tailwind's `lg`: the chat is a column from here up. The column mounts only
 *  on a wide viewport (one PlaneChat at a time — never a hidden second copy
 *  streaming beside the sheet); crossing to wide closes the sheet. */
const LG_UP = "(min-width: 64rem)";
const wide = ref(browser.mediaMatches(LG_UP));
const stopFollowingWidth = browser.onMediaChange(LG_UP, (matches) => {
  wide.value = matches;
  if (matches) chatOpen.value = false;
});
function setChatWidth(px: number, remember: boolean): void {
  chatWidth.value = clampChatWidth(px);
  if (remember) browser.writePref(CHAT_PREF, String(chatWidth.value));
}
let drag: { startX: number; startWidth: number } | null = null;
function onHandleMove(ev: PointerEvent): void {
  // The handle is the column's left edge: moving it left widens the column.
  if (drag) setChatWidth(drag.startWidth - (ev.clientX - drag.startX), false);
}
function onHandleUp(): void {
  window.removeEventListener("pointermove", onHandleMove);
  if (!drag) return;
  drag = null;
  browser.writePref(CHAT_PREF, String(chatWidth.value));
}
function onHandleDown(ev: PointerEvent): void {
  if (ev.button !== 0) return;
  ev.preventDefault();
  drag = { startX: ev.clientX, startWidth: chatWidth.value };
  (ev.currentTarget as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
  window.addEventListener("pointermove", onHandleMove);
  window.addEventListener("pointerup", onHandleUp, { once: true });
}
function onHandleKey(ev: KeyboardEvent): void {
  // The arrows move the handle: left widens the column, right narrows it;
  // Home is the widest, End the narrowest; a double-click resets.
  if (ev.key === "ArrowLeft") setChatWidth(chatWidth.value + CHAT_WIDTH.step, true);
  else if (ev.key === "ArrowRight") setChatWidth(chatWidth.value - CHAT_WIDTH.step, true);
  else if (ev.key === "Home") setChatWidth(CHAT_WIDTH.max, true);
  else if (ev.key === "End") setChatWidth(CHAT_WIDTH.min, true);
  else return;
  ev.preventDefault();
}
onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onHandleMove);
  window.removeEventListener("pointerup", onHandleUp);
  stopFollowingWidth();
});

/** A run row as the index row helpers read it: the view plus its token, when this process holds the run live. */
const indexRow = (row: PlaneRunRow): IndexRow => ({
  ...row.run,
  ...(seed?.tokens[row.run.id] ? { token: seed.tokens[row.run.id] } : {}),
});

const liveCount = computed(() => table.value?.runs.filter((r) => !r.run.finished).length ?? 0);
const recentCount = computed(() => (table.value ? table.value.runs.length - liveCount.value : 0));

const ownerOf = (row: PlaneRunRow): string => {
  const who = row.owner.name ?? whoText(indexRow(row)) ?? row.owner.id ?? "";
  return row.owner.generation ? `${who || "run"} · on ${row.owner.generation}` : who;
};
/** The one duration definition every surface prints (tracing.md item 13). */
const durationOf = (row: PlaneRunRow): string => {
  const r = row.run;
  return formatDuration(
    runDurationMs({ startedAt: r.startedAt, receivedAt: r.receivedAt, finishedAt: r.finishedAt }, now.value),
    "clock",
  );
};
const paceOf = (row: PlaneRunRow): string => rowBound(indexRow(row), now.value) ?? rowPace(indexRow(row), now.value);

const unitHref = (row: PlaneUnitRow): string => `/runs/unit/${encodeURIComponent(row.unit.unit)}`;
const prName = (row: PlanePullRequestRow): string => `${row.pr.repo}#${row.pr.number}`;
const prOwner = (row: PlanePullRequestRow): string =>
  row.owner.unitKey ?? (row.owner.runId ? `run ${shortId(row.owner.runId)}` : "a person");

/** Health words a stranger can read; the flag ids stay in `data-health` for tests and styling. */
const HEALTH_WORD: Record<string, string> = {
  stalled: "stalled",
  "bound-exceeded": "past its bound",
  "no-signal": "no signal",
  provisional: "unfinished",
  interrupted: "interrupted",
  failed: "failed",
  approved: "approved",
  dirty: "conflicts",
  red: "checks red",
  pending: "checks pending",
  mistitled: "title fails the rule",
  merged: "merged",
  closed: "closed",
  unknown: "unread",
  live: "live",
  waiting: "waiting",
  idle: "idle",
  "merge-ready": "merge-ready",
  ended: "ended",
  "owner-gap": "approved, open, nobody's",
};
const word = (flag: string): string => HEALTH_WORD[flag] ?? flag;
const tone = (flag: string): string =>
  ["stalled", "bound-exceeded", "red", "dirty", "mistitled", "owner-gap", "failed", "interrupted"].includes(flag)
    ? "border-error/40 text-error"
    : ["pending", "idle", "waiting", "no-signal", "provisional", "unknown"].includes(flag)
      ? "border-warning/40 text-warning"
      : "border-default text-muted";
</script>

<template>
  <AppShell v-if="table" title="Plane" nav="plane">
    <div
      class="plane"
      :class="chat ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_var(--chat-w)] lg:gap-10' : ''"
      :style="chat ? { '--chat-w': `${chatWidth}px` } : undefined"
      :data-chat="chat ? 'shown' : undefined"
    >
      <div class="panels min-w-0">
        <p class="mb-4 font-mono text-sm tabular-nums text-muted" data-plane-head>
          {{ liveCount }} live · {{ recentCount }} recent · {{ table.units.length }} units ·
          {{ table.pullRequests.length }} pull requests
        </p>

        <section class="mb-6" aria-labelledby="plane-runs">
          <h2 id="plane-runs" class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">Runs</h2>
          <p v-if="table.runs.length === 0" class="text-sm text-muted">No run is live or ended in the last hour.</p>
          <ul v-else class="divide-y divide-default rounded-md border border-default">
            <li
              v-for="row in table.runs"
              :key="row.run.id"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
              :data-run="row.run.id"
              :data-health="row.health.join(' ')"
            >
              <span
                class="inline-block size-2 rounded-full"
                :class="{
                  'bg-success': statusDot(indexRow(row)) === 'green',
                  'bg-error': statusDot(indexRow(row)) === 'red',
                  'bg-warning': statusDot(indexRow(row)) === 'amber',
                  'bg-dimmed': statusDot(indexRow(row)) === 'grey',
                }"
                aria-hidden="true"
              />
              <RouterLink class="font-mono text-highlighted" :to="runHref(indexRow(row))">{{
                shortId(row.run.id)
              }}</RouterLink>
              <span class="text-muted">{{ row.run.agent ?? "-" }}</span>
              <span class="font-mono tabular-nums">{{ statusWord(indexRow(row)) }}</span>
              <span class="font-mono tabular-nums text-muted">{{ durationOf(row) }}</span>
              <span v-if="paceOf(row)" class="font-mono text-xs tabular-nums text-muted">{{ paceOf(row) }}</span>
              <span class="text-muted" data-owner>{{ ownerOf(row) }}</span>
              <RouterLink
                v-if="row.unit"
                class="font-mono text-xs text-muted"
                :to="`/runs/unit/${encodeURIComponent(row.unit.key)}`"
                >{{ row.unit.key }}</RouterLink
              >
              <a
                v-if="row.run.threadKey"
                class="text-xs text-dimmed"
                :href="threadHref(row.run.threadKey)"
                target="_blank"
                rel="noreferrer"
                >thread</a
              >
              <span
                v-for="flag in row.health"
                :key="flag"
                class="rounded border px-1.5 py-0.5 text-xs"
                :class="tone(flag)"
                :data-flag="flag"
                >{{ word(flag) }}</span
              >
            </li>
          </ul>
        </section>

        <section class="mb-6" aria-labelledby="plane-units">
          <h2 id="plane-units" class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">Units</h2>
          <p v-if="table.units.length === 0" class="text-sm text-muted">No ship unit has a run on the table.</p>
          <ul v-else class="divide-y divide-default rounded-md border border-default">
            <li
              v-for="row in table.units"
              :key="row.unit.unit"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
              :data-unit="row.unit.unit"
              :data-health="row.health.join(' ')"
            >
              <RouterLink class="font-mono text-highlighted" :to="unitHref(row)">{{ row.unit.unit }}</RouterLink>
              <span class="text-muted">{{ row.instance.repo }}</span>
              <span>{{ row.unit.title ?? row.unit.id }}</span>
              <a
                v-if="row.unit.pr"
                class="font-mono text-xs text-muted"
                :href="row.unit.pr.url"
                target="_blank"
                rel="noreferrer"
                >#{{ row.unit.pr.number }}</a
              >
              <span
                v-for="flag in row.health"
                :key="flag"
                class="rounded border px-1.5 py-0.5 text-xs"
                :class="tone(flag)"
                :data-flag="flag"
                >{{ word(flag) }}</span
              >
            </li>
          </ul>
        </section>

        <section aria-labelledby="plane-prs">
          <h2 id="plane-prs" class="mb-2 text-xs font-medium uppercase tracking-wide text-dimmed">Pull requests</h2>
          <p v-if="table.pullRequests.length === 0" class="text-sm text-muted">No pull request is tracked.</p>
          <ul v-else class="divide-y divide-default rounded-md border border-default">
            <li
              v-for="row in table.pullRequests"
              :key="prName(row)"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
              :data-pr="prName(row)"
              :data-health="row.health.join(' ')"
            >
              <a
                v-if="row.pr.url"
                class="font-mono text-highlighted"
                :href="row.pr.url"
                target="_blank"
                rel="noreferrer"
                >{{ prName(row) }}</a
              >
              <span v-else class="font-mono text-highlighted">{{ prName(row) }}</span>
              <span v-if="row.pr.title" class="truncate text-muted">{{ row.pr.title }}</span>
              <span class="text-xs text-dimmed" data-owner>{{ prOwner(row) }}</span>
              <span
                v-for="flag in row.health"
                :key="flag"
                class="rounded border px-1.5 py-0.5 text-xs"
                :class="tone(flag)"
                :data-flag="flag"
                >{{ word(flag) }}</span
              >
            </li>
          </ul>
        </section>
      </div>

      <!-- The chat column (record 0070): the viewer's orchestrator thread beside the panels
           from the wide breakpoint up, resizable on the divider at its left edge. -->
      <aside v-if="chat && wide" class="chat-column relative hidden lg:block" data-testid="chat-column">
        <div
          class="handle group/handle absolute inset-y-0 -left-6 flex w-3 cursor-col-resize touch-none select-none justify-center outline-none"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the chat column"
          :aria-valuemin="CHAT_WIDTH.min"
          :aria-valuemax="CHAT_WIDTH.max"
          :aria-valuenow="chatWidth"
          tabindex="0"
          data-testid="chat-handle"
          @pointerdown="onHandleDown"
          @keydown="onHandleKey"
          @dblclick="setChatWidth(CHAT_WIDTH.default, true)"
        >
          <span
            class="w-px rounded-full bg-(--ui-border-accented) opacity-0 transition-opacity duration-150 ease-out group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100"
            aria-hidden="true"
          />
        </div>
        <PlaneChat class="sticky top-20 h-[calc(100vh-7rem)]" :chat="chat" :at="table.at" :now="now" />
      </aside>
    </div>

    <!-- Below the wide breakpoint the chat folds behind a floating button (record 0070's
         acceptance decision): the button opens it as a sheet; the panels keep their rules. -->
    <template v-if="chat && !wide">
      <UButton
        class="chat-fab fixed bottom-5 right-5 z-20 rounded-full shadow-lg lg:hidden"
        size="lg"
        icon="i-lucide-message-circle"
        aria-label="Open the chat"
        data-testid="chat-fab"
        @click="chatOpen = true"
      />
      <USlideover v-model:open="chatOpen" side="right" title="Chat" :ui="{ content: 'max-w-md' }">
        <template #body>
          <PlaneChat class="h-full" :chat="chat" :at="table.at" :now="now" />
        </template>
      </USlideover>
    </template>
  </AppShell>
  <AppShell v-else title="Plane" nav="plane">
    <p class="text-sm text-muted">The table could not be read.</p>
  </AppShell>
</template>
