#!/usr/bin/env node
// A pull request's title becomes the squash commit's subject on `main` and,
// from there, a changelog line and a version bump: release-please reads the
// type (`feat` → minor, `fix` → patch, `!` → major) and groups the line under
// the section that type maps to. The squash commit carries nothing but the
// title, so the title IS the line a reader gets. A title outside the grammar
// is a commit the release tooling cannot classify; a scope outside the code
// map is a line the reader cannot place; a breaking title without its
// migration note is a major version nobody can follow. This check runs on
// every pull request as a required status.
//
// The grammar is Conventional Commits: `type(scope)!: description`, where the
// scope and the `!` are optional. Each list has one source:
//   - types: release-please-config.json — the one place that says which types
//     exist and where each lands in the changelog;
//   - scopes: the Scope column of the Areas table in docs/reference/code-map.md
//     — the product's areas as the docs name them, plus the two scopes the
//     bots write (`deps`, `main`);
//   - a `!` title: docs/reference/migrations.md carries a `## <version>`
//     section for the major the title will cut (package.json's version, major
//     + 1 — bump-minor-pre-major is off in the release config).
//
//   npm run check:pr-title -- "feat(slack): thread admission"   # one title
//   PR_TITLE="…" npm run check:pr-title                          # what CI does
//
// In the merge queue there is no pull request title (it was checked on the PR
// that entered the queue), so the check passes with a note.

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** `type(scope)!: description` — scope and `!` optional. */
export const TITLE_GRAMMAR =
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9][a-z0-9._/-]*)\))?(?<breaking>!)?: (?<description>\S.*)$/;

export const CODE_MAP_PATH = "docs/reference/code-map.md";
export const MIGRATIONS_PATH = "docs/reference/migrations.md";

/** The commit types release-please knows, in the order its config lists them. */
export function allowedTypes(releasePleaseConfig) {
  const sections = releasePleaseConfig["changelog-sections"];
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("release-please-config.json has no changelog-sections; the allowed types come from there");
  }
  return sections.map((s) => s.type);
}

/** One scope, as the grammar spells it — the whole code span, nothing else in it. */
const SCOPE_TOKEN = /^[a-z0-9][a-z0-9._/-]*$/;

/**
 * The scopes the code map names: every code span in the Scope column of the
 * table under `## Areas` that is a scope token, in table order. Prose in a
 * cell (why a scope exists, a bot's title quoted in backticks) is ignored.
 */
export function allowedScopes(codeMapMarkdown) {
  const lines = codeMapMarkdown.split("\n");
  const start = lines.findIndex((l) => /^## Areas\s*$/.test(l));
  if (start < 0) throw new Error(`${CODE_MAP_PATH} has no "## Areas" section; the allowed scopes come from its table`);
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  const section = lines.slice(start + 1, end < 0 ? lines.length : end);
  const header = section.findIndex((l) => /^\|/.test(l));
  if (header < 0) throw new Error(`${CODE_MAP_PATH}: the Areas section has no table`);
  const columns = cells(section[header]);
  const scopeColumn = columns.findIndex((c) => c === "Scope");
  if (scopeColumn < 0)
    throw new Error(`${CODE_MAP_PATH}: the Areas table has no Scope column; the allowed scopes come from it`);
  const scopes = [];
  // A well-formed table: the `|---|` separator sits at header + 1 (prettier keeps it so), rows follow.
  for (const line of section.slice(header + 2)) {
    if (!/^\|/.test(line)) break;
    const cell = cells(line)[scopeColumn] ?? "";
    for (const m of cell.matchAll(/`([^`]+)`/g)) {
      if (SCOPE_TOKEN.test(m[1]) && !scopes.includes(m[1])) scopes.push(m[1]);
    }
  }
  if (scopes.length === 0) throw new Error(`${CODE_MAP_PATH}: the Scope column names no scope`);
  return scopes;
}

/** A Markdown table row's cells, trimmed. */
function cells(row) {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Pure: the verdict for one title against the vocabulary — `types` from the
 * release config, `scopes` from the code map. `ok: false` carries every
 * problem found, each phrased as what to change.
 */
export function checkPrTitle(rawTitle, { types, scopes }) {
  const title = (rawTitle ?? "").trim();
  if (title === "") return { ok: false, problems: ["the title is empty"] };

  const m = TITLE_GRAMMAR.exec(title);
  if (!m || !m.groups) return { ok: false, problems: [diagnose(title, types)] };

  const { type, scope, breaking, description } = m.groups;
  const problems = [];
  if (!types.includes(type)) problems.push(`unknown type "${type}" — use one of: ${types.join(", ")}`);
  if (scope !== undefined && !scopes.includes(scope)) {
    problems.push(
      `unknown scope "${scope}" — use one of: ${scopes.join(", ")} (the Areas in ${CODE_MAP_PATH}), or no scope for a tree-wide change`,
    );
  }
  if (/\.$/.test(description)) problems.push("the description ends with a period; drop it (it is a commit subject)");
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, type, scope: scope ?? null, breaking: breaking === "!", description };
}

/** The version a breaking change releases as: the next major (the release config leaves bump-minor-pre-major off). */
export function nextMajor(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!m) throw new Error(`"${version}" is not a version (expected major.minor.patch)`);
  return `${Number(m[1]) + 1}.0.0`;
}

/**
 * Pure: a `!` title needs a `## <next major>` section in the migration notes;
 * anything else needs nothing. Presence is the whole test — the first
 * breaking PR of a cycle creates the section, later ones add their lines to
 * it, and the check cannot tell whose lines are there. `migrationsDoc` is the
 * notes file's text, or undefined when the file does not exist.
 */
export function migrationNoteProblems({ breaking, version, migrationsDoc }) {
  if (!breaking) return [];
  const heading = `## ${nextMajor(version)}`;
  const present = (migrationsDoc ?? "").split("\n").some((l) => l.trim() === heading);
  if (present) return [];
  return [
    `a breaking change (\`!\`) needs its migration note: add a \`${heading}\` section to ${MIGRATIONS_PATH} — the release this title will cut — saying what an operator changes`,
  ];
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

  let vocabulary;
  let version;
  try {
    vocabulary = {
      types: allowedTypes(JSON.parse(readFileSync("release-please-config.json", "utf8"))),
      scopes: allowedScopes(readFileSync(CODE_MAP_PATH, "utf8")),
    };
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
