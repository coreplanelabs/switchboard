#!/usr/bin/env -S npx tsx
// Builds the publishable package (docs/reference/specs/packaging.md):
//   dist/cli.js      the CLI, bundled from ../../src/cli.ts by esbuild — one file, the
//                    repository's own modules inlined, every npm dependency left external
//                    (they are this package's `dependencies`, held equal to the root's by
//                    build.test.mts)
//   dist/assets/     the files the CLI reads at run time, under the paths the tree keeps
//                    them at: the examples `init` derives from, project.json, and what the
//                    repository tracks under deploy/ minus its tests and the agent-env
//                    tooling — the Worker templates, sources, manifests and Dockerfiles
//   LICENSE          a copy of the repository's, so the tarball carries the license text
// src/packageRoot.ts finds dist/assets/ beside the bundle by its project.json.
//
//   npm run build -w packages/switchboard

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { INERT_RULES } from "../../src/deploy/affected.js";

const PACKAGE_DIR = import.meta.dirname;
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const DIST = join(PACKAGE_DIR, "dist");
export const ASSETS_DIR = join(DIST, "assets");

/** Shipped from the repository root: what `init` derives from, the marker, the bot image's own files. */
export const ROOT_ASSETS = [
  ".env.example",
  "config/config.example.yaml",
  "project.json",
  "Dockerfile",
  "docker-entrypoint.sh",
  ".dockerignore",
] as const;

/** Internal tooling for this project's own downstream services — never part of the product. */
const AGENT_ENV = /^deploy\/agent-env/;
const TEST_FILE = INERT_RULES.filter((r) => r.rule === "tests").map((r) => r.test);

/**
 * Pure: which of the paths git tracks under deploy/ ship as assets — every one
 * except tests and the agent-env tooling. Tracked paths only, so an operator's
 * `deploy/profile.json` and the rendered `wrangler.jsonc` files (both
 * gitignored) can never end up in a tarball.
 */
export function shippedDeployAssets(trackedDeployPaths: readonly string[]): string[] {
  return trackedDeployPaths
    .filter((p) => p.startsWith("deploy/"))
    .filter((p) => !AGENT_ENV.test(p) && !TEST_FILE.some((t) => t.test(p)))
    .sort();
}

/** Every path the build copies under dist/assets/, repository-relative. */
export function shippedAssets(trackedDeployPaths: readonly string[]): string[] {
  return [...ROOT_ASSETS, ...shippedDeployAssets(trackedDeployPaths)];
}

function trackedDeployPaths(): string[] {
  return execFileSync("git", ["ls-files", "-z", "deploy"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

async function main(): Promise<void> {
  const nodeMajor = readFileSync(join(REPO_ROOT, ".nvmrc"), "utf8").trim();
  rmSync(DIST, { recursive: true, force: true });
  await build({
    entryPoints: [join(REPO_ROOT, "src/cli.ts")],
    outfile: join(DIST, "cli.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: `node${nodeMajor}`,
    packages: "external",
    logLevel: "warning",
  });
  const assets = shippedAssets(trackedDeployPaths());
  for (const rel of assets) {
    const to = join(ASSETS_DIR, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), to);
  }
  copyFileSync(join(REPO_ROOT, "LICENSE"), join(PACKAGE_DIR, "LICENSE"));
  console.log(`built dist/cli.js (node ${nodeMajor}) and ${assets.length} asset(s) under dist/assets/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
