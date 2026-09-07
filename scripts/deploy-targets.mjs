#!/usr/bin/env node
// The `deploy targets` CI job (features/release-and-deploy.md item 8): which
// Workers this PR's diff would deploy, judged by `deploy plan --affected`.
//
// On an ordinary PR the base is the PR's own base (HEAD^ of the merge commit CI
// checks out) and the table lands in the job summary. On the release PR the
// same command runs against production instead — each Worker's live commit —
// and the table is kept as ONE sticky comment on the PR, re-rendered on every
// push, so what merging the release will deploy is on the PR itself.
//
// Environment (all set by the workflow; the script is the only logic):
//   RELEASE_PR          "true" on the release-please branch, else "false"
//   GITHUB_STEP_SUMMARY the job summary file (optional: printed only when unset)
//   GITHUB_REPOSITORY   owner/name, for the comment API
//   PR                  the pull request number (release PR only)
//   GH_TOKEN            what `gh` authenticates with (release PR only)

import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

export const MARKER = "<!-- switchboard:deploy-targets -->";
export const FOOTER =
  "_Judged per Worker against the commit it is serving right now. Re-rendered on every push to this branch by the `deploy targets` CI job; merging runs `deploy all --affected` and deploys exactly the Workers marked **deploy**._";

/** The summary block for the job page: heading, blank line, the table. Pure. */
export function summaryBlock(releasePr, table) {
  const heading = releasePr ? "## What merging this release deploys" : "## What this PR's diff would deploy";
  return `${heading}\n\n${table}\n`;
}

/** The sticky comment body for the release PR: marker first, so it can be
 *  found again; then the heading, the table, and the footer. Pure. */
export function commentBody(table) {
  return `${MARKER}\n\n## What merging this release deploys\n\n${table}\n\n${FOOTER}\n`;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}${r.stderr ? `: ${r.stderr.trim()}` : ""}`);
  }
  return r.stdout;
}

function main() {
  const releasePr = process.env.RELEASE_PR === "true";
  const args = ["run", "--silent", "cli", "--", "deploy", "plan", "--affected", "--json"];
  if (!releasePr) args.push("--base", run("git", ["rev-parse", "HEAD^"]).trim());
  const plan = JSON.parse(run("npm", args));
  const table = plan?.affected?.markdown;
  if (typeof table !== "string" || table.length === 0) {
    throw new Error("deploy plan --affected --json returned no affected.markdown");
  }
  writeFileSync("targets.md", `${table}\n`);
  process.stdout.write(`${table}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryBlock(releasePr, table));

  if (!releasePr) return;
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR;
  if (!repo || !pr) throw new Error("GITHUB_REPOSITORY and PR are required on the release PR");
  writeFileSync("comment.md", commentBody(table));
  const existing = run("gh", [
    "api",
    `repos/${repo}/issues/${pr}/comments`,
    "--paginate",
    "--jq",
    `.[] | select(.body | startswith("${MARKER}")) | .id`,
  ])
    .split("\n")
    .find((line) => line.trim().length > 0);
  if (existing) {
    run("gh", ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.trim()}`, "-F", "body=@comment.md"]);
    console.log(`updated comment ${existing.trim()}`);
  } else {
    run("gh", ["pr", "comment", pr, "--body-file", "comment.md"]);
    console.log("posted the deploy-targets comment");
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (err) {
    console.error(`deploy:targets — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
