#!/usr/bin/env node
// Every feature spec binds each validation criterion to its proof: a test
// named as `file::describe::it` (with `…` or `*` as wildcards, and a bare
// `::it` continuing the previous reference's file), or an `[agent]`
// procedure, or a `[gap]` — a criterion held but not yet proven. A
// binding that names a test which no longer exists is a spec describing code
// that is not there — this check makes that a failing build instead of a
// stale document. It also requires every path in a spec's **Code** and
// **Tests** header to exist, because those headers are what maps a changed
// file back to the spec that covers it.
//
// Test titles come from a static parse of each test file with the TypeScript
// compiler (describe/it/test call expressions, nesting from the syntax tree),
// so the check needs no test runtime and gives the same answer everywhere.
// A parameterised title (`it.each` with `%s`, a template literal) matches as
// a wildcard at the parameter.
//
//   npm run specs:check                                # every spec
//   npm run specs:check -- docs/reference/specs/x.md               # one spec
//   npm run specs:check -- --no-baseline docs/reference/specs/x.md # list its known-stale references too
//   npm run specs:check -- --fix                       # `title` → `title…` where that is the one match

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s)$/;

// ---------------------------------------------------------------------------
// Spec side: what a spec claims.

/**
 * Pure: the proof references in one spec's markdown. A reference is a
 * backtick span shaped `path::title[::title…]` where `path` is a test file,
 * or `::title` continuing the nearest preceding reference in the same table
 * row. Each carries the 1-based line it came from.
 */
/** A span as the reader sees it: `\`` is a literal backtick, `\|` a literal pipe. */
const unescapeSpan = (s) => s.replace(/\\`/g, "`").replace(/\\\|/g, "|");

export function parseProofRefs(markdown) {
  const refs = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) continue;
    // Spans in table-row order. A `\`` inside a span is a literal backtick
    // (a test title quoting an identifier), not the end of the span, and a
    // `\|` is the table-cell escape for a literal pipe.
    // `raw` keeps the span exactly as written, so a fix can be spliced back.
    const spans = [...line.matchAll(/`((?:\\`|[^`])+)`/g)].map((m) => m[1]);
    const rowRefs = [];
    for (const raw of spans) {
      if (!raw.includes("::")) continue;
      const cleaned = unescapeSpan(raw).replace(/^\[(?:unit|agent|gap)\]\s+/, "");
      const [head, ...rest] = cleaned.split("::");
      const titles = rest.filter((t) => t !== "");
      if (head === "") {
        rowRefs.push({ line: i + 1, file: null, titles, raw });
        continue;
      }
      if (!TEST_FILE.test(head)) continue; // `::` inside something that is not a proof
      rowRefs.push({ line: i + 1, file: head, titles, raw });
    }
    // A `::title` continuation borrows the nearest `file::` reference in its
    // row — the one before it, else the first one after it (some rows list
    // the leaves before the file). A row with no file reference at all has
    // no proof references (a stray `::` is an IPv6 literal or the like).
    const files = rowRefs.map((r) => r.file);
    if (!files.some(Boolean)) continue;
    for (let k = 0; k < rowRefs.length; k++) {
      if (rowRefs[k].file) continue;
      let file = null;
      for (let j = k - 1; j >= 0 && !file; j--) file = files[j];
      for (let j = k + 1; j < rowRefs.length && !file; j++) file = files[j];
      rowRefs[k] = { ...rowRefs[k], file };
    }
    refs.push(...rowRefs);
  }
  return refs;
}

/**
 * Pure: a reference's file may be a bare name (`worker.test.ts`) when the
 * spec's **Tests** header, or the repository, has exactly one test file by
 * that name. Returns the path to use, or the bare name when nothing (or more
 * than one thing) matches — the caller then reports it as not found.
 */
export function resolveBareTestFile(name, candidates) {
  if (name.includes("/")) return { file: name, ambiguous: [] };
  const hits = [...new Set(candidates.filter((c) => c === name || c.endsWith(`/${name}`)))];
  if (hits.length === 1) return { file: hits[0], ambiguous: [] };
  return { file: name, ambiguous: hits };
}

/** Pure: the paths a spec's **Code** / **Tests** header lines claim. */
export function parseHeaderPaths(markdown) {
  const paths = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^- \*\*(Code|Tests)\*\*:/.test(line)) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const span = m[1];
      // A path carries a directory: `src/x.ts`, `deploy/cloudflare/`. A bare
      // identifier (`Actor`), a dotted symbol (`conversations.info`) or a
      // route (`/runs`) is not one.
      if (!/^[\w.@-]+(?:\/[\w.@-]+)+\/?$/.test(span)) continue;
      paths.push({ line: i + 1, path: span });
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Test side: what the suite has.

const TEST_FNS = new Set(["describe", "it", "test", "suite"]);

/** The bare function name of a `describe` / `describe.each(...)` / `it.skip` callee, or null. */
function testFnName(expr) {
  let e = expr;
  // `it.each([...])` on its own is the parameter list, not the test: the test
  // is the OUTER call, whose callee is that call.
  if (ts.isPropertyAccessExpression(e) && (e.name.text === "each" || e.name.text === "for")) return null;
  // `it.each([...])(...)` — the callee is itself a call whose callee is `it.each`.
  if (ts.isCallExpression(e)) e = e.expression;
  while (ts.isPropertyAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) && TEST_FNS.has(e.text) ? e.text : null;
}

/** The title of a test call's first argument as a match pattern, or null when it is not a string-like. */
function titlePattern(arg) {
  if (!arg) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) {
    // `${expr}` becomes a wildcard: the title is decided at run time.
    return arg.head.text + arg.templateSpans.map((s) => "*" + s.literal.text).join("");
  }
  return "*"; // a variable or call: any title
}

/**
 * Pure: every describe and it in a test source, as `{ parts }` — the title
 * path from the outermost describe down. Both describes and leaves are
 * listed, so a reference may name a whole describe.
 */
export function collectTestTitles(source, fileName = "x.test.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes = [];
  const visit = (node, ancestry) => {
    if (ts.isCallExpression(node)) {
      const fn = testFnName(node.expression);
      if (fn) {
        const title = titlePattern(node.arguments[0]);
        if (title !== null) {
          const parts = [...ancestry, title];
          nodes.push({ parts, leaf: fn !== "describe" && fn !== "suite" });
          const next = fn === "describe" || fn === "suite" ? parts : ancestry;
          ts.forEachChild(node, (c) => visit(c, next));
          return;
        }
      }
    }
    ts.forEachChild(node, (c) => visit(c, ancestry));
  };
  visit(sf, []);
  return nodes;
}

// ---------------------------------------------------------------------------
// Matching.

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A spec segment → regex: `…` and `*` are wildcards, everything else literal. */
function segmentRegex(segment) {
  // A wildcard absorbs the spaces around it: `capped at 200 …` matches
  // `capped at 200, with a cursor`.
  const body = segment
    .split(/(\s*(?:\*|…)\s*)/)
    .map((piece, i) => (i % 2 === 1 ? ".*" : escapeRegExp(piece)))
    .join("");
  return new RegExp(`^${body}$`, "s");
}

/** A test title pattern → regex: `%s`-style and `$var` placeholders and `*` (from templates) are wildcards. */
function titleRegex(title) {
  const body = title
    .split(/(\*|%[sdifjo#]|\$\{[^}]*\}|\$[A-Za-z_][\w.]*)/)
    .map((piece, i) => (i % 2 === 1 ? ".*" : escapeRegExp(piece)))
    .join("");
  return new RegExp(`^${body}$`, "s");
}

/** Pure: does one spec segment name one test title part (either side's wildcards may absorb the other). */
export function segmentMatches(segment, part) {
  if (segment === part) return true;
  if (segmentRegex(segment).test(part)) return true;
  if (titleRegex(part).test(segment)) return true;
  // Both sides carry wildcards (a `…` in the segment, a parameter in the
  // title): neither regex can be exact, so every literal chunk of the segment
  // must appear in order somewhere in the part. A wildcard-free segment never
  // reaches this — it must match exactly, or a renamed test would keep an old
  // row green whenever the old title survived as a substring.
  if (!/[*…]/.test(segment) || !/\*|%[sdifjo#]|\$\{|\$[A-Za-z_]/.test(part)) return false;
  const chunks = segment
    .split(/\*|…/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length === 0) return true;
  let from = 0;
  for (const c of chunks) {
    const at = part.indexOf(c, from);
    if (at < 0) return false;
    from = at + c.length;
  }
  return true;
}

/**
 * Pure: do the reference's title segments name a node in the file's tree?
 * Segments match an increasing subsequence of the node's parts (a reference
 * may skip intermediate describes), and the LAST segment must match the
 * node's own title.
 */
export function refMatchesNode(titles, node) {
  if (titles.length === 0) return true;
  const parts = node.parts;
  if (!segmentMatches(titles[titles.length - 1], parts[parts.length - 1])) return false;
  let p = 0;
  for (let t = 0; t < titles.length - 1; t++) {
    while (p < parts.length - 1 && !segmentMatches(titles[t], parts[p])) p++;
    if (p >= parts.length - 1) return false;
    p++;
  }
  return true;
}

/**
 * Pure: the ways a reference's title path can be read. ` > ` is vitest's own
 * reporter separator and some rows nest with it (`describe > it`), but a
 * title may also contain a literal ` > ` (`seq > afterSeq`), so both readings
 * are tried and either may bind.
 */
export function titleReadings(titles) {
  const split = titles.flatMap((t) => t.split(" > ")).filter((t) => t !== "");
  return split.length === titles.length ? [titles] : [titles, split];
}

/**
 * Pure: resolve one spec's references against a loader of test titles.
 * `titlesFor(file)` returns the file's nodes or null when the file is absent.
 */
export function resolveRefs(refs, titlesFor) {
  const problems = [];
  for (const ref of refs) {
    const file = ref.file;
    if (ref.ambiguous && ref.ambiguous.length > 1) {
      problems.push({
        line: ref.line,
        raw: ref.raw,
        reason: `"${file}" names ${ref.ambiguous.length} test files — write the path: ${ref.ambiguous.join(", ")}`,
      });
      continue;
    }
    const nodes = titlesFor(file);
    if (nodes === null) {
      problems.push({ line: ref.line, raw: ref.raw, reason: `test file not found: ${file}` });
      continue;
    }
    if (ref.titles.length === 0) continue; // the whole file is the proof
    if (!titleReadings(ref.titles).some((titles) => nodes.some((n) => refMatchesNode(titles, n)))) {
      problems.push({
        line: ref.line,
        raw: ref.raw,
        file,
        reason: `no test in ${file} is titled ${ref.titles.map((t) => `"${t}"`).join(" › ")}`,
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The check over the tree.

export const SPECS_DIR = "docs/reference/specs";

export function checkSpec(specPath, { root, titlesFor, testFiles }) {
  const markdown = readFileSync(join(root, specPath), "utf8");
  const problems = [];
  const headerPaths = parseHeaderPaths(markdown);
  // A bare test-file name resolves against the spec's own Tests header first,
  // then against every test file in the repository.
  const fileFor = (name) => {
    const own = resolveBareTestFile(
      name,
      headerPaths.map((h) => h.path),
    );
    return own.ambiguous.length === 0 && own.file.includes("/") ? own : resolveBareTestFile(name, testFiles);
  };
  const refs = parseProofRefs(markdown).map((r) => ({ ...r, ...fileFor(r.file) }));
  for (const p of resolveRefs(refs, titlesFor)) problems.push({ kind: "proof", key: `${specPath} ${p.raw}`, ...p });
  for (const h of headerPaths) {
    if (!existsSync(join(root, h.path)))
      problems.push({
        kind: "header",
        key: `${specPath} header ${h.path}`,
        line: h.line,
        raw: h.path,
        reason: `path in the Code/Tests header does not exist: ${h.path}`,
      });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Fix mode: truncated titles made explicit.

/**
 * Pure: a wildcard-free segment that is the unique prefix of one title part in
 * the file becomes `segment…`, the unique inner substring of one becomes
 * `…segment…`; anything else (already exact, ambiguous, or absent) is returned
 * unchanged. The check accepts no bare truncation, so this is the one
 * mechanical rewrite that turns a shorthand the author meant into the
 * reference the check reads.
 */
export function explicitSegment(segment, parts) {
  if (/[*…]/.test(segment)) return segment;
  const distinct = [...new Set(parts)];
  if (distinct.includes(segment)) return segment;
  const prefixed = distinct.filter((p) => p.startsWith(segment));
  if (prefixed.length === 1) return `${segment}…`;
  if (prefixed.length > 1) return segment; // ambiguous: a person decides
  const inner = distinct.filter((p) => p.includes(segment));
  return inner.length === 1 ? `…${segment}…` : segment;
}

/**
 * Pure: the span with its truncated segments made explicit, or null when the
 * rewrite still would not bind to a node of the file. Escapes and the
 * `[unit]` label are kept as written.
 */
export function explicitSpan(raw, nodes) {
  const labelMatch = /^\[(?:unit|agent|gap)\]\s+/.exec(raw);
  const label = labelMatch ? labelMatch[0] : "";
  const [head, ...rest] = raw.slice(label.length).split("::");
  const parts = nodes.flatMap((n) => n.parts);
  const fixedRaw = rest.map((seg) => {
    if (seg === "") return seg;
    const plain = unescapeSpan(seg);
    const fixed = explicitSegment(plain, parts);
    if (fixed === plain) return seg;
    return fixed.startsWith("…") ? `…${seg}…` : `${seg}…`;
  });
  const titles = fixedRaw.map(unescapeSpan).filter((t) => t !== "");
  if (!titleReadings(titles).some((t) => nodes.some((n) => refMatchesNode(t, n)))) return null;
  return `${label}${[head, ...fixedRaw].join("::")}`;
}

/** Rewrite one spec's fixable references in place; returns how many changed. */
function fixSpec(specPath, ctx) {
  const abs = join(ctx.root, specPath);
  const lines = readFileSync(abs, "utf8").split("\n");
  let changed = 0;
  for (const p of checkSpec(specPath, ctx)) {
    if (p.kind !== "proof" || !p.file) continue;
    const nodes = ctx.titlesFor(p.file);
    if (!nodes) continue;
    const fixed = explicitSpan(p.raw, nodes);
    if (fixed === null || fixed === p.raw) continue;
    const before = lines[p.line - 1];
    const after = before.replace(`\`${p.raw}\``, `\`${fixed}\``);
    if (after === before) continue;
    lines[p.line - 1] = after;
    changed++;
  }
  if (changed > 0) writeFileSync(abs, lines.join("\n"));
  return changed;
}

// ---------------------------------------------------------------------------
// The baseline: references that were already stale when the check arrived.

export const BASELINE_FILE = `${SPECS_DIR}/specs-check.baseline.json`;

/**
 * Pure: split the current problems against the baseline's known keys. A
 * problem outside the baseline is new drift; a baseline key with no current
 * problem is stale (the reference was fixed) and must be removed, so the file
 * only ever shrinks. Both fail the check.
 */
export function partitionAgainstBaseline(problems, known) {
  const knownSet = new Set(known);
  const current = new Set(problems.map((p) => p.key));
  return {
    fresh: problems.filter((p) => !knownSet.has(p.key)),
    known: problems.filter((p) => knownSet.has(p.key)),
    stale: known.filter((k) => !current.has(k)),
  };
}

function readBaseline(root) {
  const abs = join(root, BASELINE_FILE);
  if (!existsSync(abs)) return null;
  const parsed = JSON.parse(readFileSync(abs, "utf8"));
  if (!Array.isArray(parsed.known)) throw new Error(`${BASELINE_FILE} must carry a "known" array`);
  return parsed.known;
}

function writeBaseline(root, keys) {
  const body = {
    $comment:
      "Proof references that were already stale when specs:check arrived, one key per unbound reference. The check fails on any reference NOT listed here and on any entry here that has been fixed, so this file only shrinks: fix a reference, delete its line. Regenerate with `npm run specs:check -- --update-baseline` only when adopting the check on a new tree. Delete the file once it is empty.",
    known: [...new Set(keys)].sort(),
  };
  writeFileSync(join(root, BASELINE_FILE), JSON.stringify(body, null, 2) + "\n");
}

function specFiles(root, dir) {
  return readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => `${dir}/${f}`)
    .sort();
}

/** Every test file under the source trees, repo-relative, for bare-name resolution. */
export function listTestFiles(root, dirs = ["src", "web/src", "deploy", "scripts"]) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(join(root, dir))) return;
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (TEST_FILE.test(entry.name)) out.push(rel);
    }
  };
  for (const d of dirs) walk(d);
  return out.sort();
}

function makeTitleLoader(root) {
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    const abs = join(root, file);
    let nodes = null;
    if (existsSync(abs) && statSync(abs).isFile()) nodes = collectTestTitles(readFileSync(abs, "utf8"), file);
    cache.set(file, nodes);
    return nodes;
  };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const updateBaseline = args.includes("--update-baseline");
  const noBaseline = args.includes("--no-baseline"); // list every stale reference, baseline or not
  const fix = args.includes("--fix"); // make unambiguous truncated titles explicit, then check
  const requested = args.filter((a) => !a.startsWith("--")).map((p) => relative(root, resolve(p)));
  const specs = requested.length > 0 ? requested : specFiles(root, SPECS_DIR);
  const titlesFor = makeTitleLoader(root);
  const testFiles = listTestFiles(root);

  if (fix) {
    let fixed = 0;
    for (const spec of specs) fixed += fixSpec(spec, { root, titlesFor, testFiles });
    console.log(`specs:check — ${fixed} truncated reference(s) made explicit with …; checking what remains`);
  }

  let refCount = 0;
  const problems = [];
  for (const spec of specs) {
    refCount += parseProofRefs(readFileSync(join(root, spec), "utf8")).length;
    problems.push(...checkSpec(spec, { root, titlesFor, testFiles }).map((p) => ({ spec, ...p })));
  }

  if (updateBaseline) {
    writeBaseline(
      root,
      problems.map((p) => p.key),
    );
    console.log(`specs:check — baseline written: ${problems.length} known stale reference(s) in ${BASELINE_FILE}`);
    return;
  }

  // With a subset of specs requested, only their baseline entries can be judged.
  const baseline = noBaseline ? null : readBaseline(root);
  const scoped = baseline === null ? [] : baseline.filter((k) => specs.some((s) => k.startsWith(`${s} `)));
  const { fresh, known, stale } = partitionAgainstBaseline(problems, scoped);

  for (const p of fresh) console.error(`${p.spec}:${p.line} — ${p.reason}${p.kind === "proof" ? `  [${p.raw}]` : ""}`);
  for (const k of stale) console.error(`${BASELINE_FILE} — resolved, remove this entry: ${k}`);
  const knownNote = known.length > 0 ? `; ${known.length} known stale (${BASELINE_FILE}, shrink it)` : "";

  if (fresh.length > 0 || stale.length > 0) {
    console.error(
      `specs:check FAILED — ${fresh.length} new unbound reference(s), ${stale.length} stale baseline entr(y/ies)${knownNote}. Rename the test back, or update the spec in the same PR.`,
    );
    process.exit(1);
  }
  console.log(
    `specs:check ok — ${specs.length} spec(s), ${refCount} proof reference(s) checked, every Code/Tests path exists${knownNote}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
