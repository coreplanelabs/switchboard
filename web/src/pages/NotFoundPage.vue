<script setup lang="ts">
import AppShell from "../components/AppShell.vue";
import RunsTabs from "../components/runs/RunsTabs.vue";
import { useSeed } from "../lib/seed";
import { retentionSentence } from "@core/channels/webSeed.js";

// The run page's 404 (item 19): the same shell as the runs page, one
// non-revealing message for an unknown run, an expired one and a wrong token,
// the retention sentence so the likely reason is on the page, and the way
// back. Static text only — nothing from the request is echoed.

const seed = useSeed("runNotFound");
const retention = retentionSentence(seed?.retentionDays ?? null);
</script>

<template>
  <AppShell title="Run not found" nav="runs">
    <RunsTabs current="runs" />
    <section class="notfound mx-auto my-12 max-w-xl text-center text-toned">
      <p class="code mb-3 font-mono text-4xl font-medium tracking-wide text-dimmed">404</p>
      <h2 class="mb-3 text-lg font-medium tracking-tight text-highlighted">That run isn't here.</h2>
      <p class="mb-2.5 leading-relaxed">
        It may have finished and aged out, the link may be missing its token, or it never existed — this page says the
        same thing in every case.
      </p>
      <p class="why text-[0.8rem] text-muted">{{ retention }}</p>
      <UButton class="back mt-4" color="neutral" variant="outline" to="/runs" label="← All runs" />
    </section>
  </AppShell>
</template>
