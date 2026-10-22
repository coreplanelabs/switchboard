import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { stagingProblems, waitForStagingMaintenanceRelease } from "./staging.js";
import { TEST_PROFILE, TEST_MAINTENANCE } from "./testing/profile.js";
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
  it("waits only for the selected explicit release and stops at its deadline", async () => {
    const policy = { ...TEST_MAINTENANCE, attempt: { ...TEST_MAINTENANCE.attempt, deadline: 60_000 } };
    const held = {
      schema: 1,
      state: "held",
      holdId: policy.holdId,
      generation: 1,
      fixtureSha256: policy.fixtureSha256,
      attempt: policy.attempt,
    };
    let now = 0;
    const reads: number[] = [];
    await waitForStagingMaintenanceRelease(policy, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      read: async (timeout) => {
        reads.push(timeout);
        return {
          maintenance:
            reads.length === 1 ? held : { ...held, state: "released", releaseDecisionSha256: "7".repeat(64) },
        };
      },
    });
    expect({ reads, now }).toEqual({ reads: [30_000, 30_000], now: 30_000 });
    now = 0;
    await expect(
      waitForStagingMaintenanceRelease(
        { ...policy, attempt: { ...policy.attempt, deadline: 20 } },
        {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          read: async () => ({ maintenance: { ...held, attempt: { ...held.attempt, deadline: 20 } } }),
        },
      ),
    ).rejects.toThrowError("staging release deadline expired; maintenance was not released by this controller");
    expect(now).toBe(20);
  });

  it("binds a selected maintenance policy to the independently configured staging accounts", () => {
    const { profile, config } = fixture();
    profile.residentMaintenance = {
      ...TEST_MAINTENANCE,
      stagingAccount: accounts.staging,
      productionAccount: accounts.production,
      residentOrigin: "https://staging-resident.example.test",
    };
    expect(stagingProblems(profile, config, accounts)).toEqual([]);
    profile.residentMaintenance.productionAccount = "f".repeat(32);
    expect(stagingProblems(profile, config, accounts)).toEqual([
      "residentMaintenance must match the independently configured staging and production accounts",
    ]);
  });

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
  it.each([
    {
      previousStatus: "success",
      previousDeploy: "success",
      previousEvent: "pull_request_target",
      expectedTarget: "--affected",
      expectedBot: "b".repeat(40),
    },
    {
      previousStatus: "failure",
      previousDeploy: "success",
      previousEvent: "pull_request_target",
      expectedTarget: "--affected",
      expectedBot: "b".repeat(40),
    },
    {
      previousStatus: "failure",
      previousDeploy: "failure",
      previousEvent: "pull_request_target",
      expectedTarget: "all",
      expectedBot: "c".repeat(40),
    },
    {
      previousStatus: "success",
      previousDeploy: "success",
      previousEvent: "workflow_dispatch",
      expectedTarget: "all",
      expectedBot: "c".repeat(40),
    },
  ])(
    "uses live targeting after a $previousDeploy staging upload and binds skipped Bot smoke",
    ({ previousStatus, previousDeploy, previousEvent, expectedTarget, expectedBot }) => {
      const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
      const steps = workflow.jobs.deploy.steps as {
        id?: string;
        name: string;
        run?: string;
        env?: Record<string, string>;
      }[];
      const baseline = steps.find((step) => step.id === "baseline")!;
      const deploy = steps.find((step) => step.id === "deploy")!;
      expect(workflow.on.workflow_dispatch.inputs.targets.default).toBe("affected");
      expect(deploy.env?.GH_TOKEN).toBeUndefined();
      expect(steps.find((step) => step.id === "e2e")?.env?.SMOKE_EXPECTED_COMMIT).toBe(
        "${{ steps.deploy.outputs.expected_bot }}",
      );
      const directory = mkdtempSync(join(tmpdir(), "staging-targets-"));
      try {
        writeFileSync(
          join(directory, "gh"),
          `#!${process.execPath}\nconst path=process.argv[3]; if(path.includes("deployments?")) process.stdout.write(JSON.stringify([{id:11},{id:10}])); else if(path.includes("/11/")) process.stdout.write("https://github.com/acme/repo/actions/runs/123/job/1"); else if(path.includes("/10/")) process.stdout.write(JSON.stringify([{state:${JSON.stringify(previousStatus)},log_url:"https://github.com/acme/repo/actions/runs/122/job/1"}])); else if(path.includes("/jobs/")) process.stdout.write(JSON.stringify({steps:[{name:"deploy the captured commit to staging",conclusion:${JSON.stringify(previousDeploy)}}]})); else process.stdout.write(${JSON.stringify(previousEvent)});\n`,
          { mode: 0o700 },
        );
        writeFileSync(
          join(directory, "npm"),
          `#!${process.execPath}\nconst fs=require("node:fs"); const args=process.argv.slice(2); fs.appendFileSync(process.env.STAGING_TEST_RECEIPT,JSON.stringify(args)+"\\n"); const i=args.indexOf("--selection-receipt"); if(i>=0) fs.writeFileSync(args[i+1],JSON.stringify(args.includes("--affected")?{botSelected:false,botBaseCommit:"${"b".repeat(40)}"}:{botSelected:true}));\n`,
          { mode: 0o700 },
        );
        const output = join(directory, "output");
        const env = {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GITHUB_REPOSITORY: "acme/repo",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_RUN_ID: "123",
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: directory,
          STAGING_TEST_RECEIPT: join(directory, "calls.jsonl"),
          TARGETS: "affected",
          COMMIT: "c".repeat(40),
          STAGING_RETAIN_MAINTENANCE: "false",
          REVIEW_ACCEPTANCE: "true",
        };
        const checked = spawnSync("bash", ["-eo", "pipefail", "-c", baseline.run!], { encoding: "utf8", env });
        expect(checked.status, checked.stderr).toBe(0);
        const safe = readFileSync(output, "utf8").includes("safe_affected=true");
        const deployed = spawnSync("bash", ["-eo", "pipefail", "-c", deploy.run!], {
          encoding: "utf8",
          env: { ...env, SAFE_AFFECTED: String(safe) },
        });
        expect(deployed.status, deployed.stderr).toBe(0);
        const calls = readFileSync(env.STAGING_TEST_RECEIPT, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.at(-1)).toEqual([
          "run",
          "--silent",
          "staging:deploy",
          "--",
          ...(safe ? ["--affected"] : []),
          "--selection-receipt",
          join(directory, "staging-selection.json"),
        ]);
        expect(readFileSync(output, "utf8")).toContain(`expected_bot=${expectedBot}`);
        expect(safe ? "--affected" : "all").toBe(expectedTarget);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it("passes only staging Access credentials to configuration and live acceptance", () => {
    const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
    const readers = workflow.jobs.deploy.steps.filter((step: { run?: string }) => step.run?.includes("smoke:ingress"));
    expect(
      readers.map((step: { name: string; env: Record<string, string> }) => ({
        name: step.name,
        clientId: step.env.SMOKE_ACCESS_CLIENT_ID,
        clientSecret: step.env.SMOKE_ACCESS_CLIENT_SECRET,
      })),
    ).toEqual([
      {
        name: "validate acceptance configuration before upload",
        clientId: "${{ secrets.STAGING_SMOKE_ACCESS_CLIENT_ID }}",
        clientSecret: "${{ secrets.STAGING_SMOKE_ACCESS_CLIENT_SECRET }}",
      },
      {
        name: "run live Review acceptance on the deployed stack",
        clientId: "${{ secrets.STAGING_SMOKE_ACCESS_CLIENT_ID }}",
        clientSecret: "${{ secrets.STAGING_SMOKE_ACCESS_CLIENT_SECRET }}",
      },
    ]);
  });
  it.each(["ready", "challenge", "configured", "unexpected"])(
    "checks only the configured smoke reader before deployment: %s",
    (mode) => {
      const directory = mkdtempSync(join(tmpdir(), "smoke-reader-check-"));
      try {
        const plan = join(directory, "plan.json"),
          receipt = join(directory, "receipt.json"),
          calls = join(directory, "calls.jsonl");
        const preload = join(directory, "fetch.mjs");
        writeFileSync(
          plan,
          JSON.stringify({ steps: [{ name: "bot", healthUrl: "https://bot.example.test/healthz" }] }),
        );
        writeFileSync(
          preload,
          `import { appendFileSync } from "node:fs";
if (process.env.SMOKE_TEST_MODE === "unexpected") AbortSignal.timeout = () => { throw new TypeError("private-runtime-detail"); };
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://bot.example.test/mcp") throw new Error("unexpected destination");
  const request = JSON.parse(String(init.body));
  const headers = new Headers(init.headers);
  appendFileSync(process.env.SMOKE_TEST_CALLS, JSON.stringify({method: request.method, tool: request.params?.name, accessId: headers.get("cf-access-client-id"), accessSecret: headers.get("cf-access-client-secret")})+"\\n");
  if (process.env.SMOKE_TEST_MODE === "challenge") return new Response("private-body", {status:302,headers:{location:"https://login.example.test/?secret=private-value","www-authenticate":"Cloudflare-Access private-value"}});
  if (request.method === "initialize") return Response.json({jsonrpc:"2.0",id:request.id,result:{protocolVersion:request.params.protocolVersion}});
  if (request.method === "notifications/initialized") return new Response(null,{status:202});
  if (request.params?.name !== "runs_list") throw new Error("paid operation refused");
  return Response.json({jsonrpc:"2.0",id:request.id,result:{content:[{type:"text",text:'runs.list: ok\\n'+JSON.stringify({runs:[],readScope:{channelId:"http:smoke",userId:"http:smoke",repo:"acme/smoke",allowed:true}})}]}});
};`,
        );
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--import",
            preload,
            "scripts/smoke-ingress.ts",
            plan,
            receipt,
            "--check",
            ...(mode === "configured" ? [] : ["--check-reader"]),
          ],
          {
            encoding: "utf8",
            timeout: 15_000,
            env: {
              ...process.env,
              SMOKE_INGRESS_ORIGIN: "https://bot.example.test",
              SMOKE_INGRESS_TOKEN: "fixture-only",
              SMOKE_ACCESS_CLIENT_ID: "edge-id",
              SMOKE_ACCESS_CLIENT_SECRET: "edge-secret",
              SMOKE_SLACK_CONFIG: "",
              SMOKE_INGRESS_CONFIG: JSON.stringify({
                disposable: true,
                channel: "smoke",
                subject: "smoke",
                repo: "acme/smoke",
                workspace: { path: "SMOKE.md", answer: "fixture" },
                review: { number: 7, head: "b".repeat(40) },
                maxObservedUsd: 1,
              }),
              SMOKE_TEST_MODE: mode,
              SMOKE_TEST_CALLS: calls,
            },
          },
        );
        expect(result.status, result.stderr).toBe(mode === "challenge" || mode === "unexpected" ? 1 : 0);
        const saved = JSON.parse(readFileSync(receipt, "utf8"));
        expect(saved).toMatchObject({
          capabilityOutcome: "incomplete",
          reason:
            mode === "challenge" || mode === "unexpected"
              ? "reader_unproven"
              : mode === "ready"
                ? "reader_verified"
                : "configured_not_executed",
        });
        if (mode === "challenge") {
          expect(saved.readerCheck.observationError).toEqual({
            code: "mcp_auth_required",
            operation: "runs_list",
            http: { status: 302, authChallenge: true },
          });
          expect(result.stderr).toBe("Smoke reader not verified (mcp_auth_required, HTTP 302). No agent started.\n");
        }
        if (mode === "unexpected") {
          expect(saved.readerCheck.observationError).toEqual({ code: "reader_check_failed" });
          expect(result.stderr).toBe("Smoke reader not verified (reader_check_failed). No agent started.\n");
        }
        const observed = existsSync(calls)
          ? readFileSync(calls, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [];
        expect(observed.map((row) => row.tool ?? row.method)).toEqual(
          mode === "ready"
            ? ["initialize", "notifications/initialized", "runs_list"]
            : mode === "challenge"
              ? ["initialize"]
              : [],
        );
        if (mode === "ready" || mode === "challenge") {
          expect(observed[0]).toMatchObject({ accessId: "edge-id", accessSecret: "edge-secret" });
          expect(saved.readerCheck.outcome).toBe(mode === "ready" ? "passed" : "incomplete");
        }
        expect(JSON.stringify(saved) + result.stdout + result.stderr).not.toMatch(
          /edge-secret|private-body|private-value|private-runtime-detail|login\.example/,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it.each([true, false, undefined])(
    "passes retained mode through planning, deployment and acceptance only when selected: %s",
    (retain) => {
      const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
      const inputs = { retain_maintenance: retain };
      const env = Object.fromEntries(
        Object.entries(workflow.env ?? {}).map(([key, value]) => [
          key,
          String(Function("inputs", `return (${String(value).slice(3, -2)});`)(inputs) ?? ""),
        ]),
      );
      const steps = workflow.jobs.deploy.steps.filter(
        (step: { id?: string; name: string }) =>
          step.name === "validate acceptance configuration before upload" || step.id === "deploy" || step.id === "e2e",
      );
      const directory = mkdtempSync(join(tmpdir(), "staging-retained-workflow-"));
      try {
        const receipt = join(directory, "calls.jsonl");
        writeFileSync(
          join(directory, "npm"),
          `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.STAGING_TEST_RECEIPT, JSON.stringify(process.argv.slice(2))+"\\n");\n`,
          { mode: 0o700 },
        );
        writeFileSync(join(directory, "jq"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        for (const step of steps) {
          const result = spawnSync("bash", ["-e", "-c", step.run], {
            encoding: "utf8",
            env: {
              ...env,
              PATH: `${directory}:${process.env.PATH}`,
              RUNNER_TEMP: directory,
              STAGING_TEST_RECEIPT: receipt,
              TARGETS: retain ? "affected" : "all",
              GITHUB_OUTPUT: join(directory, "output"),
            },
          });
          expect(result.status, result.stderr).toBe(0);
        }
        const calls = readFileSync(receipt, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
          .filter((args) => args.includes("cli") || args.includes("staging:deploy"));
        expect(calls).toEqual([
          [
            "run",
            "--silent",
            "cli",
            "--",
            "deploy",
            "plan",
            "--allow-branch",
            "--json",
            ...(retain ? ["--retain-maintenance"] : []),
          ],
          ["run", "--silent", "staging:deploy", "--", ...(retain ? ["--retain-maintenance"] : [])],
          [
            "run",
            "--silent",
            "cli",
            "--",
            "deploy",
            "plan",
            "--allow-branch",
            "--json",
            ...(retain ? ["--retain-maintenance"] : []),
          ],
        ]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it("does not read an unrelated Bot for a manual Sandbox deploy without Review acceptance", () => {
    const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
    const deploy = workflow.jobs.deploy.steps.find((step: { id?: string }) => step.id === "deploy");
    const directory = mkdtempSync(join(tmpdir(), "staging-sandbox-workflow-"));
    try {
      const receipt = join(directory, "calls.jsonl");
      writeFileSync(
        join(directory, "npm"),
        `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.STAGING_TEST_RECEIPT,JSON.stringify(process.argv.slice(2))+"\\n");\n`,
        { mode: 0o700 },
      );
      const result = spawnSync("bash", ["-eo", "pipefail", "-c", deploy.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          RUNNER_TEMP: directory,
          STAGING_TEST_RECEIPT: receipt,
          TARGETS: "sandbox",
          SAFE_AFFECTED: "false",
          REVIEW_ACCEPTANCE: "false",
          STAGING_RETAIN_MAINTENANCE: "false",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual([
        "run",
        "--silent",
        "staging:deploy",
        "--",
        "--only",
        "sandbox",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("uses Luna and medium effort in automatic HTTP acceptance even when deployment inputs are absent", () => {
    const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
    const steps = workflow.jobs.deploy.steps.filter((step: { run?: string }) => step.run?.includes("smoke:ingress"));
    for (const step of steps) {
      const commands = step.run.slice(
        step.run.indexOf("smoke_args="),
        step.run.indexOf("jq -e") >= 0 ? step.run.indexOf("jq -e") : undefined,
      );
      const result = spawnSync("bash", ["-c", `npm() { printf '%s\\n' "$@"; }; ${commands}`], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, RUNNER_TEMP: "/fixture" },
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n").slice(-6)).toEqual([
        "--model",
        "openai/gpt-6-luna",
        "--review-transport",
        "http",
        "--review-effort",
        "medium",
      ]);
    }
  });
  it("forwards the same MCP Review model and effort through preflight and final acceptance in the existing job", () => {
    const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
    expect(workflow.on.workflow_dispatch.inputs.review_transport).toMatchObject({
      type: "choice",
      default: "http",
      options: ["http", "mcp"],
    });
    const steps = workflow.jobs.deploy.steps.filter((step: { run?: string }) => step.run?.includes("smoke:ingress"));
    const outputs = steps.map((step: { run: string; env: Record<string, string> }) => {
      expect(step.env.SMOKE_REVIEW_TRANSPORT).toBe("${{ env.STAGING_REVIEW_TRANSPORT }}");
      expect(step.env.SMOKE_REVIEW_EFFORT).toBe("${{ env.STAGING_REVIEW_EFFORT }}");
      const commands = step.run.slice(
        step.run.indexOf("smoke_args="),
        step.run.indexOf("jq -e") >= 0 ? step.run.indexOf("jq -e") : undefined,
      );
      const result = spawnSync("bash", ["-c", `npm() { printf '%s\n' "$@"; }; ${commands}`], {
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: "/fixture",
          SMOKE_MODEL: "openai/gpt-6.1-sol",
          SMOKE_REVIEW_TRANSPORT: "mcp",
          SMOKE_REVIEW_EFFORT: "high",
        },
      });
      expect(result.status).toBe(0);
      return result.stdout.trim().split("\n");
    });
    expect(outputs).toEqual([
      [
        "run",
        "--silent",
        "smoke:ingress",
        "--",
        "/fixture/staging-fleet.json",
        "/fixture/staging-setup.json",
        "--check",
        "--check-reader",
        "--model",
        "openai/gpt-6.1-sol",
        "--review-transport",
        "mcp",
        "--review-effort",
        "high",
      ],
      [
        "run",
        "--silent",
        "smoke:ingress",
        "--",
        "/fixture/staging-fleet.json",
        "/fixture/staging-e2e.json",
        "--model",
        "openai/gpt-6.1-sol",
        "--review-transport",
        "mcp",
        "--review-effort",
        "high",
      ],
    ]);
    expect(workflow.jobs.deploy.concurrency).toEqual({
      group: "deploy-staging",
      queue: "max",
      "cancel-in-progress": false,
    });
  });

  it("recovers a prior completed upload under the existing staging lock before retrying deployment", () => {
    const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
    const steps = workflow.jobs.deploy.steps;
    const recovery = steps.find(
      (step: { name?: string }) => step.name === "recover the prior completed upload before a retry",
    );
    expect(recovery.working_directory ?? recovery["working-directory"]).toBe("controller");
    expect(steps.indexOf(recovery)).toBeLessThan(steps.findIndex((step: { id?: string }) => step.id === "deploy"));
    for (const attempt of [1, 2]) {
      expect(
        runInNewContext(recovery.if, {
          github: { run_attempt: attempt, event_name: "pull_request_target" },
          steps: { recheck: { outputs: { eligible: "true" } } },
          inputs: { pr: "" },
        }),
      ).toBe(attempt === 2);
    }
    const directory = mkdtempSync(join(tmpdir(), "staging-recovery-workflow-"));
    try {
      const executed = spawnSync(
        "bash",
        [
          "-e",
          "-c",
          `npm() {
        printf '%s\\n' "$*" >> "$RUNNER_TEMP/calls";
        if [[ "$*" != *"--apply"* ]]; then printf '%s' '{"hash":"selected-hash"}' > "$RUNNER_TEMP/resident-recovery.json"; fi
      }
      ${recovery.run}`,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, RUNNER_TEMP: directory, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" },
        },
      );
      expect(executed.status, executed.stderr).toBe(0);
      expect(readFileSync(join(directory, "calls"), "utf8").replaceAll(directory, "<private>")).toBe(
        "run --silent staging:deploy -- --recover-resident --if-held --run 123 --attempt 1 --receipt <private>/resident-recovery.json\n" +
          "run --silent staging:deploy -- --recover-resident --run 123 --attempt 1 --receipt <private>/resident-recovery.json --apply selected-hash\n",
      );
      expect(workflow.jobs.deploy.concurrency).toEqual({
        group: "deploy-staging",
        queue: "max",
        "cancel-in-progress": false,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses cancelled deploys while preserving eligible skipped-validation paths and always-run receipts", () => {
    const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
    const permitted = new Set([
      "false:success:true:skipped:false",
      "false:success:true:skipped:true",
      "false:success:true:success:true",
    ]);
    for (const cancelled of [false, true]) {
      for (const authorize of ["success", "failure", "cancelled"]) {
        for (const requested of ["true", "false"]) {
          for (const validate of ["skipped", "success", "failure", "cancelled"]) {
            for (const eligible of ["true", "false"]) {
              const scenario = `${cancelled}:${authorize}:${requested}:${validate}:${eligible}`;
              const allowed = runInNewContext(
                workflow.jobs.deploy.if,
                {
                  always: () => true,
                  cancelled: () => cancelled,
                  needs: {
                    authorize: { result: authorize, outputs: { requested } },
                    validate: { result: validate, outputs: { eligible } },
                  },
                },
                { timeout: 100 },
              );
              expect(allowed, scenario).toBe(permitted.has(scenario));
            }
          }
        }
      }
    }
    expect(workflow.jobs.deploy.concurrency).toEqual({
      group: "deploy-staging",
      queue: "max",
      "cancel-in-progress": false,
    });
    const steps = workflow.jobs.deploy.steps;
    expect(steps.find((step: { name?: string }) => step.name === "staging deployment receipt").if).toBe("always()");
    expect(steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/upload-artifact@")).if).toBe(
      "always()",
    );
  });

  it("executes source gates: captures an origin head and refuses forks, unauthorized manual actors and stale heads", () => {
    const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
    const script = workflow.jobs.authorize.steps[0].run;
    const directory = mkdtempSync(join(tmpdir(), "staging-label-"));
    const commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    writeFileSync(
      join(directory, "gh"),
      `#!${process.execPath}\nconst route=process.argv[3]; console.log(route.includes('/actions/workflows/')?process.env.TEST_HISTORY:route.endsWith('/permission')?process.env.TEST_PERMISSION:route.includes('/pulls/')?process.env.TEST_HEAD:process.env.TEST_COMMIT);`,
      { mode: 0o755 },
    );
    try {
      for (const scenario of [
        {
          permission: "write",
          repo: "example/service",
          head: commit,
          branch: "feature/change",
          action: "labeled",
          status: 0,
          message: "",
        },
        {
          permission: "write",
          repo: "example/service",
          head: commit,
          branch: "feature/change",
          automatic: "true",
          labels: ["deploy:staging"],
          action: "ready_for_review",
          status: 0,
          message: "",
        },
        {
          permission: "write",
          repo: "example/service",
          head: commit,
          branch: "feature/change",
          automatic: "true",
          labels: ["deploy:staging"],
          action: "reopened",
          status: 0,
          message: "",
        },
        {
          permission: "write",
          repo: "example/service",
          head: commit,
          branch: "feature/change",
          automatic: "true",
          manualHistory: true,
          status: 0,
          message: "",
        },
        {
          permission: "read",
          repo: "example/service",
          head: commit,
          branch: "feature/change",
          automatic: "true",
          labels: ["deploy:staging"],
          status: 1,
          message: "requires repository write access",
        },
        {
          permission: "write",
          repo: "example/service",
          head: commit,
          branch: "feature/change",
          automatic: "true",
          historyFailure: true,
          status: 1,
          message: "Staging request history is unavailable",
        },
        { permission: "write", repo: "example/service", head: commit, status: 0, message: "" },
        {
          permission: "read",
          repo: "example/service",
          head: commit,
          branch: "",
          automatic: "true",
          status: 1,
          message: "release branch metadata",
        },
        {
          permission: "read",
          repo: "outside/service",
          head: commit,
          branch: "feature/change",
          automatic: "true",
          requested: false,
          status: 0,
          message: "",
        },
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
          JSON.stringify({
            action: scenario.action ?? "synchronize",
            label: { name: "deploy:staging" },
            pull_request: {
              number: 7,
              labels: (scenario.labels ?? []).map((name) => ({ name })),
              head: {
                ref: scenario.branch ?? "release-please--branches--main--components--switchboard",
                sha: commit,
                repo: { full_name: scenario.repo },
              },
            },
          }),
        );
        writeFileSync(join(directory, "output"), "");
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_ACTOR: "maintainer",
            AUTOMATIC: scenario.automatic ?? "false",
            RELEASE_BRANCH: workflow.jobs.authorize.steps[0].env.RELEASE_BRANCH,
            GITHUB_REPOSITORY: "example/service",
            GITHUB_EVENT_NAME: "pull_request_target",
            GITHUB_EVENT_PATH: join(directory, "event.json"),
            GITHUB_OUTPUT: join(directory, "output"),
            TEST_HISTORY: scenario.historyFailure
              ? "null"
              : JSON.stringify({
                  workflow_runs: scenario.manualHistory
                    ? [{ id: 99, event: "workflow_dispatch", head_sha: commit }]
                    : [],
                }),
            TEST_PERMISSION: scenario.permission,
            TEST_HEAD: scenario.head,
            TEST_COMMIT: commit,
          },
        });
        expect(result.status, result.stderr).toBe(scenario.status);
        if (scenario.status === 0)
          expect(readFileSync(join(directory, "output"), "utf8")).toBe(
            scenario.requested === false
              ? "requested=false\n"
              : `automatic=${scenario.labels?.includes("deploy:staging") || scenario.manualHistory ? "false" : (scenario.automatic ?? "false")}\nrequire_label=${scenario.action === "labeled" || scenario.labels?.includes("deploy:staging") ? "true" : "false"}\nrequested=true\ncommit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`,
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
    expect(steps[deploy].env.TARGETS).toBe("${{ inputs.reset_e2e && 'all' || inputs.targets || 'affected' }}");
    expect(steps[deploy].env.SAFE_AFFECTED).toBe("${{ steps.baseline.outputs.safe_affected }}");
    const e2e = steps.findIndex((step: { id?: string }) => step.id === "e2e");
    expect(e2e).toBeGreaterThan(deploy);
    expect(steps[e2e].if).toContain("steps.deploy.outcome == 'success'");
    expect(steps[e2e].run).toContain("npm run --silent smoke:ingress");
    expect(steps[e2e].env.SMOKE_EXPECTED_COMMIT).toBe("${{ steps.deploy.outputs.expected_bot }}");
    expect(steps[e2e].env.SMOKE_INGRESS_TOKEN).toBe("${{ secrets.STAGING_SMOKE_TOKEN }}");
    expect(steps[e2e].if).toContain("inputs.pr != ''");
    expect(workflow.jobs.acceptance.name).toBe("staging / live Review");
    expect(workflow.jobs.acceptance.if).toContain(
      "github.event.action != 'labeled' || github.event.label.name == 'deploy:staging'",
    );
    expect(workflow.jobs.acceptance.if).toContain("always()");
    for (const cancelled of [false, true]) {
      expect(
        runInNewContext(
          workflow.jobs.acceptance.if,
          {
            always: () => true,
            cancelled: () => cancelled,
            github: { event_name: "pull_request_target", event: { action: "synchronize" } },
            inputs: {},
          },
          { timeout: 100 },
        ),
        `cancelled=${cancelled}`,
      ).toBe(!cancelled);
    }
    expect(workflow.jobs.acceptance.needs).toEqual(["authorize", "validate", "deploy"]);
    const gate = workflow.jobs.acceptance.steps[0];
    for (const scenario of [
      { result: "success", accepted: "true", status: 0 },
      { result: "success", accepted: "", status: 1 },
      { result: "skipped", accepted: "", status: 1 },
      { result: "skipped", accepted: "", requested: "false", authorize: "success", status: 0 },
      { result: "skipped", accepted: "", requested: "false", authorize: "failure", status: 1 },
      { result: "failure", accepted: "true", status: 1 },
    ]) {
      const directory = mkdtempSync(join(tmpdir(), "staging-acceptance-"));
      try {
        const result = spawnSync("bash", ["-c", gate.run], {
          encoding: "utf8",
          env: {
            ...process.env,
            DEPLOY_RESULT: scenario.result,
            REQUESTED: scenario.requested ?? "true",
            AUTHORIZE_RESULT: scenario.authorize ?? "success",
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

  it.each([
    { event: "pull_request_target", inputs: {}, expected: "openai/gpt-6-luna" },
    { event: "workflow_dispatch", inputs: { model: "" }, expected: "openai/gpt-6-luna" },
    {
      event: "workflow_dispatch",
      inputs: { model: "anthropic/claude-sonnet-4-5" },
      expected: "anthropic/claude-sonnet-4-5",
    },
  ])(
    "uses the same staging acceptance model for check and execution on $event with $inputs",
    ({ inputs, expected }) => {
      const workflow = parse(readFileSync(".github/workflows/deploy-staging.yml", "utf8"));
      // Missing Actions inputs resolve to empty strings for the shell steps.
      const evaluate = (value: string, env: Record<string, string>) =>
        Function("inputs", "env", `return (${value.slice(3, -2)});`)(inputs, env) ?? "";
      const env = Object.fromEntries(
        Object.entries(workflow.env ?? {}).map(([key, value]) => [key, evaluate(value as string, {})]),
      );
      const steps = workflow.jobs.deploy.steps.filter(
        (step: { env?: { SMOKE_MODEL?: string } }) => step.env?.SMOKE_MODEL,
      );
      expect(steps.map((step: { name: string }) => step.name)).toEqual([
        "validate acceptance configuration before upload",
        "run live Review acceptance on the deployed stack",
      ]);
      const directory = mkdtempSync(join(tmpdir(), "staging-model-workflow-"));
      try {
        const bin = join(directory, "bin");
        mkdirSync(bin);
        const receipt = join(directory, "calls.jsonl");
        writeFileSync(
          join(bin, "npm"),
          `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.MODEL_TEST_RECEIPT, JSON.stringify(process.argv.slice(2))+"\\n");\n`,
          { mode: 0o700 },
        );
        writeFileSync(join(bin, "jq"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        for (const step of steps) {
          const result = spawnSync("bash", ["-e", "-c", step.run], {
            encoding: "utf8",
            env: {
              PATH: `${bin}:${process.env.PATH}`,
              RUNNER_TEMP: directory,
              MODEL_TEST_RECEIPT: receipt,
              GITHUB_OUTPUT: join(directory, "output"),
              SMOKE_MODEL: evaluate(step.env.SMOKE_MODEL, env),
            },
          });
          expect(result.status, result.stderr).toBe(0);
        }
        const calls = readFileSync(receipt, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        const smoke = calls.filter((args) => args.includes("smoke:ingress"));
        expect(smoke).toEqual([
          [
            "run",
            "--silent",
            "smoke:ingress",
            "--",
            join(directory, "staging-fleet.json"),
            join(directory, "staging-setup.json"),
            "--check",
            "--check-reader",
            "--model",
            expected,
            "--review-transport",
            "http",
            "--review-effort",
            "medium",
          ],
          [
            "run",
            "--silent",
            "smoke:ingress",
            "--",
            join(directory, "staging-fleet.json"),
            join(directory, "staging-e2e.json"),
            "--model",
            expected,
            "--review-transport",
            "http",
            "--review-effort",
            "medium",
          ],
        ]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

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
  it("records the Bot selection from the executed deployment for Review acceptance", () => {
    const { profile, config } = fixture();
    const directory = mkdtempSync(join(tmpdir(), "staging-selection-"));
    try {
      const configPath = join(directory, "config.yaml");
      const profilePath = join(directory, "profile.json");
      const receipt = join(directory, "selection.json");
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
      writeFileSync(
        join(bin, "npm"),
        `#!${process.execPath}\nconst args=process.argv.slice(2); if(args.includes("all")) process.stdout.write(JSON.stringify({plan:{steps:process.env.SELECT_BOT==="true"?[{name:"bot"}]:[],affected:{workers:[{name:"bot",base:{kind:"live",commit:"${"b".repeat(40)}"}}]}}}));\n`,
        { mode: 0o700 },
      );
      for (const [selected, expected] of [
        ["true", { botSelected: true }],
        ["false", { botSelected: false, botBaseCommit: "b".repeat(40) }],
      ] as const) {
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", "scripts/staging-deploy.ts", "--affected", "--selection-receipt", receipt],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              SWITCHBOARD_DEPLOY_PROFILE: profilePath,
              SWITCHBOARD_STAGING_ACCOUNT: accounts.staging,
              SWITCHBOARD_PRODUCTION_ACCOUNT: accounts.production,
              SELECT_BOT: selected,
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(expected);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
