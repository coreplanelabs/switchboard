// Thin CLI wrapper around opEnvFill.ts — wires the REAL `op read` and
// `wrangler` implementations and owns argv parsing, config loading, exit codes,
// and usage output. All the testable logic lives in opEnvFill.ts; this file is
// deliberately the un-unit-tested seam where the process actually shells out.
//
// Entry point (see deploy/op-env-fill.sh and the root `op-env-fill` script):
//   npx tsx src/deploy/opEnvFillCli.ts --env uat --target both [--apply]

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  parseConfig,
  runFill,
  USAGE,
  type OpReader,
  type WranglerRunner,
} from "./opEnvFill.js";

// repo root = two levels up from src/deploy/
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Real OpReader: `op read <ref>`. The service-account token is read by `op`
 *  itself from OP_SERVICE_ACCOUNT_TOKEN in the inherited env — never passed in
 *  argv. Returns the resolved value; a non-zero exit or empty stdout throws so
 *  a bad ref fails the run closed. */
const opReader: OpReader = {
  read: (ref) =>
    new Promise<string>((resolvePromise, reject) => {
      const child = spawn("op", ["read", ref], { env: process.env });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => reject(new Error(`failed to launch \`op read\`: ${e.message}`)));
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`\`op read ${ref}\` failed (exit ${code}): ${err.trim()}`));
          return;
        }
        // op appends a single trailing newline; strip exactly that.
        const value = out.replace(/\n$/, "");
        if (value.length === 0) {
          reject(new Error(`\`op read ${ref}\` returned an empty value`));
          return;
        }
        resolvePromise(value);
      });
    }),
};

/** Real WranglerRunner: `wrangler secret put <name>` in the Worker dir, value
 *  piped on stdin so it never appears in argv or process listings. */
const wrangler: WranglerRunner = {
  putSecret: ({ name, value, cwd }) =>
    new Promise<void>((resolvePromise, reject) => {
      const child = spawn("npx", ["wrangler", "secret", "put", name], {
        cwd,
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.on("error", (e) => reject(new Error(`failed to launch wrangler: ${e.message}`)));
      child.on("close", (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`\`wrangler secret put ${name}\` failed (exit ${code})`));
      });
      child.stdin.write(value);
      child.stdin.end();
    }),
};

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`op-env-fill: ${parsed.error}\n\n${USAGE}\n`);
    process.exit(1);
  }

  const configFile = isAbsolute(parsed.configPath)
    ? parsed.configPath
    : resolve(REPO_ROOT, parsed.configPath);
  let config;
  try {
    config = parseConfig(readFileSync(configFile, "utf8"));
  } catch (e) {
    process.stderr.write(`op-env-fill: cannot read ${configFile}: ${(e as Error).message}\n`);
    process.exit(1);
    return;
  }

  try {
    await runFill(
      { env: parsed.env, targets: parsed.targets, apply: parsed.apply, allowProd: parsed.allowProd },
      {
        config,
        env: { OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN },
        repoRoot: REPO_ROOT,
        opReader,
        wrangler,
        log: (line) => process.stdout.write(`${line}\n`),
      },
    );
  } catch (e) {
    process.stderr.write(`op-env-fill: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

void main();
