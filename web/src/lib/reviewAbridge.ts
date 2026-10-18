import { postCommand, getCommand } from "./settingsApi";
import { reactive } from "vue";
import { unwrapUntrusted } from "@core/core/untrusted.js";
import type { AbridgeControl, AbridgeState } from "../modules/pr-review/types";

// The host's half of the panel's "Abridge with meat" control
// (docs/reference/specs/reading-diff.md item 12): the pr-review module renders the
// state and calls `start`; this drives the command surface. `POST
// /api/review.abridge` starts the abridging; the read-only status command polls. The
// status answers `running` until the artifact is stored, then `done` (or
// `failed`). `done` says nothing about the diff itself: it sits on the run's
// record as a second `review_artifact`, so the record is read back
// (`GET /api/runs.events`, paged) and every event is handed to the sink — the
// PR-review collector, which folds the meat diff in and ignores the rest.

export interface ReviewAbridgeDeps {
  fetch: typeof globalThis.fetch;
  delay: (ms: number) => Promise<void>;
}

/** Between two polls. meat itself takes one to a few minutes. */
export const POLL_INTERVAL_MS = 3000;
/** Polls before the page stops waiting (the run's own budget is shorter). */
export const MAX_POLLS = 200;
/** Pages of the record the page reads before calling it stuck (the service
 *  pages 500 events at most; a record is thousands of events at the outside). */
export const MAX_PAGES = 50;

export interface ReviewAbridge extends AbridgeControl {
  refresh(): void;
  /** Stop polling — the page is going away. */
  dispose(): void;
}

const defaultDeps: ReviewAbridgeDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  delay: (ms) => new Promise((r) => setTimeout(r, ms)),
};

type Answer = { state?: unknown; reason?: unknown; error?: unknown; progress?: unknown };

export function createReviewAbridge(
  runId: string,
  sink: (event: unknown) => void,
  deps: Partial<ReviewAbridgeDeps> = {},
): ReviewAbridge {
  const { fetch, delay } = { ...defaultDeps, ...deps };
  const control = reactive<{ state: AbridgeState; progress: string[] }>({ state: { state: "absent" }, progress: [] });
  let disposed = false;
  let busy = false;
  /** The last failure was the SERVER's `failed` state — a stored one, which
   *  the command only recomputes on `force`. A transport or page-side failure
   *  is retried without it: the command's idempotency answers a stored
   *  artifact rather than spending a new model call. */
  let serverFailed = false;
  function keepProgress(answer: Answer) {
    if (Array.isArray(answer.progress))
      control.progress = answer.progress
        .filter((line): line is string => typeof line === "string")
        .slice(-32)
        .map((line) => unwrapUntrusted(line).slice(0, 512));
  }

  async function post(force: boolean): Promise<Answer> {
    const answer = await postCommand(fetch, "review.abridge", { id: runId, ...(force ? { force: true } : {}) });
    if (!answer.ok) throw new Error(answer.failure.message);
    return (answer.value ?? {}) as Answer;
  }

  /** Read the record page by page into the sink. `found` once a meat diff went
   *  by; `stuck` when the cursor stood still or the pages ran past the bound;
   *  `disposed` when the page went away mid-read — nothing reached the sink after. */
  async function readRecord(): Promise<"found" | "missing" | "stuck" | "disposed"> {
    let found = false;
    let afterSeq: number | undefined;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const query = `id=${encodeURIComponent(runId)}${afterSeq !== undefined ? `&after-seq=${afterSeq}` : ""}`;
      const res = await fetch(`/api/runs.events?${query}`, { credentials: "same-origin" });
      if (disposed) return "disposed";
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = (await res.json()) as { events?: unknown[]; nextAfterSeq?: number };
      if (disposed) return "disposed";
      for (const e of page.events ?? []) {
        sink(e);
        const o = e as { type?: unknown; artifact?: unknown; poweredBy?: unknown };
        if (o.type === "review_artifact" && o.artifact === "reading_diff" && o.poweredBy === "meat") found = true;
      }
      if (typeof page.nextAfterSeq !== "number") return found ? "found" : "missing";
      if (afterSeq !== undefined && page.nextAfterSeq <= afterSeq) return "stuck";
      afterSeq = page.nextAfterSeq;
    }
    return "stuck";
  }

  async function status(): Promise<Answer> {
    const answer = await getCommand(fetch, "review.status", { id: runId });
    if (!answer.ok) throw new Error(answer.failure.message);
    return (answer.value ?? {}) as Answer;
  }

  async function run(first: () => Promise<Answer>, reading = false): Promise<void> {
    try {
      let answer = await first();
      if (disposed) return;
      keepProgress(answer);
      if (answer.state === "running") control.state = { state: "running" };
      for (let polls = 0; answer.state === "running"; polls++) {
        if (polls >= MAX_POLLS) {
          serverFailed = false;
          control.state = { state: "failed", reason: "still running after the page stopped waiting; ask again later" };
          return;
        }
        await delay(POLL_INTERVAL_MS);
        if (disposed) return;
        answer = await status();
        if (disposed) return;
        keepProgress(answer);
      }
      if (disposed) return;
      if (answer.state === "failed") {
        serverFailed = true;
        control.state = {
          state: "failed",
          reason: typeof answer.reason === "string" ? answer.reason : "unknown reason",
        };
      } else if (answer.state === "done") {
        const read = await readRecord();
        if (read === "disposed") return;
        serverFailed = false;
        control.state =
          read === "found"
            ? { state: "done" }
            : {
                state: "failed",
                reason:
                  read === "stuck"
                    ? "the run's record did not page to its end"
                    : "the abridged diff did not appear on the run's record",
              };
      } else if (reading && answer.state === "absent") {
        serverFailed = false;
        control.state = { state: "absent" };
      } else {
        serverFailed = false;
        control.state = {
          state: reading ? "unavailable" : "failed",
          reason: `unexpected answer: ${String(answer.state)}`,
        };
      }
    } catch (err) {
      if (disposed) return;
      serverFailed = false;
      control.state = {
        state: reading ? "unavailable" : "failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      busy = false;
    }
  }

  return {
    get state() {
      return control.state;
    },
    get progress() {
      return control.progress;
    },
    start() {
      if (busy || control.state.state === "running" || control.state.state === "unavailable" || disposed) return;
      const force = control.state.state === "failed" && serverFailed;
      control.state = { state: "running" };
      busy = true;
      void run(() => post(force));
    },
    refresh() {
      if (busy || disposed) return;
      control.state = { state: "checking" };
      busy = true;
      void run(status, true);
    },
    dispose() {
      disposed = true;
    },
  };
}
