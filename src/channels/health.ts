// `GET /healthz` body. Beyond liveness it is the bot deploy preflight's source
// of truth (deploy/cloudflare/preflight.mjs, features/slack-channel.md item 8):
// a `wrangler deploy` rolls the container, and a rollout that lands on a run
// in flight — or on an instance already draining from a previous rollout —
// kills the run and freezes its status card (live 2026-08-29 23:51Z). The
// preflight refuses while `inFlight > 0` or `draining` is true.
//
// The Worker's per-minute keep-alive and the post-deploy `wake` only check the
// HTTP status, so the body shape is free to be JSON. Counts only — nothing
// here is sensitive, and the endpoint is public (it must be reachable from
// the operator's shell without an Access session).

export interface HealthState {
  /** Agent runs in flight (`activeRunCount()`) plus pending memory reflections. */
  inFlight: number;
  /** True once the process has received SIGTERM/SIGINT and is draining. */
  draining: boolean;
}

export function healthPayload(state: HealthState): { ok: true; inFlight: number; draining: boolean } {
  return { ok: true, inFlight: state.inFlight, draining: state.draining };
}
