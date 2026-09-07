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

import { readFileSync } from "node:fs";

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

function main() {
  const observed = PAIRS.map(({ label, dockerfile, manifest }) => ({
    label,
    imageTag: imageTag(readFileSync(dockerfile, "utf8")),
    sdkPin: sdkPin(JSON.parse(readFileSync(manifest, "utf8"))),
  }));
  const problems = pairMismatches(observed);
  if (problems.length === 0) {
    console.log(
      `check:sandbox-pair ok — ${observed.map((o) => `${o.label} ${o.imageTag}`).join(", ")}: image tag and ${SDK} pin agree`,
    );
    return;
  }
  console.error(`check:sandbox-pair FAILED — ${problems.length} Worker(s) whose image and SDK disagree:`);
  for (const p of problems) console.error(`  ${p.label}: ${p.reason}`);
  console.error("The image and the SDK are one protocol; bump both together, then deploy and validate (#498).");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
