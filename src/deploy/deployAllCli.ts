import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyDeployOutput, formatPlan, parseDeployArgs, planDeploy, type DeployPlan, type DeployStep } from "./plan.js";

// `npm run deploy:all [--only a,b] [--skip a] [--dry-run] [--force] [--allow-branch] [--wait-max <min>] [--poll <s>]`
//
// The ONE way to deploy Switchboard to production: runs the four Workers'
// `npm run deploy` in the canonical order (src/deploy/plan.ts), after checking
// the wrangler account, a clean checkout at origin/main, and node_modules per
// dir. A step whose preflight refuses (runs in flight) is waited out and
// retried — never forced unless `--force` is passed explicitly. Ends with a
// Worker → version table. Exit codes: 0 all deployed, 2 bad usage, 3 a check
// failed, 4 a step failed or the wait budget ran out.
//
// Only this file touches processes; the plan is pure and unit-tested.

const REPO_ROOT = join(import.meta.dirname, "..", "..");

interface RunResult {
  code: number;
  output: string;
}

/** Spawn a command, stream its output to our stdout, and collect it. `unset`
 *  removes env vars for the child (the `env -u` of the README commands). */
function run(cmd: string, args: string[], opts: { cwd: string; unset?: readonly string[]; set?: Record<string, string>; quiet?: boolean }): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.set ?? {}) };
  for (const k of opts.unset ?? []) delete env[k];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (!opts.quiet) process.stdout.write(text);
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
  const who = await run("npx", ["wrangler", "whoami"], { cwd: join(REPO_ROOT, "deploy/cloudflare"), unset: plan.steps[0]?.unsetEnv ?? [], quiet: true });
  if (!who.output.includes(plan.checks.account)) {
    // Keep wrangler's own words (not logged in, network, ...) — the check must be debuggable when it fails.
    const said = who.output.trim().split("\n").filter(Boolean).slice(-3).join(" | ") || `exit ${who.code}, no output`;
    problems.push(`wrangler whoami does not list account ${plan.checks.account} (coreplane-infra) — run \`npx wrangler login\` in deploy/cloudflare. wrangler said: ${said}`);
  }
  const status = await run("git", ["status", "--porcelain"], { cwd: REPO_ROOT, quiet: true });
  if (status.output.trim() !== "") problems.push("working tree is not clean — commit, stash, or deploy from a fresh checkout (wrangler builds the CURRENT tree)");
  if (plan.checks.atOriginMain) {
    // A failed fetch would let the check pass against a stale origin/main — treat it as a problem, not a warning.
    const fetch = await run("git", ["fetch", "-q", "origin"], { cwd: REPO_ROOT, quiet: true });
    if (fetch.code !== 0) problems.push(`git fetch origin failed (exit ${fetch.code}): ${fetch.output.trim().split("\n").pop() ?? ""} — cannot verify HEAD == origin/main`);
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, quiet: true })).output.trim();
    const main = (await run("git", ["rev-parse", "origin/main"], { cwd: REPO_ROOT, quiet: true })).output.trim();
    if (head !== main) problems.push(`HEAD ${head.slice(0, 7)} != origin/main ${main.slice(0, 7)} — \`git checkout --detach origin/main\`, or pass --allow-branch deliberately`);
  }
  for (const s of plan.steps) {
    for (const v of s.requiredEnv) if (!process.env[v]) problems.push(`${s.name}: ${v} is not set in the environment`);
  }
  return problems;
}

async function ensureNodeModules(step: DeployStep): Promise<boolean> {
  const dir = join(REPO_ROOT, step.dir);
  if (existsSync(join(dir, "node_modules"))) return true;
  console.log(`[deploy:all] ${step.name}: node_modules missing — npm ci`);
  const r = await run("npm", ["ci", "--silent"], { cwd: dir, quiet: true });
  if (r.code !== 0) console.error(r.output);
  return r.code === 0;
}

async function deployStep(step: DeployStep, plan: DeployPlan): Promise<{ ok: boolean; versionId?: string; reason?: string }> {
  const deadline = Date.now() + plan.waitMaxMs;
  for (;;) {
    console.log(`\n[deploy:all] ▶ ${step.name} (${step.script}) — ${step.dir}: ${step.command.join(" ")}`);
    const r = await run(step.command[0], step.command.slice(1), { cwd: join(REPO_ROOT, step.dir), unset: step.unsetEnv, set: step.setEnv });
    const outcome = classifyDeployOutput(r.code, r.output);
    if (outcome.kind === "deployed") return { ok: true, versionId: outcome.versionId };
    if (outcome.kind === "preflight-refused" && step.retryOnPreflightRefusal) {
      const left = deadline - Date.now();
      if (left <= 0) return { ok: false, reason: `preflight still refusing after ${plan.waitMaxMs / 60_000} min (${outcome.reason}); re-run later, or --force to kill what is in flight` };
      console.log(`[deploy:all] ${step.name}: preflight refused (${outcome.reason}) — retrying in ${plan.pollMs / 1000}s (${Math.ceil(left / 60_000)} min left)`);
      await sleep(plan.pollMs);
      continue;
    }
    return { ok: false, reason: outcome.reason };
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseDeployArgs(argv);
  if (!parsed.ok) {
    console.error(`deploy:all: ${parsed.error}\nusage: npm run deploy:all -- [--only a,b] [--skip a] [--dry-run] [--force] [--allow-branch] [--wait-max <min>] [--poll <s>]`);
    return 2;
  }
  const plan = planDeploy(parsed.opts);
  console.log(formatPlan(plan));
  if (plan.steps.length === 0) {
    console.error("deploy:all: nothing to deploy after filters");
    return 2;
  }
  if (plan.dryRun) return 0;

  const problems = await preChecks(plan);
  if (problems.length > 0) {
    console.error(`deploy:all: refusing —\n  - ${problems.join("\n  - ")}`);
    return 3;
  }
  for (const w of plan.warnings) console.warn(`[deploy:all] WARNING ${w}`);

  const results: Array<{ name: string; script: string; versionId?: string; status: string }> = [];
  for (const step of plan.steps) {
    if (!(await ensureNodeModules(step))) {
      results.push({ name: step.name, script: step.script, status: "npm ci failed" });
      break;
    }
    const r = await deployStep(step, plan);
    // wrangler always prints `Current Version ID`; a deploy that exits 0 without one is odd enough to say so.
    results.push({ name: step.name, script: step.script, versionId: r.versionId, status: r.ok ? (r.versionId ? "deployed" : "deployed (no version id in output?)") : `FAILED: ${r.reason}` });
    if (!r.ok) {
      console.error(`[deploy:all] ${step.name} failed — stopping here so the order holds (later Workers were NOT deployed)`);
      break;
    }
  }
  console.log("\n[deploy:all] result");
  for (const r of results) console.log(`  ${r.name.padEnd(9)} ${r.script.padEnd(22)} ${r.versionId ?? "-"}  ${r.status}`);
  const notAttempted = plan.steps.slice(results.length).map((s) => s.name);
  if (notAttempted.length > 0) console.log(`  not attempted: ${notAttempted.join(", ")}`);
  return results.every((r) => r.status.startsWith("deployed")) && notAttempted.length === 0 ? 0 : 4;
}

process.exitCode = await main(process.argv.slice(2));
