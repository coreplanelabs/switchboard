import { describe, expect, it } from "vitest";
import { renderDecisionIndex, type DecisionRecord } from "./decisions.js";

// docs/reference/specs/docs-site.md item 17 — the Design decisions index is rendered from
// the records' frontmatter, never typed.

const record = (file: string, front: Record<string, string>): DecisionRecord => ({
  path: `docs/decisions/${file}`,
  text: `---\n${Object.entries(front)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n# body\n`,
});

describe("renderDecisionIndex", () => {
  it("one row per record in id order, linking the file, with pattern, status and date from the frontmatter", () => {
    const out = renderDecisionIndex([
      record("0002-b.md", { title: "B decides", status: "accepted", date: "2026-09-08", pattern: "Strategy" }),
      record("0001-a.md", {
        title: "A decides",
        status: "implemented",
        date: "2026-09-01",
        pattern: "Ports & Adapters",
      }),
    ]);
    expect(out.split("\n")).toEqual([
      "| # | Decision | Pattern | Status | Date |",
      "|---|---|---|---|---|",
      "| 0001 | [A decides](../decisions/0001-a.md) | Ports & Adapters | implemented | 2026-09-01 |",
      "| 0002 | [B decides](../decisions/0002-b.md) | Strategy | accepted | 2026-09-08 |",
    ]);
  });

  it("a superseded record links forward to its successor, in either form the gate accepts; a record without a pattern reads —; pipes in a title are table-safe", () => {
    const out = renderDecisionIndex([
      record("0003-c.md", { title: "C | old", status: "superseded", date: "2026-09-02", superseded_by: "0004-d.md" }),
      record("0005-e.md", {
        title: "E",
        status: "superseded",
        date: "2026-09-03",
        superseded_by: "docs/decisions/0006-f.md",
      }),
      record("0007-g.md", {
        title: "G",
        status: "superseded",
        date: "2026-09-04",
        superseded_by: "docs/plans/2026-09-09-001-feat-h-plan.md",
      }),
    ]);
    expect(out.split("\n").slice(2)).toEqual([
      "| 0003 | [C \\| old](../decisions/0003-c.md) | — | superseded → [0004-d.md](../decisions/0004-d.md) | 2026-09-02 |",
      "| 0005 | [E](../decisions/0005-e.md) | — | superseded → [0006-f.md](../decisions/0006-f.md) | 2026-09-03 |",
      "| 0007 | [G](../decisions/0007-g.md) | — | superseded → [2026-09-09-001-feat-h-plan.md](../plans/2026-09-09-001-feat-h-plan.md) | 2026-09-04 |",
    ]);
  });

  it("ignores the directory README and anything outside docs/decisions/, and a record without frontmatter", () => {
    const out = renderDecisionIndex([
      { path: "docs/decisions/README.md", text: "---\ntitle: X\n---\n" },
      { path: "docs/plans/2026-09-08-001-feat-x-plan.md", text: "---\ntitle: P\nstatus: accepted\n---\n" },
      { path: "docs/decisions/0005-e.md", text: "# no frontmatter\n" },
    ]);
    expect(out.split("\n")).toHaveLength(2);
  });
});
