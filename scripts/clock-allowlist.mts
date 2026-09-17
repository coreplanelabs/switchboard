// The clock ratchets' CLI (docs/reference/specs/tracing.md item 8): two lists,
// one command pair. `npm run clock:gen` regenerates the allowlists from the
// tree — direct wall-clock reads (src/core/trace/clockAllowlist.json, empty
// since that ratchet reached zero) and minutes-scale duration literals outside
// src/core/budgets.ts (src/core/trace/durationAllowlist.json, decision 0046);
// `npm run clock:check` fails when a file's count grew or a listed file has
// fewer than recorded — either list can only shrink. The scanners live beside
// their predicate lists in src/core/trace/clockScan.mjs and durationScan.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as clock from "../src/core/trace/clockScan.mjs";
import * as duration from "../src/core/trace/durationScan.mjs";

type Allowlist = Record<string, number>;
interface Ratchet {
  name: string;
  unit: string;
  path: string;
  scan: (root: string) => Allowlist;
  problems: (current: Allowlist, listed: Allowlist) => string[];
}

const RATCHETS: Ratchet[] = [
  {
    name: "clock-allowlist",
    unit: "read",
    path: clock.ALLOWLIST_PATH,
    scan: clock.scan,
    problems: clock.allowlistProblems,
  },
  {
    name: "duration-allowlist",
    unit: "literal",
    path: duration.ALLOWLIST_PATH,
    scan: duration.scan,
    problems: duration.allowlistProblems,
  },
];

const root = process.cwd();
const total = (list: Allowlist): number => Object.values(list).reduce((a, b) => a + b, 0);
let failed = false;

for (const r of RATCHETS) {
  const current = r.scan(root);
  if (process.argv.includes("--write")) {
    writeFileSync(join(root, r.path), `${JSON.stringify(current, null, 2)}\n`);
    console.log(`${r.name}: ${Object.keys(current).length} file(s), ${total(current)} ${r.unit}(s) written`);
    continue;
  }
  const listed = JSON.parse(readFileSync(join(root, r.path), "utf8")) as Allowlist;
  const problems = r.problems(current, listed);
  if (problems.length > 0) {
    console.error(`${r.name}: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
    failed = true;
    continue;
  }
  console.log(`${r.name} ok — ${Object.keys(listed).length} file(s), ${total(listed)} ${r.unit}(s) still allowed`);
}
if (failed) process.exit(1);
