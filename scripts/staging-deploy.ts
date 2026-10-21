import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAppConfigText } from "../src/config.js";
import { hostAffectedProbe, loadProfileOnHost, readConfigForPush } from "../src/deploy/run.js";
import { stagingProblems, waitForStagingMaintenanceRelease } from "../src/deploy/staging.js";
import { systemClock } from "../src/core/trace/clock.js";
import { workersFor } from "../src/deploy/plan.js";

if (process.argv[2] === "--recover-resident") {
  process.argv.splice(2, 1);
  await import("./staging-recover-resident.js");
  process.exit(process.exitCode ?? 0);
}

if (process.argv[2] === "--continue-initialize") {
  process.argv.splice(2, 1);
  await import("./staging-continue.js");
  process.exit(0);
}

if (process.argv[2] === "--recreate") {
  process.argv.splice(2, 1);
  await import("./staging-recreate.js");
  process.exit(0);
}

const args = process.argv.slice(2);
const selection: string[] = [];
let check = false;
let initialize = false;
let retainMaintenance = false;
let receiptPath: string | undefined;
let selectionReceiptPath: string | undefined;
let resumeMemory: string | undefined;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (
    arg === "--selection-receipt" &&
    !selectionReceiptPath &&
    !initialize &&
    args[i + 1] &&
    !args[i + 1].startsWith("--")
  )
    selectionReceiptPath = args[++i];
  else if (
    (arg === "--receipt" || arg === "--resume-memory") &&
    selection.length === 0 &&
    args[i + 1] &&
    !args[i + 1].startsWith("--")
  ) {
    initialize = true;
    if (arg === "--receipt" && !receiptPath) receiptPath = args[++i];
    else if (arg === "--resume-memory" && !resumeMemory) resumeMemory = args[++i];
    else throw new Error("duplicate initialization receipt option");
  } else if (arg === "--initialize" && !initialize && selection.length === 0) initialize = true;
  else if (arg === "--retain-maintenance" && !retainMaintenance && !initialize) retainMaintenance = true;
  else if (arg === "--check" && !check) check = true;
  else if (arg === "--affected" && !initialize && selection.length === 0) selection.push(arg);
  else if (
    arg === "--only" &&
    !initialize &&
    selection.length === 0 &&
    /^(memory|bot|resident|sandbox)(,(memory|bot|resident|sandbox))*$/.test(args[i + 1] ?? "")
  )
    selection.push(arg, args[++i]);
  else
    throw new Error(
      "staging:deploy accepts --check, --initialize, or --affected/--only <Worker list>; preflight bypass is not supported",
    );
}
if (retainMaintenance && initialize) throw new Error("retained maintenance cannot initialize a new installation");
if (selectionReceiptPath && (initialize || check)) throw new Error("staging selection receipt requires a deployment");
if (!process.env.SWITCHBOARD_DEPLOY_PROFILE) throw new Error("SWITCHBOARD_DEPLOY_PROFILE must explicitly name staging");
const loaded = await loadProfileOnHost();
if (retainMaintenance && !loaded.profile.residentMaintenance)
  throw new Error("retained maintenance requires a selected staging Resident policy");
if (loaded.profile.residentMaintenance && !retainMaintenance)
  throw new Error("selected staging maintenance requires --retain-maintenance");
const config = await readConfigForPush(loaded.profile.configSource);
if (!config.ok) throw new Error(config.problem);
const problems = stagingProblems(loaded.profile, parseAppConfigText(config.text), {
  staging: process.env.SWITCHBOARD_STAGING_ACCOUNT,
  production: process.env.SWITCHBOARD_PRODUCTION_ACCOUNT,
});
if (problems.length) throw new Error(problems.join("\n"));
console.log(
  "Staging isolation: profile and resolved runtime endpoints passed; credentials and app scope require provisioning proof.",
);
if (!check && initialize) {
  const { initializeOnHost } = await import("./staging-initialize.js");
  await initializeOnHost(structuredClone(loaded.profile), Object.freeze({ ...config }), { receiptPath, resumeMemory });
} else if (!check) {
  const directory = mkdtempSync(join(tmpdir(), "switchboard-staging-"));
  try {
    // Freeze both remote inputs outside the checkout; the deploy runner still checks its clean tree.
    const configPath = join(directory, "config.yaml");
    const profilePath = join(directory, "profile.json");
    writeFileSync(configPath, config.text, { mode: 0o600 });
    writeFileSync(profilePath, JSON.stringify({ ...loaded.profile, configSource: configPath }), { mode: 0o600 });
    // Explicit values survive the child CLI's .env loader; neither shell nor file may authorize a bypass.
    const env = {
      ...process.env,
      SWITCHBOARD_DEPLOY_PROFILE: profilePath,
      SWITCHBOARD_DEPLOY_FORCE: "0",
      RESIDENT_DEPLOY_FORCE: "0",
    };
    for (const verb of ["plan", "all"]) {
      const result = spawnSync(
        "npm",
        [
          "run",
          "--silent",
          "cli",
          "--",
          "deploy",
          verb,
          ...selection,
          "--allow-branch",
          ...(retainMaintenance ? ["--retain-maintenance"] : []),
          ...(verb === "all" && selectionReceiptPath ? ["--json"] : []),
        ],
        {
          env,
          stdio: verb === "all" && selectionReceiptPath ? ["inherit", "pipe", "inherit"] : "inherit",
          encoding: "utf8",
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`staging deploy ${verb} failed (${result.status})`);
      if (verb === "all" && selectionReceiptPath) {
        const output = JSON.parse(result.stdout) as {
          plan: {
            steps: { name: string }[];
            affected?: { workers: { name: string; base: { kind: string; commit?: string } }[] };
          };
        };
        const botSelected = output.plan.steps.some((step) => step.name === "bot");
        const base = output.plan.affected?.workers.find((worker) => worker.name === "bot")?.base;
        const live =
          botSelected || base?.kind === "live"
            ? undefined
            : await hostAffectedProbe(workersFor(loaded.profile), env).liveCommit("bot");
        const botBaseCommit = botSelected
          ? undefined
          : base?.kind === "live"
            ? base.commit
            : live && "commit" in live
              ? live.commit
              : undefined;
        if (!botSelected && !/^[0-9a-f]{40}$/.test(botBaseCommit ?? ""))
          throw new Error("staging acceptance cannot read the skipped Bot's exact live commit");
        writeFileSync(selectionReceiptPath, JSON.stringify({ botSelected, botBaseCommit }), { mode: 0o600 });
        console.log(`Staging deployment completed; Bot ${botSelected ? "selected" : "skipped"}.`);
      }
    }
    if (retainMaintenance && loaded.profile.residentMaintenance) {
      const policy = loaded.profile.residentMaintenance;
      const token =
        process.env.RESIDENT_READ_TOKEN || process.env.RESIDENT_ADMIN_TOKEN || process.env.RESIDENT_OPERATOR_TOKEN;
      if (!token) throw new Error("staging maintenance release wait requires an existing read bearer");
      console.log("Staging image is ready under maintenance. Validation waits for explicit operator release.");
      await waitForStagingMaintenanceRelease(policy, {
        now: systemClock,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        read: async (timeoutMs) => {
          const response = await fetch(new URL("/staging-maintenance", policy.residentOrigin), {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) throw new Error(`staging maintenance read refused: HTTP ${response.status}`);
          return response.json();
        },
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
