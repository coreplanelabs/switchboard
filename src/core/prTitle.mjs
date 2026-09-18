// The PR title gate's predicate (docs/reference/specs/release-and-deploy.md
// item 22). A pull request's title becomes the squash commit's subject on
// `main` and, from there, a changelog line and a version bump: release-please
// reads the type (`feat` → minor, `fix` → patch, `!` → major) and groups the
// line under the section that type maps to. A title outside the grammar is a
// commit the release tooling cannot classify; a scope outside the code map is
// a line the reader cannot place.
//
// Two callers judge with this one module, so they can never disagree: the CI
// gate (scripts/check-pr-title.mjs, `npm run check:pr-title`, the required
// `title` status) and the `submit_pr_description` tool's schema
// (src/core/prDescription.ts), which refuses a title the gate would refuse
// while the run can still cut and resubmit. Plain JS with no dependencies
// because the gate runs with Node alone, before any install.
//
// The grammar is Conventional Commits: `type(scope)!: description`, where the
// scope and the `!` are optional, and the whole line is at most 72 characters:
// git's subject convention and the point past which GitHub's commit list cuts
// a subject. The cap is a refusal naming the count, never a truncation. It
// holds what people and agents write; the bots' scopes (`deps`, `main`) write
// their own lines and are left alone, and a `revert:` carries a title already
// judged. Each list has one source:
//   - types: release-please-config.json — the one place that says which types
//     exist and where each lands in the changelog;
//   - scopes: the Scope column of the Areas table in docs/reference/code-map.md
//     — the product's areas as the docs name them, plus the two scopes the
//     bots write (`deps`, `main`).
// The bot's image carries neither file, so both lists are generated into
// src/core/prTitleVocabulary.json (`npm run pr-title:gen`; `pr-title:check`
// fails the build when it drifts), and that file is what every caller hands
// `checkPrTitle` — this module stays pure so the generator can import it on a
// tree where the file does not exist yet. Typed by JSDoc rather than a
// `.d.mts` twin: tsc skips a JS file a declaration file shadows, and this one
// must reach `dist/` (`allowJs`; `check:dist` proves it did).
//   - a `!` title: docs/reference/migrations.md carries a `## <version>`
//     section for the major the title will cut (package.json's version, major
//     + 1 — bump-minor-pre-major is off in the release config); while the
//     release config pins the next version (`release-as`), no title may
//     carry `!` at all — the line moves by minors until the public launch.
//     Only the gate reads those files, so only the gate judges this.

/**
 * The two lists a title is judged against: types from the release config,
 * scopes from the code map.
 * @typedef {{ readonly types: readonly string[]; readonly scopes: readonly string[] }} PrTitleVocabulary
 */
/**
 * One title's verdict: the parts of a good line, or every problem found.
 * @typedef {{ ok: true; type: string; scope: string | null; breaking: boolean; description: string } | { ok: false; problems: string[] }} PrTitleVerdict
 */

/** `type(scope)!: description` — scope and `!` optional. */
export const TITLE_GRAMMAR =
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9][a-z0-9._/-]*)\))?(?<breaking>!)?: (?<description>\S.*)$/;

export const CODE_MAP_PATH = "docs/reference/code-map.md";
export const MIGRATIONS_PATH = "docs/reference/migrations.md";
export const RELEASE_CONFIG_PATH = "release-please-config.json";
/** The generated vocabulary — the two lists above, as the tree yields them. */
export const VOCABULARY_PATH = "src/core/prTitleVocabulary.json";

/** The most characters a title may run to, the whole line counted — git's
 *  subject convention and where GitHub's commit list cuts a subject. The
 *  submit tool's cap table (`PR_DESCRIPTION_CAPS.title`) reads this number. */
export const TITLE_MAX_LENGTH = 72;

/** The scopes only bots write — Dependabot's `chore(deps)` / `ci(deps)` and
 *  release-please's `chore(main): release …` — as the code map's Areas table
 *  names them. Their titles are theirs to write, so the cap leaves them alone;
 *  every other rule still applies. */
export const BOT_SCOPES = ["deps", "main"];

/**
 * The commit types release-please knows, in the order its config lists them.
 * @param {unknown} releasePleaseConfig
 * @returns {string[]}
 */
export function allowedTypes(releasePleaseConfig) {
  const sections = releasePleaseConfig["changelog-sections"];
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error(`${RELEASE_CONFIG_PATH} has no changelog-sections; the allowed types come from there`);
  }
  return sections.map((s) => s.type);
}

/** One scope, as the grammar spells it — the whole code span, nothing else in it. */
const SCOPE_TOKEN = /^[a-z0-9][a-z0-9._/-]*$/;

/**
 * The scopes the code map names: every code span in the Scope column of the
 * table under `## Areas` that is a scope token, in table order. Prose in a
 * cell (why a scope exists, a bot's title quoted in backticks) is ignored.
 * @param {string} codeMapMarkdown
 * @returns {string[]}
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
  /** @type {string[]} */
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

/**
 * A Markdown table row's cells, trimmed.
 * @param {string} row
 * @returns {string[]}
 */
function cells(row) {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/** What the generated vocabulary file says about itself: the first key a reader sees. */
const VOCABULARY_NOTE = `generated by \`npm run pr-title:gen\` from ${RELEASE_CONFIG_PATH} (types) and the Areas table in ${CODE_MAP_PATH} (scopes) — do not edit by hand`;

/**
 * Pure: the vocabulary file's text for the tree's two sources — what
 * `pr-title:gen` writes and `pr-title:check` expects byte for byte.
 * @param {unknown} releasePleaseConfig
 * @param {string} codeMapMarkdown
 * @returns {string}
 */
export function renderPrTitleVocabulary(releasePleaseConfig, codeMapMarkdown) {
  const out = {
    $generated: VOCABULARY_NOTE,
    types: allowedTypes(releasePleaseConfig),
    scopes: allowedScopes(codeMapMarkdown),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Pure: the verdict for one title against the vocabulary — `types` from the
 * release config, `scopes` from the code map (the generated file's lists, or
 * a test's own). `ok: false` carries every problem found, each phrased as
 * what to change.
 * @param {string | null | undefined} rawTitle
 * @param {PrTitleVocabulary} vocabulary
 * @returns {PrTitleVerdict}
 */
export function checkPrTitle(rawTitle, vocabulary) {
  const { types, scopes } = vocabulary;
  const title = (rawTitle ?? "").trim();
  if (title === "") return { ok: false, problems: ["the title is empty"] };

  const m = TITLE_GRAMMAR.exec(title);
  if (!m || !m.groups) return { ok: false, problems: [diagnose(title, types)] };

  const { type, scope, breaking, description } = m.groups;
  /** @type {string[]} */
  const problems = [];
  if (!types.includes(type)) problems.push(`unknown type "${type}" — use one of: ${types.join(", ")}`);
  if (scope !== undefined && !scopes.includes(scope)) {
    problems.push(
      `unknown scope "${scope}" — use one of: ${scopes.join(", ")} (the Areas in ${CODE_MAP_PATH}), or no scope for a tree-wide change`,
    );
  }
  if (/\.$/.test(description)) problems.push("the description ends with a period; drop it (it is a commit subject)");
  const exemptFromCap = type === "revert" || (scope !== undefined && BOT_SCOPES.includes(scope));
  if (!exemptFromCap && title.length > TITLE_MAX_LENGTH) {
    problems.push(
      `the title is ${title.length} characters; at most ${TITLE_MAX_LENGTH} — one change, one clause, present tense; the PR body carries the rest`,
    );
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, type, scope: scope ?? null, breaking: breaking === "!", description };
}

/**
 * The version a breaking change releases as: the next major (the release config leaves bump-minor-pre-major off).
 * @param {string} version
 * @returns {string}
 */
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
 *
 * While the release config pins the next version (`release-as`), a `!` title
 * is refused outright: the pin means the line moves by minors — before the
 * public launch the 1.x line is not spent on majors — and a title that
 * declares a major it cannot cut would put a BREAKING CHANGES entry under a
 * minor. The change ships without the `!`, its note under the pinned version's
 * heading.
 * @param {{ breaking: boolean; version: string; migrationsDoc?: string; releaseAs?: string }} input
 * @returns {string[]}
 */
export function migrationNoteProblems(input) {
  const { breaking, version, migrationsDoc, releaseAs } = input;
  if (!breaking) return [];
  if (releaseAs !== undefined) {
    return [
      `the next release is pinned to ${releaseAs} in ${RELEASE_CONFIG_PATH} (\`release-as\`: no major before the public launch): drop the \`!\` and put the note under \`## ${releaseAs}\` in ${MIGRATIONS_PATH}`,
    ];
  }
  const heading = `## ${nextMajor(version)}`;
  const present = (migrationsDoc ?? "").split("\n").some((l) => l.trim() === heading);
  if (present) return [];
  return [
    `a breaking change (\`!\`) needs its migration note: add a \`${heading}\` section to ${MIGRATIONS_PATH} — the release this title will cut — saying what an operator changes`,
  ];
}

/**
 * Why a title misses the grammar, in terms of the one thing to fix.
 * @param {string} title
 * @param {readonly string[]} types
 * @returns {string}
 */
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
