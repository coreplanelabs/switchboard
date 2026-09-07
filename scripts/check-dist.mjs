#!/usr/bin/env node
// dist/ must never ship test files: a *.test.js in the image would import
// vitest, which `npm ci --omit=dev` prunes, and throw at startup. Run after
// `npm run build` (the `check:dist` script does both).

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const dist = join(process.cwd(), "dist");
let files;
try {
  files = walk(dist);
} catch {
  console.error("check:dist — dist/ is missing; run `npm run build` first");
  process.exit(2);
}
const offenders = files.filter((f) => /\.test\.(m|c)?js$/.test(f) || /\/testing\//.test(f));
if (offenders.length > 0) {
  console.error(`check:dist FAILED — ${offenders.length} test file(s) in dist/:`);
  for (const f of offenders) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check:dist ok — ${files.length} file(s) in dist/, no test files`);
