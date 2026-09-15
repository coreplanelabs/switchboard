// The records gate: reads every record under docs/decisions/ and docs/plans/,
// reads their copies at the merge-base of HEAD and the base branch, and
// reports through the pure rules in src/docs/records.ts
// (docs/reference/specs/docs-site.md item 16).
//
//   npm run decisions:check                       # every record, against the merge-base with origin/main (locally and in CI)
//   DECISIONS_BASE=<ref> npm run decisions:check  # merge-base with another ref, e.g. the branch a stacked PR targets
//
// The merge-base, not the tip: a branch judged against origin/main's tip fails
// when a record was accepted, amended or added on main after the branch was
// cut, though the branch never touched it. Judged against the commit it was
// cut from, only the branch's own edits count.
//
// Without a reachable base (a shallow clone, or no common ancestor) the
// immutability half is skipped and said so; the status half always runs.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  baseRecords,
  immutabilityProblems,
  RECORD_DIRS,
  statusProblems,
  type BaseHistory,
  type RecordText,
} from "../src/docs/records.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function listRecords(): RecordText[] {
  const out: RecordText[] = [];
  for (const dir of RECORD_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      if (!name.endsWith(".md") || name === "README.md") continue;
      const path = `${dir}/${name}`;
      out.push({ path, text: readFileSync(join(root, path), "utf8") });
    }
  }
  return out;
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
/** A git answer, or null where git has none (an unknown ref, no common ancestor). */
const gitOrNull = (...args: string[]): string | null => {
  try {
    return git(...args).trim() || null;
  } catch {
    return null;
  }
};

/** The repository as `baseRecords` reads it. */
const history: BaseHistory = {
  commitOf: (ref) => gitOrNull("rev-parse", "--verify", "--quiet", `${ref}^{commit}`),
  mergeBase: (a, b) => gitOrNull("merge-base", a, b),
  recordPaths: (commit) =>
    git("ls-tree", "-r", "--name-only", commit, "--", ...RECORD_DIRS)
      .split("\n")
      .filter((p) => p.endsWith(".md") && !p.endsWith("/README.md")),
  textAt: (commit, path) => git("show", `${commit}:${path}`),
};

function main(): number {
  const records = listRecords();
  const problems = statusProblems(records, (path) => existsSync(join(root, path)));
  const ref = process.env.DECISIONS_BASE ?? "origin/main";
  const base = baseRecords(ref, history);
  if (base.kind === "found") problems.push(...immutabilityProblems(records, base.texts));
  for (const p of problems) console.error(`decisions:check ${p.path}: ${p.what}`);
  if (problems.length > 0) {
    console.error(`decisions:check FAILED — ${problems.length} problem(s) in ${records.length} record(s)`);
    return 1;
  }
  const immutability =
    base.kind === "unreachable"
      ? ` (immutability not checked: ${base.why})`
      : `, accepted bodies unchanged against ${base.commit.slice(0, 8)} (the merge-base with ${ref})`;
  console.log(
    `decisions:check ok — ${records.length} record(s) carry a valid status, every superseded_by resolves${immutability}`,
  );
  return 0;
}

process.exit(main());
