// Which specs a change touches, and which changed source paths no spec covers
// (docs/reference/specs/specs-coverage.md). Reads every spec under
// docs/reference/specs/ and maps the changed paths through the pure rules in
// src/docs/specCoverage.ts.
//
//   npm run specs:coverage -- --changed origin/main...HEAD   # the diff's paths (git diff --name-status -M -z)
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
import { closeSync, constants, openSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
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

function listSpecs(rev: string | null): SpecCoverage[] {
  const dir = join(root, SPECS_DIR);
  const paths =
    rev === null
      ? readdirSync(dir).map((name) => `${SPECS_DIR}/${name}`)
      : git("ls-tree", "-r", "--name-only", "-z", rev, "--", SPECS_DIR).split("\0").filter(Boolean);
  return paths
    .filter(
      (path) => path.endsWith(".md") && !path.endsWith("/README.md") && !path.slice(SPECS_DIR.length + 1).includes("/"),
    )
    .sort()
    .map((path) => ({
      path,
      headerPaths: parseHeaderPaths(contentAt(rev, path)).map((h) => h.path),
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

function changedPaths(args: Args, entries: ChangedEntry[]): string[] {
  if (args.changed !== undefined) return entries.map((entry) => entry.newPath);
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
const commitOf = (ref: string) => git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();

function rangeEnds(range: string): { base: string; head: string | null } {
  const sym = range.indexOf("...");
  if (sym >= 0) {
    const a = commitOf(range.slice(0, sym) || "HEAD");
    const b = commitOf(range.slice(sym + 3) || "HEAD");
    return { base: git("merge-base", a, b).trim(), head: b };
  }
  const dots = range.indexOf("..");
  if (dots >= 0)
    return { base: commitOf(range.slice(0, dots) || "HEAD"), head: commitOf(range.slice(dots + 2) || "HEAD") };
  return { base: commitOf(range), head: null };
}

/** Open regular files without following a swapped link; symlink blobs are the link bytes. */
function workingTreeBlob(path: string): { bytes: Buffer; symlink: boolean } {
  const file = join(root, path);
  if (constants.O_NOFOLLOW === undefined)
    throw new Error("specs:coverage: no-follow file opens are unavailable on this platform");
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ELOOP") throw e;
    // readlink never follows the target. If the entry changes again to a
    // regular file or disappears, the read fails rather than following it.
    return { bytes: readlinkSync(file, { encoding: "buffer" }), symlink: true };
  }
  try {
    return { bytes: readFileSync(fd), symlink: false };
  } finally {
    closeSync(fd);
  }
}

/** Expected files must be readable; only the diff may establish absence. */
function contentAt(rev: string | null, path: string): string {
  return rev !== null ? git("show", `${rev}:${path}`) : workingTreeBlob(path).bytes.toString("utf8");
}

function workingTreeBlobId(path: string): string {
  const { bytes, symlink } = workingTreeBlob(path);
  return execFileSync("git", ["hash-object", ...(symlink ? ["--no-filters"] : ["--path", path]), "--stdin"], {
    cwd: root,
    stdio: "pipe",
    input: bytes,
  })
    .toString()
    .trim();
}

interface ChangedEntry {
  status: string;
  oldPath: string;
  newPath: string;
}

function changedEntries({ base, head }: ReturnType<typeof rangeEnds>): ChangedEntry[] {
  const fields = git("diff", "--name-status", "-M", "-z", ...(head === null ? [base] : [base, head]), "--").split("\0");
  const entries: ChangedEntry[] = [];
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++];
    const oldPath = fields[i++];
    if (!/^(?:A|D|M|T|R[0-9]+)$/.test(status) || !oldPath)
      throw new Error("specs:coverage: unreadable or unresolved Git diff entry");
    const newPath = status.startsWith("R") ? fields[i++] : oldPath;
    if (!newPath) throw new Error("specs:coverage: incomplete Git rename entry");
    entries.push({ status, oldPath, newPath });
  }
  return entries;
}

const snapshot = (source: string | null, path: string): TestFileSnapshot | null =>
  source === null ? null : { blocks: collectTestTitles(source, path), expectCalls: countExpectCalls(source) };

/**
 * Every test file the range touches, parsed at both ends. A rename
 * (`R<score>\told\tnew`) reads the old path at the base and the new one at the
 * head. Moving outside the test suffix removes the proof; moving into it
 * adds a test, without assigning it a formerly executed snapshot.
 */
function changedTestFiles(entries: ChangedEntry[], { base, head }: ReturnType<typeof rangeEnds>): ChangedTestFile[] {
  const files: ChangedTestFile[] = [];
  for (const { status, oldPath, newPath } of entries) {
    if (!isTestFile(newPath) && !isTestFile(oldPath)) continue;
    if (status.startsWith("D") || !isTestFile(newPath))
      files.push({ path: oldPath, base: snapshot(contentAt(base, oldPath), oldPath), head: null });
    else
      files.push({
        path: newPath,
        ...(status.startsWith("R") ? { basePath: oldPath } : {}),
        base: status.startsWith("A") || !isTestFile(oldPath) ? null : snapshot(contentAt(base, oldPath), oldPath),
        head: snapshot(contentAt(head, newPath), newPath),
      });
  }
  return files;
}

function main(): number {
  let args: Args;
  let changed: string[];
  let testFiles: ChangedTestFile[] = [];
  let specs: SpecCoverage[];
  let baseSpecs: SpecCoverage[] = [];
  let changedSpecs: string[] = [];
  try {
    args = parseArgs(process.argv.slice(2));
    if (realpathSync(root) !== realpathSync(git("rev-parse", "--show-toplevel").trim()))
      throw new Error("specs:coverage: script package root must be the Git repository root");
    const ends = args.changed === undefined ? null : rangeEnds(args.changed);
    const entries = ends === null ? [] : changedEntries(ends);
    changed = changedPaths(args, entries);
    if (ends?.head === null && git("ls-files", "--unmerged", "-z").length > 0)
      throw new Error("specs:coverage: unresolved working-tree index");
    specs = listSpecs(ends?.head ?? null);
    if (args.changed !== undefined && args.testGuard && ends !== null) {
      baseSpecs = listSpecs(ends.base);
      testFiles = changedTestFiles(entries, ends);
      // A spec rename preserves its base identity, but a move alone does not
      // revise the contract. Deletion counts as touch; retirement needs review.
      changedSpecs = entries.flatMap(({ status, oldPath, newPath }) => {
        if (!baseSpecs.some((spec) => spec.path === oldPath)) return [];
        if (status.startsWith("D")) {
          if (ends.head === null)
            throw new Error(
              "specs:coverage: owning-spec deletion needs a committed head range; working-tree destinations are incomplete evidence",
            );
          return [oldPath];
        }
        const original = git("rev-parse", `${ends.base}:${oldPath}`).trim();
        const current =
          ends.head === null ? workingTreeBlobId(newPath) : git("rev-parse", `${ends.head}:${newPath}`).trim();
        return original === current ? [] : [oldPath];
      });
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
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
    const guard = formatTestGuard(testGuard(testFiles, changedSpecs, baseSpecs));
    guardOk = guard.ok;
    for (const line of guard.lines) console.log(line);
  }
  return (args.require && result.uncovered.length > 0) || !guardOk ? 1 : 0;
}

process.exit(main());
