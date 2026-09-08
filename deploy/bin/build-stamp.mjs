#!/usr/bin/env node
// Stamp the build identity into a Worker SCRIPT deploy (docs/reference/specs/execution.md
// item 13) — the resident, memory and sandbox Workers' `npm run deploy` runs
// this instead of bare `wrangler deploy`.
//
// It derives `{commit, builtAt}` from the tree being deployed and hands them to
// `wrangler deploy --define`, so the bundle carries the commit and the Worker
// answers it on `/healthz` (`src/deploy/buildStamp.ts` is the reader). The bot
// does the same thing through a COPYed `build.json` (`../cloudflare/write-build.mjs`)
// because a container needs a file; a Worker script needs a substitution — the
// reader module explains why a generated file cannot work here.
//
// Dependency-free Node. `buildStamp` and `defineArgs` are pure given their
// inputs and unit-tested from `src/deploy/buildStamp.test.ts`; `main()` does
// the git reads and the spawn.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The identifiers substituted into the bundle. `src/deploy/buildStamp.ts`
 *  declares and reads exactly these two. */
export const DEFINE_COMMIT = "SWITCHBOARD_BUILD_COMMIT";
export const DEFINE_BUILT_AT = "SWITCHBOARD_BUILT_AT";

/** `{ commit, builtAt }` — `commit` gets a `-dirty` suffix when the tree has
 *  uncommitted changes, because wrangler bundles the TREE, not the commit. */
export function buildStamp({ commit, dirty, now = new Date() }) {
  return { commit: `${commit}${dirty ? "-dirty" : ""}`, builtAt: now.toISOString() };
}

/** The `--define` argv for a stamp. `JSON.stringify` is what makes each value
 *  a JS string LITERAL rather than an expression: esbuild substitutes the text
 *  verbatim, so an unquoted value would be parsed as code. */
export function defineArgs(stamp) {
  return [
    "--define",
    `${DEFINE_COMMIT}:${JSON.stringify(stamp.commit)}`,
    "--define",
    `${DEFINE_BUILT_AT}:${JSON.stringify(stamp.builtAt)}`,
  ];
}

/** The identity the environment hands a deploy that has no tree to read: a
 *  deploy from the published npm package runs this script in a materialised
 *  copy of the Worker's directory, where git knows nothing, and sets
 *  `SWITCHBOARD_BUILD_COMMIT` to the commit the package was built from
 *  (src/deploy/run.ts). `builtAt` is still now — each deploy is its own build.
 *  Undefined when the variable is unset or blank: git decides. Pure. */
export function stampFromEnv(env, now = new Date()) {
  const commit = env[DEFINE_COMMIT]?.trim();
  return commit ? { commit, builtAt: now.toISOString() } : undefined;
}

/** Read the tree's identity: the environment's when it names one, else git. A
 *  git failure (deploying from an export, no git on PATH) warns and stamps
 *  `unknown` rather than blocking the deploy — the Worker then reports
 *  `commit: "unknown"`, which is the honest answer. */
function readStamp() {
  const given = stampFromEnv(process.env);
  if (given) return given;
  try {
    const git = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    return buildStamp({ commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" });
  } catch (err) {
    console.warn(`[build-stamp] git failed (${err?.message ?? err}) — deploying with commit "unknown"`);
    return { commit: "unknown", builtAt: new Date().toISOString() };
  }
}

/** How a finished spawn becomes this script's exit code, plus the line to
 *  print. A signal kill (Ctrl-C, a CI timeout) reports `status: null`, so
 *  without naming the signal an interrupted deploy is indistinguishable from
 *  a wrangler that simply failed. */
export function spawnOutcome({ error, signal, status }) {
  if (error) return { code: 1, message: `could not run wrangler: ${error.message}` };
  if (signal) return { code: 1, message: `wrangler was killed by ${signal} — the deploy did not finish` };
  if (typeof status !== "number") return { code: 1, message: "wrangler exited with no status" };
  return { code: status };
}

export function main(extraArgs = []) {
  const stamp = readStamp();
  const args = ["deploy", ...defineArgs(stamp), ...extraArgs];
  console.log(`[build-stamp] ${stamp.commit} @ ${stamp.builtAt}`);
  // `wrangler` resolves through the calling package's node_modules/.bin, which
  // npm puts on PATH for a `npm run deploy`. shell:false — no argument of this
  // command may ever be interpreted by a shell.
  const outcome = spawnOutcome(spawnSync("wrangler", args, { stdio: "inherit", cwd: process.cwd() }));
  if (outcome.message) console.error(`[build-stamp] ${outcome.message}`);
  return outcome.code;
}

// Run only when executed directly, not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
