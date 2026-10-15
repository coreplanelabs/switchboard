import type { AppConfig } from "../config.js";
import type { DeploymentProfile } from "./profile.js";
import { EXAMPLE_ACCOUNT, WORKER_KINDS } from "./profile.js";
import { DRAIN } from "../core/budgets.js";
import { stagingAttemptMatches, type StagingMaintenancePolicy } from "./residentMaintenance.js";

/** The existing CI controller waits for an explicit release. A missing or
 * changed receipt stops it; this function never changes maintenance. */
export async function waitForStagingMaintenanceRelease(
  policy: StagingMaintenancePolicy,
  io: { now(): number; read(timeoutMs: number): Promise<unknown>; sleep(ms: number): Promise<void> },
): Promise<void> {
  while (io.now() < policy.attempt.deadline) {
    const response = await io.read(Math.min(DRAIN.pollMs, policy.attempt.deadline - io.now()));
    const held = response && typeof response === "object" && "maintenance" in response ? response.maintenance : null;
    if (
      !held ||
      typeof held !== "object" ||
      !("state" in held) ||
      !("attempt" in held) ||
      !("holdId" in held) ||
      !("generation" in held) ||
      !("fixtureSha256" in held) ||
      held.fixtureSha256 !== policy.fixtureSha256 ||
      !stagingAttemptMatches(
        { policy },
        { ...(held.attempt as Record<string, unknown>), holdId: held.holdId, generation: held.generation },
      )
    )
      throw new Error("selected staging maintenance readback is unavailable or changed");
    if (
      held.state === "released" &&
      "releaseDecisionSha256" in held &&
      typeof held.releaseDecisionSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(held.releaseDecisionSha256) &&
      held.releaseDecisionSha256 !== policy.decisionSha256 &&
      io.now() < policy.attempt.deadline
    )
      return;
    if (held.state !== "held") throw new Error("explicit staging release decision is unverified");
    const left = policy.attempt.deadline - io.now();
    if (left > 0) await io.sleep(Math.min(DRAIN.pollMs, left));
  }
  throw new Error("staging release deadline expired; maintenance was not released by this controller");
}

/** Staging is a separate installation. Refuse incomplete isolation before any upload. */
export function stagingProblems(
  profile: DeploymentProfile,
  config: AppConfig,
  accounts: { staging?: string; production?: string },
): string[] {
  const problems: string[] = [];
  for (const [name, account] of Object.entries(accounts)) {
    if (!account || !/^[0-9a-f]{32}$/.test(account) || account === EXAMPLE_ACCOUNT)
      problems.push(`${name} account must be an explicit Cloudflare account id`);
  }
  if (!accounts.staging || !accounts.production) problems.push("both staging and production accounts are required");
  if (accounts.staging === accounts.production) problems.push("staging must use a separate Cloudflare account");
  if (profile.account !== accounts.staging) problems.push("profile account does not match the staging account");
  if (
    profile.residentMaintenance &&
    (profile.residentMaintenance.stagingAccount !== accounts.staging ||
      profile.residentMaintenance.productionAccount !== accounts.production)
  )
    problems.push("residentMaintenance must match the independently configured staging and production accounts");
  if (profile.images !== "build") problems.push("staging candidates require images: build");
  for (const kind of WORKER_KINDS) {
    const worker = profile.workers[kind];
    if (!worker) problems.push(`workers.${kind} is required for staging parity`);
    else if (!worker.script.includes("staging")) problems.push(`workers.${kind}.script must name staging`);
  }
  const c = config;
  const memory = profile.workers.memory ? `https://${profile.workers.memory.hostname}` : undefined;
  for (const name of ["runHistory", "runtimeOverrides", "memory"] as const) {
    if (c?.[name]?.worker?.baseUrl !== memory || !memory)
      problems.push(`${name}.worker.baseUrl must name the staging state Worker`);
  }
  if (c?.execution?.type !== "cloudflare" || c.execution.url !== `https://${profile.workers.sandbox?.hostname}`)
    problems.push("execution must use the staging sandbox Worker");
  if (c?.execution?.resident?.baseUrl !== `https://${profile.workers.resident?.hostname}`)
    problems.push("execution.resident.baseUrl must name the staging resident Worker");
  if (!profile.artifacts?.bucket.includes("staging") || c?.artifacts?.r2?.bucket !== profile.artifacts.bucket)
    problems.push("artifacts must use a matching staging bucket");
  if (c.artifacts?.r2.accountId !== accounts.staging)
    problems.push("artifacts.r2.accountId must name the staging account");
  if (
    !profile.metrics?.dataset.includes("staging") ||
    (c.metrics as { dataset?: string } | undefined)?.dataset !== profile.metrics.dataset
  )
    problems.push("metrics must use a matching staging dataset");
  // A Worker client can appear in optional features too. Check every resolved worker block.
  function checkWorkers(value: unknown, path: string): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "worker" && child && typeof child === "object" && "baseUrl" in child && child.baseUrl !== memory)
        problems.push(`${path}.worker.baseUrl must name the staging state Worker`);
      if ((key === "accountId" || key === "account") && child === accounts.production)
        problems.push(`${path}.${key} must not name the production account`);
      checkWorkers(child, `${path}.${key}`);
    }
  }
  checkWorkers(config, "config");
  return problems;
}
