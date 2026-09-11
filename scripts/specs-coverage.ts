// Which specs a change touches, and which changed source paths no spec covers
// (docs/reference/specs/specs-coverage.md). Reads every spec under
// docs/reference/specs/ and maps the changed paths through the pure rules in
// src/docs/specCoverage.ts.
//
//   npm run specs:coverage -- --changed origin/main...HEAD   # the diff's paths (git diff --name-only)
//   npm run specs:coverage -- --paths src/core/x.ts src/y.ts  # named paths
//   git diff --name-only origin/main...HEAD | npm run specs:coverage  # paths on stdin, one per line
//   … --json      # machine shape: { touched: [{ spec, because }], uncovered: [] }
//   … --require   # exit 1 when a changed source path has no covering spec (default: print and exit 0)
//   … --test-guard  # with --changed only: the test guard (src/docs/testGuard.ts) over both ends of the
//                   # range — a `removed:` line (test file deleted, title gone, skip marker added) exits 1
//                   # unless a spec covering that test file changes in the range; a `check:` line (fewer
//                   # expect( calls, a rename or a split) is for the reviewer and never fails
//
// The review agent runs the first form on the PR it reviews and reads only the
// specs listed; the uncovered list is the warn phase of a gate that becomes an
// error once every source path has a covering spec. It runs the --test-guard
// form too and files each unallowed `removed:` line as a finding.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coveringSpecs, parseHeaderPaths, type SpecCoverage } from "../src/docs/specCoverage.js";
import {
  countExpectCalls,
  formatTestGuard,
  isTestFile,
  testGuard,
  type ChangedTestFile,
  type TestFileSnapshot,
} from "../src/docs/testGuard.js";
import { collectTestTitles } from "./specs-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SPECS_DIR = "docs/reference/specs";

function listSpecs(): SpecCoverage[] {
  const dir = join(root, SPECS_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) => ({
      path: `${SPECS_DIR}/${name}`,
      headerPaths: parseHeaderPaths(readFileSync(join(dir, name), "utf8")).map((h) => h.path),
    }));
}

const USAGE = `
usage: npm run specs:coverage -- --changed <a>...<b> | --paths <p>... | (paths on stdin)  [--json] [--require] [--test-guard]`;

interface Args {
  changed?: string;
  paths?: string[];
  json: boolean;
  require: boolean;
  testGuard: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, require: false, testGuard: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--require") args.require = true;
    else if (a === "--test-guard") args.testGuard = true;
    else if (a === "--changed") {
      const range = argv[i + 1];
      if (range === undefined || range.startsWith("--"))
        throw new Error(`specs:coverage: --changed needs a range${USAGE}`);
      args.changed = argv[++i];
    } else if (a === "--paths") {
      args.paths = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args.paths.push(argv[++i]);
    } else throw new Error(`specs:coverage: unknown argument ${a}${USAGE}`);
  }
  if (args.testGuard && args.changed === undefined)
    throw new Error(`specs:coverage: --test-guard reads both ends of a range and needs --changed${USAGE}`);
  return args;
}

const splitLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const git = (...argv: string[]) => execFileSync("git", argv, { cwd: root, stdio: "pipe" }).toString();

function changedPaths(args: Args): string[] {
  if (args.changed !== undefined) return splitLines(git("diff", "--name-only", args.changed));
  if (args.paths !== undefined) return args.paths;
  // No range and no paths: the paths come on stdin — but only when something is
  // piped in. A terminal would sit waiting forever.
  if (process.stdin.isTTY) throw new Error(`specs:coverage: no changed paths given${USAGE}`);
  return splitLines(readFileSync(0, "utf8"));
}

/**
 * The two revisions a `git diff` range compares: `a...b` compares the merge
 * base of a and b with b, `a..b` compares a with b, and a lone `a` compares a
 * with the working tree (head `null`). An omitted side is HEAD, as in git.
 */
function rangeEnds(range: string): { base: string; head: string | null } {
  const sym = range.indexOf("...");
  if (sym >= 0) {
    const a = range.slice(0, sym) || "HEAD";
    const b = range.slice(sym + 3) || "HEAD";
    return { base: git("merge-base", a, b).trim(), head: b };
  }
  const dots = range.indexOf("..");
  if (dots >= 0) return { base: range.slice(0, dots) || "HEAD", head: range.slice(dots + 2) || "HEAD" };
  return { base: range, head: null };
}

/** The file's text at a revision — in the working tree when `rev` is null — or null when it is not there. */
function contentAt(rev: string | null, path: string): string | null {
  if (rev === null) return existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
  try {
    return git("show", `${rev}:${path}`);
  } catch {
    return null;
  }
}

const snapshot = (source: string | null, path: string): TestFileSnapshot | null =>
  source === null ? null : { blocks: collectTestTitles(source, path), expectCalls: countExpectCalls(source) };

/**
 * Every test file the range touches, parsed at both ends. A rename
 * (`R<score>\told\tnew`) reads the old path at the base and the new one at the
 * head, so a moved file is judged on its content, not reported as a deletion
 * plus an addition.
 */
function changedTestFiles(range: string): ChangedTestFile[] {
  const { base, head } = rangeEnds(range);
  const files: ChangedTestFile[] = [];
  for (const line of splitLines(git("diff", "--name-status", "-M", range))) {
    const [status, oldPath, renamedTo] = line.split("\t");
    const newPath = renamedTo ?? oldPath;
    if (!isTestFile(newPath) && !isTestFile(oldPath)) continue;
    if (status.startsWith("D"))
      files.push({ path: oldPath, base: snapshot(contentAt(base, oldPath), oldPath), head: null });
    else
      files.push({
        path: newPath,
        base: snapshot(contentAt(base, oldPath), oldPath),
        head: snapshot(contentAt(head, newPath), newPath),
      });
  }
  return files;
}

function main(): number {
  let args: Args;
  let changed: string[];
  let testFiles: ChangedTestFile[] = [];
  try {
    args = parseArgs(process.argv.slice(2));
    changed = changedPaths(args);
    if (args.changed !== undefined && args.testGuard) testFiles = changedTestFiles(args.changed);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const specs = listSpecs();
  const result = coveringSpecs(changed, specs);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.touched.length === 0) console.log("specs:coverage — no spec covers any changed path");
    for (const t of result.touched) console.log(`${t.spec}  ← ${t.because.join(", ")}`);
    if (result.uncovered.length > 0) {
      console.log(`specs:coverage — ${result.uncovered.length} changed source path(s) with no covering spec:`);
      for (const p of result.uncovered) console.log(`  ${p}`);
    } else {
      console.log("specs:coverage — every changed source path has a covering spec");
    }
  }
  let guardOk = true;
  if (args.testGuard) {
    const guard = formatTestGuard(testGuard(testFiles, changed, specs));
    guardOk = guard.ok;
    for (const line of guard.lines) console.log(line);
  }
  return (args.require && result.uncovered.length > 0) || !guardOk ? 1 : 0;
}

process.exit(main());
