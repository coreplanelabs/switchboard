import { constants, openSync, ftruncateSync, writeSync, fsyncSync, closeSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve, isAbsolute, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { parseAppConfigText } from "../src/config.js";
import { parseConfigSource } from "../src/deploy/configSource.js";
import { loadProfileOnHost, readConfigForPush } from "../src/deploy/run.js";
import { stagingProblems } from "../src/deploy/staging.js";
import { stagingRestorationSecrets } from "../src/deploy/stagingRecreate.js";
import {
  StagingResetRecoveryRefusal,
  stagingResetRecoveryRequest,
  validateStagingResetRecoveryIdentity,
  runStagingResetRecovery,
} from "../src/deploy/stagingResetRecovery.js";
import {
  createStagingResetRecoveryIO,
  StagingResetRecoveryBoundaryError,
} from "../src/deploy/stagingResetRecoveryHost.js";

const { values } = parseArgs({ options: { receipt: { type: "string" }, preview: { type: "string" } } });
if (!values.receipt)
  throw new StagingResetRecoveryRefusal(
    "inputs-unavailable",
    "staging:recover requires --receipt outside the checkout",
  );
const path = resolve(values.receipt);
const local = relative(process.cwd(), path);
if (local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)))
  throw new StagingResetRecoveryRefusal("inputs-unavailable", "recovery receipts must be outside the checkout");
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
let latest: Record<string, unknown> = {
  schema: 1,
  kind: "staging-reset-recovery",
  outcome: "unverified",
  phase: "identity",
};
const receipt = (value: Record<string, unknown>) => {
  latest = value;
  const text = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  ftruncateSync(fd, 0);
  let written = 0;
  while (written < text.length) {
    const bytes = writeSync(fd, text, written, text.length - written, written);
    if (bytes <= 0) throw new StagingResetRecoveryRefusal("inputs-unavailable", "recovery local receipt is incomplete");
    written += bytes;
  }
  fsyncSync(fd);
};
try {
  const env = process.env;
  if (env.GITHUB_ACTIONS !== "true" || env.SWITCHBOARD_DEPLOY_FORCE || env.RESIDENT_DEPLOY_FORCE)
    throw new StagingResetRecoveryRefusal(
      "inputs-unavailable",
      "recovery requires its original staging CI controller without force",
    );
  const request = stagingResetRecoveryRequest.parse(JSON.parse(env.STAGING_RESET_RECOVERY_REQUEST ?? ""));
  const context = validateStagingResetRecoveryIdentity(request, {
    mode: env.STAGING_RESET_RECOVERY_MODE,
    repository: env.GITHUB_REPOSITORY,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    checkoutSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    clean: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() === "",
    runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    actorId: Number(env.GITHUB_ACTOR_ID),
    actor: env.GITHUB_ACTOR,
    stagingAccount: env.SWITCHBOARD_STAGING_ACCOUNT,
    productionAccount: env.SWITCHBOARD_PRODUCTION_ACCOUNT,
    recoveryId: env.STAGING_RESET_RECOVERY_ID,
    operation: env.STAGING_RESET_ORIGINAL_OPERATION,
    configRepository: `${env.CONFIG_REPO_OWNER}/${env.CONFIG_REPO_NAME}`,
  });
  for (const name of ["CLOUDFLARE_API_TOKEN", "GH_TOKEN", "CONFIG_REPO_TOKEN", "STAGING_RUNTIME_SECRETS_JSON"])
    if (!env[name]) throw new StagingResetRecoveryRefusal("inputs-unavailable", `recovery input ${name} is missing`);
  env.SWITCHBOARD_DEPLOY_PROFILE = request.profileRef;
  const loaded = await loadProfileOnHost();
  const source = parseConfigSource(loaded.profile.configSource);
  if (
    loaded.origin !== "profile" ||
    loaded.path !== request.profileRef ||
    !source.ok ||
    source.source.kind !== "github" ||
    !/^[a-f0-9]{40}$/.test(source.source.ref) ||
    `${source.source.owner}/${source.source.repo}` !== context.configRepository
  )
    throw new StagingResetRecoveryRefusal("inputs-unavailable", "recovery configuration source differs");
  const read = await readConfigForPush(loaded.profile.configSource);
  if (!read.ok) throw new StagingResetRecoveryRefusal("inputs-unavailable", "recovery configuration is unavailable");
  const config = parseAppConfigText(read.text);
  if (
    stagingProblems(loaded.profile, config, { staging: context.stagingAccount, production: context.productionAccount })
      .length
  )
    throw new StagingResetRecoveryRefusal("inputs-unavailable", "recovery staging isolation differs");
  const secrets = stagingRestorationSecrets(
    env.STAGING_RUNTIME_SECRETS_JSON!,
    {
      MEMORY_TOKEN: env.MEMORY_TOKEN,
      SANDBOX_TOKEN: env.SANDBOX_TOKEN,
      RESIDENT_READ_TOKEN: env.RESIDENT_READ_TOKEN,
      RESIDENT_DRAIN_TOKEN: env.RESIDENT_DRAIN_TOKEN,
    },
    config.providers,
  );
  delete env.STAGING_RUNTIME_SECRETS_JSON;
  const io = createStagingResetRecoveryIO({
    request,
    profile: loaded.profile,
    repository: context.repository,
    stagingAccount: context.stagingAccount,
    productionAccount: context.productionAccount,
    cloudflareToken: env.CLOUDFLARE_API_TOKEN!,
    githubToken: env.GH_TOKEN!,
    secrets: {
      MEMORY_TOKEN: secrets.MEMORY_TOKEN,
      RESIDENT_ADMIN_TOKEN: secrets.RESIDENT_ADMIN_TOKEN,
      MCP_CREDENTIAL_KEY: secrets.MCP_CREDENTIAL_KEY,
      SANDBOX_TOKEN: secrets.SANDBOX_TOKEN,
    },
    previewText: values.preview ? readFileSync(values.preview, "utf8") : undefined,
    receipt,
  });
  await runStagingResetRecovery(request, context, io);
  console.log(JSON.stringify(latest));
} catch (error) {
  const primary = error instanceof AggregateError ? error.errors[0] : error;
  const failure =
    primary instanceof StagingResetRecoveryBoundaryError
      ? primary.diagnostic
      : primary instanceof StagingResetRecoveryRefusal
        ? { stage: "controller", reason: primary.reason, detail: primary.message }
        : { stage: "controller", reason: "refused-or-unverified" };
  try {
    receipt({ ...latest, outcome: "unverified", failure });
  } catch (receiptError) {
    console.error(
      JSON.stringify({
        event: "staging.reset.recovery.receipt_unavailable",
        kind: receiptError instanceof Error ? "error" : "non-error",
      }),
    );
  }
  console.error(
    JSON.stringify({
      event: "staging.reset.recovery.failure",
      ...failure,
      phase: latest.phase,
      operation: latest.operation,
      recoveryId: latest.recoveryId,
      controller: latest.controller,
    }),
  );
  process.exitCode = 1;
} finally {
  closeSync(fd);
}
