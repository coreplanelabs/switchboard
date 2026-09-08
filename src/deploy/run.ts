import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeAffected, formatAffectedText, type AffectedProbe, type AffectedReport } from "./affected.js";
import {
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
  UNSET_ENV,
  workersFor,
  type DeployPlan,
  type DeployStep,
  type TokenVerifyResult,
  type WorkerDef,
  type WorkerName,
} from "./plan.js";
import { parseConfigSource, readConfigSource, sourceIsDestination, type ConfigSourceIO } from "./configSource.js";
import {
  isExampleProfile,
  parseProfile,
  PROFILE_ENV,
  PROFILE_EXAMPLE_PATH,
  PROFILE_PATH,
  type LoadedProfile,
} from "./profile.js";
import { classifyRestartResponse, type RestartPlan } from "./restart.js";

// The production deploy RUNNER behind the registry's `deploy all` (CLI only):
// runs the four Workers' `npm run deploy` in the plan's canonical order
// (src/deploy/plan.ts), after checking the wrangler account, a clean checkout
// at origin/main, required env, and node_modules per dir. A step whose
// preflight refuses (runs in flight) is waited out and retried — never forced
// unless the plan says so — and the wait is never silent: every poll prints a
// heartbeat with the in-flight count. The bot step is done only when it is
// LIVE, not merely deployed: after `wrangler deploy` the old container keeps
// answering while it drains (up to 15 min), so the runner polls `/healthz`
// until a non-draining container reports the deployed commit as its
// `build.commit` (2026-08-30 05:12Z: the script said `deployed` and exited 0
// while the old container was still draining two runs). Only this file touches
// processes; the plan and the live decision are pure and unit-tested, and the
// command (src/core/commands/deploy.ts) maps this result onto the registry's
// error vocabulary.

const REPO_ROOT = join(import.meta.dirname, "..", "..");

interface RunResult {
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
  /** The step never deployed because its preflight was still refusing when the
   *  wait budget ran out — runs in flight, a drain under way. Nothing is
   *  broken and nothing needs changing: the same deploy later succeeds once
   *  they finish. Absent on every other outcome, so the caller can tell
   *  "wait and retry" from "fix something". */
  preflightTimedOut?: true;
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

async function preChecks(plan: DeployPlan, io: DeployRunnerIO): Promise<string[]> {
  const problems: string[] = [];
  const who = await run("npx", ["wrangler", "whoami"], { cwd: join(REPO_ROOT, "deploy/cloudflare"), unset: UNSET_ENV });
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
      if (!r)
        checked.set(key, (r = run("npx", [...check.command], { cwd: join(REPO_ROOT, step.dir), unset: UNSET_ENV })));
      const result = await r;
      const problem = capabilityProblem(step.name, check, result.code, result.output);
      if (problem) problems.push(problem);
      else io.log(`[deploy:all] ${step.name}: credential can \`${key}\` (${check.needs})`);
    }
  }
  const status = await run("git", ["status", "--porcelain"], { cwd: REPO_ROOT });
  if (status.output.trim() !== "")
    problems.push(
      "working tree is not clean — commit, stash, or deploy from a fresh checkout (wrangler builds the CURRENT tree)",
    );
  if (plan.checks.atOriginMain) {
    // A failed fetch would let the check pass against a stale origin/main — treat it as a problem, not a warning.
    const fetch = await run("git", ["fetch", "-q", "origin"], { cwd: REPO_ROOT });
    if (fetch.code !== 0)
      problems.push(
        `git fetch origin failed (exit ${fetch.code}): ${fetch.output.trim().split("\n").pop() ?? ""} — cannot verify HEAD == origin/main`,
      );
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })).output.trim();
    const main = (await run("git", ["rev-parse", "origin/main"], { cwd: REPO_ROOT })).output.trim();
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

/** The plan's `CheckoutProbe`: `<repo root>/<dir>/node_modules` exists. */
export function hasNodeModules(dir: string): boolean {
  return existsSync(join(REPO_ROOT, dir, "node_modules"));
}

/**
 * The deployment profile on this host: `$SWITCHBOARD_DEPLOY_PROFILE`, else
 * `deploy/profile.json`, else the checked-in example — which a plan may be
 * read from (a pull request's CI, a fresh clone) and `deploy all` refuses. An
 * unreadable or invalid profile is an error naming the file and each problem;
 * never a silent fall-through to the example.
 */
export async function loadProfileOnHost(env: Record<string, string | undefined> = process.env): Promise<LoadedProfile> {
  const override = env[PROFILE_ENV];
  const candidates: { path: string; origin: LoadedProfile["origin"] }[] = override
    ? [{ path: override, origin: "profile" }]
    : [
        { path: PROFILE_PATH, origin: "profile" },
        { path: PROFILE_EXAMPLE_PATH, origin: "example" },
      ];
  for (const c of candidates) {
    const abs = c.path.startsWith("/") ? c.path : join(REPO_ROOT, c.path);
    if (!existsSync(abs)) {
      if (c.origin === "profile" && override) throw new Error(`${PROFILE_ENV}=${override}: no such file`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(abs, "utf8"));
    } catch (err) {
      throw new Error(`${c.path}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    const parsed = parseProfile(raw);
    if (!parsed.ok) throw new Error(`${c.path}: invalid deployment profile —\n  - ${parsed.problems.join("\n  - ")}`);
    // The example is the example wherever it was read from — a copy of it
    // pointed at by the env var, too — so the runner's refusal holds.
    return { profile: parsed.profile, origin: isExampleProfile(parsed.profile) ? "example" : c.origin, path: c.path };
  }
  throw new Error(`no deployment profile: write ${PROFILE_PATH} (see ${PROFILE_EXAMPLE_PATH}) or set ${PROFILE_ENV}`);
}

/** The config-source loaders' I/O on this host: files under the repo root, real fetch, the `op` CLI. */
function hostConfigSourceIO(): ConfigSourceIO {
  return {
    readFile: async (path) => {
      const abs = path.startsWith("/") ? path : join(REPO_ROOT, path);
      return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    },
    fetch: async (url, init) => {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      return { status: res.status, text: () => res.text() };
    },
    opRead: async (ref) => {
      const r = await run("op", ["read", ref], { cwd: REPO_ROOT });
      return r.code === 127 ? undefined : r;
    },
    env: process.env,
  };
}

/**
 * Place the bot's runtime config where the image build reads it, from the
 * profile's `configSource`. A path source that already IS the destination is
 * a no-op (the file is in the tree); anything else is written over whatever
 * is there. Returns the problem, if any, for the runner to refuse on.
 */
export async function materializeConfig(
  plan: DeployPlan,
  io: DeployRunnerIO,
  sourceIO: ConfigSourceIO = hostConfigSourceIO(),
): Promise<string | undefined> {
  const parsed = parseConfigSource(plan.config.source);
  if (!parsed.ok) return parsed.problem;
  if (sourceIsDestination(parsed.source, plan.config.destination)) {
    io.log(`[deploy:all] config: ${plan.config.destination} is in the tree`);
    return undefined;
  }
  const read = await readConfigSource(parsed.source, sourceIO);
  if (!read.ok) return read.problem;
  writeFileSync(join(REPO_ROOT, plan.config.destination), read.text);
  io.log(`[deploy:all] ${read.how} → ${plan.config.destination}`);
  return undefined;
}

async function ensureNodeModules(step: DeployStep, io: DeployRunnerIO): Promise<boolean> {
  const dir = join(REPO_ROOT, step.dir);
  if (hasNodeModules(step.dir)) return true;
  io.log(`[deploy:all] ${step.name}: node_modules missing — npm ci`);
  const r = await run("npm", ["ci", "--silent"], { cwd: dir });
  if (r.code !== 0) io.warn(r.output);
  return r.code === 0;
}

/** GET a `/healthz`; undefined when unreachable or not JSON (never throws). */
async function fetchHealthz(url: string): Promise<HealthzBody | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return parseHealthz(await res.text());
  } catch {
    return undefined;
  }
}

interface StepOutcome {
  ok: boolean;
  versionId?: string;
  live: string;
  reason?: string;
  preflightTimedOut?: true;
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
): Promise<{ live: true; commit: string; waitedMs: number } | { live: false; reason: string }> {
  const started = Date.now();
  for (;;) {
    const elapsed = Date.now() - started;
    const body = await fetchHealthz(healthUrl);
    const d = decideLive(body, expectedCommit, elapsed);
    if (d.kind === "live") return { live: true, commit: d.commit, waitedMs: elapsed };
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

async function deployStep(
  step: DeployStep,
  plan: DeployPlan,
  expectedCommit: string,
  io: DeployRunnerIO,
): Promise<StepOutcome> {
  const started = Date.now();
  const deadline = started + plan.waitMaxMs;
  for (;;) {
    io.log(`\n[deploy:all] ▶ ${step.name} (${step.script}) — ${step.dir}: ${step.command.join(" ")}`);
    const r = await run(step.command[0], step.command.slice(1), {
      cwd: join(REPO_ROOT, step.dir),
      unset: step.unsetEnv,
      set: step.setEnv,
      stream: (c) => io.stream(c),
    });
    const outcome = classifyDeployOutput(r.code, r.output);
    if (outcome.kind === "deployed") {
      if (!step.liveGate) return { ok: true, versionId: outcome.versionId, live: "n/a" };
      io.log(
        `[deploy:all] ${step.name}: version ${outcome.versionId ?? "?"} uploaded — waiting until the new container is live (commit ${expectedCommit.slice(0, 7)})`,
      );
      const gate = await waitUntilLive(step, step.liveGate.healthUrl, expectedCommit, io);
      if (gate.live) {
        io.log(
          `[deploy:all] ${step.name}: live (commit ${gate.commit.slice(0, 7)}, drained after ${Math.round(gate.waitedMs / 1000)}s)`,
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
      const left = deadline - Date.now();
      if (left <= 0)
        return {
          ok: false,
          live: "not deployed",
          reason: `preflight still refusing after ${plan.waitMaxMs / 60_000} min (${outcome.reason}); re-run later, or --force to kill what is in flight`,
          preflightTimedOut: true,
        };
      // Never a silent wait: say what is in flight and how far into the budget we are.
      const body = step.healthUrl ? await fetchHealthz(step.healthUrl) : undefined;
      io.log(
        step.healthUrl
          ? heartbeatLine(step.name, body, Date.now() - started, plan.waitMaxMs)
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
export async function runDeployPlan(plan: DeployPlan, io: DeployRunnerIO): Promise<DeployRunResult> {
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
  const problems = await preChecks(plan, io);
  if (problems.length > 0) return { kind: "refused", problems };
  // The bot's image copies config/ — place this installation's config there
  // first, from wherever the profile says it lives. Refused before any Worker
  // deploys: a missing config is not something the build should discover.
  if (plan.steps.some((s) => s.name === "bot")) {
    const problem = await materializeConfig(plan, io);
    if (problem) return { kind: "refused", problems: [problem] };
  }
  for (const w of plan.warnings) io.warn(`[deploy:all] WARNING ${w}`);

  // The commit being deployed — what the bot's /healthz must report before the
  // bot step counts as live. Read AFTER the origin/main check. If git fails this
  // is "" and `sameCommit` refuses anything under 7 chars, so the gate fails
  // closed (never a false "live") — and we say so up front rather than 18 min later.
  const expectedCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })).output.trim();
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
    return {
      kind: "refused",
      problems: [
        `could not read HEAD (\`git rev-parse HEAD\` gave ${JSON.stringify(expectedCommit.slice(0, 40))}); the bot live gate needs the commit being deployed`,
      ],
    };
  }

  const results: DeployStepResult[] = [];
  for (const step of plan.steps) {
    if (!(await ensureNodeModules(step, io))) {
      results.push({ name: step.name, script: step.script, live: "not deployed", status: "npm ci failed" });
      break;
    }
    const r = await deployStep(step, plan, expectedCommit, io);
    // wrangler always prints `Current Version ID`; a deploy that exits 0 without one is odd enough to say so.
    results.push({
      name: step.name,
      script: step.script,
      ...(r.versionId !== undefined ? { versionId: r.versionId } : {}),
      live: r.live,
      status: r.ok ? (r.versionId ? "deployed" : "deployed (no version id in output?)") : `FAILED: ${r.reason}`,
      ...(r.preflightTimedOut ? { preflightTimedOut: true } : {}),
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
  const r = await run("git", args, { cwd: REPO_ROOT });
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
      try {
        const res = await fetch(w.healthUrl, {
          headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        if (!res.ok) return { error: `GET ${w.healthUrl} → HTTP ${res.status}` };
        const body = parseHealthz(text);
        const commit =
          body && typeof body.build === "object" && body.build !== null
            ? (body.build as { commit?: unknown }).commit
            : undefined;
        return typeof commit === "string" && commit !== ""
          ? { commit }
          : { error: `GET ${w.healthUrl} carries no build.commit` };
      } catch (err) {
        return { error: `GET ${w.healthUrl} failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isAncestor: async (commit, head) =>
      (await run("git", ["merge-base", "--is-ancestor", commit, head], { cwd: REPO_ROOT })).code === 0,
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
 * (bearer from `plan.tokenEnv`); a 409 (runs in flight, or already draining)
 * is waited out with a heartbeat and retried every `pollMs` up to `waitMaxMs`
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
          reason: `still refusing after ${plan.waitMaxMs / 60_000} min (${outcome.reason}); re-run later, or --force to kill what is in flight`,
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
