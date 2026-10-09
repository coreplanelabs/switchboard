import { STAGING_VALIDATION_WAIT_MS } from "../src/core/budgets.js";
import { systemClock } from "../src/core/trace/clock.js";
import { appendFile } from "node:fs/promises";
import { stagingValidation, type StagingPull, type ValidationCheck } from "../src/deploy/stagingCi.js";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const commit = process.env.STAGING_COMMIT ?? "";
const number = process.env.STAGING_PR_NUMBER ?? "";
const token = process.env.GH_TOKEN ?? "";
const automatic = process.env.STAGING_AUTOMATIC === "true";
const actor = process.env.STAGING_ACTOR ?? "";
const recheck = process.env.STAGING_VALIDATE_MODE === "recheck";
if (
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
  !/^[a-f0-9]{40}$/.test(commit) ||
  !/^[1-9][0-9]*$/.test(number) ||
  !token ||
  (!automatic && !actor)
)
  throw new Error("Staging validation needs a repository, exact commit, pull request and read token");

const api = async <T>(path: string): Promise<T> => {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Staging validation cannot read GitHub (HTTP ${response.status})`);
  return response.json() as Promise<T>;
};
const output = async (eligible: boolean) => {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `eligible=${eligible}\ncommit=${commit}\npr=${number}\n`);
};
await output(false);
const deadline = systemClock() + (recheck ? 0 : STAGING_VALIDATION_WAIT_MS);
let previous = "";
for (;;) {
  const pull = await api<StagingPull & { labels: { name: string }[] }>(`pulls/${number}`);
  if (process.env.STAGING_REQUIRE_LABEL === "true" && !pull.labels.some((label) => label.name === "deploy:staging")) {
    console.log("Staging request withdrawn; no credentials given to the candidate.");
    break;
  }
  const permission = automatic
    ? undefined
    : await api<{ permission: string }>(`collaborators/${encodeURIComponent(actor)}/permission`);
  const checks: ValidationCheck[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await api<{ check_runs: ValidationCheck[] }>(`commits/${commit}/check-runs?per_page=100&page=${page}`);
    checks.push(...data.check_runs);
    if (data.check_runs.length < 100) break;
    if (page === 10) throw new Error("Staging validation check inventory is incomplete");
  }
  const result = stagingValidation({ repository, commit, pull, permission: permission?.permission, automatic, checks });
  if (result.kind === "ready") {
    await output(true);
    console.log(`Validation and package smoke passed for ${commit}; staging may start.`);
    break;
  }
  if (result.kind === "refused") {
    console.log(`Staging not admitted: ${result.reason}.`);
    if (result.reason.startsWith("validation_failed:")) process.exitCode = 1;
    break;
  }
  if (recheck || systemClock() >= deadline) throw new Error(`Staging validation did not finish: ${result.reason}`);
  if (result.reason !== previous) console.log(`Waiting for ${result.reason}.`);
  previous = result.reason;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
