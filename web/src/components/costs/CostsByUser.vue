<script setup lang="ts">
import { computed, ref } from "vue";
import type { UserCostReport, UserCostRow } from "@core/core/costsByUser.js";
import { monthDayOf, usd } from "../../lib/costs";

// Cost by user (costs.md item 10): one row per person who started runs in the
// range — their LLM dollars at list from their runs' tokens, the day's cloud
// spend allocated by their share of run wall-clock, the total and its share of
// everything attributed. A filter narrows by name or id; **me** keeps the
// signed-in viewer's own rows (their Access email matched to Slack users). The
// range is the history's, not the calendar's: the coverage line says where
// data begins, how many runs are still being priced, and how the attributed
// total reconciles with the group's LLM figure.

const props = defineProps<{ report: UserCostReport }>();

const filter = ref("");
const meOnly = ref(false);
const canMe = computed(() => props.report.viewer.userIds.length > 0);

const rows = computed<UserCostRow[]>(() => {
  const q = filter.value.trim().toLowerCase();
  const mine = new Set(props.report.viewer.userIds);
  return props.report.users.filter((u) => {
    if (meOnly.value && !mine.has(u.userId)) return false;
    if (!q) return true;
    return u.userId.toLowerCase().includes(q) || (u.userName ?? "").toLowerCase().includes(q);
  });
});
const attributedTotal = computed(() => props.report.users.reduce((s, u) => s + u.totalUsd, 0));
const shown = computed(() => rows.value.reduce((s, u) => s + u.totalUsd, 0));
const isMe = (u: UserCostRow): boolean => props.report.viewer.userIds.includes(u.userId);

/** `slack:U…` → the name when known, else the id without its platform prefix. */
const labelOf = (u: UserCostRow): string => u.userName ?? u.userId.replace(/^[a-z]+:/, "");
const platformOf = (u: UserCostRow): string => u.userId.split(":")[0] ?? "";
const dayCount = (n: number): string => `${n} day${n === 1 ? "" : "s"}`;
</script>

<template>
  <section class="by-user grid gap-3">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label class="flex items-center gap-2 text-sm text-muted">
        <span>Filter</span>
        <input
          v-model="filter"
          class="user-filter rounded-md border border-default bg-elevated px-2.5 py-1 font-mono text-xs text-highlighted"
          type="search"
          placeholder="name or id"
          aria-label="Filter users"
        />
      </label>
      <label
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
      <table
        class="users w-full min-w-[40rem] border-collapse whitespace-nowrap font-mono text-[0.8125rem] tabular-nums"
      >
        <thead>
          <tr>
            <th class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-left text-xs font-medium text-muted">
              User
            </th>
            <th
              class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-right text-xs font-medium text-muted"
            >
              Runs
            </th>
            <th
              class="border-b border-muted bg-(--ui-bg-muted) px-2.5 py-1.5 text-right text-xs font-medium text-muted"
            >
              LLM
            </th>
            <th
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
          <tr v-for="u in rows" :key="u.userId" class="user-row" :class="isMe(u) ? 'is-me' : ''">
            <td class="border-b border-muted px-2.5 py-1.5" :title="u.userId">
              <span class="text-highlighted">{{ labelOf(u) }}</span>
              <span class="ml-1.5 text-xs text-dimmed">{{ platformOf(u) }}</span>
              <span v-if="isMe(u)" class="ml-1.5 rounded-xs bg-accented px-1 text-xs text-highlighted">me</span>
              <span
                v-if="u.unpricedTokens > 0"
                class="ml-1.5 text-xs text-warn"
                :title="`${u.unpricedTokens} tokens ran under a model with no list price`"
                >unpriced tokens</span
              >
            </td>
            <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ u.runs }}</td>
            <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ usd(u.llmUsd) }}</td>
            <td class="border-b border-muted px-2.5 py-1.5 text-right">{{ usd(u.cloudUsd) }}</td>
            <td class="border-b border-muted px-2.5 py-1.5 text-right font-medium text-highlighted">
              {{ usd(u.totalUsd) }}
            </td>
            <td class="border-b border-muted px-2.5 py-1.5 text-right">
              {{ attributedTotal > 0 ? Math.round((u.totalUsd / attributedTotal) * 100) : 0 }}%
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td class="empty px-2.5 py-3 text-sm text-muted" colspan="6">
              {{ report.users.length === 0 ? "no runs in this range" : "no user matches" }}
            </td>
          </tr>
        </tbody>
        <tfoot v-if="rows.length > 0 && rows.length < report.users.length">
          <tr>
            <td class="px-2.5 py-1.5 text-xs text-muted" colspan="4">shown</td>
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
      · cloud allocated {{ usd(report.reconciliation.cloudAllocatedUsd)
      }}<template v-if="report.reconciliation.cloudUnallocatedUsd > 0">
        · {{ usd(report.reconciliation.cloudUnallocatedUsd) }} on days with no runs</template
      >
    </p>
    <p class="text-xs text-dimmed">
      A user's LLM is their runs' tokens at Anthropic list (cache writes at the 5-minute rate); a child run bills to
      whoever started its parent. Cloud is each day's Cloudflare spend split by share of run wall-clock — an allocation,
      not a meter.
    </p>
  </section>
</template>
