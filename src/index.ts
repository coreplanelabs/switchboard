import { createServer } from "node:http";
import { ConfigStore } from "./config.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createSlackApp } from "./channels/slack.js";
import { createIngressHandler, parseIngressTokens } from "./channels/http.js";
import { createMcpHandler } from "./channels/mcp.js";
import { createLiveViewHandler } from "./channels/liveView.js";
import { createResidentsViewHandler } from "./channels/residentsView.js";
import { createCostsViewHandler } from "./channels/costsView.js";
import { AnthropicCostReportSource, CloudflareGraphqlUsageSource, NullLlmCostSource, createCostsService, parseCostsConfig } from "./core/costs.js";
import { makeResidentAdminClient } from "./core/repoCommands.js";
import {
  httpJwksFetcher,
  JwksCache,
  parseAccessConfig,
  parseAccessDevBypass,
  requireAccessForRuns,
  type VerifyDeps,
} from "./channels/accessAuth.js";
import { defaultRunRegistry } from "./core/runRegistry.js";
import { BundledSkillStore, DEFAULT_SKILLS_DIR } from "./skills/index.js";
import { buildMemoryStore, pendingReflectionCount } from "./core/memory/index.js";
import { buildFrictionLedger, WorkerFrictionLedger } from "./core/frictionLedgerWorker.js";
import { healthPayload, readBuildInfo } from "./channels/health.js";
import { DRAIN_DEADLINE_MS } from "./core/drain.js";
import { getCatchUpStatus } from "./channels/slackCatchUpStatus.js";
import { activeRunCount, setShutdownNotice, type CoreDeps } from "./core/dispatcher.js";
import { buildScheduleStore } from "./core/scheduleStore.js";
import { SCHEDULES } from "./core/schedules.js";

const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? "./config/config.yaml";
const OVERRIDES_PATH = process.env.SWITCHBOARD_OVERRIDES ?? "./data/overrides.json";

async function main() {
  for (const v of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]) {
    if (!process.env[v]) {
      console.error(`Missing required env var ${v}`);
      process.exit(1);
    }
  }

  // Build identity for /healthz (features/slack-channel.md item 8): written by
  // `deploy/cloudflare/write-build.mjs` into the image; "unknown" when built by hand.
  const build = readBuildInfo(process.env.SWITCHBOARD_BUILD_INFO ?? "./build.json");
  console.log(`[build] ${build.commit}${build.builtAt ? ` @ ${build.builtAt}` : ""}`);
  const config = new ConfigStore(CONFIG_PATH, OVERRIDES_PATH);
  const providers = new ProviderRegistry(config.config.providers);
  // Bundled skills (#100): loaded once from the seeded `skills/` dir and shared
  // across all channels via CoreDeps, so review/coding get their scoped skill
  // list in-prompt and can load bodies on demand with use_skill.
  const skills = new BundledSkillStore(DEFAULT_SKILLS_DIR);
  // Cross-session memory (#85): ONE store instance shared by every channel so
  // what the reflection pass writes after a run is what the next run reads.
  // Durable WorkerMemoryStore when memory.worker (+ its bearer) is configured;
  // otherwise an in-process store with a loud warning (a restart loses it).
  // Disabled (default) → undefined → the dispatcher uses a NullMemoryStore.
  const memory = buildMemoryStore(config.config.memory, process.env, (m) => console.warn(`[memory] ${m}`));
  // Friction ledger (Area 7b, #84): every finished run's friction diagnosis, so
  // `friction propose` can cluster across recent runs. Durable WorkerFrictionLedger
  // (a Durable Object on the state Worker) when selfImprovement.worker + its
  // bearer are set; otherwise the host-disk JSONL file with a loud warning (an
  // ephemeral-disk deploy loses it on redeploy).
  const selfImprovement = config.config.selfImprovement;
  const frictionLedger = buildFrictionLedger(selfImprovement, process.env, {
    dataDir: "./data",
    warn: (m) => console.warn(`[friction] ${m}`),
  });
  console.log(
    `[friction] ledger: ${frictionLedger instanceof WorkerFrictionLedger ? `durable (${selfImprovement?.worker?.baseUrl})` : "host-disk file"}; ` +
      (selfImprovement?.repo ? `\`friction propose\` files to ${selfImprovement.repo}` : "`friction propose` disabled until selfImprovement.repo is set"),
  );
  const deps: CoreDeps = { config, providers, skills, memory, frictionLedger };
  const app = createSlackApp(deps);

  // Work in flight = agent runs + the background memory reflections they spawn.
  // Read by the graceful drain below and reported on /healthz for the deploy
  // preflight (deploy/cloudflare/preflight.mjs).
  const inFlight = () => activeRunCount() + pendingReflectionCount();
  let draining = false;
  let drainStartedAt: number | undefined;

  // Optional HTTP server. Slack traffic arrives over the outbound Socket Mode
  // websocket, so this port serves (a) a health probe for container platforms
  // (Cloudflare Containers, Fly, k8s) and the two authenticated universal
  // ingress channels, both fed by the SAME SWITCHBOARD_INGRESS_TOKENS token map
  // (one credential set, two surfaces) and both landing in the same dispatch()
  // the Slack/CLI adapters use: (b) HTTP ingress (adapter #3): POST /ingress,
  // and (c) MCP ingress (adapter #4): POST /mcp — a minimal MCP server over
  // streamable-HTTP (JSON-RPC 2.0). With no tokens configured BOTH are
  // fail-closed disabled.
  if (process.env.PORT) {
    const auth = parseIngressTokens(process.env);
    const ingress = createIngressHandler(deps, { auth });
    const mcp = createMcpHandler(deps, { auth });
    // Scheduled jobs (#244) arrive through /ingress like any other caller: the
    // Worker shim (deploy/cloudflare/worker.ts) POSTs each `run` schedule's
    // command as the `cron` identity — the `cron` entry of the same token map —
    // and the dispatcher makes a normal run of it. Nothing to wire here beyond
    // the panel below; without a `cron` entry the shim fails closed.
    const cronArmed = Object.values(auth.tokens).some((id) => id.subject === "cron");
    // Live run view (Area 2 / #43): GET /runs (index) + /runs/:id (page) +
    // /runs/:id/events (SSE). Shares defaultRunRegistry with the dispatcher —
    // the run created during dispatch() is the run this streams. The per-run
    // page/stream are token-gated (capability token in the URL, not
    // SWITCHBOARD_INGRESS_TOKENS); the bare index is instead Access-gated
    // (Cloudflare Access fronts it) and must only be exposed behind it, since it
    // renders the per-run capability links. The index also carries the
    // "Scheduled" panel (#244): the schedule registry + each schedule's last
    // firing from the state Worker's ScheduleDO (`schedules.worker`), or a note
    // that firing history is unavailable when that is not configured.
    const scheduleStore = buildScheduleStore(config.config.schedules, process.env, (m) => console.warn(`[schedules] ${m}`));
    const liveView = createLiveViewHandler(defaultRunRegistry, { scheduled: { schedules: SCHEDULES, store: scheduleStore } });
    const schedulesState = `${SCHEDULES.length} schedule(s) on /runs (${scheduleStore ? `firings from ${config.config.schedules?.worker?.baseUrl}` : "no firing store"}; cron identity ${cronArmed ? "armed" : "NOT in SWITCHBOARD_INGRESS_TOKENS — scheduled runs fail closed"})`;
    // Residents dash: GET /residents (index) + /residents/:owner/:name (detail),
    // the browser twin of `repo list`. Reads the resident Worker's admin
    // /residents route live on every request with the same bearer the chat
    // commands use; undefined (not configured) → the handler answers 503.
    // Access-gated below alongside /runs — it lists every onboarded repo and
    // its build commands, so it must never be exposed without SSO.
    const residentCfg = config.config.execution?.resident;
    const residentAdminToken = residentCfg?.baseUrl ? process.env[residentCfg.adminTokenEnv ?? "RESIDENT_ADMIN_TOKEN"] : undefined;
    const residentsView = createResidentsViewHandler(
      residentCfg?.baseUrl && residentAdminToken ? makeResidentAdminClient(residentCfg.baseUrl, residentAdminToken) : undefined,
    );
    const residentsState = residentCfg?.baseUrl && residentAdminToken
      ? `GET /residents (dash → ${residentCfg.baseUrl})`
      : "GET /residents (503 — resident admin not configured)";
    // Costs dash: GET /costs (first group) + /costs/<group> (+ .json twin).
    // Reads Cloudflare's billing datasets (and, when an Admin key is present,
    // Anthropic's cost report) live per request. Fully off without the
    // `costs:` config block or the Cloudflare token → 503. Access-gated below
    // alongside /runs and /residents.
    const costsCfg = parseCostsConfig(config.config.costs);
    const cfAnalyticsToken = costsCfg ? process.env[costsCfg.cloudflareTokenEnv] : undefined;
    const anthropicAdminKey = costsCfg ? process.env[costsCfg.anthropicAdminKeyEnv] : undefined;
    const costsService =
      costsCfg && cfAnalyticsToken
        ? createCostsService(
            costsCfg,
            new CloudflareGraphqlUsageSource({ accountId: costsCfg.cloudflareAccountId, token: cfAnalyticsToken }),
            anthropicAdminKey ? new AnthropicCostReportSource({ adminKey: anthropicAdminKey }) : new NullLlmCostSource(),
          )
        : undefined;
    const costsView = createCostsViewHandler(costsService);
    const costsState = costsService
      ? `GET /costs (${Object.keys(costsCfg!.groups).join(",")}; LLM ${anthropicAdminKey ? "on" : "off"})`
      : costsCfg
        ? `GET /costs (503 — ${costsCfg.cloudflareTokenEnv} not set)`
        : "GET /costs (503 — no costs config)";
    const tokenCount = Object.keys(auth.tokens).length;
    const liveViewState = process.env.PUBLIC_BASE_URL
      ? "GET /runs (index) + /runs/:id (live view)"
      : "GET /runs (index) + live view (no PUBLIC_BASE_URL — per-run links omitted)";

    // The whole /runs*, /residents* and /costs* surface sits behind Cloudflare Access (SSO), enforced
    // fail-closed in our own code: the edge rule injects a signed RS256 JWT in
    // `Cf-Access-Jwt-Assertion`, and we re-verify it here so /runs refuses to
    // serve without a valid Access identity — even if the edge rule is ever
    // misconfigured or a client spoofs the header. With no ACCESS_* config,
    // /runs is DENIED (unless ACCESS_DEV_BYPASS is set for local dev).
    const accessConfig = parseAccessConfig(process.env);
    const accessDevBypass = parseAccessDevBypass(process.env);
    const accessVerify: VerifyDeps = { fetchJwks: httpJwksFetcher, now: () => Date.now(), cache: new JwksCache() };
    const accessState = accessConfig
      ? `Access SSO configured (${accessConfig.teamDomain})`
      : accessDevBypass
        ? "Access DEV BYPASS (/runs open — LOCAL DEV ONLY)"
        : "Access FAIL-CLOSED (/runs denied — no ACCESS_* configured)";

    createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/ingress") {
        ingress(req, res);
        return;
      }
      if (path === "/mcp") {
        mcp(req, res);
        return;
      }
      // /runs* + /residents* + /costs* SSO gate: identity FIRST (fail-closed), before the view
      // dispatch. The gate is async (it may fetch the JWKS), so we resolve the
      // promise here; a rejection is a 403, never a 500 that serves the page.
      // On allow, dispatch to the live-view handler (which owns the /runs index,
      // /runs/:id, and /runs/:id/events, and still applies its own per-run
      // capability-token check — defense in depth). Non-/runs paths below are
      // unchanged and not gated.
      if (path === "/runs" || path.startsWith("/runs/") || path === "/residents" || path.startsWith("/residents/") || path === "/costs" || path === "/costs.json" || path.startsWith("/costs/")) {
        requireAccessForRuns(req.headers, { config: accessConfig, verify: accessVerify, devBypass: accessDevBypass })
          .then((gate) => {
            if (!gate.ok) {
              res.writeHead(gate.status, { "content-type": "text/plain; charset=utf-8" });
              res.end(gate.body);
              return;
            }
            if (liveView(req, res)) return;
            if (residentsView(req, res)) return;
            if (costsView(req, res)) return;
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
          })
          .catch((err) => {
            console.error(`[access] ${err instanceof Error ? err.message : String(err)}`);
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            res.end("forbidden");
          });
        return;
      }
      // Root → dashboard. `/` is NOT Access-gated (only /runs* is), so this 302
      // is public — but it leaks nothing (just "go to /runs"), and /runs itself
      // stays behind Cloudflare Access. This fixes the bare-domain landing (was
      // a plain "ok"). It is an EXACT-path match, so /healthz and everything
      // else still fall through to the probes below.
      if (path === "/") {
        res.writeHead(302, { location: "/runs" });
        res.end();
        return;
      }
      // Health probe: liveness for the Worker's keep-alive cron and the deploy
      // `wake` (status only), plus the in-flight/draining facts the bot deploy
      // preflight refuses on (features/slack-channel.md item 8).
      if (path === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(healthPayload({ inFlight: inFlight(), draining, drainStartedAt, catchUp: getCatchUpStatus(), build })));
        return;
      }
      // Unknown paths. The live-view handler only ever owns /runs*, which the
      // gate above already handled, so there is nothing else for it to serve.
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }).listen(Number(process.env.PORT), () =>
      console.log(
        `http server on :${process.env.PORT} (health + POST /ingress + POST /mcp + ${liveViewState} + ${schedulesState} + ${residentsState} + ${costsState}; ` +
          `${tokenCount > 0 ? `${tokenCount} ingress token(s)` : "ingress + MCP DISABLED — no tokens configured"}; ${accessState})`,
      ),
    );
  }

  // The Slack Socket Mode handshake comes LAST, after the HTTP server above is
  // listening: /healthz (the platform's readiness probe, the keep-alive cron,
  // the deploy preflight), /ingress and /mcp (the cron identity's scheduled
  // runs) have nothing to do with Slack, and a slow or failing Slack handshake
  // used to hold every one of them dark.
  await app.start();

  console.log(
    `switchboard running (providers: ${providers.names().join(", ")}; default agent: ${config.config.defaults.agent})`,
  );

  // Graceful drain: close the Slack socket (no new events), let in-flight
  // agent runs — and the background memory reflections they spawn — finish (up
  // to DRAIN_DEADLINE_MS), then exit. A plain kill mid-run loses the run and
  // leaves a frozen status card in the thread. Cloudflare's rollout sends
  // SIGTERM and waits up to 15 min before SIGKILL — but a SECOND deploy on top
  // of a draining instance replaces it at once (live 2026-08-29 23:51Z, a
  // review killed at 153 s). The deploy preflight refuses while `draining` is
  // true; the live cards say what is happening meanwhile.
  //
  // The socket is closed at the START of the drain, and Cloudflare boots the
  // replacement only after this process exits, so a deploy over a run blacks
  // Slack out for the run's remaining duration (#272; 7.5 min observed). That
  // gap is covered by the reconnect catch-up, whose default window is derived
  // from DRAIN_DEADLINE_MS (src/core/drain.ts). Keeping the socket open while
  // draining was rejected: a mention accepted at minute 14 would start a run
  // the deadline kills a minute later — a dead run with a frozen card — where
  // the catch-up re-runs it intact on the next container.
  const drain = async (signal: string) => {
    if (draining) return;
    draining = true;
    drainStartedAt = Date.now();
    console.log(
      `[drain] ${signal}: closing Slack socket, ${activeRunCount()} run(s) + ${pendingReflectionCount()} reflection(s) in flight`,
    );
    setShutdownNotice("⏸ deploy in progress — finishing this run before the bot restarts");
    await app.stop().catch(() => {});
    const deadline = drainStartedAt + DRAIN_DEADLINE_MS;
    while (inFlight() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`[drain] exiting (${activeRunCount()} run(s), ${pendingReflectionCount()} reflection(s) abandoned)`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void drain("SIGTERM"));
  process.on("SIGINT", () => void drain("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
