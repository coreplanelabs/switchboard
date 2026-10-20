import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { DRAIN } from "../src/core/budgets.js";
import { parseAppConfigText } from "../src/config.js";
import { loadProfileOnHost, readConfigForPush } from "../src/deploy/run.js";
import { stagingProblems } from "../src/deploy/staging.js";
import { postJson } from "../src/deploy/residentDrain.js";
import {
  qualifyResidentRecovery,
  recoverResidentDeployment,
  residentRecoveryHash,
  type ResidentRecoveryObservation,
} from "../src/deploy/residentRecovery.js";

const { values } = parseArgs({
  options: {
    run: { type: "string" },
    attempt: { type: "string" },
    "if-held": { type: "boolean", default: false },
    receipt: { type: "string" },
    apply: { type: "string" },
  },
});
if (
  !values.run ||
  !/^[1-9]\d*$/.test(values.run) ||
  !values.receipt ||
  (values.apply && !/^[a-f0-9]{64}$/.test(values.apply))
)
  throw new Error(
    "Resident recovery requires --run <original run ID> --receipt <preview path> [--apply <preview hash>]",
  );
const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error("GITHUB_REPOSITORY must name the original deployment repository");
if (process.env.SWITCHBOARD_DEPLOY_FORCE === "1" || process.env.RESIDENT_DEPLOY_FORCE === "1")
  throw new Error("Resident recovery refuses force");
const loaded = await loadProfileOnHost();
const config = await readConfigForPush(loaded.profile.configSource);
if (!config.ok) throw new Error(config.problem);
const problems = stagingProblems(loaded.profile, parseAppConfigText(config.text), {
  staging: process.env.SWITCHBOARD_STAGING_ACCOUNT,
  production: process.env.SWITCHBOARD_PRODUCTION_ACCOUNT,
});
if (problems.length || loaded.profile.residentMaintenance)
  throw new Error("Resident recovery requires the isolated staging profile without held staging maintenance");
const profile = loaded.profile;
const worker = profile.workers.resident!;
const cloudflare = process.env.CLOUDFLARE_API_TOKEN;
const readToken = process.env.RESIDENT_READ_TOKEN;
const drainToken = process.env.RESIDENT_DRAIN_TOKEN;
if (!cloudflare || !readToken || (values.apply && !drainToken))
  throw new Error(
    "Resident recovery needs CLOUDFLARE_API_TOKEN, RESIDENT_READ_TOKEN and, for apply, RESIDENT_DRAIN_TOKEN",
  );
const base = `https://${worker.hostname}`;
const native = `https://api.cloudflare.com/client/v4/accounts/${profile.account}`;
async function get(url: string, token?: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": "switchboard-resident-recovery", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(DRAIN.pollMs),
  });
  if (!response.ok) throw new Error(`Recovery evidence read failed: HTTP ${response.status}`);
  return response.json();
}
async function observe(): Promise<ResidentRecoveryObservation> {
  const [healthRaw, registryRaw, deploymentsRaw, applicationsRaw] = await Promise.all([
    get(`${base}/healthz`),
    get(`${base}/residents`, readToken),
    get(`${native}/workers/scripts/${worker.script}/deployments`, cloudflare),
    get(`${native}/containers/applications`, cloudflare),
  ]);
  const health = z
    .object({ ok: z.literal(true), build: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/) }) })
    .parse(healthRaw);
  const deployments = z
    .object({
      success: z.literal(true),
      result: z.object({
        deployments: z
          .array(
            z.object({
              versions: z.array(z.object({ version_id: z.string().uuid(), percentage: z.number() })),
            }),
          )
          .nonempty(),
      }),
    })
    .parse(deploymentsRaw);
  const active = deployments.result.deployments[0].versions;
  if (active.length !== 1 || active[0].percentage !== 100)
    throw new Error("The original Worker is not the sole active deployment");
  const applicationSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    version: z.number().int().nonnegative(),
    configuration: z.object({ image: z.string().min(1) }),
  });
  const applications = z
    .object({
      success: z.literal(true),
      result: z.array(applicationSchema),
    })
    .parse(applicationsRaw)
    .result.filter((a) => a.name === `${worker.script}-residentdo`);
  if (applications.length !== 1) throw new Error("Resident application is missing or ambiguous");
  const listed = applications[0];
  const direct = z
    .object({ success: z.literal(true), result: applicationSchema })
    .parse(await get(`${native}/containers/applications/${listed.id}`, cloudflare)).result;
  if (
    direct.id !== listed.id ||
    direct.name !== listed.name ||
    direct.version !== listed.version ||
    direct.configuration.image !== listed.configuration.image
  )
    throw new Error("Resident application list and direct target do not agree");
  return {
    commit: health.build.commit,
    workerVersion: active[0].version_id,
    imageTarget: {
      application: direct.name,
      version: direct.version,
      image: direct.configuration.image,
    },
    registry: z.record(z.string(), z.unknown()).parse(registryRaw),
  };
}
const gh = (path: string) =>
  execFileSync("gh", ["api", path], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DRAIN.pollMs,
    maxBuffer: 8 * 1024 * 1024,
  });
const initial = await observe();
if (values["if-held"] && initial.registry.draining === null) {
  console.log(JSON.stringify({ state: "not-needed" }));
  process.exit(0);
}
if (values.attempt && !/^[1-9]\d*$/.test(values.attempt))
  throw new Error("The original attempt must be a positive integer");
const original = JSON.parse(
  gh(`repos/${repository}/actions/runs/${values.run}${values.attempt ? `/attempts/${values.attempt}` : ""}`).toString(),
);
const attempt = z.number().int().positive().parse(original.run_attempt);
const artifacts = JSON.parse(gh(`repos/${repository}/actions/runs/${values.run}/artifacts?per_page=100`).toString());
const matches = z
  .array(z.object({ id: z.number().int().positive(), name: z.string(), expired: z.boolean() }))
  .parse(artifacts.artifacts)
  .filter((a) => a.name === `staging-deploy-${values.run}-${attempt}` && !a.expired);
if (matches.length !== 1) throw new Error("Original staging artifact is missing or ambiguous");
const bytes = gh(`repos/${repository}/actions/artifacts/${matches[0].id}/zip`);
const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
const directory = mkdtempSync(join(tmpdir(), "resident-upload-recovery-"));
let log: string;
let artifactPlan: unknown;
try {
  const archive = join(directory, "original.zip");
  writeFileSync(archive, bytes, { mode: 0o600 });
  const extract = (name: string) =>
    execFileSync("unzip", ["-p", archive, name], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DRAIN.pollMs,
      maxBuffer: 2 * 1024 * 1024,
    }).toString();
  log = extract("staging-deploy.log");
  artifactPlan = JSON.parse(extract("staging-fleet.json"));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const plan = qualifyResidentRecovery({
  repository,
  account: profile.account,
  script: worker.script,
  hostname: worker.hostname,
  controller: original,
  artifactPlan,
  log,
  observed: initial,
});
const hash = residentRecoveryHash(plan);
const receipt = resolve(values.receipt);
const preview = { originalRun: values.run, attempt, artifactId: matches[0].id, artifactSha256, hash, plan };
if (!values.apply) {
  writeFileSync(receipt, JSON.stringify(preview, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ state: "preview", receipt, hash, plan }, null, 2));
} else {
  if (values.apply !== hash || JSON.stringify(JSON.parse(readFileSync(receipt, "utf8"))) !== JSON.stringify(preview))
    throw new Error("The original artifact, preview or current native target changed");
  // Exclusive creation plus fsync retains intent across process death. An
  // existing journal requires reconciliation; it never grants another effect.
  const journal = openSync(`${receipt}.apply.jsonl`, "wx", 0o600);
  try {
    const result = await recoverResidentDeployment(plan, {
      observe,
      record: async (phase, detail) => {
        writeSync(journal, JSON.stringify({ hash, phase, ...(detail ? { detail } : {}) }) + "\n");
        fsyncSync(journal);
      },
      reconcile: (target) => postJson(`${base}/reconcile`, drainToken!, { imageTarget: target }),
      reopen: () => postJson(`${base}/undrain`, drainToken!, {}),
    });
    console.log(JSON.stringify(result));
    if (result.state !== "reopened") process.exitCode = 1;
  } finally {
    closeSync(journal);
  }
}
