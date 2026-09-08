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
  /** ISO process start — `deploy restart`'s identity (the image, hence `build.commit`, is unchanged). */
  startedAt?: unknown;
}

/** Parse a `/healthz` response body; undefined when it is not a JSON object
 *  (a container mid-restart answers nothing, a pre-item-8 Worker answers `ok`). */
export function parseHealthz(text: string): HealthzBody | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as HealthzBody)
      : undefined;
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

/** One poll's verdict: `live` carrying the identity that proved it, or the
 *  reason an operator would want to read — `waiting` until the deadline,
 *  `timeout` after it (the CLI exits non-zero: never report success when not live). */
export type ReadyDecision<Identity> =
  ({ kind: "live" } & Identity) | { kind: "waiting"; reason: string } | { kind: "timeout"; reason: string };

export type LiveDecision = ReadyDecision<{ commit: string }>;
export type RestartDecision = ReadyDecision<{ startedAt: string }>;

function servedCommit(body: HealthzBody): string | undefined {
  const b = body.build;
  if (typeof b !== "object" || b === null) return undefined;
  const c = (b as { commit?: unknown }).commit;
  return typeof c === "string" && c !== "" ? c : undefined;
}

/** The part of a live decision every gate shares: a non-JSON body is never
 *  live; a JSON body is judged by `identify` — the identity that proves the NEW
 *  container is answering, or the reason it is not. A draining body is judged
 *  the same way (run-history item 39: a container that already serves the
 *  deployed identity IS live, whatever is rolling it next); when the identity
 *  is the old one, the reason names the drain — the more useful fact — unless
 *  `identify` already judged the same identity draining (`sameIdentity`: a
 *  same-commit rollout, decided by `startedAt`) and said why. Past
 *  `deadlineMs` the reason becomes a timeout. */
function decideReady<Identity>(
  body: HealthzBody | undefined,
  elapsedMs: number,
  deadlineMs: number,
  identify: (
    body: HealthzBody,
  ) => { live: true; identity: Identity } | { live: false; reason: string; sameIdentity?: true },
): ReadyDecision<Identity> {
  let reason: string;
  if (!body) {
    reason = "/healthz not answering with JSON (container restarting, or unreachable)";
  } else {
    const verdict = identify(body);
    if (verdict.live) return { kind: "live", ...verdict.identity };
    if (body.draining === true && !verdict.sameIdentity) {
      const n = typeof body.inFlight === "number" ? body.inFlight : "?";
      const since = typeof body.drainStartedAt === "string" ? ` since ${body.drainStartedAt}` : "";
      reason = `old container still draining — ${n} run(s) in flight${since}`;
    } else reason = verdict.reason;
  }
  return elapsedMs >= deadlineMs ? { kind: "timeout", reason } : { kind: "waiting", reason };
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
 * The decision for one poll. `live` only when the body is JSON and carries the
 * expected commit — and, when that container is DRAINING, only if it is provably
 * the new one: a rollout of the SAME commit (a Worker recovered with
 * `--only bot`, a forced `all` with no code change) drains an old container
 * that serves the deployed commit too, so the commit alone would call it live the
 * moment SIGTERM landed. The runner reads `startedAt` before the upload
 * (`opts.previousStartedAt`) and a draining same-commit container counts only
 * with a later one; without a pre-upload reading, a draining same-commit
 * container waits. Everything else is `waiting` with the reason an operator
 * would want to read — until `elapsedMs` reaches `deadlineMs`, when the same
 * reason becomes a `timeout` (the CLI exits non-zero: never report success when
 * not live).
 */
export function decideLive(
  body: HealthzBody | undefined,
  expectedCommit: string,
  elapsedMs: number,
  deadlineMs: number = LIVE_GATE_DEADLINE_MS,
  opts: { previousStartedAt?: string } = {},
): LiveDecision {
  return decideReady(body, elapsedMs, deadlineMs, (b) => {
    const commit = servedCommit(b);
    if (!commit)
      return {
        live: false,
        reason: "/healthz carries no build identity — a container that predates the live gate is answering",
      };
    if (commit === "unknown")
      return { live: false, reason: 'serving a build with commit "unknown" (image built without build.json)' };
    if (!sameCommit(commit, expectedCommit))
      return {
        live: false,
        reason: `serving commit ${commit.slice(0, 7)}, expected ${expectedCommit.slice(0, 7)} (old container still up)`,
      };
    if (b.draining === true) {
      const started = servedStartedAt(b);
      const newer =
        started !== undefined &&
        opts.previousStartedAt !== undefined &&
        Date.parse(started) > Date.parse(opts.previousStartedAt);
      if (!newer)
        return {
          live: false,
          sameIdentity: true,
          reason: `the deployed commit answers but is draining${started ? ` (started ${started})` : ""} — a same-commit rollout replaces it; waiting for the new container`,
        };
    }
    return { live: true, identity: { commit } };
  });
}

/** A parseable ISO `startedAt` from a body, else undefined. */
export function servedStartedAt(body: HealthzBody): string | undefined {
  const s = body.startedAt;
  return typeof s === "string" && Number.isFinite(Date.parse(s)) ? s : undefined;
}

/**
 * The live decision after `deploy restart`: the image is unchanged, so the
 * restarted container is recognised by a `startedAt` LATER than
 * `previousStartedAt` (what `/healthz` said before the restart was requested).
 * With no previous value (the old container predated `startedAt`), any
 * non-draining container that reports one counts. Same waiting/timeout
 * vocabulary as `decideLive`.
 */
export function decideRestarted(
  body: HealthzBody | undefined,
  previousStartedAt: string | undefined,
  elapsedMs: number,
  deadlineMs: number = LIVE_GATE_DEADLINE_MS,
): RestartDecision {
  return decideReady(body, elapsedMs, deadlineMs, (b) => {
    const startedAt = servedStartedAt(b);
    if (!startedAt)
      return {
        live: false,
        reason: "/healthz carries no startedAt — a container that predates `deploy restart` is answering",
      };
    if (previousStartedAt !== undefined && Date.parse(startedAt) <= Date.parse(previousStartedAt))
      return { live: false, reason: `old container still answering (started ${startedAt})` };
    return { live: true, identity: { startedAt } };
  });
}

/** The line printed on every preflight retry, so a long wait is never silent.
 *  `tag` names the command waiting (`deploy:all`, `deploy:restart`). */
export function heartbeatLine(
  step: string,
  body: HealthzBody | undefined,
  elapsedMs: number,
  waitMaxMs: number,
  tag = "deploy:all",
): string {
  const waited = `waited ${Math.floor(elapsedMs / 60_000)}m of ${Math.round(waitMaxMs / 60_000)}m`;
  if (!body) return `[${tag}] ${step}: still waiting — /healthz not answering, ${waited}`;
  const n = typeof body.inFlight === "number" ? body.inFlight : "?";
  return `[${tag}] ${step}: still waiting — ${n} run(s) in flight (draining: ${body.draining === true ? "yes" : "no"}), ${waited}`;
}
