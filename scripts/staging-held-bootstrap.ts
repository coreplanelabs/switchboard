import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRAIN, SECOND_MS, MINUTE_MS, minutesToMs } from "../src/core/budgets.js";
import { systemClock } from "../src/core/trace/clock.js";
import { OPERATOR_ROOT } from "../src/deploy/host.js";
import { planDeploy } from "../src/deploy/plan.js";
import {
  defaultSandboxGateDeps,
  deployHostOnHost,
  loadProfileOnHost,
  readConfigForPush,
  run,
  runDeployPlanOnHost,
} from "../src/deploy/run.js";
import {
  runHeldStagingBootstrap,
  type BootstrapWorkflowRun,
  type HeldBootstrapRequest,
} from "../src/deploy/stagingHeldBootstrap.js";
import type { ResidentImageTarget } from "../src/deploy/residentMaintenance.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--receipt" || !args[1])
  throw new Error("staging:bootstrap-held requires --receipt <path>");
const receiptPath = args[1];
const env = process.env;
const request: HeldBootstrapRequest = {
  repository: env.GITHUB_REPOSITORY ?? "",
  pullRequest: Number(env.STAGING_PR_NUMBER),
  branch: env.GITHUB_REF_NAME ?? "",
  commit: env.STAGING_COMMIT ?? "",
  controllerCommit: env.STAGING_CONTROLLER_COMMIT ?? "",
  workflowRef: env.GITHUB_WORKFLOW_REF ?? "",
  event: env.GITHUB_EVENT_NAME ?? "",
  actorId: Number(env.GITHUB_ACTOR_ID),
  runId: Number(env.GITHUB_RUN_ID),
  runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
  attemptId: env.STAGING_BOOTSTRAP_ATTEMPT ?? "",
  profileRef: env.SWITCHBOARD_DEPLOY_PROFILE ?? "",
  previousCommit: env.STAGING_BOOTSTRAP_PREVIOUS_COMMIT ?? "",
  previousWorkerVersion: env.STAGING_BOOTSTRAP_PREVIOUS_VERSION ?? "",
};
const io = { log: console.log, warn: console.warn, stream: (chunk: string) => process.stdout.write(chunk) };
const write = (value: Record<string, unknown>) =>
  writeFileSync(receiptPath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
write({ schema: 1, kind: "staging-held-bootstrap", outcome: "unverified", request });
const actual = await run("git", ["rev-parse", "HEAD"], { cwd: OPERATOR_ROOT.root });
const checkout = {
  commit: /^[0-9a-f]{40}$/.test(actual.output.trim()) ? actual.output.trim() : null,
  exitCode: actual.code,
  mode: OPERATOR_ROOT.mode,
};
if (actual.code !== 0 || actual.output.trim() !== request.commit || OPERATOR_ROOT.mode !== "checkout") {
  write({ schema: 1, kind: "staging-held-bootstrap", outcome: "unverified", request, checkout });
  throw new Error(
    `bootstrap checkout does not match the selected source: head=${checkout.commit ?? "unverified"} mode=${checkout.mode} exit=${checkout.exitCode}`,
  );
}
for (const name of [
  "CLOUDFLARE_API_TOKEN",
  "RESIDENT_READ_TOKEN",
  "RESIDENT_DRAIN_TOKEN",
  "CONFIG_REPO_TOKEN",
  "GH_TOKEN",
])
  if (!env[name]) throw new Error(`bootstrap input ${name} is required`);
await runHeldStagingBootstrap(
  request,
  {
    staging: env.SWITCHBOARD_STAGING_ACCOUNT,
    production: env.SWITCHBOARD_PRODUCTION_ACCOUNT,
    configRepository: `${env.CONFIG_REPO_OWNER}/${env.CONFIG_REPO_NAME}`,
  },
  {
    now: systemClock,
    receipt: write,
    loadProfile: loadProfileOnHost,
    readConfig: async (source) => {
      const read = await readConfigForPush(source);
      if (!read.ok) throw new Error(read.problem);
      return read.text;
    },
    history: async () => {
      const rows: BootstrapWorkflowRun[] = [];
      let total: number | undefined;
      for (let page = 1; page <= 10; page++) {
        const response = await fetch(
          `https://api.github.com/repos/${request.repository}/actions/workflows/deploy-staging-bootstrap.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`,
          {
            headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json" },
            redirect: "error",
            signal: AbortSignal.timeout(DRAIN.pollMs),
          },
        );
        if (!response.ok) throw new Error(`bootstrap history is unreadable (HTTP ${response.status})`);
        const data = (await response.json()) as { total_count: number; workflow_runs: BootstrapWorkflowRun[] };
        if (
          !Number.isSafeInteger(data.total_count) ||
          data.total_count < 0 ||
          !Array.isArray(data.workflow_runs) ||
          (total !== undefined && total !== data.total_count)
        )
          throw new Error("bootstrap history is incomplete or changed");
        total = data.total_count;
        rows.push(...data.workflow_runs);
        if (data.workflow_runs.length < 100) break;
      }
      if (rows.length !== total || new Set(rows.map((row) => row.id)).size !== rows.length)
        throw new Error("bootstrap history is incomplete");
      return rows;
    },
    read: (url, timeout) =>
      defaultSandboxGateDeps.readHealth(url, url.endsWith("/healthz") ? undefined : env.RESIDENT_READ_TOKEN, timeout),
    deploy: async (loaded, text, previousVersion) => {
      const directory = mkdtempSync(join(tmpdir(), "switchboard-held-bootstrap-"));
      try {
        const configPath = join(directory, "config.yaml");
        writeFileSync(configPath, text, { mode: 0o600 });
        const frozen = { ...loaded, profile: { ...loaded.profile, configSource: configPath } };
        const plan = planDeploy(
          {
            only: ["resident"],
            skip: undefined,
            force: true,
            retainMaintenance: true,
            allowBranch: true,
            dryRun: false,
            waitMaxMinutes: DRAIN.deployWaitMaxMs / MINUTE_MS,
            pollSeconds: DRAIN.pollMs / SECOND_MS,
          },
          deployHostOnHost(),
          frozen,
          { mode: "build" },
        );
        plan.steps[0]!.setEnv.RESIDENT_BOOTSTRAP_PREVIOUS_VERSION = previousVersion;
        plan.steps[0]!.setEnv.RESIDENT_BOOTSTRAP_RESOURCES = JSON.stringify(
          loaded.profile.residentMaintenance!.resources,
        );
        plan.steps[0]!.setEnv.RESIDENT_BOOTSTRAP_UPLOAD_RESERVE_MS = String(
          minutesToMs(DRAIN.deployFenceMinRemainingMinutes),
        );
        let target: ResidentImageTarget | undefined;
        const deadline = loaded.profile.residentMaintenance!.attempt.deadline;
        const signal = AbortSignal.timeout(Math.max(1, deadline - systemClock()));
        const result = await runDeployPlanOnHost(plan, io, {
          ...defaultSandboxGateDeps,
          signal,
          readAppState: async (...parameters) => {
            const read = await defaultSandboxGateDeps.readAppState(...parameters);
            if ("value" in read && read.value.image)
              target = { application: parameters[1], version: read.value.version, image: read.value.image };
            return read;
          },
        });
        return { result, target };
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  },
);
console.log("Staging bootstrap: image-ready, maintenance held; normal staging acceptance remains pending.");
