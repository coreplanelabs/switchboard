import { parseIngressTokenMap, type IngressIdentity } from "../core/ingressTokens.js";
import { hasAction } from "../core/authz/authorize.js";
import type { GrantsLookup } from "../core/authz/actor.js";
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
// `SWITCHBOARD_INGRESS_TOKENS` map whose `http:<subject>` actor holds
// `deploy:write` in the bot's config (`grants`, authorization.md item 9) — the
// very action the `deploy.restart` command declares, so the Worker route is
// authorized exactly as `/api/deploy.restart` would be if the bot served it.
// Two halves, because the two sides hold different things: the Worker holds the
// token map (it fires scheduled runs with the `cron` entry) and can tell WHO a
// bearer is — `authenticateRestart`, 401/503 without touching the container —
// but the grants live in the container's config, so it asks the bot
// (`POST /admin/restart/authorize`, src/channels/adminRestartAuthorize.ts) whether
// that subject holds the action and relays the answer (`parseRestartAuthorization`).
// The bot's own `/admin/crash` runs the whole check in one place (`authorizeRestart`).
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
  /** What refuses (fail-closed: no JSON body, an impossible count). */
  problems: string[];
  /** What is said but does not refuse: runs in flight (they hand off), a drain under way. */
  warnings: string[];
  message: string;
}
/**
 * Whether the container may be stopped now — the deploy preflight's rules
 * (deploy/cloudflare/preflight.mjs `decide`) minus the rollout-state check (a
 * restart is not a rollout). Since the handoff (features/run-history.md item
 * 39) runs in flight and a drain under way are WARNINGS, not refusals: SIGTERM
 * hands every resumable run to the next generation. Fail closed on a body
 * that is not JSON or an impossible count; `force` allows those anyway, with
 * the warning.
 */
export function decideRestart(body: HealthzBody | undefined, opts: { force: boolean }): RestartVerdict {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!body) {
    problems.push(
      "bot not answering with JSON on /healthz (container restarting, unreachable, or a Worker that predates the preflight)",
    );
  } else {
    if (!Number.isInteger(body.inFlight) || (body.inFlight as number) < 0) {
      problems.push(`bot reports an impossible inFlight=${JSON.stringify(body.inFlight)} (counter bug or old Worker)`);
    } else if ((body.inFlight as number) > 0) {
      warnings.push(
        `${body.inFlight} run(s) in flight — handed to the next generation on SIGTERM (run-history item 39); they continue there`,
      );
    }
    if (body.draining === true)
      warnings.push(
        "bot is already draining (a deploy or an earlier restart is in progress) — it restarts on its own when the drain ends; a second stop is harmless",
      );
  }
  const said =
    warnings.length > 0 ? ` —\n${warnings.map((w) => `  - ${w}`).join("\n")}` : ": no runs in flight, not draining";
  if (problems.length === 0) return { allow: true, forced: false, problems, warnings, message: `restart ok${said}` };
  const detail = problems.map((p) => `  - ${p}`).join("\n");
  if (opts.force)
    return {
      allow: true,
      forced: true,
      problems,
      warnings,
      message: `restart WARNING: stopping by force despite —\n${detail}`,
    };
  return {
    allow: false,
    forced: false,
    problems,
    warnings,
    message: `restart REFUSED —\n${detail}\n  wait and retry, or pass --force to stop blind`,
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
export type RestartAuthn = { ok: true; identity: IngressIdentity } | { ok: false; status: 401 | 503; reason: string };

/** The bot route the Worker asks before stopping the container: 200 `{ ok, subject }`
 *  when the bearer's actor holds `deploy:write`, else `authorizeRestart`'s 401/403/503. */
export const RESTART_AUTHORIZE_PATH = "/admin/restart/authorize";

/** WHO the bearer is — the Worker's half. Check `Authorization: Bearer <token>`
 *  against the raw `SWITCHBOARD_INGRESS_TOKENS` value: no usable map → 503 (the
 *  route is disabled, never open); no/unknown bearer → 401. Says nothing about
 *  what the identity may do. Never echoes token material. */
export function authenticateRestart(authorization: string | undefined, tokensRaw: string | undefined): RestartAuthn {
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
  return { ok: true, identity };
}

/** WHO and WHETHER — the whole check, where the grants are (the bot). The
 *  bearer's `http:<subject>` actor must hold `deploy:write` (`grantsFor` —
 *  config's entry for the token's subject); a known identity without it → 403. */
export function authorizeRestart(
  authorization: string | undefined,
  tokensRaw: string | undefined,
  grantsFor: GrantsLookup,
): RestartAuth {
  const authn = authenticateRestart(authorization, tokensRaw);
  if (!authn.ok) return authn;
  const { identity } = authn;
  if (!hasAction(grantsFor(`http:${identity.subject}`).actions, RESTART_SCOPE))
    return {
      ok: false,
      status: 403,
      reason: `forbidden: identity "${identity.subject}" holds no ${RESTART_SCOPE} grant (grants["http:${identity.subject}"] in config.yaml)`,
    };
  return { ok: true, subject: identity.subject };
}

/** The bot's `POST /admin/restart/authorize` answer, as the Worker reads it: 200
 *  `{ ok: true, subject }` → allowed; 401 / 403 / 503 `{ ok: false, error }` →
 *  relayed as they are; anything else (a bot without the route, a non-JSON body,
 *  an unexpected status) → 503, fail-closed — the Worker never restarts on an
 *  answer it cannot read. */
export function parseRestartAuthorization(status: number, text: string): RestartAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  if (status === 200 && body?.ok === true && typeof body.subject === "string" && body.subject !== "")
    return { ok: true, subject: body.subject };
  if ((status === 401 || status === 403 || status === 503) && body?.ok === false && typeof body.error === "string")
    return { ok: false, status, reason: body.error };
  return {
    ok: false,
    status: 503,
    reason: `restart disabled: the bot did not answer the authorization check (HTTP ${status}) — is it running this version?`,
  };
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
    healthUrl: `${urls.publicBaseUrl}/healthz`,
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
