import type { AppConfig } from "../config.js";
import type { DeploymentProfile } from "./profile.js";
import { EXAMPLE_ACCOUNT, WORKER_KINDS } from "./profile.js";

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
