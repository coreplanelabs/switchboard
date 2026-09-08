// The records gate: reads every record under docs/decisions/ and docs/plans/,
// reads their copies on the base branch, and reports through the pure rules in
// src/docs/records.ts (features/docs-site.md item 16).
//
//   npm run decisions:check                       # every record, against origin/main (locally and in CI)
//   DECISIONS_BASE=<ref> npm run decisions:check  # against another base, e.g. the branch a stacked PR targets
//
// Without a reachable base ref (a shallow clone) the immutability half is
// skipped and said so; the status half always runs.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { immutabilityProblems, RECORD_DIRS, statusProblems, type RecordText } from "../src/docs/records.js";

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

/**
 * Every record on the base: the ones the tree still has (so edits are caught)
 * and the ones it no longer has (so deletions are). Null when the ref is not
 * reachable, e.g. a shallow clone.
 */
function baseTexts(ref: string): Map<string, string> | null {
  let listed: string[];
  try {
    git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    listed = git("ls-tree", "-r", "--name-only", ref, "--", ...RECORD_DIRS)
      .split("\n")
      .filter((p) => p.endsWith(".md") && !p.endsWith("/README.md"));
  } catch {
    return null;
  }
  const base = new Map<string, string>();
  for (const path of listed) base.set(path, git("show", `${ref}:${path}`));
  return base;
}

function main(): number {
  const records = listRecords();
  const problems = statusProblems(records, (path) => existsSync(join(root, path)));
  const ref = process.env.DECISIONS_BASE ?? "origin/main";
  const base = baseTexts(ref);
  if (base !== null) problems.push(...immutabilityProblems(records, base));
  for (const p of problems) console.error(`decisions:check ${p.path}: ${p.what}`);
  if (problems.length > 0) {
    console.error(`decisions:check FAILED — ${problems.length} problem(s) in ${records.length} record(s)`);
    return 1;
  }
  const immutability =
    base === null
      ? ` (immutability not checked: ${ref} is not reachable here)`
      : `, accepted bodies unchanged against ${ref}`;
  console.log(
    `decisions:check ok — ${records.length} record(s) carry a valid status, every superseded_by resolves${immutability}`,
  );
  return 0;
}

process.exit(main());
