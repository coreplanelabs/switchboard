import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { parseAppConfigText } from "../src/config.js";
import { sha256Hex } from "../src/configDocument.js";
import { MINUTE_MS } from "../src/core/budgets.js";
import { loadProfileOnHost, readConfigForPush } from "../src/deploy/run.js";
import { stagingProblems } from "../src/deploy/staging.js";
import { nativeInventoryRows } from "../src/deploy/stagingBootstrap.js";
import {
  planStagingRecreation,
  recreateStaging,
  stagingRestorationSecrets,
  StagingDependencyFieldsError,
} from "../src/deploy/stagingRecreate.js";
import { initializeOnHost } from "./staging-initialize.js";

const { values } = parseArgs({
  options: {
    apply: { type: "string" },
    receipt: { type: "string" },
  },
});
if (!values.receipt) throw new Error("staging recreation requires an explicit receipt path");
if (values.apply && !/^[a-f0-9]{64}$/.test(values.apply))
  throw new Error("staging recreation requires the approved plan SHA256");
if (process.env.SWITCHBOARD_DEPLOY_FORCE || process.env.RESIDENT_DEPLOY_FORCE)
  throw new Error("staging recreation refuses deployment force");
if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_RUN_ATTEMPT !== "1")
  throw new Error("staging recreation requires one original CI attempt");
if (!process.env.SWITCHBOARD_DEPLOY_PROFILE || !process.env.CLOUDFLARE_API_TOKEN)
  throw new Error("staging recreation requires its explicit profile and deployment credential");
if (!process.env.STAGING_RUNTIME_SECRETS_JSON)
  throw new Error("STAGING_RUNTIME_SECRETS_JSON is required before staging deletion");
const restorationBundle = process.env.STAGING_RUNTIME_SECRETS_JSON;
delete process.env.STAGING_RUNTIME_SECRETS_JSON;
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
  throw new Error("staging recreation requires a clean checkout");
const loaded = await loadProfileOnHost();
const read = await readConfigForPush(loaded.profile.configSource);
if (!read.ok) throw new Error("staging recreation configuration is unavailable");
const config = parseAppConfigText(read.text);
const secrets = stagingRestorationSecrets(restorationBundle, process.env, config.providers);
const problems = stagingProblems(loaded.profile, config, {
  staging: process.env.SWITCHBOARD_STAGING_ACCOUNT,
  production: process.env.SWITCHBOARD_PRODUCTION_ACCOUNT,
});
if (problems.length) throw new Error(problems.join("; "));
if (loaded.profile.residentMaintenance)
  throw new Error("staging recreation requires an ordinary profile without maintenance");
const directory = mkdtempSync(join(tmpdir(), "switchboard-staging-recreate-"));
const profile = { ...loaded.profile, secretsSource: directory };
const creationReceipt = `${values.receipt}.memory.json`;
const save = (value: unknown) => writeFileSync(values.receipt!, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const prefix = `/accounts/${profile.account}`;
const request = async (path: string, method = "GET"): Promise<unknown> => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    redirect: "error",
    signal: AbortSignal.timeout(MINUTE_MS),
  });
  if (!response.ok)
    throw new Error(
      `staging provider ${method} ${path} refused or unverified (HTTP ${response.status}); inspect original receipt before another action`,
    );
  const text = await response.text();
  if (method === "DELETE" && !text.trim()) return null;
  let body: { success?: boolean; result?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("staging provider response is unverified");
  }
  if (body.success !== true) throw new Error("staging provider action is unverified");
  return method === "GET" ? body : body.result;
};
const inventory = async () => {
  const [scripts, applications, namespaces, workflows] = await Promise.all([
    request(`${prefix}/workers/scripts`),
    request(`${prefix}/containers/applications`),
    request(`${prefix}/workers/durable_objects/namespaces`),
    request(`${prefix}/workflows`),
  ]);
  return { scripts, applications, namespaces, workflows };
};
try {
  for (const [name, value] of Object.entries(secrets)) {
    process.stdout.write(
      `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`,
    );
    writeFileSync(join(directory, name), value, { flag: "wx", mode: 0o600 });
  }
  // This executes the existing complete input, bearer, Docker and render checks before deletion.
  const preflight = () => initializeOnHost(profile, read, { receiptPath: creationReceipt, checkOnly: true });
  const readPlan = async () => {
    const native = await inventory();
    const dependencies = Object.fromEntries(
      await Promise.all(
        Object.values(profile.workers).map(async (worker) => {
          const [references, tails] = await Promise.all([
            request(`${prefix}/workers/scripts/${worker.script}/references`),
            request(`${prefix}/workers/tails/by-consumer/${worker.script}`),
          ]);
          return [
            worker.script,
            { references: (references as { result?: unknown }).result, tails: (tails as { result?: unknown }).result },
          ];
        }),
      ),
    );
    try {
      return planStagingRecreation(
        loaded.profile,
        process.env.SWITCHBOARD_PRODUCTION_ACCOUNT!,
        { ...native, dependencies },
        { commit, configSha256: sha256Hex(read.text) },
      );
    } catch (error) {
      if (error instanceof StagingDependencyFieldsError)
        save({
          status: "refused",
          commit,
          dependencyFields: error.diagnostic,
          nativeMutations: "not-started",
          acceptance: "not-run",
        });
      throw error;
    }
  };
  if (!values.apply) {
    await preflight();
    const plan = await readPlan();
    save({ status: "plan-only", plan });
    console.log(`Staging reset plan: ${plan.sha256}. Nothing deleted or deployed.`);
  } else {
    const result = await recreateStaging(values.apply, {
      preflight,
      readPlan,
      remove: async (entry) => {
        await request(entry.path, "DELETE");
      },
      absent: async () => {
        const current = await inventory();
        const names = Object.values(profile.workers).map((worker) => worker.script);
        if (
          nativeInventoryRows(current.scripts).some((row) => names.includes(String(row.id))) ||
          nativeInventoryRows(current.applications).some((row) =>
            names.some((name) => String(row.name).startsWith(name + "-")),
          ) ||
          nativeInventoryRows(current.namespaces).some(
            (row) =>
              names.includes(String(row.script)) || names.some((name) => String(row.name).startsWith(name + "_")),
          ) ||
          nativeInventoryRows(current.workflows).some(
            (row) =>
              names.includes(String(row.script_name)) || names.some((name) => String(row.name).startsWith(name + "-")),
          )
        )
          throw new Error("old staging resources remain; initialization refused");
      },
      initialize: () => initializeOnHost(profile, read, { receiptPath: creationReceipt }),
      record: async (phase, plan) => save({ status: phase, plan, originalOutcome: "unknown", acceptance: "not-run" }),
    });
    console.log(JSON.stringify(result));
  }
} finally {
  delete process.env.STAGING_RUNTIME_SECRETS_JSON;
  rmSync(directory, { recursive: true, force: true });
}
