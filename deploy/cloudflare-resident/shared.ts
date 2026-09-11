// What the resident Worker's entry (worker.ts) and the refresh instance
// (refresh.ts) both read: the tunables the cycle's cadence and step budgets
// derive from, the two Durable Object stub factories, the Worker's one tracer
// with its log sink, and the error-message helper. The module exists so that
// refresh.ts never imports worker.ts at runtime — the entry imports refresh.ts
// for the class the Workflows binding names, and an import back would be a
// cycle at module evaluation. The entry's types (`Env`, the DO classes) are
// imported `type`-only here and in refresh.ts; those imports are erased before
// either module evaluates.
import { getSandbox } from "@cloudflare/sandbox";
import { systemClock } from "../../src/core/trace/clock.js";
import { createTracer } from "../../src/core/trace/tracer.js";
import { workerLogSink } from "../../src/core/trace/workerTrace.js";
import type { Env } from "./worker";

/** Container sleep window, passed to every getSandbox() for ResidentDO.
 *  Invariant: REFRESH_INTERVAL_S and the watchdog cron (wrangler.jsonc,
 *  every 10 minutes) MUST both stay SHORTER than this window, so a healthy
 *  resident is re-warmed before the platform can sleep it. Bump together. */
export const SLEEP_AFTER = "20m";

/** Refresh alarm cadence (seconds). Each resident DO self-reschedules this
 *  alarm (per-resident alarms own freshness; the sparse cron is only the
 *  watchdog); it doubles as the keep-warm heartbeat, so it must stay below
 *  SLEEP_AFTER. Matches the watchdog cron so a killed chain is re-armed
 *  within one refresh interval. */
export const REFRESH_INTERVAL_S = 600;

/** How far out an idle resident's cycle is parked (seconds): the alarm's idle
 *  re-arm (`IDLE_AFTER_S` in worker.ts decides idleness) and the cron's idle
 *  cadence, in whole ten-minute buckets since the last instance. */
export const IDLE_REFRESH_INTERVAL_S = 6 * 60 * 60;

/** Exec budgets. The DO alarm handler has a ~15-minute platform wall clock;
 *  every schedule callback's step budgets are chosen to fit under it. */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const GIT_NETWORK_TIMEOUT_MS = 5 * 60_000;
export const REFRESH_BUILD_TIMEOUT_MS = 5 * 60_000;
/** The refresh install budget. Twice the build's: a full `npm install` of the
 *  switchboard lockfile takes ~4 min on the resident's 1 vCPU when nothing
 *  else runs, and thread runs (tests, a review's greps) share that vCPU —
 *  under load it crosses 5 min several cycles in a row while the default
 *  branch keeps moving. A timed-out install is worse than a slow one: the cycle's whole
 *  budget is spent and the checkout is left without deps, so the next cycle
 *  starts the same install over. The cycle runs in the background (runs keep
 *  attaching to the last snapshot); the cost of a longer budget is a longer
 *  mirror-lock window, bounded well inside STALE_MIDFLIGHT_MS. */
export const REFRESH_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Budget per R2 SNAPSHOT upload. The SDK's createBackup
 *  accepts no timeout or AbortSignal, so each call is raced against this
 *  (withTimeout): a hung upload fails the cycle into the existing degrade
 *  handling with a named error, instead of stranding `refreshing` until the
 *  30-min watchdog. Restores are NOT on this budget any more: a download is
 *  judged by the bytes arriving in its target (restoreWithProgress) —
 *  a fixed budget abandoned a 481 s restore that then completed.
 *  Same class as the other network budgets (observed live transfers run
 *  seconds, recorded in `lastRestore.ms`). */
export const R2_TRANSFER_TIMEOUT_MS = 5 * 60_000;
/** What the dependency install step runs around the install itself, each
 *  bounded: the scratch clone, the seed and its cache swap, the commit (one
 *  network budget each) and the harden (the default exec budget). The step's
 *  lease is the install budget plus this. */
export const DEPS_STEP_OVERHEAD_MS = 4 * GIT_NETWORK_TIMEOUT_MS + DEFAULT_EXEC_TIMEOUT_MS;

export const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The Worker's one tracer and its `slow` log sink, whose filter drops a
 *  refusal's line: the entry's edge and step roots and the refresh instance's
 *  `resident.refresh` root all start from these, so one isolate emits one
 *  consistent trace (docs/reference/specs/tracing.md item 22). */
export const tracer = createTracer({ clock: systemClock });
export const traceSinks = [workerLogSink((line) => console.log(line))];

export function registryStub(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

export function residentStub(env: Env, resource: string) {
  return getSandbox(env.RESIDENT, resource, { sleepAfter: SLEEP_AFTER });
}
