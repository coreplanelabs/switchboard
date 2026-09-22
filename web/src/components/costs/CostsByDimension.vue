<script setup lang="ts">
import { computed, ref } from "vue";
import type { CostDimension, CostsByReport, CostsByRow } from "@core/core/costsBy.js";
import { monthDayOf, usd } from "../../lib/costs";

// Cost by dimension (costs.md items 10–10a): one row per key — the person who
// started the runs, the thread or channel they ran in, the agent they ran on,
// or the model whose tokens they spent — with the LLM dollars from the runs'
// tokens through the price table, the day's cloud spend allocated by share of
// run wall-clock (a run belongs to one user, thread, channel and agent; on the
// model dimension a run may span models, so cloud is not split and the rows
// carry LLM dollars alone), the total and its share of everything attributed.
// A filter narrows by key or name; on the user dimension **me** keeps the
// signed-in viewer's own rows (their Access email matched to Slack users). The
// range is the history's, not the calendar's: the coverage line says where
// data begins, how many runs are still being priced, and how the attributed
// total reconciles with the group's LLM figure.

const props = defineProps<{ report: CostsByReport }>();

/** What the key column is called, and what the filter narrows by. */
const KEY_HEADING: Record<CostDimension, string> = {
  user: "User",
  thread: "Thread",
  channel: "Channel",
  agent: "Agent",
  model: "Model",
};

const filter = ref("");
const meOnly = ref(false);
const dimension = computed(() => props.report.dimension);
/** The **me** toggle exists on the user dimension alone; it is live when the viewer matched a run user. */
const hasMe = computed(() => props.report.viewer !== undefined);
const canMe = computed(() => (props.report.viewer?.userIds.length ?? 0) > 0);
/** Cloud is split along a dimension a run belongs to exactly once; the model dimension carries LLM alone. */
const showCloud = computed(() => props.report.cloudAllocated);
/** Runs count on a run-keyed dimension; on the model dimension a run may span models, so turns count. */
const countHeading = computed(() => (dimension.value === "model" ? "Turns" : "Runs"));
const countOf = (r: CostsByRow): number => (dimension.value === "model" ? r.turns : r.runs);

const rows = computed<CostsByRow[]>(() => {
  const q = filter.value.trim().toLowerCase();
  const mine = new Set(props.report.viewer?.userIds ?? []);
  return props.report.rows.filter((r) => {
    if (meOnly.value && !mine.has(r.key)) return false;
    if (!q) return true;
    return r.key.toLowerCase().includes(q) || (r.label ?? "").toLowerCase().includes(q);
  });
});
const attributedTotal = computed(() => props.report.rows.reduce((s, r) => s + r.totalUsd, 0));
const shown = computed(() => rows.value.reduce((s, r) => s + r.totalUsd, 0));
const isMe = (r: CostsByRow): boolean => props.report.viewer?.userIds.includes(r.key) ?? false;

/** A platform-namespaced key (`slack:U…`, `slack:C…:1712.34`) reads as its name when known,
 *  else the id without its platform prefix; an agent or a model ref reads as itself. */
const namespaced = computed(
  () => dimension.value === "user" || dimension.value === "thread" || dimension.value === "channel",
);
const labelOf = (r: CostsByRow): string =>
  r.label
    ? dimension.value === "channel"
      ? `#${r.label}`
      : r.label
    : namespaced.value
      ? r.key.replace(/^[a-z]+:/, "")
      : r.key;
const platformOf = (r: CostsByRow): string => (namespaced.value && r.key.includes(":") ? r.key.split(":")[0] : "");
const dayCount = (n: number): string => `${n} day${n === 1 ? "" : "s"}`;
const columns = computed(() => (showCloud.value ? 6 : 5));
</script>

<template>
  <section class="by-dimension grid gap-3" :data-dimension="dimension">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label class="flex items-center gap-2 text-sm text-muted">
        <span>Filter</span>
        <input
          v-model="filter"
          class="key-filter rounded-md border border-default bg-elevated px-2.5 py-1 font-mono text-xs text-highlighted"
          type="search"
          :placeholder="dimension === 'user' ? 'name or id' : KEY_HEADING[dimension].toLowerCase()"
          :aria-label="`Filter by ${KEY_HEADING[dimension].toLowerCase()}`"
        />
      </label>
      <label
        v-if="hasMe"
        class="me-toggle flex items-center gap-2 text-sm"
        :class="canMe ? 'text-muted' : 'text-dimmed'"
        :title="canMe ? 'Only your own runs' : undefined"
      >
        <input
          v-model="meOnly"
          type="checkbox"
          :disabled="!canMe"
          aria-label="Only me"
          :aria-describedby="canMe ? undefined : 'me-hint'"
        />
        <span>me</span>
        <!-- The reason the toggle is off stays visible, not hover-only, so a
             keyboard or screen-reader user meets it too. -->
        <span v-if="!canMe" id="me-hint" class="me-hint text-xs text-dimmed"
          >— your sign-in email matched no Slack user in this range</span
        >
      </label>
      <p class="coverage font-mono text-xs tabular-nums text-muted">
        <template v-if="!report.coverage.historyOn">run history is off — no runs to attribute</template>
        <template v-else>
          runs from {{ monthDayOf(report.coverage.from) }} to {{ monthDayOf(report.range.to)
          }}<template v-if="report.coverage.clamped">
            · earlier days are past the history's {{ report.coverage.retentionDays }}-day window</template
          ><template v-if="report.pending > 0">
            · {{ report.pending }} run{{ report.pending === 1 ? "" : "s" }} still being priced</template
          >
        </template>
      </p>
    </div>

    <div class="overflow-x-auto">
      <table class="by w-full min-w-[40rem] border-collapse whitespace-nowrap font-mono text-[0.8125rem] tabular-nums">
        <thead>
          <tr>
            <th class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-left text-xs font-medium text-muted">
              {{ KEY_HEADING[dimension] }}
            </th>
            <th
              class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-right text-xs font-medium text-muted"
            >
              {{ countHeading }}
            </th>
            <th
              class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-right text-xs font-medium text-muted"
            >
              LLM
            </th>
            <th
              v-if="showCloud"
              class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-right text-xs font-medium text-muted"
            >
              Cloud <span class="font-normal text-dimmed">allocated</span>
            </th>
            <th
              class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-right text-xs font-medium text-muted"
            >
              Total
            </th>
            <th
              class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-right text-xs font-medium text-muted"
            >
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.key" class="by-row" :class="isMe(r) ? 'is-me' : ''">
            <td class="border-b border-muted px-2.5 py-1.5" :title="r.key">
              <span class="text-highlighted">{{ labelOf(r) }}</span>
              <span v-if="platformOf(r)" class="ml-1.5 text-xs text-dimmed">{{ platformOf(r) }}</span>
              <span v-if="isMe(r)" class="ml-1.5 rounded-xs bg-accented px-1 text-xs text-highlighted">me</span>
              <span
                v-if="r.unpricedTokens > 0"
                class="ml-1.5 text-xs text-warn"
                :title="`${r.unpricedTokens} tokens ran under a model with no price`"
                >unpriced tokens</span
              >
            </td>
            <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ countOf(r) }}</td>
            <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ usd(r.llmUsd) }}</td>
            <td v-if="showCloud" class="border-b border-muted px-2.5 py-1.5 text-right">{{ usd(r.cloudUsd) }}</td>
            <td class="border-b border-muted px-2.5 py-1.5 text-right font-medium text-highlighted">
              {{ usd(r.totalUsd) }}
            </td>
            <td class="border-b border-muted px-2.5 py-1.5 text-right">
              {{ attributedTotal > 0 ? Math.round((r.totalUsd / attributedTotal) * 100) : 0 }}%
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td class="empty px-2.5 py-3 text-sm text-muted" :colspan="columns">
              {{
                report.rows.length === 0
                  ? "no runs in this range"
                  : `no ${KEY_HEADING[dimension].toLowerCase()} matches`
              }}
            </td>
          </tr>
        </tbody>
        <tfoot v-if="rows.length > 0 && rows.length < report.rows.length">
          <tr>
            <td class="px-2.5 py-1.5 text-xs text-muted" :colspan="columns - 2">shown</td>
            <td class="px-2.5 py-1.5 text-right text-xs text-muted">{{ usd(shown) }}</td>
            <td class="px-2.5 py-1.5 text-right text-xs text-muted">
              {{ attributedTotal > 0 ? Math.round((shown / attributedTotal) * 100) : 0 }}%
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- One plain line: does the attributed total tie out to the group's figure? -->
    <p class="reconciliation font-mono text-xs tabular-nums text-muted">
      <template v-if="report.reconciliation.comparedDays > 0">
        LLM attributed {{ usd(report.reconciliation.attributedLlmUsd) }} of
        {{ usd(report.reconciliation.workspaceLlmUsd) }} on the workspace over
        {{ dayCount(report.reconciliation.comparedDays) }} ·
        <template v-if="report.reconciliation.unattributedLlmUsd >= 0">
          {{ usd(report.reconciliation.unattributedLlmUsd) }} unattributed (router, review abridges, runs without a
          record, list vs invoice)
        </template>
        <!-- More attributed than the workspace shows: list above invoice, or a
             day on which part of the spend was billed to another workspace (a
             key that moved mid-day). Named, never printed as a negative dollar. -->
        <template v-else>
          {{ usd(-report.reconciliation.unattributedLlmUsd) }} more attributed than the workspace figure (list vs
          invoice, or spend billed outside this workspace on a compared day)
        </template>
      </template>
      <template v-else>no day in range has a workspace LLM figure to compare against</template>
      <template v-if="report.reconciliation.uncomparedDays > 0">
        · {{ dayCount(report.reconciliation.uncomparedDays) }} with {{ usd(report.reconciliation.uncomparedLlmUsd) }} of
        run tokens but no workspace figure (billed outside this workspace) not compared</template
      >
      <template v-if="showCloud">
        · cloud allocated {{ usd(report.reconciliation.cloudAllocatedUsd)
        }}<template v-if="report.reconciliation.cloudUnallocatedUsd > 0">
          · {{ usd(report.reconciliation.cloudUnallocatedUsd) }} on days with no runs</template
        ></template
      >
    </p>
    <p class="text-xs text-dimmed">
      <template v-if="dimension === 'model'">
        A model's LLM is the runs' tokens on it, priced through the price table (the configured rates over Anthropic
        list; cache writes at the 5-minute rate); a run that spent on two models counts under both, and cloud is not
        split by model — a container runs a run, not a model.
      </template>
      <template v-else>
        A {{ KEY_HEADING[dimension].toLowerCase() }}'s LLM is its runs' tokens priced through the price table (the
        configured rates over Anthropic list; cache writes at the 5-minute rate); a child run bills to whoever started
        its parent, in the child's own thread and agent. Cloud is each day's Cloudflare spend split by share of run
        wall-clock — an allocation, not a meter.
      </template>
    </p>
  </section>
</template>
