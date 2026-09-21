#!/usr/bin/env node
// The user-message ratchet (docs/reference/specs/routing-and-config.md item 33),
// beside vocabulary:check. A statement shown to a person says what Switchboard
// did, is doing or will do. It never delegates recovery with an imperative.
// Confirmation offers and clarifying questions are the two typed exceptions.
//
// The check reads printed literals from direct chat/card/endings sources,
// plus template text, element attributes and TypeScript models from the web
// app. Existing violations are counted by path and phrase in a baseline that
// can only shrink.
//
//   npm run user-message:check
//   npm run user-message:check -- --write
//   npm run user-message:check -- --list src/

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { growthProblems, ratchetProblems } from "./public-hygiene.mjs";
import { extractTemplateText } from "./vocabulary-check.mjs";

export const BASELINE_PATH = "scripts/user-message-check.baseline.json";

export const WORDING = {
  grew: "a recovery imperative reached a user surface; say what the system did, is doing or will do",
  shrank: "the baseline only shrinks: run `npm run user-message:check -- --write` to record the retirement",
};

/** Deliberately narrow signatures of delegated recovery, not an English
 * imperative parser. Verb signatures use a clause boundary so statements such
 * as “the run ended” and “an admin can raise it” are not instructions. */
const imperative = (verb, rest = "") =>
  new RegExp(`(?:^|[.!?;:,—]\\s*|-\\s+|\\b(?:and|or|then|please)\\s+)(?:please\\s+)?${verb}${rest}`, "i");

export const PHRASES = {
  // “By hand” always assigns the recovery to the person. Match the phrase
  // itself rather than maintaining an incomplete list of verbs before it.
  "by hand": /\bby hand\b/i,
  "re-issue": /\bre-issue\b/i,
  "re-send": /(?<!no need to )\bre-send\b/i,
  "re-ask": /\bre-ask\b/i,
  "try again": /\btry again\b/i,
  "type the line": /\btype the line\b/i,
  "retry once": /\bretry once\b/i,
  "raise boundary": imperative("raise\\b", "[^.!?\\n]{0,80}\\bboundar(?:y|ies)\\b"),
  "drop overrides": imperative("drop\\b", "[^.!?\\n]{0,80}\\boverrides?\\b"),
  "ask to raise": imperative("ask\\b", "[^.!?\\n]{0,80}\\bto\\s+raise\\b"),
  "send again": imperative("send\\b", "[^.!?\\n]{0,80}\\bagain\\b"),
  "spawn it": imperative("spawn\\s+it\\b"),
  "re-run": imperative("re-run\\b"),
  run: imperative("run\\s+"),
};

const TYPESCRIPT_SURFACE_FILES = new Set([
  "src/cli.ts",
  "src/core/boot.ts",
  "src/core/commandChat.ts",
  "src/core/commandRegistry.ts",
  "src/core/commandSurface.ts",
  "src/core/confirmations.ts",
  "src/core/dispatcher.ts",
  "src/core/harness/windDown.ts",
  "src/core/metricsService.ts",
  "src/core/pullSweep.ts",
  "src/core/reviewRound.ts",
  "src/core/runsService.ts",
  "src/core/threadAdmission.ts",
]);
const TYPESCRIPT_SURFACE_PREFIXES = [
  "src/channels/",
  "src/core/commands/",
  "src/core/coordinator/",
  "src/core/dispatch/",
  "src/core/ship/",
  "src/execution/",
  "src/mcp/",
];

/** The source sets behind the requested surfaces: Slack cards/replies, unit
 * endings, run-page strings, CLI chat answers, and execution failures those
 * renderers narrate. Tests and declaration twins are never surfaces. */
export function surfaceFor(path) {
  if (path.endsWith(".test.ts") || path.endsWith(".d.ts") || path.endsWith(".d.mts")) return null;
  if (
    path.endsWith(".ts") &&
    (TYPESCRIPT_SURFACE_FILES.has(path) || TYPESCRIPT_SURFACE_PREFIXES.some((prefix) => path.startsWith(prefix)))
  )
    return "typescript";
  if (path.startsWith("web/src/") && (path.endsWith(".vue") || path.endsWith(".ts"))) return "web";
  return null;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

function objectDiscriminant(object, name, value) {
  return object.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === name &&
      ts.isStringLiteralLike(property.initializer) &&
      property.initializer.text === value,
  );
}

/** A syntax-level type fence. ConfirmationOffer annotations and the existing
 * `kind: "question"` union make the exception reviewable in source; prose that
 * merely ends in a question mark does not exempt itself. */
function shapeOf(node, source) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current) && current.type?.getText(source).split(/\W+/u).includes("ConfirmationOffer"))
      return "confirmation";
    if (ts.isObjectLiteralExpression(current) && objectDiscriminant(current, "kind", "question")) return "question";
  }
  return "statement";
}

/** Statically compose the ordinary expression forms renderers use to build
 * one message. An interpolation inside one authored token is omitted so
 * `Re-${part}send` is checked as `Re-send`; elsewhere a marker keeps the hole
 * from turning `${count} run` into a new imperative at the clause boundary. */
function renderedString(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const next = span.literal.text;
      value += /\S$/u.test(value) && /^\S/u.test(next) ? next : `\${}${next}`;
    }
    return value;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = renderedString(node.left);
    const right = renderedString(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length <= 1 &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join" &&
    ts.isArrayLiteralExpression(node.expression.expression)
  ) {
    const separator = node.arguments.length === 0 ? "," : renderedString(node.arguments[0]);
    const fragments = node.expression.expression.elements.map((element) => renderedString(element));
    if (separator !== undefined && fragments.every((fragment) => fragment !== undefined))
      return fragments.join(separator);
  }
  return undefined;
}

/** Printed strings with their typed message shape. Composite expressions are
 * emitted once as their rendered text instead of scanning each fragment. */
export function extractTypeScriptMessages(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const push = (node, value) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    for (const [offset, piece] of value.split("\n").entries())
      if (piece.trim() !== "") out.push({ line: line + 1 + offset, text: piece.trim(), shape: shapeOf(node, source) });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const value = renderedString(node);
    if (value !== undefined) {
      push(node, value);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function lineAt(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

const USER_TEXT_ATTRIBUTES = new Set(["alt", "aria-description", "aria-label", "label", "placeholder", "title"]);

/** User-visible element attributes from a Vue template. Plain attributes are
 * already printed values; bindings are expressions, so only their string and
 * template literals are printed copy. */
function extractTemplateAttributes(path, sfc) {
  const start = sfc.indexOf("<template");
  const end = sfc.lastIndexOf("</template>");
  if (start < 0 || end <= start) return [];
  const openEnd = sfc.indexOf(">", start);
  const body = sfc.slice(openEnd + 1, end);
  const attributes = /(?:^|[\s<])([:@#]?[\w.-]+|v-[\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/gu;
  const out = [];

  for (const match of body.matchAll(attributes)) {
    const name = match[1];
    const attribute = name.replace(/^:/u, "").replace(/^v-bind:/u, "");
    if (!USER_TEXT_ATTRIBUTES.has(attribute)) continue;
    const value = match[3];
    const valueOffset = openEnd + 1 + match.index + match[0].lastIndexOf(value);
    const valueLine = lineAt(sfc, valueOffset);
    const expression = name.startsWith(":") || name.startsWith("v-bind:");
    if (expression) {
      for (const message of extractTypeScriptMessages(`${path}.attribute.ts`, value))
        out.push({ ...message, line: valueLine + message.line - 1 });
      continue;
    }
    for (const [offset, piece] of value.split("\n").entries())
      if (piece.trim() !== "") out.push({ line: valueLine + offset, text: piece.trim(), shape: "statement" });
  }
  return out;
}

export function extractFile(path, text) {
  switch (surfaceFor(path)) {
    case "typescript":
      return extractTypeScriptMessages(path, text);
    case "web":
      if (path.endsWith(".ts")) return extractTypeScriptMessages(path, text);
      return [
        ...extractTemplateText(text).map((message) => ({ ...message, shape: "statement" })),
        ...extractTemplateAttributes(path, text),
      ].sort((a, b) => a.line - b.line);
    default:
      return [];
  }
}

export function scanMessages(messages) {
  const counts = {};
  const hits = [];
  for (const message of messages) {
    if (message.shape === "confirmation" || message.shape === "question") continue;
    for (const [phrase, pattern] of Object.entries(PHRASES)) {
      if (!pattern.test(message.text)) continue;
      counts[phrase] = (counts[phrase] ?? 0) + 1;
      hits.push({ line: message.line, phrase, text: message.text.trim() });
    }
  }
  return { counts, hits };
}

const repoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), "..");

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString()
    .split("\0")
    .filter((path) => path !== "" && surfaceFor(path) !== null);
}

export function scanTree(root) {
  const counts = {};
  const hits = [];
  for (const path of trackedFiles(root)) {
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    const result = scanMessages(extractFile(path, text));
    if (result.hits.length > 0) counts[path] = result.counts;
    for (const hit of result.hits) hits.push({ path, ...hit });
  }
  return { counts, hits };
}

const total = (counts) =>
  Object.values(counts).reduce((sum, byPhrase) => sum + Object.values(byPhrase).reduce((a, b) => a + b, 0), 0);

function main(argv) {
  const root = repoRoot();
  const { counts, hits } = scanTree(root);
  const listAt = argv.indexOf("--list");
  if (listAt >= 0) {
    const prefixes = argv.slice(listAt + 1).filter((arg) => !arg.startsWith("--"));
    const shown = hits.filter((hit) => prefixes.length === 0 || prefixes.some((prefix) => hit.path.startsWith(prefix)));
    for (const hit of shown) console.log(`${hit.path}:${hit.line}\t${hit.phrase}\t${hit.text}`);
    console.log(`user-message: ${shown.length} hit(s) in ${new Set(shown.map((hit) => hit.path)).size} file(s)`);
    return 0;
  }

  const listed = JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8"));
  if (argv.includes("--write")) {
    const growth = argv.includes("--force") ? [] : growthProblems(counts, listed, WORDING);
    if (growth.length > 0) {
      console.error(`user-message: not recorded — ${growth.length} problem(s)\n  ${growth.join("\n  ")}`);
      return 1;
    }
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`user-message: ${Object.keys(counts).length} file(s), ${total(counts)} hit(s) recorded`);
    return 0;
  }

  const problems = ratchetProblems(counts, listed, WORDING);
  if (problems.length > 0) {
    console.error(`user-message: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
    return 1;
  }
  console.log(`user-message ok — ${Object.keys(listed).length} file(s), ${total(listed)} hit(s) still on the baseline`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  process.exit(main(process.argv.slice(2)));
