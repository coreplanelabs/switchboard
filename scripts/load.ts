// The load harness entrypoint (docs/reference/specs/load-harness.md).
//
//   npm run load -- history                       peak concurrency from the run store
//   npm run load -- resident --resource repo:owner/name --threads 16 --hold 600
//   npm run load -- sandbox  -- --threads 8 --hold 300
//   npm run load -- e2e      -- --ingress-url http://127.0.0.1:8080/ingress --text "agent:coding in owner/name: load" --threads 50
//   npm run load -- cards    -- --cards 50 --hold 600 --channels 5
//   npm run load -- provider --port 8089 --profile coding --cpu-seconds 60
//
// Every command writes `load-results/<command>-<runId>.json` (the samples and
// the summary) and `.md` (the receipt) and exits non-zero when a configured
// check fails. Targets and bearers come from flags or the environment named in
// `--help`; nothing here is hard-coded to one deployment.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  evaluateSlo,
  renderMarkdown,
  summarize,
  type SloCheck,
  type SloSpec,
  type Summary,
} from "../src/load/aggregate.js";
import { simulateCards } from "../src/load/cardsLoad.js";
import { runE2eLoad } from "../src/load/e2eLoad.js";
import { durationStats, pageAll, peakConcurrency, realRuns } from "../src/load/history.js";
import { runResidentLoad, type ResidentThreadClient } from "../src/load/residentLoad.js";
import { runSandboxLoad } from "../src/load/sandboxLoad.js";
import { codingProfileScript, reviewProfileScript, startScriptedProvider } from "../src/load/scriptedProvider.js";
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
  provider   serve the scripted model for a local bot (blocks)
             --port N  --profile review|coding  --cpu-seconds S  --terminal
`;

type Flags = Record<string, string | boolean | undefined>;

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
  const script = profile === "review" ? reviewProfileScript(opts) : codingProfileScript(opts);
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

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (!command || f.help) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const commands: Record<string, (f: Flags) => Promise<boolean>> = { history, resident, sandbox, e2e, cards, provider };
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
