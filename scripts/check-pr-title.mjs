#!/usr/bin/env node
// A pull request's title becomes the squash commit's subject on `main` and,
// from there, a changelog line and a version bump: release-please reads the
// type (`feat` → minor, `fix` → patch, `!` → major) and groups the line under
// the section that type maps to. A title outside the grammar is a commit the
// release tooling cannot classify, so this check runs on every pull request
// as a required status.
//
// The grammar is Conventional Commits: `type(scope)!: description`, where the
// scope and the `!` are optional. The allowed types are read from
// release-please-config.json — the one place that says which types exist and
// where each lands in the changelog — so adding a type there is enough.
//
//   npm run check:pr-title -- "feat(slack): thread admission"   # one title
//   PR_TITLE="…" npm run check:pr-title                          # what CI does
//
// In the merge queue there is no pull request title (it was checked on the PR
// that entered the queue), so the check passes with a note.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** `type(scope)!: description` — scope and `!` optional. */
export const TITLE_GRAMMAR =
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9][a-z0-9._/-]*)\))?(?<breaking>!)?: (?<description>\S.*)$/;

/** The commit types release-please knows, in the order its config lists them. */
export function allowedTypes(releasePleaseConfig) {
  const sections = releasePleaseConfig["changelog-sections"];
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("release-please-config.json has no changelog-sections; the allowed types come from there");
  }
  return sections.map((s) => s.type);
}

/**
 * Pure: the verdict for one title. `ok: false` carries every problem found,
 * each phrased as what to change.
 */
export function checkPrTitle(rawTitle, types) {
  const title = (rawTitle ?? "").trim();
  if (title === "") return { ok: false, problems: ["the title is empty"] };

  const m = TITLE_GRAMMAR.exec(title);
  if (!m || !m.groups) return { ok: false, problems: [diagnose(title, types)] };

  const { type, scope, breaking, description } = m.groups;
  const problems = [];
  if (!types.includes(type)) problems.push(`unknown type "${type}" — use one of: ${types.join(", ")}`);
  if (/\.$/.test(description)) problems.push("the description ends with a period; drop it (it is a commit subject)");
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, type, scope: scope ?? null, breaking: breaking === "!", description };
}

/** Why a title misses the grammar, in terms of the one thing to fix. */
function diagnose(title, types) {
  const list = types.join(", ");
  if (/^\[?(wip|draft)\b/i.test(title))
    return `drop the "${title.split(/[\s\]:]/)[0]}" marker; mark the PR as a draft instead`;
  if (/^Revert "/.test(title))
    return 'a revert is titled `revert: <the original title>` (GitHub\'s Revert button writes `Revert "…"`)';
  if (!/^[a-z]/.test(title)) return `the type must be lowercase, one of: ${list}`;
  if (!/^[a-z]+(\([^)]*\))?!?:/.test(title))
    return `start with a type and a colon — \`type: description\` or \`type(scope): description\` — where type is one of: ${list}`;
  if (/^[a-z]+\([^)]*[^a-z0-9._/)-][^)]*\)/.test(title) || /^[a-z]+\([^a-z0-9]/.test(title)) {
    return "the scope is lowercase letters, digits and . _ / - inside the parentheses, like `feat(slack): …`";
  }
  if (/^[a-z]+(\([^)]*\))?!?:\s*$/.test(title)) return "add a description after the colon";
  if (/^[a-z]+(\([^)]*\))?!?:\S/.test(title)) return "put exactly one space after the colon, then the description";
  return `the title does not match \`type(scope)!: description\` with type one of: ${list}`;
}

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

  let types;
  try {
    types = allowedTypes(JSON.parse(readFileSync("release-please-config.json", "utf8")));
  } catch (err) {
    console.error(`check:pr-title — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const verdict = checkPrTitle(title, types);
  if (verdict.ok) {
    const scope = verdict.scope ? `(${verdict.scope})` : "";
    console.log(`check:pr-title ok — ${verdict.type}${scope}${verdict.breaking ? "!" : ""}: ${verdict.description}`);
    return;
  }
  console.error(`check:pr-title FAILED — "${title.trim()}"`);
  for (const p of verdict.problems) console.error(`  ${p}`);
  console.error("  The title becomes the squash commit and a changelog line; see CONTRIBUTING.md → Pull requests.");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
