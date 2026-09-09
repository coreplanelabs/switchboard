import { z } from "zod";
import type { AffectedReport } from "../../deploy/affected.js";
import {
  CONFIG_DOCUMENT_KEY,
  DEPLOY_ORDER,
  formatPlan,
  planDeploy,
  type CheckoutProbe,
  type DeployOptions,
  type DeployPlan,
  type WorkerName,
} from "../../deploy/plan.js";
import type { LoadedProfile } from "../../deploy/profile.js";
import { planRestart, type RestartPlan } from "../../deploy/restart.js";
import {
  formatDeployResults,
  type ConfigPushOutcome,
  type DeployRunResult,
  type RestartRunResult,
} from "../../deploy/run.js";
import { profileUrls } from "../../deploy/profile.js";
import {
  PROJECT_FACTS_FILE,
  renderSiteConfig,
  renderWorkerConfig,
  renderWorkerConfigs,
  SITE_CONFIG_TARGET,
  workerConfigTargets,
} from "../../deploy/wranglerTemplate.js";
import {
  MANIFEST_PATH,
  parseManifest,
  parseSecretsSource,
  planSecretPuts,
  secretRef,
  wranglerFailureLine,
} from "../../deploy/secrets.js";
import type { SecretsHostIO } from "../../deploy/secretsHost.js";
import {
  CommandError,
  commandDefiner,
  flag,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";

// The `deploy.*` registrations (phase 4b): the production deploy order as
// commands. `deploy plan` is pure — the plan `planDeploy` computes from the
// options (every surface; a browser can read what a deploy WOULD do). `deploy
// all` executes it (CLI only: it spawns wrangler on the operator's machine) —
// the former `npm run deploy:all` script. Same options on both, so a plan you
// read is the plan you run. `deploy restart` (item 8) restarts the bot
// container WITHOUT a build — how a rotated bot secret goes live — through the
// Worker's `POST /admin/restart`; CLI only like `deploy all`: it is an
// operator action that stops a container and reads the bearer from the
// operator's env.

export interface DeployCommandDeps {
  deploy: {
    run(plan: DeployPlan): Promise<DeployRunResult>;
    /** `deploy restart`: POST the admin route, wait out a refusal, gate on a later `startedAt` (src/deploy/run.ts `runBotRestart`). */
    restart(plan: RestartPlan): Promise<RestartRunResult>;
    /** The checkout the plan describes — which step dirs lack `node_modules` (`checks.nodeModulesMissing`). */
    checkout: CheckoutProbe;
    /** `--affected`: which Workers this tree needs deployed, judged per Worker against what it serves (or `base`) — src/deploy/affected.ts over the host (src/deploy/run.ts `computeAffectedOnHost`). */
    affected(opts: { base?: string }): Promise<AffectedReport>;
    /** The installation the plan is for (src/deploy/profile.ts): `deploy/profile.json`, else the example — which `deploy all` refuses. Throws (→ `unavailable`) when the file is invalid. */
    profile(): Promise<LoadedProfile>;
    /** `deploy init`'s file access, repo-relative: the templates and rendered configs under deploy/ (src/deploy/run.ts `hostDeployFiles`). */
    files: {
      read(path: string): Promise<string | undefined>;
      write(path: string, text: string): Promise<void>;
    };
    /** `deploy secrets`: the manifest, which names the source has a value for, and one `wrangler secret put` (src/deploy/secretsHost.ts). */
    secrets: SecretsHostIO;
    /** `deploy config`: read the source, validate, push the `base` document to the state Worker (src/deploy/run.ts `pushConfigOnHost`). */
    pushConfig(opts: { source: string; stateWorkerUrl: string; key: string }): Promise<ConfigPushOutcome>;
  };
}

const defineCommand = commandDefiner<DeployCommandDeps>();

const workerList = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .refine(
    (names) => names.every((n) => (DEPLOY_ORDER as readonly string[]).includes(n)),
    `expected a comma list of Workers (${DEPLOY_ORDER.join(", ")})`,
  )
  .transform((names) => [...new Set(names)] as WorkerName[]);
const positiveInt = z.coerce.number().int().positive();
/** A git revision as `git rev-parse` accepts one — never shell-interpreted, but keep it to revision
 *  characters, and never a leading `-`: that would reach git's argv looking like an option. */
const gitRef = z
  .string()
  .regex(/^[A-Za-z0-9_./^~@{}][A-Za-z0-9_./^~@{}-]{0,199}$/, "expected a git revision (a sha, tag, branch, or HEAD^)");

const deployOptions = z.object({
  only: workerList
    .optional()
    .describe(
      `deploy only these Workers (comma list of ${DEPLOY_ORDER.join(", ")}); with --affected, only those of them that are affected`,
    ),
  skip: workerList.optional().describe("skip these Workers (comma list)"),
  affected: flag
    .optional()
    .describe(
      "select the Workers whose inputs changed since the commit each one serves (its /healthz build.commit; else the last release tag; else unsure → deploy) — what the release deploy runs",
    ),
  base: gitRef
    .optional()
    .describe(
      "with --affected: judge every Worker against this revision instead of what it serves (a PR's CI uses HEAD^)",
    ),
  force: flag
    .optional()
    .describe(
      "bypass the bot/resident preflights — deploy over a rollout in progress, or blind when a Worker cannot be consulted (in-flight bot runs hand off regardless)",
    ),
  allowBranch: flag.optional().describe("deploy from a branch other than origin/main (deliberately)"),
  waitMax: positiveInt
    .optional()
    .describe("minutes to wait out a refusing preflight — a container rollout still settling (default 10)"),
  poll: positiveInt.optional().describe("seconds between preflight retries (default 60)"),
});

function toOptions(
  o: z.output<typeof deployOptions>,
  dryRun: boolean,
  affected: AffectedReport | undefined,
): DeployOptions {
  return {
    only: o.only,
    skip: o.skip,
    ...(affected ? { affected } : {}),
    dryRun,
    force: o.force ?? false,
    allowBranch: o.allowBranch ?? false,
    waitMaxMinutes: o.waitMax ?? 10,
    pollSeconds: o.poll ?? 60,
  };
}

/** The plan both commands compute: `--affected` asks the probe and lets the
 *  report select (`--only`/`--skip` then narrow that selection); otherwise
 *  `--only/--skip` select, and an empty selection is a mistake in the
 *  invocation. An empty AFFECTED selection is a true answer. */
async function computePlan(
  options: z.output<typeof deployOptions>,
  deps: DeployCommandDeps,
  dryRun: boolean,
): Promise<DeployPlan> {
  if (options.base !== undefined && !options.affected)
    throw new CommandError("invalid_input", "--base only means something with --affected");
  const loaded = await loadProfile(deps);
  const affected = options.affected
    ? await deps.deploy.affected(options.base !== undefined ? { base: options.base } : {})
    : undefined;
  const plan = planDeploy(toOptions(options, dryRun, affected), deps.deploy.checkout, loaded);
  if (plan.steps.length === 0 && !affected)
    throw new CommandError("invalid_input", "nothing to deploy after --only/--skip filters");
  return plan;
}

/** The profile, or `unavailable` naming what is wrong with it — the one error a caller can act on. */
async function loadProfile(deps: DeployCommandDeps): Promise<LoadedProfile> {
  try {
    return await deps.deploy.profile();
  } catch (err) {
    throw new CommandError("unavailable", `deployment profile: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const planJson = (plan: DeployPlan): JsonValue => plan as unknown as JsonValue;

export const deployPlan = defineCommand({
  id: "deploy.plan",
  options: deployOptions,
  action: "deploy:read",
  effect: "read",
  describe:
    "The production deploy plan: checks, Worker order, preflight handling — computed, nothing executed. With --affected, also which Workers this tree actually needs deployed and why.",
  render: (output) => formatPlan(output as unknown as DeployPlan),
  handler: async ({ options, deps }) => planJson(await computePlan(options, deps, true)),
});

export const deployAll = defineCommand({
  id: "deploy.all",
  options: deployOptions,
  action: "deploy:write",
  effect: "write",
  surfaces: { chat: false, mcp: false, http: false },
  describe:
    "Deploy production in the one supported order (memory → bot → resident → sandbox), waiting out preflights and each live gate — the bot's drain, the sandbox's image rollout and an `echo ok` probe — until the new containers are live. --affected deploys only the Workers whose inputs changed since what they serve — the release deploy.",
  render: (output) => {
    const o = output as JsonObject;
    const results = o.results as unknown as Parameters<typeof formatDeployResults>[0];
    if (results.length === 0)
      return `nothing to deploy — every Worker already serves this tree's inputs\n${formatPlan(o.plan as unknown as DeployPlan)}`;
    return `deployed and live\n${formatDeployResults(results, [])}`;
  },
  handler: async ({ options, deps }) => {
    const plan = await computePlan(options, deps, false);
    if (plan.steps.length === 0) return { plan: planJson(plan), results: [] };
    const result = await deps.deploy.run(plan);
    if (result.kind === "refused")
      throw new CommandError("unavailable", `refusing —\n  - ${result.problems.join("\n  - ")}`);
    if (!result.ok) {
      // The run stops at its first failure, so at most one result failed; every
      // failure needs a person. (Runs in flight no longer hold a deploy — the
      // handoff, run-history item 39 — so a preflight still refusing past the
      // wait budget is a rollout stuck in progress, not a busy bot.)
      throw new CommandError(
        "unavailable",
        `deploy stopped —\n${formatDeployResults(result.results, result.notAttempted)}`,
      );
    }
    return { plan: planJson(plan), results: result.results as unknown as JsonValue };
  },
});

const restartOptions = z.object({
  only: z
    .enum(["bot"])
    .optional()
    .describe("the Worker to restart — only `bot` has a long-lived container (default bot)"),
  force: flag
    .optional()
    .describe(
      "restart even when the bot cannot be consulted (no JSON on /healthz) — the fail-closed cases; runs in flight never refuse, they hand off",
    ),
  waitMax: positiveInt
    .optional()
    .describe("minutes to wait out a refusal (the bot not answering with JSON) before giving up (default 10)"),
  poll: positiveInt.optional().describe("seconds between retries while refused (default 60)"),
});

export const deployRestart = defineCommand({
  id: "deploy.restart",
  options: restartOptions,
  action: "deploy:write",
  effect: "write",
  surfaces: { chat: false, mcp: false, http: false },
  describe:
    "Restart the bot container without an image build — how a rotated bot secret goes live (~30 s): runs in flight hand off to the next container; done once /healthz answers with a later startedAt.",
  render: (output) => {
    const o = output as JsonObject;
    return `${o.target} restarted — startedAt ${o.startedAt} (was ${o.previousStartedAt ?? "unknown"}), live after ${Math.round((o.waitedMs as number) / 1000)}s`;
  },
  handler: async ({ options, deps }) => {
    const loaded = await loadProfile(deps);
    if (loaded.origin === "example")
      throw new CommandError(
        "unavailable",
        `${loaded.path} is the example profile — write deploy/profile.json for this installation before restarting its bot`,
      );
    const plan = planRestart(
      {
        only: options.only ?? "bot",
        force: options.force ?? false,
        waitMaxMinutes: options.waitMax ?? 10,
        pollSeconds: options.poll ?? 60,
      },
      loaded.profile,
    );
    const result = await deps.deploy.restart(plan);
    if (result.kind === "refused")
      throw new CommandError("unavailable", `refusing —\n  - ${result.problems.join("\n  - ")}`);
    if (!result.ok)
      throw new CommandError("unavailable", `${plan.target} NOT restarted — ${result.reason ?? "unknown reason"}`);
    return {
      target: result.target,
      previousStartedAt: result.previousStartedAt ?? null,
      startedAt: result.startedAt ?? null,
      waitedMs: result.waitedMs,
    };
  },
});

const initOptions = z.object({
  check: flag
    .optional()
    .describe(
      "compare only: report each rendered file that differs from the one on disk and fail when any does (the `deploy:check` gate); nothing is written",
    ),
});

/** What `deploy init` found for one rendered file. `stale`/`missing` only under --check (without it, the file is written). */
type InitStatus = "unchanged" | "written" | "stale" | "missing";
interface InitOutput {
  profile: { origin: LoadedProfile["origin"]; path: string };
  files: { path: string; status: InitStatus }[];
}

export const deployInit = defineCommand({
  id: "deploy.init",
  options: initOptions,
  action: "deploy:write",
  effect: "write",
  surfaces: { chat: false, mcp: false, http: false },
  describe:
    "Render every Worker's wrangler.jsonc from the wrangler.template.jsonc beside it and the deployment profile, and the project's docs site's from project.json — generated files, never hand-edited. --check compares without writing (the `deploy:check` gate).",
  render: (output) => {
    const o = output as unknown as InitOutput;
    const from = `${o.profile.path}${o.profile.origin === "example" ? " (the EXAMPLE profile)" : ""}`;
    return [`Worker configs from ${from}:`, ...o.files.map((f) => `  ${f.status.padEnd(9)} ${f.path}`)].join("\n");
  },
  handler: async ({ options, deps }) => {
    const loaded = await loadProfile(deps);
    const templates = new Map<string, string | undefined>();
    for (const t of [...workerConfigTargets(loaded.profile), SITE_CONFIG_TARGET])
      templates.set(t.templatePath, await deps.deploy.files.read(t.templatePath));
    const rendered = renderWorkerConfigs(loaded.profile, (path) => templates.get(path));
    // The docs site is the project's, not a Worker of the installation: its script name and
    // hostname come from project.json, and only the account comes from the profile.
    const site = renderSiteConfig(loaded.profile, await deps.deploy.files.read(PROJECT_FACTS_FILE), (path) =>
      templates.get(path),
    );
    const problems = [...(rendered.ok ? [] : rendered.problems), ...(site.ok ? [] : site.problems)];
    if (!rendered.ok || !site.ok)
      throw new CommandError("unavailable", `cannot render the Worker configs —\n  - ${problems.join("\n  - ")}`);
    const files: InitOutput["files"] = [];
    for (const f of [...rendered.files, site]) {
      const current = await deps.deploy.files.read(f.path);
      let status: InitStatus;
      if (current === f.text) status = "unchanged";
      else if (options.check) status = current === undefined ? "missing" : "stale";
      else {
        await deps.deploy.files.write(f.path, f.text);
        status = "written";
      }
      files.push({ path: f.path, status });
    }
    const drift = files.filter((f) => f.status === "stale" || f.status === "missing");
    if (drift.length > 0)
      throw new CommandError(
        "conflict",
        `Worker configs are not the render of their templates — ${drift.map((f) => `${f.path} (${f.status})`).join(", ")}; run \`npm run deploy:gen\` and commit the result`,
      );
    const output: InitOutput = { profile: { origin: loaded.origin, path: loaded.path }, files };
    return output as unknown as JsonValue;
  },
});

/** Render ONE Worker's wrangler.jsonc from its template and the loaded profile and write it
 *  when absent or stale — the part of `deploy init` a single-Worker command needs before it
 *  spawns wrangler in that directory. A template that cannot render is `unavailable`. */
async function writeWorkerConfig(loaded: LoadedProfile, worker: WorkerName, deps: DeployCommandDeps): Promise<void> {
  const target = workerConfigTargets(loaded.profile).find((t) => t.kind === worker);
  if (!target) throw new CommandError("unavailable", `${loaded.path}: the profile has no ${worker} Worker`);
  const template = await deps.deploy.files.read(target.templatePath);
  const rendered = renderWorkerConfig(loaded.profile, worker, () => template);
  if (!rendered.ok)
    throw new CommandError(
      "unavailable",
      `cannot render ${target.outputPath} —\n  - ${rendered.problems.join("\n  - ")}`,
    );
  if ((await deps.deploy.files.read(rendered.path)) !== rendered.text)
    await deps.deploy.files.write(rendered.path, rendered.text);
}

const configOptions = z.object({
  source: z
    .string()
    .min(1)
    .optional()
    .describe(
      "read the config from this source instead of the profile's configSource (a path, github://owner/repo/path@ref, or op://Vault/Item/field)",
    ),
});

interface ConfigPushOutput {
  source: string;
  how: string;
  document: string;
  stateWorkerUrl: string;
  version: number;
  sha256: string;
  bytes: number;
}

export const deployConfig = defineCommand({
  id: "deploy.config",
  options: configOptions,
  action: "deploy:write",
  effect: "write",
  surfaces: { chat: false, mcp: false, http: false },
  describe:
    "Push the bot's config to the state Worker as the `base` document the bot reads at startup — from the profile's configSource (or --source), validated first. The running container keeps its config until `deploy restart`.",
  render: (output) => {
    const o = output as unknown as ConfigPushOutput;
    return `pushed ${o.how} → document "${o.document}" v${o.version} on ${o.stateWorkerUrl} (sha256 ${o.sha256.slice(0, 12)}, ${o.bytes} bytes)\nthe bot reads it on its next start: \`deploy restart\``;
  },
  handler: async ({ options, deps }) => {
    const loaded = await loadProfile(deps);
    const source = options.source ?? loaded.profile.configSource;
    const stateWorkerUrl = profileUrls(loaded.profile).stateWorkerUrl;
    if (stateWorkerUrl === undefined)
      throw new CommandError(
        "unavailable",
        `${loaded.path} names no memory (state) Worker — there is no document to push the config to; the bot reads its config from SWITCHBOARD_CONFIG`,
      );
    const pushed = await deps.deploy.pushConfig({ source, stateWorkerUrl, key: CONFIG_DOCUMENT_KEY });
    if (!pushed.ok) throw new CommandError("unavailable", pushed.problem);
    const output: ConfigPushOutput = {
      source,
      how: pushed.how,
      document: CONFIG_DOCUMENT_KEY,
      stateWorkerUrl,
      version: pushed.version,
      sha256: pushed.sha256,
      bytes: pushed.bytes,
    };
    return output as unknown as JsonValue;
  },
});

const secretNames = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .refine(
    (names) => names.length > 0 && names.every((n) => /^[A-Z][A-Z0-9_]*$/.test(n)),
    "expected a comma list of secret names (SCREAMING_SNAKE)",
  )
  .transform((names) => [...new Set(names)]);

const secretsOptions = z.object({
  only: secretNames
    .optional()
    .describe("put only these secrets (comma list of names from deploy/secrets.manifest.json)"),
});

interface SecretsOutput {
  worker: WorkerName;
  dir: string;
  /** Where the values were read from, with `<NAME>` for the secret — never a value. */
  source: string;
  put: string[];
  skippedOptional: string[];
}

export const deploySecrets = defineCommand({
  id: "deploy.secrets",
  args: [
    {
      name: "worker",
      schema: z.enum(DEPLOY_ORDER as [WorkerName, ...WorkerName[]]),
      describe: `the Worker to provision (${DEPLOY_ORDER.join(", ")})`,
    },
  ],
  options: secretsOptions,
  action: "deploy:write",
  effect: "write",
  surfaces: { chat: false, mcp: false, http: false },
  describe:
    "Put a Worker's secrets from the deployment profile's secretsSource (a directory of <NAME> files, or an op://Vault/Item): every name deploy/secrets.manifest.json lists for it, refused before any upload when a required value is absent. Values ride stdin into `wrangler secret put`; none is ever printed.",
  render: (output) => {
    const o = output as unknown as SecretsOutput;
    return [
      ...o.skippedOptional.map((n) => `skip  ${n} (optional; no value at ${o.source.replace("<NAME>", n)})`),
      ...o.put.map((n) => `put   ${n} → ${o.dir}`),
      `done: ${o.put.length} secret(s) on ${o.worker} from ${o.source}`,
    ].join("\n");
  },
  handler: async ({ args, options, deps }) => {
    const worker = args.worker;
    const loaded = await loadProfile(deps);
    const source = parseSecretsSource(loaded.profile.secretsSource);
    if (!source.ok) throw new CommandError("unavailable", `${loaded.path}: ${source.problem}`);
    const raw = await deps.deploy.secrets.manifest();
    if (raw === undefined) throw new CommandError("unavailable", `${MANIFEST_PATH}: no such file`);
    const manifest = parseManifest(raw);
    if (!manifest.ok)
      throw new CommandError("unavailable", `${MANIFEST_PATH} is invalid —\n  - ${manifest.problems.join("\n  - ")}`);
    const mine = manifest.manifest.secrets.filter((s) => s.workers.includes(worker)).map((s) => s.name);
    const present = await deps.deploy.secrets.present(source.source, mine);
    if (!present.ok) throw new CommandError("unavailable", present.problem);
    const planned = planSecretPuts(manifest.manifest, worker, present.present, options.only);
    if (!planned.ok) throw new CommandError("invalid_input", planned.problem);
    const { plan } = planned;
    const where = secretRef(source.source, "<NAME>");
    if (plan.missing.length > 0)
      throw new CommandError(
        "unavailable",
        `refusing: no value for required ${worker} secret(s) ${plan.missing.join(", ")} — expected ${where}. Nothing uploaded.`,
      );
    // wrangler reads the script and account from the Worker dir's wrangler.jsonc, a
    // generated file that a clean checkout does not have — render it from the profile
    // first, as `deploy all` does, instead of letting wrangler fail on a missing name.
    await writeWorkerConfig(loaded, worker, deps);
    for (const [i, name] of plan.puts.entries()) {
      const r = await deps.deploy.secrets.put(source.source, plan.dir, name);
      if (r.code !== 0) {
        const rest = plan.puts.slice(i + 1);
        const said = wranglerFailureLine(r.output);
        throw new CommandError(
          "unavailable",
          `wrangler secret put ${name} failed (exit ${r.code}) in ${plan.dir}; stopping — ${rest.length > 0 ? rest.join(", ") : "nothing"} not attempted${said ? `. ${said}` : ""}`,
        );
      }
    }
    const output: SecretsOutput = {
      worker,
      dir: plan.dir,
      source: where,
      put: plan.puts,
      skippedOptional: plan.skippedOptional,
    };
    return output as unknown as JsonValue;
  },
});

export const deployCommands: readonly CommandDef<DeployCommandDeps>[] = [
  deployPlan,
  deployAll,
  deployRestart,
  deployInit,
  deploySecrets,
  deployConfig,
] as unknown as CommandDef<DeployCommandDeps>[];

export function registerDeployCommands<D extends DeployCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of deployCommands) registry.register(cmd as unknown as CommandDef<D>);
}
