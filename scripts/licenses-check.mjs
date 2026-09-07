#!/usr/bin/env node
// Production-dependency license gate, shared by every package root.
//
// Each package's `npm run licenses:check` runs this file from its own directory
// (`node ../scripts/licenses-check.mjs` in web/), so the allowed set and the
// per-package exceptions live in exactly one place. A dependency whose license
// is outside the set, or unknown, fails the run and is named with its path.
//
// The dependency list comes from npm itself (`npm ls --omit=dev --all --long
// --json`), which understands the workspace layout: a package's production
// tree is resolved wherever npm hoisted it, so the count is the same whether
// a dependency lives in the package's own node_modules or the root's. Nothing
// but npm is needed.
//
// The allowed set is the permissive family THIRD_PARTY_NOTICES.md documents.
// MPL-2.0 is allowed because its copyleft is file-level and attaches to the
// dependency's own files, which are used unmodified; it never reaches this
// project's code.
//
// Exceptions are packages whose manifests misreport their license. Every entry
// says what the real license is and why the manifest cannot show it, so the
// carve-out stays honest and is easy to remove when upstream fixes it.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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
    "MIT — the repository (github.com/Elliot-Alexander/vaul-vue) carries an MIT LICENSE, but the published package omits the `license` field, so the manifest reports nothing.",
};

/**
 * Decide over a report of `{ "<name>@<version>": { licenses, path } }`.
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
    const ok = licenses.every(
      (l) =>
        allowedSet.has(l) ||
        String(l)
          .replace(/^\(|\)$/g, "")
          .split(" OR ")
          .some((alt) => allowedSet.has(alt.trim())),
    );
    if (!ok) offending.push({ id, licenses: licenses.join(", "), path: info.path ?? "" });
  }
  return offending;
}

/**
 * Flatten `npm ls --json --long` output into the report shape above: one entry
 * per installed package (deduplicated by install path), only packages that live
 * under a node_modules directory (never the project or a workspace itself),
 * never extraneous ones. Pure.
 */
export function reportFromNpmLs(tree) {
  const report = {};
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    const { name, version, path, license, extraneous, dependencies } = node;
    if (name && version && path && !extraneous && /[\\/]node_modules[\\/]/.test(path) && !seen.has(path)) {
      seen.add(path);
      report[`${name}@${version}`] = { licenses: normalizeLicense(license), path };
    }
    if (dependencies) for (const child of Object.values(dependencies)) visit(child);
  };
  visit(tree);
  return report;
}

function normalizeLicense(license) {
  if (license == null || license === "") return "UNKNOWN";
  if (typeof license === "string") return license;
  if (Array.isArray(license)) return license.map((l) => (typeof l === "string" ? l : (l?.type ?? "UNKNOWN")));
  if (typeof license === "object" && typeof license.type === "string") return license.type;
  return "UNKNOWN";
}

/** The repository root: the nearest ancestor whose package.json declares workspaces (or the dir itself). */
function findRoot(dir) {
  let cur = dir;
  for (;;) {
    const manifest = join(cur, "package.json");
    if (existsSync(manifest)) {
      try {
        if (Array.isArray(JSON.parse(readFileSync(manifest, "utf8")).workspaces)) return cur;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return dir;
    cur = parent;
  }
}

function listProduction(dir) {
  const root = findRoot(dir);
  const rel = relative(root, dir);
  const scope = rel === "" ? ["--workspaces=false"] : ["-w", rel];
  const args = ["ls", "--omit=dev", "--all", "--json", "--long", ...scope];
  const result = spawnSync("npm", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (!result.stdout)
    return { error: `\`npm ${args.join(" ")}\` produced no output${result.stderr ? `: ${result.stderr.trim()}` : ""}` };
  try {
    const tree = JSON.parse(result.stdout);
    if (tree.error) return { error: `npm ls: ${tree.error.summary ?? JSON.stringify(tree.error)}` };
    return { tree };
  } catch (err) {
    return { error: `could not parse npm ls output: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function main() {
  const dir = process.cwd();
  const root = findRoot(dir);
  if (!existsSync(join(root, "node_modules"))) {
    console.error(`licenses:check — nothing is installed under ${root}; run npm ci at the repository root first`);
    process.exit(2);
  }
  const { tree, error } = listProduction(dir);
  if (error) {
    console.error(`licenses:check — ${error}`);
    process.exit(2);
  }
  const report = reportFromNpmLs(tree);
  const total = Object.keys(report).length;
  const offending = evaluate(report);
  if (offending.length === 0) {
    console.log(
      `licenses:check ok — ${total} production package(s) for ${dir}, all within the allowed set (${Object.keys(EXCEPTIONS).length} documented exception(s))`,
    );
    return;
  }
  console.error(
    `licenses:check FAILED — ${offending.length} of ${total} production package(s) for ${dir} carry a license outside the allowed set:`,
  );
  for (const o of offending) console.error(`  ${o.id}\t${o.licenses}\t${o.path}`);
  console.error(
    `Allowed: ${ALLOWED_LICENSES.join("; ")}. To accept a misreported license, add a documented entry to EXCEPTIONS in scripts/licenses-check.mjs.`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
