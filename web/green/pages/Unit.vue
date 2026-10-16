<script setup lang="ts">
defineOptions({ name: "GreenUnitPage" });
import { computed, nextTick, onBeforeUnmount, reactive, ref } from "vue";
import PageHeading from "../components/PageHeading.vue";
import EmptyState from "../components/EmptyState.vue";
import ReadonlyThread from "../components/ReadonlyThread.vue";
import RunFoldRow from "../../src/components/runs/RunFoldRow.vue";
import FindingsBlock from "../../src/components/unit/FindingsBlock.vue";
import ThreadSearch, { type SearchSession } from "../components/ThreadSearch.vue";
import { useRouter } from "vue-router";
import { recordedPullRequestRun } from "../lib/pullRequest";
import { useSeed, fetchSeed } from "../../src/lib/seed";
import { useWallClock } from "../../src/lib/wallClock";
import { githubPrUrl, githubRepoUrl, githubTreeUrl } from "../../src/lib/githubLinks";
import { unitSessionKeys, type UnitThread } from "@core/core/unitRuns.js";
import { endingWordOf } from "@core/core/pipelineStanding.js";

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

const router = useRouter();
const findingDiff = ref(false);
let active = true;
onBeforeUnmount(() => {
  active = false;
});
const diffNotice = ref("");
async function openRecordedDiff() {
  if (!view?.pr || findingDiff.value) return;
  findingDiff.value = true;
  diffNotice.value = "";
  try {
    const result = await recordedPullRequestRun(view.runs, view.instance.repo, view.pr.number, fetchSeed);
    if (!active) return;
    if (result.kind === "found") await router.push(result.href);
    else if (result.kind === "unavailable")
      diffNotice.value =
        "Some recorded artifacts could not be read. Open the pull request on GitHub for its current diff.";
    else
      diffNotice.value = `No recorded diff was found in the ${result.searched} recent authorized child runs. Open the pull request on GitHub for its current diff.`;
  } finally {
    findingDiff.value = false;
  }
}
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
  view?.instance.id !== undefined ? `/pipelines/${encodeURIComponent(view.instance.id)}` : undefined,
);

/** The unit's standing, in the header: its ending once it has one; else the
 *  round in flight (a live run) or the last round that ran; else not started. */
const standing = computed(() => {
  if (!view) return { cls: "grey", text: "" };
  if (view.mergeCompletion) return { cls: "ok", text: "Merged", at: view.mergeCompletion.at };
  if (view.ending) {
    const ok = view.ending.kind === "merged" || view.ending.kind === "merge_ready" || view.ending.kind === "done";
    // The header prints the user's word for the ending (record 0066), never the internal kind.
    return { cls: ok ? "ok" : "grey", text: endingWordOf(view.ending.kind), at: view.ending.at };
  }
  // An idle unit (record 0051): not ended — the header names the old kind's word as its why.
  if (view.idle) return { cls: "grey", text: `idle · ${endingWordOf(view.idle.why)}`, at: view.idle.at };
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

/** A later try is said as the pipeline's ordinal, never as the scheduler's counter. */
const pipelineOrdinal = computed(() => {
  const n = view?.instance.attempt;
  if (n === undefined) return undefined;
  if (n === 1) return "first";
  if (n === 2) return "second";
  if (n === 3) return "third";
  const mod100 = n % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
});

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
</script>
<template>
  <template v-if="view">
    <PageHeading
      :title="view.title ?? `Unit ${view.id}`"
      :description="`${view.instance.repo} · ${view.branch}`"
      :eyebrow="`UNIT ${view.id}`"
      ><span class="green-badge" :class="STANDING_CLS[standing.cls]">{{ standing.text.replace("coding", "code") }}</span
      ><RouterLink v-if="parentHref" class="green-button" :to="parentHref"
        ><UIcon name="i-lucide-arrow-up-left" />Pipeline</RouterLink
      ><button v-if="view.pr" class="green-button" type="button" :disabled="findingDiff" @click="openRecordedDiff">
        <UIcon name="i-lucide-git-compare" />{{ findingDiff ? "Reading recorded artifacts…" : "Inspect recorded diff" }}
      </button>
      <a v-if="prUrl" class="green-button" :href="prUrl" target="_blank" rel="noopener noreferrer"
        ><UIcon name="i-lucide-git-pull-request" />#{{ view.pr?.number }}</a
      ></PageHeading
    >
    <p v-if="diffNotice" class="green-notice" role="status">{{ diffNotice }}</p>
    <section class="green-section">
      <div class="green-section-heading">
        <h2>Work and provenance</h2>
        <span class="text-xs text-muted">{{ roundCount }} rounds</span>
      </div>
      <div class="green-section-content">
        <dl class="grid sm:grid-cols-[140px_minmax(0,1fr)] gap-x-5 gap-y-3 text-xs">
          <dt class="text-muted">Repository</dt>
          <dd>
            <a v-if="repoUrl" :href="repoUrl" class="text-primary">{{ view.instance.repo }}</a
            ><span v-else>{{ view.instance.repo }}</span>
          </dd>
          <dt class="text-muted">Branch</dt>
          <dd class="break-all">
            <a v-if="treeUrl" :href="treeUrl" class="text-primary">{{ view.branch }}</a
            ><span v-else>{{ view.branch }}</span>
          </dd>
          <template v-if="view.instance.plan"
            ><dt class="text-muted">Plan context</dt>
            <dd>
              {{ view.instance.plan.id }}<span v-if="pipelineOrdinal"> · {{ pipelineOrdinal }} pipeline</span>
            </dd></template
          ><template v-if="issueUrl"
            ><dt class="text-muted">Issue</dt>
            <dd>
              <a class="text-primary" :href="issueUrl">#{{ view.issue }}</a>
            </dd></template
          ><template v-if="view.threads.coding"
            ><dt class="text-muted">Unit thread</dt>
            <dd>
              <RouterLink class="text-primary" :to="`/threads/${encodeURIComponent(view.threads.coding)}`"
                >Read thread →</RouterLink
              ><a v-if="codingUrl" class="ml-3 text-muted" :href="codingUrl" target="_blank" rel="noopener noreferrer"
                >Source ↗</a
              >
            </dd></template
          ><template v-if="view.threads.review"
            ><dt class="text-muted">Review thread</dt>
            <dd>
              <RouterLink class="text-primary" :to="`/threads/${encodeURIComponent(view.threads.review)}`"
                >Read review thread →</RouterLink
              ><a v-if="reviewUrl" class="ml-3 text-muted" :href="reviewUrl" target="_blank" rel="noopener noreferrer"
                >Source ↗</a
              >
            </dd></template
          >
        </dl>
        <p v-if="view.ending?.report" class="whitespace-pre-wrap text-sm mt-5">{{ view.ending.report }}</p>
      </div>
    </section>
    <section v-if="view.pr" id="changes" class="green-section">
      <div class="green-section-heading"><h2>Changes</h2></div>
      <div class="green-section-content flex gap-3 flex-wrap">
        <button class="green-button" type="button" :disabled="findingDiff" @click="openRecordedDiff">
          Recorded changes
        </button>
        <a v-if="prUrl" class="green-button" :href="prUrl" target="_blank" rel="noopener noreferrer"
          >Current pull request ↗</a
        >
        <p class="text-xs text-muted w-full">
          Recorded changes come from this unit's authorized runs. The current pull request may have changed.
        </p>
      </div>
    </section>
    <ReadonlyThread v-if="view.threads.coding" :thread="view.threads.coding" />
    <FindingsBlock v-if="view.findings" :ledger="view.findings" :runs="view.runs" @open="openRun" />
    <section v-if="sessions.length" class="green-section">
      <div class="green-section-heading"><h2>Thread search</h2></div>
      <div class="green-section-content">
        <ThreadSearch :sessions="sessions" :runs="view.runs" :initial="initialSearch" @open="openRun" />
      </div>
    </section>
    <section class="green-section">
      <div class="green-section-heading">
        <div>
          <h2>Conversation and run evidence</h2>
          <p>Rounds appear in the order they happened. Open a finished run to inspect its timeline.</p>
        </div>
      </div>
      <ol v-if="view.runs.length" class="list-none p-0 m-0">
        <RunFoldRow
          v-for="run in view.runs"
          :key="run.id"
          :run="run"
          :now="now"
          :label="`Round ${run.round} · ${run.thread === 'coding' ? 'code' : run.thread}`"
          :open="opened.has(run.id)"
          :land="landing.get(run.id)"
        />
      </ol>
      <EmptyState
        v-else
        title="This unit has not started"
        description="Its first round will appear here when the pipeline begins the unit."
      />
    </section>
  </template>
  <EmptyState
    v-else
    title="Work is unavailable"
    description="This unit is unknown or cannot be viewed with your current access."
  />
</template>
