#!/usr/bin/env node
// The CI title gate: a pull request's title becomes the squash commit's
// subject on `main`, a changelog line and a version bump, so it is checked on
// every pull request as a required status. The predicate — the grammar, the
// allowed types and scopes, the 72-character cap, the migration note behind
// `!` — lives in src/core/prTitle.mjs, shared with the `submit_pr_description`
// tool so a coding run is refused the same title CI would refuse; the
// vocabulary it judges against is the generated src/core/prTitleVocabulary.json
// (`npm run pr-title:gen` from release-please-config.json and the code map).
// This file only reads the tree and reports.
//
//   npm run check:pr-title -- "feat(slack): thread admission"   # one title
//   PR_TITLE="…" npm run check:pr-title                          # what CI does
//
// In the merge queue there is no pull request title (it was checked on the PR
// that entered the queue), so the check passes with a note. Plain JS with no
// dependencies: the CI job runs it on Node alone, before any install.

import { existsSync, readFileSync } from "node:fs";
import { checkPrTitle, migrationNoteProblems, MIGRATIONS_PATH, RELEASE_CONFIG_PATH } from "../src/core/prTitle.mjs";
import vocabulary from "../src/core/prTitleVocabulary.json" with { type: "json" };

function main() {
  const fromArg = process.argv.slice(2).join(" ").trim();
  const title = fromArg !== "" ? fromArg : (process.env.PR_TITLE ?? "");
  if (title.trim() === "" && process.env.GITHUB_EVENT_NAME === "merge_group") {
    console.log("check:pr-title ok — merge queue run; the title was checked on the pull request");
    return;
  }
  if (title.trim() === "" && !process.env.PR_TITLE && fromArg === "") {
    console.error('check:pr-title — no title given: pass one (npm run check:pr-title -- "feat: …") or set PR_TITLE');
    process.exit(2);
  }

  let version;
  let releaseAs;
  try {
    releaseAs = JSON.parse(readFileSync(RELEASE_CONFIG_PATH, "utf8"))["release-as"];
    version = JSON.parse(readFileSync("package.json", "utf8")).version;
  } catch (err) {
    console.error(`check:pr-title — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const verdict = checkPrTitle(title, vocabulary);
  const problems = verdict.ok
    ? migrationNoteProblems({
        breaking: verdict.breaking,
        version,
        migrationsDoc: existsSync(MIGRATIONS_PATH) ? readFileSync(MIGRATIONS_PATH, "utf8") : undefined,
        releaseAs,
      })
    : verdict.problems;
  if (verdict.ok && problems.length === 0) {
    const scope = verdict.scope ? `(${verdict.scope})` : "";
    console.log(`check:pr-title ok — ${verdict.type}${scope}${verdict.breaking ? "!" : ""}: ${verdict.description}`);
    return;
  }
  console.error(`check:pr-title FAILED — "${title.trim()}"`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("  The title is the changelog line; see CONTRIBUTING.md → The PR title is the changelog line.");
  process.exit(1);
}

main();
