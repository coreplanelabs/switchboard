import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  PACKAGE_ROOT,
  PACKAGE_SOURCE_FILE,
  packageVersion,
  parsePackageSource,
  RUNS_FROM_PUBLISHED_PACKAGE,
} from "../packageRoot.js";
import { assetPath, resolveOperatorRoot, type OperatorRoot } from "./operatorRoot.js";
import { ensureWorkArea, type WorkAreaOutcome } from "./workArea.js";

// The root this process deploys from, and the work area over it — the one place
// the deploy hosts (src/deploy/run.ts, src/deploy/secretsHost.ts) ask "where"
// (src/deploy/operatorRoot.ts explains the three kinds of file). In a checkout
// the work area is the tree itself and nothing here does anything; from the
// published package `ensureWorkAreaOnHost` copies the shipped tree under the
// operator's directory and installs the Workers about to run (src/deploy/workArea.ts).

/** Where this process deploys from: the package root and the working directory it was started in. */
export const OPERATOR_ROOT: OperatorRoot = resolveOperatorRoot({
  packageRoot: PACKAGE_ROOT,
  published: RUNS_FROM_PUBLISHED_PACKAGE,
  cwd: process.cwd(),
});

/** The published package's own version and commit (`source.json` in its assets). Throws, naming the
 *  file, when the package carries none — a broken package, never a deploy of an unknown tree. */
export function packageSourceOnHost(at: Pick<OperatorRoot, "assets"> = OPERATOR_ROOT) {
  const path = assetPath(at, PACKAGE_SOURCE_FILE);
  const parsed = parsePackageSource(existsSync(path) ? readFileSync(path, "utf8") : undefined);
  if (!parsed.ok) throw new Error(`${parsed.problem} (${path})`);
  return parsed.source;
}

/** The version this CLI runs as — what the release published its images under (src/deploy/images.ts):
 *  from the package, its own `source.json`; in a checkout or the image, the root `package.json`'s. */
export function cliVersionOnHost(at: OperatorRoot = OPERATOR_ROOT): string {
  return at.mode === "package" ? packageSourceOnHost(at).version : packageVersion();
}

/** `npm ci --workspace <w>…` in `cwd`, output collected; never throws. */
function npmCi(cwd: string, workspaces: readonly string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const args = ["ci", "--no-audit", "--no-fund", ...workspaces.flatMap((w) => ["--workspace", w])];
    const child = spawn("npm", args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr.on("data", (c: Buffer) => (output += c.toString()));
    child.on("error", (err) => resolve({ code: 127, output: `${output}\n${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * From the package: the work area holds the shipped tree at this CLI's version
 * and each of `workers` (their `deploy/<worker>` directories) is installed —
 * `[]` for the copy alone, what a render needs. In a checkout: nothing to do,
 * the tree is the work area. A problem is returned, never thrown: the caller
 * names it as a refusal.
 */
export async function ensureWorkAreaOnHost(
  workers: readonly string[],
  log: (line: string) => void,
  at: OperatorRoot = OPERATOR_ROOT,
): Promise<WorkAreaOutcome> {
  if (at.mode === "checkout") return { ok: true, copied: false, installed: [] };
  let version: string;
  try {
    version = packageSourceOnHost(at).version;
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
  return ensureWorkArea(at, version, workers, { install: npmCi, log });
}
