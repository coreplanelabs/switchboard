import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAppConfigText } from "../src/config.js";
import { loadProfileOnHost, readConfigForPush } from "../src/deploy/run.js";
import { stagingProblems } from "../src/deploy/staging.js";

const args = process.argv.slice(2);
const selection: string[] = [];
let check = false;
let initialize = false;
let receiptPath: string | undefined;
let resumeMemory: string | undefined;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (
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
if (!process.env.SWITCHBOARD_DEPLOY_PROFILE) throw new Error("SWITCHBOARD_DEPLOY_PROFILE must explicitly name staging");
const loaded = await loadProfileOnHost();
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
        ["run", "--silent", "cli", "--", "deploy", verb, ...selection, "--allow-branch"],
        {
          env,
          stdio: "inherit",
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`staging deploy ${verb} failed (${result.status})`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
