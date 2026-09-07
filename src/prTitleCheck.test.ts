import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allowedTypes, checkPrTitle } from "../scripts/check-pr-title.mjs";

// The title gate's decision. A PR title is the squash commit's subject and a
// changelog line, so the grammar is Conventional Commits and the allowed types
// are exactly the ones release-please-config.json maps to changelog sections.

const root = fileURLToPath(new URL("..", import.meta.url));
const config = JSON.parse(readFileSync(new URL("release-please-config.json", `file://${root}`), "utf8")) as unknown;
const TYPES = allowedTypes(config);

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

describe("checkPrTitle accepts", () => {
  it.each([
    ["feat: thread admission", { type: "feat", scope: null, breaking: false }],
    ["fix(runner): keep the cause on rethrow", { type: "fix", scope: "runner", breaking: false }],
    ["feat(api)!: drop the legacy permissions block", { type: "feat", scope: "api", breaking: true }],
    ["chore(deps): bump vitest from 4.1.0 to 4.2.0", { type: "chore", scope: "deps", breaking: false }],
    ["chore(main): release 0.2.0", { type: "chore", scope: "main", breaking: false }],
    ["style: format the tree with prettier", { type: "style", scope: null, breaking: false }],
    ["refactor(core/dispatcher): split the run loop", { type: "refactor", scope: "core/dispatcher", breaking: false }],
    ["revert: feat: thread admission", { type: "revert", scope: null, breaking: false }],
    ["docs: TypeScript 5.9 stays until vue-tsc runs on 7", { type: "docs", scope: null, breaking: false }],
  ])("%s", (title, expected) => {
    const v = checkPrTitle(title, TYPES);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v).toMatchObject(expected);
  });

  it("trims surrounding whitespace before judging", () => {
    expect(checkPrTitle("  fix: trailing spaces  ", TYPES).ok).toBe(true);
  });
});

describe("checkPrTitle rejects, naming the fix", () => {
  const reject = (title: string) => {
    const v = checkPrTitle(title, TYPES);
    expect(v.ok, `expected "${title}" to be rejected`).toBe(false);
    return v.ok ? [] : v.problems;
  };

  it("an empty title", () => {
    expect(reject("")).toEqual(["the title is empty"]);
    expect(checkPrTitle(undefined, TYPES).ok).toBe(false);
  });

  it("a title with no type", () => {
    expect(reject("authz U7 step 1: config is native grants only")[0]).toMatch(/start with a type and a colon/);
  });

  it("an uppercase type", () => {
    expect(reject("Feat: shout")[0]).toMatch(/type must be lowercase/);
  });

  it("an unknown type, listing the allowed ones", () => {
    const [problem] = reject("feature: new thing");
    expect(problem).toMatch(/unknown type "feature"/);
    expect(problem).toContain("feat, fix");
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

  it("the type list cannot be widened by the title itself", () => {
    // A type is allowed only because the release config names it.
    expect(checkPrTitle("hotfix: x", ["feat", "fix"]).ok).toBe(false);
    expect(checkPrTitle("hotfix: x", ["feat", "fix", "hotfix"]).ok).toBe(true);
  });
});
