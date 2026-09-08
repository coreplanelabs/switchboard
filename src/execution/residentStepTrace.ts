// The resident's own measurement of a request's steps (docs/reference/specs/tracing.md
// item 19; docs/reference/specs/resident-repos.md item 63): every command the Worker runs
// for one `/attach` or `/op` — clone, fetch, install, the mutex wait — as
// offsets from the request's start, handed back in the answer's `trace` so
// the bot grafts them under the span that made the call. A pure module both
// sides import: the Worker records, the bot re-validates (residentTrace.ts).
// No I/O, no clock of its own: the caller supplies every stamp.

/** One measured step, in the resident's own time as offsets from its request start. */
export type ResidentStep = {
  /** The step's name — an identifier from the Worker's step vocabulary (`clone`,
   *  `install`, `mutex_wait`…); sanitized on both sides. */
  name: string;
  /** Milliseconds after the request started. */
  startMs: number;
  durationMs: number;
  status: "ok" | "error";
  exitCode?: number;
  timedOut?: boolean;
  /** `mutex_wait` only: how long the request waited for the mirror lock. */
  waitedMs?: number;
};

/** The most steps one answer carries, and the most bytes: an attach is about
 *  a dozen steps, a full build a few dozen; past the cap the newest are kept. */
export const STEP_TRACE_MAX = 64;
export const STEP_TRACE_MAX_BYTES = 8 * 1024;
export const STEP_NAME_MAX = 32;

const STEP_NAME = /[^a-z0-9_-]+/g;

/** A step name as the trace carries it: lowercase `[a-z0-9_-]`, at most 32
 *  chars, `step` when nothing is left. */
export function sanitizeStepName(raw: unknown): string {
  const s = String(raw ?? "")
    .toLowerCase()
    .replace(STEP_NAME, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, STEP_NAME_MAX);
  return s || "step";
}

export interface StepTrace {
  /** Record one finished command. */
  record(
    step: string,
    stamps: { startedAt: number; endedAt: number; exitCode?: number; timedOut?: boolean; ok?: boolean },
  ): void;
  /** Record a wait for the mirror lock that ended at `endedAt`. */
  mutexWait(waitedMs: number, endedAt: number): void;
  /** The steps so far, bounded, as offsets from `t0`. */
  steps(): ResidentStep[];
}

/** A collector for one request: `t0` is the request's start on the Worker's clock. */
export function createStepTrace(t0: number): StepTrace {
  const steps: ResidentStep[] = [];
  const sizes: number[] = [];
  let bytes = 2; // the array's brackets
  const push = (s: ResidentStep) => {
    // Bounded by count and by bytes (a running total: each step's serialized
    // size plus its comma); the newest steps are the ones a slow attach is
    // about, so the oldest go first.
    const size = JSON.stringify(s).length + 1;
    steps.push(s);
    sizes.push(size);
    bytes += size;
    while (steps.length > STEP_TRACE_MAX || bytes > STEP_TRACE_MAX_BYTES) {
      steps.shift();
      bytes -= sizes.shift() ?? 0;
    }
  };
  return {
    record(step, stamps) {
      const ok = stamps.ok ?? ((stamps.exitCode === 0 || stamps.exitCode === undefined) && !stamps.timedOut);
      push({
        name: sanitizeStepName(step),
        startMs: Math.max(0, Math.round(stamps.startedAt - t0)),
        durationMs: Math.max(0, Math.round(stamps.endedAt - stamps.startedAt)),
        status: ok ? "ok" : "error",
        ...(stamps.exitCode !== undefined ? { exitCode: stamps.exitCode } : {}),
        ...(stamps.timedOut ? { timedOut: true } : {}),
      });
    },
    mutexWait(waitedMs, endedAt) {
      const wait = Math.max(0, Math.round(waitedMs));
      push({
        name: "mutex_wait",
        startMs: Math.max(0, Math.round(endedAt - wait - t0)),
        durationMs: wait,
        status: "ok",
        waitedMs: wait,
      });
    },
    steps: () => steps.map((s) => ({ ...s })),
  };
}
