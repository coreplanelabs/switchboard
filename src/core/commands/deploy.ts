import { z } from "zod";
import type { AffectedReport } from "../../deploy/affected.js";
import {
  DEPLOY_ORDER,
  formatPlan,
  planDeploy,
  type CheckoutProbe,
  type DeployOptions,
  type DeployPlan,
  type WorkerName,
} from "../../deploy/plan.js";
import { planRestart, type RestartPlan } from "../../deploy/restart.js";
import { formatDeployResults, type DeployRunResult, type RestartRunResult } from "../../deploy/run.js";
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
      "bypass the bot/resident preflights — in-flight runs are SIGTERM-drained and killed only at the drain deadline",
    ),
  allowBranch: flag.optional().describe("deploy from a branch other than origin/main (deliberately)"),
  waitMax: positiveInt.optional().describe("minutes to wait out a refusing preflight (default 30)"),
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
    waitMaxMinutes: o.waitMax ?? 30,
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
  const affected = options.affected
    ? await deps.deploy.affected(options.base !== undefined ? { base: options.base } : {})
    : undefined;
  const plan = planDeploy(toOptions(options, dryRun, affected), deps.deploy.checkout);
  if (plan.steps.length === 0 && !affected)
    throw new CommandError("invalid_input", "nothing to deploy after --only/--skip filters");
  return plan;
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
    "Deploy production in the one supported order (memory → bot → resident → sandbox), waiting out preflights and the bot's drain until the new container is live. --affected deploys only the Workers whose inputs changed since what they serve — the release deploy.",
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
    if (!result.ok)
      throw new CommandError(
        "unavailable",
        `deploy stopped —\n${formatDeployResults(result.results, result.notAttempted)}`,
      );
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
    .describe("restart even while runs are in flight — they are SIGTERM-drained and killed only at the drain deadline"),
  waitMax: positiveInt
    .optional()
    .describe("minutes to wait out a refusal (runs in flight) before giving up (default 30)"),
  poll: positiveInt.optional().describe("seconds between retries while refused (default 60)"),
});

export const deployRestart = defineCommand({
  id: "deploy.restart",
  options: restartOptions,
  action: "deploy:write",
  effect: "write",
  surfaces: { chat: false, mcp: false, http: false },
  describe:
    "Restart the bot container without an image build — how a rotated bot secret goes live (~30 s): refused while runs are in flight unless --force; done once /healthz answers with a later startedAt.",
  render: (output) => {
    const o = output as JsonObject;
    return `${o.target} restarted — startedAt ${o.startedAt} (was ${o.previousStartedAt ?? "unknown"}), live after ${Math.round((o.waitedMs as number) / 1000)}s`;
  },
  handler: async ({ options, deps }) => {
    const plan = planRestart({
      only: options.only ?? "bot",
      force: options.force ?? false,
      waitMaxMinutes: options.waitMax ?? 30,
      pollSeconds: options.poll ?? 60,
    });
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

export const deployCommands: readonly CommandDef<DeployCommandDeps>[] = [
  deployPlan,
  deployAll,
  deployRestart,
] as unknown as CommandDef<DeployCommandDeps>[];

export function registerDeployCommands<D extends DeployCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of deployCommands) registry.register(cmd as unknown as CommandDef<D>);
}
