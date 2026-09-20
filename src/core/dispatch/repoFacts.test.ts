import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_DOC_INDEX, renderRepoFacts } from "./repoFacts.js";

describe("the repository facts block (issue 2043)", () => {
  it("every index row's directory exists in the repository's own tree — the block is rendered from the docs index, never hand-written prose", () => {
    for (const fact of REPO_DOC_INDEX) {
      expect(existsSync(join(process.cwd(), dirname(fact.glob))), fact.glob).toBe(true);
    }
  });

  it("renders one line per row saying the file is a ship unit's ordinary docs edit, the ref named so the operator can read 'record NNNN' as a file", () => {
    const lines = renderRepoFacts();
    expect(lines).toHaveLength(REPO_DOC_INDEX.length);
    expect(lines[0]).toContain("docs/decisions/*.md");
    expect(lines[0]).toContain('"record NNNN" names one');
    expect(lines[1]).toContain("docs/plans/*.md");
    expect(lines[1]).toContain('"plan YYYY-MM-DD-NNN" names one');
    for (const line of lines) {
      expect(line).toContain("a ship unit edits like any other file");
      expect(line).toContain("never administrative state");
    }
  });
});
