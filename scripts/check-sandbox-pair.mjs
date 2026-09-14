#!/usr/bin/env node
// A Worker built on the cloudflare/sandbox container image talks to that
// container through the @cloudflare/sandbox SDK: one protocol in two
// artifacts. The image tag lives in the Worker's Dockerfile and the SDK
// version in its package.json, and nothing else ties them together — a
// dependency bump that moves one side alone (a Dependabot group bump can) ships a
// Worker speaking a protocol its container does not, on the live execution
// path, with only a typecheck as the gate.
//
// This check reads committed files only on its failure path: the Dockerfile
// tag, the package.json pin, and the lockfile's resolution of that pin must
// all agree, per Worker. The installed node_modules tree is NOT part of the
// gate — a stale install is a local-state problem `npm ci` fixes, so when an
// installed copy disagrees with the lockfile the check prints a one-line
// advisory and still passes. Bump image and SDK together, then deploy and
// validate. Dependabot ignores both sides.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The Workers whose image and SDK must agree. */
export const PAIRS = [
  {
    label: "deploy/cloudflare-sandbox",
    dockerfile: "deploy/cloudflare-sandbox/Dockerfile",
    manifest: "deploy/cloudflare-sandbox/package.json",
  },
  {
    label: "deploy/cloudflare-resident",
    dockerfile: "deploy/cloudflare-resident/Dockerfile",
    manifest: "deploy/cloudflare-resident/package.json",
  },
];

const SDK = "@cloudflare/sandbox";

/** Pure: the `cloudflare/sandbox` image tag a Dockerfile builds FROM, or null. */
export function imageTag(dockerfileText) {
  const m = /^FROM\s+(?:docker\.io\/)?cloudflare\/sandbox:(\S+)/m.exec(dockerfileText);
  return m ? m[1] : null;
}

/** Pure: the `@cloudflare/sandbox` pin a package.json declares, or null. */
export function sdkPin(manifest) {
  return manifest.dependencies?.[SDK] ?? manifest.devDependencies?.[SDK] ?? null;
}

/** Pure: the version the lockfile resolves `@cloudflare/sandbox` to for a
 *  workspace, by npm's own layout: the workspace's nested entry first (npm
 *  nests a divergent pin), else the root's hoisted entry, else null. Reads the
 *  parsed lockfile object, never the disk. */
export function lockfileSdkVersion(lockfile, workspacePath) {
  const packages = lockfile.packages ?? {};
  for (const key of [`${workspacePath}/node_modules/${SDK}`, `node_modules/${SDK}`]) {
    const version = packages[key]?.version;
    if (version) return version;
  }
  return null;
}

/** Pure: the problems for a set of `{ label, imageTag, sdkPin, locked }`
 *  pairs — the committed truth. `locked` is the lockfile's resolution of the
 *  pin (null when the lockfile has no entry, which is a mismatch: the pin was
 *  bumped without `npm install` updating the lockfile). */
export function pairMismatches(pairs) {
  const problems = [];
  for (const { label, imageTag: tag, sdkPin: pin, locked } of pairs) {
    if (tag === null) {
      problems.push({ label, reason: "Dockerfile has no `FROM cloudflare/sandbox:<tag>` line" });
      continue;
    }
    if (pin === null) {
      problems.push({ label, reason: `package.json does not depend on ${SDK}` });
      continue;
    }
    if (!/^\d/.test(pin)) {
      problems.push({ label, reason: `${SDK} pin "${pin}" is a range; pin the exact image version "${tag}"` });
      continue;
    }
    if (pin !== tag) {
      problems.push({ label, reason: `${SDK} is "${pin}" but the Dockerfile builds FROM cloudflare/sandbox:${tag}` });
      continue;
    }
    if (locked === undefined) continue; // caller supplied no lockfile view (unit fixtures)
    if (locked === null) {
      problems.push({
        label,
        reason: `package-lock.json has no entry for ${SDK}; run \`npm install\` and commit the lockfile`,
      });
      continue;
    }
    if (locked !== pin) {
      problems.push({
        label,
        reason: `package.json pins ${SDK} ${pin} but package-lock.json resolves it to ${locked}; run \`npm install\` and commit the lockfile`,
      });
    }
  }
  return problems;
}

/** Pure: advisories (never failures) for a set of `{ label, locked,
 *  installed }` pairs, where `installed` is the SDK version actually present
 *  under the Worker's node_modules (null when nothing is installed — a fresh
 *  clone before `npm ci`, nothing to say). An installed copy that disagrees
 *  with the lockfile is local-state drift, not a committed mismatch: name it
 *  in one line and point at `npm ci`. */
export function installAdvisories(pairs) {
  const advisories = [];
  for (const { label, locked, installed } of pairs) {
    if (installed === null || locked == null) continue;
    if (installed !== locked) {
      advisories.push(
        `${label}: installed ${SDK} ${installed} differs from the lockfile's ${locked} — local drift, run \`npm ci\``,
      );
    }
  }
  return advisories;
}

/** The repository root, anchored to this script's location — never the
 *  process's working directory, so the check reads the same tree from `npm
 *  run`, CI, or a shell in any subdirectory. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The installed `@cloudflare/sandbox` version a Worker would bundle, by
 *  Node's own resolution: its nested node_modules first (npm nests a
 *  workspace's divergent pin there), else the repository root's hoisted copy
 *  (what a Worker whose pin matches the root resolves to), else null. Feeds
 *  the advisory only — never the failure path. */
export function installedSdkVersion(manifestPath, repoRoot = REPO_ROOT) {
  if (!existsSync(manifestPath)) return null;
  const dir = dirname(manifestPath);
  for (const candidate of [
    join(dir, "node_modules", SDK, "package.json"),
    join(repoRoot, "node_modules", SDK, "package.json"),
  ]) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8")).version ?? null;
  }
  return null;
}

function main() {
  // Every path is repo-root-relative and resolved against REPO_ROOT, so the
  // check reads the same tree whatever the working directory is.
  const lockfile = JSON.parse(readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"));
  const observed = PAIRS.map(({ label, dockerfile, manifest }) => ({
    label,
    imageTag: imageTag(readFileSync(join(REPO_ROOT, dockerfile), "utf8")),
    sdkPin: sdkPin(JSON.parse(readFileSync(join(REPO_ROOT, manifest), "utf8"))),
    locked: lockfileSdkVersion(lockfile, label),
    installed: installedSdkVersion(join(REPO_ROOT, manifest)),
  }));
  for (const advisory of installAdvisories(observed)) console.warn(`check:sandbox-pair advisory — ${advisory}`);
  const problems = pairMismatches(observed);
  if (problems.length === 0) {
    console.log(
      `check:sandbox-pair ok — ${observed.map((o) => `${o.label} ${o.imageTag}`).join(", ")}: image tag, ${SDK} pin and the lockfile agree`,
    );
    return;
  }
  console.error(`check:sandbox-pair FAILED — ${problems.length} Worker(s) whose image and SDK disagree:`);
  for (const p of problems) console.error(`  ${p.label}: ${p.reason}`);
  console.error("The image and the SDK are one protocol; bump both together, then deploy and validate.");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
