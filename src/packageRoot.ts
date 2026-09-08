import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Where the files the CLI ships with are read from (docs/reference/specs/packaging.md):
// the examples `init` derives from, the Worker templates and manifests the
// deploy commands read, `project.json`. The same code runs from three places
// and the files sit differently in each:
//   a checkout        src/setup/host.ts → <repo>/.env.example        (the repository root)
//   the image         /app/dist/setup/  → /app/.env.example          (the Dockerfile COPYs them beside dist/)
//   the npm package   <pkg>/dist/cli.js → <pkg>/dist/assets/.env.example  (esbuild bundles the CLI into one
//                                                                    file; the build copies the assets beside it)
// One rule covers all three: `assets/` beside the module when it carries the
// marker, else the nearest ancestor that does. `project.json` is the marker
// because every one of those places has exactly one, and it is the file that
// says which project this is.

/** The file that marks the package root. */
export const PACKAGE_ROOT_MARKER = "project.json";

export interface PackageRoot {
  root: string;
  /** `assets`: the published package's `dist/assets/`; `tree`: a checkout or the image's /app. */
  kind: "assets" | "tree";
}

/**
 * Pure over `exists`: from a module's directory, the package root and which
 * kind it is. Throws, naming the marker and the start, when nothing up to the
 * filesystem root carries it — a module copied somewhere it cannot work from.
 */
export function locatePackageRoot(from: string, exists: (path: string) => boolean = existsSync): PackageRoot {
  const assets = join(from, "assets");
  if (exists(join(assets, PACKAGE_ROOT_MARKER))) return { root: assets, kind: "assets" };
  for (let dir = from; ; dir = dirname(dir)) {
    if (exists(join(dir, PACKAGE_ROOT_MARKER))) return { root: dir, kind: "tree" };
    if (dirname(dir) === dir) break;
  }
  throw new Error(`${PACKAGE_ROOT_MARKER} not found in assets/ beside or in any directory above ${from}`);
}

const located = locatePackageRoot(import.meta.dirname);

/** The root every shipped file is read under: the repository root in a checkout, `/app` in the image, `dist/assets` in the package. */
export const PACKAGE_ROOT = located.root;

/** True when this process runs from the published npm package rather than a checkout or the image. */
export const RUNS_FROM_PUBLISHED_PACKAGE = located.kind === "assets";

/** The identity of the tree the published package was built from, beside the marker in `dist/assets/`
 *  (packages/switchboard/build.mts writes it): the package's version and the commit, so a deploy
 *  from the package knows which commit it deploys without a checkout. Absent in a checkout and the image. */
export const PACKAGE_SOURCE_FILE = "source.json";

export interface PackageSource {
  version: string;
  /** The commit, `-dirty` suffixed when the package was built from a tree with uncommitted changes. */
  commit: string;
  builtAt: string;
}

/** Pure: the stamp's text, or the problem with it — never a guess at a version or a commit. */
export function parsePackageSource(
  text: string | undefined,
): { ok: true; source: PackageSource } | { ok: false; problem: string } {
  if (text === undefined) return { ok: false, problem: `${PACKAGE_SOURCE_FILE}: no such file in the package's assets` };
  let raw: { version?: unknown; commit?: unknown; builtAt?: unknown } | null;
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    return { ok: false, problem: `${PACKAGE_SOURCE_FILE}: not JSON` };
  }
  const field = (key: "version" | "commit" | "builtAt"): string | undefined => {
    const value = raw?.[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const [version, commit, builtAt] = [field("version"), field("commit"), field("builtAt")];
  if (version === undefined) return { ok: false, problem: `${PACKAGE_SOURCE_FILE}: \`version\` is missing` };
  if (commit === undefined) return { ok: false, problem: `${PACKAGE_SOURCE_FILE}: \`commit\` is missing` };
  if (builtAt === undefined) return { ok: false, problem: `${PACKAGE_SOURCE_FILE}: \`builtAt\` is missing` };
  return { ok: true, source: { version, commit, builtAt } };
}

/**
 * Pure over `read`: the version this code runs as where there is no `source.json`
 * — a checkout or the image — the `version` of the nearest `package.json` at or
 * above the package root (the root's own there; the published package's manifest
 * two levels above `dist/assets/`, though from the package `source.json` is the
 * identity that counts: src/deploy/host.ts `cliVersionOnHost`). It is the version
 * `deploy images` copies and `registry` mode references: the images a release
 * published carry the same number as the CLI that release published. Throws,
 * naming the start, when no manifest above carries a version.
 */
export function locatePackageVersion(
  root: string,
  read: (path: string) => string | undefined = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
): string {
  for (let dir = root; ; dir = dirname(dir)) {
    const text = read(join(dir, "package.json"));
    if (text !== undefined) {
      let version: unknown;
      try {
        version = (JSON.parse(text) as { version?: unknown }).version;
      } catch {
        version = undefined;
      }
      if (typeof version === "string" && version !== "") return version;
    }
    if (dirname(dir) === dir) break;
  }
  throw new Error(`no package.json with a version at or above ${root}`);
}

let version: string | undefined;
/** The version this process runs as (`locatePackageVersion` over the package root), read once. */
export function packageVersion(): string {
  version ??= locatePackageVersion(PACKAGE_ROOT);
  return version;
}
