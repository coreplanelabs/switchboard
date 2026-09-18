#!/usr/bin/env node
// Installed-tree-vs-lockfile drift gate.
//
// A long-lived tree (a resident's hardlink view, a workspace that survived a
// lockfile change) can drift from package-lock.json in ways `npm ls` reports
// confusingly late: a nested workspace node_modules the lockfile mandates is
// missing, so the packages hoisted for its dependents read as extraneous and
// their subtrees are misattributed to production — the shape behind a
// licenses:check failure that a clean `npm ci` of the same commit passes.
// This check names the drift itself, before any downstream gate trips on a
// symptom: every non-optional package path in the lockfile must exist on
// disk, and every top-level entry of every node_modules must be a lockfile
// package. The fix is always the same and is printed: `npm ci`.
//
// Pure halves (unit-tested from src/depsDriftCheck.test.ts): deriving the
// expected paths and the node_modules roots from the lockfile's `packages`
// map, and judging a disk listing against it. The CLI only reads the tree.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Minimal per-package facts this check reads from a lockfile `packages` entry. */
/** @typedef {{ optional?: boolean; devOptional?: boolean; link?: boolean }} LockPackage */

/**
 * The package paths a full install of this lockfile must put on disk: every
 * key under a node_modules directory, except optional ones (platform-gated
 * packages are legitimately absent — `@img/sharp-libvips-darwin-arm64` on a
 * Linux tree). Pure.
 * @param {Record<string, LockPackage>} packages
 * @returns {string[]} sorted
 */
export function expectedPackagePaths(packages) {
  return Object.keys(packages)
    .filter((key) => key.includes("node_modules/"))
    .filter((key) => !packages[key].optional && !packages[key].devOptional)
    .sort();
}

/**
 * Every node_modules directory the lockfile can speak for: each prefix of a
 * package key ending in `node_modules`, plus the root's own and one per
 * workspace directory (a key with no node_modules segment) — a stale
 * `<workspace>/node_modules` the lockfile no longer installs into still gets
 * its entries judged. Pure.
 * @param {Record<string, LockPackage>} packages
 * @returns {string[]} sorted
 */
export function nodeModulesRoots(packages) {
  const roots = new Set(["node_modules"]);
  for (const key of Object.keys(packages)) {
    if (key === "") continue;
    if (!key.includes("node_modules")) {
      roots.add(`${key}/node_modules`);
      continue;
    }
    const parts = key.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "node_modules") roots.add(parts.slice(0, i + 1).join("/"));
    }
  }
  return [...roots].sort();
}

/**
 * Judge one node_modules directory's listing against the lockfile: every
 * non-dot entry (dot entries are tool-managed — `.bin`, `.package-lock.json`,
 * `.cache` — and deliberately tree-private on a resident view) must be a
 * package key `<root>/<name>`. Scoped entries arrive already expanded
 * (`@scope/name`). Pure.
 * @param {string} root
 * @param {readonly string[]} entries
 * @param {Record<string, LockPackage>} packages
 * @returns {string[]} the extraneous paths, sorted
 */
export function extraneousEntries(root, entries, packages) {
  return entries
    .filter((name) => !name.startsWith(".") && !name.split("/").some((p) => p.startsWith(".")))
    .map((name) => `${root}/${name}`)
    .filter((path) => !(path in packages))
    .sort();
}

/**
 * The whole judgement over plain data. Pure.
 * @param {Record<string, LockPackage>} packages
 * @param {{ exists: (path: string) => boolean; list: (root: string) => string[] | null }} disk
 *   `list` returns the scope-expanded entries of a node_modules dir, or null when it does not exist.
 * @returns {{ missing: string[]; extraneous: string[]; checked: number }}
 */
export function evaluateDepsDrift(packages, disk) {
  const expected = expectedPackagePaths(packages);
  const missing = expected.filter((path) => !disk.exists(path));
  const extraneous = [];
  for (const root of nodeModulesRoots(packages)) {
    const entries = disk.list(root);
    if (entries) extraneous.push(...extraneousEntries(root, entries, packages));
  }
  return { missing, extraneous: extraneous.sort(), checked: expected.length };
}

/** List a node_modules dir with `@scope` dirs expanded to `@scope/<name>`; null when absent. */
function listNodeModules(dir) {
  if (!existsSync(dir)) return null;
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("@")) {
      const scoped = join(dir, entry);
      try {
        for (const inner of readdirSync(scoped)) out.push(`${entry}/${inner}`);
      } catch {
        out.push(entry);
      }
    } else {
      out.push(entry);
    }
  }
  return out;
}

function main() {
  const root = process.cwd();
  const lockPath = join(root, "package-lock.json");
  if (!existsSync(lockPath)) {
    console.log("check:deps-drift ok — no package-lock.json here, nothing to compare");
    return;
  }
  if (!existsSync(join(root, "node_modules"))) {
    console.error(`check:deps-drift — nothing is installed under ${root}; run npm ci first`);
    process.exit(2);
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const packages = lock.packages ?? {};
  const { missing, extraneous, checked } = evaluateDepsDrift(packages, {
    exists: (path) => existsSync(join(root, path)),
    list: (dir) => listNodeModules(join(root, dir)),
  });
  if (missing.length === 0 && extraneous.length === 0) {
    console.log(`check:deps-drift ok — ${checked} lockfile package path(s) present, no extraneous entries`);
    return;
  }
  console.error(`check:deps-drift FAILED — the installed tree has drifted from package-lock.json:`);
  for (const p of missing) console.error(`  missing\t${p}`);
  for (const p of extraneous) console.error(`  extraneous\t${p}`);
  console.error(
    `${missing.length} missing path(s), ${extraneous.length} extraneous entr(ies). A drifted tree misattributes hoisted packages (npm ls marks them extraneous and their subtrees leak into the production graph). Fix: npm ci at the repository root.`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
