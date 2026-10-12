<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, watch } from "vue";
import { SeedKey, useViewingAs } from "../../src/lib/seed";
import { useHomeSession } from "../lib/homeSession";
import type { HomePrimaryAction } from "@core/channels/homeSeed.js";
import ConfirmationPrompt from "./ConfirmationPrompt.vue";
const props = withDefaults(
  defineProps<{ capturedRevision?: number; primaryAction?: HomePrimaryAction; autofocus?: boolean }>(),
  { autofocus: true, capturedRevision: undefined, primaryAction: undefined },
);
const home = useHomeSession();
const viewingAs = useViewingAs();
const globalSeed = inject(SeedKey, null);
const writableView = computed(() => !viewingAs && (!globalSeed?.dataView || globalSeed.dataView.mode !== "person"));
const composer = ref<HTMLTextAreaElement | null>(null);
const controls = ref<HTMLElement | null>(null);
const replyDisclosure = ref<HTMLButtonElement | null>(null);
const primaryAction = computed(() => props.primaryAction ?? home?.session.value?.destination.primaryAction);
const repositories = computed(() => home?.session.value?.repositories);
const selectedRepository = computed(() => home?.context.value.find((ref) => ref.kind === "repository")?.key ?? "");
function chooseRepository(repo: string) {
  if (
    !home ||
    home.sending.value ||
    home.pendingSubmission.value ||
    repositories.value?.status !== "complete" ||
    (repo && !repositories.value.repositories.some((row) => row.repo === repo))
  )
    return;
  const remaining = home.context.value.filter((ref) => ref.kind !== "repository");
  if (repo && remaining.length >= 8) return;
  home.context.value = repo ? [...remaining, { kind: "repository", key: repo, label: repo }] : remaining;
}
const retryOnly = computed(
  () => !!home?.pendingSubmission.value && home.status.value === "ready" && !home.session.value?.destination.canWrite,
);
const canSubmit = computed(() => home?.session.value?.destination.canWrite || retryOnly.value);
const buttonFirst = computed(() => !!primaryAction.value || !!home?.offer.value);
const editorOpen = ref<boolean | null>(null),
  acceptedQuestion = ref<string | null>(null);
const questionIdentity = computed(() => {
  const session = home?.session.value;
  return JSON.stringify([
    session?.actor,
    session?.organization,
    session?.stream,
    session?.bindingRevision,
    session?.accessEpoch,
    session?.destination.thread,
    session?.destination.revision,
    primaryAction.value?.label,
    primaryAction.value?.text,
    home?.offer.value?.id,
  ]);
});
const answered = computed(() => acceptedQuestion.value === questionIdentity.value);
let attemptedQuestion: string | null = null;
const editorVisible = computed(
  () =>
    !buttonFirst.value ||
    (editorOpen.value ??
      (!!home?.text.value.trim() && (!primaryAction.value || home.text.value !== primaryAction.value.text))),
);
watch(
  () => home?.session.value?.destination.thread,
  () => {
    editorOpen.value = null;
    acceptedQuestion.value = null;
    attemptedQuestion = null;
  },
);
async function openEditor() {
  editorOpen.value = !editorVisible.value;
  await nextTick();
  composer.value?.focus();
}
async function chooseAnswer() {
  if (!home || home.sending.value || !primaryAction.value) return;
  if (home.pendingSubmission.value) {
    const originalQuestion = attemptedQuestion;
    await home.submit();
    if (!home.pendingSubmission.value && !home.text.value) acceptedQuestion.value = originalQuestion;
    return;
  }
  if (questionChanged.value || home.draftStale.value) return;
  const originalQuestion = questionIdentity.value;
  attemptedQuestion = originalQuestion;
  home.text.value = primaryAction.value.text;
  await home.submit(primaryAction.value.text);
  if (!home.pendingSubmission.value && !home.text.value) acceptedQuestion.value = originalQuestion;
}
const questionChanged = computed(
  () => props.capturedRevision !== undefined && props.capturedRevision !== home?.session.value?.destination.revision,
);
const commands = computed(() =>
  home?.text.value.startsWith("/")
    ? (home.session.value?.commands
        .filter((command) => command.chat.startsWith(home.text.value.slice(1)))
        .slice(0, 6) ?? [])
    : [],
);
function focusComposer() {
  if (props.autofocus === false) return;
  if (buttonFirst.value)
    (
      controls.value?.querySelector<HTMLButtonElement>(
        '.green-button-primary:not(:disabled), [aria-label="Saved action confirmation"] button:not(:disabled)',
      ) ?? replyDisclosure.value
    )?.focus();
  else composer.value?.focus();
}
watch(
  () => home?.session.value?.destination.thread,
  async () => {
    await nextTick();
    focusComposer();
  },
);
onMounted(focusComposer);
async function submitReply() {
  if (!home || (questionChanged.value && !home.pendingSubmission.value)) return;
  const originalQuestion = home.pendingSubmission.value ? attemptedQuestion : questionIdentity.value;
  if (!home.pendingSubmission.value) attemptedQuestion = originalQuestion;
  await home.submit();
  if (buttonFirst.value && !home.pendingSubmission.value && !home.text.value) acceptedQuestion.value = originalQuestion;
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!questionChanged.value || home?.pendingSubmission.value) void submitReply();
  }
}
</script>
<template>
  <div
    v-if="home?.session.value"
    ref="controls"
    class="green-conversation-composer"
    :class="{ 'is-inline': capturedRevision !== undefined }"
  >
    <ul
      v-if="
        editorVisible && commands.length && !retryOnly && writableView && !(buttonFirst && home.pendingSubmission.value)
      "
      class="list-none m-0 p-0 mb-2"
      aria-label="Command suggestions"
    >
      <li v-for="command in commands" :key="command.chat">
        <button
          class="w-full text-left p-2 text-xs min-h-10 rounded hover:bg-elevated"
          type="button"
          @click="
            home.text.value = command.chat + ' ';
            composer?.focus();
          "
        >
          <strong>{{ command.chat }}</strong
          ><span class="block text-muted">{{ command.describe }}</span>
        </button>
      </li>
    </ul>
    <ConfirmationPrompt
      v-if="home.offer.value && canSubmit && writableView"
      :key="home.offer.value?.id"
      :offer="home.offer.value"
      :busy="home.sending.value"
      :pending="home.pendingChoice.value"
      @choose="home.submitConfirmation"
    />
    <div v-if="buttonFirst && canSubmit && writableView" class="flex flex-wrap gap-2 mt-3">
      <button
        v-if="primaryAction && !home.offer.value"
        type="button"
        class="green-button green-button-primary"
        :disabled="
          home.sending.value ||
          answered ||
          ((questionChanged || home.draftStale.value) && !home.pendingSubmission.value)
        "
        @click="chooseAnswer"
      >
        {{ home.pendingSubmission.value ? "Check saved reply" : answered ? "Reply accepted" : primaryAction.label }}
      </button>
      <button
        ref="replyDisclosure"
        type="button"
        class="green-button"
        :aria-expanded="editorVisible"
        :disabled="home.sending.value || answered"
        @click="openEditor"
      >
        {{ editorVisible ? "Hide reply" : retryOnly ? "Show saved reply" : "Type a reply" }}
      </button>
    </div>
    <div
      v-if="
        repositories &&
        home.session.value.destination.kind === 'broad' &&
        home.session.value.destination.canWrite &&
        writableView &&
        !buttonFirst
      "
      class="mb-2 mt-3"
    >
      <label for="green-repository" class="text-xs text-muted flex items-center gap-2"
        ><UIcon name="i-lucide-folder-git-2" />Repository for coding work</label
      >
      <select
        id="green-repository"
        class="green-input w-full mt-1"
        aria-label="Repository for coding work"
        :disabled="
          home.sending.value ||
          home.pendingSubmission.value ||
          repositories.status !== 'complete' ||
          !repositories.repositories.length
        "
        :value="selectedRepository"
        @change="chooseRepository(($event.target as HTMLSelectElement).value)"
      >
        <option value="">
          {{
            repositories.status === "unavailable"
              ? "Repository list unavailable"
              : repositories.repositories.length
                ? "Choose a repository"
                : "No eligible repositories"
          }}
        </option>
        <option v-for="repo in repositories.repositories" :key="repo.repo" :value="repo.repo">{{ repo.repo }}</option>
      </select>
    </div>
    <form v-if="canSubmit && writableView && editorVisible" class="green-composer-box" @submit.prevent="submitReply">
      <label for="green-message" class="sr-only">Message to {{ home.session.value.destination.label }}</label
      ><textarea
        id="green-message"
        ref="composer"
        v-model="home.text.value"
        rows="3"
        :disabled="home.sending.value || (questionChanged && !home.pendingSubmission.value)"
        :readonly="(buttonFirst || retryOnly) && home.pendingSubmission.value"
        placeholder="Ask Switchboard…"
        maxlength="32768"
        @keydown="keydown"
      />
      <div class="green-composer-actions">
        <span>Enter to send · Shift Enter for a new line</span
        ><button
          class="green-send"
          :class="{ 'green-send-check': retryOnly }"
          type="submit"
          :aria-label="retryOnly ? 'Check saved reply' : 'Send message'"
          :disabled="
            !home.text.value.trim() || home.sending.value || (questionChanged && !home.pendingSubmission.value)
          "
        >
          <span v-if="retryOnly">Check saved reply</span>
          <UIcon v-else :name="home.sending.value ? 'i-lucide-loader-circle' : 'i-lucide-arrow-up'" />
        </button>
      </div>
    </form>
    <p v-else-if="!canSubmit || !writableView" class="text-xs text-muted py-3">
      {{ !writableView ? "This view is read-only." : "This destination is read-only with your current permissions." }}
    </p>
    <div
      v-if="home.draftStale.value && writableView && capturedRevision === undefined"
      class="green-notice text-xs mt-2"
      role="alert"
    >
      <p>The question changed. Review the current question before sending this draft.</p>
      <button
        class="green-button mt-2"
        type="button"
        :disabled="home.sending.value || (questionChanged && !home.pendingSubmission.value)"
        @click="home.reviewDraft()"
      >
        Use draft for current question
      </button>
    </div>
    <p v-if="home.notice.value" class="text-xs text-muted mt-2" role="status">{{ home.notice.value }}</p>
    <p v-if="questionChanged" class="green-notice text-xs" role="alert">
      The question changed. Open the original thread to review it. An unknown saved action can still return its original
      receipt.
    </p>
  </div>
</template>
<style scoped>
.green-composer-box {
  border: 1px solid var(--ui-border-accented);
  border-radius: 8px;
  background: var(--ui-bg);
  padding: 10px;
}
.green-composer-box:focus-within {
  border-color: var(--ui-primary);
}
.green-composer-box textarea {
  width: 100%;
  border: 0;
  outline: 0;
  resize: vertical;
  max-height: 180px;
  min-height: 60px;
  font-size: 13px;
  background: transparent;
  color: var(--ui-text);
}
.green-composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.green-composer-actions span {
  font-size: 9px;
  color: var(--ui-text-muted);
}
.green-send {
  width: 36px;
  height: 36px;
  border-radius: 7px;
  background: var(--green-accent);
  color: var(--green-accent-text);
  display: grid;
  place-items: center;
}
.green-send-check {
  width: auto;
  padding-inline: 10px;
}
@media (max-width: 1100px) {
  .green-conversation-composer:not(.is-inline) .green-composer-box textarea {
    min-height: 40px;
    height: 40px;
  }
  .green-conversation-composer:not(.is-inline) .green-composer-actions > span {
    display: none;
  }
  .green-conversation-composer:not(.is-inline) .green-composer-box {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .green-conversation-composer:not(.is-inline) .green-composer-actions {
    flex: none;
  }
}
</style>
