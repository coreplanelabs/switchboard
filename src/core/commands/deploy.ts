import { z } from "zod";
import { DEPLOY_ORDER, formatPlan, planDeploy, type CheckoutProbe, type DeployOptions, type DeployPlan, type WorkerName } from "../../deploy/plan.js";
import { formatDeployResults, type DeployRunResult } from "../../deploy/run.js";
import { CommandError, commandDefiner, flag, type CommandDef, type CommandRegistry, type JsonObject, type JsonValue } from "../commandRegistry.js";

// The `deploy.*` registrations (phase 4b): the production deploy order as
// commands. `deploy plan` is pure — the plan `planDeploy` computes from the
// options (every surface; a browser can read what a deploy WOULD do). `deploy
// all` executes it (CLI only: it spawns wrangler on the operator's machine) —
// the former `npm run deploy:all` script. Same options on both, so a plan you
// read is the plan you run.

export interface DeployCommandDeps {
  deploy: {
    run(plan: DeployPlan): Promise<DeployRunResult>;
    /** The checkout the plan describes — which step dirs lack `node_modules` (`checks.nodeModulesMissing`). */
    checkout: CheckoutProbe;
  };
}

const defineCommand = commandDefiner<DeployCommandDeps>();

const workerList = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
  .refine((names) => names.every((n) => (DEPLOY_ORDER as readonly string[]).includes(n)), `expected a comma list of Workers (${DEPLOY_ORDER.join(", ")})`)
  .transform((names) => [...new Set(names)] as WorkerName[]);
const positiveInt = z.coerce.number().int().positive();

const deployOptions = z.object({
  only: workerList.optional().describe(`deploy only these Workers (comma list of ${DEPLOY_ORDER.join(", ")})`),
  skip: workerList.optional().describe("skip these Workers (comma list)"),
  force: flag.optional().describe("bypass the bot/resident preflights — in-flight runs WILL be killed"),
  allowBranch: flag.optional().describe("deploy from a branch other than origin/main (deliberately)"),
  waitMax: positiveInt.optional().describe("minutes to wait out a refusing preflight (default 30)"),
  poll: positiveInt.optional().describe("seconds between preflight retries (default 60)"),
});

function toOptions(o: z.output<typeof deployOptions>, dryRun: boolean): DeployOptions {
  return {
    only: o.only,
    skip: o.skip,
    dryRun,
    force: o.force ?? false,
    allowBranch: o.allowBranch ?? false,
    waitMaxMinutes: o.waitMax ?? 30,
    pollSeconds: o.poll ?? 60,
  };
}

const planJson = (plan: DeployPlan): JsonValue => plan as unknown as JsonValue;

export const deployPlan = defineCommand({
  id: "deploy.plan",
  options: deployOptions,
  scope: "deploy:read",
  chatGate: "operator",
  effect: "read",
  describe: "The production deploy plan: checks, Worker order, preflight handling — computed, nothing executed.",
  render: (output) => formatPlan(output as unknown as DeployPlan),
  handler: async ({ options, deps }) => {
    const plan = planDeploy(toOptions(options, true), deps.deploy.checkout);
    if (plan.steps.length === 0) throw new CommandError("invalid_input", "nothing to deploy after --only/--skip filters");
    return planJson(plan);
  },
});

export const deployAll = defineCommand({
  id: "deploy.all",
  options: deployOptions,
  scope: "deploy:write",
  chatGate: "operator",
  effect: "write",
  surfaces: { chat: false, mcp: false, http: false },
  describe: "Deploy production in the one supported order (memory → bot → resident → sandbox), waiting out preflights and the bot's drain until the new container is live.",
  render: (output) => {
    const o = output as JsonObject;
    return `deployed and live\n${formatDeployResults(o.results as unknown as Parameters<typeof formatDeployResults>[0], [])}`;
  },
  handler: async ({ options, deps }) => {
    const plan = planDeploy(toOptions(options, false), deps.deploy.checkout);
    if (plan.steps.length === 0) throw new CommandError("invalid_input", "nothing to deploy after --only/--skip filters");
    const result = await deps.deploy.run(plan);
    if (result.kind === "refused") throw new CommandError("unavailable", `refusing —\n  - ${result.problems.join("\n  - ")}`);
    if (!result.ok) throw new CommandError("unavailable", `deploy stopped —\n${formatDeployResults(result.results, result.notAttempted)}`);
    return { plan: planJson(plan), results: result.results as unknown as JsonValue };
  },
});

export const deployCommands: readonly CommandDef<DeployCommandDeps>[] = [deployPlan, deployAll] as unknown as CommandDef<DeployCommandDeps>[];

export function registerDeployCommands<D extends DeployCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of deployCommands) registry.register(cmd as unknown as CommandDef<D>);
}
