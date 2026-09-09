#!/usr/bin/env node
// The built docs site is complete and is ours: every section index and the
// pages the dashboard links to exist in docs/.vitepress/dist, and the home
// page carries the product's display name — the tab title and the hero — as
// project.json states it. The build proves the artifact compiles; this proves
// it is the site we expect to deploy. The site derives its name from
// project.json at build time rather than copying it, so the name is checked
// here, on the artifact, and not by check:project-facts on a source copy. Run
// after `npm run build -w docs`.
//
//   npm run check:site

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_PAGES = [
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

/**
 * Pure: what is wrong with a built site, given a reader over its dist directory
 * (`read(relativePath)` → the file's text, or undefined when absent) and the
 * project facts. Every required page must exist; the home page's `<title>` and
 * the hero's `product` element must both read `displayName`.
 */
export function siteProblems(read, facts) {
  const problems = [];
  const pages = Object.fromEntries(REQUIRED_PAGES.map((p) => [p, read(p)]));
  for (const p of REQUIRED_PAGES) if (pages[p] === undefined) problems.push(`missing: ${p}`);
  const home = pages["index.html"];
  if (home !== undefined) {
    const title = /<title>([^<]*)<\/title>/.exec(home);
    if (!title) problems.push("index.html: has no <title>");
    else if (title[1] !== facts.displayName)
      problems.push(`index.html: <title> is "${title[1]}" — project.json says displayName "${facts.displayName}"`);
    // The hero names the product in an element of class `product`
    // (docs/.vitepress/theme/LandingPage.vue); scoped styles add attributes.
    const hero = /<[a-z]+[^>]*\bclass="product"[^>]*>\s*([^<]*?)\s*</.exec(home);
    if (!hero) problems.push('index.html: the hero has no element of class "product" naming the product');
    else if (hero[1] !== facts.displayName)
      problems.push(
        `index.html: the hero names the product "${hero[1]}" — project.json says displayName "${facts.displayName}"`,
      );
  }
  return problems;
}

function main() {
  const dist = join(process.cwd(), "docs", ".vitepress", "dist");
  if (!existsSync(dist)) {
    console.error(`check:site — ${dist} is missing; run \`npm run build -w docs\` first`);
    process.exit(2);
  }
  const facts = JSON.parse(readFileSync(join(process.cwd(), "project.json"), "utf8"));
  const read = (p) => (existsSync(join(dist, p)) ? readFileSync(join(dist, p), "utf8") : undefined);
  const problems = siteProblems(read, facts);
  if (problems.length > 0) {
    console.error(`check:site FAILED — ${problems.length} problem(s) with the built site:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    `check:site ok — ${REQUIRED_PAGES.length} required page(s) present in docs/.vitepress/dist, home page titled "${facts.displayName}"`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
