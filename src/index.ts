import { createServer } from "node:http";
import { openConfigStore } from "./config.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createSlackApp } from "./channels/slack.js";
import { createIngressHandler, parseIngressTokens } from "./channels/http.js";
import { createMcpHandler } from "./channels/mcp.js";
import { join } from "node:path";
import { FAVICON_ICO_SVG, createLiveViewHandler } from "./channels/liveView.js";
import { loadWebAssets } from "./channels/webAssets.js";
import { makeShellRenderer } from "./channels/webShell.js";
import { createResidentsViewHandler } from "./channels/residentsView.js";
import { createCostsViewHandler } from "./channels/costsView.js";
import { AnthropicCostReportSource, CloudflareGraphqlUsageSource, NullLlmCostSource, createCostsService, parseCostsConfig } from "./core/costs.js";
import { makeResidentAdminClient } from "./core/residentAdmin.js";
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
import { buildMcpToolSource } from "./mcp/index.js";
import { buildMemoryStore, pendingReflectionCount } from "./core/memory/index.js";
import { buildFrictionLedger, WorkerFrictionLedger } from "./core/frictionLedgerWorker.js";
import { healthPayload, readBuildInfo } from "./channels/health.js";
import { selectFrictionLedger } from "./core/frictionLedger.js";
import { buildRunStore, FileRunStore, retentionPolicyOf } from "./core/runStore.js";
import { createRunsService } from "./core/runsService.js";
import { createRunHistoryWriter } from "./core/runHistoryWriter.js";
import { DRAIN_DEADLINE_MS } from "./core/drain.js";
import { getCatchUpStatus } from "./channels/slackCatchUpStatus.js";
import { getSocketStatus } from "./channels/slackSocketStatus.js";
import { activeRunCount, DEPLOY_RESTART_NOTICE, setShutdownNotice, writeAbandonedRunRecords, type CoreDeps } from "./core/dispatcher.js";
import { buildScheduleStore } from "./core/scheduleStore.js";
import { SCHEDULES } from "./core/schedules.js";
// --- command registry adapters (#157 U7) ---
import { buildCoreCommands } from "./core/commandCatalogue.js";
import { callerIdFor, createCommandHttpHandler, isCommandPath, isLocalhostBase, isLoopbackAddress, serviceTokenAllowed } from "./channels/commandHttp.js";
// --- end command registry adapters ---

const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? "./config/config.yaml";
const OVERRIDES_PATH = process.env.SWITCHBOARD_OVERRIDES ?? "./data/overrides.json";

// Process start for `/healthz.startedAt` — `deploy restart`'s live gate tells
// the restarted container (same image, same `build.commit`) from the old one by it.
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/** Total budget for the drain deadline's `interrupted` full-transcript writes
 *  (#375) — the runs are being abandoned anyway; the tombstones written at
 *  their start already cover a write that misses this window. */
const INTERRUPTED_WRITE_BUDGET_MS = 10_000;

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
  // Runtime overrides (`config set …`) live where `runtimeOverrides.worker`
  // says — the state Worker's ConfigDO in prod, so a container restart keeps
  // them (features/routing-and-config.md item 12); the JSON file otherwise.
  const config = await openConfigStore(CONFIG_PATH, { overridesPath: OVERRIDES_PATH, env: process.env });
  console.log(`[config] runtime overrides: ${config.overridesLocation()}`);
  const providers = new ProviderRegistry(config.config.providers);
  // Bundled skills (#100): loaded once from the seeded `skills/` dir and shared
  // across all channels via CoreDeps, so review/coding get their scoped skill
  // list in-prompt and can load bodies on demand with use_skill.
  const skills = new BundledSkillStore(DEFAULT_SKILLS_DIR);
  // External MCP servers as tools (#394, features/mcp-tools.md): the static
  // `mcp.servers` list, validated loudly here (a bad URL or a missing bearer
  // env var stops startup), served per run by ONE source whose clients ride
  // the SSRF-pinned web fetch. No servers → undefined → requests unchanged.
  const mcp = buildMcpToolSource(config.config.mcp, process.env);
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
  const legacyFrictionLedger = buildFrictionLedger(selfImprovement, process.env, {
    dataDir: "./data",
    warn: (m) => console.warn(`[friction] ${m}`),
  });
  // Run history (#157): the durable store every finished run's record lands in.
  // `null` when `runHistory` is unconfigured (or misconfigured — buildRunStore
  // warned) → history off, live-only as before. With a store, the friction
  // ledger is READ from it (legacy FrictionDO rows unioned for the rollout
  // window) while `record()` keeps writing the legacy ledger (KD3 call-out).
  const runHistoryCfg = config.config.runHistory;
  const runStore = buildRunStore(runHistoryCfg, process.env, { dataDir: "./data", warn: (m) => console.warn(`[run-history] ${m}`) });
  const runHistoryWriter = runStore
    ? createRunHistoryWriter({ store: runStore, warn: (m) => console.warn(m), onPersisted: (id) => defaultRunRegistry.markPersisted(id) })
    : undefined;
  console.log(
    runStore
      ? `[run-history] store: ${runStore instanceof FileRunStore ? "host-disk file (data/runs)" : `durable Worker (${runHistoryCfg?.worker?.baseUrl})`}`
      : "[run-history] off (no runHistory config) — runs are live-only",
  );
  const frictionLedger = selectFrictionLedger(runStore, legacyFrictionLedger);
  console.log(
    `[friction] ledger: ${runStore ? "run store (legacy rows unioned); legacy write: " : ""}${legacyFrictionLedger instanceof WorkerFrictionLedger ? `durable (${selfImprovement?.worker?.baseUrl})` : "host-disk file"}; ` +
      (selfImprovement?.repo ? `\`friction propose\` files to ${selfImprovement.repo}` : "`friction propose` disabled until selfImprovement.repo is set"),
  );
  // Deploy-ordering probe (best-effort, never blocks startup): the state Worker
  // must carry the `v3` run-history routes before this bot version writes to
  // them. A Worker whose /healthz lacks `runs` would 404 every put (the writer
  // then logs once and degrades) — say so at boot instead of at the first run.
  if (runStore && !(runStore instanceof FileRunStore) && runHistoryCfg?.worker?.baseUrl) {
    const base = runHistoryCfg.worker.baseUrl.replace(/\/+$/, "");
    fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { features?: unknown } | null;
        const features = Array.isArray(body?.features) ? (body!.features as unknown[]) : [];
        if (!features.includes("runs")) {
          console.error(`[run-history] ORDERING ERROR: ${base}/healthz lists features ${JSON.stringify(features)} without "runs" — deploy the state Worker with run-history routes before this bot version; every run write will fail until then`);
        } else {
          console.log(`[run-history] state Worker ${base} reports runs support`);
        }
      })
      .catch((err: unknown) => console.warn(`[run-history] /healthz probe of ${base} failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  const deps: CoreDeps = { config, providers, skills, mcp, memory, frictionLedger, runHistoryWriter };
  // --- command registry (#157 U6/U7/U9): the ONE core catalogue (`buildCoreCommands`,
  // shared with src/cli.ts), bound ONCE; every adapter
  // (HTTP /api/*, MCP tools, chat) exposes the same registrations over the same
  // deps: `runs.*` on one RunsService, `friction.*` on the ledger selected
  // above (and the same tracker the scheduled trigger uses), `repo.list` on the
  // resident admin client the config names. ---
  // One RunsService for every surface: the command registry (HTTP/MCP/chat) and the /runs pages.
  const runsService = createRunsService({ registry: defaultRunRegistry, store: runStore });
  // Scheduled firings (#244) are recorded on the state Worker's ScheduleDO;
  // `schedule list` and the /runs "Scheduled" panel read the same store.
  const scheduleStore = buildScheduleStore(config.config.schedules, process.env, (m) => console.warn(`[schedules] ${m}`));
  const commands = buildCoreCommands(config, runStore, {
    registry: defaultRunRegistry,
    env: process.env,
    dataDir: "./data",
    warn: (m) => console.warn(m),
    runs: runsService,
    frictionLedger,
    tracker: deps.issueTracker,
    memory: () => memory,
    scheduleStore,
  });
  // The same bound registry serves HTTP, MCP, and the chat fast path (U13): one
  // registration, every surface.
  deps.commands = commands;
  // --- end command registry ---
  const { app } = createSlackApp(deps);

  // Work in flight = agent runs + the background memory reflections they spawn
  // + run-history writes still retrying (#157 KTD4: a record lost at SIGTERM is
  // a run that vanishes at eviction). Read by the graceful drain below and
  // reported on /healthz for the deploy preflight (deploy/cloudflare/preflight.mjs).
  const pendingHistoryWrites = () => runHistoryWriter?.pending() ?? 0;
  const inFlight = () => activeRunCount() + pendingReflectionCount() + pendingHistoryWrites();
  let draining = false;
  // Epoch ms when the HTTP server's listen() callback fired; undefined until
  // then (and forever when PORT is unset). Reported on /healthz.
  let httpListeningAt: number | undefined;
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
    const mcp = createMcpHandler(deps, { auth, commands });
    // Scheduled jobs (#244) arrive through /ingress like any other caller: the
    // Worker shim (deploy/cloudflare/worker.ts) POSTs each `run` schedule's
    // command as the `cron` identity — the `cron` entry of the same token map —
    // and the dispatcher makes a normal run of it. Nothing to wire here beyond
    // the "Scheduled" panel on the /runs index (created with the live view
    // below): the schedule registry + each schedule's last firing from the state
    // Worker's ScheduleDO (`schedules.worker`), or a note that firing history is
    // unavailable when that is not configured. Without a `cron` entry the shim
    // fails closed.
    const cronArmed = Object.values(auth.tokens).some((id) => id.subject === "cron");
    const schedulesState = `${SCHEDULES.length} schedule(s) on /runs (${scheduleStore ? `firings from ${config.config.schedules?.worker?.baseUrl}` : "no firing store"}; cron identity ${cronArmed ? "armed" : "NOT in SWITCHBOARD_INGRESS_TOKENS — scheduled runs fail closed"})`;
    // The web app (web/): every HTML page is the shared shell + a JSON seed,
    // painted client-side by the Vue bundle served as hashed assets under
    // /assets/*. The build is loaded once at startup — a missing build is a
    // boot error (the Docker image builds it; local dev runs `npm run build`
    // in web/ once, or points SWITCHBOARD_WEB_DIST elsewhere).
    const webAssets = loadWebAssets(process.env.SWITCHBOARD_WEB_DIST ?? join(process.cwd(), "web", "dist"));
    const shell = makeShellRenderer(webAssets.entry);
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
      shell,
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
    const costsView = createCostsViewHandler(costsService, shell);
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
    // ── U8 (#157): live view on RunsService ──────────────────────────────────
    // Live run view (Area 2 / #43) + run history (#157): GET /runs (index; ?all=1
    // adds finished/persisted runs) + /runs/:id (page) + /runs/:id/events (SSE).
    // Reads go through ONE RunsService over the shared defaultRunRegistry (the
    // run created during dispatch() is the run this streams) and the run store
    // (null → history off, live-only). Live routes stay token-gated (capability
    // token in the URL); finished/persisted runs are served tokenless to the
    // Access-authenticated viewer, so — like the index — they must only be
    // exposed behind Access. KTD13: under the dev bypass, history reads are
    // served only to a loopback client with no remote PUBLIC_BASE_URL. The
    // bypass is in effect only when Access is NOT configured (the same rule
    // `requireAccessForRuns` applies and `commandHttp` is wired with below):
    // with ACCESS_* set, a stray ACCESS_DEV_BYPASS must not turn the
    // Access-authenticated viewer's history reads into 403s. `isLocalhostBase` is
    // the ONE localhost rule (shared with commandHttp); a malformed
    // PUBLIC_BASE_URL is "not localhost", never a boot crash.
    const publicBaseUrl = process.env.PUBLIC_BASE_URL;
    const devBypassActive = accessConfig === null && accessDevBypass;
    const liveView = createLiveViewHandler({
      shell,
      service: runsService,
      index: defaultRunRegistry,
      retention: runStore && runHistoryCfg ? { retentionDays: retentionPolicyOf(runHistoryCfg).retentionDays } : null,
      devBypass: {
        active: () => devBypassActive,
        isLoopback: (req) => isLoopbackAddress(req.socket?.remoteAddress) && isLocalhostBase(publicBaseUrl),
      },
      scheduled: { schedules: SCHEDULES, store: scheduleStore },
    });
    // ── end U8 ───────────────────────────────────────────────────────────────
    const accessVerify: VerifyDeps = { fetchJwks: httpJwksFetcher, now: () => Date.now(), cache: new JwksCache() };
    const accessState = accessConfig
      ? `Access SSO configured (${accessConfig.teamDomain})`
      : accessDevBypass
        ? "Access DEV BYPASS (/runs open — LOCAL DEV ONLY)"
        : "Access FAIL-CLOSED (/runs denied — no ACCESS_* configured)";
    // --- command registry over HTTP (#157 U7): /api/<group>.<verb>, behind the
    // SAME Access gate as /runs* (gated on `isCommandPath`, KTD13). The handler
    // claims all of /api/* and answers its own 404. Under the dev bypass it
    // serves loopback callers on a localhost deployment only. ---
    const commandHttp = createCommandHttpHandler(commands, {
      operatorIdentities: () => config.operatorIdentities(),
      serviceTokenScopes: (cn) => config.serviceTokenScopes(cn),
      devBypassActive,
      publicBaseUrl,
    });
    const commandHttpState = `GET|POST /api/<group>.<verb> (${commands.list().length} commands)`;
    // --- end command registry over HTTP ---
    // A service token is a command-surface credential only (`serviceTokenAllowed`):
    // it can never load /runs* (live capability tokens), /residents* or /costs*.
    // Logged once per process — the fact, never any token material.
    let serviceTokenRefusalLogged = false;

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
      // The web app's hashed static assets (js/css). Code only — no data, no
      // tokens — and referenced by pages a capability-token viewer can load,
      // so served without the in-process Access gate (the edge policy still
      // applies to whatever it covers). Immutable-cacheable by content hash.
      // GUARD: because this route is ungated, nothing beyond the built bundle
      // may land in web/dist — in particular, keep `build.sourcemap` OFF in
      // web/vite.config.ts, or the app's source would be world-readable here.
      if (webAssets.serve(req, res)) return;
      // /runs* + /residents* + /costs* SSO gate: identity FIRST (fail-closed), before the view
      // dispatch. The gate is async (it may fetch the JWKS), so we resolve the
      // promise here; a rejection is a 403, never a 500 that serves the page.
      // On allow, dispatch to the live-view handler (which owns the /runs index,
      // /runs/:id, and /runs/:id/events, and still applies its own per-run
      // capability-token check — defense in depth). Non-/runs paths below are
      // unchanged and not gated.
      if (isCommandPath(path) || path === "/runs" || path.startsWith("/runs/") || path === "/residents" || path.startsWith("/residents/") || path === "/costs" || path === "/costs.json" || path.startsWith("/costs/")) {
        requireAccessForRuns(req.headers, { config: accessConfig, verify: accessVerify, devBypass: accessDevBypass })
          .then((gate) => {
            if (!gate.ok) {
              res.writeHead(gate.status, { "content-type": "text/plain; charset=utf-8" });
              res.end(gate.body);
              return;
            }
            if (!serviceTokenAllowed(path, gate.identity)) {
              if (!serviceTokenRefusalLogged) {
                serviceTokenRefusalLogged = true;
                console.warn(`[access] a service token requested ${path}: service tokens are served /api/* only (403)`);
              }
              res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
              res.end("forbidden");
              return;
            }
            // --- /api/* (#157 U7): the command handler owns everything under it. ---
            if (isCommandPath(path)) return commandHttp(req, res, gate.identity);
            // --- end /api/* ---
            if (liveView(req, res, { identity: callerIdFor(gate.identity) })) return;
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
      // The favicon fallback (live-view item 21): the runs index carries its own
      // inline data: icon, but every other page — and any bookmark — asks here,
      // and the catch-all used to answer with a text/plain "ok". Public like /:
      // it is one gray dot, it leaks nothing. Exact path, cacheable.
      if (path === "/favicon.ico") {
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
        res.end(FAVICON_ICO_SVG);
        return;
      }
      // Health probe: liveness for the Worker's keep-alive cron and the deploy
      // `wake` (status only), plus the in-flight/draining facts the bot deploy
      // preflight refuses on (features/slack-channel.md item 8).
      if (path === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(healthPayload({ inFlight: inFlight(), draining, drainStartedAt, catchUp: getCatchUpStatus(), slack: getSocketStatus(), build, startedAt: PROCESS_STARTED_AT, httpListeningAt })));
        return;
      }
      // Unknown paths. The live-view handler only ever owns /runs*, which the
      // gate above already handled, so there is nothing else for it to serve.
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }).listen(Number(process.env.PORT), () => {
      // Stamped when the server is ACCEPTING — /healthz reports it so the
      // listen-before-Slack ordering is provable from one later poll
      // (`httpListeningAt < slack.since`, both on this process's clock).
      // The Worker shim's port polling releases held requests too coarsely
      // (~seconds) for an external prober to land inside the window itself.
      httpListeningAt = Date.now();
      console.log(
        `http server on :${process.env.PORT} (health + POST /ingress + POST /mcp + ${liveViewState} + ${schedulesState} + ${residentsState} + ${costsState} + ${commandHttpState}; ` +
          `${tokenCount > 0 ? `${tokenCount} ingress token(s)` : "ingress + MCP DISABLED — no tokens configured"}; ${accessState})`,
      );
    });
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
  // true; the live cards say what is happening meanwhile. Run-history writes
  // drain here too (see `inFlight` above).
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
      `[drain] ${signal}: closing Slack socket, ${activeRunCount()} run(s) + ${pendingReflectionCount()} reflection(s) + ${pendingHistoryWrites()} history write(s) in flight`,
    );
    setShutdownNotice(DEPLOY_RESTART_NOTICE);
    await app.stop().catch(() => {});
    const deadline = drainStartedAt + DRAIN_DEADLINE_MS;
    while (inFlight() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    // Tombstone upgrade (#375): the deadline passed with runs still in flight —
    // they are about to be killed by process.exit. Each still-active registry
    // run already has its provisional `interrupted` tombstone (written at
    // start, a few events); `writeAbandonedRunRecords` rewrites it now from the
    // FULL snapshot (every event published so far) with `finishedAt` = now, so
    // the common abandonment leaves a full transcript, not just the tombstone.
    // The writes are provisional (no persisted flag on the dying registry, and
    // they stand down for a finish record that races them inside the budget).
    // Bounded: one write per run through the normal writer (its own retries run
    // inside the budget), at most INTERRUPTED_WRITE_BUDGET_MS total — never a
    // second drain.
    if (runHistoryWriter && inFlight() > 0) {
      const written = writeAbandonedRunRecords(defaultRunRegistry, runHistoryWriter, Date.now());
      if (written > 0) {
        await Promise.race([runHistoryWriter.settled(), new Promise((r) => setTimeout(r, INTERRUPTED_WRITE_BUDGET_MS))]);
      }
    }
    console.log(
      `[drain] exiting (${activeRunCount()} run(s), ${pendingReflectionCount()} reflection(s), ${pendingHistoryWrites()} history write(s) abandoned` +
        (runHistoryWriter ? `; ${runHistoryWriter.failures()} history write(s) lost this process)` : ")"),
    );
    process.exit(0);
  };
  process.on("SIGTERM", () => void drain("SIGTERM"));
  process.on("SIGINT", () => void drain("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
