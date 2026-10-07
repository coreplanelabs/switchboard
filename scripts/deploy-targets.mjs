#!/usr/bin/env node
// The `deploy targets` CI job (docs/reference/specs/release-and-deploy.md item 8): which
// Workers this PR's diff would deploy, judged by `deploy plan --affected`.
//
// On an ordinary PR (ci.yml) the base is the PR's own base (HEAD^ of the merge
// commit CI checks out) and the table lands in the job summary. For the RELEASE
// PR the same script ALSO runs from release-please.yml on the push to main that
// opened or updated it, against production instead: each Worker's live commit,
// and the table is kept as ONE sticky comment on the PR, re-rendered on every
// merge to main. Its selector/plan snapshot is on the PR, not a deployment receipt.
//
// Environment (all set by the workflow; the script is the only logic):
//   RELEASE_PR          "true" when run for the release PR, else unset/"false"
//   TARGETS             the captured release selector (default affected; ignored on ordinary PRs)
//   GITHUB_STEP_SUMMARY the job summary file (optional: printed only when unset)
//   GITHUB_REPOSITORY   owner/name, for the comment API
//   PR                  the pull request number (release PR only)
//   GH_TOKEN            what `gh` authenticates with (release PR only)

import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MARKER = "<!-- switchboard:deploy-targets -->";
export const FOOTER =
  "_This is a preview snapshot of the selector, release tree and profile read by this workflow. The release run captures its own selector when it starts; later variable edits affect future runs. Planned targets still require candidate, preservation, configuration and deployment gates to pass. This preview does not prove any upload or service uptake._";

/** Preview decoder of the reusable workflow's closed selector grammar.
 * Parity tests execute that real workflow step; package execution stays independent of this checkout. */
export function parseTargetSelector(value = "") {
  if (value === "" || value === "affected") return { kind: "affected", label: "affected", args: ["--affected"] };
  if (value === "all") return { kind: "all", label: "all", args: [] };
  if (typeof value !== "string" || !/^(memory|bot|resident|sandbox)(,(memory|bot|resident|sandbox))*$/.test(value))
    throw new Error("targets must be affected, all, or comma-separated Worker names. Nothing was deployed.");
  return { kind: "only", label: value, names: value.split(","), args: ["--only", value] };
}

/** The plan's actual selected steps, not a diff guessed for another selector. */
export function releaseTargetTable(plan, selector) {
  if (!Array.isArray(plan?.steps)) throw new Error("deploy plan returned no steps");
  if (selector.kind === "affected") {
    const table = plan?.affected?.markdown;
    if (typeof table !== "string" || !table) throw new Error("affected plan returned no affected.markdown");
    return table;
  }
  const workers = plan?.profile?.selection?.workers;
  if (!workers || typeof workers !== "object" || Array.isArray(workers))
    throw new Error("plan returned no configured Workers");
  const order = ["memory", "bot", "resident", "sandbox"];
  const names = order.filter((name) => Object.hasOwn(workers, name));
  const selected = new Set(plan.steps.map((step) => step.name));
  const expected = names.filter((name) => selector.kind === "all" || selector.names.includes(name));
  if (
    selected.size !== plan.steps.length ||
    selected.size !== expected.length ||
    expected.some((name) => !selected.has(name))
  )
    throw new Error("selected plan steps disagree with the captured target selector");
  const missing = selector.kind === "only" ? selector.names.filter((name) => !names.includes(name)) : [];
  return [
    `Deploy targets: **${selected.size} of ${names.length} configured Workers**${selected.size ? ` — ${expected.join(", ")}` : ""}`,
    "",
    "| Worker | Decision | Why |",
    "|---|---|---|",
    ...names.map(
      (name) =>
        `| ${name} | **${selected.has(name) ? "deploy" : "skip"}** | ${selected.has(name) ? `selected by \`${selector.label}\`` : "not in the captured selector"} |`,
    ),
    ...(missing.length ? ["", `Not configured in this profile: ${missing.join(", ")}.`] : []),
  ].join("\n");
}

/** The summary block for the job page: heading, blank line, the table. Pure. */
export function summaryBlock(releasePr, table) {
  const heading = releasePr ? "## Release deployment preview" : "## What this PR's diff would deploy";
  return `${heading}\n\n${table}\n`;
}

/** The sticky comment body for the release PR: marker first, so it can be
 *  found again; then the heading, the table, and the footer. Pure. */
export function commentBody(table, selector = parseTargetSelector()) {
  return `${MARKER}\n\n## Release deployment preview\n\nSelector: \`${selector.label}\`\n\n${table}\n\n${FOOTER}\n`;
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
  const selector = parseTargetSelector(releasePr ? process.env.TARGETS : "affected");
  const args = ["run", "--silent", "cli", "--", "deploy", "plan", ...selector.args, "--json"];
  if (!releasePr) args.push("--base", run("git", ["rev-parse", "HEAD^"]).trim());
  const plan = JSON.parse(run("npm", args));
  const table = releaseTargetTable(plan, selector);
  writeFileSync("targets.md", `${table}\n`);
  process.stdout.write(`${table}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryBlock(releasePr, table));

  if (!releasePr) return;
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR;
  if (!repo || !pr) throw new Error("GITHUB_REPOSITORY and PR are required on the release PR");
  writeFileSync("comment.md", commentBody(table, selector));
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
    run("gh", [
      "api",
      "--method",
      "PATCH",
      `repos/${repo}/issues/comments/${existing.trim()}`,
      "-F",
      "body=@comment.md",
    ]);
    console.log(`updated comment ${existing.trim()}`);
  } else {
    run("gh", ["pr", "comment", pr, "--body-file", "comment.md"]);
    console.log("posted the deploy-targets comment");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`deploy:targets — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
