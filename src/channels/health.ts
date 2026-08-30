import { DRAIN_DEADLINE_MS } from "../core/drain.js";

// `GET /healthz` body. Beyond liveness it is the bot deploy preflight's source
// of truth (deploy/cloudflare/preflight.mjs, features/slack-channel.md item 8):
// a `wrangler deploy` rolls the container, and a rollout that lands on a run
// in flight — or on an instance already draining from a previous rollout —
// kills the run and freezes its status card (live 2026-08-29 23:51Z). The
// preflight refuses while `inFlight > 0` or `draining` is true.
//
// A drain also blacks Slack out until the process exits (#272, item 7), so the
// body carries the drain deadline and, while draining, when it started: an
// operator can read how long the blackout can still last.
//
// The Worker's per-minute keep-alive and the post-deploy `wake` only check the
// HTTP status, so the body shape is free to be JSON. Counts and timings only —
// nothing here is sensitive, and the endpoint is public (it must be reachable
// from the operator's shell without an Access session).

export interface HealthState {
  /** Agent runs in flight (`activeRunCount()`) plus pending memory reflections. */
  inFlight: number;
  /** True once the process has received SIGTERM/SIGINT and is draining. */
  draining: boolean;
  /** Epoch ms when the drain began; only reported while `draining`. */
  drainStartedAt?: number;
}

export interface HealthPayload {
  ok: true;
  inFlight: number;
  draining: boolean;
  /** How long the drain holds the process (and the Slack blackout) at most. */
  drainDeadlineMs: number;
  /** ISO timestamp of the drain start; present only while draining. */
  drainStartedAt?: string;
}

export function healthPayload(state: HealthState): HealthPayload {
  const payload: HealthPayload = {
    ok: true,
    inFlight: state.inFlight,
    draining: state.draining,
    drainDeadlineMs: DRAIN_DEADLINE_MS,
  };
  if (state.draining && state.drainStartedAt !== undefined) {
    payload.drainStartedAt = new Date(state.drainStartedAt).toISOString();
  }
  return payload;
}
