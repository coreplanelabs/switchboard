<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { LinkConsentView } from "@core/channels/linkBrowser.js";

// A presentation module, not a route. The host owns the transport; this module
// only emits the closed POST fields, never a person or identity to bind.
const props = defineProps<{
  view: LinkConsentView;
  busy?: boolean;
  live?: boolean;
  native?: boolean;
  readonly?: boolean;
  path?: string;
  embedded?: boolean;
}>();
const emit = defineEmits<{
  submit: [
    submission: { action: "begin" | "commit" | "cancel" | "interrupt" | "restart"; fields: Record<string, string> },
  ];
}>();
const consent = ref(false);
const operationName = computed(() => ("operation" in props.view ? (props.view.operation?.kind ?? "link") : "link"));
const operationLabel = computed(() =>
  operationName.value === "unlink" ? "unlink" : operationName.value === "recover" ? "recover" : "link",
);
watch(
  () => props.view,
  () => {
    consent.value = false;
  },
);
const active = computed(() => ("revision" in props.view ? props.view : null));
const ending = computed(() => {
  switch (props.view.stage) {
    case "committed":
      return {
        title: props.live
          ? operationName.value === "unlink"
            ? "Account unlinked"
            : operationName.value === "recover"
              ? "Account link recovered"
              : "Accounts linked"
          : "Accounts verified in this fixture",
        detail: props.live
          ? "Both accounts were verified. Only future cross-surface activity changes. Each source keeps its own permissions and past attribution."
          : "The local transaction is complete. This does not enable live linking, change permissions or move history.",
      };
    case "cancelled":
      return { title: "Link cancelled", detail: "Verification was cancelled. No account link was created." };
    case "expired":
      return {
        title: "Verification expired",
        detail: "This verification is no longer valid. Linking requires fresh verification of both accounts.",
      };
    case "failed":
      return {
        title: "Verification could not complete",
        detail: "No new link was created. Account details and provider errors are not disclosed.",
      };
    case "unavailable":
      return {
        title: "Verification is unavailable",
        detail:
          "The result could not be confirmed. A result read or an identical consent retry cannot create a second link.",
      };
    case "result-expired":
      return {
        title: "Result window closed",
        detail: "This verification's result can no longer be retrieved. Existing account links are unchanged.",
      };
    default:
      return null;
  }
});
function submit(event: Event, action: "begin" | "commit" | "cancel" | "interrupt" | "restart") {
  if (!props.live || !props.native) event.preventDefault();
  if (props.busy || props.readonly) {
    event.preventDefault();
    return;
  }
  const v = props.view;
  if (action === "begin" && v.stage === "start") emit("submit", { action, fields: { csrf: v.csrf } });
  else if (action === "restart" && "restartCsrf" in v && v.restartCsrf)
    emit("submit", { action, fields: { csrf: v.restartCsrf } });
  else if ("revision" in v) {
    if (action === "commit" && (v.stage !== "awaiting-consent" || !consent.value)) {
      event.preventDefault();
      return;
    }
    const token = action === "cancel" ? v.cancelCsrf : action === "interrupt" ? v.interruptCsrf : v.csrf;
    if (token)
      emit("submit", {
        action,
        fields: { csrf: token, revision: String(v.revision), ...(action === "commit" ? { consent: "yes" } : {}) },
      });
  }
}
</script>

<template>
  <component
    :is="embedded ? 'div' : 'main'"
    class="mx-auto w-full max-w-2xl px-5 py-10 sm:py-16"
    aria-labelledby="link-heading"
  >
    <div class="mb-8 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted">
      <UIcon name="i-lucide-link" class="size-4" /> Account verification
    </div>
    <p v-if="!live" class="mb-3 text-sm font-medium text-warn">Local preview · Live linking is disabled</p>
    <p v-if="readonly" class="mb-3 text-sm font-medium text-warn">This view is read-only.</p>
    <component
      :is="embedded ? 'h2' : 'h1'"
      id="link-heading"
      class="text-3xl font-semibold tracking-tight text-highlighted"
      >Confirm your accounts</component
    >
    <p class="mt-3 text-sm leading-relaxed text-muted">
      Prove that you control both accounts, then confirm the selected operation. Matching names or email addresses are
      not proof.
    </p>

    <template v-if="view.stage === 'start'">
      <section class="mt-8 rounded-xl border border-default p-6">
        <h2 class="font-medium text-highlighted">Verify with Slack</h2>
        <p class="mt-2 text-sm text-muted">
          Your authenticated Access account starts verification. Slack verification alone does not link anything.
        </p>
        <form
          method="post"
          :action="`${path ?? '/account-link'}/begin`"
          data-action="begin"
          class="mt-5"
          @submit="submit($event, 'begin')"
        >
          <input type="hidden" name="csrf" :value="view.csrf" />
          <UButton type="submit" :disabled="busy || readonly" color="neutral">Continue to Slack</UButton>
        </form>
        <div v-if="view.operations?.length" class="mt-5 grid gap-3">
          <form
            v-for="operation in view.operations"
            :key="`${operation.kind}:${operation.target}`"
            method="post"
            :action="`${path ?? '/account-link'}/${operation.kind}`"
            :data-action="operation.kind"
          >
            <input type="hidden" name="csrf" :value="operation.csrf" /><input
              type="hidden"
              name="target"
              :value="operation.target"
            />
            <UButton type="submit" :disabled="busy || readonly || !live || !native" color="neutral" variant="outline">
              {{ operation.kind === "unlink" ? "Unlink" : "Recover" }}
              {{ operation.target === "access" ? "browser account" : "Slack account" }}
            </UButton>
          </form>
          <p class="text-xs text-muted">
            Every operation verifies both accounts again. Recovery also requires identity administrator permission.
          </p>
        </div>
      </section>
    </template>

    <template v-else-if="active">
      <section class="mt-8 overflow-hidden rounded-xl border border-default" aria-label="Verified accounts">
        <div class="border-b border-default p-5 sm:p-6">
          <h2 class="flex items-center gap-2 text-sm font-semibold text-highlighted">
            <UIcon name="i-lucide-shield-check" class="size-4" /> Access account
          </h2>
          <dl class="mt-4 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt class="text-muted">Subject</dt>
            <dd class="break-all font-mono text-highlighted">{{ active.access.subject }}</dd>
            <dt class="text-muted">Issuer</dt>
            <dd class="break-all">{{ active.access.issuer }}</dd>
            <dt class="text-muted">Application</dt>
            <dd class="break-all">{{ active.access.audience }}</dd>
          </dl>
        </div>
        <div class="p-5 sm:p-6">
          <h2 class="flex items-center gap-2 text-sm font-semibold text-highlighted">
            <UIcon name="i-lucide-message-circle" class="size-4" /> Slack account
          </h2>
          <dl v-if="active.slack" class="mt-4 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt class="text-muted">User</dt>
            <dd class="break-all font-mono text-highlighted">{{ active.slack.subject }}</dd>
            <dt class="text-muted">Workspace</dt>
            <dd class="break-all font-mono">{{ active.slack.tenant }}</dd>
            <dt class="text-muted">Issuer</dt>
            <dd class="break-all">{{ active.slack.issuer }}</dd>
          </dl>
          <p v-else class="mt-3 text-sm text-muted">
            {{
              active.stage === "exchanging"
                ? "Verification is in progress. An interrupted exchange cannot be replayed."
                : "Waiting for Slack verification. No link has been created."
            }}
          </p>
        </div>
      </section>
      <p class="mt-3 text-xs text-muted">
        Expires {{ new Date(active.expiresAt).toISOString().replace("T", " ").replace(".000Z", " UTC") }} · Refreshing
        does not extend this verification.
      </p>
      <form
        v-if="active.stage === 'awaiting-consent'"
        method="post"
        :action="`${path ?? '/account-link'}/commit`"
        data-action="commit"
        class="mt-7"
        @submit="submit($event, 'commit')"
      >
        <input type="hidden" name="csrf" :value="active.csrf" />
        <input type="hidden" name="revision" :value="active.revision" />
        <label class="flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-highlighted">
          <input
            v-model="consent"
            type="checkbox"
            name="consent"
            value="yes"
            required
            :disabled="busy || readonly"
            class="mt-1 size-4 shrink-0 accent-current"
          />
          <span
            >I control both accounts shown above and explicitly consent to this {{ operationLabel }} operation.</span
          >
        </label>
        <p class="ml-7 mt-2 text-sm text-muted">
          {{
            live
              ? "Linking grants no permissions. Existing history remains with its original owner."
              : "This preview grants no permissions and claims no existing history."
          }}
        </p>
        <UButton type="submit" :disabled="!consent || busy || readonly" color="neutral" class="mt-5">{{
          live ? `Confirm ${operationLabel}` : "Confirm link in fixture"
        }}</UButton>
      </form>
      <div class="mt-3 flex flex-wrap gap-3">
        <form
          method="post"
          :action="`${path ?? '/account-link'}/cancel`"
          data-action="cancel"
          @submit="submit($event, 'cancel')"
        >
          <input type="hidden" name="csrf" :value="active.cancelCsrf" /><input
            type="hidden"
            name="revision"
            :value="active.revision"
          />
          <UButton type="submit" :disabled="busy || readonly" color="neutral" variant="ghost"
            >Cancel verification</UButton
          >
        </form>
        <form
          v-if="active.stage === 'exchanging'"
          method="post"
          :action="`${path ?? '/account-link'}/interrupt`"
          data-action="interrupt"
          @submit="submit($event, 'interrupt')"
        >
          <input type="hidden" name="csrf" :value="active.interruptCsrf" /><input
            type="hidden"
            name="revision"
            :value="active.revision"
          />
          <UButton type="submit" :disabled="busy || readonly" color="neutral" variant="outline"
            >End interrupted verification</UButton
          >
        </form>
      </div>
    </template>
    <section v-else-if="ending" class="mt-8 rounded-xl border border-default p-6" role="status">
      <h2 class="font-medium text-highlighted">{{ ending.title }}</h2>
      <p class="mt-2 text-sm leading-relaxed text-muted">{{ ending.detail }}</p>
      <form
        v-if="'restartCsrf' in view && view.restartCsrf"
        method="post"
        :action="`${path ?? '/account-link'}/restart`"
        data-action="restart"
        class="mt-5"
        @submit="submit($event, 'restart')"
      >
        <input type="hidden" name="csrf" :value="view.restartCsrf" />
        <UButton type="submit" :disabled="busy || readonly" color="neutral">Verify another operation</UButton>
      </form>
    </section>
    <p v-if="!live" class="mt-10 border-t border-default pt-5 text-xs leading-relaxed text-muted">
      Staged implementation only. Live linking requires a separate release decision, revocation safeguards and
      retirement of legacy email linking.
    </p>
  </component>
</template>
