import { onBeforeUnmount, shallowRef, watch, reactive } from "vue";
import { unwrapUntrusted } from "@core/core/untrusted.js";
import type { PrChecksSnapshot } from "@core/core/prChecks.js";
import type { ChecksControl, ChecksSnapshot, PrRef } from "../modules/pr-review/types";
import { prLinks } from "../modules/pr-review/types";
import { useEventSourceFactory, type EventSourceFactory, type EventSourceLike } from "./eventSource";

export interface PrChecksControl extends ChecksControl {
  dispose(): void;
}

/** The host owns requests and cleanup; the panel only renders props. */
export function createPrChecks(id: string, pr: PrRef, makeSource: EventSourceFactory): PrChecksControl {
  const state = reactive<{ snapshot?: ChecksSnapshot; loading: boolean; error: string }>({ loading: false, error: "" });
  let source: EventSourceLike | undefined;
  let disposed = false;
  const receive = (raw: string) => {
    if (disposed) return;
    try {
      const data = JSON.parse(raw) as PrChecksSnapshot;
      if (
        !data ||
        data.repo !== pr.repo ||
        data.number !== pr.number ||
        !/^[a-f0-9]{40}$/.test(data.headSha) ||
        !/^[a-f0-9]{40}$/.test(data.checkedSha) ||
        !Number.isFinite(data.checkedAt) ||
        typeof data.state !== "string" ||
        !Array.isArray(data.warnings) ||
        !data.warnings.every((w) => typeof w === "string") ||
        !Array.isArray(data.checks) ||
        !data.checks.every(
          (c) =>
            c &&
            typeof c.id === "string" &&
            typeof c.name === "string" &&
            (c.description === undefined || typeof c.description === "string") &&
            (c.provider === undefined || typeof c.provider === "string") &&
            typeof c.required === "boolean" &&
            ["pending", "in_progress", "success", "failure", "neutral", "skipped", "cancelled", "expected"].includes(
              c.status,
            ),
        )
      )
        throw new Error("GitHub returned an incomplete checks response.");
      state.snapshot = {
        headSha: data.headSha,
        checkedSha: data.checkedSha,
        state: data.state,
        checkedAt: data.checkedAt,
        rows: data.checks.map((check) => ({
          ...check,
          name: unwrapUntrusted(check.name),
          ...(check.description !== undefined ? { description: unwrapUntrusted(check.description) } : {}),
          ...(check.provider !== undefined ? { provider: unwrapUntrusted(check.provider) } : {}),
        })),
        warnings: data.warnings,
      };
      state.error = "";
    } catch (error) {
      state.error = error instanceof Error ? error.message : "GitHub checks could not be loaded.";
    } finally {
      state.loading = false;
    }
  };
  return {
    get snapshot() {
      return state.snapshot;
    },
    get loading() {
      return state.loading;
    },
    get error() {
      return state.error;
    },
    start() {
      if (source || disposed) return;
      state.loading = true;
      source = makeSource(`/api/review.checks?id=${encodeURIComponent(id)}`);
      source.onmessage = (event) => receive(event.data);
      source.onerror = () => {
        if (disposed) return;
        state.loading = false;
        state.error = "The checks stream was interrupted. Reconnecting…";
      };
      source.addEventListener("unavailable", (raw) => {
        if (disposed) return;
        try {
          const error = JSON.parse(raw ?? "") as { message?: unknown; retry?: unknown };
          state.error = typeof error.message === "string" ? error.message : "GitHub checks are unavailable.";
          if (error.retry === false) source?.close();
        } catch {
          state.error = "GitHub returned an incomplete checks response.";
        }
        state.loading = false;
      });
    },
    dispose() {
      disposed = true;
      source?.close();
      state.loading = false;
    },
  };
}

export function usePrChecks(id: () => string | undefined, pr: () => PrRef) {
  const makeSource = useEventSourceFactory();
  const control = shallowRef<PrChecksControl>();
  watch(
    [id, () => pr().repo, () => pr().number],
    () => {
      control.value?.dispose();
      const runId = id();
      control.value = runId && prLinks(pr()).pr ? createPrChecks(runId, pr(), makeSource) : undefined;
    },
    { immediate: true },
  );
  onBeforeUnmount(() => control.value?.dispose());
  return control;
}
