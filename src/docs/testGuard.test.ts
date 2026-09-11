import { describe, expect, it } from "vitest";
import { collectTestTitles } from "../../scripts/specs-check.mjs";
import {
  compareTestFile,
  countExpectCalls,
  formatTestGuard,
  isTestFile,
  testGuard,
  type ChangedTestFile,
  type TestFileSnapshot,
} from "./testGuard.js";

// The test guard (docs/reference/specs/specs-coverage.md item 6): a PR may
// remove or narrow a test only when the same PR changes a spec that covers
// that test's path. Two classes of line — `removed:` (class A, deterministic,
// fails the command) and `check:` (class B, heuristic, the reviewer disposes
// of it) — both silenced only by a covering spec change. The decision is pure:
// snapshots of each changed test file at the base and at the head, the diff's
// paths, the specs' coverage. Titles come from the same static parse
// `specs:check` binds proofs with, so the guard and the binding check agree
// on what a test is.

const snapshot = (source: string, path = "src/x.test.ts"): TestFileSnapshot => ({
  blocks: collectTestTitles(source, path),
  expectCalls: countExpectCalls(source),
});

const BASE = `
describe("thing", () => {
  it("adds", () => {
    expect(add(1, 2)).toBe(3);
    expect(add(0, 0)).toBe(0);
  });
  it("subtracts", () => {
    expect(sub(3, 1)).toBe(2);
  });
});
`;
const WITHOUT_SUBTRACTS = BASE.replace(/ {2}it\("subtracts"[\s\S]*?\n {2}\}\);\n/, "");

describe("isTestFile", () => {
  it("is a .test or .spec file in any of the script extensions", () => {
    for (const p of ["src/a.test.ts", "scripts/b.test.mjs", "web/src/c.spec.ts", "deploy/d.test.mts", "e.test.js"])
      expect(isTestFile(p), p).toBe(true);
  });

  it("is not a source file, a snapshot, a fixture or a doc", () => {
    for (const p of [
      "src/a.ts",
      "src/__snapshots__/a.test.ts.snap",
      "src/testing/fixtures.ts",
      "docs/x.md",
      "a.test.tsx",
    ])
      expect(isTestFile(p), p).toBe(false);
  });
});

describe("countExpectCalls", () => {
  it("counts every expect( call, whatever follows it", () => {
    expect(countExpectCalls(BASE)).toBe(3);
    expect(countExpectCalls("expect (x).toBe(1); await expect(p).resolves.toBe(2); expectTypeOf(x);")).toBe(2);
  });
});

describe("compareTestFile — what one changed test file lost between base and head", () => {
  describe("class A, removed: deterministic losses", () => {
    it("a deleted test file", () => {
      expect(compareTestFile(snapshot(BASE), null)).toEqual([{ kind: "removed", what: "the test file" }]);
    });

    it("an it whose title is gone from the file, with no new title added — named by its title path", () => {
      expect(compareTestFile(snapshot(BASE), snapshot(WITHOUT_SUBTRACTS))).toEqual([
        { kind: "removed", what: 'test "thing > subtracts"' },
        { kind: "check", what: "expect() calls 3 → 2" },
      ]);
    });

    it("a describe removed with its children names the describe and each child", () => {
      const head = `expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3);`;
      expect(compareTestFile(snapshot(BASE), snapshot(head))).toEqual([
        { kind: "removed", what: 'describe "thing"' },
        { kind: "removed", what: 'test "thing > adds"' },
        { kind: "removed", what: 'test "thing > subtracts"' },
      ]);
    });

    it("a skip, only or todo marker added to a test that existed at the base; one already there is not", () => {
      const base = snapshot(
        `it.skip("old", () => {}); it("a", () => {}); describe("d", () => { it("b", () => {}); });`,
      );
      const head = snapshot(
        `it.skip("old", () => {}); it.only("a", () => {}); describe.skip("d", () => { it.todo("b"); });`,
      );
      expect(compareTestFile(base, head)).toEqual([
        { kind: "removed", what: 'every test but "a" from the run — marked only' },
        { kind: "removed", what: 'describe "d" from the run — marked skip' },
        { kind: "removed", what: 'test "d > b" from the run — marked todo' },
      ]);
    });

    it("the x-prefixed aliases (xit, xdescribe, xtest) read as skip markers", () => {
      const base = snapshot(`it("a", () => {}); describe("d", () => { test("b", () => {}); });`);
      const head = snapshot(`xit("a", () => {}); xdescribe("d", () => { xtest("b", () => {}); });`);
      expect(compareTestFile(base, head)).toEqual([
        { kind: "removed", what: 'test "a" from the run — marked skip' },
        { kind: "removed", what: 'describe "d" from the run — marked skip' },
        { kind: "removed", what: 'test "d > b" from the run — marked skip' },
      ]);
    });

    it("a new test that arrives already skipped removes nothing — only a test the base ran can be taken out of the run", () => {
      const head = snapshot(`${BASE}\nit.todo("later");`);
      expect(compareTestFile(snapshot(BASE), head)).toEqual([]);
    });
  });

  describe("class B, check: heuristic signals the reviewer disposes of", () => {
    it("fewer expect() calls with every title intact", () => {
      const head = BASE.replace("    expect(add(0, 0)).toBe(0);\n", "");
      expect(compareTestFile(snapshot(BASE), snapshot(head))).toEqual([
        { kind: "check", what: "expect() calls 3 → 2" },
      ]);
    });

    it("a test retitled with its body unchanged is a rename to confirm, not a removal", () => {
      const head = BASE.replace('it("subtracts"', 'it("takes away"');
      expect(compareTestFile(snapshot(BASE), snapshot(head))).toEqual([
        { kind: "check", what: 'test "thing > subtracts" retitled "thing > takes away", body unchanged' },
      ]);
    });

    it("a describe retitled with its body unchanged is one rename line — its children moved with it and are not listed", () => {
      const head = BASE.replace('describe("thing"', 'describe("arithmetic"');
      expect(compareTestFile(snapshot(BASE), snapshot(head))).toEqual([
        { kind: "check", what: 'describe "thing" retitled "arithmetic", body unchanged' },
      ]);
    });

    it("a test retitled with a changed body is a title gone while another was added — a rename or a split", () => {
      const head = BASE.replace(
        'it("subtracts", () => {\n    expect(sub(3, 1)).toBe(2);',
        'it("takes away", () => {\n    expect(sub(4, 1)).toBe(3);',
      );
      expect(compareTestFile(snapshot(BASE), snapshot(head))).toEqual([
        {
          kind: "check",
          what: 'test "thing > subtracts" gone while "thing > takes away" was added in the same file — a rename or a split?',
        },
      ]);
    });

    it("titles pair off: with N gone and M added, min(N, M) are a rename or a split and the rest are removed", () => {
      // Two gone (a retitled-and-rewritten test, a deleted one), one added: the
      // rename and the deletion in one file still report the deletion.
      const head = BASE.replace(
        'it("adds", () => {\n    expect(add(1, 2)).toBe(3);',
        'it("sums", () => {\n    expect(add(2, 2)).toBe(4);',
      ).replace(/ {2}it\("subtracts"[\s\S]*?\n {2}\}\);\n/, "");
      expect(compareTestFile(snapshot(BASE), snapshot(head))).toEqual([
        {
          kind: "check",
          what: 'test "thing > adds" gone while "thing > sums" was added in the same file — a rename or a split?',
        },
        { kind: "removed", what: 'test "thing > subtracts"' },
        { kind: "check", what: "expect() calls 3 → 2" },
      ]);
    });

    it("a describe gone with its children while one title was added: one pairs off as a check, the children are removed", () => {
      const head = `it("top", () => { expect(1).toBe(1); expect(2).toBe(2); expect(3).toBe(3); });`;
      expect(compareTestFile(snapshot(BASE), snapshot(head))).toEqual([
        { kind: "check", what: 'describe "thing" gone while "top" was added in the same file — a rename or a split?' },
        { kind: "removed", what: 'test "thing > adds"' },
        { kind: "removed", what: 'test "thing > subtracts"' },
      ]);
    });

    it("a test moved verbatim under another describe is neither class", () => {
      const head = BASE.replace(
        '  it("subtracts", () => {\n    expect(sub(3, 1)).toBe(2);\n  });\n});',
        '});\ndescribe("other", () => {\n  it("subtracts", () => {\n    expect(sub(3, 1)).toBe(2);\n  });\n});',
      );
      expect(compareTestFile(snapshot(BASE), snapshot(head))).toEqual([]);
    });
  });

  it("a new test file has nothing to lose, whatever it contains", () => {
    expect(compareTestFile(null, snapshot(`it.skip("later", () => {});`))).toEqual([]);
  });

  it("a file that only adds tests and assertions has nothing to report", () => {
    const head = BASE.replace(
      '  it("subtracts"',
      '  it("multiplies", () => {\n    expect(mul(2, 3)).toBe(6);\n  });\n  it("subtracts"',
    ).replace("    expect(sub(3, 1)).toBe(2);", "    expect(sub(3, 1)).toBe(2);\n    expect(sub(1, 3)).toBe(-2);");
    expect(compareTestFile(snapshot(BASE), snapshot(head))).toEqual([]);
  });

  it("an unchanged file has nothing to report", () => {
    expect(compareTestFile(snapshot(BASE), snapshot(BASE))).toEqual([]);
  });
});

describe("testGuard — a line is allowed only when a spec covering the test file changes in the same diff", () => {
  const specs = [
    { path: "docs/reference/specs/a.md", headerPaths: ["src/core/a.ts", "src/core/a.test.ts"] },
    { path: "docs/reference/specs/core.md", headerPaths: ["src/core/"] },
    { path: "docs/reference/specs/b.md", headerPaths: ["src/b.ts"] },
  ];
  const removed: ChangedTestFile = {
    path: "src/core/a.test.ts",
    base: snapshot(BASE),
    head: snapshot(WITHOUT_SUBTRACTS),
  };
  const both = ["docs/reference/specs/a.md", "docs/reference/specs/core.md"];

  it("names the covering specs on each line and allows none of them when no such spec changed", () => {
    const result = testGuard([removed], ["src/core/a.test.ts", "src/core/a.ts"], specs);
    expect(result.testFiles).toBe(1);
    expect(result.findings).toEqual([
      { file: "src/core/a.test.ts", kind: "removed", what: 'test "thing > subtracts"', specs: both, allowed: false },
      { file: "src/core/a.test.ts", kind: "check", what: "expect() calls 3 → 2", specs: both, allowed: false },
    ]);
  });

  it("class A and class B lines alike are allowed when any spec covering the test file is among the changed paths", () => {
    const result = testGuard([removed], ["src/core/a.test.ts", "docs/reference/specs/core.md"], specs);
    expect(result.findings.map((f) => [f.kind, f.allowed])).toEqual([
      ["removed", true],
      ["check", true],
    ]);
  });

  it("a changed spec that does not cover the test file allows nothing", () => {
    const result = testGuard([removed], ["src/core/a.test.ts", "docs/reference/specs/b.md"], specs);
    expect(result.findings.map((f) => f.allowed)).toEqual([false, false]);
  });

  it("a test file no spec covers can never be allowed — the finding carries no spec", () => {
    const result = testGuard([{ ...removed, path: "src/orphan.test.ts" }], ["src/orphan.test.ts"], specs);
    expect(result.findings.map((f) => [f.specs, f.allowed])).toEqual([
      [[], false],
      [[], false],
    ]);
  });

  it("a deleted test file is a class A finding against the specs whose headers cover it", () => {
    const result = testGuard(
      [{ path: "src/core/a.test.ts", base: snapshot(BASE), head: null }],
      ["src/core/a.test.ts"],
      specs,
    );
    expect(result.findings).toEqual([
      { file: "src/core/a.test.ts", kind: "removed", what: "the test file", specs: both, allowed: false },
    ]);
  });

  it("files with nothing lost count as changed and produce no finding", () => {
    const grown: ChangedTestFile = {
      path: "src/core/a.test.ts",
      base: snapshot(BASE),
      head: snapshot(`${BASE}\nit("more", () => { expect(1).toBe(1); });`),
    };
    const fresh: ChangedTestFile = { path: "src/core/new.test.ts", base: null, head: snapshot(BASE) };
    expect(testGuard([grown, fresh], ["src/core/a.test.ts", "src/core/new.test.ts"], specs)).toEqual({
      testFiles: 2,
      findings: [],
    });
  });
});

describe("formatTestGuard — the lines the command prints and whether it passes", () => {
  const file = "src/core/a.test.ts";
  const a = "docs/reference/specs/a.md";
  const core = "docs/reference/specs/core.md";
  const removed = (allowed: boolean, specs = [a]) => ({
    file,
    kind: "removed" as const,
    what: 'test "thing > subtracts"',
    specs,
    allowed,
  });
  const check = (allowed: boolean, specs = [a]) => ({
    file,
    kind: "check" as const,
    what: "expect() calls 3 → 2",
    specs,
    allowed,
  });

  it("nothing lost: one ok line naming how many test files changed", () => {
    expect(formatTestGuard({ testFiles: 3, findings: [] })).toEqual({
      ok: true,
      lines: ["test-guard ok — 3 test file(s) changed, no verification removed without its spec"],
    });
  });

  it("class A unallowed: a `removed:` line naming the file, the loss and the spec(s) to change; the result fails", () => {
    expect(formatTestGuard({ testFiles: 1, findings: [removed(false, [a, core])] })).toEqual({
      ok: false,
      lines: [
        `test-guard: ${file} — removed: test "thing > subtracts" — covered by ${a}, ${core}; change it in this PR or restore the test`,
        "test-guard FAILED — 1 removal(s) without a spec change",
      ],
    });
  });

  it("class A on a test file no spec covers says so instead of naming a spec", () => {
    expect(formatTestGuard({ testFiles: 1, findings: [removed(false, [])] }).lines[0]).toBe(
      `test-guard: ${file} — removed: test "thing > subtracts" — no spec covers it; add its spec in this PR or restore the test`,
    );
  });

  it("class B unallowed: a `check:` line for the reviewer; the result still passes", () => {
    expect(formatTestGuard({ testFiles: 1, findings: [check(false)] })).toEqual({
      ok: true,
      lines: [
        `test-guard: ${file} — check: expect() calls 3 → 2`,
        "test-guard ok — 1 test file(s) changed, no verification removed without its spec",
      ],
    });
  });

  it("an allowed line of either class ends `— allowed by <spec>` and counts for nothing", () => {
    expect(formatTestGuard({ testFiles: 1, findings: [removed(true, [a, core]), check(true)] })).toEqual({
      ok: true,
      lines: [
        `test-guard: ${file} — removed: test "thing > subtracts" — allowed by ${a}, ${core}`,
        `test-guard: ${file} — check: expect() calls 3 → 2 — allowed by ${a}`,
        "test-guard ok — 1 test file(s) changed, no verification removed without its spec",
      ],
    });
  });

  it("the failing summary counts class A only", () => {
    const { ok, lines } = formatTestGuard({ testFiles: 2, findings: [removed(false), check(false), removed(true)] });
    expect(ok).toBe(false);
    expect(lines.at(-1)).toBe("test-guard FAILED — 1 removal(s) without a spec change");
  });
});
