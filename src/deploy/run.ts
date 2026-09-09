import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { startProcessRoot } from "../core/requestTrace.js";
import { systemClock } from "../core/trace/clock.js";
import { createLogSink } from "../core/trace/sinks.js";
import type { Span } from "../core/trace/types.js";
import { computeAffected, formatAffectedText, type AffectedProbe, type AffectedReport } from "./affected.js";
import {
  servedStartedAt,
  decideLive,
  decideRestarted,
  heartbeatLine,
  LIVE_GATE_DEADLINE_MS,
  LIVE_GATE_POLL_MS,
  parseHealthz,
  type HealthzBody,
} from "./liveGate.js";
import {
  capabilityProblem,
  classifyDeployOutput,
  decideAccount,
  lastErrorLines,
  UNSET_ENV,
  WORKER_DIRS,
  workersFor,
  type DeployHost,
  type DeployPlan,
  type DeployStep,
  type SandboxLiveGate,
  type TokenVerifyResult,
  type WorkerDef,
  type WorkerName,
} from "./plan.js";
import { parseAppConfigText } from "../config.js";
import { baseConfigDocument, ConfigDocumentClient, STATE_WORKER_TOKEN_ENV } from "../configDocument.js";
import { OPERATOR_ROOT } from "./host.js";
import { assetPath, installationPath, workPath } from "./operatorRoot.js";
import { RENDERED_FILE } from "./wranglerTemplate.js";
import { parseConfigSource, readConfigSource, type ConfigSourceIO } from "./configSource.js";
import {
  isExampleProfile,
  parseProfile,
  PROFILE_ENV,
  PROFILE_EXAMPLE_PATH,
  PROFILE_PATH,
  type LoadedProfile,
} from "./profile.js";
import { classifyRestartResponse, type RestartPlan } from "./restart.js";
import { renderWorkerConfigs } from "./wranglerTemplate.js";
import {
  containerAppId,
  decideSandboxLive,
  decideWorker,
  parseAppState,
  parseExecStream,
  parseInstancesPage,
  parseWranglerJson,
  PROBE_COMMAND,
  PROBE_TIMEOUT_MS,
  probeThreadKey,
  rolloutTargetFromDeployOutput,
  shortImage,
  type AppState,
  type ContainerInstance,
  type HealthRead,
  type ProbeResult,
  type Read,
  type RolloutTarget,
} from "./sandboxLiveGate.js";

// The production deploy RUNNER behind the registry's `deploy all` (CLI only):
// runs the four Workers' `npm run deploy` in the plan's canonical order
// (src/deploy/plan.ts), after checking the wrangler account, a clean checkout
// at origin/main, required env, and node_modules per dir. Every path is
// resolved through the operator root (src/deploy/operatorRoot.ts): in a
// checkout that is the repository root, exactly as before. A step whose
// preflight refuses (runs in flight) is waited out and retried — never forced
// unless the plan says so — and the wait is never silent: every poll prints a
// heartbeat with the in-flight count. The bot step is done only when it is
// LIVE, not merely deployed: after `wrangler deploy` the old container keeps
// answering while it drains (up to 15 min), so the runner polls `/healthz`
// until a non-draining container reports the deployed commit as its
// `build.commit` (docs/decisions/0015-deploy-order-deployed-is-not-live.md:
// trusting the upload says `deployed`, exit 0, while the old container is
// still draining runs). The sandbox step is likewise done only when its
// Worker, its container rollout and an `echo ok` probe agree (a thread placed
// during the image rollout lands on the previous image and every exec fails
// with an empty error). Only this file
// touches processes; the plan and the live decisions are pure and unit-tested,
// and the command (src/core/commands/deploy.ts) maps this result onto the
// registry's error vocabulary.

export interface RunResult {
  code: number;
  output: string;
}

export interface DeployStepResult {
  name: string;
  script: string;
  versionId?: string;
  /** `live` (gated and confirmed), `n/a` (no gate), `not deployed`, or `deployed, not live: <reason>`. */
  live: string;
  status: string;
}

export type DeployRunResult =
  /** A pre-check refused: nothing was deployed. */
  | { kind: "refused"; problems: string[] }
  /** Steps ran (in order) until one failed or all deployed (and went live). */
  | { kind: "ran"; ok: boolean; results: DeployStepResult[]; notAttempted: string[] };

export interface DeployRunnerIO {
  log(line: string): void;
  warn(line: string): void;
  /** A child's streamed output (already newline-terminated chunks). */
  stream(chunk: string): void;
}

/** Spawn a command, stream its output, and collect it. `unset` removes env
 *  vars for the child (the `env -u` of the README commands). */
function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; unset?: readonly string[]; set?: Record<string, string>; stream?: (chunk: string) => void },
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.set ?? {}) };
  for (const k of opts.unset ?? []) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      opts.stream?.(text);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => resolve({ code: 127, output: output + `\n${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Cloudflare's per-account token verify — the only way an ACCOUNT-owned token
 *  (no `/user`, so `wrangler whoami` lists nothing) proves which account it is
 *  for. Never throws: a network failure is "not verified", and refused. */
async function verifyTokenAgainstAccount(account: string, token: string): Promise<TokenVerifyResult | undefined> {
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return undefined;
  }
}

/** A Worker directory as wrangler runs in it: under the tree in a checkout, under the work area from the package. */
const workerDir = (dir: string) => workPath(OPERATOR_ROOT, dir);

async function preChecks(plan: DeployPlan, io: DeployRunnerIO): Promise<string[]> {
  const problems: string[] = [];
  // `whoami` needs a wrangler to run: the first step's directory has one (in a checkout every
  // directory resolves the root's; from the package each step's was just installed).
  const who = await run("npx", ["wrangler", "whoami"], {
    cwd: workerDir(plan.steps[0]?.dir ?? WORKER_DIRS.bot),
    unset: UNSET_ENV,
  });
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = decideAccount({
    account: plan.checks.account,
    whoamiOutput: who.output,
    whoamiExit: who.code,
    tokenSet: !!token,
    ...(token && !who.output.includes(plan.checks.account)
      ? { tokenVerify: await verifyTokenAgainstAccount(plan.checks.account, token) }
      : {}),
  });
  if (account.ok) io.log(`[deploy:all] account: ${account.how}`);
  else problems.push(account.problem);
  // Capabilities BEFORE any Worker deploys: the same command each is about to
  // need, run read-only in its dir. One check per distinct command.
  const checked = new Map<string, Promise<RunResult>>();
  for (const step of plan.steps) {
    for (const check of step.capabilities) {
      const key = check.command.join(" ");
      let r = checked.get(key);
      if (!r) checked.set(key, (r = run("npx", [...check.command], { cwd: workerDir(step.dir), unset: UNSET_ENV })));
      const result = await r;
      const problem = capabilityProblem(step.name, check, result.code, result.output);
      if (problem) problems.push(problem);
      else io.log(`[deploy:all] ${step.name}: credential can \`${key}\` (${check.needs})`);
    }
  }
  if (plan.checks.cleanTree) {
    const status = await run("git", ["status", "--porcelain"], { cwd: OPERATOR_ROOT.root });
    if (status.output.trim() !== "")
      problems.push(
        "working tree is not clean — commit, stash, or deploy from a fresh checkout (wrangler builds the CURRENT tree)",
      );
  }
  if (plan.checks.atOriginMain) {
    // A failed fetch would let the check pass against a stale origin/main — treat it as a problem, not a warning.
    const fetch = await run("git", ["fetch", "-q", "origin"], { cwd: OPERATOR_ROOT.root });
    if (fetch.code !== 0)
      problems.push(
        `git fetch origin failed (exit ${fetch.code}): ${fetch.output.trim().split("\n").pop() ?? ""} — cannot verify HEAD == origin/main`,
      );
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: OPERATOR_ROOT.root })).output.trim();
    const main = (await run("git", ["rev-parse", "origin/main"], { cwd: OPERATOR_ROOT.root })).output.trim();
    if (head !== main)
      problems.push(
        `HEAD ${head.slice(0, 7)} != origin/main ${main.slice(0, 7)} — \`git checkout --detach origin/main\`, or pass --allow-branch deliberately`,
      );
  }
  for (const s of plan.steps) {
    for (const req of s.requiredEnv) {
      if (!req.anyOf.some((v) => process.env[v]))
        problems.push(`${s.name}: none of ${req.anyOf.join(" / ")} is set in the environment`);
    }
  }
  return problems;
}

/** The plan's `DeployHost.hasNodeModules`: `<root>/<dir>/node_modules` exists. */
export function hasNodeModules(dir: string): boolean {
  return existsSync(join(OPERATOR_ROOT.root, dir, "node_modules"));
}

/** What the plan is computed over on this host: the root and mode this process runs from (`plan.root`)
 *  and the install probe (src/deploy/plan.ts `DeployHost`). */
export function deployHostOnHost(): DeployHost {
  return { root: { mode: OPERATOR_ROOT.mode, path: OPERATOR_ROOT.root }, hasNodeModules };
}

/** Parse + validate profile JSON read from `where` (a path or a source reference — what errors name). */
function profileFromJson(text: string, where: string, origin: LoadedProfile["origin"]): LoadedProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${where}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const parsed = parseProfile(raw);
  if (!parsed.ok) throw new Error(`${where}: invalid deployment profile —\n  - ${parsed.problems.join("\n  - ")}`);
  // The example is the example wherever it was read from — a copy of it
  // pointed at by the env var, too — so the runner's refusal holds.
  return { profile: parsed.profile, origin: isExampleProfile(parsed.profile) ? "example" : origin, path: where };
}

/**
 * The deployment profile on this host: `$SWITCHBOARD_DEPLOY_PROFILE` — a path,
 * or the same `github://owner/repo/path@ref` / `op://Vault/Item/field` forms
 * `configSource` takes, read through the same loaders (a production profile
 * kept in an infrastructure repository is named this way by the release
 * workflow) — else `deploy/profile.json` (an installation's own, gitignored),
 * else the checked-in example — which a plan may be read from (a pull request's
 * CI, a fresh clone) and `deploy all` refuses. An unreadable or invalid profile
 * is an error naming the file or reference and each problem; never a silent
 * fall-through to the example.
 */
export async function loadProfileOnHost(
  env: Record<string, string | undefined> = process.env,
  sourceIO: ConfigSourceIO = hostConfigSourceIO(),
): Promise<LoadedProfile> {
  const override = env[PROFILE_ENV];
  if (override) {
    const source = parseConfigSource(override);
    if (source.ok && source.source.kind !== "path") {
      const read = await readConfigSource(source.source, sourceIO);
      if (!read.ok) throw new Error(`${PROFILE_ENV}=${override}: ${read.problem}`);
      return profileFromJson(read.text, override, "profile");
    }
  }
  // The installation's own profile (or the path the env var names) is under the root — the checkout,
  // or the operator's directory; the example is a shipped file.
  const candidates: { path: string; origin: LoadedProfile["origin"]; abs: string }[] = override
    ? [
        {
          path: override,
          origin: "profile",
          abs: isAbsolute(override) ? override : installationPath(OPERATOR_ROOT, override),
        },
      ]
    : [
        { path: PROFILE_PATH, origin: "profile", abs: installationPath(OPERATOR_ROOT, PROFILE_PATH) },
        { path: PROFILE_EXAMPLE_PATH, origin: "example", abs: assetPath(OPERATOR_ROOT, PROFILE_EXAMPLE_PATH) },
      ];
  for (const c of candidates) {
    const abs = c.abs;
    if (!existsSync(abs)) {
      if (c.origin === "profile" && override) throw new Error(`${PROFILE_ENV}=${override}: no such file`);
      continue;
    }
    return profileFromJson(readFileSync(abs, "utf8"), c.path, c.origin);
  }
  throw new Error(`no deployment profile: write ${PROFILE_PATH} (see ${PROFILE_EXAMPLE_PATH}) or set ${PROFILE_ENV}`);
}

/**
 * Render every Worker's `wrangler.jsonc` from its template and the profile in
 * force (src/deploy/wranglerTemplate.ts). The rendered files are generated and
 * gitignored, so this dirties nothing; `deploy all` does it before anything
 * reads a Worker's config — the capability pre-checks and wrangler itself pick
 * the account from these files. Returns the problems, if any.
 */
export async function renderWorkerConfigsOnHost(
  io: Pick<DeployRunnerIO, "log">,
  env: Record<string, string | undefined> = process.env,
  writeFile: (path: string, text: string) => void | Promise<void> = (path, text) => hostDeployFiles.write(path, text),
): Promise<string[]> {
  const loaded = await loadProfileOnHost(env);
  const rendered = renderWorkerConfigs(loaded.profile, (path) => readShipped(path));
  if (!rendered.ok) return rendered.problems;
  for (const f of rendered.files) await writeFile(f.path, f.text);
  io.log(`[deploy:all] rendered ${rendered.files.length} Worker config(s) from ${loaded.path}`);
  return [];
}

/** A shipped file by its tree path (a template, the manifest, `project.json`); undefined when absent. */
function readShipped(path: string): string | undefined {
  const abs = assetPath(OPERATOR_ROOT, path);
  return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
}

/** `deploy init`'s file access on this host, by tree path: a rendered `wrangler.jsonc` lives in the
 *  Worker's directory under the work area (materialised first from the package — the copy alone, no
 *  install), everything else — the templates, `project.json` — is a shipped file. In a checkout the
 *  two are one tree (src/deploy/operatorRoot.ts). */
export const hostDeployFiles = {
  read: async (path: string): Promise<string | undefined> => {
    if (!path.endsWith(`/${RENDERED_FILE}`)) return readShipped(path);
    const abs = workPath(OPERATOR_ROOT, path);
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  },
  write: async (path: string, text: string): Promise<void> => {
    const abs = workPath(OPERATOR_ROOT, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  },
};

/** The config-source loaders' I/O on this host: files under the root (the checkout, or the operator's directory), real fetch, the `op` CLI. */
function hostConfigSourceIO(): ConfigSourceIO {
  return {
    readFile: async (path) => {
      const abs = isAbsolute(path) ? path : installationPath(OPERATOR_ROOT, path);
      return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    },
    fetch: async (url, init) => {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      return { status: res.status, text: () => res.text() };
    },
    opRead: async (ref) => {
      const r = await run("op", ["read", ref], { cwd: OPERATOR_ROOT.root });
      return r.code === 127 ? undefined : r;
    },
    env: process.env,
  };
}

/** A config read from a `configSource` and validated — what `deploy all` and `deploy config` push. */
export type ConfigRead = { ok: true; text: string; how: string } | { ok: false; problem: string };

/**
 * Read the bot's config from a `configSource` and validate it. `deploy all`
 * does this BEFORE any Worker deploys: a source that cannot be read or a
 * config that does not validate is a refusal up front, never something the
 * bot discovers at startup after the memory Worker has already rolled.
 */
export async function readConfigForPush(
  source: string,
  sourceIO: ConfigSourceIO = hostConfigSourceIO(),
): Promise<ConfigRead> {
  const parsed = parseConfigSource(source);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  const read = await readConfigSource(parsed.source, sourceIO);
  if (!read.ok) return { ok: false, problem: read.problem };
  try {
    parseAppConfigText(read.text);
  } catch (err) {
    return {
      ok: false,
      problem: `configSource ${source}: the config does not validate — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, text: read.text, how: read.how };
}

export type ConfigPushOutcome =
  { ok: true; how: string; version: number; sha256: string; bytes: number } | { ok: false; problem: string };

/** What the runner needs to push: the plan's state Worker, the document key, the bearer's env. */
export interface ConfigPushTarget {
  stateWorkerUrl: string;
  key: string;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Push a validated config as the `base` document on the state Worker (src/configDocument.ts); the
 *  bearer is `MEMORY_TOKEN`, named when missing. The bot picks the document up on its next start. */
export async function pushConfigDocument(
  read: Extract<ConfigRead, { ok: true }>,
  target: ConfigPushTarget,
): Promise<ConfigPushOutcome> {
  const token = target.env[STATE_WORKER_TOKEN_ENV];
  if (!token)
    return {
      ok: false,
      problem: `${STATE_WORKER_TOKEN_ENV} is not set — the config is pushed to ${target.stateWorkerUrl} with the state Worker's bearer`,
    };
  const client = new ConfigDocumentClient({
    baseUrl: target.stateWorkerUrl,
    token,
    ...(target.fetch ? { fetch: target.fetch } : {}),
  });
  const document = baseConfigDocument(
    read.text,
    read.how.replace(/^config from /, ""),
    (target.now ?? (() => new Date(systemClock())))(),
  );
  const pushed = await client.pushBase(document, target.key);
  if (!pushed.ok) return pushed;
  return {
    ok: true,
    how: read.how,
    version: pushed.version,
    sha256: document.sha256,
    bytes: Buffer.byteLength(read.text),
  };
}

/** `deploy config` on this host: read the source, validate, push. */
export async function pushConfigOnHost(opts: {
  source: string;
  stateWorkerUrl: string;
  key: string;
}): Promise<ConfigPushOutcome> {
  const read = await readConfigForPush(opts.source);
  if (!read.ok) return read;
  return pushConfigDocument(read, { stateWorkerUrl: opts.stateWorkerUrl, key: opts.key, env: process.env });
}

async function ensureNodeModules(step: DeployStep, io: DeployRunnerIO): Promise<boolean> {
  const dir = workerDir(step.dir);
  if (hasNodeModules(step.dir)) return true;
  io.log(`[deploy:all] ${step.name}: node_modules missing — npm ci`);
  const r = await run("npm", ["ci", "--silent"], { cwd: dir });
  if (r.code !== 0) io.warn(r.output);
  return r.code === 0;
}

/** One GET of the Worker's `/healthz` after its deploy, so it (and its Durable Objects) are awake
 *  before the next step needs them. Informational: the deploy is done either way. */
async function wake(name: string, url: string, io: DeployRunnerIO): Promise<void> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    io.log(`[deploy:all] ${name}: awake — GET ${url} → HTTP ${res.status}`);
  } catch (err) {
    io.warn(`[deploy:all] ${name}: wake GET ${url} failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** GET a `/healthz`, with a bearer when the Worker sits behind one (the sandbox):
 *  the status and the parsed body, or why the request failed. Never throws. */
async function readHealthz(url: string, bearer?: string): Promise<HealthRead> {
  try {
    const res = await fetch(url, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, body: parseHealthz(await res.text()) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The body of an unauthenticated `/healthz`; undefined when unreachable or not JSON. */
async function fetchHealthz(url: string): Promise<HealthzBody | undefined> {
  const r = await readHealthz(url);
  return "body" in r ? r.body : undefined;
}

export interface StepOutcome {
  ok: boolean;
  versionId?: string;
  live: string;
  reason?: string;
}

/**
 * After a gated step's deploy: poll `/healthz` until the NEW container answers
 * (not draining, `build.commit` == `expectedCommit`), logging every poll so the
 * drain is visible. Returns the live commit, or the reason it never went live
 * within the drain deadline (+ cold-start margin).
 */
async function waitUntilLive(
  step: DeployStep,
  healthUrl: string,
  expectedCommit: string,
  io: DeployRunnerIO,
  clock: () => number,
  /** The container's `startedAt` read before the upload: what a draining
   *  same-commit container must be later than to count as the new one. */
  previousStartedAt: string | undefined,
): Promise<GateOutcome> {
  const started = clock();
  for (;;) {
    const elapsed = clock() - started;
    const body = await fetchHealthz(healthUrl);
    const d = decideLive(body, expectedCommit, elapsed, LIVE_GATE_DEADLINE_MS, {
      ...(previousStartedAt !== undefined ? { previousStartedAt } : {}),
    });
    if (d.kind === "live") return { live: true, detail: `commit ${d.commit.slice(0, 7)}`, waitedMs: elapsed };
    if (d.kind === "timeout")
      return {
        live: false,
        reason: `${d.reason} — gave up after ${Math.round(elapsed / 60_000)} min (drain deadline ${LIVE_GATE_DEADLINE_MS / 60_000} min)`,
      };
    io.log(
      `[deploy:all] ${step.name}: deployed, not live yet — ${d.reason} (${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1000)}s)`,
    );
    await sleep(LIVE_GATE_POLL_MS);
  }
}

/** What a live gate ends with: the facts that proved it, or the reason it never held. */
type GateOutcome = { live: true; detail: string; waitedMs: number } | { live: false; reason: string };

// ---- the sandbox live gate (src/deploy/sandboxLiveGate.ts is the pure half) -----------------------

/** The sandbox gate's I/O, injectable so the loop is unit-tested without a network, wrangler or a clock. */
export interface SandboxGateDeps {
  env: Record<string, string | undefined>;
  readHealth(url: string, bearer: string): Promise<HealthRead>;
  /** `wrangler containers info <app> --json` → the application's version and image, run in `dir`. */
  readAppState(dir: string, containerApp: string): Promise<Read<AppState>>;
  /** `wrangler containers instances <app> --json`, every page, run in `dir`. */
  readInstances(dir: string, containerApp: string): Promise<Read<ContainerInstance[]>>;
  /** `POST /exec` `echo ok` on the probe thread; the streamed body parsed. */
  probeExec(execUrl: string, bearer: string, threadKey: string): Promise<ProbeResult>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** One read-only wrangler command in a Worker's dir, its `--json` payload parsed;
 *  `CLOUDFLARE_ACCOUNT_ID` stripped like every other wrangler call here. */
async function wranglerJson(dir: string, args: string[]): Promise<Read<unknown>> {
  const r = await run("npx", ["wrangler", ...args], { cwd: workerDir(dir), unset: UNSET_ENV });
  if (r.code !== 0)
    return { error: `wrangler ${args.join(" ")} failed: ${lastErrorLines(r.output) || `exit ${r.code}, no output`}` };
  const parsed = parseWranglerJson(r.output);
  return parsed === undefined ? { error: `wrangler ${args.join(" ")}: no JSON in the output` } : { value: parsed };
}

/** The application id behind a Containers application name — stable, so a
 *  success is remembered for the process; a failure is retried next poll. */
const containerAppIds = new Map<string, string>();
async function resolveContainerAppId(dir: string, containerApp: string): Promise<Read<string>> {
  const known = containerAppIds.get(containerApp);
  if (known) return { value: known };
  const listing = await wranglerJson(dir, ["containers", "list", "--json"]);
  if ("error" in listing) return listing;
  const id = containerAppId(listing.value, containerApp);
  if (!id)
    return {
      error: `container application ${containerApp} not in \`wrangler containers list\` (wrong account, or renamed class?)`,
    };
  containerAppIds.set(containerApp, id);
  return { value: id };
}

/** `--per-page` above the fleet's `max_instances` (25); wrangler answers one page per call. */
const INSTANCES_PER_PAGE = 100;

export const defaultSandboxGateDeps: SandboxGateDeps = {
  env: process.env,
  readHealth: (url, bearer) => readHealthz(url, bearer),
  readAppState: async (dir, containerApp) => {
    const id = await resolveContainerAppId(dir, containerApp);
    if ("error" in id) return id;
    const info = await wranglerJson(dir, ["containers", "info", id.value, "--json"]);
    if ("error" in info) return info;
    const state = parseAppState(info.value);
    return state === null
      ? { error: `wrangler containers info ${id.value}: no numeric version in the output` }
      : { value: state };
  },
  readInstances: async (dir, containerApp) => {
    const id = await resolveContainerAppId(dir, containerApp);
    if ("error" in id) return id;
    const rows: ContainerInstance[] = [];
    let pageToken: string | null = null;
    do {
      const args = ["containers", "instances", id.value, "--json", "--per-page", String(INSTANCES_PER_PAGE)];
      if (pageToken) args.push("--page-token", pageToken);
      const page = await wranglerJson(dir, args);
      if ("error" in page) return page;
      const parsed = parseInstancesPage(page.value);
      if (!parsed) return { error: `wrangler containers instances ${id.value}: unexpected JSON shape` };
      rows.push(...parsed.rows);
      pageToken = parsed.nextPageToken;
    } while (pageToken);
    return { value: rows };
  },
  probeExec: async (execUrl, bearer, threadKey) => {
    try {
      const res = await fetch(execUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "x-thread-key": threadKey, "content-type": "application/json" },
        body: JSON.stringify({ command: PROBE_COMMAND, timeoutMs: PROBE_TIMEOUT_MS }),
        // The command's own budget plus a cold container start; the body streams heartbeats meanwhile.
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS + 60_000),
      });
      const text = await res.text();
      if (!res.ok) return { error: `POST /exec → HTTP ${res.status}: ${text.trim().slice(0, 200)}` };
      return parseExecStream(text);
    } catch (err) {
      return { error: `POST /exec failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
  now: Date.now,
  sleep,
};

/** What the sandbox gate knows about the rollout it waits for: the application as read BEFORE
 *  the upload, and the target wrangler's deploy output named (`null`: no container change printed). */
export interface SandboxRollout {
  before: Read<AppState>;
  target: RolloutTarget | null;
}

/**
 * After the sandbox deploy: poll until the Worker serves the deployed commit,
 * the container application has left its pre-deploy version (when wrangler
 * printed a container change), every running instance is on the application's
 * version, and an `echo ok` through the gate's probe thread answers from an
 * instance on that version — logging every poll's first unmet signal. The
 * rollout and the probe are read only once the Worker is live (they mean
 * nothing before), and the probe is sent BEFORE the instance list is read so
 * the list includes the probe's own instance. One thread key per deployed
 * commit: the probe holds one fleet slot for the 5-min idle window, not one
 * per poll.
 */
export async function waitUntilSandboxLive(
  step: Pick<DeployStep, "name" | "dir">,
  gate: SandboxLiveGate,
  expectedCommit: string,
  rollout: SandboxRollout,
  io: Pick<DeployRunnerIO, "log">,
  deps: SandboxGateDeps = defaultSandboxGateDeps,
): Promise<GateOutcome> {
  const bearer = deps.env[gate.bearerEnv];
  if (!bearer)
    return {
      live: false,
      reason: `${gate.bearerEnv} is not set — the sandbox live gate reads /healthz and probes /exec with it`,
    };
  const threadKey = probeThreadKey(expectedCommit);
  const execUrl = new URL("/exec", gate.healthUrl).toString();
  const started = deps.now();
  for (;;) {
    const elapsed = deps.now() - started;
    const health = await deps.readHealth(gate.healthUrl, bearer);
    const rest = decideWorker(health, expectedCommit).ok
      ? {
          probe: await deps.probeExec(execUrl, bearer, threadKey),
          app: await deps.readAppState(step.dir, gate.containerApp),
          instances: await deps.readInstances(step.dir, gate.containerApp),
        }
      : { probe: null, app: null, instances: null };
    const d = decideSandboxLive({
      health,
      ...rest,
      probeThreadKey: threadKey,
      deployedCommit: expectedCommit,
      before: rollout.before,
      target: rollout.target,
      elapsedMs: elapsed,
    });
    if (d.kind === "live") return { live: true, detail: d.summary, waitedMs: deps.now() - started };
    if (d.kind === "failed") return { live: false, reason: d.reason };
    io.log(
      `[deploy:all] ${step.name}: deployed, not live yet — ${d.reason} (${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1000)}s)`,
    );
    await deps.sleep(LIVE_GATE_POLL_MS);
  }
}

/** The sandbox's container application as it stands BEFORE the upload — the version the gate must see
 *  the rollout leave. A failed read is logged and returned as such: the gate then needs the
 *  deploy's image to show, and a deploy is never refused over it. */
async function readAppBeforeUpload(
  step: Pick<DeployStep, "name" | "dir">,
  gate: SandboxLiveGate,
  io: Pick<DeployRunnerIO, "log">,
  deps: SandboxGateDeps,
): Promise<Read<AppState>> {
  const before = await deps.readAppState(step.dir, gate.containerApp);
  io.log(
    "value" in before
      ? `[deploy:all] ${step.name}: container application at version ${before.value.version}${before.value.image ? ` (image ${shortImage(before.value.image)})` : ""} before the upload`
      : `[deploy:all] ${step.name}: could not read the container application before the upload — ${before.error}; the gate will need the deploy's image to show`,
  );
  return before;
}

/** A step's `npm run deploy` in its dir, output streamed — the one spawn `deployStep` makes, injectable. */
export type StepExec = (step: DeployStep, io: DeployRunnerIO) => Promise<RunResult>;
const runStepCommand: StepExec = (step, io) =>
  run(step.command[0], step.command.slice(1), {
    cwd: workerDir(step.dir),
    unset: step.unsetEnv,
    set: step.setEnv,
    stream: (c) => io.stream(c),
  });

/**
 * One step: its deploy command, then its gate. A sandbox-gated step reads the
 * container application BEFORE the command runs — the version the rollout must
 * leave — and takes the rollout target from what wrangler printed; a
 * failed pre-read is logged and handed to the gate, never a reason not to
 * deploy. A step whose preflight refuses is waited out and retried.
 */
export async function deployStep(
  step: DeployStep,
  plan: Pick<DeployPlan, "waitMaxMs" | "pollMs">,
  expectedCommit: string,
  io: DeployRunnerIO,
  deps: SandboxGateDeps,
  exec: StepExec = runStepCommand,
): Promise<StepOutcome> {
  // One `deploy.step.<worker>` root per step on the runner's own output, its
  // live gate a `deploy.wait_live` child carrying the `waitedMs` the "live"
  // line prints (docs/reference/specs/tracing.md item 20; release-and-deploy.md item 19).
  // `slow`: the step always prints, the gate when it took a second or more.
  const root = startProcessRoot(
    { clock: deps.now, sinks: [createLogSink({ level: "slow", write: (line) => io.log(line) })] },
    `deploy.step.${step.name}`,
  );
  try {
    const r = await deployStepTraced(step, plan, expectedCommit, io, deps, exec, root);
    root.end(r.ok ? "ok" : "error", { outcome: stepOutcomeWord(r) });
    return r;
  } catch (err) {
    root.fail(err);
    root.end("error", { outcome: "threw" });
    throw err;
  }
}

/** The one word a step's root carries for how it ended. */
function stepOutcomeWord(r: StepOutcome): string {
  if (r.ok) return r.live === "live" ? "live" : "deployed";
  return r.live.startsWith("deployed, not live") ? "not_live" : "failed";
}

async function deployStepTraced(
  step: DeployStep,
  plan: Pick<DeployPlan, "waitMaxMs" | "pollMs">,
  expectedCommit: string,
  io: DeployRunnerIO,
  deps: SandboxGateDeps,
  exec: StepExec,
  root: Span,
): Promise<StepOutcome> {
  const started = deps.now();
  // A step may carry its own budget (the resident's, sized for runs and a
  // provisioning rather than a rollout — plan.ts RESIDENT_WAIT_MAX_MS).
  const waitMaxMs = step.waitMaxMs ?? plan.waitMaxMs;
  const deadline = started + waitMaxMs;
  for (;;) {
    io.log(`\n[deploy:all] ▶ ${step.name} (${step.script}) — ${step.dir}: ${step.command.join(" ")}`);
    const sandbox =
      step.liveGate?.kind === "sandbox"
        ? { gate: step.liveGate, before: await readAppBeforeUpload(step, step.liveGate, io, deps) }
        : undefined;
    // The bot gate's pre-upload reading (liveGate.ts `decideLive`): the container's
    // `startedAt` now, so a same-commit rollout is told from its draining
    // predecessor. Best-effort — unreadable means the commit alone judges.
    const previousStartedAt =
      step.liveGate && step.liveGate.kind !== "sandbox"
        ? await fetchHealthz(step.liveGate.healthUrl).then((b) => (b ? servedStartedAt(b) : undefined))
        : undefined;
    const r = await exec(step, io);
    const outcome = classifyDeployOutput(r.code, r.output);
    if (outcome.kind === "deployed") {
      if (!step.liveGate) {
        if (step.wakeUrl) await wake(step.name, step.wakeUrl, io);
        return { ok: true, versionId: outcome.versionId, live: "n/a" };
      }
      io.log(
        `[deploy:all] ${step.name}: version ${outcome.versionId ?? "?"} uploaded — waiting until live (commit ${expectedCommit.slice(0, 7)})`,
      );
      const liveGate = step.liveGate;
      // The wait is the step's one child span: `waitedMs` is the number the
      // "live" line below prints, so the log and the span cannot disagree.
      const gate = await root.span("deploy.wait_live", async (wait) => {
        let g: GateOutcome;
        if (sandbox) {
          const target = rolloutTargetFromDeployOutput(r.output);
          const from = "value" in sandbox.before ? `version ${sandbox.before.value.version}` : "its pre-deploy version";
          io.log(
            target
              ? `[deploy:all] ${step.name}: wrangler printed a container change — ${target.image ? `image ${shortImage(target.image)}` : "configuration only, image unchanged"}; the application must leave ${from}`
              : `[deploy:all] ${step.name}: wrangler printed no container change — Worker-only deploy, no rollout expected`,
          );
          g = await waitUntilSandboxLive(step, sandbox.gate, expectedCommit, { ...sandbox, target }, io, deps);
        } else g = await waitUntilLive(step, liveGate.healthUrl, expectedCommit, io, deps.now, previousStartedAt);
        wait.setAttrs(g.live ? { outcome: "live", waitedMs: g.waitedMs } : { outcome: "not_live" });
        return g;
      });
      if (gate.live) {
        io.log(
          `[deploy:all] ${step.name}: live (${gate.detail}; ${Math.round(gate.waitedMs / 1000)}s after the upload)`,
        );
        return { ok: true, versionId: outcome.versionId, live: "live" };
      }
      return {
        ok: false,
        versionId: outcome.versionId,
        live: `deployed, not live: ${gate.reason}`,
        reason: `deployed but NOT live — ${gate.reason}`,
      };
    }
    if (outcome.kind === "preflight-refused" && step.retryOnPreflightRefusal) {
      const left = deadline - deps.now();
      if (left <= 0)
        return {
          ok: false,
          live: "not deployed",
          reason: `preflight still refusing after ${waitMaxMs / 60_000} min (${outcome.reason}); re-run later, or --force to deploy over it`,
        };
      // Never a silent wait: say what is in flight and how far into the budget we are.
      const body = step.healthUrl ? await fetchHealthz(step.healthUrl) : undefined;
      io.log(
        step.healthUrl
          ? heartbeatLine(step.name, body, deps.now() - started, waitMaxMs)
          : `[deploy:all] ${step.name}: still waiting — ${outcome.reason}`,
      );
      io.log(`[deploy:all] ${step.name}: retrying in ${plan.pollMs / 1000}s (${Math.ceil(left / 60_000)} min left)`);
      await sleep(plan.pollMs);
      continue;
    }
    return { ok: false, live: "not deployed", reason: outcome.reason };
  }
}

/** Execute a plan for real: pre-checks, then the steps in order, stopping at
 *  the first failure so the order holds (later Workers are NOT deployed). */
export async function runDeployPlan(
  plan: DeployPlan,
  io: DeployRunnerIO,
  deps: SandboxGateDeps = defaultSandboxGateDeps,
): Promise<DeployRunResult> {
  if (plan.affected) io.log(formatAffectedText(plan.affected));
  if (plan.steps.length === 0) {
    io.log("[deploy:all] nothing to deploy — every Worker already serves this tree's inputs");
    return { kind: "ran", ok: true, results: [], notAttempted: [] };
  }
  if (plan.profile.origin === "example") {
    return {
      kind: "refused",
      problems: [
        `${plan.profile.path} is the example profile — write deploy/profile.json for this installation (or point ${PROFILE_ENV} at one)`,
      ],
    };
  }
  // The Worker configs first: they are rendered from the profile (gitignored, so
  // the tree stays clean), and everything after — the capability pre-checks,
  // wrangler — reads the account and names from them.
  const renderProblems = await renderWorkerConfigsOnHost(io);
  if (renderProblems.length > 0) return { kind: "refused", problems: renderProblems };
  const problems = await preChecks(plan, io);
  if (problems.length > 0) return { kind: "refused", problems };
  // The bot reads its config from the state Worker, so the bot step is preceded
  // by a push of this installation's config from wherever the profile says it
  // lives. Read and validated HERE, before any Worker deploys: an unreadable
  // source or an invalid config is a refusal up front, not a bot that fails to
  // start after the memory Worker has already rolled.
  let configToPush: Extract<ConfigRead, { ok: true }> | undefined;
  const stateWorkerUrl = plan.config.stateWorkerUrl;
  if (plan.steps.some((s) => s.name === "bot")) {
    if (stateWorkerUrl === undefined) {
      io.warn(
        "[deploy:all] config: the profile has no state Worker — nothing is pushed; the bot reads SWITCHBOARD_CONFIG",
      );
    } else {
      const read = await readConfigForPush(plan.config.source);
      if (!read.ok) return { kind: "refused", problems: [read.problem] };
      if (!process.env[STATE_WORKER_TOKEN_ENV])
        return {
          kind: "refused",
          problems: [
            `${STATE_WORKER_TOKEN_ENV} is not set — the bot step pushes the config to ${stateWorkerUrl} with it`,
          ],
        };
      configToPush = read;
      io.log(`[deploy:all] config: ${read.how} validates; pushed to ${stateWorkerUrl} before the bot step`);
    }
  }
  for (const w of plan.warnings) io.warn(`[deploy:all] WARNING ${w}`);

  // The commit being deployed — what a gated Worker's /healthz must report
  // before its step counts as live. Read AFTER the origin/main check. If git fails this
  // is "" and `sameCommit` refuses anything under 7 chars, so the gate fails
  // closed (never a false "live") — and we say so up front rather than 18 min later.
  const expectedCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: OPERATOR_ROOT.root })).output.trim();
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
    return {
      kind: "refused",
      problems: [
        `could not read HEAD (\`git rev-parse HEAD\` gave ${JSON.stringify(expectedCommit.slice(0, 40))}); the live gates need the commit being deployed`,
      ],
    };
  }

  const results: DeployStepResult[] = [];
  for (const step of plan.steps) {
    if (step.name === "bot" && configToPush && stateWorkerUrl !== undefined) {
      // After the memory step (the document lives there), before the bot rolls (it reads it on start).
      const pushed = await pushConfigDocument(configToPush, {
        stateWorkerUrl,
        key: plan.config.document,
        env: process.env,
      });
      if (!pushed.ok) {
        results.push({
          name: step.name,
          script: step.script,
          live: "not deployed",
          status: `FAILED: config push — ${pushed.problem}`,
        });
        break;
      }
      io.log(
        `[deploy:all] config: ${pushed.how} → document "${plan.config.document}" v${pushed.version} on ${stateWorkerUrl} (sha256 ${pushed.sha256.slice(0, 12)}, ${pushed.bytes} bytes)`,
      );
    }
    if (!(await ensureNodeModules(step, io))) {
      results.push({ name: step.name, script: step.script, live: "not deployed", status: "npm ci failed" });
      break;
    }
    const r = await deployStep(step, plan, expectedCommit, io, deps);
    // wrangler always prints `Current Version ID`; a deploy that exits 0 without one is odd enough to say so.
    results.push({
      name: step.name,
      script: step.script,
      ...(r.versionId !== undefined ? { versionId: r.versionId } : {}),
      live: r.live,
      status: r.ok ? (r.versionId ? "deployed" : "deployed (no version id in output?)") : `FAILED: ${r.reason}`,
    });
    if (!r.ok) {
      io.warn(`[deploy:all] ${step.name} failed — stopping here so the order holds (later Workers were NOT deployed)`);
      break;
    }
  }
  const notAttempted = plan.steps.slice(results.length).map((s) => s.name);
  const ok =
    results.every((r) => r.status.startsWith("deployed") && !r.live.startsWith("deployed, not live")) &&
    notAttempted.length === 0;
  return { kind: "ran", ok, results, notAttempted };
}

/** The Worker → version → live table both the success output and a failure message end with. */
export function formatDeployResults(results: readonly DeployStepResult[], notAttempted: readonly string[]): string {
  const lines = [`  ${"worker".padEnd(9)} ${"script".padEnd(22)} ${"version".padEnd(38)} ${"live".padEnd(8)} status`];
  for (const r of results)
    lines.push(
      `  ${r.name.padEnd(9)} ${r.script.padEnd(22)} ${(r.versionId ?? "-").padEnd(38)} ${r.live.padEnd(8)} ${r.status}`,
    );
  if (notAttempted.length > 0) lines.push(`  not attempted: ${notAttempted.join(", ")}`);
  return lines.join("\n");
}

// ---- `--affected` (src/deploy/affected.ts is the pure half) ---------------------------------------

/** One git command in the repo root; `undefined` on a non-zero exit. */
async function git(args: string[]): Promise<string | undefined> {
  const r = await run("git", args, { cwd: OPERATOR_ROOT.root });
  return r.code === 0 ? r.output : undefined;
}

/**
 * The `AffectedProbe` over this checkout and the live Workers: git for HEAD,
 * ancestry, the last `v*` tag before HEAD, diffs and file contents at a ref
 * (`git show`, after one `ls-tree` per ref so a candidate path that does not
 * exist costs no spawn — the import crawler tries up to three per specifier);
 * `GET /healthz` per Worker for the commit it serves, with the sandbox's
 * bearer from `env` when present. Every failure is a value the pure half
 * turns into "unsure", never a throw.
 */
export function hostAffectedProbe(
  workers: readonly WorkerDef[],
  env: Record<string, string | undefined> = process.env,
): AffectedProbe {
  const trees = new Map<string, Promise<Set<string> | undefined>>();
  const listTree = (ref: string) => {
    let t = trees.get(ref);
    if (!t)
      trees.set(
        ref,
        (t = git(["ls-tree", "-r", "--name-only", ref]).then((out) =>
          out === undefined ? undefined : new Set(out.split("\n").filter(Boolean)),
        )),
      );
    return t;
  };
  return {
    head: async () => (await git(["rev-parse", "HEAD"]))?.trim() ?? "",
    liveCommit: async (worker: WorkerName) => {
      const w = workers.find((x) => x.name === worker)!;
      const bearer = w.healthBearerEnv ? env[w.healthBearerEnv] : undefined;
      if (w.healthBearerEnv && !bearer)
        return { error: `${w.healthBearerEnv} is not set — cannot read ${w.healthUrl}` };
      const r = await readHealthz(w.healthUrl, bearer);
      if ("error" in r) return { error: `GET ${w.healthUrl} failed: ${r.error}` };
      if (r.status < 200 || r.status >= 300) return { error: `GET ${w.healthUrl} → HTTP ${r.status}` };
      const body = r.body;
      const commit =
        body && typeof body.build === "object" && body.build !== null
          ? (body.build as { commit?: unknown }).commit
          : undefined;
      return typeof commit === "string" && commit !== ""
        ? { commit }
        : { error: `GET ${w.healthUrl} carries no build.commit` };
    },
    isAncestor: async (commit, head) =>
      (await run("git", ["merge-base", "--is-ancestor", commit, head], { cwd: OPERATOR_ROOT.root })).code === 0,
    lastRelease: async () => {
      const tag = (await git(["describe", "--tags", "--match", "v*", "--abbrev=0", "HEAD^"]))?.trim();
      if (!tag) return undefined;
      const commit = (await git(["rev-parse", `${tag}^{commit}`]))?.trim();
      return commit ? { tag, commit } : undefined;
    },
    // `undefined` on a git failure (an unknown base) — the pure half reads that as unsure, never as "nothing changed".
    changedPaths: async (base, head) =>
      (await git(["diff", "--name-only", "--no-renames", base, head, "--"]))?.split("\n").filter(Boolean),
    fileAt: async (ref, path) => {
      const tree = await listTree(ref);
      if (tree && !tree.has(path)) return undefined;
      return git(["show", `${ref}:${path}`]);
    },
  };
}

/** `deploy plan|all --affected` on the host: the selection over this checkout
 *  and the live fleet — the fleet being the installation the profile names. */
export async function computeAffectedOnHost(opts: { base?: string }): Promise<AffectedReport> {
  const { profile } = await loadProfileOnHost();
  return computeAffected(hostAffectedProbe(workersFor(profile)), opts);
}

// ---- `deploy restart` (src/deploy/restart.ts is the pure half) -----------------------------------

export type RestartRunResult =
  /** Refused before anything was posted (no bearer in the env). */
  | { kind: "refused"; problems: string[] }
  /** The route was called. `ok` only when a non-draining container answered with a LATER `startedAt`. */
  | {
      kind: "ran";
      ok: boolean;
      target: string;
      previousStartedAt?: string;
      startedAt?: string;
      waitedMs: number;
      reason?: string;
    };

/** The runner's I/O, injectable so the loop is unit-tested without a network or a clock. */
export interface RestartRunnerDeps {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const defaultRestartRunnerDeps: RestartRunnerDeps = {
  env: process.env,
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }),
  sleep,
  now: Date.now,
};

async function fetchHealthzWith(deps: RestartRunnerDeps, url: string): Promise<HealthzBody | undefined> {
  try {
    return parseHealthz(await (await deps.fetch(url)).text());
  } catch {
    return undefined;
  }
}

/**
 * Restart the bot container without a build: POST the Worker's `/admin/restart`
 * (bearer from `plan.tokenEnv`); a 409 (the bot not answering with JSON — the
 * fail-closed cases; runs in flight hand off and never refuse, run-history item
 * 39) is waited out with a heartbeat and retried every `pollMs` up to `waitMaxMs`
 * — never forced unless the plan says so; then poll `/healthz` until a
 * non-draining container reports a `startedAt` later than the old one's
 * (`decideRestarted`), logging every poll so the drain is visible.
 */
export async function runBotRestart(
  plan: RestartPlan,
  io: Pick<DeployRunnerIO, "log" | "warn">,
  deps: RestartRunnerDeps = defaultRestartRunnerDeps,
): Promise<RestartRunResult> {
  const token = deps.env[plan.tokenEnv];
  if (!token)
    return {
      kind: "refused",
      problems: [
        `${plan.tokenEnv} is not set in the environment — a SWITCHBOARD_INGRESS_TOKENS bearer whose identity carries deploy:write`,
      ],
    };
  const tag = "deploy:restart";
  const started = deps.now();
  const deadline = started + plan.waitMaxMs;
  if (plan.force)
    io.warn(
      `[${tag}] WARNING --force: the preflight is bypassed — in-flight runs on ${plan.target} are SIGTERM-drained (finish if they can, else killed at the drain deadline)`,
    );

  let previousStartedAt: string | undefined;
  for (;;) {
    io.log(`[${tag}] ▶ ${plan.target}: POST ${plan.adminUrl}${plan.force ? " (force)" : ""}`);
    let status: number;
    let text: string;
    try {
      const res = await deps.fetch(plan.adminUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ force: plan.force }),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      return {
        kind: "ran",
        ok: false,
        target: plan.target,
        waitedMs: deps.now() - started,
        reason: `POST ${plan.adminUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const outcome = classifyRestartResponse(status, text);
    if (outcome.kind === "stopping") {
      previousStartedAt = outcome.previousStartedAt;
      io.log(
        `[${tag}] ${plan.target}: SIGTERM sent (old container started ${previousStartedAt ?? "unknown"}) — waiting until a restarted container answers /healthz`,
      );
      break;
    }
    if (outcome.kind === "not-running") {
      io.log(
        `[${tag}] ${plan.target}: container was not running — the next request starts it with the current env; checking /healthz`,
      );
      break;
    }
    if (outcome.kind === "refused" && !plan.force) {
      const left = deadline - deps.now();
      if (left <= 0)
        return {
          kind: "ran",
          ok: false,
          target: plan.target,
          waitedMs: deps.now() - started,
          reason: `still refusing after ${plan.waitMaxMs / 60_000} min (${outcome.reason}); re-run later, or --force to stop blind`,
        };
      const body = await fetchHealthzWith(deps, plan.healthUrl);
      io.log(heartbeatLine(plan.target, body, deps.now() - started, plan.waitMaxMs, tag));
      io.log(`[${tag}] ${plan.target}: retrying in ${plan.pollMs / 1000}s (${Math.ceil(left / 60_000)} min left)`);
      await deps.sleep(plan.pollMs);
      continue;
    }
    return { kind: "ran", ok: false, target: plan.target, waitedMs: deps.now() - started, reason: outcome.reason };
  }

  const gateStarted = deps.now();
  for (;;) {
    const elapsed = deps.now() - gateStarted;
    const d = decideRestarted(
      await fetchHealthzWith(deps, plan.healthUrl),
      previousStartedAt,
      elapsed,
      plan.liveDeadlineMs,
    );
    if (d.kind === "live") {
      io.log(
        `[${tag}] ${plan.target}: restarted — startedAt ${d.startedAt} (was ${previousStartedAt ?? "unknown"}), live after ${Math.round(elapsed / 1000)}s`,
      );
      return {
        kind: "ran",
        ok: true,
        target: plan.target,
        previousStartedAt,
        startedAt: d.startedAt,
        waitedMs: deps.now() - started,
      };
    }
    if (d.kind === "timeout") {
      return {
        kind: "ran",
        ok: false,
        target: plan.target,
        previousStartedAt,
        waitedMs: deps.now() - started,
        reason: `${d.reason} — gave up after ${Math.round(elapsed / 60_000)} min (drain deadline ${plan.liveDeadlineMs / 60_000} min)`,
      };
    }
    io.log(
      `[${tag}] ${plan.target}: not live yet — ${d.reason} (${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1000)}s)`,
    );
    await deps.sleep(LIVE_GATE_POLL_MS);
  }
}
