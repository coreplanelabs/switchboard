import "./loadEnv.js";
import { createServer } from "node:http";
import { openConfigStore } from "./config.js";
import { capabilitiesFrom } from "./core/capabilities.js";
import { ProviderRegistry } from "./providers/registry.js";
import { createSlackApp } from "./channels/slack.js";
import { SlackChannelDirectory } from "./channels/slackChannelDirectory.js";
import { createIngressHandler, parseIngressTokens } from "./channels/http.js";
import { createMcpHandler } from "./channels/mcp.js";
import { join } from "node:path";
import { FAVICON_ICO_SVG, createLiveViewHandler } from "./channels/liveView.js";
import { loadWebAssets } from "./channels/webAssets.js";
import { makeShellRenderer } from "./channels/webShell.js";
import { createResidentsViewHandler } from "./channels/residentsView.js";
import { createCostsViewHandler } from "./channels/costsView.js";
import {
  AnthropicCostReportSource,
  CloudflareGraphqlUsageSource,
  NullCostsService,
  NullLlmCostSource,
  createCostsService,
  parseCostsConfig,
} from "./core/costs.js";
import { NullResidentAdminClient, residentAdminFromConfig } from "./core/residentAdmin.js";
import { NO_FLEET, residentFleetWatcherFor, type ResidentFleetFacts } from "./core/residentFleet.js";
import { httpJwksFetcher, JwksCache, parseAccessConfig, type VerifyDeps } from "./channels/accessAuth.js";
import { buildDashboardVerifier } from "./channels/dashboardAuth.js";
import { defaultRunRegistry } from "./core/runRegistry.js";
import { BundledSkillStore, DEFAULT_SKILLS_DIR } from "./skills/index.js";
import { buildMcp } from "./mcp/index.js";
import { NullMcpToolSource } from "./mcp/source.js";
import { createMcpConnectViewHandler, isConnectPath } from "./channels/mcpConnectView.js";
import { resolveUserEmail } from "./channels/slack.js";
import { mdToMrkdwn } from "./channels/mrkdwn.js";
import { buildMemoryStore, NullMemoryStore, pendingReflectionCount } from "./core/memory/index.js";
import { healthPayload, readBuildInfo } from "./channels/health.js";
import { startProcessMetrics } from "./channels/processMetrics.js";
import { selectFrictionLedger } from "./core/frictionLedger.js";
import { buildRunStore, FileRunStore, NullRunStore, retentionPolicyOf } from "./core/runStore.js";
import { createRunsService } from "./core/runsService.js";
import { createRunHistoryWriter, NullRunHistoryWriter } from "./core/runHistoryWriter.js";
import { buildRunLedger } from "./core/runLedgerWorker.js";
import { createLedgerWriteThrough, mintGeneration, NullLedgerWriteThrough } from "./core/runLedger/writeThrough.js";
import { reclaimRuns, startReclaimSweep, closeReclaimed, type ReclaimOutcome } from "./core/boot.js";
import { launchResumes } from "./core/resumeLaunch.js";
import { ThreadsElsewhere } from "./core/runLedger/threadsElsewhere.js";
import { nullChannelIO } from "./core/nullChannelIo.js";
import { getAgent } from "./agents/registry.js";
import { systemClock } from "./core/trace/index.js";
import { resumeSlackIO } from "./channels/slack.js";
import { closeReclaimedCards, markForeignLiveCards, setForeignLiveCardsSource } from "./channels/slack/statusCard.js";
import { handleAdminCrash } from "./channels/adminCrash.js";
import { handleAdminTraceLog, TRACE_LOG_PATH } from "./channels/adminTraceLog.js";
import { createSpanLog } from "./core/trace/spanLog.js";
import { handleAdminRestartAuthorize } from "./channels/adminRestartAuthorize.js";
import { RESTART_AUTHORIZE_PATH } from "./deploy/restart.js";
import { DRAIN_DEADLINE_MS, HANDOFF_BUDGET_MS } from "./core/drain.js";
import { startProcessRoot } from "./core/requestTrace.js";
import { configureInternalHosts, internalHostsOf } from "./core/trace/internalHosts.js";
import { getCatchUpStatus } from "./channels/slackCatchUpStatus.js";
import { getSocketStatus } from "./channels/slackSocketStatus.js";
import { PROJECT_DOCS_URL, docsRedirectTarget } from "./core/docsLink.js";
import { activeRunCount, type CoreDeps } from "./core/dispatcher.js";
import { DEPLOY_RESTART_NOTICE, setShutdownNotice } from "./core/dispatch/run.js";
import { writeAbandonedRunRecords } from "./core/dispatch/record.js";
import { buildScheduleStore, NullScheduleStore } from "./core/scheduleStore.js";
import { SCHEDULES } from "./core/schedules.js";
// --- command registry adapters ---
import { buildCoreCommands } from "./core/commandCatalogue.js";
import { accessActor, createCommandHttpHandler, isCommandPath, serviceTokenAllowed } from "./channels/commandHttp.js";
import { coreCommandGroups } from "./core/commands/all.js";
// --- end command registry adapters ---

const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? "./config/config.yaml";
const OVERRIDES_PATH = process.env.SWITCHBOARD_OVERRIDES ?? "./data/overrides.json";

// Process start for `/healthz.startedAt` — `deploy restart`'s live gate tells
// the restarted container (same image, same `build.commit`) from the old one by
// it. Read at module load, which is the process start to within its own
// startup — the one clock, never `process.uptime` (docs/reference/specs/tracing.md item 8).
const PROCESS_STARTED_AT = systemClock();
// Memory and event-loop lag for `/healthz.process` — the bot is one Node
// process, and under many concurrent runs it is the first thing to fail.
const sampleProcessMetrics = startProcessMetrics();

/** Total budget for the drain deadline's `interrupted` full-transcript writes
 *  — the runs are being abandoned anyway; the tombstones written at
 *  their start already cover a write that misses this window. */
const INTERRUPTED_WRITE_BUDGET_MS = 10_000;

async function main() {
  for (const v of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]) {
    if (!process.env[v]) {
      console.error(`Missing required env var ${v}`);
      process.exit(1);
    }
  }

  // Build identity for /healthz (docs/reference/specs/slack-channel.md item 8): written by
  // `deploy/cloudflare/write-build.mjs` into the image; "unknown" when built by hand.
  const build = readBuildInfo(process.env.SWITCHBOARD_BUILD_INFO ?? "./build.json");
  console.log(`[build] ${build.commit}${build.builtAt ? ` @ ${build.builtAt}` : ""}`);
  // The ingress token map is read once, here: it authenticates POST /ingress
  // and POST /mcp below. What a token's bearer may do is config's `grants`
  // entry for `http:<subject>` / `mcp:<subject>` (one authorization model,
  // docs/reference/specs/authorization.md).
  const auth = parseIngressTokens(process.env);
  // Runtime overrides (`config set …`) live where `runtimeOverrides.worker`
  // says — the state Worker's ConfigDO in prod, so a container restart keeps
  // them (docs/reference/specs/routing-and-config.md item 12); the JSON file otherwise.
  // The command groups are what an Access browser session's implicit reads span.
  const config = await openConfigStore(CONFIG_PATH, {
    overridesPath: OVERRIDES_PATH,
    env: process.env,
    commandGroups: coreCommandGroups(),
  });
  console.log(`[config] runtime overrides: ${config.overridesLocation()}`);
  // What is on in this process (src/core/capabilities.ts): resolved ONCE, here,
  // from the config and the environment; every surface below reads this value
  // and none re-derives a capability from `config`.
  const capabilities = capabilitiesFrom(config.config, process.env);
  console.log(`[capabilities] ${JSON.stringify(capabilities)}`);
  const providers = new ProviderRegistry(config.config.providers);
  // Bundled skills (docs/reference/specs/skills.md): loaded once from the seeded `skills/` dir and shared
  // across all channels via CoreDeps, so review/coding get their scoped skill
  // list in-prompt and can load bodies on demand with use_skill.
  const skills = new BundledSkillStore(DEFAULT_SKILLS_DIR);
  // External MCP servers as tools (docs/reference/specs/mcp-tools.md): the static
  // `mcp.servers` list, validated loudly here (a bad URL or a missing bearer
  // env var stops startup), served per run by ONE source whose clients ride
  // the SSRF-pinned web fetch. No servers → undefined → requests unchanged.
  // External MCP servers (docs/reference/specs/mcp-tools.md): entries live in the
  // config scopes (already loaded above); credentials and connect tickets go
  // where the overrides go (the ConfigDO, or a file); `mcp add|list|…` and the
  // Access-gated connect page work off ONE service, and its servers are the
  // per-run tool source. Requester emails come from Slack once the app exists.
  let slackEmailLookup: ((userId: string) => Promise<string | undefined>) | undefined;
  const mcpWiring = buildMcp(config, process.env, {
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    resolveEmail: (userId) => (slackEmailLookup ? slackEmailLookup(userId) : Promise.resolve(undefined)),
    warn: (m) => console.warn(`[mcp] ${m}`),
  });
  // Every optional subsystem below is wired as a real implementation or its
  // Null Object (docs/reference/specs/routing-and-config.md item 16): the core never asks
  // whether a store, a ledger or a source exists — it calls it.
  const mcp = mcpWiring.source ?? new NullMcpToolSource();
  console.log(
    `[mcp] ${capabilities.mcp ? `on (secrets: ${mcpWiring.service!.secrets.describe()})` : `off — ${mcpWiring.unavailable}`}`,
  );
  // Cross-session memory (docs/reference/specs/memory.md): ONE store instance shared by every channel so
  // what the reflection pass writes after a run is what the next run reads.
  // Durable WorkerMemoryStore when memory.worker (+ its bearer) is configured;
  // otherwise an in-process store with a loud warning (a restart loses it).
  // Disabled (default) → the NullMemoryStore: nothing read, nothing written.
  const memory =
    buildMemoryStore(config.config.memory, process.env, (m) => console.warn(`[memory] ${m}`)) ?? new NullMemoryStore();
  // Run history (docs/reference/specs/run-history.md): the durable store every finished run's record lands in.
  // With `runHistory` unconfigured (or misconfigured — buildRunStore warned) it
  // is the NullRunStore → history off, live-only as before. The friction ledger
  // (what `friction propose` clusters across) is READ from it:
  // the record carries the diagnosis, so nothing is written twice.
  const runHistoryCfg = config.config.runHistory;
  // The hosts our own Workers answer on (docs/reference/specs/tracing.md item 21): the one
  // set a `traceparent` may leave for. Computed once from the configured URLs,
  // named once — nothing else decides where trace context travels.
  const hosts = internalHostsOf([
    config.config.execution?.resident?.baseUrl,
    config.config.execution?.url,
    runHistoryCfg?.worker?.baseUrl,
    config.config.schedules?.worker?.baseUrl,
    config.config.runtimeOverrides?.worker?.baseUrl,
    process.env.PUBLIC_BASE_URL,
  ]);
  configureInternalHosts(hosts);
  console.log(
    `[trace] internal hosts (trace context travels to these only): ${hosts.hosts.length > 0 ? hosts.hosts.join(", ") : "none"}`,
  );
  const runStore =
    buildRunStore(runHistoryCfg, process.env, {
      dataDir: "./data",
      warn: (m) => console.warn(`[run-history] ${m}`),
    }) ?? new NullRunStore();
  const runHistoryWriter = capabilities.runHistory
    ? createRunHistoryWriter({
        store: runStore,
        warn: (m) => console.warn(m),
        onPersisted: (id) => defaultRunRegistry.markPersisted(id),
      })
    : new NullRunHistoryWriter();
  console.log(
    capabilities.runHistory
      ? `[run-history] store: ${runStore instanceof FileRunStore ? "host-disk file (data/runs)" : `durable Worker (${runHistoryCfg?.worker?.baseUrl})`}`
      : "[run-history] off (no runHistory config) — runs are live-only",
  );
  // The run ledger's write-through (docs/reference/specs/run-history.md item 35): this
  // process's generation — its fencing token on every ledger write — is minted
  // once here, and every run is mirrored onto the state Worker's ledger (claim,
  // seed, steps, events, state, finishing, finish) so the next generation can
  // pick it up. Worker-backed history only: a file store has no ledger, and a
  // process without one carries the null write-through (nothing claimed).
  const generation = mintGeneration();
  const ledgerClient = capabilities.runLedger ? buildRunLedger(runHistoryCfg, process.env) : null;
  const runLedger = ledgerClient
    ? createLedgerWriteThrough({
        ledger: ledgerClient,
        gen: generation,
        fallback: runStore,
        warn: (m) => console.warn(m),
      })
    : new NullLedgerWriteThrough(generation, runStore);
  console.log(
    capabilities.runLedger
      ? `[ledger] generation ${generation}: runs are mirrored onto the ledger (${runHistoryCfg?.worker?.baseUrl})`
      : `[ledger] generation ${generation}: write-through off (${capabilities.runHistory ? "host-disk history has no ledger" : "history off"})`,
  );
  const selfImprovement = config.config.selfImprovement;
  const frictionLedger = selectFrictionLedger(runStore);
  console.log(
    `[friction] ledger: ${capabilities.runHistory ? "run history" : "none (no runHistory config — `friction report` has no runs to analyze)"}; ` +
      (selfImprovement?.repo
        ? `\`friction propose\` files to ${selfImprovement.repo}`
        : "`friction propose` disabled until selfImprovement.repo is set"),
  );
  // Deploy-ordering probe (best-effort, never blocks startup): the state Worker
  // must carry the `v3` run-history routes before this bot version writes to
  // them. A Worker whose /healthz lacks `runs` would 404 every put (the writer
  // then logs once and degrades) — say so at boot instead of at the first run.
  if (capabilities.runLedger && runHistoryCfg?.worker?.baseUrl) {
    const base = runHistoryCfg.worker.baseUrl.replace(/\/+$/, "");
    fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { features?: unknown } | null;
        const features = Array.isArray(body?.features) ? (body!.features as unknown[]) : [];
        if (!features.includes("runs")) {
          console.error(
            `[run-history] ORDERING ERROR: ${base}/healthz lists features ${JSON.stringify(features)} without "runs" — deploy the state Worker with run-history routes before this bot version; every run write will fail until then`,
          );
        } else {
          console.log(`[run-history] state Worker ${base} reports runs support`);
        }
      })
      .catch((err: unknown) =>
        console.warn(
          `[run-history] /healthz probe of ${base} failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }
  // The threads whose live run is on the ledger but not here (thread-admission
  // item 5): fed by every reclaim outcome below, read at admission.
  const threadsElsewhere = new ThreadsElsewhere();
  // The resident admin plane: the client the config names, or — without
  // residents, or without the admin bearer — the null client carrying the
  // reason, which the residents dash and `repo list` render as their 503.
  const residentAdmin = capabilities.residents
    ? residentAdminFromConfig(config, process.env)
    : new NullResidentAdminClient();
  const residentAdminClient =
    "unavailable" in residentAdmin ? new NullResidentAdminClient(residentAdmin.unavailable) : residentAdmin;
  // The fleet facts the About block reads on every dispatch (routing-and-config
  // item 11): the resident Worker's cap, refreshed in the background — never on
  // the run path, never a constant. Only an admin plane that can answer is
  // watched: none without residents, none when the admin bearer is unset (the
  // null client would answer 503 forever and the cap could never be learned).
  // The bot's span log (docs/reference/specs/tracing.md item 26): every root this process
  // starts also writes here, bounded, and `GET /admin/trace/log` reads it for a
  // `trace:read` bearer — the container's stdout, without the container.
  const spanLog = createSpanLog();
  // Each background read of the listing is a `resident.fleet_refresh` root
  // (tracing item 20), so the Worker's `/residents` line adopts a trace.
  const fleetWatcher = residentFleetWatcherFor(residentAdminClient, {
    warn: (m) => console.warn(m),
    trace: { config, spanLog },
  });
  fleetWatcher?.start();
  const residentFleet: ResidentFleetFacts = fleetWatcher ?? NO_FLEET;
  const deps: CoreDeps = {
    config,
    providers,
    spanLog,
    capabilities,
    residentFleet,
    skills,
    mcp,
    memory,
    runHistoryWriter,
    threadsElsewhere,
    runLedger,
  };
  // --- command registry (docs/decisions/0008-one-command-definition-every-surface.md):
  // the ONE core catalogue (`buildCoreCommands`,
  // shared with src/cli.ts), bound ONCE; every adapter
  // (HTTP /api/*, MCP tools, chat) exposes the same registrations over the same
  // deps: `runs.*` on one RunsService, `friction.*` on the ledger selected
  // above (and the same tracker the scheduled trigger uses), `repo.list` on the
  // resident admin client the config names. ---
  // One RunsService for every surface: the command registry (HTTP/MCP/chat) and the /runs pages.
  const runsService = createRunsService({ registry: defaultRunRegistry, store: runStore, ledger: ledgerClient });
  // Scheduled firings are recorded on the state Worker's ScheduleDO;
  // `schedule list` and the /runs "Scheduled" panel read the same store.
  const scheduleStore =
    buildScheduleStore(config.config.schedules, process.env, (m) => console.warn(`[schedules] ${m}`)) ??
    new NullScheduleStore();
  const commands = buildCoreCommands(config, runStore, {
    registry: defaultRunRegistry,
    env: process.env,
    dataDir: "./data",
    warn: (m) => console.warn(m),
    capabilities,
    runs: runsService,
    frictionLedger,
    tracker: deps.issueTracker,
    memory: () => memory,
    scheduleStore,
    mcp: () => mcpWiring.service ?? { unavailable: mcpWiring.unavailable ?? "MCP is not enabled" },
  });
  // The same bound registry serves HTTP, MCP, and the chat fast path (U13): one
  // registration, every surface.
  deps.commands = commands;
  // --- end command registry ---
  const { app, statusClient } = createSlackApp(deps);
  // Channel facts for the run stamp (authorization.md item 7): with
  // the Slack adapter up, `conversations.info` decides whether a `slack:C…`
  // channel is public or private — cached per channel per TTL, `unknown` on any
  // failure — so a public channel's runs are readable by everyone and a private
  // channel's or DM's stay grants-only. Non-Slack ids keep the static answer.
  deps.channelDirectory = new SlackChannelDirectory(app.client);
  // Connect tickets bind to the requester's email when Slack can tell us
  // (`users:read.email`); without the scope the lookup yields undefined and the
  // ticket binds to the first Access identity that opens it instead.
  slackEmailLookup = (userId) =>
    userId.startsWith("slack:")
      ? resolveUserEmail(app.client, userId.slice("slack:".length))
      : Promise.resolve(undefined);

  // Work in flight = agent runs + the background memory reflections they spawn
  // + run-history writes still retrying (a record lost at SIGTERM is
  // a run that vanishes at eviction). Read by the graceful drain below and
  // reported on /healthz for the deploy preflight (deploy/cloudflare/preflight.mjs).
  const pendingHistoryWrites = () => runHistoryWriter.pending();
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
    const ingress = createIngressHandler(deps, { auth, publicBaseUrl: process.env.PUBLIC_BASE_URL });
    const mcp = createMcpHandler(deps, { auth, commands, grantsFor: (id) => config.grantsFor(id) });
    // Scheduled jobs arrive through /ingress like any other caller: the
    // Worker shim (deploy/cloudflare/worker.ts) POSTs each `run` schedule's
    // command as the `cron` identity — the `cron` entry of the same token map —
    // and the dispatcher makes a normal run of it. Nothing to wire here beyond
    // the "Scheduled" panel on the /runs index (created with the live view
    // below): the schedule registry + each schedule's last firing from the state
    // Worker's ScheduleDO (`schedules.worker`), or a note that firing history is
    // unavailable when that is not configured. Without a `cron` entry the shim
    // fails closed.
    const cronArmed = Object.values(auth.tokens).some((id) => id.subject === "cron");
    const schedulesState = `${SCHEDULES.length} schedule(s) on /runs (${capabilities.schedules ? `firings from ${config.config.schedules?.worker?.baseUrl}` : "no firing store"}; cron identity ${cronArmed ? "armed" : "NOT in SWITCHBOARD_INGRESS_TOKENS — scheduled runs fail closed"})`;
    // The web app (web/): every HTML page is the shared shell + a JSON seed,
    // painted client-side by the Vue bundle served as hashed assets under
    // /assets/*. The build is loaded once at startup — a missing build is a
    // boot error (the Docker image builds it; local dev runs `npm run build`
    // in web/ once, or points SWITCHBOARD_WEB_DIST elsewhere).
    const webAssets = loadWebAssets(process.env.SWITCHBOARD_WEB_DIST ?? join(process.cwd(), "web", "dist"));
    const shell = makeShellRenderer(webAssets.entry, capabilities);
    // Residents dash: GET /residents (index) + /residents/:owner/:name (detail),
    // the browser twin of `repo list`. Reads the resident Worker's admin
    // /residents route live on every request with the same bearer the chat
    // commands use; without residents (or without the admin bearer) the null
    // client answers every route 503 with the reason, and so does the page.
    // Access-gated below alongside /runs — it lists every onboarded repo and
    // its build commands, so it must never be exposed without SSO.
    const residentsView = createResidentsViewHandler(residentAdminClient, shell, { config, spanLog });
    const residentsState =
      residentAdminClient instanceof NullResidentAdminClient
        ? `GET /residents (503 — ${residentAdminClient.reason})`
        : `GET /residents (dash → ${config.config.execution?.resident?.baseUrl})`;
    // Costs dash: GET /costs (first group) + /costs/<group> (+ .json twin).
    // Reads Cloudflare's billing datasets (and, when an Admin key is present,
    // Anthropic's cost report) live per request. Without the `costs:` block or
    // the Cloudflare token the null service has no group and the page says so
    // (503). Access-gated below alongside /runs and /residents.
    const costsCfg = parseCostsConfig(config.config.costs);
    const anthropicAdminKey = costsCfg ? process.env[costsCfg.anthropicAdminKeyEnv] : undefined;
    const costsService =
      capabilities.costs && costsCfg
        ? createCostsService(
            costsCfg,
            new CloudflareGraphqlUsageSource({
              accountId: costsCfg.cloudflareAccountId,
              token: process.env[costsCfg.cloudflareTokenEnv]!,
            }),
            anthropicAdminKey
              ? new AnthropicCostReportSource({ adminKey: anthropicAdminKey })
              : new NullLlmCostSource(),
          )
        : new NullCostsService();
    const costsView = createCostsViewHandler(costsService, shell);
    const costsState = capabilities.costs
      ? `GET /costs (${costsService.groups().join(",")}; LLM ${anthropicAdminKey ? "on" : "off"})`
      : costsCfg
        ? `GET /costs (503 — ${costsCfg.cloudflareTokenEnv} not set)`
        : "GET /costs (503 — no costs config)";
    const tokenCount = Object.keys(auth.tokens).length;
    const liveViewState = process.env.PUBLIC_BASE_URL
      ? "GET /runs (index) + /runs/:id (live view)"
      : "GET /runs (index) + live view (no PUBLIC_BASE_URL — per-run links omitted)";

    // Everything the dashboard serves — /runs*, /residents*, /costs*,
    // /mcp/connect/* and /api/* — sits behind ONE identity gate, the dashboard
    // auth strategy composed below (`dashboardAuth`). Under `access` the edge
    // rule injects a signed RS256 JWT in `Cf-Access-Jwt-Assertion` and we
    // re-verify it here, fail-closed — even if the edge rule is ever
    // misconfigured or a client spoofs the header. ACCESS_* stay the env inputs
    // of that strategy; null means Access is not configured.
    const accessConfig = parseAccessConfig(process.env);
    // ── live view on RunsService ─────────────────────────────────────────────
    // Live run view + run history: GET /runs (index; ?all=1
    // adds finished/persisted runs) + /runs/:id (page) + /runs/:id/events (SSE).
    // Reads go through ONE RunsService over the shared defaultRunRegistry (the
    // run created during dispatch() is the run this streams) and the run store
    // (null → history off, live-only). Live routes stay token-gated (capability
    // token in the URL); finished/persisted runs are served tokenless to the
    // Access-authenticated viewer, so — like the index — they must only be
    // exposed behind Access, and both are bound to that viewer's actor
    // (docs/reference/specs/authorization.md items 5–7): the gate's identity is
    // resolved with the SAME `accessActor` the /api adapter uses and handed to
    // the handler as `ctx.actor` below, so the index lists and the run page
    // reads exactly what `/api/runs.*` would for that identity — under the
    // `token` strategy the configured actor, under `none` the local operator
    // `access:loopback`, each granted like any other browser session.
    const publicBaseUrl = process.env.PUBLIC_BASE_URL;
    // Where /docs* sends a caller: this installation's docs site, the DOCS_BASE_URL
    // var the bot Worker renders from the profile (or a local `npm run docs:dev`);
    // without one, the project's published docs (src/core/docsLink.ts).
    const docsBaseUrl = process.env.DOCS_BASE_URL ?? PROJECT_DOCS_URL;
    const liveView = createLiveViewHandler({
      shell,
      service: runsService,
      index: defaultRunRegistry,
      retention:
        capabilities.runHistory && runHistoryCfg
          ? { retentionDays: retentionPolicyOf(runHistoryCfg).retentionDays }
          : null,
      // The panel's own off-state wording (live-view item 14: "firing history
      // unavailable", never "never fired") stands until the dashboard paints the
      // off-state from the seed's capabilities; so the panel gets no store when
      // schedules are off, not the null one.
      scheduled: { schedules: SCHEDULES, store: capabilities.schedules ? scheduleStore : undefined },
    });
    // ── end live view ────────────────────────────────────────────────────────
    const accessVerify: VerifyDeps = { fetchJwks: httpJwksFetcher, now: () => systemClock(), cache: new JwksCache() };
    // The dashboard auth strategy (docs/reference/specs/access-gate.md, plan D5): ONE
    // verifier, asked once per request below, for everything the dashboard
    // serves. `dashboard.auth` picks it — `access` (the Cloudflare Access JWT,
    // re-verified here, fail-closed), `token` (a bearer → one configured actor)
    // or `none` (loopback callers on a localhost deployment only); absent →
    // access when ACCESS_* are set, else none. A strategy missing its inputs is
    // a startup error, never a silently open or silently closed dashboard.
    const dashboardAuth = buildDashboardVerifier({
      dashboard: config.config.dashboard,
      access: accessConfig,
      env: process.env,
      verify: accessVerify,
      publicBaseUrl,
    });
    if (process.env.ACCESS_DEV_BYPASS !== undefined) {
      console.warn(
        "[dashboard] ACCESS_DEV_BYPASS is no longer read: without ACCESS_* the dashboard auth is `none` (loopback callers on a localhost deployment) — unset it; a grants entry keyed access:dev-bypass belongs under access:loopback now",
      );
    }
    const accessState = `dashboard auth: ${dashboardAuth.describe()}`;
    // --- command registry over HTTP: /api/<group>.<verb>, behind the
    // SAME gate as /runs* (gated on `isCommandPath`). The handler claims
    // all of /api/* and answers its own 404. ---
    const commandHttp = createCommandHttpHandler(commands, {
      grantsFor: (id) => config.grantsFor(id),
      publicBaseUrl,
    });
    const commandHttpState = `GET|POST /api/<group>.<verb> (${commands.list().length} commands)`;
    const mcpConnectView = createMcpConnectViewHandler({
      registry: () => mcpWiring.service,
      publicOrigin: publicBaseUrl ? new URL(publicBaseUrl).origin : undefined,
    });
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
      // The Worker shim's question before `deploy restart` stops this container
      // (deploy/cloudflare/worker.ts): does the bearer's actor hold `deploy:write`?
      // The Worker holds the token map; the grants are this config's.
      if (path === RESTART_AUTHORIZE_PATH) {
        handleAdminRestartAuthorize(req, res, {
          tokens: process.env.SWITCHBOARD_INGRESS_TOKENS,
          grantsFor: (id) => config.grantsFor(id),
        });
        return;
      }
      // Kill injection for the durable-runs receipts (run-history item 36):
      // a `deploy:write` bearer SIGKILLs this process after a 202.
      // The span log (docs/reference/specs/tracing.md item 26): a `trace:read` bearer reads
      // what this process's roots recorded, at every level, filtered.
      if (path === TRACE_LOG_PATH) {
        handleAdminTraceLog(req, res, {
          tokens: process.env.SWITCHBOARD_INGRESS_TOKENS,
          grantsFor: (id) => config.grantsFor(id),
          spanLog,
        });
        return;
      }
      if (path === "/admin/crash") {
        handleAdminCrash(req, res, {
          tokens: process.env.SWITCHBOARD_INGRESS_TOKENS,
          grantsFor: (id) => config.grantsFor(id),
          generation: capabilities.runLedger ? generation : undefined,
        });
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
      // The dashboard gate: identity FIRST (the configured strategy, fail-closed),
      // before the view dispatch. The gate is async (`access` may fetch the JWKS),
      // so we resolve the promise here; a rejection is a 403, never a 500 that
      // serves the page.
      // On allow, dispatch to the live-view handler (which owns the /runs index,
      // /runs/:id, and /runs/:id/events, and still applies its own per-run
      // capability-token check — defense in depth). Non-/runs paths below are
      // unchanged and not gated.
      if (
        isCommandPath(path) ||
        isConnectPath(path) ||
        path === "/runs" ||
        path.startsWith("/runs/") ||
        path === "/residents" ||
        path.startsWith("/residents/") ||
        path === "/costs" ||
        path === "/costs.json" ||
        path.startsWith("/costs/")
      ) {
        dashboardAuth
          .verify(req)
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
            // --- /api/*: the command handler owns everything under it. ---
            if (isCommandPath(path)) return commandHttp(req, res, gate.identity);
            // --- end /api/* ---
            if (liveView(req, res, { actor: accessActor(gate.identity, (id) => config.grantsFor(id)) })) return;
            // --- /mcp/connect/<nonce>: the credential page, identity-bound. ---
            if (mcpConnectView(req, res, gate.identity)) return;
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
      // /docs* → the docs site (deploy/cloudflare-docs/), subpath preserved.
      // Public like `/`: it discloses only the docs hostname, and the docs site
      // itself sits behind the same Cloudflare Access as the dashboards, so an
      // unauthenticated follower meets the SSO login there. This is the stable
      // in-product path the dashboard header links to — see src/core/docsLink.ts.
      const docsTarget = docsRedirectTarget(path, docsBaseUrl);
      if (docsTarget) {
        res.writeHead(302, { location: docsTarget });
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
      // preflight refuses on (docs/reference/specs/slack-channel.md item 8).
      if (path === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            healthPayload({
              inFlight: inFlight(),
              draining,
              drainStartedAt,
              catchUp: getCatchUpStatus(),
              slack: getSocketStatus(),
              build,
              ...(capabilities.runLedger ? { generation } : {}),
              startedAt: PROCESS_STARTED_AT,
              httpListeningAt,
              process: sampleProcessMetrics(),
            }),
          ),
        );
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
      httpListeningAt = systemClock();
      console.log(
        `http server on :${process.env.PORT} (health + POST /ingress + POST /mcp + ${liveViewState} + ${schedulesState} + ${residentsState} + ${costsState} + ${commandHttpState} + /docs → ${docsBaseUrl}; ` +
          `${tokenCount > 0 ? `${tokenCount} ingress token(s)` : "ingress + MCP DISABLED — no tokens configured"}; ${accessState})`,
      );
    });
  }

  // The Slack Socket Mode handshake comes LAST, after the HTTP server above is
  // listening: /healthz (the platform's readiness probe, the keep-alive cron,
  // the deploy preflight), /ingress and /mcp (the cron identity's scheduled
  // runs) have nothing to do with Slack, and a slow or failing Slack handshake
  // used to hold every one of them dark.
  //
  // But the ledger reclaim comes BEFORE the socket (run-history item 36, plan
  // D7): every run the previous generation left is taken over and closed with
  // a record built from the ledger's events, and the rows another generation
  // still holds are marked so the reconnect handler's orphan sweep leaves their
  // cards alone. Awaited: the sweep decides ownership inside the connect, so
  // this is the one safe ordering point. Never throws; a ledger that cannot be
  // reached is a warning and the bot boots as before.
  // What one reclaim outcome asks of this process (run-history items 36 and
  // 38): mark the cards other generations hold, close the cards of runs that had
  // replied, and launch the resumes. Used at boot and by the periodic sweep.
  const ledgerReclaim = capabilities.runLedger && ledgerClient ? { client: ledgerClient } : undefined;
  // Two acts, because the boot performs them at different times: the cards
  // before the socket opens (the sweep must see them), the resumes after it.
  const guardCards = async (outcome: ReclaimOutcome): Promise<void> => {
    // Every outcome comes from a full listing, so an empty `liveElsewhere` is
    // the truth (no other generation holds a row) and replaces the set.
    markForeignLiveCards(outcome.liveElsewhere.flatMap((r) => (r.card ? [r.card] : [])));
    // …and the threads a follow-up must be steered into rather than run afresh:
    // rows other generations hold, plus the ones just reclaimed and not yet
    // launched (the launcher runs after this, and in-process admission takes
    // over the moment a resume is dispatched).
    threadsElsewhere.replace([...outcome.liveElsewhere, ...outcome.resumable.map((r) => r.row)]);
    const closedCards = await closeReclaimedCards(
      app.client,
      outcome.closed.map((c) => ({
        status: c.status,
        agent: c.agent,
        card: c.card,
        ...(c.note ? { note: c.note } : {}),
      })),
      (w) => console.warn(w),
    );
    if (closedCards > 0) console.log(`[reclaim] closed ${closedCards} card(s) of runs the previous generation left`);
    // An interrupted ship pipeline's work stands on GitHub with nobody driving
    // it (run-history item 36): its thread is told, with the re-issue that
    // continues it — a closed card alone is easy to miss on a two-hour run.
    for (const c of outcome.closed) {
      if (c.status !== "interrupted" || c.agent !== "ship" || !c.note) continue;
      const [platform, channel, threadTs] = c.threadKey.split(":");
      if (platform !== "slack" || !channel || !threadTs) continue;
      try {
        await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: mdToMrkdwn(c.note) });
      } catch (err) {
        console.warn(
          `[reclaim] ${c.runId}: the ship pipeline's thread could not be told: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };
  const launch = async (outcome: ReclaimOutcome): Promise<void> => {
    if (!ledgerReclaim || outcome.resumable.length === 0) return;
    await launchResumes(deps, outcome.resumable, {
      agentFor: (name) => {
        try {
          return name ? getAgent(name) : undefined;
        } catch {
          return undefined;
        }
      },
      ioFor: (row) => {
        const [platform, channel, threadTs] = row.threadKey.split(":");
        if (platform === "slack" && channel && threadTs) {
          return resumeSlackIO(
            app.client,
            {
              channel,
              threadTs,
              user: row.meta.userId.replace(/^slack:/, ""),
              ...(row.card ? { cardTs: row.card.ts } : {}),
            },
            { statusClient },
          );
        }
        if (platform === "http" || platform === "mcp") return nullChannelIO(row.threadKey);
        return undefined;
      },
      close: async (run, why) => {
        const closed = await closeReclaimed(ledgerReclaim.client, generation, {
          row: run.row,
          events: run.kind === "restart" ? [] : run.events,
          status: "interrupted",
          finishedAt: systemClock(),
        });
        console.log(
          `[resume] ${run.row.runId} ${run.row.threadKey} closed interrupted (${why})${closed.ok ? "" : ` — finish refused (${closed.reason})`}`,
        );
      },
      log: (l) => console.log(l),
      warn: (w) => console.warn(w),
    });
  };
  let bootReclaim: ReclaimOutcome | undefined;
  if (ledgerReclaim) {
    bootReclaim = await reclaimRuns({
      ledger: ledgerReclaim.client,
      gen: generation,
      log: (l) => console.log(l),
      warn: (w) => console.warn(w),
    });
    // The card sweep guard and the replied runs' cards, before the socket
    // opens; the resumes wait for it (they post to threads and need the client
    // connected like any run).
    await guardCards(bootReclaim);
    // …and on every later reconnect, the ledger's current answer: rows under a
    // live lease held by another generation. An expired lease is a dead
    // generation — its cards are orphans again, its rows the next sweep's.
    const client = ledgerReclaim.client;
    setForeignLiveCardsSource(async () =>
      (await client.listLive())
        .filter((r) => r.ownerGen !== generation && r.leaseUntil > systemClock())
        .flatMap((r) => (r.card ? [r.card] : [])),
    );
  }
  await app.start();
  // The runs the boot reclaim found resumable continue now that the socket is
  // up (run-history item 38), and the reclaim repeats every lease interval so a
  // row whose lease was still current at boot is taken once it expires.
  if (ledgerReclaim && bootReclaim) {
    await launch(bootReclaim);
    startReclaimSweep({
      ledger: ledgerReclaim.client,
      gen: generation,
      log: (l) => console.log(l),
      warn: (w) => console.warn(w),
      onOutcome: async (outcome) => {
        await guardCards(outcome);
        await launch(outcome);
      },
    });
  }

  console.log(
    `switchboard running (providers: ${providers.names().join(", ")}; default agent: ${config.config.defaults.agent})`,
  );

  // Graceful drain: close the Slack socket (no new events), let in-flight
  // agent runs — and the background memory reflections they spawn — finish (up
  // to DRAIN_DEADLINE_MS), then exit. A plain kill mid-run loses the run and
  // leaves a frozen status card in the thread. Cloudflare's rollout sends
  // SIGTERM and waits up to 15 min before SIGKILL — but a SECOND deploy on top
  // of a draining instance replaces it at once, mid-run. The deploy preflight
  // warns while `draining` is
  // true; the live cards say what is happening meanwhile. Run-history writes
  // drain here too (see `inFlight` above).
  //
  // The socket is closed at the START of the drain, and Cloudflare boots the
  // replacement only after this process exits, so a deploy over a run blacks
  // Slack out for the run's remaining duration. That
  // gap is covered by the reconnect catch-up, whose default window is derived
  // from DRAIN_DEADLINE_MS (src/core/drain.ts). Keeping the socket open while
  // draining was rejected: a mention accepted at minute 14 would start a run
  // the deadline kills a minute later — a dead run with a frozen card — where
  // the catch-up re-runs it intact on the next container.
  const drain = async (signal: string) => {
    if (draining) return;
    draining = true;
    drainStartedAt = systemClock();
    // The drain is one `drain` root on the span log (docs/reference/specs/tracing.md item
    // 20): what signalled it, what it held, what it handed off and abandoned.
    const root = startProcessRoot(deps, "drain", {
      startedAt: drainStartedAt,
      attrs: { signal: signal === "SIGTERM" || signal === "SIGINT" ? signal : "other", runs: activeRunCount() },
    });
    console.log(
      `[drain] ${signal}: closing Slack socket, ${activeRunCount()} run(s) + ${pendingReflectionCount()} reflection(s) + ${pendingHistoryWrites()} history write(s) in flight`,
    );
    setShutdownNotice(DEPLOY_RESTART_NOTICE);
    await app.stop().catch(() => {});
    // The handoff (plan D8, run-history item 39): every run a resume can
    // continue is marked `handoff` on the ledger, so the next generation takes
    // it at once — whatever its lease — and carries on from its last step. Those
    // runs are not waited for: they keep running here until the exit, and their
    // writes are fenced the moment the next generation reclaims them. Only the
    // runs a resume cannot continue (a ship pipeline, an untracked run) hold the
    // drain, up to the old deadline.
    const handoff = await runLedger.handoff();
    const handed = new Set(handoff.marked);
    if (handoff.failed) console.warn(`[drain] handoff failed (${handoff.failed}) — waiting for the runs instead`);
    if (handed.size > 0)
      console.log(`[drain] handed ${handed.size} run(s) to the next generation: ${[...handed].join(", ")}`);
    // Counted by registry id, not by the write-through's live set: a handed run
    // that gets fenced mid-drain (the next generation took it) leaves that set
    // but is still handed — it must not start holding the drain again.
    const runsHeld = () => defaultRunRegistry.listActive().filter((r) => !r.finished && !handed.has(r.id)).length;
    const stillHere = () => runsHeld() + pendingReflectionCount() + pendingHistoryWrites();
    const deadline = drainStartedAt + (runsHeld() > 0 ? DRAIN_DEADLINE_MS : HANDOFF_BUDGET_MS);
    while (stillHere() > 0 && systemClock() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    // Every finished run whose reply never settled is sealed now, with no
    // `replyOk` (docs/reference/specs/tracing.md): its viewers get their `end` frame, and
    // one event-loop turn hands those frames to the sockets before the exit
    // (best effort — the process is going away).
    const sealed = defaultRunRegistry.sealAllFinished();
    if (sealed > 0) console.log(`[drain] sealed ${sealed} finished run(s) whose reply never settled`);
    await new Promise((r) => setImmediate(r));
    // Tombstone upgrade: the deadline passed with runs still in flight —
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
    if (inFlight() > 0) {
      const written = writeAbandonedRunRecords(
        defaultRunRegistry,
        runHistoryWriter,
        systemClock(),
        console.log,
        handed,
      );
      if (written > 0) {
        await Promise.race([
          runHistoryWriter.settled(),
          new Promise((r) => setTimeout(r, INTERRUPTED_WRITE_BUDGET_MS)),
        ]);
      }
    }
    console.log(
      `[drain] exiting (${activeRunCount()} run(s) of which ${handed.size} handed off, ${pendingReflectionCount()} reflection(s), ${pendingHistoryWrites()} history write(s) abandoned; ${runHistoryWriter.failures()} history write(s) lost this process)`,
    );
    root.end("ok", { handed: handed.size, sealed, abandonedRuns: activeRunCount() });
    process.exit(0);
  };
  process.on("SIGTERM", () => void drain("SIGTERM"));
  process.on("SIGINT", () => void drain("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
