// The duration ratchet's scanner (docs/reference/specs/tracing.md item 8;
// decision 0046): counts minutes-scale duration literals per production file
// with the TypeScript AST, using the same predicate ids as the ESLint
// `duration-ban` rule (durationReads.mjs). Plain JS beside the predicate list,
// so the lint config, the CLI (scripts/clock-allowlist.mts, which runs both
// ratchets) and the
// allowlist test all load the same code; never part of the bot's runtime.
// The allowlist it keeps only shrinks: a literal that becomes a row of
// src/core/budgets.ts leaves it, and no file may gain one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { filesUnder, scriptBlocksOf } from "./clockScan.mjs";
import {
  DURATION_BAN_EXEMPT,
  DURATION_BAN_FILES,
  DURATION_READS,
  MINUTE_SCALE_RAW,
  MINUTE_UNIT_NAMES,
} from "./durationReads.mjs";

export const ALLOWLIST_PATH = "src/core/trace/durationAllowlist.json";

const SIXTY_THOUSAND = /^60_?000$/;
const MINUTE_SCALE = new RegExp(MINUTE_SCALE_RAW);
const MINUTE_UNIT = new RegExp(MINUTE_UNIT_NAMES);

/** Every file the ratchet applies to, repo-relative and sorted. @param {string} root */
export function productionFiles(root) {
  return filesUnder(root, DURATION_BAN_FILES, DURATION_BAN_EXEMPT);
}

/** Count the duration literals in one source, keyed by predicate id.
 *  @param {string} path @param {string} text @returns {Record<string, number>} */
export function countDurationLiterals(path, text) {
  const source = ts.createSourceFile(
    path.endsWith(".mjs") ? "x.js" : "x.ts",
    scriptBlocksOf(path, text),
    ts.ScriptTarget.ES2022,
    true,
  );
  /** @type {Record<string, number>} */
  const counts = {};
  /** @param {string} id */
  const hit = (id) => {
    counts[id] = (counts[id] ?? 0) + 1;
  };
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
      for (const side of [node.left, node.right]) {
        if (ts.isNumericLiteral(side) && SIXTY_THOUSAND.test(side.getText())) hit("n * 60000");
        if (ts.isIdentifier(side) && MINUTE_UNIT.test(side.text)) hit("n * MIN");
      }
    }
    if (ts.isNumericLiteral(node) && MINUTE_SCALE.test(node.getText())) {
      // `5 * 60_000` is counted once, as the multiplication; the bare-literal
      // class is for a number standing alone (`RETRY_MS = 900_000`).
      const parent = node.parent;
      const inMultiplication =
        parent !== undefined &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
        SIXTY_THOUSAND.test(node.getText());
      if (!inMultiplication) hit("minute-scale literal");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counts;
}

/** Literals per file across the tree; files with none are omitted.
 *  @param {string} root @returns {Record<string, number>} */
export function scan(root) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const f of productionFiles(root)) {
    const counts = countDurationLiterals(f, readFileSync(join(root, f), "utf8"));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) out[f] = total;
  }
  return out;
}

/** The predicate ids the scanner knows; the test asserts they equal the rule's. */
export const SCANNER_IDS = ["n * 60000", "n * MIN", "minute-scale literal"];
export const RULE_IDS = DURATION_READS.map((r) => r.id);

/** Compare the tree against the allowlist. Returns the problems (empty = ok):
 *  a file over its entry grew a literal; a listed file under its entry has a
 *  stale entry to shrink. @param {Record<string, number>} current @param {Record<string, number>} listed */
export function allowlistProblems(current, listed) {
  /** @type {string[]} */
  const problems = [];
  for (const [f, count] of Object.entries(current)) {
    const allowed = listed[f] ?? 0;
    if (count > allowed)
      problems.push(
        `${f}: ${count} duration literal(s), allowlist permits ${allowed} — move the number into src/core/budgets.ts`,
      );
  }
  for (const [f, allowed] of Object.entries(listed)) {
    if ((current[f] ?? 0) < allowed)
      problems.push(
        `${f}: allowlist says ${allowed} but ${current[f] ?? 0} remain — shrink the entry (npm run clock:gen)`,
      );
  }
  return problems;
}
