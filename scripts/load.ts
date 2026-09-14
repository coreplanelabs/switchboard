// The load harness entrypoint (docs/reference/specs/load-harness.md).
//
//   npm run load -- history                       peak concurrency from the run store
//   npm run load -- resident --resource repo:owner/name --threads 16 --hold 600
//   npm run load -- sandbox  -- --threads 8 --hold 300
//   npm run load -- e2e      -- --ingress-url http://127.0.0.1:8080/ingress --text "agent:coding in owner/name: load" --threads 50
//   npm run load -- cards    -- --cards 50 --hold 600 --channels 5
//   npm run load -- provider --port 8089 --profile coding --cpu-seconds 60
//   npm run load -- pi --checkout ../repo --task all --provider anthropic --model <id> --key-env ANTHROPIC_API_KEY
//   npm run load -- pi --suite review --checkout ../repo --task all --provider anthropic --model <id>   (merged PRs reviewed, verdicts recorded)
//   npm run load -- route --since <date> --limit 200 --provider anthropic --model <id>   (singles + the compound and imperative sets)
//
// Every command writes `load-results/<command>-<runId>.json` (the samples and
// the summary) and `.md` (the receipt) and exits non-zero when a configured
// check fails. Targets and bearers come from flags or the environment named in
// `--help`; nothing here is hard-coded to one deployment.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  evaluateSlo,
  renderMarkdown,
  summarize,
  type Sample,
  type SloCheck,
  type SloSpec,
  type Summary,
} from "../src/load/aggregate.js";
import { redactSecrets } from "../src/core/redact.js";
import { processSecrets, type Secret } from "../src/secrets.js";
import { simulateCards } from "../src/load/cardsLoad.js";
import { runE2eLoad } from "../src/load/e2eLoad.js";
import { durationStats, pageAll, peakConcurrency, realRuns } from "../src/load/history.js";
import { runResidentLoad, type ResidentThreadClient } from "../src/load/residentLoad.js";
import { runSandboxLoad } from "../src/load/sandboxLoad.js";
import {
  codingProfileScript,
  piCodingProfileScript,
  piReviewProfileScript,
  reviewProfileScript,
  startScriptedProvider,
} from "../src/load/scriptedProvider.js";
import { drivePiTask, realTimers, redactPiRun, type PiTaskRun } from "../src/load/piRpc.js";
import { judgeToolCall } from "../src/core/harness/pi/toolRules.js";
import { PI_TASK_NAMES, PI_TASKS, piTaskByName, taskBranch, taskPrompt } from "../src/load/piTasks.js";
import { PI_REVIEW_TASKS, PI_REVIEW_TASK_NAMES, piReviewTaskByName, reviewTaskUrl } from "../src/load/piReviewTasks.js";
import {
  reviewChecks,
  reviewFailureReason,
  reviewOutcome,
  reviewPrompt,
  reviewSystemPrompt,
  type ReviewRow,
} from "../src/load/piReview.js";
import {
  PI_CODING_TOOLS,
  PI_REVIEW_TOOLS,
  PROXIED_MODEL_ENTRY,
  checkoutBranch,
  checkoutPrHead,
  checkoutState,
  earlyExitNote,
  originSlug,
  piKeyEnvFor,
  spawnPi,
  writeAgentDir,
  writeSystemPrompt,
  type AgentDirLayout,
} from "../src/load/piProcess.js";
import {
  compoundExamples,
  compoundScore,
  confusionTable,
  historyCompounds,
  imperativeScore,
  labelledRequests,
  readToWriteRoutes,
  renderCompound,
  renderConfusion,
  renderImperative,
  replayCompound,
  replayImperative,
  replayRoutes,
  routeChecks,
} from "../src/load/routeReplay.js";
import { ROUTE_COMPOUND_FIXTURES } from "../src/load/routeCompoundFixtures.js";
import { ROUTE_IMPERATIVE_FIXTURES } from "../src/load/routeImperativeFixtures.js";
import { COMPOUND_PRESET } from "../src/agents/registry.js";
import { providerRouteModel, routablePresets, route, ROUTE_TIMEOUT_MS } from "../src/core/dispatch/route.js";
import { DEFAULT_MAX_CHILDREN } from "../src/core/dispatch/spawn.js";
import { WorkerRunStore } from "../src/core/runStoreWorker.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { parsePrDescription } from "../src/core/prDescription.js";
import { CloudflareSandboxExecutor } from "../src/execution/cloudflareSandbox.js";
import { ResidentExecutor } from "../src/execution/resident.js";
import { systemClock } from "../src/core/trace/clock.js";

const RESULTS_DIR = process.env.SWITCHBOARD_LOAD_RESULTS ?? "load-results";

const USAGE = `usage: tsx scripts/load.ts <command> [flags]

commands
  history    peak concurrency and durations from the run store
             env: SWITCHBOARD_STATE_WORKER_URL, MEMORY_TOKEN (or --state-url / --token-env)
  resident   N synthetic threads against one resident
             --resource repo:owner/name  --threads N  --hold S  --stagger S  --profile review|coding
             --cpu-seconds S  --override
             env: SWITCHBOARD_RESIDENT_URL, RESIDENT_OPERATOR_TOKEN, RESIDENT_ADMIN_TOKEN (or --resident-url)
  sandbox    N per-thread cold sandboxes
             --threads N  --hold S  --stagger S  --cpu-seconds S  --override
             env: SWITCHBOARD_SANDBOX_URL, SANDBOX_TOKEN (or --sandbox-url)
  e2e        N runs through a bot's POST /ingress (synchronous mode)
             --ingress-url URL  --healthz-url URL  --text "agent:coding in owner/name: load"  --threads N  --hold S  --stagger S
             env: SWITCHBOARD_LOAD_INGRESS_TOKEN (or --token-env)
  cards      the status-card path in virtual time (no network)
             --cards N  --hold S  --channels N  [--client budgeted|retrying  --budget-per-minute N  --per-app-per-minute N  --per-channel-per-second N]
  provider   serve the scripted model for a local bot or for \`pi\` (blocks)
             --port N  --profile review|coding|pi-coding|pi-review  --cpu-seconds S  --terminal
  pi         the five representative coding tasks on pi's harness (pi --mode rpc in a checkout), or with
             --suite review the review tasks: merged public pull requests reviewed at their pinned head under the read
             identity's allowlist, the verdict recorded in the receipt and posted nowhere
             --checkout DIR  --task all|<name>  --provider NAME  --model ID  --key-env VAR  [--suite coding|review]
             [--pi PATH  --thinking LEVEL  --budget-minutes N  --base-url URL (a custom OpenAI-compatible endpoint)]
             [--through-proxy URL  (--shape anthropic|openai)]: the bot's model proxy as pi's one provider — URL is the
             bot's base, the key variable holds a run bearer (SWITCHBOARD_PI_MODEL_KEY unless --key-env names another)
             the model key is read from the environment variable --key-env names (default: the variable pi reads
             for --provider, e.g. ANTHROPIC_API_KEY); never from a file, never printed
             --print-prompt --task <name>: print the task's prompt and exit (for the same task on today's coding agent)
  route      the request router replayed against finished runs whose requester typed the preset (the label), its
             compound form scored on the checked-in set (src/load/routeCompoundFixtures.ts) and the history's conductor runs,
             and the terse imperatives scored on theirs (src/load/routeImperativeFixtures.ts)
             --provider NAME  --model ID  [--key-env VAR  --base-url URL  --since DATE  --limit N  --default-agent NAME
             --concurrency N  --max-parts N (the compound cap, default spawn.maxChildren's 3)]
             env: SWITCHBOARD_STATE_WORKER_URL, MEMORY_TOKEN (or --state-url / --token-env); the model key as for pi
`;

type Flags = Record<string, string | boolean | undefined>;

const pct = (n: number) => (Number.isFinite(n) ? `${Math.round(n * 1000) / 10}%` : "—");

function flags(argv: string[]): Flags {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: false,
    options: {
      resource: { type: "string" },
      threads: { type: "string" },
      cards: { type: "string" },
      channels: { type: "string" },
      hold: { type: "string" },
      stagger: { type: "string" },
      profile: { type: "string" },
      "cpu-seconds": { type: "string" },
      override: { type: "boolean" },
      terminal: { type: "boolean" },
      port: { type: "string" },
      text: { type: "string" },
      "ingress-url": { type: "string" },
      "healthz-url": { type: "string" },
      "resident-url": { type: "string" },
      "sandbox-url": { type: "string" },
      "state-url": { type: "string" },
      "token-env": { type: "string" },
      "per-app-per-minute": { type: "string" },
      "per-channel-per-second": { type: "string" },
      client: { type: "string" },
      "budget-per-minute": { type: "string" },
      checkout: { type: "string" },
      task: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "key-env": { type: "string" },
      pi: { type: "string" },
      thinking: { type: "string" },
      "budget-minutes": { type: "string" },
      "base-url": { type: "string" },
      "through-proxy": { type: "string" },
      suite: { type: "string" },
      shape: { type: "string" },
      "print-prompt": { type: "boolean" },
      since: { type: "string" },
      limit: { type: "string" },
      "default-agent": { type: "string" },
      concurrency: { type: "string" },
      "max-parts": { type: "string" },
      help: { type: "boolean" },
    },
  });
  return values as Flags;
}

const str = (f: Flags, k: string, fallback?: string): string => {
  const v = f[k];
  if (typeof v === "string" && v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${k} is required`);
};
const num = (f: Flags, k: string, fallback: number): number => {
  const v = f[k];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${k} must be a non-negative number (got ${String(v)})`);
  return n;
};
const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const secretFile = (name: string): string | undefined => {
  try {
    return readFileSync(`${process.env.HOME}/.secrets/switchboard/${name}`, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};
const bearer = (name: string): string => process.env[name] ?? secretFile(name) ?? env(name);

const runId = () =>
  new Date(systemClock())
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

function writeResults(
  command: string,
  id: string,
  startedAt: string,
  params: Record<string, unknown>,
  summary: Summary,
  checks: SloCheck[],
  extra: Record<string, unknown>,
  notes: string[] = [],
): boolean {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const base = `${RESULTS_DIR}/${command}-${id}`;
  writeFileSync(
    `${base}.json`,
    JSON.stringify({ command, runId: id, startedAt, params, summary, checks, ...extra }, null, 2),
  );
  const md = renderMarkdown({ title: `load:${command}`, runId: id, startedAt, params, summary, checks, notes });
  writeFileSync(`${base}.md`, md);
  process.stdout.write(md);
  process.stdout.write(`\nwrote ${base}.json and ${base}.md\n`);
  return checks.every((c) => c.pass);
}

const RESIDENT_SLO: SloSpec = {
  latencyMs: [
    { op: "attach", p: 50, maxMs: 15_000 },
    { op: "attach", p: 95, maxMs: 60_000 },
    { op: "exec", p: 95, maxMs: 3_000 },
  ],
  zeroReasons: ["mirror-busy", "user-pool-exhausted", "disk-pressure"],
};
const SANDBOX_SLO: SloSpec = {
  latencyMs: [
    { op: "first-exec", p: 95, maxMs: 90_000 },
    { op: "exec", p: 95, maxMs: 3_000 },
  ],
  zeroReasons: ["fleet-busy"],
};
// Structural, not an enumerated reason list: a run's failure reason is its
// terminal status or an HTTP status, and an unanticipated one (`http-401`)
// must fail the receipt, never pass by omission.
const E2E_SLO: SloSpec = { zeroFailures: ["run"] };

async function history(f: Flags): Promise<boolean> {
  const id = runId();
  const startedAt = new Date(systemClock()).toISOString();
  const base = str(f, "state-url", process.env.SWITCHBOARD_STATE_WORKER_URL).replace(/\/$/, "");
  const token = bearer(str(f, "token-env", "MEMORY_TOKEN"));
  const items = await pageAll(
    async (cursor) => {
      const body: Record<string, unknown> = { storeKey: "runs:default", limit: 200, ...(cursor ?? {}) };
      const res = await fetch(`${base}/runs/list`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${base}/runs/list HTTP ${res.status}`);
      const data = (await res.json()) as {
        items: Array<{ id: string; startedAt: number; finishedAt: number; agent?: string }>;
      };
      return data.items;
    },
    { pageSize: 200, maxPages: 50 },
  );
  const runs = realRuns(items);
  const peak = peakConcurrency(runs);
  const durations = durationStats(runs);
  const byAgent: Record<string, number> = {};
  for (const r of runs) byAgent[r.agent ?? "?"] = (byAgent[r.agent ?? "?"] ?? 0) + 1;
  const summary = summarize(
    runs.map((r) => ({ op: "run", startedAt: r.startedAt, ms: r.finishedAt - r.startedAt, ok: true })),
  );
  const notes = [
    `peak concurrent runs: ${peak.peak}${peak.at ? ` at ${new Date(peak.at).toISOString()}` : ""}`,
    `per-day peak: ${Object.entries(peak.perDay)
      .map(([d, p]) => `${d}=${p}`)
      .join(" ")}`,
    `durations (s): mean ${durations.meanS} p50 ${durations.p50S} p90 ${durations.p90S} p99 ${durations.p99S} max ${durations.maxS}`,
    `by agent: ${Object.entries(byAgent)
      .map(([a, n]) => `${a}=${n}`)
      .join(" ")}`,
    `${items.length} rows fetched, ${runs.length} real runs (tombstones dropped)`,
  ];
  return writeResults("history", id, startedAt, { stateUrl: base }, summary, [], { peak, durations, byAgent }, notes);
}

async function resident(f: Flags): Promise<boolean> {
  const id = runId();
  const startedAt = new Date(systemClock()).toISOString();
  const baseUrl = str(f, "resident-url", process.env.SWITCHBOARD_RESIDENT_URL).replace(/\/$/, "");
  const operator = bearer("RESIDENT_OPERATOR_TOKEN");
  const admin = bearer("RESIDENT_ADMIN_TOKEN");
  const resource = str(f, "resource");
  const profileFlag = str(f, "profile", "coding");
  if (profileFlag !== "review" && profileFlag !== "coding") throw new Error(`--profile must be review or coding`);
  const profile: "review" | "coding" = profileFlag;
  const params = {
    runId: id,
    resource,
    threads: num(f, "threads", 8),
    staggerMs: num(f, "stagger", 30) * 1000,
    holdMs: num(f, "hold", 600) * 1000,
    profile,
    cpuSeconds: num(f, "cpu-seconds", 60),
    override: f.override === true,
  };
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  const out = await runResidentLoad(params, {
    signal: ac.signal,
    openClient: (threadKey, readonly): ResidentThreadClient =>
      new ResidentExecutor({ baseUrl, token: operator, resource, threadKey, ...(readonly ? { readonly: true } : {}) }),
    status: async () => {
      const res = await fetch(`${baseUrl}/status?resource=${encodeURIComponent(resource)}`, {
        headers: { authorization: `Bearer ${operator}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as { state?: string; inFlight?: number };
      return {
        state: data.state ?? `http-${res.status}`,
        inFlight: typeof data.inFlight === "number" ? data.inFlight : null,
      };
    },
    purge: async (prefix) => {
      const res = await fetch(`${baseUrl}/debug`, {
        method: "POST",
        headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
        body: JSON.stringify({ op: "purge-bindings", resource, prefix }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await res.json().catch(() => ({}))) as { purged?: string[]; keptLive?: string[]; error?: string };
      if (!res.ok) throw new Error(`purge-bindings HTTP ${res.status}: ${data.error ?? ""}`);
      return { purged: data.purged?.length ?? 0, keptLive: data.keptLive?.length ?? 0 };
    },
  });
  const summary = summarize(out.samples);
  const checks = evaluateSlo(summary, RESIDENT_SLO);
  const notes = [
    `threads started ${out.result.started}, setup failures ${out.result.setupFailures}, iterations ${out.result.iterations}, iteration errors ${out.result.errors}${out.result.aborted ? ", ABORTED" : ""}`,
    "purge: " +
      ("failed" in out.purge
        ? `FAILED (${out.purge.failed})`
        : `${out.purge.purged} binding(s) removed, ${out.purge.keptLive} still live`),
  ];
  return writeResults(
    "resident",
    id,
    startedAt,
    { ...params, baseUrl },
    summary,
    checks,
    { samples: out.samples, result: out.result, purge: out.purge },
    notes,
  );
}

async function sandbox(f: Flags): Promise<boolean> {
  const id = runId();
  const startedAt = new Date(systemClock()).toISOString();
  const url = str(f, "sandbox-url", process.env.SWITCHBOARD_SANDBOX_URL).replace(/\/$/, "");
  const token = bearer("SANDBOX_TOKEN");
  const params = {
    runId: id,
    threads: num(f, "threads", 4),
    staggerMs: num(f, "stagger", 30) * 1000,
    holdMs: num(f, "hold", 300) * 1000,
    cpuSeconds: num(f, "cpu-seconds", 60),
    override: f.override === true,
  };
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  const out = await runSandboxLoad(params, {
    signal: ac.signal,
    openClient: (threadKey) => new CloudflareSandboxExecutor({ url, token, threadKey, resolveEnvs: async () => ({}) }),
  });
  const summary = summarize(out.samples);
  const checks = evaluateSlo(summary, SANDBOX_SLO);
  const notes = [
    `threads started ${out.result.started}, setup failures ${out.result.setupFailures}, iterations ${out.result.iterations}, iteration errors ${out.result.errors}`,
  ];
  return writeResults(
    "sandbox",
    id,
    startedAt,
    { ...params, url },
    summary,
    checks,
    { samples: out.samples, result: out.result },
    notes,
  );
}

async function e2e(f: Flags): Promise<boolean> {
  const id = runId();
  const startedAt = new Date(systemClock()).toISOString();
  const params = {
    runId: id,
    ingressUrl: str(f, "ingress-url"),
    token: bearer(str(f, "token-env", "SWITCHBOARD_LOAD_INGRESS_TOKEN")),
    text: str(f, "text"),
    threads: num(f, "threads", 8),
    staggerMs: num(f, "stagger", 30) * 1000,
    holdMs: num(f, "hold", 600) * 1000,
    healthzUrl: typeof f["healthz-url"] === "string" ? f["healthz-url"] : undefined,
    healthzEveryMs: 15_000,
  };
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  const out = await runE2eLoad(params, { fetch, signal: ac.signal });
  const summary = summarize(out.samples);
  const checks = evaluateSlo(summary, E2E_SLO);
  const rss = out.health.map((h) => h.rssMb).filter((n): n is number => n !== undefined);
  const lag = out.health.map((h) => h.eventLoopLagP99Ms).filter((n): n is number => n !== undefined);
  const notes = [
    `threads started ${out.result.started}, runs ${summary.total}, iteration errors ${out.result.errors}${out.result.aborted ? ", ABORTED" : ""}`,
    `healthz samples ${out.health.length}: rss max ${rss.length ? Math.max(...rss) : "—"} MB, event-loop lag p99 max ${lag.length ? Math.max(...lag) : "—"} ms`,
  ];
  return writeResults(
    "e2e",
    id,
    startedAt,
    { ...params, token: "(redacted)" },
    summary,
    checks,
    { samples: out.samples, result: out.result, health: out.health },
    notes,
  );
}

async function cards(f: Flags): Promise<boolean> {
  const id = runId();
  const startedAt = new Date(systemClock()).toISOString();
  const params = {
    cards: num(f, "cards", 50),
    holdMs: num(f, "hold", 600) * 1000,
    channels: num(f, "channels", 5),
    // `--client retrying` is the pre-budget adapter, the baseline the budget is measured against.
    client: str(f, "client", "budgeted") === "retrying" ? ("retrying" as const) : ("budgeted" as const),
    ...(f["budget-per-minute"] !== undefined ? { budgetPerMinute: num(f, "budget-per-minute", 50) } : {}),
    ...(f["per-app-per-minute"] !== undefined ? { perAppPerMinute: num(f, "per-app-per-minute", 50) } : {}),
    ...(f["per-channel-per-second"] !== undefined ? { perChannelPerSecond: num(f, "per-channel-per-second", 1) } : {}),
  };
  const out = simulateCards(params);
  const summary: Summary = {
    ops: [
      {
        op: "chat.update",
        count: out.stats.updates + out.stats.ratelimited,
        ok: out.stats.updates,
        failed: out.stats.ratelimited,
        p50: out.stats.lagMs.p50,
        p95: out.stats.lagMs.p95,
        p99: out.stats.lagMs.p99,
        max: out.stats.lagMs.max,
      },
    ],
    refusals: out.stats.ratelimited ? { ratelimited: out.stats.ratelimited } : {},
    total: out.stats.updates + out.stats.ratelimited,
  };
  const checks: SloCheck[] = [
    {
      name: "card update lag p95 ≤ 10000 ms",
      pass: out.stats.lagMs.p95 <= 10_000,
      actual: `${out.stats.lagMs.p95} ms`,
      limit: "≤ 10000 ms",
    },
    {
      name: "every terminal frame accepted",
      pass: out.terminalAccepted === params.cards,
      actual: `${out.terminalAccepted}/${params.cards}`,
      limit: `${params.cards}`,
    },
    {
      name: "every card edited at least once",
      pass: out.stats.cards === params.cards,
      actual: `${out.stats.cards}/${params.cards}`,
      limit: `${params.cards}`,
    },
  ];
  const notes = [
    out.client === "budgeted"
      ? `client budgeted: frames produced ${out.framesProduced}, accepted edits ${out.stats.updates}, held back by the budget ${out.budgetDropped}, refused by Slack ${out.stats.ratelimited}, terminal frames re-sent ${out.terminalResent}`
      : `client retrying: frames produced ${out.framesProduced}, accepted edits ${out.stats.updates}, refused ${out.stats.ratelimited}, retries ${out.retries}, stale retries dropped ${out.staleDropped}, given up ${out.givenUp}`,
    `virtual span ${Math.round(out.spanMs / 1000)} s (the simulation is instant; the latency column is card lag, not request time)`,
  ];
  return writeResults("cards", id, startedAt, params, summary, checks, { outcome: out }, notes);
}

async function provider(f: Flags): Promise<boolean> {
  const profile = str(f, "profile", "coding");
  const opts = { cpuSeconds: num(f, "cpu-seconds", 60), terminal: f.terminal === true };
  const script =
    profile === "review"
      ? reviewProfileScript(opts)
      : profile === "pi-coding"
        ? piCodingProfileScript(opts)
        : profile === "pi-review"
          ? piReviewProfileScript(opts)
          : codingProfileScript(opts);
  const server = await startScriptedProvider(script, { port: num(f, "port", 8089) });
  process.stdout.write(
    `scripted provider (${profile}, cpu ${opts.cpuSeconds}s${opts.terminal ? ", terminal tool" : ""}) on ${server.url}\n`,
  );
  process.stdout.write(
    `config: providers.scripted: { type: openai-compatible, baseUrl: ${server.url} } and defaults.models.<agent>: scripted/any\n`,
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await server.close();
  return true;
}

/** pi's `auth.json` is absent or an empty object: nothing was persisted. */
function authStoreEmpty(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** What both suites of `load:pi` share (docs/reference/specs/load-harness.md,
 *  the pi driver items): the provider — a built-in one with its own key, or
 *  the bot's model proxy with a run bearer — the checkout, the model, pi's
 *  binary and thinking level, the budget, and pi's config directory beside the
 *  receipt. The key comes from the environment variable `--key-env` names and
 *  goes nowhere but the child's environment. */
interface PiSetup {
  startedAt: string;
  providerName: string;
  keyEnv: string;
  key: Secret;
  checkout: string;
  model: string;
  budgetMs: number;
  piBin: string;
  thinking: string | undefined;
  baseUrl: string | undefined;
  throughProxy: string | undefined;
  extensionPath: string;
  agentDir: string;
  layout: AgentDirLayout;
}

/** Undefined when the key is not in the environment — the reason is printed
 *  and the command refuses to start. */
function piSetup(f: Flags, id: string, defaultBudgetMinutes: number): PiSetup | undefined {
  const startedAt = new Date(systemClock()).toISOString();
  // Through the bot's model proxy (docs/reference/specs/harness-pi.md, the
  // live receipt): pi's one provider is the bot, on the shape the run's
  // provider speaks, and the "key" is a run bearer an operator minted — the
  // harness's own variable holds it, never a provider's.
  const throughProxy = typeof f["through-proxy"] === "string" ? f["through-proxy"].replace(/\/$/, "") : undefined;
  const shape = str(f, "shape", "anthropic");
  if (shape !== "anthropic" && shape !== "openai") throw new Error("--shape must be anthropic or openai");
  const providerName = throughProxy ? "switchboard" : str(f, "provider", "anthropic");
  const keyEnv = str(f, "key-env", piKeyEnvFor(providerName));
  const key = processSecrets.named(keyEnv);
  if (!key) {
    process.stderr.write(
      `load pi: the model key must be in the environment variable ${keyEnv} (name another with --key-env); refusing to start\n`,
    );
    return undefined;
  }
  const checkout = resolve(str(f, "checkout"));
  const model = str(f, "model");
  const budgetMs = num(f, "budget-minutes", defaultBudgetMinutes) * 60_000;
  const piBin = str(f, "pi", "pi");
  const thinking = typeof f.thinking === "string" ? f.thinking : undefined;
  const baseUrl = throughProxy
    ? shape === "openai"
      ? `${throughProxy}/v1`
      : throughProxy
    : typeof f["base-url"] === "string"
      ? f["base-url"]
      : undefined;
  const api = throughProxy
    ? shape === "openai"
      ? ("openai-completions" as const)
      : ("anthropic-messages" as const)
    : undefined;
  const extensionPath = resolve("src/load/piExtension.ts");

  // pi's config directory lives beside the receipt, not in a temp dir: its
  // session files are the run's own record and stay with the results
  // (settings.json and models.json hold no secret — the key is interpolated
  // from the environment at request time). Named relative to this cwd; the
  // child, which runs in the checkout, gets it absolute. Through the proxy
  // the model's entry carries what pi's catalog says of the model, so the
  // arm thinks like the direct one; the dry run's scripted model stays bare.
  const agentDir = `${RESULTS_DIR}/pi-${id}-agent`;
  const layout = writeAgentDir(agentDir, {
    provider: providerName,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(api ? { api } : {}),
    ...(throughProxy ? { modelEntry: PROXIED_MODEL_ENTRY } : {}),
  });
  return {
    startedAt,
    providerName,
    keyEnv,
    key,
    checkout,
    model,
    budgetMs,
    piBin,
    thinking,
    baseUrl,
    throughProxy,
    extensionPath,
    agentDir,
    layout,
  };
}

/** The pi spike (docs/reference/specs/load-harness.md, the pi driver items):
 *  each task starts one `pi --mode rpc` in the checkout, on a branch the
 *  driver creates, with the harness extension and nothing else loaded, and
 *  records what pi's stream said. `--suite review` runs the review tasks
 *  instead (`piReviewSuite`). */
async function pi(f: Flags): Promise<boolean> {
  const suite = str(f, "suite", "coding");
  if (suite !== "coding" && suite !== "review") throw new Error("--suite must be coding or review");
  if (suite === "review") return piReviewSuite(f);
  const id = runId();
  if (f["print-prompt"] === true) {
    // The same words for the other arm of the comparison: today's coding
    // agent gets this prompt through `npm run cli -- ask`. It names a branch
    // of its own, since no driver creates one for it. No pi, no key.
    const task = piTaskByName(str(f, "task"));
    if (!task) throw new Error(`--task must be one of ${PI_TASK_NAMES.join(", ")}`);
    process.stdout.write(taskPrompt(task, { name: taskBranch(`native-${task.name}`, id), created: false }) + "\n");
    return true;
  }
  const taskFlag = str(f, "task", "all");
  const tasks = taskFlag === "all" ? [...PI_TASKS] : [piTaskByName(taskFlag)].flatMap((t) => (t ? [t] : []));
  if (tasks.length === 0) throw new Error(`--task must be all or one of ${PI_TASK_NAMES.join(", ")}`);
  const setup = piSetup(f, id, 45);
  if (!setup) return false;
  const {
    startedAt,
    providerName,
    keyEnv,
    key,
    checkout,
    model,
    budgetMs,
    piBin,
    thinking,
    baseUrl,
    throughProxy,
    extensionPath,
    agentDir,
    layout,
  } = setup;

  const samples: Sample[] = [];
  const runs: PiTaskRun[] = [];
  const stderrs: Record<string, string> = {};
  for (const task of tasks) {
    const branch = taskBranch(task.name, id);
    await checkoutBranch(checkout, branch);
    const proc = spawnPi({
      piBin,
      checkout,
      extensionPath,
      provider: providerName,
      model,
      ...(thinking ? { thinking } : {}),
      // pi reads its provider's own variable; the operator's `--key-env`
      // names where the value comes FROM, never what the child sees.
      keyEnvName: piKeyEnvFor(providerName),
      keyValue: key,
      agentDir,
      sessionDir: layout.sessionDir,
      tools: PI_CODING_TOOLS,
    });
    const startedTask = systemClock();
    process.stdout.write(`pi ${task.name}: branch ${branch}, budget ${budgetMs / 60_000} min\n`);
    const run = await drivePiTask(proc.transport, {
      task: task.name,
      prompt: taskPrompt(task, { name: branch, created: true }),
      budgetMs,
      now: systemClock,
      timers: realTimers,
      preview: (tool, input) => judgeToolCall(tool, input, { identity: "write", checkout, branch }),
      describe: (input) => {
        try {
          parsePrDescription(input);
          return [];
        } catch (err) {
          return [err instanceof Error ? err.message.split("\n")[0] : String(err)];
        }
      },
      onEvent: (event) => {
        if (event.type === "tool_execution_start") process.stdout.write(`  ${String(event.toolName)}\n`);
      },
    });
    // pi shuts down when its stdin closes; give it 5 s, then kill. The timer
    // is unref'd and cleared so a prompt exit never waits on it.
    let exitTimer: NodeJS.Timeout | undefined;
    const exit = await Promise.race([
      proc.exited,
      new Promise<{ code: null; signal: null }>((r) => {
        exitTimer = setTimeout(() => r({ code: null, signal: null }), 5_000);
        exitTimer.unref();
      }),
    ]);
    if (exitTimer) clearTimeout(exitTimer);
    if (exit.code === null && exit.signal === null) proc.kill();
    stderrs[task.name] = redactSecrets(proc.stderr());
    const ok = run.terminal === "settled" && run.prShaped.reached;
    samples.push({
      op: "task",
      startedAt: startedTask,
      ms: run.wallMs,
      ok,
      status: run.terminal,
      ...(ok ? {} : { reason: run.terminal === "settled" ? "not-pr-shaped" : run.terminal }),
    });
    runs.push(redactPiRun(run));
    process.stdout.write(
      `  → ${run.terminal}, ${run.turns} turns, $${run.cost.total.toFixed(4)}, ${run.toolCalls.length} tool calls, PR-shaped: ${run.prShaped.reached}\n`,
    );
  }

  const summary = summarize(samples);
  const refusedCalls = runs.flatMap((r) =>
    r.toolCalls.filter((c) => c.verdict !== "allowed").map((c) => ({ task: r.task, ...c })),
  );
  // The gate's coverage: every call pi ran was seen by the hook. A call pi
  // answered by itself — its arguments failed pi's validation, were cut by the
  // output limit, or the tool is not on pi's list — never reached the hook
  // and never ran; it is listed with pi's reason and does not fail the check.
  const bypassed = runs.flatMap((r) =>
    r.toolCalls.filter((c) => c.gate === "bypassed").map((c) => `${r.task}:${c.callId} (${c.tool})`),
  );
  const rejectedByPi = runs.flatMap((r) =>
    r.toolCalls.filter((c) => c.gate === "rejected-by-pi").map((c) => ({ task: r.task, ...c })),
  );
  const vetted = runs.reduce((n, r) => n + r.toolCalls.filter((c) => c.gate === "vetted").length, 0);
  const unmapped = [...new Set(runs.flatMap((r) => r.unmapped))];
  const checks: SloCheck[] = [
    {
      name: "every task settled",
      pass: runs.every((r) => r.terminal === "settled"),
      actual: runs.map((r) => r.terminal).join(", "),
      limit: "settled",
    },
    {
      name: "every task reached a PR-shaped outcome",
      pass: runs.every((r) => r.prShaped.reached),
      actual: `${runs.filter((r) => r.prShaped.reached).length}/${runs.length}`,
      limit: `${runs.length}`,
    },
    {
      name: "every tool call pi ran was seen by the extension's tool_call hook — none bypassed the gate",
      pass: bypassed.length === 0,
      actual:
        bypassed.length === 0
          ? `${vetted} vetted${rejectedByPi.length === 0 ? "" : `; ${rejectedByPi.length} answered by pi before the hook, never ran`}`
          : `bypassed: ${bypassed.join(", ")}`,
      limit: "0 bypassed",
    },
    // pi creates an empty credential store in its config directory; the key
    // it read from the environment must never land in it, because the
    // directory stays beside the receipt.
    {
      name: "pi persisted no credential into its config directory",
      pass: authStoreEmpty(`${agentDir}/auth.json`),
      actual: authStoreEmpty(`${agentDir}/auth.json`) ? "auth.json absent or {}" : "auth.json carries entries",
      limit: "absent or {}",
    },
  ];
  const notes = [
    "| task | terminal | wall | turns | retries | tokens in/out | cost (pi catalog) | tool calls | refused | outside profile | PR-shaped |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...runs.map(
      (r) =>
        `| ${r.task} | ${r.terminal} | ${Math.round(r.wallMs / 1000)} s | ${r.turns} | ${r.retries} | ${r.usage.input}/${r.usage.output} | $${r.cost.total.toFixed(4)} | ${r.toolCalls.length} | ${r.toolCalls.filter((c) => c.verdict === "refused").length} | ${r.toolCalls.filter((c) => c.verdict === "outside-profile").length} | ${r.prShaped.reached ? "yes" : `no (${r.prShaped.problems.join("; ")})`} |`,
    ),
    // A task pi left before its first turn has no stream to explain it; its
    // stderr is the reason, and belongs on the receipt, not only in the JSON.
    ...runs.flatMap((r) => {
      const note = earlyExitNote(r.task, r, stderrs[r.task] ?? "");
      return note ? [note] : [];
    }),
    `model: ${runs[0]?.model ? `${runs[0].model.provider}/${runs[0].model.id} thinking ${runs[0].model.thinkingLevel}` : "unknown"}; pi's config and session files under ${agentDir} (kept: the sessions are the run's own record)`,
    `tool calls the policy preview would refuse or that fall outside the coding profile: ${refusedCalls.length === 0 ? "none" : ""}`,
    ...refusedCalls.map((c) => `  - ${c.task} ${c.tool} (${c.verdict}): ${c.reason} — \`${c.summary}\``),
    `tool calls pi answered by itself before the hook — nothing ran, so the gate had nothing to vet: ${rejectedByPi.length === 0 ? "none" : ""}`,
    ...rejectedByPi.map((c) => `  - ${c.task} ${c.tool} ${c.callId}: ${c.piRejection} — \`${c.summary}\``),
    `pi event kinds with no home on the run stream: ${unmapped.length === 0 ? "none" : unmapped.join(", ")}`,
    ...runs.flatMap((r) => r.errors.map((e) => `error (${r.task}): ${e}`)),
  ];
  return writeResults(
    "pi",
    id,
    startedAt,
    {
      checkout,
      tasks: tasks.map((t) => t.name),
      provider: providerName,
      model,
      thinking,
      budgetMinutes: budgetMs / 60_000,
      keyEnv,
      piBin,
      baseUrl,
      throughProxy,
    },
    summary,
    checks,
    { runs, stderr: stderrs },
    notes,
  );
}

/** The review suite (docs/reference/specs/load-harness.md, the review suite
 *  item): each task is a merged public pull request reviewed at its pinned
 *  head — the checkout fetched and detached there, pi started under the read
 *  identity's allowlist (no `edit`, no `write`) with the registry's review
 *  framing as its system prompt and the verdict tool as its one relay — and
 *  scored as the post-step would score it: a verdict in the house shape
 *  naming the reviewed head, every call vetted, no write tool run, the
 *  checkout untouched. The verdict is recorded in the receipt and posted
 *  nowhere: the driver's `submit_verdict` reaches the driver, never GitHub. */
async function piReviewSuite(f: Flags): Promise<boolean> {
  const id = runId();
  const taskFlag = str(f, "task", "all");
  const tasks =
    taskFlag === "all" ? [...PI_REVIEW_TASKS] : [piReviewTaskByName(taskFlag)].flatMap((t) => (t ? [t] : []));
  if (tasks.length === 0) throw new Error(`--task must be all or one of ${PI_REVIEW_TASK_NAMES.join(", ")}`);
  const setup = piSetup(f, id, 25);
  if (!setup) return false;
  const {
    startedAt,
    providerName,
    keyEnv,
    key,
    checkout,
    model,
    budgetMs,
    piBin,
    thinking,
    baseUrl,
    throughProxy,
    extensionPath,
    agentDir,
    layout,
  } = setup;

  // The repository the tasks belong to is the checkout's, read once: the
  // fixtures pin heads, never a name.
  const repo = await originSlug(checkout);
  const samples: Sample[] = [];
  const rows: ReviewRow[] = [];
  const stderrs: Record<string, string> = {};
  for (const task of tasks) {
    await checkoutPrHead(checkout, task);
    // The framing a resident review run composes, rewritten per task: pi
    // reads SYSTEM.md from its config directory, as the production harness
    // writes it.
    writeSystemPrompt(agentDir, reviewSystemPrompt(task, { repo, checkout }));
    const proc = spawnPi({
      piBin,
      checkout,
      extensionPath,
      provider: providerName,
      model,
      ...(thinking ? { thinking } : {}),
      keyEnvName: piKeyEnvFor(providerName),
      keyValue: key,
      agentDir,
      sessionDir: layout.sessionDir,
      tools: PI_REVIEW_TOOLS,
    });
    const startedTask = systemClock();
    process.stdout.write(
      `pi review ${task.name}: ${reviewTaskUrl(repo, task)} at ${task.head.slice(0, 7)}, budget ${budgetMs / 60_000} min\n`,
    );
    const run = await drivePiTask(proc.transport, {
      task: task.name,
      prompt: reviewPrompt(task, repo),
      budgetMs,
      now: systemClock,
      timers: realTimers,
      // The gate's rules for a read identity: no branch of the run's own, no
      // push at all, no write tool in reach.
      preview: (tool, input) => judgeToolCall(tool, input, { identity: "read", checkout }),
      describe: () => [],
      onEvent: (event) => {
        if (event.type === "tool_execution_start") process.stdout.write(`  ${String(event.toolName)}\n`);
      },
    });
    let exitTimer: NodeJS.Timeout | undefined;
    const exit = await Promise.race([
      proc.exited,
      new Promise<{ code: null; signal: null }>((r) => {
        exitTimer = setTimeout(() => r({ code: null, signal: null }), 5_000);
        exitTimer.unref();
      }),
    ]);
    if (exitTimer) clearTimeout(exitTimer);
    if (exit.code === null && exit.signal === null) proc.kill();
    stderrs[task.name] = redactSecrets(proc.stderr());
    const state = await checkoutState(checkout);
    const outcome = reviewOutcome(run, task);
    const reason = reviewFailureReason(run, outcome);
    samples.push({
      op: "task",
      startedAt: startedTask,
      ms: run.wallMs,
      ok: reason === undefined,
      status: run.terminal,
      ...(reason === undefined ? {} : { reason }),
    });
    rows.push({ task, run: redactPiRun(run), checkout: state });
    process.stdout.write(
      `  → ${run.terminal}, ${run.turns} turns, $${run.cost.total.toFixed(4)}, ${run.toolCalls.length} tool calls, verdict: ${outcome.verdict?.verdict ?? "none"}${outcome.headMatches ? "" : " (head not the reviewed one)"}, checkout ${state.clean && state.head === task.head ? "untouched" : "touched"}\n`,
    );
  }

  const summary = summarize(samples);
  const outcomes = rows.map((r) => ({ ...r, outcome: reviewOutcome(r.run, r.task) }));
  const refusedCalls = rows.flatMap((r) =>
    r.run.toolCalls.filter((c) => c.verdict !== "allowed").map((c) => ({ task: r.task.name, ...c })),
  );
  const rejectedByPi = rows.flatMap((r) =>
    r.run.toolCalls.filter((c) => c.gate === "rejected-by-pi").map((c) => ({ task: r.task.name, ...c })),
  );
  const unmapped = [...new Set(rows.flatMap((r) => r.run.unmapped))];
  const checks: SloCheck[] = [
    ...reviewChecks(rows),
    {
      name: "pi persisted no credential into its config directory",
      pass: authStoreEmpty(`${agentDir}/auth.json`),
      actual: authStoreEmpty(`${agentDir}/auth.json`) ? "auth.json absent or {}" : "auth.json carries entries",
      limit: "absent or {}",
    },
  ];
  const notes = [
    "| task | pull request | terminal | wall | turns | tokens in/out | cost (pi catalog) | tool calls | write calls | verdict | head | checkout |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...outcomes.map(
      (r) =>
        `| ${r.task.name} | [#${r.task.number}](${reviewTaskUrl(repo, r.task)}) | ${r.run.terminal} | ${Math.round(r.run.wallMs / 1000)} s | ${r.run.turns} | ${r.run.usage.input}/${r.run.usage.output} | $${r.run.cost.total.toFixed(4)} | ${r.run.toolCalls.length} | ${r.outcome.writeCalls.length === 0 ? "none" : r.outcome.writeCalls.join(", ")} | ${r.outcome.verdict ? `${r.outcome.verdict.verdict}, ${r.outcome.verdict.findings?.length ?? 0} finding(s)` : `none (${r.outcome.problems.join("; ")})`} | ${r.outcome.headMatches ? "reviewed" : "not the reviewed head"} | ${r.checkout.clean && r.checkout.head === r.task.head ? "untouched" : `${r.checkout.clean ? "" : "dirty "}${r.checkout.head === r.task.head ? "" : `at ${r.checkout.head.slice(0, 7)}`}`.trim()} |`,
    ),
    // The verdict the post-step would have posted, first line only: the
    // receipt says what landed nowhere.
    ...outcomes.flatMap((r) =>
      r.outcome.body
        ? [`${r.task.name} — the body the post-step would post begins: \`${r.outcome.body.split("\n")[0]}\``]
        : [],
    ),
    ...rows.flatMap((r) => {
      const note = earlyExitNote(r.task.name, r.run, stderrs[r.task.name] ?? "");
      return note ? [note] : [];
    }),
    `model: ${rows[0]?.run.model ? `${rows[0].run.model.provider}/${rows[0].run.model.id} thinking ${rows[0].run.model.thinkingLevel}` : "unknown"}; pi's config and session files under ${agentDir} (kept: the sessions are the run's own record); verdicts recorded here and posted nowhere`,
    `tool calls the read identity's rules would refuse or that fall outside its reach: ${refusedCalls.length === 0 ? "none" : ""}`,
    ...refusedCalls.map((c) => `  - ${c.task} ${c.tool} (${c.verdict}): ${c.reason} — \`${c.summary}\``),
    `tool calls pi answered by itself before the hook — nothing ran, so the gate had nothing to vet: ${rejectedByPi.length === 0 ? "none" : ""}`,
    ...rejectedByPi.map((c) => `  - ${c.task} ${c.tool} ${c.callId}: ${c.piRejection} — \`${c.summary}\``),
    `pi event kinds with no home on the run stream: ${unmapped.length === 0 ? "none" : unmapped.join(", ")}`,
    ...rows.flatMap((r) => r.run.errors.map((e) => `error (${r.task.name}): ${e}`)),
  ];
  return writeResults(
    "pi-review",
    id,
    startedAt,
    {
      checkout,
      repo,
      suite: "review",
      tasks: tasks.map((t) => ({ name: t.name, url: reviewTaskUrl(repo, t), head: t.head })),
      provider: providerName,
      model,
      thinking,
      budgetMinutes: budgetMs / 60_000,
      keyEnv,
      piBin,
      baseUrl,
      throughProxy,
    },
    summary,
    checks,
    { runs: outcomes.map((r) => ({ ...r.run, checkout: r.checkout, review: r.outcome })), stderr: stderrs },
    notes,
  );
}

/** `load:route` (docs/reference/specs/load-harness.md item 17): the request
 *  router scored against the requests people already typed. Finished runs are
 *  read newest-first from the run store; a run whose requester chose its
 *  preset (`labelledRequests`) is one labelled example, the directive hidden
 *  from its text; the router — the dispatcher's own `route` over the same
 *  `RouteModel` seam, bound to the provider `--provider`/`--model` name, the
 *  compound form offered as production offers it — is asked what it would
 *  have picked; the receipt is the per-preset confusion table over the stamped
 *  labels, the accuracy against record 0026's bar, its read-only-to-write
 *  clause as a row of its own, the misroutes, and the unstamped labels (a
 *  pre-stamp record cannot tell a typed preset from a scope's) replayed and
 *  reported apart. Then the compound half: the
 *  checked-in set (twenty compounds, five decoys) scored on detection, on
 *  decoys kept single and on part presets against the unit's bar, and the
 *  history's `conductor` requests — few — on detection, their count printed.
 *  Then the imperative half: the checked-in set of terse imperatives (twenty,
 *  five read-only decoys, five review-shaped) scored on reaching coding and on
 *  no look-alike reaching a write preset. Live model spend: one small call per
 *  request, the key from the environment. */
async function routeReplay(f: Flags): Promise<boolean> {
  const id = runId();
  const startedAt = new Date(systemClock()).toISOString();
  const providerName = str(f, "provider", "anthropic");
  const keyEnv = str(f, "key-env", piKeyEnvFor(providerName));
  if (!processSecrets.named(keyEnv)) {
    process.stderr.write(
      `load route: the model key must be in the environment variable ${keyEnv} (name another with --key-env); refusing to start\n`,
    );
    return false;
  }
  const modelId = str(f, "model");
  const baseUrl = typeof f["base-url"] === "string" ? f["base-url"] : undefined;
  const providers = new ProviderRegistry({
    [providerName]: {
      type: providerName === "anthropic" ? "anthropic" : "openai-compatible",
      apiKeyEnv: keyEnv,
      ...(baseUrl ? { baseUrl } : {}),
    },
  });
  const model = providerRouteModel(providers.get(providerName), modelId);
  const modelRef = `${providerName}/${modelId}`;
  const base = str(f, "state-url", process.env.SWITCHBOARD_STATE_WORKER_URL).replace(/\/$/, "");
  const store = new WorkerRunStore({
    baseUrl: base,
    token: bearer(str(f, "token-env", "MEMORY_TOKEN")),
    storeKey: "runs:default",
  });
  const since = typeof f.since === "string" ? Date.parse(f.since) : undefined;
  if (since !== undefined && Number.isNaN(since)) throw new Error(`--since must be a date (got ${String(f.since)})`);
  const limit = num(f, "limit", 200);
  const defaultPreset = str(f, "default-agent", "general");
  const concurrency = num(f, "concurrency", 4);
  const maxParts = num(f, "max-parts", DEFAULT_MAX_CHILDREN);

  // Newest first, one record at a time, until `limit` labelled requests or
  // the store runs out: a record is a few KB, and most rows are labelled.
  const items = await pageAll(
    async (cursor) => store.list({ limit: 200, ...(since !== undefined ? { sinceMs: since } : {}), ...(cursor ?? {}) }),
    { pageSize: 200, maxPages: 50 },
  );
  const rows = realRuns(items);
  let scanned = 0;
  const skipped: Record<string, number> = {};
  const requests = [];
  for (const row of rows) {
    if (requests.length >= limit) break;
    const record = await store.get(row.id);
    scanned++;
    if (!record) continue;
    const labelled = labelledRequests([record], { defaultPreset });
    for (const [reason, n] of Object.entries(labelled.skipped)) if (n > 0) skipped[reason] = (skipped[reason] ?? 0) + n;
    requests.push(...labelled.requests);
  }
  // The singles: every labelled request but a `conductor` one — those are the
  // history's compound examples below, since the conductor is never a single
  // route. The stamped labels (directive, sticky) make the table and the bar;
  // an unstamped one — a pre-stamp record, whose preset may be a scope's —
  // is replayed and reported apart, so it never inflates the accuracy.
  const singles = requests.filter((r) => r.label !== COMPOUND_PRESET);
  const stamped = singles.filter((r) => r.labelSource !== "unstamped");
  const unstamped = singles.filter((r) => r.labelSource === "unstamped");
  const fromHistory = historyCompounds(requests);
  process.stdout.write(
    `route: ${stamped.length} stamped + ${unstamped.length} unstamped labelled request(s) and ${fromHistory.length} conductor request(s) from ${scanned} record(s) scanned; model ${modelRef}\n`,
  );

  // One decision function for both halves: the production prompt, the compound
  // form offered under the cap — so a single that the router splits is a
  // misroute in the table, and a decoy split is counted where it belongs.
  const presets = routablePresets();
  const allowed = presets.map((p) => p.name);
  const decide = (text: string) =>
    route({ text, recentDirectives: {}, presets, allowed, fallback: defaultPreset, compound: { maxParts } }, model, {
      timeoutMs: ROUTE_TIMEOUT_MS,
    });
  const results = await replayRoutes(stamped, decide, { concurrency, now: systemClock });
  const table = confusionTable(results, allowed);
  const unstampedResults = await replayRoutes(unstamped, decide, { concurrency, now: systemClock });
  const unstampedAgreed = unstampedResults.filter((r) => r.correct).length;
  const fixtureResults = await replayCompound(compoundExamples(ROUTE_COMPOUND_FIXTURES), decide, {
    concurrency,
    now: systemClock,
  });
  const fixtures = compoundScore(fixtureResults);
  const historyResults = await replayCompound(fromHistory, decide, { concurrency, now: systemClock });
  const history = compoundScore(historyResults);
  const imperativeResults = await replayImperative(ROUTE_IMPERATIVE_FIXTURES, decide, {
    concurrency,
    now: systemClock,
  });
  const imperative = imperativeScore(imperativeResults);
  const samples: Sample[] = [
    ...[...results, ...unstampedResults].map((r): Sample => ({
      op: "route",
      startedAt: systemClock(),
      ms: r.ms,
      ok: r.routed !== undefined,
      status: r.routed ?? "none",
      ...(r.routed === undefined ? { reason: "no-route" } : {}),
    })),
    ...[...fixtureResults, ...historyResults].map((r): Sample => ({
      op: "route-compound",
      startedAt: systemClock(),
      ms: r.ms,
      ok: r.routed !== undefined,
      status: r.detected ? "compound" : (r.routed ?? "none"),
      ...(r.routed === undefined ? { reason: "no-route" } : {}),
    })),
    ...imperativeResults.map((r): Sample => ({
      op: "route-imperative",
      startedAt: systemClock(),
      ms: r.ms,
      ok: r.routed !== undefined,
      status: r.routed ?? "none",
      ...(r.routed === undefined ? { reason: "no-route" } : {}),
    })),
  ];
  const summary = summarize(samples);
  const answered = results.filter((r) => r.routed !== undefined).length;
  const readToWrite = readToWriteRoutes(results);
  const checks: SloCheck[] = routeChecks({
    table,
    answered,
    readToWrite: readToWrite.length,
    compound: fixtures,
    compoundBar: { detection: 0.9 },
    imperative,
    imperativeBar: { hit: 0.9 },
  });
  const bySource: Record<string, number> = {};
  for (const r of requests) bySource[r.labelSource] = (bySource[r.labelSource] ?? 0) + 1;
  const notes = [
    ...renderConfusion(table),
    "",
    readToWrite.length === 0
      ? "read-only labels routed to a write preset: none"
      : `read-only labels routed to a write preset (${readToWrite.length}): ${readToWrite.map((r) => `${r.id} (${r.label} → ${r.routed})`).join(", ")}`,
    "",
    unstamped.length === 0
      ? `unstamped labels: none (every labelled record carries run_meta.agentSource)`
      : `unstamped labels (a record from before the agentSource stamp, on a preset other than ${defaultPreset} — typed, sticky or a channel/user scope's agent; the record cannot say): ${unstamped.length}, router agreed ${unstampedAgreed} (${pct(unstampedAgreed / unstamped.length)}) — excluded from the table and the bar`,
    "",
    `checked-in compound set (${fixtures.compounds} compounds, ${fixtures.decoys} decoys; cap ${maxParts} parts):`,
    ...renderCompound(fixtures),
    "",
    history.compounds === 0
      ? "history: no conductor request in the window — the checked-in set is the whole compound score"
      : `history: ${history.compounds} conductor request(s), ${history.detected} detected as compound (parts unknown on the record, so detection alone)`,
    ...(history.compounds === 0 ? [] : renderCompound(history).slice(2)),
    "",
    `checked-in imperative set (${imperative.imperatives} imperatives, ${imperative.decoys} read-only decoys, ${imperative.reviews} review-shaped):`,
    ...renderImperative(imperative),
    "",
    `labels: ${Object.entries(bySource)
      .map(([k, v]) => `${k}=${v}`)
      .join(
        " ",
      )} (directive/sticky: the record's run_meta.agentSource — the table and the bar; unstamped: a record from before the stamp — reported above, apart)`,
    `records skipped: ${
      Object.entries(skipped)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ") || "none"
    }`,
    "the thread's earlier directives are not on a record, so every request replays with none; the allowlist is every routable preset and the compound form is offered, as production offers it to a requester who may run the conductor",
  ];
  const redacted = <T extends { text: string; reason: string }>(r: T): T => ({
    ...r,
    text: redactSecrets(r.text),
    reason: redactSecrets(r.reason),
  });
  return writeResults(
    "route",
    id,
    startedAt,
    { stateUrl: base, model: modelRef, since: f.since, limit, defaultPreset, concurrency, maxParts, keyEnv },
    summary,
    checks,
    {
      table,
      results: results.map(redacted),
      readToWrite: readToWrite.map(redacted),
      unstamped: { count: unstamped.length, agreed: unstampedAgreed, results: unstampedResults.map(redacted) },
      compound: {
        fixtures: { ...fixtures, misses: fixtures.misses.map(redacted), results: fixtureResults.map(redacted) },
        history: { ...history, misses: history.misses.map(redacted), results: historyResults.map(redacted) },
      },
      imperative: { ...imperative, misses: imperative.misses.map(redacted), results: imperativeResults.map(redacted) },
      skipped,
    },
    notes,
  );
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (!command || f.help) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const commands: Record<string, (f: Flags) => Promise<boolean>> = {
    history,
    resident,
    sandbox,
    e2e,
    cards,
    provider,
    pi,
    route: routeReplay,
  };
  const run = commands[command];
  if (!run) {
    process.stderr.write(`unknown command ${command}\n${USAGE}`);
    return 2;
  }
  return (await run(f)) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`load: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
