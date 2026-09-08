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
//
// The review agent runs the first form on the PR it reviews and reads only the
// specs listed; the uncovered list is the warn phase of a gate that becomes an
// error once every source path has a covering spec.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coveringSpecs, parseHeaderPaths, type SpecCoverage } from "../src/docs/specCoverage.js";

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
usage: npm run specs:coverage -- --changed <a>...<b> | --paths <p>... | (paths on stdin)  [--json] [--require]`;

interface Args {
  changed?: string;
  paths?: string[];
  json: boolean;
  require: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, require: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--require") args.require = true;
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
  return args;
}

const splitLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function changedPaths(args: Args): string[] {
  if (args.changed !== undefined)
    return splitLines(
      execFileSync("git", ["diff", "--name-only", args.changed], { cwd: root, stdio: "pipe" }).toString(),
    );
  if (args.paths !== undefined) return args.paths;
  // No range and no paths: the paths come on stdin — but only when something is
  // piped in. A terminal would sit waiting forever.
  if (process.stdin.isTTY) throw new Error(`specs:coverage: no changed paths given${USAGE}`);
  return splitLines(readFileSync(0, "utf8"));
}

function main(): number {
  let args: Args;
  let changed: string[];
  try {
    args = parseArgs(process.argv.slice(2));
    changed = changedPaths(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const result = coveringSpecs(changed, listSpecs());
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
  return args.require && result.uncovered.length > 0 ? 1 : 0;
}

process.exit(main());
