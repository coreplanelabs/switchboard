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
// Every step strips the ambient Cloudflare credentials (`env -u CLOUDFLARE_API_TOKEN
// -u CLOUDFLARE_ACCOUNT_ID`): the shell may carry another account's token, and
// CLOUDFLARE_ACCOUNT_ID would override the wrangler.jsonc account (a wrong-account
// deploy happened once). No node:* imports here — pure data + functions.

/** The coreplane-infra account every wrangler.jsonc under deploy/ pins. */
export const PRODUCTION_ACCOUNT_ID = "3c7b28f23cc93f09e77bb0a9ffcb7e6f";

/** Env vars removed from every deploy step's environment. */
export const UNSET_ENV = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;

export type WorkerName = "memory" | "bot" | "resident" | "sandbox";

/** The bot's public health probe (deploy/cloudflare/preflight.mjs reads the same URL). */
export const BOT_HEALTH_URL = "https://switchboard.coreplanelabs.dev/healthz";

export interface WorkerDef {
  name: WorkerName;
  /** The Cloudflare Worker script name (what `wrangler deployments list` shows). */
  script: string;
  /** Repo-relative directory holding package.json + wrangler.jsonc. */
  dir: string;
  /** Present when the dir's `npm run deploy` runs a preflight that can refuse.
   *  `healthUrl` is the bot's public `/healthz`: the heartbeat reads it while
   *  waiting, and the live gate polls it after the deploy. */
  preflight?: { forceEnv: string; healthUrl?: string };
  /** Present when "deployed" is not "live": the step is done only once
   *  `healthUrl` is answered by a container that is not draining AND reports
   *  the deployed commit as its `build.commit` (src/deploy/liveGate.ts). */
  liveGate?: { healthUrl: string };
  /** Env vars the step needs present (the runner fails fast when missing). */
  requiredEnv?: string[];
  why: string;
}

/** Canonical order. Never reorder without updating README + AGENTS.md. */
export const WORKERS: readonly WorkerDef[] = [
  {
    name: "memory",
    script: "switchboard-memory",
    dir: "deploy/cloudflare-memory",
    why: "state Worker — DO migrations land before the bot writes to them",
  },
  {
    name: "bot",
    script: "switchboard",
    dir: "deploy/cloudflare",
    preflight: { forceEnv: "SWITCHBOARD_DEPLOY_FORCE", healthUrl: BOT_HEALTH_URL },
    liveGate: { healthUrl: BOT_HEALTH_URL },
    why: "container shim — preflight refuses while runs are in flight; done only when the new container is live. A rotated bot secret needs no build: `wrangler secret put` alone leaves the running container on its old env — `deploy restart` restarts it on the current env",
  },
  {
    name: "resident",
    script: "switchboard-resident",
    dir: "deploy/cloudflare-resident",
    preflight: { forceEnv: "RESIDENT_DEPLOY_FORCE" },
    requiredEnv: ["RESIDENT_ADMIN_TOKEN"],
    why: "per-repo DOs — preflight refuses while a resident has work in flight",
  },
  {
    name: "sandbox",
    script: "switchboard-sandbox",
    dir: "deploy/cloudflare-sandbox",
    why: "per-thread exec proxy — stateless per run",
  },
];

export const DEPLOY_ORDER: readonly WorkerName[] = WORKERS.map((w) => w.name);

export interface DeployOptions {
  only: WorkerName[] | undefined;
  skip: WorkerName[] | undefined;
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
  requiredEnv: string[];
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
  const steps = WORKERS.filter((w) => (opts.only ? opts.only.includes(w.name) : true) && !(opts.skip ?? []).includes(w.name)).map<DeployStep>((w) => ({
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
    `Checks: wrangler account = ${plan.checks.account}; clean tree; ${plan.checks.atOriginMain ? "HEAD == origin/main" : "any branch (--allow-branch)"}; ${nodeModules}`,
    ...plan.warnings.map((w) => `WARNING ${w}`),
    "Steps:",
  ];
  plan.steps.forEach((s, i) => {
    const pf = s.retryOnPreflightRefusal
      ? ` — preflight (retry every ${plan.pollMs / 1000}s up to ${plan.waitMaxMs / 60_000} min)`
      : Object.keys(s.setEnv).length > 0
        ? ` — preflight FORCED (${Object.keys(s.setEnv).join(",")}=1)`
        : "";
    const env = s.requiredEnv.length > 0 ? ` — needs ${s.requiredEnv.join(", ")}` : "";
    const live = s.liveGate ? ` — then wait until live (${s.liveGate.healthUrl} not draining + build.commit == HEAD)` : "";
    lines.push(`  ${i + 1}. ${s.name} (${s.script}) — ${s.dir}: ${s.command.join(" ")}${pf}${env}${live}\n     ${s.why}`);
  });
  if (plan.dryRun) lines.push("(dry run — nothing executed)");
  return lines.join("\n");
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
