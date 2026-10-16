import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { parseAppConfigText } from "../src/config.js";
import { loadProfileOnHost, readConfigForPush } from "../src/deploy/run.js";
import { stagingProblems } from "../src/deploy/staging.js";
import { stagingRestorationSecrets } from "../src/deploy/stagingRecreate.js";
import {
  continuationSchema,
  validateContinuationProvenance,
  validateContinuationSource,
} from "../src/deploy/stagingContinuation.js";
import { makeResidentAdminClient } from "../src/core/residentAdmin.js";
import { initializeOnHost } from "./staging-initialize.js";

const { values } = parseArgs({
  options: { check: { type: "boolean", default: false }, source: { type: "string" }, receipt: { type: "string" } },
});
if (
  (!values.check && !values.source) ||
  !values.receipt ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_RUN_ATTEMPT !== "1" ||
  process.env.GITHUB_REF !== "refs/heads/main" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
)
  throw new Error("initialization continuation requires its original main CI controller, source and receipt");
if (process.env.SWITCHBOARD_DEPLOY_FORCE || process.env.RESIDENT_DEPLOY_FORCE)
  throw new Error("initialization continuation refuses force");
const raw = process.env.STAGING_CONTINUATION ?? "";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
if (!/^[a-f0-9]{64}$/.test(process.env.APPROVED_PLAN ?? "") || hash(raw) !== process.env.APPROVED_PLAN)
  throw new Error("continuation requires the exact approved checkpoint");
const checkpoint = continuationSchema.parse(JSON.parse(raw));
const output = resolve(values.receipt);
const save = (phase: string, details: Record<string, unknown> = {}) =>
  writeFileSync(
    output,
    JSON.stringify(
      {
        schema: 1,
        phase,
        installationCommit: checkpoint.installationCommit,
        controllerCommit: process.env.GITHUB_SHA,
        qualifiedCandidate: process.env.STAGING_CONTINUATION_CANDIDATE,
        originalRun: checkpoint.originalRun,
        checkpointSha256: hash(raw),
        ...details,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
const api = (path: string) =>
  JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const prefix = `repos/${process.env.GITHUB_REPOSITORY}`;
const original = api(`${prefix}/actions/runs/${checkpoint.originalRun}`);
if (original.repository?.full_name !== process.env.GITHUB_REPOSITORY || original.head_branch !== "main")
  throw new Error("original initialization belongs to another repository or controller branch");
const artifacts = api(`${prefix}/actions/runs/${checkpoint.originalRun}/artifacts?per_page=100`);
const selectedArtifacts = artifacts.artifacts?.filter(
  (artifact: { id: number; name: string; expired: boolean }) =>
    artifact.name === `staging-recreation-${checkpoint.originalRun}-1`,
);
if (
  artifacts.total_count !== artifacts.artifacts?.length ||
  selectedArtifacts?.length !== 1 ||
  selectedArtifacts[0].id !== checkpoint.originalArtifact ||
  selectedArtifacts[0].expired !== false ||
  selectedArtifacts[0].digest !== `sha256:${checkpoint.originalArtifactDigest}` ||
  selectedArtifacts[0].workflow_run?.id !== checkpoint.originalRun ||
  selectedArtifacts[0].workflow_run?.head_sha !== checkpoint.originalController
)
  throw new Error("original initialization artifact identity changed");
const directory = mkdtempSync(join(tmpdir(), "switchboard-staging-continuation-"));
try {
  execFileSync(
    "gh",
    [
      "run",
      "download",
      String(checkpoint.originalRun),
      "--repo",
      process.env.GITHUB_REPOSITORY!,
      "--name",
      `staging-recreation-${checkpoint.originalRun}-1`,
      "--dir",
      directory,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const partialBytes = readFileSync(join(directory, "staging-recreation.json"));
  const memoryPath = join(directory, "staging-recreation.json.memory.json");
  if (
    hash(partialBytes) !== checkpoint.partialArtifactSha256 ||
    hash(readFileSync(memoryPath)) !== checkpoint.memoryReceiptSha256
  )
    throw new Error("original initialization artifacts changed");
  if (
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== process.env.GITHUB_SHA ||
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  )
    throw new Error("continuation controller checkout differs from the reviewed main source");
  validateContinuationProvenance(
    checkpoint,
    original,
    partialBytes,
    readFileSync(memoryPath),
    process.env.STAGING_INSTALLATION_COMMIT,
  );
  if (values.check) {
    save("original-source-provenance-verified", { readOnly: true, acceptance: "not-run" });
  } else {
    process.chdir(resolve(values.source!));
    if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== checkpoint.installationCommit)
      throw new Error("continuation requires the original installation source");
    const loaded = await loadProfileOnHost();
    const read = await readConfigForPush(loaded.profile.configSource);
    if (!read.ok) throw new Error(read.problem);
    const config = parseAppConfigText(read.text);
    const problems = stagingProblems(loaded.profile, config, {
      staging: process.env.SWITCHBOARD_STAGING_ACCOUNT,
      production: process.env.SWITCHBOARD_PRODUCTION_ACCOUNT,
    });
    if (problems.length || loaded.profile.residentMaintenance)
      throw new Error("continuation requires ordinary isolated staging");
    validateContinuationSource(
      checkpoint,
      original,
      partialBytes,
      readFileSync(memoryPath),
      loaded.profile,
      hash(read.text),
    );
    const currentCandidate = process.env.STAGING_CONTINUATION_CANDIDATE;
    const pr = process.env.STAGING_PR_NUMBER;
    const guard = () => {
      if (
        !currentCandidate ||
        !pr ||
        api(`${prefix}/pulls/${pr}`).head.sha !== currentCandidate ||
        api(`${prefix}/git/ref/heads/main`).object.sha !== process.env.GITHUB_SHA
      )
        throw new Error("continuation main or qualified current release head changed");
    };
    guard();
    const secrets = stagingRestorationSecrets(
      process.env.STAGING_RUNTIME_SECRETS_JSON ?? "",
      process.env,
      config.providers,
    );
    delete process.env.STAGING_RUNTIME_SECRETS_JSON;
    for (const [name, value] of Object.entries(secrets)) {
      process.stdout.write(
        `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`,
      );
      writeFileSync(join(directory, name), value, { flag: "wx", mode: 0o600 });
    }
    save("inspecting");
    await initializeOnHost({ ...loaded.profile, secretsSource: directory }, read, {
      resumeMemory: memoryPath,
      continuation: checkpoint,
    });
    save("installed", { acceptance: "not-run" });
    if (checkpoint.fixture) {
      guard();
      const fixture = checkpoint.fixture;
      if (fixture.resource !== `repo:${config.selfImprovement?.repo}`)
        throw new Error("fixture differs from the approved staging configuration");
      const admin = makeResidentAdminClient(config.execution!.resident!.baseUrl, secrets.RESIDENT_ADMIN_TOKEN);
      const before = await admin.residents();
      if (before.status !== 200 || !Array.isArray(before.data.residents) || !Array.isArray(before.data.repositories))
        throw new Error("fixture registry is unreadable");
      const rows = [...before.data.residents, ...before.data.repositories] as Record<string, unknown>[];
      if (rows.some((r) => r.resource === fixture.resource))
        throw new Error("fixture already registered; reconcile without replay");
      save("fixture-registration-reserved", { fixture });
      const registered = await admin.onboard(fixture);
      if (
        registered.status !== 200 ||
        registered.data.state !== "cold" ||
        registered.data.resource !== fixture.resource ||
        registered.data.warning
      )
        throw new Error("fixture registration is refused or unverified; inspect original receipt");
      save("fixture-registration-acknowledged", { fixture });
      const after = await admin.residents();
      if (after.status !== 200) throw new Error("fixture registration readback is unavailable");
      const matches = z
        .array(z.record(z.string(), z.unknown()))
        .parse(after.data.repositories)
        .filter((r) => r.resource === fixture.resource);
      if (matches.length !== 1) throw new Error("fixture registration readback is incomplete");
      const cold = z
        .object({
          resource: z.literal(fixture.resource),
          noResident: z.literal(true),
          defaultRef: z.literal(fixture.defaultRef),
          commands: z.record(z.string(), z.string()),
          live: z.object({ state: z.literal("cold") }),
        })
        .passthrough()
        .parse(matches[0]);
      if (!isDeepStrictEqual(cold.commands, fixture.commands)) throw new Error("fixture command readback differs");
      save("installed", { fixture: matches[0], acceptance: "not-run" });
    }
  }
} finally {
  delete process.env.STAGING_RUNTIME_SECRETS_JSON;
  rmSync(directory, { recursive: true, force: true });
}
