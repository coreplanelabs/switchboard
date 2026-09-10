#!/usr/bin/env -S npx tsx
// Builds the publishable package (docs/reference/specs/packaging.md):
//   dist/cli.js      the CLI, bundled from ../../src/cli.ts by esbuild — one file, the
//                    repository's own modules inlined, every npm dependency left external
//                    (they are this package's `dependencies`, held equal to the root's by
//                    build.test.mts). The bot's entry (src/index.ts) is in the closure —
//                    `start` runs it — so the bundle is the bot as much as the CLI.
//   dist/assets/     the files the CLI reads at run time, under the paths the tree keeps
//                    them at: the examples `init` derives from, project.json, what the
//                    repository tracks under deploy/ minus its tests and the agent-env
//                    tooling — the Worker templates, sources, manifests and Dockerfiles —
//                    the sources under src/ each Worker's worker.ts imports, and the root
//                    manifest and lockfile, so a deploy from the package can materialise a
//                    Worker directory and `npm ci --workspace` it at the release's pinned
//                    versions (src/deploy/workArea.ts); the dashboard's built bundle
//                    (web/dist, built here first) the bot serves from the package root
//                    (src/channels/webAssets.ts `webDistDir`); plus source.json, the version
//                    and commit this build came from (src/packageRoot.ts `parsePackageSource`)
//   LICENSE          a copy of the repository's, so the tarball carries the license text
// src/packageRoot.ts finds dist/assets/ beside the bundle by its project.json.
//
//   npm run build -w packages/switchboard

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildStamp } from "../../deploy/bin/build-stamp.mjs";
import { WEB_DIST_DIR } from "../../src/channels/webAssets.js";
import { importClosure, INERT_RULES } from "../../src/deploy/affected.js";
import { WORKER_SPECS } from "../../src/deploy/plan.js";
import { PACKAGE_SOURCE_FILE, type PackageSource } from "../../src/packageRoot.js";

const PACKAGE_DIR = import.meta.dirname;
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const DIST = join(PACKAGE_DIR, "dist");
export const ASSETS_DIR = join(DIST, "assets");

/** Shipped from the repository root: what `init` derives from, the marker, the bot image's own files,
 *  and the manifest + lockfile a materialised Worker directory is installed against. */
export const ROOT_ASSETS = [
  ".env.example",
  "config/config.example.yaml",
  "project.json",
  "Dockerfile",
  "docker-entrypoint.sh",
  ".dockerignore",
  "package.json",
  "package-lock.json",
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

/**
 * Pure: every path the build copies under dist/assets/, repository-relative —
 * the root assets, the deploy assets, the source files the Workers' `worker.ts`
 * import (`workerSourceFiles`) and the dashboard's built files (`webDistAssets`),
 * each once, sorted after the root list.
 */
export function shippedAssets(
  trackedDeployPaths: readonly string[],
  workerSources: readonly string[] = [],
  webDist: readonly string[] = [],
): string[] {
  const rest = new Set([...shippedDeployAssets(trackedDeployPaths), ...workerSources, ...webDist]);
  for (const root of ROOT_ASSETS) rest.delete(root);
  return [...ROOT_ASSETS, ...[...rest].sort()];
}

/** The Vite manifest the bot reads first (src/channels/webAssets.ts `loadWebAssets`): without it there is no bundle. */
const WEB_MANIFEST = ".vite/manifest.json";

/**
 * Pure: the dashboard's built files as tree paths (`web/dist/<file>`), from a
 * listing of `web/dist` — every file, since the bot serves the whole directory.
 * A listing without the Vite manifest is not a build: an error naming the
 * command that makes one, never a package whose `start` boots half-blind.
 */
export function webDistAssets(filesUnderDist: readonly string[]): string[] {
  if (!filesUnderDist.includes(WEB_MANIFEST))
    throw new Error(`${WEB_DIST_DIR} has no ${WEB_MANIFEST} — it is not a build (npm run build -w web makes one)`);
  return filesUnderDist.map((f) => `${WEB_DIST_DIR}/${f}`).sort();
}

/** Builds the dashboard (`npm run build -w web`, as the Dockerfile does) and lists what it produced. */
function buildWebDist(): string[] {
  execFileSync("npm", ["run", "build", "--workspace", "web", "--silent"], { cwd: REPO_ROOT, stdio: "inherit" });
  const dist = join(REPO_ROOT, WEB_DIST_DIR);
  const files = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((rel) =>
    statSync(join(dist, rel)).isFile(),
  );
  return webDistAssets(files);
}

function trackedDeployPaths(): string[] {
  return execFileSync("git", ["ls-files", "-z", "deploy"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/**
 * The files under src/ every Worker's bundle is built from: the union of the
 * relative-import closures of the Worker entries (the same crawl `--affected`
 * judges a Worker's inputs by), read from the tree. A specifier that resolves
 * to no file is a broken tree, not something to ship without.
 */
export async function workerSourceFiles(
  read: (path: string) => Promise<string | undefined>,
  entries: readonly string[] = WORKER_SPECS.map((w) => w.entry),
): Promise<string[]> {
  const files = new Set<string>();
  for (const entry of entries) {
    const closure = await importClosure(entry, read);
    if (closure.unresolved.length > 0)
      throw new Error(
        `${entry}: imports that resolve to no file — ${closure.unresolved.map((u) => `${u.specifier} from ${u.from || "(entry)"}`).join(", ")}`,
      );
    for (const f of closure.files) if (f.startsWith("src/")) files.add(f);
  }
  return [...files].sort();
}

/** The stamp of the tree this build came from: the package's version, the commit (`-dirty` when the tree has uncommitted changes), now. */
function packageSource(): PackageSource {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string };
  const git = (args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const stamp = buildStamp({ commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" });
  return { version: pkg.version, ...stamp };
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
  const readTree = async (path: string) => {
    const abs = join(REPO_ROOT, path);
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  };
  const assets = shippedAssets(trackedDeployPaths(), await workerSourceFiles(readTree), buildWebDist());
  for (const rel of assets) {
    const to = join(ASSETS_DIR, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(REPO_ROOT, rel), to);
  }
  const source = packageSource();
  writeFileSync(join(ASSETS_DIR, PACKAGE_SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`);
  copyFileSync(join(REPO_ROOT, "LICENSE"), join(PACKAGE_DIR, "LICENSE"));
  console.log(
    `built dist/cli.js (node ${nodeMajor}) and ${assets.length} asset(s) under dist/assets/ from ${source.commit} (version ${source.version})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
