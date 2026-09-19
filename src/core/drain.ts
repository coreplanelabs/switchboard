// Graceful-drain timing facts, shared by the drain itself (`src/index.ts`),
// the `/healthz` body (`src/channels/health.ts`) and the Slack reconnect
// catch-up (`src/channels/slackCatchUp.ts`). Node-free and Bolt-free on purpose
// so tests can pin the relationship between them without loading the adapter.
//
// Why they are one module: on SIGTERM the drain closes the Slack socket
// at once and holds the container until in-flight runs finish, up to
// DRAIN_DEADLINE_MS. Cloudflare starts the replacement container only after
// this one exits, so a deploy that lands on a run in flight blacks Slack out
// for the run's remaining duration (minutes, in practice). Mentions in
// that gap are recovered ONLY by the catch-up scan on the next connect, whose
// window must therefore cover the worst blackout: the full drain deadline plus
// the new container's cold start. Keeping the socket open during the drain was
// rejected — see the drain in `src/index.ts`.

/** How long the drain waits for in-flight work after SIGTERM before exiting —
 *  the grace Cloudflare's rollout allows before SIGKILL. With the run ledger on,
 *  the runs a resume can continue are handed off instead of waited for
 *  (docs/reference/specs/run-history.md item 39); this is the wait for the rest. */
export const DRAIN_DEADLINE_MS = 15 * 60_000;

/** One run holding a drain: the registry-active run's id and why it holds.
 *  The drain is held by the RUN REGISTRY's live rows, not by the dispatcher's
 *  in-flight count — the two can disagree (a registry row whose dispatcher-side
 *  run is gone still holds the drain for its full deadline) — so the lines an
 *  operator reads name these rows, never the count from the other ledger. */
export interface HeldRun {
  id: string;
  why: string;
}

/** Why a registry-active run holds the drain: the handoff (run-history item 39)
 *  did not mark it for the next generation, so this process must wait for it. */
export const HELD_NOT_HANDED_OFF = "not handed off";

/** One `id (why)` per held run, comma-separated — shared by the drain's hold
 *  line here and the deploy CLI's still-draining line (src/deploy/liveGate.ts). */
export function heldRunsText(held: readonly HeldRun[]): string {
  return held.map((r) => `${r.id} (${r.why})`).join(", ");
}

/** The drain's hold line (slack-channel.md item 8): what actually holds the
 *  exit, by run id and reason — printed once the handoff has settled who stays. */
export function drainHoldLine(held: readonly HeldRun[]): string {
  return `[drain] holding for ${held.length} registry-active run(s): ${heldRunsText(held)}`;
}

/** The handoff's own budget (plan D8): after every resumable run is marked
 *  `handoff`, the drain waits this long for pending history writes and
 *  reflections, then exits — the next generation takes the runs. */
export const HANDOFF_BUDGET_MS = 6_000;

/**
 * The drain's wait bound, re-read on every poll of the drain loop
 * (`src/index.ts`). While a run still holds the drain (registry-active, not
 * handed off) the bound is the full DRAIN_DEADLINE_MS from the signal — the
 * deadline is the bound for a run that will not end, never the schedule. The
 * moment the held count reaches zero the bound collapses to HANDOFF_BUDGET_MS
 * from that instant (never past the full deadline) — the same grace a drain
 * that started with nothing held gets — so pending reflections and history
 * writes, including the steady stream a handed-off run still executing here
 * produces, get seconds to settle, not the deploy's remaining minutes. Once
 * collapsed the bound never grows back: the socket is closed, so no new run
 * can arrive to hold the drain again.
 */
export function createDrainDeadline(drainStartedAt: number): (now: number, runsHeld: number) => number {
  const full = drainStartedAt + DRAIN_DEADLINE_MS;
  let collapsed: number | undefined;
  return (now, runsHeld) => {
    if (collapsed !== undefined) return collapsed;
    if (runsHeld > 0) return full;
    collapsed = Math.min(full, now + HANDOFF_BUDGET_MS);
    return collapsed;
  };
}

/** Time budgeted for the replacement container to boot and reach Socket Mode
 *  `connected` (image pull + Node start + Bolt handshake), when the catch-up
 *  scan runs. */
export const COLD_START_ALLOWANCE_MS = 5 * 60_000;

/** The smallest catch-up window that still covers a full-length drain. A
 *  smaller window leaves mentions posted early in a long drain un-run forever. */
export const MIN_CATCH_UP_WINDOW_MS = DRAIN_DEADLINE_MS + COLD_START_ALLOWANCE_MS;

/**
 * Startup validation for `slack.catchUp.windowMinutes`. Returns a warning to
 * log when the configured window cannot cover a full drain, or is not a usable
 * duration; `undefined` when unset (the default applies) or safe. Never clamps:
 * the operator's value stands — the warning names what it costs.
 */
export function catchUpWindowWarning(windowMinutes: number | undefined): string | undefined {
  if (windowMinutes === undefined) return undefined;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return `slack.catchUp.windowMinutes must be a positive number of minutes (got ${String(windowMinutes)}); no catch-up window is usable`;
  }
  const windowMs = windowMinutes * 60_000;
  if (windowMs >= MIN_CATCH_UP_WINDOW_MS) return undefined;
  return (
    `slack.catchUp.windowMinutes=${windowMinutes} (${windowMinutes} min) is below the safe minimum of ${MIN_CATCH_UP_WINDOW_MS / 60_000} min ` +
    `(the ${DRAIN_DEADLINE_MS / 60_000} min drain deadline + ${COLD_START_ALLOWANCE_MS / 60_000} min cold start): ` +
    `mentions posted early in a deploy-time drain longer than ${windowMinutes} min will never be caught up. Keeping the configured value.`
  );
}
