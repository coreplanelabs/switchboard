#!/usr/bin/env node
// Did the last push touch the docs site or its deploy config? Prints `true` or
// `false` and, under GitHub Actions, writes `docs=<value>` to $GITHUB_OUTPUT so
// the deploy job can gate on it. Fails OPEN (answers `true`) when the diff
// cannot be computed — the published site must never be silently older than
// main because a shallow clone hid the parent commit.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const DOCS_PATHS = /^(docs\/|deploy\/cloudflare-docs\/)/;

function git(...args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

let changed = true;
let reason = "no parent commit — deploying";
const parent = git("rev-parse", "HEAD^");
if (parent) {
  const diff = git("diff", "--name-only", "HEAD^", "HEAD");
  if (diff !== null) {
    const files = diff.split("\n").filter(Boolean);
    changed = files.some((f) => DOCS_PATHS.test(f));
    reason = changed ? `docs touched: ${files.filter((f) => DOCS_PATHS.test(f)).join(", ")}` : "docs untouched by this push";
  }
}
console.log(`docs:changed — ${reason}`);
console.log(changed ? "true" : "false");
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `docs=${changed}\n`);
