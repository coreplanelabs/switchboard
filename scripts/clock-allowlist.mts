// The clock ratchet's CLI (features/tracing.md). `npm run clock:gen`
// regenerates src/core/trace/clockAllowlist.json from the tree; `npm run
// clock:check` fails when a file's count grew or a listed file has fewer reads
// than recorded — the list can only shrink. The scanner itself lives beside the
// predicate list in src/core/trace/clockScan.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWLIST_PATH, allowlistProblems, scan } from "../src/core/trace/clockScan.mjs";

const root = process.cwd();
const current = scan(root);
const total = (list: Record<string, number>): number => Object.values(list).reduce((a, b) => a + b, 0);

if (process.argv.includes("--write")) {
  writeFileSync(join(root, ALLOWLIST_PATH), `${JSON.stringify(current, null, 2)}\n`);
  console.log(`clock-allowlist: ${Object.keys(current).length} file(s), ${total(current)} read(s) written`);
} else {
  const listed = JSON.parse(readFileSync(join(root, ALLOWLIST_PATH), "utf8")) as Record<string, number>;
  const problems = allowlistProblems(current, listed);
  if (problems.length > 0) {
    console.error(`clock-allowlist: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`clock-allowlist ok — ${Object.keys(listed).length} file(s), ${total(listed)} read(s) still allowed`);
}
