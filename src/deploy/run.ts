import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decideLive, heartbeatLine, LIVE_GATE_DEADLINE_MS, LIVE_GATE_POLL_MS, parseHealthz, type HealthzBody } from "./liveGate.js";
import { classifyDeployOutput, type DeployPlan, type DeployStep } from "./plan.js";

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
function run(cmd: string, args: string[], opts: { cwd: string; unset?: readonly string[]; set?: Record<string, string>; stream?: (chunk: string) => void }): Promise<RunResult> {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function preChecks(plan: DeployPlan): Promise<string[]> {
  const problems: string[] = [];
  const who = await run("npx", ["wrangler", "whoami"], { cwd: join(REPO_ROOT, "deploy/cloudflare"), unset: plan.steps[0]?.unsetEnv ?? [] });
  if (!who.output.includes(plan.checks.account)) {
    // Keep wrangler's own words (not logged in, network, ...) — the check must be debuggable when it fails.
    const said = who.output.trim().split("\n").filter(Boolean).slice(-3).join(" | ") || `exit ${who.code}, no output`;
    problems.push(`wrangler whoami does not list account ${plan.checks.account} (coreplane-infra) — run \`npx wrangler login\` in deploy/cloudflare. wrangler said: ${said}`);
  }
  const status = await run("git", ["status", "--porcelain"], { cwd: REPO_ROOT });
  if (status.output.trim() !== "") problems.push("working tree is not clean — commit, stash, or deploy from a fresh checkout (wrangler builds the CURRENT tree)");
  if (plan.checks.atOriginMain) {
    // A failed fetch would let the check pass against a stale origin/main — treat it as a problem, not a warning.
    const fetch = await run("git", ["fetch", "-q", "origin"], { cwd: REPO_ROOT });
    if (fetch.code !== 0) problems.push(`git fetch origin failed (exit ${fetch.code}): ${fetch.output.trim().split("\n").pop() ?? ""} — cannot verify HEAD == origin/main`);
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })).output.trim();
    const main = (await run("git", ["rev-parse", "origin/main"], { cwd: REPO_ROOT })).output.trim();
    if (head !== main) problems.push(`HEAD ${head.slice(0, 7)} != origin/main ${main.slice(0, 7)} — \`git checkout --detach origin/main\`, or pass --allow-branch deliberately`);
  }
  for (const s of plan.steps) {
    for (const v of s.requiredEnv) if (!process.env[v]) problems.push(`${s.name}: ${v} is not set in the environment`);
  }
  return problems;
}

async function ensureNodeModules(step: DeployStep, io: DeployRunnerIO): Promise<boolean> {
  const dir = join(REPO_ROOT, step.dir);
  if (existsSync(join(dir, "node_modules"))) return true;
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
}

/**
 * After a gated step's deploy: poll `/healthz` until the NEW container answers
 * (not draining, `build.commit` == `expectedCommit`), logging every poll so the
 * drain is visible. Returns the live commit, or the reason it never went live
 * within the drain deadline (+ cold-start margin).
 */
async function waitUntilLive(step: DeployStep, healthUrl: string, expectedCommit: string, io: DeployRunnerIO): Promise<{ live: true; commit: string; waitedMs: number } | { live: false; reason: string }> {
  const started = Date.now();
  for (;;) {
    const elapsed = Date.now() - started;
    const body = await fetchHealthz(healthUrl);
    const d = decideLive(body, expectedCommit, elapsed);
    if (d.kind === "live") return { live: true, commit: d.commit, waitedMs: elapsed };
    if (d.kind === "timeout") return { live: false, reason: `${d.reason} — gave up after ${Math.round(elapsed / 60_000)} min (drain deadline ${LIVE_GATE_DEADLINE_MS / 60_000} min)` };
    io.log(`[deploy:all] ${step.name}: deployed, not live yet — ${d.reason} (${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1000)}s)`);
    await sleep(LIVE_GATE_POLL_MS);
  }
}

async function deployStep(step: DeployStep, plan: DeployPlan, expectedCommit: string, io: DeployRunnerIO): Promise<StepOutcome> {
  const started = Date.now();
  const deadline = started + plan.waitMaxMs;
  for (;;) {
    io.log(`\n[deploy:all] ▶ ${step.name} (${step.script}) — ${step.dir}: ${step.command.join(" ")}`);
    const r = await run(step.command[0], step.command.slice(1), { cwd: join(REPO_ROOT, step.dir), unset: step.unsetEnv, set: step.setEnv, stream: (c) => io.stream(c) });
    const outcome = classifyDeployOutput(r.code, r.output);
    if (outcome.kind === "deployed") {
      if (!step.liveGate) return { ok: true, versionId: outcome.versionId, live: "n/a" };
      io.log(`[deploy:all] ${step.name}: version ${outcome.versionId ?? "?"} uploaded — waiting until the new container is live (commit ${expectedCommit.slice(0, 7)})`);
      const gate = await waitUntilLive(step, step.liveGate.healthUrl, expectedCommit, io);
      if (gate.live) {
        io.log(`[deploy:all] ${step.name}: live (commit ${gate.commit.slice(0, 7)}, drained after ${Math.round(gate.waitedMs / 1000)}s)`);
        return { ok: true, versionId: outcome.versionId, live: "live" };
      }
      return { ok: false, versionId: outcome.versionId, live: `deployed, not live: ${gate.reason}`, reason: `deployed but NOT live — ${gate.reason}` };
    }
    if (outcome.kind === "preflight-refused" && step.retryOnPreflightRefusal) {
      const left = deadline - Date.now();
      if (left <= 0) return { ok: false, live: "not deployed", reason: `preflight still refusing after ${plan.waitMaxMs / 60_000} min (${outcome.reason}); re-run later, or --force to kill what is in flight` };
      // Never a silent wait: say what is in flight and how far into the budget we are.
      const body = step.healthUrl ? await fetchHealthz(step.healthUrl) : undefined;
      io.log(step.healthUrl ? heartbeatLine(step.name, body, Date.now() - started, plan.waitMaxMs) : `[deploy:all] ${step.name}: still waiting — ${outcome.reason}`);
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
  const problems = await preChecks(plan);
  if (problems.length > 0) return { kind: "refused", problems };
  for (const w of plan.warnings) io.warn(`[deploy:all] WARNING ${w}`);

  // The commit being deployed — what the bot's /healthz must report before the
  // bot step counts as live. Read AFTER the origin/main check. If git fails this
  // is "" and `sameCommit` refuses anything under 7 chars, so the gate fails
  // closed (never a false "live") — and we say so up front rather than 18 min later.
  const expectedCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })).output.trim();
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
    return { kind: "refused", problems: [`could not read HEAD (\`git rev-parse HEAD\` gave ${JSON.stringify(expectedCommit.slice(0, 40))}); the bot live gate needs the commit being deployed`] };
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
    });
    if (!r.ok) {
      io.warn(`[deploy:all] ${step.name} failed — stopping here so the order holds (later Workers were NOT deployed)`);
      break;
    }
  }
  const notAttempted = plan.steps.slice(results.length).map((s) => s.name);
  const ok = results.every((r) => r.status.startsWith("deployed") && !r.live.startsWith("deployed, not live")) && notAttempted.length === 0;
  return { kind: "ran", ok, results, notAttempted };
}

/** The Worker → version → live table both the success output and a failure message end with. */
export function formatDeployResults(results: readonly DeployStepResult[], notAttempted: readonly string[]): string {
  const lines = [`  ${"worker".padEnd(9)} ${"script".padEnd(22)} ${"version".padEnd(38)} ${"live".padEnd(8)} status`];
  for (const r of results) lines.push(`  ${r.name.padEnd(9)} ${r.script.padEnd(22)} ${(r.versionId ?? "-").padEnd(38)} ${r.live.padEnd(8)} ${r.status}`);
  if (notAttempted.length > 0) lines.push(`  not attempted: ${notAttempted.join(", ")}`);
  return lines.join("\n");
}
