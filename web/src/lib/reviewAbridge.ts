import { reactive } from "vue";
import type { AbridgeControl, AbridgeState } from "../modules/pr-review/types";

// The host's half of the panel's "Abridge with meat" control
// (docs/reference/specs/reading-diff.md item 12): the pr-review module renders the
// state and calls `start`; this drives the command surface. `POST
// /api/review.abridge` starts the abridging and is also the poll — the same
// call answers `running` until the artifact is stored, then `done` (or
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

export interface ReviewAbridge extends AbridgeControl {
  /** Stop polling — the page is going away. */
  dispose(): void;
}

const defaultDeps: ReviewAbridgeDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  delay: (ms) => new Promise((r) => setTimeout(r, ms)),
};

type Answer = { state?: unknown; reason?: unknown; error?: unknown };

export function createReviewAbridge(
  runId: string,
  sink: (event: unknown) => void,
  deps: Partial<ReviewAbridgeDeps> = {},
): ReviewAbridge {
  const { fetch, delay } = { ...defaultDeps, ...deps };
  const control = reactive<{ state: AbridgeState }>({ state: { state: "absent" } });
  let disposed = false;

  async function post(force: boolean): Promise<Answer> {
    const res = await fetch("/api/review.abridge", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: runId, ...(force ? { force: true } : {}) }),
    });
    const body = (await res.json().catch(() => null)) as Answer | null;
    if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
    return body ?? {};
  }

  /** Read the record page by page into the sink; true once a meat diff went by. */
  async function readRecord(): Promise<boolean> {
    let found = false;
    let afterSeq: number | undefined;
    for (;;) {
      const query = `id=${encodeURIComponent(runId)}${afterSeq !== undefined ? `&after-seq=${afterSeq}` : ""}`;
      const res = await fetch(`/api/runs.events?${query}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = (await res.json()) as { events?: unknown[]; nextAfterSeq?: number };
      for (const e of page.events ?? []) {
        sink(e);
        const o = e as { type?: unknown; artifact?: unknown; poweredBy?: unknown };
        if (o.type === "review_artifact" && o.artifact === "reading_diff" && o.poweredBy === "meat") found = true;
      }
      if (typeof page.nextAfterSeq !== "number") return found;
      afterSeq = page.nextAfterSeq;
    }
  }

  async function run(force: boolean): Promise<void> {
    try {
      let answer = await post(force);
      for (let polls = 0; answer.state === "running"; polls++) {
        if (polls >= MAX_POLLS) {
          control.state = { state: "failed", reason: "still running after the page stopped waiting; ask again later" };
          return;
        }
        await delay(POLL_INTERVAL_MS);
        if (disposed) return;
        answer = await post(false);
      }
      if (disposed) return;
      if (answer.state === "failed") {
        control.state = {
          state: "failed",
          reason: typeof answer.reason === "string" ? answer.reason : "unknown reason",
        };
      } else if (answer.state === "done") {
        control.state = (await readRecord())
          ? { state: "done" }
          : { state: "failed", reason: "the abridged diff did not appear on the run's record" };
      } else {
        control.state = { state: "failed", reason: `unexpected answer: ${String(answer.state)}` };
      }
    } catch (err) {
      if (disposed) return;
      control.state = { state: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    get state() {
      return control.state;
    },
    start() {
      if (control.state.state === "running" || disposed) return;
      const retry = control.state.state === "failed";
      control.state = { state: "running" };
      void run(retry);
    },
    dispose() {
      disposed = true;
    },
  };
}
