#!/usr/bin/env node
// The vocabulary ratchet (docs/reference/specs/public-hygiene.md), public-hygiene's
// sibling under check:consistency: none of the fourteen internal words of decision
// record 0066 ("The internal words") is printed where a user reads it. The check
// reads what is printed, never what the code says to itself — string and template
// literals extracted (TypeScript AST) from the dispatch and ship modules and from
// the command registry's summaries and tool descriptions (`describe:`), the text
// nodes of the web templates, and the lines of the non-spec docs trees. Today's
// violations sit on a committed baseline, path → word → count, that only shrinks;
// there is no per-line allow file — a violation is rewritten in the user's nouns
// (docs/reference/vocabulary.md) or it waits on the baseline. The vocabulary page
// and the public-hygiene spec quote the words by design and are exempt by path.
//
//   npm run vocabulary:check                 # the surfaces equal the baseline
//   npm run vocabulary:gen                   # record the surfaces after a retirement (refuses growth; -- --force to insist)
//   npm run vocabulary:check -- --list src/  # every remaining hit under a prefix, for a retirement
//
// Plain JS with a .d.mts twin, like the other checks under scripts/: the test
// imports it; nothing under src/ does (the image copies src/ without scripts/).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { growthProblems, ratchetProblems } from "./public-hygiene.mjs";

export const BASELINE_PATH = "scripts/vocabulary-check.baseline.json";

/** The wording the shared ratchet prints for this class of problem: there is no
 *  allow file here — a new hit is rewritten, a retired one is re-recorded. */
export const WORDING = {
  grew: "an internal word reached a user surface; rewrite it in the user's nouns (docs/reference/vocabulary.md)",
  shrank: "the baseline only shrinks: run `npm run vocabulary:gen` to record the retirement",
};

/** The fourteen internal words, each with its regex over one printed snippet.
 *  Two carry a scoped sense: `hosted` only immediately before run/parent/pipeline
 *  (a GitHub-hosted runner in the how-to tree is the vendor's noun), and `runner`
 *  only as "plan runner" (the internal name whose user referent is pipeline). */
export const WORDS = {
  session: /\bsessions?\b/i,
  lease: /\bleases?\b/i,
  segment: /\bsegments?\b/i,
  instance: /\binstances?\b/i,
  attempt: /\battempts?\b/i,
  hosted: /\bhosted (?:runs?|parents?|pipelines?)\b/i,
  "host key": /\bhost keys?\b/i,
  coordinator: /\bcoordinators?\b/i,
  runner: /\bplan runners?\b/i,
  admission: /\badmissions?\b/i,
  intake: /\bintakes?\b/i,
  handoff: /\bhand-?offs?\b/i,
  "wind-down": /\bwind-downs?\b/i,
  tier: /\btiers?\b/i,
};

/** Pages whose job is to quote the banned words: exempt by path, never line by line. */
export const EXEMPT_PATHS = new Set(["docs/reference/vocabulary.md", "docs/reference/specs/public-hygiene.md"]);

const DOCS_TREES = ["docs/reference/", "docs/how-to/", "docs/tutorials/", "docs/explanation/"];

/**
 * Which extraction a tracked path gets, or null when the path is no user
 * surface: `bot` (every string and template literal), `registry` (only the
 * `describe:` summaries the CLI and the MCP tool list print), `web` (template
 * text nodes), `docs` (every line of the non-spec trees — the specs keep their
 * internal precision and are read against the vocabulary page).
 */
export function surfaceFor(path) {
  if (EXEMPT_PATHS.has(path)) return null;
  if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts")) {
    if (path.startsWith("src/core/dispatch/") || path.startsWith("src/core/ship/")) return "bot";
    if (path.startsWith("src/core/commands/")) return "registry";
  }
  if (path.startsWith("web/src/") && path.endsWith(".vue")) return "web";
  if (path.startsWith("docs/reference/specs/")) return null;
  if (path.endsWith(".md") && DOCS_TREES.some((p) => path.startsWith(p))) return "docs";
  return null;
}

/**
 * The printed strings of one TypeScript file as { line, text } snippets.
 * `all`: every string and template literal (a template contributes its static
 * chunks; expressions inside it are visited for their own literals). Never an
 * identifier, never a comment (the AST walk sees neither), never an import or
 * export specifier — a module path is what the code says to itself.
 * `describe`: only literals under a `describe:` property — the registry's
 * summaries, which the CLI's help and the MCP tool list print verbatim.
 */
export function extractTypeScriptStrings(path, text, mode) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const push = (node, value) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    for (const [i, piece] of value.split("\n").entries())
      if (piece.trim() !== "") out.push({ line: line + 1 + i, text: piece.trim() });
  };
  const literals = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteralLike(node)) push(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      push(node.head, node.head.text);
      for (const span of node.templateSpans) push(span.literal, span.literal.text);
    }
    ts.forEachChild(node, literals);
  };
  const visit = (node) => {
    if (mode === "all") {
      literals(node);
      return;
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "describe")
      literals(node.initializer);
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * The text nodes of one Vue single-file component's template as { line, text }
 * snippets: what sits between tags, with comments and `{{ … }}` bindings blanked
 * (a binding's value is data, not a literal the template prints). Attribute
 * values live inside tags, so a binding or a label passed as an attribute is
 * never extracted here.
 */
export function extractTemplateText(sfc) {
  const start = sfc.indexOf("<template");
  const end = sfc.lastIndexOf("</template>");
  if (start < 0 || end <= start) return [];
  const openEnd = sfc.indexOf(">", start);
  const blank = (m) => m.replace(/[^\n]/g, " ");
  const body = sfc
    .slice(openEnd + 1, end)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\{\{[\s\S]*?\}\}/g, blank);
  const baseLine = sfc.slice(0, openEnd + 1).split("\n").length;
  const out = [];
  let line = baseLine;
  let inTag = false;
  let quote = null;
  let buf = "";
  let bufLine = line;
  const flush = () => {
    for (const [i, piece] of buf.split("\n").entries())
      if (piece.trim() !== "") out.push({ line: bufLine + i, text: piece.trim() });
    buf = "";
  };
  for (const c of body) {
    if (inTag) {
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") inTag = false;
    } else if (c === "<") {
      flush();
      inTag = true;
    } else {
      if (buf === "") bufLine = line;
      buf += c;
    }
    if (c === "\n") line++;
  }
  flush();
  return out;
}

/** One tracked file's printed snippets, by its surface; [] when it is none. */
export function extractFile(path, text) {
  switch (surfaceFor(path)) {
    case "bot":
      return extractTypeScriptStrings(path, text, "all");
    case "registry":
      return extractTypeScriptStrings(path, text, "describe");
    case "web":
      return extractTemplateText(text);
    case "docs":
      return text.split("\n").map((t, i) => ({ line: i + 1, text: t }));
    default:
      return [];
  }
}

/** One file's snippets scanned: counts per word, every hit with its line. */
export function scanSnippets(snippets) {
  const counts = {};
  const hits = [];
  for (const { line, text } of snippets) {
    for (const [word, re] of Object.entries(WORDS)) {
      if (!re.test(text)) continue;
      counts[word] = (counts[word] ?? 0) + 1;
      hits.push({ line, word, text: text.trim() });
    }
  }
  return { counts, hits };
}

// ---------------------------------------------------------------------------
// The host: the tracked tree, the baseline, the report.

const repoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), "..");

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString()
    .split("\0")
    .filter((p) => p !== "" && surfaceFor(p) !== null);
}

/** Scan the user surfaces: path → counts (only files with hits), every hit. */
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
    const r = scanSnippets(extractFile(path, text));
    if (r.hits.length > 0) counts[path] = r.counts;
    for (const h of r.hits) hits.push({ path, ...h });
  }
  return { counts, hits };
}

const total = (counts) =>
  Object.values(counts).reduce((n, byWord) => n + Object.values(byWord).reduce((a, b) => a + b, 0), 0);

function main(argv) {
  const root = repoRoot();
  const { counts, hits } = scanTree(root);

  const listAt = argv.indexOf("--list");
  if (listAt >= 0) {
    const prefixes = argv.slice(listAt + 1).filter((a) => !a.startsWith("--"));
    const shown = hits.filter((h) => prefixes.length === 0 || prefixes.some((p) => h.path.startsWith(p)));
    for (const h of shown) console.log(`${h.path}:${h.line}\t${h.word}\t${h.text}`);
    console.log(`vocabulary: ${shown.length} hit(s) in ${new Set(shown.map((h) => h.path)).size} file(s)`);
    return 0;
  }

  const listed = JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8"));

  if (argv.includes("--write")) {
    // Recording is for retirements. Growth is refused, and nothing is written,
    // unless --force says it is deliberate (the first recording of a brand-new
    // baseline is growth by definition) — so `npm run fix` cannot absorb a new
    // printed internal word into the baseline.
    const growth = argv.includes("--force") ? [] : growthProblems(counts, listed, WORDING);
    if (growth.length > 0) {
      console.error(`vocabulary: not recorded — ${growth.length} problem(s)\n  ${growth.join("\n  ")}`);
      return 1;
    }
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`vocabulary: ${Object.keys(counts).length} file(s), ${total(counts)} hit(s) recorded`);
    return 0;
  }

  const problems = ratchetProblems(counts, listed, WORDING);
  if (problems.length > 0) {
    console.error(`vocabulary: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
    return 1;
  }
  console.log(`vocabulary ok — ${Object.keys(listed).length} file(s), ${total(listed)} hit(s) still on the baseline`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  process.exit(main(process.argv.slice(2)));
