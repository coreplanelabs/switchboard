import { readFileSync } from "node:fs";
import { DRAIN_DEADLINE_MS } from "../core/drain.js";
import type { CatchUpStatus } from "./slackCatchUpStatus.js";
import type { SlackSocketStatus } from "./slackSocketStatus.js";

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
// `startedAt` (process start) is what `deploy restart`'s live gate compares:
// a restart re-uses the image, so `build.commit` cannot tell old from new.
//
// The Worker's per-minute keep-alive and the post-deploy `wake` only check the
// HTTP status, so the body shape is free to be JSON. Counts, timings, an error
// string and scope names only — nothing here is sensitive, and the endpoint is
// public (it must be reachable from the operator's shell without an Access
// session).

/** Which build this process is: the commit the image was built from (with a
 *  `-dirty` suffix when the tree had uncommitted changes; `"unknown"` when the
 *  image was built without `build.json`) and when. `npm run deploy` in
 *  `deploy/cloudflare/` writes the file (`write-build.mjs`) and the Dockerfile
 *  COPYs it; `deploy:all`'s live gate compares `commit` to what it deployed, so
 *  "deployed" is never mistaken for "live" (the old container keeps answering
 *  while it drains). */
export interface BuildInfo {
  commit: string;
  builtAt?: string;
}

export const UNKNOWN_BUILD: BuildInfo = { commit: "unknown" };

/** Read `build.json` once at startup. Missing or malformed → `UNKNOWN_BUILD`
 *  (never throws — a bot built by hand still starts and says so). */
export function readBuildInfo(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): BuildInfo {
  try {
    const parsed: unknown = JSON.parse(read(path));
    if (typeof parsed !== "object" || parsed === null) return UNKNOWN_BUILD;
    const b = parsed as Record<string, unknown>;
    if (typeof b.commit !== "string" || b.commit === "") return UNKNOWN_BUILD;
    return { commit: b.commit, ...(typeof b.builtAt === "string" ? { builtAt: b.builtAt } : {}) };
  } catch {
    return UNKNOWN_BUILD;
  }
}

export interface HealthState {
  /** Agent runs in flight (`activeRunCount()`) plus pending memory reflections. */
  inFlight: number;
  /** True once the process has received SIGTERM/SIGINT and is draining. */
  draining: boolean;
  /** Epoch ms when the drain began; only reported while `draining`. */
  drainStartedAt?: number;
  /** The reconnect catch-up's record (`getCatchUpStatus()`); `{}` before the first scan. */
  catchUp?: CatchUpStatus;
  /** The Socket Mode state (`getSocketStatus()`): `{connected:false}` from
   *  process boot until the handshake lands — the HTTP server starts FIRST, so
   *  this is how the cold-start window (and a silently dead socket) shows. */
  slack?: SlackSocketStatus;
  /** The running build (`readBuildInfo`), when the entrypoint knows it. */
  build?: BuildInfo;
  /** Epoch ms of the process start. `deploy restart` (no image build, same
   *  `build.commit`) tells the restarted container from the old one by this. */
  startedAt?: number;
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
  /** Present whenever `HealthState.slack` is given — the bot process always
   *  passes `getSocketStatus()`, so on the live `/healthz` it is
   *  unconditionally present; `since`/`connects` are dropped while absent. */
  slack?: SlackSocketStatus;
  /** Present whenever `HealthState.build` is given — the bot process always
   *  passes `readBuildInfo(...)`, so on the live `/healthz` it is unconditionally
   *  present (`commit: "unknown"` for an image built without `build.json`). */
  build?: BuildInfo;
  /** ISO process start; present whenever `HealthState.startedAt` is given (always on the live `/healthz`). */
  startedAt?: string;
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
  if (state.slack) {
    payload.slack = {
      connected: state.slack.connected,
      ...(state.slack.since !== undefined ? { since: state.slack.since } : {}),
      ...(state.slack.connects !== undefined ? { connects: state.slack.connects } : {}),
    };
  }
  if (state.build) payload.build = { commit: state.build.commit, ...(state.build.builtAt !== undefined ? { builtAt: state.build.builtAt } : {}) };
  if (state.startedAt !== undefined) payload.startedAt = new Date(state.startedAt).toISOString();
  return payload;
}
