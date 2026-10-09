import {
  consumerConfigKey,
  parseConfigConsumerIdentity,
  servedConfigConsumer,
  type ServedConfigConsumer,
  type ConfigConsumerIdentity,
} from "../configConsumer.js";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { MINUTE_MS } from "../core/budgets.js";
import {
  DRAINED_GAVE_UP_SUFFIX,
  drainBeganLine,
  drainBody,
  drainLiftedLine,
  drainSet,
  drainSkippedLine,
  drainUntil,
  drainUrl,
  postJson,
  reconcileLine,
  reconcileUrl,
  RESIDENT_DRAINED_WAIT_MAX_MS,
  undrainUrl,
  type PostAnswer,
} from "./residentDrain.js";
import {
  RESIDENT_READY_WAIT_MS,
  residentWorkerProblem,
  residentRegistryProblem,
  residentImageReportsProblem,
  reconciledResources,
} from "./residentReadiness.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { startProcessRoot } from "../core/requestTrace.js";
import { systemClock } from "../core/trace/clock.js";
import { createLogSink } from "../core/trace/sinks.js";
import type { Span } from "../core/trace/types.js";
import { computeAffected, formatAffectedText, type AffectedProbe, type AffectedReport } from "./affected.js";
import {
  decideRestarted,
  heartbeatLine,
  preflightGaveUpLine,
  RESTART_GAVE_UP_WORDS,
  LIVE_GATE_POLL_MS,
  parseHealthz,
  type HealthzBody,
} from "./liveGate.js";
import {
  capabilityProblem,
  classifyDeployOutput,
  decideAccount,
  lastErrorLines,
  RESIDENT_BEARER_ENVS,
  UNSET_ENV,
  WORKER_DIRS,
  workersFor,
  type DeployHost,
  type BotLiveGate,
  type ConfigConsumerTarget,
  type DeployPlan,
  type DeployStep,
  type SandboxLiveGate,
  type TokenVerifyResult,
  type WorkerDef,
  type WorkerName,
} from "./plan.js";
import { parseAppConfigText, validateProductionConfig } from "../config.js";
import {
  baseConfigDocument,
  ConfigDocumentClient,
  sha256Hex,
  STATE_WORKER_TOKEN_ENV,
  type ReadBaseOutcome,
  type BaseConfigDocument,
  sameConfigPublicationSnapshot,
  type ConfigPublicationSnapshot,
  type ConfigSourceObservation,
} from "../configDocument.js";
export type { ConfigSourceObservation } from "../configDocument.js";
import { BUILD_COMMIT_ENV } from "./buildStamp.js";
import { cliVersionOnHost, ensureWorkAreaOnHost, OPERATOR_ROOT, packageSourceOnHost } from "./host.js";
import { assetPath, installationPath, workPath, type OperatorRoot } from "./operatorRoot.js";
import { checkoutInstallHolds, imageBuiltOutsideDir, readWorkAreaState, type WorkAreaOutcome } from "./workArea.js";
import { RENDERED_FILE } from "./wranglerTemplate.js";
import { parseConfigSource, readConfigSource, type ConfigSourceIO } from "./configSource.js";
import { publishedImagesFrom, type PublishedImages } from "./images.js";
import { executionImageInputTags } from "./imageInputs.js";
import {
  isExampleProfile,
  parseProfile,
  PROFILE_ENV,
  PROFILE_EXAMPLE_PATH,
  PROFILE_PATH,
  type LoadedProfile,
} from "./profile.js";
import { classifyRestartResponse, type RestartPlan } from "./restart.js";
import { postPlaneDeploy } from "./planeDeploy.js";
import { PROJECT_FACTS_FILE, renderWorkerConfigs } from "./wranglerTemplate.js";
import { supersededSteps } from "./supersede.js";
import { decideBotLive } from "./botLiveGate.js";
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
  rolloutAdvanced,
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
// checkout that is the repository root, exactly as before; from the published
// package the profile and config are the operator's directory, the templates
// and manifests the package's assets, and the Worker directories a work area
// materialised under `.switchboard/` before anything runs in them
// (src/deploy/workArea.ts) — where the git checks give way to the package's own
// version and commit, since there is no tree to check. A step whose
// preflight refuses (a bot rollout still in progress, a resident with work in
// flight — never bot runs in flight, which hand off and only warn) is waited
// out and retried — never forced unless the plan says so — and the wait is
// never silent: every poll prints a heartbeat naming what still refuses.
// The bot step is done only when it is LIVE, not merely deployed: the runner
// reads its independently managed container application before upload, then
// requires its version and image target to move with wrangler's diff and polls
// `/healthz` until a non-draining container reports the exact deployed commit.
// Either control-plane or serving evidence alone can leave a rollback mixed
// (docs/decisions/0015-deploy-order-deployed-is-not-live.md). The sandbox step
// is likewise done only when its
// Worker, its container rollout and an `echo ok` probe agree (a thread placed
// during the image rollout lands on the previous image and every exec fails
// with the SDK skew until the rollout replaces the instance). Only this file
// touches processes; the plan and the live decisions are pure and unit-tested,
// and the command (src/core/commands/deploy.ts) maps this result onto the
// registry's error vocabulary.

export interface RunResult {
  code: number;
  output: string;
  cancelled?: true;
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
 *  vars for the child (the `env -u` of the README commands). Exported for the
 *  other host halves (src/deploy/imagesHost.ts) so every spawn has one shape. */
export function run(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    unset?: readonly string[];
    set?: Record<string, string>;
    stream?: (chunk: string) => void;
    signal?: AbortSignal;
  },
): Promise<RunResult> {
  if (opts.signal?.aborted) return Promise.resolve({ code: 130, output: "", cancelled: true });
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.set ?? {}) };
  for (const k of opts.unset ?? []) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let spawnError: Error | undefined;
    const stop = () => {
      child.kill("SIGTERM");
    };
    opts.signal?.addEventListener("abort", stop, { once: true });
    if (opts.signal?.aborted) stop();
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      opts.stream?.(text);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      spawnError = err;
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", stop);
      resolve(
        opts.signal?.aborted
          ? { code: 130, output, cancelled: true }
          : spawnError
            ? { code: 127, output: output + `\n${spawnError.message}` }
            : { code: code ?? 1, output },
      );
    });
  });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });

/** Cloudflare's per-account token verify — the only way an ACCOUNT-owned token
 *  (no `/user`, so `wrangler whoami` lists nothing) proves which account it is
 *  for. Never throws: a network failure is "not verified", and refused. */
async function verifyTokenAgainstAccount(
  account: string,
  token: string,
  signal?: AbortSignal,
): Promise<TokenVerifyResult | undefined> {
  if (signal?.aborted) return undefined;
  try {
    const timeout = AbortSignal.timeout(20_000);
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`, {
      headers: { authorization: `Bearer ${token}` },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return undefined;
  }
}

/** A Worker directory as wrangler runs in it: under the tree in a checkout, under the work area from the package. */
const workerDir = (dir: string) => workPath(OPERATOR_ROOT, dir);

async function preChecks(plan: DeployPlan, io: DeployRunnerIO, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) return ["deployment cancelled"];
  const problems: string[] = [];
  // `whoami` needs a wrangler to run: the first step's directory has one (in a checkout every
  // directory resolves the root's; from the package each step's was just installed).
  const who = await run("npx", ["wrangler", "whoami"], {
    cwd: workerDir(plan.steps[0]?.dir ?? WORKER_DIRS.bot),
    unset: UNSET_ENV,
    signal,
  });
  if (signal?.aborted) return ["deployment cancelled"];
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = decideAccount({
    account: plan.checks.account,
    whoamiOutput: who.output,
    whoamiExit: who.code,
    tokenSet: !!token,
    ...(token && !who.output.includes(plan.checks.account)
      ? { tokenVerify: await verifyTokenAgainstAccount(plan.checks.account, token, signal) }
      : {}),
  });
  if (signal?.aborted) return ["deployment cancelled"];
  if (account.ok) io.log(`[deploy:all] account: ${account.how}`);
  else problems.push(account.problem);
  // Capabilities BEFORE any Worker deploys: the same command each is about to
  // need, run read-only in its dir. One check per distinct command.
  const checked = new Map<string, Promise<RunResult>>();
  for (const step of plan.steps) {
    for (const check of step.capabilities) {
      if (signal?.aborted) return ["deployment cancelled"];
      const key = check.command.join(" ");
      let r = checked.get(key);
      if (!r)
        checked.set(key, (r = run("npx", [...check.command], { cwd: workerDir(step.dir), unset: UNSET_ENV, signal })));
      const result = await r;
      if (signal?.aborted) return ["deployment cancelled"];
      const problem = capabilityProblem(step.name, check, result.code, result.output);
      if (problem) problems.push(problem);
      else io.log(`[deploy:all] ${step.name}: credential can \`${key}\` (${check.needs})`);
    }
  }
  if (plan.checks.cleanTree) {
    const status = await run("git", ["status", "--porcelain"], { cwd: OPERATOR_ROOT.root, signal });
    if (signal?.aborted) return ["deployment cancelled"];
    if (status.output.trim() !== "")
      problems.push(
        "working tree is not clean — commit, stash, or deploy from a fresh checkout (wrangler builds the CURRENT tree)",
      );
  }
  if (plan.checks.atOriginMain) {
    // A failed fetch would let the check pass against a stale origin/main — treat it as a problem, not a warning.
    const fetch = await run("git", ["fetch", "-q", "origin"], { cwd: OPERATOR_ROOT.root, signal });
    if (signal?.aborted) return ["deployment cancelled"];
    if (fetch.code !== 0)
      problems.push(
        `git fetch origin failed (exit ${fetch.code}): ${fetch.output.trim().split("\n").pop() ?? ""} — cannot verify HEAD == origin/main`,
      );
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: OPERATOR_ROOT.root, signal })).output.trim();
    if (signal?.aborted) return ["deployment cancelled"];
    const main = (await run("git", ["rev-parse", "origin/main"], { cwd: OPERATOR_ROOT.root, signal })).output.trim();
    if (signal?.aborted) return ["deployment cancelled"];
    if (head !== main)
      problems.push(
        `HEAD ${head.slice(0, 7)} != origin/main ${main.slice(0, 7)} — \`git checkout --detach origin/main\`, or pass --allow-branch deliberately`,
      );
  }
  if (plan.root.mode === "package") problems.push(...packageModeProblems(plan));
  for (const s of plan.steps) {
    for (const req of s.requiredEnv) {
      if (!req.anyOf.some((v) => process.env[v]))
        problems.push(`${s.name}: none of ${req.anyOf.join(" / ")} is set in the environment`);
    }
  }
  return problems;
}

/**
 * The package-mode equivalents of the tree checks, after the work area is
 * materialised: the Worker sources are the package's version (the stamp says
 * so — `ensureWorkAreaOnHost` refused otherwise), and a step whose image is a
 * Dockerfile OUTSIDE its own directory cannot build here — the bot's is the
 * repository's root `Dockerfile`, whose build context (`src/`, `web/`, the
 * toolchain) the package does not carry. Said up front, before the memory
 * Worker rolls and leaves the fleet half-deployed.
 */
function packageModeProblems(plan: DeployPlan): string[] {
  const problems: string[] = [];
  const state = readWorkAreaState(OPERATOR_ROOT.workArea);
  if (state.kind !== "stamped" || state.stamp.version !== plan.root.version)
    problems.push(
      `${OPERATOR_ROOT.workArea} does not hold the package's version ${plan.root.version ?? "?"} — re-run; the work area is materialised before the checks`,
    );
  // Only a `build`-mode plan builds anything: in `registry` mode every image is a reference into the
  // account registry (src/deploy/images.ts), and `deploy all` copied a missing one before handing the plan over.
  if (plan.images.mode === "build") {
    for (const step of plan.steps) {
      const rendered = workerDir(`${step.dir}/${RENDERED_FILE}`);
      const image = existsSync(rendered) ? imageBuiltOutsideDir(readFileSync(rendered, "utf8")) : undefined;
      if (image)
        problems.push(
          `${step.name}: its image builds from ${image} — outside ${step.dir}, from the repository's own sources, which the package does not carry; deploy the ${step.name} Worker from a checkout, or switch the profile to \`"images": "registry"\` and run \`deploy images\``,
        );
    }
  }
  return problems;
}

/** The plan's `DeployHost.hasNodeModules`: in a checkout the Worker's `wrangler` resolves from its
 *  directory — nested or hoisted to the root (`checkoutInstallHolds`); from the package the work area's
 *  stamp lists the Worker as installed (its install is hoisted, never in the dir). */
export function hasNodeModules(dir: string): boolean {
  if (OPERATOR_ROOT.mode === "checkout") return checkoutInstallHolds(OPERATOR_ROOT.root, dir, existsSync);
  const state = readWorkAreaState(OPERATOR_ROOT.workArea);
  return state.kind === "stamped" && state.stamp.installed.includes(dir);
}

/** What the plan is computed over on this host: the root and mode this process runs from, the package's
 *  version when it is the package (`plan.root`), and the install probe (src/deploy/plan.ts `DeployHost`). */
export function deployHostOnHost(): DeployHost {
  let version: string | undefined;
  let commit: string | undefined;
  if (OPERATOR_ROOT.mode === "package") {
    // A package without its stamp still plans; the runner refuses it by name before anything deploys.
    try {
      ({ version, commit } = packageSourceOnHost());
    } catch {
      version = undefined;
    }
  }
  if (OPERATOR_ROOT.mode === "checkout") {
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: OPERATOR_ROOT.root, encoding: "utf8" }).trim();
      const dirty = execFileSync("git", ["status", "--porcelain"], {
        cwd: OPERATOR_ROOT.root,
        encoding: "utf8",
      }).trim();
      commit = `${head}${dirty ? "-dirty" : ""}`;
    } catch {
      commit = undefined;
    }
  }
  return {
    root: {
      mode: OPERATOR_ROOT.mode,
      path: OPERATOR_ROOT.root,
      ...(version !== undefined ? { version } : {}),
      ...(commit !== undefined ? { commit } : {}),
    },
    hasNodeModules,
  };
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
  selection?: LoadedProfile,
): Promise<string[]> {
  const loaded = selection ?? (await loadProfileOnHost(env));
  const published = await publishedImagesOnHost();
  if (!published.ok) return [published.problem];
  const rendered = renderWorkerConfigs(loaded.profile, (path) => readShipped(path), published.images);
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

/**
 * The images this CLI deploys or copies (src/deploy/images.ts `PublishedImages`):
 * the three names from the shipped `project.json`, and the version this CLI runs
 * as (src/deploy/host.ts `cliVersionOnHost`). GHCR images all carry that release
 * tag; the account's resident and sandbox copies use stable image-input tags.
 * A facts file without the names is a problem naming it, not a guess.
 */
export async function publishedImagesOnHost(): Promise<
  { ok: true; images: PublishedImages } | { ok: false; problem: string }
> {
  const published = publishedImagesFrom(readShipped(PROJECT_FACTS_FILE), cliVersionOnHost());
  if (!published.ok) return published;
  return {
    ok: true,
    images: { ...published.images, inputTags: await executionImageInputTags(async (path) => readShipped(path)) },
  };
}

/**
 * `deploy init`'s file access by tree path, over a root and the work area's
 * materialisation: a rendered `wrangler.jsonc` lives in the Worker's directory
 * under the work area, everything else — the templates, `project.json` — is a
 * shipped file. The work area is brought to this CLI's version (the copy alone,
 * no install) before a rendered file is READ as well as before one is written:
 * a work area left by another version is replaced, its stale render with it, so
 * a command that compares the render to what is on disk finds nothing there and
 * writes — never a `deploy secrets` that judges an old render current and then
 * has the install sweep it away. In a checkout the two places are one tree and
 * the materialisation is a no-op (src/deploy/operatorRoot.ts).
 */
export function deployFiles(
  at: Pick<OperatorRoot, "assets" | "workArea">,
  ensureWorkArea: () => Promise<WorkAreaOutcome>,
): { read(path: string): Promise<string | undefined>; write(path: string, text: string): Promise<void> } {
  const shipped = (path: string) => {
    const abs = assetPath(at, path);
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  };
  const current = async () => {
    const ready = await ensureWorkArea();
    if (!ready.ok) throw new Error(ready.problem);
  };
  return {
    read: async (path) => {
      if (!path.endsWith(`/${RENDERED_FILE}`)) return shipped(path);
      await current();
      const abs = workPath(at, path);
      return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    },
    write: async (path, text) => {
      await current();
      const abs = workPath(at, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    },
  };
}

/** `deploy init`'s file access on this host. */
export const hostDeployFiles = deployFiles(OPERATOR_ROOT, () => ensureWorkAreaOnHost([], () => {}));

/** The config-source loaders' I/O on this host: files under the root (the checkout, or the operator's directory), real fetch, the `op` CLI. */
function hostConfigSourceIO(): ConfigSourceIO {
  return {
    readFile: async (path) => {
      const abs = isAbsolute(path) ? path : installationPath(OPERATOR_ROOT, path);
      return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    },
    pathModifiedAt: async (path) => {
      const abs = isAbsolute(path) ? path : installationPath(OPERATOR_ROOT, path);
      try {
        return statSync(abs).mtime.toISOString();
      } catch {
        return undefined;
      }
    },
    fetch: async (url, init) => {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      return { status: res.status, text: () => res.text(), headers: res.headers };
    },
    opRead: async (ref) => {
      const r = await run("op", ["read", ref], { cwd: OPERATOR_ROOT.root });
      return r.code === 127 ? undefined : r;
    },
    env: process.env,
  };
}

/** A config read from a `configSource` and validated — what `deploy all` and `deploy config` push. */
export type ConfigRead = { ok: true; text: string; how: string; modifiedAt?: string } | { ok: false; problem: string };

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
    validateProductionConfig(parseAppConfigText(read.text));
  } catch (err) {
    return {
      ok: false,
      problem: `configSource ${source}: the config does not validate — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: true,
    text: read.text,
    how: read.how,
    ...(read.modifiedAt !== undefined ? { modifiedAt: read.modifiedAt } : {}),
  };
}

export type ConfigPushOutcome =
  | { ok: true; how: string; version: number; sha256: string; bytes: number; snapshotKey?: string; document: string }
  | { ok: false; problem: string; write: "not-written" | "unknown" };

/** What the runner needs to push: the plan's state Worker, the document key, the bearer's env. */
export interface ConfigPushTarget {
  stateWorkerUrl: string;
  key: string;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Printed before send, so a lost answer can be investigated by this exact private record key. */
  onSnapshot?: (key: string) => void;
  consumer?: ConfigConsumerIdentity;
  inputSourceKey?: string;
  expectedInputSource?: Readonly<{ version: number; sha256: string }>;
}

/** Private operation inputs. Prior YAML is recovery material, never public output
 *  or authority to restore over a successor or an uncertain application target. */
export interface PreparedConfigPublication {
  readonly stateWorkerUrl: string;
  readonly key: string;
  readonly how: string;
  readonly snapshotKey: string;
  readonly candidate: Readonly<BaseConfigDocument>;
  readonly prior: Readonly<{ version: number; document: Readonly<BaseConfigDocument> | null }>;
  readonly inputSource?: NonNullable<ConfigPublicationSnapshot["inputSource"]>;
}

/** Freeze validated candidate bytes and canonical state before any Worker upload. */
export async function prepareConfigPublication(
  read: Extract<ConfigRead, { ok: true }>,
  target: ConfigPushTarget,
): Promise<{ ok: true; publication: PreparedConfigPublication } | { ok: false; problem: string }> {
  const token = target.env[STATE_WORKER_TOKEN_ENV];
  if (!token)
    return {
      ok: false,
      problem: `${STATE_WORKER_TOKEN_ENV} is not set — the config is pushed to ${target.stateWorkerUrl} with the state Worker's bearer`,
    };
  const { stateWorkerUrl, key } = target;
  if (target.consumer && key !== consumerConfigKey(target.consumer))
    return { ok: false, problem: "config publication target does not belong to the publishing consumer" };
  const how = read.how;
  const candidate = Object.freeze(
    baseConfigDocument(read.text, how.replace(/^config from /, ""), (target.now ?? (() => new Date(systemClock())))()),
  );
  const client = new ConfigDocumentClient({ baseUrl: stateWorkerUrl, token, fetch: target.fetch });
  const prior = await client.readBase(key);
  if (!prior.ok) return prior;
  const inputKey = target.inputSourceKey;
  const inputRead = inputKey && inputKey !== key ? await client.readBase(inputKey) : prior;
  if (!inputRead.ok) return inputRead;
  if (
    target.expectedInputSource &&
    (inputRead.version !== target.expectedInputSource.version ||
      inputRead.document?.sha256 !== target.expectedInputSource.sha256)
  )
    return {
      ok: false,
      problem: "input source changed since its observed serving pair; reconcile current settings before publication",
    };
  const inputSource = inputKey
    ? Object.freeze({
        key: inputKey,
        version: inputRead.version,
        document: inputRead.document ? Object.freeze({ ...inputRead.document }) : null,
      })
    : undefined;
  const publicationId = randomUUID();
  const snapshotKey = `deploy-base-${publicationId}`;
  const priorDocument = prior.document ? Object.freeze({ ...prior.document }) : null;
  const snapshot: ConfigPublicationSnapshot = Object.freeze({
    schema: 1,
    kind: "base-config-publication",
    publicationId,
    stateWorkerUrl,
    baseKey: key,
    priorVersion: prior.version,
    priorDocument,
    expectedCandidateVersion: prior.version + 1,
    candidate,
    ...(inputSource ? { inputSource } : {}),
  });
  target.onSnapshot?.(snapshotKey);
  const stored = await client.recordPublicationSnapshot(snapshotKey, snapshot);
  if (!stored.ok)
    return {
      ok: false,
      problem: `config input snapshot "${snapshotKey}": ${stored.problem}; base config was not sent`,
    };
  const readback = await client.readPublicationSnapshot(snapshotKey);
  if (!readback.ok || !sameConfigPublicationSnapshot(readback.snapshot, snapshot))
    return {
      ok: false,
      problem: `config input snapshot "${snapshotKey}" readback is uncertain; base config was not sent`,
    };
  return {
    ok: true,
    publication: Object.freeze({
      stateWorkerUrl,
      key,
      how,
      snapshotKey,
      candidate,
      ...(inputSource ? { inputSource } : {}),
      prior: Object.freeze({ version: prior.version, document: priorDocument }),
    }),
  };
}

/** Send the immutable publication once against its captured canonical version. */
export async function publishConfigPublication(
  publication: PreparedConfigPublication,
  transport: Pick<ConfigPushTarget, "env" | "fetch">,
): Promise<ConfigPushOutcome> {
  const token = transport.env[STATE_WORKER_TOKEN_ENV];
  if (!token) return { ok: false, write: "not-written", problem: `${STATE_WORKER_TOKEN_ENV} is not set` };
  const client = new ConfigDocumentClient({ baseUrl: publication.stateWorkerUrl, token, fetch: transport.fetch });
  const pushed = await client.pushBase(
    publication.candidate,
    publication.key,
    publication.prior.version,
    publication.inputSource
      ? { key: publication.inputSource.key, version: publication.inputSource.version }
      : undefined,
  );
  if (!pushed.ok) return { ...pushed, problem: `${pushed.problem}; input snapshot "${publication.snapshotKey}"` };
  return {
    ok: true,
    snapshotKey: publication.snapshotKey,
    document: publication.key,
    how: publication.how,
    version: pushed.version,
    sha256: publication.candidate.sha256,
    bytes: Buffer.byteLength(publication.candidate.yaml),
  };
}

/** Complete inventory must identify the one serving singleton, without hiding contradictory rows. */
function hasServingConfigSingleton(
  app: Read<AppState>,
  instances: Read<ContainerInstance[]>,
): app is { value: AppState & { image: string } } {
  if (
    "error" in app ||
    "error" in instances ||
    !Number.isSafeInteger(app.value.version) ||
    app.value.version < 0 ||
    !app.value.image
  )
    return false;
  const knownStates = ["running", "stopped", "stopping", "failed", "provisioning", "unhealthy", "inactive"];
  if (
    instances.value.some(
      (row) =>
        !row.name?.trim() ||
        !knownStates.includes(row.state.toLowerCase()) ||
        row.version === null ||
        !Number.isSafeInteger(row.version) ||
        row.version < 0,
    )
  )
    return false;
  if (new Set(instances.value.map((row) => row.name)).size !== instances.value.length) return false;
  const singleton = instances.value.filter((row) => row.name === "singleton");
  const running = instances.value.filter((row) => row.state.toLowerCase() === "running");
  return (
    singleton.length === 1 &&
    running.length === 1 &&
    running[0] === singleton[0] &&
    singleton[0].version === app.value.version
  );
}

/** A frozen source observation is data from an installed process and native app.
 *  It deliberately does not declare that the legacy build display is an owned CID. */
export function configSourceObservation(
  health: HealthRead,
  app: Read<AppState>,
  instances: Read<ContainerInstance[]>,
): { ok: true; source: ConfigSourceObservation } | { ok: false; problem: string } {
  if ("error" in health || health.status !== 200 || !health.body || "error" in app || "error" in instances)
    return {
      ok: false,
      problem:
        "config source serving pair is unavailable; bootstrap requires proven native absence or original observation",
    };
  const body = health.body;
  const loaded = body.loadedBase;
  if (
    body.ok !== true ||
    body.draining !== false ||
    typeof loaded !== "object" ||
    loaded === null ||
    Array.isArray(loaded)
  )
    return { ok: false, problem: "config source is not installed by a non-draining process" };
  const receipt = loaded as Record<string, unknown>;
  const state = receipt.source;
  const process = receipt.process;
  if (
    receipt.schema !== 1 ||
    typeof state !== "object" ||
    state === null ||
    Array.isArray(state) ||
    typeof process !== "object" ||
    process === null ||
    Array.isArray(process)
  )
    return { ok: false, problem: "config source observation is incomplete" };
  const source = state as Record<string, unknown>;
  const commit = (process as Record<string, unknown>).commit;
  if (
    source.kind !== "state" ||
    typeof source.key !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(source.key) ||
    typeof source.version !== "number" ||
    !Number.isSafeInteger(source.version) ||
    source.version < 1 ||
    typeof receipt.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.sha256)
  )
    return { ok: false, problem: "config source is unknown, file-backed or malformed" };
  if (
    source.key !== "base" &&
    (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) || source.key !== consumerConfigKey({ commit }))
  )
    return { ok: false, problem: "config source is foreign to the observed process" };
  if (!hasServingConfigSingleton(app, instances))
    return { ok: false, problem: "config source application and serving instance do not agree" };
  return {
    ok: true,
    source: Object.freeze({
      key: source.key,
      version: source.version,
      sha256: receipt.sha256,
      ...(typeof commit === "string" ? { observedProcessCommit: commit } : {}),
      application: Object.freeze({ version: app.value.version, image: app.value.image }),
    }),
  };
}

/** Construct legacy input data from the exact original document/native app
 *  observations. No legacy display/environment value becomes an owned CID. */
export function frozenLegacyConfigSourceInput(
  base: ReadBaseOutcome,
  app: Read<AppState>,
): { ok: true; source: ConfigSourceObservation } | { ok: false; problem: string } {
  if (
    !base.ok ||
    !base.document ||
    !Number.isSafeInteger(base.version) ||
    base.version < 1 ||
    base.document.sha256 !== sha256Hex(base.document.yaml) ||
    "error" in app ||
    !Number.isSafeInteger(app.value.version) ||
    app.value.version < 0 ||
    !app.value.image
  )
    return { ok: false, problem: "original legacy source/native application observation is incomplete" };
  return {
    ok: true,
    source: Object.freeze({
      key: "base",
      version: base.version,
      sha256: base.document.sha256,
      application: Object.freeze({ version: app.value.version, image: app.value.image }),
    }),
  };
}

export function originalConfigSourceObservation(
  source: ConfigSourceObservation,
  app: Read<AppState>,
  instances: Read<ContainerInstance[]>,
): boolean {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(source.key) ||
    !Number.isSafeInteger(source.version) ||
    source.version < 1 ||
    !/^[0-9a-f]{64}$/.test(source.sha256) ||
    (source.key !== "base" &&
      (typeof source.observedProcessCommit !== "string" ||
        !/^[0-9a-f]{40}$/.test(source.observedProcessCommit) ||
        source.key !== consumerConfigKey({ commit: source.observedProcessCommit }))) ||
    !unchangedConfigSourceApplication(source, app) ||
    "error" in instances
  )
    return false;
  return hasServingConfigSingleton(app, instances);
}

export function unchangedConfigSourceApplication(source: ConfigSourceObservation, app: Read<AppState>): boolean {
  return (
    "value" in app && app.value.version === source.application.version && app.value.image === source.application.image
  );
}

/** Both native application and serving receipt identify the same current consumer.
 *  A desired Worker image or permissive build display alone grants no eligibility. */
export function eligibleConfigPublicationConsumer(
  identity: ConfigConsumerIdentity,
  health: HealthRead,
  app: Read<AppState>,
  instances: Read<ContainerInstance[]>,
  expectedImage?: string,
): { ok: true; consumer: ServedConfigConsumer } | { ok: false; problem: string } {
  if ("error" in health || health.status !== 200 || "error" in app || "error" in instances)
    return { ok: false, problem: "actual config consumer or application target is unavailable" };
  const serving = servedConfigConsumer(health.body);
  if (!serving.ok) return serving;
  if (serving.consumer.identity.commit !== identity.commit)
    return { ok: false, problem: "publishing parser does not match the actual config consumer" };
  if ((expectedImage !== undefined && app.value.image !== expectedImage) || !hasServingConfigSingleton(app, instances))
    return { ok: false, problem: "actual application and serving instance target do not agree" };
  return serving;
}

/** Final read-only acceptance: source writes during image activation remain a
 *  cutover failure, not permission to restore or to refresh either config. */
export async function confirmConsumerConfigPublication(
  publication: PreparedConfigPublication,
  identity: ConfigConsumerIdentity,
  health: HealthRead,
  app: Read<AppState>,
  instances: Read<ContainerInstance[]>,
  readSource: (key: string) => Promise<ReadBaseOutcome>,
  expectedImage?: string,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  const current = eligibleConfigPublicationConsumer(identity, health, app, instances, expectedImage);
  if (!current.ok) return current;
  if (
    current.consumer.key !== publication.key ||
    current.consumer.version !== publication.prior.version + 1 ||
    current.consumer.sha256 !== publication.candidate.sha256
  )
    return { ok: false, problem: "activated consumer did not install the exact published config" };
  if (publication.inputSource) {
    const source = await readSource(publication.inputSource.key);
    const sameTarget = publication.inputSource.key === publication.key;
    if (
      !source.ok ||
      source.version !== (sameTarget ? publication.prior.version + 1 : publication.inputSource.version) ||
      source.document?.sha256 !== (sameTarget ? publication.candidate.sha256 : publication.inputSource.document?.sha256)
    )
      return {
        ok: false,
        problem: "input source changed during image activation; sole writer must reconcile current settings",
      };
  }
  return { ok: true };
}

/** Direct config writes prepare and send immediately; deployments prepare before
 *  uploads and call publishConfigPublication with those same operation inputs. */
export async function pushConfigDocument(
  read: Extract<ConfigRead, { ok: true }>,
  target: ConfigPushTarget,
): Promise<ConfigPushOutcome> {
  const prepared = await prepareConfigPublication(read, target);
  if (!prepared.ok) return { ...prepared, write: "not-written" };
  return publishConfigPublication(prepared.publication, target);
}

/** One publishing parser's own source; runtime variables never choose it. */
async function configPublisherIdentityOnHost(): Promise<
  { ok: true; identity: ConfigConsumerIdentity } | { ok: false; problem: string }
> {
  if (OPERATOR_ROOT.mode === "package") return parseConfigConsumerIdentity(JSON.stringify(packageSourceOnHost()));
  const status = await run("git", ["status", "--porcelain"], { cwd: OPERATOR_ROOT.root });
  if (status.code !== 0 || status.output.trim())
    return { ok: false, problem: "config publication requires a clean publishing parser checkout" };
  const source = await run("git", ["rev-parse", "HEAD"], { cwd: OPERATOR_ROOT.root });
  if (source.code !== 0) return { ok: false, problem: "publishing parser identity is unavailable" };
  return parseConfigConsumerIdentity(JSON.stringify({ commit: source.output.trim() }));
}

/** Direct config writes are only for the consumer actually serving its owned slot. */
export async function pushConfigForServedConsumer(
  read: Extract<ConfigRead, { ok: true }>,
  target: ConfigPushTarget,
  identity: ConfigConsumerIdentity,
  health: HealthRead,
  app: Read<AppState>,
  instances: Read<ContainerInstance[]>,
  expectedImage?: string,
): Promise<ConfigPushOutcome> {
  const current = eligibleConfigPublicationConsumer(identity, health, app, instances, expectedImage);
  if (!current.ok) return { ...current, write: "not-written" };
  const prepared = await prepareConfigPublication(read, {
    ...target,
    key: current.consumer.key,
    consumer: identity,
    inputSourceKey: current.consumer.key,
    expectedInputSource: { version: current.consumer.version, sha256: current.consumer.sha256 },
  });
  if (!prepared.ok) return { ...prepared, write: "not-written" };
  return publishConfigPublication(prepared.publication, target);
}

export interface ActualConfigConsumerBinding {
  readonly health: HealthRead;
  readonly application: Read<AppState>;
  readonly instances: Read<ContainerInstance[]>;
}

async function readActualConfigConsumerOnHost(target: ConfigConsumerTarget): Promise<ActualConfigConsumerBinding> {
  // Wrangler prefers account_id in its config over the environment. A private
  // account-only file binds these reads even if the installation's files change.
  const directory = mkdtempSync(join(tmpdir(), "switchboard-consumer-read-"));
  const config = join(directory, "wrangler.jsonc");
  try {
    writeFileSync(config, JSON.stringify({ account_id: target.account }));
    const [health, application, instances] = await Promise.all([
      defaultSandboxGateDeps.readHealth(target.healthUrl),
      defaultSandboxGateDeps.readAppState(target.dir, target.containerApp, config),
      defaultSandboxGateDeps.readInstances(target.dir, target.containerApp, config),
    ]);
    return { health, application, instances };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** `deploy config` validates its own publisher and actual native target before writing. */
export async function pushConfigOnHost(input: {
  source: string;
  stateWorkerUrl: string;
  key: string;
  consumerTarget: ConfigConsumerTarget;
}): Promise<ConfigPushOutcome> {
  const opts = Object.freeze({ ...input, consumerTarget: Object.freeze({ ...input.consumerTarget }) });
  if (!opts.consumerTarget.stateWorkerUrl || opts.stateWorkerUrl !== opts.consumerTarget.stateWorkerUrl)
    return {
      ok: false,
      write: "not-written",
      problem: "config publication state endpoint differs from the frozen deployment target",
    };
  const publisher = await configPublisherIdentityOnHost();
  if (!publisher.ok) return { ...publisher, write: "not-written" };
  const binding = await readActualConfigConsumerOnHost(opts.consumerTarget);
  const { health, application: app, instances } = binding;
  const current = eligibleConfigPublicationConsumer(publisher.identity, health, app, instances);
  if (!current.ok) return { ...current, write: "not-written" };
  const read = await readConfigForPush(opts.source);
  if (!read.ok) return { ...read, write: "not-written" };
  return pushConfigForServedConsumer(
    read,
    {
      stateWorkerUrl: opts.stateWorkerUrl,
      key: current.consumer.key,
      env: process.env,
      onSnapshot: (key) =>
        process.stderr.write(`config input snapshot "${key}" (private data, not restoration authority)\n`),
    },
    publisher.identity,
    health,
    app,
    instances,
  );
}

async function ensureNodeModules(step: DeployStep, io: DeployRunnerIO, signal?: AbortSignal): Promise<boolean> {
  if (hasNodeModules(step.dir)) return true;
  // A checkout installs at its root: every Worker is an npm workspace of it, and an `npm ci` run
  // inside a workspace directory prunes the tree to that workspace — the bundle then cannot resolve
  // what `src/` imports (`zod` went missing that way on a release deploy). From the package the
  // work area is installed per Worker by `ensureWorkAreaOnHost` before this; a miss here is its dir.
  const cwd = OPERATOR_ROOT.mode === "checkout" ? OPERATOR_ROOT.root : workerDir(step.dir);
  io.log(`[deploy:all] ${step.name}: install missing — npm ci in ${cwd}`);
  const r = await run("npm", ["ci", "--silent"], { cwd, signal });
  if (r.code !== 0) io.warn(r.output);
  return r.code === 0;
}

/** One GET of the Worker's `/healthz` after its deploy, so it (and its Durable Objects) are awake
 *  before the next step needs them. Informational: the deploy is done either way. */
async function wake(name: string, url: string, io: DeployRunnerIO, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  try {
    const timeout = AbortSignal.timeout(180_000);
    const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    io.log(`[deploy:all] ${name}: awake — GET ${url} → HTTP ${res.status}`);
  } catch (err) {
    io.warn(`[deploy:all] ${name}: wake GET ${url} failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** GET a `/healthz`, with a bearer when the Worker sits behind one (the sandbox):
 *  the status and the parsed body, or why the request failed. Never throws. */
async function readHealthz(
  url: string,
  bearer?: string,
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<HealthRead> {
  if (signal?.aborted) return { error: "deployment cancelled" };
  try {
    const res = await fetch(url, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: parseHealthz(await res.text()) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The body of an unauthenticated `/healthz`; undefined when unreachable or not JSON. */
async function fetchHealthz(url: string, signal?: AbortSignal): Promise<HealthzBody | undefined> {
  const r = await readHealthz(url, undefined, undefined, signal);
  return "body" in r ? r.body : undefined;
}

export interface StepOutcome {
  ok: boolean;
  /** No command started, or every completed attempt proved a pre-upload refusal. */
  noUpload?: true;
  versionId?: string;
  live: string;
  reason?: string;
}

/** What a live gate ends with: the facts that proved it, or the reason it never held. */
type GateOutcome = { live: true; detail: string; waitedMs: number } | { live: false; reason: string };

// ---- the sandbox live gate (src/deploy/sandboxLiveGate.ts is the pure half) -----------------------

/** The sandbox gate's I/O, injectable so the loop is unit-tested without a network, wrangler or a clock. */
export interface SandboxGateDeps {
  /** Only this operator deployment; cancellation grants no native ending or lift proof. */
  signal?: AbortSignal;
  env: Record<string, string | undefined>;
  readHealth(url: string, bearer?: string, timeoutMs?: number, signal?: AbortSignal): Promise<HealthRead>;
  /** `wrangler containers info <app> --json` → the application's version and image, run in `dir`. */
  readAppState(dir: string, containerApp: string, config?: string): Promise<Read<AppState>>;
  /** `wrangler containers instances <app> --json`, every page, run in `dir`. */
  readInstances(dir: string, containerApp: string, config?: string): Promise<Read<ContainerInstance[]>>;
  /** The application list Wrangler uses to compute its deploy diff. */
  readListedAppState?(dir: string, containerApp: string, account: string): Promise<Read<AppState>>;
  /** `POST /exec` `echo ok` on the probe thread; the streamed body parsed. */
  probeExec(execUrl: string, bearer: string, threadKey: string): Promise<ProbeResult>;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** One authenticated JSON POST (the fleet drain's `/drain` and `/undrain`, release-and-deploy
   *  item 31); absent → the runner never drains and says why. */
  postJson?(url: string, bearer: string, body: Record<string, unknown>): Promise<PostAnswer>;
}

/** One read-only wrangler command in a Worker's dir, its `--json` payload parsed;
 *  `CLOUDFLARE_ACCOUNT_ID` stripped like every other wrangler call here. */
async function wranglerJson(dir: string, args: string[], config?: string): Promise<Read<unknown>> {
  const r = await run("npx", ["wrangler", ...args, ...(config ? ["--config", config] : [])], {
    cwd: workerDir(dir),
    unset: UNSET_ENV,
  });
  if (r.code !== 0)
    return { error: `wrangler ${args.join(" ")} failed: ${lastErrorLines(r.output) || `exit ${r.code}, no output`}` };
  const parsed = parseWranglerJson(r.output);
  return parsed === undefined ? { error: `wrangler ${args.join(" ")}: no JSON in the output` } : { value: parsed };
}

/** The application id behind a Containers application name — stable, so a
 *  success is remembered for the process; a failure is retried next poll. */
const containerAppIds = new Map<string, string>();
async function resolveContainerAppId(dir: string, containerApp: string, config?: string): Promise<Read<string>> {
  const cacheKey = `${workerDir(dir)}:${config ?? ""}:${containerApp}`;
  const known = containerAppIds.get(cacheKey);
  if (known) return { value: known };
  const listing = await wranglerJson(dir, ["containers", "list", "--json"], config);
  if ("error" in listing) return listing;
  const id = containerAppId(listing.value, containerApp);
  if (!id)
    return {
      error: `container application ${containerApp} not in \`wrangler containers list\` (wrong account, or renamed class?)`,
    };
  containerAppIds.set(cacheKey, id);
  return { value: id };
}

/** `--per-page` above the fleet's `max_instances` (25); wrangler answers one page per call. */
const INSTANCES_PER_PAGE = 100;

export const defaultSandboxGateDeps: SandboxGateDeps = {
  env: process.env,
  postJson,
  readHealth: (url, bearer, timeoutMs, signal) => readHealthz(url, bearer, timeoutMs, signal),
  readListedAppState: async (dir, containerApp, account) => {
    // Capture privately: neither successful credentials nor failed auth output
    // may enter a deploy log. Use the same auth modes as Wrangler's upload.
    const auth = await run("npx", ["wrangler", "auth", "token", "--json"], { cwd: workerDir(dir), unset: UNSET_ENV });
    if (auth.code !== 0) return { error: "Wrangler credentials unavailable for the raw application list" };
    return readRawBotApplication(account, containerApp, parseWranglerJson(auth.output));
  },
  readAppState: async (dir, containerApp, config) => {
    const id = await resolveContainerAppId(dir, containerApp, config);
    if ("error" in id) return id;
    const info = await wranglerJson(dir, ["containers", "info", id.value, "--json"], config);
    if ("error" in info) return info;
    const state = parseAppState(info.value);
    return state === null
      ? { error: `wrangler containers info ${id.value}: no numeric version in the output` }
      : { value: state };
  },
  readInstances: async (dir, containerApp, config) => {
    const id = await resolveContainerAppId(dir, containerApp, config);
    if ("error" in id) return id;
    const rows: ContainerInstance[] = [];
    let pageToken: string | null = null;
    do {
      const args = ["containers", "instances", id.value, "--json", "--per-page", String(INSTANCES_PER_PAGE)];
      if (pageToken) args.push("--page-token", pageToken);
      const page = await wranglerJson(dir, args, config);
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

/** The raw list used by Wrangler deploy differs from its dashboard-backed CLI list. */
export async function readRawBotApplication(
  account: string,
  name: string,
  credentials: unknown,
  fetcher: typeof fetch = fetch,
): Promise<Read<AppState>> {
  if (!/^[a-f0-9]{32}$/.test(account)) return { error: "raw application list requires the selected account" };
  if (typeof credentials !== "object" || credentials === null) return { error: "Wrangler credentials unavailable" };
  const auth = credentials as Record<string, unknown>;
  let headers: Record<string, string>;
  if ((auth.type === "api_token" || auth.type === "oauth") && typeof auth.token === "string" && auth.token)
    headers = { authorization: `Bearer ${auth.token}` };
  else if (
    auth.type === "api_key" &&
    typeof auth.key === "string" &&
    auth.key &&
    typeof auth.email === "string" &&
    auth.email
  )
    headers = { "X-Auth-Key": auth.key, "X-Auth-Email": auth.email };
  else return { error: "Wrangler credentials unavailable" };
  try {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications`, {
      headers,
      signal: AbortSignal.timeout(MINUTE_MS),
    });
    if (!response.ok) return { error: `raw application list HTTP ${response.status}` };
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return { error: "raw application list has no result" };
    const envelope = body as Record<string, unknown>;
    if (envelope.success !== true || !Array.isArray(envelope.result))
      return { error: "raw application list has no successful result" };
    const matches = envelope.result.filter((row) => row && typeof row === "object" && row.name === name);
    if (matches.length !== 1) return { error: `raw application list does not uniquely name ${name}` };
    const state = parseAppState(matches[0]);
    return state?.image ? { value: state } : { error: `raw application list ${name} has no image/version` };
  } catch {
    return { error: "raw application list request or JSON failed" };
  }
}

/** Refuse a known image no-op in the list endpoint Wrangler deploy uses. */
export function botUploadProblem(
  direct: Read<AppState>,
  listed: Read<AppState>,
  selectedImage?: string,
): string | undefined {
  if ("error" in direct) return `direct application read unavailable: ${direct.error}`;
  if ("error" in listed) return `application list unavailable: ${listed.error}`;
  if (
    !direct.value.image ||
    !listed.value.image ||
    ![direct.value.version, listed.value.version].every((version) => Number.isSafeInteger(version) && version >= 0)
  )
    return "application image/version evidence incomplete";
  // List configuration and effective configuration can differ after a rollout.
  // Refuse only the known image no-op: Wrangler would diff the selected image
  // against an equal list image while the effective application targets another.
  if (selectedImage === listed.value.image && selectedImage !== direct.value.image)
    return `application list/direct mismatch: list version ${listed.value.version} image ${listed.value.image} already equals selected ${selectedImage}; direct version ${direct.value.version} image ${direct.value.image}; Wrangler would omit the required image change`;
  return undefined;
}

/** What an application gate knows about the rollout it waits for: the application as read BEFORE
 *  the upload, and the target wrangler's deploy output named (`null`: no container change printed). */
export interface SandboxRollout {
  before: Read<AppState>;
  target: RolloutTarget | null;
}

/**
 * After a bot deploy, poll the two independently managed surfaces: the container
 * application and running singleton must match the selected release, and `/healthz` must
 * serve the full expected commit. Either fact alone is not rollback success.
 */
export async function waitUntilBotLive(
  step: Pick<DeployStep, "name" | "dir" | "botImage">,
  gate: BotLiveGate,
  expectedCommit: string,
  io: Pick<DeployRunnerIO, "log">,
  deps: SandboxGateDeps = defaultSandboxGateDeps,
): Promise<GateOutcome> {
  const started = deps.now();
  for (;;) {
    if (deps.signal?.aborted) return { live: false, reason: "deployment cancelled" };
    const elapsed = deps.now() - started;
    const app = await deps.readAppState(step.dir, gate.containerApp);
    if (deps.signal?.aborted) return { live: false, reason: "deployment cancelled" };
    const instances = await deps.readInstances(step.dir, gate.containerApp);
    if (deps.signal?.aborted) return { live: false, reason: "deployment cancelled" };
    const health = deps.signal
      ? await deps.readHealth(gate.healthUrl, undefined, undefined, deps.signal)
      : await deps.readHealth(gate.healthUrl);
    if (deps.signal?.aborted) return { live: false, reason: "deployment cancelled" };
    const decision = decideBotLive({
      containerApp: gate.containerApp,
      health,
      app,
      expectedImage: step.botImage ?? null,
      instances,
      expectedCommit,
      ...(gate.requireRunningSingleton ? { requireRunningSingleton: true as const } : {}),
      elapsedMs: elapsed,
    });
    if (decision.kind === "live") return { live: true, detail: decision.summary, waitedMs: deps.now() - started };
    if (decision.kind === "failed") return { live: false, reason: decision.reason };
    io.log(
      `[deploy:all] ${step.name}: deployed, not live yet — ${decision.reason} (${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1000)}s)`,
    );
    await deps.sleep(LIVE_GATE_POLL_MS, deps.signal);
  }
}

/**
 * After the sandbox deploy: poll until the Worker serves the deployed commit,
 * the container application has left its pre-deploy version (when wrangler
 * printed a container change), every running instance is on the application's
 * version, and an `echo ok` through the gate's probe thread answers from an
 * instance on that version — logging every poll's first unmet signal. The
 * application is read only once the Worker is live (it means nothing before);
 * the probe is sent and the instances read only once the application has left
 * its pre-deploy version (`rolloutAdvanced`) — a thread placed before then
 * lands on the previous image, the gate's own included, and answers with the
 * SDK skew until the rollout's wave replaces it — and the probe goes BEFORE
 * the instance list so the list includes the probe's own instance. One thread
 * key per deployed commit: the probe holds one fleet slot for the 5-min idle
 * window, not one per poll.
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
    if (deps.signal?.aborted) return { live: false, reason: "deployment cancelled" };
    const elapsed = deps.now() - started;
    const health = deps.signal
      ? await deps.readHealth(gate.healthUrl, bearer, undefined, deps.signal)
      : await deps.readHealth(gate.healthUrl, bearer);
    if (deps.signal?.aborted) return { live: false, reason: "deployment cancelled" };
    const app = decideWorker(health, expectedCommit).ok ? await deps.readAppState(step.dir, gate.containerApp) : null;
    if (deps.signal?.aborted) return { live: false, reason: "deployment cancelled" };
    const registered =
      app !== null &&
      "value" in app &&
      (rollout.target === null || rolloutAdvanced(app.value, rollout.before, rollout.target).ok);
    const probe = registered ? await deps.probeExec(execUrl, bearer, threadKey) : null;
    if (deps.signal?.aborted) return { live: false, reason: "deployment cancelled" };
    const rest = {
      app,
      probe,
      instances: registered ? await deps.readInstances(step.dir, gate.containerApp) : null,
    };
    if (deps.signal?.aborted) return { live: false, reason: "deployment cancelled" };
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
    await deps.sleep(LIVE_GATE_POLL_MS, deps.signal);
  }
}

/** A container application as it stands BEFORE the upload — the version a full deploy must leave.
 *  A failed sandbox read can fall back to the target image; the bot gate fails closed because rollback
 *  needs coherent pre-upload reads before Wrangler computes its diff. */
async function readAppBeforeUpload(
  step: Pick<DeployStep, "name" | "dir">,
  gate: BotLiveGate | SandboxLiveGate,
  io: Pick<DeployRunnerIO, "log">,
  deps: SandboxGateDeps,
): Promise<Read<AppState>> {
  const before = await deps.readAppState(step.dir, gate.containerApp);
  io.log(
    "value" in before
      ? `[deploy:all] ${step.name}: container application at version ${before.value.version}${before.value.image ? ` (image ${shortImage(before.value.image)})` : ""} before the upload`
      : gate.kind === "sandbox"
        ? `[deploy:all] ${step.name}: could not read the container application before the upload — ${before.error}; the gate will need the deploy's image to show`
        : `[deploy:all] ${step.name}: could not read the container application before the upload — ${before.error}; the upload requires a coherent application list/direct read`,
  );
  return before;
}

/** A step's `npm run deploy` in its dir, output streamed — the one spawn `deployStep` makes, injectable. */
export type StepExec = (step: DeployStep, io: DeployRunnerIO, signal?: AbortSignal) => Promise<RunResult>;
const runStepCommand: StepExec = (step, io, signal) =>
  run(step.command[0], step.command.slice(1), {
    cwd: workerDir(step.dir),
    unset: step.unsetEnv,
    set: { ...step.setEnv, ...stampEnvOnHost() },
    stream: (c) => io.stream(c),
    signal,
  });

/** From the package, the commit the step's deploy stamps into its Worker (`deploy/bin/build-stamp.mjs`,
 *  `deploy/cloudflare/write-build.mjs` read it): the package's — the materialised directory has no
 *  git to ask. In a checkout nothing is set and the scripts read the tree. */
function stampEnvOnHost(): Record<string, string> {
  return OPERATOR_ROOT.mode === "package" ? { [BUILD_COMMIT_ENV]: packageSourceOnHost().commit } : {};
}

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
  if (deps.signal?.aborted) return { ok: false, live: "not deployed", reason: "deployment cancelled", noUpload: true };
  let noUpload = true;
  // One `deploy.step.<worker>` root per step on the runner's own output, its
  // live gate a `deploy.wait_live` child carrying the `waitedMs` the "live"
  // line prints (docs/reference/specs/tracing.md item 20; release-and-deploy.md item 19).
  // `slow`: the step always prints, the gate when it took a second or more.
  const root = startProcessRoot(
    { clock: deps.now, sinks: [createLogSink({ level: "slow", write: (line) => io.log(line) })] },
    `deploy.step.${step.name}`,
  );
  try {
    const result = await deployStepTraced(step, plan, expectedCommit, io, deps, exec, root, (mayHaveUploaded) => {
      noUpload = !mayHaveUploaded;
    });
    const r = noUpload ? { ...result, noUpload: true as const } : result;
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
  onUploadState: (mayHaveUploaded: boolean) => void,
): Promise<StepOutcome> {
  const started = deps.now();
  // A step may carry its own budget (the resident's, sized for runs and a
  // provisioning rather than a rollout — plan.ts RESIDENT_WAIT_MAX_MS). A
  // drained fleet (release-and-deploy item 31) waits past a run's whole lease
  // instead: the wait ends when the runs in flight end, and nothing new lands.
  const drain = await beginDrain(step, expectedCommit, io, deps);
  let residentBefore: Read<AppState> | undefined;
  let residentPrintedTarget: RolloutTarget | null | undefined;
  const waitMaxMs = drain.drained
    ? Math.max(step.waitMaxMs ?? plan.waitMaxMs, RESIDENT_DRAINED_WAIT_MAX_MS)
    : (step.waitMaxMs ?? plan.waitMaxMs);
  const deadline = started + waitMaxMs;
  let result: StepOutcome;
  let readyDeadline = 0;
  let resources: string[] = [];
  let retryImageReconcile = true;
  // Once the resident command starts, its upload may have landed even if the
  // command or health read fails. Only a proved pre-upload refusal or an
  // authenticated post-upload image decision makes an explicit lift safe.
  let safeToLift = true;
  try {
    result = await deployStepLoop(
      step,
      plan,
      expectedCommit,
      io,
      deps,
      exec,
      root,
      {
        started,
        waitMaxMs,
        deadline,
        drained: drain.drained,
      },
      (mayHaveUploaded) => {
        onUploadState(mayHaveUploaded);
        if (step.name === "resident") safeToLift = !mayHaveUploaded;
      },
      async () => {
        residentBefore = step.residentContainerApp
          ? await deps.readAppState(step.dir, step.residentContainerApp)
          : undefined;
        return residentBefore;
      },
      (output) => {
        residentPrintedTarget = rolloutTargetFromDeployOutput(output);
      },
    );
    // An informational wake cannot undo a completed non-Resident step.
    // Resident upload still owes its separate reconciliation/readiness below.
    if (deps.signal?.aborted && !(result.ok && step.name !== "resident"))
      return {
        ...result,
        ok: false,
        live: safeToLift ? result.live : "upload outcome uncertain",
        reason: "deployment cancelled",
      };
    if (result.ok && step.name === "resident") {
      readyDeadline = deps.now() + RESIDENT_READY_WAIT_MS;
      // Reconcile only against the new Worker; an old healthy build can stamp
      // the old image current before the platform routes the uploaded version.
      const healthProblem = await waitForResident(step, expectedCommit, readyDeadline, io, deps);
      if (deps.signal?.aborted) return { ok: false, live: "upload outcome uncertain", reason: "deployment cancelled" };
      if (healthProblem) result = residentNotReady(result, healthProblem);
      else {
        const residentAfter = step.residentContainerApp
          ? await deps.readAppState(step.dir, step.residentContainerApp)
          : undefined;
        if (deps.signal?.aborted)
          return { ok: false, live: "upload outcome uncertain", reason: "deployment cancelled" };
        const application = residentApplicationChange(residentBefore, residentAfter, step.residentContainerApp);
        if (application.kind === "unknown") result = residentNotReady(result, application.reason);
        else if (application.kind === "unchanged" && residentPrintedTarget === null) {
          const base = step.drain?.url ?? step.setEnv.RESIDENT_BASE_URL;
          const bearer = RESIDENT_BEARER_ENVS.map((name) => deps.env[name]).find((value) => value?.trim());
          const registry =
            base && bearer && deps.now() < readyDeadline
              ? await deps.readHealth(
                  new URL("/residents", base).toString(),
                  bearer,
                  readyDeadline - deps.now(),
                  deps.signal,
                )
              : { error: "resident origin or read bearer missing" };
          if (deps.signal?.aborted)
            return { ok: false, live: "upload outcome uncertain", reason: "deployment cancelled" };
          const problem = residentImageReportsProblem(registry);
          if (problem) result = residentNotReady(result, problem);
          else {
            resources = (
              "error" in registry ? [] : (registry.body as { residents: { resource: string }[] }).residents
            ).map((row) => row.resource);
            retryImageReconcile = false;
            safeToLift = true;
            io.log(
              `[deploy:all] resident: unchanged container application ${step.residentContainerApp} at version ${application.version} and image ${shortImage(application.image)}; image reconcile skipped`,
            );
          }
        } else {
          // A changed application still uses the existing guarded image cycle.
          // Without this deploy's reconcile, an absent pending marker reads as
          // current even on an old image. Missing reconcile capability fails closed.
          const answer = await reconcileFleet(step, io, deps);
          if (deps.signal?.aborted)
            return { ok: false, live: "upload outcome uncertain", reason: "deployment cancelled" };
          const reconciled = answer && reconciledResources(answer);
          if (!reconciled)
            result = residentNotReady(
              result,
              "reconcile did not confirm the affected fleet; image reports cannot be trusted",
            );
          else {
            resources = reconciled;
            safeToLift = true;
          }
        }
      }
    }
  } finally {
    if (drain.attempted && safeToLift) await endDrain(step, drain, io, deps);
    else if (drain.attempted)
      io.log(
        `[deploy:all] resident: ${drain.drained ? "fleet stays closed" : "any drain that landed stays closed"} — the uploaded image is not reconciled; verify the image and lift with the drain bearer, or wait for the drain backstop${drain.until ? ` at ${drain.until}` : ""}`,
      );
  }
  if (result.ok && step.name === "resident") {
    const problem = await waitForResident(
      step,
      expectedCommit,
      readyDeadline,
      io,
      deps,
      resources,
      retryImageReconcile,
    );
    if (problem) return residentNotReady(result, problem);
    io.log("[deploy:all] resident: live — exact Worker commit, registry undrained, every image report current");
    return { ...result, live: "live" };
  }
  return result;
}

type ResidentApplicationChange =
  { kind: "unchanged"; version: number; image: string } | { kind: "changed" } | { kind: "unknown"; reason: string };

/** Only an authenticated read of the same named application on both sides can skip a container cycle. */
function residentApplicationChange(
  before: Read<AppState> | undefined,
  after: Read<AppState> | undefined,
  name: string | undefined,
): ResidentApplicationChange {
  if (!name || !before || !after) return { kind: "unknown", reason: "named resident container application missing" };
  if ("error" in before)
    return { kind: "unknown", reason: `container application ${name} unreadable before upload: ${before.error}` };
  if ("error" in after)
    return { kind: "unknown", reason: `container application ${name} unreadable after upload: ${after.error}` };
  const prior = before.value;
  const current = after.value;
  if (
    !Number.isSafeInteger(prior.version) ||
    prior.version < 0 ||
    !Number.isSafeInteger(current.version) ||
    current.version < prior.version ||
    typeof prior.image !== "string" ||
    !prior.image.trim() ||
    typeof current.image !== "string" ||
    !current.image.trim()
  )
    return { kind: "unknown", reason: `container application ${name} target is incomplete or regressed` };
  return prior.version === current.version && prior.image === current.image
    ? { kind: "unchanged", version: current.version, image: current.image }
    : { kind: "changed" };
}

function residentNotReady(result: StepOutcome, problem: string): StepOutcome {
  return {
    ...result,
    ok: false,
    live: `deployed, not live: ${problem}`,
    reason: `partial deployment — resident Worker uploaded but NOT ready: ${problem}; no rollback performed`,
  };
}

function uncertainResidentUpload(problem: string): StepOutcome {
  return {
    ok: false,
    live: "deployed, not live: upload outcome uncertain",
    reason: `partial deployment — resident command ended without proving no upload (${problem}); the fleet stays closed until verified recovery or the drain backstop`,
  };
}

/** Reconcile and lift spend the same readiness budget as both read phases;
 *  cleanup still attempts its independently bounded lift after expiry.
 *  Undefined resources means the pre-reconcile health phase. A cleared lift
 *  is not evidence, and --force only bypasses the preflight. */
async function waitForResident(
  step: DeployStep,
  expectedCommit: string,
  deadline: number,
  io: DeployRunnerIO,
  deps: SandboxGateDeps,
  resources?: readonly string[],
  retryImageReconcile = true,
): Promise<string | undefined> {
  const base = step.drain?.url ?? step.setEnv.RESIDENT_BASE_URL;
  if (!base) return "resident base URL missing";
  const bearer = RESIDENT_BEARER_ENVS.map((name) => deps.env[name]).find((value) => value?.trim());
  if (resources && !bearer) return `registry unreadable: no ${RESIDENT_BEARER_ENVS.join(" / ")}`;
  let problem = "readiness deadline expired before readback";
  let lastLoggedProblem = "";
  let lastLoggedAt = -Infinity;
  let nextReconcileAt = 0;
  while (deps.now() < deadline) {
    if (deps.signal?.aborted) return "deployment cancelled";
    const timeoutMs = Math.min(LIVE_GATE_POLL_MS, deadline - deps.now());
    const [health, registry] = await Promise.all([
      deps.readHealth(new URL("/healthz", base).toString(), undefined, timeoutMs, deps.signal),
      resources ? deps.readHealth(new URL("/residents", base).toString(), bearer, timeoutMs, deps.signal) : undefined,
    ]);
    if (deps.signal?.aborted) return "deployment cancelled";
    const problems = [
      residentWorkerProblem(health, expectedCommit),
      registry && residentRegistryProblem(registry, resources),
    ].filter(Boolean);
    if (problems.length === 0 && deps.now() <= deadline) return undefined;
    problem = problems.join("; ") || "readback arrived after the readiness deadline";
    if (problem !== lastLoggedProblem || deps.now() - lastLoggedAt >= MINUTE_MS) {
      io.log(`[deploy:all] resident: waiting for readiness — ${problem}`);
      lastLoggedProblem = problem;
      lastLoggedAt = deps.now();
    }
    // A stopped, idle container cannot report until asked again. Reconcile
    // retries the pending fleet on the same Worker build, without re-uploading
    // the Worker or cycling residents whose reports are already current.
    if (
      retryImageReconcile &&
      resources &&
      deps.now() >= nextReconcileAt &&
      deadline - deps.now() > 2 * LIVE_GATE_POLL_MS &&
      !residentWorkerProblem(health, expectedCommit)
    ) {
      const retry = await reconcileFleet(step, io, deps, false);
      if (deps.signal?.aborted) return "deployment cancelled";
      if (retry && !reconciledResources(retry)) io.log(reconcileLine(step.name, retry));
      nextReconcileAt = deps.now() + MINUTE_MS;
    }
    const left = deadline - deps.now();
    if (left > 0) await deps.sleep(Math.min(LIVE_GATE_POLL_MS, left), deps.signal);
  }
  return `${problem} — readiness not proven within ${RESIDENT_READY_WAIT_MS / MINUTE_MS} min`;
}

/** The fleet drain before the step's first attempt: with the step's drain and its drain bearer
 *  in the env, `POST /drain` for the drained wait plus the margin; the line says what happened.
 *  Without either, the step waits as before and the line says so. `attempted` is whether a
 *  `/drain` was posted at all; `drained` is whether its answer confirmed the record,
 *  which sizes the wait. An upload without reconciliation does not lift it. */
async function beginDrain(
  step: DeployStep,
  expectedCommit: string,
  io: DeployRunnerIO,
  deps: SandboxGateDeps,
): Promise<{ attempted: boolean; drained: boolean; until: string | undefined }> {
  if (deps.signal?.aborted || !step.drain) return { attempted: false, drained: false, until: undefined };
  const bearer = deps.env[step.drain.tokenEnv];
  if (!bearer || !deps.postJson) {
    io.log(drainSkippedLine(step.name, step.drain.tokenEnv));
    return { attempted: false, drained: false, until: undefined };
  }
  const answer = await deps.postJson(
    drainUrl(step.drain.url),
    bearer,
    drainBody(RESIDENT_DRAINED_WAIT_MAX_MS, expectedCommit),
  );
  io.log(drainBeganLine(step.name, answer));
  return { attempted: true, drained: drainSet(answer), until: drainUntil(answer) };
}

/** The reconcile inside the drain window: `POST /reconcile` walks every
 *  resident and restarts each container that predates the image just deployed
 *  while the fleet is still closed; the line says what each resident answered.
 *  Its affected resources must all appear in the readiness readback. */
async function reconcileFleet(
  step: DeployStep,
  io: DeployRunnerIO,
  deps: SandboxGateDeps,
  log = true,
): Promise<PostAnswer | undefined> {
  if (deps.signal?.aborted) return;
  const bearer = step.drain ? deps.env[step.drain.tokenEnv] : undefined;
  if (!step.drain || !bearer || !deps.postJson) return;
  const answer = await deps.postJson(reconcileUrl(step.drain.url), bearer, {});
  if (log) io.log(reconcileLine(step.name, answer));
  return answer;
}

async function endDrain(
  step: DeployStep,
  drain: { drained: boolean; until: string | undefined },
  io: DeployRunnerIO,
  deps: SandboxGateDeps,
): Promise<void> {
  const bearer = step.drain ? deps.env[step.drain.tokenEnv] : undefined;
  if (!step.drain || !bearer || !deps.postJson) return;
  const answer = await deps.postJson(undrainUrl(step.drain.url), bearer, {});
  io.log(drainLiftedLine(step.name, answer, drain));
}

async function deployStepLoop(
  step: DeployStep,
  plan: Pick<DeployPlan, "waitMaxMs" | "pollMs">,
  expectedCommit: string,
  io: DeployRunnerIO,
  deps: SandboxGateDeps,
  exec: StepExec,
  root: Span,
  wait: { started: number; waitMaxMs: number; deadline: number; drained: boolean },
  uploadState: (mayHaveUploaded: boolean) => void = () => {},
  readResidentBeforeUpload: () => Promise<Read<AppState> | undefined> = async () => undefined,
  onResidentOutput: (output: string) => void = () => {},
): Promise<StepOutcome> {
  const { started, waitMaxMs, deadline } = wait;
  for (;;) {
    if (deps.signal?.aborted) return { ok: false, live: "not deployed", reason: "deployment cancelled" };
    io.log(`\n[deploy:all] ▶ ${step.name} (${step.script}) — ${step.dir}: ${step.command.join(" ")}`);
    const application = step.liveGate
      ? { before: await readAppBeforeUpload(step, step.liveGate, io, deps) }
      : undefined;
    if (deps.signal?.aborted) return { ok: false, live: "not deployed", reason: "deployment cancelled" };
    if (step.liveGate?.kind === "bot") {
      const listed = deps.readListedAppState
        ? await deps.readListedAppState(step.dir, step.liveGate.containerApp, step.botAccount ?? "")
        : { error: "application list read unavailable" };
      const problem = botUploadProblem(application!.before, listed, step.botImage);
      if (problem) return { ok: false, live: "not deployed", reason: `bot upload refused: ${problem}` };
    }
    if (deps.signal?.aborted) return { ok: false, live: "not deployed", reason: "deployment cancelled" };
    if (step.name === "resident") {
      const beforeRead = await readResidentBeforeUpload();
      const before = residentApplicationChange(beforeRead, beforeRead, step.residentContainerApp);
      if (before.kind === "unknown")
        return { ok: false, live: "not deployed", reason: `resident upload refused: ${before.reason}` };
      if (deps.signal?.aborted) return { ok: false, live: "not deployed", reason: "deployment cancelled" };
    }
    uploadState(true);
    const r = await exec(step, io, deps.signal);
    if (r.cancelled || deps.signal?.aborted)
      return { ok: false, live: "upload outcome uncertain", reason: "deployment cancelled" };
    if (step.name === "resident") onResidentOutput(r.output);
    const outcome = classifyDeployOutput(r.code, r.output);
    if (outcome.kind === "deployed") {
      if (!step.liveGate) {
        if (step.wakeUrl && step.name !== "resident") await wake(step.name, step.wakeUrl, io, deps.signal);
        return { ok: true, versionId: outcome.versionId, live: "n/a" };
      }
      io.log(
        `[deploy:all] ${step.name}: version ${outcome.versionId ?? "?"} uploaded — waiting until live (commit ${expectedCommit.slice(0, 7)})`,
      );
      const liveGate = step.liveGate;
      // The wait is the step's one child span: `waitedMs` is the number the
      // "live" line below prints, so the log and the span cannot disagree.
      const gate = await root.span("deploy.wait_live", async (wait) => {
        if (!application) throw new Error(`${step.name}: live gate has no application state`);
        const target = liveGate.kind === "sandbox" ? rolloutTargetFromDeployOutput(r.output) : null;
        const from =
          "value" in application.before ? `version ${application.before.value.version}` : "its pre-deploy version";
        if (liveGate.kind === "bot")
          io.log(
            `[deploy:all] bot: gate requires ${step.botImage ?? "the directly read application image"}, unique singleton identity and exact healthy commit ${expectedCommit}`,
          );
        else
          io.log(
            target
              ? `[deploy:all] ${step.name}: wrangler printed a container change — ${target.image ? `image ${shortImage(target.image)}` : "configuration only, image unchanged"}; the application must leave ${from}`
              : `[deploy:all] ${step.name}: wrangler printed no container change — Worker-only deploy, no rollout expected`,
          );
        const g: GateOutcome =
          liveGate.kind === "sandbox"
            ? await waitUntilSandboxLive(
                step,
                liveGate,
                expectedCommit,
                { before: application.before, target },
                io,
                deps,
              )
            : await waitUntilBotLive(step, liveGate, expectedCommit, io, deps);
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
    if (outcome.kind === "preflight-refused" && step.name === "resident") {
      // Only the structured resident preflight refusal, with no upload line,
      // proves that this attempt did not change the Worker image.
      if (
        !/^\[resident-preflight\] preflight REFUSED:/m.test(r.output) ||
        /\bUploaded\b|Current Version ID:/i.test(r.output)
      )
        return uncertainResidentUpload(outcome.reason);
      uploadState(false);
    }
    if (
      outcome.kind === "preflight-refused" &&
      step.name !== "resident" &&
      !/\bUploaded\b|Current Version ID:/i.test(r.output)
    )
      uploadState(false);
    if (outcome.kind === "preflight-refused" && step.retryOnPreflightRefusal) {
      if (deps.signal?.aborted) return { ok: false, live: "not deployed", reason: "deployment cancelled" };
      const left = deadline - deps.now();
      // The budget ran out with the refusal standing: the step FAILS by name,
      // never a deploy over what refused (liveGate.ts `preflightGaveUpLine`).
      if (left <= 0)
        return {
          ok: false,
          live: "not deployed",
          reason: preflightGaveUpLine(waitMaxMs, outcome.reason) + (wait.drained ? DRAINED_GAVE_UP_SUFFIX : ""),
        };
      // Never a silent wait: say what is in flight and how far into the budget we are.
      const body = step.healthUrl ? await fetchHealthz(step.healthUrl, deps.signal) : undefined;
      if (deps.signal?.aborted) return { ok: false, live: "not deployed", reason: "deployment cancelled" };
      io.log(
        step.healthUrl
          ? heartbeatLine(step.name, body, deps.now() - started, waitMaxMs)
          : `[deploy:all] ${step.name}: still waiting — ${outcome.reason}`,
      );
      io.log(`[deploy:all] ${step.name}: retrying in ${plan.pollMs / 1000}s (${Math.ceil(left / 60_000)} min left)`);
      // The injected clock (the default is the real one): a test drives the wait without waiting.
      await deps.sleep(plan.pollMs, deps.signal);
      continue;
    }
    if (step.name === "resident" && outcome.kind === "failed") return uncertainResidentUpload(outcome.reason);
    return { ok: false, live: "not deployed", reason: outcome.reason };
  }
}

/** Host signal ownership lasts only for this deployment. Force kill or runner
 * loss cannot execute cleanup; an interrupted command retains unknown upload. */
export async function runDeployPlanOnHost(
  plan: DeployPlan,
  io: DeployRunnerIO,
  deps: SandboxGateDeps = defaultSandboxGateDeps,
): Promise<DeployRunResult> {
  const control = new AbortController();
  const signal = deps.signal ? AbortSignal.any([control.signal, deps.signal]) : control.signal;
  const stop = () => control.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await runDeployPlan(plan, io, {
      ...deps,
      signal,
      readHealth: (url, bearer, timeout) =>
        signal.aborted
          ? Promise.resolve({ error: "deployment cancelled" })
          : deps.readHealth(url, bearer, timeout, signal),
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

/** Execute a plan for real: pre-checks, then the steps in order, stopping at
 *  the first failure so the order holds (later Workers are NOT deployed). */
export async function runDeployPlan(
  input: DeployPlan,
  io: DeployRunnerIO,
  originalDeps: SandboxGateDeps = defaultSandboxGateDeps,
): Promise<DeployRunResult> {
  if (originalDeps.signal?.aborted) return { kind: "refused", problems: ["deployment cancelled"] };
  const plan = structuredClone(input);
  if (plan.steps.length === 0) return runSelectedDeployPlan(plan, io, originalDeps);
  const directory = mkdtempSync(join(tmpdir(), "switchboard-plan-native-"));
  const config = join(directory, "wrangler.jsonc");
  const uploadConfigs: string[] = [];
  try {
    writeFileSync(config, JSON.stringify({ account_id: plan.checks.account }));
    const deps: SandboxGateDeps = {
      ...originalDeps,
      readAppState: (dir, app) => originalDeps.readAppState(dir, app, config),
      readInstances: (dir, app) => originalDeps.readInstances(dir, app, config),
    };
    return await runSelectedDeployPlan(plan, io, deps, uploadConfigs);
  } finally {
    for (const path of uploadConfigs) rmSync(path, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}

async function runSelectedDeployPlan(
  plan: DeployPlan,
  io: DeployRunnerIO,
  deps: SandboxGateDeps = defaultSandboxGateDeps,
  uploadConfigs: string[] = [],
): Promise<DeployRunResult> {
  const cancelled = () => deps.signal?.aborted === true;
  if (cancelled()) return { kind: "refused", problems: ["deployment cancelled"] };
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
  // From the package, the Worker directories first: copied from the shipped tree and installed, so
  // the pre-checks' wrangler and the steps' have somewhere to run (a checkout is its own work area
  // and this does nothing). Then the Worker configs: they are rendered from the profile (gitignored,
  // so the tree stays clean), and everything after — the capability pre-checks, wrangler — reads the
  // account and names from them.
  const ready = await ensureWorkAreaOnHost(
    plan.steps.map((s) => s.dir),
    (l) => io.log(l),
  );
  if (cancelled()) return { kind: "refused", problems: ["deployment cancelled"] };
  if (!ready.ok) return { kind: "refused", problems: [ready.problem] };
  const selectedConfigs = new Map<string, string>();
  const renderProblems = await renderWorkerConfigsOnHost(
    io,
    process.env,
    async (path, text) => {
      await hostDeployFiles.write(path, text);
      // A sibling keeps Wrangler's relative source/image paths intact. Each
      // operation owns its copy; shared generated configs cannot redirect it.
      const selected = join(dirname(workerDir(path)), `.wrangler-plan-${randomUUID()}.jsonc`);
      writeFileSync(selected, text, { flag: "wx", mode: 0o400 });
      uploadConfigs.push(selected);
      selectedConfigs.set(path, selected);
    },
    { origin: plan.profile.origin, path: plan.profile.path, profile: plan.profile.selection },
  );
  if (cancelled()) return { kind: "refused", problems: ["deployment cancelled"] };
  if (renderProblems.length > 0) return { kind: "refused", problems: renderProblems };
  for (const step of plan.steps) {
    const config = selectedConfigs.get(`${step.dir}/${RENDERED_FILE}`);
    if (!config) return { kind: "refused", problems: [`${step.name}: selected Worker configuration was not rendered`] };
    step.command.push("--", "--config", config);
    step.setEnv.SWITCHBOARD_DEPLOY_CONFIG = config;
  }
  const problems = await preChecks(plan, io, deps.signal);
  if (cancelled()) return { kind: "refused", problems: ["deployment cancelled"] };
  if (problems.length > 0) return { kind: "refused", problems };
  // The commit being deployed — what a gated Worker's /healthz must report
  // before its step counts as live. In a checkout, HEAD, read AFTER the origin/main check;
  // from the package, the commit it was built from (its `source.json`), which the steps stamp
  // into their Workers (`stampEnvOnHost`). If git fails this is "" and `sameCommit` refuses
  // anything under 7 chars, so the gate fails closed (never a false "live") — and we say so up
  // front rather than 18 min later; a package built from a dirty tree carries `-dirty` and is
  // refused the same way.
  const expectedCommit =
    plan.root.mode === "checkout"
      ? (await run("git", ["rev-parse", "HEAD"], { cwd: OPERATOR_ROOT.root, signal: deps.signal })).output.trim()
      : packageSourceOnHost().commit;
  if (cancelled()) return { kind: "refused", problems: ["deployment cancelled"] };
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
    return {
      kind: "refused",
      problems: [
        plan.root.mode === "checkout"
          ? `could not read HEAD (\`git rev-parse HEAD\` gave ${JSON.stringify(expectedCommit.slice(0, 40))}); the live gates need the commit being deployed`
          : `the package was built from ${JSON.stringify(expectedCommit.slice(0, 48))}, not a commit — a release build carries the release commit; the live gates need it`,
      ],
    };
  }

  // The bot reads its config from the state Worker, so the bot step is preceded
  // by a push of this installation's config from wherever the profile says it
  // lives. Read and validated HERE, before any Worker deploys: an unreadable
  // source or an invalid config is a refusal up front, not a bot that fails to
  // start after the memory Worker has already rolled.
  let configPublication: PreparedConfigPublication | undefined;
  let configSource: ConfigSourceObservation | undefined;
  const stateWorkerUrl = plan.config.stateWorkerUrl;
  if (plan.steps.some((s) => s.name === "bot")) {
    if (stateWorkerUrl === undefined) {
      io.warn(
        "[deploy:all] config: the profile has no state Worker — nothing is pushed; the bot reads SWITCHBOARD_CONFIG",
      );
    } else {
      const read = await readConfigForPush(plan.config.source);
      if (cancelled()) return { kind: "refused", problems: ["deployment cancelled"] };
      if (!read.ok) return { kind: "refused", problems: [read.problem] };
      const identity = parseConfigConsumerIdentity(JSON.stringify({ commit: expectedCommit }));
      if (!identity.ok) return { kind: "refused", problems: [identity.problem] };
      const bot = plan.steps.find((step) => step.name === "bot");
      if (!bot || bot.liveGate?.kind !== "bot")
        return { kind: "refused", problems: ["config input source needs an actual bot application binding"] };
      const [sourceHealth, sourceApp, sourceInstances] = await Promise.all([
        deps.readHealth(bot.liveGate.healthUrl),
        deps.readAppState(bot.dir, bot.liveGate.containerApp),
        deps.readInstances(bot.dir, bot.liveGate.containerApp),
      ]);
      if (cancelled()) return { kind: "refused", problems: ["deployment cancelled"] };
      const observed = configSourceObservation(sourceHealth, sourceApp, sourceInstances);
      const original = plan.config.originalSource;
      const input = observed.ok
        ? observed.source
        : original && originalConfigSourceObservation(original, sourceApp, sourceInstances)
          ? original
          : undefined;
      if (!input || !unchangedConfigSourceApplication(input, sourceApp))
        return {
          kind: "refused",
          problems: [observed.ok ? "config source native application changed" : observed.problem],
        };
      if (
        original &&
        observed.ok &&
        (original.key !== observed.source.key ||
          original.version !== observed.source.version ||
          original.sha256 !== observed.source.sha256 ||
          !unchangedConfigSourceApplication(original, sourceApp))
      )
        return { kind: "refused", problems: ["original config source changed; reconcile current settings"] };
      const prepared = await prepareConfigPublication(read, {
        stateWorkerUrl,
        key: consumerConfigKey(identity.identity),
        consumer: identity.identity,
        inputSourceKey: input.key,
        expectedInputSource: { version: input.version, sha256: input.sha256 },
        env: process.env,
        onSnapshot: (key) =>
          io.log(`[deploy:all] config: input snapshot "${key}" (private data, not restoration authority)`),
      });
      if (cancelled()) return { kind: "refused", problems: ["deployment cancelled"] };
      if (!prepared.ok) return { kind: "refused", problems: [prepared.problem] };
      configPublication = prepared.publication;
      configSource = input;
      io.log(
        `[deploy:all] config: ${read.how} validates; frozen "${configPublication.key}" v${configPublication.prior.version} ` +
          `(sha256 ${configPublication.prior.document?.sha256 ?? "absent"}); candidate sha256 ${configPublication.candidate.sha256}`,
      );
    }
  }
  for (const w of plan.warnings) io.warn(`[deploy:all] WARNING ${w}`);

  // The supersede guard (src/deploy/supersede.ts, release-and-deploy.md item 32): each
  // selected Worker's live build.commit is read before anything uploads, and a live
  // commit that already contains the commit being deployed — an older release's re-run
  // queued behind the newer one that went live — refuses the Worker by name. Forced,
  // it deploys anyway and the warning says a deliberate rollback is happening.
  const supersede = await supersededSteps(plan, expectedCommit, {
    env: deps.env,
    readLive: async (url, bearerEnv) => {
      const bearer = bearerEnv ? deps.env[bearerEnv] : undefined;
      const r = await readHealthz(url, bearer, undefined, deps.signal);
      return "body" in r && r.status >= 200 && r.status < 300 ? r.body : undefined;
    },
    liveContains: async (deploying, live) => {
      if (cancelled()) return undefined;
      const r = await run("git", ["merge-base", "--is-ancestor", deploying, live], {
        cwd: OPERATOR_ROOT.root,
        signal: deps.signal,
      });
      return r.code === 0 ? true : r.code === 1 ? false : undefined;
    },
  });
  if (cancelled()) return { kind: "refused", problems: ["deployment cancelled"] };
  for (const note of supersede.notes) io.warn(`[deploy:all] WARNING ${note}`);
  if (supersede.problems.length > 0) return { kind: "refused", problems: supersede.problems };

  // The plane's deploy window (record 0064, "The queue"): opened before the
  // first Worker uploads when the bot rolls — an ask that arrives mid-roll
  // queues on `deploy_settled` — and lifted in the `finally`, landed or
  // failed alike, so a broken run never leaves asks queued forever.
  const planeDeploy =
    plan.steps.some((s) => s.name === "bot") && stateWorkerUrl !== undefined
      ? { stateWorkerUrl, env: process.env, log: (l: string) => io.log(l) }
      : undefined;
  if (planeDeploy) await postPlaneDeploy(planeDeploy, "pending", expectedCommit);
  const results: DeployStepResult[] = [];
  let windowSettled = true;
  try {
    for (const step of plan.steps) {
      if (deps.signal?.aborted) break;
      if (step.name === "bot" && configPublication) {
        // After the memory step (the document lives there), before the bot rolls (it reads it on start).
        const currentApp =
          step.liveGate?.kind === "bot"
            ? await deps.readAppState(step.dir, step.liveGate.containerApp)
            : { error: "bot application unavailable" };
        if (cancelled()) break;
        if (!configSource || !unchangedConfigSourceApplication(configSource, currentApp)) {
          results.push({
            name: step.name,
            script: step.script,
            live: "not deployed",
            status: "FAILED: original config source application target changed before activation",
          });
          break;
        }
        const pushed = await publishConfigPublication(configPublication, { env: process.env });
        if (cancelled()) break;
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
          `[deploy:all] config: ${pushed.how} → document "${configPublication.key}" v${pushed.version} on ${stateWorkerUrl} (sha256 ${pushed.sha256.slice(0, 12)}, ${pushed.bytes} bytes)`,
        );
      }
      if (deps.signal?.aborted) break;
      if (!(await ensureNodeModules(step, io, deps.signal))) {
        if (deps.signal?.aborted) windowSettled = false;
        results.push({ name: step.name, script: step.script, live: "not deployed", status: "npm ci failed" });
        break;
      }
      if (cancelled()) break;
      windowSettled = false;
      const acceptanceStep =
        step.liveGate?.kind === "bot" && configPublication
          ? { ...step, liveGate: { ...step.liveGate, requireRunningSingleton: true as const } }
          : step;
      let r = await deployStep(acceptanceStep, plan, expectedCommit, io, deps);
      windowSettled = r.noUpload === true || r.ok;
      if (r.ok && !deps.signal?.aborted && step.liveGate?.kind === "bot" && configPublication) {
        const client = new ConfigDocumentClient({
          baseUrl: configPublication.stateWorkerUrl,
          token: process.env[STATE_WORKER_TOKEN_ENV] ?? "",
        });
        const [health, app, instances] = await Promise.all([
          deps.readHealth(step.liveGate.healthUrl),
          deps.readAppState(step.dir, step.liveGate.containerApp),
          deps.readInstances(step.dir, step.liveGate.containerApp),
        ]);
        const confirmed = cancelled()
          ? { ok: false as const, problem: "deployment cancelled" }
          : await confirmConsumerConfigPublication(
              configPublication,
              { commit: expectedCommit },
              health,
              app,
              instances,
              (key) => client.readBase(key),
              step.botImage,
            );
        if (cancelled())
          r = { ...r, ok: false, live: "deployed, not live: deployment cancelled", reason: "deployment cancelled" };
        else if (!confirmed.ok) {
          const observed = {
            applicationVersion: "value" in app ? app.value.version : "unreadable",
            instances:
              "value" in instances
                ? instances.value.slice(0, 10).map(({ state, version }) => ({ state, version }))
                : "unreadable",
          };
          io.log(`[deploy:all] bot: final readiness evidence ${JSON.stringify(observed)}`);
          r = { ...r, ok: false, live: `deployed, not live: ${confirmed.problem}`, reason: confirmed.problem };
        }
      }
      // wrangler always prints `Current Version ID`; a deploy that exits 0 without one is odd enough to say so.
      results.push({
        name: step.name,
        script: step.script,
        ...(r.versionId !== undefined ? { versionId: r.versionId } : {}),
        live: r.live,
        status: r.ok ? (r.versionId ? "deployed" : "deployed (no version id in output?)") : `FAILED: ${r.reason}`,
      });
      if (!r.ok) {
        io.warn(
          `[deploy:all] ${step.name} failed — stopping here so the order holds (later Workers were NOT deployed)`,
        );
        break;
      }
    }
  } finally {
    // A cancelled active command cannot certify observer-window settlement.
    // Lifting a known settled window certifies neither readiness nor native ending.
    if (planeDeploy && (!cancelled() || windowSettled)) await postPlaneDeploy(planeDeploy, "landed", expectedCommit);
  }
  const notAttempted = plan.steps.slice(results.length).map((s) => s.name);
  const ok =
    !cancelled() &&
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

/**
 * The `AffectedProbe` from the published package, where there is no tree to
 * diff: HEAD is the commit the package was built from, and a live Worker is
 * read as the host probe reads it. A Worker serving that commit has nothing
 * to deploy (the pure half compares before it asks anything else); every other
 * Worker is unsure — no ancestry, no release tag, no diff — and deploys with
 * the reason named. Honest, never narrower than the truth.
 */
export function packageAffectedProbe(host: Pick<AffectedProbe, "liveCommit">, commit: string): AffectedProbe {
  return {
    head: async () => commit,
    liveCommit: host.liveCommit,
    // A commit is its own ancestor — the one ancestry a package can vouch for; every other is unknown.
    isAncestor: async (c, head) => head.startsWith(c),
    lastRelease: async () => undefined,
    changedPaths: async () => undefined,
    fileAt: async () => undefined,
  };
}

/** `deploy plan|all --affected` on the host: the selection over this checkout
 *  (or the package's commit) and the live fleet — the fleet being the installation the profile names. */
export async function computeAffectedOnHost(opts: { base?: string }): Promise<AffectedReport> {
  const { profile } = await loadProfileOnHost();
  const host = hostAffectedProbe(workersFor(profile));
  const probe = OPERATOR_ROOT.mode === "checkout" ? host : packageAffectedProbe(host, packageSourceOnHost().commit);
  return computeAffected(probe, opts);
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
      /** The durable config document this run proved current before POSTing. */
      configGeneration?: string;
      previousStartedAt?: string;
      startedAt?: string;
      waitedMs: number;
      reason?: string;
    };

/** The runner's I/O, injectable so the loop is unit-tested without a network or a clock. */
export interface RestartRunnerDeps {
  env: Record<string, string | undefined>;
  publisherIdentity: () => Promise<{ ok: true; identity: ConfigConsumerIdentity } | { ok: false; problem: string }>;
  actualConsumer: (target: ConfigConsumerTarget) => Promise<ActualConfigConsumerBinding>;
  /** The profile's current config source, validated exactly as deploy config reads it. */
  readConfig: (source: string) => Promise<ConfigRead>;
  /** The durable base document and its ConfigDO version. */
  readBase: (
    target: { stateWorkerUrl: string; key: string },
    env: Record<string, string | undefined>,
  ) => Promise<ReadBaseOutcome>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const defaultRestartRunnerDeps: RestartRunnerDeps = {
  env: process.env,
  publisherIdentity: configPublisherIdentityOnHost,
  actualConsumer: readActualConfigConsumerOnHost,
  readConfig: (source) => readConfigForPush(source),
  readBase: async (target, env) => {
    const token = env[STATE_WORKER_TOKEN_ENV];
    if (!token)
      return {
        ok: false,
        problem: `${STATE_WORKER_TOKEN_ENV} is not set — deploy restart reads document "${target.key}" from ${target.stateWorkerUrl}`,
      };
    return new ConfigDocumentClient({ baseUrl: target.stateWorkerUrl, token }).readBase(target.key);
  },
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

export type RestartConfigReadiness =
  | {
      ok: true;
      generation: string;
      pushedAt: string;
      source: string;
      consumer: ConfigConsumerIdentity;
      key: string;
      version: number;
      sha256: string;
      application: { version: number; image: string | null };
    }
  | { ok: false; problem: string };

/** Prove the durable base is the config source this command would push now.
 * Compare both clocks when the source exposes one (filesystem mtime or the
 * remote Last-Modified) and always compare the digest: neither a preserved
 * timestamp nor a changed-then-restored source can silently restart stale. */
export async function restartConfigReadiness(
  plan: RestartPlan,
  deps: Pick<RestartRunnerDeps, "env" | "readConfig" | "readBase" | "publisherIdentity" | "actualConsumer">,
): Promise<RestartConfigReadiness> {
  const stateWorkerUrl = plan.config.stateWorkerUrl;
  if (stateWorkerUrl === undefined)
    return {
      ok: false,
      problem: "the deployment profile has no state Worker — `deploy restart` cannot identify a base config generation",
    };
  if (
    plan.consumerTarget.stateWorkerUrl !== stateWorkerUrl ||
    plan.consumerTarget.healthUrl !== plan.healthUrl ||
    plan.consumerTarget.adminUrl !== plan.adminUrl
  )
    return { ok: false, problem: "restart endpoints differ from the frozen deployment target" };
  const publisher = await deps.publisherIdentity();
  if (!publisher.ok) return publisher;
  const binding = await deps.actualConsumer(plan.consumerTarget);
  const current = eligibleConfigPublicationConsumer(
    publisher.identity,
    binding.health,
    binding.application,
    binding.instances,
  );
  if (!current.ok) return current;
  const key = current.consumer.key;
  const source = await deps.readConfig(plan.config.source);
  if (!source.ok) return source;
  const base = await deps.readBase({ stateWorkerUrl, key }, deps.env);
  if (!base.ok) return base;
  if (!base.document)
    return {
      ok: false,
      problem: `config: missing base document "${key}" — run \`deploy config\` first`,
    };
  const generation = `${key} v${base.version}`;
  const sourceModifiedAt = source.modifiedAt;
  const pushedAtMs = Date.parse(base.document.pushedAt);
  const modifiedAtMs = sourceModifiedAt === undefined ? Number.NaN : Date.parse(sourceModifiedAt);
  const sourceIsNewer = Number.isFinite(modifiedAtMs) && Number.isFinite(pushedAtMs) && modifiedAtMs > pushedAtMs;
  if (sourceIsNewer || base.document.sha256 !== sha256Hex(source.text))
    return {
      ok: false,
      problem:
        `base document "${key}" v${base.version} (pushed ${base.document.pushedAt}) is older than ` +
        `${source.how}${sourceIsNewer ? ` (source changed ${sourceModifiedAt})` : " (content differs)"} — ` +
        "run `deploy config` first",
    };
  return {
    ok: true,
    generation,
    pushedAt: base.document.pushedAt,
    source: base.document.source,
    consumer: publisher.identity,
    key,
    version: base.version,
    sha256: base.document.sha256,
    application: "value" in binding.application ? { ...binding.application.value } : { version: -1, image: null },
  };
}

/**
 * Restart the bot container without a build: POST the Worker's `/admin/restart`
 * (bearer from `plan.tokenEnv`); a 409 (the bot not answering with JSON — the
 * fail-closed cases; runs in flight hand off and never refuse, run-history item
 * 39) is waited out with a heartbeat and retried every `pollMs` up to
 * `waitMaxMs`, then FAILS by name — never forced unless the plan says so; then poll `/healthz` until a
 * non-draining container reports a `startedAt` later than the old one's
 * (`decideRestarted`), logging every poll so the drain is visible.
 */
export async function runBotRestart(
  input: RestartPlan,
  io: Pick<DeployRunnerIO, "log" | "warn">,
  deps: RestartRunnerDeps = defaultRestartRunnerDeps,
): Promise<RestartRunResult> {
  const plan = Object.freeze({
    ...input,
    config: Object.freeze({ ...input.config }),
    consumerTarget: Object.freeze({ ...input.consumerTarget }),
  });
  const token = deps.env[plan.tokenEnv];
  if (!token)
    return {
      kind: "refused",
      problems: [
        `${plan.tokenEnv} is not set in the environment — a SWITCHBOARD_INGRESS_TOKENS bearer whose identity carries deploy:write`,
      ],
    };
  const config = await restartConfigReadiness(plan, deps);
  if (!config.ok) return { kind: "refused", problems: [config.problem] };
  const configGeneration = config.generation;
  const tag = "deploy:restart";
  io.log(
    `[${tag}] config: ${configGeneration} from ${config.source} (pushed ${config.pushedAt}) — restarting onto this generation`,
  );
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
        configGeneration,
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
          configGeneration,
          waitedMs: deps.now() - started,
          reason: preflightGaveUpLine(plan.waitMaxMs, outcome.reason, RESTART_GAVE_UP_WORDS),
        };
      const body = await fetchHealthzWith(deps, plan.healthUrl);
      io.log(heartbeatLine(plan.target, body, deps.now() - started, plan.waitMaxMs, tag));
      io.log(`[${tag}] ${plan.target}: retrying in ${plan.pollMs / 1000}s (${Math.ceil(left / 60_000)} min left)`);
      await deps.sleep(plan.pollMs);
      continue;
    }
    return {
      kind: "ran",
      ok: false,
      target: plan.target,
      configGeneration,
      waitedMs: deps.now() - started,
      reason: outcome.reason,
    };
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
      const binding = await deps.actualConsumer(plan.consumerTarget);
      const current = eligibleConfigPublicationConsumer(
        config.consumer,
        binding.health,
        binding.application,
        binding.instances,
      );
      if (
        !current.ok ||
        "error" in binding.application ||
        binding.application.value.version !== config.application.version ||
        binding.application.value.image !== config.application.image ||
        current.consumer.key !== config.key ||
        current.consumer.version !== config.version ||
        current.consumer.sha256 !== config.sha256
      ) {
        return {
          kind: "ran",
          ok: false,
          target: plan.target,
          configGeneration,
          waitedMs: deps.now() - started,
          reason: current.ok ? "restart did not preserve the exact consumer/application/config tuple" : current.problem,
        };
      }
      io.log(
        `[${tag}] ${plan.target}: restarted — startedAt ${d.startedAt} (was ${previousStartedAt ?? "unknown"}), live after ${Math.round(elapsed / 1000)}s`,
      );
      return {
        kind: "ran",
        ok: true,
        target: plan.target,
        configGeneration,
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
        configGeneration,
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
