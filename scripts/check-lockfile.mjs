#!/usr/bin/env node
// The lockfile must carry every platform's copy of the native packages the
// build uses. npm records only the current machine's optional platform
// package when `npm install` runs with a node_modules already present, so a
// lockfile refreshed on a macOS laptop can silently lose the Linux variants —
// and CI, the Docker image, and every Linux contributor then fail at
// `rollup` or `lightningcss` with MODULE_NOT_FOUND after a clean `npm ci`.
//
// This check reads package-lock.json and, for each native package that is in
// the tree at all, requires the variants CI and the image run on. Fix a
// failure by refreshing the lockfile with node_modules absent — delete only
// node_modules, keep the lockfile, and run `npm install`: npm then keeps every
// existing entry and adds what the manifests changed. Regenerating from
// nothing (deleting the lockfile too) is the last resort: npm's workspace
// resolver has dropped a nested package's dependency that way.
//   rm -rf node_modules && npm install
//
// The lockfile must also mirror the manifests. npm copies each package.json's
// name, version, bin, workspaces and dependency maps into that package's
// lockfile record (`packages[""]` for the root, `packages["<dir>"]` for a
// workspace); a manifest edited without `npm install` leaves the record behind,
// and npm then stops trusting the lock and re-resolves the ranges — which
// holds until any dependency publishes a newer version inside its range, when
// `npm ci` fails on every branch at once with "package.json and
// package-lock.json are not in sync". This check compares each record with
// its manifest so the drift fails here, deterministically, before a publish
// picks the moment. Fix: `npm install --package-lock-only`, which rewrites the
// records without reading node_modules (so the platform trap above cannot
// fire).

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Native packages → the platform variants that must be recorded whenever
 *  any variant of that package is in the lockfile. Linux x64 is what CI and
 *  the Docker image run; macOS arm64 is the laptops. */
export const REQUIRED_VARIANTS = {
  "@rollup/rollup-": ["linux-x64-gnu", "darwin-arm64"],
  "@tailwindcss/oxide-": ["linux-x64-gnu", "darwin-arm64"],
  "lightningcss-": ["linux-x64-gnu", "darwin-arm64"],
  "@esbuild/": ["linux-x64", "darwin-arm64"],
};

/** Pure: the missing `{ family, variant }` pairs for a lockfile's package list. */
export function missingVariants(packagePaths, required = REQUIRED_VARIANTS) {
  const names = new Set(packagePaths.map((p) => p.replace(/^.*node_modules\//, "")));
  const missing = [];
  for (const [prefix, variants] of Object.entries(required)) {
    const present = [...names].some((n) => n.startsWith(prefix));
    if (!present) continue;
    for (const v of variants) {
      if (!names.has(`${prefix}${v}`)) missing.push({ family: prefix, variant: `${prefix}${v}` });
    }
  }
  return missing;
}

/** The manifest fields npm mirrors into a package's lockfile record. `license`
 *  and `engines` are copied too but a drift there changes no resolution, so
 *  they are not compared. */
export const MIRRORED_FIELDS = [
  "name",
  "version",
  "bin",
  "workspaces",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/** A manifest field as npm records it: `bin` as a string becomes `{ [name]: path }`,
 *  `workspaces` as `{ packages }` becomes the array, and an empty map is
 *  recorded as absent. */
function mirrored(manifest, field) {
  const value = manifest?.[field];
  if (field === "bin" && typeof value === "string") return { [manifest.name]: value };
  if (field === "workspaces" && value && !Array.isArray(value)) return value.packages;
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return undefined;
  return value;
}

function canonical(value) {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === "object") {
    return JSON.stringify(
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, value[k]]),
      ),
    );
  }
  return JSON.stringify(value);
}

/** Pure: the mirrored fields whose value in the lockfile record differs from
 *  the manifest's — `{ field, manifest, lockfile }` per drift, in field order.
 *  A missing record drifts in every field the manifest sets. */
export function manifestDrift(manifest, record, fields = MIRRORED_FIELDS) {
  const drift = [];
  for (const field of fields) {
    const wanted = mirrored(manifest, field);
    const recorded = mirrored(record ?? {}, field);
    if (canonical(wanted) !== canonical(recorded)) drift.push({ field, manifest: wanted, lockfile: recorded });
  }
  return drift;
}

/** Pure given its reader: the root manifest and each workspace manifest paired
 *  with the lockfile record npm keeps for it (`""` for the root, the workspace
 *  directory otherwise); a workspace with no record pairs with `undefined`. */
export function recordsToMirror(rootManifest, lock, readManifest) {
  const packages = lock.packages ?? {};
  const pairs = [{ path: "package.json", manifest: rootManifest, record: packages[""] }];
  for (const dir of mirrored(rootManifest, "workspaces") ?? []) {
    pairs.push({ path: `${dir}/package.json`, manifest: readManifest(dir), record: packages[dir] });
  }
  return pairs;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`check:lockfile — cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

function main() {
  const lock = readJson("package-lock.json");
  const missing = missingVariants(Object.keys(lock.packages ?? {}));
  if (missing.length > 0) {
    console.error(`check:lockfile FAILED — ${missing.length} platform variant(s) missing from package-lock.json:`);
    for (const m of missing) console.error(`  ${m.variant}`);
    console.error("The lockfile was refreshed with node_modules present, so npm kept only this machine's platform.");
    console.error("Refresh it with node_modules absent (keep the lockfile): rm -rf node_modules && npm install");
    process.exit(1);
  }
  const drifted = recordsToMirror(readJson("package.json"), lock, (dir) => readJson(`${dir}/package.json`))
    .map((pair) => ({ ...pair, drift: manifestDrift(pair.manifest, pair.record) }))
    .filter((pair) => pair.drift.length > 0);
  if (drifted.length > 0) {
    console.error(`check:lockfile FAILED — ${drifted.length} lockfile record(s) no longer mirror their manifest:`);
    for (const { path, drift } of drifted) {
      for (const d of drift) {
        console.error(`  ${path} ${d.field}: manifest ${canonical(d.manifest)}, lockfile ${canonical(d.lockfile)}`);
      }
    }
    console.error(
      "A manifest changed without the lockfile; npm would re-resolve the ranges instead of trusting the lock.",
    );
    console.error("Refresh the records without touching node_modules: npm install --package-lock-only");
    process.exit(1);
  }
  console.log(
    "check:lockfile ok — every native package records its Linux x64 and macOS arm64 variants, and every record mirrors its manifest",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
