import { DRAIN_DEADLINE_MS } from "../core/drain.js";
import type { CatchUpStatus } from "./slackCatchUpStatus.js";

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
// It also carries the reconnect catch-up's last outcome and the bot token's
// missing scopes (item 7, #271) — the only place those are visible without
// container logs; the preflight WARNS on them but never refuses.
//
// The Worker's per-minute keep-alive and the post-deploy `wake` only check the
// HTTP status, so the body shape is free to be JSON. Counts, timings, an error
// string and scope names only — nothing here is sensitive, and the endpoint is
// public (it must be reachable from the operator's shell without an Access
// session).

export interface HealthState {
  /** Agent runs in flight (`activeRunCount()`) plus pending memory reflections. */
  inFlight: number;
  /** True once the process has received SIGTERM/SIGINT and is draining. */
  draining: boolean;
  /** Epoch ms when the drain began; only reported while `draining`. */
  drainStartedAt?: number;
  /** The reconnect catch-up's record (`getCatchUpStatus()`); `{}` before the first scan. */
  catchUp?: CatchUpStatus;
}

export interface HealthPayload {
  ok: true;
  inFlight: number;
  draining: boolean;
  /** How long the drain holds the process (and the Slack blackout) at most. */
  drainDeadlineMs: number;
  /** ISO timestamp of the drain start; present only while draining. */
  drainStartedAt?: string;
  /** Present whenever `HealthState.catchUp` is given. The bot process always
   *  passes `getCatchUpStatus()` (`{}` before the first scan), so on the live
   *  `/healthz` it is unconditionally present; a caller that omits the state
   *  (another entrypoint, a test) gets no key. Undefined fields are dropped. */
  catchUp?: CatchUpStatus;
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
  if (state.catchUp) {
    const catchUp: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(state.catchUp)) if (v !== undefined) catchUp[k] = v;
    payload.catchUp = catchUp as CatchUpStatus;
  }
  return payload;
}
