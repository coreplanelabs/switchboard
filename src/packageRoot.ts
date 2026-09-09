import { existsSync } from "node:fs";
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
