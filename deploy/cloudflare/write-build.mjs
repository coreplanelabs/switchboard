#!/usr/bin/env node
// Stamp the build identity into the bot image (docs/reference/specs/slack-channel.md item 8).
//
// `wrangler deploy` builds ../../Dockerfile from the CURRENT tree and exposes
// no build args, so `npm run deploy` writes `<repo>/build.json` first and the
// Dockerfile COPYs it (`COPY package.json build.jso[n] ./` — the glob makes the
// file optional, so a bare `wrangler deploy` or docker-compose still builds and
// the bot then reports `commit: "unknown"`). The bot reads it once at startup and
// serves it on `GET /healthz` as `build: { commit, builtAt }`; `deploy:all`'s
// live gate compares that commit to the one it deployed, so "deployed" is never
// confused with "live". The file is gitignored: the tree stays clean.
//
// Dependency-free Node (child_process + fs). `buildInfo()` is pure given its
// inputs; `main()` does the I/O.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `{ commit, builtAt }` — `commit` gets a `-dirty` suffix when the tree has uncommitted changes. */
export function buildInfo({ commit, dirty, now = new Date() }) {
  return { commit: `${commit}${dirty ? "-dirty" : ""}`, builtAt: now.toISOString() };
}

/** The env var that names the commit when there is no tree to read — a deploy from the published npm
 *  package (src/deploy/run.ts sets it; `../bin/build-stamp.mjs` reads the same variable). */
export const COMMIT_ENV = "SWITCHBOARD_BUILD_COMMIT";

/** The identity: the environment's commit when it names one (never `-dirty` — nothing was read from a tree), else git's. */
export function readBuildInfo(
  env = process.env,
  git = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
) {
  const given = env[COMMIT_ENV]?.trim();
  if (given) return buildInfo({ commit: given, dirty: false });
  return buildInfo({ commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" });
}

/** The config consumer stamp must describe the code being packaged, not an
 * arbitrary environment label. A package without git uses its published source. */
export function readConsumerBuildInfo(
  env = process.env,
  git = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
  readSource = () => JSON.parse(readFileSync(join(REPO_ROOT, "source.json"), "utf8")),
) {
  let commit;
  let checkout = false;
  try {
    commit = git(["rev-parse", "HEAD"]);
    checkout = true;
  } catch {
    commit = readSource()?.commit;
  }
  // Once HEAD identifies a checkout, an unavailable status is uncertainty,
  // not evidence of a package. It must propagate before a stamp is written.
  if (checkout && git(["status", "--porcelain"]) !== "") throw new Error("dirty publishing tree");
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error("config consumer build requires an exact clean source commit");
  const given = env[COMMIT_ENV];
  if (given !== undefined && given !== commit)
    throw new Error("provided build commit does not match the packaged consumer source");
  return buildInfo({ commit, dirty: false });
}

export function main() {
  const info = readConsumerBuildInfo();
  const path = join(REPO_ROOT, "build.json");
  writeFileSync(path, `${JSON.stringify(info)}\n`);
  console.log(`[build] ${path}: ${info.commit} @ ${info.builtAt}`);
  return 0;
}

// Run only when executed directly (`node write-build.mjs`), not when imported.
// pathToFileURL, not `file://${argv[1]}`, so the guard also holds on Windows paths.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
