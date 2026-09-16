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
//
// And every edge the lockfile declares must be satisfied by the record npm
// resolves for it, and every fetched record must be pinned. npm resolves a
// dependant's edge nested-before-hoisted — `<dependant>/node_modules/<name>`,
// then its parent's, up to the root's `node_modules/<name>` — and an edge whose
// resolved record does not satisfy the declared range is one npm treats as
// invalid: it re-resolves the range against the registry on EVERY install,
// which holds only until the registry has a newer version inside the range;
// then a cold `npm ci` refuses the lock ("does not satisfy") on every branch at
// once. That is how the first such break happened: `web/node_modules/@types/node`
// at 26.5.0 against `web`'s `^24.0.0`, carried since the scaffold, invisible to
// `npm ls --omit=dev` because it was a workspace's devDependency. A fetched
// record without `resolved` is the other half of the same defect — npm
// fetches it by version alone, nothing says which tarball — so it fails here
// too (`integrity` is not demanded: npm itself omits it for a git checkout and
// for a nested duplicate of a package it already fetched). Fix: delete the
// named nested record(s) from package-lock.json and run
// `npm install --package-lock-only`; npm re-adds what is needed, pinned.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import semver from "semver";

/** Native packages → the platform variants that must be recorded whenever
 *  any variant of that package is in the lockfile. Linux x64 is what CI and
 *  the Docker image run; macOS arm64 is the laptops. */
export const REQUIRED_VARIANTS = {
  "@rollup/rollup-": ["linux-x64-gnu", "darwin-arm64"],
  "@tailwindcss/oxide-": ["linux-x64-gnu", "darwin-arm64"],
  "lightningcss-": ["linux-x64-gnu", "darwin-arm64"],
  "@esbuild/": ["linux-x64", "darwin-arm64"],
  // @opencode/cli (the second harness's binary, a devDependency the conformance
  // suite runs against the real binary with): CI runs linux-x64, the laptops
  // darwin-arm64, so both platform packages must be recorded.
  "@opencode/cli-": ["linux-x64", "darwin-arm64"],
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

/** The record path a dependant's edge resolves to, the way npm looks a package
 *  up: `<from>/node_modules/<name>`, then the parent's `node_modules`, up to
 *  the root's. A workspace link (`{ link: true, resolved: "<dir>" }`) resolves
 *  to the workspace's own record. `undefined` when nothing in the lock answers. */
export function resolveDependency(packages, from, name) {
  let dir = from;
  for (;;) {
    const candidate = dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    const record = packages[candidate];
    if (record) {
      if (record.link && typeof record.resolved === "string" && packages[record.resolved])
        return { path: record.resolved, record: packages[record.resolved] };
      return { path: candidate, record };
    }
    if (dir === "") return undefined;
    const cut = dir.lastIndexOf("/node_modules/");
    dir = cut >= 0 ? dir.slice(0, cut) : "";
  }
}

/** The range an edge's spec asks for, or `undefined` for a spec semver cannot
 *  judge (a git URL, a file path, a tag): `npm:<name>@<range>` aliases carry
 *  their range after the `@`. */
function rangeOf(spec) {
  const alias = /^npm:(?:@[^/@]+\/)?[^@/]+@(.+)$/.exec(spec);
  const range = alias ? alias[1] : spec;
  return semver.validRange(range, { includePrerelease: true }) ?? undefined;
}

/** Pure: the lock's edges npm cannot honour and the records it cannot pin —
 *  `{ kind: "unsatisfied", from, field, name, spec, at, version }` when the
 *  resolved record misses the declared range, `{ kind: "missing", … }` when a
 *  required dependency resolves to nothing (optional and peer edges may be
 *  absent; a bundled one travels inside its dependant's tarball), and
 *  `{ kind: "unpinned", at, version }` for a fetched record without `resolved`
 *  (the root, a workspace, a link and a bundled copy are not fetched). In lock
 *  order, a record's edges before its own pin. */
export function resolutionProblems(lock) {
  const packages = lock.packages ?? {};
  const problems = [];
  for (const [from, record] of Object.entries(packages)) {
    if (record.link) continue;
    const top = !from.includes("node_modules/");
    const bundled = bundledNames(record);
    const fields = ["dependencies", "optionalDependencies", "peerDependencies"];
    if (top) fields.push("devDependencies");
    for (const field of fields) {
      for (const [name, spec] of Object.entries(record[field] ?? {})) {
        if (bundled.has(name)) continue;
        const hit = resolveDependency(packages, from, name);
        if (!hit) {
          const optional = field === "optionalDependencies" || record.optionalDependencies?.[name] !== undefined;
          if (!optional && field !== "peerDependencies") problems.push({ kind: "missing", from, field, name, spec });
          continue;
        }
        const range = rangeOf(spec);
        if (range === undefined) continue;
        const version = hit.record.version;
        if (typeof version !== "string" || !semver.satisfies(version, range, { includePrerelease: true }))
          problems.push({ kind: "unsatisfied", from, field, name, spec, at: hit.path, version });
      }
    }
    if (!top && !record.inBundle && !pinned(record))
      problems.push({ kind: "unpinned", at: from, version: record.version });
  }
  return problems;
}

/** The dependency names a record bundles inside its own tarball: the listed
 *  ones, or every dependency when the manifest shorthand `true` was mirrored. */
function bundledNames(record) {
  const declared = record.bundleDependencies ?? record.bundledDependencies;
  if (declared === true) return new Set(Object.keys(record.dependencies ?? {}));
  return new Set(Array.isArray(declared) ? declared : []);
}

/** A fetched record is pinned when it says where it came from: `resolved`, the
 *  exact tarball URL or git commit npm will fetch. `integrity` is npm's to
 *  write beside it and is not demanded here — npm itself omits it for a git
 *  checkout and, reproducibly, for a nested duplicate of a package it already
 *  fetched — so a record with a URL and no integrity is npm's own shape, while
 *  a record with neither is one npm fetches by version alone. */
function pinned(record) {
  return typeof record.resolved === "string";
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
  const problems = resolutionProblems(lock);
  if (problems.length > 0) {
    console.error(
      `check:lockfile FAILED — ${problems.length} lockfile edge(s) npm cannot honour or record(s) it cannot pin:`,
    );
    for (const p of problems) {
      if (p.kind === "unsatisfied")
        console.error(
          `  ${p.from || "(root)"} ${p.field} ${p.name}@${p.spec} resolves to ${p.at}, which is ${p.version}`,
        );
      else if (p.kind === "missing")
        console.error(`  ${p.from || "(root)"} ${p.field} ${p.name}@${p.spec} resolves to nothing`);
      else
        console.error(`  ${p.at} (${p.version ?? "no version"}) has no resolved URL — npm fetches it by version alone`);
    }
    console.error(
      "npm treats such an edge as invalid and re-resolves the range against the registry on every install; the next publish inside the range breaks `npm ci` on every branch.",
    );
    console.error("Delete the named nested record(s) from package-lock.json, then: npm install --package-lock-only");
    process.exit(1);
  }
  console.log(
    "check:lockfile ok — every native package records its Linux x64 and macOS arm64 variants, every record mirrors its manifest, every edge resolves inside its range and every fetched record is pinned",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
