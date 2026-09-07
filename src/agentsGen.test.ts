import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENTS_BUDGET_BYTES,
  budgetProblem,
  commandDocProblems,
  NOTE,
  REGION,
  renderCommandsTable,
} from "./docs/agentsTable.js";
import { declaredRegions, replaceRegion } from "./docs/regions.js";

// The AGENTS.md Commands table is generated from package.json (which scripts
// exist) and project.json (what each does and when to run it); the check keeps
// the table current, every script described, and the file under its budget.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(new URL(p, `file://${root}`), "utf8");

describe("renderCommandsTable", () => {
  it("renders one row per script in package.json order, escaping pipes", () => {
    const table = renderCommandsTable(
      { verify: "npm run a", test: "vitest run" },
      { verify: { does: "The gate", when: "Before review | always" }, test: { does: "Tests", when: "Often" } },
    );
    expect(table.split("\n")).toEqual([
      "| Command | What it does | When |",
      "|---|---|---|",
      "| `npm run verify` | The gate | Before review \\| always |",
      "| `npm run test` | Tests | Often |",
    ]);
  });
});

describe("commandDocProblems", () => {
  it("a script without a description, and a description without a script, are both problems", () => {
    const problems = commandDocProblems(
      { a: "x", b: "y" },
      { a: { does: "A", when: "now" }, c: { does: "C", when: "never" } },
    );
    expect(problems).toEqual([
      'script "b" has no { does, when } entry in project.json → commands',
      'project.json describes "c", which is not a script in package.json',
    ]);
  });

  it("ignores $-prefixed keys and requires both fields", () => {
    expect(commandDocProblems({ a: "x" }, { $comment: "…", a: { does: "A" } })).toEqual([
      'script "a" has no { does, when } entry in project.json → commands',
    ]);
  });
});

describe("budgetProblem", () => {
  it("passes at the budget and names the overage past it", () => {
    expect(budgetProblem("x".repeat(AGENTS_BUDGET_BYTES))).toBeNull();
    expect(budgetProblem("x".repeat(AGENTS_BUDGET_BYTES + 1))).toMatch(/over its 15360-byte budget/);
    expect(budgetProblem("é".repeat(10), 10)).toMatch(/20 bytes/);
  });
});

describe("the repository's AGENTS.md", () => {
  const agents = read("AGENTS.md");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  const facts = JSON.parse(read("project.json")) as { commands: Record<string, { does: string; when: string }> };
  const docs = Object.fromEntries(Object.entries(facts.commands).filter(([k]) => !k.startsWith("$")));

  it("declares exactly the commands region, and its table is current", () => {
    expect(declaredRegions(agents)).toEqual([REGION]);
    const outcome = replaceRegion(agents, REGION, renderCommandsTable(pkg.scripts, docs), NOTE);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.changed, "run `npm run agents:gen`").toBe(false);
  });

  it("describes every root script and no phantom ones", () => {
    expect(commandDocProblems(pkg.scripts, docs)).toEqual([]);
  });

  it("stays under the budget", () => {
    expect(budgetProblem(agents)).toBeNull();
  });
});
