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

import { readFileSync } from "node:fs";

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

function main() {
  let lock;
  try {
    lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  } catch (err) {
    console.error(`check:lockfile — cannot read package-lock.json: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const missing = missingVariants(Object.keys(lock.packages ?? {}));
  if (missing.length === 0) {
    console.log("check:lockfile ok — every native package records its Linux x64 and macOS arm64 variants");
    return;
  }
  console.error(`check:lockfile FAILED — ${missing.length} platform variant(s) missing from package-lock.json:`);
  for (const m of missing) console.error(`  ${m.variant}`);
  console.error("The lockfile was refreshed with node_modules present, so npm kept only this machine's platform.");
  console.error("Refresh it with node_modules absent (keep the lockfile): rm -rf node_modules && npm install");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
