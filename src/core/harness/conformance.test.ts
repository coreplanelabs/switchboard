import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { harnessDrivers } from "./testing/drivers.js";
import { openCodeDriver, type MutatedClause } from "./opencode/testing/driver.js";
import {
  assertReadsRecord,
  buildHarnessConformanceMatrix,
  renderHarnessConformanceMatrix,
  rowVerdict,
  runRow,
  SCENARIOS,
  type DrivenRun,
  type HarnessDriver,
  type RowOutcome,
  type ScenarioRow,
} from "./testing/scenarios.js";

// Feature: docs/reference/specs/harness.md item 11 — the conformance table.
// Record 0038's six clauses and the parity rows as one table of scenarios, each
// a function of a `HarnessDriver`, run against every harness the tree has
// through `describe.each`; a row that asserts nothing on the run events or the
// ledger steps is refused by the lint; the matrix the PR body carries is the
// suite's own. pi's driver runs the real bridge, mirror, relay and gate over
// the fake container and the scripted double.

const drivers = harnessDrivers();

describe.each(drivers.map((d) => [d.harness, d] as const))("conformance — %s", (_name, driver) => {
  for (const row of SCENARIOS) {
    const declared = driver.cannot?.[row.id];
    if (declared === undefined) {
      it(`${row.clause}: ${row.title}`, async () => {
        await runRow(driver, row);
      });
    } else {
      // A limit the harness declares is asserted, never skipped: the row must
      // fail as declared, so a declaration the harness has outgrown goes red.
      it(`${row.clause}: ${row.title} — declared cannot (${declared}): the run fails as declared`, async () => {
        expect((await rowVerdict(driver, row)).outcome).toBe("cannot");
      });
    }
  }
});

describe("the table", () => {
  it("holds the six clauses, each with at least one row, and the parity rows; every id is unique", () => {
    const clauses = new Set(SCENARIOS.map((r) => r.clause));
    for (const c of ["credential", "gate", "relay", "record", "conversation", "survival", "parity"])
      expect(clauses.has(c as ScenarioRow["clause"]), c).toBe(true);
    expect(new Set(SCENARIOS.map((r) => r.id)).size).toBe(SCENARIOS.length);
  });

  it("the lint: a row whose check reads neither the run events nor the ledger steps is refused by name, and one that reads either passes it", async () => {
    // A driver that answers a run of nothing, so only the check's reads decide.
    const empty: DrivenRun = {
      harness: "pi",
      outcome: { kind: "answered", answer: "ok" },
      inboxLeft: [],
      stopRequested: undefined,
      events: [],
      steps: [],
      facts: [],
      progress: [],
      starts: [],
      killed: [],
      removed: [],
      requests: [],
      modelCalls: [],
      statusReports: [],
    };
    const driver: HarnessDriver = { ...drivers[0], run: async () => empty };
    const blind: ScenarioRow = {
      id: "blind-row",
      clause: "gate",
      title: "asserts on the answer alone",
      script: { turns: [] },
      check: (run) => assert.equal(run.outcome.kind, "answered"),
    };
    await expect(runRow(driver, blind)).rejects.toThrow(/row blind-row asserts nothing on the record/);
    const sighted: ScenarioRow = { ...blind, id: "sighted-row", check: (run) => assert.deepEqual(run.events, []) };
    await expect(runRow(driver, sighted)).resolves.toEqual({ reads: new Set(["events"]) });
    expect(() => assertReadsRecord({ id: "x" }, new Set(["steps"]))).not.toThrow();
    expect(() => assertReadsRecord({ id: "x" }, new Set(["facts", "outcome"]))).toThrow(/neither events nor steps/);
  });

  it("the matrix prints every harness × row: pi green on every row, OpenCode green on every row but its declared cannots, over the fake serve", async () => {
    const columns = await buildHarnessConformanceMatrix(drivers);
    expect(columns.map((c) => c.harness)).toEqual(["pi", "opencode"]);
    const [pi, opencode] = columns;
    // pi passes every row (it prevents a forged approval by construction).
    expect(Object.values(pi.rows).every((o) => o === "pass")).toBe(true);
    // OpenCode passes every row but the ones it declares: the permanent
    // gate-approval-unforgeable, and the loop-end tool cut it owes.
    const declared = new Set(Object.keys(drivers.find((d) => d.harness === "opencode")?.cannot ?? {}));
    expect(declared.size).toBeGreaterThan(0);
    for (const row of SCENARIOS) expect(opencode.rows[row.id]).toBe(declared.has(row.id) ? "cannot" : "pass");
    expect(Object.keys(pi.rows)).toEqual(SCENARIOS.map((r) => r.id));
    const rendered = renderHarnessConformanceMatrix(columns, ["pi", "opencode"]);
    const lines = rendered.split("\n");
    expect(lines[0]).toContain(`${SCENARIOS.length} rows × 2 harness(es)`);
    expect(lines[2]).toBe("| Clause | Row | pi | opencode |");
    const body = lines.slice(4).filter((l) => l.startsWith("|") && !l.startsWith("| Clause") && !l.startsWith("|---"));
    const isDeclared = (l: string) => [...declared].some((id) => l.includes(`\`${id}\``));
    for (const line of body.filter(isDeclared)) expect(line.endsWith("| ✅ | ✖ |")).toBe(true);
    for (const line of body.filter((l) => !isDeclared(l))) expect(line.endsWith("| ✅ | ✅ |")).toBe(true);
    // Every declared cannot's reason is printed beneath the table.
    for (const id of declared) expect(rendered).toContain(`✖ opencode cannot \`${id}\`:`);
  });

  it("a declared cannot is asserted, never skipped: a declared row whose run fails is the verdict cannot, a declared row that passes is a failure naming the stale declaration, an undeclared failure is fail, and the matrix prints the declared cell with its reason beneath the table", async () => {
    // A driver that fails one row for real (its check finds an empty record) and passes another.
    const failing: DrivenRun = {
      harness: "pi",
      outcome: { kind: "answered", answer: "ok" },
      inboxLeft: [],
      stopRequested: undefined,
      events: [],
      steps: [],
      facts: [],
      progress: [],
      starts: [],
      killed: [],
      removed: [],
      requests: [],
      modelCalls: [],
      statusReports: [],
    };
    const rowThatFails: ScenarioRow = {
      id: "needs-a-step",
      clause: "record",
      title: "needs one ledger step",
      script: { turns: [] },
      check: (run) => assert.equal(run.steps.length, 1),
    };
    const rowThatPasses: ScenarioRow = {
      id: "needs-nothing",
      clause: "record",
      title: "reads the record and asks nothing of it",
      script: { turns: [] },
      check: (run) => assert.deepEqual(run.steps, []),
    };
    const undeclared: HarnessDriver = { ...drivers[0], run: async () => failing };
    const declared: HarnessDriver = {
      ...undeclared,
      cannot: { "needs-a-step": "this harness writes no ledger steps", "needs-nothing": "stale: it passes now" },
    };
    expect((await rowVerdict(undeclared, rowThatFails)).outcome).toBe("fail");
    expect((await rowVerdict(undeclared, rowThatPasses)).outcome).toBe("pass");
    const asDeclared = await rowVerdict(declared, rowThatFails);
    expect(asDeclared.outcome).toBe("cannot");
    expect(asDeclared.error?.message).toMatch(/Expected values to be strictly equal|steps/);
    const stale = await rowVerdict(declared, rowThatPasses);
    expect(stale.outcome).toBe("fail");
    expect(stale.error?.message).toMatch(
      /needs-nothing passes for pi, but the driver declares it cannot: stale: it passes now/,
    );
    // The matrix: the declared cell is its own mark, with the reason beneath the table.
    const rendered = renderHarnessConformanceMatrix(
      [
        {
          harness: "pi",
          rows: { "needs-a-step": "cannot", "needs-nothing": "pass" },
          cannot: { "needs-a-step": "this harness writes no ledger steps" },
        },
      ],
      ["pi"],
      [rowThatFails, rowThatPasses],
    );
    expect(rendered).toContain("| record | `needs-a-step` — needs one ledger step | ✖ |");
    expect(rendered).toContain("| record | `needs-nothing` — reads the record and asks nothing of it | ✅ |");
    expect(rendered).toContain("✖ pi cannot `needs-a-step`: this harness writes no ledger steps");
    expect(rendered.split("\n")[0]).toContain("✖ cannot (declared, asserted)");
  });
});

// U11 (record 0038's fourth and fifth amendments): the OpenCode harness enters
// the same table as a driver over a fake `serve`. This unit greens the gate and
// the record rows; U12 adds the driver to `harnessDrivers()` and greens every
// row against the real binary. The gate's honest cannots are the declared
// cells: a forged approval caught by detection, never prevented by
// construction (`gate-approval-unforgeable`), and a bash timeout the ask never
// carries (`budget-refuses-a-command-past-the-loop-end`).
describe("conformance — opencode (fake serve, gate and record)", () => {
  const driver = openCodeDriver();
  const rows = SCENARIOS.filter((r) => r.clause === "gate" || r.clause === "record");

  for (const row of rows) {
    const declared = driver.cannot?.[row.id];
    if (declared === undefined) {
      it(`${row.clause}: ${row.title}`, async () => {
        await runRow(driver, row);
      });
    } else {
      it(`${row.clause}: ${row.title} — declared cannot (${declared}): the run fails as declared`, async () => {
        expect((await rowVerdict(driver, row)).outcome).toBe("cannot");
      });
    }
  }

  it("the matrix shows OpenCode green on every gate and record row against the fake serve, with the declared cannot cells", async () => {
    const verdicts: Record<string, RowOutcome> = {};
    for (const row of rows) verdicts[row.id] = (await rowVerdict(driver, row)).outcome;
    const declared = new Set(Object.keys(driver.cannot ?? {}));
    for (const row of rows) expect(verdicts[row.id]).toBe(declared.has(row.id) ? "cannot" : "pass");
    const rendered = renderHarnessConformanceMatrix(
      [{ harness: "opencode", rows: verdicts, ...(driver.cannot ? { cannot: driver.cannot } : {}) }],
      ["opencode"],
      rows,
    );
    expect(rendered).toContain("| ✖ |");
    for (const id of declared) expect(rendered).toContain(`✖ opencode cannot \`${id}\`:`);
  });
});

// The mutation requirement (record 0038): removing one clause's behaviour from OpenCode fails the
// suite, once per clause. The fake serve can switch a clause off
// (`MutatedClause`), and the clause's own row — green with the clause on — goes
// red with it off, so a regression in any clause cannot pass the table.
describe("conformance — opencode: the six mutation rows (each clause switched off fails its row)", () => {
  const cases: Array<{ clause: MutatedClause; row: string }> = [
    { clause: "credential", row: "credential-bearer-only" },
    { clause: "gate", row: "gate-decides-every-call" },
    { clause: "relay", row: "relay-runs-in-bot" },
    { clause: "record", row: "record-vocabulary-and-steps" },
    { clause: "conversation", row: "conversation-seed-then-prompt" },
    { clause: "survival", row: "survival-facts-on-row" },
  ];

  for (const { clause, row: rowId } of cases) {
    const row = SCENARIOS.find((r) => r.id === rowId)!;
    it(`${clause}: on, the row passes; off, the row fails`, async () => {
      expect((await rowVerdict(openCodeDriver(), row)).outcome).toBe("pass");
      expect((await rowVerdict(openCodeDriver({ mutate: clause }), row)).outcome).toBe("fail");
    });
  }
});
