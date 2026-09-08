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
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `{ commit, builtAt }` — `commit` gets a `-dirty` suffix when the tree has uncommitted changes. */
export function buildInfo({ commit, dirty, now = new Date() }) {
  return { commit: `${commit}${dirty ? "-dirty" : ""}`, builtAt: now.toISOString() };
}

export function main() {
  const git = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const info = buildInfo({ commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" });
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
