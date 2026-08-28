// Thin CLI wrapper around bootstrap.ts — wires the REAL `op read` and the REAL
// file sink, and owns argv parsing, manifest loading, exit codes, and usage
// output. All the testable logic lives in bootstrap.ts; this file is the
// deliberately un-unit-tested seam where the process actually shells out and
// touches the filesystem.
//
// Entry point (see deploy/agent-env-bootstrap.sh and the root
// `agent-env-bootstrap` npm script):
//   npx tsx src/agentEnv/bootstrapCli.ts --env uat --service <name> [--apply]

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  parseManifest,
  runBootstrap,
  USAGE,
  type EnvSink,
  type OpReader,
} from "./bootstrap.js";

// repo root = two levels up from src/agentEnv/
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Real OpReader: `op read <ref>`. The service-account token is read by `op`
 *  itself from OP_SERVICE_ACCOUNT_TOKEN in the inherited env — never passed in
 *  argv. A non-zero exit or empty stdout throws so a bad ref fails the run
 *  closed. */
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

/** Real EnvSink: materialize the env file owner-only (mode 600). Writes a fresh
 *  temp file at mode 600 and atomically renames it over the target, so new
 *  secret contents never sit under a pre-existing file's looser permissions. */
const fileSink: EnvSink = {
  writeEnvFile: async ({ path, contents, mode }) => {
    mkdirSync(dirname(path), { recursive: true });
    // Write a fresh temp file at the target mode, then atomically rename over the
    // destination. A plain write-then-chmod would leave secret contents under a
    // pre-existing file's (possibly looser) permissions until the chmod lands;
    // writing a new temp file at `mode` and renaming closes that window and makes
    // the swap atomic.
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, contents, { mode });
    try {
      chmodSync(tmp, mode); // writeFileSync mode is subject to umask; force it
      renameSync(tmp, path);
    } catch (e) {
      // If chmod/rename fails after the temp write, remove the orphaned temp so a
      // failed apply never leaves a 600 secrets file behind. (On success the temp
      // is renamed away, so cleanup only matters on the error path.)
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      throw e;
    }
  },
};

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`agent-env-bootstrap: ${parsed.error}\n\n${USAGE}\n`);
    process.exit(1);
  }

  const manifestFile = isAbsolute(parsed.manifest) ? parsed.manifest : resolve(REPO_ROOT, parsed.manifest);
  let manifest;
  try {
    manifest = parseManifest(readFileSync(manifestFile, "utf8"));
  } catch (e) {
    process.stderr.write(`agent-env-bootstrap: cannot read ${manifestFile}: ${(e as Error).message}\n`);
    process.exit(1);
    return;
  }

  // Default out path keeps resolved values under a gitignored dir, keyed by
  // service+env so parallel services never clobber each other.
  const defaultOut = resolve(REPO_ROOT, ".agent-env", `${parsed.service}.${parsed.env}.env`);
  const outFile = parsed.out ? (isAbsolute(parsed.out) ? parsed.out : resolve(REPO_ROOT, parsed.out)) : defaultOut;

  try {
    await runBootstrap(
      { env: parsed.env, service: parsed.service, apply: parsed.apply, outFile },
      {
        manifest,
        env: { OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN },
        opReader,
        sink: fileSink,
        log: (line) => process.stdout.write(`${line}\n`),
      },
    );
  } catch (e) {
    process.stderr.write(`agent-env-bootstrap: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

void main();
