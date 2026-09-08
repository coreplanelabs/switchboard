// Cloudflare Containers shim: runs the unchanged Switchboard image as a single
// always-on container instance. Follows the house pattern proven by
// coreplanelabs/infrastructure `terrateam/` (long-lived server in a container,
// singleton DO, cron keep-alive).
//
// The Worker exists to (re)start the container, run health checks, restart the
// container on request (`POST /admin/restart` — `deploy restart`), and fire
// the scheduled jobs — all Slack traffic is the container's own outbound Socket
// Mode websocket, so nothing user-facing flows through here. Scheduled jobs are
// NOT special: a `run` schedule is POSTed to the bot's generic /ingress as the
// `cron` identity, so it becomes an ordinary run (#244).
import { Container, getContainer } from "@cloudflare/containers";
import { parseHealthz } from "../../src/deploy/liveGate.ts";
import {
  authorizeRestart,
  decideRestart,
  parseRestartRequest,
  restartResponse,
  type RestartOutcome,
} from "../../src/deploy/restart.ts";
import {
  interpretIngressResponse,
  isRunSchedule,
  planScheduledFiring,
  recordFiring as postFiring,
  scheduleForCron,
  type ScheduleFiring,
} from "../../src/core/schedules.ts";

interface Env {
  SWITCHBOARD: DurableObjectNamespace<SwitchboardServer>;
  // secrets (wrangler secret put ...)
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY?: string;
  E2B_API_KEY?: string;
  SANDBOX_TOKEN?: string; // cloudflare execution: bearer for the sandbox Worker
  RESIDENT_OPERATOR_TOKEN?: string; // resident repos: operator bearer for the resident Worker
  RESIDENT_ADMIN_TOKEN?: string; // resident repos: admin bearer for `repo onboard/offboard/...` chat commands
  GH_TOKEN?: string; // fallback when no GitHub App is configured
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  PUBLIC_BASE_URL?: string; // live-view: base for /runs/<id>?t=… links on the status card
  ACCESS_TEAM_DOMAIN?: string; // live-view SSO gate: Cloudflare Access team domain (JWKS + iss)
  ACCESS_AUD?: string; // live-view SSO gate: Cloudflare Access application AUD tag
  SWITCHBOARD_INGRESS_TOKENS?: string; // enables HTTP /ingress + MCP /mcp (JSON token→identity map); the `cron` entry is what scheduled runs present; an entry with `deploy:write` may POST /admin/restart
  BRAVE_SEARCH_API_KEY?: string; // web_search backend (Brave); web_fetch works without it
  CF_ANALYTICS_TOKEN?: string; // costs dash: Cloudflare API token, Account Analytics:Read only
  ANTHROPIC_ADMIN_KEY?: string; // costs dash (optional): Anthropic Admin API key for the LLM cost report
  MEMORY_TOKEN?: string; // durable memory + friction ledger + schedule firings + MCP registry: bearer for the state Worker
  MCP_CREDENTIAL_KEY?: string; // MCP registry (#394): the bot-only key that seals server credentials before they reach the McpDO
  STATE_WORKER_URL?: string; // var: the state Worker's base URL — where this shim records each scheduled firing (#244)
}

/** Every secret/var the Worker forwards into the container. Optional entries
 *  are forwarded only when set, so the bot sees "not configured" as absence. */
const FORWARDED_OPTIONAL = [
  "OPENAI_API_KEY",
  "E2B_API_KEY",
  "SANDBOX_TOKEN",
  "RESIDENT_OPERATOR_TOKEN",
  "RESIDENT_ADMIN_TOKEN",
  "GH_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "PUBLIC_BASE_URL",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "CF_ANALYTICS_TOKEN",
  "ANTHROPIC_ADMIN_KEY",
  "SWITCHBOARD_INGRESS_TOKENS",
  "BRAVE_SEARCH_API_KEY",
  "MEMORY_TOKEN",
  "MCP_CREDENTIAL_KEY",
  "STATE_WORKER_URL",
] as const satisfies readonly (keyof Env)[];

/** The container's environment, computed from the Worker env AT START TIME.
 *  A running container keeps the env it started with, whatever `wrangler
 *  secret put` has since changed on the Worker — so this is read on every
 *  (re)start rather than once in the constructor: after `deploy restart`
 *  stops the container, the next start carries the current secrets. */
function containerEnv(env: Env): Record<string, string> {
  const vars: Record<string, string> = {
    // The image carries no config: the bot reads the `base` document `deploy config`
    // pushed to the state Worker (src/configDocument.ts), reached through
    // STATE_WORKER_URL + MEMORY_TOKEN forwarded below.
    SWITCHBOARD_CONFIG: "state://base",
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: env.SLACK_APP_TOKEN,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  };
  for (const name of FORWARDED_OPTIONAL) {
    const value = env[name];
    if (value) vars[name] = value;
  }
  return vars;
}

const INSTANCE = "singleton";
const INTERNAL = "https://switchboard-keepalive.internal";

export class SwitchboardServer extends Container<Env> {
  defaultPort = 8080; // the bot's health endpoint (PORT=8080 in the image)
  // Never let this scale to zero: the Slack websocket must stay connected and
  // Slack does not redeliver missed Socket Mode events. The keep-alive cron
  // pings /healthz every MINUTE (wrangler.jsonc `* * * * *`, deliberate: it
  // bounds the Slack deaf window after a stop/rollover — the sooner a touch
  // restarts the container, the sooner the reconnect catch-up can run).
  sleepAfter = "2h";

  /** Start the container if it is not running, with the env computed now.
   *  Default port-ready timeout is 20s; first boot (npm-less image, but cold
   *  pull + Slack connect) can exceed it. Already running → a no-op (the
   *  start options are not applied to a live container). */
  private startBot(): Promise<void> {
    return this.startAndWaitForPorts(
      this.defaultPort,
      { portReadyTimeoutMS: 120_000 },
      { envVars: containerEnv(this.env) },
    );
  }

  override async fetch(request: Request): Promise<Response> {
    await this.startBot();
    return super.fetch(request);
  }

  /**
   * `deploy restart`: stop the container WITHOUT an image build so it comes
   * back on the Worker's current secrets. Cloudflare's idiom — `stop()` sends
   * SIGTERM, the bot's graceful drain (src/index.ts) finishes in-flight runs
   * and exits, and the NEXT request through `fetch` starts the container again
   * (`startBot`, env computed then). The keep-alive cron GETs /healthz every
   * minute and the CLI's live gate polls it every 15 s, so the next request is
   * never more than seconds away. Refuses (the deploy preflight's rules) while
   * runs are in flight or a drain is already under way unless `force`.
   */
  async restart(opts: { force: boolean }): Promise<RestartOutcome> {
    if (!this.ctx.container?.running) return { kind: "not-running" };
    const health = await this.containerFetch(new Request(`${INTERNAL}/healthz`), this.defaultPort);
    const body = parseHealthz(await health.text().catch(() => ""));
    const verdict = decideRestart(body, opts);
    if (!verdict.allow) return { kind: "refused", problems: verdict.problems };
    const inFlight = typeof body?.inFlight === "number" ? body.inFlight : 0;
    const previousStartedAt = typeof body?.startedAt === "string" ? body.startedAt : undefined;
    console.log(
      `[restart] SIGTERM → container (started ${previousStartedAt ?? "unknown"}, ${inFlight} in flight${verdict.forced ? ", FORCED" : ""})`,
    );
    await this.stop();
    return { kind: "stopping", forced: verdict.forced, inFlight, previousStartedAt };
  }

  override onStop(params: { exitCode: number; reason: string }): void {
    // The next fetch (cron keep-alive within a minute, or the CLI's poll) starts it again with the current env.
    console.log(
      `[restart] container stopped (exit ${params.exitCode}, ${params.reason}) — restarts with the current env on the next request`,
    );
  }
}

/** `POST /admin/restart` — the operator surface behind `deploy restart`
 *  (src/deploy/restart.ts documents the authorization choice: a
 *  SWITCHBOARD_INGRESS_TOKENS bearer whose identity carries `deploy:write`).
 *  Body `{ "force": true }` bypasses the in-flight/draining refusal. */
async function handleAdminRestart(request: Request, env: Env): Promise<Response> {
  const json = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (request.method !== "POST") return json(405, { ok: false, error: "method not allowed: POST /admin/restart" });
  const auth = authorizeRestart(request.headers.get("authorization") ?? undefined, env.SWITCHBOARD_INGRESS_TOKENS);
  if (!auth.ok) {
    console.warn(`[restart] ${auth.status} — ${auth.reason}`);
    return json(auth.status, { ok: false, error: auth.reason });
  }
  const parsed = parseRestartRequest(await request.text().catch(() => ""));
  if (!parsed.ok) return json(400, { ok: false, error: parsed.reason });
  let outcome: RestartOutcome;
  try {
    outcome = await getContainer(env.SWITCHBOARD, INSTANCE).restart({ force: parsed.force });
  } catch (err) {
    // The container's /healthz probe or the DO call threw (container mid-transition,
    // port not answering): fail closed in the route's own JSON shape so the CLI reads
    // a reason instead of the platform's HTML 500. Nothing was stopped.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[restart] ${auth.subject} → error before stop: ${reason}`);
    return json(500, { ok: false, error: `restart failed before stopping anything: ${reason}` });
  }
  console.log(
    `[restart] ${auth.subject} → ${outcome.kind}${outcome.kind === "refused" ? `: ${outcome.problems.join("; ")}` : ""}`,
  );
  const res = restartResponse(outcome);
  return json(res.status, res.body);
}

/** Record a firing on the state Worker's ScheduleDO (the /runs Scheduled panel
 *  reads it). Best-effort: a failure here is a log line — the run itself (if
 *  any) already happened and is its own record. */
async function recordFiring(env: Env, firing: ScheduleFiring): Promise<void> {
  const res = await postFiring({ url: env.STATE_WORKER_URL, token: env.MEMORY_TOKEN }, firing);
  if (!res.ok) console.error(`[schedule] ${firing.schedule}: recording the firing failed — ${res.reason}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The one route the Worker answers itself; everything else is the container's.
    if (new URL(request.url).pathname === "/admin/restart") return handleAdminRestart(request, env);
    return getContainer(env.SWITCHBOARD, INSTANCE).fetch(request);
  },

  // Every cron trigger in wrangler.jsonc is a `bot` schedule in the registry
  // (src/core/schedules.ts — a unit test keeps the two equal). `healthz` (the
  // internal keep-alive) touches /healthz: any touch starts the container if
  // stopped and renews the activity timeout, which is also what revives it after
  // platform maintenance; internal, so nothing is recorded. A `run` schedule
  // POSTs the bot's generic /ingress as the `cron` identity (its bearer is the
  // `cron` entry of SWITCHBOARD_INGRESS_TOKENS — no extra secret) with the
  // schedule's command text; the bot dispatches it as a normal run and answers
  // with the run's id + status, which is recorded on the state Worker for the
  // /runs Scheduled panel. Fail-closed: no `cron` token → nothing is sent and the
  // firing is recorded as `misconfigured`; an ingress error (bot down, unknown
  // identity) is recorded as `ingress-error`.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const schedule = scheduleForCron(controller.cron, "bot");
    if (!schedule) {
      console.error(
        `[schedule] cron "${controller.cron}" is not a bot schedule in the registry — nothing fired (wrangler.jsonc and src/core/schedules.ts have drifted)`,
      );
      return;
    }
    if (schedule.action.type === "healthz") {
      const res = await getContainer(env.SWITCHBOARD, INSTANCE).fetch(new Request(`${INTERNAL}/healthz`));
      if (!res.ok) console.error(`switchboard health check failed: ${res.status}`);
      return;
    }
    if (!isRunSchedule(schedule)) {
      console.error(
        `[schedule] ${schedule.name}: action "${schedule.action.type}" is not something the bot shim fires — nothing fired (the registry entry names the wrong worker)`,
      );
      return;
    }

    const firedAt = controller.scheduledTime || Date.now();
    const plan = planScheduledFiring(schedule, env.SWITCHBOARD_INGRESS_TOKENS, firedAt);
    if (!plan.ok) {
      console.error(`[schedule] ${schedule.name}: not armed — ${plan.reason}; nothing ran`);
      ctx.waitUntil(
        recordFiring(env, { schedule: schedule.name, firedAt, outcome: "misconfigured", detail: plan.reason }),
      );
      return;
    }
    let firing: ScheduleFiring;
    try {
      const res = await getContainer(env.SWITCHBOARD, INSTANCE).fetch(
        new Request(`${INTERNAL}/ingress`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${plan.token}` },
          body: JSON.stringify(plan.body),
        }),
      );
      firing = interpretIngressResponse(schedule, firedAt, res.status, await res.text().catch(() => ""));
    } catch (err) {
      firing = {
        schedule: schedule.name,
        firedAt,
        outcome: "ingress-error",
        detail: `fetch failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      };
    }
    // Ids, outcome, and the reply's first line only — never a token.
    console.log(
      `[schedule] ${schedule.name} → ${firing.outcome}${firing.runId ? ` run ${firing.runId}` : ""}${firing.detail ? ` — ${firing.detail}` : ""}`,
    );
    // Telemetry for the /runs Scheduled panel — best-effort and off the
    // invocation's critical path: the cron completes when the ingress answered,
    // not when the state Worker has acknowledged the record.
    ctx.waitUntil(recordFiring(env, firing));
  },
} satisfies ExportedHandler<Env>;
