#!/usr/bin/env node
// A Worker built on the cloudflare/sandbox container image talks to that
// container through the @cloudflare/sandbox SDK: one protocol in two
// artifacts. The image tag lives in the Worker's Dockerfile and the SDK
// version in its package.json, and nothing else ties them together — a
// dependency bump that moves one side alone (Dependabot did, #503) ships a
// Worker speaking a protocol its container does not, on the live execution
// path, with only a typecheck as the gate.
//
// This check reads both files for every such Worker and requires the
// package.json pin to be exact and equal to the Dockerfile tag. Bump them
// together, then deploy and validate (#498). Dependabot ignores both sides.

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

/** Pure: the problems for a set of `{ label, imageTag, sdkPin }` pairs. */
export function pairMismatches(pairs) {
  const problems = [];
  for (const { label, imageTag: tag, sdkPin: pin } of pairs) {
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
    }
  }
  return problems;
}

/** Pure: the problems for a set of `{ label, sdkPin, installed }` pairs, where
 *  `installed` is the version of the SDK actually present under the Worker's
 *  node_modules (null when nothing is installed — a fresh clone before
 *  `npm ci`, which is not a mismatch). The pin and the lockfile can agree
 *  while the tree on disk is something else: the main checkout carried a
 *  nested 0.12.9 install against a 0.3.7 pin (#553), and wrangler bundles
 *  whatever is installed. */
export function installMismatches(pairs) {
  const problems = [];
  for (const { label, sdkPin: pin, installed } of pairs) {
    if (installed === null || pin === null) continue;
    if (installed !== pin) {
      problems.push({
        label,
        reason: `${SDK} ${installed} is installed under the Worker but package.json pins ${pin} — run \`npm ci\` before deploying`,
      });
    }
  }
  return problems;
}

/** The repository root, anchored to this script's location — never the
 *  process's working directory, so the check reads the same tree from `npm
 *  run`, CI, or a shell in any subdirectory. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The installed `@cloudflare/sandbox` version a Worker would bundle, by
 *  Node's own resolution: its nested node_modules first (npm nests a
 *  workspace's divergent pin there), else the repository root's hoisted copy
 *  (what a Worker whose pin matches the root resolves to), else null. */
export function installedSdkVersion(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  const dir = dirname(manifestPath);
  for (const candidate of [
    join(dir, "node_modules", SDK, "package.json"),
    join(REPO_ROOT, "node_modules", SDK, "package.json"),
  ]) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf8")).version ?? null;
  }
  return null;
}

function main() {
  // Every path is repo-root-relative and resolved against REPO_ROOT, so the
  // check reads the same tree whatever the working directory is.
  const observed = PAIRS.map(({ label, dockerfile, manifest }) => ({
    label,
    imageTag: imageTag(readFileSync(join(REPO_ROOT, dockerfile), "utf8")),
    sdkPin: sdkPin(JSON.parse(readFileSync(join(REPO_ROOT, manifest), "utf8"))),
    installed: installedSdkVersion(join(REPO_ROOT, manifest)),
  }));
  const problems = [...pairMismatches(observed), ...installMismatches(observed)];
  if (problems.length === 0) {
    console.log(
      `check:sandbox-pair ok — ${observed.map((o) => `${o.label} ${o.imageTag}${o.installed ? ` (installed ${o.installed})` : ""}`).join(", ")}: image tag, ${SDK} pin and the installed SDK agree`,
    );
    return;
  }
  console.error(`check:sandbox-pair FAILED — ${problems.length} Worker(s) whose image and SDK disagree:`);
  for (const p of problems) console.error(`  ${p.label}: ${p.reason}`);
  console.error("The image and the SDK are one protocol; bump both together, then deploy and validate (#498).");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
