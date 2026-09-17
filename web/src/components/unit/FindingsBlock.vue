<script setup lang="ts">
import { computed } from "vue";
import GithubMark from "../GithubMark.vue";
import type { FindingsLedgerView } from "@core/core/runsService.js";
import type { FindingRow, FindingSighting, FindingDispositionRef, FindingStatus } from "@core/core/findingsLedger.js";
import { FINDING_STATUSES } from "@core/core/findingsLedger.js";
import type { UnitRunRowSeed } from "@core/channels/webSeed.js";

// The unit page's Findings block (agent-ship item 18): the pull request's
// ledger as `runs findings` answers it — one row per finding id across every
// round, its status a function of what the records say — drawn beside the
// runs it was read from. Each row's trail names where the finding was raised,
// what the coding run recorded against it and where the next review saw it;
// a run on this page opens its fold in place (as a search hit does), a run
// outside it links to its own page. The block derives nothing: the seed is
// the ledger, the page binds text as text.

const props = defineProps<{ ledger: FindingsLedgerView; runs: UnitRunRowSeed[] }>();
const emit = defineEmits<{ open: [runId: string] }>();

const STATUS_CLS: Record<FindingStatus, string> = {
  open: "border-warn/30 text-warn",
  "awaiting re-review": "border-accented text-toned",
  fixed: "border-ok/30 text-ok",
  conceded: "border-ok/30 text-ok",
  "re-raised": "border-warn/30 text-warn",
  "not re-raised": "border-accented text-muted",
  "unknown id": "border-accented text-muted",
};
const SEVERITY_CLS: Record<string, string> = {
  blocking: "text-bad",
  major: "text-warn",
  minor: "text-toned",
  nit: "text-muted",
};

const rows = computed(() => props.ledger.findings);
/** The tally in the header, in the vocabulary's own order, statuses with no row left out. */
const tally = computed(() => {
  const counts = new Map<FindingStatus, number>();
  for (const r of rows.value) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return FINDING_STATUSES.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(" · ");
});
const runById = computed(() => new Map(props.runs.map((r) => [r.id, r])));

/** How a row reads its status: a re-raise names the kind it answered. */
function statusText(r: FindingRow): string {
  return r.status === "re-raised" && r.reRaisedAfter ? `re-raised after ${r.reRaisedAfter}` : r.status;
}
function where(r: FindingRow): string | undefined {
  if (r.file === undefined) return undefined;
  return r.line !== undefined ? `${r.file}:${r.line}` : r.file;
}

interface TrailStop {
  runId: string;
  /** What the stop was: raised, the disposition's kind, or seen again. */
  what: string;
  /** `round n · thread` for a run on this page, else its id. */
  label: string;
  onPage: boolean;
}

/** The runs a finding passed through, in order and each once: where it was
 *  raised, the run that recorded its disposition, where it was last seen when
 *  that is a later review. */
function trail(r: FindingRow): TrailStop[] {
  const stops: TrailStop[] = [];
  const add = (s: FindingSighting | FindingDispositionRef | undefined, what: string) => {
    if (!s || stops.some((x) => x.runId === s.runId)) return;
    const run = runById.value.get(s.runId);
    const label =
      run && run.round !== undefined && run.thread
        ? `round ${run.round} · ${run.thread}`
        : s.round !== undefined
          ? `round ${s.round}`
          : s.runId;
    stops.push({ runId: s.runId, what, label, onPage: run !== undefined });
  };
  add(r.raised, "raised");
  add(r.disposition, r.disposition?.kind ?? "");
  add(r.lastSeen, r.status === "re-raised" ? "re-raised" : "seen");
  return stops;
}

function follow(stop: TrailStop, event: Event): void {
  if (!stop.onPage) return; // a plain link to the run's own page
  event.preventDefault();
  emit("open", stop.runId);
}
</script>

<template>
  <section id="findings" class="block mb-4 rounded-lg border border-default bg-(--ui-bg-muted) px-(--sb-gutter) py-3">
    <h2
      class="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 font-mono text-xs font-medium uppercase tracking-wider text-muted"
    >
      <span>Findings</span>
      <span class="count font-normal normal-case tracking-normal text-dimmed"
        >· {{ rows.length }} finding{{ rows.length === 1 ? "" : "s" }} — what each review raised, what the coding run
        recorded against it, whether the next review agreed</span
      >
      <a
        class="prlink ml-auto whitespace-nowrap font-normal normal-case tracking-normal text-primary no-underline hover:underline"
        :href="ledger.pr.url ?? `https://github.com/${ledger.repo}/pull/${ledger.pr.number}`"
        target="_blank"
        rel="noopener noreferrer"
        ><GithubMark class="mr-1 align-[-0.125em]" />{{ ledger.repo }}#{{ ledger.pr.number }}</a
      >
    </h2>
    <p v-if="tally" class="tally mb-2 font-mono text-[0.72rem] text-dimmed">{{ tally }}</p>
    <ol class="m-0 list-none p-0">
      <li
        v-for="r in rows"
        :key="r.id"
        class="finding flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-t border-default py-1.5 first:border-t-0"
        :data-finding-id="r.id"
        :data-status="r.status"
      >
        <span
          class="fid shrink-0 rounded border border-accented px-1.5 font-mono text-[0.72rem] font-medium text-toned"
          >{{ r.id }}</span
        >
        <span
          v-if="r.severity"
          class="severity shrink-0 font-mono text-[0.72rem] uppercase tracking-wider"
          :class="SEVERITY_CLS[r.severity] ?? 'text-muted'"
          >{{ r.severity }}</span
        >
        <span v-if="where(r)" class="where shrink-0 font-mono text-xs text-toned">{{ where(r) }}</span>
        <span v-if="r.title !== undefined" class="title min-w-0 flex-1 text-sm text-highlighted">{{ r.title }}</span>
        <span
          class="status shrink-0 rounded border px-1.5 font-mono text-[0.7rem]"
          :class="STATUS_CLS[r.status] ?? 'border-accented text-muted'"
          >{{ statusText(r) }}</span
        >
        <span class="trail flex basis-full flex-wrap items-baseline gap-x-1.5 font-mono text-[0.72rem] text-dimmed">
          <template v-for="(stop, i) in trail(r)" :key="stop.runId">
            <span v-if="i > 0" aria-hidden="true">·</span>
            <span>{{ stop.what }} in</span>
            <a
              class="run text-muted no-underline hover:text-primary hover:underline"
              :class="{ onpage: stop.onPage }"
              :href="stop.onPage ? `#run-${stop.runId}` : `/runs/${encodeURIComponent(stop.runId)}`"
              :data-run-id="stop.runId"
              :title="stop.onPage ? 'open this run\'s fold on this page' : 'open this run\'s page'"
              @click="follow(stop, $event)"
              >{{ stop.label }}</a
            >
          </template>
        </span>
        <span v-if="r.disposition" class="note basis-full text-sm text-toned"
          >{{ r.disposition.kind }} — {{ r.disposition.note }}</span
        >
      </li>
      <li v-if="rows.length === 0" class="empty py-1.5 text-sm text-muted">The reviews listed no findings.</li>
    </ol>
  </section>
</template>
