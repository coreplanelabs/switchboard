import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PR_DESCRIPTION_CAPS } from "./core/prDescription.js";
import {
  allowedScopes,
  allowedTypes,
  BOT_SCOPES,
  checkPrTitle,
  migrationNoteProblems,
  nextMajor,
  renderPrTitleVocabulary,
  TITLE_MAX_LENGTH,
  VOCABULARY_PATH,
} from "./core/prTitle.mjs";
import PR_TITLE_VOCABULARY from "./core/prTitleVocabulary.json" with { type: "json" };

// The title gate's decision. A PR title is the squash commit's subject and the
// changelog line a reader gets, so the grammar is Conventional Commits, the
// allowed types are exactly the ones release-please-config.json maps to
// changelog sections, the allowed scopes are exactly the Areas the code map
// names, and a breaking title (`!`) needs its migration note in the tree.

const root = fileURLToPath(new URL("..", import.meta.url));
const readRoot = (path: string) => readFileSync(new URL(path, `file://${root}`), "utf8");
const config = JSON.parse(readRoot("release-please-config.json")) as unknown;
const TYPES = allowedTypes(config);
const SCOPES = allowedScopes(readRoot("docs/reference/code-map.md"));
const VOCAB = { types: TYPES, scopes: SCOPES };

describe("allowedTypes", () => {
  it("reads the types from the repository's release-please changelog sections", () => {
    expect(TYPES).toEqual(expect.arrayContaining(["feat", "fix", "docs", "refactor", "chore", "ci", "build", "test"]));
    // `style:` is what the formatter's own commits use; `revert` and `perf` are
    // release-please's other visible sections.
    expect(TYPES).toEqual(expect.arrayContaining(["style", "revert", "perf"]));
  });

  it("refuses a config without sections rather than allowing everything", () => {
    expect(() => allowedTypes({})).toThrow(/changelog-sections/);
  });
});

describe("allowedScopes", () => {
  it("reads the Scope column of the code map's Areas table", () => {
    const doc = [
      "# Code map",
      "",
      "## Areas",
      "",
      "| Area | Scope | Path | Spec |",
      "|---|---|---|---|",
      "| Orchestration | `dispatcher` | `src/core/dispatcher.ts` | [`run-loop.md`](specs/run-loop.md) |",
      "| Channels | `slack`, `http`, `mcp` | `src/channels/` | [`slack-channel.md`](specs/slack-channel.md) |",
      // A code span that is not a scope token (a bot's title, quoted) is prose, not a scope.
      "| The process | `process`, `deps`, `main` (release-please's `chore(main): release …`) | `.github/` | — |",
      "",
      "## Modules",
      "",
      "| Module | Owns | Rule |",
      "|---|---|---|",
      "| `src/x.ts` | `not-a-scope` | — |",
    ].join("\n");
    expect(allowedScopes(doc)).toEqual(["dispatcher", "slack", "http", "mcp", "process", "deps", "main"]);
  });

  it("the repository's code map names the scopes the changelog and the bots use", () => {
    // Product areas a reader knows from the docs …
    expect(SCOPES).toEqual(
      expect.arrayContaining(["dispatcher", "core", "config", "slack", "review", "deploy", "docs"]),
    );
    // … and the two titles no person writes: Dependabot's `chore(deps)` /
    // `ci(deps)` and release-please's `chore(main): release …`.
    expect(SCOPES).toEqual(expect.arrayContaining(["deps", "main"]));
    // The bots' scopes — the ones the length cap leaves alone — are exactly those two, and the map names them.
    expect([...BOT_SCOPES].sort()).toEqual(["deps", "main"]);
    for (const s of BOT_SCOPES) expect(SCOPES).toContain(s);
    expect(new Set(SCOPES).size, "a scope is listed once").toBe(SCOPES.length);
    for (const s of SCOPES) expect(s).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("refuses a code map without the column rather than allowing every scope", () => {
    expect(() => allowedScopes("# Code map\n\n## Areas\n\n| Area | Path |\n|---|---|\n| x | `y` |\n")).toThrow(
      /Scope column/,
    );
    expect(() => allowedScopes("# Code map\n")).toThrow(/Areas/);
  });
});

describe("the generated vocabulary (src/core/prTitleVocabulary.json)", () => {
  // The bot's image ships src/ and neither source file, so the submit tool
  // judges against this generated copy; `pr-title:check` is the CI gate for
  // drift, this test the unit proof that the committed file IS the tree's.
  it("is the render of the release config and the code map, byte for byte, and what the tool judges against", () => {
    expect(readRoot(VOCABULARY_PATH)).toBe(renderPrTitleVocabulary(config, readRoot("docs/reference/code-map.md")));
    expect(PR_TITLE_VOCABULARY.types).toEqual(TYPES);
    expect(PR_TITLE_VOCABULARY.scopes).toEqual(SCOPES);
  });

  it("names its generator first, so a reader never edits it by hand", () => {
    const rendered = JSON.parse(renderPrTitleVocabulary(config, readRoot("docs/reference/code-map.md"))) as Record<
      string,
      unknown
    >;
    expect(Object.keys(rendered)).toEqual(["$generated", "types", "scopes"]);
    expect(rendered.$generated).toMatch(/npm run pr-title:gen/);
  });
});

describe("checkPrTitle accepts", () => {
  it.each([
    ["feat: thread admission", { type: "feat", scope: null, breaking: false }],
    ["fix(resident): keep the cause on rethrow", { type: "fix", scope: "resident", breaking: false }],
    // The directory people reach for when a change spans src/core, an agent's
    // name, the config layers, the installer: areas as contributors say them.
    ["feat(core): one clock behind every stage", { type: "feat", scope: "core", breaking: false }],
    ["fix(review): the verdict names the head it read", { type: "fix", scope: "review", breaking: false }],
    ["feat(config): a thread may pin its effort", { type: "feat", scope: "config", breaking: false }],
    ["feat(init): the installer writes the profile", { type: "feat", scope: "init", breaking: false }],
    [
      "feat(authz)!: grants + restrict are the whole authorization config",
      { type: "feat", scope: "authz", breaking: true },
    ],
    ["chore(deps): bump vitest from 4.1.0 to 4.2.0", { type: "chore", scope: "deps", breaking: false }],
    ["ci(deps): bump actions/checkout from 6 to 7", { type: "ci", scope: "deps", breaking: false }],
    ["chore(main): release 0.2.0", { type: "chore", scope: "main", breaking: false }],
    ["style: format the tree with prettier", { type: "style", scope: null, breaking: false }],
    [
      "refactor(dispatcher): the run stage is named functions",
      { type: "refactor", scope: "dispatcher", breaking: false },
    ],
    ["revert: feat: thread admission", { type: "revert", scope: null, breaking: false }],
    ["docs: TypeScript 5.9 stays until vue-tsc runs on 7", { type: "docs", scope: null, breaking: false }],
  ])("%s", (title, expected) => {
    const v = checkPrTitle(title, VOCAB);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v).toMatchObject(expected);
  });

  it("trims surrounding whitespace before judging", () => {
    expect(checkPrTitle("  fix: trailing spaces  ", VOCAB).ok).toBe(true);
  });
});

describe("checkPrTitle rejects, naming the fix", () => {
  const reject = (title: string) => {
    const v = checkPrTitle(title, VOCAB);
    expect(v.ok, `expected "${title}" to be rejected`).toBe(false);
    return v.ok ? [] : v.problems;
  };

  it("an empty title", () => {
    expect(reject("")).toEqual(["the title is empty"]);
    expect(checkPrTitle(undefined, VOCAB).ok).toBe(false);
  });

  it("a title with no type", () => {
    expect(reject("authz step 1: config is native grants only")[0]).toMatch(/start with a type and a colon/);
  });

  it("an uppercase type", () => {
    expect(reject("Feat: shout")[0]).toMatch(/type must be lowercase/);
  });

  it("an unknown type, listing the allowed ones", () => {
    const [problem] = reject("feature: new thing");
    expect(problem).toMatch(/unknown type "feature"/);
    expect(problem).toContain("feat, fix");
  });

  it("a scope the code map does not name, listing the vocabulary and where it lives", () => {
    const [problem] = reject("feat(oss): phase 13 lands");
    expect(problem).toMatch(/unknown scope "oss"/);
    expect(problem).toContain("dispatcher");
    expect(problem).toContain("slack");
    expect(problem).toContain("docs/reference/code-map.md");
    // A plan name, a file's name or a subdirectory path is not an area of the
    // product: these are `process` or `docs`, or the area the path belongs to.
    for (const scope of ["readme", "site", "visuals"]) {
      expect(reject(`docs(${scope}): x`)[0]).toMatch(new RegExp(`unknown scope "${scope}"`));
    }
    expect(reject("fix(core/dispatcher): x")[0]).toMatch(/unknown scope "core\/dispatcher"/);
  });

  it("a scope problem and a type problem are both named", () => {
    const problems = reject("feature(readme): x");
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/unknown type/);
    expect(problems[1]).toMatch(/unknown scope/);
  });

  it("a missing space after the colon", () => {
    expect(reject("fix:no space")[0]).toMatch(/one space after the colon/);
  });

  it("an empty description", () => {
    expect(reject("fix: ")[0]).toMatch(/add a description|empty/);
    expect(reject("fix:")[0]).toMatch(/one space after the colon|add a description/);
  });

  it("a scope with spaces or capitals", () => {
    expect(reject("feat(Slack API): x")[0]).toMatch(/scope is lowercase/);
  });

  it("a trailing period on the description", () => {
    expect(reject("fix: stop here.")[0]).toMatch(/ends with a period/);
  });

  it("GitHub's Revert-button title, pointing at the revert type", () => {
    expect(reject('Revert "feat: thread admission"')[0]).toMatch(/revert: <the original title>/);
  });

  it("a WIP marker, pointing at draft PRs", () => {
    expect(reject("WIP: feat: half done")[0]).toMatch(/draft/);
    expect(reject("[WIP] feat: half done")[0]).toMatch(/draft/);
  });

  it("neither list can be widened by the title itself", () => {
    // A type or a scope is allowed only because its source names it.
    const vocab = { types: ["feat", "fix"], scopes: ["slack"] };
    expect(checkPrTitle("hotfix: x", vocab).ok).toBe(false);
    expect(checkPrTitle("hotfix: x", { ...vocab, types: [...vocab.types, "hotfix"] }).ok).toBe(true);
    expect(checkPrTitle("fix(web): x", vocab).ok).toBe(false);
    expect(checkPrTitle("fix(web): x", { ...vocab, scopes: [...vocab.scopes, "web"] }).ok).toBe(true);
  });
});

describe("the title is capped at 72 characters", () => {
  // The whole title — type, scope and description — is one changelog line and
  // one squash subject; git's subject convention and GitHub's commit list both
  // stop at 72, so past it the line is cut. The cap is a refusal naming the
  // count, never a truncation: the author cuts to one change, one clause.
  const fill = (prefix: string, n: number) => prefix + "x".repeat(n - prefix.length);

  it("is 72, and the submit tool's schema holds the title to the same number", () => {
    expect(TITLE_MAX_LENGTH).toBe(72);
    expect(PR_DESCRIPTION_CAPS.title).toBe(TITLE_MAX_LENGTH);
  });

  it("counts raw characters, a markdown link's target included — GitHub renders no markdown in a title, and the schema counts the same way", () => {
    const linked = `fix: [x](${"h".repeat(63)})`;
    expect(linked).toHaveLength(73);
    const v = checkPrTitle(linked, VOCAB);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems[0]).toMatch(/73 characters/);
    expect(checkPrTitle(`fix: [x](${"h".repeat(62)})`, VOCAB).ok).toBe(true);
  });

  it("a title at the cap passes; one character over is refused naming the count and the cap", () => {
    expect(checkPrTitle(fill("fix(resident): ", 72), VOCAB).ok).toBe(true);
    const v = checkPrTitle(fill("fix(resident): ", 73), VOCAB);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.problems).toHaveLength(1);
      expect(v.problems[0]).toMatch(/73 characters/);
      expect(v.problems[0]).toMatch(/at most 72/);
      expect(v.problems[0]).toMatch(/one change/);
    }
  });

  it("counts the whole line — the type and the scope spend the same budget as the description", () => {
    const description = "x".repeat(60);
    expect(checkPrTitle(`fix: ${description}`, VOCAB).ok).toBe(true);
    expect(checkPrTitle(`refactor(dispatcher): ${description}`, VOCAB).ok).toBe(false);
  });

  it("the titles this repository merges today are refused: a 175-character median is the shape the cap ends", () => {
    const merged =
      "fix(harness): the gate holds neither exit by type — an abort handed to it passes the hold as a reply does — the transport's landing tells a dropped write from a held one";
    const v = checkPrTitle(merged, VOCAB);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems[0]).toMatch(new RegExp(`${merged.length} characters`));
  });

  it("a length problem is reported beside a scope problem, not instead of it", () => {
    const v = checkPrTitle(fill("fix(oss): ", 90), VOCAB);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.problems.some((p) => /unknown scope "oss"/.test(p))).toBe(true);
      expect(v.problems.some((p) => /at most 72/.test(p))).toBe(true);
    }
  });

  it("the bots' titles are not held to it: Dependabot's and release-please's lines are theirs to write", () => {
    expect(
      checkPrTitle(
        "chore(deps): bump wrangler from 4.124.0 to 4.129.0 in the minor-and-patch group across 1 directory",
        VOCAB,
      ).ok,
    ).toBe(true);
    expect(checkPrTitle(fill("ci(deps): ", 100), VOCAB).ok).toBe(true);
    expect(checkPrTitle(fill("chore(main): release ", 100), VOCAB).ok).toBe(true);
    // The exemption is the scope's, not the type's: a person's chore is capped.
    expect(checkPrTitle(fill("chore(process): ", 73), VOCAB).ok).toBe(false);
  });

  it("a revert carries the original title and is judged by that title's own gate, not measured again", () => {
    expect(checkPrTitle(`revert: ${fill("fix(resident): ", 72)}`, VOCAB).ok).toBe(true);
  });

  it("the grammar's other problems keep their own words: an over-long title with a trailing period names both", () => {
    const v = checkPrTitle(`${fill("fix: ", 80)}.`, VOCAB);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.problems.some((p) => /ends with a period/.test(p))).toBe(true);
      expect(v.problems.some((p) => /at most 72/.test(p))).toBe(true);
    }
  });
});

describe("a breaking title needs its migration note", () => {
  it("nextMajor: a `!` bumps the major, from 0.x too (bump-minor-pre-major is off)", () => {
    expect(nextMajor("1.11.0")).toBe("2.0.0");
    expect(nextMajor("2.0.0")).toBe("3.0.0");
    expect(nextMajor("0.4.0")).toBe("1.0.0");
    expect(() => nextMajor("v1.2")).toThrow(/version/);
  });

  const doc = "# Migration notes\n\n## 2.0.0\n\nThe `grants` block …\n\n## 1.0.0\n\nOlder.\n";

  it("a `!` title passes when the notes carry a section for the release it will cut", () => {
    expect(migrationNoteProblems({ breaking: true, version: "1.11.0", migrationsDoc: doc })).toEqual([]);
  });

  it("a `!` title without its section is refused, naming the file and the heading to add", () => {
    const [problem] = migrationNoteProblems({ breaking: true, version: "2.0.0", migrationsDoc: doc });
    expect(problem).toContain("docs/reference/migrations.md");
    expect(problem).toContain("## 3.0.0");
    expect(migrationNoteProblems({ breaking: true, version: "1.11.0", migrationsDoc: undefined })).toHaveLength(1);
  });

  it("a second breaking title in the same cycle passes on the section the first one created — presence, not authorship", () => {
    // The check cannot tell whose lines are under the heading; CONTRIBUTING
    // asks each breaking PR to add its own, and review holds that line.
    const firstPrWroteIt = "# Migration notes\n\n## 2.0.0\n\nThe first PR's note.\n";
    expect(migrationNoteProblems({ breaking: true, version: "1.11.0", migrationsDoc: firstPrWroteIt })).toEqual([]);
  });

  it("a section heading is exact: `## 2.0.0`, not a mention in prose or a deeper heading", () => {
    const prose = "# Migration notes\n\nNothing yet; 2.0.0 will be the first.\n\n### 2.0.0\n";
    expect(migrationNoteProblems({ breaking: true, version: "1.11.0", migrationsDoc: prose })).toHaveLength(1);
  });

  it("a title without `!` needs nothing", () => {
    expect(migrationNoteProblems({ breaking: false, version: "1.11.0", migrationsDoc: undefined })).toEqual([]);
  });

  it("while the release config pins the next version (`release-as`), a `!` title is refused: it cannot cut the major it declares", () => {
    // Before the public launch the 1.x line moves by minors; a breaking cleanup
    // ships under the pinned minor with its note under that heading.
    const [problem, ...rest] = migrationNoteProblems({
      breaking: true,
      version: "1.13.0",
      migrationsDoc: doc,
      releaseAs: "1.14.0",
    });
    expect(rest).toEqual([]);
    expect(problem).toContain("1.14.0");
    expect(problem).toContain("release-please-config.json");
    expect(problem).toContain("drop the `!`");
    expect(problem).toContain("## 1.14.0");
  });

  it("the pin does not touch a title without `!`", () => {
    expect(
      migrationNoteProblems({ breaking: false, version: "1.13.0", migrationsDoc: doc, releaseAs: "1.14.0" }),
    ).toEqual([]);
  });

  it("the repository's pin, when set, is never behind the released version and never a major — the release PR itself carries pin == manifest", () => {
    // release-please's release PR bumps the manifest to the pinned version
    // before the release exists, so on that PR the two are equal and the suite
    // must stay green; a pin BEHIND the manifest is one release-please can no
    // longer cut. Removing a pin after its release is the owner's step.
    const config = JSON.parse(readRoot("release-please-config.json")) as { "release-as"?: string };
    const manifest = JSON.parse(readRoot(".release-please-manifest.json")) as Record<string, string>;
    const released = manifest["."];
    if (config["release-as"] === undefined) return;
    const [pinMajor, pinMinor, pinPatch] = config["release-as"].split(".").map(Number);
    const [relMajor, relMinor, relPatch] = released.split(".").map(Number);
    const behind =
      pinMajor < relMajor ||
      (pinMajor === relMajor && (pinMinor < relMinor || (pinMinor === relMinor && pinPatch < relPatch)));
    expect(
      behind,
      `release-as ${config["release-as"]} is behind the released ${released}: move or remove the pin`,
    ).toBe(false);
    expect(pinMajor, "the pin holds the 1.x line: a major is cut only after the public launch").toBe(relMajor);
  });

  it("the repository's notes: one `## <version>` per release, newest first, every heading a version", () => {
    const headings = readRoot("docs/reference/migrations.md")
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3).trim());
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(h).toMatch(/^\d+\.\d+\.\d+$/);
    const asNumbers = headings.map((h) => h.split(".").map(Number));
    for (let i = 1; i < asNumbers.length; i++) {
      const [a, b] = [asNumbers[i - 1], asNumbers[i]];
      const newerFirst = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
      expect(newerFirst, `${headings[i - 1]} should come before ${headings[i]}`).toBe(true);
    }
  });
});
