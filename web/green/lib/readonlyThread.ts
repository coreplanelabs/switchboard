import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import type { HomeSession } from "@core/channels/homeSeed.js";
import { useEventSourceFactory, type EventSourceLike } from "../../src/lib/eventSource";
import { isHomeSession, useHomeSession } from "./homeSession";
import { SeedKey, useViewingAs } from "../../src/lib/seed";

/** A separate read scope: observing a target never redirects the one composer. */
export function useReadonlyThread(thread: () => string | null) {
  const home = useHomeSession();
  const viewingAs = useViewingAs();
  const seed = inject(SeedKey, null);
  const independentScope = !!viewingAs || seed?.dataView?.mode === "person";
  const makeSource = useEventSourceFactory();
  const session = ref<HomeSession | null>(null);
  const status = ref<"loading" | "ready" | "unavailable">("loading");
  const canWrite = ref(false);
  let proofRevision: number | null = null;
  let proofGeneration = 0;
  let generation = 0;
  let source: EventSourceLike | null = null;
  const privacy = (value: HomeSession) =>
    JSON.stringify([value.actor, value.organization, value.stream, value.bindingRevision, value.accessEpoch]);
  const scope = computed(() =>
    home?.scopeChanging.value
      ? null
      : independentScope
        ? "view-as-observer"
        : home?.status.value === "ready" && home.session.value
          ? privacy(home.session.value)
          : seed?.dataView?.mode === "everyone"
            ? "all-observer"
            : null,
  );
  function clear(next: "loading" | "unavailable") {
    generation++;
    proofGeneration++;
    proofRevision = null;
    canWrite.value = false;
    source?.close();
    source = null;
    session.value = null;
    status.value = next;
  }
  watch(
    [thread, scope],
    ([target, privacyScope]) => {
      clear(target && privacyScope ? "loading" : "unavailable");
      if (!target || !privacyScope) return;
      const mine = generation;
      let observedScope: string | null = null;
      const separate = independentScope || privacyScope === "all-observer";
      async function currentReplyProof() {
        if (separate || !home) return;
        const request = ++proofGeneration;
        canWrite.value = false;
        const current = await home.peek(target!);
        if (mine !== generation || request !== proofGeneration || scope.value !== privacyScope) return;
        if (!current || privacy(current) !== privacyScope) {
          clear("unavailable");
          return;
        }
        if (session.value && session.value.destination.revision !== current.destination.revision) return;
        proofRevision = current.destination.revision;
        canWrite.value = current.destination.canWrite;
        if (!session.value) {
          session.value = current;
          status.value = "ready";
        }
      }
      if (!separate) void currentReplyProof();
      source = makeSource(`/home/events?thread=${encodeURIComponent(target)}&observe=1`);
      source.onmessage = (event) => {
        if (mine !== generation || scope.value !== privacyScope) return;
        let value: unknown;
        try {
          value = JSON.parse(event.data);
        } catch {
          clear("unavailable");
          return;
        }
        if (
          !isHomeSession(value) ||
          value.destination.kind !== "thread" ||
          value.destination.thread !== target ||
          (separate ? observedScope !== null && privacy(value) !== observedScope : privacy(value) !== privacyScope)
        ) {
          clear("unavailable");
          return;
        }
        observedScope = privacy(value);
        session.value = value;
        status.value = "ready";
        if (!separate && proofRevision !== value.destination.revision) void currentReplyProof();
      };
      for (const name of ["revoked", "unavailable"])
        source.addEventListener(name, () => {
          if (mine === generation) clear("unavailable");
        });
      source.onerror = () => {
        if (mine === generation) clear("unavailable");
      };
    },
    { immediate: true, flush: "sync" },
  );
  onBeforeUnmount(() => clear("unavailable"));
  return { session, status, canWrite };
}
