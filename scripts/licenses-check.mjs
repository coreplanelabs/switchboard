#!/usr/bin/env node
// Production-dependency license gate, shared by every package root.
//
// Each package's `npm run licenses:check` runs this file from its own directory
// (`node ../scripts/licenses-check.mjs` in web/), so the allowed set and the
// per-package exceptions live in exactly one place. A dependency whose license
// is outside the set, or unknown, fails the run and is named with its path.
//
// The allowed set is the permissive family THIRD_PARTY_NOTICES.md documents.
// MPL-2.0 is allowed because its copyleft is file-level and attaches to the
// dependency's own files, which are used unmodified; it never reaches this
// project's code.
//
// Exceptions are packages the checker misreads. Every entry says what the real
// license is and why the checker cannot see it, so the carve-out stays honest
// and is easy to remove when upstream fixes its manifest.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const ALLOWED_LICENSES = [
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "MPL-2.0",
  "Python-2.0",
  "CC-BY-4.0",
  "(Apache-2.0 AND BSD-3-Clause)",
];

/** Package name → why its reported license is not the real one. */
export const EXCEPTIONS = {
  "vaul-vue":
    "MIT — the repository (github.com/Elliot-Alexander/vaul-vue) carries an MIT LICENSE, but the published package omits the `license` field, so the checker reports UNKNOWN.",
};

/**
 * Decide over a license-checker JSON report (`{ "<name>@<version>": { licenses, path, ... } }`).
 * Pure: no I/O. Returns the offending entries; an empty list means the gate passes.
 */
export function evaluate(report, { allowed = ALLOWED_LICENSES, exceptions = EXCEPTIONS } = {}) {
  const allowedSet = new Set(allowed);
  const offending = [];
  for (const [id, info] of Object.entries(report)) {
    const name = id.startsWith("@") ? `@${id.slice(1).split("@")[0]}` : id.split("@")[0];
    if (name in exceptions) continue;
    const licenses = Array.isArray(info.licenses) ? info.licenses : [info.licenses ?? "UNKNOWN"];
    // A package may declare `(A OR B)`; accept it when any alternative is allowed.
    const ok = licenses.every((l) => allowedSet.has(l) || String(l).replace(/^\(|\)$/g, "").split(" OR ").some((alt) => allowedSet.has(alt.trim())));
    if (!ok) offending.push({ id, licenses: licenses.join(", "), path: info.path ?? "" });
  }
  return offending;
}

function runChecker(dir) {
  const bin = join(dir, "node_modules", ".bin", "license-checker-rseidelsohn");
  if (!existsSync(bin)) {
    return { error: `license-checker-rseidelsohn is not installed in ${dir} — run npm ci there first` };
  }
  const result = spawnSync(bin, ["--production", "--excludePrivatePackages", "--json", "--start", dir], { encoding: "utf8" });
  if (result.status !== 0) return { error: result.stderr || `license checker exited ${result.status}` };
  try {
    return { report: JSON.parse(result.stdout) };
  } catch (err) {
    return { error: `could not parse the license checker's output: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function main() {
  const dir = process.cwd();
  const { report, error } = runChecker(dir);
  if (error) {
    console.error(`licenses:check — ${error}`);
    process.exit(2);
  }
  const offending = evaluate(report);
  const total = Object.keys(report).length;
  if (offending.length === 0) {
    console.log(`licenses:check ok — ${total} production package(s) in ${dir}, all within the allowed set (${Object.keys(EXCEPTIONS).length} documented exception(s))`);
    return;
  }
  console.error(`licenses:check FAILED — ${offending.length} of ${total} production package(s) in ${dir} carry a license outside the allowed set:`);
  for (const o of offending) console.error(`  ${o.id}\t${o.licenses}\t${o.path}`);
  console.error(`Allowed: ${ALLOWED_LICENSES.join("; ")}. To accept a misreported license, add a documented entry to EXCEPTIONS in scripts/licenses-check.mjs.`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
