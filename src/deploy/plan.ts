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
//
// WHERE the Workers deploy — the account, each Worker's script name and
// hostname, where the runtime config comes from — is the deployment profile's
// (src/deploy/profile.ts), not this file's: the static half of each Worker
// (its dir, its entry, its inputs, its preflight) is `WORKER_SPECS`, and
// `workersFor(profile)` binds the two. No node:* imports here — pure data +
// functions.

import { formatAffectedText, type AffectedReport } from "./affected.js";
import { BASE_CONFIG_DOCUMENT_KEY } from "../configDocument.js";
import { profileUrls, type DeploymentProfile, type LoadedProfile, type WorkerKind } from "./profile.js";

/** Env vars removed from every deploy step's environment. */
export const UNSET_ENV = ["CLOUDFLARE_ACCOUNT_ID"] as const;

export type WorkerName = "memory" | "bot" | "resident" | "sandbox";

/** What a Worker is built from, beyond the import closure of its `entry`
 *  (features/release-and-deploy.md item 5). `paths`: a dir prefix (ends with
 *  `/`) or an exact file. `lockfile`: how the ONE root `package-lock.json`
 *  (npm workspaces, #496) is judged for this Worker — the dependency closure
 *  of each named workspace (`""` = the root package): production only for a
 *  wrangler bundle (a devDependency bump changes no bundle), dev included for
 *  an image whose `npm ci` installs the toolchain that builds the artifact. */
export interface WorkerInputs {
  paths: readonly string[];
  lockfile: readonly LockfileWorkspace[];
}

export interface LockfileWorkspace {
  /** The workspace directory as the lockfile keys it; `""` is the root package. */
  workspace: string;
  includeDev: boolean;
}

/** "One of these env vars must be set" — the resident preflight takes any bearer scope. */
export interface EnvRequirement {
  anyOf: readonly string[];
}

/** A read-only wrangler command that succeeds only when the credential has the
 *  scope this Worker's deploy needs — run BEFORE any Worker deploys, so a token
 *  that can deploy the memory Worker but not push the bot's image is refused at
 *  the top with wrangler's own words, not after step one (v0.2.1, run
 *  34162851123: the docs Worker's token lacked the Containers scope and the bot
 *  preflight refused for 22 minutes with the cause truncated away). */
export interface CapabilityCheck {
  /** argv after `npx`, run in the Worker's dir so wrangler.jsonc picks the account. */
  command: readonly string[];
  /** The scope, named the way the Cloudflare dashboard names it. */
  needs: string;
}

/** The sandbox Worker's container class (deploy/cloudflare-sandbox/wrangler.jsonc `class_name`);
 *  wrangler names the Containers application `<script>-<class lowercased>`. */
export const SANDBOX_CONTAINER_CLASS = "SwitchboardSandbox";
/** The bearer every route on the sandbox Worker needs, `/healthz` included (execution.md item 13). */
export const SANDBOX_BEARER_ENV = "SANDBOX_TOKEN";

/** The Containers application `wrangler deploy` creates for a Worker's container class —
 *  `<script>-<class_name lowercased>` (the bot's is `switchboard-switchboardserver`,
 *  deploy/cloudflare/preflight.mjs `APP_NAME`). The script name is the profile's. */
export function containerApplicationName(script: string, className: string): string {
  return `${script}-${className.toLowerCase()}`;
}

/** The static half of a live gate — WHICH proof a step needs; the profile supplies where to read it. */
export type LiveGateSpec =
  /** The bot: `/healthz` answered by a container that is not draining AND reporting
   *  the deployed commit as its `build.commit` (src/deploy/liveGate.ts `decideLive`). */
  | { kind: "health" }
  /** The sandbox (#569): the Worker serves the deployed commit (bearer from `bearerEnv`),
   *  every RUNNING instance of its container application is on the application's
   *  version, and an `/exec` probe answers `echo ok` from an instance on that version
   *  (src/deploy/sandboxLiveGate.ts `decideSandboxLive`). */
  | { kind: "sandbox"; bearerEnv: string; containerClass: string };

/** A live gate bound to an installation: the spec plus the URL (and application) the profile gives it. */
export type LiveGate =
  | { kind: "health"; healthUrl: string }
  | { kind: "sandbox"; healthUrl: string; bearerEnv: string; containerApp: string };

export type SandboxLiveGate = Extract<LiveGate, { kind: "sandbox" }>;

/** The static half of a Worker — true for every installation. */
export interface WorkerSpec {
  name: WorkerName;
  /** Repo-relative directory holding package.json + wrangler.jsonc. */
  dir: string;
  /** The Worker script wrangler bundles — the root of its import closure. */
  entry: string;
  /** Set when `/healthz` sits behind a bearer: the env var holding it. */
  healthBearerEnv?: string;
  inputs: WorkerInputs;
  /** Present when the dir's `npm run deploy` runs a preflight that can refuse: the env var that
   *  bypasses it (`--force`) and the env var it reads the Worker's origin from (set by the runner
   *  from the profile — the preflight has no address of its own). */
  preflight?: { forceEnv: string; baseUrlEnv: string };
  /** Present when "deployed" is not "live": which proof the step waits for (`LiveGateSpec`). */
  liveGate?: LiveGateSpec;
  /** Env the step needs present (the runner fails fast when a requirement has none of its alternatives). */
  requiredEnv?: readonly EnvRequirement[];
  /** The credential capabilities this Worker's deploy needs beyond Workers Scripts: Edit — each one checked before any Worker deploys. */
  capabilities?: readonly CapabilityCheck[];
  /** A wait budget of this step's own for a preflight refusal, when the plan's default does not fit what it refuses for. */
  waitMaxMs?: number;
  why: string;
}

/** A Worker bound to an installation: the spec plus what the profile says about it. */
export interface WorkerDef extends Omit<WorkerSpec, "preflight" | "liveGate"> {
  /** The Cloudflare Worker script name (what `wrangler deployments list` shows). */
  script: string;
  /** The Worker's origin (`https://<hostname>`), from the profile. */
  baseUrl: string;
  /** `GET /healthz` — answers `build.commit`, the commit this Worker serves (execution.md item 13). */
  healthUrl: string;
  /** Present when the dir's `npm run deploy` runs a preflight that can refuse.
   *  `healthUrl` is the bot's public `/healthz`: the heartbeat reads it while
   *  waiting, and the live gate polls it after the deploy. */
  preflight?: { forceEnv: string; baseUrlEnv: string; healthUrl?: string };
  /** Present when "deployed" is not "live": the spec's gate bound to this installation's URLs. */
  liveGate?: LiveGate;
}

/** The three bearer scopes the resident preflight accepts (deploy/cloudflare-resident/preflight.mjs `TOKEN_ENV_VARS`); read is enough. */
export const RESIDENT_BEARER_ENVS = ["RESIDENT_ADMIN_TOKEN", "RESIDENT_OPERATOR_TOKEN", "RESIDENT_READ_TOKEN"] as const;

/** The resident step's own wait budget (release-and-deploy item 13). The
 *  plan's default (10 min) is sized for the bot's one refusal, a container
 *  rollout still settling. The resident preflight refuses for runs in flight
 *  (a coding run is up to 25 min) and for a provisioning (up to its 5-min
 *  deadline) — states that clear on their own within half an hour, and that a
 *  10-min budget once turned into a red release. Past this budget a refusal is
 *  a real anomaly and fails like any stopped run. */
export const RESIDENT_WAIT_MAX_MS = 30 * 60_000;

/** Every Worker with a container image needs this: the bot's preflight reads the
 *  application with it, and `wrangler deploy` pushes the image with it. */
export const CONTAINERS_CAPABILITY: CapabilityCheck = {
  command: ["wrangler", "containers", "list", "--json"],
  needs: "Containers: Edit",
};

/** Each Worker's directory: package.json, wrangler.template.jsonc and the wrangler.jsonc rendered from
 *  it (src/deploy/wranglerTemplate.ts). The docs Worker is here too — it has a config to render even
 *  though it deploys on its own (features/docs-site.md), never as a `deploy all` step. */
export const WORKER_DIRS: Readonly<Record<WorkerKind, string>> = {
  memory: "deploy/cloudflare-memory",
  bot: "deploy/cloudflare",
  resident: "deploy/cloudflare-resident",
  sandbox: "deploy/cloudflare-sandbox",
  docs: "deploy/cloudflare-docs",
};

/** Canonical order. Never reorder without updating README + AGENTS.md. */
export const WORKER_SPECS: readonly WorkerSpec[] = [
  {
    name: "memory",
    dir: WORKER_DIRS.memory,
    entry: "deploy/cloudflare-memory/worker.ts",
    inputs: {
      paths: ["deploy/cloudflare-memory/"],
      lockfile: [{ workspace: "deploy/cloudflare-memory", includeDev: false }],
    },
    why: "state Worker — DO migrations land before the bot writes to them",
  },
  {
    name: "bot",
    dir: WORKER_DIRS.bot,
    entry: "deploy/cloudflare/worker.ts",
    // The Worker shim's dir, plus everything the root Dockerfile COPYs into the
    // image (src/, web/, skills/, the package files, the tsconfigs — never
    // config/: the bot reads its config from the state Worker, not the image)
    // and the two files that decide what it copies. The lockfile counts for
    // the root package and web INCLUDING devDependencies (the Dockerfile's
    // `npm ci --include-workspace-root --workspace web`: tsc and vite build
    // the artifact) plus the shim's own production closure (wrangler bundles
    // it); another workspace's dependency moving (the resident's SDK) does not.
    inputs: {
      paths: [
        "deploy/cloudflare/",
        "Dockerfile",
        ".dockerignore",
        "package.json",
        "tsconfig.json",
        "tsconfig.build.json",
        "src/",
        "web/",
        "skills/",
      ],
      lockfile: [
        { workspace: "", includeDev: true },
        { workspace: "web", includeDev: true },
        { workspace: "deploy/cloudflare", includeDev: false },
      ],
    },
    preflight: { forceEnv: "SWITCHBOARD_DEPLOY_FORCE", baseUrlEnv: "SWITCHBOARD_BASE_URL" },
    liveGate: { kind: "health" },
    // The preflight reads the container application and the deploy pushes the image: both need Containers.
    capabilities: [CONTAINERS_CAPABILITY],
    why: "container shim — preflight refuses while runs are in flight; done only when the new container is live. A rotated bot secret needs no build: `wrangler secret put` alone leaves the running container on its old env — `deploy restart` restarts it on the current env",
  },
  {
    name: "resident",
    dir: WORKER_DIRS.resident,
    entry: "deploy/cloudflare-resident/worker.ts",
    inputs: {
      paths: ["deploy/cloudflare-resident/"],
      lockfile: [{ workspace: "deploy/cloudflare-resident", includeDev: false }],
    },
    preflight: { forceEnv: "RESIDENT_DEPLOY_FORCE", baseUrlEnv: "RESIDENT_BASE_URL" },
    requiredEnv: [{ anyOf: RESIDENT_BEARER_ENVS }],
    // A container image like the bot's — checked here too, since an --affected
    // release can select the resident without the bot — plus the BACKUP_BUCKET
    // R2 binding wrangler validates on deploy.
    capabilities: [
      CONTAINERS_CAPABILITY,
      { command: ["wrangler", "r2", "bucket", "list"], needs: "Workers R2 Storage: Edit" },
    ],
    waitMaxMs: RESIDENT_WAIT_MAX_MS,
    why: "per-repo DOs — preflight refuses while a resident has a run in flight or is provisioning (a refresh or restore mid-cycle only warns: it resumes after the swap)",
  },
  {
    name: "sandbox",
    dir: WORKER_DIRS.sandbox,
    entry: "deploy/cloudflare-sandbox/worker.ts",
    healthBearerEnv: SANDBOX_BEARER_ENV,
    inputs: {
      paths: ["deploy/cloudflare-sandbox/"],
      lockfile: [{ workspace: "deploy/cloudflare-sandbox", includeDev: false }],
    },
    // A Worker + image pair: the upload is instant, the image rollout is not, and a
    // thread placed in between lands on the previous image (#569). Done only when the
    // Worker, the rollout and a probe agree — all three read with the bearer, so the
    // step needs it in the env.
    liveGate: { kind: "sandbox", bearerEnv: SANDBOX_BEARER_ENV, containerClass: SANDBOX_CONTAINER_CLASS },
    requiredEnv: [{ anyOf: [SANDBOX_BEARER_ENV] }],
    // Its image needs Containers too.
    capabilities: [CONTAINERS_CAPABILITY],
    why: "per-thread exec proxy — stateless per run; done only when the Worker serves the commit, every running container is on the new image and an `echo ok` probe answers from one (#569)",
  },
];

export const DEPLOY_ORDER: readonly WorkerName[] = WORKER_SPECS.map((w) => w.name);

/** Pure: a gate spec bound to the installation — the Worker's `/healthz`, and for the
 *  sandbox the Containers application wrangler names from the profile's script name. */
function bindLiveGate(gate: LiveGateSpec, script: string, healthUrl: string): LiveGate {
  return gate.kind === "health"
    ? { kind: "health", healthUrl }
    : {
        kind: "sandbox",
        healthUrl,
        bearerEnv: gate.bearerEnv,
        containerApp: containerApplicationName(script, gate.containerClass),
      };
}

/** Pure: the Workers of one installation — each spec the profile has a Worker
 *  for, in canonical order, bound to the script name and hostname the profile
 *  gives it. A profile with only the bot is a one-Worker fleet. Health URLs
 *  are derived, never typed. */
export function workersFor(profile: DeploymentProfile): WorkerDef[] {
  return WORKER_SPECS.flatMap(({ preflight, liveGate, ...spec }) => {
    const worker = profile.workers[spec.name];
    if (!worker) return [];
    const baseUrl = `https://${worker.hostname}`;
    const healthUrl = `${baseUrl}/healthz`;
    const script = worker.script;
    return [
      {
        ...spec,
        script,
        baseUrl,
        healthUrl,
        // A preflighted step with a health gate reads the same URL for its wait heartbeat.
        ...(preflight ? { preflight: liveGate?.kind === "health" ? { ...preflight, healthUrl } : preflight } : {}),
        ...(liveGate ? { liveGate: bindLiveGate(liveGate, script, healthUrl) } : {}),
      },
    ];
  });
}

/** Where the bot's runtime config lands: the `base` document on the state
 *  Worker's ConfigDO (src/configDocument.ts), which the bot Worker points its
 *  container at with `SWITCHBOARD_CONFIG=state://base`. */
export const CONFIG_DOCUMENT_KEY = BASE_CONFIG_DOCUMENT_KEY;

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
  /** What the runner sets for the step's `npm run deploy`: a preflighted step's origin (the
   *  preflight reads it — `SWITCHBOARD_BASE_URL` / `RESIDENT_BASE_URL`), plus its force env under
   *  --force. Empty for a step without a preflight. */
  setEnv: Record<string, string>;
  /** The env var set to `1` in `setEnv` to bypass this step's preflight — present only under --force. */
  forcedBy?: string;
  /** `/healthz` to GET once after an unguarded deploy so the Worker (and its Durable Objects) wake
   *  — steps without a live gate whose health route is public. */
  wakeUrl?: string;
  requiredEnv: readonly EnvRequirement[];
  /** The read-only wrangler commands the pre-checks run to prove the credential can deploy this step. */
  capabilities: readonly CapabilityCheck[];
  /** A "preflight REFUSED" exit is waited out and retried (never for forced or unpreflighted steps). */
  retryOnPreflightRefusal: boolean;
  /** This step's wait budget for that retry loop; absent → the plan's `waitMaxMs`. */
  waitMaxMs?: number;
  /** `/healthz` to read for the wait heartbeat (preflighted steps with a health URL). */
  healthUrl?: string;
  /** After the deploy, wait until the step's gate holds (the bot's drain; the sandbox's rollout + probe). */
  liveGate?: LiveGate;
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
  /** The deployment profile the plan was computed from. `deploy all` refuses a plan from the example. */
  profile: { origin: LoadedProfile["origin"]; path: string };
  /** The bot's runtime config: where it comes from, and the state Worker document the runner pushes it to
   *  before the bot step — no `stateWorkerUrl` when the profile has no state Worker (nothing is pushed). */
  config: { source: string; document: string; stateWorkerUrl?: string };
  warnings: string[];
}

/** What the plan reads from the checkout it is computed in. The plan stays
 *  free of node:* imports; the runner (src/deploy/run.ts) supplies the real
 *  probe through the command deps. */
export interface CheckoutProbe {
  /** Does `<repo root>/<dir>/node_modules` exist? */
  hasNodeModules(dir: string): boolean;
}

export function planDeploy(opts: DeployOptions, checkout: CheckoutProbe, loaded: LoadedProfile): DeployPlan {
  const { profile } = loaded;
  // `--affected` selects; `--only` (and `--skip`) can only narrow what it selected.
  const selected = opts.affected
    ? opts.affected.selected.filter((n) => !opts.only || opts.only.includes(n))
    : opts.only;
  const chosen = workersFor(profile).filter(
    (w) => (selected ? selected.includes(w.name) : true) && !(opts.skip ?? []).includes(w.name),
  );
  const steps = chosen.map<DeployStep>((w) => ({
    name: w.name,
    script: w.script,
    dir: w.dir,
    command: ["npm", "run", "deploy"],
    unsetEnv: UNSET_ENV,
    setEnv: w.preflight
      ? { [w.preflight.baseUrlEnv]: w.baseUrl, ...(opts.force ? { [w.preflight.forceEnv]: "1" } : {}) }
      : {},
    ...(opts.force && w.preflight ? { forcedBy: w.preflight.forceEnv } : {}),
    requiredEnv: w.requiredEnv ?? [],
    capabilities: w.capabilities ?? [],
    retryOnPreflightRefusal: !!w.preflight && !opts.force,
    ...(w.waitMaxMs !== undefined ? { waitMaxMs: w.waitMaxMs } : {}),
    ...(w.preflight?.healthUrl ? { healthUrl: w.preflight.healthUrl } : {}),
    ...(w.liveGate ? { liveGate: w.liveGate } : {}),
    ...(!w.liveGate && !w.healthBearerEnv ? { wakeUrl: w.healthUrl } : {}),
    why: w.why,
  }));
  const forcedNames = opts.force ? chosen.filter((w) => w.preflight).map((w) => w.name) : [];
  // `--only` may name a Worker this profile does not have: nothing to deploy for it, said out loud.
  const notInProfile = (opts.only ?? []).filter((n) => profile.workers[n] === undefined);
  const stateWorkerUrl = profileUrls(profile).stateWorkerUrl;
  return {
    steps,
    ...(opts.affected ? { affected: opts.affected } : {}),
    dryRun: opts.dryRun,
    force: opts.force,
    waitMaxMs: opts.waitMaxMinutes * 60_000,
    pollMs: opts.pollSeconds * 1000,
    checks: {
      account: profile.account,
      cleanTree: true,
      atOriginMain: !opts.allowBranch,
      nodeModulesMissing: steps.filter((s) => !checkout.hasNodeModules(s.dir)).map((s) => s.dir),
    },
    profile: { origin: loaded.origin, path: loaded.path },
    config: {
      source: profile.configSource,
      document: CONFIG_DOCUMENT_KEY,
      ...(stateWorkerUrl !== undefined ? { stateWorkerUrl } : {}),
    },
    warnings: [
      ...(loaded.origin === "example"
        ? [
            `profile: ${loaded.path} is the EXAMPLE — this plan can be read, not deployed; write deploy/profile.json for a real installation`,
          ]
        : []),
      ...(notInProfile.length > 0
        ? [`--only names ${notInProfile.join(", ")}: not among this profile's Workers — nothing to deploy for it`]
        : []),
      ...(forcedNames.length > 0
        ? [
            `--force: preflights are bypassed — in-flight runs on ${forcedNames.join(" and ")} are SIGTERM-drained (finish if they can, else killed at the drain deadline)`,
          ]
        : []),
    ],
  };
}

/** Human rendering of a plan (what `--dry-run` prints). */
export function formatPlan(plan: DeployPlan): string {
  const missing = plan.checks.nodeModulesMissing;
  const nodeModules =
    missing.length === 0
      ? "node_modules present in every dir"
      : `node_modules missing in ${missing.join(", ")} — the runner will \`npm ci\` there first`;
  const lines = [
    ...(plan.affected ? [formatAffectedText(plan.affected)] : []),
    `Profile: ${plan.profile.path}${plan.profile.origin === "example" ? " (example)" : ""}; config: ${plan.config.source}${
      plan.config.stateWorkerUrl
        ? ` → document "${plan.config.document}" on ${plan.config.stateWorkerUrl}`
        : " (no state Worker in the profile — not pushed anywhere)"
    }`,
    `Checks: wrangler account = ${plan.checks.account}; clean tree; ${plan.checks.atOriginMain ? "HEAD == origin/main" : "any branch (--allow-branch)"}; ${nodeModules}`,
    ...plan.warnings.map((w) => `WARNING ${w}`),
    plan.steps.length === 0 ? "Steps: none — nothing to deploy" : "Steps:",
  ];
  plan.steps.forEach((s, i) => {
    const pf = s.retryOnPreflightRefusal
      ? ` — preflight (retry every ${plan.pollMs / 1000}s up to ${(s.waitMaxMs ?? plan.waitMaxMs) / 60_000} min)`
      : s.forcedBy
        ? ` — preflight FORCED (${s.forcedBy}=1)`
        : "";
    const env =
      s.requiredEnv.length > 0
        ? ` — needs ${s.requiredEnv.map((r) => (r.anyOf.length === 1 ? r.anyOf[0] : `one of ${r.anyOf.join(" / ")}`)).join(", ")}`
        : "";
    const live = s.liveGate
      ? s.liveGate.kind === "health"
        ? ` — then wait until live (${s.liveGate.healthUrl} not draining + build.commit == HEAD)`
        : ` — then wait until live (${s.liveGate.healthUrl} build.commit == HEAD + every running ${s.liveGate.containerApp} instance on the app version + an /exec probe answers ok from one)`
      : "";
    const cap =
      s.capabilities.length > 0
        ? ` — credential must pass ${s.capabilities.map((c) => `\`${c.command.join(" ")}\` (${c.needs})`).join(" and ")}`
        : "";
    lines.push(
      `  ${i + 1}. ${s.name} (${s.script}) — ${s.dir}: ${s.command.join(" ")}${pf}${env}${cap}${live}\n     ${s.why}`,
    );
  });
  if (plan.dryRun) lines.push("(dry run — nothing executed)");
  return lines.join("\n");
}

/** ANSI colour sequences (ESC `[` … `m`), built from the code point so the regex literal carries no control character. */
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The last non-empty lines of a command's output, ANSI-stripped, wrangler's own
 *  `✘ [ERROR]` lines preferred — the words an operator needs to fix a credential.
 *  (deploy/cloudflare/preflight.mjs `wranglerFailureText` is the same idea on the
 *  plain-Node side of the boundary; the two are pinned by their own tests.) */
export function lastErrorLines(output: string, maxLines = 3): string {
  const lines = output
    .split("\n")
    .map((l) => l.replace(ANSI_SEQUENCE, "").trim())
    .filter((l) => l.length > 0 && !/^npm (ERR|WARN|warn)/i.test(l));
  const errorish = lines.filter((l) =>
    /\[ERROR\]|✘|error|Authentication|Unauthorized|not authorized|permission/i.test(l),
  );
  return (errorish.length > 0 ? errorish : lines).slice(-maxLines).join(" | ");
}

/**
 * The capability pre-check's verdict for one planned step, pure: a non-zero
 * exit of the step's read-only wrangler command means the credential cannot
 * do what this Worker's deploy will need, and the problem names the scope and
 * keeps wrangler's words. `undefined` when the step needs no capability or the
 * command succeeded.
 */
export function capabilityProblem(
  stepName: WorkerName,
  check: CapabilityCheck,
  exitCode: number,
  output: string,
): string | undefined {
  if (exitCode === 0) return undefined;
  const said = lastErrorLines(output) || `exit ${exitCode}, no output`;
  return `${stepName}: the credential cannot \`${check.command.join(" ")}\` — its deploy needs ${check.needs}; grant it on the token, or deploy with a login that has it. wrangler said: ${said}`;
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
export function decideAccount(input: {
  account: string;
  whoamiOutput: string;
  whoamiExit: number;
  tokenSet: boolean;
  tokenVerify?: TokenVerifyResult;
}): { ok: true; how: string } | { ok: false; problem: string } {
  if (input.whoamiOutput.includes(input.account))
    return { ok: true, how: `wrangler whoami lists account ${input.account}` };
  if (input.tokenSet && input.tokenVerify) {
    let status: unknown;
    try {
      status = (JSON.parse(input.tokenVerify.body) as { result?: { status?: unknown } })?.result?.status;
    } catch {
      status = undefined;
    }
    if (input.tokenVerify.status === 200 && status === "active")
      return {
        ok: true,
        how: `CLOUDFLARE_API_TOKEN verifies active against account ${input.account} (account-owned token; wrangler whoami lists no memberships)`,
      };
  }
  const said =
    input.whoamiOutput.trim().split("\n").filter(Boolean).slice(-3).join(" | ") ||
    `exit ${input.whoamiExit}, no output`;
  const verify = input.tokenSet
    ? input.tokenVerify
      ? ` and the token does not verify against it (HTTP ${input.tokenVerify.status})`
      : " and the token could not be verified against it"
    : "";
  const wayOut = input.tokenSet
    ? "unset a CLOUDFLARE_API_TOKEN that belongs to another account, or use one for this account"
    : "run `npx wrangler login` in deploy/cloudflare";
  return {
    ok: false,
    problem: `wrangler whoami does not list account ${input.account} (the deployment profile's)${verify} — ${wayOut}. wrangler said: ${said}`,
  };
}

export type DeployOutcome =
  | { kind: "deployed"; versionId: string | undefined }
  | { kind: "preflight-refused"; reason: string }
  | { kind: "failed"; reason: string };

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
