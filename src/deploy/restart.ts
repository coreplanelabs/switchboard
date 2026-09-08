import { parseIngressTokenMap } from "../core/ingressTokens.js";
import { LIVE_GATE_DEADLINE_MS, parseHealthz, type HealthzBody } from "./liveGate.js";
import { profileUrls, type DeploymentProfile } from "./profile.js";

// `deploy restart` — restart the bot container WITHOUT an image build, so a
// rotated bot secret goes live in seconds instead of a full `deploy all --only
// bot` (features/slack-channel.md item 8). Cloudflare's model: `wrangler secret
// put` updates the Worker's env, but a running container keeps the env it
// started with, and a rollout only happens on an image/config change. The
// documented restart is the Container DO calling `stop()` (SIGTERM → the bot's
// graceful drain finishes in-flight runs and exits) and the NEXT request
// starting it again — with envVars computed at start time from the DO's
// current env (deploy/cloudflare/worker.ts). The Worker exposes that as
// `POST /admin/restart`; this module is the pure half shared by the Worker
// (authorization, the refusal decision, the wire shapes) and the CLI runner
// (src/deploy/run.ts `runBotRestart`), so both sides are unit-tested here and
// nothing in this file imports node:*.
//
// Authorization: the bearer must be an entry of the bot's own
// `SWITCHBOARD_INGRESS_TOKENS` map whose identity carries `deploy:write` — the
// very scope the `deploy.restart` command declares, so the Worker route is
// authorized exactly as `/api/deploy.restart` would be if the bot served it.
// Reused rather than minted: the Worker already holds and parses that map (it
// fires scheduled runs with the `cron` entry), the resident precedent for a
// privileged deploy operation is likewise a bearer in the operator's env
// (`RESIDENT_ADMIN_TOKEN`), and an Access JWT cannot be checked here — the
// operator rule lives in the container's config.yaml, not in the Worker.
//
// The route's URL is the installation's: the deployment profile names the
// bot's hostname, `planRestart` derives `https://<bot>/admin/restart` from it.

/** The operator's env var holding a `SWITCHBOARD_INGRESS_TOKENS` bearer with `deploy:write`. */
export const RESTART_TOKEN_ENV = "SWITCHBOARD_DEPLOY_TOKEN";
/** The scope the bearer's identity must carry — the `deploy.restart` command's own. */
export const RESTART_SCOPE = "deploy:write";

// ---- refusal decision (Worker side; the CLI relies on the 409) -----------------------------

export interface RestartVerdict {
  allow: boolean;
  forced: boolean;
  problems: string[];
  message: string;
}

/**
 * Whether the container may be stopped now — the deploy preflight's rules
 * (deploy/cloudflare/preflight.mjs `decide`) minus the rollout-state check
 * (a restart is not a rollout): refuse while runs are in flight or a drain is
 * already under way; fail closed on a body that is not JSON or an impossible
 * count. `force` allows anyway, with the warning.
 */
export function decideRestart(body: HealthzBody | undefined, opts: { force: boolean }): RestartVerdict {
  const problems: string[] = [];
  if (!body) {
    problems.push(
      "bot not answering with JSON on /healthz (container restarting, unreachable, or a Worker that predates the preflight)",
    );
  } else {
    if (!Number.isInteger(body.inFlight) || (body.inFlight as number) < 0) {
      problems.push(`bot reports an impossible inFlight=${JSON.stringify(body.inFlight)} (counter bug or old Worker)`);
    } else if ((body.inFlight as number) > 0) {
      problems.push(`${body.inFlight} run(s) in flight — a restart would kill them`);
    }
    if (body.draining === true)
      problems.push(
        "bot is already draining (a deploy or an earlier restart is in progress) — it restarts on its own when the drain ends",
      );
  }
  if (problems.length === 0)
    return { allow: true, forced: false, problems, message: "restart ok: no runs in flight, not draining" };
  const detail = problems.map((p) => `  - ${p}`).join("\n");
  if (opts.force)
    return {
      allow: true,
      forced: true,
      problems,
      message: `restart WARNING: stopping by force despite —\n${detail}\n  in-flight runs get SIGTERM'd into the drain: they finish if they can, else are killed at the drain deadline and their status cards left for the next connect's sweep to close`,
    };
  return {
    allow: false,
    forced: false,
    problems,
    message: `restart REFUSED —\n${detail}\n  wait and retry, or pass --force to drain (and at the deadline kill) what is in flight`,
  };
}

// ---- authorization (Worker side) ---------------------------------------------------------------

/** Byte-wise equality whose running time depends only on the lengths, never on
 *  where the first difference is. */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Find the presented bearer among the configured tokens by comparing against
 *  EVERY entry (fixed work; a plain object-key lookup would let a probe learn
 *  which prefixes exist from timing). Returns the matched identity, if any. */
export function lookupConstantTime<T>(tokens: Record<string, T>, presented: string): T | undefined {
  let found: T | undefined;
  for (const [token, identity] of Object.entries(tokens)) if (constantTimeEqual(token, presented)) found = identity;
  return found;
}

export type RestartAuth = { ok: true; subject: string } | { ok: false; status: 401 | 403 | 503; reason: string };

/** Check `Authorization: Bearer <token>` against the raw `SWITCHBOARD_INGRESS_TOKENS`
 *  value. No usable map → 503 (the route is disabled, never open); no/unknown
 *  bearer → 401; a known identity without `deploy:write` → 403. Never echoes
 *  token material. */
export function authorizeRestart(authorization: string | undefined, tokensRaw: string | undefined): RestartAuth {
  const parsed = parseIngressTokenMap(tokensRaw);
  if (!parsed.ok || Object.keys(parsed.tokens).length === 0) {
    return {
      ok: false,
      status: 503,
      reason: `restart disabled: SWITCHBOARD_INGRESS_TOKENS is ${parsed.ok ? "not set" : parsed.reason}`,
    };
  }
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  const identity = m ? lookupConstantTime(parsed.tokens, m[1]) : undefined;
  if (!identity)
    return {
      ok: false,
      status: 401,
      reason: "unauthorized: a Bearer token from SWITCHBOARD_INGRESS_TOKENS is required",
    };
  if (!identity.scopes.includes(RESTART_SCOPE))
    return {
      ok: false,
      status: 403,
      reason: `forbidden: identity "${identity.subject}" lacks the ${RESTART_SCOPE} scope`,
    };
  return { ok: true, subject: identity.subject };
}

// ---- wire shapes ----------------------------------------------------------------------------------

export type ParsedRestartRequest = { ok: true; force: boolean } | { ok: false; reason: string };

/** The request body: empty, or a JSON object with an optional boolean `force`. */
export function parseRestartRequest(text: string): ParsedRestartRequest {
  if (text.trim() === "") return { ok: true, force: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, reason: "body must be a JSON object" };
  const force = (parsed as { force?: unknown }).force;
  if (force !== undefined && typeof force !== "boolean") return { ok: false, reason: "`force` must be a boolean" };
  return { ok: true, force: force === true };
}

/** What the Container DO reports back to the Worker route. */
export type RestartOutcome =
  /** The container is not running: nothing to stop; the next request starts it with the current env. */
  | { kind: "not-running" }
  | { kind: "refused"; problems: string[] }
  /** SIGTERM sent; `previousStartedAt` is what the OLD container reported (the CLI's baseline). */
  | { kind: "stopping"; forced: boolean; inFlight: number; previousStartedAt: string | undefined };

export interface RestartHttpResponse {
  status: number;
  body: Record<string, unknown>;
}

export function restartResponse(outcome: RestartOutcome): RestartHttpResponse {
  switch (outcome.kind) {
    case "stopping":
      return {
        status: 202,
        body: {
          ok: true,
          stopping: true,
          forced: outcome.forced,
          inFlight: outcome.inFlight,
          previousStartedAt: outcome.previousStartedAt,
        },
      };
    case "refused":
      return { status: 409, body: { ok: false, refused: true, problems: outcome.problems } };
    case "not-running":
      return {
        status: 200,
        body: {
          ok: true,
          stopping: false,
          note: "container not running — nothing to stop; the next request starts it with the current env",
        },
      };
  }
}

/** The CLI's reading of the route's answer. */
export type RestartResponseClass =
  | { kind: "stopping"; previousStartedAt: string | undefined }
  | { kind: "not-running" }
  /** 409 — retryable while runs finish. */
  | { kind: "refused"; reason: string }
  | { kind: "unauthorized"; reason: string }
  | { kind: "failed"; reason: string };

export function classifyRestartResponse(status: number, text: string): RestartResponseClass {
  const body = parseHealthz(text) as Record<string, unknown> | undefined;
  if (status === 202)
    return {
      kind: "stopping",
      previousStartedAt: typeof body?.previousStartedAt === "string" ? body.previousStartedAt : undefined,
    };
  if (status === 200 && body?.stopping === false) return { kind: "not-running" };
  if (status === 409) {
    const problems = Array.isArray(body?.problems)
      ? body.problems.filter((p): p is string => typeof p === "string")
      : [];
    return { kind: "refused", reason: problems[0] ?? "restart refused" };
  }
  if (status === 401 || status === 403)
    return { kind: "unauthorized", reason: `HTTP ${status}: ${text.slice(0, 200)}` };
  return { kind: "failed", reason: `HTTP ${status}: ${text.slice(0, 200)}` };
}

// ---- the plan (what `deploy restart` does, as data) --------------------------------------------

export interface RestartOptions {
  /** The only supported target for now: the bot is the one Worker with a long-lived container. */
  only: "bot";
  force: boolean;
  waitMaxMinutes: number;
  pollSeconds: number;
}

export interface RestartPlan {
  target: "bot";
  adminUrl: string;
  healthUrl: string;
  tokenEnv: string;
  force: boolean;
  /** Budget for waiting out a 409 (runs in flight) before giving up. */
  waitMaxMs: number;
  pollMs: number;
  /** Budget for the new container to answer with a later `startedAt` (drain + cold start). */
  liveDeadlineMs: number;
}

export function planRestart(opts: RestartOptions, profile: DeploymentProfile): RestartPlan {
  const urls = profileUrls(profile);
  return {
    target: opts.only,
    adminUrl: urls.botAdminRestartUrl,
    healthUrl: urls.healthUrl("bot"),
    tokenEnv: RESTART_TOKEN_ENV,
    force: opts.force,
    waitMaxMs: opts.waitMaxMinutes * 60_000,
    pollMs: opts.pollSeconds * 1000,
    liveDeadlineMs: LIVE_GATE_DEADLINE_MS,
  };
}

export function formatRestartPlan(plan: RestartPlan): string {
  const gate = plan.force
    ? `preflight FORCED — in-flight runs are drained (SIGTERM), killed only at the drain deadline`
    : `refused while runs are in flight or draining (409) — retry every ${plan.pollMs / 1000}s up to ${plan.waitMaxMs / 60_000} min`;
  return [
    `Restart ${plan.target}: POST ${plan.adminUrl} (bearer from $${plan.tokenEnv}, needs ${RESTART_SCOPE}) — ${gate}`,
    `  then wait until ${plan.healthUrl} answers not draining with a later startedAt (up to ${Math.round(plan.liveDeadlineMs / 60_000)} min: drain + cold start)`,
    `  no image build: the container restarts on the same build with the Worker's CURRENT secrets`,
  ].join("\n");
}
