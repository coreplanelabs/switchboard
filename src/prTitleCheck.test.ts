import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allowedScopes,
  allowedTypes,
  checkPrTitle,
  migrationNoteProblems,
  nextMajor,
} from "../scripts/check-pr-title.mjs";

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

  it("the repository's pin, when set, is ahead of the released version — a pin left behind after its release is cut fails here", () => {
    const config = JSON.parse(readRoot("release-please-config.json")) as { "release-as"?: string };
    const manifest = JSON.parse(readRoot(".release-please-manifest.json")) as Record<string, string>;
    const released = manifest["."];
    if (config["release-as"] === undefined) return;
    const [pinMajor, pinMinor, pinPatch] = config["release-as"].split(".").map(Number);
    const [relMajor, relMinor, relPatch] = released.split(".").map(Number);
    const ahead =
      pinMajor > relMajor ||
      (pinMajor === relMajor && (pinMinor > relMinor || (pinMinor === relMinor && pinPatch > relPatch)));
    expect(ahead, `release-as ${config["release-as"]} is not ahead of the released ${released}: remove the pin`).toBe(
      true,
    );
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
