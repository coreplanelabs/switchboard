import { describe, expect, it } from "vitest";
import {
  CONTRACT_HEADING,
  CONTRACT_SECTION_HEADINGS,
  DEFAULT_CONTRACT_MAX_CHARS,
  GUARDS,
  contractFromPlan,
  contractFromTask,
  itemNumbersNamed,
  parsePlanUnit,
  parseSpecItem,
  parseValidationRows,
  renderContract,
  resolveSpecRow,
  specItemRefs,
  type ChildContract,
} from "./contract.js";

// Feature: docs/reference/specs/agent-ship.md item 13 — the child contract. A
// coding child started for a plan unit is handed one typed object (the unit's
// section verbatim, the spec rows it names with their proof bindings, the
// repository's agent rules, the guard names) rendered under fixed headings, and
// the review child checks the diff against the same object. The module is
// pure: the plan and the specs arrive as text, nothing here reads a disk or
// the network.

const PLAN = `---
title: Fixture program - Plan
status: proposed
---

# Fixture program - Plan

## Implementation Units

### U10. Warm the cache on wake

- **Goal**: A wake never starts cold.
- **Requirements**: none
- **Dependencies**: none.
- **Files**: \`src/execution/wake.ts\` (+ \`.test.ts\`); \`docs/reference/specs/resident-repos.md\` items 3 and 7; \`docs/reference/specs/execution.md\` item 22 (the timeout); \`agent-ship.md\` items 4–6.
- **Approach**:
  1. Read the row and decide from the disk: a recorded archive whose bytes match the row is restored, a missing or short one is rebuilt from the mirror, and the decision is written back to the row before any container work starts.
  2. Restore the archive (spec item 9); the restore judged by bytes stays the DO method's job, and a restore the runtime replacement interrupts is degraded and retried, never reported down.
  3. Warm the build in the same step, so the first attach after a wake finds the tree built and the dependency store attached.
- **Patterns to follow**: the refresh plan.
- **Test scenarios**:
  - a cold wake restores from the archive;
  - a warm wake is a no-op.
- **Verification**: \`npm test\` green.

### U11. Retire the alarm

- **Goal**: No lifecycle timer exists.
- **Files**: \`src/execution/alarm.ts\`.
- **Test scenarios**: a source scan finds no \`setAlarm\`.

---

## Verification Contract

- \`npm test\` green.
`;

/** Item 3's text, long enough that dropping it saves more than the placeholder costs. */
const THIRD =
  "3. **Third**: the third item's text, which runs on: the mirror is fetched under the lock, the tree is reset to the row's sha, the deps key is compared with the lockfile's, a mismatch installs before the build, and the row records each step so a retry resumes where the last attempt stopped instead of starting over.";

const RESIDENT_SPEC = `# Resident repo environments

One always-warm service per onboarded repo.

- **Code**: \`src/execution/resident.ts\`
- **Tests**: \`src/execution/resident.test.ts\`

## Behavior

1. **First**: text one.
2. **Second**: text two
   continues on a second line.
${THIRD}
4. **Fourth**: unrelated.
7. **Seventh**: a wake restores the archive.

## Roadmap (gaps)

- \`[gap]\` something later

## Validation criteria

| Criterion | Proof |
|---|---|
| 3: the third holds | \`[unit]\` \`src/execution/resident.test.ts::third::holds\` |
| Wake restores the archive (item 7) | \`[unit]\` \`src/execution/wake.test.ts::wake::restores\` |
| Items 2–3 hold together | \`[unit]\` \`src/execution/resident.test.ts::pair::*\` |
| Nothing about any item | \`[agent]\` do the thing and look |
`;

const SHIP_SPEC = `# Agent: ship

## Behavior

4. **Round 0**: the PR gate end to end — the coding child implements, pushes, and submits its description; the pipeline reuses the coding PR post-step.
5. **Review rounds**: run on a pinned head through the extracted units; a verdict always covers the full diff against base.
6. **Findings**: typed artifacts, validated fail-closed per finding; fix rounds record one disposition per finding.
9. **LGTM**: merge-ready, never merged — merge-ready stands on the POSTED approval, and no merge endpoint is reachable from any ship code path.

## Validation criteria

| Criterion | Proof |
|---|---|
| Round 0 opens the PR | \`[unit]\` \`src/core/dispatcher.test.ts::agent:ship (pipeline)::LGTM round 1…\` |
`;

const SPECS: Record<string, string> = { "resident-repos.md": RESIDENT_SPEC, "agent-ship.md": SHIP_SPEC };
const readSpec = (name: string) => SPECS[name];

const RULES = {
  file: "AGENTS.md",
  text: [
    "# Agent rules",
    "",
    "Run only what the Commands table names.",
    "The spec says what should be true; a failing test, then the code; `npm run fix`, then `npm run verify`.",
    "Never hand-edit a generated file or region; the spec follows the code, never the reverse; tests move with code.",
  ].join("\n"),
};

function u10(): ChildContract {
  return contractFromPlan({
    planMarkdown: PLAN,
    unitId: "U10",
    readSpec,
    agentRules: RULES,
    rebase: { branch: "plan/fixture/u10-warm-the-cache", onto: "main" },
  });
}

describe("parsePlanUnit — a unit is its `### U<n>.` heading to the next heading, verbatim", () => {
  it("reads the id, the title and the section, and stops at the next `###` heading", () => {
    const unit = parsePlanUnit(PLAN, "U10")!;
    expect(unit.id).toBe("U10");
    expect(unit.title).toBe("Warm the cache on wake");
    expect(unit.section.startsWith("### U10. Warm the cache on wake\n")).toBe(true);
    expect(unit.section).toContain("- **Verification**: `npm test` green.");
    expect(unit.section).not.toContain("U11");
    expect(unit.section.endsWith("\n")).toBe(false);
  });

  it("stops at a `##` heading too, and drops the thematic break that separates the last unit from it", () => {
    const unit = parsePlanUnit(PLAN, "U11")!;
    expect(unit.section).toContain("- **Test scenarios**: a source scan finds no `setAlarm`.");
    expect(unit.section).not.toContain("---");
    expect(unit.section).not.toContain("Verification Contract");
  });

  it("carries the plan's bullet keys with their bodies, multi-line bullets whole", () => {
    const unit = parsePlanUnit(PLAN, "U10")!;
    expect(Object.keys(unit.bullets)).toEqual([
      "Goal",
      "Requirements",
      "Dependencies",
      "Files",
      "Approach",
      "Patterns to follow",
      "Test scenarios",
      "Verification",
    ]);
    expect(unit.bullets.Goal).toBe("A wake never starts cold.");
    expect(unit.bullets.Approach.startsWith("1. Read the row and decide from the disk:")).toBe(true);
    expect(unit.bullets.Approach).toContain("\n2. Restore the archive (spec item 9);");
    expect(unit.bullets.Approach.endsWith("the dependency store attached.")).toBe(true);
    expect(unit.bullets["Test scenarios"]).toBe("- a cold wake restores from the archive;\n- a warm wake is a no-op.");
  });

  it("a unit the plan does not have is undefined", () => {
    expect(parsePlanUnit(PLAN, "U99")).toBeUndefined();
    expect(parsePlanUnit("no units here", "U10")).toBeUndefined();
  });
});

describe("specItemRefs — the spec rows a unit names, `<spec>.md item(s) …`, once each in order", () => {
  it("reads path-prefixed, bare and backticked spec names, comma/and lists, en-dash ranges, and a parenthetical after the number", () => {
    const unit = parsePlanUnit(PLAN, "U10")!;
    expect(specItemRefs(unit.section)).toEqual([
      { spec: "resident-repos.md", item: 3 },
      { spec: "resident-repos.md", item: 7 },
      { spec: "execution.md", item: 22 },
      { spec: "agent-ship.md", item: 4 },
      { spec: "agent-ship.md", item: 5 },
      { spec: "agent-ship.md", item: 6 },
      { spec: "agent-ship.md", item: 9 },
    ]);
  });

  it("a bare `spec item N` is attributed to the nearest preceding spec named in the section; none preceding → no row", () => {
    expect(specItemRefs("Fix `resident-repos.md` item 5, then the restore (spec item 9).")).toEqual([
      { spec: "resident-repos.md", item: 5 },
      { spec: "resident-repos.md", item: 9 },
    ]);
    expect(specItemRefs("the restore judged by bytes (spec item 61) stays")).toEqual([]);
  });

  it("a markdown link to a spec counts; a file that is not a spec (README.md, AGENTS.md) never does", () => {
    expect(specItemRefs("see [execution.md](../reference/specs/execution.md) item 13 and `AGENTS.md` item 2")).toEqual([
      { spec: "execution.md", item: 13 },
    ]);
  });

  it("names the same row once", () => {
    expect(specItemRefs("`execution.md` items 6, 9 and `execution.md` item 9")).toEqual([
      { spec: "execution.md", item: 6 },
      { spec: "execution.md", item: 9 },
    ]);
  });
});

describe("parseSpecItem / parseValidationRows / itemNumbersNamed — a spec's numbered items and the rows that name them", () => {
  it("an item is its `N.` line to the next item or heading, continuation lines included", () => {
    expect(parseSpecItem(RESIDENT_SPEC, 2)).toBe("2. **Second**: text two\n   continues on a second line.");
    expect(parseSpecItem(RESIDENT_SPEC, 7)).toBe("7. **Seventh**: a wake restores the archive.");
    expect(parseSpecItem(RESIDENT_SPEC, 5)).toBeUndefined();
  });

  it("the validation table's rows, header and separator excluded", () => {
    const rows = parseValidationRows(RESIDENT_SPEC);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      criterion: "3: the third holds",
      proof: "`[unit]` `src/execution/resident.test.ts::third::holds`",
    });
  });

  it("a row names an item by a leading `N:`, by `item N`, by `items A, B and C` and by an `A–B` range", () => {
    expect([...itemNumbersNamed("3: the third holds")]).toEqual([3]);
    expect([...itemNumbersNamed("Wake restores the archive (item 7)")]).toEqual([7]);
    expect([...itemNumbersNamed("Items 2–3 hold together")]).toEqual([2, 3]);
    expect([...itemNumbersNamed("guard rows (items 4, 6 and 9) stay")]).toEqual([4, 6, 9]);
    expect([...itemNumbersNamed("Nothing about any item")]).toEqual([]);
  });

  it("resolveSpecRow: the item's text plus the rows naming it; an absent item or spec is said, never invented", () => {
    expect(resolveSpecRow({ spec: "resident-repos.md", item: 3 }, RESIDENT_SPEC)).toEqual({
      spec: "resident-repos.md",
      item: 3,
      specRead: true,
      text: THIRD,
      validation: [
        { criterion: "3: the third holds", proof: "`[unit]` `src/execution/resident.test.ts::third::holds`" },
        { criterion: "Items 2–3 hold together", proof: "`[unit]` `src/execution/resident.test.ts::pair::*`" },
      ],
    });
    expect(resolveSpecRow({ spec: "resident-repos.md", item: 5 }, RESIDENT_SPEC)).toEqual({
      spec: "resident-repos.md",
      item: 5,
      specRead: true,
      text: undefined,
      validation: [],
    });
    expect(resolveSpecRow({ spec: "execution.md", item: 22 }, undefined)).toEqual({
      spec: "execution.md",
      item: 22,
      specRead: false,
      text: undefined,
      validation: [],
    });
  });
});

describe("contractFromPlan — the typed contract for one unit", () => {
  it("carries the unit, exactly the rows it names resolved against the specs, the agent rules, the guards and the rebase", () => {
    const c = u10();
    expect(c.unit.id).toBe("U10");
    expect(c.specRows.map((r) => `${r.spec}#${r.item}`)).toEqual([
      "resident-repos.md#3",
      "resident-repos.md#7",
      "execution.md#22",
      "agent-ship.md#4",
      "agent-ship.md#5",
      "agent-ship.md#6",
      "agent-ship.md#9",
    ]);
    expect(c.specRows[1].text).toBe("7. **Seventh**: a wake restores the archive.");
    expect(c.specRows[1].validation).toEqual([
      {
        criterion: "Wake restores the archive (item 7)",
        proof: "`[unit]` `src/execution/wake.test.ts::wake::restores`",
      },
    ]);
    expect(c.specRows[2].text).toBeUndefined(); // execution.md is not among the specs handed in
    expect(c.agentRules).toEqual(RULES);
    expect(c.guards).toBe(GUARDS);
    expect(c.rebase).toEqual({ branch: "plan/fixture/u10-warm-the-cache", onto: "main" });
  });

  it("a unit naming no spec rows receives none (until decided: never the covering specs' rows by path)", () => {
    const c = contractFromPlan({ planMarkdown: PLAN, unitId: "U11", readSpec });
    expect(c.specRows).toEqual([]);
    expect(c.agentRules).toBeUndefined();
    expect(c.rebase).toEqual({ branch: undefined, onto: undefined });
  });

  it("an unknown unit throws, naming the units the plan has", () => {
    expect(() => contractFromPlan({ planMarkdown: PLAN, unitId: "U99", readSpec })).toThrow(/no unit U99 .* U10, U11/);
  });
});

describe("contractFromTask — a task string is a plan of one unit with no rows", () => {
  it("the task is the unit's whole section, titled by its first line; no spec rows, no rules unless given", () => {
    const c = contractFromTask({ task: "fix the login redirect\n\nthe cookie is dropped after the redirect" });
    expect(c.unit).toEqual({
      id: "task",
      title: "fix the login redirect",
      section: "fix the login redirect\n\nthe cookie is dropped after the redirect",
      bullets: {},
    });
    expect(c.specRows).toEqual([]);
    expect(c.agentRules).toBeUndefined();
    expect(c.guards).toBe(GUARDS);
  });

  it("a long first line is cut to a title", () => {
    const c = contractFromTask({ task: `${"word ".repeat(40).trim()}\nmore` });
    expect(c.unit.title.length).toBeLessThanOrEqual(80);
    expect(c.unit.title.endsWith("…")).toBe(true);
  });
});

describe("renderContract — one block under `## Contract`, fixed sub-headings in a stable order", () => {
  it("renders the five sections in order under the one heading, the unit body verbatim, each spec row with its proof rows, the rules, the guards", () => {
    const { text, chars, dropped } = renderContract(u10(), {});
    expect(text.startsWith(`${CONTRACT_HEADING}\n`)).toBe(true);
    const order = [
      CONTRACT_SECTION_HEADINGS.firstInstruction,
      CONTRACT_SECTION_HEADINGS.unit,
      CONTRACT_SECTION_HEADINGS.specRows,
      CONTRACT_SECTION_HEADINGS.agentRules,
      CONTRACT_SECTION_HEADINGS.guards,
    ].map((h) => text.indexOf(`\n${h}`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the first instruction names the branch and the parent
    expect(text).toContain("Rebase `plan/fixture/u10-warm-the-cache` onto `main`");
    // the unit: its id and title on the fixed heading, its bullets verbatim
    expect(text).toContain(`${CONTRACT_SECTION_HEADINGS.unit} U10 — Warm the cache on wake`);
    expect(text).toContain(
      "- **Test scenarios**:\n  - a cold wake restores from the archive;\n  - a warm wake is a no-op.",
    );
    // the spec rows: item text, then the criterion/proof rows
    expect(text).toContain(`#### resident-repos.md item 3\n\n${THIRD}`);
    expect(text).toContain("| 3: the third holds | `[unit]` `src/execution/resident.test.ts::third::holds` |");
    expect(text).toContain("#### execution.md item 22\n\n(not found: no spec execution.md was readable)");
    expect(text).toContain("#### agent-ship.md item 9\n\n9. **LGTM**: merge-ready, never merged — ");
    expect(text).toContain("any ship code path.\n\n(no validation row names item 9)");
    // the rules and their source
    expect(text).toContain(`Source: AGENTS.md\n\n${RULES.text}`);
    // every guard with its one line
    for (const g of GUARDS) expect(text).toContain(`- \`${g.name}\` — ${g.refuses}`);
    expect(dropped).toEqual([]);
    expect(chars).toBe(text.length);
    expect(text).not.toContain("Cut to fit");
  });

  it("a unit with no spec rows and no rules says so under the same headings", () => {
    const { text } = renderContract(contractFromPlan({ planMarkdown: PLAN, unitId: "U11", readSpec }), {});
    expect(text).toContain(`${CONTRACT_SECTION_HEADINGS.specRows}\n\n(none — the unit names no spec rows`);
    expect(text).toContain(
      `${CONTRACT_SECTION_HEADINGS.agentRules}\n\n(none — the repository has neither AGENTS.md nor CLAUDE.md)`,
    );
    expect(text).toContain("Rebase the unit's branch onto the merged parent");
  });

  it("over-length drops the Approach text first and keeps every spec row, and the render says what it dropped", () => {
    const full = renderContract(u10(), {});
    const cut = renderContract(u10(), { maxChars: full.chars - 1 });
    expect(cut.dropped).toEqual(["approach"]);
    expect(cut.chars).toBeLessThan(full.chars);
    expect(cut.text).not.toContain("Read the row and decide from the disk");
    expect(cut.text).toContain("- **Approach**: (dropped to fit the contract's budget — read it in the plan)");
    for (const heading of [
      "#### resident-repos.md item 3",
      "#### resident-repos.md item 7",
      "#### agent-ship.md item 9",
    ])
      expect(cut.text).toContain(heading);
    expect(cut.text).toContain(THIRD);
    expect(cut.text).toContain(
      `Cut to fit ${full.chars - 1} characters: the unit's Approach text was dropped (read it in the plan).`,
    );
  });

  it("still over after the Approach: the agent rules go next, then the spec items' text (their proof rows stay), the proof rows last — and the rows' names survive every cut", () => {
    const full = renderContract(u10(), {});
    const noApproach = renderContract(u10(), { maxChars: full.chars - 1 });
    const noRules = renderContract(u10(), { maxChars: noApproach.chars - 1 });
    expect(noRules.dropped).toEqual(["approach", "agentRules"]);
    expect(noRules.text).not.toContain("Run only what the Commands table names.");
    expect(noRules.text).toContain("(dropped to fit the contract's budget — read AGENTS.md at the head)");
    expect(noRules.text).toContain(THIRD);
    const noSpecText = renderContract(u10(), { maxChars: noRules.chars - 1 });
    expect(noSpecText.dropped).toEqual(["approach", "agentRules", "specText"]);
    expect(noSpecText.text).not.toContain(THIRD);
    expect(noSpecText.text).toContain(
      "#### resident-repos.md item 3\n\n(text dropped — read item 3 in the spec)\n\n| Criterion | Proof |",
    );
    expect(noSpecText.text).toContain(
      "| 3: the third holds | `[unit]` `src/execution/resident.test.ts::third::holds` |",
    );
    expect(noSpecText.text).toContain(
      "the spec items' text was dropped (read them in the specs; their proof rows stay)",
    );
    const tiny = renderContract(u10(), { maxChars: 10 });
    expect(tiny.dropped).toEqual(["approach", "agentRules", "specText", "specRows"]);
    expect(tiny.text).not.toContain("3: the third holds");
    expect(tiny.text).toContain("- resident-repos.md item 3\n- resident-repos.md item 7\n- execution.md item 22");
    expect(tiny.text).toContain("the spec rows' proof rows were dropped too (their names stay above)");
    expect(tiny.overBudget).toBe(true);
    expect(tiny.chars).toBe(tiny.text.length);
    // the guards and the unit's test scenarios are never cut
    expect(tiny.text).toContain("a cold wake restores from the archive");
    for (const g of GUARDS) expect(tiny.text).toContain(`\`${g.name}\``);
  });

  it("a part that is not there is not reported as dropped", () => {
    const c = contractFromPlan({ planMarkdown: PLAN, unitId: "U11", readSpec });
    const tiny = renderContract(c, { maxChars: 10 });
    expect(tiny.dropped).toEqual([]);
    expect(tiny.overBudget).toBe(true);
  });

  it("the default budget is the one the children render with, and a task contract renders within it", () => {
    expect(DEFAULT_CONTRACT_MAX_CHARS).toBeGreaterThan(20_000);
    const r = renderContract(contractFromTask({ task: "fix the login redirect" }), {});
    expect(r.overBudget).toBe(false);
    expect(r.text).toContain(`${CONTRACT_SECTION_HEADINGS.unit} task — fix the login redirect`);
    expect(r.text).toContain("fix the login redirect");
  });

  it("the same object renders to the same bytes", () => {
    expect(renderContract(u10(), {}).text).toBe(renderContract(u10(), {}).text);
  });
});
