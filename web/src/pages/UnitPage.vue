<script setup lang="ts">
import { computed, nextTick, reactive } from "vue";
import AppShell from "../components/AppShell.vue";
import GithubMark from "../components/GithubMark.vue";
import SlackMark from "../components/SlackMark.vue";
import RunFoldRow from "../components/runs/RunFoldRow.vue";
import FindingsBlock from "../components/unit/FindingsBlock.vue";
import SessionSearch, { type SearchSession } from "../components/unit/SessionSearch.vue";
import { useSeed } from "../lib/seed";
import { useWallClock } from "../lib/wallClock";
import { githubPrUrl, githubRepoUrl, githubTreeUrl } from "../lib/githubLinks";
import { formatDateTime, formatLocalIso } from "../lib/format";
import { unitSessionKeys, type UnitThread } from "@core/core/unitRuns.js";

// The unit page (agent-ship item 17; record 0034, "the unit is the reading
// unit"): one ship unit's story on one page — the runs of its coding thread
// (and, on a row written before record 0055, its review thread) laid out in time order at the round boundaries the
// runner recorded (coding 0, review 1, coding 1 …), each a row that opens to
// the run's own timeline in place. The header states what the unit is (the
// plan's line for it, its branch, its pull request), where its two threads
// live, and how it stands; a search box reads one thread's session log at a
// time. Everything on the page is the seed `runs unit` answers — the page
// derives nothing from raw events. A unit whose review thread does not exist
// yet lists the coding thread alone; a unit not started lists nothing and
// says so. In-progress work draws where it will end up: a live run is a row
// in its round with its clock moving, never a separate status. The pull
// request's findings ledger (agent-ship item 18) sits between the contract
// and the runs when the seed carries it: one row per finding across every
// round, each trail stop opening the run it names in place.

const seed = useSeed("unit");
const view = seed?.view;
const now = useWallClock(seed?.now);

const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
/** `?open=<run id>[,<run id>]`: rows open on first paint — a shared link to one run's timeline. */
const opened = reactive(
  new Set(
    (params.get("open") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
);
/** The session-log turn each opened fold lands on (session-log item 11): a search
 *  hit's, or `?turn=<n>` beside a single `?open=<id>` — a shareable link to a step. */
const landing = reactive(new Map<string, number>());
const turnParam = params.get("turn");
if (turnParam !== null && /^\d+$/.test(turnParam) && opened.size === 1) landing.set([...opened][0], Number(turnParam));
const initialSearch = { thread: params.get("session") ?? undefined, q: params.get("q") ?? undefined };

const title = computed(() => (view ? `Unit ${view.id}` : "Unit"));
const repoUrl = computed(() => githubRepoUrl(view?.instance.repo));
const treeUrl = computed(() => githubTreeUrl(view?.instance.repo, view?.branch));
const prUrl = computed(() => (view?.pr ? (githubPrUrl(view.instance.repo, view.pr.number) ?? undefined) : undefined));
const issueUrl = computed(() =>
  view?.issue !== undefined && repoUrl.value ? `${repoUrl.value}/issues/${view.issue}` : undefined,
);
/** Only an http(s) permalink becomes a link — a foreign record cannot plant a click target. */
const httpsUrl = (url: string | undefined): string | undefined => (url && /^https?:\/\//.test(url) ? url : undefined);
const codingUrl = computed(() => httpsUrl(view?.sourceUrls.coding));
const reviewUrl = computed(() => httpsUrl(view?.sourceUrls.review));
const parentHref = computed(() =>
  view?.instance.runId !== undefined ? `/runs/${encodeURIComponent(view.instance.runId)}` : undefined,
);

/** The unit's standing, in the header: its ending once it has one; else the
 *  round in flight (a live run) or the last round that ran; else not started. */
const standing = computed(() => {
  if (!view) return { cls: "grey", text: "" };
  if (view.ending) {
    const ok = view.ending.kind === "merged" || view.ending.kind === "merge_ready" || view.ending.kind === "done";
    return { cls: ok ? "ok" : "grey", text: view.ending.kind, at: view.ending.at };
  }
  // An idle unit (record 0051): not ended — the header names the old kind as its why.
  if (view.idle) return { cls: "grey", text: `idle · ${view.idle.why}`, at: view.idle.at };
  const live = view.runs.find((r) => !r.finished);
  if (live) return { cls: "live", text: `round ${live.round} · ${live.thread} running` };
  const last = view.runs.at(-1);
  if (last) return { cls: "grey", text: `round ${last.round} · ${last.thread} ended` };
  return { cls: "grey", text: "not started" };
});
const STANDING_CLS: Record<string, string> = {
  ok: "border-ok/30 text-ok",
  live: "border-ok/30 text-ok motion-safe:animate-pulse",
  grey: "border-accented text-muted",
};

/** The round count the runner drew: distinct round indexes over both threads. */
const roundCount = computed(() => new Set(view?.rounds.map((r) => r.index) ?? []).size);

/** The sessions the search reads: the working keys `<instance>:<unit>:coding`
 *  and `<instance>:<unit>:review` (session-log item 13) — a run of the lane
 *  that names its own session (a row written before the re-key) still wins,
 *  so an in-flight unit keeps searching where its rows are. */
const sessions = computed<SearchSession[]>(() => {
  if (!view) return [];
  const keys = unitSessionKeys(view);
  const out: SearchSession[] = [];
  const add = (thread: UnitThread, opened: string | undefined) => {
    if (opened === undefined) return;
    // A run of the lane names its session; the working key is the lane's name otherwise.
    const known = view.runs.find((r) => r.thread === thread && r.session?.key !== undefined)?.session?.key;
    out.push({ thread, key: known ?? keys[thread] });
  };
  add("coding", view.threads.coding);
  add("review", view.threads.review ?? view.threads.coding);
  return out;
});

/** A search hit opens its run's fold and brings the row into view; the fold
 *  then lands on the hit's turn once the record is read. */
function openRun(runId: string, turn?: number): void {
  if (turn !== undefined) landing.set(runId, turn);
  opened.add(runId);
  void nextTick().then(() => {
    const el = document.getElementById(`run-${runId}`);
    el?.scrollIntoView?.({ block: "center" });
    el?.classList.add("revealed");
    setTimeout(() => el?.classList.remove("revealed"), 1500);
  });
}

function fmtTime(at: number | undefined): string {
  return typeof at === "number" ? formatDateTime(at, now.value) : "";
}
function fmtTimeTitle(at: number | undefined): string | undefined {
  return typeof at === "number" ? formatLocalIso(at) : undefined;
}
</script>

<template>
  <AppShell :title="title" nav="runs">
    <template #leading>
      <RouterLink class="back text-sm text-primary no-underline hover:underline" to="/runs">← All runs</RouterLink>
    </template>
    <template #status>
      <span v-if="view" id="standing" class="flex items-center gap-2 font-mono">
        <span class="chip rounded border px-1.5 text-[0.7rem]" :class="STANDING_CLS[standing.cls]">{{
          standing.text
        }}</span>
        <span v-if="standing.at !== undefined" class="text-xs text-muted" :title="fmtTimeTitle(standing.at)">{{
          fmtTime(standing.at)
        }}</span>
      </span>
    </template>

    <div v-if="view" class="mx-auto max-w-6xl">
      <!-- The facts bar, as the run page heads with (live-view item 19): what
           the unit is and where it lives — repository · branch · #PR · issue ·
           the two threads · the rounds — every link built from a verified shape. -->
      <div
        id="unitmeta"
        class="facts mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1.5 px-(--sb-gutter) font-mono text-xs text-dimmed"
      >
        <span class="unit text-[0.68rem] font-medium uppercase tracking-wider text-toned">unit {{ view.id }}</span>
        <a
          v-if="repoUrl"
          class="repo text-primary no-underline hover:underline"
          :href="repoUrl"
          target="_blank"
          rel="noopener noreferrer"
          >{{ view.instance.repo }}</a
        >
        <span v-else class="repo">{{ view.instance.repo }}</span>
        <a
          v-if="treeUrl"
          class="reftag rounded border border-accented px-1.5 text-[0.75rem] text-toned no-underline hover:border-primary hover:text-primary"
          :href="treeUrl"
          target="_blank"
          rel="noopener noreferrer"
          title="the unit's branch on GitHub"
          >{{ view.branch }}</a
        >
        <span v-else class="reftag rounded border border-accented px-1.5 text-[0.75rem] text-toned">{{
          view.branch
        }}</span>
        <a
          v-if="view.pr && prUrl"
          class="prlink whitespace-nowrap text-primary no-underline hover:underline"
          :href="prUrl"
          target="_blank"
          rel="noopener noreferrer"
          ><GithubMark class="mr-1 align-[-0.125em]" />#{{ view.pr.number }}</a
        >
        <a
          v-if="view.issue !== undefined && issueUrl"
          class="issue whitespace-nowrap text-muted no-underline hover:text-primary hover:underline"
          :href="issueUrl"
          target="_blank"
          rel="noopener noreferrer"
          title="the unit's board issue"
          >issue #{{ view.issue }}</a
        >
        <span class="thread flex items-center gap-1.5" data-thread="coding">
          <SlackMark />
          <a
            v-if="codingUrl"
            class="text-muted no-underline hover:text-primary hover:underline"
            :href="codingUrl"
            target="_blank"
            rel="noopener noreferrer"
            title="open the coding thread"
            >coding thread</a
          >
          <span v-else-if="view.threads.coding" class="text-muted" :title="view.threads.coding">coding thread</span>
          <span v-else class="text-dimmed">coding thread not opened yet</span>
        </span>
        <span v-if="view.threads.review" class="thread flex items-center gap-1.5" data-thread="review">
          <SlackMark />
          <a
            v-if="reviewUrl"
            class="text-muted no-underline hover:text-primary hover:underline"
            :href="reviewUrl"
            target="_blank"
            rel="noopener noreferrer"
            title="open the review thread"
            >review thread</a
          >
          <span v-else class="text-muted" :title="view.threads.review">review thread</span>
        </span>
        <span class="rounds tabular-nums">{{ roundCount }} round{{ roundCount === 1 ? "" : "s" }}</span>
      </div>

      <!-- What the unit is: the plan's line for it, and the plan it belongs to. -->
      <section
        id="contract"
        class="block mb-4 rounded-lg border border-default bg-(--ui-bg-muted) px-(--sb-gutter) py-3"
      >
        <h2 class="mb-2 flex items-baseline gap-2.5 font-mono text-xs font-medium uppercase tracking-wider text-muted">
          <span>Unit {{ view.id }}</span>
          <span class="plan font-normal normal-case tracking-normal text-dimmed">
            <template v-if="view.instance.plan">
              of plan <span class="font-mono">{{ view.instance.plan.id }}</span>
              <template v-if="view.instance.attempt !== undefined"> · attempt {{ view.instance.attempt }}</template>
            </template>
            <template v-else>of a ship request</template>
          </span>
          <RouterLink
            v-if="parentHref"
            class="parent ml-auto font-normal normal-case tracking-normal text-primary no-underline hover:underline"
            :to="parentHref"
            title="the pipeline's own record — its card, its summary, every unit"
            >the plan's record →</RouterLink
          >
        </h2>
        <p v-if="view.title" class="title text-sm text-highlighted">{{ view.title }}</p>
        <p v-else class="title text-sm text-muted">
          The plan gave this unit no title; its branch is {{ view.branch }}.
        </p>
        <p v-if="view.ending" class="report mt-2 whitespace-pre-wrap break-words text-sm text-toned">
          {{ view.ending.report }}
        </p>
      </section>

      <!-- The pull request's findings ledger (agent-ship item 18), when the unit names one. -->
      <FindingsBlock v-if="view.findings" :ledger="view.findings" :runs="view.runs" @open="openRun" />

      <SessionSearch
        v-if="sessions.length > 0"
        :sessions="sessions"
        :runs="view.runs"
        :initial="initialSearch"
        @open="openRun"
      />

      <!-- The runs, at the runner's round boundaries, in time order. -->
      <h2
        id="rounds"
        class="mb-1 flex items-baseline gap-2.5 px-(--sb-gutter) font-mono text-xs font-medium uppercase tracking-wider text-muted"
      >
        <span>Runs by round</span>
        <span class="count font-normal normal-case tracking-normal text-dimmed">
          · {{ view.runs.length }} run{{ view.runs.length === 1 ? "" : "s" }} — the coding thread's and the review
          thread's, as the rounds happened
        </span>
      </h2>
      <ol id="unitruns" class="m-0 list-none border-t border-muted p-0">
        <RunFoldRow
          v-for="run in view.runs"
          :key="run.id"
          :run="run"
          :now="now"
          :label="`round ${run.round} · ${run.thread}`"
          :open="opened.has(run.id)"
          :land="landing.get(run.id)"
        />
        <li v-if="view.runs.length === 0" id="empty" class="empty px-2 py-2 text-sm text-muted">
          No runs yet — the runner has not started this unit.
        </li>
      </ol>
    </div>
  </AppShell>
</template>
