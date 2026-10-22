<script setup lang="ts">
import { computed } from "vue";
import { useSeed } from "../../src/lib/seed";
import { useWallClock } from "../../src/lib/wallClock";
import { formatDateTime } from "../../src/lib/format";
import EmptyState from "../components/EmptyState.vue";

const seed = useSeed("runAdmission");
const now = useWallClock();
const title = computed(() =>
  seed?.admission.ownerStatus === "uncertain"
    ? "Request outcome unknown"
    : seed?.admission.ownerStatus === "completed"
      ? seed.admission.handlerOutcome === "refused"
        ? "Request refused before a run"
        : seed.admission.handlerOutcome === "completed"
          ? "Request handler returned"
          : "Request result recorded"
      : "Request recorded",
);
const explanation = computed(() =>
  seed?.admission.ownerStatus === "uncertain"
    ? "Switchboard could not confirm the original request result. No agent run record is available at this address."
    : seed?.admission.ownerStatus === "completed"
      ? "The original request has a recorded result, but no agent run record is available at this address. This page does not establish the agent result."
      : "Switchboard saved a request record but has not recorded its result. This does not confirm receipt acceptance or agent start.",
);
</script>
<template>
  <EmptyState v-if="seed" :title="title" :description="explanation" icon="i-lucide-clock-3">
    <dl class="mx-auto mt-4 max-w-xl space-y-2 text-left text-sm">
      <div class="grid gap-x-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt class="text-muted">Receipt</dt>
        <dd class="min-w-0 break-all font-mono">{{ seed.admission.receiptId }}</dd>
      </div>
      <div class="grid gap-x-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt class="text-muted">Assigned ID</dt>
        <dd class="min-w-0 break-all font-mono">{{ seed.id }}</dd>
      </div>
      <div class="grid gap-x-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt class="text-muted">Request recorded</dt>
        <dd>{{ formatDateTime(seed.admission.createdAt, now) }}</dd>
      </div>
      <div v-if="seed.admission.settledAt" class="grid gap-x-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt class="text-muted">Status recorded</dt>
        <dd>{{ formatDateTime(seed.admission.settledAt, now) }}</dd>
      </div>
      <div v-if="seed.admission.ownerStage" class="grid gap-x-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt class="text-muted">Last recorded stage</dt>
        <dd class="font-mono">{{ seed.admission.ownerStage }}</dd>
      </div>
      <div v-if="seed.admission.failure" class="grid gap-x-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt class="text-muted">
          {{ seed.admission.ownerStatus === "completed" ? "Earlier failure class" : "Failure class" }}
        </dt>
        <dd class="font-mono">
          {{ seed.admission.failure.kind
          }}<template v-if="seed.admission.failure.code"> · {{ seed.admission.failure.code }}</template>
        </dd>
      </div>
    </dl>
    <RouterLink to="/runs" class="green-button mt-4">Runs</RouterLink>
  </EmptyState>
</template>
