import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { stagingProblems } from "./staging.js";
import { TEST_PROFILE } from "./testing/profile.js";
import type { DeploymentProfile } from "./profile.js";

const accounts = { staging: "abcdef1234567890".repeat(2), production: TEST_PROFILE.account };
function fixture(): { profile: DeploymentProfile; config: AppConfig } {
  const profile: DeploymentProfile = {
    ...TEST_PROFILE,
    account: accounts.staging,
    workers: {
      memory: { script: "switchboard-staging-memory", hostname: "staging-memory.example.test" },
      bot: { script: "switchboard-staging", hostname: "staging.example.test" },
      resident: { script: "switchboard-staging-resident", hostname: "staging-resident.example.test" },
      sandbox: { script: "switchboard-staging-sandbox", hostname: "staging-sandbox.example.test" },
    },
    artifacts: { bucket: "switchboard-staging-artifacts" },
    metrics: { dataset: "switchboard_staging_runs" },
  };
  const config = {
    runHistory: { worker: { baseUrl: "https://staging-memory.example.test" } },
    runtimeOverrides: { worker: { baseUrl: "https://staging-memory.example.test" } },
    memory: { worker: { baseUrl: "https://staging-memory.example.test" } },
    execution: {
      type: "cloudflare",
      url: "https://staging-sandbox.example.test",
      resident: { baseUrl: "https://staging-resident.example.test" },
    },
    artifacts: { r2: { accountId: accounts.staging, bucket: "switchboard-staging-artifacts" } },
    metrics: { dataset: "switchboard_staging_runs" },
  } as AppConfig;
  return { profile, config };
}

describe("isolated staging deployment", () => {
  it("the CLI checks real profile/config inputs without credentials and rejects a production state endpoint", () => {
    const { profile, config } = fixture();
    const directory = mkdtempSync(join(tmpdir(), "staging-cli-"));
    try {
      const configPath = join(directory, "config.yaml");
      const profilePath = join(directory, "profile.json");
      writeFileSync(profilePath, JSON.stringify({ ...profile, configSource: configPath }));
      const complete = {
        ...parse(readFileSync("config/config.example.yaml", "utf8")),
        ...config,
        grants: { "http:staging": { actions: ["dispatch"], channels: ["http:staging"] } },
      };
      writeFileSync(configPath, stringify(complete));
      const env = {
        ...process.env,
        SWITCHBOARD_DEPLOY_PROFILE: profilePath,
        SWITCHBOARD_STAGING_ACCOUNT: accounts.staging,
        SWITCHBOARD_PRODUCTION_ACCOUNT: accounts.production,
        CLOUDFLARE_API_TOKEN: "",
        MEMORY_TOKEN: "",
        RESIDENT_READ_TOKEN: "",
        RESIDENT_DRAIN_TOKEN: "",
        SANDBOX_TOKEN: "",
      };
      const invoke = (...args: string[]) =>
        spawnSync(process.execPath, ["--import", "tsx", "scripts/staging-deploy.ts", ...args], {
          encoding: "utf8",
          env,
        });
      const passed = invoke("--check");
      expect(passed.status, passed.stderr).toBe(0);
      expect(passed.stdout).toContain("Staging isolation: profile and resolved runtime endpoints passed");
      complete.runHistory.worker.baseUrl = "https://production-memory.example.test";
      writeFileSync(configPath, stringify(complete));
      const refused = invoke("--check");
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("runHistory.worker.baseUrl must name the staging state Worker");
      const force = invoke("--force");
      expect(force.status).toBe(1);
      expect(force.stderr).toContain("preflight bypass is not supported");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a full isolated installation and refuses the production account", () => {
    const { profile, config } = fixture();
    expect(stagingProblems(profile, config, accounts)).toEqual([]);
    expect(stagingProblems({ ...profile, account: accounts.production }, config, accounts)).toEqual([
      "profile account does not match the staging account",
    ]);
    expect(stagingProblems(profile, config, { ...accounts, production: accounts.staging })).toContain(
      "staging must use a separate Cloudflare account",
    );
  });

  it("refuses missing account pins and release images for an unreleased candidate", () => {
    const { profile, config } = fixture();
    expect(stagingProblems(profile, config, {})).toContain("both staging and production accounts are required");
    expect(stagingProblems({ ...profile, images: "registry" }, config, accounts)).toEqual([
      "staging candidates require images: build",
    ]);
  });

  it("refuses production execution endpoints, optional state clients and shared storage", () => {
    const { profile, config } = fixture();
    config.execution!.url = "https://sandbox.example.test";
    config.execution!.resident!.baseUrl = "https://resident.example.test";
    config.runHistory!.worker!.baseUrl = "https://memory.example.test";
    config.artifacts!.r2!.bucket = "production-artifacts";
    config.metrics = { dataset: "production_runs" };
    const problems = stagingProblems(profile, config, accounts);
    expect(problems).toContain("execution must use the staging sandbox Worker");
    expect(problems).toContain("execution.resident.baseUrl must name the staging resident Worker");
    expect(problems).toContain("config.runHistory.worker.baseUrl must name the staging state Worker");
    expect(problems).toContain("artifacts must use a matching staging bucket");
    expect(problems).toContain("metrics must use a matching staging dataset");
  });

  it("refuses partial topology and Worker names that do not identify staging", () => {
    const { profile, config } = fixture();
    delete profile.workers.resident;
    profile.workers.bot.script = "switchboard";
    const problems = stagingProblems(profile, config, accounts);
    expect(problems).toContain("workers.resident is required for staging parity");
    expect(problems).toContain("workers.bot.script must name staging");
  });
});

describe("staging workflow isolation", () => {
  it("executes source gates: captures an origin head and refuses forks, unauthorized manual actors and stale heads", () => {
    const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
    const script = workflow.jobs.authorize.steps[0].run;
    const directory = mkdtempSync(join(tmpdir(), "staging-label-"));
    const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    writeFileSync(
      join(directory, "gh"),
      `#!${process.execPath}\nconst route=process.argv[3]; console.log(route.endsWith('/permission')?process.env.TEST_PERMISSION:route.includes('/pulls/')?process.env.TEST_HEAD:process.env.TEST_COMMIT);`,
      { mode: 0o755 },
    );
    try {
      for (const scenario of [
        { permission: "write", repo: "example/service", head: commit, status: 0, message: "" },
        { permission: "read", repo: "example/service", head: commit, automatic: "true", status: 0, message: "" },
        {
          permission: "read",
          repo: "outside/service",
          head: commit,
          automatic: "true",
          status: 1,
          message: "Fork deployments are refused",
        },
        {
          permission: "read",
          repo: "example/service",
          head: commit,
          status: 1,
          message: "requires repository write access",
        },
        {
          permission: "write",
          repo: "outside/service",
          head: commit,
          status: 1,
          message: "Fork deployments are refused",
        },
        {
          permission: "write",
          repo: "example/service",
          head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          status: 1,
          message: "PR head changed",
        },
      ]) {
        writeFileSync(
          join(directory, "event.json"),
          JSON.stringify({ pull_request: { number: 7, head: { sha: commit, repo: { full_name: scenario.repo } } } }),
        );
        writeFileSync(join(directory, "output"), "");
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_ACTOR: "maintainer",
            AUTOMATIC: scenario.automatic ?? "false",
            GITHUB_REPOSITORY: "example/service",
            GITHUB_EVENT_NAME: "pull_request_target",
            GITHUB_EVENT_PATH: join(directory, "event.json"),
            GITHUB_OUTPUT: join(directory, "output"),
            TEST_PERMISSION: scenario.permission,
            TEST_HEAD: scenario.head,
            TEST_COMMIT: commit,
          },
        });
        expect(result.status, result.stderr).toBe(scenario.status);
        if (scenario.status === 0)
          expect(readFileSync(join(directory, "output"), "utf8")).toBe(
            "commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
          );
        else expect(result.stdout).toContain(scenario.message);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("waits for validation, rechecks through the base controller and holds the stack through live Review", () => {
    const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
    expect(workflow.on.pull_request_target.types).toEqual([
      "opened",
      "reopened",
      "synchronize",
      "ready_for_review",
      "labeled",
    ]);
    expect(workflow.jobs.deploy.needs).toEqual(["authorize", "validate"]);
    expect(workflow.jobs.validate.concurrency["cancel-in-progress"]).toBe(true);
    expect(workflow.jobs.deploy.concurrency).toEqual({
      group: "deploy-staging",
      queue: "max",
      "cancel-in-progress": false,
    });
    const steps = workflow.jobs.deploy.steps;
    expect(steps[0].with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      path: "controller",
      "persist-credentials": false,
    });
    expect(steps[1].with).toMatchObject({
      ref: "${{ needs.authorize.outputs.commit }}",
      path: "candidate",
      "persist-credentials": false,
    });
    const recheck = steps.findIndex((step: { id?: string }) => step.id === "recheck");
    expect(steps[recheck]).toMatchObject({
      "working-directory": "controller",
      run: "npm run staging:validate",
      env: { STAGING_VALIDATE_MODE: "recheck" },
    });
    expect(steps.slice(0, recheck + 1).some((step: object) => JSON.stringify(step).includes("secrets."))).toBe(false);
    const deploy = steps.findIndex((step: { id?: string }) => step.id === "deploy");
    expect(steps[deploy].if).toContain("steps.recheck.outputs.eligible == 'true'");
    expect(steps[deploy].env.TARGETS).toContain(
      "github.event_name == 'pull_request_target' || inputs.pr != '' || inputs.review_e2e",
    );
    const e2e = steps.findIndex((step: { id?: string }) => step.id === "e2e");
    expect(e2e).toBeGreaterThan(deploy);
    expect(steps[e2e].if).toContain("steps.deploy.outcome == 'success'");
    expect(steps[e2e].run).toContain("npm run --silent smoke:ingress");
    expect(steps[e2e].env.SMOKE_EXPECTED_COMMIT).toBe("${{ needs.authorize.outputs.commit }}");
    expect(steps[e2e].env.SMOKE_INGRESS_TOKEN).toBe("${{ secrets.STAGING_SMOKE_TOKEN }}");
    expect(steps[e2e].if).toContain("inputs.pr != ''");
    expect(workflow.jobs.acceptance.name).toBe(
      "${{ github.event.action == 'labeled' && github.event.label.name != 'deploy:staging' && 'staging / ignored label' || 'staging / Review E2E' }}",
    );
    expect(workflow.jobs.acceptance.if).toContain(
      "github.event.action != 'labeled' || github.event.label.name == 'deploy:staging'",
    );
    expect(workflow.jobs.acceptance.if).toContain("always()");
    expect(workflow.jobs.acceptance.needs).toEqual(["authorize", "validate", "deploy"]);
    const gate = workflow.jobs.acceptance.steps[0];
    for (const scenario of [
      { result: "success", accepted: "true", status: 0 },
      { result: "success", accepted: "", status: 1 },
      { result: "skipped", accepted: "", status: 1 },
      { result: "failure", accepted: "true", status: 1 },
    ]) {
      const directory = mkdtempSync(join(tmpdir(), "staging-acceptance-"));
      try {
        const result = spawnSync("bash", ["-c", gate.run], {
          encoding: "utf8",
          env: {
            ...process.env,
            DEPLOY_RESULT: scenario.result,
            ACCEPTED: scenario.accepted,
            GITHUB_STEP_SUMMARY: join(directory, "summary"),
          },
        });
        expect(result.status).toBe(scenario.status);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("uses separate deployment credentials without inheriting production secrets", () => {
    const text = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
    const workflow = parse(text);
    const step = workflow.jobs.deploy.steps.find(
      (s: { name?: string }) => s.name === "deploy the captured commit to staging",
    );
    expect(step.env.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.STAGING_CLOUDFLARE_DEPLOY_TOKEN }}");
    expect(step.env.MEMORY_TOKEN).toBe("${{ secrets.STAGING_MEMORY_TOKEN }}");
    expect(step.env.RESIDENT_DRAIN_TOKEN).toBe("${{ secrets.STAGING_RESIDENT_DRAIN_TOKEN }}");
    expect(workflow.jobs.deploy.environment).toBe("staging");
    expect(workflow.jobs.deploy.concurrency).toEqual({
      group: "deploy-staging",
      queue: "max",
      "cancel-in-progress": false,
    });
    expect(text).not.toMatch(
      /secrets\.(CLOUDFLARE_DEPLOY_TOKEN|CLOUDFLARE_API_TOKEN|MEMORY_TOKEN|RESIDENT_READ_TOKEN|RESIDENT_DRAIN_TOKEN|SANDBOX_TOKEN)\b/,
    );
    const secretRefs = [...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1]);
    expect(secretRefs.every((name) => name.startsWith("STAGING_"))).toBe(true);
    expect(secretRefs).toContain("STAGING_CONFIG_REPO_APP_PRIVATE_KEY");
  });
});

describe("staging inherited force protection", () => {
  it("the real CLI disables exported and file-loaded bypasses before all, affected and selected deploys", () => {
    const { profile, config } = fixture();
    const directory = mkdtempSync(join(tmpdir(), "staging-force-"));
    try {
      const configPath = join(directory, "config.yaml");
      const profilePath = join(directory, "profile.json");
      const receipt = join(directory, "receipt.json");
      const envFile = join(directory, "fixture.env");
      const bin = join(directory, "bin");
      mkdirSync(bin);
      writeFileSync(
        configPath,
        stringify({
          ...parse(readFileSync("config/config.example.yaml", "utf8")),
          ...config,
          grants: { "http:staging": { actions: ["dispatch"], channels: ["http:staging"] } },
        }),
      );
      writeFileSync(profilePath, JSON.stringify({ ...profile, configSource: configPath }));
      writeFileSync(envFile, "SWITCHBOARD_DEPLOY_FORCE=1\nRESIDENT_DEPLOY_FORCE=1\nSTAGING_LOADER_MARKER=loaded\n");
      writeFileSync(
        join(bin, "npm"),
        '#!/usr/bin/env node\nconst fs = require("node:fs"); require("node:process").loadEnvFile(process.env.STAGING_TEST_ENV_FILE); fs.writeFileSync(process.env.STAGING_TEST_RECEIPT, JSON.stringify({ bot: process.env.SWITCHBOARD_DEPLOY_FORCE, resident: process.env.RESIDENT_DEPLOY_FORCE, marker: process.env.STAGING_LOADER_MARKER }));\n',
        { mode: 0o700 },
      );
      for (const args of [[], ["--affected"], ["--only", "memory,bot,resident,sandbox"]]) {
        const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/staging-deploy.ts", ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            SWITCHBOARD_DEPLOY_PROFILE: profilePath,
            SWITCHBOARD_STAGING_ACCOUNT: accounts.staging,
            SWITCHBOARD_PRODUCTION_ACCOUNT: accounts.production,
            SWITCHBOARD_DEPLOY_FORCE: "1",
            RESIDENT_DEPLOY_FORCE: "1",
            STAGING_TEST_ENV_FILE: envFile,
            STAGING_TEST_RECEIPT: receipt,
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ bot: "0", resident: "0", marker: "loaded" });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
