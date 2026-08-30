import { COLD_START_ALLOWANCE_MS, DRAIN_DEADLINE_MS } from "../core/drain.js";

// "Deployed" is not "live". `wrangler deploy` uploads a Worker version and
// starts a container rollout, but the OLD bot container keeps serving while it
// drains in-flight runs (up to DRAIN_DEADLINE_MS) — the first live `deploy:all`
// (2026-08-30 05:12Z) printed `bot … deployed`, exited 0, and the old container
// was still draining two runs. This module is the pure half of the live gate
// `deploy:all` runs after the bot step: read `/healthz`, decide whether the NEW
// container — identified by the commit baked into its image (`build.commit`,
// src/channels/health.ts) — is the one answering, and say why not otherwise.
// No node:* imports; the CLI does the fetching and the clock.

/** What the gate needs from a `/healthz` body (src/channels/health.ts `HealthPayload`). */
export interface HealthzBody {
  ok?: unknown;
  inFlight?: unknown;
  draining?: unknown;
  drainStartedAt?: unknown;
  build?: { commit?: unknown; builtAt?: unknown } | unknown;
}

/** Parse a `/healthz` response body; undefined when it is not a JSON object
 *  (a container mid-restart answers nothing, a pre-item-8 Worker answers `ok`). */
export function parseHealthz(text: string): HealthzBody | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as HealthzBody) : undefined;
  } catch {
    return undefined;
  }
}

/** How long the gate waits for the new container: the drain deadline the old
 *  one may use in full, plus the same cold-start allowance the reconnect
 *  catch-up budgets (`COLD_START_ALLOWANCE_MS`, item 7) — one number for "how
 *  long until the replacement is up", so the gate cannot time out a container
 *  the catch-up still expects to arrive. */
export const LIVE_GATE_DEADLINE_MS = DRAIN_DEADLINE_MS + COLD_START_ALLOWANCE_MS;
/** `/healthz` poll interval while waiting to go live. */
export const LIVE_GATE_POLL_MS = 15_000;

export type LiveDecision =
  | { kind: "live"; commit: string }
  | { kind: "waiting"; reason: string }
  | { kind: "timeout"; reason: string };

function servedCommit(body: HealthzBody): string | undefined {
  const b = body.build;
  if (typeof b !== "object" || b === null) return undefined;
  const c = (b as { commit?: unknown }).commit;
  return typeof c === "string" && c !== "" ? c : undefined;
}

/** Two commit identities name the same commit when one is a prefix of the other
 *  (≥7 chars) — `git rev-parse HEAD` vs. a short form; a `-dirty` suffix never matches. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (x.length < 7 || y.length < 7) return false;
  if (x.endsWith("-dirty") || y.endsWith("-dirty")) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * The decision for one poll. `live` only when the body is JSON, not draining,
 * and carries the expected commit. Everything else is `waiting` with the reason
 * an operator would want to read — until `elapsedMs` reaches `deadlineMs`, when
 * the same reason becomes a `timeout` (the CLI exits non-zero: never report
 * success when not live).
 */
export function decideLive(body: HealthzBody | undefined, expectedCommit: string, elapsedMs: number, deadlineMs: number = LIVE_GATE_DEADLINE_MS): LiveDecision {
  let reason: string;
  if (!body) {
    reason = "/healthz not answering with JSON (container restarting, or unreachable)";
  } else if (body.draining === true) {
    const n = typeof body.inFlight === "number" ? body.inFlight : "?";
    const since = typeof body.drainStartedAt === "string" ? ` since ${body.drainStartedAt}` : "";
    reason = `old container still draining — ${n} run(s) in flight${since}`;
  } else {
    const commit = servedCommit(body);
    if (!commit) reason = "/healthz carries no build identity — a container that predates the live gate is answering";
    else if (commit === "unknown") reason = "serving a build with commit \"unknown\" (image built without build.json)";
    else if (!sameCommit(commit, expectedCommit)) reason = `serving commit ${commit.slice(0, 7)}, expected ${expectedCommit.slice(0, 7)} (old container still up)`;
    else return { kind: "live", commit };
  }
  return elapsedMs >= deadlineMs ? { kind: "timeout", reason } : { kind: "waiting", reason };
}

/** The line printed on every preflight retry, so a long wait is never silent. */
export function heartbeatLine(step: string, body: HealthzBody | undefined, elapsedMs: number, waitMaxMs: number): string {
  const waited = `waited ${Math.floor(elapsedMs / 60_000)}m of ${Math.round(waitMaxMs / 60_000)}m`;
  if (!body) return `[deploy:all] ${step}: still waiting — /healthz not answering, ${waited}`;
  const n = typeof body.inFlight === "number" ? body.inFlight : "?";
  return `[deploy:all] ${step}: still waiting — ${n} run(s) in flight (draining: ${body.draining === true ? "yes" : "no"}), ${waited}`;
}
