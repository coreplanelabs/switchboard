#!/usr/bin/env node
// The built docs site is complete: every section index and the pages the
// dashboard links to exist in docs/.vitepress/dist. The build proves the
// artifact compiles; this proves it is the site we expect to deploy. Run after
// `npm run build -w docs`.

import { existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(process.cwd(), "docs", ".vitepress", "dist");
const required = [
  "index.html",
  "404.html",
  "tutorials/index.html",
  "how-to/index.html",
  "reference/index.html",
  "explanation/index.html",
  // The specs directory is the one README nested two levels deep; its index is
  // what the sidebar's "Specs" entry and the footer link to.
  "reference/specs/index.html",
  "reference/cli.html",
];

if (!existsSync(dist)) {
  console.error(`check:site — ${dist} is missing; run \`npm run build -w docs\` first`);
  process.exit(2);
}
const missing = required.filter((p) => !existsSync(join(dist, p)));
if (missing.length > 0) {
  console.error(`check:site FAILED — ${missing.length} required page(s) missing from the built site:`);
  for (const p of missing) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check:site ok — ${required.length} required page(s) present in docs/.vitepress/dist`);
