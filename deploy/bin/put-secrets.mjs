#!/usr/bin/env node
// Provision a Worker's secrets from the manifest — the `npm run secrets` behind
// every deploy/cloudflare*/ package.json.
//
//   node ../bin/put-secrets.mjs <bot|resident|memory|sandbox> [NAME ...]
//
// Reads deploy/secrets.manifest.json, takes the entries listed for that Worker
// (or only the NAMEs given), and pipes each ~/.secrets/switchboard/<NAME> into
// `wrangler secret put <NAME>` in the current directory. A required secret with
// no local file aborts BEFORE anything is uploaded (a half-provisioned Worker
// is worse than an unprovisioned one); optional ones are skipped by name.
// Values never touch argv or the environment — stdin only.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/** @typedef {{ name: string, workers: string[], optional?: boolean, note?: string }} SecretDef */
/** @typedef {{ secrets: SecretDef[] }} Manifest */

/** Worker key → its deploy/ directory. The only place the mapping lives. */
export const WORKERS = Object.freeze({
  bot: "cloudflare",
  resident: "cloudflare-resident",
  memory: "cloudflare-memory",
  sandbox: "cloudflare-sandbox",
});

export const SECRETS_DIR = resolve(homedir(), ".secrets", "switchboard");

/** @returns {Manifest} */
export function loadManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Pure: which names to put for `worker`, which optional ones lack a file, and
 * which REQUIRED ones lack a file (the caller must refuse when non-empty).
 * @param {Manifest} manifest
 * @param {keyof typeof WORKERS} worker
 * @param {(name: string) => boolean} hasFile
 * @param {string[]} [only] explicit names; each must be one of the Worker's secrets
 */
export function planSecretPuts(manifest, worker, hasFile, only) {
  if (!(worker in WORKERS)) throw new Error(`unknown worker "${worker}" — one of ${Object.keys(WORKERS).join(", ")}`);
  const mine = manifest.secrets.filter((s) => s.workers.includes(worker));
  const wanted = only
    ? only.map((n) => {
        const def = mine.find((s) => s.name === n);
        if (!def) throw new Error(`${n} is not a ${worker} secret (manifest: ${mine.map((s) => s.name).join(", ")})`);
        return def;
      })
    : mine;
  const puts = [], skippedOptional = [], missing = [];
  for (const s of wanted) {
    if (hasFile(s.name)) puts.push(s.name);
    else if (s.optional) skippedOptional.push(s.name);
    else missing.push(s.name);
  }
  return { puts, skippedOptional, missing };
}

/** The Worker dir's pinned wrangler when run from inside it; PATH otherwise (`npm run secrets` puts the same binary on PATH). */
function wranglerBin() {
  const local = resolve("node_modules/.bin/wrangler");
  return existsSync(local) ? local : "wrangler";
}

function main(argv) {
  const [worker, ...only] = argv;
  if (!worker) {
    console.error("usage: put-secrets.mjs <bot|resident|memory|sandbox> [NAME ...]");
    return 2;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = loadManifest(resolve(here, "..", "secrets.manifest.json"));
  const fileFor = (name) => resolve(SECRETS_DIR, name);
  let plan;
  try {
    plan = planSecretPuts(manifest, worker, (name) => existsSync(fileFor(name)), only.length ? only : undefined);
  } catch (err) {
    console.error(`refusing: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  for (const n of plan.skippedOptional) console.log(`skip  ${n} (optional; no ${fileFor(n)})`);
  if (plan.missing.length) {
    console.error(`refusing: no local value for required ${worker} secret(s) ${plan.missing.join(", ")} — expected ${SECRETS_DIR}/<NAME> (1Password item "Switchboard: <NAME>"). Nothing uploaded.`);
    return 1;
  }
  for (const n of plan.puts) {
    console.log(`put   ${n} → ${WORKERS[worker]}`);
    const r = spawnSync(wranglerBin(), ["secret", "put", n], { input: readFileSync(fileFor(n)), stdio: ["pipe", "inherit", "inherit"] });
    if (r.status !== 0) {
      console.error(`wrangler secret put ${n} failed (exit ${r.status}); stopping — ${plan.puts.slice(plan.puts.indexOf(n) + 1).join(", ") || "nothing"} not attempted`);
      return r.status ?? 1;
    }
  }
  console.log(`done: ${plan.puts.length} secret(s) on ${WORKERS[worker]}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
