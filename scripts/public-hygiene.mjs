#!/usr/bin/env node
// The public-hygiene ratchet (docs/reference/specs/public-hygiene.md). The public tree
// carries no imprint of the company that grew it: no company, sibling-product
// or person names beyond the integrations the code talks to, no private
// tracker references, no plan ids, no platform ids, no dated incident
// narratives. Every remaining hit is counted per file and class in
// scripts/public-hygiene.allowlist.json, and that list can only shrink: a file
// that gained a hit fails, a file that lost one asks to be re-recorded, and a
// line that is legitimately allowed ("nominal" as English) is named verbatim
// in scripts/public-hygiene.allow so the reason travels with it.
//
//   npm run hygiene:check                 # the tree equals the list, no stale allow entries
//   npm run hygiene:gen                   # record the tree after a scrub (refuses growth; -- --force to insist)
//   npm run hygiene:check -- --list src/  # every remaining hit under a prefix, for a scrub
//
// Plain JS with a .d.mts twin, like the other checks under scripts/: the test
// imports it; nothing under src/ does (the image copies src/ without scripts/).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ALLOWLIST_PATH = "scripts/public-hygiene.allowlist.json";
export const ALLOW_LINES_PATH = "scripts/public-hygiene.allow";

/** What must not appear, by class. Each regex is tested per line. */
export const CLASSES = {
  names:
    /coreplane|\bnominal\b|polylane|terrateam|\bjustin\b|claude tag|switchboard-prompting|op:\/\/|1password|littlebird/i,
  trackers: /(?<![\w&`/#])#\d{2,4}\b(?![\w-])|github\.com\/(?:orgs\/)?coreplanelabs\b/i,
  planIds: /\bKTD\d+\b|\bKD\d+\b|\bOQ\d+\b|\bU[1-9]\b|\bR(?!2\b)\d{1,2}\b/,
  ids: /\b[CUD]0[A-Z0-9]{8,10}\b|(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/,
  dates: /\b20\d\d-\d\d-\d\d\b/,
};

const SCOPE_PREFIXES = ["src/", "deploy/", "web/", "scripts/", "config/", "docs/", ".github/"];
const EXCLUDED_PREFIXES = ["docs/plans/"];
const EXCLUDED_FILES = new Set([
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  ALLOWLIST_PATH,
  ALLOW_LINES_PATH,
  "scripts/public-hygiene.mjs",
  "scripts/public-hygiene.d.mts",
  "src/publicHygiene.test.ts",
]);
const BINARY = /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|mp4|webm)$/i;

/** Whether a repo-relative tracked path is part of the public tree the policy covers. */
export function inScope(path) {
  if (EXCLUDED_FILES.has(path)) return false;
  if (path.endsWith("package-lock.json") || BINARY.test(path)) return false;
  if (EXCLUDED_PREFIXES.some((p) => path.startsWith(p))) return false;
  if (SCOPE_PREFIXES.some((p) => path.startsWith(p))) return true;
  return !path.includes("/") && (path.endsWith(".md") || path === "package.json");
}

/** The classes counted for a path: decision records (and their generated index) carry a date and may cite PRs for provenance. */
export function classesFor(path) {
  const all = Object.keys(CLASSES);
  const record = path.startsWith("docs/decisions/") || path === "docs/explanation/design-decisions.md";
  return record ? all.filter((c) => c !== "trackers" && c !== "dates") : all;
}

/** The allow file: `path<TAB>trimmed line`, one per line; `#` comments and blanks ignored. */
export function parseAllowLines(text) {
  const out = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("#")) continue;
    out.add(line);
  }
  return out;
}

/**
 * One file's hits: counts per class, every hit with its line, and which allow
 * entries the file used. An allowed line is skipped whole.
 */
export function scanText(path, text, allow) {
  const counts = {};
  const hits = [];
  const used = new Set();
  const classes = classesFor(path);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const key = `${path}\t${trimmed}`;
    if (allow.has(key)) {
      used.add(key);
      continue;
    }
    for (const cls of classes) {
      if (CLASSES[cls].test(trimmed)) {
        counts[cls] = (counts[cls] ?? 0) + 1;
        hits.push({ line: i + 1, cls, text: trimmed });
      }
    }
  }
  return { counts, hits, used };
}

/** Allow entries no line in the tree matched any more. */
export function staleAllowEntries(allow, used) {
  return [...allow].filter((e) => !used.has(e)).sort();
}

/** Every (path, class) whose count differs between the tree and the list, with both counts. */
function deltas(current, listed) {
  const out = [];
  const paths = new Set([...Object.keys(current), ...Object.keys(listed)]);
  for (const path of [...paths].sort()) {
    const now = current[path] ?? {};
    const was = listed[path] ?? {};
    for (const cls of Object.keys(CLASSES)) {
      const a = was[cls] ?? 0;
      const b = now[cls] ?? 0;
      if (a !== b) out.push({ path, cls, a, b });
    }
  }
  return out;
}

const grew = ({ path, cls, a, b }) =>
  `${path}: ${cls} ${a} → ${b} — new imprint; rewrite the line, or allow it by name in ${ALLOW_LINES_PATH}`;

/**
 * What `hygiene:gen` refuses to record: growth (or a new file) is new imprint,
 * and recording it would let `npm run fix` absorb it silently. Shrinkage is
 * exactly what gen exists to record, so it is not a problem here.
 */
export function growthProblems(current, listed) {
  return deltas(current, listed)
    .filter((d) => d.b > d.a)
    .map(grew);
}

/**
 * The ratchet: `current` and `listed` map path → class → count. Growth (or a
 * new file) is new imprint; shrinkage (or a vanished file) asks for `hygiene:gen`.
 */
export function ratchetProblems(current, listed) {
  return deltas(current, listed).map((d) =>
    d.b > d.a
      ? grew(d)
      : `${d.path}: ${d.cls} ${d.a} → ${d.b} — the list only shrinks: run \`npm run hygiene:gen\` to record the progress`,
  );
}

// ---------------------------------------------------------------------------
// The host: the tracked tree, the two files, the report.

const repoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), "..");

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString()
    .split("\0")
    .filter((p) => p !== "" && inScope(p));
}

/** Scan the tree: path → counts (only files with hits), every hit, the allow entries used. */
export function scanTree(root, allow) {
  const counts = {};
  const hits = [];
  const used = new Set();
  for (const path of trackedFiles(root)) {
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    const r = scanText(path, text, allow);
    if (r.hits.length > 0) counts[path] = r.counts;
    for (const h of r.hits) hits.push({ path, ...h });
    for (const u of r.used) used.add(u);
  }
  return { counts, hits, used };
}

const total = (counts) =>
  Object.values(counts).reduce((n, byClass) => n + Object.values(byClass).reduce((a, b) => a + b, 0), 0);

function main(argv) {
  const root = repoRoot();
  const allow = parseAllowLines(readFileSync(join(root, ALLOW_LINES_PATH), "utf8"));
  const { counts, hits, used } = scanTree(root, allow);
  const stale = staleAllowEntries(allow, used);

  const listAt = argv.indexOf("--list");
  if (listAt >= 0) {
    const prefixes = argv.slice(listAt + 1).filter((a) => !a.startsWith("--"));
    const shown = hits.filter((h) => prefixes.length === 0 || prefixes.some((p) => h.path.startsWith(p)));
    for (const h of shown) console.log(`${h.path}:${h.line}\t${h.cls}\t${h.text}`);
    console.log(`public-hygiene: ${shown.length} hit(s) in ${new Set(shown.map((h) => h.path)).size} file(s)`);
    return 0;
  }

  const listed = JSON.parse(readFileSync(join(root, ALLOWLIST_PATH), "utf8"));
  const staleProblems = stale.map((e) => `stale allow entry (no such line): ${e}`);

  if (argv.includes("--write")) {
    // Recording is for progress. Growth is refused, and nothing is written,
    // unless --force says it is deliberate — so `npm run fix` cannot absorb
    // new imprint into the list. A stale allow entry stops the write too.
    const growth = argv.includes("--force") ? [] : growthProblems(counts, listed);
    const refusals = [...growth, ...staleProblems];
    if (refusals.length > 0) {
      console.error(`public-hygiene: not recorded — ${refusals.length} problem(s)\n  ${refusals.join("\n  ")}`);
      return 1;
    }
    writeFileSync(join(root, ALLOWLIST_PATH), `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`public-hygiene: ${Object.keys(counts).length} file(s), ${total(counts)} hit(s) recorded`);
    return 0;
  }

  const problems = [...ratchetProblems(counts, listed), ...staleProblems];
  if (problems.length > 0) {
    console.error(`public-hygiene: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
    return 1;
  }
  console.log(
    `public-hygiene ok — ${Object.keys(listed).length} file(s), ${total(listed)} hit(s) still listed, ${allow.size} line(s) allowed`,
  );
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  process.exit(main(process.argv.slice(2)));
