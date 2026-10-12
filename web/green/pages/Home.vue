<script setup lang="ts">
defineOptions({ name: "GreenHomePage" });
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import type { HomeSnapshot } from "@core/core/home/service.js";
import type { HomeUnit } from "@core/core/home/service.js";
import type {
  HomeFleetSeed,
  HomeMergeAction,
  HomeConfirmationOffer,
  HomeConfirmationChoice,
} from "@core/channels/homeSeed.js";
import MergeAction from "../components/MergeAction.vue";
import { SeedKey } from "../../src/lib/seed";
import PageHeading from "../components/PageHeading.vue";
import { useHomeSession } from "../lib/homeSession";
import { useViewingAs } from "../../src/lib/seed";
import InlineAnswer from "../components/InlineAnswer.vue";
import EmptyState from "../components/EmptyState.vue";
import UnitList from "../components/UnitList.vue";
import { githubRepoUrl, githubPrUrl, githubTreeUrl } from "../../src/lib/githubLinks";
const globalSeed = inject(SeedKey, null);
const seed = globalSeed as unknown as HomeFleetSeed | null;
const historyHref = (() => {
  try {
    return `/home/history?tz=${encodeURIComponent(new Intl.DateTimeFormat().resolvedOptions().timeZone)}`;
  } catch {
    return "/home/history";
  }
})();
const home = useHomeSession();
const viewingAs = useViewingAs();
const refreshed = ref<HomeSnapshot | null>(null);
const refreshNotice = ref("");
type SavedAction = {
  action: HomeMergeAction;
  offer: HomeConfirmationOffer;
  pending: HomeConfirmationChoice;
  label: string;
};
const savedActions = ref<Record<string, SavedAction>>({});
let active = true,
  refreshGeneration = 0;
const privacy = () => {
  if (home?.recoveringPrivacy.value) return home.recoveringPrivacy.value;
  const session = home?.session.value;
  return session
    ? JSON.stringify([
        session.actor,
        session.organization,
        session.stream,
        session.bindingRevision,
        session.accessEpoch,
      ])
    : null;
};
const sourceGeneration = ref(0);
const actionScope = computed(() =>
  JSON.stringify([
    globalSeed?.asUser?.id,
    globalSeed?.dataView?.mode,
    globalSeed?.viewingAs?.id,
    sourceGeneration.value,
    home?.scopeChanging.value,
  ]),
);
const workInvalidated = ref(false);
const recoveryHeld = ref(false);
const recoveredWork = ref(false);
const lostAnswerUnit = ref<string | null>(null);
let lastAnswerUnit: string | null = null;
watch(
  [() => home?.inlineAnswer.value?.unit, () => home?.focused.value],
  ([unit, focused]) => {
    if (unit) lastAnswerUnit = unit;
    else if (!focused) lastAnswerUnit = null;
  },
  { flush: "sync" },
);
watch(
  () => home?.recoveringPrivacy.value,
  (next, previous) => {
    if (next) {
      refreshGeneration++;
      recoveryHeld.value = true;
      lostAnswerUnit.value = lastAnswerUnit;
      refreshNotice.value = "Checking current work access.";
    } else if (previous && privacy() === previous && home?.status.value === "ready") {
      void refreshWork();
    }
  },
  { flush: "sync" },
);
function hideWork() {
  workInvalidated.value = true;
  savedActions.value = {};
  const previous = refreshed.value ?? seed?.snapshot;
  if (previous)
    refreshed.value = { ...previous, status: "unavailable", needsYou: [], moving: [], waiting: [], pipelines: [] };
}
watch(actionScope, () => {
  refreshGeneration++;
  hideWork();
  refreshNotice.value = "Work access changed. This page's data is hidden.";
});
let hasSession = false;
watch(
  privacy,
  (next, previous) => {
    const session = home?.session.value;
    if (
      session &&
      (session.actor !== globalSeed?.asUser?.id || session.organization !== seed?.snapshot.organizationId)
    ) {
      sourceGeneration.value++;
      hideWork();
      refreshNotice.value = "Work access changed. This page's data is hidden.";
      return;
    }
    // The first matching frame initializes this page's source scope. It cannot
    // authorize work from a page served to a different account or organization.
    if (previous === undefined || (!hasSession && next !== null && !home?.scopeChanging.value)) {
      hasSession = !!session;
      return;
    }
    sourceGeneration.value++;
  },
  { immediate: true },
);
function saveAction(
  unit: string,
  saved: { offer: HomeConfirmationOffer; pending: HomeConfirmationChoice },
  scope: string | null | undefined,
) {
  const action = seed?.actions?.[unit];
  if (
    workInvalidated.value ||
    !active ||
    !action ||
    scope !== actionScope.value ||
    viewingAs ||
    home?.scopeChanging.value
  )
    return;
  savedActions.value = {
    ...savedActions.value,
    [unit]: {
      ...saved,
      action,
      label:
        savedActions.value[unit]?.label ??
        snapshot.value?.needsYou.find((row) => row.unit.unit === unit)?.unit.title ??
        unit,
    },
  };
}
function settleAction(unit: string) {
  const next = { ...savedActions.value };
  delete next[unit];
  savedActions.value = next;
}
function readableMergeRow(key: string, action: HomeMergeAction) {
  const row = [
    ...(refreshed.value?.needsYou ?? []),
    ...(refreshed.value?.moving ?? []),
    ...(refreshed.value?.waiting ?? []),
  ].find((item) => item.unit.unit === key);
  const original = [
    ...(seed?.snapshot.needsYou ?? []),
    ...(seed?.snapshot.moving ?? []),
    ...(seed?.snapshot.waiting ?? []),
  ].find((item) => item.unit.unit === key);
  // IDs and PRs survive private redaction. They cannot prove an old offer readable.
  const merge = row?.conditions.find(
    (condition) =>
      condition.id === `${key}:merge` &&
      condition.unitKey === key &&
      condition.state === "open" &&
      condition.owner.kind === "person" &&
      (seed?.attentionRecipients ?? [seed?.attentionRecipient]).includes(condition.owner.id),
  );
  return row &&
    merge &&
    row.unit.ending?.kind === "merge_ready" &&
    original &&
    row.instance.repo === original.instance.repo &&
    row.unit.branch === original.unit.branch &&
    JSON.stringify(row.unit.threads) === JSON.stringify(original.unit.threads) &&
    `${row.instance.repo}#${row.unit.pr?.number}` === action.pr &&
    JSON.stringify(row.conditions) === JSON.stringify(original.conditions)
    ? row
    : null;
}
const readableSavedActions = computed(() => {
  if (recoveryHeld.value) return {};
  if (!recoveredWork.value) return savedActions.value;
  return Object.fromEntries(
    Object.entries(savedActions.value).flatMap(([key, saved]) => {
      const row = readableMergeRow(key, saved.action);
      return row ? [[key, { ...saved, label: row.unit.title ?? row.unit.unit }]] : [];
    }),
  );
});
const unprovedSavedActions = computed(
  () =>
    recoveredWork.value &&
    !recoveryHeld.value &&
    Object.keys(savedActions.value).some((key) => !readableSavedActions.value[key]),
);
const answerTargets = computed(() =>
  Object.fromEntries(
    Object.entries(seed?.answers ?? {}).filter(([key, target]) => {
      if (key === lostAnswerUnit.value) return false;
      if (!recoveredWork.value) return true;
      const row = [
        ...(refreshed.value?.needsYou ?? []),
        ...(refreshed.value?.moving ?? []),
        ...(refreshed.value?.waiting ?? []),
      ].find((item) => item.unit.unit === key);
      const original = [
        ...(seed?.snapshot.needsYou ?? []),
        ...(seed?.snapshot.moving ?? []),
        ...(seed?.snapshot.waiting ?? []),
      ].find((item) => item.unit.unit === key);
      return (
        row?.unit.threads.coding === target.thread &&
        !!original &&
        JSON.stringify(row.conditions) === JSON.stringify(original.conditions) &&
        row.conditions.some(
          (condition) =>
            condition.id === `${key}:question` &&
            condition.unitKey === key &&
            condition.state === "open" &&
            condition.owner.kind === "person" &&
            (seed?.attentionRecipients ?? [seed?.attentionRecipient]).includes(condition.owner.id),
        )
      );
    }),
  ),
);
const mergeActions = computed(() =>
  Object.fromEntries(
    Object.entries(seed?.actions ?? {}).filter(
      ([key, action]) => key !== lostAnswerUnit.value && (!recoveredWork.value || !!readableMergeRow(key, action)),
    ),
  ),
);
const savedOutsideList = computed(() =>
  Object.entries(readableSavedActions.value).filter(
    ([key]) => !snapshot.value?.needsYou.some((row) => row.unit.unit === key),
  ),
);
onBeforeUnmount(() => {
  active = false;
  refreshGeneration++;
});
async function refreshWork(unit?: string) {
  if (workInvalidated.value || viewingAs || globalSeed?.dataView?.mode === "person" || home?.scopeChanging.value)
    return;
  const request = ++refreshGeneration,
    scope = actionScope.value,
    source = privacy();
  const current = () =>
    active &&
    request === refreshGeneration &&
    !home?.scopeChanging.value &&
    actionScope.value === scope &&
    privacy() === source;
  try {
    const response = await fetch(unit ? `/home/snapshot?observe=${encodeURIComponent(unit)}` : "/home/snapshot", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!current()) return;
    if (response.status === 403 || response.status === 404) {
      if (unit === undefined) {
        refreshNotice.value = "Current work access could not be confirmed.";
        return;
      }
      hideWork();
      refreshNotice.value = "Work access changed. This page's data is hidden.";
      return;
    }
    const value = await response.json();
    if (!current()) return;
    if (
      !response.ok ||
      value.organizationId !== seed?.snapshot.organizationId ||
      !["complete", "partial"].includes(value.status) ||
      !Array.isArray(value.needsYou) ||
      !Array.isArray(value.moving) ||
      !Array.isArray(value.waiting) ||
      !Array.isArray(value.pipelines)
    ) {
      refreshNotice.value =
        unit === undefined
          ? "Current work access could not be confirmed."
          : "Merge recorded. Completion could not be verified.";
      return;
    }
    refreshed.value = value;
    if (unit === undefined) {
      recoveredWork.value = true;
      recoveryHeld.value = false;
      refreshNotice.value = "Current work access checked.";
      return;
    }
    refreshNotice.value =
      value.observation === "observed"
        ? "Completed work updated."
        : "Merge recorded. Completion has not been verified.";
  } catch {
    if (current())
      refreshNotice.value =
        unit === undefined
          ? "Current work access could not be confirmed."
          : "Merge recorded. Completion could not be verified.";
  }
}
const savedReplyOutsideList = computed(
  () =>
    !workInvalidated.value &&
    home?.inlineAnswer.value &&
    (home.pendingSubmission.value || !!home.notice.value) &&
    !viewingAs &&
    (!globalSeed?.dataView || globalSeed.dataView.mode !== "person") &&
    ![...(snapshot.value?.needsYou ?? []), ...(snapshot.value?.moving ?? []), ...(snapshot.value?.waiting ?? [])].some(
      (row) => row.unit.unit === home.inlineAnswer.value?.unit,
    ),
);
const snapshot = computed(() => {
  const value = refreshed.value ?? seed?.snapshot ?? null;
  return recoveryHeld.value && value
    ? { ...value, status: "unavailable", needsYou: [], moving: [], waiting: [], pipelines: [] }
    : value;
});
const count = computed(() =>
  snapshot.value ? snapshot.value.needsYou.length + snapshot.value.moving.length + snapshot.value.waiting.length : 0,
);
const pipelines = computed(() => {
  const rows = new Map<string, HomeUnit[]>();
  for (const row of [
    ...(snapshot.value?.needsYou ?? []),
    ...(snapshot.value?.moving ?? []),
    ...(snapshot.value?.waiting ?? []),
  ]) {
    const group = rows.get(row.instance.id) ?? [];
    group.push(row);
    rows.set(row.instance.id, group);
  }
  return (snapshot.value?.pipelines ?? []).map((pipeline) => ({
    ...pipeline,
    rows: rows.get(pipeline.instance.id) ?? [],
  }));
});
const replyThread = (row: HomeUnit) =>
  recoveredWork.value ? row.unit.threads.coding : (seed?.answers?.[row.unit.unit]?.thread ?? row.unit.threads.coding);
</script>
<template>
  <PageHeading title="Home" description="What needs you, what is moving, and what happens next."
    ><RouterLink class="green-button" :to="historyHref"><UIcon name="i-lucide-history" />Completed work</RouterLink
    ><RouterLink class="green-button" to="/home/threads"
      ><UIcon name="i-lucide-search" />Find a thread</RouterLink
    ></PageHeading
  >
  <p v-if="refreshNotice" class="green-notice" role="status">{{ refreshNotice }}</p>
  <p v-if="unprovedSavedActions" class="green-notice" role="status">
    Saved action result is unknown. Its work cannot be confirmed with current access.
  </p>
  <section v-if="savedOutsideList.length" class="green-section" aria-label="Saved actions with unknown results">
    <h2>Saved actions with unknown results</h2>
    <div v-for="[unit, saved] in savedOutsideList" :key="unit" class="mt-3">
      <RouterLink :to="`/runs/unit/${encodeURIComponent(unit)}`">{{ saved.label }}</RouterLink>
      <MergeAction
        :action="saved.action"
        :scope="actionScope"
        :saved="saved"
        @merged="refreshWork(unit)"
        @settled="settleAction(unit)"
        @unknown="(value, scope) => saveAction(unit, value, scope)"
      />
    </div>
  </section>
  <template v-if="snapshot">
    <p v-if="snapshot.status === 'partial'" class="green-notice green-warning" role="status">
      Some work could not be loaded. These rows do not prove that all work is accounted for.
    </p>
    <p v-else-if="snapshot.status === 'unavailable'" class="green-notice green-warning" role="alert">
      Work is unavailable. Attention and progress cannot be confirmed.
    </p>
    <p v-if="snapshot.access === 'filtered'" class="text-xs text-muted mb-4">
      This view includes only work you can access.
    </p>
    <template v-if="count"
      ><UnitList
        :rows="snapshot.needsYou"
        :answers="answerTargets"
        :actions="mergeActions"
        :action-scope="actionScope"
        :saved-actions="readableSavedActions"
        label="Needs you"
        urgent
        :attention-recipient="seed?.attentionRecipient"
        :attention-recipients="seed?.attentionRecipients"
        @merged="refreshWork"
        @settled="settleAction"
        @unknown="saveAction" /><UnitList
        :rows="snapshot.moving"
        label="Moving"
        :attention-recipient="seed?.attentionRecipient"
        :attention-recipients="seed?.attentionRecipients"
        activity="moving" /><UnitList
        :rows="snapshot.waiting"
        label="Other waits"
        :attention-recipient="seed?.attentionRecipient"
        :attention-recipients="seed?.attentionRecipients"
    /></template>
    <section v-else-if="snapshot.status === 'complete'" class="green-section">
      <EmptyState
        :title="snapshot.access === 'filtered' ? 'No unresolved work in your view' : 'All caught up'"
        :description="
          snapshot.access === 'filtered'
            ? 'No unresolved units are visible with your current access.'
            : 'There are no unresolved units in the complete work projection.'
        "
        icon="i-lucide-circle-check"
      />
    </section>
    <section v-if="savedReplyOutsideList && home?.inlineAnswer.value" class="green-section" aria-label="Saved reply">
      <div class="green-section-heading">
        <h2>Saved reply · {{ home.inlineAnswer.value.title }}</h2>
        <RouterLink class="green-button" :to="`/threads/${encodeURIComponent(home.inlineAnswer.value.thread)}`"
          >Original thread</RouterLink
        >
      </div>
      <div class="p-4">
        <InlineAnswer v-if="home.pendingSubmission.value" />
        <template v-else
          ><p role="status" class="text-sm">{{ home.notice.value }}</p>
          <button type="button" class="green-button mt-3" @click="home.preserveInlineAnswer()">
            Return to messages
          </button></template
        >
      </div>
    </section>
    <section v-if="snapshot.pipelines.length" class="green-section">
      <div class="green-section-heading">
        <div>
          <h2>Pipelines</h2>
          <p>Open a pipeline to see its work, next actions, threads, pull requests, and changes.</p>
        </div>
      </div>
      <div class="green-pipeline-cards">
        <article v-for="pipeline in pipelines" :key="pipeline.instance.id" class="green-pipeline-card">
          <RouterLink class="green-unit-title" :to="`/pipelines/${encodeURIComponent(pipeline.instance.id)}`">{{
            pipeline.instance.label ?? pipeline.instance.plan?.id ?? pipeline.instance.id
          }}</RouterLink>
          <p class="text-xs text-muted mt-1">
            <a
              v-if="githubRepoUrl(pipeline.instance.repo)"
              :href="githubRepoUrl(pipeline.instance.repo)!"
              target="_blank"
              rel="noopener noreferrer"
              ><UIcon name="i-lucide-folder-git-2" class="mr-1" />{{ pipeline.instance.repo }}</a
            ><span v-else>{{ pipeline.instance.repo }}</span>
          </p>
          <p class="text-xs mt-3">
            {{ pipeline.needsYou }} needs you · {{ pipeline.moving }} moving · {{ pipeline.waiting }} waiting
          </p>
          <ul class="green-pipeline-work" aria-label="Pipeline work links">
            <li v-for="row in pipeline.rows.slice(0, 3)" :key="row.unit.unit">
              <RouterLink class="green-unit-title" :to="`/runs/unit/${encodeURIComponent(row.unit.unit)}`">{{
                row.unit.title ?? `Unit ${row.unit.id}`
              }}</RouterLink>
              <p v-if="row.nextAction.kind === 'recorded'" class="text-xs text-muted mt-1">{{ row.nextAction.text }}</p>
              <div class="green-pipeline-work-links">
                <RouterLink
                  v-if="replyThread(row)"
                  :to="`/threads/${encodeURIComponent(replyThread(row)!)}`"
                  aria-label="Original unit thread"
                  title="Original unit thread"
                >
                  <UIcon name="i-lucide-messages-square" /><span>Thread</span>
                </RouterLink>
                <RouterLink
                  v-if="row.unit.threads.review"
                  :to="`/threads/${encodeURIComponent(row.unit.threads.review)}`"
                  aria-label="Review thread"
                  title="Review thread"
                  ><UIcon name="i-lucide-message-square-check" /><span class="sr-only">Review thread</span></RouterLink
                >
                <a
                  v-if="githubTreeUrl(row.instance.repo, row.unit.branch)"
                  :href="githubTreeUrl(row.instance.repo, row.unit.branch)!"
                  target="_blank"
                  rel="noopener noreferrer"
                  ><UIcon name="i-lucide-git-branch" />{{ row.unit.branch }}</a
                >
                <a
                  v-if="row.unit.pr && githubPrUrl(row.instance.repo, row.unit.pr.number)"
                  :href="githubPrUrl(row.instance.repo, row.unit.pr.number)!"
                  target="_blank"
                  rel="noopener noreferrer"
                  ><UIcon name="i-lucide-git-pull-request" />#{{ row.unit.pr.number }}</a
                >
                <RouterLink
                  v-if="row.unit.pr"
                  :to="`/runs/unit/${encodeURIComponent(row.unit.unit)}#changes`"
                  aria-label="Changes"
                  title="Changes"
                  ><UIcon name="i-lucide-git-compare" /><span>Changes</span></RouterLink
                >
              </div>
            </li>
          </ul>
          <RouterLink
            v-if="pipeline.rows.length > 3"
            class="text-xs text-primary"
            :to="`/pipelines/${encodeURIComponent(pipeline.instance.id)}`"
            >View {{ pipeline.rows.length - 3 }} more</RouterLink
          >
        </article>
      </div>
    </section>
  </template>
  <EmptyState
    v-else
    title="Work could not be loaded"
    description="The page has no work projection. Attention and progress cannot be confirmed."
  />
</template>

<style scoped>
.green-pipeline-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  gap: 16px;
  padding: 16px;
}
.green-pipeline-card {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
}
.green-pipeline-work {
  margin-top: 12px;
}
.green-pipeline-work li {
  padding: 10px 0;
  border-top: 1px solid var(--ui-border-muted);
}
.green-pipeline-work p {
  overflow-wrap: anywhere;
}
.green-pipeline-work-links {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: var(--ui-primary);
  font-size: 11px;
}
.green-pipeline-work-links a {
  min-height: 40px;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  overflow-wrap: anywhere;
}
</style>
