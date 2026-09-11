#!/usr/bin/env node
// Did the last push touch the docs site or its deploy config? Prints `true` or
// `false` and, under GitHub Actions, writes `docs=<value>` to $GITHUB_OUTPUT so
// the deploy job can gate on it. Fails OPEN (answers `true`) when the diff
// cannot be computed — the published site must never be silently older than
// main because a shallow clone hid the parent commit.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The site's inputs: its pages and build under `docs/`, the Worker that serves
 *  it, and `project.json` — the site reads its title, hero and hostname from
 *  the facts at build time, so a changed fact is a changed site. */
export const DOCS_PATHS = /^(docs\/|deploy\/cloudflare-docs\/|project\.json$)/;

/** Pure: of the paths one push changed, the ones that are the site's inputs. */
export const docsTouched = (files) => files.filter((f) => DOCS_PATHS.test(f));

function git(...args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

function main() {
  let changed = true;
  let reason = "no parent commit — deploying";
  const parent = git("rev-parse", "HEAD^");
  if (parent) {
    const diff = git("diff", "--name-only", "HEAD^", "HEAD");
    if (diff !== null) {
      const touched = docsTouched(diff.split("\n").filter(Boolean));
      changed = touched.length > 0;
      reason = changed ? `docs touched: ${touched.join(", ")}` : "docs untouched by this push";
    }
  }
  console.log(`docs:changed — ${reason}`);
  console.log(changed ? "true" : "false");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `docs=${changed}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
