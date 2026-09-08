// The clock ratchet's scanner (docs/reference/specs/tracing.md): counts direct wall-clock
// reads per production file with the TypeScript AST, using the same predicate
// ids as the ESLint `clock-ban` rule (clockReads.mjs). Plain JS beside the
// predicate list, so the lint config, the CLI (scripts/clock-allowlist.mts) and
// the allowlist test all load the same code; it is never part of the bot's
// runtime (nothing under src/ imports it except its test).
// `.vue` files are scanned by their <script> blocks; `.mjs` as JS.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { CLOCK_BAN_EXEMPT, CLOCK_BAN_FILES, CLOCK_READS } from "./clockReads.mjs";

export const ALLOWLIST_PATH = "src/core/trace/clockAllowlist.json";

const ROOTS = ["src", "deploy", "web", "scripts"];
const EXTENSIONS = [".ts", ".mts", ".mjs", ".vue"];

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTENSIONS.some((e) => p.endsWith(e))) out.push(p);
  }
}

/** A flat-config glob as a RegExp. Placeholders first, so a later `*` pass
 *  cannot rewrite the output of an earlier one. @param {string} glob */
function globToRe(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "<<DIRS>>")
    .replace(/\*\*/g, "<<ANY>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<DIRS>>/g, "(?:.*/)?")
    .replace(/<<ANY>>/g, ".*");
  return new RegExp(`^${re}$`);
}

const INCLUDE = CLOCK_BAN_FILES.map(globToRe);
const EXEMPT = CLOCK_BAN_EXEMPT.map(globToRe);

/** Every file the ratchet applies to, repo-relative and sorted. @param {string} root */
export function productionFiles(root) {
  /** @type {string[]} */
  const files = [];
  for (const r of ROOTS) walk(join(root, r), files);
  return files
    .map((f) => relative(root, f))
    .filter((f) => INCLUDE.some((re) => re.test(f)) && !EXEMPT.some((re) => re.test(f)))
    .sort();
}

/** The script blocks of a .vue file, or the file itself. @param {string} path @param {string} text */
function sourceOf(path, text) {
  if (!path.endsWith(".vue")) return text;
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
}

/** Count the clock reads in one source, keyed by predicate id.
 *  @param {string} path @param {string} text @returns {Record<string, number>} */
export function countClockReads(path, text) {
  const source = ts.createSourceFile(
    path.endsWith(".mjs") ? "x.js" : "x.ts",
    sourceOf(path, text),
    ts.ScriptTarget.ES2022,
    true,
  );
  /** @type {Record<string, number>} */
  const counts = {};
  /** @param {string} id */
  const hit = (id) => {
    counts[id] = (counts[id] ?? 0) + 1;
  };
  /** @param {ts.Node} n */
  const name = (n) => (ts.isIdentifier(n) ? n.text : undefined);
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isNewExpression(node) && name(node.expression) === "Date" && (node.arguments?.length ?? 0) === 0)
      hit("new Date()");
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const prop = callee.name.text;
        const obj = callee.expression;
        if (prop === "now" && name(obj) === "Date") hit("Date.now");
        else if (prop === "now" && ts.isPropertyAccessExpression(obj) && obj.name.text === "Date")
          hit("globalThis.Date.now");
        else if (prop === "now" && name(obj) === "performance") hit("performance.now");
        else if (prop === "hrtime" && name(obj) === "process") hit("process.hrtime");
        else if (prop === "uptime" && name(obj) === "process") hit("process.uptime");
        else if (
          prop === "bigint" &&
          ts.isPropertyAccessExpression(obj) &&
          obj.name.text === "hrtime" &&
          name(obj.expression) === "process"
        )
          hit("process.hrtime.bigint");
      } else if (
        ts.isElementAccessExpression(callee) &&
        name(callee.expression) === "Date" &&
        ts.isStringLiteral(callee.argumentExpression) &&
        callee.argumentExpression.text === "now"
      ) {
        hit("Date['now']");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counts;
}

/** Reads per file across the tree; files with none are omitted.
 *  @param {string} root @returns {Record<string, number>} */
export function scan(root) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const f of productionFiles(root)) {
    const counts = countClockReads(f, readFileSync(join(root, f), "utf8"));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) out[f] = total;
  }
  return out;
}

/** The predicate ids the scanner knows; the test asserts they equal the rule's. */
export const SCANNER_IDS = [
  "Date.now",
  "globalThis.Date.now",
  "Date['now']",
  "new Date()",
  "performance.now",
  "process.hrtime",
  "process.hrtime.bigint",
  "process.uptime",
];
export const RULE_IDS = CLOCK_READS.map((r) => r.id);

/** Compare the tree against the allowlist. Returns the problems (empty = ok).
 *  @param {Record<string, number>} current @param {Record<string, number>} listed */
export function allowlistProblems(current, listed) {
  /** @type {string[]} */
  const problems = [];
  for (const [f, count] of Object.entries(current)) {
    const allowed = listed[f] ?? 0;
    if (count > allowed) problems.push(`${f}: ${count} clock read(s), allowlist permits ${allowed}`);
  }
  for (const [f, allowed] of Object.entries(listed)) {
    if ((current[f] ?? 0) < allowed)
      problems.push(`${f}: allowlist says ${allowed} but ${current[f] ?? 0} remain — shrink the entry`);
  }
  return problems;
}
