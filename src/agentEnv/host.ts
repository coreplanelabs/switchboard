import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, runBootstrap, type BootstrapResult, type EnvSink, type OpReader } from "./bootstrap.js";

// The host half of the agent-env bootstrap: the REAL `op read` and the REAL
// file sink, plus manifest loading and path defaults. All the testable logic
// lives in bootstrap.ts; this is the deliberately un-unit-tested seam where the
// process actually shells out and touches the filesystem. Reached through the
// registry's `env bootstrap` command (src/core/commands/env.ts), CLI only.

// repo root = two levels up from src/agentEnv/
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Real OpReader: `op read <ref>`. The service-account token is read by `op`
 *  itself from OP_SERVICE_ACCOUNT_TOKEN in the inherited env — never passed in
 *  argv. A non-zero exit or empty stdout throws so a bad ref fails the run
 *  closed. */
export const opReader: OpReader = {
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
export const fileSink: EnvSink = {
  writeEnvFile: async ({ path, contents, mode }) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, contents, { mode });
    try {
      chmodSync(tmp, mode); // writeFileSync mode is subject to umask; force it
      renameSync(tmp, path);
    } catch (e) {
      // A failed apply must never leave a 600 secrets file behind.
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      throw e;
    }
  },
};

export interface HostBootstrapOptions {
  env: string;
  service: string;
  apply: boolean;
  /** explicit out path; undefined → `.agent-env/<service>.<env>.env` under the repo root. */
  out?: string;
  manifest: string;
}

/** Run the bootstrap against the real host: read the manifest, resolve the out
 *  path, shell out to `op` on apply, write the file. `log` receives the plan
 *  lines (names + refs, never values). */
export async function bootstrapOnHost(
  opts: HostBootstrapOptions,
  log: (line: string) => void,
): Promise<BootstrapResult> {
  const manifestFile = isAbsolute(opts.manifest) ? opts.manifest : resolve(REPO_ROOT, opts.manifest);
  const manifest = parseManifest(readFileSync(manifestFile, "utf8"));
  // Default out path keeps resolved values under a gitignored dir, keyed by
  // service+env so parallel services never clobber each other.
  const outFile = opts.out
    ? isAbsolute(opts.out)
      ? opts.out
      : resolve(REPO_ROOT, opts.out)
    : resolve(REPO_ROOT, ".agent-env", `${opts.service}.${opts.env}.env`);
  return runBootstrap(
    { env: opts.env, service: opts.service, apply: opts.apply, outFile },
    {
      manifest,
      env: { OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN },
      opReader,
      sink: fileSink,
      log,
    },
  );
}
