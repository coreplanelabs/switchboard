// The production deploy order for Switchboard's four Cloudflare Workers, as a
// pure plan. `npx tsx src/cli.ts deploy all` (src/deploy/run.ts) executes exactly what
// `planDeploy` returns, so the order, the filters, and the force gating are
// unit-tested here and cannot be bypassed by hand-ordering four `npm run deploy`s.
//
// Why this order (README "Deploying on Cloudflare Containers"):
//   1. memory   — the state Worker: Durable Object migrations must exist before
//                 the bot writes to them (friction ledger, memory, schedule firings).
//   2. bot      — the container shim; its own preflight refuses while runs are in
//                 flight (a rollout kills them — #250/#261).
//   3. resident — per-repo DOs; its preflight refuses while a resident has work
//                 in flight; needs the admin bearer in the env.
//   4. sandbox  — the per-thread exec proxy; stateless per run, no preflight.
// Every step strips the ambient CLOUDFLARE_ACCOUNT_ID: it would override the
// account every wrangler.jsonc pins (a wrong-account deploy happened once).
// CLOUDFLARE_API_TOKEN is KEPT — it is how CI authenticates — and the runner
// asserts the account instead (`decideAccount`): a token for another account
// is refused with wrangler's own words, never silently swapped for a login.
// No node:* imports here — pure data + functions.

import { formatAffectedText, type AffectedReport } from "./affected.js";

/** The coreplane-infra account every wrangler.jsonc under deploy/ pins. */
export const PRODUCTION_ACCOUNT_ID = "3c7b28f23cc93f09e77bb0a9ffcb7e6f";

/** Env vars removed from every deploy step's environment. */
export const UNSET_ENV = ["CLOUDFLARE_ACCOUNT_ID"] as const;

export type WorkerName = "memory" | "bot" | "resident" | "sandbox";

/** The bot's public health probe (deploy/cloudflare/preflight.mjs reads the same URL). */
export const BOT_HEALTH_URL = "https://switchboard.coreplanelabs.dev/healthz";

/** What a Worker is built from, beyond the import closure of its `entry`
 *  (features/release-and-deploy.md item 5). `paths`: a dir prefix (ends with
 *  `/`) or an exact file. `prodDepsLockfiles`: lockfiles judged by their
 *  PRODUCTION dependency set only — a devDependency bump changes no bundle. */
export interface WorkerInputs {
  paths: readonly string[];
  prodDepsLockfiles: readonly string[];
}

/** "One of these env vars must be set" — the resident preflight takes any bearer scope. */
export interface EnvRequirement {
  anyOf: readonly string[];
}

export interface WorkerDef {
  name: WorkerName;
  /** The Cloudflare Worker script name (what `wrangler deployments list` shows). */
  script: string;
  /** Repo-relative directory holding package.json + wrangler.jsonc. */
  dir: string;
  /** The Worker script wrangler bundles — the root of its import closure. */
  entry: string;
  /** `GET /healthz` — answers `build.commit`, the commit this Worker serves (execution.md item 13). */
  healthUrl: string;
  /** Set when `/healthz` sits behind a bearer: the env var holding it. */
  healthBearerEnv?: string;
  inputs: WorkerInputs;
  /** Present when the dir's `npm run deploy` runs a preflight that can refuse.
   *  `healthUrl` is the bot's public `/healthz`: the heartbeat reads it while
   *  waiting, and the live gate polls it after the deploy. */
  preflight?: { forceEnv: string; healthUrl?: string };
  /** Present when "deployed" is not "live": the step is done only once
   *  `healthUrl` is answered by a container that is not draining AND reports
   *  the deployed commit as its `build.commit` (src/deploy/liveGate.ts). */
  liveGate?: { healthUrl: string };
  /** Env the step needs present (the runner fails fast when a requirement has none of its alternatives). */
  requiredEnv?: readonly EnvRequirement[];
  why: string;
}

/** The three bearer scopes the resident preflight accepts (deploy/cloudflare-resident/preflight.mjs `TOKEN_ENV_VARS`); read is enough. */
export const RESIDENT_BEARER_ENVS = ["RESIDENT_ADMIN_TOKEN", "RESIDENT_OPERATOR_TOKEN", "RESIDENT_READ_TOKEN"] as const;

/** Canonical order. Never reorder without updating README + AGENTS.md. */
export const WORKERS: readonly WorkerDef[] = [
  {
    name: "memory",
    script: "switchboard-memory",
    dir: "deploy/cloudflare-memory",
    entry: "deploy/cloudflare-memory/worker.ts",
    healthUrl: "https://switchboard-memory.coreplanelabs.dev/healthz",
    inputs: { paths: ["deploy/cloudflare-memory/"], prodDepsLockfiles: ["deploy/cloudflare-memory/package-lock.json"] },
    why: "state Worker — DO migrations land before the bot writes to them",
  },
  {
    name: "bot",
    script: "switchboard",
    dir: "deploy/cloudflare",
    entry: "deploy/cloudflare/worker.ts",
    healthUrl: BOT_HEALTH_URL,
    // The Worker shim's dir, plus everything the root Dockerfile COPYs into the
    // image (src/, web/, config/, skills/, the package files, the tsconfigs)
    // and the two files that decide what it copies. The root lockfile is a
    // WHOLE-file input: tsc and vite are devDependencies that build the artifact.
    inputs: {
      paths: ["deploy/cloudflare/", "Dockerfile", ".dockerignore", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "src/", "web/", "config/", "skills/"],
      prodDepsLockfiles: ["deploy/cloudflare/package-lock.json"],
    },
    preflight: { forceEnv: "SWITCHBOARD_DEPLOY_FORCE", healthUrl: BOT_HEALTH_URL },
    liveGate: { healthUrl: BOT_HEALTH_URL },
    why: "container shim — preflight refuses while runs are in flight; done only when the new container is live. A rotated bot secret needs no build: `wrangler secret put` alone leaves the running container on its old env — `deploy restart` restarts it on the current env",
  },
  {
    name: "resident",
    script: "switchboard-resident",
    dir: "deploy/cloudflare-resident",
    entry: "deploy/cloudflare-resident/worker.ts",
    healthUrl: "https://switchboard-resident.coreplanelabs.dev/healthz",
    inputs: { paths: ["deploy/cloudflare-resident/"], prodDepsLockfiles: ["deploy/cloudflare-resident/package-lock.json"] },
    preflight: { forceEnv: "RESIDENT_DEPLOY_FORCE" },
    requiredEnv: [{ anyOf: RESIDENT_BEARER_ENVS }],
    why: "per-repo DOs — preflight refuses while a resident has work in flight",
  },
  {
    name: "sandbox",
    script: "switchboard-sandbox",
    dir: "deploy/cloudflare-sandbox",
    entry: "deploy/cloudflare-sandbox/worker.ts",
    healthUrl: "https://switchboard-sandbox.coreplanelabs.dev/healthz",
    healthBearerEnv: "SANDBOX_TOKEN",
    inputs: { paths: ["deploy/cloudflare-sandbox/"], prodDepsLockfiles: ["deploy/cloudflare-sandbox/package-lock.json"] },
    why: "per-thread exec proxy — stateless per run",
  },
];

export const DEPLOY_ORDER: readonly WorkerName[] = WORKERS.map((w) => w.name);

export interface DeployOptions {
  only: WorkerName[] | undefined;
  skip: WorkerName[] | undefined;
  /** `--affected`: the selection comes from the report (src/deploy/affected.ts), not from `only`. */
  affected?: AffectedReport;
  dryRun: boolean;
  force: boolean;
  allowBranch: boolean;
  waitMaxMinutes: number;
  pollSeconds: number;
}

export interface DeployStep {
  name: WorkerName;
  script: string;
  dir: string;
  command: string[];
  unsetEnv: readonly string[];
  /** Force env for a preflighted step when --force; empty otherwise. */
  setEnv: Record<string, string>;
  requiredEnv: readonly EnvRequirement[];
  /** A "preflight REFUSED" exit is waited out and retried (never for forced or unpreflighted steps). */
  retryOnPreflightRefusal: boolean;
  /** `/healthz` to read for the wait heartbeat (preflighted steps with a health URL). */
  healthUrl?: string;
  /** After the deploy, poll this `/healthz` until the new container is live (bot only). */
  liveGate?: { healthUrl: string };
  why: string;
}

export interface DeployPlan {
  steps: DeployStep[];
  /** Present when the steps were selected by `--affected`: the per-Worker judgement behind them. */
  affected?: AffectedReport;
  dryRun: boolean;
  force: boolean;
  waitMaxMs: number;
  pollMs: number;
  checks: {
    account: string;
    cleanTree: true;
    atOriginMain: boolean;
    /** Step dirs (repo-relative) without `node_modules` when the plan was computed — the runner `npm ci`s each before its deploy. */
    nodeModulesMissing: string[];
  };
  warnings: string[];
}

/** What the plan reads from the checkout it is computed in. The plan stays
 *  free of node:* imports; the runner (src/deploy/run.ts) supplies the real
 *  probe through the command deps. */
export interface CheckoutProbe {
  /** Does `<repo root>/<dir>/node_modules` exist? */
  hasNodeModules(dir: string): boolean;
}

export function planDeploy(opts: DeployOptions, checkout: CheckoutProbe): DeployPlan {
  // `--affected` selects; `--only` (and `--skip`) can only narrow what it selected.
  const selected = opts.affected ? opts.affected.selected.filter((n) => !opts.only || opts.only.includes(n)) : opts.only;
  const steps = WORKERS.filter((w) => (selected ? selected.includes(w.name) : true) && !(opts.skip ?? []).includes(w.name)).map<DeployStep>((w) => ({
    name: w.name,
    script: w.script,
    dir: w.dir,
    command: ["npm", "run", "deploy"],
    unsetEnv: UNSET_ENV,
    setEnv: opts.force && w.preflight ? { [w.preflight.forceEnv]: "1" } : {},
    requiredEnv: w.requiredEnv ?? [],
    retryOnPreflightRefusal: !!w.preflight && !opts.force,
    ...(w.preflight?.healthUrl ? { healthUrl: w.preflight.healthUrl } : {}),
    ...(w.liveGate ? { liveGate: w.liveGate } : {}),
    why: w.why,
  }));
  const forcedNames = steps.filter((s) => Object.keys(s.setEnv).length > 0).map((s) => s.name);
  return {
    steps,
    ...(opts.affected ? { affected: opts.affected } : {}),
    dryRun: opts.dryRun,
    force: opts.force,
    waitMaxMs: opts.waitMaxMinutes * 60_000,
    pollMs: opts.pollSeconds * 1000,
    checks: {
      account: PRODUCTION_ACCOUNT_ID,
      cleanTree: true,
      atOriginMain: !opts.allowBranch,
      nodeModulesMissing: steps.filter((s) => !checkout.hasNodeModules(s.dir)).map((s) => s.dir),
    },
    warnings: forcedNames.length > 0 ? [`--force: preflights are bypassed — in-flight runs on ${forcedNames.join(" and ")} are SIGTERM-drained (finish if they can, else killed at the drain deadline)`] : [],
  };
}

/** Human rendering of a plan (what `--dry-run` prints). */
export function formatPlan(plan: DeployPlan): string {
  const missing = plan.checks.nodeModulesMissing;
  const nodeModules = missing.length === 0 ? "node_modules present in every dir" : `node_modules missing in ${missing.join(", ")} — the runner will \`npm ci\` there first`;
  const lines = [
    ...(plan.affected ? [formatAffectedText(plan.affected)] : []),
    `Checks: wrangler account = ${plan.checks.account}; clean tree; ${plan.checks.atOriginMain ? "HEAD == origin/main" : "any branch (--allow-branch)"}; ${nodeModules}`,
    ...plan.warnings.map((w) => `WARNING ${w}`),
    plan.steps.length === 0 ? "Steps: none — nothing to deploy" : "Steps:",
  ];
  plan.steps.forEach((s, i) => {
    const pf = s.retryOnPreflightRefusal
      ? ` — preflight (retry every ${plan.pollMs / 1000}s up to ${plan.waitMaxMs / 60_000} min)`
      : Object.keys(s.setEnv).length > 0
        ? ` — preflight FORCED (${Object.keys(s.setEnv).join(",")}=1)`
        : "";
    const env = s.requiredEnv.length > 0 ? ` — needs ${s.requiredEnv.map((r) => (r.anyOf.length === 1 ? r.anyOf[0] : `one of ${r.anyOf.join(" / ")}`)).join(", ")}` : "";
    const live = s.liveGate ? ` — then wait until live (${s.liveGate.healthUrl} not draining + build.commit == HEAD)` : "";
    lines.push(`  ${i + 1}. ${s.name} (${s.script}) — ${s.dir}: ${s.command.join(" ")}${pf}${env}${live}\n     ${s.why}`);
  });
  if (plan.dryRun) lines.push("(dry run — nothing executed)");
  return lines.join("\n");
}

/** Cloudflare's per-account token check: `GET /accounts/<id>/tokens/verify` → `{ result: { status } }`. */
export interface TokenVerifyResult {
  status: number;
  body: string;
}

/**
 * The account pre-check, pure. `wrangler whoami` listing the production
 * account passes (a login, or a user-owned token). An ACCOUNT-owned token
 * answers `whoami` with no memberships (`/user` is null for it), so the
 * runner also asks Cloudflare whether the token verifies against the account;
 * `active` passes and says so. Neither → refuse with wrangler's words and
 * both ways out — never a silent switch to whatever credential is around.
 */
export function decideAccount(input: { account: string; whoamiOutput: string; whoamiExit: number; tokenSet: boolean; tokenVerify?: TokenVerifyResult }): { ok: true; how: string } | { ok: false; problem: string } {
  if (input.whoamiOutput.includes(input.account)) return { ok: true, how: `wrangler whoami lists account ${input.account}` };
  if (input.tokenSet && input.tokenVerify) {
    let status: unknown;
    try {
      status = (JSON.parse(input.tokenVerify.body) as { result?: { status?: unknown } })?.result?.status;
    } catch {
      status = undefined;
    }
    if (input.tokenVerify.status === 200 && status === "active") return { ok: true, how: `CLOUDFLARE_API_TOKEN verifies active against account ${input.account} (account-owned token; wrangler whoami lists no memberships)` };
  }
  const said = input.whoamiOutput.trim().split("\n").filter(Boolean).slice(-3).join(" | ") || `exit ${input.whoamiExit}, no output`;
  const verify = input.tokenSet
    ? input.tokenVerify
      ? ` and the token does not verify against it (HTTP ${input.tokenVerify.status})`
      : " and the token could not be verified against it"
    : "";
  const wayOut = input.tokenSet ? "unset a CLOUDFLARE_API_TOKEN that belongs to another account, or use one for this account" : "run `npx wrangler login` in deploy/cloudflare";
  return { ok: false, problem: `wrangler whoami does not list account ${input.account} (coreplane-infra)${verify} — ${wayOut}. wrangler said: ${said}` };
}

export type DeployOutcome = { kind: "deployed"; versionId: string | undefined } | { kind: "preflight-refused"; reason: string } | { kind: "failed"; reason: string };

/** Read a step's exit + combined output: a preflight refusal (retryable), a
 *  deploy with its `Current Version ID`, or a hard failure (first error-ish line). */
export function classifyDeployOutput(exitCode: number, output: string): DeployOutcome {
  if (exitCode === 0) {
    const m = /Current Version ID:\s*([0-9a-f-]{8,})/i.exec(output);
    return { kind: "deployed", versionId: m ? m[1] : undefined };
  }
  if (/preflight REFUSED/i.test(output)) {
    const bullet = output
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("- "));
    return { kind: "preflight-refused", reason: bullet ? bullet.slice(2) : "preflight refused" };
  }
  // The full output was already streamed; this is the one-line summary for the
  // table. Prefer a real cause over npm's `npm ERR!` preamble lines.
  const lines = output.split("\n").map((l) => l.trim());
  const isErrorish = (l: string) => /error|ERR!|✘|refused|failed/i.test(l);
  const firstError = lines.find((l) => isErrorish(l) && !/^npm ERR!/i.test(l)) ?? lines.find(isErrorish);
  return { kind: "failed", reason: firstError ?? `exit ${exitCode}` };
}
