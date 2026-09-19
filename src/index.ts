import "./loadEnv.js";
import { createServer } from "node:http";
import { join } from "node:path";
import { OPERATOR_ROOT } from "./deploy/host.js";
import { installationPath } from "./deploy/operatorRoot.js";
import { intakeModelRef, openConfigStore } from "./config.js";
import { parseModelRef } from "./core/provider.js";
import { providerRouteModel } from "./core/dispatch/route.js";
import type { IntakeReceipt } from "./core/runLedger/types.js";
import { capabilitiesFrom } from "./core/capabilities.js";
import { PiAiProviders } from "./core/harness/piAi.js";
import { createSlackApp, wireIntakeGate, type SlackIntakeGate } from "./channels/slack.js";
import { SlackChannelDirectory } from "./channels/slackChannelDirectory.js";
import { SlackConversationReader } from "./channels/slack/references.js";
import { createIngressHandler, parseIngressTokens } from "./channels/http.js";
import { createMcpHandler } from "./channels/mcp.js";
import { FAVICON_ICO_SVG, createLiveViewHandler } from "./channels/liveView.js";
import { loadWebAssets, webDistDir } from "./channels/webAssets.js";
import { PACKAGE_ROOT, packageVersion } from "./packageRoot.js";
import { makePageSender } from "./channels/webShell.js";
import { createResidentsViewHandler } from "./channels/residentsView.js";
import { createWebChatHandler, resumeWebIO } from "./channels/web.js";
import { createCostsViewHandler } from "./channels/costsView.js";
import { createPlaneViewHandler } from "./channels/planeView.js";
import { createDeliveryViewHandler } from "./channels/deliveryView.js";
import { createSettingsViewHandler } from "./channels/settingsView.js";
import { installationSettings } from "./core/installationSettings.js";
import { EFFORT_LEVELS } from "./effort.js";
import { NullDeliveryService, parseDeliveryConfig, SNAPSHOT_EVERY_MINUTES } from "./core/delivery.js";
import { buildDeliverySnapshotStore } from "./core/deliverySnapshotStore.js";
import { parseCostsConfig } from "./core/costs.js";
import { costsFromConfig, NullCostsService } from "./core/costsService.js";
import { AnalyticsEngineSqlSource, parseMetricsConfig } from "./core/metrics.js";
import { createMetricsService, NullMetricsService } from "./core/metricsService.js";
import { NullResidentAdminClient, residentAdminFromConfig } from "./core/residentAdmin.js";
import { NO_FLEET, residentFleetWatcherFor, type ResidentFleetFacts } from "./core/residentFleet.js";
import { httpJwksFetcher, JwksCache, parseAccessConfig, type VerifyDeps } from "./channels/accessAuth.js";
import type { AccessIdentity } from "./channels/accessAuth.js";
import { buildDashboardVerifier } from "./channels/dashboardAuth.js";
import { defaultRunRegistry } from "./core/runRegistry.js";
import { BundledSkillStore, DEFAULT_SKILLS_DIR } from "./skills/index.js";
import { buildMcp } from "./mcp/index.js";
import { NullMcpToolSource } from "./mcp/source.js";
import { buildConfirmationStore } from "./core/confirmations.js";
import { createMcpConnectViewHandler, isConnectPath } from "./channels/mcpConnectView.js";
import { createViewAsHandler, peopleSource, viewAsFromCookie } from "./channels/viewAs.js";
import { RUN_LIST_MAX_LIMIT } from "./core/runRecord.js";
import { resolvePersonByEmail, resolveUserEmail, resolveUserName } from "./channels/slack/lookups.js";
import { slackNames } from "./channels/slackNames.js";
import { NO_NAMES, type NameDirectory } from "./core/names.js";
import { mdToMrkdwn } from "./channels/mrkdwn.js";
import { buildMemoryStore, NullMemoryStore, pendingReflectionCount } from "./core/memory/index.js";
import { healthPayload, readBuildInfo } from "./channels/health.js";
import { buildArtifactStore } from "./artifacts/buildStore.js";
import { ARTIFACT_DEFAULTS } from "./artifacts/config.js";
import { startProcessMetrics } from "./channels/processMetrics.js";
import { selectFrictionLedger } from "./core/frictionLedger.js";
import { buildRunStore, FileRunStore, NullRunStore, retentionPolicyOf } from "./core/runStore.js";
import { metricsDatasetWarning } from "./core/runStoreWorker.js";
import { createRunsService } from "./core/runsService.js";
import { createPlaneService } from "./core/planeService.js";
import { createRunHistoryWriter, NullRunHistoryWriter } from "./core/runHistoryWriter.js";
import { autoAbridgeOnPersist, reviewAbridgerFromConfig } from "./core/reviewAbridge.js";
import { meatOnPath } from "./core/meatProcess.js";
import { buildRunLedger } from "./core/runLedgerWorker.js";
import { createLedgerWriteThrough, mintGeneration, NullLedgerWriteThrough } from "./core/runLedger/writeThrough.js";
import {
  reclaimRuns,
  startReclaimSweep,
  closeReclaimed,
  threadsElsewhereOf,
  type ReclaimOutcome,
} from "./core/boot.js";
import { launchResumes, resumeIoTarget } from "./core/resumeLaunch.js";
import { ThreadsElsewhere } from "./core/runLedger/threadsElsewhere.js";
import { LedgerTakeover } from "./core/runLedger/takeover.js";
import { nullChannelIO } from "./core/nullChannelIo.js";
import type { ChannelIO } from "./core/types.js";
import { AGENTS, getAgent, IDENTITIES, MACHINE_CLASSES } from "./agents/registry.js";
import { systemClock } from "./core/trace/index.js";
import { resumeSlackIO } from "./channels/slack.js";
import {
  adoptLiveCard,
  closeReclaimedCards,
  markForeignLiveCards,
  setForeignLiveCardsSource,
} from "./channels/slack/statusCard.js";
import { handleAdminCrash } from "./channels/adminCrash.js";
import { handleAdminModelProxyBearer, MODEL_PROXY_BEARER_PATH } from "./channels/adminModelProxy.js";
import {
  ANTHROPIC_MESSAGES_PATH,
  createModelProxyHandler,
  isModelProxyPath,
  OPENAI_CHAT_COMPLETIONS_PATH,
  OPENAI_RESPONSES_PATH,
} from "./channels/modelProxy.js";
import { RunBearerStore } from "./core/modelProxy/runBearers.js";
import { PiHarness } from "./core/harness/pi/piHarness.js";
import { OpenCodeHarness } from "./core/harness/opencode/harness.js";
import type { HarnessRoster } from "./core/harness/roster.js";
import { HarnessRegistry } from "./core/harness/pi/relay.js";
import { createHarnessRoutesHandler, isHarnessPath } from "./channels/harnessRoutes.js";
import { handleAdminTraceLog, TRACE_LOG_PATH } from "./channels/adminTraceLog.js";
import { createSpanLog } from "./core/trace/spanLog.js";
import { handleAdminRestartAuthorize } from "./channels/adminRestartAuthorize.js";
import { RESTART_AUTHORIZE_PATH } from "./deploy/restart.js";
import {
  DRAIN_DEADLINE_MS,
  drainHoldLine,
  HANDOFF_BUDGET_MS,
  HELD_NOT_HANDED_OFF,
  createDrainDeadline,
} from "./core/drain.js";
import { MINUTE_MS } from "./core/budgets.js";
import { startProcessRoot } from "./core/requestTrace.js";
import { configureInternalHosts, internalHostsOf } from "./core/trace/internalHosts.js";
import { getCatchUpStatus } from "./channels/slackCatchUpStatus.js";
import { getSocketStatus } from "./channels/slackSocketStatus.js";
import { PROJECT_DOCS_URL, docsRedirectTarget } from "./core/docsLink.js";
import { activeRunCount, dispatch, type CoreDeps } from "./core/dispatcher.js";
import { createAdminCoordinatorHandler, isCoordinatorAdminPath } from "./channels/adminCoordinator.js";
import { createGithubWebhookHandler, GITHUB_WEBHOOK_PATH } from "./channels/githubWebhook.js";
import { createMergeWaitRegistry } from "./core/coordinator/checksIntake.js";
import { processShimOptions, shimWorkflowSender } from "./core/coordinator/instancesClient.js";
import { classifyRoundChecks } from "./core/ship/checkFindings.js";
import { buildCoordinatorInstanceStore } from "./core/coordinator/instanceStore.js";
import {
  commitsOverBase,
  createBranchRef,
  fetchCheckRunDetails,
  fetchCommitChecks,
  fetchPullRequestFacts,
  fixupCommitSubjects,
  fetchPullRequestReviews,
  findMergedPrByHead,
  findOpenPrByHead,
  mergePullRequest,
  openPullRequest,
  pullRequestChangedPaths,
  rerunFailedJobs,
} from "./execution/githubPulls.js";
import { RestGithubApi } from "./execution/githubApi.js";
import { resolveGithubIdentity } from "./execution/githubApp.js";
import { DEPLOY_RESTART_NOTICE, setShutdownNotice } from "./core/dispatch/run.js";
import { channelVisibilityOf, writeAbandonedRunRecords } from "./core/dispatch/record.js";
import { buildScheduleStore, NullScheduleStore } from "./core/scheduleStore.js";
import { SCHEDULES } from "./core/schedules.js";
// --- command registry adapters ---
import { buildCoreCommands, deliveryFromConfig } from "./core/commandCatalogue.js";
import {
  callerFor,
  createCommandHttpHandler,
  isCommandPath,
  resolveAccessActor,
  serviceTokenAllowed,
  type PersonLookup,
} from "./channels/commandHttp.js";
import { coreCommandGroups } from "./core/commands/all.js";
// --- end command registry adapters ---
import { claimEntry } from "./invokedAsScript.js";
import { processSecrets, publicEnv } from "./secrets.js";

// The installation's files (src/deploy/operatorRoot.ts): the checkout or the image's /app, or — `start`
// from the published package — SWITCHBOARD_HOME, a cwd that holds an installation, else ~/.switchboard.
const DATA_DIR = installationPath(OPERATOR_ROOT, "data");
const CONFIG_PATH = process.env.SWITCHBOARD_CONFIG ?? installationPath(OPERATOR_ROOT, "config/config.yaml");
const OVERRIDES_PATH = process.env.SWITCHBOARD_OVERRIDES ?? join(DATA_DIR, "overrides.json");

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

/**
 * The bot process: Slack over Socket Mode, the HTTP server when `PORT` is set,
 * until a signal drains it. Resolves once the socket is up; the process then
 * lives on its open handles. Run by this module as a script (`node
 * dist/index.js`, the image's no-argument entrypoint, `npm run dev`) and by the
 * CLI's `start` (src/cli.ts) — the same process from the same directory.
 */
export async function runBot(): Promise<void> {
  for (const v of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]) {
    if (!processSecrets.get(v)) {
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
  const auth = parseIngressTokens(processSecrets);
  // Runtime overrides (`config set …`) live where `runtimeOverrides.worker`
  // says — the state Worker's ConfigDO in prod, so a container restart keeps
  // them (docs/reference/specs/routing-and-config.md item 12); the JSON file otherwise.
  // The command groups are what an Access browser session's baseline reads span.
  const config = await openConfigStore(CONFIG_PATH, {
    overridesPath: OVERRIDES_PATH,
    env: publicEnv(),
    secrets: processSecrets,
    commandGroups: coreCommandGroups(),
  });
  console.log(`[config] runtime overrides: ${config.overridesLocation()}`);
  // The confirmation a routed write is offered as (record 0044; routing-and-config
  // item 25) lives where the overrides live: the same ConfigDO in prod — a row
  // that must outlive the bot process that minted it — or a JSON file beside
  // the overrides file. A configured Worker without its bearer stopped the
  // load above already; the same check holds here.
  const confirmations = buildConfirmationStore(config, processSecrets, {
    path: join(DATA_DIR, "confirmations.json"),
  });
  console.log(`[confirmations] ${confirmations.describe()}`);
  // What is on in this process (src/core/capabilities.ts): resolved ONCE, here,
  // from the config and the environment; every surface below reads this value
  // and none re-derives a capability from `config`.
  const capabilities = capabilitiesFrom(config.config, publicEnv(), processSecrets, {
    meatBinary: meatOnPath(publicEnv()),
  });
  console.log(`[capabilities] ${JSON.stringify(capabilities)}`);
  // The config's provider table on pi's model library, for the model calls made
  // outside a run — the router's and reflection's (docs/reference/specs/harness-pi.md
  // item 13); a run's own calls go through the model proxy below.
  const completions = new PiAiProviders(config.config.providers);
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
  let slackNameLookup: ((userId: string) => Promise<string | undefined>) | undefined;
  /** A plain line into a Slack channel by its bare id — the costs snapshot alert's poster, bound once the app exists. */
  let slackPost: ((channel: string, text: string) => Promise<void>) | undefined;
  let slackPersonByEmail: PersonLookup | undefined;
  const personByEmail: PersonLookup = (email) =>
    slackPersonByEmail ? slackPersonByEmail(email) : Promise.resolve(undefined);
  /** Display names for the ids the dashboard shows (src/core/names.ts), the Slack directory once the app exists. */
  let slackNameDirectory: NameDirectory | undefined;
  const names: NameDirectory = {
    person: (id) => (slackNameDirectory ?? NO_NAMES).person(id),
    channel: (id) => (slackNameDirectory ?? NO_NAMES).channel(id),
  };
  /** A linked person's channels, bound to the Slack directory once the app exists; `unknown` before. */
  let slackChannelsOf: ((actorId: string) => Promise<ReadonlySet<string> | "unknown">) | undefined;
  const channelsOf = (actorId: string) =>
    slackChannelsOf ? slackChannelsOf(actorId) : Promise.resolve("unknown" as const);
  /** The name the view-as banner and audit line give a person (record 0053). */
  const personName = (personId: string) => names.person(personId);
  const mcpWiring = buildMcp(config, processSecrets, {
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    resolveEmail: (userId) => (slackEmailLookup ? slackEmailLookup(userId) : Promise.resolve(undefined)),
    // `addedBy` as a name on the MCP lists (record 0042): the cached lookup the runs index uses.
    resolveName: (userId) => (slackNameLookup ? slackNameLookup(userId) : Promise.resolve(undefined)),
    // A channel tier's rows name their channel the same way (settings-page.md item 8).
    resolveChannelName: (channelId) => names.channel(channelId),
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
    buildMemoryStore(config.config.memory, processSecrets, (m) => console.warn(`[memory] ${m}`)) ??
    new NullMemoryStore();
  // The artifact store (docs/reference/specs/execution.md item 20): R2 when
  // `artifacts:` is configured, none otherwise. A configured store with a
  // missing secret throws here — a store that silently downgraded would leave a
  // run believing its file was kept.
  const artifacts = buildArtifactStore(config.config.artifacts, processSecrets, {
    copyBaseUrl: process.env.PUBLIC_BASE_URL,
  });
  console.log(`[artifacts] ${artifacts ? `on — bucket ${artifacts.bucket}` : "off — no artifacts: section"}`);
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
  // The `costs:` block, parsed once and early: the price table every finished
  // run is priced through (costs.md item 4c) — the run store's and the
  // ledger's metrics points (run-metrics.md), `RunsService` and the costs
  // service below all read the same table.
  const costsCfg = parseCostsConfig(config.config.costs);
  const runStore =
    buildRunStore(runHistoryCfg, processSecrets, {
      dataDir: DATA_DIR,
      warn: (m) => console.warn(`[run-history] ${m}`),
      ...(costsCfg?.prices ? { prices: costsCfg.prices } : {}),
    }) ?? new NullRunStore();
  // The ONE abridger of this process (docs/reference/specs/reading-diff.md item 5): meat
  // on this host over the stored record. `review abridge` (the catalogue below)
  // and `provider: meat` (the persist hook here) share it, so a run has one
  // running/failed state whichever way it was asked for.
  const abridger =
    capabilities.runHistory && capabilities.readingDiffAbridge
      ? reviewAbridgerFromConfig(
          () => config.config,
          runStore,
          processSecrets,
          publicEnv(),
          DATA_DIR,
          (m) => console.warn(m),
        )
      : undefined;
  const autoAbridge = autoAbridgeOnPersist(
    () => abridger,
    () => config.config.review?.readingDiff,
    publicEnv(),
  );
  const runHistoryWriter = capabilities.runHistory
    ? createRunHistoryWriter({
        store: runStore,
        warn: (m) => console.warn(m),
        onPersisted: (id) => {
          defaultRunRegistry.markPersisted(id);
          autoAbridge(id);
        },
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
  const ledgerClient = capabilities.runLedger
    ? buildRunLedger(runHistoryCfg, processSecrets, {
        ...(costsCfg?.prices ? { prices: costsCfg.prices } : {}),
      })
    : null;
  // The coordinator's parent records (run-history item 49) live beside the
  // ledger on the state Worker; without one, the null store knows no instance
  // and the coordinator routes refuse every step by name.
  const coordinatorInstances = buildCoordinatorInstanceStore(runHistoryCfg, processSecrets);
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
        // The name held on both sides (run-metrics.md item 6): the bot's configured
        // metrics.dataset against the dataset the Worker's deploy bound — one warning
        // when they disagree, advisory on both sides.
        const datasetWarning = metricsDatasetWarning(parseMetricsConfig(config.config.metrics)?.dataset, features);
        if (datasetWarning !== undefined) console.warn(datasetWarning);
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
  // The runs the ledger lists as live that this generation has not finished
  // resuming (harness-pi item 7): fed by every reclaim outcome and the resume
  // launcher below, read by the harness door, which holds for a surviving pi's
  // bearer until its run is back on the harness instead of refusing it.
  const takeover = new LedgerTakeover();
  // The resident admin plane: the client the config names, or — without
  // residents, or without the admin bearer — the null client carrying the
  // reason, which the residents dash and `repo list` render as their 503.
  const residentAdmin = capabilities.residents
    ? residentAdminFromConfig(config, processSecrets)
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
  // The run-scoped bearers the model proxy honours (docs/reference/specs/model-proxy.md):
  // minted by the provision stage as a run's executor attaches, revoked as the
  // run ends; in-process, so a restart drops them with the runs that held them.
  const runBearers = new RunBearerStore({ clock: systemClock });
  // The runs driving a harness process (docs/reference/specs/harness-pi.md):
  // the harness routes answer for exactly these; the bot's public URL is where
  // a run's container reaches the proxy and the routes, and this process's own
  // port, over loopback, is where a process running as a child of the bot does
  // (item 12). The roster (harness.md item 8) is wired here and nowhere else:
  // pi and OpenCode, each with the deployment's compaction thresholds behind
  // it (harness-pi item 4; the `opencode` block), keyed by the name each
  // object declares — the word `harness.<preset>` in the configuration picks
  // one, and a preset the block does not name runs on pi.
  const harnesses = new HarnessRegistry();
  const roster: HarnessRoster = {
    pi: new PiHarness(config.config.pi?.compaction ? { compaction: config.config.pi.compaction } : {}),
    opencode: new OpenCodeHarness(
      config.config.opencode?.compaction ? { compaction: config.config.opencode.compaction } : {},
    ),
  };
  // The Workflow sender over the shim's event relay (http-ingress item 12,
  // record 0051's nudge): built once — the check-run intake's checks-settled send
  // and the dispatcher's unit nudge go through the same door.
  const workflowSender = shimWorkflowSender(processShimOptions());
  const deps: CoreDeps = {
    config,
    completions,
    spanLog,
    runBearers,
    harness: {
      harnesses: roster,
      registry: harnesses,
      ...(process.env.PUBLIC_BASE_URL ? { harnessUrl: process.env.PUBLIC_BASE_URL } : {}),
      ...(process.env.PORT ? { loopbackUrl: `http://127.0.0.1:${process.env.PORT}` } : {}),
    },
    capabilities,
    residentFleet,
    // What this process is, for the About block: the package version and the image's stamp.
    build: { version: packageVersion(), commit: build.commit },
    skills,
    mcp,
    memory,
    ...(artifacts ? { artifacts } : {}),
    runHistoryWriter,
    // The coordinator's instance records and unit rows (run-history items 49 and 50): what the ship branch writes when it hands an `agent:ship` request to the plan runner.
    coordinatorInstances,
    workflow: workflowSender,
    runStore,
    threadsElsewhere,
    runLedger,
    confirmations,
  };
  // --- command registry (docs/decisions/0008-one-command-definition-every-surface.md):
  // the ONE core catalogue (`buildCoreCommands`,
  // shared with src/cli.ts), bound ONCE; every adapter
  // (HTTP /api/*, MCP tools, chat) exposes the same registrations over the same
  // deps: `runs.*` on one RunsService, `friction.*` on the ledger selected
  // above (and the same tracker the scheduled trigger uses), `repo.list` on the
  // resident admin client the config names. ---
  // One RunsService for every surface: the command registry (HTTP/MCP/chat), the
  // /runs pages, and the run tools a spawning run holds (the dispatcher's `runs`).
  const runsService = createRunsService({
    registry: defaultRunRegistry,
    store: runStore,
    ledger: ledgerClient,
    sessions: ledgerClient,
    units: coordinatorInstances,
    prices: costsCfg?.prices,
  });
  deps.runs = runsService;
  // One plane service for `plane show` and the /plane panel (record 0064, the table):
  // the same runs service and instance store, the merge door's GitHub reads for the
  // tracked pull requests.
  const planeService = createPlaneService({
    runs: runsService,
    instances: coordinatorInstances,
    github: { facts: fetchPullRequestFacts, checks: fetchCommitChecks, reviews: fetchPullRequestReviews },
  });
  // Scheduled firings are recorded on the state Worker's ScheduleDO;
  // `schedule list` and the /runs "Scheduled" panel read the same store.
  const scheduleStore =
    buildScheduleStore(config.config.schedules, processSecrets, (m) => console.warn(`[schedules] ${m}`)) ??
    new NullScheduleStore();
  // Delivery indicators (docs/reference/specs/delivery.md): ONE service for the
  // `/delivery` page and `delivery report`, GitHub over the App's read token
  // behind a per-repository snapshot kept on the state Worker (in memory
  // without one), with the `delivery:` config; without a GitHub credential the
  // Null Object answers the page's 503 and the command is hidden by its
  // capability. The refresh loop is this process's own minute tick: it keeps
  // every configured repository's snapshot within `delivery.snapshot.everyMinutes`.
  const deliveryWarn = (m: string) => console.warn(`[delivery] ${m}`);
  const deliveryConfig = parseDeliveryConfig(config.config.delivery);
  const delivery = capabilities.github
    ? deliveryFromConfig(deliveryConfig, {
        snapshots: buildDeliverySnapshotStore(config.config, processSecrets, deliveryWarn),
        warn: deliveryWarn,
      })
    : undefined;
  const deliveryService = delivery?.service ?? new NullDeliveryService();
  const deliveryEveryMinutes = deliveryConfig?.snapshot.everyMinutes ?? SNAPSHOT_EVERY_MINUTES.default;
  if (delivery && deliveryService.repos().length > 0)
    delivery.source.startRefreshLoop({ repos: deliveryService.repos(), everyMinutes: deliveryEveryMinutes });
  // Costs dash (docs/reference/specs/costs.md): every figure the page, its JSON
  // twins and `costs snapshot` serve comes from ONE snapshot of both billing
  // sources and the run history, taken on `costs.snapshot.everyHours` by the
  // bot's own refresh loop or on request — never in a page load. Without the
  // `costs:` block or the Cloudflare token the null service has no group and
  // the page says so (503). Both keys are revealed into their source's
  // constructor and held nowhere else here.
  const costs =
    capabilities.costs && costsCfg
      ? costsFromConfig(costsCfg, config.config, {
          secrets: processSecrets,
          runStore,
          // Cost by user (costs.md item 10): the Slack email lookup that matches the viewer to their runs.
          emailOfSlackUser: (userId) => (slackEmailLookup ? slackEmailLookup(userId) : Promise.resolve(undefined)),
          // `costs.snapshot.alertChannel` (item 6): a Slack channel by its namespaced id; any other
          // namespace, or a Slack app not up yet, rejects — the snapshotter warns and the status still says.
          notify: (channelId, text) => {
            if (!channelId.startsWith("slack:")) return Promise.reject(new Error(`no poster for ${channelId}`));
            if (!slackPost) return Promise.reject(new Error("the Slack app is not up yet"));
            return slackPost(channelId.slice("slack:".length), text);
          },
          warn: (m) => console.warn(`[costs] ${m}`),
        })
      : undefined;
  const costsService = costs?.service ?? new NullCostsService();
  // A stale snapshot after a restart is refreshed at once; a young one is left alone.
  costs?.snapshots.startRefreshLoop();
  // Run metrics reader (docs/reference/specs/run-metrics.md): `metrics trend` reads
  // the dataset over the Analytics Engine SQL API with the SAME analytics token the
  // costs sources hold — revealed into the source's constructor and held nowhere else.
  const metricsCfg = parseMetricsConfig(config.config.metrics);
  const metricsToken = costsCfg && processSecrets.named(costsCfg.cloudflareTokenEnv);
  const metricsService =
    capabilities.metrics && metricsCfg && costsCfg && metricsToken
      ? createMetricsService(
          metricsCfg,
          new AnalyticsEngineSqlSource({ accountId: costsCfg.cloudflareAccountId, token: metricsToken.reveal() }),
        )
      : new NullMetricsService();
  const commands = buildCoreCommands(config, runStore, {
    registry: defaultRunRegistry,
    secrets: processSecrets,
    dataDir: DATA_DIR,
    warn: (m) => console.warn(m),
    capabilities,
    runs: runsService,
    delivery: () => deliveryService,
    costs: () => costsService,
    metrics: () => metricsService,
    plane: () => planeService,
    abridger: () => abridger,
    frictionLedger,
    tracker: deps.issueTracker,
    memory: () => memory,
    // `config show --channel`: the same directory the run stamp reads, wired below once the Slack adapter is up.
    channelDirectory: () => deps.channelDirectory,
    // `config channels`: the channels by name, through the same directory the settings page reads.
    names: () => names,
    // `status show`: the same facts /healthz serves, read when asked (inFlight and
    // draining are defined below and change over the process's life).
    status: () => ({
      version: packageVersion(),
      commit: build.commit,
      ...(build.builtAt !== undefined ? { builtAt: build.builtAt } : {}),
      startedAt: PROCESS_STARTED_AT,
      inFlight: inFlight(),
      draining,
    }),
    scheduleStore,
    mcp: () => mcpWiring.service ?? { unavailable: mcpWiring.unavailable ?? "MCP is not enabled" },
  });
  // The same bound registry serves HTTP, MCP, and the chat fast path (U13): one
  // registration, every surface.
  deps.commands = commands;
  // --- end command registry ---
  // The thread-reply intake gate (record 0058; docs/reference/specs/slack-channel.md
  // item 15): the fast model behind the router's seam, the receipt on the run
  // ledger — or degraded without one, which `wireIntakeGate` says once at
  // startup — and the runs page and the pending confirmation as the facts'
  // sources. Without a resolvable model ref the gate is not wired and thread
  // replies run as `always`: degrade open, never a silence nothing decided.
  let slackIntake: SlackIntakeGate | undefined;
  try {
    const intakeRef = intakeModelRef(config.config);
    if (intakeRef) {
      const ref = parseModelRef(intakeRef);
      const intakeLedger = ledgerClient
        ? {
            readIntake: (key: string) => ledgerClient.readIntake(key),
            // The write-through's retrying insert (run-history item 59); its
            // degraded `undefined` becomes the throw `decideIntake` maps to
            // `receipt: failed`, so the adapter still acts on the verdict.
            recordIntake: async (key: string, receipt: IntakeReceipt) => {
              const out = await runLedger.recordIntake(key, receipt);
              if (out === undefined) throw new Error("the receipt write degraded (the ledger warning names why)");
              return out;
            },
          }
        : null;
      slackIntake = wireIntakeGate({
        intakeModeFor: (threadKey, userId, channelId) => config.intakeModeFor(threadKey, userId, channelId),
        deps: {
          model: providerRouteModel(completions.get(ref.provider), ref.model),
          ledger: intakeLedger,
          now: systemClock,
        },
        modelRef: intakeRef,
        gen: PROCESS_STARTED_AT,
        runs: runsService,
        confirmations,
      });
    } else {
      console.warn(
        "[intake] no model ref resolves (intake.model, routing.model, defaults.models.general) — thread replies run as always",
      );
    }
  } catch (err) {
    console.warn(
      `[intake] gate not wired (${err instanceof Error ? err.message : String(err)}) — thread replies run as always`,
    );
  }
  const { app, receiver, statusClient } = createSlackApp(deps, slackIntake);
  // A thread's channel handle rebuilt from a stored row's parts, with no
  // triggering event (run-history item 38): what a resumed run replies through
  // and what a coordinator's child is dispatched into. Slack from the key's
  // channel and ts (and the row's card, when it has one); the web from the
  // key's sub — history as the session's own actor, `openThread` minting a
  // conversation in the same lane, replies logged as undeliverable (record
  // 0060); HTTP and MCP have no thread to speak into, so their handle logs;
  // any other platform, none.
  const threadIoFor = (thread: { threadKey: string; userId: string; cardTs?: string }): ChannelIO | undefined => {
    const [platform, channel, threadTs] = thread.threadKey.split(":");
    if (platform === "slack" && channel && threadTs) {
      return resumeSlackIO(
        app.client,
        {
          channel,
          threadTs,
          user: thread.userId.replace(/^slack:/, ""),
          ...(thread.cardTs ? { cardTs: thread.cardTs } : {}),
        },
        { statusClient },
      );
    }
    if (platform === "web") {
      return resumeWebIO(
        {
          service: runsService,
          registry: defaultRunRegistry,
          intake: ledgerClient ? { listIntake: (query) => ledgerClient.listIntake(query) } : null,
          grantsFor: (id) => config.grantsFor(id),
        },
        thread,
      );
    }
    if (platform === "http" || platform === "mcp") return nullChannelIO(thread.threadKey);
    return undefined;
  };
  // Channel facts for the run stamp (authorization.md item 7): with
  // the Slack adapter up, `conversations.info` decides whether a `slack:C…`
  // channel is public or private — cached per channel per TTL, `unknown` on any
  // failure — so a public channel's runs are readable by everyone and a private
  // channel's or DM's stay grants-only. Non-Slack ids keep the static answer.
  const channelDirectory = new SlackChannelDirectory(app.client);
  deps.channelDirectory = channelDirectory;
  // Membership: a dashboard session linked to its person carries the
  // channels that person is in, from `users.conversations` cached per person. The
  // events keep the cache fresh — a join or leave forgets that person, a move of
  // the bot's own reach forgets everyone (the bot joining a channel makes that
  // channel visible on every member's set at once), and so does a reconnect
  // (Socket Mode replays nothing missed) — so the TTL is only the bound on a
  // missed event.
  slackChannelsOf = (actorId) => channelDirectory.channelsOf(actorId);
  let directoryBotUserId: string | undefined;
  const membershipMoved = async (user: string) => {
    try {
      directoryBotUserId ??= (await app.client.auth.test()).user_id ?? undefined;
    } catch {
      channelDirectory.forgetAll(); // who moved is unknown: forgetting more is always safe
      return;
    }
    if (user === directoryBotUserId) channelDirectory.forgetAll();
    else channelDirectory.forgetMember(`slack:${user}`);
  };
  app.event("member_joined_channel", async ({ event }) => membershipMoved(event.user));
  app.event("member_left_channel", async ({ event }) => membershipMoved(event.user));
  for (const moved of [
    "channel_left",
    "group_left",
    "channel_archive",
    "group_archive",
    "channel_deleted",
    "group_deleted",
  ] as const)
    app.event(moved, async () => channelDirectory.forgetAll());
  receiver.client.on("connected", () => channelDirectory.forgetAll());
  // The conversation reader (record 0037): a permalink to another thread the
  // bot is in becomes a quoted, untrusted block on the request turn — this
  // workspace's URL grammar, one fresh `conversations.info` per classification,
  // a text-only fetch. Inert until `references.enabled` is set; the host it
  // recognises is read from `auth.test` once the socket is up.
  const conversationReader = new SlackConversationReader(app.client);
  deps.conversationReaders = [conversationReader];
  // Connect tickets bind to the requester's email when Slack can tell us
  // (`users:read.email`); without the scope the lookup yields undefined and the
  // ticket binds to the first Access identity that opens it instead.
  slackEmailLookup = (userId) =>
    userId.startsWith("slack:")
      ? resolveUserEmail(app.client, userId.slice("slack:".length))
      : Promise.resolve(undefined);
  slackNameLookup = (userId) =>
    userId.startsWith("slack:")
      ? resolveUserName(app.client, userId.slice("slack:".length))
      : Promise.resolve(undefined);
  slackNameDirectory = slackNames(app.client);
  slackPost = async (channel, text) => {
    await app.client.chat.postMessage({ channel, text: mdToMrkdwn(text) });
  };
  // The dashboard link (record 0042): a browser session's Access email names
  // its Slack person, resolved once per gate pass through a cached reverse
  // lookup — identity, never authority.
  slackPersonByEmail = (email) => resolvePersonByEmail(app.client, email);

  // Work in flight = agent runs + the background memory reflections they spawn
  // + run-history writes still retrying (a record lost at SIGTERM is
  // a run that vanishes at eviction). Read by the graceful drain below and
  // reported on /healthz for the deploy preflight (deploy/cloudflare/preflight.mjs).
  const pendingHistoryWrites = () => runHistoryWriter.pending();
  const inFlight = () => activeRunCount() + pendingReflectionCount() + pendingHistoryWrites();
  let draining = false;
  // The runs the drain's handoff marked for the next generation — they stop
  // holding the drain the moment they are marked (run-history item 39).
  const handedOff = new Set<string>();
  // What actually holds the drain: the REGISTRY's live rows, not the
  // dispatcher's count above — the two can disagree (a registry row whose
  // dispatcher-side run is gone holds the drain while `inFlight` reads 0), so
  // the drain waits on these and /healthz names them, id and why, for the
  // deploy CLI's still-draining line (slack-channel.md item 8).
  const heldRuns = () =>
    defaultRunRegistry
      .listActive()
      .filter((r) => !r.finished && !handedOff.has(r.id))
      .map((r) => ({ id: r.id, why: HELD_NOT_HANDED_OFF }));
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
    // A token entry's `email` binds it to a person (authorization.md item 15):
    // the same cached reverse lookup the dashboard link uses.
    const ingress = createIngressHandler(deps, { auth, publicBaseUrl: process.env.PUBLIC_BASE_URL, personByEmail });
    const mcp = createMcpHandler(deps, { auth, commands, grantsFor: (id) => config.grantsFor(id), personByEmail });
    // The model proxy (docs/reference/specs/model-proxy.md): a run's bearer buys
    // model calls through this process — pinned to its preset's model and caps,
    // metered as its own `model.turn` spans, forwarded to the real provider with
    // the real key from this process's secrets. The shim forwards both paths
    // blind and the Access gate does not cover them: the bearer is the whole door.
    const modelProxy = createModelProxyHandler({
      bearers: runBearers,
      providers: () => config.config.providers,
      // The operator's `costs.prices` (costs.md item 4b): the turn price's
      // operator layer (model-proxy item 6), parsed once with the runs service's table.
      ...(costsCfg?.prices ? { prices: () => costsCfg.prices } : {}),
      secrets: processSecrets,
      clock: systemClock,
    });
    // The harness routes (docs/reference/specs/harness-pi.md item 7): what a
    // run's pi extension asks over the run's own bearer — its relayed tool
    // definitions, the gate's verdict before each tool call, a relayed tool run
    // here. The shim forwards them blind like the proxy; the bearer is the door.
    const harnessRoutes = createHarnessRoutesHandler({ bearers: runBearers, harnesses, takeover });
    // The bot steps a ship coordinator calls (docs/reference/specs/http-ingress.md
    // item 9): `POST /admin/coordinator/spawn|read-record|pr-check`, and the
    // `authorize` question the shim asks before it creates an instance — for
    // the `coordinator` bearer of the same token map, whose actor must hold
    // `coordinator:step`. A spawn is a `dispatch()` as the requester the parent
    // record names, into the unit's thread, tagged with the instance and key.
    // The check-run intake (http-ingress.md item 12): GitHub's `check_run`
    // webhook, verified against GITHUB_WEBHOOK_SECRET, wakes the merge steps
    // waiting at the settled head through the shim's event relay. The waiters
    // are noted by the merge step's `pending` answers below; the registry is
    // in-memory on purpose — a restart loses it and the driver's bounded merge
    // wait re-asks the door on its own cadence.
    const mergeWaits = createMergeWaitRegistry();
    const checksWorkflow = workflowSender;
    const githubWebhook = createGithubWebhookHandler({
      secret: processSecrets.get("GITHUB_WEBHOOK_SECRET")?.reveal(),
      checksSettled: async (repo, headSha) => {
        const checks = await fetchCommitChecks(repo, headSha);
        return checks !== undefined && checks.total > 0 && checks.pending.length === 0;
      },
      instancesWaitingAt: (headSha) => Promise.resolve(mergeWaits.waitingAt(headSha, systemClock())),
      workflow: checksWorkflow,
      now: systemClock,
    });
    const coordinatorAdmin = createAdminCoordinatorHandler({
      tokens: processSecrets.get("SWITCHBOARD_INGRESS_TOKENS"),
      grantsFor: (id) => config.grantsFor(id),
      instances: coordinatorInstances,
      // The runs page base (agent-ship item 12): a unit-end report links a
      // child's write-up to its run page; without PUBLIC_BASE_URL it names the run id.
      ...(process.env.PUBLIC_BASE_URL?.trim()
        ? { runPageBase: `${process.env.PUBLIC_BASE_URL.trim().replace(/\/+$/, "")}/runs` }
        : {}),
      runs: runsService,
      // The hosted parent's write door (record 0060): the runner's routes
      // publish to the parent's registry row and renew its ledger deadline.
      registry: defaultRunRegistry,
      ledgerRuns: () => runLedger.liveRuns(),
      dispatch: (msg, io, opts) => dispatch(deps, msg, io, opts),
      ioFor: (thread) => threadIoFor(thread),
      findOpenPrByHead,
      findMergedPrByHead,
      // The recover path (agent-ship item 15): a coding child that pushed and
      // then died has its pull request opened from the branch itself.
      openPullRequest,
      // The round-0 fact (agent-ship item 12): a branch with no commits over
      // the base, beside a handoff naming where the scope landed, ends the
      // unit already_landed instead of aborting it.
      commitsOverBase,
      // The App's GitHub reads for the plan, the specs, the rules and a unit's
      // board issue; the branch create; the reviews and the identity the merge
      // gate's "the verdict stands" question is answered from.
      github: deps.githubApi ?? new RestGithubApi(),
      createBranchRef,
      fetchPrReviews: fetchPullRequestReviews,
      // The merge step (record 0031's merge grant): the pull request as GitHub has it, the checks at its head, the squash.
      fetchPrFacts: fetchPullRequestFacts,
      fetchCommitChecks,
      // The ready state beside the checks (agent-ship item 9): the head's
      // self-declared fix-up commits, read on the ending's facts pr-check.
      fixupCommitSubjects,
      mergePullRequest,
      selfIdentity: resolveGithubIdentity,
      runHistoryWriter,
      channelVisibilityOf: (channelId) => channelVisibilityOf(deps, channelId),
      noteMergeWait: (headSha, instanceId, at) => mergeWaits.note(headSha, instanceId, at),
      // The round's checks step (record 0055): the runs at the reviewed head
      // classified against the pull request's changed paths, and the flake
      // rule's one re-run of the failed jobs behind them.
      fetchRoundChecks: async (repo, sha, prNumber) => {
        const runs = await fetchCheckRunDetails(repo, sha);
        if (runs === undefined) return undefined;
        const changed = await pullRequestChangedPaths({ repo, number: prNumber });
        return classifyRoundChecks(runs, changed);
      },
      rerunFailedChecks: rerunFailedJobs,
    });
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
    // /assets/*. The build is loaded once at startup from `web/dist` under the
    // package root — the checkout, `/app` in the image, the npm package's
    // `dist/assets` — so `start` from the package has the dashboard wherever it
    // runs; a missing build is a boot error (the Docker image and the package
    // build it; local dev runs `npm run build` in web/ once, or points
    // SWITCHBOARD_WEB_DIST elsewhere).
    const webAssets = loadWebAssets(webDistDir(publicEnv(), PACKAGE_ROOT));
    const page = makePageSender(webAssets.entry, capabilities);
    // Residents dash: GET /residents (index) + /residents/:owner/:name (detail),
    // the browser twin of `repo list`. Reads the resident Worker's admin
    // /residents route live on every request with the same bearer the chat
    // commands use; without residents (or without the admin bearer) the null
    // client answers every route 503 with the reason, and so does the page.
    // Access-gated below alongside /runs — it lists every onboarded repo and
    // its build commands, so it must never be exposed without SSO.
    // The index folds each resident open to the runs on it: the registry's
    // live rows seed it and its `?stream=1` feed keeps it current.
    const residentsView = createResidentsViewHandler({
      client: residentAdminClient,
      page,
      runs: defaultRunRegistry,
      trace: { config, spanLog },
    });
    const residentsState =
      residentAdminClient instanceof NullResidentAdminClient
        ? `GET /residents (503 — ${residentAdminClient.reason})`
        : `GET /residents (dash → ${config.config.execution?.resident?.baseUrl})`;
    // Costs dash: GET /costs (first group) + /costs/<group> (+ .json twins),
    // served from the snapshot built above. Access-gated below alongside /runs
    // and /residents.
    const costsView = createCostsViewHandler(costsService, page, { names });
    // The plane panel: GET /plane (+ .json twin) over the plane service; the live
    // rows' tokens come from the registry's index face, as the runs index reads them.
    const planeView = createPlaneViewHandler(planeService, page, {
      liveTokens: () => new Map(defaultRunRegistry.listActive().map((s) => [s.id, s.token])),
    });
    const costsState = costs
      ? `GET /costs (${costsService.groups().join(",")}; LLM ${costs.llmOn ? "on" : "off"}; snapshot every ${costsCfg?.snapshot.everyHours ?? "?"} h)`
      : costsCfg
        ? `GET /costs (503 — ${costsCfg.cloudflareTokenEnv} not set)`
        : "GET /costs (503 — no costs config)";
    // Delivery page: GET /delivery (first repository) + /delivery/<owner>/<name>
    // (+ .json twin). Reads GitHub and the viewer's own runs live per request;
    // gated below alongside /runs, /residents and /costs.
    const deliveryView = createDeliveryViewHandler({ service: deliveryService, runs: runsService }, page);
    // Settings page: GET /settings and its tabs (record 0041). Every tab's seed
    // is the registry's answer to the same commands the CLI would run, invoked
    // as the viewer; the Installation tab projects the running config by allow-list.
    const settingsView = createSettingsViewHandler(
      {
        commands,
        names,
        callerFor: (identity) =>
          callerFor(identity, { grantsFor: (id) => config.grantsFor(id), personByEmail, channelsOf, personName }),
        installation: () => installationSettings(config.config, capabilities),
        vocabulary: {
          agents: Object.keys(AGENTS),
          efforts: [...EFFORT_LEVELS],
          identities: [...IDENTITIES],
          machines: [...MACHINE_CLASSES],
        },
        capabilities,
      },
      page,
    );
    // The web chat (record 0043, docs/reference/specs/web-chat.md): channel
    // adapter #5 at `/threads`. `POST /threads/<id>/send` dispatches the body as
    // the gate's actor into the same `dispatch()` every channel calls; the
    // pages seed from the runs service under the viewer's predicate; the
    // palette is the chat catalogue the viewer may run. Access-gated below with
    // every other section — the send route starts runs as the session.
    const webChat = createWebChatHandler({
      core: deps,
      service: runsService,
      registry: defaultRunRegistry,
      commands,
      page,
      capabilities,
      names,
      retention:
        capabilities.runHistory && runHistoryCfg
          ? { retentionDays: retentionPolicyOf(runHistoryCfg).retentionDays }
          : null,
      // The thread view's silent receipts (web-chat item 12): the ledger's own
      // read — no write-through, a failing read seeds the runs alone.
      intake: ledgerClient ? { listIntake: (query) => ledgerClient.listIntake(query) } : null,
      publicBaseUrl: process.env.PUBLIC_BASE_URL,
    });
    const deliveryState = !capabilities.github
      ? "GET /delivery (503 — no GitHub credential)"
      : deliveryService.repos().length === 0
        ? "GET /delivery (503 — no delivery.repos)"
        : `GET /delivery (${deliveryService.repos().join(",")}; snapshot every ${deliveryEveryMinutes} min)`;
    const tokenCount = Object.keys(auth.tokens).length;
    const liveViewState = process.env.PUBLIC_BASE_URL
      ? "GET /runs (index) + /runs/:id (live view)"
      : "GET /runs (index) + live view (no PUBLIC_BASE_URL — per-run links omitted)";

    // Everything the dashboard serves — /runs*, /residents*, /costs*,
    // /delivery*, /settings*, /threads*, /mcp/connect/* and /api/* — sits
    // behind ONE identity gate, the dashboard
    // auth strategy composed below (`dashboardAuth`). Under `access` the edge
    // rule injects a signed RS256 JWT in `Cf-Access-Jwt-Assertion` and we
    // re-verify it here, fail-closed — even if the edge rule is ever
    // misconfigured or a client spoofs the header. ACCESS_* stay the env inputs
    // of that strategy; null means Access is not configured.
    const accessConfig = parseAccessConfig(publicEnv());
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
    // resolved with the SAME `resolveAccessActor` the /api adapter uses and handed to
    // the handler as `ctx.actor` below, so the index lists and the run page
    // reads exactly what `/api/runs.*` would for that identity — under the
    // `token` strategy the configured actor, under `none` the local operator
    // `access:loopback`, each granted like any other browser session.
    const publicBaseUrl = process.env.PUBLIC_BASE_URL;
    // /docs* sends every caller to the project's published docs
    // (src/core/docsLink.ts): the site is the project's, not a feature an
    // installation deploys a copy of.
    // The view-as picker's people (record 0053): everyone the grants table names and every
    // requester in run history, named through the directory — computed off the request behind a
    // cache the index reads, primed now so the first admin paint after startup already has them.
    const viewAsPeople = peopleSource({
      granted: () => config.grantedPeople(),
      requesters: async () =>
        (await runsService.listRuns({ status: "all", visibleTo: { kind: "all" }, limit: RUN_LIST_MAX_LIMIT })).runs,
      name: personName,
    });
    void viewAsPeople.refresh();
    const liveView = createLiveViewHandler({
      page,
      service: runsService,
      index: defaultRunRegistry,
      // The view-as picker's people (record 0053): the cache `viewAsPeople` keeps.
      people: () => viewAsPeople.current(),
      retention:
        capabilities.runHistory && runHistoryCfg
          ? { retentionDays: retentionPolicyOf(runHistoryCfg).retentionDays }
          : null,
      // The panel's own off-state wording (live-view item 14: "firing history
      // unavailable", never "never fired") stands until the dashboard paints the
      // off-state from the seed's capabilities; so the panel gets no store when
      // schedules are off, not the null one.
      scheduled: { schedules: SCHEDULES, store: capabilities.schedules ? scheduleStore : undefined },
      // The run page's files (live-view.md item 26), when a store is configured.
      ...(artifacts
        ? {
            artifacts: {
              store: artifacts,
              retentionDays: config.config.artifacts?.retentionDays ?? ARTIFACT_DEFAULTS.retentionDays,
            },
          }
        : {}),
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
      secrets: processSecrets,
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
      personByEmail,
      channelsOf,
      personName,
      publicBaseUrl,
    });
    // View-as (record 0053): the cookie's routes, under the Access-covered /runs prefix.
    const viewAsRoutes = createViewAsHandler({ publicBaseUrl, secure: publicBaseUrl?.startsWith("https://") ?? false });
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
      if (path === GITHUB_WEBHOOK_PATH) {
        void githubWebhook(req, res);
        return;
      }
      if (path === "/mcp") {
        mcp(req, res);
        return;
      }
      if (isModelProxyPath(path)) {
        modelProxy(req, res);
        return;
      }
      if (isHarnessPath(path)) {
        harnessRoutes(req, res);
        return;
      }
      // An operator's bearer for a live run (a `deploy:write` ingress bearer, like
      // the restart and the crash), so the proxy can be probed against a real run.
      if (path === MODEL_PROXY_BEARER_PATH) {
        handleAdminModelProxyBearer(req, res, {
          tokens: processSecrets.get("SWITCHBOARD_INGRESS_TOKENS"),
          grantsFor: (id) => config.grantsFor(id),
          bearers: runBearers,
        });
        return;
      }
      // The Worker shim's question before `deploy restart` stops this container
      // (deploy/cloudflare/worker.ts): does the bearer's actor hold `deploy:write`?
      // The Worker holds the token map; the grants are this config's.
      if (path === RESTART_AUTHORIZE_PATH) {
        handleAdminRestartAuthorize(req, res, {
          tokens: processSecrets.get("SWITCHBOARD_INGRESS_TOKENS"),
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
          tokens: processSecrets.get("SWITCHBOARD_INGRESS_TOKENS"),
          grantsFor: (id) => config.grantsFor(id),
          spanLog,
        });
        return;
      }
      if (isCoordinatorAdminPath(path)) {
        coordinatorAdmin(req, res);
        return;
      }
      if (path === "/admin/crash") {
        handleAdminCrash(req, res, {
          tokens: processSecrets.get("SWITCHBOARD_INGRESS_TOKENS"),
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
        path.startsWith("/costs/") ||
        path === "/plane" ||
        path === "/plane.json" ||
        path === "/delivery" ||
        path === "/delivery.json" ||
        path.startsWith("/delivery/") ||
        path === "/settings" ||
        path.startsWith("/settings/") ||
        path === "/threads" ||
        path.startsWith("/threads/")
      ) {
        dashboardAuth
          .verify(req)
          .then(async (gate) => {
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
            // The view-as cookie's word rides the identity (record 0053); the resolver
            // decides whether it counts — only for a session whose own actor holds `all`.
            const viewAs = viewAsFromCookie(req.headers.cookie);
            const identity: AccessIdentity = viewAs !== undefined ? { ...gate.identity, viewAs } : gate.identity;
            // --- /api/*: the command handler owns everything under it. ---
            if (isCommandPath(path)) return commandHttp(req, res, identity);
            // --- end /api/* ---
            // The pages' actor: the same resolution `/api` makes, linked to its
            // person when the session's email names one (record 0042), or viewing
            // as one when an admin's cookie says so (record 0053).
            const actor = await resolveAccessActor(identity, {
              grantsFor: (id) => config.grantsFor(id),
              personByEmail,
              channelsOf,
              personName,
            });
            if (viewAsRoutes(req, res, { actor })) return;
            if (liveView(req, res, { actor })) return;
            // --- /threads*: the web chat, the actor's own runs and lane (record 0043). ---
            if (webChat(req, res, { actor, identity })) return;
            // --- /mcp/connect/<nonce>: the credential page, identity-bound. ---
            if (mcpConnectView(req, res, gate.identity)) return;
            if (residentsView(req, res, { actor })) return;
            if (costsView(req, res, { identity, actor })) return;
            if (planeView(req, res, { actor })) return;
            if (deliveryView(req, res, { actor })) return;
            if (settingsView(req, res, { identity })) return;
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
      // Root → the chat (record 0043, amended). `/` is NOT Access-gated — the
      // Access application lists path prefixes, and `/` would cover the bearer
      // routes (`POST /mcp`, `/ingress`) — so this 302 is public; it leaks
      // nothing (just "go to /threads"), and /threads itself stays behind the
      // gate. An EXACT-path match, so /healthz and everything else still fall
      // through to the probes below.
      if (path === "/") {
        res.writeHead(302, { location: "/threads" });
        res.end();
        return;
      }
      // /docs* → the docs site (deploy/cloudflare-docs/), subpath preserved.
      // Public like `/`: it discloses only the docs hostname, and the docs site
      // itself sits behind the same Cloudflare Access as the dashboards, so an
      // unauthenticated follower meets the SSO login there. This is the stable
      // in-product path the dashboard header links to — see src/core/docsLink.ts.
      const docsTarget = docsRedirectTarget(path);
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
              held: heldRuns(),
              catchUp: getCatchUpStatus(),
              slack: getSocketStatus(),
              build,
              ...(capabilities.runLedger ? { generation } : {}),
              startedAt: PROCESS_STARTED_AT,
              httpListeningAt,
              process: sampleProcessMetrics(),
              ...(artifacts ? { artifacts: { bucket: artifacts.bucket } } : {}),
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
        `http server on :${process.env.PORT} (health + POST /ingress + POST /mcp + model proxy (POST ${ANTHROPIC_MESSAGES_PATH}, POST ${OPENAI_CHAT_COMPLETIONS_PATH}, POST ${OPENAI_RESPONSES_PATH}) + ${liveViewState} + ${schedulesState} + ${residentsState} + ${costsState} + ${deliveryState} + GET /settings + GET /threads (+ POST /threads/<id>/send) + ${commandHttpState} + /docs → ${PROJECT_DOCS_URL}; ` +
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
    threadsElsewhere.replace(threadsElsewhereOf(outcome));
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
      // The handle from the row's METADATA (record 0060): a hosted row's key
      // column carries the host suffix and names no thread of any channel.
      ioFor: (row) => threadIoFor(resumeIoTarget(row)),
      // A re-hosted parent's card is this generation's again, so the connect's
      // orphan sweep leaves it alone (slack-channel item 8).
      keepCardLive: adoptLiveCard,
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
      onDone: (runId) => takeover.done(runId),
      log: (l) => console.log(l),
      warn: (w) => console.warn(w),
    });
  };
  // The hosted-row guard's store read (record 0060): the reclaim
  // abandons a hosted row only when the plain store already holds the
  // pipeline's outcome — its `finish` landed there because the ledger refused
  // the write — and re-hosts every other one within its deadline.
  const storedStatus = async (runId: string) => (await runStore.get(runId))?.status;
  let bootReclaim: ReclaimOutcome | undefined;
  if (ledgerReclaim) {
    bootReclaim = await reclaimRuns({
      ledger: ledgerReclaim.client,
      gen: generation,
      storedStatus,
      log: (l) => console.log(l),
      warn: (w) => console.warn(w),
    });
    // The harness door learns which runs are on their way back before anything
    // else is awaited: a surviving pi's re-ask may already be waiting on it.
    takeover.take(bootReclaim);
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
  } else {
    // No ledger: nothing is ever on its way back, so the door's verdict is final from the start.
    takeover.settle();
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
      storedStatus,
      log: (l) => console.log(l),
      warn: (w) => console.warn(w),
      onOutcome: async (outcome) => {
        takeover.take(outcome);
        await guardCards(outcome);
        await launch(outcome);
      },
    });
  }

  console.log(
    `switchboard running (providers: ${completions.names().join(", ")}; default agent: ${config.config.defaults.agent})`,
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
    // it at once — whatever its lease — and carries on from its last step. A
    // hosted ship pipeline is among them (record 0060): its row has no process
    // to wait for, and the next generation re-hosts it. Those runs are not
    // waited for: they keep running here until the exit, and their writes are
    // fenced the moment the next generation reclaims them. Only the runs a
    // resume cannot continue (an untracked run) hold the drain, up to the old
    // deadline.
    const handoff = await runLedger.handoff();
    for (const id of handoff.marked) handedOff.add(id);
    const handed = handedOff;
    if (handoff.failed) console.warn(`[drain] handoff failed (${handoff.failed}) — waiting for the runs instead`);
    if (handed.size > 0)
      console.log(`[drain] handed ${handed.size} run(s) to the next generation: ${[...handed].join(", ")}`);
    // Counted by registry id, not by the write-through's live set: a handed run
    // that gets fenced mid-drain (the next generation took it) leaves that set
    // but is still handed — it must not start holding the drain again. The hold
    // line names each held run and why — never the dispatcher's in-flight count,
    // which can read 0 while a registry row holds the drain.
    const runsHeld = () => heldRuns().length;
    if (runsHeld() > 0) console.log(drainHoldLine(heldRuns()));
    const stillHere = () => runsHeld() + pendingReflectionCount() + pendingHistoryWrites();
    // The bound is re-read each poll: full deadline while a run holds the
    // drain, collapsing to the handoff grace the moment the last one ends —
    // the deadline is the bound for a run that will not end, never the
    // schedule (src/core/drain.ts, createDrainDeadline).
    const deadlineAt = createDrainDeadline(drainStartedAt);
    // The hold names what it waits on: the registry runs still active and not
    // handed off — not the dispatcher's `inFlight` counter, which a run whose
    // dispatch returned has already left — so a drain that runs to its deadline
    // says which run ids held it.
    if (runsHeld() > 0) {
      const held = defaultRunRegistry
        .listActive()
        .filter((r) => !r.finished && !handed.has(r.id))
        .map((r) => r.id);
      console.log(
        `[drain] waiting up to ${Math.round(DRAIN_DEADLINE_MS / MINUTE_MS)} min for ${held.length} run(s) still active and not handed off: ${held.join(", ")}`,
      );
    }
    let wasHeld = runsHeld() > 0;
    while (stillHere() > 0 && systemClock() < deadlineAt(systemClock(), runsHeld())) {
      await new Promise((r) => setTimeout(r, 500));
      if (wasHeld && runsHeld() === 0) {
        wasHeld = false;
        console.log(
          `[drain] last held run ended — exiting within the ${HANDOFF_BUDGET_MS} ms handoff grace, not at the deadline`,
        );
      }
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

// Run only as the process's entry (`node dist/index.js`, `npm run dev`, the
// image's no-argument entrypoint) — never when imported, and never as the second
// main of a process the CLI already claimed (its bundle inlines this module).
if (claimEntry(import.meta.url)) {
  runBot().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
